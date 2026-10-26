import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiRunnerProvisioningIntent, FleetShard } from '@/generated/prisma/client';
import { fakeOrchestrator, type FleetWorkloadKind } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { HOST_PLAN_KEY } from '@/lib/billing/planCaps';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import type { FleetUseDTO } from '@/lib/dto/fleetUse';
import type { HostedRunAdmitData } from '@/lib/jobs/types';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { _resetPlanCapsCache, planCapsService } from '@/lib/services/planCapsService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { organizationsService } from '@/lib/services/organizationsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { GET } from '@/app/api/organizations/[orgId]/billing/fleet-use/route';
import { POST } from '@/app/api/organizations/[orgId]/billing/fleet-use/capacity-requests/route';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateJobRuns } from '../../helpers/db';
import { randomInt, randomToken } from '../../helpers/random';
import {
  AI,
  fx,
  otherMember,
  setUpHarness,
  stub,
  tearDownHarness,
} from '../../agentInstances/_harness';

// THE INTEGRATION GATE for Story MOTIR-9368 (MOTIR-9664) — an organisation's
// owner or admin sees its fleet use against its plan figures.
//
// Every card proved its own part with its neighbour stubbed. This file drives the
// REAL admission services into their deferrals over real Postgres and the real
// `fleet` lock, then reads the REAL route, and proves the three claims the story
// is accepted on:
//   1. the page agrees with admission — every figure is asserted equal to
//      `planCapsService.capsFor` / `fleetCeilingService.resolveCiBurstCap`, every
//      count to `fleetCeilingService.orgCensus` or the guard's own repository
//      count, read in the same test; the literals live in the test names only;
//   2. the two waits stay apart — `plan_cap` and `shard_capacity` come from real
//      `admit` passes and land in `planLimit` and `poolFull`;
//   3. every response is gated and isolated, and none carries an id or a secret.
//
// Faked: `getSession` (the one mock), motir-ai and GitHub at `fetch`, the
// providers (the fake orchestrator), Sentry, and AWS — an own account is its
// `fleet_shard` rows and quota request, as `tests/billing/fleetUseService.test.ts`
// seeds them; where a job lands is the real `fleetShardAdmissionService.chooseInTx`.

