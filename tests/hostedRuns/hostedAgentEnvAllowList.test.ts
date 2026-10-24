import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildContainerUserData,
  fakeOrchestrator,
  HOSTED_AGENT_ENV_NAMES,
  type ContainerSpec,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../helpers/adminDb';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// THE HOSTED-AGENT ENV ALLOW-LIST, guarded from the PRODUCER's side (MOTIR-9422).
//
// An agent-runner VM boots a hosted run from container-mode user-data, and
// `buildContainerUserData` REFUSES any env key outside `HOSTED_AGENT_ENV_NAMES`.
// So the list must hold exactly what the start paths put in the spec, or a run
// fails at boot on AWS alone. Two halves, set up as `hostedRunAdmit.test.ts` is:
//
//   1. a plain Run hosted is driven through the REAL start path against the fake
//      orchestrator, and the `spec.env` it provisions is handed to the builder;
//   2. the continue, fix and review starts need a dead run, a red pull request
//      and a review gate to drive, so their LITERAL `extraEnv` keys are read from
//      `lib/services/hostedRunService.ts` instead, with the launcher's own env and
//      its admission credentials, and every key must be on the list.
//
// Adding an env key to any start path without adding it to the list fails here.

const IMAGE = `ghcr.io/motir-co/motir-hosted-agent@sha256:${'a'.repeat(64)}`;

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

interface Stub {
  models?: {
    status?: number;
    ids?: string[];
    /** The platform's per-difficulty defaults (MOTIR-6990). Absent reads as all-null. */
    defaultsByDifficulty?: Partial<Record<'trivial' | 'low' | 'medium' | 'high', string | null>>;
  };
  mayRun?: boolean | 'unanswerable';
  /** `GET /repos/{owner}/{name}/installation` status, by `owner/name`. Default 200. */
  installation?: Record<string, number>;
}

let calls: Call[] = [];

