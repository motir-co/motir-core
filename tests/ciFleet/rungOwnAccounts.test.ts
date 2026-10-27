import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AwsSessionCredentials, Ec2Api, FleetWorkloadKind } from '@motir/orchestrator';
import type { FleetShard } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { RawSubscriptionResponse } from '@/lib/ai/types';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import { largerPoolPlans } from '@/lib/billing/catalog';
import { planCarriesOwnAccounts } from '@/lib/billing/ownAccountPlans';
import { capsForPlanKey, HOST_PLAN_KEY, LARGER_POOL_FLOOR_CAPS } from '@/lib/billing/planCaps';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { AWS_MEMBER_EMAIL_TEMPLATE_ENV } from '@/lib/fleetShards/awsMemberAccountPlan';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import type { FleetHeadroomAlert } from '@/lib/monitoring/fleetShardHeadroomAlert';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  ADD_SHARD_ENTERPRISE_SLUG as SLUG,
  FakeOrganization,
  buildStacksInto,
  stubPoolDefinitionEnv,
  installAddShardGithub,
  newGithubWorld,
  type GithubWorld,
} from '../helpers/addShardFakes';

// A RUNG ORG ON ITS OWN ACCOUNTS (MOTIR-9653, story MOTIR-9366). A larger pool
// plan on sale carries the three AWS accounts Host does, and from the moment
// one is live it is admitted, capped and let go exactly as a Host org: the
// shared floor of 5 runs, agents 10 / 50 and CI 20 until a kind's account is
// live, then only that account, runs and CI at the granted vCPU ÷ 2, agents
// 10 / 50 and the merged account's 10 kept index spots. A removed rung's key
// carries no accounts and no caps row: the plan is unknown.
//
// The world is the Host recipe's (`hostOwnAccountsRecipe.test.ts`): all four
// fleet kinds on AWS, a shared account per kind, the add-shard's fake AWS, and
// jobs entering through the doors their dispatchers call. The plan is
// motir-ai's subscription read, the one stubbed seam. `check` asserts after
// EVERY placement that a job of an org on a plan with live own accounts lands
// only on its own account (or waits), and no other job lands on one.

// ── seams ────────────────────────────────────────────────────────────────────

const getOrgSubscriptionMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  getOrgSubscription: (q: unknown) => getOrgSubscriptionMock(q),
}));

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

const { planCapsService, _resetPlanCapsCache } = await import('@/lib/services/planCapsService');
const { hostAccountReconcileService } = await import('@/lib/services/hostAccountReconcileService');
const { hostAccountStateService } = await import('@/lib/services/hostAccountStateService');
const { fleetQuotaRaiseService } = await import('@/lib/services/fleetQuotaRaiseService');
const { fleetShardAdmissionService, OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND } =
  await import('@/lib/services/fleetShardAdmissionService');
const { fleetCeilingService } = await import('@/lib/services/fleetCeilingService');
const { ciRunnerAdmissionService } = await import('@/lib/services/ciRunnerAdmissionService');
const { codeGraphIndexAdmissionService } =
  await import('@/lib/services/codeGraphIndexAdmissionService');
const { fleetShardOrchestratorService } =
  await import('@/lib/services/fleetShardOrchestratorService');
const { fleetShardService } = await import('@/lib/services/fleetShardService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');

type Ec2Fake = Ec2Api;
const ec2FakePath = '../../packages/orchestrator/test/contract/awsEc2Fake';

