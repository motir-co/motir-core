import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getPreplanState } from '@/lib/ai/motirAiClient';
import type { HostingSize, HostingTarget, HostingUseCase } from '@/lib/hosting/vocabulary';
import type { ProjectRepoDto } from '@/lib/dto/projectRepos';
import type { SeedRegistryEntryInput } from '@/lib/dto/seedRegistry';
import {
  _resetProvisioningInstallationCache,
  _setReadinessPollForTests,
} from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  ProjectRepoNotMotirHostedError,
  ProjectRepoSeedRefusedError,
} from '@/lib/projectRepos/errors';
import {
  SEED_SOURCE_AWS_STARTER,
  SEED_SOURCE_EXPO_MOBILE_FOUNDATION,
  SEED_SOURCE_FLY_STARTER,
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_LEGACY_PLATFORM_STARTER,
  SEED_SOURCE_ORGANIZATION,
  SEED_SOURCE_PLATFORM_STARTER,
  SEED_SOURCE_SPRING_API_FOUNDATION,
} from '@/lib/projectRepos/vocabulary';
import { projectRepoProposalService } from '@/lib/services/projectRepoProposalService';
import { projectRepoProvisioningService } from '@/lib/services/projectRepoProvisioningService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { seedRegistryPromotionService } from '@/lib/services/seedRegistryPromotionService';
import { seedRegistryService } from '@/lib/services/seedRegistryService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { organizationIdOf } from '../../helpers/organizationOf';
import { createRunnerGroupFake, type RunnerGroupFake } from '../../helpers/runnerGroupFake';
import {
  createActionsVariableFake,
  type ActionsVariableFake,
} from '../../helpers/actionsVariableFake';
import { spyOnJobDispatch } from '../../helpers/jobs';
import { resetSeedRegistry } from '../../helpers/seedRegistryShipped';

// THE SEED REGISTRY, ASSEMBLED (Story MOTIR-704 · MOTIR-713). Each card under the
// story proves its own unit; this suite proves the JOINS, over the real test
// database with GitHub stubbed at the HTTP boundary (`fetch`) the way the
// establish and promotion suites stub it:
//
//   the registry's shipped entries (MOTIR-9813) → the matching on role, stack,
//   hosting target, use case and size (MOTIR-709) → the row's stored seed and
//   target (MOTIR-9808) → establish's `/generate` on exactly that entry's
//   template (MOTIR-708) → the designChoice commit on a web repo (MOTIR-1529),
//   and promote / retire (MOTIR-710) feeding the next project's matching.
//
// A row's hosting target is written by the plan's hosting decision, which no
// shipped caller performs yet: the proposer writes rows with no target. So a
// target-bearing row is written here the way that decision writes it — the
// matching answers the seed for the row's target, the row is added with that
// seed and its recorded result, and `setHosting` stores the target — never by
// writing a column the services would not write.

vi.mock('@/lib/ai/motirAiClient', () => ({ getPreplanState: vi.fn() }));