const session = vi.hoisted(() => ({
  current: null as { user: { id: string; email: string } } | null,
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const MODEL = 'claude-opus-5-5';
const GATEWAY = 'https://gateway.test';
const MOTIR_ORG = 'motir-projects';

interface Tier {
  key: string;
  name: string;
  monthlyCreditAllotment: number;
}

const TIERS = {
  pro: { key: 'pro', name: 'Pro', monthlyCreditAllotment: 15_000 },
  max: { key: 'max', name: 'Max', monthlyCreditAllotment: 30_000 },
  host: { key: HOST_PLAN_KEY, name: 'Host', monthlyCreditAllotment: 30_000 },
  legacy: { key: 'legacy_tier', name: 'Legacy', monthlyCreditAllotment: 0 },
} satisfies Record<string, Tier>;

/** The subscription motir-ai answers for every org: a tier, or a failed read. */
let subscription: { kind: 'tier'; tier: Tier | null } | { kind: 'throws' };

function onPlan(tier: Tier | null): void {
  subscription = { kind: 'tier', tier };
  _resetPlanCapsCache();
}

// ── the leak scan's two lists, filled by every case ──────────────────────────

/** Every response body any case produced, serialised, with the org id its URL
 *  named — a refusal may echo the id its own caller sent, and nothing else. */
const bodies: { text: string; askedFor: string }[] = [];
/** Every seeded value no response may carry. */
const forbidden = new Set<string>();

const remember = (...values: (string | null | undefined)[]) => {
  for (const value of values) if (value) forbidden.add(value);
};

// ── boundaries ───────────────────────────────────────────────────────────────

let runKeySeq = 0;
let tokenSeq = 0;

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
        return json(200, { models: [{ id: MODEL, provider: 'anthropic' }], default: MODEL });
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
        return json(201, { token: `ghs_clone_${tokenSeq}`, expires_at: '2026-10-29T23:00:00Z' });
      }
      if (url.endsWith('/installation/token') && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

// ── the routes, as a signed-in person calls them ─────────────────────────────

interface Person {
  id: string;
  email: string;
}

async function call(
  askedFor: string,
  res: Promise<Response>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await res;
  const text = await response.text();
  bodies.push({ text, askedFor });
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function readFleetUse(as: Person, organizationId: string) {
  session.current = { user: as };
  remember(as.id, as.email, organizationId);
  return call(
    organizationId,
    GET(new Request(`http://localhost/api/organizations/${organizationId}/billing/fleet-use`), {
      params: Promise.resolve({ orgId: organizationId }),
    }),
  );
}

/** The 200 body's DTO; any other answer fails the case. */
async function fleetUseOf(as: Person, organizationId: string): Promise<FleetUseDTO> {
  const res = await readFleetUse(as, organizationId);
  expect(res.status).toBe(200);
  return res.body['fleetUse'] as FleetUseDTO;
}

async function requestCapacity(
  as: Person,
  organizationId: string,
  body: { fleetKind: string; desiredVcpu: number; reason: string },
) {
  session.current = { user: as };
  remember(as.id, as.email, organizationId);
  return call(
    organizationId,
    POST(
      new Request(
        `http://localhost/api/organizations/${organizationId}/billing/fleet-use/capacity-requests`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
      { params: Promise.resolve({ orgId: organizationId }) },
    ),
  );
}

// ── the fixture org and its people ───────────────────────────────────────────

const orgId = () => fx.workspace.organizationId;
const owner = (): Person => ({ id: fx.owner.id, email: fx.owner.email });

async function addPerson(organizationId: string, role: 'admin' | 'member', by: string) {
  const user = await createTestUser();
  await organizationsService.addMember({ organizationId, userId: user.id, role, actorUserId: by });
  remember(user.id, user.email);
  return { id: user.id, email: user.email } satisfies Person;
}

async function setOrg(data: { isMeta?: boolean; internalBilling?: boolean }): Promise<void> {
  await adminDb.organization.update({ where: { id: orgId() }, data });
  _resetPlanCapsCache();
}

/** A second organisation, with its own owner and project. */
async function otherOrg() {
  const ownerUser = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Other',
    ownerUserId: ownerUser.id,
  });
  remember(ownerUser.id, ownerUser.email, workspace.organizationId, workspace.id);
  return {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    owner: { id: ownerUser.id, email: ownerUser.email } satisfies Person,
  };
}

// ── what the gates count, read the way they read it ──────────────────────────

const censusOf = (organizationId: string) =>
  withSystemContext((tx) => fleetCeilingService.orgCensus(organizationId, new Date(), tx));

/** The org's running agents — the running-cap guard's own count. */
const runningAgentsOf = (organizationId: string) =>
  withSystemContext(async (tx) => {
    const live = await fleetInFlightSlotRepository.listLiveForOrganization(
      organizationId,
      'agent_instance',
      new Date(),
      tx,
    );
    return agentInstanceRepository.countRunningOrAdmitting(
      organizationId,
      live.map((slot) => slot.ref),
      tx,
    );
  });

async function cappedFigures(organizationId: string) {
  const caps = await planCapsService.capsFor(organizationId);
  const ci = await fleetCeilingService.resolveCiBurstCap(organizationId);
  if (caps.kind !== 'capped' || ci.kind !== 'capped') throw new Error('expected a capped plan');
  return { caps: caps.caps, ci: ci.figure };
}

// ── hosted runs ──────────────────────────────────────────────────────────────

let repoSeeded = false;

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
      repoId: String(900_000 + randomInt(90_000)),
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

async function admitPayload(dispatchRunId: string): Promise<HostedRunAdmitData> {
  const events = await adminDb.jobEvent.findMany({ where: { name: 'hosted-run/admit' } });
  const event = events.find(
    (e) => (e.data as unknown as HostedRunAdmitData).dispatchRunId === dispatchRunId,
  );
  if (!event) throw new Error(`no admission event for ${dispatchRunId}`);
  return event.data as unknown as HostedRunAdmitData;
}

/** Four runs started: three boot, the fourth is held at the plan's figure. */
async function fourHostedRuns(): Promise<string[]> {
  const runs: string[] = [];
  for (let i = 0; i < 4; i++) runs.push(await startHostedRun());
  return runs;
}

// ── CI ───────────────────────────────────────────────────────────────────────

let jobSeq = 0;

async function seedIntent(
  organizationId: string,
  workspaceId: string,
  projectId: string | null,
  overrides: { status?: string; fleetShardId?: string } = {},
): Promise<CiRunnerProvisioningIntent> {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId,
      organizationId,
      projectId,
      installationId: '556677',
      runId: '9664',
      runAttempt: 1,
      jobId: String(96_640_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'site',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(),
      status: overrides.status ?? 'pending',
      fleetShardId: overrides.fleetShardId ?? null,
    },
  });
}

/** A CI job of the fixture org, judged by the real admission. */
const admitCi = async () =>
  ciRunnerAdmissionService.admit(await seedIntent(orgId(), fx.workspaceId, fx.projectId));

const intentRow = (id: string) =>
  adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id } });

