import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetShard } from '@/generated/prisma/client';
import * as orchestratorPackage from '@motir/orchestrator';
import {
  fakeFleetInventory,
  fakeOrchestrator,
  flyFleetInventory,
  flyOrchestrator,
  OrchestratorNotConfiguredError,
  type FleetWorkloadKind,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import {
  AGENT_RUNNER_PROVIDER_ENV_VAR,
  CI_RUNNER_PROVIDER_ENV_VAR,
} from '@/lib/ciFleet/fleetKindSwitches';
import { INDEX_FLEET_PROVIDER_ENV } from '@/lib/ciFleet/limits';
import { INSTALL_FLEET_KINDS_ENV } from '@/lib/ciFleet/installFleet';
import {
  getFleetInventory,
  getOrchestrator,
  isOrchestratorConfigured,
  selectedOrchestratorProvider,
} from '@/lib/orchestrator';
import { deploymentStatusProvider } from '@/lib/deployment/providers';
import {
  createEcsDeploymentStatusProvider,
  ecsDeploymentStatusProvider,
  type DescribeServices,
  type EcsServiceRow,
} from '@/lib/deployment/adapters/ecs/ecsServicesStatus';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import type { PlatformSignalDTO } from '@/lib/dto/platformHealth';
import { platformHealthService } from '@/lib/services/platformHealthService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import { randomInt, randomToken } from '../../helpers/random';
import { grantPaidAiPlan } from '../../helpers/paidAiPlan';

// THE INTEGRATION GATE OF THE FLY DEPLOY-SURFACE RETIREMENT (MOTIR-10955, Story
// MOTIR-9716). It adds no assertion a sibling suite already owns; it composes
// what two merged cards left behind and asks four questions only the composition
// can answer:
//
//   1. the deploy surface is gone and nothing reaches it (a scan proved able to
//      fail, by a planted line in a scratch tree);
//   2. with all four fleet kinds seeded in one world, an unset switch still
//      answers the process-wide lane — under an EXPLICIT `fly` selector, the
//      kept Fly fleet — and one `aws` flip moves exactly one kind;
//   3. the composition root still hands out the Fly fleet adapters by identity;
//   4. the deployment-status binding hands out the ECS adapter under Fargate,
//      and the Hosting card renders from THAT object.
//
// What it rests on rather than re-asserts: each kind's switch reading and each
// admission's own answers (`tests/ciFleet/`), the ECS adapter's own cases
// (`tests/deployment/ecsServicesStatus.test.ts`), the hosting signal's five arms
// (`tests/platform/platformHealthService.test.ts`), and the kept adapters' own
// behaviour (their suites under `packages/orchestrator/test/` and
// `tests/publicAddresses/`). It proves nothing about a deployed system and boots
// nothing on a real provider: every case runs against the CI Postgres and an
// injected describe.

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The platform gate reads a session and tests have no cookies: the same
    // stand-in `tests/platform/platformHealthService.test.ts` uses. Everything
    // below the gate is the real path against real Postgres.
    requirePlatformStaff: vi.fn(async () => currentPrincipal),
  };
});

let currentPrincipal: PlatformPrincipal;

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SELF = 'tests/integration/fleet/fleetAfterFlyGate.test.ts';

// ═══════════════════════════════════════════════════════════════════════════
// 1 · THE DEPLOY SURFACE IS GONE AND NOTHING REACHES IT
// ═══════════════════════════════════════════════════════════════════════════

/** The deploy-only scripts MOTIR-10935 deleted, by basename without extension. */
const DELETED_DEPLOY_SCRIPTS = [
  'assert-machine-pool',
  'machinePool',
  'flyImageSet',
  'repair-fly-image-set',
] as const;

const CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;
const HASH_COMMENT_EXTENSIONS = /(?:\.ya?ml|\.toml|\.sh|\.bash|Dockerfile[^/]*|\.dockerfile)$/;
const TEXT_EXTENSIONS = /\.json$/;

/** One place a surviving file still reaches a deleted deploy script. */
interface DeployScriptHit {
  file: string;
  line: number;
  text: string;
}