let currentSession: { user: { id: string; email: string; name: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';
const CHOICE = { styleId: 'neo-brutalism', paletteId: 'cobalt', typeId: 'grotesk' };
const DESIGN_MANIFEST = `${JSON.stringify({ styleId: 'warm-editorial', paletteId: 'motir', typeId: 'motir' }, null, 2)}\n`;
const FLY_MANIFEST = readFileSync(
  join(__dirname, '../../fixtures/hosting-manifests/fly.json'),
  'utf8',
);
const COMMIT = 'c0ffee0000000000000000000000000000000713';
const TREE = 'tree000000000000000000000000000000000713';
const SOURCE_TREE = [
  { path: 'README.md', mode: '100644', type: 'blob', sha: 'blob-readme' },
  { path: 'motir.hosting.json', mode: '100644', type: 'blob', sha: 'blob-manifest' },
];
/** Templates that carry no `@motir/design-system` manifest: the two non-web foundations. */
const FOUNDATION_TEMPLATES = new Set([
  `motir-co/${SEED_SOURCE_EXPO_MOBILE_FOUNDATION}`,
  `motir-co/${SEED_SOURCE_SPRING_API_FOUNDATION}`,
]);

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
/** Repositories in Motir's org, by name. */
let repos: Map<string, { id: number; description: string | null }>;
/** The template (`owner/repo`) each generated repository came from. */
let generatedFrom: Map<string, string>;
let nextRepoId: number;
let runnerGroups: RunnerGroupFake;
let actionsVariables: ActionsVariableFake;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * One GitHub for every seam the suite crosses: the provisioning installation and
 * its token, the runner group and fleet variable establish syncs, the two create
 * endpoints, a generated repository's tree as the design commit reads and writes
 * it, and a created repository's commit, manifest and tree as promotion reads and
 * copies them. Anything else throws, so an unexpected call fails the case.
 */
function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ url: u, method, body });
      const path = u.replace('https://api.github.com', '');

      if (path === `/orgs/${MOTIR_ORG}/installation`) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (path.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const group = await runnerGroups.handle(u, method, body);
      if (group) return group;
      const variable = actionsVariables.handle(u, method, body);
      if (variable) return variable;

      const create = (name: string, from: string | null, description: string | null) => {
        if (repos.has(name)) {
          return json(422, {
            message: 'Repository creation failed.',
            errors: [
              {
                resource: 'Repository',
                field: 'name',
                message: 'name already exists on this account',
              },
            ],
          });
        }
        const id = nextRepoId++;
        repos.set(name, { id, description });
        if (from) generatedFrom.set(name, from);
        return json(201, { id, name, owner: { login: MOTIR_ORG } });
      };
      const generate = /^\/repos\/([^/]+)\/([^/]+)\/generate$/.exec(path);
      if (method === 'POST' && generate) {
        return create(String(body?.['name']), `${generate[1]}/${generate[2]}`, null);
      }
      if (method === 'POST' && path === `/orgs/${MOTIR_ORG}/repos`) {
        return create(String(body?.['name']), null, (body?.['description'] as string) ?? null);
      }

      const own = /^\/repos\/([^/]+)\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(path);
      if (!own || own[1] !== MOTIR_ORG || !repos.has(own[2]!)) {
        throw new Error(`unexpected GitHub call: ${method} ${u}`);
      }
      const name = own[2]!;
      const rest = own[3] ?? '';
      if (method === 'GET' && rest === '') {
        return json(200, {
          id: repos.get(name)!.id,
          name,
          owner: { login: MOTIR_ORG },
          default_branch: 'main',
          description: repos.get(name)!.description,
        });
      }
      if (method === 'GET' && rest.startsWith('/branches/')) {
        return json(200, { name: 'main', commit: { sha: `seed-${name}` } });
      }
      // The design commit (MOTIR-1529): a generated repo carries the manifest
      // unless its template is a non-web foundation.
      if (method === 'GET' && rest === '/contents/motir.design.json') {
        const from = generatedFrom.get(name);
        return from && !FOUNDATION_TEMPLATES.has(from)
          ? json(200, { content: Buffer.from(DESIGN_MANIFEST).toString('base64') })
          : json(404, { message: 'Not Found' });
      }
      if (method === 'GET' && rest === '/contents/DESIGN.md')
        return json(404, { message: 'Not Found' });
      if (method === 'GET' && rest === '/git/ref/heads/main')
        return json(200, { object: { sha: 'head1' } });
      if (method === 'GET' && rest === '/git/commits/head1')
        return json(200, { tree: { sha: 'tree1' } });
      // Promotion's reads of the source (MOTIR-710).
      if (method === 'GET' && rest.startsWith('/commits/')) {
        return json(200, { sha: COMMIT, commit: { tree: { sha: TREE } } });
      }
      if (method === 'GET' && rest === '/contents/motir.hosting.json') {
        return json(200, {
          type: 'file',
          encoding: 'base64',
          content: Buffer.from(FLY_MANIFEST).toString('base64'),
        });
      }
      if (method === 'GET' && rest === `/git/trees/${TREE}`) {
        return json(200, { sha: TREE, tree: SOURCE_TREE, truncated: false });
      }
      if (method === 'GET' && rest.startsWith('/git/blobs/')) {
        const sha = rest.slice('/git/blobs/'.length);
        return json(200, { sha, encoding: 'base64', content: Buffer.from(sha).toString('base64') });
      }
      if (method === 'POST' && rest.startsWith('/git/'))
        return json(201, { sha: `${name}-${rest}` });
      if (method === 'PATCH') return json(200, {});
      if (method === 'PUT') return json(201, { content: {} });
      throw new Error(`unexpected GitHub call: ${method} ${u}`);
    }),
  );
}