// ── own and shared AWS accounts ──────────────────────────────────────────────

/** A shared account of `fleetKind`, as the pool layer's tests build one. */
async function sharedAccount(fleetKind: FleetWorkloadKind, machineLimit: number) {
  const slug = randomToken(6).toLowerCase();
  const row = await adminDb.fleetShard.create({
    data: {
      name: `shared-${slug}`,
      fleetKind,
      provider: 'fly',
      role: 'primary',
      state: 'active',
      githubOrg: MOTIR_ORG,
      githubInstallationId: '556677',
      flyOrg: 'motir',
      flyApp: `motir-${slug}`,
      flyRegion: 'iad',
      credentialRef: `FLEET_SHARD_SHARED_${slug.toUpperCase()}`,
      machineLimit,
    },
  });
  remember(row.id, row.credentialRef);
  return row;
}

/** One own AWS account of `organizationId`: a row per kind, its raise on the first. */
async function ownAccount(
  organizationId: string,
  kinds: FleetWorkloadKind[],
  desired: number,
  options: { granted?: number; status?: string; live?: boolean } = {},
): Promise<FleetShard[]> {
  const awsAccountId = String(randomInt(100_000_000_000, 999_999_999_999));
  const live = options.live ?? false;
  const granted = options.granted ?? null;
  const at = new Date();
  const rows: FleetShard[] = [];
  for (const fleetKind of kinds) {
    const slug = randomToken(6).toLowerCase();
    const row = await adminDb.fleetShard.create({
      data: {
        name: `host-${slug}-${fleetKind}`.replace(/_/g, '-'),
        fleetKind,
        provider: 'aws',
        role: 'org_owned',
        ownerOrganizationId: organizationId,
        state: live ? 'active' : 'provisioning',
        githubOrg: MOTIR_ORG,
        githubInstallationId: '556677',
        awsAccountId,
        awsRegion: 'us-east-1',
        credentialRef: `FLEET_SHARD_${slug.toUpperCase()}`,
        quotaRequestedAt: at,
        grantedAt: granted !== null ? at : null,
        liveAt: live ? at : null,
      },
    });
    remember(row.id, row.credentialRef);
    rows.push(row);
  }
  const awsRequestId = `req-${randomToken(8)}`;
  remember(awsAccountId, awsRequestId);
  const status = options.status ?? (granted !== null ? 'approved' : 'pending');
  await adminDb.fleetQuotaRequest.create({
    data: {
      shardId: rows[0]!.id,
      fleetKind: rows[0]!.fleetKind,
      quotaCode: 'L-1216C47A',
      desiredValue: desired,
      awsRequestId,
      status: status as never,
      grantedValue: granted,
      closedAt: status === 'pending' ? null : at,
    },
  });
  return rows;
}

/** A Host org right after purchase: its three accounts, quota requested. */
async function hostAccounts(
  organizationId: string,
  options: {
    agentRunner?: { granted?: number; live?: boolean };
    merged?: { status?: string };
  } = {},
) {
  const ci = await ownAccount(organizationId, ['ci_runner'], 64);
  const agentRunner = await ownAccount(organizationId, ['hosted_agent'], 64, options.agentRunner);
  const merged = await ownAccount(
    organizationId,
    ['code_graph_index', 'agent_instance'],
    128,
    options.merged,
  );
  return { ci, agentRunner, merged };
}

/** Where the real admission places a job of `fleetKind` for the org now. */
const placementOf = (organizationId: string, fleetKind: FleetWorkloadKind) =>
  withSystemContext((tx) =>
    fleetShardAdmissionService.chooseInTx({ fleetKind, organizationId }, new Date(), tx),
  );

