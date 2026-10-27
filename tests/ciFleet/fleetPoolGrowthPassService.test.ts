import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AwsSessionCredentials, type Ec2Api } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import {
  PoolGrowthRefusedError,
  QuotaRequestDeniedError,
  QuotaRequestSlowError,
} from '@/lib/ciFleet/headroomErrors';
import { refusalBackoffMs } from '@/lib/ciFleet/poolGrowthPolicy';
import { AWS_MEMBER_EMAIL_TEMPLATE_ENV } from '@/lib/fleetShards/awsMemberAccountPlan';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import type { FleetHeadroomAlert } from '@/lib/monitoring/fleetShardHeadroomAlert';
import {
  fleetPoolGrowthPassService,
  type GrowthPassDeps,
} from '@/lib/services/fleetPoolGrowthPassService';
import { fleetPoolGrowthService } from '@/lib/services/fleetPoolGrowthService';
import { fleetQuotaRaiseService } from '@/lib/services/fleetQuotaRaiseService';
import { fleetQuotaRequestService } from '@/lib/services/fleetQuotaRequestService';
import { fleetShardQuotaService } from '@/lib/services/fleetShardQuotaService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  ADD_SHARD_ENTERPRISE_SLUG as SLUG,
  FakeOrganization,
  buildStacksInto,
  stubPoolDefinitionEnv,
  installAddShardGithub,
  newGithubWorld,
  type GithubWorld,
} from '../helpers/addShardFakes';

// THE GROWTH PASS (Story MOTIR-9362 · MOTIR-9462), against a real database and
// the REAL growth, live read, raise refresh and unattended add-shard underneath
// — AWS behind an in-memory organization, GitHub stubbed at `fetch`, the network
// over the in-memory EC2. Alerts are captured, not sent.

const ec2FakePath = '../../packages/orchestrator/test/contract/awsEc2Fake';
let AwsEc2Fake: new () => Ec2Api;

const ORG = 'motir-fleet-use1-1';
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
const NOW = new Date('2026-10-24T12:00:00Z');

let github: GithubWorld;
let organization: FakeOrganization;
let ec2: Ec2Api;
let unregister: () => void;
let primaryId: string;

let awsKinds: Set<string>;
let inUse: number;
let alerts: FleetHeadroomAlert[];

/** One pass at `now`, the primary using `inUse` vCPU of its live granted 100. */
const passDeps = (now: Date = NOW): GrowthPassDeps => ({
  now: () => now,
  onPool: async (kind) => awsKinds.has(kind),
  management: () => organization,
  growth: {
    addSpare: {
      raise: { management: () => organization, now: () => now },
      env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: TEMPLATE },
    },
  },
  readUsage: async () => [{ shardId: primaryId, usedVcpu: inUse }],
  alert: (alert) => void alerts.push(alert),
});
const pass = (now: Date = NOW) => fleetPoolGrowthPassService.runGrowthPass(passDeps(now));
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

const events = () => adminDb.fleetGrowthEvent.findMany({ orderBy: { createdAt: 'asc' } });
const audits = () =>
  adminDb.platformAuditLog.findMany({
    where: { action: 'fleet.pool.grow' },
    orderBy: { seq: 'asc' },
  });
const shard = (id: string) => adminDb.fleetShard.findUniqueOrThrow({ where: { id } });

/** A spare holding 200 vCPU, with a raise in `status` (none for `null`). */
async function spareWithRaise(status: string | null, state: 'active' | 'provisioning' = 'active') {
  const spare = await fleetShardService.createShard({
    name: 'ci-runner-motir-spare',
    fleetKind: 'ci_runner',
    provider: 'aws',
    role: 'spare',
    state,
    githubOrg: ORG,
    githubInstallationId: '9001',
    awsAccountId: '444455556666',
    awsRegion: 'us-east-1',
    credentialRef: 'FLEET_SHARD_CI_RUNNER_SPARE',
    limits: { vcpuQuota: 200 },
  });
  if (status) {
    const request = await fleetQuotaRequestService.createRequest({
      shardId: spare.id,
      desiredValue: 200,
      awsRequestId: 'manual-req-1',
    });
    if (status !== 'pending') {
      await fleetQuotaRequestService.recordRead(request.id, {
        status,
        grantedValue: status === 'approved' ? 200 : null,
      });
    }
  }
  return spare;
}

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ ec2FakePath)) as {
    AwsEc2Fake: new () => Ec2Api;
  });
});

