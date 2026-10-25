import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import { HOSTED_RUN_SETTLE_MARGIN_MS, HOSTED_RUN_TIMEOUT_MS } from '@/lib/hostedRuns/limits';
import type { HostedRunAdmitData } from '@/lib/jobs/types';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { _resetAiPlanCache } from '@/lib/services/aiPlanGateService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import {
  HOSTED_RUN_WAITING_REASONS,
  hostedRunAdmitKey,
  hostedRunService,
} from '@/lib/services/hostedRunService';
import { HOSTED_AGENT_SHARD_CAPACITY_DETAIL } from '@/lib/services/fleetShardAdmissionService';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import type { FleetShard } from '@/generated/prisma/client';
import { planCapsService } from '@/lib/services/planCapsService';
import { AGENT_RUNNER_PROVIDER_ENV_VAR } from '@/lib/ciFleet/fleetKindSwitches';
import { fakeOrchestratorForShard, resetShardFakes } from '@/lib/orchestrator';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../helpers/adminDb';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// A FULL AGENT-RUNNER POOL WAITS (Story MOTIR-9359 · MOTIR-9425) — with the
// agent runner's switch on, a hosted run that finds every `hosted_agent` account
// full (reserve's deferral) or refused (the boot's move-then-defer) is NOT ended:
// it waits through MOTIR-9381's one mechanism, `shard_capacity` being one more
// member of `HOSTED_RUN_WAITING_REASONS`. Built on `hostedRunAdmit.test.ts`'s
// setup: real services over real Postgres, motir-ai, the gateway and GitHub
// stubbed at `fetch`, and two agent-runner accounts each with its OWN fake.
//
// ⚠️ THE CONTAINER COUNT IS THE ASSERTION, on each account's fake AND on the
// legacy (Fly) fake: a waiting run that booted, or one that went to Fly, reads
// the same from its status alone.

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

const mintCalls = () =>
  calls.filter((c) => c.url === `${GATEWAY}/api/motir/run-keys` && c.method === 'POST');

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

const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });

/** The admission job's payload, exactly as the start path stored it. */
async function admitPayload(dispatchRunId: string): Promise<HostedRunAdmitData> {
  const events = await adminDb.jobEvent.findMany({ where: { name: 'hosted-run/admit' } });
  const event = events.find(
    (e) => (e.data as unknown as HostedRunAdmitData).dispatchRunId === dispatchRunId,
  );
  if (!event) throw new Error(`no admission event for ${dispatchRunId}`);
  return event.data as unknown as HostedRunAdmitData;
}

const waitingLines = async (dispatchRunId: string) =>
  (await adminDb.dispatchRunEvent.findMany({ where: { dispatchRunId, kind: 'log' } }))
    .map((e) => e.body ?? '')
    .filter((body) => body.startsWith('[motir] waiting for room'));

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  fakeOrchestrator.reset();
  resetShardFakes();
  fleetShardOrchestratorService.resetCache();
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
  vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
  stub();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const WAITING_LINE = `[motir] waiting for room: ${HOSTED_AGENT_SHARD_CAPACITY_DETAIL}\n`;
let accountSeq = 0;

async function agentAccount(machineLimit: number): Promise<FleetShard> {
  accountSeq += 1;
  return adminDb.fleetShard.create({
    data: {
      name: `agents-wait-${accountSeq}`,
      fleetKind: 'hosted_agent',
      provider: 'fly',
      state: 'active',
      githubOrg: 'motir-projects',
      githubInstallationId: '556677',
      flyOrg: 'motir',
      flyApp: `motir-agents-wait-${accountSeq}`,
      flyRegion: 'iad',
      credentialRef: 'FLEET_SHARD_TEST_TOKEN',
      machineLimit,
    },
  });
}

/** `count` live hosted slots on `shard`, held by runs of ANOTHER org. */
async function fill(shard: FleetShard, count = 1): Promise<string[]> {
  const other = await adminDb.organization
    .findFirstOrThrow({
      where: { id: { not: fx.workspace.organizationId } },
    })
    .catch(async () => {
      const o = await makeWorkItemFixture();
      return { id: o.workspace.organizationId };
    });
  const refs: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const ref = `other-${shard.id}-${i}`;
    refs.push(ref);
    await withSystemContext((tx) =>
      fleetInFlightSlotRepository.take(
        {
          workload: 'hosted_agent',
          ref,
          ownerRef: ref,
          organizationId: other.id,
          fleetShardId: shard.id,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
        tx,
      ),
    );
  }
  return refs;
}

