import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakeOrchestrator,
  type ContainerOrchestrator,
  type PersistentExecResult,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { isPrivateNetworkHost } from '@/lib/ai/containerAiAddress';
import { motirAiContainerBaseUrl } from '@/lib/ai/motirAiClient';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { agentInstanceRunService, agentRunLaunchKey } from '@/lib/services/agentInstanceRunService';
import { agentInstanceLifecycleService } from '@/lib/services/agentInstanceLifecycleService';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { hostedRunKeyService } from '@/lib/services/hostedRunKeyService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import {
  fleet,
  fx as agentFx,
  seedRepo as seedAgentRepo,
  setUpHarness,
  tearDownHarness,
} from '../agentInstances/_harness';

// EVERY MOTIR ADDRESS A FLEET MACHINE IS HANDED, PER FLEET KIND (Story
// MOTIR-9714 · MOTIR-10751).
//
// A machine in a pool account can reach only what Motir publishes. Each address
// it was handed that was not one of those — motir-core's own private name, a Fly
// host, an unset value read as localhost — booted normally and failed late with
// every check green (MOTIR-4518, MOTIR-4916). So, per fleet kind, this file
// calls the function that builds what the machine is handed (or captures the
// value where that output reaches a fake orchestrator), and holds every Motir
// address in it to ONE checker: an https origin, on a host the classifier calls
// public, equal to one of the three origins the motir-infra services stack
// publishes (MOTIR_BASE_URL, MOTIR_AI_CONTAINER_URL, MOTIR_GATEWAY_RUN_URL).
//
//   kind           built by                                  Motir addresses
//   CI runner      ciRunnerBootService.buildSpec             none
//   indexer        codeGraphIndexDispatchService.buildIndexSpec  MOTIR_AI_BASE_URL
//   agent runner   hostedRunService (+ hostedRunKeyService.mintRunKey)
//                                                            MOTIR_API_URL, MOTIR_GATEWAY_URL
//   hoster         agentInstanceRunService launch (stdin)    apiUrl
//
// The kinds are named as core names them: the agent RUNNER boots a hosted
// run's container (`hosted_agent`), the agent HOSTER an agent instance
// (`agent_instance`).
//
// The source guard at the end reports a kind that starts carrying an address
// outside the three, so that origin is added to the stack outputs.

const PUBLISHED = {
  MOTIR_BASE_URL: 'https://app.motir.co',
  MOTIR_AI_CONTAINER_URL: 'https://ai.motir.co',
  MOTIR_GATEWAY_RUN_URL: 'https://gateway-run.motir.co',
} as const;

type FleetKind = 'CI runner' | 'indexer' | 'agent runner' | 'hoster';

function stubPublishedOrigins(): void {
  for (const [name, value] of Object.entries(PUBLISHED)) vi.stubEnv(name, value);
}

/** Which failing form a private host is, by the shape the classifier refused. */
function privateForm(host: string): string {
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost';
  if (host.endsWith('.fly.dev')) return 'Fly-owned host';
  if (host.endsWith('.flycast') || host.endsWith('.internal')) return 'Flycast or internal host';
  if (host.endsWith('.elb.amazonaws.com')) return 'AWS internal load balancer';
  if (/^[\d.]+$/.test(host) || host.includes(':')) return 'private range';
  return 'private host';
}

/**
 * THE ONE CHECKER every listed address goes through, positive cases and
 * negative alike. Returns the origin, or throws naming the kind, the variable
 * and the form that failed.
 */
