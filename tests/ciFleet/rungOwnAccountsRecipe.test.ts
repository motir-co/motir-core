import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AwsSessionCredentials, Ec2Api, FleetWorkloadKind } from '@motir/orchestrator';
import type { FleetShard } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { RawSubscriptionResponse } from '@/lib/ai/types';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import { BILLING_CATALOG, largerPoolPlans } from '@/lib/billing/catalog';
import { ownAccountPoolCredits, planCarriesOwnAccounts } from '@/lib/billing/ownAccountPlans';
import { LARGER_POOL_FLOOR_CAPS } from '@/lib/billing/planCaps';
import { ownAccountRaiseTargetVcpu } from '@/lib/ciFleet/hostAccounts';
import { AgentInstanceStartRefusedError } from '@/lib/agentInstances/errors';
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

// STORY MOTIR-9366's VERIFICATION RECIPE, STEPS 5–8 (MOTIR-9657) — the fleet half
// of the story's acceptance, walked in order with one org's state carried from
// step to step: an org whose plan reads `pool_600k` gets three AWS accounts asking
// the raises its pool derives (5), runs on the shared floor until a grant (6), on
// its own agent runner at granted ÷ 2 once granted (7), and keeps Host's agent
// figures for its members (8). The billing half (steps 1–4, 9, 10) is the
// browser receipt `tests/e2e/acceptance-billing-larger-pool-above-host.spec.ts`.
//
// The world is `rungOwnAccounts.test.ts`'s (MOTIR-9653), which is the Host
// recipe's (`hostOwnAccountsRecipe.test.ts`, MOTIR-9592): all four fleet kinds on
// AWS, a shared account per kind, the add-shard's fake AWS, jobs through the
// doors their dispatchers call, and `check` — the central invariant — after
// EVERY placement. The plan is motir-ai's subscription read, the one stubbed
// seam: motir-core reads the tier from motir-ai and has no invoice webhook.
//
// Typed: the recipe's 64 vCPU grant, and the three keys the story names. Every
// other figure is derived from the catalog and `ownAccountRaiseTargetVcpu`.

// ── seams ────────────────────────────────────────────────────────────────────

const getOrgSubscriptionMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  getOrgSubscription: (q: unknown) => getOrgSubscriptionMock(q),
  // Agent creation asks motir-ai whether the org may run (recipe 8): it may.
  checkAgentRunCredits: async () => ({ balanceCredits: 100, mayRun: true }),
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
const { runFleetAdmin } = await import('@/scripts/fleet/fleetAdmin');
const { agentInstanceLifecycleService: lifecycle } =
  await import('@/lib/services/agentInstanceLifecycleService');

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
  installation: 'ghs_INSTALL_SECRET_9657_never_printed',
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
        planTier: {
          key,
          name: BILLING_CATALOG.aiPlans.find((p) => p.key === key)?.name ?? key,
          monthlyCreditAllotment: 1,
        },
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
  await adminDb.agentInstance.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── the recipe ───────────────────────────────────────────────────────────────

const RUNG = 'pool_600k';
const RUNG_ENTRY = BILLING_CATALOG.aiPlans.find((p) => p.key === RUNG)!;
/** The recipe's grant on the agent runner. */
const GRANT = 64;

async function fleetAdmin(...argv: string[]): Promise<string[]> {
  const out: string[] = [];
  const io = { out: (l: string) => void out.push(l), err: (l: string) => void out.push(l) };
  const pool = { status: { onPool: async () => true, now: () => now, readUsage: async () => [] } };
  expect(await runFleetAdmin(argv, io, pool)).toBe(0);
  return out;
}

/** Another org's jobs of every kind, after each step: never on this org's accounts. */
let other: Tenant;
async function foreignJobs() {
  const run = await hostedRun(other);
  expect(run.landed).toEqual(on(shared.hosted_agent!));
  await finishHosted([run.ref]);
  const job = await ciJob(other);
  expect(job.landed).toEqual(on(shared.ci_runner!));
  await finishCi([job.intentId]);
  const index = await indexRun(other);
  expect(index.landed).toEqual(on(shared.code_graph_index!));
  await index.release();
  expect(await agentInstance(other)).toEqual(on(shared.agent_instance!));
  agents.clear();
}