/** The templates establish generated from, in call order. */
const generatedTemplates = () =>
  calls
    .filter((c) => c.method === 'POST' && c.url.endsWith('/generate'))
    .map((c) => /\/repos\/([^/]+\/[^/]+)\/generate$/.exec(c.url)![1]);

/** The design commits written to one repository. */
const designCommitsOn = (name: string) =>
  calls.filter(
    (c) => c.method === 'POST' && c.url.endsWith(`/repos/${MOTIR_ORG}/${name}/git/commits`),
  );

/** The `motir.design.json` the design commit on `name` wrote. */
function designWrittenTo(name: string): unknown {
  const tree = calls.find(
    (c) => c.method === 'POST' && c.url.endsWith(`/repos/${MOTIR_ORG}/${name}/git/trees`),
  )!;
  const entries = tree.body?.['tree'] as { path: string; content: string }[];
  return JSON.parse(entries.find((e) => e.path === 'motir.design.json')!.content);
}

interface Hosting {
  target: HostingTarget;
  useCase: HostingUseCase;
  size: HostingSize;
}

/**
 * A Motir-created web row on `hosting`, written as the hosting decision writes
 * it: seeded from the matching for that target (a `nextjs` stack signal), with
 * the result recorded, then its target, use case and size stored.
 */
async function hostedWebRow(fx: WorkItemFixture, name: string, hosting: Hosting) {
  const match = await seedRegistryService.matchSeedEntry({
    role: 'web',
    stack: 'nextjs',
    hostingTarget: hosting.target,
    useCase: hosting.useCase,
    size: hosting.size,
  });
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name, seedSource: match.key, seedMatch: match.result },
    fx.ctx,
  );
  return projectRepoSetService.setHosting(row.id, hosting, fx.ctx);
}

async function readRow(fx: WorkItemFixture, rowId: string): Promise<ProjectRepoDto> {
  const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
  return rows.find((r) => r.id === rowId)!;
}

/** A fixture entry, written through the registry's own write path. */
function register(input: SeedRegistryEntryInput) {
  return adminDb.$transaction((tx) => seedRegistryService.create(input, tx));
}

function webEntry(key: string, over: Partial<SeedRegistryEntryInput> = {}): SeedRegistryEntryInput {
  return {
    key,
    role: 'web',
    stack: 'nextjs',
    label: `Next.js · ${key}`,
    source: { owner: 'motir-co', repo: key },
    useCases: ['mvp'],
    sizes: ['small'],
    hostingTargets: ['fly'],
    ...over,
  };
}

async function refusalOf(attempt: Promise<unknown>): Promise<ProjectRepoSeedRefusedError> {
  const err = await attempt.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProjectRepoSeedRefusedError);
  return err as ProjectRepoSeedRefusedError;
}

beforeEach(async () => {
  await truncateAuthTables();
  calls = [];
  repos = new Map();
  generatedFrom = new Map();
  nextRepoId = 713_001;
  currentSession = null;
  actionsVariables = createActionsVariableFake(MOTIR_ORG);
  runnerGroups = createRunnerGroupFake(MOTIR_ORG);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  _setReadinessPollForTests({ attempts: 2, delayMs: 0 });
  installGitHub();
  spyOnJobDispatch();
  // A pre-plan session that recorded a design choice and no platform signal.
  vi.mocked(getPreplanState).mockResolvedValue({
    session: { designChoice: CHOICE, platform: null, designStarter: null },
    docs: [],
    catalog: null,
  } as unknown as Awaited<ReturnType<typeof getPreplanState>>);
});