function assertPublishedOrigin(args: { kind: FleetKind; variable: string; value: string }): string {
  const { kind, variable, value } = args;
  const refuse = (form: string): never => {
    throw new Error(`${kind} ${variable}=${value}: ${form}`);
  };
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    // Left null — refused just below.
  }
  if (!url || !url.hostname) return refuse('not an absolute URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateNetworkHost(host)) return refuse(privateForm(host));
  if (url.protocol !== 'https:') return refuse('not https');
  const published = Object.values(PUBLISHED).map((p) => new URL(p).origin);
  if (!published.includes(url.origin) || value.replace(/\/+$/, '') !== url.origin) {
    return refuse('unpublished host: not one of the three published origins');
  }
  return url.origin;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('CI runner — ciRunnerBootService.buildSpec', () => {
  it('is handed NO Motir address: its env is exactly the five boot keys, none of them a URL', () => {
    stubPublishedOrigins();
    const spec = ciRunnerBootService.buildSpec({
      intent: {
        id: 'intent-1',
        organizationId: 'org-1',
        workspaceId: 'ws-1',
        repoOwner: 'motir-projects',
        repoName: 'demo',
      } as Parameters<typeof ciRunnerBootService.buildSpec>[0]['intent'],
      workflowJobId: 42,
      projectId: 'proj-1',
      encodedJitConfig: 'ZW5jb2RlZC1qaXQ=',
      timeoutSeconds: 60,
      orchestrator: {} as ContainerOrchestrator,
    });
    expect(Object.keys(spec.env).sort()).toEqual([
      'ACTIONS_RUNNER_CONFIG_ARGS',
      'ACTIONS_RUNNER_INPUT_JITCONFIG',
      'MOTIR_INTENT_ID',
      'MOTIR_RUNNER_LABEL',
      'MOTIR_WORKFLOW_JOB_ID',
    ]);
    for (const value of Object.values(spec.env)) {
      expect(String(value)).not.toMatch(/https?:\/\//);
    }
  });
});

describe('indexer — codeGraphIndexDispatchService.buildIndexSpec', () => {
  it('hands MOTIR_AI_BASE_URL, the published AiContainerOrigin', () => {
    stubPublishedOrigins();
    const spec = codeGraphIndexDispatchService.buildIndexSpec({
      target: {
        installationId: '556677',
        providerId: 'github',
        organizationId: 'org-1',
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        repoOwner: 'motir-co',
        repoName: 'motir-core',
        repoRef: 'motir-co/motir-core',
        defaultBranch: 'main',
        runId: 'run-abc',
        dispatchId: 'evt-abc',
      },
      fleet: { image: 'motir/indexer@sha256:abc', region: 'ams' },
      // The value production passes, read the way production reads it.
      aiBaseUrl: motirAiContainerBaseUrl(),
      tarballUrl: 'https://codeload.github.com/motir-co/motir-core/legacy.tar.gz/main?token=x',
      runCredential: 'r'.repeat(48),
      previousSnapshotUrl: 'https://snapshots.s3.amazonaws.com/motir-core.tar?sig=x',
      timeoutSeconds: 1800,
    });

    expect(
      assertPublishedOrigin({
        kind: 'indexer',
        variable: 'MOTIR_AI_BASE_URL',
        value: spec.env['MOTIR_AI_BASE_URL']!,
      }),
    ).toBe(PUBLISHED.MOTIR_AI_CONTAINER_URL);
    // The other two URL variables are PRE-SIGNED OBJECT URLS (the repository
    // archive and the previous snapshot), not Motir origins: named, not checked.
    const urlKeys = Object.keys(spec.env)
      .filter((k) => /_URL$/.test(k))
      .sort();
    expect(urlKeys).toEqual([
      'MOTIR_AI_BASE_URL',
      'MOTIR_INDEX_SNAPSHOT_URL',
      'MOTIR_INDEX_TARBALL_URL',
    ]);
  });
});

describe('agent runner — hostedRunKeyService.mintRunKey', () => {
  it('hands MOTIR_GATEWAY_URL, the published GatewayRunOrigin', async () => {
    stubPublishedOrigins();
    // The gateway's MINT seam is core's own address for it, not the machine's.
    vi.stubEnv('MOTIR_GATEWAY_URL', 'https://gateway.test');
    vi.stubEnv('MOTIR_RUN_KEY_MINT_SECRET', 'mint-secret');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              key: 'sk-run-key-1',
              runRef: 'run_abc',
              coreOrganizationId: 'org_1',
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
              lane: 'agent',
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const config = await hostedRunKeyService.mintRunKey(
      { id: 'run_abc', organizationId: 'org_1', startedAt: new Date() },
      'claude-opus-5-5',
    );
    expect(
      assertPublishedOrigin({
        kind: 'agent runner',
        variable: 'MOTIR_GATEWAY_URL',
        value: config.containerEnv.MOTIR_GATEWAY_URL,
      }),
    ).toBe(PUBLISHED.MOTIR_GATEWAY_RUN_URL);
  });
});

// ── The agent runner's container request, captured at the fake orchestrator
//
// The few lines of `tests/hostedRuns/hostedRunStart.test.ts`'s fixture a
// hosted run's admission needs, copied rather than exported: motir-ai's model
// list and credit check, the gateway's mint and GitHub's installation read.

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function stubHostedRunSeams(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url === `${AI}/v1/agent-models`) {
        return json(200, { models: [{ id: MODEL, provider: 'anthropic' }], default: MODEL });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
        return json(200, {
          coreOrganizationId: body?.coreOrganizationId,
          balanceCredits: 250,
          hasCredits: true,
          mayRun: true,
        });
      }
      if (url === `${GATEWAY}/api/motir/run-keys` && method === 'POST') {
        return json(201, {
          key: 'sk-run-key-secret',
          runRef: body?.runRef,
          coreOrganizationId: body?.coreOrganizationId,
          expiresAt: body?.expiresAt,
          lane: 'agent',
        });
      }
      const inst = /\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url);
      if (inst && method === 'GET') {
        return json(200, {
          id: 42,
          account: { login: (inst[1] ?? '').split('/')[0] },
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
          suspended_at: null,
        });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

async function seedHostedRepo(hfx: WorkItemFixture): Promise<void> {
  const organizationId = hfx.workspace.organizationId;
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${hfx.workspaceId}-motir-projects`,
      workspaceId: hfx.workspaceId,
      organizationId,
      accountLogin: 'motir-projects',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: hfx.workspaceId,
      organizationId,
      repoId: '810001',
      owner: 'motir-projects',
      name: 'site',
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: hfx.workspaceId,
      projectId: hfx.projectId,
      role: 'web',
      name: 'site',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'created',
      position: 'a001',
      githubRepoId: mirror.id,
    },
  });
}

describe('agent runner — hostedRunService, the container request a fake orchestrator receives', () => {
  grantPaidAiPlan();

  beforeEach(async () => {
    await truncateAuthTables();
    await truncateJobRuns();
    await adminDb.fleetInFlightSlot.deleteMany({});
    fakeOrchestrator.reset();
    _resetRunGitBotAuthors();
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    vi.stubEnv('MOTIR_AI_URL', `${AI}/`);
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
    vi.stubEnv('MOTIR_GATEWAY_URL', GATEWAY);
    vi.stubEnv('MOTIR_RUN_KEY_MINT_SECRET', 'mint-secret');
    vi.stubEnv('GITHUB_STUDIO_APP_ID', '111');
    vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', PEM);
    vi.stubEnv('GITHUB_APP_ID', '222');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', PEM);
    stubPublishedOrigins();
    // With the trailing slash an operator pastes: the request trims it.
    vi.stubEnv('MOTIR_BASE_URL', `${PUBLISHED.MOTIR_BASE_URL}/`);
    stubHostedRunSeams();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await adminDb.fleetInFlightSlot.deleteMany({});
  });

  it('hands MOTIR_API_URL (CoreOrigin) and MOTIR_GATEWAY_URL (GatewayRunOrigin), and no other address', async () => {
    const hfx = await makeWorkItemFixture();
    await seedHostedRepo(hfx);
    const card = await workItemsService.createWorkItem(
      { projectId: hfx.projectId, kind: 'task', title: 'a card' },
      hfx.ctx,
    );
    await hostedRunService.start(
      { workItemKey: card.identifier, model: MODEL, idempotencyKey: 'idem-addresses' },
      hfx.ctx,
    );

    expect(fakeOrchestrator.specs).toHaveLength(1);
    const env = fakeOrchestrator.specs[0]!.env;
    expect(
      assertPublishedOrigin({
        kind: 'agent runner',
        variable: 'MOTIR_API_URL',
        value: env['MOTIR_API_URL']!,
      }),
    ).toBe(PUBLISHED.MOTIR_BASE_URL);
    expect(
      assertPublishedOrigin({
        kind: 'agent runner',
        variable: 'MOTIR_GATEWAY_URL',
        value: env['MOTIR_GATEWAY_URL']!,
      }),
    ).toBe(PUBLISHED.MOTIR_GATEWAY_RUN_URL);
    const addressed = Object.entries(env)
      .filter(([, v]) => /^https?:\/\//.test(String(v)))
      .map(([k]) => k)
      .sort();
    expect(addressed).toEqual(['MOTIR_API_URL', 'MOTIR_GATEWAY_URL']);
  });
});

// ── The agent hoster's launch, captured at the fake persistent fleet ────────

/** What the fake agent's terminal server answers — a signed-in agent that launches. */
function answer(command: readonly string[]): PersistentExecResult {
  const line = command.join(' ');
  const ok = (stdout = ''): PersistentExecResult => ({ exitCode: 0, stdout, stderr: '' });
  if (line === 'motir agent-terminal run --help') return ok();
  if (line.endsWith('motir agent-terminal signin')) {
    return ok(`${JSON.stringify({ profile: 'claude', state: 'signed_in' })}\n`);
  }
  if (line.includes('motir agent-terminal run ')) return ok('{"session":"sess-1"}\n');
  return ok();
}

describe('hoster — agentInstanceRunService, the launch exec a fake fleet receives', () => {
  beforeEach(async () => {
    await setUpHarness();
    await truncateJobRuns();
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', 'm'.repeat(48));
    stubPublishedOrigins();
    fleet.setExecResponder(answer);
    await seedAgentRepo('acme', 'web');
  });
  afterEach(tearDownHarness);

  it('hands apiUrl (CoreOrigin) on the launch stdin, and nothing at boot', async () => {
    const agent = await agentInstanceLifecycleService.create(
      agentFx.projectIdentifier,
      { name: 'yue-claude', profileId: 'claude' },
      agentFx.ctx,
    );
    const item = await workItemsService.createWorkItem(
      { projectId: agentFx.projectId, kind: 'task', title: 'a card' },
      agentFx.ctx,
    );
    const started = await agentInstanceRunService.start(
      { workItemKey: item.identifier, agentInstanceId: agent.id },
      agentFx.ctx,
    );
    const step = { run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() };
    await engineJob('agent-instance-run/launch')!.handler(
      {
        step,
        event: {
          data: {
            workspaceId: agentFx.workspaceId,
            dispatchRunId: started.dispatchRunId,
            idempotencyKey: agentRunLaunchKey(started.dispatchRunId),
          },
        },
      } as never,
      jobServices as never,
    );

    const launch = fleet.execs.find((e) => e.command.includes('--run-id'));
    expect(launch).toBeDefined();
    const stdin = JSON.parse(launch!.stdin!) as Record<string, unknown>;
    expect(Object.keys(stdin).sort()).toEqual(['apiUrl', 'token']);
    expect(
      assertPublishedOrigin({
        kind: 'hoster',
        variable: 'apiUrl',
        value: String(stdin['apiUrl']),
      }),
    ).toBe(PUBLISHED.MOTIR_BASE_URL);
  });
});

// ── The checker's refusals ──────────────────────────────────────────────────

describe('assertPublishedOrigin refuses every form a fleet machine cannot use', () => {
  it.each([
    ['https://motir-ai.fly.dev', 'Fly-owned host'],
    ['http://motir-gateway.flycast', 'Flycast or internal host'],
    ['https://motir-ai.internal', 'Flycast or internal host'],
    ['https://ip-10-0-1-5.ec2.internal', 'Flycast or internal host'],
    ['https://internal-core-1.us-east-1.elb.amazonaws.com', 'AWS internal load balancer'],
    ['https://10.0.1.5', 'private range'],
    ['https://172.20.5.5', 'private range'],
    ['https://192.168.0.9', 'private range'],
    ['https://100.64.0.1', 'private range'],
  ])('%s — %s, naming the kind and the variable', (value, form) => {
    expect(() =>
      assertPublishedOrigin({ kind: 'agent runner', variable: 'MOTIR_GATEWAY_URL', value }),
    ).toThrow(`agent runner MOTIR_GATEWAY_URL=${value}: ${form}`);
  });

  it.each(['https://motir-core-123.us-east-1.elb.amazonaws.com', 'https://app.example.com'])(
    '%s — a public host that is not one of the three published origins',
    (value) => {
      expect(() =>
        assertPublishedOrigin({ kind: 'indexer', variable: 'MOTIR_AI_BASE_URL', value }),
      ).toThrow(`indexer MOTIR_AI_BASE_URL=${value}: unpublished host`);
    },
  );

  it('refuses a published host over plain http, and a published origin with a path', () => {
    expect(() =>
      assertPublishedOrigin({
        kind: 'agent runner',
        variable: 'MOTIR_API_URL',
        value: 'http://app.motir.co',
      }),
    ).toThrow('not https');
    expect(() =>
      assertPublishedOrigin({
        kind: 'agent runner',
        variable: 'MOTIR_GATEWAY_URL',
        value: 'https://gateway-run.motir.co/v1',
      }),
    ).toThrow('unpublished host');
    expect(() =>
      assertPublishedOrigin({
        kind: 'agent runner',
        variable: 'MOTIR_API_URL',
        value: 'app.motir.co',
      }),
    ).toThrow('not an absolute URL');
  });

  it('refuses the localhost fallback an unset MOTIR_BASE_URL reads as: a kind handed it would be wrong', () => {
    vi.stubEnv('MOTIR_BASE_URL', '');
    const value = resolveBaseUrlTrimmed();
    expect(value).toBe('http://localhost:3000');
    expect(() => assertPublishedOrigin({ kind: 'hoster', variable: 'apiUrl', value })).toThrow(
      `hoster apiUrl=${value}: localhost`,
    );
  });
});

// ── The source guard ────────────────────────────────────────────────────────
//
// Every address-bearing name the five builders hold today, with what it is. A
// NEW `MOTIR_*_URL`, address accessor or `http(s)://` literal in one of them
// fails here, naming the file and the name: decide whether the machine is
// handed it, and if so publish it as a stack output and add a case above.

const ADDRESS_NAMES: Record<string, Record<string, string>> = {
  'lib/services/ciRunnerBootService.ts': {},
  'lib/services/codeGraphIndexDispatchService.ts': {
    MOTIR_AI_BASE_URL: 'the indexer env key, from motirAiContainerBaseUrl (checked above)',
    MOTIR_AI_CONTAINER_URL: 'named in comments; read through motirAiContainerBaseUrl',
    MOTIR_AI_URL: "core's own private motir-ai seam, named in comments; never handed",
    MOTIR_INDEX_TARBALL_URL: 'a pre-signed object URL, not a Motir origin',
    MOTIR_INDEX_SNAPSHOT_URL: 'a pre-signed object URL, not a Motir origin',
    'motirAiContainerBaseUrl(': 'the indexer address (checked above)',
    'motirAiBaseUrl(': "core's own call to motir-ai; never handed to the machine",
  },
  'lib/services/hostedRunKeyService.ts': {
    MOTIR_GATEWAY_URL: 'the agent runner env key, from gatewayRunUrl (checked above)',
    'gatewayRunUrl(': 'the agent runner gateway address (checked above)',
  },
  'lib/services/hostedRunService.ts': {
    MOTIR_API_URL: 'the agent runner env key, from resolveBaseUrlTrimmed (checked above)',
    MOTIR_GATEWAY_URL: 'the agent runner env key, from mintRunKey (checked above)',
    'resolveBaseUrlTrimmed(': 'the agent runner core address (checked above)',
  },
  'lib/services/agentInstanceRunService.ts': {
    'resolveBaseUrlTrimmed(': 'the hoster apiUrl (checked above)',
  },
};

function addressNamesIn(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/\bMOTIR_[A-Z0-9_]*_URL\b/g)) names.add(m[0]);
  for (const m of source.matchAll(
    /\b(resolveBaseUrl\w*|motirAi\w*BaseUrl|gateway\w*Url|\w*[Oo]rigin\w*Url)\s*\(/g,
  )) {
    names.add(`${m[1]}(`);
  }
  for (const m of source.matchAll(/https?:\/\/[^\s'"`)<>]+/g)) names.add(m[0]);
  return [...names].sort();
}

describe('the source guard over the five builders', () => {
  it.each(Object.keys(ADDRESS_NAMES))('%s holds only the addresses listed here', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const unlisted = addressNamesIn(source)
      .filter((name) => !(name in ADDRESS_NAMES[file]!))
      .map((name) => `${file}: ${name}`);
    expect(
      unlisted,
      'a new address a fleet machine may be handed: publish it, then list it',
    ).toEqual([]);
    // And nothing listed is gone, so the list stays a statement of what is there.
    expect(Object.keys(ADDRESS_NAMES[file]!).filter((n) => !source.includes(n))).toEqual([]);
  });

  it('reports a new address, with the file and the name', () => {
    const names = addressNamesIn(
      "env.MOTIR_TELEMETRY_URL = process.env.MOTIR_TELEMETRY_URL ?? 'https://telemetry.motir.co';",
    );
    expect(names).toEqual(['MOTIR_TELEMETRY_URL', 'https://telemetry.motir.co']);
  });
});