const providerIn = (fleetUse: FleetUseDTO, kind: FleetWorkloadKind) =>
  fleetUse.whereItRuns.find((row) => row.fleetKind === kind)?.provider;

// ── the harness ──────────────────────────────────────────────────────────────

const SWITCHED: FleetWorkloadKind[] = [
  'ci_runner',
  'hosted_agent',
  'code_graph_index',
  'agent_instance',
];

beforeEach(async () => {
  await setUpHarness();
  await truncateJobRuns();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetCapacityRequest.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  repoSeeded = false;
  onPlan(TIERS.pro);
  vi.stubEnv('MOTIR_GATEWAY_URL', GATEWAY);
  vi.stubEnv('MOTIR_GATEWAY_RUN_URL', GATEWAY);
  vi.stubEnv('MOTIR_RUN_KEY_MINT_SECRET', 'mint-secret');
  vi.stubEnv('MOTIR_BASE_URL', 'https://app.test/');
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  stubBoundaries();
  session.current = null;
  remember(orgId(), fx.workspaceId, fx.owner.id, fx.owner.email);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const kind of SWITCHED) wireFleetKindSwitch(kind, null);
  vi.useRealTimers();
  await tearDownHarness();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetCapacityRequest.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── 1 · the page equals admission ────────────────────────────────────────────

describe('the page reads the figures and counts the gates enforce', () => {
  it('Pro: 3 of 3 agent runs with the 4th waiting on the plan, 10 of 10 CI jobs with 2 waiting', async () => {
    const admin = await addPerson(orgId(), 'admin', fx.owner.id);
    await fourHostedRuns();
    expect(fakeOrchestrator.provisioned).toHaveLength(3);

    const { caps, ci } = await cappedFigures(orgId());
    for (let i = 0; i < ci; i++) {
      expect(await admitCi()).toMatchObject({ outcome: 'admitted', ciBurstCap: ci });
    }
    expect(await admitCi()).toMatchObject({ outcome: 'deferred', reason: 'plan_cap' });
    expect(await admitCi()).toMatchObject({ outcome: 'deferred', reason: 'plan_cap' });

    const census = await censusOf(orgId());
    const fleetUse = await fleetUseOf(admin, orgId());

    expect(fleetUse.plan).toEqual({
      kind: 'limited',
      planKey: 'pro',
      planName: 'Pro',
      noFleet: false,
    });
    expect(fleetUse.figures.agentRunsInParallel).toEqual({
      figure: caps.agentRunsInParallel,
      inUse: census.byWorkload.hosted_agent,
      waiting: { planLimit: 1, poolFull: 0, other: 0 },
      figureSource: 'plan',
    });
    expect(census.byWorkload.hosted_agent).toBe(caps.agentRunsInParallel);
    expect(fleetUse.figures.ciJobsInFlight).toEqual({
      figure: ci,
      inUse: census.byWorkload.ci_runner,
      waiting: { planLimit: 2, poolFull: 0, other: 0 },
      figureSource: 'plan',
    });
    expect(census.byWorkload.ci_runner).toBe(ci);
    expect(fleetUse.codeGraphIndex.inUse).toBe(census.byWorkload.code_graph_index);
  });

  it('a plan-limit wait and a full-pool wait are counted apart, and a freed pool clears its wait', async () => {
    // Org A: at its CI figure, two jobs held by the plan.
    const { ci } = await cappedFigures(orgId());
    for (let i = 0; i < ci; i++) await admitCi();
    await admitCi();
    await admitCi();

    // Org B: below its CI figure, on a CI pool whose every account is full.
    const b = await otherOrg();
    wireFleetKindSwitch('ci_runner', () => true);
    const account = await sharedAccount('ci_runner', 1);
    await seedIntent(b.organizationId, b.workspaceId, null, {
      status: 'running',
      fleetShardId: account.id,
    });
    const held = await seedIntent(b.organizationId, b.workspaceId, null);
    expect(await ciRunnerAdmissionService.admit(held)).toMatchObject({
      outcome: 'deferred',
      reason: 'shard_capacity',
    });

    const a = await fleetUseOf(owner(), orgId());
    const bUse = await fleetUseOf(b.owner, b.organizationId);
    expect(a.figures.ciJobsInFlight.waiting).toEqual({ planLimit: 2, poolFull: 0, other: 0 });
    expect(bUse.figures.ciJobsInFlight.waiting).toEqual({ planLimit: 0, poolFull: 1, other: 0 });
    expect(bUse.figures.ciJobsInFlight.inUse).toBe(
      (await censusOf(b.organizationId)).byWorkload.ci_runner,
    );
    expect(bUse.figures.ciJobsInFlight.inUse).toBeLessThan(
      (await cappedFigures(b.organizationId)).ci,
    );

    // The pool gains room; the next pass claims the job and clears its reason.
    await adminDb.fleetShard.update({ where: { id: account.id }, data: { machineLimit: 2 } });
    expect(await ciRunnerAdmissionService.admit(await intentRow(held.id))).toMatchObject({
      outcome: 'admitted',
      fleetShardId: account.id,
    });
    expect(await intentRow(held.id)).toMatchObject({ waitingReason: null, waitingSince: null });

    const after = await fleetUseOf(b.owner, b.organizationId);
    expect(after.figures.ciJobsInFlight.inUse).toBe(
      (await censusOf(b.organizationId)).byWorkload.ci_runner,
    );
    expect(after.figures.ciJobsInFlight.inUse).toBe(2);
    expect(after.figures.ciJobsInFlight.waiting).toEqual({ planLimit: 0, poolFull: 0, other: 0 });
    // Org A's plan-limit waits did not move.
    expect((await fleetUseOf(owner(), orgId())).figures.ciJobsInFlight.waiting).toEqual({
      planLimit: 2,
      poolFull: 0,
      other: 0,
    });
  });

  it('agents: one member at the per-person figure, the org count the running-cap guard’s, and neither queues', async () => {
    const { caps } = await cappedFigures(orgId());
    for (let i = 0; i < caps.agentsPerUser; i++) {
      expect(
        (
          await lifecycle.create(
            fx.projectIdentifier,
            { name: `mine-${i}`, profileId: 'claude' },
            fx.ctx,
          )
        ).state,
      ).toBe('running');
    }
    // Another member, below the figure.
    const other = await otherMember();
    await adminDb.agentInstance.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: orgId(),
        projectId: fx.projectId,
        ownerId: other.userId,
        name: 'theirs',
        profileId: 'claude',
        imageTag: 't',
        imageDigest: 'sha256:x',
        region: 'iad',
        state: 'running',
      },
    });
    remember(other.userId);

    const fleetUse = await fleetUseOf(owner(), orgId());
    const membersAt = await withSystemContext(async (tx) => {
      const { bindOrganizationContext } = await import('@/lib/organizations/context');
      await bindOrganizationContext(tx, orgId());
      return agentInstanceRepository.countMembersAtLiveFigure(orgId(), caps.agentsPerUser, tx);
    });

    expect(fleetUse.figures.agentsPerPerson).toEqual({
      figure: caps.agentsPerUser,
      inUse: membersAt,
      waiting: null,
      figureSource: 'plan',
    });
    expect(membersAt).toBe(1);
    expect(fleetUse.figures.agentsRunningInOrg).toEqual({
      figure: caps.agentsRunningPerOrg,
      inUse: await runningAgentsOf(orgId()),
      waiting: null,
      figureSource: 'plan',
    });
  });

  it('Pro → Max past the plan cache: the held 4th run boots and the page reads Max’s 5 with no plan wait', async () => {
    const runs = await fourHostedRuns();
    expect(fakeOrchestrator.provisioned).toHaveLength(3);
    const before = await fleetUseOf(owner(), orgId());
    expect(before.figures.agentRunsInParallel.waiting?.planLimit).toBe(1);

    onPlan(TIERS.max);
    expect(await hostedRunService.admit(await admitPayload(runs[3]!))).toEqual({ kind: 'booted' });
    expect(fakeOrchestrator.provisioned).toHaveLength(4);

    const { caps } = await cappedFigures(orgId());
    const fleetUse = await fleetUseOf(owner(), orgId());
    expect(fleetUse.plan).toMatchObject({ kind: 'limited', planKey: 'max' });
    expect(fleetUse.figures.agentRunsInParallel).toMatchObject({
      figure: caps.agentRunsInParallel,
      inUse: (await censusOf(orgId())).byWorkload.hosted_agent,
      waiting: { planLimit: 0, poolFull: 0, other: 0 },
    });
  });

  it.each([
    ['the subscription read fails', { kind: 'throws' } as const],
    ['the plan key has no caps row', { kind: 'tier', tier: TIERS.legacy } as const],
  ])('%s: admission fails closed and the page reads not read, never 0', async (_, answer) => {
    const census = await censusOf(orgId());
    subscription = answer;
    _resetPlanCapsCache();

    expect(await admitCi()).toMatchObject({ outcome: 'deferred', reason: 'plan_unknown' });

    const fleetUse = await fleetUseOf(owner(), orgId());
    expect(fleetUse.plan).toEqual({ kind: 'not_read' });
    for (const row of Object.values(fleetUse.figures)) {
      expect(row.figure).toBeNull();
      expect(row.figureSource).toBe('not_read');
    }
    // The rest of the read still returns.
    expect(fleetUse.countsRead).toBe(true);
    expect(fleetUse.figures.ciJobsInFlight.inUse).toBe(census.byWorkload.ci_runner);
    expect(fleetUse.whereItRuns).toHaveLength(4);
  });

  it.each([{ isMeta: true }, { internalBilling: true }])(
    'a Motir-owned org (%o) is held to no plan figure and reads no plan limits, with its use',
    async (flags) => {
      await setOrg(flags);
      subscription = { kind: 'throws' };
      // More CI than any plan's figure, all admitted.
      for (let i = 0; i < 12; i++) {
        expect(await admitCi()).toMatchObject({ outcome: 'admitted', ciBurstCap: null });
      }

      const fleetUse = await fleetUseOf(owner(), orgId());
      expect(fleetUse.plan).toEqual({ kind: 'no_plan_limits' });
      expect(fleetUse.figures.ciJobsInFlight).toMatchObject({
        figure: null,
        inUse: (await censusOf(orgId())).byWorkload.ci_runner,
      });
      expect(fleetUse.figures.agentRunsInParallel.figure).toBeNull();
    },
  );
});