const KINDS: FleetWorkloadKind[] = [
  'ci_runner',
  'hosted_agent',
  'code_graph_index',
  'agent_instance',
];
const GITHUB_ORG = 'motir-fleet-use1-1';
const TEMPLATE = 'aws+{name}@motir.co';
const SECRETS = {
  installation: 'ghs_INSTALL_SECRET_9653_never_printed',
  managementKey: 'AKIA_MANAGEMENT_9653_never_printed',
  managementSecret: 'MANAGEMENT_SECRET_9653_never_printed',
  sessionKeyId: 'ASIA_SESSION_9653_never_printed',
  sessionSecret: 'SESSION_SECRET_9653_never_printed',
  sessionToken: 'SESSION_TOKEN_9653_never_printed',
};
const SESSION: AwsSessionCredentials = {
  accessKeyId: SECRETS.sessionKeyId,
  secretAccessKey: SECRETS.sessionSecret,
  sessionToken: SECRETS.sessionToken,
  expiration: null,
};
const T0 = new Date('2026-10-26T12:00:00.000Z');
const MINUTE = 60_000;
const INDEX_TIMEOUT_MS = 30 * MINUTE;

let github: GithubWorld;
let organization: FakeOrganization;
let unregister: () => void;
let now: Date;
let operatorEmail: string;
/** Every alert the reconcile raised, across the walk. */
const alerts: FleetHeadroomAlert[] = [];
/** Each org's plan key, as motir-ai reports it. */
const plans = new Map<string, string>();
const shared: Partial<Record<FleetWorkloadKind, FleetShard>> = {};
/** Running agent instances per account — the hoster's counter reads the
 *  instance records, whose creation is the agent hoster story's. */
const agents = new Map<string, number>();
const flySwitch = new Set<FleetWorkloadKind>();

interface Tenant {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  userId: string;
}

/** The 600k org the walk carries through every step. */
let rung: Tenant;

function setNow(at: Date) {
  now = at;
  vi.setSystemTime(at);
}