/** Drop every comment from JS/TS source, keeping line breaks so lines still count. */
function stripCodeComments(source: string, file: string): string {
  // Parsed, not scanned: a bare scanner cannot tell a regex literal from a
  // division, and one misread `/` turns the rest of a file into a "string" whose
  // comments then survive. The parser places every token, and each token's
  // leading and trailing trivia is where every comment lives.
  const kind = /\.[cm]?jsx?$/.test(file)
    ? ts.ScriptKind.JSX
    : file.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const ranges = new Map<number, number>();
  const collect = (list: ts.CommentRange[] | undefined) => {
    for (const range of list ?? []) ranges.set(range.pos, range.end);
  };
  const visit = (node: ts.Node) => {
    collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(source, node.getEnd()));
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  let out = source;
  for (const [pos, end] of ranges) {
    out = out.slice(0, pos) + out.slice(pos, end).replace(/[^\n]/g, ' ') + out.slice(end);
  }
  return out;
}

/** Drop `#` comments from YAML, TOML and shell, keeping line breaks. */
function stripHashComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
}

/** Does a module specifier name a deleted deploy script, in any relative spelling? */
function specifierNamesDeletedScript(specifier: string): boolean {
  if (!specifier.startsWith('.') && !specifier.includes('scripts/')) return false;
  const base = posix.basename(specifier).replace(/\.(?:[cm]?[jt]s)$/, '');
  return (DELETED_DEPLOY_SCRIPTS as readonly string[]).includes(base);
}

/** Escape every regular-expression metacharacter, the backslash included. */
const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|-]/g, '\\$&');
const NAMES = DELETED_DEPLOY_SCRIPTS.map(escapeRegExp).join('|');
/** A path to a deleted script as a COMMAND or a path argument: `node scripts/x.mjs`, `'./x.mjs'`. */
const INVOCATION = new RegExp(`(?:^|[^\\w.-])(?:\\.{1,2}/)?(?:[\\w.-]+/)*(?:${NAMES})\\.mjs\\b`);
/** Every way JS/TS names a module: static, side-effect, re-export, dynamic and require. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"`])([^'"`\n]+)\1/g;

/**
 * Scan `files` under `root` for a reach into a deleted deploy script, comments
 * stripped. JS/TS is read for module specifiers AND for an invocation path in a
 * string (a `spawn('node', ['scripts/x.mjs'])`); YAML, TOML, shell and JSON are
 * read for an invocation path.
 */
function scanForDeployScriptReach(root: string, files: readonly string[]): DeployScriptHit[] {
  const hits: DeployScriptHit[] = [];
  for (const file of files) {
    if (file === SELF) continue;
    const isCode = CODE_EXTENSIONS.test(file);
    if (!isCode && !HASH_COMMENT_EXTENSIONS.test(file) && !TEXT_EXTENSIONS.test(file)) continue;
    const raw = readFileSync(join(root, file), 'utf8');
    // Every reach names the script's basename literally, so a file that never
    // does is skipped before it is parsed — which keeps a whole-tree scan inside
    // a test's budget without narrowing what it can find.
    if (!DELETED_DEPLOY_SCRIPTS.some((name) => raw.includes(name))) continue;
    const stripped = isCode
      ? stripCodeComments(raw, file)
      : HASH_COMMENT_EXTENSIONS.test(file)
        ? stripHashComments(raw)
        : raw;
    stripped.split('\n').forEach((text, index) => {
      const viaSpecifier =
        isCode &&
        [...text.matchAll(SPECIFIER)].some((match) => specifierNamesDeletedScript(match[2]!));
      if (viaSpecifier || INVOCATION.test(text)) {
        hits.push({ file, line: index + 1, text: text.trim() });
      }
    });
  }
  return hits;
}

/** The files at the head: what git tracks, which is what the pull request ships. */
function trackedFiles(root: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '' && !file.startsWith('docs/') && !file.endsWith('.md'))
    .filter((file) => existsSync(join(root, file)));
}