describe('the larger-pool recipe, steps 5–8, for one pool_600k org', () => {
  beforeAll(async () => {
    other = await seedTenant();
    await setPlan(other.organizationId, 'max_x2');
  });
  afterEach(foreignJobs);

  it('recipe 5 — the plan reads pool_600k: three accounts as four rows asking the derived raises, none in pool-status; a second pass makes nothing', async () => {
    expect(largerPoolPlans().map((p) => p.key)).toContain(RUNG);
    await setPlan(rung.organizationId, RUNG);
    await reconcile();
    await statePass();

    const rows = await ownRows(rung.organizationId);
    expect(rows.map((r) => r.fleetKind).sort()).toEqual([...KINDS].sort());
    expect(rows.every((r) => r.role === 'org_owned')).toBe(true);
    expect(new Set(rows.map((r) => r.awsAccountId)).size).toBe(3);
    const index = rows.find((r) => r.fleetKind === 'code_graph_index')!;
    const hoster = rows.find((r) => r.fleetKind === 'agent_instance')!;
    expect(index.awsAccountId).toBe(hoster.awsAccountId);

    const pool = ownAccountPoolCredits(RUNG)!;
    expect(pool).toBe(RUNG_ENTRY.allotment!.credits);
    const expected: [FleetWorkloadKind, number, null][] = [
      ['ci_runner', ownAccountRaiseTargetVcpu('ci_runner', pool), null],
      ['code_graph_index', ownAccountRaiseTargetVcpu('merged', pool), null],
      ['hosted_agent', ownAccountRaiseTargetVcpu('agent_runner', pool), null],
    ];
    const requests = await ownRequests(rung.organizationId);
    expect(requests.map((r) => [r.shard.fleetKind, r.desiredValue, r.closedAt]).sort()).toEqual(
      expected.sort(),
    );
    // Once, so a reader sees the recipe's figures.
    expect(expected.map(([, v]) => v)).toEqual([400, 120, 64]);

    const listing = await fleetAdmin('org-accounts', '--org', rung.organizationId);
    expect(listing).toHaveLength(4);
    expect(listing.every((l) => l.includes(' quota_requested '))).toBe(true);
    for (const kind of KINDS) {
      const status = (await fleetAdmin('pool-status', '--kind', kind)).join('\n');
      expect(status).toContain(shared[kind]!.name);
      for (const own of rows) expect(status).not.toContain(own.name);
    }
    expect(creates()).toHaveLength(3);

    setNow(new Date(T0.getTime() + 5 * MINUTE));
    await reconcile();
    await statePass();
    expect(creates()).toHaveLength(3);
    expect(organization.accounts.size).toBe(3);
    expect((await ownRows(rung.organizationId)).map((r) => [r.id, r.quotaRequestedAt])).toEqual(
      rows.map((r) => [r.id, r.quotaRequestedAt]),
    );
    expect(await ownRequests(rung.organizationId)).toHaveLength(3);
  });

  it("recipe 6 — before any grant: five runs on the shared runner, the sixth waits naming the plan's figure", async () => {
    const floor = LARGER_POOL_FLOOR_CAPS.agentRunsInParallel;
    expect(floor).toBe(5);
    const runs = [];
    for (let i = 0; i <= floor; i++) runs.push(await hostedRun(rung));
    expect(runs.slice(0, floor).map((r) => r.landed)).toEqual(
      Array(floor).fill(on(shared.hosted_agent!)),
    );
    expect(runs[floor]!.landed).toMatchObject({ deferred: 'plan_cap' });
    expect((runs[floor]!.landed as { detail: string }).detail).toContain(`runs ${floor}`);
    await finishHosted(runs.map((r) => r.ref));
    const job = await ciJob(rung);
    expect(job.landed).toEqual(on(shared.ci_runner!));
    await finishCi([job.intentId]);
  });

  it('recipe 7 — the agent runner granted at 64: live, 32 runs on the own account, the 33rd waits with the own-capacity words', async () => {
    await answer(rung.organizationId, 'hosted_agent', 'APPROVED', GRANT);
    await statePass();
    const runner = await row(rung.organizationId, 'hosted_agent');
    expect(runner.liveAt).not.toBeNull();
    const read = await caps(rung.organizationId);
    expect(read.agentRunsInParallel).toBe(GRANT / 2);
    expect(read.agentRunsInParallel).toBe(32);

    const runs = [];
    for (let i = 0; i < GRANT / 2; i++) runs.push(await hostedRun(rung));
    expect(runs.map((r) => r.landed)).toEqual(Array(GRANT / 2).fill(on(runner)));
    const next = await withSystemContext((tx) =>
      fleetShardAdmissionService.chooseInTx(
        { fleetKind: 'hosted_agent', organizationId: rung.organizationId },
        now,
        tx,
      ),
    );
    expect(next).toMatchObject({ deferred: 'shard_capacity', detail: ownWait('hosted_agent') });
    const over = await hostedRun(rung);
    expect(over.landed).toMatchObject({ deferred: 'plan_cap' });
    await finishHosted([...runs, over].map((r) => r.ref));
    // CI's own account is not granted yet: still the shared pool.
    const job = await ciJob(rung);
    expect(job.landed).toEqual(on(shared.ci_runner!));
    await finishCi([job.intentId]);
  });

  it('recipe 8 — a member creates agents: the tenth is created, the eleventh refused naming the plan; 10 / 50 as on the floor', async () => {
    const read = await caps(rung.organizationId);
    expect([read.agentsPerUser, read.agentsRunningPerOrg]).toEqual([
      LARGER_POOL_FLOOR_CAPS.agentsPerUser,
      LARGER_POOL_FLOOR_CAPS.agentsRunningPerOrg,
    ]);
    expect([read.agentsPerUser, read.agentsRunningPerOrg]).toEqual([10, 50]);

    const project = await adminDb.project.findUniqueOrThrow({ where: { id: rung.projectId } });
    const ctx = { userId: rung.userId, workspaceId: rung.workspaceId };
    const create = (name: string) =>
      lifecycle.create(project.identifier, { name, profileId: 'claude' }, ctx);
    for (let i = 1; i <= read.agentsPerUser; i++) {
      expect((await create(`agent-${i}`)).name).toBe(`agent-${i}`);
    }
    const refused = await create(`agent-${read.agentsPerUser + 1}`).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AgentInstanceStartRefusedError);
    expect(refused).toMatchObject({ reason: 'user_cap', limit: read.agentsPerUser });
    expect((refused as Error).message).toContain(RUNG_ENTRY.name);
  });
});