beforeEach(async () => {
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
  github = newGithubWorld();
  github.orgs.add(ORG);
  organization = new FakeOrganization(SESSION);
  buildStacksInto(organization, () => ec2);
  organization.quota = 5; // a new account's AWS default
  ec2 = new AwsEc2Fake();
  installAddShardGithub(github, SECRETS.installation);
  unregister = registerShardProvisioningProvider(
    createAwsShardProvisioningProvider({
      management: () => organization,
      ec2: () => ec2,
      env: () => process.env,
    }),
  );
  await createTestUser({ email: MOTIR_SYSTEM_USER_EMAIL });
  awsKinds = new Set(['ci_runner']);
  inUse = 80;
  alerts = [];
  primaryId = (
    await fleetShardService.createShard({
      name: 'ci-runner-use1-1',
      fleetKind: 'ci_runner',
      provider: 'aws',
      state: 'active',
      githubOrg: ORG,
      githubInstallationId: '9001',
      awsAccountId: '111122223333',
      awsRegion: 'us-east-1',
      credentialRef: 'FLEET_SHARD_CI_RUNNER_USE1_1',
      limits: { vcpuQuota: 100 },
    })
  ).id;
  organization.quotaByAccount.set('111122223333', 100); // its LIVE granted quota
});

afterEach(() => {
  vi.restoreAllMocks();
  unregister();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('refusalBackoffMs', () => {
  it('is 30 minutes, doubling per consecutive refusal, capped at 6 hours', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 40].map((n) => refusalBackoffMs(n) / 60_000)).toEqual([
      0, 30, 60, 120, 240, 360, 360, 360,
    ]);
  });
});

describe('one pass', () => {
  it('reads live quotas, then refreshes raises, then settles and grows each AWS kind', async () => {
    const order: string[] = [];
    const spy = <T extends object>(target: T, method: keyof T & string) => {
      const original = (target[method] as (...a: unknown[]) => unknown).bind(target);
      vi.spyOn(target, method as never).mockImplementation(((...args: unknown[]) => {
        order.push(method);
        return original(...args);
      }) as never);
    };
    spy(fleetShardQuotaService, 'refreshLiveGrantedQuotas');
    spy(fleetQuotaRaiseService, 'refreshOpenRequests');
    spy(fleetPoolGrowthService, 'settleGrantedSpares');
    spy(fleetPoolGrowthService, 'growKind');

    const summary = await pass();

    expect(order).toEqual([
      'refreshLiveGrantedQuotas',
      'refreshOpenRequests',
      'settleGrantedSpares',
      'growKind',
    ]);
    expect(summary).toMatchObject({ ran: true, kinds: { ci_runner: 'grown' }, failures: 0 });
    // The live read set the figure the decision used.
    expect((await events())[0]).toMatchObject({ vcpuInUse: 80, grantedQuota: 100 });
  });

  it('never passes a kind still on Fly to growKind, and writes nothing for it', async () => {
    awsKinds = new Set();
    const grow = vi.spyOn(fleetPoolGrowthService, 'growKind');

    const summary = await pass();

    expect(grow).not.toHaveBeenCalled();
    expect(summary.kinds).toMatchObject({ ci_runner: 'on_fly', hosted_agent: 'on_fly' });
    expect(await events()).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(alerts).toEqual([]);
    expect(organization.calls).toEqual([]);
  });

  it('a kind that throws is counted failed and the other kinds still run', async () => {
    awsKinds = new Set(['ci_runner', 'hosted_agent', 'code_graph_index']);
    const grow = vi.spyOn(fleetPoolGrowthService, 'growKind');
    grow.mockImplementation(async (kind) => {
      if (kind === 'hosted_agent') throw new Error('boom');
      return { result: 'below_threshold', fleetKind: kind, skipped: [] };
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const summary = await pass();

    expect(summary.kinds).toMatchObject({
      ci_runner: 'below_threshold',
      hosted_agent: 'failed',
      code_graph_index: 'below_threshold',
    });
    expect(grow.mock.calls.map(([kind]) => kind).sort()).toEqual([
      'ci_runner',
      'code_graph_index',
      'hosted_agent',
    ]);
  });

  it('two overlapping runs do not both execute a pass', async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    const gate = new Promise<void>((r) => (release = r));
    const slow = fleetPoolGrowthPassService.runGrowthPass({
      ...passDeps(),
      readUsage: async () => {
        enter();
        await gate;
        return [];
      },
    });
    await entered;

    const overlapping = await pass();
    release();

    expect(overlapping).toMatchObject({ ran: false, kinds: {} });
    expect(await slow).toMatchObject({ ran: true });
    // Released: the next run executes.
    expect(await pass(minutes(1))).toMatchObject({ ran: true });
  });

  it('an expired lease from a crashed run does not block the next one', async () => {
    await adminDb.fleetGrowthPassLease.create({
      data: { id: 'fleet-pool-growth-pass', holder: 'crashed', heldUntil: minutes(-1) },
    });
    expect(await pass()).toMatchObject({ ran: true });
  });
});

describe('a refused growth', () => {
  it('is one refused event and one audit row, one alert, no new row; the promoted spare stays', async () => {
    const spare = await spareWithRaise('approved');
    organization.createFailure = 'ACCOUNT_NUMBER_LIMIT_EXCEEDED';

    const summary = await pass();

    expect(summary.kinds.ci_runner).toBe('refused');
    const all = await events();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      outcome: 'refused',
      reason: 'ACCOUNT_NUMBER_LIMIT_EXCEEDED',
      triggeringShardId: primaryId,
      spareShardId: spare.id,
      vcpuInUse: 80,
      grantedQuota: 100,
    });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ outcome: 'refused', growthEventId: all[0]!.id });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toBeInstanceOf(PoolGrowthRefusedError);
    expect(alerts[0]!.message).toContain('ACCOUNT_NUMBER_LIMIT_EXCEEDED');
    expect(await adminDb.fleetShard.count()).toBe(2);
    expect(await shard(spare.id)).toMatchObject({ role: 'primary', state: 'active' });
  });

  it('backs off: 30 minutes, then 60; a growth that succeeds resets it', async () => {
    organization.createFailure = 'ACCOUNT_NUMBER_LIMIT_EXCEEDED';
    const grow = vi.spyOn(fleetPoolGrowthService, 'growKind');
    const settle = vi.spyOn(fleetPoolGrowthService, 'settleGrantedSpares');
    const live = vi.spyOn(fleetShardQuotaService, 'refreshLiveGrantedQuotas');
    const refresh = vi.spyOn(fleetQuotaRaiseService, 'refreshOpenRequests');

    await pass(); // refusal 1
    expect(grow).toHaveBeenCalledTimes(1);

    // Inside the backoff: no growKind, no event — but the refreshes and the
    // settling still run.
    expect((await pass(minutes(29))).kinds.ci_runner).toBe('backing_off');
    expect(grow).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(2);
    expect(live).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(await events()).toHaveLength(1);

    await pass(minutes(31)); // refusal 2: the backoff is now 60 minutes
    expect(grow).toHaveBeenCalledTimes(2);
    expect((await pass(minutes(31 + 59))).kinds.ci_runner).toBe('backing_off');
    expect(grow).toHaveBeenCalledTimes(2);

    organization.createFailure = null;
    expect((await pass(minutes(31 + 61))).kinds.ci_runner).toBe('grown');
    // Reset: the growth is in flight, not backing off.
    expect((await pass(minutes(31 + 62))).kinds.ci_runner).toBe('in_flight');
    expect((await events()).map((e) => e.outcome)).toEqual([
      'refused',
      'refused',
      'waiting_for_quota',
    ]);
  });
});

