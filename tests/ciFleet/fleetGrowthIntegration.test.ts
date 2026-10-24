import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AwsSessionCredentials, type Ec2Api } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { FleetShardAccountRefusedError } from '@/lib/ciFleet/errors';
import { PoolGrowthRefusedError } from '@/lib/ciFleet/headroomErrors';
import type { GrowthResult } from '@/lib/ciFleet/poolGrowthPolicy';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { AWS_MEMBER_EMAIL_TEMPLATE_ENV } from '@/lib/fleetShards/awsMemberAccountPlan';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import type { FleetHeadroomAlert } from '@/lib/monitoring/fleetShardHeadroomAlert';
import {
  fleetShardAdmissionService,
  SHARD_CAPACITY_DETAIL,
} from '@/lib/services/fleetShardAdmissionService';
import {
  fleetPoolGrowthPassService,
  type GrowthPassDeps,
  type GrowthPassSummary,
} from '@/lib/services/fleetPoolGrowthPassService';
import * as fleetPoolGrowthServiceExports from '@/lib/services/fleetPoolGrowthService';
import { fleetPoolGrowthService } from '@/lib/services/fleetPoolGrowthService';
import { fleetQuotaRaiseService } from '@/lib/services/fleetQuotaRaiseService';
import { fleetQuotaRequestService } from '@/lib/services/fleetQuotaRequestService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { runFleetAdmin } from '@/scripts/fleet/fleetAdmin';
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

// THE STORY'S INTEGRATION GATE (Story MOTIR-9362 · MOTIR-9464). Each sibling card
// tests its own piece; this file tests the ASSEMBLED seam they form — the live
// quota read → `growKind` → the unattended add-shard → the event, the audit row,
// the new spare and its filed raise — driven only through `runGrowthPass()`,
// admission's `chooseInTx` and the `fleet-admin` commands, against real Postgres.
// AWS is an in-memory organization, GitHub is stubbed at `fetch`, EC2 is the
// orchestrator's in-memory fake. Nothing else is mocked; the clock is injected.

const ec2FakePath = '../../packages/orchestrator/test/contract/awsEc2Fake';
let AwsEc2Fake: new () => Ec2Api;

const ORG = 'motir-fleet-use1-1';
const TEMPLATE = 'aws+{name}@motir.co';
const PRIMARY_ACCOUNT = '111122223333';
const SPARE_ACCOUNT = '444455556666';
const SECRETS = {
  installation: 'ghs_INSTALL_SECRET_never_printed',
  managementKey: 'AKIA_MANAGEMENT_never_printed',
  managementSecret: 'MANAGEMENT_SECRET_never_printed',
  sessionKeyId: 'ASIA_SESSION_never_printed',
  sessionSecret: 'SESSION_SECRET_never_printed',
  sessionToken: 'SESSION_TOKEN_never_printed',
};
/** Credential-shaped text the fake AWS puts in its reasons and errors. */
const LEAKED = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYzz',
  sessionToken: 'IQoJb3JpZ2luX2VjEHYaCXVzLWVhc3QtMSJHMEUCIQDexampleSessionTokenBody0123',
};
const SESSION: AwsSessionCredentials = {
  accessKeyId: SECRETS.sessionKeyId,
  secretAccessKey: SECRETS.sessionSecret,
  sessionToken: SECRETS.sessionToken,
  expiration: null,
};
const NOW = new Date('2026-10-24T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

let github: GithubWorld;
let organization: FakeOrganization;
let ec2: Ec2Api;
let unregister: () => void;
let primaryId: string;

let awsKinds: Set<string>;
let usage: Map<string, number>;
let alerts: FleetHeadroomAlert[];
let summaries: GrowthPassSummary[];
let growResults: GrowthResult[];
let logLines: string[];

const passDeps = (now: Date): GrowthPassDeps => ({
  now: () => now,
  onPool: async (kind) => awsKinds.has(kind),
  management: () => organization,
  growth: {
    addSpare: {
      raise: { management: () => organization, now: () => now },
      env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: TEMPLATE },
    },
  },
  readUsage: async () => [...usage].map(([shardId, usedVcpu]) => ({ shardId, usedVcpu })),
  alert: (alert) => void alerts.push(alert),
});

async function pass(now: Date = NOW): Promise<GrowthPassSummary> {
  const summary = await fleetPoolGrowthPassService.runGrowthPass(passDeps(now));
  summaries.push(summary);
  return summary;
}

const events = () => adminDb.fleetGrowthEvent.findMany({ orderBy: { createdAt: 'asc' } });
const growAudits = () =>
  adminDb.platformAuditLog.findMany({ where: { action: 'fleet.pool.grow' } });
const shard = (id: string) => adminDb.fleetShard.findUniqueOrThrow({ where: { id } });
const shards = (fleetKind = 'ci_runner') =>
  adminDb.fleetShard.findMany({ where: { fleetKind }, orderBy: { createdAt: 'asc' } });
const requestsFor = (shardId: string) => adminDb.fleetQuotaRequest.findMany({ where: { shardId } });
const creates = () => organization.calls.filter((c) => c === 'createOrganizationAccount');

