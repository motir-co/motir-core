import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import type { HostedRunAdmitData } from '@/lib/jobs/types';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { PLAN_CACHE_TTL_MS } from '@/lib/services/orgPlanReader';
import { _resetPlanCapsCache, planCapsService } from '@/lib/services/planCapsService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import { codeGraphIndexAdmissionService } from '@/lib/services/codeGraphIndexAdmissionService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { platformFleetMonitorService } from '@/lib/services/platformFleetMonitorService';
import { ciFleetAdmissionLockRepository } from '@/lib/repositories/ciFleetAdmissionLockRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { withSystemContext } from '@/lib/workspaces/context';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { refusalKey } from '@/app/(authed)/my-agents/_components/agentRefusal';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';
import {
  AI,
  fleet,
  fx,
  otherMember,
  setUpHarness,
  slots as agentSlots,
  stub,
  tearDownHarness,
} from '../agentInstances/_harness';

// THE INTEGRATION GATE for Story MOTIR-9363 (MOTIR-9378) — each organisation is
// held to its PLAN's figures, one per workload (decision MOTIR-9357, amending
// `fleet-per-org-pool.md` §2).
//
// Every code card proved its own gate with its neighbour's seam stubbed. This
// file runs the ASSEMBLED surface: the REAL `planCapsService.capsFor` (and the
// paid-plan gate it shares one read with) over the motir-ai subscription answered
// at `fetch`, feeding the REAL hosted-run, agent-instance, CI and index gates,
// over real Postgres and the real `fleet` admission lock, with the platform
// monitor reading the same org. Faked: motir-ai, the gateway and GitHub at
// `fetch`, and the provider (the fake ephemeral and persistent orchestrators).
//
// Four things are proven here and nowhere else:
//   1. the lookup→admission seams — one plan read reaches every door and the
//      monitor, they agree on the figure, a plan change reaches all of them after
//      the 30-second cache, and an unreadable plan fails closed at every door;
//   2. workload independence under the one lock — each workload fills its OWN
//      figure while the others still admit, including inside one race;
//   3. a cap that holds over one org's work split across two accounts;
//   4. the kill switch, and the two retired variables that no longer decide.
//
// ⚠️ THE CONTAINER AND SLOT COUNTS ARE THE ASSERTIONS throughout: a held run that
// booted reads the same from its status alone.

const MODEL = 'claude-opus-5-5';
const GATEWAY = 'https://gateway.test';
const MOTIR_ORG = 'motir-projects';

interface Tier {
  key: string;
  name: string;
  monthlyCreditAllotment: number;
}

const TIERS = {
  standard: { key: 'standard', name: 'Standard', monthlyCreditAllotment: 3_000 },
  pro: { key: 'pro', name: 'Pro', monthlyCreditAllotment: 15_000 },
  max: { key: 'max', name: 'Max', monthlyCreditAllotment: 30_000 },
  legacy: { key: 'legacy_tier', name: 'Legacy', monthlyCreditAllotment: 0 },
} satisfies Record<string, Tier>;

/** The subscription motir-ai answers: a tier, a null tier, or a failed read. */
let subscription: { kind: 'tier'; tier: Tier | null } | { kind: 'throws' };

/** Move the org to a plan. `fresh` forgets the cached read, as a new process would. */
function onPlan(tier: Tier | null, { fresh = true } = {}): void {
  subscription = { kind: 'tier', tier };
  if (fresh) _resetPlanCapsCache();
}

let runKeySeq = 0;
let tokenSeq = 0;

/** motir-ai, the gateway and GitHub — every boundary the four doors cross. Only
 *  the SUBSCRIPTION varies by case; everything else answers "yes". */