describe('slow and refused quota raises', () => {
  async function filedRaise() {
    const spare = await spareWithRaise(null, 'provisioning');
    const request = await fleetQuotaRaiseService.fileRaise(spare.id, 300, {
      management: () => organization,
      now: () => NOW,
    });
    return { spare, request };
  }

  it('a raise open 24 hours alerts once, not on every pass', async () => {
    awsKinds = new Set(); // no growth in the way
    awsKinds.add('hosted_agent'); // a kind on AWS so the pass runs its refreshes
    const { request } = await filedRaise();
    await adminDb.fleetQuotaRequest.update({
      where: { id: request.id },
      data: { createdAt: new Date(NOW.getTime() - 25 * 3_600_000) },
    });

    expect((await pass()).requestAlerts).toBe(1);
    expect(alerts[0]).toBeInstanceOf(QuotaRequestSlowError);
    expect(alerts[0]!.message).toContain('25 hours');
    expect((await pass(minutes(1))).requestAlerts).toBe(0);
    expect(alerts).toHaveLength(1);
  });

  it('a raise that closes denied alerts once and leaves the granted quota alone', async () => {
    awsKinds = new Set(['hosted_agent']);
    const { spare, request } = await filedRaise();
    expect((await pass()).requestAlerts).toBe(0);

    organization.settleQuotaRequest(request.awsRequestId, 'DENIED');
    const summary = await pass(minutes(1));

    expect(summary.requestAlerts).toBe(1);
    expect(alerts.at(-1)).toBeInstanceOf(QuotaRequestDeniedError);
    expect((await fleetQuotaRequestService.getRequest(request.id)).status).toBe('denied');
    expect(await shard(spare.id)).toMatchObject({ vcpuQuota: 200 });
    expect((await pass(minutes(2))).requestAlerts).toBe(0);
  });
});

describe('no secret leaves the pass', () => {
  it('appears in no summary, event, audit row, alert or log line', async () => {
    const logs: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void logs.push(args));
    }
    await spareWithRaise('approved');
    organization.createFailure = 'ACCOUNT_NUMBER_LIMIT_EXCEEDED';
    const refused = await pass();
    organization.createFailure = null;
    const grown = await pass(minutes(31));

    const outputs = JSON.stringify([
      refused,
      grown,
      await events(),
      await audits(),
      alerts.map((a) => [a.name, a.message, { ...a }]),
      logs,
    ]);
    for (const secret of Object.values(SECRETS)) expect(outputs).not.toContain(secret);
  });
});
