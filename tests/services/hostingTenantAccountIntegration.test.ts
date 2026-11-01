import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWS_MANAGEMENT_ENV, type AwsSessionCredentials } from '@motir/orchestrator';
import { FleetShardAccountRefusedError } from '@/lib/ciFleet/errors';
import {
  TENANT_ORGANIZATION_TAG_KEY,
  TENANT_OU_NAME,
  TENANT_QUOTA_TARGETS,
  tenantAccountName,
} from '@/lib/ciFleet/hostingTenantAccounts';
import { refusalBackoffMs } from '@/lib/ciFleet/poolGrowthPolicy';
import { AWS_MEMBER_EMAIL_TEMPLATE_ENV } from '@/lib/fleetShards/awsMemberAccountPlan';
import type { FleetHeadroomAlert } from '@/lib/monitoring/fleetShardHeadroomAlert';
import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { fleetShardHeadroomService } from '@/lib/services/fleetShardHeadroomService';
import { fleetPoolStatusService } from '@/lib/services/fleetPoolStatusService';
import { bootstrapTenantAccount } from '@/lib/services/hostingTenantAccountBootstrapService';
import { createOrFindTenantAccount } from '@/lib/services/hostingTenantAccountProvisioningService';
import {
  hostingTenantAccountService,
  type TenantReconcileDeps,
} from '@/lib/services/hostingTenantAccountService';
import { planCapsService } from '@/lib/services/planCapsService';
import { withSystemContext } from '@/lib/workspaces/context';
import { FakeOrganization, type FakeOrganizationStep } from '../helpers/addShardFakes';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE TENANT ACCOUNT STORY'S INTEGRATION GATE (Story MOTIR-9792 · MOTIR-9944).
// The assembled chain — `hostingTenantAccountService` driving the REAL
// `createOrFindTenantAccount` and `bootstrapTenantAccount` through the real
// database — over the one fake, the in-memory AWS organization. It proves what
// only the whole can: a pass cut off at ANY AWS step is finished by a later one
// with exactly one of everything, and a tenant account never reaches fleet
// admission, headroom, plan caps or the pool view. The source half of the
// isolation proof is `tests/ciFleet/hostingTenantAccountFleetIsolation.test.ts`.

const T0 = new Date('2026-10-28T12:00:00Z');
const LEASE_ID = 'hosting-tenant-account-reconcile';
const EMAIL_MARK = 'distinctive-tenant-template.example';
const SECRETS = {
  sessionKeyId: 'ASIA_TENANT_SESSION_never_printed',
  sessionSecret: 'TENANT_SESSION_SECRET_never_printed',
  sessionToken: 'TENANT_SESSION_TOKEN_never_printed',
};
const SESSION: AwsSessionCredentials = {
  accessKeyId: SECRETS.sessionKeyId,
  secretAccessKey: SECRETS.sessionSecret,
  sessionToken: SECRETS.sessionToken,
  expiration: null,
};
const ENV = {
  [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: `root+{name}@${EMAIL_MARK}`,
  [AWS_MANAGEMENT_ENV.accessKeyId]: 'AKIA_MANAGEMENT_never_printed',
  [AWS_MANAGEMENT_ENV.secretAccessKey]: 'MANAGEMENT_SECRET_never_printed',
  [AWS_MANAGEMENT_ENV.roleArn]: 'arn:aws:iam::576360162297:role/motir-add-shard',
};
const FORBIDDEN = [
  ...Object.values(SECRETS),
  ENV[AWS_MANAGEMENT_ENV.accessKeyId]!,
  ENV[AWS_MANAGEMENT_ENV.secretAccessKey]!,
  EMAIL_MARK,
  'root+',
];
const MAX_PASSES = 8;

let organization: FakeOrganization;
let alerts: FleetHeadroomAlert[];
let logs: string[];
let outputs: unknown[];
let moves: number;
let orgSeq = 0;
const seededShards: string[] = [];

async function seedOrg() {
  orgSeq += 1;
  return adminDb.organization.create({
    data: { name: `Tenant org ${orgSeq}`, slug: `tenant-gate-${orgSeq}-${Date.now()}` },
  });
}

/** The reconcile's deps: the REAL create and bootstrap over the fake client. */
function deps(at: Date = T0): TenantReconcileDeps {
  return {
    now: () => at,
    alert: (a) => alerts.push(a),
    create: (organizationId) =>
      createOrFindTenantAccount(organizationId, { management: organization, env: ENV }),
    bootstrap: (organizationId) =>
      bootstrapTenantAccount(organizationId, { management: organization }),
  };
}

const rowOf = (organizationId: string) =>
  withSystemContext((tx) =>
    hostingTenantAccountRepository.findByOrganizationId(organizationId, tx),
  );

/** Run passes until the row is ready, failing loudly on a stuck row. */
async function passUntilReady(organizationId: string, at: Date = T0): Promise<number> {
  for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
    const summary = await hostingTenantAccountService.runReconcile(deps(at));
    outputs.push(summary);
    if ((await rowOf(organizationId))?.state === 'ready') return pass;
  }
  throw new Error(`the row for ${organizationId} was not ready after ${MAX_PASSES} passes`);
}