afterEach(async () => {
  await resetSeedRegistry();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _setReadinessPollForTests(null);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('1. each target’s web row gets its own starter, end to end', () => {
  it('matches, generates from and designs serverless, Fly and AWS from three distinct starters', async () => {
    const cases = [
      ['serverless', SEED_SOURCE_PLATFORM_STARTER, 'internal_tool'],
      ['fly', SEED_SOURCE_FLY_STARTER, 'mvp'],
      ['aws', SEED_SOURCE_AWS_STARTER, 'planned_product'],
    ] as const;
    for (const [target, starter, useCase] of cases) {
      const fx = await makeWorkItemFixture();
      const name = `acme-${target}`;
      const row = await hostedWebRow(fx, name, { target, useCase, size: 'small' });
      expect(row).toMatchObject({
        seedSource: starter,
        seedMatch: 'matched',
        hostingTarget: target,
      });

      const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
      expect(result.rows).toEqual([expect.objectContaining({ rowId: row.id, outcome: 'created' })]);
      expect(generatedFrom.get(name)).toBe(`motir-co/${starter}`);
      expect(designCommitsOn(name)).toHaveLength(1);
      expect(designWrittenTo(name)).toEqual(CHOICE);
    }
    expect(generatedTemplates()).toEqual([
      `motir-co/${SEED_SOURCE_PLATFORM_STARTER}`,
      `motir-co/${SEED_SOURCE_FLY_STARTER}`,
      `motir-co/${SEED_SOURCE_AWS_STARTER}`,
    ]);
  });
});

describe('2. a role with no target keeps its own foundation', () => {
  it('proposes and generates a mobile row from the Expo foundation, with no design commit', async () => {
    // A newer mobile entry that DOES carry a target: a mobile row runs on none,
    // so it is never a candidate however recently it was registered.
    await register(
      webEntry('expo-mobile-on-fly', { role: 'mobile', stack: 'expo', hostingTargets: ['fly'] }),
    );
    const fx = await makeWorkItemFixture();

    const proposal = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx, {
      itemRoles: ['web', 'mobile'],
    });
    expect(proposal).toMatchObject({ proposed: true });
    const [web, mobile] = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(mobile).toMatchObject({
      role: 'mobile',
      seedSource: SEED_SOURCE_EXPO_MOBILE_FOUNDATION,
      seedMatch: 'no_stack_signal',
      hostingTarget: null,
    });
    await projectRepoSetService.setHosting(
      web!.id,
      { target: 'serverless', useCase: 'mvp', size: 'small' },
      fx.ctx,
    );

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(result.rows.map((r) => r.outcome)).toEqual(['created', 'created']);
    expect(generatedFrom.get(mobile!.name)).toBe(`motir-co/${SEED_SOURCE_EXPO_MOBILE_FOUNDATION}`);
    expect(generatedFrom.get(web!.name)).toBe(`motir-co/${SEED_SOURCE_PLATFORM_STARTER}`);
    expect(designCommitsOn(mobile!.name)).toEqual([]);
    expect(designCommitsOn(web!.name)).toHaveLength(1);
  });
});

describe('3. target beats every soft preference', () => {
  const ROW = { target: 'fly', useCase: 'internal_tool', size: 'small' } as const;

  it('never picks a better-fitting entry for another target', async () => {
    // Fits the row's role, stack, use case and size — and deploys only to serverless.
    await register(
      webEntry('nextjs-internal-serverless', {
        useCases: ['internal_tool'],
        sizes: ['small'],
        hostingTargets: ['serverless'],
      }),
    );
    const fx = await makeWorkItemFixture();
    const row = await hostedWebRow(fx, 'acme-fly', ROW);
    expect(row.seedSource).toBe(SEED_SOURCE_FLY_STARTER);

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(generatedTemplates()).toEqual([`motir-co/${SEED_SOURCE_FLY_STARTER}`]);
  });

  it('falls back to `initialised`, no_match, when no entry deploys to the target', async () => {
    await register(
      webEntry('nextjs-internal-serverless', {
        useCases: ['internal_tool'],
        hostingTargets: ['serverless'],
      }),
    );
    await adminDb.seedRegistryEntry.update({
      where: { key: SEED_SOURCE_FLY_STARTER },
      data: { status: 'retired' },
    });
    const fx = await makeWorkItemFixture();
    const row = await hostedWebRow(fx, 'acme-fly', ROW);
    expect(row).toMatchObject({ seedSource: SEED_SOURCE_INITIALISED, seedMatch: 'no_match' });

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(generatedTemplates()).toEqual([]);
  });
});

describe('4. use case orders, the tie-break decides, establish follows', () => {
  it('an internal_tool row takes the entry that lists internal_tool', async () => {
    await register(webEntry('nextjs-fly-internal', { useCases: ['internal_tool'] }));
    const fx = await makeWorkItemFixture();
    const row = await hostedWebRow(fx, 'acme-tool', {
      target: 'fly',
      useCase: 'internal_tool',
      size: 'small',
    });
    expect(row.seedSource).toBe('nextjs-fly-internal');
  });

  it('two equal entries: the most recently promoted wins, and establish generates from it', async () => {
    const older = new Date('2026-10-01T00:00:00Z');
    const newer = new Date('2026-10-20T00:00:00Z');
    await register(
      webEntry('nextjs-fly-tool-a', { useCases: ['internal_tool'], promotedAt: newer }),
    );
    await register(
      webEntry('nextjs-fly-tool-b', { useCases: ['internal_tool'], promotedAt: older }),
    );
    const fx = await makeWorkItemFixture();
    const row = await hostedWebRow(fx, 'acme-tool', {
      target: 'fly',
      useCase: 'internal_tool',
      size: 'small',
    });
    expect(row.seedSource).toBe('nextjs-fly-tool-a');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(generatedTemplates()).toEqual(['motir-co/nextjs-fly-tool-a']);
  });
});

describe('5. a re-point across targets is refused', () => {
  it('refuses the serverless starter on an AWS row, admits an AWS entry, and freezes once established', async () => {
    await register(
      webEntry('nextjs-aws-containers', {
        useCases: ['planned_product'],
        hostingTargets: ['aws'],
      }),
    );
    const fx = await makeWorkItemFixture();
    const row = await hostedWebRow(fx, 'acme-aws', {
      target: 'aws',
      useCase: 'planned_product',
      size: 'large',
    });
    const before = await readRow(fx, row.id);

    const refused = await refusalOf(
      projectRepoSetService.patchRow(row.id, { seedSource: SEED_SOURCE_PLATFORM_STARTER }, fx.ctx),
    );
    expect(refused.refusal).toBe('target_mismatch');
    expect(await readRow(fx, row.id)).toEqual(before);

    const repointed = await projectRepoSetService.patchRow(
      row.id,
      { seedSource: 'nextjs-aws-containers' },
      fx.ctx,
    );
    expect(repointed).toMatchObject({ seedSource: 'nextjs-aws-containers', seedMatch: null });
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(generatedTemplates()).toEqual(['motir-co/nextjs-aws-containers']);
    expect(await readRow(fx, row.id)).toMatchObject({ state: 'created' });

    const late = await refusalOf(
      projectRepoSetService.patchRow(row.id, { seedSource: SEED_SOURCE_AWS_STARTER }, fx.ctx),
    );
    expect(late.refusal).toBe('not_editable');
    expect((await readRow(fx, row.id)).seedSource).toBe('nextjs-aws-containers');
  });
});

describe('6. promote → offered → retire → not offered', () => {
  const FLY_TOOL = { target: 'fly', useCase: 'internal_tool', size: 'small' } as const;
  const KEY = 'acme-fly-tool-starter';

  it('carries a promoted entry into the next project’s matching, and out again once retired', async () => {
    const user = await createTestUser({ email: 'seed-assembly-operator@example.com' });
    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'operator' } });
    currentSession = { user: { id: user.id, email: user.email, name: user.name } };
    const operator = { userId: user.id, email: user.email, role: 'operator' as const };

    // A repository Motir created, on Fly.
    const source = await makeWorkItemFixture();
    const sourceRow = await hostedWebRow(source, 'acme-fly', FLY_TOOL);
    await projectRepoProvisioningService.establishSet(source.projectId, source.ctx);

    const promoted = await seedRegistryPromotionService.promote(
      operator,
      {
        sourceRowId: sourceRow.id,
        ref: 'v1',
        key: KEY,
        role: 'web',
        stack: 'nextjs',
        label: 'Next.js · internal tool on Fly',
        useCases: ['internal_tool'],
        sizes: ['small'],
        hostingTargets: ['fly'],
      },
      'a good internal tool',
    );
    expect(promoted).toMatchObject({
      key: KEY,
      source: { owner: MOTIR_ORG, repo: KEY },
      hostingTargets: ['fly'],
      promotedRef: COMMIT,
    });

    // Offered: the next project's matching row proposes it.
    const next = await makeWorkItemFixture();
    const offered = await hostedWebRow(next, 'next-fly', FLY_TOOL);
    expect(offered.seedSource).toBe(KEY);

    await seedRegistryPromotionService.retire(operator, KEY, 'superseded');

    // Not offered: a new project proposes the previous winner.
    const later = await makeWorkItemFixture();
    expect((await hostedWebRow(later, 'later-fly', FLY_TOOL)).seedSource).toBe(
      SEED_SOURCE_FLY_STARTER,
    );

    // The row already naming the retired entry fails at establish, with its reason…
    const failed = await projectRepoProvisioningService.establishSet(next.projectId, next.ctx);
    expect(failed.rows[0]).toMatchObject({ outcome: 'failed' });
    const failedRow = await readRow(next, offered.id);
    expect(failedRow.state).toBe('failed');
    expect(failedRow.failureReason).toContain(KEY);
    expect(generatedFrom.has('next-fly')).toBe(false);

    // …and succeeds once re-pointed.
    await projectRepoSetService.patchRow(
      offered.id,
      { seedSource: SEED_SOURCE_FLY_STARTER },
      next.ctx,
    );
    const retried = await projectRepoProvisioningService.establishSet(next.projectId, next.ctx);
    expect(retried.rows[0]).toMatchObject({ outcome: 'created' });
    expect(generatedFrom.get('next-fly')).toBe(`motir-co/${SEED_SOURCE_FLY_STARTER}`);
  });
});

