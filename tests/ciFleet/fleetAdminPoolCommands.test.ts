import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AwsManagementApiError,
  type AwsManagementApi,
  type AwsSessionCredentials,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { runFleetAdmin } from '@/scripts/fleet/fleetAdmin';
import type { FleetAdminPoolDeps } from '@/scripts/fleet/fleetAdminPoolCommands';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { FakeOrganization } from '../helpers/addShardFakes';

// `fleet-admin request-quota`, `pool-status` and `growth-events` (Story
// MOTIR-9362 · MOTIR-9463), through the command against real Postgres, with the
// AWS management calls behind an in-memory organization.

const NOW = new Date('2026-10-24T12:00:00Z');
const SESSION: AwsSessionCredentials = {
  accessKeyId: 'ASIA_SESSION_never_printed',
  secretAccessKey: 'SESSION_SECRET_never_printed',
  sessionToken: 'SESSION_TOKEN_never_printed',
  expiration: null,
};
/** Credential-shaped text an AWS reason could carry. */
const LEAKED_KEY = 'AKIAIOSFODNN7EXAMPLE';
const LEAKED_SECRET = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYzz';

let organization: FakeOrganization;
let operatorEmail: string;
let onPool: boolean;
let management: () => AwsManagementApi;

const deps = (): FleetAdminPoolDeps => ({
  raise: { management: () => management(), now: () => NOW },
  status: {
    onPool: async () => onPool,
    now: () => NOW,
    readUsage: async () => usage,
  },
});
let usage: Array<{ shardId: string; usedVcpu: number }>;

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFleetAdmin(
    argv,
    { out: (l) => void out.push(l), err: (l) => void err.push(l) },
    deps(),
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function account(name: string, accountId: string, granted: number, role = 'primary') {
  return fleetShardService.createShard({
    name,
    fleetKind: 'ci_runner',
    provider: 'aws',
    role: role as 'primary' | 'spare',
    state: 'active',
    githubOrg: 'motir-fleet-use1-1',
    githubInstallationId: '9001',
    awsAccountId: accountId,
    awsRegion: 'us-east-1',
    credentialRef: 'FLEET_SHARD_TEST',
    limits: { vcpuQuota: granted },
    limitsSource: { vcpuQuota: 'provider_read' },
  });
}

const raises = () => organization.calls.filter((c) => c.startsWith('requestVcpuQuotaIncrease'));
const audits = () =>
  adminDb.platformAuditLog.findMany({
    where: { action: { in: ['fleet.shard.quota_request', 'fleet.pool.grow'] } },
  });

beforeEach(async () => {
  await truncateAuthTables();
  organization = new FakeOrganization(SESSION);
  management = () => organization;
  onPool = true;
  usage = [];
  const user = await usersService.createUser({
    email: 'fleet-pool-operator@example.com',
    password: 'hunter2hunter2',
    name: 'Operator',
  });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'superadmin' } });
  operatorEmail = user.email;
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('request-quota', () => {
  it('files a raise on each named account concurrently, one line each, and pool-status lists both', async () => {
    await account('ci-a', '111111111111', 100);
    await account('ci-b', '222222222222', 100);
    // A barrier: neither filing returns until both are in flight at once.
    let arrived = 0;
    let open!: () => void;
    const both = new Promise<void>((r) => (open = r));
    management = () =>
      new Proxy(organization, {
        get(target, prop, receiver) {
          if (prop === 'requestVcpuQuotaIncrease') {
            return async (...args: Parameters<FakeOrganization['requestVcpuQuotaIncrease']>) => {
              if (++arrived === 2) open();
              await Promise.race([
                both,
                new Promise((_, reject) => setTimeout(() => reject(new Error('serial')), 2000)),
              ]);
              return target.requestVcpuQuotaIncrease(...args);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

    const result = await run(
      'request-quota',
      '--name',
      'ci-a',
      '--name',
      'ci-b',
      '--vcpu',
      '200',
      '--operator',
      operatorEmail,
    );

    expect(result.code).toBe(0);
    const lines = result.out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ci-a {2}desired 200 {2}request quota-req-\d {2}pending$/);
    expect(lines[1]).toMatch(/^ci-b {2}desired 200 {2}request quota-req-\d {2}pending$/);

    const status = await run('pool-status', '--kind', 'ci_runner');
    expect(status.out).toMatch(
      /ci-a {2}L-1216C47A {2}desired 200 {2}request quota-req-\d {2}pending/,
    );
    expect(status.out).toMatch(
      /ci-b {2}L-1216C47A {2}desired 200 {2}request quota-req-\d {2}pending/,
    );
  });

  it('one refused account fails its own line; the others are filed; the exit code is non-zero', async () => {
    await account('ci-a', '111111111111', 300);
    await account('ci-b', '222222222222', 100);

    const result = await run(
      'request-quota',
      '--name',
      'ci-a',
      '--name',
      'ci-b',
      '--name',
      'ci-nope',
      '--vcpu',
      '200',
      '--operator',
      operatorEmail,
    );

    expect(result.code).toBe(1);
    const [a, b, nope] = result.out.split('\n');
    expect(a).toBe(
      'ci-a  failed: quota raise for fleet account ci-a refused: 200 is not above the granted 300',
    );
    expect(b).toMatch(/^ci-b {2}desired 200 {2}request quota-req-1 {2}pending$/);
    expect(nope).toBe('ci-nope  failed: no fleet account is named ci-nope');
    expect(raises()).toEqual(['requestVcpuQuotaIncrease:222222222222:200']);
  });

  it('an AWS failure is its account’s line, and credential-shaped AWS text is never printed or audited', async () => {
    await account('ci-a', '111111111111', 100);
    organization.requestFailure = new AwsManagementApiError(
      'service-quotas',
      `AccessDenied ${LEAKED_KEY} ${LEAKED_SECRET}`,
      403,
    );

    const result = await run(
      'request-quota',
      '--name',
      'ci-a',
      '--vcpu',
      '200',
      '--operator',
      operatorEmail,
    );

    expect(result.code).toBe(1);
    expect(result.out).toContain(
      'ci-a  failed: could not file the quota raise of fleet account ci-a',
    );
    const rows = await audits();
    const everything = JSON.stringify([result, rows]);
    for (const secret of [
      LEAKED_KEY,
      LEAKED_SECRET,
      SESSION.accessKeyId,
      SESSION.secretAccessKey,
      SESSION.sessionToken!,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('a second run for an open request prints it and makes no second AWS call', async () => {
    await account('ci-a', '111111111111', 100);
    const args = ['request-quota', '--name', 'ci-a', '--vcpu', '200', '--operator', operatorEmail];
    await run(...args);

    const again = await run(...args);

    expect(again.code).toBe(0);
    expect(again.out).toMatch(
      /^ci-a {2}desired 200 {2}request quota-req-1 {2}pending {2}\(already open\)$/,
    );
    expect(raises()).toHaveLength(1);
  });

  it('writes one audit row per run with each account’s outcome; refuses a non-superadmin', async () => {
    await account('ci-a', '111111111111', 100);
    await account('ci-b', '222222222222', 300);
    await run(
      'request-quota',
      '--name',
      'ci-a',
      '--name',
      'ci-b',
      '--vcpu',
      '200',
      '--operator',
      operatorEmail,
    );

    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'fleet.shard.quota_request' });
    expect(rows[0]!.metadata).toMatchObject({
      desiredVcpu: 200,
      accounts: [
        { name: 'ci-a', outcome: 'filed', awsRequestId: 'quota-req-1' },
        { name: 'ci-b', outcome: 'failed' },
      ],
    });

    const refused = await run(
      'request-quota',
      '--name',
      'ci-a',
      '--vcpu',
      '300',
      '--operator',
      'nobody@example.com',
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('is not a superadmin');
    expect(raises()).toHaveLength(1);
  });
});

describe('pool-status', () => {
  it('prints shared accounts, the spare, the requests and whether a growth is in flight', async () => {
    const a = await account('ci-a', '111111111111', 100);
    await account('ci-spare', '333333333333', 32, 'spare');
    usage = [{ shardId: a.id, usedVcpu: 50 }];
    await run('request-quota', '--name', 'ci-spare', '--vcpu', '200', '--operator', operatorEmail);
    const before = organization.calls.length;

    const result = await run('pool-status', '--kind', 'ci_runner');

    expect(result.code).toBe(0);
    const lines = result.out.split('\n');
    // A spare still waiting on its raise is a growth in flight.
    expect(lines[0]).toBe('ci_runner: aws  growth in flight');
    expect(result.out).toMatch(
      /ci-a {2}active {2}granted 100 \(read \S+\) {2}in use 50 {2}50% {2}to 70% 20/,
    );
    expect(result.out).toContain('ci-spare  spare  active  quota 32');
    expect(result.out).toMatch(
      /ci-spare {2}L-1216C47A {2}desired 200 {2}request quota-req-1 {2}pending {2}granted - {2}last read -/,
    );
    expect(organization.calls.length).toBe(before);
    expect(await audits()).toHaveLength(1); // the request-quota's only
  });

  it('a kind still on Fly says so, with no AWS call', async () => {
    onPool = false;
    const result = await run('pool-status', '--kind', 'ci_runner');
    expect(result.out).toBe('ci_runner: fly (no growth)');
    expect(organization.calls).toEqual([]);
  });

  it('with no kind prints every kind', async () => {
    onPool = false;
    const result = await run('pool-status');
    expect(result.out.split('\n')).toHaveLength(4);
  });
});

describe('growth-events', () => {
  it('prints the kind’s events newest first, bounded by --limit, and writes no audit row', async () => {
    const a = await account('ci-a', '111111111111', 100);
    const spare = await account('ci-spare', '333333333333', 200, 'spare');
    await adminDb.fleetGrowthEvent.create({
      data: {
        fleetKind: 'ci_runner',
        triggeringShardId: a.id,
        vcpuInUse: 70,
        grantedQuota: 100,
        outcome: 'refused',
        reason: 'ACCOUNT_NUMBER_LIMIT_EXCEEDED',
        createdAt: new Date(NOW.getTime() - 60_000),
      },
    });
    await adminDb.fleetGrowthEvent.create({
      data: {
        fleetKind: 'ci_runner',
        triggeringShardId: a.id,
        vcpuInUse: 80,
        grantedQuota: 100,
        outcome: 'spare_promoted',
        spareShardId: spare.id,
        createdAt: NOW,
      },
    });

    const result = await run('growth-events', '--kind', 'ci_runner');
    expect(result.out.split('\n')).toEqual([
      `${NOW.toISOString()}  ci-a  80/100 vCPU  spare_promoted  spare ci-spare`,
      `${new Date(NOW.getTime() - 60_000).toISOString()}  ci-a  70/100 vCPU  refused  -  ACCOUNT_NUMBER_LIMIT_EXCEEDED`,
    ]);
    const limited = await run('growth-events', '--kind', 'ci_runner', '--limit', '1');
    expect(limited.out.split('\n')).toHaveLength(1);
    expect(await audits()).toEqual([]);
  });
});

describe('the command module', () => {
  it('imports neither the database nor the AWS SDK', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'scripts/fleet/fleetAdminPoolCommands.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from '@\/lib\/db'/);
    expect(source).not.toMatch(/@aws-sdk/);
  });
});