function stub(s: Stub = {}): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, method, body });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      if (url === `${AI}/v1/agent-models`) {
        const status = s.models?.status ?? 200;
        if (status !== 200) return json(status, { code: 'internal_error' });
        const ids = s.models?.ids ?? [MODEL];
        return json(200, {
          models: ids.map((id) => ({
            id,
            provider: id.startsWith('deepseek') ? 'deepseek' : 'anthropic',
          })),
          default: ids[0] ?? null,
          ...(s.models?.defaultsByDifficulty
            ? {
                defaultsByDifficulty: {
                  trivial: null,
                  low: null,
                  medium: null,
                  high: null,
                  ...s.models.defaultsByDifficulty,
                },
              }
            : {}),
        });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
        if (s.mayRun === 'unanswerable') return json(503, { code: 'internal_error' });
        const mayRun = s.mayRun ?? true;
        return json(200, {
          coreOrganizationId: body?.coreOrganizationId,
          balanceCredits: mayRun ? 250 : 0,
          hasCredits: mayRun,
          mayRun,
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
      if (url.startsWith(`${GATEWAY}/api/motir/run-keys/`) && method === 'DELETE') {
        return json(200, { runRef: url.split('/').pop(), revoked: 1 });
      }
      const inst = /\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url);
      if (inst && method === 'GET') {
        const repo = inst[1] ?? '';
        const status = s.installation?.[repo] ?? 200;
        if (status !== 200) return json(status, {});
        const owner = repo.split('/')[0];
        return json(200, {
          id: 42,
          account: { login: owner },
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
          suspended_at: null,
          html_url: `https://github.com/organizations/${owner}/settings/installations/42`,
        });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

let repoSeq = 0;

/** A project repository with a realized GitHub repository behind it. */
async function seedRepo(opts: {
  state: 'created' | 'connected';
  owner: string;
  name: string;
}): Promise<string> {
  repoSeq += 1;
  const organizationId = fx.workspace.organizationId;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}-${opts.owner}` },
    create: {
      installationId: `inst-${fx.workspaceId}-${opts.owner}`,
      workspaceId: fx.workspaceId,
      organizationId,
      accountLogin: opts.owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId,
      repoId: String(800_000 + repoSeq),
      owner: opts.owner,
      name: opts.name,
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
      name: opts.name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: opts.state,
      position: `a${String(repoSeq).padStart(3, '0')}`,
      githubRepoId: mirror.id,
    },
  });
  return row.id;
}

let fx: WorkItemFixture;

/** A card created the way the product creates one — in its workflow's initial status. */
function newCard(title: string) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

let seq = 0;
const start = (key: string) =>
  hostedRunService.start(
    { workItemKey: key, model: MODEL, idempotencyKey: `idem-${++seq}` },
    fx.ctx,
  );

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  fx = await makeWorkItemFixture();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_AI_URL', `${AI}/`);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_GATEWAY_URL', GATEWAY);
  vi.stubEnv('MOTIR_RUN_KEY_MINT_SECRET', 'mint-secret');
  vi.stubEnv('MOTIR_BASE_URL', 'https://app.test/');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '111');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', PEM);
  vi.stubEnv('GITHUB_APP_ID', '222');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', PEM);
  stub();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the hosted-agent env allow-list', () => {
  it('a plain Run hosted provisions an env the container-mode builder accepts', async () => {
    const provision = vi.spyOn(fakeOrchestrator, 'provision');
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard('the card');
    await start(card.identifier);

    expect(provision).toHaveBeenCalledTimes(1);
    const spec = provision.mock.calls[0]![0] as ContainerSpec;
    expect(Object.keys(spec.env).sort()).toEqual([
      'MOTIR_API_URL',
      'MOTIR_DISPATCH_RUN_ID',
      'MOTIR_GATEWAY_URL',
      'MOTIR_MODEL',
      'MOTIR_RUN_KEY',
      'MOTIR_RUN_TOKEN',
      'MOTIR_WORK_ITEM_KEY',
    ]);
    expect(() => buildContainerUserData({ image: IMAGE, env: spec.env })).not.toThrow();
  });

  it('every env key a start path writes in hostedRunService.ts is on the list', () => {
    const source = readFileSync(join(process.cwd(), 'lib/services/hostedRunService.ts'), 'utf8');
    // Every `MOTIR_*:` property written in the file: the launcher's env, its
    // admission credentials, and the continue / fix / review `extraEnv`.
    const written = new Set([...source.matchAll(/\b(MOTIR_[A-Z_]+)\s*:/g)].map((m) => m[1]!));
    for (const key of [
      'MOTIR_RUN_MODE',
      'MOTIR_REVIEW_GATE_ID',
      'MOTIR_REVIEW_VERSION',
      'MOTIR_RUN_TOKEN',
      'MOTIR_RUN_KEY',
    ]) {
      expect(written, key).toContain(key);
    }
    const allowed = new Set<string>(HOSTED_AGENT_ENV_NAMES);
    expect([...written].filter((key) => !allowed.has(key))).toEqual([]);
    // And each start path's mode, literally.
    for (const mode of ['continue', 'fix', 'review']) {
      expect(source).toContain(`MOTIR_RUN_MODE: '${mode}'`);
    }
  });

  it('the review env, with every mode, is accepted', () => {
    const base = {
      MOTIR_DISPATCH_RUN_ID: 'run-1',
      MOTIR_WORK_ITEM_KEY: 'ACME-1',
      MOTIR_API_URL: 'https://app.test',
      MOTIR_MODEL: 'anthropic/claude-opus-5-5',
      MOTIR_RUN_TOKEN: 'token',
      MOTIR_GATEWAY_URL: 'https://gateway.test',
      MOTIR_RUN_KEY: 'key',
    };
    for (const extra of [
      { MOTIR_RUN_MODE: 'continue' },
      { MOTIR_RUN_MODE: 'fix' },
      { MOTIR_RUN_MODE: 'review', MOTIR_REVIEW_GATE_ID: 'gate', MOTIR_REVIEW_VERSION: '2' },
    ]) {
      expect(() =>
        buildContainerUserData({ image: IMAGE, env: { ...base, ...extra } }),
      ).not.toThrow();
    }
  });
});
