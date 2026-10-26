import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwsSessionCredentials, Ec2Api, FleetWorkloadKind } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import { hostMonthlyPlanCredits } from '@/lib/billing/catalog';
import { capsForPlanKey, HOST_PLAN_KEY } from '@/lib/billing/planCaps';
import type { HostAccountRefusedError } from '@/lib/ciFleet/headroomErrors';
import { hostAccountPlan, type HostAccountSlot } from '@/lib/ciFleet/hostAccounts';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import { REFUSAL_BACKOFF_BASE_MS } from '@/lib/ciFleet/poolGrowthPolicy';
import { AWS_MEMBER_EMAIL_TEMPLATE_ENV } from '@/lib/fleetShards/awsMemberAccountPlan';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import type { FleetHeadroomAlert } from '@/lib/monitoring/fleetShardHeadroomAlert';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { fleetShardProvisioningService } from '@/lib/services/fleetShardProvisioningService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import {
  hostAccountReconcileService,
  type HostReconcileDeps,
} from '@/lib/services/hostAccountReconcileService';
import type { PlanCapsAnswer } from '@/lib/services/planCapsService';
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

// THE HOST ACCOUNT RECONCILE (Story MOTIR-9365 · MOTIR-9582), against a real
// database for the rows, attempts and audit entries, GitHub stubbed at `fetch`,
// the AWS management calls behind the in-memory organization and the network
// built by the REAL `ensureAwsShardNetwork` over the in-memory EC2 — the
// unattended add-shard's own fakes.

const ec2FakePath = '../../packages/orchestrator/test/contract/awsEc2Fake';
let AwsEc2Fake: new () => Ec2Api;

const GITHUB_ORG = 'motir-fleet-use1-1';
const TEMPLATE = 'aws+{name}@motir.co';
const SECRETS = {
  installation: 'ghs_INSTALL_SECRET_never_printed',
  managementKey: 'AKIA_MANAGEMENT_never_printed',
  managementSecret: 'MANAGEMENT_SECRET_never_printed',
  sessionKeyId: 'ASIA_SESSION_never_printed',
  sessionSecret: 'SESSION_SECRET_never_printed',
  sessionToken: 'SESSION_TOKEN_never_printed',
};
const SESSION: AwsSessionCredentials = {
  accessKeyId: SECRETS.sessionKeyId,
  secretAccessKey: SECRETS.sessionSecret,
  sessionToken: SECRETS.sessionToken,
  expiration: null,
};
const T0 = new Date('2026-10-25T12:00:00Z');
const HOST_CAPS = capsForPlanKey(HOST_PLAN_KEY)!;

let github: GithubWorld;
let organization: FakeOrganization;
let unregister: () => void;
let alerts: FleetHeadroomAlert[];
/** Each org's plan answer; an org not here reads as a non-Host paid plan. */
let plans: Map<string, PlanCapsAnswer>;

const host = (): PlanCapsAnswer => ({
  kind: 'capped',
  planKey: HOST_PLAN_KEY,
  planName: 'Host',
  caps: HOST_CAPS,
});
/** A plan answer naming `planKey` — what `capsFor` answers for any `pool_<N>k`. */
const onPlan = (planKey: string): PlanCapsAnswer => ({
  kind: 'capped',
  planKey,
  planName: planKey,
  caps: capsForPlanKey(planKey)!,
});

function deps(now: Date = T0): HostReconcileDeps {
  return {
    now: () => now,
    alert: (a) => alerts.push(a),
    capsFor: async (id) =>
      plans.get(id) ?? { kind: 'capped', planKey: 'max', planName: 'Max', caps: HOST_CAPS },
    provisioning: {
      raise: { management: () => organization, now: () => now },
      env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: TEMPLATE },
    },
  };
}

let orgSeq = 0;
async function seedOrg(data: { isMeta?: boolean; aiIncludedSeat?: boolean } = {}) {
  orgSeq += 1;
  return adminDb.organization.create({
    data: {
      name: `Org ${orgSeq}`,
      slug: `host-org-${orgSeq}-${Date.now()}`,
      aiIncludedSeat: data.aiIncludedSeat ?? true,
      isMeta: data.isMeta ?? false,
    },
  });
}