function stubBoundaries(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      stub.calls.push({ url, method, body });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      if (url.startsWith(`${AI}/v1/stripe/subscription?`)) {
        if (subscription.kind === 'throws') throw new Error('ECONNREFUSED');
        return json(200, {
          status: 'active',
          currentPeriodEnd: null,
          priceId: null,
          planTier: subscription.tier,
        });
      }
      if (url.startsWith(`${AI}/v1/usage`)) return json(200, { balance: 1_000 });
      if (url === `${AI}/v1/agent-models`) {
        return json(200, {
          models: [{ id: MODEL, provider: 'anthropic' }],
          default: MODEL,
        });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
        return json(200, {
          coreOrganizationId: body?.['coreOrganizationId'],
          balanceCredits: 250,
          hasCredits: true,
          mayRun: true,
        });
      }
      if (url === `${AI}/v1/credits/agent-machine`) {
        return json(200, { idempotent: false, balanceCredits: 90 });
      }
      if (url === `${GATEWAY}/api/motir/run-keys` && method === 'POST') {
        runKeySeq += 1;
        return json(201, {
          key: `sk-run-key-${runKeySeq}`,
          runRef: body?.['runRef'],
          coreOrganizationId: body?.['coreOrganizationId'],
          expiresAt: body?.['expiresAt'],
          lane: 'agent',
        });
      }
      if (url.startsWith(`${GATEWAY}/api/motir/run-keys/`) && method === 'DELETE') {
        return json(200, { runRef: url.split('/').pop(), revoked: 1 });
      }
      const installation = /\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url);
      if (installation && method === 'GET') {
        const owner = installation[1] ?? '';
        return json(200, {
          id: 42,
          account: { login: owner },
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
          suspended_at: null,
          html_url: `https://github.com/organizations/${owner}/settings/installations/42`,
        });
      }
      if (url.endsWith('/app/installations/42/access_tokens') && method === 'POST') {
        tokenSeq += 1;
        return json(201, { token: `ghs_clone_${tokenSeq}`, expires_at: '2026-09-29T23:00:00Z' });
      }
      if (url.endsWith('/installation/token') && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

const orgId = () => fx.workspace.organizationId;

async function setOrg(data: {
  isMeta?: boolean;
  internalBilling?: boolean;
  fleetPoolCap?: number | null;
}): Promise<void> {
  await adminDb.organization.update({ where: { id: orgId() }, data });
  _resetPlanCapsCache();
}

// ── hosted runs ─────────────────────────────────────────────────────────────

let repoSeeded = false;

/** A Motir-hosted repository for the fixture's project, once. */
async function ensureRepo(): Promise<void> {
  if (repoSeeded) return;
  repoSeeded = true;
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${fx.workspaceId}-hosted`,
      workspaceId: fx.workspaceId,
      organizationId: orgId(),
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: orgId(),
      repoId: String(900_000 + Math.floor(Math.random() * 90_000)),
      owner: MOTIR_ORG,
      name: 'site',
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
      name: 'site',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'created',
      position: 'a0011',
      githubRepoId: mirror.id,
    },
  });
}

let runSeq = 0;

/** Run hosted on a fresh card, through the product's own start. */
async function startHostedRun(): Promise<string> {
  await ensureRepo();
  runSeq += 1;
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `hosted card ${runSeq}` },
    fx.ctx,
  );
  const started = await hostedRunService.start(
    { workItemKey: card.identifier, model: MODEL, idempotencyKey: `idem-${runSeq}` },
    fx.ctx,
  );
  return started.dispatchRunId;
}

const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });

/** The run's admission job payload, exactly as the start stored it. */
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

/** Free a booted run's slot — as its settle would. */
const releaseSlotOf = (dispatchRunId: string) =>
  fleetCeilingService.release('hosted_agent', hostedRunDispatchId(dispatchRunId), dispatchRunId);

const hostedSlots = () =>
  adminDb.fleetInFlightSlot.count({ where: { workload: 'hosted_agent', organizationId: orgId() } });

// ── CI and index ────────────────────────────────────────────────────────────

let jobSeq = 0;

async function seedIntent(
  overrides: {
    status?: string;
    installationId?: string;
    containerProvider?: string;
    containerId?: string;
  } = {},
): Promise<CiRunnerProvisioningIntent> {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: orgId(),
      projectId: fx.projectId,
      installationId: overrides.installationId ?? '556677',
      runId: '9378',
      runAttempt: 1,
      jobId: String(93_780_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'site',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(),
      status: overrides.status ?? 'pending',
      containerProvider: overrides.containerProvider ?? null,
      containerId: overrides.containerId ?? null,
    },
  });
}

async function ciInFlight(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await seedIntent({ status: 'running' });
}

const admitCi = async () => ciRunnerAdmissionService.admit(await seedIntent());

/** The org's census — the count every gate decides on. */
const census = () =>
  withSystemContext((tx) => fleetCeilingService.orgCensus(orgId(), new Date(), tx));

/** The org's CI runners in flight, as the CI gate counts them. */
const ciRunning = async () => (await census()).byWorkload.ci_runner;

let indexSeq = 0;
const admitIndex = () => {
  indexSeq += 1;
  return codeGraphIndexAdmissionService.admit({
    organizationId: orgId(),
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    repoRef: `acme/repo-${indexSeq}`,
    dispatchId: `dispatch-${indexSeq}`,
    containerTimeoutMs: 60_000,
  });
};

// ── agent instances ─────────────────────────────────────────────────────────

const create = (name: string, ctx = fx.ctx) =>
  lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, ctx);

/** An agent of the owner's, created and put to sleep — something to wake. */
async function sleepingAgent(name: string): Promise<string> {
  const agent = await create(name);
  await lifecycle.hibernate(fx.projectIdentifier, agent.id, fx.ctx);
  return agent.id;
}

const wake = (id: string) => lifecycle.wake(fx.projectIdentifier, id, fx.ctx);

let seededAgents = 0;
/** `count` agents already running in the org, owned by another member. */
async function agentsRunning(count: number): Promise<void> {
  const owner = await otherMember();
  for (let i = 0; i < count; i++) {
    seededAgents += 1;
    await adminDb.agentInstance.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: orgId(),
        projectId: fx.projectId,
        ownerId: owner.userId,
        name: `seeded-${seededAgents}`,
        profileId: 'claude',
        imageTag: 't',
        imageDigest: 'sha256:x',
        region: 'iad',
        state: 'running',
      },
    });
  }
}

const runningAgents = () =>
  adminDb.agentInstance.count({
    where: { organizationId: orgId(), state: { in: ['running', 'starting', 'waking'] } },
  });

const monitorPlan = async () =>
  (await platformFleetMonitorService.judgeOrganization(orgId(), new Date())).plan;

// ── the harness ─────────────────────────────────────────────────────────────

beforeEach(async () => {
  await setUpHarness();
  await truncateJobRuns();
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  repoSeeded = false;
  onPlan(TIERS.standard);
  vi.stubEnv('MOTIR_GATEWAY_URL', GATEWAY);
  vi.stubEnv('MOTIR_GATEWAY_RUN_URL', GATEWAY);
  vi.stubEnv('MOTIR_RUN_KEY_MINT_SECRET', 'mint-secret');
  vi.stubEnv('MOTIR_BASE_URL', 'https://app.test/');
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  stubBoundaries();
  // Every refusal logs; the assertions are on verdicts and rows.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  await tearDownHarness();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── 1 · one plan, every door ────────────────────────────────────────────────

describe('a plan read once reaches every door, each with its own figure', () => {
  it('Standard: the second hosted run waits naming Standard and 1, and boots itself once the first frees its slot', async () => {
    onPlan(TIERS.standard);
    const first = await startHostedRun();
    const held = await startHostedRun();

    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(await runRow(held)).toMatchObject({ status: 'running' });
    expect(await waitingLines(held)).toEqual([
      '[motir] waiting for room: a Standard organization runs 1 agent run at once, and 1 is already running\n',
    ]);

    // Still held: the admit job's pass waits again, and boots nothing.
    expect(await hostedRunService.admit(await admitPayload(held))).toMatchObject({
      kind: 'waiting',
    });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);

    await releaseSlotOf(first);
    expect(await hostedRunService.admit(await admitPayload(held))).toEqual({ kind: 'booted' });
    expect(fakeOrchestrator.provisioned).toHaveLength(2);
    expect(await hostedSlots()).toBe(1);
  });

  it('Pro: three runs boot and the fourth waits; the third create is user_cap 2 Pro; the sixth CI job is plan_cap Pro 5', async () => {
    onPlan(TIERS.pro);
    const runs = [];
    for (let i = 0; i < 4; i++) runs.push(await startHostedRun());
    expect(fakeOrchestrator.provisioned).toHaveLength(3);
    expect(await waitingLines(runs[3]!)).toEqual([
      '[motir] waiting for room: a Pro organization runs 3 agent runs at once, and 3 are already running\n',
    ]);

    for (let i = 1; i <= 2; i++) expect((await create(`pro-${i}`)).state).toBe('running');
    await expect(create('pro-3')).rejects.toMatchObject({
      reason: 'user_cap',
      limit: 2,
      planName: 'Pro',
    });

    for (let i = 0; i < 5; i++) {
      expect(await admitCi()).toMatchObject({ outcome: 'admitted', ciBurstCap: 5 });
    }
    const sixth = await admitCi();
    expect(sixth).toMatchObject({ outcome: 'deferred', reason: 'plan_cap' });
    expect((sixth as { detail: string }).detail).toMatch(
      /^a Pro organization runs 5 CI jobs at once, and 5 are already running/,
    );

    // Each workload sits at its own figure, and none borrowed from another.
    expect(await hostedSlots()).toBe(3);
    expect(await agentSlots()).toHaveLength(2);
    expect(await ciRunning()).toBe(5);
  });
});

// ── 2 · workload independence ───────────────────────────────────────────────

describe('each workload fills its own figure while the others still admit', () => {
  it('Max with CI at 10: the 11th CI job waits, and a hosted run and an agent wake in the same org are admitted', async () => {
    onPlan(TIERS.max);
    const sleeping = await sleepingAgent('sleeper');
    await ciInFlight(10);

    expect(await admitCi()).toMatchObject({ outcome: 'deferred', reason: 'plan_cap' });

    const run = await startHostedRun();
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(await waitingLines(run)).toEqual([]);

    expect((await wake(sleeping)).state).toBe('running');
    expect(await ciRunning()).toBe(10);
  });

  it('Standard with its hosted run and two agents running: CI still admits its own two, and indexing answers only to the index caps', async () => {
    onPlan(TIERS.standard);
    await startHostedRun();
    await agentsRunning(2);
    // Both at their figures: a second run would wait, a third agent is refused.
    await expect(create('one-too-many')).rejects.toMatchObject({ reason: 'org_cap' });

    for (let i = 0; i < 2; i++) {
      expect(await admitCi()).toMatchObject({ outcome: 'admitted', ciBurstCap: 2 });
    }
    expect(await admitCi()).toMatchObject({ outcome: 'deferred', reason: 'plan_cap' });

    // Index containers: no plan figure. Global 2 ⇒ the org's share is 1.
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '2');
    expect((await admitIndex()).outcome).toBe('admitted');
    expect(await admitIndex()).toMatchObject({ outcome: 'deferred', reason: 'org_index_cap' });
  });

  // ⚠️ MUTATION-CHECK: delete the `lockScope` call in `ciRunnerAdmissionService.admit`
  // and both CI racers read "9 in flight" and both claim — 11 against a figure of 10.
  it('one Max org racing CI (twice its room), a hosted run and a wake inside one admission window: no workload passes its figure', async () => {
    onPlan(TIERS.max);
    const sleeping = await sleepingAgent('racer');
    await ciInFlight(9);
    const [a, b] = [await seedIntent(), await seedIntent()];
    const lock = vi.spyOn(ciFleetAdmissionLockRepository, 'lockScope');

    const [ciA, ciB, run, woken] = await Promise.all([
      ciRunnerAdmissionService.admit(a),
      ciRunnerAdmissionService.admit(b),
      startHostedRun(),
      wake(sleeping),
    ]);

    const ci = [ciA, ciB];
    expect(ci.filter((v) => v.outcome === 'admitted')).toHaveLength(1);
    expect(ci.filter((v) => v.outcome === 'deferred' && v.reason === 'plan_cap')).toHaveLength(1);
    expect(await ciRunning()).toBe(10);
    expect(await runRow(run)).toMatchObject({ status: 'running' });
    expect(await waitingLines(run)).toEqual([]);
    expect(await hostedSlots()).toBe(1);
    expect(woken.state).toBe('running');
    expect(await runningAgents()).toBeLessThanOrEqual(20);
    // Every one of the three gates took the one lock.
    expect(lock.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('two admit passes for one waiting Standard run, racing for the freed slot, hold at most one slot for it', async () => {
    onPlan(TIERS.standard);
    const first = await startHostedRun();
    const held = await startHostedRun();
    await releaseSlotOf(first);
    const data = await admitPayload(held);

    const results = await Promise.all([hostedRunService.admit(data), hostedRunService.admit(data)]);

    // The loser's boot answered `already_booting` (its reserve: `already_held`).
    expect(results).toEqual([{ kind: 'booted' }, { kind: 'booted' }]);
    expect(fakeOrchestrator.provisioned).toHaveLength(2);
    expect(
      await adminDb.fleetInFlightSlot.count({
        where: { workload: 'hosted_agent', ref: hostedRunDispatchId(held) },
      }),
    ).toBe(1);
  });
});

// ── 3 · two accounts ────────────────────────────────────────────────────────

describe('one org’s work split across two accounts is held to the figure on the total', () => {
  // The census has no account column (`ci_runner_provisioning_intent` and
  // `fleet_in_flight_slot`, checked against prisma/schema.prisma): the split is
  // staged as two accounts would leave it — two GitHub installations, two
  // providers, two container-id namespaces. When the pool layer (MOTIR-8953)
  // adds an account column, half these rows take it and the assertions stand.
  const ACCOUNTS = [
    { installationId: 'inst-account-a', containerProvider: 'fly', prefix: 'acct-a' },
    { installationId: 'inst-account-b', containerProvider: 'aws', prefix: 'acct-b' },
  ] as const;

  it('Pro, five CI jobs and one-or-two runs on each account: the 11th CI job and the 4th run are deferred plan_cap', async () => {
    onPlan(TIERS.pro);
    for (let i = 0; i < 10; i++) {
      const account = ACCOUNTS[i % 2]!;
      await seedIntent({
        status: 'running',
        installationId: account.installationId,
        containerProvider: account.containerProvider,
        containerId: `${account.prefix}-ci-${i}`,
      });
    }
    for (let i = 0; i < 3; i++) {
      const account = ACCOUNTS[i % 2]!;
      await adminDb.fleetInFlightSlot.create({
        data: {
          workload: 'hosted_agent',
          ref: `${account.prefix}-run-${i}`,
          ownerRef: `${account.prefix}-run-${i}`,
          organizationId: orgId(),
          workspaceId: fx.workspaceId,
          containerProvider: account.containerProvider,
          containerId: `${account.prefix}-machine-${i}`,
          expiresAt: new Date(Date.now() + 60 * 60_000),
        },
      });
    }

    // Each account alone is under both figures…
    for (const account of ACCOUNTS) {
      expect(
        await adminDb.ciRunnerProvisioningIntent.count({
          where: { organizationId: orgId(), containerProvider: account.containerProvider },
        }),
      ).toBeLessThan(10);
      expect(
        await adminDb.fleetInFlightSlot.count({
          where: { organizationId: orgId(), containerProvider: account.containerProvider },
        }),
      ).toBeLessThan(3);
    }
    // …and the census counts both halves.
    expect((await census()).byWorkload).toMatchObject({ ci_runner: 10, hosted_agent: 3 });

    expect(await admitCi()).toMatchObject({ outcome: 'deferred', reason: 'plan_cap' });
    const fourth = await startHostedRun();
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await waitingLines(fourth)).toEqual([
      '[motir] waiting for room: a Pro organization runs 3 agent runs at once, and 3 are already running\n',
    ]);
  });
});

// ── 4 · a plan change, through the cache ────────────────────────────────────

describe('a plan change reaches every door after the 30-second cache, and ends nothing', () => {
  it('Pro → Standard: Pro’s figures hold inside the window, Standard’s after it, and what runs keeps running', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date());
    onPlan(TIERS.pro);
    await ciInFlight(2);
    await create('first');
    const firstRun = await startHostedRun();
    expect(
      (await platformFleetMonitorService.judgeOrganization(orgId(), new Date())).plan,
    ).toMatchObject({
      kind: 'capped',
      planKey: 'pro',
    });

    // The subscription moves; the cached read does not, yet.
    onPlan(TIERS.standard, { fresh: false });
    vi.setSystemTime(Date.now() + PLAN_CACHE_TTL_MS - 5_000);
    expect(await admitCi()).toMatchObject({ outcome: 'admitted', ciBurstCap: 5 });
    expect((await create('second')).state).toBe('running');
    const secondRun = await startHostedRun();
    expect(fakeOrchestrator.provisioned).toHaveLength(2);
    expect(await monitorPlan()).toMatchObject({ planKey: 'pro', ciBurstCap: 5 });

    // Past the cache: every door, and the monitor, judge Standard.
    vi.setSystemTime(Date.now() + 10_000);
    expect(await admitCi()).toMatchObject({ outcome: 'deferred', reason: 'plan_cap' });
    await expect(create('third')).rejects.toMatchObject({
      reason: 'user_cap',
      limit: 1,
      planName: 'Standard',
    });
    const thirdRun = await startHostedRun();
    expect(fakeOrchestrator.provisioned).toHaveLength(2);
    expect(await waitingLines(thirdRun)).toEqual([
      '[motir] waiting for room: a Standard organization runs 1 agent run at once, and 2 are already running\n',
    ]);
    expect(await monitorPlan()).toEqual({
      kind: 'capped',
      planKey: 'standard',
      planName: 'Standard',
      agentRunsInParallel: 1,
      agentsPerUser: 1,
      agentsPerOrg: 2,
      ciBurstCap: 2,
      ciBurstSource: 'plan',
    });

    // Nothing already in flight was ended by the downgrade.
    expect(await ciRunning()).toBe(3);
    expect(await agentSlots()).toHaveLength(2);
    expect(await runRow(firstRun)).toMatchObject({ status: 'running' });
    expect(await runRow(secondRun)).toMatchObject({ status: 'running' });
    expect(await hostedSlots()).toBe(2);
  });
});

// ── 5 · fail closed, and Motir's own ───────────────────────────────────────

describe('a plan with no figures fails closed at every door — no default, no fleetPoolCap fallback', () => {
  it.each([
    ['the subscription read throws', { kind: 'throws' } as const],
    ['the plan tier is null', { kind: 'tier', tier: null } as const],
    ['the key has no caps row (legacy_tier)', { kind: 'tier', tier: TIERS.legacy } as const],
  ])('%s', async (_, answer) => {
    onPlan(TIERS.pro);
    const sleeping = await sleepingAgent('sleeper');
    // A generous staff CI override — that it is never read as a fallback is the point.
    await setOrg({ fleetPoolCap: 50 });
    subscription = answer;
    _resetPlanCapsCache();
    const planKey = answer.kind === 'tier' && answer.tier ? answer.tier.key : null;
    const slotsBefore = await adminDb.fleetInFlightSlot.count();

    const run = await startHostedRun();
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await runRow(run)).toMatchObject({ status: 'running' });
    expect(await waitingLines(run)).toHaveLength(1);

    const ci = await admitCi();
    expect(ci).toMatchObject({ outcome: 'deferred', reason: 'plan_unknown' });
    if (planKey) expect((ci as { detail: string }).detail).toContain(planKey);

    // An unreadable SUBSCRIPTION is the paid-plan gate's refusal, asked first
    // (`ai_plan_unknown`); a readable one with no figures is the caps' (`plan_unknown`).
    const agentReason = answer.kind === 'throws' ? 'ai_plan_unknown' : 'plan_unknown';
    await expect(create('two')).rejects.toMatchObject({ reason: agentReason });
    await expect(wake(sleeping)).rejects.toMatchObject({ reason: agentReason });

    expect(await monitorPlan()).toEqual({ kind: 'plan_unknown', planKey });
    expect(await adminDb.fleetInFlightSlot.count()).toBe(slotsBefore);
    expect(await ciRunning()).toBe(0);
  });

  it.each([{ isMeta: true }, { internalBilling: true }])(
    'an org with %o is held by no plan figure, and the monitor reads exempt',
    async (flags) => {
      await setOrg(flags);
      // Answering a subscription would be a bug: an exempt org is never asked.
      subscription = { kind: 'throws' };

      for (let i = 0; i < 6; i++) await startHostedRun();
      expect(fakeOrchestrator.provisioned).toHaveLength(6);

      await ciInFlight(50);
      expect(await admitCi()).toMatchObject({ outcome: 'admitted', ciBurstCap: null });

      await agentsRunning(50);
      for (let i = 0; i < 11; i++) expect((await create(`e-${i}`)).state).toBe('running');

      expect(await monitorPlan()).toEqual({ kind: 'exempt', ciBurstOverride: null });
      expect(stub.calls.filter((c) => c.url.includes('/v1/stripe/subscription'))).toHaveLength(0);
    },
  );
});

// ── 6 · the kill switch, and the retired variables ──────────────────────────

describe('the kill switch stops every workload; the retired variables decide nothing', () => {
  it('MOTIR_FLEET_MAX_IN_FLIGHT=0 defers every new boot of every workload for an org under its figures', async () => {
    onPlan(TIERS.pro);
    const sleeping = await sleepingAgent('sleeper');
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');

    // The kill switch is not a wait: the run is refused at its start.
    await expect(startHostedRun()).rejects.toThrow(/kill switch is engaged/);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await hostedSlots()).toBe(0);

    expect(await admitCi()).toMatchObject({ outcome: 'deferred', reason: 'fleet_ceiling' });
    expect(await admitIndex()).toMatchObject({ outcome: 'deferred', reason: 'fleet_ceiling' });
    await expect(create('two')).rejects.toMatchObject({ reason: 'fleet_busy' });
    await expect(wake(sleeping)).rejects.toMatchObject({ reason: 'fleet_busy' });
  });

  it('MOTIR_FLEET_ORG_MAX_IN_FLIGHT=1 and MOTIR_INSTANCE_MAX_RUNNING=1 change no verdict', async () => {
    onPlan(TIERS.pro);
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '1');
    vi.stubEnv('MOTIR_INSTANCE_MAX_RUNNING', '1');

    await startHostedRun();
    await startHostedRun();
    expect(fakeOrchestrator.provisioned).toHaveLength(2);
    expect(await admitCi()).toMatchObject({ outcome: 'admitted', ciBurstCap: 5 });
    expect(await admitCi()).toMatchObject({ outcome: 'admitted', ciBurstCap: 5 });
    expect((await create('one')).state).toBe('running');
    expect((await create('two')).state).toBe('running');
  });
});

// ── 7 · the monitor reads what the gates apply ──────────────────────────────

describe('the platform monitor reports the figures the gates applied', () => {
  it.each([
    ['standard', TIERS.standard],
    ['pro', TIERS.pro],
    ['max', TIERS.max],
  ] as const)('%s: every figure equals the gate’s', async (_, tier) => {
    onPlan(tier);
    const caps = await planCapsService.capsFor(orgId());
    const ci = await fleetCeilingService.resolveCiBurstCap(orgId());
    if (caps.kind !== 'capped' || ci.kind !== 'capped') throw new Error('expected a capped plan');

    // The CI figure the gate applies, read off an admitted verdict.
    const admitted = await admitCi();
    expect(admitted).toMatchObject({ outcome: 'admitted', ciBurstCap: ci.figure });

    expect(await monitorPlan()).toEqual({
      kind: 'capped',
      planKey: tier.key,
      planName: tier.name,
      agentRunsInParallel: caps.caps.agentRunsInParallel,
      agentsPerUser: caps.caps.agentsPerUser,
      agentsPerOrg: caps.caps.agentsPerOrg,
      ciBurstCap: ci.figure,
      ciBurstSource: 'plan',
    });
  });

  it('a staff fleetPoolCap override on Max: the gate and the monitor both apply 7, marked override, and Max’s other figures stand', async () => {
    onPlan(TIERS.max);
    await setOrg({ fleetPoolCap: 7 });
    await ciInFlight(6);

    expect(await admitCi()).toMatchObject({ outcome: 'admitted', ciBurstCap: 7 });
    expect(await admitCi()).toMatchObject({ outcome: 'deferred', reason: 'plan_cap' });
    expect(await fleetCeilingService.resolveCiBurstCap(orgId())).toMatchObject({
      kind: 'capped',
      figure: 7,
      source: 'override',
    });
    expect(await monitorPlan()).toEqual({
      kind: 'capped',
      planKey: 'max',
      planName: 'Max',
      agentRunsInParallel: 5,
      agentsPerUser: 3,
      agentsPerOrg: 20,
      ciBurstCap: 7,
      ciBurstSource: 'override',
    });
  });
});

// ── 8 · the refusal the person reads ────────────────────────────────────────

describe('a real user_cap refusal reaches My agents with the plan’s figure', () => {
  it('create → mapAgentInstanceError: a 429 carrying reason, limit and planName, never 10 or 500', async () => {
    onPlan(TIERS.pro);
    for (let i = 1; i <= 2; i++) await create(`a-${i}`);
    const refused = await create('a-3').catch((e: unknown) => e);

    const res = mapAgentInstanceError(refused)!;
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      reason: string;
      limit: number;
      planName: string;
      error: string;
    };
    expect(body).toMatchObject({ reason: 'user_cap', limit: 2, planName: 'Pro' });
    expect(refusalKey(body)).toBe('userCap');
    expect(body.error).toContain('Pro plan allows 2 agents per person');
    expect(body.error).not.toMatch(/\b10\b/);
    expect(body.error).not.toContain('500');
    // Nothing was taken for the refused create.
    expect(await agentSlots()).toHaveLength(2);
    expect(fleet.persistentSpecs).toHaveLength(2);
  });
});