/** A ready spare: active, 200 vCPU, its raise in `status`. */
async function spare(status: 'approved' | 'pending' = 'approved') {
  const row = await fleetShardService.createShard({
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
  const request = await fleetQuotaRequestService.createRequest({
    shardId: row.id,
    desiredValue: 200,
    awsRequestId: 'manual-req-1',
  });
  if (status === 'approved') {
    await fleetQuotaRequestService.recordRead(request.id, { status, grantedValue: 200 });
  }
  return row;
}

/** Approve every raise the fake AWS holds, as AWS would. */
function approveAll(): void {
  for (const [id, r] of organization.quotaRequests) {
    if (r.status === 'PENDING') organization.settleQuotaRequest(id, 'APPROVED');
  }
}

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ ec2FakePath)) as {
    AwsEc2Fake: new () => Ec2Api;
  });
});

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
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
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  github = newGithubWorld();
  github.orgs.add(ORG);
  organization = new FakeOrganization(SESSION);
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
  alerts = [];
  summaries = [];
  growResults = [];
  logLines = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  const grow = fleetPoolGrowthService.growKind.bind(fleetPoolGrowthService);
  vi.spyOn(fleetPoolGrowthService, 'growKind').mockImplementation(async (...args) => {
    const result = await grow(...args);
    growResults.push(result);
    return result;
  });
  // The primary's STORED quota is 100; what AWS grants it is set per case.
  primaryId = (
    await fleetShardService.createShard({
      name: 'ci-runner-use1-1',
      fleetKind: 'ci_runner',
      provider: 'aws',
      state: 'active',
      githubOrg: ORG,
      githubInstallationId: '9001',
      awsAccountId: PRIMARY_ACCOUNT,
      awsRegion: 'us-east-1',
      credentialRef: 'FLEET_SHARD_CI_RUNNER_USE1_1',
      limits: { vcpuQuota: 100 },
    })
  ).id;
  organization.quotaByAccount.set(PRIMARY_ACCOUNT, 100);
  usage = new Map([[primaryId, 80]]);
});

afterEach(async () => {
  wireFleetKindSwitch('ci_runner', null);
  vi.restoreAllMocks();
  unregister();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the live quota decides, through one pass', () => {
  it('at 36 of a LIVE 50 (72%) the stored 100 is overwritten and growth runs to the new spare and its raise', async () => {
    const ready = await spare('approved');
    organization.quotaByAccount.set(PRIMARY_ACCOUNT, 50);
    usage.set(primaryId, 36); // 36% of the stored 100 — only the live 50 crosses 70%

    const summary = await pass();

    expect(summary).toMatchObject({ ran: true, kinds: { ci_runner: 'grown' } });
    expect(await shard(primaryId)).toMatchObject({ vcpuQuota: 50 });

    const all = await events();
    expect(all).toHaveLength(1);
    const [event] = all;
    expect(event).toMatchObject({
      outcome: 'spare_promoted',
      triggeringShardId: primaryId,
      vcpuInUse: 36,
      grantedQuota: 50,
      spareShardId: ready.id,
    });
    expect(await growAudits()).toHaveLength(1);

    // The ready spare joined the shared pool…
    expect(await shard(ready.id)).toMatchObject({ role: 'primary', state: 'active' });
    // …and its replacement is a provisioning spare, named on the event, its root
    // email derived from the template, with exactly one raise filed at AWS.
    const replacement = await shard(event!.newShardId!);
    expect(replacement).toMatchObject({ role: 'spare', state: 'provisioning', provider: 'aws' });
    expect(organization.usedEmails).toEqual(
      new Set([TEMPLATE.replace('{name}', replacement.name)]),
    );
    const raises = await requestsFor(replacement.id);
    expect(raises).toHaveLength(1);
    expect(raises[0]!.awsRequestId).toMatch(/^quota-req-\d+$/);
    expect(organization.quotaRequests.get(raises[0]!.awsRequestId)).toMatchObject({
      accountId: replacement.awsAccountId,
      desiredValue: raises[0]!.desiredValue,
    });
  });

  it('at 34 of a LIVE 50 (68%) nothing grows, and the stored value still follows the live one', async () => {
    await spare('approved');
    organization.quotaByAccount.set(PRIMARY_ACCOUNT, 50);
    usage.set(primaryId, 34);

    const summary = await pass();

    expect(summary.kinds).toMatchObject({ ci_runner: 'below_threshold' });
    expect(await shard(primaryId)).toMatchObject({ vcpuQuota: 50 });
    expect(await events()).toEqual([]);
    expect(await growAudits()).toEqual([]);
    expect(creates()).toEqual([]);
  });

  it('an account whose live read fails is skipped and reported, and another account still triggers growth', async () => {
    const failing = await fleetShardService.createShard({
      name: 'ci-runner-use1-2',
      fleetKind: 'ci_runner',
      provider: 'aws',
      state: 'active',
      githubOrg: ORG,
      githubInstallationId: '9001',
      awsAccountId: '777788889999',
      awsRegion: 'us-east-1',
      credentialRef: 'FLEET_SHARD_CI_RUNNER_USE1_2',
      limits: { vcpuQuota: 1_000 },
    });
    organization.readFailures.set('777788889999', new Error('ThrottlingException'));
    // Above 70% of its stored 1000 — which must never be compared.
    usage.set(failing.id, 900);
    usage.set(primaryId, 10); // well under its live 100
    expect(
      (await pass()).kinds,
      'with only the failing account over 70%, nothing grows',
    ).toMatchObject({ ci_runner: 'below_threshold' });
    expect(growResults.at(-1)).toMatchObject({
      skipped: [{ shardId: failing.id, reason: expect.any(String) }],
    });
    expect(await events()).toEqual([]);

    usage.set(primaryId, 80);
    expect((await pass(minutes(1))).kinds).toMatchObject({ ci_runner: 'grown' });
    const [event] = await events();
    expect(event).toMatchObject({ triggeringShardId: primaryId, grantedQuota: 100 });
    expect(growResults.at(-1)).toMatchObject({
      skipped: [{ shardId: failing.id, reason: expect.any(String) }],
    });
    expect(await shard(failing.id)).toMatchObject({ vcpuQuota: 1_000 });
  });
});