describe('1 · the deploy surface is gone and nothing reaches it', () => {
  let files: string[];
  beforeAll(() => {
    files = trackedFiles(REPO_ROOT);
  }, 60_000);

  it('no surviving file imports or invokes a deleted deploy script, and the manifests and the deploy job are absent', () => {
    // The scan reads a real tree, not an empty one.
    expect(files.length).toBeGreaterThan(1000);
    expect(files.filter((file) => file.startsWith('scripts/')).length).toBeGreaterThan(10);

    expect(scanForDeployScriptReach(REPO_ROOT, files)).toEqual([]);

    expect(existsSync(join(REPO_ROOT, 'fly.toml'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'fly.relay.toml'))).toBe(false);
    for (const name of DELETED_DEPLOY_SCRIPTS) {
      expect(existsSync(join(REPO_ROOT, 'scripts', `${name}.mjs`))).toBe(false);
    }
    const ci = parseYaml(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, unknown>;
    };
    expect(Object.keys(ci.jobs).length).toBeGreaterThan(5);
    expect(ci.jobs).not.toHaveProperty('deploy');
  });

  it('the scan fails on a planted import of ./machinePool.mjs in a scratch tree, naming the file and the line', () => {
    // A scratch tree that is never committed: two surviving scripts copied out,
    // one of them with a planted import. A green run of the case above means
    // there is no importer, not that the scan matches nothing.
    const survivors = files.filter((file) => /^scripts\/[^/]+\.mjs$/.test(file)).slice(0, 2);
    expect(survivors).toHaveLength(2);
    const scratch = mkdtempSync(join(tmpdir(), 'motir-10955-scan-'));
    try {
      for (const file of survivors) {
        mkdirSync(dirname(join(scratch, file)), { recursive: true });
        writeFileSync(join(scratch, file), readFileSync(join(REPO_ROOT, file), 'utf8'));
      }
      const planted = survivors[0]!;
      const before = readFileSync(join(scratch, planted), 'utf8');
      const plantedLine = before.split('\n').length + (before.endsWith('\n') ? 0 : 1);
      writeFileSync(
        join(scratch, planted),
        `${before}${before.endsWith('\n') ? '' : '\n'}import './machinePool.mjs';\n`,
      );

      expect(scanForDeployScriptReach(scratch, survivors)).toEqual([
        { file: planted, line: plantedLine, text: "import './machinePool.mjs';" },
      ]);
      // The same line inside a comment is not a reach.
      writeFileSync(join(scratch, planted), `${before}\n// import './machinePool.mjs';\n`);
      expect(scanForDeployScriptReach(scratch, survivors)).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('the scan recognises every relative spelling and an invocation, and ignores a comment', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'motir-10955-spell-'));
    try {
      const write = (file: string, body: string) => {
        mkdirSync(dirname(join(scratch, file)), { recursive: true });
        writeFileSync(join(scratch, file), body);
      };
      write('scripts/a.mjs', "import { x } from '../scripts/flyImageSet.mjs';\n");
      write('lib/b.ts', "const m = await import('../scripts/repair-fly-image-set');\n");
      write('c.cjs', "const p = require('./scripts/assert-machine-pool.mjs');\n");
      write('d.yml', 'steps:\n  - run: node scripts/assert-machine-pool.mjs # gate\n');
      write('package.json', '{ "scripts": { "pool": "node ./scripts/machinePool.mjs" } }\n');
      write('e.yml', '# node scripts/machinePool.mjs\nsteps: []\n');
      write('f.ts', "/* import './machinePool.mjs' */ export const machinePool = 1;\n");
      const files = [
        'scripts/a.mjs',
        'lib/b.ts',
        'c.cjs',
        'd.yml',
        'package.json',
        'e.yml',
        'f.ts',
      ];

      expect(scanForDeployScriptReach(scratch, files).map((hit) => hit.file)).toEqual([
        'scripts/a.mjs',
        'lib/b.ts',
        'c.cjs',
        'd.yml',
        'package.json',
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('the deployment-status port has one adapter, the ECS one: the Fly adapter and expectedMachines do not resolve', async () => {
    expect(existsSync(join(REPO_ROOT, 'lib/deployment/adapters/fly'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'lib/deployment/expectedMachines.ts'))).toBe(false);
    await expect(import('@/lib/deployment/expectedMachines' as string)).rejects.toThrow();

    const providers = stripCodeComments(
      readFileSync(join(REPO_ROOT, 'lib/deployment/providers.ts'), 'utf8'),
      'providers.ts',
    );
    const adapterModules = [...providers.matchAll(SPECIFIER)]
      .map((match) => match[2]!)
      .filter((specifier) => specifier.includes('/adapters/'));
    expect(adapterModules).toEqual(['@/lib/deployment/adapters/ecs/ecsServicesStatus']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · KIND ISOLATION, COMPOSED — WITH THE FLY FLEET STILL A PLACEMENT
// ═══════════════════════════════════════════════════════════════════════════

const PASSWORD = 'hunter2hunter2';
const GITHUB_ORG = 'motir-projects';
const NOW = new Date('2026-11-12T12:00:00.000Z');
const KINDS: readonly FleetWorkloadKind[] = [
  'ci_runner',
  'hosted_agent',
  'code_graph_index',
  'agent_instance',
];

interface World {
  workspaceId: string;
  organizationId: string;
  projectId: string;
  /** One `aws` account per kind, each with exactly one free slot. */
  accounts: Record<FleetWorkloadKind, FleetShard>;
}

/** Seed this gate's own world — the shape `tests/ciFleet/fleetShardAdmission.test.ts`
 *  seeds, written here rather than imported, so neither suite's tidy-up breaks the other. */
async function seedWorld(): Promise<World> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `fleet-after-fly-${suffix}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${suffix}`,
    ownerUserId: user.id,
  });
  const { projectsService } = await import('@/lib/services/projectsService');
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `F${randomInt(100, 1000)}`,
  });
  const accounts = {} as Record<FleetWorkloadKind, FleetShard>;
  for (const [index, kind] of KINDS.entries()) {
    accounts[kind] = await adminDb.fleetShard.create({
      data: {
        name: `aws-${kind}-${randomToken(6).toLowerCase()}`,
        fleetKind: kind,
        provider: 'aws',
        role: 'primary',
        state: 'active',
        githubOrg: GITHUB_ORG,
        githubInstallationId: '556677',
        awsAccountId: String(111_111_111_110 + index),
        awsRegion: 'us-east-1',
        credentialRef: `AWS_GATE_${kind.toUpperCase()}`,
        machineLimit: 1,
      },
    });
  }
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
    accounts,
  };
}

let jobSeq = 0;

async function seedCiIntent(world: World) {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: world.workspaceId,
      organizationId: world.organizationId,
      projectId: world.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(80_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: GITHUB_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: NOW,
      status: 'pending',
    },
  });
}

function choose(world: World, kind: FleetWorkloadKind) {
  return withSystemContext((tx) =>
    fleetShardAdmissionService.chooseInTx(
      { fleetKind: kind, organizationId: world.organizationId },
      NOW,
      tx,
    ),
  );
}

/** What has been placed on the seeded accounts — slots and CI intents, per kind. */
async function placedOnSeeded(world: World): Promise<Record<FleetWorkloadKind, number>> {
  const counts = {} as Record<FleetWorkloadKind, number>;
  for (const kind of KINDS) {
    const shardId = world.accounts[kind].id;
    counts[kind] =
      (await adminDb.fleetInFlightSlot.count({ where: { fleetShardId: shardId } })) +
      (await adminDb.ciRunnerProvisioningIntent.count({ where: { fleetShardId: shardId } })) +
      (await adminDb.agentInstance.count({ where: { fleetShardId: shardId } }));
  }
  return counts;
}

/** Every kind's switch unset, and the selector set EXPLICITLY — never left to its default. */
function unsetSwitchesUnder(selector: 'fly' | 'fake'): void {
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', selector);
  vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, '');
  vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, '');
  vi.stubEnv(INDEX_FLEET_PROVIDER_ENV, '');
  vi.stubEnv(INSTALL_FLEET_KINDS_ENV, '');
}