// ── 2 · Host accounts against placement ──────────────────────────────────────

describe('a Host org’s accounts read where admission places its jobs', () => {
  it('right after purchase: three accounts quota requested, every kind on the shared floor, and a run lands on the shared pool', async () => {
    onPlan(TIERS.host);
    wireFleetKindSwitch('hosted_agent', () => true);
    const shared = await sharedAccount('hosted_agent', 10);
    await hostAccounts(orgId());

    const fleetUse = await fleetUseOf(owner(), orgId());
    const accounts = fleetUse.hostAccounts as Exclude<
      FleetUseDTO['hostAccounts'],
      null | { kind: 'not_read' }
    >;
    expect(accounts.map((a) => a.accountKind)).toEqual([
      'ci_runner',
      'hosted_agent',
      'indexer_and_hoster',
    ]);
    const merged = accounts.find((a) => a.accountKind === 'indexer_and_hoster')!;
    expect([...merged.fleetKinds].sort()).toEqual(['agent_instance', 'code_graph_index']);
    for (const account of accounts) {
      expect(account).toMatchObject({ state: 'quota_requested', onSharedFloor: true });
    }

    const caps = await planCapsService.capsFor(orgId());
    if (caps.kind !== 'capped') throw new Error('expected Host capped');
    expect(fleetUse.figures.agentRunsInParallel).toMatchObject({
      figure: caps.caps.agentRunsInParallel,
      figureSource: 'shared_floor',
    });

    expect(await placementOf(orgId(), 'hosted_agent')).toEqual({ shardId: shared.id });
    expect(providerIn(fleetUse, 'hosted_agent')).toBe('shared_aws_pool');
  });

  it('agent runner live at 32 vCPU: runs land on the own account at capsFor’s 16, and a denied merged account stays on the shared floor', async () => {
    onPlan(TIERS.host);
    for (const kind of SWITCHED) wireFleetKindSwitch(kind, () => true);
    await sharedAccount('hosted_agent', 10);
    const { agentRunner } = await hostAccounts(orgId(), {
      agentRunner: { granted: 32, live: true },
      merged: { status: 'denied' },
    });

    const fleetUse = await fleetUseOf(owner(), orgId());
    const caps = await planCapsService.capsFor(orgId());
    if (caps.kind !== 'capped') throw new Error('expected Host capped');
    expect(fleetUse.figures.agentRunsInParallel).toMatchObject({
      figure: caps.caps.agentRunsInParallel,
      figureSource: 'granted_quota',
    });
    expect(caps.caps.agentRunsInParallel).toBe(16);

    expect(await placementOf(orgId(), 'hosted_agent')).toEqual({ shardId: agentRunner[0]!.id });
    expect(providerIn(fleetUse, 'hosted_agent')).toBe('own_aws_account');

    const accounts = fleetUse.hostAccounts as Exclude<
      FleetUseDTO['hostAccounts'],
      null | { kind: 'not_read' }
    >;
    const merged = accounts.find((a) => a.accountKind === 'indexer_and_hoster')!;
    expect(merged).toMatchObject({ quotaOutcome: 'denied', onSharedFloor: true });
    expect(providerIn(fleetUse, 'code_graph_index')).toBe('shared_aws_pool');
    expect(providerIn(fleetUse, 'agent_instance')).toBe('shared_aws_pool');
  });

  it('an admin’s capacity request on the merged account comes back once, on that account, in the POST’s own shape', async () => {
    onPlan(TIERS.host);
    const admin = await addPerson(orgId(), 'admin', fx.owner.id);
    await hostAccounts(orgId());
    const before = await fleetUseOf(admin, orgId());
    const accounts = before.hostAccounts as Exclude<
      FleetUseDTO['hostAccounts'],
      null | { kind: 'not_read' }
    >;
    const merged = accounts.find((a) => a.accountKind === 'indexer_and_hoster')!;

    const posted = await requestCapacity(admin, orgId(), {
      fleetKind: merged.requestKind,
      desiredVcpu: 256,
      reason: 'The indexer runs out at the end of the month.',
    });
    expect(posted.status).toBe(200);
    const request = posted.body['request'] as { id: string };

    const after = await fleetUseOf(admin, orgId());
    const afterAccounts = after.hostAccounts as Exclude<
      FleetUseDTO['hostAccounts'],
      null | { kind: 'not_read' }
    >;
    const listed = afterAccounts.flatMap((a) =>
      a.capacityRequests.filter((r) => r.id === request.id).map(() => a.accountKind),
    );
    expect(listed).toEqual(['indexer_and_hoster']);
    expect(
      afterAccounts
        .find((a) => a.accountKind === 'indexer_and_hoster')!
        .capacityRequests.find((r) => r.id === request.id),
    ).toEqual(request);
  });
});

