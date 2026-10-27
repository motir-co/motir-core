import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type AwsSessionCredentials, type Ec2Api } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import { PoolGrowthRefusedError } from '@/lib/ciFleet/headroomErrors';
import { poolAccountRaiseTargetVcpu } from '@/lib/ciFleet/shardTargets';
import { AWS_MEMBER_EMAIL_TEMPLATE_ENV } from '@/lib/fleetShards/awsMemberAccountPlan';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import type { FleetHeadroomAlert } from '@/lib/monitoring/fleetShardHeadroomAlert';
import { fleetPoolGrowthPassService } from '@/lib/services/fleetPoolGrowthPassService';
import { fleetQuotaRequestService } from '@/lib/services/fleetQuotaRequestService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { usersService } from '@/lib/services/usersService';
import { runFleetAdmin } from '@/scripts/fleet/fleetAdmin';
import type { FleetAdminPoolDeps } from '@/scripts/fleet/fleetAdminPoolCommands';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { findSecrets } from '../helpers/secretScan';
import {
  ADD_SHARD_ENTERPRISE_SLUG as SLUG,
  FakeOrganization,
  buildStacksInto,
  stubPoolDefinitionEnv,
  installAddShardGithub,
  newGithubWorld,
} from '../helpers/addShardFakes';

// THE STORY'S VERIFICATION WALK (Story MOTIR-9362 · MOTIR-9465). The seven-step
// recipe, in order, as a platform admin meets it: `fleet-admin pool-status`,
// `growth-events` and `request-quota` through their real entry point, and the
// scheduled growth pass between them — one shared in-memory AWS Organization,
// real Postgres, an injected clock and no sleeping. Each `it` is one recipe
// step and starts from the state the previous one left, so a failure names the
// step. The per-seam cases, the admission guard and the full secret scan are
// the integration gate's (`fleetGrowthIntegration.test.ts`).

const ec2FakePath = '../../packages/orchestrator/test/contract/awsEc2Fake';

const ORG = 'motir-fleet-use1-1';
const TEMPLATE = 'aws+{name}@motir.co';
const PRIMARY_ACCOUNT = '111122223333';
const SPARE_ACCOUNT = '444455556666';
const INDEX_ACCOUNT = '999900001111';
const SECRETS = {
  installation: 'ghs_INSTALL_SECRET_never_printed',
  managementKey: 'AKIA_MANAGEMENT_never_printed',
  managementSecret: 'MANAGEMENT_SECRET_never_printed',
  sessionKeyId: 'ASIA_SESSION_never_printed',
  sessionSecret: 'SESSION_SECRET_never_printed',
  sessionToken: 'SESSION_TOKEN_never_printed',
  /** What step 6's refusal reason carries. */
  leakedKeyId: 'AKIAIOSFODNN7EXAMPLE',
};
const SESSION: AwsSessionCredentials = {
  accessKeyId: SECRETS.sessionKeyId,
  secretAccessKey: SECRETS.sessionSecret,
  sessionToken: SECRETS.sessionToken,
  expiration: null,
};
const START = new Date('2026-10-24T12:00:00Z');

let organization: FakeOrganization;
let unregister: () => void;
let clock = START;
const tick = (min: number) => (clock = new Date(clock.getTime() + min * 60_000));

let awsKinds: Set<string>;
const usage = new Map<string, number>();
const alerts: FleetHeadroomAlert[] = [];
const printed: string[] = [];
let operatorEmail: string;
let primaryId: string;
let spareId: string;

const readUsage = async () => [...usage].map(([shardId, usedVcpu]) => ({ shardId, usedVcpu }));

const commandDeps = (): FleetAdminPoolDeps => ({
  raise: { management: () => organization, now: () => clock },
  status: { onPool: async (kind) => awsKinds.has(kind), now: () => clock, readUsage },
});

/** One `fleet-admin` invocation: its exit code and printed text. */
async function fleetAdmin(...argv: string[]) {
  const lines: string[] = [];
  const io = { out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l) };
  const code = await runFleetAdmin(argv, io, commandDeps());
  printed.push(...lines);
  return { code, out: lines.join('\n') };
}

