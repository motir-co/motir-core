import { AwsManagementApiError, type FleetWorkloadKind } from '@motir/orchestrator';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { LiveQuotaReadFailedError } from '@/lib/ciFleet/errors';
import {
  fleetShardQuotaService,
  type FleetShardQuotaDeps,
  type LiveQuotaReading,
} from '@/lib/services/fleetShardQuotaService';
import { fleetShardService, type CreateFleetShardInput } from '@/lib/services/fleetShardService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { FakeOrganization } from '../helpers/addShardFakes';

// THE LIVE GRANTED vCPU QUOTA (Story MOTIR-9362 · MOTIR-9458), against real
// Postgres and a fake AWS organization: every shared active AWS account — and
// every AWS spare not disabled (MOTIR-11233) — of a kind on its pool is read each
// pass, written only when AWS's answer changed,
// and an unreadable account is a typed failure that touches nothing.

const SESSION = {
  accessKeyId: 'ASIAFAKEMEMBER',
  secretAccessKey: 'member-secret-do-not-print',
  sessionToken: 'member-session-token-do-not-print',
  expiration: null,
};
const AT = new Date('2026-10-24T12:00:00.000Z');

let org: FakeOrganization;
let onPool: Set<FleetWorkloadKind>;

function deps(overrides: Partial<FleetShardQuotaDeps> = {}): FleetShardQuotaDeps {
  return {
    management: () => org,
    onPool: async (kind) => onPool.has(kind),
    now: () => AT,
    ...overrides,
  };
}

let seq = 0;
function awsAccount(overrides: Partial<CreateFleetShardInput> = {}) {
  seq += 1;
  return fleetShardService.createShard({
    name: `quota-test-${seq}`,
    fleetKind: 'ci_runner',
    provider: 'aws',
    state: 'active',
    githubOrg: `motir-quota-${seq}`,
    githubInstallationId: `${7000 + seq}`,
    awsAccountId: `22223333${String(seq).padStart(4, '0')}`,
    awsRegion: 'us-east-1',
    credentialRef: 'FLEET_AWS_TEST',
    limits: { vcpuQuota: 64, githubRegistrationsPer5Min: 1500 },
    limitsSource: { vcpuQuota: 'provider_read', githubRegistrationsPer5Min: 'documented' },
    ...overrides,
  });
}

const okOf = (r: LiveQuotaReading) => ('failure' in r ? null : r);

// ⚠️ TRUNCATE, NOT `deleteMany` (MOTIR-10733's CI). A suite that ran earlier on this worker's
// database can leave `agent_instance` rows naming a fleet shard, and that foreign key is
// RESTRICT, so a plain delete of every shard is refused and the whole file fails in its hook.
// `truncateAuthTables` truncates `fleet_shard` with CASCADE, as every suite's reset does.
beforeEach(async () => {
  await truncateAuthTables(adminDb);
  org = new FakeOrganization(SESSION);
  onPool = new Set(['ci_runner']);
});

