import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AwsSessionCredentials, Ec2Api, FleetWorkloadKind } from '@motir/orchestrator';
import type { FleetShard } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { RawSubscriptionResponse } from '@/lib/ai/types';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import { hostMonthlyPlanCredits, largerPoolPlans } from '@/lib/billing/catalog';
import { ownAccountPoolCredits, planCarriesOwnAccounts } from '@/lib/billing/ownAccountPlans';
import { capsForPlanKey, HOST_PLAN_KEY, LARGER_POOL_FLOOR_CAPS } from '@/lib/billing/planCaps';
import { ownAccountRaiseTargetVcpu, type HostAccountSlot } from '@/lib/ciFleet/hostAccounts';
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
  installAddShardGithub,
  newGithubWorld,
  type GithubWorld,
} from '../helpers/addShardFakes';

// STORY MOTIR-9366's INTEGRATION GATE, SEAMS HALF (MOTIR-9656). The reconcile →
// state pass → admission → caps chain the Host gate (MOTIR-9591,
// `hostOwnAccountsIntegration.test.ts`) proves for a `host` org, walked for a 600k
// and a 2,400k org: three AWS accounts as four rows, raises at targets DERIVED from
// the Host bases and the rung's pool (`ownAccountRaiseTargetVcpu`), unchanged
// across repeated passes; the floor until a grant, granted ÷ 2 after; no
// non-owner job ever on a rung org's account; an upgrade from Host reusing the
// same accounts; a move to max_x2 and back creating and closing nothing.
//
// The world is `rungOwnAccounts.test.ts`'s (MOTIR-9653), copied: all four fleet
// kinds on AWS, a shared account per kind, the add-shard's fake AWS, jobs entering
// through their doors, `check` asserting the central invariant after EVERY
// placement. The plan is motir-ai's subscription read, the one stubbed seam; a
// "replay" is the reconcile run again with the plan unchanged. The catalog half
// is `tests/billing/largerPoolHostAnchorStoryGate.test.ts`.

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
  installation: 'ghs_INSTALL_SECRET_9656_never_printed',
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
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  _resetPlanCapsCache();
  fleetShardOrchestratorService.resetCache();
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

async function answerOf(organizationId: string) {
  _resetPlanCapsCache();
  return planCapsService.capsFor(organizationId);
}

// ── the seams ────────────────────────────────────────────────────────────────

/** The story's acceptance names these three keys; every figure is derived. */
const RUNG = 'pool_600k';
const TOP = 'pool_2400k';
const REMOVED = 'pool_250k';

const SLOT_OF: Partial<Record<FleetWorkloadKind, HostAccountSlot>> = {
  ci_runner: 'ci_runner',
  hosted_agent: 'agent_runner',
  code_graph_index: 'merged',
};
/** The three raises a plan's accounts file, derived from the Host bases and its pool. */
function targetsFor(planKey: string): [FleetWorkloadKind, number][] {
  const pool = ownAccountPoolCredits(planKey)!;
  return Object.entries(SLOT_OF)
    .map(
      ([kind, slot]) =>
        [kind as FleetWorkloadKind, ownAccountRaiseTargetVcpu(slot, pool)] as [
          FleetWorkloadKind,
          number,
        ],
    )
    .sort(([a], [b]) => a.localeCompare(b));
}
const raisesOf = async (organizationId: string) =>
  (await ownRequests(organizationId))
    .map((r) => [r.shard.fleetKind, r.desiredValue] as [FleetWorkloadKind, number])
    .sort(([a], [b]) => a.localeCompare(b));
const awsAccounts = async (organizationId: string) =>
  new Set((await ownRows(organizationId)).map((r) => r.awsAccountId)).size;
const snapshot = async (organizationId: string) => ({
  rows: (await ownRows(organizationId)).map((r) => [r.id, r.awsAccountId, r.quotaRequestedAt]),
  requests: (await ownRequests(organizationId)).map((r) => [r.id, r.desiredValue, r.closedAt]),
});

let top: Tenant;

