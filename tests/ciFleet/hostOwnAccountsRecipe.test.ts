import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
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

// THE VERIFICATION RECIPE OF STORY MOTIR-9365, AS ONE WALK (MOTIR-9592). The
// story's eleven steps run in order against ONE world, each step's state feeding
// the next: all four fleet kinds switched to AWS, a shared account per kind, and
// the add-shard's fake AWS (Organizations + Service Quotas in
// `FakeOrganization`, the network over the in-memory EC2).
//
// The cross-card seams are proven case by case in
// `hostOwnAccountsIntegration.test.ts`; this file proves the SEQUENCE: one org
// carried from purchase through the shared floor, grants and a denial, a full
// account, a leaked machine, a kind switched back to Fly and a downgrade, with a
// second Host org for the refused creation.
//
// Jobs enter through the doors their dispatchers call: a hosted run through
// `fleetCeilingService.reserve`, a CI job through `ciRunnerAdmissionService.admit`,
// an index run through `codeGraphIndexAdmissionService.admit`. An agent
// instance is placed by `chooseInTx`, its running count read through the
// hoster's counter, because creating instance records is the agent hoster
// story's lifecycle. The plan is motir-ai's subscription read, the one stubbed
// seam; motir-core has no invoice webhook, so a replayed purchase is the
// reconcile and state jobs run again with the plan unchanged.
//
// `check` asserts the central invariant after EVERY placement: a job of an org
// other than an account's owner never names an `org_owned` row, and a job of a
// Host org with a live own account of the kind names that row or waits — never
// a shared account, never Fly.

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
const { fleetCeilingService } = await import('@/lib/services/fleetCeilingService');
const { ciRunnerAdmissionService } = await import('@/lib/services/ciRunnerAdmissionService');
const { codeGraphIndexAdmissionService } =
  await import('@/lib/services/codeGraphIndexAdmissionService');
const { fleetAttributionService, FLEET_ATTRIBUTION_GRACE_MS } =
  await import('@/lib/services/fleetAttributionService');
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