async function primary(name: string, fleetKind: string, accountId: string) {
  return fleetShardService.createShard({
    name,
    fleetKind,
    provider: 'aws',
    state: 'active',
    githubOrg: GITHUB_ORG,
    githubInstallationId: '9001',
    awsAccountId: accountId,
    awsRegion: 'us-east-1',
    credentialRef: `FLEET_SHARD_${name.toUpperCase().replace(/-/g, '_')}`,
    limits: { vcpuQuota: 640 },
  });
}

const ownedRows = (organizationId: string) =>
  adminDb.fleetShard.findMany({
    where: { ownerOrganizationId: organizationId },
    orderBy: { name: 'asc' },
  });
const ownedRequests = (organizationId: string) =>
  adminDb.fleetQuotaRequest.findMany({
    where: { shard: { ownerOrganizationId: organizationId } },
    include: { shard: { select: { fleetKind: true } } },
  });
const creates = () => organization.calls.filter((c) => c === 'createOrganizationAccount');
const emailOf = (organizationId: string, slot: HostAccountSlot) =>
  TEMPLATE.replace(
    '{name}',
    hostAccountPlan(organizationId, slot, hostMonthlyPlanCredits()).account.name,
  );

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ ec2FakePath)) as {
    AwsEc2Fake: new () => Ec2Api;
  });
});

beforeEach(async () => {
  await truncateAuthTables();
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4445390');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('GITHUB_ENTERPRISE_SLUG', SLUG);
  vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', SECRETS.managementKey);
  vi.stubEnv('AWS_ORG_ADMIN_SECRET_ACCESS_KEY', SECRETS.managementSecret);
  vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::576360162297:role/motir-add-shard');
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
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
  await createTestUser({ email: MOTIR_SYSTEM_USER_EMAIL });
  await primary('ci-runner-use1-1', 'ci_runner', '111122223331');
  await primary('hosted-agent-use1-1', 'hosted_agent', '111122223332');
  await primary('indexer-use1-1', 'code_graph_index', '111122223333');
  await primary('agent-host-use1-1', 'agent_instance', '111122223334');
  alerts = [];
  plans = new Map();
});

