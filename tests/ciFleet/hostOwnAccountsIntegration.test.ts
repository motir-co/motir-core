import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AwsSessionCredentials,
  Ec2Api,
  Ec2Instance,
  Ec2Tag,
  FleetWorkloadKind,
} from '@motir/orchestrator';
import type { FleetShard } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { RawSubscriptionResponse } from '@/lib/ai/types';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import { capsForPlanKey, HOST_PLAN_KEY } from '@/lib/billing/planCaps';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import type { HostAccountRefusedError } from '@/lib/ciFleet/headroomErrors';
import { hostMonthlyPlanCredits } from '@/lib/billing/catalog';
import { hostAccountPlan } from '@/lib/ciFleet/hostAccounts';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { AWS_MEMBER_EMAIL_TEMPLATE_ENV } from '@/lib/fleetShards/awsMemberAccountPlan';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import type { FleetHeadroomAlert } from '@/lib/monitoring/fleetShardHeadroomAlert';
import { platformPrincipalForStaffEmail } from '@/lib/platform/auth';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import {
  ADD_SHARD_ENTERPRISE_SLUG as SLUG,
  FakeOrganization,
  installAddShardGithub,
  newGithubWorld,
  type GithubWorld,
} from '../helpers/addShardFakes';

// THE STORY GATE FOR A HOST ORGANISATION'S OWN ACCOUNTS (Story MOTIR-9365 ·
// MOTIR-9591) — the SEAMS between its nine feature cards, driven through their
// real entry points in order against the real database and the add-shard's fake
// AWS (Organizations + Service Quotas in `FakeOrganization`, the network built
// over the in-memory EC2):
//
//   reconcile (`runReconcile`) → quota tracker (`refreshOpenRequests`) →
//   state pass (`runStatePass`) → admission (`chooseInTx`) → caps (`capsFor`)
//   → attribution (`reconcile`) → `fleet-admin`.
//
// Rows are never written by hand; a test sets only a plan (motir-ai's
// subscription read, the one stubbed seam behind the real `capsFor`), a kind
// switch, a fake grant, or the work already running on an account (an intent,
// a slot, an agent instance count) that a placement would have started.
//
// THE CENTRAL INVARIANT is asserted by `placed` after EVERY placement, from
// both sides: a job of an org other than an account's owner never names an
// `org_owned` row, and a job of a Host org with a live own account of the kind
// names that row or defers — never a shared account, never Fly.

// ── seams ────────────────────────────────────────────────────────────────────

const getOrgSubscriptionMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  getOrgSubscription: (q: unknown) => getOrgSubscriptionMock(q),
}));

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

// The attribution walk lists each AWS account through its own in-memory EC2,
// keyed by the account id; everything else about the composition is real.
const inventories = vi.hoisted(() => ({ byAccount: new Map<string, unknown>() }));
vi.mock('@/lib/orchestrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/orchestrator')>();
  const { createAwsFleetInventory } = await import('@motir/orchestrator');
  return {
    ...real,
    inventoryForShard: (shard: {
      provider: string;
      name: string;
      aws?: { accountId: string; region: string } | null;
    }) => {
      const ec2 = shard.aws ? inventories.byAccount.get(shard.aws.accountId) : undefined;
      if (!ec2 || !shard.aws) return null;
      return createAwsFleetInventory({
        ec2: ec2 as Ec2Api,
        region: shard.aws.region,
        accountName: shard.name,
      });
    },
  };
});

const { planCapsService, _resetPlanCapsCache } = await import('@/lib/services/planCapsService');
const { hostAccountReconcileService } = await import('@/lib/services/hostAccountReconcileService');
const { hostAccountStateService } = await import('@/lib/services/hostAccountStateService');
const { fleetQuotaRaiseService } = await import('@/lib/services/fleetQuotaRaiseService');
const { fleetShardAdmissionService, OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND } =
  await import('@/lib/services/fleetShardAdmissionService');
const { fleetAttributionService, FLEET_ATTRIBUTION_GRACE_MS } =
  await import('@/lib/services/fleetAttributionService');
const { fleetCapacityRequestService } = await import('@/lib/services/fleetCapacityRequestService');
const { fleetShardOrchestratorService } =
  await import('@/lib/services/fleetShardOrchestratorService');