const count = (prefix: string) => organization.calls.filter((c) => c.startsWith(prefix)).length;

function expectNoLeak() {
  const text = JSON.stringify([outputs, logs, alerts.map((a) => a.message), organization.calls]);
  for (const secret of FORBIDDEN) expect(text).not.toContain(secret);
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetGrowthPassLease.deleteMany({ where: { id: LEASE_ID } });
  organization = new FakeOrganization(SESSION);
  // Count the moves that landed, at the fake's own parent store — a move cut
  // off after it landed counts too.
  moves = 0;
  const parents = organization.accountUnits;
  const setParent = parents.set.bind(parents);
  parents.set = (accountId: string, parentId: string) => {
    moves += 1;
    return setParent(accountId, parentId);
  };
  alerts = [];
  outputs = [];
  logs = [];
  for (const level of ['info', 'log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (seededShards.length > 0) {
    await adminDb.fleetShard.deleteMany({ where: { id: { in: seededShards.splice(0) } } });
  }
});

afterAll(async () => {
  await truncateAuthTables();
  await adminDb.fleetGrowthPassLease.deleteMany({ where: { id: LEASE_ID } });
});

describe('resume at every AWS step', () => {
  const cut = (step: FakeOrganizationStep) => (): void =>
    void organization.failAfter.set(step, new Error('cut off'));

  const injections: Array<[string, () => void]> = [
    ['CreateAccount returned', cut('createOrganizationAccount')],
    ['the OU was created', cut('ensureOrganizationalUnit')],
    [
      'the record was written',
      () => {
        const record = hostingTenantAccountRepository.recordAccountInTx.bind(
          hostingTenantAccountRepository,
        );
        let fired = false;
        vi.spyOn(hostingTenantAccountRepository, 'recordAccountInTx').mockImplementation(
          async (...args) => {
            const row = await record(...args);
            if (!fired) {
              fired = true;
              throw new Error('cut off');
            }
            return row;
          },
        );
      },
    ],
    ['the account was moved', cut('moveAccountToOrganizationalUnit')],
    ['the role was created', cut('tenantRoleCreated')],
    ['the role policy was put', cut('tenantRolePolicyPut')],
    ['the tag was written', cut('accountTagged')],
    ['the first quota raise was filed', cut('quotaRaiseFiled')],
  ];

  it.each(injections)('a pass cut off after %s is finished, one of everything', async (_, arm) => {
    const org = await seedOrg();
    await hostingTenantAccountService.ensureForOrganization(org.id);
    arm();

    const passes = await passUntilReady(org.id);
    expect(passes).toBeGreaterThan(1);

    const account = organization.accounts.get(tenantAccountName(org.id));
    expect(account).toBeDefined();
    const accountId = account!.accountId;
    expect(count('createOrganizationAccount')).toBe(1);
    expect(organization.accounts.size).toBe(1);
    expect([...organization.organizationalUnits.keys()]).toEqual([TENANT_OU_NAME]);
    expect(await adminDb.hostingTenantAccount.count()).toBe(1);
    expect(moves).toBe(1);
    expect(organization.accountUnits.get(accountId)).toBe(
      organization.organizationalUnits.get(TENANT_OU_NAME),
    );
    expect([...organization.tenantRoles.keys()]).toEqual([accountId]);
    expect([...organization.accountTags.get(accountId)!.entries()]).toEqual([
      [TENANT_ORGANIZATION_TAG_KEY, org.id],
    ]);
    expect(organization.openQuotaRaises.size).toBe(TENANT_QUOTA_TARGETS.length);
    expect(await rowOf(org.id)).toMatchObject({ state: 'ready', awsAccountId: accountId });

    expect(organization.calls.filter((c) => c.startsWith('assume'))).toEqual(
      organization.calls
        .filter((c) => c.startsWith('assume'))
        .map(() => `assumeMemberRole:${accountId}`),
    );
    expectNoLeak();
  });
});

describe('a ready account', () => {
  it('is left alone by further passes and ensures, answering the same account', async () => {
    const org = await seedOrg();
    await hostingTenantAccountService.ensureForOrganization(org.id);
    await passUntilReady(org.id);
    const accountId = organization.accounts.get(tenantAccountName(org.id))!.accountId;
    const callsAtReady = organization.calls.length;

    await hostingTenantAccountService.runReconcile(deps(new Date(T0.getTime() + 60_000)));
    await hostingTenantAccountService.runReconcile(deps(new Date(T0.getTime() + 120_000)));
    // A second project of the same organisation asks through the same door.
    const answers = [
      await hostingTenantAccountService.ensureForOrganization(org.id),
      await hostingTenantAccountService.ensureForOrganization(org.id),
    ];

    expect(organization.calls.slice(callsAtReady)).toEqual([]);
    expect(answers).toEqual([
      { state: 'ready', ready: true, accountId },
      { state: 'ready', ready: true, accountId },
    ]);
  });
});