describe('a 600k and a 2,400k org buy their rung', () => {
  it('the targets are the Host bases scaled by the pool — once, the story’s figures', () => {
    expect(largerPoolPlans().map((p) => p.key)).toEqual(expect.arrayContaining([RUNG, TOP]));
    expect(ownAccountPoolCredits(HOST_PLAN_KEY)).toBe(hostMonthlyPlanCredits());
    expect(targetsFor(RUNG).map(([, v]) => v)).toEqual([400, 120, 64]);
    expect(targetsFor(TOP).map(([, v]) => v)).toEqual([1600, 120, 256]);
  });

  it('the reconcile and state pass make three AWS accounts as four rows, three raises at the derived targets', async () => {
    top = await seedTenant();
    await setPlan(rung.organizationId, RUNG);
    await setPlan(top.organizationId, TOP);
    const createsBefore = creates().length;
    await reconcile();
    await statePass();

    for (const [tenant, key] of [
      [rung, RUNG],
      [top, TOP],
    ] as const) {
      const rows = await ownRows(tenant.organizationId);
      expect(rows.map((r) => r.fleetKind).sort(), key).toEqual([...KINDS].sort());
      expect(rows.every((r) => r.role === 'org_owned')).toBe(true);
      expect(await awsAccounts(tenant.organizationId), key).toBe(3);
      const merged = rows.filter(
        (r) => r.fleetKind === 'code_graph_index' || r.fleetKind === 'agent_instance',
      );
      expect(new Set(merged.map((r) => r.awsAccountId)).size, key).toBe(1);
      expect(await raisesOf(tenant.organizationId), key).toEqual(targetsFor(key));
      expect(
        rows.every((r) => r.quotaRequestedAt !== null),
        key,
      ).toBe(true);
      expect(await caps(tenant.organizationId), key).toEqual(LARGER_POOL_FLOOR_CAPS);
    }
    expect(creates().length - createsBefore).toBe(6);
  });

  it('two more passes with the plans unchanged create, file and move nothing', async () => {
    const before = [await snapshot(rung.organizationId), await snapshot(top.organizationId)];
    const createsBefore = creates().length;
    for (let i = 0; i < 2; i++) {
      setNow(new Date(now.getTime() + MINUTE));
      await reconcile();
      await statePass();
    }
    expect(creates()).toHaveLength(createsBefore);
    expect([await snapshot(rung.organizationId), await snapshot(top.organizationId)]).toEqual(
      before,
    );
  });

  it('on the floor, each org’s jobs of every kind land on the shared accounts', async () => {
    for (const tenant of [rung, top]) {
      const run = await hostedRun(tenant);
      expect(run.landed).toEqual(on(shared.hosted_agent!));
      await finishHosted([run.ref]);
      const job = await ciJob(tenant);
      expect(job.landed).toEqual(on(shared.ci_runner!));
      await finishCi([job.intentId]);
      const index = await indexRun(tenant);
      expect(index.landed).toEqual(on(shared.code_graph_index!));
      await index.release();
      expect(await agentInstance(tenant)).toEqual(on(shared.agent_instance!));
    }
    agents.clear();
  });

  it('the sixth run of the 600k org waits on the floor’s figure, never an own account or Fly', async () => {
    const floor = LARGER_POOL_FLOOR_CAPS.agentRunsInParallel;
    const runs = [];
    for (let i = 0; i <= floor; i++) runs.push(await hostedRun(rung));
    expect(runs.slice(0, floor).map((r) => r.landed)).toEqual(
      Array(floor).fill(on(shared.hosted_agent!)),
    );
    expect(runs[floor]!.landed).toMatchObject({ deferred: 'plan_cap' });
    expect((runs[floor]!.landed as { detail: string }).detail).toContain(`runs ${floor}`);
    await finishHosted(runs.map((r) => r.ref));
  });
});