let tenantSeq = 0;
async function seedTenant(): Promise<Tenant> {
  tenantSeq += 1;
  const user = await usersService.createUser({
    email: `rung-own-${tenantSeq}-${Date.now()}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Rung ${tenantSeq}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `R${100 + tenantSeq}`,
  });
  return {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    projectId: project.id,
    userId: user.id,
  };
}

/** The org's plan as motir-ai reports it. A paid plan bundles the AI seat, which
 *  is what the reconcile's candidate read selects on. */
async function setPlan(organizationId: string, key: string) {
  plans.set(organizationId, key);
  await adminDb.organization.update({
    where: { id: organizationId },
    data: { aiIncludedSeat: true },
  });
  _resetPlanCapsCache();
}

const reconcile = () =>
  hostAccountReconcileService.runReconcile({
    now: () => now,
    alert: (a: FleetHeadroomAlert) => alerts.push(a),
    capsFor: (id: string) => planCapsService.capsFor(id),
    provisioning: {
      raise: { management: () => organization, now: () => now },
      env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: TEMPLATE },
    },
  });
const statePass = () => hostAccountStateService.runStatePass({ now: () => now });
const track = () =>
  fleetQuotaRaiseService.refreshOpenRequests(undefined, {
    management: () => organization,
    now: () => now,
  });

async function caps(organizationId: string) {
  _resetPlanCapsCache();
  const answer = await planCapsService.capsFor(organizationId);
  if (answer.kind !== 'capped') throw new Error(`expected capped, got ${answer.kind}`);
  return answer.caps;
}

const ownRows = (organizationId: string) =>
  adminDb.fleetShard.findMany({
    where: { ownerOrganizationId: organizationId },
    orderBy: { name: 'asc' },
  });
const ownRequests = (organizationId: string) =>
  adminDb.fleetQuotaRequest.findMany({
    where: { shard: { ownerOrganizationId: organizationId } },
    include: { shard: { select: { fleetKind: true } } },
    orderBy: { createdAt: 'asc' },
  });
const creates = () => organization.calls.filter((c) => c === 'createOrganizationAccount');
const row = async (organizationId: string, kind: FleetWorkloadKind) =>
  (await ownRows(organizationId)).find((r) => r.fleetKind === kind)!;

/** AWS answers the open raise filed against the org's row of `kind`. */
async function answer(
  organizationId: string,
  kind: FleetWorkloadKind,
  status: 'APPROVED' | 'DENIED',
  granted?: number,
) {
  const shard = await row(organizationId, kind);
  const open = await adminDb.fleetQuotaRequest.findFirstOrThrow({
    where: { shardId: shard.id, closedAt: null },
  });
  organization.settleQuotaRequest(open.awsRequestId, status, granted);
  await track();
}

// ── the doors, and the central invariant ─────────────────────────────────────

/** Where a job went: an account, Fly (`null`), or a wait with its words. */
type Landed = { shardId: string | null } | { deferred: string; detail: string };

async function check(kind: FleetWorkloadKind, organizationId: string, landed: Landed) {
  const live = await adminDb.fleetShard.findFirst({
    where: {
      role: 'org_owned',
      ownerOrganizationId: organizationId,
      fleetKind: kind,
      state: 'active',
      liveAt: { not: null },
    },
  });
  const onHost = planCarriesOwnAccounts(plans.get(organizationId) ?? '');
  const ownApplies = live !== null && onHost && !flySwitch.has(kind);
  if (!('shardId' in landed)) return;
  if (landed.shardId === null) {
    expect(ownApplies, `a ${kind} job of an org on its own account went to Fly`).toBe(false);
    return;
  }
  const target = await adminDb.fleetShard.findUniqueOrThrow({ where: { id: landed.shardId } });
  if (ownApplies) {
    expect(target.id, `a ${kind} job left its org's own account`).toBe(live!.id);
  } else if (target.role === 'org_owned') {
    expect(target.ownerOrganizationId, `a ${kind} job landed on another org's account`).toBe(
      organizationId,
    );
    expect(onHost).toBe(true);
  }
}

let seq = 0;

/** A hosted agent run, through the slot its dispatcher reserves. */
async function hostedRun(tenant: Tenant) {
  seq += 1;
  const ref = `run-${seq}`;
  const verdict = await fleetCeilingService.reserve(
    {
      workload: 'hosted_agent',
      ref,
      ownerRef: ref,
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
    },
    now,
  );
  const landed: Landed =
    verdict.outcome === 'reserved'
      ? { shardId: verdict.fleetShardId }
      : verdict.outcome === 'deferred'
        ? { deferred: verdict.reason, detail: verdict.detail }
        : { deferred: verdict.outcome, detail: '' };
  await check('hosted_agent', tenant.organizationId, landed);
  return { ref, landed };
}

/** A CI job a push queued, through the CI gate. */
async function ciJob(tenant: Tenant) {
  seq += 1;
  const intent = await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: tenant.workspaceId,
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      installationId: '556677',
      runId: '9653',
      runAttempt: 1,
      jobId: String(965_300 + seq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: GITHUB_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: now,
      status: 'pending',
    },
  });
  const verdict = await ciRunnerAdmissionService.admit(intent);
  const landed: Landed =
    verdict.outcome === 'admitted'
      ? { shardId: verdict.fleetShardId }
      : verdict.outcome === 'deferred'
        ? { deferred: verdict.reason, detail: verdict.detail }
        : { deferred: verdict.outcome, detail: '' };
  await check('ci_runner', tenant.organizationId, landed);
  return { intentId: intent.id, landed };
}

/** An index run of one repository, through the index gate. */
async function indexRun(tenant: Tenant) {
  seq += 1;
  const request = {
    projectId: tenant.projectId,
    repoRef: `acme/repo-${seq}`,
    dispatchId: `dispatch-${seq}`,
    workspaceId: tenant.workspaceId,
    organizationId: tenant.organizationId,
    containerTimeoutMs: INDEX_TIMEOUT_MS,
  };
  const verdict = await codeGraphIndexAdmissionService.admit(request, now);
  const landed: Landed =
    verdict.outcome === 'admitted'
      ? { shardId: verdict.admission.shardId ?? null }
      : verdict.outcome === 'deferred'
        ? { deferred: verdict.reason, detail: verdict.detail }
        : { deferred: verdict.outcome, detail: '' };
  await check('code_graph_index', tenant.organizationId, landed);
  const slotRef = verdict.outcome === 'admitted' ? verdict.admission.slotRef : null;
  return {
    landed,
    release: () => slotRef && codeGraphIndexAdmissionService.release(slotRef, request.dispatchId),
  };
}