describe('with no ready spare', () => {
  it('the new account takes no shared job until its raise is approved and a later pass settles it', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await seedTenant();

    expect((await pass()).kinds).toMatchObject({ ci_runner: 'grown' });
    const [event] = await events();
    expect(event).toMatchObject({ outcome: 'waiting_for_quota' });
    const newId = event!.newShardId!;
    expect(await shard(newId)).toMatchObject({ role: 'spare', state: 'provisioning' });
    expect(await selectionIds(fx.organizationId)).toEqual([primaryId]);

    approveAll();
    await pass(minutes(1));

    expect(await shard(newId)).toMatchObject({ role: 'primary', state: 'active' });
    const [settled] = await requestsFor(newId);
    expect(settled).toMatchObject({ status: 'approved' });
    expect(settled!.grantedValue).toBe(settled!.desiredValue);
    expect((await events())[0]).toMatchObject({ outcome: 'account_created', newShardId: newId });
    expect((await selectionIds(fx.organizationId)).sort()).toEqual([primaryId, newId].sort());
  });
});

describe('one growth at a time', () => {
  it('two concurrent passes, then five more above 70%, make one account, one raise and one event', async () => {
    const [a, b] = await Promise.all([pass(), pass()]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);

    for (let i = 1; i <= 5; i += 1) {
      expect((await pass(minutes(i))).kinds).toMatchObject({ ci_runner: 'in_flight' });
    }

    expect(creates()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
    expect(await growAudits()).toHaveLength(1);
    expect(await adminDb.fleetQuotaRequest.count()).toBe(1);
    expect(await shards()).toHaveLength(2);
  });
});

describe('a refused CreateAccount', () => {
  it('is one refused event, one audit row and one alert, changes no shard, and backs off', async () => {
    organization.createFailure = 'ACCOUNT_NUMBER_LIMIT_EXCEEDED';
    const before = await shards();

    expect((await pass()).kinds).toMatchObject({ ci_runner: 'refused' });
    const all = await events();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      outcome: 'refused',
      reason: expect.stringContaining('ACCOUNT_NUMBER_LIMIT_EXCEEDED'),
    });
    expect(await growAudits()).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toBeInstanceOf(PoolGrowthRefusedError);
    expect(await shards()).toEqual(before);
    expect(creates()).toHaveLength(1);

    // Inside the 30-minute backoff: no CreateAccount at all.
    expect((await pass(minutes(10))).kinds).toMatchObject({ ci_runner: 'backing_off' });
    expect(creates()).toHaveLength(1);

    // Past it, the pass tries again.
    expect((await pass(minutes(31))).kinds).toMatchObject({ ci_runner: 'refused' });
    expect(creates()).toHaveLength(2);
  });
});

describe('a kind on Fly', () => {
  it('gets no event, audit row, alert, row, raise or AWS call while ci_runner grows in the same pass', async () => {
    const indexer = await fleetShardService.createShard({
      name: 'code-graph-index-use1-1',
      fleetKind: 'code_graph_index',
      provider: 'aws',
      state: 'active',
      githubOrg: ORG,
      githubInstallationId: '9001',
      awsAccountId: '999900001111',
      awsRegion: 'us-east-1',
      credentialRef: 'FLEET_SHARD_CODE_GRAPH_INDEX_USE1_1',
      limits: { vcpuQuota: 100 },
    });
    organization.quotaByAccount.set('999900001111', 50);
    usage.set(indexer.id, 90);

    const summary = await pass();

    expect(summary.kinds).toMatchObject({ ci_runner: 'grown', code_graph_index: 'on_fly' });
    expect(await adminDb.fleetGrowthEvent.count({ where: { fleetKind: 'code_graph_index' } })).toBe(
      0,
    );
    expect(
      await adminDb.fleetQuotaRequest.count({ where: { fleetKind: 'code_graph_index' } }),
    ).toBe(0);
    expect(await shards('code_graph_index')).toEqual([await shard(indexer.id)]);
    expect(await shard(indexer.id)).toMatchObject({ vcpuQuota: 100 });
    expect(organization.calls.some((c) => c.includes('999900001111'))).toBe(false);
    expect(await growAudits()).toHaveLength(1); // ci_runner's
    expect(alerts).toEqual([]);
  });
});