describe('granted, each org runs on its own accounts at granted ÷ 2', () => {
  it('the 600k agent runner granted its target: runs = granted ÷ 2 on the own account; CI still shared at the floor', async () => {
    const granted = ownAccountRaiseTargetVcpu('agent_runner', ownAccountPoolCredits(RUNG)!);
    await answer(rung.organizationId, 'hosted_agent', 'APPROVED', granted);
    await statePass();
    const runner = await row(rung.organizationId, 'hosted_agent');
    expect(runner.liveAt).not.toBeNull();
    const read = await caps(rung.organizationId);
    expect(read.agentRunsInParallel).toBe(granted / 2);
    expect(read.agentRunsInParallel).toBe(32);

    const runs = [];
    for (let i = 0; i <= granted / 2; i++) runs.push(await hostedRun(rung));
    expect(runs.slice(0, granted / 2).map((r) => r.landed)).toEqual(
      Array(granted / 2).fill(on(runner)),
    );
    expect(runs[granted / 2]!.landed).toMatchObject({ deferred: 'plan_cap' });
    await finishHosted(runs.map((r) => r.ref));

    const job = await ciJob(rung);
    expect(job.landed).toEqual(on(shared.ci_runner!));
    expect(read.ciBurstCap).toBe(LARGER_POOL_FLOOR_CAPS.ciBurstCap);
    await finishCi([job.intentId]);
  });

  it('the 2,400k org granted CI and agent runner at its targets reads both ÷ 2, agents unchanged', async () => {
    const pool = ownAccountPoolCredits(TOP)!;
    const ci = ownAccountRaiseTargetVcpu('ci_runner', pool);
    const runner = ownAccountRaiseTargetVcpu('agent_runner', pool);
    await answer(top.organizationId, 'ci_runner', 'APPROVED', ci);
    await answer(top.organizationId, 'hosted_agent', 'APPROVED', runner);
    await statePass();
    const read = await caps(top.organizationId);
    expect(read).toEqual({
      ...LARGER_POOL_FLOOR_CAPS,
      agentRunsInParallel: runner / 2,
      ciBurstCap: ci / 2,
    });
    expect([read.agentRunsInParallel, read.ciBurstCap]).toEqual([128, 800]);
    expect([read.agentsPerUser, read.agentsRunningPerOrg]).toEqual([10, 50]);
    const job = await ciJob(top);
    expect(job.landed).toEqual(on(await row(top.organizationId, 'ci_runner')));
    await finishCi([job.intentId]);
  });

  it('the 600k merged account granted: both rows live together, 10 index spots kept beside the org’s agents', async () => {
    await answer(rung.organizationId, 'code_graph_index', 'APPROVED', 120);
    await statePass();
    const index = await row(rung.organizationId, 'code_graph_index');
    const hoster = await row(rung.organizationId, 'agent_instance');
    expect([index.state, index.liveAt]).toEqual([hoster.state, hoster.liveAt]);
    expect(index.liveAt).not.toBeNull();

    const perOrg = (await caps(rung.organizationId)).agentsRunningPerOrg;
    const placed: Landed[] = [];
    for (let i = 0; i <= perOrg; i++) placed.push(await agentInstance(rung));
    expect(placed.slice(0, perOrg)).toEqual(Array(perOrg).fill(on(hoster)));
    expect(placed[perOrg]).toEqual({
      deferred: 'shard_capacity',
      detail: ownWait('agent_instance'),
    });

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
});

describe('nobody else lands on a rung org’s accounts', () => {
  it('another Host org, a max_x2 org, a pool_250k org and a Motir exempt org, in every kind', async () => {
    const otherHost = await seedTenant();
    await setPlan(otherHost.organizationId, HOST_PLAN_KEY);
    const ladder = await seedTenant();
    await setPlan(ladder.organizationId, 'max_x2');
    const removed = await seedTenant();
    await setPlan(removed.organizationId, REMOVED);
    const meta = await seedTenant();
    await adminDb.organization.update({
      where: { id: meta.organizationId },
      data: { isMeta: true },
    });
    const owned = new Set(
      [...(await ownRows(rung.organizationId)), ...(await ownRows(top.organizationId))].map(
        (r) => r.id,
      ),
    );

    for (const tenant of [otherHost, ladder, removed, meta]) {
      for (const kind of KINDS) {
        const set = await withSystemContext((tx) =>
          fleetShardAdmissionService.selectionSetInTx(
            { fleetKind: kind, organizationId: tenant.organizationId },
            tx,
          ),
        );
        expect(
          set.some((s) => owned.has(s.id)),
          `${kind} selection`,
        ).toBe(false);
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
        expect(moved === null || !owned.has(moved), `${kind} move`).toBe(true);
        await adminDb.fleetShard.update({
          where: { id: shared[kind]!.id },
          data: { admissionPausedUntil: null, admissionPausedReason: null },
        });
      }
    }
    // Their jobs through the doors, under the central invariant.
    for (const tenant of [ladder, meta]) {
      const run = await hostedRun(tenant);
      expect(run.landed).toEqual(on(shared.hosted_agent!));
      await finishHosted([run.ref]);
    }

    // The removed rung: no caps row, no account, no row, no request.
    const createsBefore = creates().length;
    await reconcile();
    await statePass();
    expect(await answerOf(removed.organizationId)).toEqual({
      kind: 'plan_unknown',
      planKey: REMOVED,
    });
    expect(await ownRows(removed.organizationId)).toEqual([]);
    expect(await ownRequests(removed.organizationId)).toEqual([]);
    // Only the other Host org was new to the reconcile.
    expect(creates().length - createsBefore).toBe(3);
  });
});

describe('an upgrade from Host to pool_600k', () => {
  it('reuses the Host accounts; the new CI target is filed once, after the open 200 closes', async () => {
    const host = await seedTenant();
    await setPlan(host.organizationId, HOST_PLAN_KEY);
    await reconcile();
    await statePass();
    const rowsBefore = await ownRows(host.organizationId);
    const hostCi = ownAccountRaiseTargetVcpu('ci_runner', hostMonthlyPlanCredits());
    expect((await raisesOf(host.organizationId)).find(([k]) => k === 'ci_runner')).toEqual([
      'ci_runner',
      hostCi,
    ]);
    const createsBefore = creates().length;
    const alertsBefore = alerts.length;

    await setPlan(host.organizationId, RUNG);
    await reconcile();
    await statePass();
    expect(creates()).toHaveLength(createsBefore);
    expect((await ownRows(host.organizationId)).map((r) => r.id)).toEqual(
      rowsBefore.map((r) => r.id),
    );
    const ciRequests = async () =>
      (await ownRequests(host.organizationId)).filter((r) => r.shard.fleetKind === 'ci_runner');
    expect((await ciRequests()).map((r) => r.desiredValue)).toEqual([hostCi]);
    expect(alerts).toHaveLength(alertsBefore);

    // AWS answers the 200: granted, short of the rung's target.
    await answer(host.organizationId, 'ci_runner', 'APPROVED', hostCi);
    const rungCi = ownAccountRaiseTargetVcpu('ci_runner', ownAccountPoolCredits(RUNG)!);
    for (let i = 0; i < 2; i++) {
      await reconcile();
      await statePass();
    }
    expect((await ciRequests()).map((r) => r.desiredValue)).toEqual([hostCi, rungCi]);
    expect(rungCi).toBe(400);
    expect(creates()).toHaveLength(createsBefore);
  });
});

describe('a 600k org downgraded to max_x2 and back', () => {
  it('new work is shared at max_x2’s caps, nothing created or closed; back on the rung it routes to the same accounts', async () => {
    const rowsBefore = await ownRows(rung.organizationId);
    const requestsBefore = await adminDb.fleetQuotaRequest.count();
    const createsBefore = creates().length;
    const runner = await row(rung.organizationId, 'hosted_agent');

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

    await setPlan(rung.organizationId, RUNG);
    const back = await hostedRun(rung);
    expect(back.landed).toEqual(on(runner));
    await finishHosted([back.ref]);
    await reconcile();
    await statePass();
    expect(creates()).toHaveLength(createsBefore);
    expect(
      (await ownRows(rung.organizationId)).map((r) => [r.id, r.role, r.state, r.liveAt]),
    ).toEqual(rowsBefore.map((r) => [r.id, r.role, r.state, r.liveAt]));
  });
});