/** An agent instance's placement; a landed one counts as running there. */
async function agentInstance(tenant: Tenant): Promise<Landed> {
  const placement = await withSystemContext((tx) =>
    fleetShardAdmissionService.chooseInTx(
      { fleetKind: 'agent_instance', organizationId: tenant.organizationId },
      now,
      tx,
    ),
  );
  const landed: Landed =
    'deferred' in placement
      ? { deferred: placement.deferred, detail: placement.detail }
      : { shardId: placement.shardId };
  await check('agent_instance', tenant.organizationId, landed);
  if ('shardId' in landed && landed.shardId) {
    agents.set(landed.shardId, (agents.get(landed.shardId) ?? 0) + 1);
  }
  return landed;
}

const finishCi = (intentIds: string[]) =>
  adminDb.ciRunnerProvisioningIntent.updateMany({
    where: { id: { in: intentIds } },
    data: { status: 'completed' },
  });
const finishHosted = (refs: string[]) =>
  Promise.all(refs.map((ref) => fleetCeilingService.release('hosted_agent', ref, ref)));

const on = (shard: { id: string }) => ({ shardId: shard.id });
const ownWait = (kind: FleetWorkloadKind) => OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND[kind];

// ── the world, built once ────────────────────────────────────────────────────

beforeAll(async () => {
  const { AwsEc2Fake } = (await import(/* @vite-ignore */ ec2FakePath)) as {
    AwsEc2Fake: new () => Ec2Fake;
  };
  await truncateAuthTables();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetMachineKill.deleteMany({});
  await adminDb.fleetCapacityRequest.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  vi.useFakeTimers({ toFake: ['Date'] });
  setNow(T0);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', '');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4445390');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('GITHUB_ENTERPRISE_SLUG', SLUG);
  vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', SECRETS.managementKey);
  vi.stubEnv('AWS_ORG_ADMIN_SECRET_ACCESS_KEY', SECRETS.managementSecret);
  vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::576360162297:role/motir-add-shard');
  stubPoolDefinitionEnv();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  _resetPlanCapsCache();
  fleetShardOrchestratorService.resetCache();
  github = newGithubWorld();
  github.orgs.add(GITHUB_ORG);
  organization = new FakeOrganization(SESSION);
  buildStacksInto(organization, () => ec2);
  organization.quota = 5; // a new account's AWS default
  const ec2 = new AwsEc2Fake();
  installAddShardGithub(github, SECRETS.installation);
  unregister = registerShardProvisioningProvider(
    createAwsShardProvisioningProvider({
      management: () => organization,
      ec2: () => ec2,
      env: () => process.env,
    }),
  );
  getOrgSubscriptionMock.mockImplementation(
    async (q: { coreOrganizationId: string }): Promise<RawSubscriptionResponse> => {
      const key = plans.get(q.coreOrganizationId) ?? 'max';
      return {
        status: 'active',
        currentPeriodEnd: null,
        priceId: null,
        planTier: { key, name: key, monthlyCreditAllotment: 1 },
      };
    },
  );
  vi.spyOn(agentInstanceRepository, 'countLiveOnFleetShard').mockImplementation(
    async (shardId) => agents.get(shardId) ?? 0,
  );
  for (const kind of KINDS) wireFleetKindSwitch(kind, async () => !flySwitch.has(kind));

  await createTestUser({ email: MOTIR_SYSTEM_USER_EMAIL });
  const operator = await createTestUser({ email: `fleet-operator-${Date.now()}@example.com` });
  await adminDb.user.update({ where: { id: operator.id }, data: { platformRole: 'superadmin' } });
  operatorEmail = operator.email;
  const ids: Record<FleetWorkloadKind, string> = {
    ci_runner: '111122224441',
    hosted_agent: '111122224442',
    code_graph_index: '111122224443',
    agent_instance: '111122224444',
  };
  for (const kind of KINDS) {
    const dto = await fleetShardService.createShard({
      name: `shared-${kind.replace(/_/g, '-')}`,
      fleetKind: kind,
      provider: 'aws',
      state: 'active',
      githubOrg: GITHUB_ORG,
      githubInstallationId: '9001',
      awsAccountId: ids[kind],
      awsRegion: 'us-east-1',
      credentialRef: `FLEET_SHARD_SHARED_${kind.toUpperCase()}`,
      limits: { vcpuQuota: 640 },
    });
    shared[kind] = await adminDb.fleetShard.findUniqueOrThrow({ where: { id: dto.id } });
  }
  rung = await seedTenant();
});