describe('shared admission and the spares growth leaves behind', () => {
  it('never places a non-exempt org on a spare, defers shard_capacity when the primaries are full, and gives an exempt org the most headroom', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const ready = await spare('approved');
    await pass(); // promotes `ready`, creates its replacement
    const [event] = await events();
    const replacementId = event!.newShardId!;
    approveAll();
    usage.set(primaryId, 10); // below 70%: this pass only settles
    await pass(minutes(1)); // the replacement's raise is granted: it becomes the ready spare
    const replacement = await shard(replacementId);
    expect(replacement).toMatchObject({ role: 'spare', state: 'active' });
    // The two primaries hold one slot each; the spare holds its whole quota.
    for (const id of [primaryId, ready.id]) {
      await adminDb.fleetShard.update({ where: { id }, data: { admissionCeilingOverride: 1 } });
    }

    const fx = await seedTenant();
    const meta = await seedTenant();
    await adminDb.organization.update({
      where: { id: meta.organizationId },
      data: { isMeta: true },
    });

    const placed = await choose(fx.organizationId);
    expect([primaryId, ready.id]).toContain(placed.shardId);
    expect(await choose(meta.organizationId)).toEqual({ shardId: replacementId });

    // Fill both primaries: the non-exempt job defers rather than take the spare.
    for (const id of [primaryId, ready.id]) await seedRunningIntent(fx, id);
    expect(await choose(fx.organizationId)).toEqual({
      deferred: 'shard_capacity',
      detail: SHARD_CAPACITY_DETAIL,
    });
    expect(
      await adminDb.ciRunnerProvisioningIntent.count({ where: { fleetShardId: replacementId } }),
    ).toBe(0);
  });
});

describe('no secret reaches any sink', () => {
  it('across a refused growth, a failed member-role assumption, a full growth and the three commands', async () => {
    const operator = await usersService.createUser({
      email: 'fleet-growth-operator@example.com',
      password: 'hunter2hunter2',
      name: 'Operator',
    });
    await adminDb.user.update({
      where: { id: operator.id },
      data: { platformRole: 'superadmin' },
    });
    await spare('approved');

    // 1. AWS refuses CreateAccount with a reason that carries a key id.
    organization.createFailure = `ACCOUNT_NUMBER_LIMIT_EXCEEDED for ${LEAKED.accessKeyId}`;
    expect((await pass()).kinds).toMatchObject({ ci_runner: 'refused' });

    // 2. Past the backoff, a full growth — while assuming the promoted spare's
    //    member role fails with an error that carries a session token, so its
    //    live read is skipped with AWS's own text in hand.
    organization.createFailure = null;
    const assume = organization.assumeMemberRole.bind(organization);
    organization.assumeMemberRole = async (accountId: string) => {
      if (accountId === SPARE_ACCOUNT) {
        throw new Error(`AccessDenied: token ${LEAKED.sessionToken} expired`);
      }
      return assume(accountId);
    };
    expect((await pass(minutes(31))).kinds).toMatchObject({ ci_runner: 'grown' });
    expect(growResults.at(-1)).toMatchObject({
      skipped: [{ shardId: expect.any(String), reason: expect.any(String) }],
    });
    organization.assumeMemberRole = assume;

    // 3. The commands, one raise failing with a secret key in its error.
    const out: string[] = [];
    const io = { out: (l: string) => void out.push(l), err: (l: string) => void out.push(l) };
    const commandDeps = {
      raise: { management: () => organization, now: () => minutes(100) },
      status: {
        onPool: async (kind: string) => awsKinds.has(kind),
        now: () => minutes(100),
        readUsage: async () => [...usage].map(([shardId, usedVcpu]) => ({ shardId, usedVcpu })),
      },
    };
    organization.requestFailure = new Error(`Throttling: signature by ${LEAKED.secretKey}`);
    const names = (await shards())
      .filter((s) => s.role === 'primary')
      .map((s) => ['--name', s.name])
      .flat();
    const raiseCode = await runFleetAdmin(
      ['request-quota', ...names, '--vcpu', '4000', '--operator', operator.email],
      io,
      commandDeps,
    );
    expect(raiseCode).toBe(1); // one account failed, the other filed
    await runFleetAdmin(['pool-status', '--kind', 'ci_runner'], io, commandDeps);
    await runFleetAdmin(['growth-events', '--kind', 'ci_runner'], io, commandDeps);
    expect(out.some((l) => l.includes('failed:'))).toBe(true);

    // Every sink, gathered once.
    const sinks: Array<[string, unknown]> = [
      ['growth events', await adminDb.fleetGrowthEvent.findMany()],
      ['quota requests', await adminDb.fleetQuotaRequest.findMany()],
      [
        'audit rows',
        await adminDb.platformAuditLog.findMany({
          where: { action: { in: ['fleet.pool.grow', 'fleet.shard.quota_request'] } },
        }),
      ],
      ['alerts', alerts.map((a) => ({ name: a.name, message: a.message, fields: { ...a } }))],
      ['pass summaries (the job step record)', summaries],
      ['growth results', growResults],
      ['log lines', logLines],
      ['command output', out],
    ];
    expect(alerts.length).toBeGreaterThan(0);
    expect(
      await adminDb.platformAuditLog.count({ where: { action: 'fleet.shard.quota_request' } }),
    ).toBe(1);

    const seeded = [...Object.values(LEAKED), ...Object.values(SECRETS)];
    for (const [sink, value] of sinks) {
      const text = JSON.stringify(value);
      for (const secret of seeded) {
        expect(text.includes(secret), `${sink} carries ${secret}`).toBe(false);
      }
      expect(credentialKeys(value), `${sink} has a credential-named field`).toEqual([]);
    }
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** Every object key, at any depth, named for a credential. */
function credentialKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) credentialKeys(item, found);
  } else if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [key, inner] of Object.entries(value)) {
      if (/secret|token|password|accesskey|privatekey|credentials?$/i.test(key)) found.push(key);
      credentialKeys(inner, found);
    }
  }
  return found;
}