const { fleetShardService } = await import('@/lib/services/fleetShardService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { runFleetAdmin } = await import('@/scripts/fleet/fleetAdmin');

interface Ec2Fake extends Ec2Api {
  plantInstance(instance: Partial<Ec2Instance> & { tags: readonly Ec2Tag[] }): string;
  liveInstanceIds(): string[];
}
const ec2FakePath = '../../packages/orchestrator/test/contract/awsEc2Fake';
let AwsEc2Fake: new () => Ec2Fake;

const KINDS: FleetWorkloadKind[] = [
  'ci_runner',
  'hosted_agent',
  'code_graph_index',
  'agent_instance',
];
const GITHUB_ORG = 'motir-fleet-use1-1';
const TEMPLATE = 'aws+{name}@motir.co';
const SECRETS = {
  installation: 'ghs_INSTALL_SECRET_9591_never_printed',
  managementKey: 'AKIA_MANAGEMENT_9591_never_printed',
  managementSecret: 'MANAGEMENT_SECRET_9591_never_printed',
  sessionKeyId: 'ASIA_SESSION_9591_never_printed',
  sessionSecret: 'SESSION_SECRET_9591_never_printed',
  sessionToken: 'SESSION_TOKEN_9591_never_printed',
};
const SESSION: AwsSessionCredentials = {
  accessKeyId: SECRETS.sessionKeyId,
  secretAccessKey: SECRETS.sessionSecret,
  sessionToken: SECRETS.sessionToken,
  expiration: null,
};
const T0 = new Date('2026-10-26T12:00:00.000Z');
const MINUTE = 60_000;
const FLOOR = capsForPlanKey(HOST_PLAN_KEY)!;

let github: GithubWorld;
let organization: FakeOrganization;
let unregister: () => void;
let alerts: FleetHeadroomAlert[];
let now: Date;
let operatorEmail: string;
/** Each org's plan key; 'unknown' makes the subscription read fail. */
let plans: Map<string, string>;
const shared: Partial<Record<FleetWorkloadKind, FleetShard>> = {};

interface Tenant {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  userId: string;
}

let tenantSeq = 0;
async function seedTenant(): Promise<Tenant> {
  tenantSeq += 1;
  const user = await usersService.createUser({
    email: `host-gate-${tenantSeq}-${Date.now()}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Gate ${tenantSeq}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `G${100 + tenantSeq}`,
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
async function setPlan(organizationId: string, key: string | null) {
  if (key === null) plans.delete(organizationId);
  else plans.set(organizationId, key);
  if (key !== null && key !== 'unknown') {
    await adminDb.organization.update({
      where: { id: organizationId },
      data: { aiIncludedSeat: true },
    });
  }
  _resetPlanCapsCache();
}

const reconcileDeps = () => ({
  now: () => now,
  alert: (a: FleetHeadroomAlert) => alerts.push(a),
  capsFor: (id: string) => planCapsService.capsFor(id),
  provisioning: {
    raise: { management: () => organization, now: () => now },
    env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: TEMPLATE },
  },
});

const reconcile = () => hostAccountReconcileService.runReconcile(reconcileDeps());
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

/** Every own and shared row, as the readers must leave them. */
const allRows = () => adminDb.fleetShard.findMany({ orderBy: { id: 'asc' } });

// ── placement and the central invariant ──────────────────────────────────────

type Placement = Awaited<ReturnType<typeof fleetShardAdmissionService.chooseInTx>>;

/** Place one job of `kind` for `org`, assert the invariant, and — when it lands —
 *  start the work there exactly as the kind's admission would. */
async function placed(
  kind: FleetWorkloadKind,
  tenant: Tenant,
  options: { start?: boolean } = {},
): Promise<Placement> {
  const placement = await withSystemContext((tx) =>
    fleetShardAdmissionService.chooseInTx(
      { fleetKind: kind, organizationId: tenant.organizationId },
      now,
      tx,
    ),
  );
  await assertInvariant(kind, tenant.organizationId, placement);
  if ('shardId' in placement && placement.shardId && options.start !== false) {
    await start(kind, tenant, placement.shardId);
  }
  return placement;
}

async function assertInvariant(kind: FleetWorkloadKind, organizationId: string, p: Placement) {
  const live = await adminDb.fleetShard.findFirst({
    where: {
      role: 'org_owned',
      ownerOrganizationId: organizationId,
      fleetKind: kind,
      state: 'active',
      liveAt: { not: null },
    },
  });
  const onHost = plans.get(organizationId) === HOST_PLAN_KEY;
  const switchOn = !flySwitch.has(kind);
  if (!('shardId' in p) || p.shardId === null) {
    // A deferral or Fly — Fly is never an answer for a live own kind on AWS.
    if (live && onHost && switchOn) expect(p).not.toEqual({ shardId: null });
    return;
  }
  const target = await adminDb.fleetShard.findUniqueOrThrow({ where: { id: p.shardId } });
  if (live && onHost && switchOn) {
    expect(target.id).toBe(live.id);
  } else if (target.role === 'org_owned') {
    expect(target.ownerOrganizationId).toBe(organizationId);
    expect(onHost).toBe(true);
  }
}

let workSeq = 0;
/** The work a landed placement starts, counted on its account by the kind's
 *  own per-account counter. */
async function start(kind: FleetWorkloadKind, tenant: Tenant, shardId: string) {
  workSeq += 1;
  if (kind === 'ci_runner') {
    await adminDb.ciRunnerProvisioningIntent.create({
      data: {
        workspaceId: tenant.workspaceId,
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
        installationId: '556677',
        runId: '9591',
        runAttempt: 1,
        jobId: String(959_100 + workSeq),
        jobName: 'build',
        workflowName: 'CI',
        repoOwner: GITHUB_ORG,
        repoName: 'acme-web',
        requestedLabels: [MOTIR_RUNNER_LABEL],
        queuedAt: now,
        status: 'running',
        fleetShardId: shardId,
      },
    });
  } else if (kind === 'agent_instance') {
    agents.set(shardId, (agents.get(shardId) ?? 0) + 1);
  } else {
    await withSystemContext((tx) =>
      fleetInFlightSlotRepository.take(
        {
          workload: kind,
          ref: `${tenant.projectId}:work-${workSeq}`,
          ownerRef: `dispatch-${workSeq}`,
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          fleetShardId: shardId,
          expiresAt: new Date(now.getTime() + 60 * MINUTE),
        },
        tx,
      ),
    );
  }
}

/** Running agent instances per account — the hoster's counter reads the
 *  instance records, whose creation is the agent hoster story's. */
const agents = new Map<string, number>();
const flySwitch = new Set<FleetWorkloadKind>();

const ownFull = (kind: FleetWorkloadKind) => ({
  deferred: 'shard_capacity',
  detail: OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND[kind],
  own: true,
});

/** A Host org through purchase: three accounts, their raises, a state pass. */
async function purchase(): Promise<Tenant> {
  const tenant = await seedTenant();
  await setPlan(tenant.organizationId, HOST_PLAN_KEY);
  await reconcile();
  await statePass();
  return tenant;
}

/** A purchased org with every account granted and live: CI 200, agent runner
 *  32, merged 120. */
async function liveHost(): Promise<Tenant> {
  const tenant = await purchase();
  await answer(tenant.organizationId, 'ci_runner', 'APPROVED', 200);
  await answer(tenant.organizationId, 'hosted_agent', 'APPROVED', 32);
  await answer(tenant.organizationId, 'code_graph_index', 'APPROVED', 120);
  await statePass();
  return tenant;
}

// ── harness ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ ec2FakePath)) as {
    AwsEc2Fake: new () => Ec2Fake;
  });
});

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetMachineKill.deleteMany({});
  await adminDb.fleetCapacityRequest.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  now = T0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4445390');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('GITHUB_ENTERPRISE_SLUG', SLUG);
  vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', SECRETS.managementKey);
  vi.stubEnv('AWS_ORG_ADMIN_SECRET_ACCESS_KEY', SECRETS.managementSecret);
  vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::576360162297:role/motir-add-shard');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  _resetPlanCapsCache();
  fleetShardOrchestratorService.resetCache();
  sentry.captureException.mockReset();
  inventories.byAccount.clear();
  github = newGithubWorld();
  github.orgs.add(GITHUB_ORG);
  organization = new FakeOrganization(SESSION);
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
  plans = new Map();
  getOrgSubscriptionMock.mockReset();
  getOrgSubscriptionMock.mockImplementation(
    async (q: { coreOrganizationId: string }): Promise<RawSubscriptionResponse> => {
      const key = plans.get(q.coreOrganizationId) ?? 'max';
      if (key === 'unknown') throw new Error('motir-ai is unreachable');
      return {
        status: 'active',
        currentPeriodEnd: null,
        priceId: null,
        planTier: { key, name: key, monthlyCreditAllotment: 1 },
      };
    },
  );
  alerts = [];
  agents.clear();
  flySwitch.clear();
  vi.spyOn(agentInstanceRepository, 'countLiveOnFleetShard').mockImplementation(
    async (shardId) => agents.get(shardId) ?? 0,
  );
  for (const kind of KINDS) wireFleetKindSwitch(kind, async () => !flySwitch.has(kind));

  await createTestUser({ email: MOTIR_SYSTEM_USER_EMAIL });
  const operator = await createTestUser({ email: `fleet-operator-${Date.now()}@example.com` });
  await adminDb.user.update({ where: { id: operator.id }, data: { platformRole: 'superadmin' } });
  operatorEmail = operator.email;
  const ids: Record<FleetWorkloadKind, string> = {
    ci_runner: '111122223331',
    hosted_agent: '111122223332',
    code_graph_index: '111122223333',
    agent_instance: '111122223334',
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
});

afterEach(async () => {
  unregister();
  for (const kind of KINDS) wireFleetKindSwitch(kind, null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
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

// ── the cases ────────────────────────────────────────────────────────────────

describe('purchase, and a replayed pass', () => {
  it('creates three accounts as four rows with three raises, and the org stays on the shared floor', async () => {
    const host = await purchase();

    const rows = await ownRows(host.organizationId);
    expect(rows.map((r) => r.fleetKind).sort()).toEqual([...KINDS].sort());
    expect(rows.every((r) => r.role === 'org_owned')).toBe(true);
    const merged = rows.filter(
      (r) => r.fleetKind === 'code_graph_index' || r.fleetKind === 'agent_instance',
    );
    expect(merged[0]!.awsAccountId).toBe(merged[1]!.awsAccountId);
    expect(new Set(rows.map((r) => r.awsAccountId)).size).toBe(3);
    const requests = await ownRequests(host.organizationId);
    expect(requests.map((r) => [r.shard.fleetKind, r.desiredValue]).sort()).toEqual(
      [
        ['ci_runner', 200],
        ['code_graph_index', 120],
        ['hosted_agent', 32],
      ].sort(),
    );
    const states = await adminDb.fleetShard.findMany({
      where: { ownerOrganizationId: host.organizationId },
    });
    expect(states.every((r) => r.quotaRequestedAt !== null && r.grantedAt === null)).toBe(true);

    for (const kind of KINDS) {
      expect(await placed(kind, host)).toEqual({ shardId: shared[kind]!.id });
    }
    const floor = await caps(host.organizationId);
    expect([floor.agentRunsInParallel, floor.ciBurstCap]).toEqual([5, 50]);
  });

  it('a replayed reconcile and state pass create nothing and move no time already set', async () => {
    const host = await purchase();
    const before = await ownRows(host.organizationId);

    now = new Date(T0.getTime() + 5 * MINUTE);
    await reconcile();
    await statePass();
    await caps(host.organizationId);

    expect(creates()).toHaveLength(3);
    expect(organization.accounts.size).toBe(3);
    const after = await ownRows(host.organizationId);
    expect(after.map((r) => [r.id, r.quotaRequestedAt])).toEqual(
      before.map((r) => [r.id, r.quotaRequestedAt]),
    );
    expect(await ownRequests(host.organizationId)).toHaveLength(3);
  });
});

describe('an account granted', () => {
  it('the agent runner at 32: live, 16 runs, every one on the own account, the rest wait for it', async () => {
    const host = await purchase();
    await answer(host.organizationId, 'hosted_agent', 'APPROVED', 32);
    await statePass();

    const runner = await row(host.organizationId, 'hosted_agent');
    expect(runner).toMatchObject({ state: 'active' });
    expect(runner.liveAt).not.toBeNull();
    expect((await caps(host.organizationId)).agentRunsInParallel).toBe(16);

    const results: Placement[] = [];
    for (let i = 0; i < 20; i++) results.push(await placed('hosted_agent', host));
    expect(results.filter((p) => 'shardId' in p && p.shardId === runner.id)).toHaveLength(16);
    expect(results.slice(16)).toEqual(Array(4).fill(ownFull('hosted_agent')));
  });

  it('CI pending, then granted at 200: shared at 50, then own at 100, the agent runner unaffected', async () => {
    const host = await purchase();
    await answer(host.organizationId, 'hosted_agent', 'APPROVED', 32);
    await statePass();
    const runner = await row(host.organizationId, 'hosted_agent');

    expect(await placed('ci_runner', host)).toEqual({ shardId: shared.ci_runner!.id });
    expect((await caps(host.organizationId)).ciBurstCap).toBe(50);
    expect(await placed('hosted_agent', host)).toEqual({ shardId: runner.id });

    await answer(host.organizationId, 'ci_runner', 'APPROVED', 200);
    await statePass();
    const ci = await row(host.organizationId, 'ci_runner');
    expect(await placed('ci_runner', host)).toEqual({ shardId: ci.id });
    const after = await caps(host.organizationId);
    expect([after.ciBurstCap, after.agentRunsInParallel]).toEqual([100, 16]);
    expect(await placed('hosted_agent', host)).toEqual({ shardId: runner.id });
  });

  it('the merged account denied, then granted at 40: one state, 10 index spots kept, 10 agents', async () => {
    const host = await purchase();
    await answer(host.organizationId, 'code_graph_index', 'DENIED');
    await statePass();
    expect((await row(host.organizationId, 'code_graph_index')).grantedAt).toBeNull();
    expect(await placed('code_graph_index', host, { start: false })).toEqual({
      shardId: shared.code_graph_index!.id,
    });
    expect(await placed('agent_instance', host, { start: false })).toEqual({
      shardId: shared.agent_instance!.id,
    });

    const index = await row(host.organizationId, 'code_graph_index');
    const raised = await fleetQuotaRaiseService.fileRaises(
      { names: [index.name], desiredVcpu: 40, operatorEmail },
      { management: () => organization, now: () => now },
    );
    expect(raised[0]).toMatchObject({ ok: true });
    await answer(host.organizationId, 'code_graph_index', 'APPROVED', 40);
    await statePass();

    const [a, b] = (await ownRows(host.organizationId)).filter(
      (r) => r.fleetKind === 'code_graph_index' || r.fleetKind === 'agent_instance',
    );
    expect([a!.quotaRequestedAt, a!.grantedAt, a!.liveAt]).toEqual([
      b!.quotaRequestedAt,
      b!.grantedAt,
      b!.liveAt,
    ]);
    expect(a!.liveAt).not.toBeNull();
    const hoster = await row(host.organizationId, 'agent_instance');

    // No index running: 10 agents and no 11th — the index spots are not lent.
    const agentsPlaced: Placement[] = [];
    for (let i = 0; i < 11; i++) agentsPlaced.push(await placed('agent_instance', host));
    expect(agentsPlaced.slice(0, 10).every((p) => 'shardId' in p && p.shardId === hoster.id)).toBe(
      true,
    );
    expect(agentsPlaced[10]).toEqual(ownFull('agent_instance'));
    // And all 10 index spots are still there beside them.
    const indexPlaced: Placement[] = [];
    for (let i = 0; i < 11; i++) indexPlaced.push(await placed('code_graph_index', host));
    expect(indexPlaced.slice(0, 10).every((p) => 'shardId' in p && p.shardId === index.id)).toBe(
      true,
    );
    expect(indexPlaced[10]).toEqual(ownFull('code_graph_index'));
  });
});

describe('the one granted value', () => {
  it('the state pass, the ceiling, the split and the caps all follow a new grant, and no reader writes a row', async () => {
    const host = await liveHost();
    const ci = await row(host.organizationId, 'ci_runner');
    const hoster = await row(host.organizationId, 'agent_instance');
    const ceiling = (shard: FleetShard) =>
      withSystemContext((tx) => fleetShardAdmissionService.ownCeilingInTx(shard, tx));
    expect([await ceiling(ci), await ceiling(hoster)]).toEqual([100, 50]);
    expect((await caps(host.organizationId)).ciBurstCap).toBe(100);

    // A later, smaller grant on both accounts (a reduced quota is read the same way).
    const runner = await row(host.organizationId, 'hosted_agent');
    await fleetQuotaRaiseService.fileRaises(
      { names: [ci.name, runner.name], desiredVcpu: 300, operatorEmail },
      { management: () => organization, now: () => now },
    );
    await answer(host.organizationId, 'ci_runner', 'APPROVED', 300);
    await answer(host.organizationId, 'hosted_agent', 'APPROVED', 64);
    await statePass();

    const before = await allRows();
    expect(await ceiling(ci)).toBe(150);
    expect((await caps(host.organizationId)).ciBurstCap).toBe(150);
    expect((await caps(host.organizationId)).agentRunsInParallel).toBe(32);
    expect(await placed('ci_runner', host, { start: false })).toEqual({ shardId: ci.id });
    expect(await allRows()).toEqual(before);
  });
});

describe('nobody else ever lands on an own account', () => {
  it('another Host org, a non-Host org and a Motir exempt org, for every kind, and the in-boot move', async () => {
    await liveHost();
    const otherHost = await seedTenant();
    await setPlan(otherHost.organizationId, HOST_PLAN_KEY);
    const pro = await seedTenant();
    await setPlan(pro.organizationId, 'pro');
    const meta = await seedTenant();
    await adminDb.organization.update({
      where: { id: meta.organizationId },
      data: { isMeta: true },
    });

    for (const tenant of [otherHost, pro, meta]) {
      for (const kind of KINDS) {
        const set = await withSystemContext((tx) =>
          fleetShardAdmissionService.selectionSetInTx(
            { fleetKind: kind, organizationId: tenant.organizationId },
            tx,
          ),
        );
        expect(set.every((s) => s.role !== 'org_owned')).toBe(true);
        expect(await placed(kind, tenant, { start: false })).toEqual({ shardId: shared[kind]!.id });
        const moved = await withSystemContext((tx) =>
          fleetShardAdmissionService.moveAfterRefusalInTx(
            { fleetKind: kind, organizationId: tenant.organizationId },
            shared[kind]!.id,
            'capacity_refused',
            new Set([shared[kind]!.id]),
            now,
            tx,
            async () => undefined,
          ),
        );
        expect(moved).toBeNull();
        await adminDb.fleetShard.update({
          where: { id: shared[kind]!.id },
          data: { admissionPausedUntil: null, admissionPausedReason: null },
        });
      }
    }
  });

  it('a full, paused or tried own account defers, and the move finds nothing — never shared, never Fly', async () => {
    const host = await liveHost();
    const runner = await row(host.organizationId, 'hosted_agent');
    for (let i = 0; i < 16; i++) await placed('hosted_agent', host);
    expect(await placed('hosted_agent', host)).toEqual(ownFull('hosted_agent'));

    const ci = await row(host.organizationId, 'ci_runner');
    const moved = await withSystemContext((tx) =>
      fleetShardAdmissionService.moveAfterRefusalInTx(
        { fleetKind: 'ci_runner', organizationId: host.organizationId },
        ci.id,
        'capacity_refused',
        new Set([ci.id]),
        now,
        tx,
        async () => undefined,
      ),
    );
    expect(moved).toBeNull();
    // Paused by that refusal: the next CI job waits for its own account.
    expect(await placed('ci_runner', host)).toEqual(ownFull('ci_runner'));
    expect(runner.id).not.toBe(ci.id);
  });
});

describe('a kind switched back to Fly', () => {
  it('that kind boots on Fly at the floor; the others stay on their own accounts', async () => {
    const host = await liveHost();
    flySwitch.add('hosted_agent');

    expect(await placed('hosted_agent', host)).toEqual({ shardId: null });
    expect((await caps(host.organizationId)).agentRunsInParallel).toBe(FLOOR.agentRunsInParallel);
    expect((await caps(host.organizationId)).ciBurstCap).toBe(100);
    expect(await placed('ci_runner', host)).toEqual({
      shardId: (await row(host.organizationId, 'ci_runner')).id,
    });
  });
});

describe('a refused CreateAccount for a second Host org', () => {
  it('writes no row, alerts once, keeps it on the floor, backs off, then creates it — the first org untouched', async () => {
    const first = await liveHost();
    const firstRows = await ownRows(first.organizationId);
    const second = await seedTenant();
    await setPlan(second.organizationId, HOST_PLAN_KEY);
    organization.usedEmails.add(
      TEMPLATE.replace(
        '{name}',
        hostAccountPlan(second.organizationId, 'ci_runner', hostMonthlyPlanCredits()).account.name,
      ),
    );

    await reconcile();
    expect((await ownRows(second.organizationId)).map((r) => r.fleetKind)).not.toContain(
      'ci_runner',
    );
    expect(alerts).toHaveLength(1);
    expect((alerts[0] as HostAccountRefusedError).organizationId).toBe(second.organizationId);
    expect(await placed('ci_runner', second, { start: false })).toEqual({
      shardId: shared.ci_runner!.id,
    });

    // Inside the backoff: not tried again.
    organization.usedEmails.clear();
    now = new Date(T0.getTime() + MINUTE);
    await reconcile();
    expect((await ownRows(second.organizationId)).map((r) => r.fleetKind)).not.toContain(
      'ci_runner',
    );

    now = new Date(T0.getTime() + 2 * 60 * MINUTE);
    await reconcile();
    expect((await ownRows(second.organizationId)).map((r) => r.fleetKind)).toContain('ci_runner');
    expect((await ownRows(first.organizationId)).map((r) => r.id)).toEqual(
      firstRows.map((r) => r.id),
    );
  });
});

describe('attribution on the own accounts', () => {
  it('reaps an untagged and a foreign machine once, spares the owner’s, and lists the merged account once', async () => {
    const host = await liveHost();
    const other = await seedTenant();
    const ciRow = await row(host.organizationId, 'ci_runner');
    const indexRow = await row(host.organizationId, 'code_graph_index');
    const ciEc2 = new AwsEc2Fake();
    const mergedEc2 = new AwsEc2Fake();
    inventories.byAccount.set(ciRow.awsAccountId!, ciEc2);
    inventories.byAccount.set(indexRow.awsAccountId!, mergedEc2);
    const old = new Date(T0.getTime() - 2 * FLEET_ATTRIBUTION_GRACE_MS);
    const plant = (ec2: Ec2Fake) =>
      ec2.plantInstance({
        instanceId: `i-${randomToken(12).toLowerCase()}`,
        launchTime: old,
        tags: [],
      });
    const untagged = plant(ciEc2);
    const foreign = plant(ciEc2);
    const mine = plant(ciEc2);
    const strayMerged = plant(mergedEc2);
    const intent = (tenant: Tenant, instanceId: string) =>
      adminDb.ciRunnerProvisioningIntent.create({
        data: {
          workspaceId: tenant.workspaceId,
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          installationId: '556677',
          runId: '9591',
          runAttempt: 1,
          jobId: `attr-${instanceId}`,
          jobName: 'build',
          workflowName: 'CI',
          repoOwner: GITHUB_ORG,
          repoName: 'acme-web',
          requestedLabels: [MOTIR_RUNNER_LABEL],
          queuedAt: old,
          status: 'running',
          containerProvider: 'aws',
          containerId: instanceId,
          containerRegion: 'us-east-1',
          fleetShardId: ciRow.id,
          bootedAt: old,
          startedAt: old,
        },
      });
    await intent(other, foreign);
    await intent(host, mine);

    const result = await fleetAttributionService.reconcile({
      now: () => new Date(T0.getTime() + MINUTE),
      inventory: null,
      listingRetryDelayMs: 0,
    });

    expect(result.outcome).toBe('reconciled');
    expect(ciEc2.liveInstanceIds()).toEqual([mine]);
    expect(mergedEc2.liveInstanceIds()).toEqual([]);
    const kills = await adminDb.fleetMachineKill.findMany();
    expect(kills.map((k) => [k.machineId, k.organizationId]).sort()).toEqual(
      [
        [untagged, host.organizationId],
        [foreign, host.organizationId],
        [strayMerged, host.organizationId],
      ].sort(),
    );
    const destroyed = sentry.captureException.mock.calls.filter(
      ([err]) => (err as Error).name === 'UnattributedMachineDestroyedError',
    );
    expect(destroyed).toHaveLength(3);
  });
});

describe('asking for more capacity', () => {
  it('alerts once, is filed and linked, and the caps follow the grant; a second ask answers the first', async () => {
    const host = await liveHost();
    const ci = await row(host.organizationId, 'ci_runner');
    sentry.captureException.mockClear();

    const asked = await fleetCapacityRequestService.request(
      {
        organizationId: host.organizationId,
        userId: host.userId,
        shardId: ci.id,
        fleetKind: 'ci_runner',
        desiredVcpu: 400,
        reason: 'a release week',
      },
      () => now,
    );
    expect(
      sentry.captureException.mock.calls.filter(
        ([err]) => (err as Error).name === 'FleetCapacityRequestedError',
      ),
    ).toHaveLength(1);

    const [filed] = await fleetQuotaRaiseService.fileRaises(
      { names: [ci.name], desiredVcpu: 400, operatorEmail },
      { management: () => organization, now: () => now },
    );
    if (!filed || !filed.ok) throw new Error('the raise did not file');
    const principal = await platformPrincipalForStaffEmail(operatorEmail);
    const linked = await fleetCapacityRequestService.linkQuotaRequest(
      { requestId: asked.id, quotaRequestId: filed.request.id },
      principal!,
      () => now,
    );
    expect(linked.status).toBe('filed');
    // A second ask while that one is active answers it.
    const again = await fleetCapacityRequestService.request(
      {
        organizationId: host.organizationId,
        userId: host.userId,
        shardId: ci.id,
        fleetKind: 'ci_runner',
        desiredVcpu: 400,
        reason: 'a release week',
      },
      () => now,
    );
    expect(again.id).toBe(asked.id);

    await answer(host.organizationId, 'ci_runner', 'APPROVED', 400);
    await statePass();
    expect((await caps(host.organizationId)).ciBurstCap).toBe(200);
  });
});

describe('the capacity request through fleet-admin', () => {
  it('refuses a non-superadmin, a short command, a wrong link and a closed request, and lists none once closed', async () => {
    const host = await liveHost();
    const ci = await row(host.organizationId, 'ci_runner');
    const runner = await row(host.organizationId, 'hosted_agent');
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) };
    const run = (...argv: string[]) => runFleetAdmin(argv, io);
    const ask = (shardId: string, fleetKind: string, desiredVcpu: number) =>
      fleetCapacityRequestService.request(
        {
          organizationId: host.organizationId,
          userId: host.userId,
          shardId,
          fleetKind,
          desiredVcpu,
          reason: 'more room',
        },
        () => now,
      );

    await expect(ask(ci.id, 'not_a_kind', 400)).rejects.toThrow('fleetKind');
    const asked = await ask(ci.id, 'ci_runner', 400);
    const other = await ask(runner.id, 'hosted_agent', 64);

    expect(await run('capacity-requests', '--operator', 'nobody@example.com')).toBe(1);
    expect(err.join('\n')).toContain('is not a superadmin');
    expect(await run('capacity-request-link', asked.id, '--operator', operatorEmail)).toBe(1);
    expect(err.join('\n')).toContain('capacity-request-link <request> <quota request>');
    expect(
      await run('capacity-request-link', 'no-such-request', 'q', '--operator', operatorEmail),
    ).toBe(1);
    expect(
      await run('capacity-request-link', asked.id, 'no-such-quota', '--operator', operatorEmail),
    ).toBe(1);

    // A raise on ANOTHER account is refused for this request.
    const [runnerRaise] = await fleetQuotaRaiseService.fileRaises(
      { names: [runner.name], desiredVcpu: 64, operatorEmail },
      { management: () => organization, now: () => now },
    );
    if (!runnerRaise || !runnerRaise.ok) throw new Error('the raise did not file');
    err.length = 0;
    expect(
      await run(
        'capacity-request-link',
        asked.id,
        runnerRaise.request.id,
        '--operator',
        operatorEmail,
      ),
    ).toBe(1);
    // Linked to its own raise; again with another raise is a state error.
    expect(
      await run(
        'capacity-request-link',
        other.id,
        runnerRaise.request.id,
        '--operator',
        operatorEmail,
      ),
    ).toBe(0);
    const [ciRaise] = await fleetQuotaRaiseService.fileRaises(
      { names: [ci.name], desiredVcpu: 400, operatorEmail },
      { management: () => organization, now: () => now },
    );
    if (!ciRaise || !ciRaise.ok) throw new Error('the raise did not file');
    expect(
      await run('capacity-request-link', other.id, ciRaise.request.id, '--operator', operatorEmail),
    ).toBe(1);

    expect(await run('capacity-request-close', asked.id, '  ', '--operator', operatorEmail)).toBe(
      1,
    );
    expect(
      await run('capacity-request-close', 'no-such-request', 'gone', '--operator', operatorEmail),
    ).toBe(1);
    expect(
      await run('capacity-request-close', asked.id, 'declined', '--operator', operatorEmail),
    ).toBe(0);
    expect(
      await run('capacity-request-close', asked.id, 'again', '--operator', operatorEmail),
    ).toBe(1);
    expect(
      await run('capacity-request-link', asked.id, ciRaise.request.id, '--operator', operatorEmail),
    ).toBe(1);
    expect(await run('capacity-request-close', other.id, 'done', '--operator', operatorEmail)).toBe(
      0,
    );

    out.length = 0;
    expect(await run('capacity-requests', '--operator', operatorEmail)).toBe(0);
    expect(out).toEqual(['no open or filed capacity requests']);
  });
});

describe('leaving Host and buying it again', () => {
  it('new work goes shared at Max; running work and the hoster instance stay; nothing is created or closed', async () => {
    const host = await liveHost();
    const ci = await row(host.organizationId, 'ci_runner');
    const hoster = await row(host.organizationId, 'agent_instance');
    await placed('ci_runner', host);
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const rowsBefore = await ownRows(host.organizationId);
    const requestsBefore = await ownRequests(host.organizationId);

    await setPlan(host.organizationId, 'max');
    for (const kind of KINDS) {
      expect(await placed(kind, host, { start: false })).toEqual({ shardId: shared[kind]!.id });
    }
    const max = await caps(host.organizationId);
    expect(max).toEqual(capsForPlanKey('max'));
    expect(
      await adminDb.ciRunnerProvisioningIntent.count({
        where: { fleetShardId: ci.id, status: 'running' },
      }),
    ).toBe(1);
    await fleetShardOrchestratorService.persistentOrchestratorFor({ fleetShardId: hoster.id });

    await reconcile();
    await statePass();
    expect(creates()).toHaveLength(3);
    const rowsAfter = await ownRows(host.organizationId);
    expect(rowsAfter.map((r) => [r.id, r.role, r.state, r.ownerOrganizationId, r.liveAt])).toEqual(
      rowsBefore.map((r) => [r.id, r.role, r.state, r.ownerOrganizationId, r.liveAt]),
    );
    expect(await ownRequests(host.organizationId)).toHaveLength(requestsBefore.length);

    await setPlan(host.organizationId, HOST_PLAN_KEY);
    await reconcile();
    expect(creates()).toHaveLength(3);
    expect((await ownRows(host.organizationId)).map((r) => r.id)).toEqual(
      rowsBefore.map((r) => r.id),
    );
    expect(await placed('ci_runner', host, { start: false })).toEqual({ shardId: ci.id });
  });

  it('an unreadable plan defers a job of an org with an own account: neither side', async () => {
    const host = await liveHost();
    await setPlan(host.organizationId, 'unknown');
    for (const kind of KINDS) {
      const p = await placed(kind, host, { start: false });
      expect(p).toMatchObject({ deferred: 'shard_capacity' });
    }
  });
});

describe('fleet-admin and secrets', () => {
  it('org-accounts lists four lines, pool-status shows only shared, and nothing anywhere carries a secret', async () => {
    const host = await liveHost();
    const out: string[] = [];
    const io = { out: (l: string) => void out.push(l), err: (l: string) => void out.push(l) };

    expect(await runFleetAdmin(['org-accounts', '--org', host.organizationId], io)).toBe(0);
    const listing = out.splice(0);
    expect(listing).toHaveLength(4);
    expect(listing.every((l) => l.includes(' live ') && l.includes('granted '))).toBe(true);

    const pool = {
      status: { onPool: async () => true, now: () => now, readUsage: async () => [] },
    };
    expect(await runFleetAdmin(['pool-status', '--kind', 'ci_runner'], io, pool)).toBe(0);
    const status = out.join('\n');
    expect(status).toContain('shared-ci-runner');
    const own = await row(host.organizationId, 'ci_runner');
    expect(status).not.toContain(own.name);
    expect(status).not.toContain('desired 200');

    const rows = JSON.stringify(await ownRows(host.organizationId));
    const audits = JSON.stringify(await adminDb.platformAuditLog.findMany());
    const text = [listing.join('\n'), status, rows, audits, JSON.stringify(alerts)].join('\n');
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    // Every member-account email the reconcile created an account with.
    expect(organization.usedEmails.size).toBe(3);
    for (const email of organization.usedEmails) expect(text).not.toContain(email);
  });
});