afterAll(async () => {
  await truncateAuthTables(adminDb);
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('refreshLiveGrantedQuotas', () => {
  it('reads each shared active AWS account and writes only the one AWS changed', async () => {
    const same = await awsAccount();
    const raised = await awsAccount();
    org.quotaByAccount.set(same.aws!.accountId, 64);
    org.quotaByAccount.set(raised.aws!.accountId, 200);
    const before = await adminDb.fleetShard.findUniqueOrThrow({ where: { id: same.id } });

    const readings = await fleetShardQuotaService.refreshLiveGrantedQuotas(undefined, deps());

    expect(readings.map(okOf)).toEqual(
      expect.arrayContaining([
        { shardId: same.id, fleetKind: 'ci_runner', granted: 64, changed: false },
        { shardId: raised.id, fleetKind: 'ci_runner', granted: 200, changed: true },
      ]),
    );
    expect(readings).toHaveLength(2);

    const sameAfter = await adminDb.fleetShard.findUniqueOrThrow({ where: { id: same.id } });
    expect(sameAfter.updatedAt).toEqual(before.updatedAt);

    const raisedAfter = await fleetShardService.getShard(raised.id);
    expect(raisedAfter.limits).toMatchObject({ vcpuQuota: 200, githubRegistrationsPer5Min: 1500 });
    expect(raisedAfter.limitsSource).toEqual({
      vcpuQuota: 'provider_read',
      githubRegistrationsPer5Min: 'documented',
    });
    expect(raisedAfter.limitsVerifiedAt).toBe(AT.toISOString());
  });

  it('takes AWS’s answer, never the stored value, as the live one', async () => {
    const shard = await awsAccount({ limits: { vcpuQuota: 500 } });
    org.quota = 5; // AWS's default for an account with no applied quota.

    const [reading] = await fleetShardQuotaService.refreshLiveGrantedQuotas('ci_runner', deps());

    expect(okOf(reading!)).toMatchObject({ granted: 5, changed: true });
    expect((await fleetShardService.getShard(shard.id)).limits.vcpuQuota).toBe(5);
  });

  it('a failed read is a typed failure, leaves the row, and the others are still read', async () => {
    const broken = await awsAccount();
    const fine = await awsAccount();
    org.readFailures.set(
      broken.aws!.accountId,
      new AwsManagementApiError('service-quotas', 'AccessDeniedException', 403),
    );
    org.quotaByAccount.set(fine.aws!.accountId, 128);

    const readings = await fleetShardQuotaService.refreshLiveGrantedQuotas('ci_runner', deps());

    const failed = readings.find((r) => r.shardId === broken.id)!;
    expect('failure' in failed && failed.failure).toBeInstanceOf(LiveQuotaReadFailedError);
    expect('failure' in failed && failed.failure).toMatchObject({
      shardId: broken.id,
      shardName: broken.name,
      reason: 'AccessDeniedException',
    });
    expect((await fleetShardService.getShard(broken.id)).limits.vcpuQuota).toBe(64);
    expect(okOf(readings.find((r) => r.shardId === fine.id)!)).toMatchObject({
      granted: 128,
      changed: true,
    });
  });

  it('an unreachable management credential fails every account, writing nothing', async () => {
    const shard = await awsAccount();
    const readings = await fleetShardQuotaService.refreshLiveGrantedQuotas(
      'ci_runner',
      deps({
        management: () => {
          throw new AwsManagementApiError('sts', 'ExpiredToken', 403);
        },
      }),
    );
    expect(readings).toHaveLength(1);
    expect('failure' in readings[0]! && readings[0].failure.reason).toBe('ExpiredToken');
    expect((await fleetShardService.getShard(shard.id)).limits.vcpuQuota).toBe(64);
  });

  it('skips a kind on Fly, provisioning and disabled shared accounts, disabled spares and Fly accounts', async () => {
    const read = await awsAccount();
    await awsAccount({ state: 'provisioning' });
    const disabled = await awsAccount();
    await fleetShardService.setState(disabled.id, 'disabled');
    const spare = await awsAccount({ role: 'spare' });
    const provisioningSpare = await awsAccount({ role: 'spare', state: 'provisioning' });
    const retiredSpare = await awsAccount({ role: 'spare', state: 'provisioning' });
    await fleetShardService.setState(retiredSpare.id, 'disabled');
    await awsAccount({ fleetKind: 'code_graph_index' }); // still on Fly
    await awsAccount({ fleetKind: 'code_graph_index', role: 'spare' }); // still on Fly
    await fleetShardService.createShard({
      name: 'quota-test-fly',
      fleetKind: 'ci_runner',
      provider: 'fly',
      state: 'active',
      githubOrg: 'motir-fly',
      githubInstallationId: '1',
      flyOrg: 'motir',
      flyApp: 'motir-ci',
      flyRegion: 'iad',
      credentialRef: 'FLY_TEST',
      limits: { machineLimit: 10 },
    });

    const readings = await fleetShardQuotaService.refreshLiveGrantedQuotas(undefined, deps());

    // The shared accounts first, then the spares (active before provisioning).
    expect(readings.map((r) => r.shardId)).toEqual([read.id, spare.id, provisioningSpare.id]);
    expect(org.calls.filter((c) => c.startsWith('assumeMemberRole'))).toEqual([
      `assumeMemberRole:${read.aws!.accountId}`,
      `assumeMemberRole:${spare.aws!.accountId}`,
      `assumeMemberRole:${provisioningSpare.aws!.accountId}`,
    ]);
  });

  // MOTIR-11233: a spare's raise AWS closed as CASE_CLOSED after applying 300
  // left the row at 32 for good; the per-pass read is what corrects it.
  it('a spare’s stored quota follows its live value each pass', async () => {
    const spare = await awsAccount({
      role: 'spare',
      state: 'provisioning',
      limits: { vcpuQuota: 32, githubRegistrationsPer5Min: 1500 },
    });
    org.quotaByAccount.set(spare.aws!.accountId, 300);

    const [first] = await fleetShardQuotaService.refreshLiveGrantedQuotas('ci_runner', deps());
    expect(okOf(first!)).toEqual({
      shardId: spare.id,
      fleetKind: 'ci_runner',
      granted: 300,
      changed: true,
    });
    const row = await fleetShardService.getShard(spare.id);
    expect(row.limits).toMatchObject({ vcpuQuota: 300, githubRegistrationsPer5Min: 1500 });
    expect(row.limitsSource).toMatchObject({ vcpuQuota: 'provider_read' });

    const [again] = await fleetShardQuotaService.refreshLiveGrantedQuotas('ci_runner', deps());
    expect(okOf(again!)).toMatchObject({ granted: 300, changed: false });
  });

  it('reads nothing, and builds no management client, when no kind is on its pool', async () => {
    await awsAccount();
    onPool.clear();
    const management = vi.fn(() => org);
    expect(
      await fleetShardQuotaService.refreshLiveGrantedQuotas(undefined, deps({ management })),
    ).toEqual([]);
    expect(management).not.toHaveBeenCalled();
  });

  it('no credential or session token appears in the result or a failure', async () => {
    const shard = await awsAccount();
    await awsAccount();
    org.readFailures.set(shard.aws!.accountId, new Error(SESSION.sessionToken));

    const readings = await fleetShardQuotaService.refreshLiveGrantedQuotas('ci_runner', deps());
    const printed = JSON.stringify(readings, (_k, v: unknown) =>
      v instanceof Error ? { ...v, message: v.message } : v,
    );

    for (const secret of [SESSION.secretAccessKey, SESSION.sessionToken, SESSION.accessKeyId]) {
      expect(printed).not.toContain(secret);
    }
  });
});