interface Tenant {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

let tenantSeq = 0;

async function seedTenant(): Promise<Tenant> {
  tenantSeq += 1;
  const user = await usersService.createUser({
    email: `fleet-growth-tenant-${tenantSeq}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Growth WS ${tenantSeq}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `G${100 + tenantSeq}`,
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

let jobSeq = 0;

async function seedRunningIntent(fx: Tenant, fleetShardId: string): Promise<void> {
  jobSeq += 1;
  await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(80_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: NOW,
      status: 'running',
      fleetShardId,
    },
  });
}

const choose = (organizationId: string) =>
  withSystemContext((tx) =>
    fleetShardAdmissionService.chooseInTx({ fleetKind: 'ci_runner', organizationId }, NOW, tx),
  );

const selectionIds = async (organizationId: string) =>
  (
    await withSystemContext((tx) =>
      fleetShardAdmissionService.selectionSetInTx({ fleetKind: 'ci_runner', organizationId }, tx),
    )
  ).map((s) => s.id);

// ── The arms the per-file coverage gate measures ─────────────────────────────
//
// The seam cases above reach most of the story's growth code. These reach the
// rest: refusal and validation arms, the production defaults the seam always
// injects, and the races the repositories exist to absorb. Arms deliberately
// left uncovered, and why:
// - `fleetShardQuotaService` / `fleetQuotaRaiseService`: an aws row with no
//   account or region (`MissingAwsLocation` on the live read) — the
//   `fleet_shard` CHECK makes it unstorable; the arm keeps the reader total.
// - The default `now` of the live read and of a raise: reached only with a real
//   management credential, which a test never holds (`fleetManagementApi()`
//   throws without one, as the case below shows).
// - `fleetQuotaRaiseService`'s rethrow of a non-staff lookup failure and
//   `failureText`'s non-Error arm: the staff lookup throws only its own typed
//   error or a database fault, and every filing failure is wrapped in a typed
//   error before it reaches the text.
// - `fleetGrowthEventService.recordRefused` / the pass's refusal alert naming a
//   trigger by id: the event's foreign key keeps the trigger row alive, so its
//   name is always found.
describe('the edges the per-file gate measures', () => {
  const flyShard = (name: string) =>
    adminDb.fleetShard.create({
      data: {
        name,
        fleetKind: 'ci_runner',
        provider: 'fly',
        role: 'primary',
        state: 'active',
        githubOrg: ORG,
        githubInstallationId: '9001',
        flyOrg: 'motir',
        flyApp: `motir-${name}`,
        flyRegion: 'iad',
        credentialRef: 'FLEET_SHARD_FLY_TEST',
        machineLimit: 4,
      },
    });
  const raiseDeps = { management: () => organization, now: () => NOW };

  it('the job runs one pass through its step', async () => {
    const { fleetPoolGrowth, FLEET_POOL_GROWTH_CRON } =
      await import('@/lib/jobs/definitions/fleetPoolGrowth');
    const runGrowthPass = vi.fn(async () => ({ ran: true }));
    const steps: string[] = [];
    const out = await fleetPoolGrowth.handler(
      {
        step: {
          run: (name: string, fn: () => unknown) => {
            steps.push(name);
            return fn();
          },
        },
      } as never,
      { fleetPoolGrowthPass: { runGrowthPass } } as never,
    );
    expect(FLEET_POOL_GROWTH_CRON).toBe('* * * * *');
    expect(steps).toEqual(['fleet-pool-growth']);
    expect(out).toEqual({ ran: true });
  });

  it('refuses an unset or malformed member email template, and a missing system account', async () => {
    const { memberEmailTemplateProblems } = await import('@/lib/fleetShards/awsMemberAccountPlan');
    const { fleetAutomationPrincipal } = await import('@/lib/fleetShards/fleetAutomationPrincipal');
    expect(memberEmailTemplateProblems(undefined)).toHaveLength(1);
    expect(memberEmailTemplateProblems('not an email {name}')).toHaveLength(1);
    await adminDb.user.deleteMany({ where: { email: MOTIR_SYSTEM_USER_EMAIL } });
    await expect(fleetAutomationPrincipal()).rejects.toThrow(/not provisioned/);
  });

  it('the repositories read outside the system context see nothing: the tables are system-only', async () => {
    const { fleetGrowthEventRepository } =
      await import('@/lib/repositories/fleetGrowthEventRepository');
    const { fleetQuotaRequestRepository } =
      await import('@/lib/repositories/fleetQuotaRequestRepository');
    const { fleetGrowthEventService } = await import('@/lib/services/fleetGrowthEventService');
    const ready = await spare('pending');
    const [request] = await requestsFor(ready.id);
    await fleetGrowthEventService.recordEvent({
      fleetKind: 'ci_runner',
      triggeringShardId: primaryId,
      vcpuInUse: 80,
      grantedQuota: 100,
      outcome: 'waiting_for_quota',
      quotaRequestId: request!.id,
    } as never);
    expect(await events()).toHaveLength(1);

    expect(await fleetGrowthEventRepository.listByKind('ci_runner', 5)).toEqual([]);
    expect(await fleetGrowthEventRepository.findLatestUnfinishedByKind('ci_runner')).toBeNull();
    expect(await fleetQuotaRequestRepository.findById(request!.id)).toBeNull();
    expect(
      await fleetQuotaRequestRepository.findOpenByShardAndCode(ready.id, request!.quotaCode),
    ).toBeNull();
    expect(await fleetQuotaRequestRepository.listOpen({ shardId: ready.id })).toEqual([]);
    expect(await fleetQuotaRequestRepository.listByShard(ready.id)).toEqual([]);
  });

  it('the request records refuse bad values, absorb a create race and keep a closed request closed', async () => {
    const ready = await spare('pending');
    const base = { shardId: ready.id, desiredValue: 300, awsRequestId: 'r' };
    await expect(
      fleetQuotaRequestService.createRequest({ ...base, quotaCode: '' }),
    ).rejects.toThrow();
    await expect(
      fleetQuotaRequestService.createRequest({ ...base, quotaCode: 'L-OTHER', awsRequestId: ' ' }),
    ).rejects.toThrow();
    await expect(fleetQuotaRequestService.getRequest('nope')).rejects.toThrow();
    await expect(
      fleetQuotaRequestService.recordRead('nope', { status: 'pending', grantedValue: null }),
    ).rejects.toThrow();
    const [open] = await requestsFor(ready.id);
    await expect(
      fleetQuotaRequestService.recordRead(open!.id, { status: 'approved', grantedValue: -1 }),
    ).rejects.toThrow();

    // Two creates for one account and code race past the read: one row, one answer.
    const raced = await Promise.all([
      fleetQuotaRequestService.createRequest({ ...base, quotaCode: 'L-RACE', awsRequestId: 'a' }),
      fleetQuotaRequestService.createRequest({ ...base, quotaCode: 'L-RACE', awsRequestId: 'a' }),
    ]);
    expect(raced[0].id).toBe(raced[1].id);

    // A closed request keeps the status that closed it.
    await fleetQuotaRequestService.recordRead(open!.id, { status: 'denied', grantedValue: null });
    expect(
      await fleetQuotaRequestService.recordRead(open!.id, {
        status: 'pending',
        grantedValue: null,
      }),
    ).toMatchObject({ status: 'denied' });
  });

  it('the event service refuses a negative figure', async () => {
    const { fleetGrowthEventService } = await import('@/lib/services/fleetGrowthEventService');
    await expect(
      fleetGrowthEventService.recordEvent({
        fleetKind: 'ci_runner',
        triggeringShardId: primaryId,
        vcpuInUse: -1,
        grantedQuota: 100,
        outcome: 'account_created',
      } as never),
    ).rejects.toThrow();
  });

  it('the live read without its seams: no credential fails every account, by class name only', async () => {
    const { fleetManagementApi, awsReasonOf, fleetShardQuotaService } =
      await import('@/lib/services/fleetShardQuotaService');
    vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', '');
    vi.stubEnv('AWS_ORG_ADMIN_SECRET_ACCESS_KEY', '');
    expect(() => fleetManagementApi()).toThrow();
    expect(awsReasonOf('not an error')).toBe('UnknownError');
    wireFleetKindSwitch('ci_runner', () => true);
    const [reading] = await fleetShardQuotaService.refreshLiveGrantedQuotas('ci_runner');
    expect(reading).toMatchObject({ shardId: primaryId, failure: expect.any(Error) });

    // A row whose limits source is not an object is rewritten, not merged.
    await adminDb.fleetShard.update({ where: { id: primaryId }, data: { limitsSource: [] } });
    organization.quotaByAccount.set(PRIMARY_ACCOUNT, 64);
    await fleetShardQuotaService.refreshLiveGrantedQuotas('ci_runner', {
      management: () => organization,
      onPool: async () => true,
      now: () => NOW,
    });
    expect(await shard(primaryId)).toMatchObject({ vcpuQuota: 64 });
  });

  it('the raise service refuses before AWS and reads a non-aws or shared-account request safely', async () => {
    const fly = await flyShard('fly-raise');
    await expect(fleetQuotaRaiseService.fileRaise(fly.id, 10, raiseDeps)).rejects.toThrow(
      /not an aws account/,
    );
    await expect(fleetQuotaRaiseService.fileRaise(primaryId, 0, raiseDeps)).rejects.toThrow(
      /not a count/,
    );
    // AWS answered without echoing the value: the stored one is the one asked for.
    const request = organization.requestVcpuQuotaIncrease.bind(organization);
    organization.requestVcpuQuotaIncrease = async (...args) => {
      const filed = await request(...args);
      return { ...filed, desiredValue: undefined as never };
    };
    expect(await fleetQuotaRaiseService.fileRaise(primaryId, 400, raiseDeps)).toMatchObject({
      desiredValue: 400,
    });
    organization.requestVcpuQuotaIncrease = request;

    // A fly row's request reads as MissingAwsLocation; two open requests on one
    // account share one member session.
    await fleetQuotaRequestService.createRequest({
      shardId: fly.id,
      desiredValue: 10,
      awsRequestId: 'fly-1',
    });
    await fleetQuotaRequestService.createRequest({
      shardId: primaryId,
      quotaCode: 'L-OTHER',
      desiredValue: 10,
      awsRequestId: 'quota-req-1',
    });
    const refreshed = await fleetQuotaRaiseService.refreshOpenRequests(undefined, raiseDeps);
    expect(refreshed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ shardId: fly.id, failure: expect.any(Error) }),
      ]),
    );
    expect(
      organization.calls.filter((c) => c === `assumeMemberRole:${PRIMARY_ACCOUNT}`),
    ).toHaveLength(
      2, // one for the filing, one shared by the two reads
    );

    // Without its seams, no credential: every open request fails its read.
    vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', '');
    const unread = await fleetQuotaRaiseService.refreshOpenRequests();
    expect(unread.every((r) => 'failure' in r)).toBe(true);
  });

  it('the commands refuse bad flags and print empty sections', async () => {
    const out: string[] = [];
    const io = { out: (l: string) => void out.push(l), err: (l: string) => void out.push(l) };
    const deps = {
      raise: raiseDeps,
      status: { onPool: async () => true, now: () => NOW, readUsage: async () => [] },
    };
    expect(await runFleetAdmin(['request-quota', '--vcpu', 'x'], io, deps)).toBe(1);
    expect(await runFleetAdmin(['request-quota', '--vcpu', '10'], io, deps)).toBe(1);
    expect(
      await runFleetAdmin(
        ['request-quota', '--name', 'a', '--vcpu', '10', '--code', 'L-X', '--operator', ''],
        io,
        deps,
      ),
    ).toBe(1);
    expect(await runFleetAdmin(['growth-events'], io, deps)).toBe(1);
    expect(await runFleetAdmin(['growth-events', '--kind', 'hosted_agent'], io, deps)).toBe(0);
    expect(await runFleetAdmin(['pool-status', '--kind', 'hosted_agent'], io, deps)).toBe(0);
    expect(out.join('\n')).toMatch(/\(none\)/);
    expect(out).toContain('hosted_agent: no growth events');
    expect(out.filter((l) => l.trim() === 'none')).toHaveLength(3);
  });

  it('pool-status without its seams reads the switch and the headroom, and names a foreign shard by id', async () => {
    const { fleetPoolStatusService } = await import('@/lib/services/fleetPoolStatusService');
    const { fleetGrowthEventService } = await import('@/lib/services/fleetGrowthEventService');
    await expect(fleetPoolStatusService.getPoolStatus('nope')).rejects.toThrow();
    expect(await fleetPoolStatusService.getPoolStatus('ci_runner')).toEqual([
      { fleetKind: 'ci_runner', onPool: false },
    ]);
    const other = await fleetShardService.createShard({
      name: 'hosted-agent-use1-1',
      fleetKind: 'hosted_agent',
      provider: 'aws',
      state: 'active',
      githubOrg: ORG,
      githubInstallationId: '9001',
      awsAccountId: '121212121212',
      awsRegion: 'us-east-1',
      credentialRef: 'FLEET_SHARD_HOSTED_AGENT_USE1_1',
      limits: { vcpuQuota: 100 },
    });
    await fleetGrowthEventService.recordEvent({
      fleetKind: 'ci_runner',
      triggeringShardId: primaryId,
      vcpuInUse: 80,
      grantedQuota: 100,
      outcome: 'account_created',
      newShardId: other.id,
    } as never);
    const [event] = await fleetPoolStatusService.listGrowthEvents('ci_runner');
    expect(event).toMatchObject({ newAccount: other.id });
  });

  it('the pass without its seams; a refresh that throws is counted and the kinds still run', async () => {
    expect((await fleetPoolGrowthPassService.runGrowthPass()).kinds).toMatchObject({
      ci_runner: 'on_fly',
    });

    const { fleetShardQuotaService } = await import('@/lib/services/fleetShardQuotaService');
    const { fleetQuotaRaiseService: raise } = await import('@/lib/services/fleetQuotaRaiseService');
    vi.spyOn(fleetShardQuotaService, 'refreshLiveGrantedQuotas').mockRejectedValueOnce('down');
    vi.spyOn(raise, 'refreshOpenRequests').mockRejectedValueOnce(new Error('down'));
    const { readUsage: _injected, ...rest } = passDeps(NOW);
    const summary = await fleetPoolGrowthPassService.runGrowthPass(rest);
    expect(summary).toMatchObject({ failures: 2, kinds: { ci_runner: 'below_threshold' } });
    expect(logLines.join('\n')).toMatch(/UnknownError/);
  });

  it('picks the most loaded account by ratio, whichever order the accounts come in', async () => {
    const accounts = [
      ['ci-runner-use1-2', '555500001111', 20],
      ['ci-runner-use1-3', '555500002222', 90],
    ] as const;
    for (const [name, accountId, used] of accounts) {
      const row = await fleetShardService.createShard({
        name,
        fleetKind: 'ci_runner',
        provider: 'aws',
        state: 'active',
        githubOrg: ORG,
        githubInstallationId: '9001',
        awsAccountId: accountId,
        awsRegion: 'us-east-1',
        credentialRef: `FLEET_SHARD_${name.toUpperCase().replaceAll('-', '_')}`,
        limits: { vcpuQuota: 100 },
      });
      organization.quotaByAccount.set(accountId, 100);
      usage.set(row.id, used);
    }
    await pass();
    expect((await events())[0]).toMatchObject({ vcpuInUse: 90 });
  });

  it('a spare is ready only when it holds a quota and is not disabled', () => {
    const { spareReady } = fleetPoolGrowthServiceExports;
    expect(spareReady({ state: 'disabled', vcpuQuota: 100, fleetKind: 'ci_runner' }, null)).toBe(
      false,
    );
    expect(spareReady({ state: 'active', vcpuQuota: null, fleetKind: 'ci_runner' }, null)).toBe(
      false,
    );
  });

  it.each([
    ['an account refusal', () => new FleetShardAccountRefusedError('acct', 'EMAIL_ALREADY_EXISTS')],
    ['a reason-bearing error', () => Object.assign(new Error('x'), { reason: 'SOME_REASON' })],
    ['a plain error', () => new TypeError('boom')],
    ['a thrown string', () => 'boom'],
  ])('a refused add-shard records %s as text', async (_label, error) => {
    const { fleetShardProvisioningService } =
      await import('@/lib/services/fleetShardProvisioningService');
    vi.spyOn(fleetShardProvisioningService, 'addSpareShard').mockRejectedValueOnce(error());
    expect((await pass()).kinds).toMatchObject({ ci_runner: 'refused' });
    expect((await events())[0]!.reason).toMatch(
      /EMAIL_ALREADY_EXISTS|SOME_REASON|TypeError|UnknownError/,
    );
  });

  it('a growth whose raise could not be filed is account_created, with the reason', async () => {
    organization.requestFailure = new Error('Throttling');
    expect((await pass()).kinds).toMatchObject({ ci_runner: 'grown' });
    expect((await events())[0]).toMatchObject({
      outcome: 'account_created',
      quotaRequestId: null,
      reason: expect.stringMatching(/^quota raise not filed/),
    });
  });

  it('growKind and settleGrantedSpares refuse an unknown kind and default to the switch', async () => {
    await expect(
      fleetPoolGrowthService.growKind('nope', { liveQuotas: [], usage: [] }),
    ).rejects.toThrow();
    await expect(fleetPoolGrowthService.settleGrantedSpares('nope')).rejects.toThrow();
    expect(
      await fleetPoolGrowthService.growKind('ci_runner', { liveQuotas: [], usage: [] }),
    ).toMatchObject({ result: 'not_aws' });
    expect(await fleetPoolGrowthService.settleGrantedSpares('ci_runner')).toMatchObject({
      joined: [],
      readied: [],
    });
  });

  it('settling skips a spare with no raise, leaves a granted one beside a ready spare, and yields to a held lock', async () => {
    await spare('approved'); // the kind's ready spare
    const extra = async (name: string, accountId: string) =>
      fleetShardService.createShard({
        name,
        fleetKind: 'ci_runner',
        provider: 'aws',
        role: 'spare',
        state: 'provisioning',
        githubOrg: ORG,
        githubInstallationId: '9001',
        awsAccountId: accountId,
        awsRegion: 'us-east-1',
        credentialRef: `FLEET_SHARD_${accountId}`,
        limits: { vcpuQuota: 200 },
      });
    const bare = await extra('ci-runner-spare-bare', '666600001111');
    const granted = await extra('ci-runner-spare-granted', '666600002222');
    const request = await fleetQuotaRequestService.createRequest({
      shardId: granted.id,
      desiredValue: 200,
      awsRequestId: 'granted-1',
    });
    await fleetQuotaRequestService.recordRead(request.id, {
      status: 'approved',
      grantedValue: 200,
    });

    const onPool = async () => true;
    expect(await fleetPoolGrowthService.settleGrantedSpares('ci_runner', { onPool })).toMatchObject(
      { joined: [], readied: [] },
    );
    expect(await shard(bare.id)).toMatchObject({ state: 'provisioning' });
    expect(await shard(granted.id)).toMatchObject({ state: 'provisioning' });

    // Another settler holds the kind's lock: this one stands aside.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const taken = new Promise<void>((r) => (locked = r));
    const holder = adminDb.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended('fleet_growth:ci_runner', 0))`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await taken;
    expect(await fleetPoolGrowthService.settleGrantedSpares('ci_runner', { onPool })).toMatchObject(
      { locked: true },
    );
    release();
    await holder;
  });
});