const provisionsOn = (shard: FleetShard) => fakeOrchestratorForShard(shard.id).provisioned.length;
const admitEvents = () => adminDb.jobEvent.findMany({ where: { name: 'hosted-run/admit' } });

/** Two accounts, both at their ceiling. */
async function fullPool(): Promise<{ a: FleetShard; b: FleetShard }> {
  const a = await agentAccount(1);
  const b = await agentAccount(1);
  await fill(a);
  await fill(b);
  return { a, b };
}

describe('the waiting reasons', () => {
  it('are exactly plan_cap, plan_unknown and shard_capacity', () => {
    expect([...HOSTED_RUN_WAITING_REASONS].sort()).toEqual([
      'plan_cap',
      'plan_unknown',
      'shard_capacity',
    ]);
  });
});

describe('a full agent-runner pool waits — it is not ended', () => {
  it('every account at its ceiling: the run stays open and claimed, boots nothing, and says why', async () => {
    const { a, b } = await fullPool();
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard('a card the pool has no room for');

    const started = await start(card.identifier);

    expect(started.created).toBe(true);
    expect(await runRow(started.dispatchRunId)).toMatchObject({ status: 'running' });
    const claimed = await adminDb.workItem.findFirstOrThrow({ where: { id: card.id } });
    expect(claimed).toMatchObject({ status: 'in_progress', assigneeId: fx.ownerId });
    expect([provisionsOn(a), provisionsOn(b), fakeOrchestrator.provisioned.length]).toEqual([
      0, 0, 0,
    ]);
    const events = await admitEvents();
    expect(events).toHaveLength(1);
    expect((events[0]!.data as unknown as HostedRunAdmitData).idempotencyKey).toBe(
      hostedRunAdmitKey(started.dispatchRunId),
    );
    expect(await waitingLines(started.dispatchRunId)).toEqual([WAITING_LINE]);
    // No credential for a run that was not admitted.
    expect(mintCalls()).toHaveLength(0);
  });

  it('every account refusing the boot for capacity waits the same way, leaving nothing behind', async () => {
    const a = await agentAccount(5);
    const b = await agentAccount(5);
    fakeOrchestratorForShard(a.id).failNextProvisionForCapacity('out_of_stock');
    fakeOrchestratorForShard(b.id).failNextProvisionForCapacity('quota_exceeded');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });

    const started = await start((await newCard('refused everywhere')).identifier);

    expect(await runRow(started.dispatchRunId)).toMatchObject({ status: 'running' });
    expect(await waitingLines(started.dispatchRunId)).toEqual([WAITING_LINE]);
    expect(fakeOrchestratorForShard(a.id).liveContainerIds()).toEqual([]);
    expect(fakeOrchestratorForShard(b.id).liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(
      await adminDb.fleetInFlightSlot.count({
        where: { ref: hostedRunDispatchId(started.dispatchRunId) },
      }),
    ).toBe(0);
    expect(await admitEvents()).toHaveLength(1);
  });

  it('a pass still full writes no second line and provisions nothing', async () => {
    const { a, b } = await fullPool();
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const started = await start((await newCard('still full')).identifier);

    expect(await hostedRunService.admit(await admitPayload(started.dispatchRunId))).toMatchObject({
      kind: 'waiting',
      detail: HOSTED_AGENT_SHARD_CAPACITY_DETAIL,
    });
    expect(await waitingLines(started.dispatchRunId)).toHaveLength(1);
    expect([provisionsOn(a), provisionsOn(b), fakeOrchestrator.provisioned.length]).toEqual([
      0, 0, 0,
    ]);
  });

  it('a run that waited on its plan and then on the pool carries both lines, in their own words', async () => {
    const a = await agentAccount(1);
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({
      kind: 'plan_unknown',
      planKey: null,
    });
    const started = await start((await newCard('plan, then pool')).identifier);
    expect(await waitingLines(started.dispatchRunId)).toHaveLength(1);

    vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({ kind: 'exempt' });
    await fill(a);
    expect(await hostedRunService.admit(await admitPayload(started.dispatchRunId))).toMatchObject({
      kind: 'waiting',
    });

    const lines = await waitingLines(started.dispatchRunId);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(WAITING_LINE);
    expect(lines[0]).not.toBe(WAITING_LINE);
  });
});

