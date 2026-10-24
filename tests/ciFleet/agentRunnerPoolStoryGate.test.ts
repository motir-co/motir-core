import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator, type ContainerSpec } from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { FleetShard } from '@/generated/prisma/client';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import type { HostedRunAdmitData, HostedRunSuperviseData } from '@/lib/jobs/types';
import { isJobRunDefer } from '@/lib/jobs/engine/defer';
import { inMemorySupervisionStore, type SupervisionStore } from '@/lib/jobs/supervision/driver';
import type { MemoizingSteps } from '@/lib/jobs/supervision/inProcessSteps';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import {
  HOSTED_AGENT_SHARD_CAPACITY_DETAIL,
  fleetShardAdmissionService,
} from '@/lib/services/fleetShardAdmissionService';
import { fleetAttributionService } from '@/lib/services/fleetAttributionService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { withSystemContext } from '@/lib/workspaces/context';
import { AGENT_RUNNER_PROVIDER_ENV_VAR } from '@/lib/ciFleet/fleetKindSwitches';
import { fleetKindOnPool } from '@/lib/ciFleet/shardTargets';
import {
  fakeOrchestratorForShard,
  resetShardFakes,
  setAwsEc2OverrideForTests,
} from '@/lib/orchestrator';
import { createFileBackedEc2 } from '@/lib/test-fake-aws';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { fakeAwsInstances, stopFakeAwsInstance } from '../e2e/_helpers/fake-aws-boundary';

// THE STORY'S INTEGRATION GATE (Story MOTIR-9359 · MOTIR-9427) — the agent-runner
// pool as ONE chain: the slot ledger's account choice → boot on that account →
// poll and settle there → the reconciler finding the VM there, driven through
// the product's own entrances (`hostedRunService.start`, `admit`, `supervise`,
// `cancel`). Each card's own suite stops at its seam; a wrong account id at any
// handoff passes every one of them and bills a run on one account while it is
// supervised on another.
//
// ⚠️ THE LANE. The default `vitest.config.ts` project, like
// `hostedAgentMeterStoryGate.test.ts`: each worker has its own database, the
// tests in this file run in order on it, and the fakes are selected through the
// shipped `MOTIR_FLEET_ORCHESTRATOR=fake` seam — the legacy (Fly) fake plus one
// `fakeOrchestratorForShard` per account. motir-ai, the gateway and GitHub are
// stubbed at `fetch` exactly as `tests/hostedRuns/hostedRunPoolWait.test.ts` does.
//
// ⚠️ THE RECONCILE CASES RUN ON AWS. A VM booted on a per-account fake is
// invisible to an account's EC2 listing, so those cases put two `aws` accounts
// behind the acceptance lane's file-backed EC2 (`lib/test-fake-aws.ts`,
// MOTIR-9429) — the REAL AWS adapter and inventory over a temp file — while the
// fake orchestrator stays selected for everything else.
//
// ⚠️ WHAT THIS CANNOT ASSERT: motir-ai's credit ledger (the charge is observed as
// the request this repository sends), and a real AWS or Fly account.
//
// ⚠️ THE CONTAINER COUNT IS THE ASSERTION. A run that went to the wrong place
// reads the same from its status, so every case counts calls on every fake, and
// the never-Fly / never-a-CI-account guard is an `afterEach` over every
// switch-on case.

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const MINUTE = 60_000;
const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 1, bootDeadlineMs: 600 * MINUTE } as const;
const IMAGE =
  'ghcr.io/motir-co/motir-hosted-agent@sha256:e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];