describe('7. rows written before the registry are untouched', () => {
  it('establishes a legacy-keyed web row and an initialised row exactly as before', async () => {
    const fx = await makeWorkItemFixture();
    const web = await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        role: 'web',
        name: 'old-web',
        seedSource: SEED_SOURCE_LEGACY_PLATFORM_STARTER,
        state: 'proposed',
        position: 'a0',
      },
    });
    const api = await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        role: 'api',
        name: 'old-api',
        seedSource: SEED_SOURCE_INITIALISED,
        state: 'proposed',
        position: 'a1',
      },
    });

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows.map((r) => [r.rowId, r.outcome])).toEqual([
      [web.id, 'created'],
      [api.id, 'created'],
    ]);
    // The legacy key resolves to the renamed entry's template; `initialised`
    // takes the org create with GitHub's own first commit.
    expect(generatedTemplates()).toEqual([`motir-co/${SEED_SOURCE_PLATFORM_STARTER}`]);
    const orgCreate = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`),
    )!;
    expect(orgCreate.body).toMatchObject({ name: 'old-api', auto_init: true });
    expect(await readRow(fx, web.id)).toMatchObject({
      seedSource: SEED_SOURCE_LEGACY_PLATFORM_STARTER,
      hostingTarget: null,
      state: 'created',
    });
    expect(await readRow(fx, api.id)).toMatchObject({
      seedSource: SEED_SOURCE_INITIALISED,
      hostingTarget: null,
      state: 'created',
    });
  });
});

describe('8. a customer row stays out', () => {
  it('takes no target, keeps its seedSource through the proposer, refuses a re-point, and is never created', async () => {
    const fx = await makeWorkItemFixture();
    const installation = await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        accountLogin: 'acme',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        installationId: installation.id,
        workspaceId: fx.workspaceId,
        organizationId: await organizationIdOf(fx.workspaceId),
        repoId: `repo-${fx.workspaceId}`,
        owner: 'acme',
        name: 'acme-app',
        defaultBranch: 'main',
        archived: false,
        provider: 'github',
      },
    });
    const row = await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        role: 'web',
        name: 'acme-app',
        seedSource: SEED_SOURCE_ORGANIZATION,
        state: 'connected',
        githubRepoId: repo.id,
        position: 'a0',
      },
    });
    const before = await readRow(fx, row.id);

    await expect(
      projectRepoSetService.setHosting(
        row.id,
        { target: 'fly', useCase: 'mvp', size: 'small' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ProjectRepoNotMotirHostedError);

    const proposal = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);
    expect(proposal).toMatchObject({ proposed: false });

    const refused = await refusalOf(
      projectRepoSetService.patchRow(row.id, { seedSource: SEED_SOURCE_FLY_STARTER }, fx.ctx),
    );
    expect(refused.refusal).toBe('organization_row');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(
      calls.filter(
        (c) => c.method === 'POST' && (c.url.endsWith('/generate') || c.url.endsWith('/repos')),
      ),
    ).toEqual([]);
    expect(await readRow(fx, row.id)).toEqual(before);
  });
});