describe('a refused CreateAccount', () => {
  it('backs off from the stored row across a restart, then retries and clears', async () => {
    const org = await seedOrg();
    await hostingTenantAccountService.ensureForOrganization(org.id);
    organization.createFailure = 'ACCOUNT_NUMBER_LIMIT_EXCEEDED';

    await hostingTenantAccountService.runReconcile(deps());
    expect(await rowOf(org.id)).toMatchObject({
      state: 'refused',
      refusedCount: 1,
      lastRefusedAt: T0,
    });
    expect(alerts).toHaveLength(1);
    organization.createFailure = null;

    const inside = new Date(T0.getTime() + refusalBackoffMs(1) - 1);
    const callsBefore = organization.calls.length;
    expect((await hostingTenantAccountService.runReconcile(deps(inside))).organizations).toEqual([
      { organizationId: org.id, outcome: 'backing_off' },
    ]);

    // A restart: a fresh module graph, so nothing is carried in memory.
    vi.resetModules();
    const restarted = (await import('@/lib/services/hostingTenantAccountService'))
      .hostingTenantAccountService;
    expect((await restarted.runReconcile(deps(inside))).organizations).toEqual([
      { organizationId: org.id, outcome: 'backing_off' },
    ]);
    expect(organization.calls.slice(callsBefore)).toEqual([]);

    const after = new Date(T0.getTime() + refusalBackoffMs(1));
    expect((await restarted.runReconcile(deps(after))).organizations).toEqual([
      { organizationId: org.id, outcome: 'ready' },
    ]);
    expect(await rowOf(org.id)).toMatchObject({ state: 'ready', refusedCount: 0 });
    expect(alerts[0]!.message).toContain(tenantAccountName(org.id));
    expect(alerts[0]!.message).toContain('ACCOUNT_NUMBER_LIMIT_EXCEEDED');
    expectNoLeak();
  });

  it('a refusal surfaces from the real create as the typed error the reconcile records', async () => {
    const org = await seedOrg();
    await hostingTenantAccountService.ensureForOrganization(org.id);
    organization.createFailure = 'ACCOUNT_NUMBER_LIMIT_EXCEEDED';
    await expect(
      createOrFindTenantAccount(org.id, { management: organization, env: ENV }),
    ).rejects.toBeInstanceOf(FleetShardAccountRefusedError);
  });
});

describe('a tenant account never reaches the fleet', () => {
  it('is not listed or counted by admission, headroom, plan caps or the pool view', async () => {
    const org = await seedOrg();
    const shard = await adminDb.fleetShard.create({
      data: {
        name: `pool-gate-${Date.now()}`,
        fleetKind: 'ci_runner',
        provider: 'aws',
        role: 'primary',
        state: 'active',
        githubOrg: 'motir-projects',
        githubInstallationId: '556677',
        awsAccountId: '111122223333',
        awsRegion: 'us-east-1',
        credentialRef: 'FLEET_SHARD_GATE_TEST',
        vcpuQuota: 640,
      },
    });
    seededShards.push(shard.id);
    const shardsBefore = await adminDb.fleetShard.findMany({ orderBy: { id: 'asc' } });
    const capsBefore = await planCapsService.capsFor(org.id);

    await hostingTenantAccountService.ensureForOrganization(org.id);
    await passUntilReady(org.id);
    const tenantAccountId = organization.accounts.get(tenantAccountName(org.id))!.accountId;

    expect(await adminDb.fleetShard.findMany({ orderBy: { id: 'asc' } })).toEqual(shardsBefore);
    expect(await adminDb.fleetShard.count({ where: { awsAccountId: tenantAccountId } })).toBe(0);

    const admitted = await withSystemContext((tx) =>
      fleetShardAdmissionService.selectionSetInTx(
        { fleetKind: 'ci_runner', organizationId: org.id },
        tx,
      ),
    );
    const headroom = await fleetShardHeadroomService.readAccountHeadroom(T0);
    const pool = await fleetPoolStatusService.getPoolStatus(undefined, {
      onPool: async () => true,
      now: () => T0,
    });
    const orgAccounts = await fleetPoolStatusService.listOrgAccounts({ organizationId: org.id });
    const capsAfter = await planCapsService.capsFor(org.id);

    expect(admitted.map((s) => s.id)).toEqual([shard.id]);
    expect(headroom.map((r) => r.shardId).sort()).toEqual(
      shardsBefore
        .filter(
          (s) =>
            (s.state === 'active' || s.state === 'disabled') &&
            (s.role === 'primary' || s.role === 'spare'),
        )
        .map((s) => s.id)
        .sort(),
    );
    expect(orgAccounts).toEqual([]);
    expect(capsAfter).toEqual(capsBefore);
    for (const view of [admitted, headroom, pool, orgAccounts, capsAfter]) {
      expect(JSON.stringify(view)).not.toContain(tenantAccountId);
      expect(JSON.stringify(view)).not.toContain(tenantAccountName(org.id));
    }
  });
});