/** One scheduled growth pass at the current clock. */
const pass = () =>
  fleetPoolGrowthPassService.runGrowthPass({
    now: () => clock,
    onPool: async (kind) => awsKinds.has(kind),
    management: () => organization,
    growth: {
      addSpare: {
        raise: { management: () => organization, now: () => clock },
        env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: TEMPLATE },
      },
    },
    readUsage,
    alert: (alert) => void alerts.push(alert),
  });

const count = (call: string) => organization.calls.filter((c) => c.startsWith(call)).length;
const ciShards = () =>
  adminDb.fleetShard.findMany({ where: { fleetKind: 'ci_runner' }, orderBy: { createdAt: 'asc' } });
const ciEvents = () =>
  adminDb.fleetGrowthEvent.findMany({
    where: { fleetKind: 'ci_runner' },
    orderBy: { createdAt: 'asc' },
  });

async function awsAccount(name: string, accountId: string, granted: number) {
  organization.quotaByAccount.set(accountId, granted);
  return fleetShardService.createShard({
    name,
    fleetKind: 'ci_runner',
    provider: 'aws',
    state: 'active',
    githubOrg: ORG,
    githubInstallationId: '9001',
    awsAccountId: accountId,
    awsRegion: 'us-east-1',
    credentialRef: `FLEET_SHARD_${name.toUpperCase().replaceAll('-', '_')}`,
    limits: { vcpuQuota: granted },
    limitsSource: { vcpuQuota: 'provider_read' },
  });
}

beforeAll(async () => {
  const { AwsEc2Fake } = (await import(/* @vite-ignore */ ec2FakePath)) as {
    AwsEc2Fake: new () => Ec2Api;
  };
  await truncateAuthTables();
  await adminDb.fleetGrowthPassLease.deleteMany({});
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
  stubPoolDefinitionEnv();
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  const github = newGithubWorld();
  github.orgs.add(ORG);
  installAddShardGithub(github, SECRETS.installation);
  organization = new FakeOrganization(SESSION);
  buildStacksInto(organization, () => ec2);
  organization.quota = 5; // a new account's AWS default
  const ec2 = new AwsEc2Fake();
  unregister = registerShardProvisioningProvider(
    createAwsShardProvisioningProvider({
      management: () => organization,
      ec2: () => ec2,
      env: () => process.env,
    }),
  );
  await createTestUser({ email: MOTIR_SYSTEM_USER_EMAIL });
  const operator = await usersService.createUser({
    email: 'fleet-walk-operator@example.com',
    password: 'hunter2hunter2',
    name: 'Operator',
  });
  await adminDb.user.update({ where: { id: operator.id }, data: { platformRole: 'superadmin' } });
  operatorEmail = operator.email;
  awsKinds = new Set(['ci_runner']);
});

