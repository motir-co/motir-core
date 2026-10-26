import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwsSessionCredentials, Ec2Api, FleetWorkloadKind } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import { capsForPlanKey, HOST_PLAN_KEY } from '@/lib/billing/planCaps';
import { hostAccountPlan } from '@/lib/ciFleet/hostAccounts';
import { deriveAccountState, LIVE_MIN_VCPU } from '@/lib/ciFleet/hostAccountState';
import { AWS_MEMBER_EMAIL_TEMPLATE_ENV } from '@/lib/fleetShards/awsMemberAccountPlan';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { fleetQuotaRaiseService } from '@/lib/services/fleetQuotaRaiseService';
import { fleetQuotaRequestService } from '@/lib/services/fleetQuotaRequestService';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import {
  hostAccountReconcileService,
  type HostReconcileDeps,
} from '@/lib/services/hostAccountReconcileService';
import { hostAccountStateService } from '@/lib/services/hostAccountStateService';
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

// THE HOST ACCOUNT STATE PASS (Story MOTIR-9365 · MOTIR-9585), against a real
// database. The accounts are created by the REAL reconcile over the add-shard's
// own fakes (the in-memory AWS organization, GitHub stubbed at `fetch`, the REAL
// `ensureAwsShardNetwork` over the in-memory EC2), the raises are moved on in the
// fake AWS and read by the REAL quota tracker, and the pass runs the registered
// provider's own network step.

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
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const HOST_CAPS = capsForPlanKey(HOST_PLAN_KEY)!;

let github: GithubWorld;
let organization: FakeOrganization;
let unregister: () => void;

function reconcileDeps(): HostReconcileDeps {
  return {
    now: () => T0,
    alert: () => undefined,
    capsFor: async (): Promise<PlanCapsAnswer> => ({
      kind: 'capped',
      planKey: HOST_PLAN_KEY,
      planName: 'Host',
      caps: HOST_CAPS,
    }),
    provisioning: {
      raise: { management: () => organization, now: () => T0 },
      env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: TEMPLATE },
    },
  };
}