const KINDS: FleetWorkloadKind[] = [
  'ci_runner',
  'hosted_agent',
  'code_graph_index',
  'agent_instance',
];
const GITHUB_ORG = 'motir-fleet-use1-1';
const TEMPLATE = 'aws+{name}@motir.co';
const SECRETS = {
  installation: 'ghs_INSTALL_SECRET_9592_never_printed',
  managementKey: 'AKIA_MANAGEMENT_9592_never_printed',
  managementSecret: 'MANAGEMENT_SECRET_9592_never_printed',
  sessionKeyId: 'ASIA_SESSION_9592_never_printed',
  sessionSecret: 'SESSION_SECRET_9592_never_printed',
  sessionToken: 'SESSION_TOKEN_9592_never_printed',
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
/** Every line a `fleet-admin` command printed, across the walk. */
const printed: string[] = [];
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

/** The org the recipe carries through every step, and the second Host org. */
let first: Tenant;
let second: Tenant;

function setNow(at: Date) {
  now = at;
  vi.setSystemTime(at);
}

let tenantSeq = 0;
async function seedTenant(): Promise<Tenant> {
  tenantSeq += 1;
  const user = await usersService.createUser({
    email: `host-recipe-${tenantSeq}-${Date.now()}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Recipe ${tenantSeq}`,
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

async function fleetAdmin(...argv: string[]): Promise<string[]> {
  const out: string[] = [];
  const io = { out: (l: string) => void out.push(l), err: (l: string) => void out.push(l) };
  const pool = { status: { onPool: async () => true, now: () => now, readUsage: async () => [] } };
  expect(await runFleetAdmin(argv, io, pool)).toBe(0);
  printed.push(...out);
  return out;
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
  const onHost = plans.get(organizationId) === HOST_PLAN_KEY;
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
      runId: '9592',
      runAttempt: 1,
      jobId: String(959_200 + seq),
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
  AwsEc2FakeCtor = AwsEc2Fake;
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
  first = await seedTenant();
});

let AwsEc2FakeCtor: new () => Ec2Fake;

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

// ── the recipe ───────────────────────────────────────────────────────────────

describe('the Host own-accounts recipe, step by step', () => {
  it('recipe 1 — buying Host creates three accounts as four rows, each raise pending, none in pool-status', async () => {
    await setPlan(first.organizationId, HOST_PLAN_KEY);
    await reconcile();
    await statePass();

    const rows = await ownRows(first.organizationId);
    expect(rows.map((r) => r.fleetKind).sort()).toEqual([...KINDS].sort());
    expect(rows.every((r) => r.role === 'org_owned')).toBe(true);
    expect(new Set(rows.map((r) => r.awsAccountId)).size).toBe(3);
    const index = rows.find((r) => r.fleetKind === 'code_graph_index')!;
    const hoster = rows.find((r) => r.fleetKind === 'agent_instance')!;
    expect(index.awsAccountId).toBe(hoster.awsAccountId);
    const requests = await ownRequests(first.organizationId);
    expect(requests.map((r) => [r.shard.fleetKind, r.desiredValue, r.closedAt]).sort()).toEqual(
      [
        ['ci_runner', 200, null],
        ['code_graph_index', 120, null],
        ['hosted_agent', 32, null],
      ].sort(),
    );

    const listing = await fleetAdmin('org-accounts', '--org', first.organizationId);
    expect(listing).toHaveLength(4);
    expect(listing.every((l) => l.includes(' quota_requested '))).toBe(true);
    for (const kind of KINDS) {
      const status = (await fleetAdmin('pool-status', '--kind', kind)).join('\n');
      expect(status).toContain(shared[kind]!.name);
      for (const own of rows) expect(status).not.toContain(own.name);
    }
    expect(creates()).toHaveLength(3);
  });

  it('recipe 2 — replaying the purchase creates nothing more', async () => {
    const before = await ownRows(first.organizationId);
    setNow(new Date(T0.getTime() + 5 * MINUTE));
    await reconcile();
    await statePass();

    expect(creates()).toHaveLength(3);
    expect(organization.accounts.size).toBe(3);
    const after = await ownRows(first.organizationId);
    expect(after.map((r) => [r.id, r.quotaRequestedAt])).toEqual(
      before.map((r) => [r.id, r.quotaRequestedAt]),
    );
    expect(await ownRequests(first.organizationId)).toHaveLength(3);
  });

  it("recipe 3 — before any grant: five runs on the shared runner, the sixth waits on the plan's figure; CI held to 20 on shared", async () => {
    const runs = [];
    for (let i = 0; i < 6; i++) runs.push(await hostedRun(first));
    expect(runs.slice(0, 5).map((r) => r.landed)).toEqual(Array(5).fill(on(shared.hosted_agent!)));
    expect(runs[5]!.landed).toMatchObject({ deferred: 'plan_cap' });
    expect((runs[5]!.landed as { detail: string }).detail).toContain('runs 5');

    const jobs = [];
    for (let i = 0; i < 21; i++) jobs.push(await ciJob(first));
    expect(
      jobs
        .slice(0, 20)
        .every((j) => 'shardId' in j.landed && j.landed.shardId === shared.ci_runner!.id),
    ).toBe(true);
    expect(jobs[20]!.landed).toMatchObject({ deferred: 'plan_cap' });
    expect((jobs[20]!.landed as { detail: string }).detail).toContain('20');
    expect([
      (await caps(first.organizationId)).agentRunsInParallel,
      (await caps(first.organizationId)).ciBurstCap,
    ]).toEqual([5, 20]);

    // The runs and the push finish.
    await finishHosted(runs.map((r) => r.ref));
    await finishCi(jobs.map((j) => j.intentId));
  });

  const ownRunnerRefs: string[] = [];

  it('recipe 4 — the agent runner granted at 32: live, sixteen runs on the own account, four wait', async () => {
    await answer(first.organizationId, 'hosted_agent', 'APPROVED', 32);
    await statePass();
    const runner = await row(first.organizationId, 'hosted_agent');
    expect(runner.grantedAt).not.toBeNull();
    expect(runner.liveAt).not.toBeNull();
    expect(runner.state).toBe('active');
    const listing = await fleetAdmin('org-accounts', '--org', first.organizationId);
    expect(listing.find((l) => l.includes('hosted_agent'))).toContain(' live ');
    expect((await caps(first.organizationId)).agentRunsInParallel).toBe(16);

    const runs = [];
    for (let i = 0; i < 20; i++) runs.push(await hostedRun(first));
    expect(runs.slice(0, 16).map((r) => r.landed)).toEqual(Array(16).fill(on(runner)));
    for (const r of runs.slice(16)) {
      expect(r.landed).toMatchObject({ deferred: 'plan_cap' });
      expect((r.landed as { detail: string }).detail).toContain('runs 16');
    }
    ownRunnerRefs.push(...runs.slice(0, 16).map((r) => r.ref));
  });

  it('recipe 5 — a full own account means wait: never shared, never Fly, also after a move on refusal', async () => {
    const runner = await row(first.organizationId, 'hosted_agent');
    // The account itself is full: its own answer is the own-capacity wait.
    const full = await withSystemContext((tx) =>
      fleetShardAdmissionService.chooseInTx(
        { fleetKind: 'hosted_agent', organizationId: first.organizationId },
        now,
        tx,
      ),
    );
    expect(full).toMatchObject({ deferred: 'shard_capacity', detail: ownWait('hosted_agent') });

    // One run finishes; the next lands, and the account refuses its machine.
    await finishHosted(ownRunnerRefs.splice(0, 1));
    const next = await hostedRun(first);
    expect(next.landed).toEqual(on(runner));
    const moved = await fleetCeilingService.moveHostedSlotAfterRefusal(
      { ref: next.ref, ownerRef: next.ref, organizationId: first.organizationId },
      runner.id,
      'capacity_refused',
      new Set([runner.id]),
      now,
    );
    expect(moved).toBeNull();
    await finishHosted([next.ref]);

    // Paused by that refusal: the next run waits for its own account.
    const waiting = await hostedRun(first);
    expect(waiting.landed).toEqual({ deferred: 'shard_capacity', detail: ownWait('hosted_agent') });
    await finishHosted(ownRunnerRefs.splice(0));
  });

  it('recipe 6 — CI boots shared while its raise is pending, then on its own account once granted', async () => {
    setNow(new Date(now.getTime() + 5 * MINUTE)); // past the refusal's pause
    const pending = await ciJob(first);
    expect(pending.landed).toEqual(on(shared.ci_runner!));
    expect((await caps(first.organizationId)).ciBurstCap).toBe(20);

    await answer(first.organizationId, 'ci_runner', 'APPROVED', 200);
    await statePass();
    const ci = await row(first.organizationId, 'ci_runner');
    expect(ci.liveAt).not.toBeNull();
    const granted = await ciJob(first);
    expect(granted.landed).toEqual(on(ci));
    expect((await caps(first.organizationId)).ciBurstCap).toBe(100);
    // The agent runner is unaffected.
    const run = await hostedRun(first);
    expect(run.landed).toEqual(on(await row(first.organizationId, 'hosted_agent')));
    await finishHosted([run.ref]);
  });

  it('recipe 7 — the merged account denied keeps indexing and instances shared; granted at 40 it keeps 10 index spots and runs 10 instances', async () => {
    await answer(first.organizationId, 'code_graph_index', 'DENIED');
    await statePass();
    const index = await row(first.organizationId, 'code_graph_index');
    const hoster = await row(first.organizationId, 'agent_instance');
    expect([index.grantedAt, index.liveAt, hoster.liveAt]).toEqual([null, null, null]);
    const listing = await fleetAdmin('org-accounts', '--org', first.organizationId);
    expect(listing.find((l) => l.includes('code_graph_index'))).toContain(' quota_requested ');
    const sharedIndex = await indexRun(first);
    expect(sharedIndex.landed).toEqual(on(shared.code_graph_index!));
    await sharedIndex.release();
    expect(
      await withSystemContext((tx) =>
        fleetShardAdmissionService.chooseInTx(
          { fleetKind: 'agent_instance', organizationId: first.organizationId },
          now,
          tx,
        ),
      ),
    ).toEqual(on(shared.agent_instance!));

    // The platform admin files again, and AWS grants 40.
    const [raised] = await fleetQuotaRaiseService.fileRaises(
      { names: [index.name], desiredVcpu: 40, operatorEmail },
      { management: () => organization, now: () => now },
    );
    expect(raised).toMatchObject({ ok: true });
    await answer(first.organizationId, 'code_graph_index', 'APPROVED', 40);
    await statePass();
    const [a, b] = [
      await row(first.organizationId, 'code_graph_index'),
      await row(first.organizationId, 'agent_instance'),
    ];
    expect([a.state, a.quotaRequestedAt, a.grantedAt, a.liveAt]).toEqual([
      b.state,
      b.quotaRequestedAt,
      b.grantedAt,
      b.liveAt,
    ]);
    expect(a.liveAt).not.toBeNull();

    // No index running: 10 instances and no 11th — the index spots are not lent.
    const placed: Landed[] = [];
    for (let i = 0; i < 11; i++) placed.push(await agentInstance(first));
    expect(placed.slice(0, 10)).toEqual(Array(10).fill(on(hoster)));
    expect(placed[10]).toEqual({ deferred: 'shard_capacity', detail: ownWait('agent_instance') });
    // And all 10 index spots are still free beside them.
    const runs = [];
    for (let i = 0; i < 11; i++) runs.push(await indexRun(first));
    expect(runs.slice(0, 10).map((r) => r.landed)).toEqual(Array(10).fill(on(index)));
    expect(runs[10]!.landed).toEqual({
      deferred: 'pool_full',
      detail: ownWait('code_graph_index'),
    });
    for (const r of runs) await r.release();
  });

  it('recipe 8 — a refused creation for a second Host org: one alert, no row, the shared floor, then the retry after the backoff', async () => {
    const firstRows = await ownRows(first.organizationId);
    second = await seedTenant();
    await setPlan(second.organizationId, HOST_PLAN_KEY);
    const taken = TEMPLATE.replace(
      '{name}',
      hostAccountPlan(second.organizationId, 'ci_runner', hostMonthlyPlanCredits()).account.name,
    );
    organization.usedEmails.add(taken);
    const alertsBefore = alerts.length;

    await reconcile();
    expect((await ownRows(second.organizationId)).map((r) => r.fleetKind)).not.toContain(
      'ci_runner',
    );
    expect(alerts.slice(alertsBefore)).toHaveLength(1);
    expect((alerts[alertsBefore] as HostAccountRefusedError).organizationId).toBe(
      second.organizationId,
    );
    const job = await ciJob(second);
    expect(job.landed).toEqual(on(shared.ci_runner!));
    const run = await hostedRun(second);
    expect(run.landed).toEqual(on(shared.hosted_agent!));
    await finishHosted([run.ref]);

    // Inside the backoff: not tried again.
    organization.usedEmails.delete(taken);
    setNow(new Date(now.getTime() + MINUTE));
    await reconcile();
    expect((await ownRows(second.organizationId)).map((r) => r.fleetKind)).not.toContain(
      'ci_runner',
    );

    setNow(new Date(now.getTime() + 2 * 60 * MINUTE));
    await reconcile();
    expect((await ownRows(second.organizationId)).map((r) => r.fleetKind)).toContain('ci_runner');
    expect(alerts.slice(alertsBefore)).toHaveLength(1);
    const firstAfter = await ownRows(first.organizationId);
    expect(firstAfter.map((r) => [r.id, r.state, r.liveAt])).toEqual(
      firstRows.map((r) => [r.id, r.state, r.liveAt]),
    );
  });

  it('recipe 9 — an untagged machine on the own CI account is destroyed, recorded against the owner, alerted once', async () => {
    const ci = await row(first.organizationId, 'ci_runner');
    const ec2 = new AwsEc2FakeCtor();
    inventories.byAccount.set(ci.awsAccountId!, ec2);
    const leaked = ec2.plantInstance({
      instanceId: `i-${randomToken(12).toLowerCase()}`,
      launchTime: new Date(now.getTime() - 2 * FLEET_ATTRIBUTION_GRACE_MS),
      tags: [],
    });
    sentry.captureException.mockClear();

    const result = await fleetAttributionService.reconcile({
      now: () => now,
      inventory: null,
      listingRetryDelayMs: 0,
    });

    expect(result.outcome).toBe('reconciled');
    expect(ec2.liveInstanceIds()).toEqual([]);
    const kills = await adminDb.fleetMachineKill.findMany();
    expect(kills.map((k) => [k.machineId, k.organizationId])).toEqual([
      [leaked, first.organizationId],
    ]);
    expect(
      sentry.captureException.mock.calls.filter(
        ([err]) => (err as Error).name === 'UnattributedMachineDestroyedError',
      ),
    ).toHaveLength(1);
  });

  it('recipe 10 — the indexer switched back to Fly: the next index run is on Fly, the other kinds stay on their own accounts', async () => {
    flySwitch.add('code_graph_index');
    const run = await indexRun(first);
    expect(run.landed).toEqual({ shardId: null });
    await run.release();

    expect((await ciJob(first)).landed).toEqual(on(await row(first.organizationId, 'ci_runner')));
    const hosted = await hostedRun(first);
    expect(hosted.landed).toEqual(on(await row(first.organizationId, 'hosted_agent')));
    await finishHosted([hosted.ref]);
    // Room freed by an instance that ended.
    const hoster = await row(first.organizationId, 'agent_instance');
    agents.set(hoster.id, 9);
    expect(await agentInstance(first)).toEqual(on(hoster));
  });

  it('recipe 11 — downgraded to Max: new work is shared at Max, the instance on the hoster still wakes there, nothing is created or closed', async () => {
    flySwitch.delete('code_graph_index');
    const rowsBefore = await ownRows(first.organizationId);
    const requestsBefore = await adminDb.fleetQuotaRequest.count();
    const accountsBefore = organization.accounts.size;
    const createsBefore = creates().length;
    const hoster = await row(first.organizationId, 'agent_instance');

    await setPlan(first.organizationId, 'max');
    expect(await caps(first.organizationId)).toEqual(capsForPlanKey('max'));
    const run = await hostedRun(first);
    expect(run.landed).toEqual(on(shared.hosted_agent!));
    await finishHosted([run.ref]);
    expect((await ciJob(first)).landed).toEqual(on(shared.ci_runner!));
    const index = await indexRun(first);
    expect(index.landed).toEqual(on(shared.code_graph_index!));
    await index.release();
    expect(await agentInstance(first)).toEqual(on(shared.agent_instance!));

    // The instance created on the own hoster account wakes there, from its record.
    const orchestrator = await fleetShardOrchestratorService.persistentOrchestratorFor({
      fleetShardId: hoster.id,
    });
    expect(orchestrator).toBeTruthy();

    await reconcile();
    await statePass();
    expect(creates()).toHaveLength(createsBefore);
    expect(organization.accounts.size).toBe(accountsBefore);
    expect(await adminDb.fleetQuotaRequest.count()).toBe(requestsBefore);
    const rowsAfter = await ownRows(first.organizationId);
    expect(rowsAfter.map((r) => [r.id, r.role, r.state, r.ownerOrganizationId, r.liveAt])).toEqual(
      rowsBefore.map((r) => [r.id, r.role, r.state, r.ownerOrganizationId, r.liveAt]),
    );
    expect(rowsAfter.every((r) => r.state === 'active')).toBe(true);
  });

  it('no credential, environment value or member-account email appears in any row, audit entry, alert or output of the walk', async () => {
    const text = [
      printed.join('\n'),
      JSON.stringify(await adminDb.fleetShard.findMany()),
      JSON.stringify(await adminDb.fleetQuotaRequest.findMany()),
      JSON.stringify(await adminDb.fleetMachineKill.findMany()),
      JSON.stringify(await adminDb.platformAuditLog.findMany()),
      JSON.stringify(alerts),
    ].join('\n');
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    // Every member-account email an account was created with (six: two orgs).
    expect(organization.usedEmails.size).toBeGreaterThanOrEqual(6);
    for (const email of organization.usedEmails) expect(text).not.toContain(email);
  });
});