afterAll(async () => {
  unregister();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the pool-growth walk', () => {
  it('step 1: pool-status shows one shared account with its granted quota and one granted spare', async () => {
    primaryId = (await awsAccount('ci-runner-use1-1', PRIMARY_ACCOUNT, 200)).id;
    usage.set(primaryId, 40); // runners × cpus 2
    const spare = await fleetShardService.createShard({
      name: 'ci-runner-motir-spare',
      fleetKind: 'ci_runner',
      provider: 'aws',
      role: 'spare',
      state: 'active',
      githubOrg: ORG,
      githubInstallationId: '9001',
      awsAccountId: SPARE_ACCOUNT,
      awsRegion: 'us-east-1',
      credentialRef: 'FLEET_SHARD_CI_RUNNER_SPARE',
      limits: { vcpuQuota: 200 },
    });
    spareId = spare.id;
    organization.quotaByAccount.set(SPARE_ACCOUNT, 200);
    const raise = await fleetQuotaRequestService.createRequest({
      shardId: spare.id,
      desiredValue: 200,
      awsRequestId: 'manual-req-1',
    });
    await fleetQuotaRequestService.recordRead(raise.id, { status: 'approved', grantedValue: 200 });

    const { code, out } = await fleetAdmin('pool-status', '--kind', 'ci_runner');

    expect(code).toBe(0);
    expect(out).toMatch(
      /ci-runner-use1-1 {2}active {2}granted 200 .* in use 40 {2}20% {2}to 70% 100/,
    );
    expect(out).toMatch(/ci-runner-motir-spare {2}spare {2}active {2}quota 200/);
    expect(organization.calls).toEqual([]);
  });

  it('step 2: 69% grows nothing; exactly 70% promotes the spare and creates a new account', async () => {
    usage.set(primaryId, 138);
    tick(1);
    await pass();
    expect(await ciEvents()).toEqual([]);

    usage.set(primaryId, 140);
    tick(1);
    await pass();
    const { out } = await fleetAdmin('growth-events', '--kind', 'ci_runner');

    const events = await ciEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'spare_promoted',
      triggeringShardId: primaryId,
      vcpuInUse: 140,
      grantedQuota: 200,
      spareShardId: spareId,
    });
    const created = await adminDb.fleetShard.findUniqueOrThrow({
      where: { id: events[0]!.newShardId! },
    });
    expect(out.split('\n')).toEqual([
      expect.stringMatching(
        new RegExp(
          `ci-runner-use1-1 {2}140/200 vCPU {2}spare_promoted {2}spare ci-runner-motir-spare, new ${created.name}`,
        ),
      ),
    ]);
  });

  it('step 3: pool-status shows two shared accounts and a provisioning spare with a pending raise', async () => {
    const { out } = await fleetAdmin('pool-status', '--kind', 'ci_runner');
    const [event] = await ciEvents();
    const created = await adminDb.fleetShard.findUniqueOrThrow({
      where: { id: event!.newShardId! },
    });
    const [request] = await adminDb.fleetQuotaRequest.findMany({ where: { shardId: created.id } });

    expect(out).toMatch(/ci-runner-use1-1 {2}active {2}granted 200/);
    expect(out).toMatch(/ci-runner-motir-spare {2}active {2}granted 200/);
    expect(out).toContain(`${created.name}  spare  provisioning`);
    expect(request!.desiredValue).toBe(poolAccountRaiseTargetVcpu('ci_runner'));
    expect(out).toContain(
      `${created.name}  L-1216C47A  desired ${request!.desiredValue}  request ${request!.awsRequestId}  pending`,
    );
  });

  it('step 4: more passes above 70% create nothing more while the growth is in flight', async () => {
    for (let i = 0; i < 5; i += 1) {
      tick(3);
      expect((await pass()).kinds).toMatchObject({ ci_runner: 'in_flight' });
    }
    const { out } = await fleetAdmin('pool-status', '--kind', 'ci_runner');

    expect(await ciShards()).toHaveLength(3);
    expect(await adminDb.fleetQuotaRequest.count({ where: { closedAt: null } })).toBe(1);
    expect(await ciEvents()).toHaveLength(1);
    expect(count('createOrganizationAccount')).toBe(1);
    expect(count('requestVcpuQuotaIncrease')).toBe(1);
    expect(out).toContain('growth in flight');
  });

  it('step 5: two parallel request-quota raises, each with its own status; a repeat calls AWS no more', async () => {
    await awsAccount('ci-runner-use1-2', '555500001111', 64);
    await awsAccount('ci-runner-use1-3', '555500002222', 96);
    const argv = [
      'request-quota',
      '--name',
      'ci-runner-use1-2',
      '--name',
      'ci-runner-use1-3',
      '--vcpu',
      '128',
      '--operator',
      operatorEmail,
    ];

    const first = await fleetAdmin(...argv);
    expect(first.code).toBe(0);
    const lines = first.out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^ci-runner-use1-2 {2}desired 128 {2}request quota-req-\d+ {2}pending$/,
    );
    expect(lines[1]).toMatch(
      /^ci-runner-use1-3 {2}desired 128 {2}request quota-req-\d+ {2}pending$/,
    );

    // AWS approves one of the two; pool-status shows each with its own status.
    const [idA] = [...organization.quotaRequests].find(([, r]) => r.accountId === '555500001111')!;
    organization.settleQuotaRequest(idA, 'APPROVED');
    tick(1);
    await pass();
    const status = await fleetAdmin('pool-status', '--kind', 'ci_runner');
    expect(status.out).toMatch(
      /ci-runner-use1-2 {2}L-1216C47A {2}desired 128 .* approved {2}granted 128/,
    );
    expect(status.out).toMatch(
      /ci-runner-use1-3 {2}L-1216C47A {2}desired 128 .* pending {2}granted -/,
    );

    // The same command for the still-open one is answered from the record.
    const calls = organization.calls.length;
    const again = await fleetAdmin(
      'request-quota',
      '--name',
      'ci-runner-use1-3',
      '--vcpu',
      '128',
      '--operator',
      operatorEmail,
    );
    expect(again.out).toMatch(/ci-runner-use1-3 .* pending {2}\(already open\)$/);
    expect(organization.calls.length).toBe(calls);
  });

  it('step 6: a refused CreateAccount is one refused event and one alert, changes no capacity, and backs off', async () => {
    // AWS turns down the step-2 spare's raise: no growth is in flight any more,
    // and no spare is ready.
    const [pendingId] = [...organization.quotaRequests].find(
      ([, r]) =>
        r.status === 'PENDING' && r.desiredValue === poolAccountRaiseTargetVcpu('ci_runner'),
    )!;
    organization.settleQuotaRequest(pendingId, 'DENIED');
    organization.createFailure = `ACCOUNT_NUMBER_LIMIT_EXCEEDED (caller ${SECRETS.leakedKeyId})`;
    const before = await ciShards();
    const creates = count('createOrganizationAccount');

    tick(1);
    expect((await pass()).kinds).toMatchObject({ ci_runner: 'refused' });
    const growth = await fleetAdmin('growth-events', '--kind', 'ci_runner');
    const status = await fleetAdmin('pool-status', '--kind', 'ci_runner');

    expect(growth.out.split('\n')[0]).toMatch(/refused .*ACCOUNT_NUMBER_LIMIT_EXCEEDED/);
    expect(alerts.filter((a) => a instanceof PoolGrowthRefusedError)).toHaveLength(1);
    expect(await ciShards()).toEqual(before);
    expect(status.out).not.toContain('growth in flight');
    expect(count('createOrganizationAccount')).toBe(creates + 1);

    tick(10); // inside the 30-minute backoff
    expect((await pass()).kinds).toMatchObject({ ci_runner: 'backing_off' });
    expect(count('createOrganizationAccount')).toBe(creates + 1);
  });

  it('step 7: code_graph_index on Fly never grows while ci_runner grows in the same pass', async () => {
    const indexer = await fleetShardService.createShard({
      name: 'code-graph-index-use1-1',
      fleetKind: 'code_graph_index',
      provider: 'aws',
      state: 'active',
      githubOrg: ORG,
      githubInstallationId: '9001',
      awsAccountId: INDEX_ACCOUNT,
      awsRegion: 'us-east-1',
      credentialRef: 'FLEET_SHARD_CODE_GRAPH_INDEX_USE1_1',
      limits: { vcpuQuota: 100 },
    });
    organization.quotaByAccount.set(INDEX_ACCOUNT, 100);
    usage.set(indexer.id, 90);
    organization.createFailure = null;
    const alertsBefore = alerts.length;

    tick(31); // past ci_runner's backoff
    const summary = await pass();
    const growth = await fleetAdmin('growth-events', '--kind', 'code_graph_index');
    const status = await fleetAdmin('pool-status', '--kind', 'code_graph_index');

    expect(summary.kinds).toMatchObject({ ci_runner: 'grown', code_graph_index: 'on_fly' });
    expect(growth.out).toBe('code_graph_index: no growth events');
    expect(status.out).toBe('code_graph_index: fly (no growth)');
    expect(await adminDb.fleetShard.count({ where: { fleetKind: 'code_graph_index' } })).toBe(1);
    expect(
      await adminDb.fleetQuotaRequest.count({ where: { fleetKind: 'code_graph_index' } }),
    ).toBe(0);
    expect(organization.calls.some((c) => c.includes(INDEX_ACCOUNT))).toBe(false);
    expect(alerts.slice(alertsBefore)).toEqual([]);
  });

  it('after the walk: no secret in any printed line or audit row', async () => {
    const audits = await adminDb.platformAuditLog.findMany({
      where: { action: { in: ['fleet.pool.grow', 'fleet.shard.quota_request'] } },
    });
    expect(audits.length).toBeGreaterThan(0);
    expect(
      findSecrets(
        [
          ['printed output', printed],
          ['audit rows', audits],
        ],
        Object.values(SECRETS),
      ),
    ).toEqual([]);
  });
});