function stub(): void {
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
        return json(200, { models: [{ id: MODEL, provider: 'anthropic' }], default: MODEL });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
        return json(200, { balanceCredits: 250, hasCredits: true, mayRun: true });
      }
      if (url === `${AI}/v1/credits/agent-machine`) {
        return json(200, {
          balanceAfter: 90,
          credits: 1,
          billableSeconds: 1,
          exhausted: false,
          idempotent: false,
        });
      }
      if (url === `${GATEWAY}/api/motir/run-keys` && method === 'POST') {
        return json(201, { key: 'sk-run-key-secret', runRef: body?.runRef });
      }
      if (url.startsWith(`${GATEWAY}/api/motir/run-keys/`) && method === 'DELETE') {
        return json(200, { runRef: url.split('/').pop(), revoked: 1 });
      }
      if (url === 'https://api.github.com/installation/token' && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      const inst = /\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url);
      if (inst && method === 'GET') {
        const owner = (inst[1] ?? '').split('/')[0];
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
const chargeCalls = () => calls.filter((c) => c.url === `${AI}/v1/credits/agent-machine`);

let fx: WorkItemFixture;
let repoSeq = 0;

async function seedRepo(): Promise<void> {
  repoSeq += 1;
  const organizationId = fx.workspace.organizationId;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}` },
    create: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      organizationId,
      accountLogin: 'motir-projects',
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
      repoId: String(940_000 + repoSeq),
      owner: 'motir-projects',
      name: `site-${repoSeq}`,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name: `site-${repoSeq}`,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'created',
      position: `a${String(repoSeq).padStart(3, '0')}`,
      githubRepoId: mirror.id,
    },
  });
}

let seq = 0;

/** Run hosted on a fresh card. */
async function runHosted(title = 'a hosted card') {
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `${title} ${++seq}` },
    fx.ctx,
  );
  return hostedRunService.start(
    { workItemKey: card.identifier, model: MODEL, idempotencyKey: `idem-${seq}` },
    fx.ctx,
  );
}

const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });
const slotOf = (dispatchRunId: string) =>
  adminDb.fleetInFlightSlot.findFirst({ where: { ref: hostedRunDispatchId(dispatchRunId) } });

async function jobData<T>(name: string, dispatchRunId: string): Promise<T> {
  const events = await adminDb.jobEvent.findMany({ where: { name } });
  const event = events.find(
    (e) => (e.data as { dispatchRunId?: string }).dispatchRunId === dispatchRunId,
  );
  if (!event) throw new Error(`no ${name} event for ${dispatchRunId}`);
  return event.data as unknown as T;
}
const superviseData = (id: string) => jobData<HostedRunSuperviseData>('hosted-run/supervise', id);
const admitData = (id: string) => jobData<HostedRunAdmitData>('hosted-run/admit', id);

function durableSteps(memo: Map<string, unknown>): MemoizingSteps {
  return {
    async run<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
      if (memo.has(id)) return memo.get(id) as T;
      const value = await fn();
      memo.set(id, value);
      return value;
    },
  };
}

/** One supervision pass: `defer`, or the settled reason. */
async function pass(
  data: HostedRunSuperviseData,
  memo: Map<string, unknown>,
  store: SupervisionStore,
): Promise<'defer' | string> {
  try {
    const outcome = await hostedRunService.supervise('gate-job', data, {
      ...FAST,
      steps: durableSteps(memo),
      supervisionStore: store,
    });
    return outcome.outcome === 'settled' ? outcome.reason : outcome.outcome;
  } catch (err) {
    if (isJobRunDefer(err)) return 'defer';
    throw err;
  }
}

/** A supervision the test can step: one pass at a time, or to the end. */
function supervisor(data: HostedRunSuperviseData) {
  const memo = new Map<string, unknown>();
  const store = inMemorySupervisionStore();
  return {
    once: () => pass(data, memo, store),
    async toEnd(): Promise<string> {
      let result = await pass(data, memo, store);
      for (let i = 0; i < 8 && result === 'defer'; i += 1) result = await pass(data, memo, store);
      if (result === 'defer') throw new Error('the supervision never returned');
      return result;
    },
  };
}

let accountSeq = 0;

async function flyAccount(
  fleetKind: 'hosted_agent' | 'ci_runner',
  machineLimit: number,
): Promise<FleetShard> {
  accountSeq += 1;
  return adminDb.fleetShard.create({
    data: {
      name: `gate-${fleetKind}-${accountSeq}`,
      fleetKind,
      provider: 'fly',
      state: 'active',
      githubOrg: 'motir-projects',
      githubInstallationId: '556677',
      flyOrg: 'motir',
      flyApp: `motir-gate-${accountSeq}`,
      flyRegion: 'iad',
      credentialRef: 'FLEET_SHARD_TEST_TOKEN',
      machineLimit,
    },
  });
}

/** `count` live hosted slots on `shard`, held by another org's runs. */
async function fill(shard: { id: string }, count = 1): Promise<string[]> {
  const other = await makeWorkItemFixture();
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
          organizationId: other.workspace.organizationId,
          fleetShardId: shard.id,
          expiresAt: new Date(Date.now() + 60 * MINUTE),
        },
        tx,
      ),
    );
  }
  return refs;
}

const fake = (shard: { id: string }) => fakeOrchestratorForShard(shard.id);
const hostedSpecs = (specs: readonly ContainerSpec[]) =>
  specs.filter((s) => s.workload === 'hosted_agent');

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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  stub();
  await seedRepo();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setAwsEc2OverrideForTests(null);
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.dispatchRun.updateMany({ data: { fleetShardId: null } });
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('with the agent-runner switch on', () => {
  /** Every `ci_runner` account the case made — the guard counts their fakes. */
  let ciAccounts: FleetShard[] = [];

  beforeEach(() => {
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    ciAccounts = [];
  });

  afterEach(() => {
    // THE GUARD: whatever path a case took, no hosted run reached Fly or a CI account.
    expect(hostedSpecs(fakeOrchestrator.specs)).toEqual([]);
    for (const ci of ciAccounts) expect(fake(ci).provisioned).toEqual([]);
  });

  /** A (ceiling 2, one live slot), B (ceiling 5, empty) and a roomier CI account C. */
  async function pool() {
    const a = await flyAccount('hosted_agent', 2);
    const b = await flyAccount('hosted_agent', 5);
    const c = await flyAccount('ci_runner', 50);
    ciAccounts.push(c);
    await fill(a);
    return { a, b, c };
  }

  it('reserves, boots, polls, settles and charges on the one account reserve chose', async () => {
    const { a, b, c } = await pool();
    const describeB = vi.spyOn(fake(b), 'describe');
    const touched = [a, c].map((s) => [
      vi.spyOn(fake(s), 'provision'),
      vi.spyOn(fake(s), 'describe'),
      vi.spyOn(fake(s), 'teardown'),
    ]);

    const started = await runHosted();
    const data = await superviseData(started.dispatchRunId);

    expect((await slotOf(started.dispatchRunId))?.fleetShardId).toBe(b.id);
    expect(data.session.handle.shardId).toBe(b.id);
    expect((await runRow(started.dispatchRunId)).fleetShardId).toBe(b.id);
    expect(fake(b).provisioned.map((h) => h.id)).toEqual([data.session.handle.id]);

    fake(b).completeJob(data.session.handle.id, { exitCode: 0 });
    await supervisor(data).toEnd();

    expect(describeB).toHaveBeenCalled();
    expect(fake(b).teardowns.map((t) => t.handleId)).toEqual([data.session.handle.id]);
    expect(fake(b).liveContainerIds()).toEqual([]);
    for (const spies of touched) for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(fakeOrchestrator.provisioned).toEqual([]);
    const usage = await adminDb.ciContainerUsage.findMany({
      where: { dispatchRunId: started.dispatchRunId },
    });
    expect(usage.length).toBeGreaterThan(0);
    for (const row of usage) {
      expect(row).toMatchObject({
        containerProvider: data.session.handle.provider,
        containerRegion: data.session.handle.region,
        handleId: data.session.handle.id,
      });
    }
    expect((await runRow(started.dispatchRunId)).status).not.toBe('running');
    expect(chargeCalls()).toHaveLength(1);
    expect(await slotOf(started.dispatchRunId)).toBeNull();
  });

  it('moves a capacity refusal to the other account in the same boot, minting once', async () => {
    const a = await flyAccount('hosted_agent', 5);
    const b = await flyAccount('hosted_agent', 3);
    fake(a).failNextProvisionForCapacity('out_of_stock');
    const provisionA = vi.spyOn(fake(a), 'provision');
    const describeA = vi.spyOn(fake(a), 'describe');
    const teardownA = vi.spyOn(fake(a), 'teardown');

    const started = await runHosted('refused on A');
    const data = await superviseData(started.dispatchRunId);

    expect(provisionA).toHaveBeenCalledTimes(1);
    expect(
      (await adminDb.fleetShard.findUniqueOrThrow({ where: { id: a.id } })).admissionPausedUntil,
    ).not.toBeNull();
    expect((await slotOf(started.dispatchRunId))?.fleetShardId).toBe(b.id);
    expect(data.session.handle.shardId).toBe(b.id);
    expect((await runRow(started.dispatchRunId)).fleetShardId).toBe(b.id);
    // Minted once, the same key and credential on both attempts.
    expect(mintCalls()).toHaveLength(1);
    const envA = provisionA.mock.calls[0]![0].env;
    const envB = fake(b).specs[0]!.env;
    expect(envB['MOTIR_RUN_KEY']).toBe(envA['MOTIR_RUN_KEY']);
    expect(envB['MOTIR_RUN_TOKEN']).toBe(envA['MOTIR_RUN_TOKEN']);
    expect(envB['MOTIR_RUN_TOKEN']).toBeTruthy();

    fake(b).completeJob(data.session.handle.id, { exitCode: 0 });
    await supervisor(data).toEnd();

    expect(fake(b).teardowns.map((t) => t.handleId)).toEqual([data.session.handle.id]);
    expect(describeA).not.toHaveBeenCalled();
    expect(teardownA).not.toHaveBeenCalled();
  });

  it('waits on a full pool, provisions nothing while waiting, and boots on the freed account', async () => {
    const a = await flyAccount('hosted_agent', 1);
    const b = await flyAccount('hosted_agent', 1);
    const [onA] = await fill(a);
    await fill(b);

    const started = await runHosted('full pool');
    expect(await runRow(started.dispatchRunId)).toMatchObject({ status: 'running' });
    const lines = (
      await adminDb.dispatchRunEvent.findMany({
        where: { dispatchRunId: started.dispatchRunId, kind: 'log' },
      })
    ).map((e) => e.body ?? '');
    expect(lines.filter((l) => l.includes(HOSTED_AGENT_SHARD_CAPACITY_DETAIL))).toHaveLength(1);
    expect(await hostedRunService.admit(await admitData(started.dispatchRunId))).toMatchObject({
      kind: 'waiting',
    });
    expect([fake(a).provisioned, fake(b).provisioned]).toEqual([[], []]);
    expect(mintCalls()).toHaveLength(0);

    await fleetCeilingService.release('hosted_agent', onA!, onA!);
    expect(await hostedRunService.admit(await admitData(started.dispatchRunId))).toEqual({
      kind: 'booted',
    });
    expect(mintCalls()).toHaveLength(1);
    const data = await superviseData(started.dispatchRunId);
    expect(data.session.handle.shardId).toBe(a.id);
    const describeB = vi.spyOn(fake(b), 'describe');

    fake(a).completeJob(data.session.handle.id, { exitCode: 0 });
    await supervisor(data).toEnd();

    expect(fake(a).teardowns.map((t) => t.handleId)).toEqual([data.session.handle.id]);
    expect(fake(b).provisioned).toEqual([]);
    expect(describeB).not.toHaveBeenCalled();
  });

  it('waits when every account refuses the boot, leaving no container and no slot', async () => {
    const a = await flyAccount('hosted_agent', 5);
    const b = await flyAccount('hosted_agent', 5);
    fake(a).failNextProvisionForCapacity('out_of_stock');
    fake(b).failNextProvisionForCapacity('quota_exceeded');

    const started = await runHosted('refused everywhere');

    expect(await runRow(started.dispatchRunId)).toMatchObject({ status: 'running' });
    expect([fake(a).liveContainerIds(), fake(b).liveContainerIds()]).toEqual([[], []]);
    expect(await slotOf(started.dispatchRunId)).toBeNull();
  });

  it('tears a cancelled run down on its account only, and releases its slot', async () => {
    const { a, b } = await pool();
    const teardownA = vi.spyOn(fake(a), 'teardown');
    const legacyTeardown = vi.spyOn(fakeOrchestrator, 'teardown');
    const started = await runHosted('cancelled');
    const data = await superviseData(started.dispatchRunId);
    expect(data.session.handle.shardId).toBe(b.id);

    await hostedRunService.cancel(started.dispatchRunId, fx.ctx);
    expect(await supervisor(data).toEnd()).toBe('gate_revoked');

    expect(fake(b).teardowns).toEqual([
      { handleId: data.session.handle.id, reason: 'gate_revoked' },
    ]);
    expect(teardownA).not.toHaveBeenCalled();
    expect(legacyTeardown).not.toHaveBeenCalled();
    expect(await slotOf(started.dispatchRunId)).toBeNull();
  });

  it('the kill switch at 0 refuses before any account is read or any fake is called', async () => {
    const { a, b } = await pool();
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    const choose = vi.spyOn(fleetShardAdmissionService, 'chooseInTx');
    const selection = vi.spyOn(fleetShardAdmissionService, 'selectionSetInTx');

    await expect(runHosted('kill switch')).rejects.toThrow();

    expect(choose).not.toHaveBeenCalled();
    expect(selection).not.toHaveBeenCalled();
    expect([fake(a).provisioned, fake(b).provisioned, fakeOrchestrator.provisioned]).toEqual([
      [],
      [],
      [],
    ]);
  });
});

describe('the reconciler finds the VM on the account it booted on (AWS-backed)', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    vi.stubEnv('MOTIR_HOSTED_AGENT_IMAGE', IMAGE);
    dir = mkdtempSync(join(tmpdir(), 'motir-gate-aws-'));
    statePath = join(dir, 'fake-aws.json');
    vi.stubEnv('MOTIR_FAKE_AWS_STATE_PATH', statePath);
    setAwsEc2OverrideForTests((shard, errors) => createFileBackedEc2(statePath, shard, errors));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    expect(hostedSpecs(fakeOrchestrator.specs)).toEqual([]);
  });

  async function awsAccount(label: string, machineLimit: number) {
    return fleetShardService.createShard({
      name: `hosted-agent-use1-${label}-${++accountSeq}`,
      fleetKind: 'hosted_agent',
      provider: 'aws',
      state: 'active',
      githubOrg: 'motir-projects',
      githubInstallationId: '556677',
      awsAccountId: label === 'a' ? '111111111111' : '222222222222',
      awsRegion: 'us-east-1',
      credentialRef: `AWS_GATE_${label.toUpperCase()}`,
      limits: { machineLimit },
    });
  }

  it('counts the live VM matched, and writes no kill once it has settled', async () => {
    const a = await awsAccount('a', 2);
    const b = await awsAccount('b', 5);
    await fill(a);
    const captured = vi.spyOn(console, 'error').mockImplementation(() => {});

    const started = await runHosted('on aws');
    const data = await superviseData(started.dispatchRunId);
    expect(data.session.handle).toMatchObject({ provider: 'aws', shardId: b.id });
    expect(fakeAwsInstances(a.id)).toEqual([]);
    const [vm] = fakeAwsInstances(b.id);
    expect(vm!.instanceId).toBe(data.session.handle.id);
    const run = supervisor(data);
    // Polled until the first checkpoint — the record the matcher attributes by.
    const checkpoints = () =>
      adminDb.ciContainerUsage.count({
        where: { containerProvider: 'aws', handleId: vm!.instanceId },
      });
    for (let i = 0; i < 4 && (await checkpoints()) === 0; i += 1) {
      expect(await run.once()).toBe('defer');
    }
    expect(await checkpoints()).toBe(1);

    const live = await fleetAttributionService.reconcile({ inventory: null, accounts: [a, b] });
    expect(live).toMatchObject({ outcome: 'reconciled', listed: 1, matched: 1, killed: [] });
    expect(fakeAwsInstances(b.id)[0]!.state).toBe('running');

    stopFakeAwsInstance(b, vm!.instanceId);
    await run.toEnd();
    expect(fakeAwsInstances(b.id)[0]!.state).toBe('terminated');

    const after = await fleetAttributionService.reconcile({ inventory: null, accounts: [a, b] });
    expect(after).toMatchObject({ outcome: 'reconciled', listed: 0, killed: [] });
    expect(await adminDb.fleetMachineKill.count({ where: { machineId: vm!.instanceId } })).toBe(0);
    expect(captured.mock.calls.filter((c) => String(c[0]).includes('fleetAttribution'))).toEqual(
      [],
    );
  });
});

describe('with the agent-runner switch off, and flipped at run time', () => {
  it('a run boots, is supervised and settles on the legacy fake, with no account recorded', async () => {
    const a = await flyAccount('hosted_agent', 5);
    const b = await flyAccount('hosted_agent', 5);
    const c = await flyAccount('ci_runner', 50);

    const started = await runHosted('switch off');
    const data = await superviseData(started.dispatchRunId);
    expect((await slotOf(started.dispatchRunId))?.fleetShardId).toBeNull();
    expect(data.session.handle.shardId).toBeUndefined();
    fakeOrchestrator.completeJob(data.session.handle.id, { exitCode: 0 });
    await supervisor(data).toEnd();

    expect(fakeOrchestrator.teardowns.map((t) => t.handleId)).toEqual([data.session.handle.id]);
    expect((await runRow(started.dispatchRunId)).fleetShardId).toBeNull();
    for (const s of [a, b, c]) expect(fake(s).provisioned).toEqual([]);
  });

  it('flipping the switch moves the hosted-agent kind only', async () => {
    const a = await flyAccount('hosted_agent', 5);
    const others = ['ci_runner', 'code_graph_index', 'agent_instance'] as const;
    const readOthers = () => Promise.all(others.map((k) => fleetKindOnPool(k)));
    const baseline = await readOthers();

    const run1 = await runHosted('flip 1');
    expect(await readOthers()).toEqual(baseline);
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    expect(await fleetKindOnPool('hosted_agent')).toBe(true);
    expect(await readOthers()).toEqual(baseline);
    const run2 = await runHosted('flip 2');
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, '');
    expect(await readOthers()).toEqual(baseline);
    const run3 = await runHosted('flip 3');

    expect((await runRow(run1.dispatchRunId)).fleetShardId).toBeNull();
    expect((await runRow(run2.dispatchRunId)).fleetShardId).toBe(a.id);
    expect((await runRow(run3.dispatchRunId)).fleetShardId).toBeNull();
    expect(hostedSpecs(fakeOrchestrator.specs)).toHaveLength(2);
    expect(fake(a).provisioned).toHaveLength(1);
  });
});