afterEach(() => {
  unregister();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('one pass over a Host organisation with no accounts', () => {
  it('creates three AWS accounts as four org_owned provisioning rows, the merged one twice', async () => {
    const org = await seedOrg();
    plans.set(org.id, host());

    const summary = await hostAccountReconcileService.runReconcile(deps());

    expect(summary.ran).toBe(true);
    expect(summary.organizations).toEqual([
      {
        organizationId: org.id,
        host: true,
        slots: { ci_runner: 'created', agent_runner: 'created', merged: 'created' },
      },
    ]);
    expect(creates()).toHaveLength(3);
    const rows = await ownedRows(org.id);
    expect(rows.map((r) => [r.fleetKind, r.role, r.state])).toEqual(
      expect.arrayContaining([
        ['ci_runner', 'org_owned', 'provisioning'],
        ['hosted_agent', 'org_owned', 'provisioning'],
        ['code_graph_index', 'org_owned', 'provisioning'],
        ['agent_instance', 'org_owned', 'provisioning'],
      ]),
    );
    expect(rows).toHaveLength(4);
    const index = rows.find((r) => r.fleetKind === 'code_graph_index')!;
    const hoster = rows.find((r) => r.fleetKind === 'agent_instance')!;
    expect(hoster.awsAccountId).toBe(index.awsAccountId);
    expect(hoster.credentialRef).toBe(index.credentialRef);
    expect(new Set(rows.map((r) => r.awsAccountId)).size).toBe(3);
  });

  it('files one L-1216C47A raise per AWS account — 200, 32 and 120, the merged one once', async () => {
    const org = await seedOrg();
    plans.set(org.id, host());

    await hostAccountReconcileService.runReconcile(deps());

    const requests = await ownedRequests(org.id);
    expect(requests.map((r) => [r.shard.fleetKind, r.desiredValue, r.quotaCode]).sort()).toEqual([
      ['ci_runner', 200, 'L-1216C47A'],
      ['code_graph_index', 120, 'L-1216C47A'],
      ['hosted_agent', 32, 'L-1216C47A'],
    ]);
    for (const r of requests) expect(r.awsRequestId).toMatch(/^quota-req-\d+$/);
    expect(organization.quotaRequests.size).toBe(3);
  });

  it('keeps every created row out of shared selection, the spares and pool growth', async () => {
    const org = await seedOrg();
    plans.set(org.id, host());
    await hostAccountReconcileService.runReconcile(deps());

    // Settle them as if granted and live: still never selected.
    await adminDb.fleetShard.updateMany({
      where: { ownerOrganizationId: org.id },
      data: { state: 'active' },
    });
    for (const kind of ['ci_runner', 'hosted_agent', 'code_graph_index', 'agent_instance']) {
      const selected = await withSystemContext((tx) =>
        fleetShardAdmissionService.selectionSetInTx(
          { fleetKind: kind as FleetWorkloadKind, organizationId: org.id },
          tx,
        ),
      );
      expect(selected.every((s) => s.role !== 'org_owned')).toBe(true);
      const spares = await withSystemContext((tx) =>
        fleetShardRepository.listSparesForKind(kind as FleetWorkloadKind, tx),
      );
      expect(spares).toEqual([]);
    }
  });
});

describe('the runner role of an own account (MOTIR-9584)', () => {
  it('may terminate an untagged instance, so the attribution pass can reap every machine there', async () => {
    const org = await seedOrg();
    plans.set(org.id, host());

    await hostAccountReconcileService.runReconcile(deps());

    // One role per AWS account: the merged account's two rows share one.
    expect(organization.runnerRoles.size).toBe(3);
    for (const policy of organization.runnerRoles.values()) {
      expect(policy).toContain('TerminateAnyInAccount');
    }
  });
});

describe('a replayed pass', () => {
  it('again, and after a replayed paid invoice, creates nothing more', async () => {
    const org = await seedOrg();
    plans.set(org.id, host());
    await hostAccountReconcileService.runReconcile(deps());

    const again = await hostAccountReconcileService.runReconcile(deps());
    // A replayed invoice changes nothing a reconcile reads: the same plan, again.
    await adminDb.organization.update({ where: { id: org.id }, data: { aiIncludedSeat: true } });
    await hostAccountReconcileService.runReconcile(deps());

    expect(again.organizations[0]!.slots).toEqual({
      ci_runner: 'already',
      agent_runner: 'already',
      merged: 'already',
    });
    expect(creates()).toHaveLength(3);
    expect(organization.accounts.size).toBe(3);
    expect(await ownedRows(org.id)).toHaveLength(4);
    expect(await ownedRequests(org.id)).toHaveLength(3);
  });
});

describe('a pass interrupted part way', () => {
  it('after CreateAccount and before the row: the next pass finds the account and writes the row', async () => {
    const org = await seedOrg();
    plans.set(org.id, host());
    const create = fleetShardService.createShard.bind(fleetShardService);
    vi.spyOn(fleetShardService, 'createShard').mockImplementationOnce(async () => {
      throw new Error('interrupted');
    });
    // The spy's later calls go to the real method.
    vi.mocked(fleetShardService.createShard).mockImplementation(create);

    const first = await hostAccountReconcileService.reconcileOrganization(org.id, deps());
    expect(first.slots.ci_runner).toBe('failed');
    expect(organization.accounts.size).toBe(3);

    const second = await hostAccountReconcileService.reconcileOrganization(org.id, deps());

    expect(second.slots.ci_runner).toBe('created');
    expect(creates()).toHaveLength(3);
    expect(await ownedRows(org.id)).toHaveLength(4);
    expect(await ownedRequests(org.id)).toHaveLength(3);
  });

  it('after the merged first row: the next pass writes the second row only', async () => {
    const org = await seedOrg();
    plans.set(org.id, host());
    const create = fleetShardService.createShard.bind(fleetShardService);
    let interrupted = false;
    vi.spyOn(fleetShardService, 'createShard').mockImplementation(async (input) => {
      if (input.fleetKind === 'agent_instance' && !interrupted) {
        interrupted = true;
        throw new Error('interrupted');
      }
      return create(input);
    });

    const first = await hostAccountReconcileService.reconcileOrganization(org.id, deps());
    expect(first.slots.merged).toBe('failed');
    expect(await ownedRows(org.id)).toHaveLength(3);

    const second = await hostAccountReconcileService.reconcileOrganization(org.id, deps());

    expect(second.slots.merged).toBe('created');
    expect(creates()).toHaveLength(3);
    expect(await ownedRows(org.id)).toHaveLength(4);
    expect(await ownedRequests(org.id)).toHaveLength(3);
  });

  it('a raise that fails to file leaves the account and row, and the next pass files it', async () => {
    const org = await seedOrg();
    plans.set(org.id, host());
    organization.requestFailure = new Error('ThrottlingException');

    const first = await hostAccountReconcileService.reconcileOrganization(org.id, deps());

    expect(first.slots.ci_runner).toBe('raise_failed');
    expect(await ownedRows(org.id)).toHaveLength(4);
    expect(await ownedRequests(org.id)).toHaveLength(2);

    const second = await hostAccountReconcileService.reconcileOrganization(org.id, deps());

    expect(second.slots).toEqual({
      ci_runner: 'created',
      agent_runner: 'already',
      merged: 'already',
    });
    expect(creates()).toHaveLength(3);
    expect(await ownedRows(org.id)).toHaveLength(4);
    expect(await ownedRequests(org.id)).toHaveLength(3);
  });
});

describe('which organisations get accounts', () => {
  it('a non-Host plan, an unreadable plan and a Motir exempt org get none', async () => {
    const max = await seedOrg();
    const unknown = await seedOrg();
    plans.set(unknown.id, { kind: 'plan_unknown', planKey: null });
    const exempt = await seedOrg();
    plans.set(exempt.id, { kind: 'exempt' });
    const meta = await seedOrg({ isMeta: true });
    plans.set(meta.id, host());

    const summary = await hostAccountReconcileService.runReconcile(deps());

    expect(summary.organizations).toEqual([]);
    expect(creates()).toHaveLength(0);
    for (const org of [max, unknown, exempt, meta]) {
      expect(await ownedRows(org.id)).toEqual([]);
    }
    // And the real plan read: Motir's own organisation is exempt, never Host.
    const real = await hostAccountReconcileService.reconcileOrganization(meta.id, {
      ...deps(),
      capsFor: undefined,
    });
    expect(real.host).toBe(false);
  });

  it('an org that leaves Host keeps its rows untouched and gets no new account', async () => {
    const org = await seedOrg();
    plans.set(org.id, host());
    await hostAccountReconcileService.runReconcile(deps());
    const before = await ownedRows(org.id);
    await adminDb.fleetShard.deleteMany({
      where: { ownerOrganizationId: org.id, fleetKind: 'agent_instance' },
    });

    plans.delete(org.id);
    const summary = await hostAccountReconcileService.runReconcile(deps());

    expect(summary.organizations).toEqual([]);
    expect(creates()).toHaveLength(3);
    const after = await ownedRows(org.id);
    expect(after).toEqual(before.filter((r) => r.fleetKind !== 'agent_instance'));
  });

  it('an org that leaves Host and buys it again reuses its accounts and creates none (MOTIR-9590)', async () => {
    const org = await seedOrg();
    plans.set(org.id, host());
    await hostAccountReconcileService.runReconcile(deps());
    const before = await ownedRows(org.id);
    const requests = await ownedRequests(org.id);

    plans.delete(org.id);
    await hostAccountReconcileService.runReconcile(deps());
    expect(await ownedRows(org.id)).toEqual(before);
    expect(await ownedRequests(org.id)).toEqual(requests);

    plans.set(org.id, host());
    const back = await hostAccountReconcileService.runReconcile(deps());
    expect(back.organizations[0]!.slots).toEqual({
      ci_runner: 'already',
      agent_runner: 'already',
      merged: 'already',
    });
    expect(creates()).toHaveLength(3);
    expect(organization.accounts.size).toBe(3);
    expect((await ownedRows(org.id)).map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(await ownedRequests(org.id)).toHaveLength(3);
  });
});

describe('a refused CreateAccount', () => {
  it('writes no row, records and alerts once, runs the rest, and backs the slot off', async () => {
    const refused = await seedOrg();
    const other = await seedOrg();
    plans.set(refused.id, host());
    plans.set(other.id, host());
    organization.usedEmails.add(emailOf(refused.id, 'ci_runner'));

    const first = await hostAccountReconcileService.runReconcile(deps(T0));

    expect(first.organizations.find((o) => o.organizationId === refused.id)!.slots).toEqual({
      ci_runner: 'refused',
      agent_runner: 'created',
      merged: 'created',
    });
    expect(first.organizations.find((o) => o.organizationId === other.id)!.slots).toEqual({
      ci_runner: 'created',
      agent_runner: 'created',
      merged: 'created',
    });
    const rows = await ownedRows(refused.id);
    expect(rows.map((r) => r.fleetKind)).not.toContain('ci_runner');
    const attempt = await adminDb.hostAccountAttempt.findUniqueOrThrow({
      where: { organizationId_slot: { organizationId: refused.id, slot: 'ci_runner' } },
    });
    expect(attempt.refusedCount).toBe(1);
    expect(attempt.lastRefusedAt).toEqual(T0);
    expect(alerts).toHaveLength(1);
    const alert = alerts[0] as HostAccountRefusedError;
    expect(alert.name).toBe('HostAccountRefusedError');
    expect(alert).toMatchObject({
      organizationId: refused.id,
      slot: 'ci_runner',
      reason: 'EMAIL_ALREADY_EXISTS',
    });

    // Inside the 30-minute backoff: the slot is not tried.
    const callsBefore = creates().length;
    const inside = await hostAccountReconcileService.reconcileOrganization(
      refused.id,
      deps(new Date(T0.getTime() + REFUSAL_BACKOFF_BASE_MS - 60_000)),
    );
    expect(inside.slots.ci_runner).toBe('backing_off');
    expect(creates()).toHaveLength(callsBefore);
    expect(alerts).toHaveLength(1);

    // Past it, the next pass retries and succeeds — and the count is cleared.
    organization.usedEmails.delete(emailOf(refused.id, 'ci_runner'));
    const after = await hostAccountReconcileService.reconcileOrganization(
      refused.id,
      deps(new Date(T0.getTime() + REFUSAL_BACKOFF_BASE_MS)),
    );
    expect(after.slots.ci_runner).toBe('created');
    expect(await ownedRows(refused.id)).toHaveLength(4);
    const cleared = await adminDb.hostAccountAttempt.findUniqueOrThrow({
      where: { organizationId_slot: { organizationId: refused.id, slot: 'ci_runner' } },
    });
    expect(cleared.refusedCount).toBe(0);
  });
});

describe('a slot whose kind has no primary account', () => {
  it('is skipped silently, then created once the kind has one', async () => {
    const org = await seedOrg();
    plans.set(org.id, host());
    await adminDb.fleetShard.update({
      where: { name: 'hosted-agent-use1-1' },
      data: { state: 'disabled' },
    });

    const first = await hostAccountReconcileService.reconcileOrganization(org.id, deps());

    expect(first.slots.agent_runner).toBe('no_primary');
    expect(alerts).toEqual([]);
    expect(await adminDb.hostAccountAttempt.count()).toBe(0);
    expect((await ownedRows(org.id)).map((r) => r.fleetKind)).not.toContain('hosted_agent');

    await adminDb.fleetShard.update({
      where: { name: 'hosted-agent-use1-1' },
      data: { state: 'active' },
    });
    const second = await hostAccountReconcileService.reconcileOrganization(org.id, deps());
    expect(second.slots.agent_runner).toBe('created');
  });
});

describe('the addOrgOwnedShard door', () => {
  it('refuses a kind with no primary account before any AWS call', async () => {
    const org = await seedOrg();
    await adminDb.fleetShard.update({
      where: { name: 'ci-runner-use1-1' },
      data: { state: 'disabled' },
    });
    await expect(
      fleetShardProvisioningService.addOrgOwnedShard(
        { organizationId: org.id, slot: 'ci_runner', planKey: HOST_PLAN_KEY },
        deps().provisioning,
      ),
    ).rejects.toThrow(/no primary account/);
    expect(organization.calls).toEqual([]);
  });

  it.each(['max', 'pool_250k', 'free', 'enterprise'])(
    'refuses a plan that carries no own accounts (%s) before any AWS or GitHub call',
    async (planKey) => {
      const org = await seedOrg();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(
        fleetShardProvisioningService.addOrgOwnedShard(
          { organizationId: org.id, slot: 'ci_runner', planKey },
          deps().provisioning,
        ),
      ).rejects.toBeInstanceOf(FleetShardProvisioningRefusedError);
      expect(organization.calls).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await ownedRows(org.id)).toEqual([]);
    },
  );
});

describe('no credential, secret or member email', () => {
  it('appears in a row, audit entry, alert or summary', async () => {
    const org = await seedOrg();
    plans.set(org.id, host());
    organization.usedEmails.add(emailOf(org.id, 'merged'));

    const summary = await hostAccountReconcileService.runReconcile(deps());

    const rows = await ownedRows(org.id);
    const audits = await adminDb.platformAuditLog.findMany({
      where: { targetId: { in: rows.map((r) => r.id) } },
    });
    expect(audits.length).toBeGreaterThan(0);
    const printed = JSON.stringify([
      summary,
      rows,
      audits,
      await adminDb.hostAccountAttempt.findMany(),
      alerts.map((a) => ({ ...a, message: a.message })),
    ]);
    for (const secret of Object.values(SECRETS)) expect(printed).not.toContain(secret);
    expect(printed).not.toContain('@motir.co');
  });
});

describe('a larger pool on sale carries the same three accounts, sized to its pool (MOTIR-9651)', () => {
  const raises = async (organizationId: string) =>
    (await ownedRequests(organizationId))
      .map((r) => [r.shard.fleetKind, r.desiredValue, r.quotaCode])
      .sort();

  it.each([
    ['pool_600k', 400, 64, 120],
    ['pool_2400k', 1_600, 256, 120],
  ] as const)(
    '%s: three accounts, four rows, raises %i / %i / %i',
    async (planKey, ci, agent, merged) => {
      const org = await seedOrg();
      plans.set(org.id, onPlan(planKey));

      const summary = await hostAccountReconcileService.runReconcile(deps());

      expect(summary.organizations).toEqual([
        {
          organizationId: org.id,
          host: true,
          slots: { ci_runner: 'created', agent_runner: 'created', merged: 'created' },
        },
      ]);
      expect(creates()).toHaveLength(3);
      const rows = await ownedRows(org.id);
      expect(rows).toHaveLength(4);
      for (const r of rows)
        expect([r.role, r.state, r.ownerOrganizationId]).toEqual([
          'org_owned',
          'provisioning',
          org.id,
        ]);
      const index = rows.find((r) => r.fleetKind === 'code_graph_index')!;
      expect(rows.find((r) => r.fleetKind === 'agent_instance')!.awsAccountId).toBe(
        index.awsAccountId,
      );
      expect(await raises(org.id)).toEqual([
        ['ci_runner', ci, 'L-1216C47A'],
        ['code_graph_index', merged, 'L-1216C47A'],
        ['hosted_agent', agent, 'L-1216C47A'],
      ]);

      // Again, and after a replayed paid invoice: nothing more.
      await hostAccountReconcileService.runReconcile(deps());
      await adminDb.organization.update({ where: { id: org.id }, data: { aiIncludedSeat: true } });
      await hostAccountReconcileService.runReconcile(deps());
      expect(creates()).toHaveLength(3);
      expect(await ownedRows(org.id)).toHaveLength(4);
      expect(await ownedRequests(org.id)).toHaveLength(3);
    },
  );

  it('a retired rung gets no account, row, raise, refusal or alert, and is not in the summary', async () => {
    const org = await seedOrg();
    plans.set(org.id, onPlan('pool_250k'));

    const outcome = await hostAccountReconcileService.reconcileOrganization(org.id, deps());
    const summary = await hostAccountReconcileService.runReconcile(deps());

    expect(outcome).toEqual({ organizationId: org.id, host: false, slots: {} });
    expect(summary.organizations).toEqual([]);
    expect(creates()).toHaveLength(0);
    expect(await ownedRows(org.id)).toEqual([]);
    expect(await ownedRequests(org.id)).toEqual([]);
    expect(await adminDb.hostAccountAttempt.count()).toBe(0);
    expect(alerts).toEqual([]);
  });

  it('an upgrade from Host keeps the accounts, waits on the open 200, then files 400 once', async () => {
    const org = await seedOrg();
    plans.set(org.id, host());
    await hostAccountReconcileService.runReconcile(deps());
    const before = await ownedRows(org.id);
    expect(before).toHaveLength(4);

    plans.set(org.id, onPlan('pool_600k'));
    const waiting = await hostAccountReconcileService.reconcileOrganization(org.id, deps());

    expect(waiting.slots.ci_runner).toBe('raise_failed');
    expect(creates()).toHaveLength(3);
    expect((await ownedRows(org.id)).map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(await adminDb.hostAccountAttempt.count()).toBe(0);
    expect(alerts).toEqual([]);

    // AWS answers the 200 request; it closes.
    const ci = before.find((r) => r.fleetKind === 'ci_runner')!;
    const open = await adminDb.fleetQuotaRequest.findFirstOrThrow({
      where: { shardId: ci.id, closedAt: null },
    });
    expect(open.desiredValue).toBe(200);
    organization.settleQuotaRequest(open.awsRequestId!, 'APPROVED');
    await adminDb.fleetQuotaRequest.update({
      where: { id: open.id },
      data: { status: 'approved', grantedValue: 200, closedAt: T0 },
    });

    const filed = await hostAccountReconcileService.reconcileOrganization(org.id, deps());
    await hostAccountReconcileService.reconcileOrganization(org.id, deps());

    expect(filed.slots.ci_runner).toBe('created');
    const ciRequests = await adminDb.fleetQuotaRequest.findMany({
      where: { shardId: ci.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(ciRequests.map((r) => r.desiredValue)).toEqual([200, 400]);
    expect(creates()).toHaveLength(3);
    expect((await ownedRows(org.id)).map((r) => r.id)).toEqual(before.map((r) => r.id));
  });

  it('a downgrade from a rung to Host, granted at the rung’s targets, creates and files nothing', async () => {
    const org = await seedOrg();
    plans.set(org.id, onPlan('pool_600k'));
    await hostAccountReconcileService.runReconcile(deps());
    const rows = await ownedRows(org.id);
    for (const request of await ownedRequests(org.id)) {
      organization.settleQuotaRequest(request.awsRequestId!, 'APPROVED');
      await adminDb.fleetQuotaRequest.update({
        where: { id: request.id },
        data: { status: 'approved', grantedValue: request.desiredValue, closedAt: T0 },
      });
      await adminDb.fleetShard.updateMany({
        where: { awsAccountId: rows.find((r) => r.id === request.shardId)!.awsAccountId },
        data: { vcpuQuota: request.desiredValue },
      });
    }

    plans.set(org.id, host());
    const after = await hostAccountReconcileService.reconcileOrganization(org.id, deps());

    expect(after.slots).toEqual({
      ci_runner: 'already',
      agent_runner: 'already',
      merged: 'already',
    });
    expect(creates()).toHaveLength(3);
    expect(await ownedRequests(org.id)).toHaveLength(3);
  });
});