let orgSeq = 0;
async function seedOrg() {
  orgSeq += 1;
  return adminDb.organization.create({
    data: {
      name: `State Org ${orgSeq}`,
      slug: `host-state-org-${orgSeq}-${Date.now()}`,
      aiIncludedSeat: true,
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

/** A Host org with its three accounts created and their raises filed. */
async function hostOrg() {
  const org = await seedOrg();
  await hostAccountReconcileService.reconcileOrganization(org.id, reconcileDeps());
  return org;
}

const rowOf = (
  organizationId: string,
  slot: 'ci_runner' | 'agent_runner' | 'merged',
  shared = false,
) => {
  const plan = hostAccountPlan(organizationId, slot);
  const name = shared ? plan.sharedRow!.name : plan.account.name;
  return adminDb.fleetShard.findUniqueOrThrow({ where: { name } });
};

/** The fake AWS request id filed for one slot's account. */
async function awsRequestOf(organizationId: string, slot: 'ci_runner' | 'agent_runner' | 'merged') {
  const row = await rowOf(organizationId, slot);
  const request = await adminDb.fleetQuotaRequest.findFirstOrThrow({ where: { shardId: row.id } });
  return request.awsRequestId;
}

/** The quota tracker's own read of every open request, as the growth pass runs it. */
const track = (now: Date) =>
  fleetQuotaRaiseService.refreshOpenRequests(undefined, {
    management: () => organization,
    now: () => now,
  });

const pass = (now: Date) => hostAccountStateService.runStatePass({ now: () => now });

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
  organization.quota = 5;
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
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

describe('deriveAccountState (MOTIR-9585)', () => {
  it.each([
    [{ hasRequest: false, grantedVcpu: null, networkBuilt: false }, 'created'],
    [{ hasRequest: false, grantedVcpu: null, networkBuilt: true }, 'created'],
    [{ hasRequest: true, grantedVcpu: null, networkBuilt: true }, 'quota_requested'],
    [{ hasRequest: true, grantedVcpu: 1, networkBuilt: true }, 'granted'],
    [{ hasRequest: true, grantedVcpu: 32, networkBuilt: false }, 'granted'],
    [{ hasRequest: true, grantedVcpu: LIVE_MIN_VCPU, networkBuilt: true }, 'live'],
    [{ hasRequest: true, grantedVcpu: 200, networkBuilt: true }, 'live'],
  ] as const)('%o is %s', (facts, state) => {
    expect(deriveAccountState(facts)).toBe(state);
  });

  it('one job is the 2 vCPU fleet machine', () => {
    expect(LIVE_MIN_VCPU).toBe(2);
  });
});

describe('one pass over a fresh Host organisation', () => {
  it('stores quota requested on every row — both of the merged account — and settles them active', async () => {
    const org = await hostOrg();

    const summary = await pass(at(1));

    expect(summary).toEqual({ ran: true, states: { quota_requested: 3 }, settled: 4, failures: 0 });
    const rows = await adminDb.fleetShard.findMany({ where: { ownerOrganizationId: org.id } });
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toMatchObject({
        state: 'active',
        quotaRequestedAt: at(1),
        grantedAt: null,
        liveAt: null,
      });
    }
    const dto = await fleetShardService.getShard(rows[0]!.id);
    expect(dto.accountState).toBe('quota_requested');
  });

  it('keeps a settled own account out of every shared selection set and the growth pass', async () => {
    const org = await hostOrg();
    await pass(at(1));

    for (const kind of ['ci_runner', 'hosted_agent', 'code_graph_index', 'agent_instance']) {
      const selected = await withSystemContext((tx) =>
        fleetShardAdmissionService.selectionSetInTx(
          { fleetKind: kind as FleetWorkloadKind, organizationId: org.id },
          tx,
        ),
      );
      expect(selected.every((s) => s.role !== 'org_owned')).toBe(true);
      const primaries = await fleetShardService.listShards({ fleetKind: kind });
      expect(primaries.every((s) => s.ownerOrganizationId === null)).toBe(true);
      const spares = await withSystemContext((tx) =>
        fleetShardRepository.listSparesForKind(kind as FleetWorkloadKind, tx),
      );
      expect(spares).toEqual([]);
    }
  });
});

describe('a grant read by the quota tracker', () => {
  it('moves the agent-runner account to live at 32, and the merged account at 40 for both rows', async () => {
    const org = await hostOrg();
    await pass(at(1));
    organization.settleQuotaRequest(await awsRequestOf(org.id, 'agent_runner'), 'APPROVED', 32);
    organization.settleQuotaRequest(await awsRequestOf(org.id, 'merged'), 'APPROVED', 40);

    await track(at(2));
    const summary = await pass(at(3));

    expect(summary.states).toEqual({ quota_requested: 1, live: 2 });
    expect(await rowOf(org.id, 'agent_runner')).toMatchObject({ grantedAt: at(3), liveAt: at(3) });
    const index = await rowOf(org.id, 'merged');
    const host = await rowOf(org.id, 'merged', true);
    for (const row of [index, host]) {
      expect(row).toMatchObject({ quotaRequestedAt: at(1), grantedAt: at(3), liveAt: at(3) });
    }
    // The raise was recorded against the indexer row only.
    expect(await adminDb.fleetQuotaRequest.count({ where: { shardId: host.id } })).toBe(0);
    expect((await fleetShardService.getShard(host.id)).accountState).toBe('live');
    expect(await rowOf(org.id, 'ci_runner')).toMatchObject({ grantedAt: null, liveAt: null });
  });

  it('a denied raise stays at quota requested, and a later grant moves it on', async () => {
    const org = await hostOrg();
    await pass(at(1));
    organization.settleQuotaRequest(await awsRequestOf(org.id, 'ci_runner'), 'DENIED');
    await track(at(2));
    await pass(at(3));

    expect(await rowOf(org.id, 'ci_runner')).toMatchObject({
      quotaRequestedAt: at(1),
      grantedAt: null,
      liveAt: null,
    });

    // A later raise, filed and granted.
    const ci = await rowOf(org.id, 'ci_runner');
    const later = await fleetQuotaRequestService.createRequest({
      shardId: ci.id,
      desiredValue: 200,
      awsRequestId: 'quota-req-later',
    });
    await fleetQuotaRequestService.recordRead(later.id, { status: 'approved', grantedValue: 200 });
    await pass(at(4));

    expect(await rowOf(org.id, 'ci_runner')).toMatchObject({
      quotaRequestedAt: at(1),
      grantedAt: at(4),
      liveAt: at(4),
    });
  });
});

describe('the times', () => {
  it('are written once: a later pass, a replay and a raced pass move none of them', async () => {
    const org = await hostOrg();
    await pass(at(1));
    organization.settleQuotaRequest(await awsRequestOf(org.id, 'merged'), 'APPROVED', 120);
    await track(at(2));
    await pass(at(3));
    const before = await adminDb.fleetShard.findMany({
      where: { ownerOrganizationId: org.id },
      orderBy: { name: 'asc' },
    });

    await pass(at(10));
    const merged = await rowOf(org.id, 'merged');
    await Promise.all([
      hostAccountStateService.settleAccount(merged.awsAccountId!, { now: () => at(11) }),
      hostAccountStateService.settleAccount(merged.awsAccountId!, { now: () => at(12) }),
    ]);

    const after = await adminDb.fleetShard.findMany({
      where: { ownerOrganizationId: org.id },
      orderBy: { name: 'asc' },
    });
    const times = (rows: typeof before) =>
      rows.map((r) => [r.name, r.quotaRequestedAt, r.grantedAt, r.liveAt]);
    expect(times(after)).toEqual(times(before));
  });

  it('a second row written later takes the account time its sibling already holds', async () => {
    const org = await hostOrg();
    await pass(at(1));
    const host = await rowOf(org.id, 'merged', true);
    // As if the shared row had been written after the first pass.
    await adminDb.fleetShard.update({ where: { id: host.id }, data: { quotaRequestedAt: null } });

    await pass(at(5));

    expect(await rowOf(org.id, 'merged', true)).toMatchObject({ quotaRequestedAt: at(1) });
  });
});

describe('the shared floor', () => {
  it('holds for an org with no row, for an account not yet live, and turns off with the live kind', async () => {
    const bare = await seedOrg();
    expect(await hostAccountStateService.isOnSharedFloor(bare.id, 'ci_runner')).toBe(true);

    const org = await hostOrg();
    await pass(at(1));
    expect(await hostAccountStateService.sharedFloorKinds(org.id)).toEqual(
      expect.arrayContaining(['ci_runner', 'hosted_agent', 'code_graph_index', 'agent_instance']),
    );

    organization.settleQuotaRequest(await awsRequestOf(org.id, 'merged'), 'APPROVED', 40);
    await track(at(2));
    await pass(at(3));

    expect(await hostAccountStateService.isOnSharedFloor(org.id, 'code_graph_index')).toBe(false);
    expect(await hostAccountStateService.isOnSharedFloor(org.id, 'agent_instance')).toBe(false);
    expect(await hostAccountStateService.isOnSharedFloor(org.id, 'ci_runner')).toBe(true);
    expect(await hostAccountStateService.isOnSharedFloor(org.id, 'hosted_agent')).toBe(true);
  });
});

describe('a failing account', () => {
  it('is logged and counted, and the pass still reaches every other account', async () => {
    const org = await hostOrg();
    const ci = await rowOf(org.id, 'ci_runner');

    const summary = await hostAccountStateService.runStatePass({
      now: () => at(1),
      network: async (account) => {
        if (account.id === ci.id) throw new Error(`network down ${SECRETS.sessionSecret}`);
      },
    });

    expect(summary).toMatchObject({ ran: true, failures: 1, settled: 3 });
    expect(await rowOf(org.id, 'ci_runner')).toMatchObject({
      state: 'provisioning',
      quotaRequestedAt: at(1),
    });
    expect(await rowOf(org.id, 'agent_runner')).toMatchObject({ state: 'active' });
    // Names only: the summary and the log line never carry a secret or an email.
    const written = JSON.stringify({
      summary,
      logs: vi.mocked(console.error).mock.calls,
      rows: await adminDb.fleetShard.findMany({ where: { ownerOrganizationId: org.id } }),
    });
    for (const secret of Object.values(SECRETS)) expect(written).not.toContain(secret);
    expect(written).not.toContain('@motir.co');
  });

  it('a second run while one holds the pass does nothing', async () => {
    await hostOrg();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = hostAccountStateService.runStatePass({
      now: () => at(1),
      network: () => held,
    });
    // Let the first pass take its lease.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await pass(at(1))).toMatchObject({ ran: false });
    release();
    expect(await first).toMatchObject({ ran: true });
  });
});