const ZERO = { ci_runner: 0, hosted_agent: 0, code_graph_index: 0, agent_instance: 0 };

describe('2 · kind isolation, composed, with the Fly fleet still a placement', () => {
  grantPaidAiPlan();

  beforeEach(async () => {
    await truncateAuthTables();
    await adminDb.ciRunnerProvisioningIntent.deleteMany({});
    await adminDb.fleetInFlightSlot.deleteMany({});
    await adminDb.platformFleetKindSwitch.deleteMany({});
    vi.setSystemTime(NOW);
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.stubEnv('GITHUB_FALLBACK_ORG', GITHUB_ORG);
    vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '100');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string): Promise<Response> => {
        if (String(url).includes('/v1/usage')) {
          return new Response(JSON.stringify({ balance: 1_000 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch to ${String(url)}`);
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await adminDb.ciRunnerProvisioningIntent.deleteMany({});
    await adminDb.fleetInFlightSlot.deleteMany({});
    await adminDb.fleetShard.deleteMany({});
  });

  it('every switch unset under an explicit fly selector: each kind answers the process-wide lane and no seeded account takes a slot', async () => {
    unsetSwitchesUnder('fly');
    expect(selectedOrchestratorProvider()).toBe('fly');
    const world = await seedWorld();

    for (const kind of KINDS) {
      expect(await choose(world, kind), kind).toEqual({ shardId: null });
    }
    // A real CI admission, not only a choice: the job is claimed on the
    // process-wide lane and the seeded CI account is left empty.
    const intent = await seedCiIntent(world);
    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      outcome: 'admitted',
      fleetShardId: null,
    });
    expect(await placedOnSeeded(world)).toEqual(ZERO);
  });

  it('the agent runner flipped to aws, the rest unset: a hosted run is placed on its seeded account and the other three still answer the process-wide lane', async () => {
    unsetSwitchesUnder('fly');
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    expect(selectedOrchestratorProvider()).toBe('fly');
    const world = await seedWorld();

    const verdict = await fleetCeilingService.reserve(
      {
        workload: 'hosted_agent',
        ref: 'gate-hosted-run-1',
        ownerRef: 'gate-hosted-run-1',
        organizationId: world.organizationId,
        workspaceId: world.workspaceId,
      },
      NOW,
    );
    expect(verdict).toMatchObject({
      outcome: 'reserved',
      fleetShardId: world.accounts.hosted_agent.id,
    });
    for (const kind of ['ci_runner', 'code_graph_index', 'agent_instance'] as const) {
      expect(await choose(world, kind), kind).toEqual({ shardId: null });
    }
    expect(await placedOnSeeded(world)).toEqual({ ...ZERO, hosted_agent: 1 });
  });

  it('the CI runner flipped to aws, the rest unset: a CI job is placed on its seeded account with exactly one intent row, and the other three still answer the process-wide lane', async () => {
    unsetSwitchesUnder('fly');
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, 'aws');
    expect(selectedOrchestratorProvider()).toBe('fly');
    const world = await seedWorld();
    const intent = await seedCiIntent(world);

    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      outcome: 'admitted',
      fleetShardId: world.accounts.ci_runner.id,
    });
    expect(
      await adminDb.ciRunnerProvisioningIntent.findMany({
        where: { fleetShardId: world.accounts.ci_runner.id },
        select: { id: true },
      }),
    ).toEqual([{ id: intent.id }]);
    for (const kind of ['hosted_agent', 'code_graph_index', 'agent_instance'] as const) {
      expect(await choose(world, kind), kind).toEqual({ shardId: null });
    }
    expect(await placedOnSeeded(world)).toEqual({ ...ZERO, ci_runner: 1 });
  });

  it('under the fake selector the same unset switch also answers the process-wide lane, and the root hands out the fake — so the Fly cases rest on their explicit selector', async () => {
    unsetSwitchesUnder('fake');
    expect(selectedOrchestratorProvider()).toBe('fake');
    const world = await seedWorld();

    for (const kind of KINDS) {
      expect(await choose(world, kind), kind).toEqual({ shardId: null });
    }
    expect(getOrchestrator()).toBe(fakeOrchestrator);
    expect(getFleetInventory()).toBe(fakeFleetInventory);
    // The same answer under both selectors: only the selector says which fleet
    // the process-wide lane is.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    expect(selectedOrchestratorProvider()).toBe('fly');
    expect(getOrchestrator).toThrow(OrchestratorNotConfiguredError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · THE FLY FLEET STILL RESOLVES THROUGH THE COMPOSITION ROOT
// ═══════════════════════════════════════════════════════════════════════════

describe('3 · the Fly fleet still resolves through the composition root', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function placeholderFlyFleet(): void {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'placeholder-fleet-token');
    vi.stubEnv('FLY_FLEET_APP', 'placeholder-fleet-app');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', 'registry.example/placeholder-runner@sha256:0');
    vi.stubEnv('FLY_INVENTORY_API_TOKEN', '');
  }

  it('configured with placeholders and the selector on fly, the root hands out the Fly fleet adapter and inventory by identity, with no network call', () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('no network call is expected');
    });
    vi.stubGlobal('fetch', fetchSpy);
    placeholderFlyFleet();
    expect(selectedOrchestratorProvider()).toBe('fly');

    expect(isOrchestratorConfigured()).toBe(true);
    expect(getOrchestrator()).toBe(flyOrchestrator);
    expect(getFleetInventory()).toBe(flyFleetInventory);
    // The objects the root hands out ARE the package's exports, not copies.
    expect(getOrchestrator()).toBe(orchestratorPackage.flyOrchestrator);
    expect(getFleetInventory()).toBe(orchestratorPackage.flyFleetInventory);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with FLY_FLEET_API_TOKEN cleared and no inventory token, the kept fleet guard still refuses exactly as at main', () => {
    placeholderFlyFleet();
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    expect(selectedOrchestratorProvider()).toBe('fly');

    expect(isOrchestratorConfigured()).toBe(false);
    expect(getOrchestrator).toThrow(OrchestratorNotConfiguredError);
    expect(getOrchestrator).toThrow(/FLY_FLEET_API_TOKEN/);
    expect(getFleetInventory()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · THE BINDING SELECTS THE ECS ADAPTER, AND THE CARD RENDERS FROM IT
// ═══════════════════════════════════════════════════════════════════════════

const SERVICES = ['motir-core-web', 'motir-core-worker'] as const;

function onFargate(): void {
  vi.stubEnv('AWS_EXECUTION_ENV', 'AWS_ECS_FARGATE');
  vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('MOTIR_ECS_CLUSTER', 'motir-core');
  vi.stubEnv('MOTIR_DEPLOYMENT_ECS_SERVICES', SERVICES.join(','));
  vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '');
}

/** A recorded DescribeServices row: `running` of `desired`, on `deployments` releases. */
function serviceRow(
  name: string,
  running: number,
  desired: number,
  releases: readonly number[] = [1],
): EcsServiceRow {
  return {
    serviceName: name,
    status: 'ACTIVE',
    runningCount: running,
    pendingCount: 0,
    desiredCount: desired,
    deployments: releases.map((revision, index) => ({
      status: index === 0 ? 'PRIMARY' : 'ACTIVE',
      rolloutState: releases.length > 1 && index === 0 ? 'IN_PROGRESS' : 'COMPLETED',
      taskDefinition: `arn:aws:ecs:us-east-1:111111111111:task-definition/${name}:${revision}`,
      createdAt: new Date(NOW.getTime() - (releases.length - index) * 60_000),
    })),
  };
}

/** The injected describe: answers the recorded rows for whatever it is asked. */
function recordedDescribe(rows: readonly EcsServiceRow[]): DescribeServices {
  return async ({ services }) => ({
    services: rows.filter((row) => services.includes(row.serviceName!)),
    failures: [],
  });
}

describe('4 · the binding selects the ECS adapter, and the Hosting card renders from it', () => {
  beforeEach(async () => {
    await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
    await truncateJobRuns();
    await truncateAuthTables();
    const user = await createTestUser({
      email: `ops+fleet-gate-${randomInt(1_000_000)}@moooon.net`,
    });
    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
    currentPrincipal = { userId: user.id, email: user.email, role: 'support' };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /**
   * Drive the card through the binding: assert the binding hands out the ECS
   * adapter by identity, then have THAT object read through the adapter built
   * over `rows` — so `foldServices` shapes the answer, and the card can only
   * render what the bound object returned.
   */
  async function hostingFrom(rows: readonly EcsServiceRow[]) {
    onFargate();
    const bound = await deploymentStatusProvider();
    expect(bound).toBe(ecsDeploymentStatusProvider);
    const overRecorded = createEcsDeploymentStatusProvider(recordedDescribe(rows));
    const read = vi
      .spyOn(ecsDeploymentStatusProvider, 'read')
      .mockImplementation(() => overRecorded.read());

    const board = await platformHealthService.read(currentPrincipal);
    expect(read).toHaveBeenCalledTimes(1);
    expect(board.signals).toHaveLength(7);
    const hosting = board.signals.find((signal) => signal.id === 'hosting');
    expect(hosting).toBeDefined();
    return hosting as PlatformSignalDTO;
  }

  it('under Fargate with the deployment variables set and the fake clear, the binding answers the ECS adapter', async () => {
    onFargate();
    const bound = await deploymentStatusProvider();
    expect(bound).toBe(ecsDeploymentStatusProvider);
    expect(bound?.configured()).toBe(true);
  });

  it('a service short of its desired count arrives at the Hosting card as shortGroup, naming it', async () => {
    const hosting = await hostingFrom([
      serviceRow('motir-core-web', 2, 3),
      serviceRow('motir-core-worker', 1, 1),
    ]);
    expect(hosting.state).toBe('degraded');
    expect(hosting.values).toMatchObject({
      reason: 'shortGroup',
      group: 'motir-core-web',
      started: 2,
      expected: 3,
    });
  });

  it('a service with two deployments in play arrives as mixedReleases, naming it and its release', async () => {
    const hosting = await hostingFrom([
      serviceRow('motir-core-web', 2, 2),
      serviceRow('motir-core-worker', 1, 1, [18, 17]),
    ]);
    expect(hosting.state).toBe('degraded');
    expect(hosting.values).toMatchObject({
      reason: 'mixedReleases',
      group: 'motir-core-worker',
      release: 'motir-core-worker:18',
    });
  });

  it('every service at its desired count and steady reads healthy', async () => {
    const hosting = await hostingFrom([
      serviceRow('motir-core-web', 2, 2),
      serviceRow('motir-core-worker', 1, 1),
    ]);
    expect(hosting.state).toBe('healthy');
    expect(hosting.services?.map((service) => service.name)).toEqual([...SERVICES]);
  });

  it('off a managed host with the fake clear, the binding answers null', async () => {
    vi.stubEnv('AWS_EXECUTION_ENV', '');
    vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '');
    expect(await deploymentStatusProvider()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE KEPT ADAPTERS STILL LOAD AND EXPORT WHAT THEIR CALLERS IMPORT
// ═══════════════════════════════════════════════════════════════════════════

/** Each kept module, and the symbols its callers import from it. */
const KEPT_ADAPTERS: ReadonlyArray<{ module: string; exports: readonly string[] }> = [
  {
    module: 'packages/orchestrator/src/adapters/fly/hosting.ts',
    exports: ['createFlyHostingDeployPort', 'flyHostingConfig'],
  },
  {
    module: 'packages/orchestrator/src/adapters/fly/index.ts',
    exports: ['flyOrchestrator', 'createFlyOrchestrator'],
  },
  {
    module: 'packages/orchestrator/src/adapters/fly/inventory.ts',
    exports: ['flyFleetInventory', 'isFlyInventoryConfigured'],
  },
  {
    module: 'packages/orchestrator/src/adapters/fly/persistent.ts',
    exports: ['flyPersistentOrchestrator', 'isFlyInstancesConfigured'],
  },
  {
    module: 'packages/orchestrator/src/adapters/fly/indexImage.ts',
    exports: ['flyIndexerImage', 'isFlyIndexerImageConfigured', 'INDEXER_IMAGE_ENV_VAR'],
  },
  {
    module: 'packages/orchestrator/src/adapters/neon/database.ts',
    exports: ['createNeonDatabasePort'],
  },
  {
    module: 'packages/orchestrator/src/adapters/neon/config.ts',
    exports: ['neonDatabaseConfig'],
  },
  {
    module: 'lib/publicAddresses/adapters/fly/flyCertificates.ts',
    exports: ['flyCertificateProvider', 'isFlyCertsConfigured'],
  },
];

describe('the kept adapters still load and export what their callers import', () => {
  it.each(KEPT_ADAPTERS)(
    '$module resolves and exports its callers’ symbols',
    async ({ module, exports }) => {
      const loaded = (await import(join(REPO_ROOT, module))) as Record<string, unknown>;
      for (const name of exports) {
        expect(loaded[name], `${module} → ${name}`).toBeDefined();
        // The orchestrator package's callers import through its public surface;
        // the certificate adapter is imported by path.
        if (module.startsWith('packages/orchestrator/')) {
          expect((orchestratorPackage as Record<string, unknown>)[name], name).toBeDefined();
        }
      }
    },
    30_000,
  );
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});