afterAll(async () => {
  unregister();
  for (const kind of KINDS) wireFleetKindSwitch(kind, null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetMachineKill.deleteMany({});
  await adminDb.fleetCapacityRequest.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── the walk ─────────────────────────────────────────────────────────────────

const RUNG = 'pool_600k';
const TOP = 'pool_2400k';

async function answerOf(organizationId: string) {
  _resetPlanCapsCache();
  return planCapsService.capsFor(organizationId);
}

describe('a pool_600k org on its own accounts', () => {
  it('buying the rung creates its three accounts as four rows, raises filed at 400 / 64 / 120', async () => {
    expect(largerPoolPlans().map((p) => p.key)).toContain(RUNG);
    await setPlan(rung.organizationId, RUNG);
    await reconcile();
    await statePass();

    const rows = await ownRows(rung.organizationId);
    expect(rows.map((r) => r.fleetKind).sort()).toEqual([...KINDS].sort());
    expect(rows.every((r) => r.role === 'org_owned')).toBe(true);
    const requests = await ownRequests(rung.organizationId);
    expect(requests.map((r) => [r.shard.fleetKind, r.desiredValue]).sort()).toEqual(
      [
        ['ci_runner', 400],
        ['code_graph_index', 120],
        ['hosted_agent', 64],
      ].sort(),
    );
  });

  it('on the floor: capped at 5 / 10 / 50 / 20 under its own key, the sixth run waits on the plan, CI held to 20 on shared', async () => {
    expect(await answerOf(rung.organizationId)).toMatchObject({
      kind: 'capped',
      planKey: RUNG,
      caps: LARGER_POOL_FLOOR_CAPS,
    });

    const runs = [];
    for (let i = 0; i < 6; i++) runs.push(await hostedRun(rung));
    expect(runs.slice(0, 5).map((r) => r.landed)).toEqual(Array(5).fill(on(shared.hosted_agent!)));
    expect(runs[5]!.landed).toMatchObject({ deferred: 'plan_cap' });
    expect((runs[5]!.landed as { detail: string }).detail).toContain('runs 5');

    const jobs = [];
    for (let i = 0; i < 21; i++) jobs.push(await ciJob(rung));
    expect(
      jobs
        .slice(0, 20)
        .every((j) => 'shardId' in j.landed && j.landed.shardId === shared.ci_runner!.id),
    ).toBe(true);
    expect(jobs[20]!.landed).toMatchObject({ deferred: 'plan_cap' });

    await finishHosted(runs.map((r) => r.ref));
    await finishCi(jobs.map((j) => j.intentId));
  });

  it('the agent runner granted at 64: 32 runs on the own account, the 33rd waits, never shared or Fly; a raise to 128 reads 64', async () => {
    await answer(rung.organizationId, 'hosted_agent', 'APPROVED', 64);
    await statePass();
    const runner = await row(rung.organizationId, 'hosted_agent');
    expect(runner.liveAt).not.toBeNull();
    const caps64 = await caps(rung.organizationId);
    expect(caps64).toEqual({ ...LARGER_POOL_FLOOR_CAPS, agentRunsInParallel: 32 });

    const runs = [];
    for (let i = 0; i < 33; i++) runs.push(await hostedRun(rung));
    expect(runs.slice(0, 32).map((r) => r.landed)).toEqual(Array(32).fill(on(runner)));
    expect(runs[32]!.landed).toMatchObject({ deferred: 'plan_cap' });
    expect((runs[32]!.landed as { detail: string }).detail).toContain('runs 32');
    // The account itself is full too: its own answer is the own-capacity wait.
    expect(
      await withSystemContext((tx) =>
        fleetShardAdmissionService.chooseInTx(
          { fleetKind: 'hosted_agent', organizationId: rung.organizationId },
          now,
          tx,
        ),
      ),
    ).toMatchObject({ deferred: 'shard_capacity', detail: ownWait('hosted_agent') });
    await finishHosted(runs.map((r) => r.ref));

    // A later raise to 128 reads 64 on the next call, with nothing stored.
    const [raised] = await fleetQuotaRaiseService.fileRaises(
      { names: [runner.name], desiredVcpu: 128, operatorEmail },
      { management: () => organization, now: () => now },
    );
    expect(raised).toMatchObject({ ok: true });
    await answer(rung.organizationId, 'hosted_agent', 'APPROVED', 128);
    expect((await caps(rung.organizationId)).agentRunsInParallel).toBe(64);
  });

  it('CI stays shared at 20 while only the agent runner is live; granted at 400 it reads 200 and goes only to its own account', async () => {
    setNow(new Date(now.getTime() + 5 * MINUTE));
    const pending = await ciJob(rung);
    expect(pending.landed).toEqual(on(shared.ci_runner!));
    expect((await caps(rung.organizationId)).ciBurstCap).toBe(20);

    await answer(rung.organizationId, 'ci_runner', 'APPROVED', 400);
    await statePass();
    const ci = await row(rung.organizationId, 'ci_runner');
    expect(ci.liveAt).not.toBeNull();
    expect((await caps(rung.organizationId)).ciBurstCap).toBe(200);
    const jobs = [];
    for (let i = 0; i < 3; i++) jobs.push(await ciJob(rung));
    expect(jobs.map((j) => j.landed)).toEqual(Array(3).fill(on(ci)));
    await finishCi([pending.intentId, ...jobs.map((j) => j.intentId)]);
  });

  it('the merged account granted at 120: 10 index spots kept beside 50 agent instances, the 51st waits', async () => {
    await answer(rung.organizationId, 'code_graph_index', 'APPROVED', 120);
    await statePass();
    const index = await row(rung.organizationId, 'code_graph_index');
    const hoster = await row(rung.organizationId, 'agent_instance');
    expect([index.liveAt, hoster.liveAt].every((t) => t !== null)).toBe(true);

    const placed: Landed[] = [];
    for (let i = 0; i < 51; i++) placed.push(await agentInstance(rung));
    expect(placed.slice(0, 50)).toEqual(Array(50).fill(on(hoster)));
    expect(placed[50]).toEqual({ deferred: 'shard_capacity', detail: ownWait('agent_instance') });

    const runs = [];
    for (let i = 0; i < 11; i++) runs.push(await indexRun(rung));
    expect(runs.slice(0, 10).map((r) => r.landed)).toEqual(Array(10).fill(on(index)));
    expect(runs[10]!.landed).toEqual({
      deferred: 'pool_full',
      detail: ownWait('code_graph_index'),
    });
    for (const r of runs) await r.release();
    agents.set(hoster.id, 0);
  });

  it('a move to Host and back keeps routing to the same accounts, creating nothing', async () => {
    const rowsBefore = await ownRows(rung.organizationId);
    const createsBefore = creates().length;
    const runner = await row(rung.organizationId, 'hosted_agent');
    const ci = await row(rung.organizationId, 'ci_runner');

    for (const key of [HOST_PLAN_KEY, RUNG]) {
      await setPlan(rung.organizationId, key);
      const run = await hostedRun(rung);
      expect(run.landed).toEqual(on(runner));
      await finishHosted([run.ref]);
      const job = await ciJob(rung);
      expect(job.landed).toEqual(on(ci));
      await finishCi([job.intentId]);
    }
    await reconcile();
    await statePass();
    expect(creates()).toHaveLength(createsBefore);
    expect((await ownRows(rung.organizationId)).map((r) => [r.id, r.liveAt])).toEqual(
      rowsBefore.map((r) => [r.id, r.liveAt]),
    );
  });

  it('a plan read with no row defers a job of an org with a live own account', async () => {
    await setPlan(rung.organizationId, 'pool_999k');
    expect(await answerOf(rung.organizationId)).toMatchObject({ kind: 'plan_unknown' });
    expect(
      await withSystemContext((tx) =>
        fleetShardAdmissionService.chooseInTx(
          { fleetKind: 'hosted_agent', organizationId: rung.organizationId },
          now,
          tx,
        ),
      ),
    ).toMatchObject({ deferred: 'shard_capacity' });
    await setPlan(rung.organizationId, RUNG);
  });

  it('downgraded to max_x2: new work is shared at max_x2, nothing is created or closed', async () => {
    const rowsBefore = await ownRows(rung.organizationId);
    const requestsBefore = await adminDb.fleetQuotaRequest.count();
    const createsBefore = creates().length;

    await setPlan(rung.organizationId, 'max_x2');
    expect(await caps(rung.organizationId)).toEqual(capsForPlanKey('max_x2'));
    const run = await hostedRun(rung);
    expect(run.landed).toEqual(on(shared.hosted_agent!));
    await finishHosted([run.ref]);
    const job = await ciJob(rung);
    expect(job.landed).toEqual(on(shared.ci_runner!));
    await finishCi([job.intentId]);
    const index = await indexRun(rung);
    expect(index.landed).toEqual(on(shared.code_graph_index!));
    await index.release();
    expect(await agentInstance(rung)).toEqual(on(shared.agent_instance!));

    await reconcile();
    await statePass();
    expect(creates()).toHaveLength(createsBefore);
    expect(await adminDb.fleetQuotaRequest.count()).toBe(requestsBefore);
    const rowsAfter = await ownRows(rung.organizationId);
    expect(rowsAfter.map((r) => [r.id, r.role, r.state, r.liveAt])).toEqual(
      rowsBefore.map((r) => [r.id, r.role, r.state, r.liveAt]),
    );
  });
});

describe('a pool_2400k org', () => {
  it('granted 256 and 1,600 reads 128 runs and CI 800, agents still 10 per person and 50 per org', async () => {
    expect(largerPoolPlans().map((p) => p.key)).toContain(TOP);
    const top = await seedTenant();
    await setPlan(top.organizationId, TOP);
    await reconcile();
    await statePass();
    const requests = await ownRequests(top.organizationId);
    expect(requests.map((r) => [r.shard.fleetKind, r.desiredValue]).sort()).toEqual(
      [
        ['ci_runner', 1600],
        ['code_graph_index', 120],
        ['hosted_agent', 256],
      ].sort(),
    );

    await answer(top.organizationId, 'hosted_agent', 'APPROVED', 256);
    await answer(top.organizationId, 'ci_runner', 'APPROVED', 1600);
    await statePass();
    const read = await caps(top.organizationId);
    expect(read).toEqual({
      ...LARGER_POOL_FLOOR_CAPS,
      agentRunsInParallel: 128,
      ciBurstCap: 800,
    });
    expect([read.agentsPerUser, read.agentsRunningPerOrg]).toEqual([10, 50]);
    const run = await hostedRun(top);
    expect(run.landed).toEqual(on(await row(top.organizationId, 'hosted_agent')));
    await finishHosted([run.ref]);
  });
});

describe('a removed rung', () => {
  it('pool_250k carries no accounts and no caps row: none created, the plan unknown', async () => {
    const removed = await seedTenant();
    const createsBefore = creates().length;
    await setPlan(removed.organizationId, 'pool_250k');
    await reconcile();
    await statePass();
    expect(creates()).toHaveLength(createsBefore);
    expect(await ownRows(removed.organizationId)).toEqual([]);
    expect(await answerOf(removed.organizationId)).toEqual({
      kind: 'plan_unknown',
      planKey: 'pool_250k',
    });
  });
});