// ── 3 · the gate, isolation and leaks ────────────────────────────────────────

describe('every response is gated and isolated', () => {
  it('a member is refused 403, a non-member and another org’s admin 404, and nothing is written', async () => {
    onPlan(TIERS.host);
    await hostAccounts(orgId());
    const member = await addPerson(orgId(), 'member', fx.owner.id);
    const stranger = await createTestUser();
    remember(stranger.id, stranger.email);
    const b = await otherOrg();
    const bAdmin = await addPerson(b.organizationId, 'admin', b.owner.id);
    await hostAccounts(b.organizationId);
    const bShardsBefore = await adminDb.fleetShard.findMany({
      where: { ownerOrganizationId: b.organizationId },
      orderBy: { id: 'asc' },
    });
    const body = { fleetKind: 'ci_runner', desiredVcpu: 256, reason: 'more builds' };

    expect((await readFleetUse(member, orgId())).status).toBe(403);
    expect((await requestCapacity(member, orgId(), body)).status).toBe(403);
    const nonMember = { id: stranger.id, email: stranger.email };
    expect((await readFleetUse(nonMember, orgId())).status).toBe(404);
    expect((await requestCapacity(nonMember, orgId(), body)).status).toBe(404);
    expect((await readFleetUse(bAdmin, orgId())).status).toBe(404);
    expect((await requestCapacity(bAdmin, orgId(), body)).status).toBe(404);

    expect(await adminDb.fleetCapacityRequest.count()).toBe(0);
    expect(
      await adminDb.fleetShard.findMany({
        where: { ownerOrganizationId: b.organizationId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(bShardsBefore);
  });
});

// Runs last, over every body every case above produced (vitest runs a file's
// cases in order), so a case added later is scanned too.
describe('no response carries an id or a secret', () => {
  it('scans every body for every seeded account, shard, credential, request, quota code, org, user and email', () => {
    expect(bodies.length).toBeGreaterThan(20);
    forbidden.add('L-1216C47A');
    const leaks: string[] = [];
    for (const value of forbidden) {
      for (const { text, askedFor } of bodies) {
        if (value !== askedFor && text.includes(value)) leaks.push(`${value} in ${text}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