describe('a waiting run boots itself once an account has room', () => {
  it('boots on the freed account only, records it, and mints its credentials at that pass', async () => {
    const a = await agentAccount(1);
    const b = await agentAccount(1);
    const [onA] = await fill(a);
    await fill(b);
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const started = await start((await newCard('waits, then boots')).identifier);
    expect(mintCalls()).toHaveLength(0);
    await hostedRunService.admit(await admitPayload(started.dispatchRunId));
    expect(mintCalls()).toHaveLength(0);
    expect(await adminDb.apiToken.count({ where: { dispatchRunId: started.dispatchRunId } })).toBe(
      0,
    );

    await fleetCeilingService.release('hosted_agent', onA!, onA!);
    const startedAt = (await runRow(started.dispatchRunId)).startedAt;
    const admittedAt = new Date(startedAt.getTime() + 20 * 60_000);
    const result = await hostedRunService.admit(await admitPayload(started.dispatchRunId), {
      now: () => admittedAt,
      supervision: { now: () => admittedAt },
    });

    expect(result).toEqual({ kind: 'booted' });
    expect([provisionsOn(a), provisionsOn(b), fakeOrchestrator.provisioned.length]).toEqual([
      1, 0, 0,
    ]);
    expect(await runRow(started.dispatchRunId)).toMatchObject({ fleetShardId: a.id });
    expect(mintCalls()).toHaveLength(1);
    expect(mintCalls()[0]!.body!['expiresAt']).toBe(
      Math.floor((admittedAt.getTime() + HOSTED_RUN_TIMEOUT_MS) / 1000),
    );
    const token = await adminDb.apiToken.findFirstOrThrow({
      where: { dispatchRunId: started.dispatchRunId },
    });
    expect(token.expiresAt!.getTime()).toBe(
      admittedAt.getTime() + HOSTED_RUN_TIMEOUT_MS + HOSTED_RUN_SETTLE_MARGIN_MS,
    );
    expect(fakeOrchestratorForShard(a.id).specs[0]!.env).toMatchObject({
      MOTIR_DISPATCH_RUN_ID: started.dispatchRunId,
      MOTIR_RUN_KEY: 'sk-run-key-secret',
    });
  });

  it('a run cancelled while it waited is closed: no container, no credential', async () => {
    const { a } = await fullPool();
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const started = await start((await newCard('cancelled while waiting')).identifier);
    await hostedRunService.cancel(started.dispatchRunId, fx.ctx);
    await adminDb.fleetInFlightSlot.deleteMany({ where: { fleetShardId: a.id } });

    expect(await hostedRunService.admit(await admitPayload(started.dispatchRunId))).toEqual({
      kind: 'closed',
    });
    expect(provisionsOn(a)).toBe(0);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await adminDb.apiToken.count({ where: { dispatchRunId: started.dispatchRunId } })).toBe(
      0,
    );
  });
});

describe('the other start paths wait the same way', () => {
  it('a continue start on a full pool waits', async () => {
    const { a, b } = await fullPool();
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard('a card whose run died');
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { status: 'in_progress', assigneeId: fx.ownerId },
    });
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: card.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [
        {
          kind: 'checkout_ready',
          workItemKey: card.identifier,
          disposition: 'running',
          data: { branch: `subtask/${card.identifier}-work` },
        },
      ],
      fx.ctx,
    );
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 7 * 60_000) },
    });

    const started = await hostedRunService.start(
      {
        workItemKey: card.identifier,
        model: MODEL,
        idempotencyKey: 'continue-press',
        mode: 'continue',
      },
      fx.ctx,
    );

    expect(await runRow(started.dispatchRunId)).toMatchObject({
      status: 'running',
      command: 'continue',
    });
    expect(await waitingLines(started.dispatchRunId)).toEqual([WAITING_LINE]);
    expect([provisionsOn(a), provisionsOn(b), fakeOrchestrator.provisioned.length]).toEqual([
      0, 0, 0,
    ]);
  });
});

describe('the refusals that do not clear by themselves still end the run', () => {
  it('the kill switch at 0 ends a hosted run failed, with the switch on', async () => {
    await agentAccount(5);
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    await expect(start((await newCard('kill switch')).identifier)).rejects.toThrow();
    const runs = await adminDb.dispatchRun.findMany({ where: { workspaceId: fx.workspaceId } });
    expect(runs.map((r) => r.status)).toEqual(['failed']);
    expect(await admitEvents()).toHaveLength(0);
  });

  it('no paid plan ends a hosted run failed, with the switch on', async () => {
    await agentAccount(5);
    _resetAiPlanCache();
    vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(false);
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    await expect(start((await newCard('no plan')).identifier)).rejects.toThrow();
    const runs = await adminDb.dispatchRun.findMany({ where: { workspaceId: fx.workspaceId } });
    expect(runs.every((r) => r.status !== 'running')).toBe(true);
    expect(await admitEvents()).toHaveLength(0);
  });
});
