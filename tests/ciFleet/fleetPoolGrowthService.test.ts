import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AwsSessionCredentials, type Ec2Api } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import { LiveQuotaReadFailedError } from '@/lib/ciFleet/errors';
import { crossesGrowthThreshold, GROWTH_CLAIM_STALE_MS } from '@/lib/ciFleet/poolGrowthPolicy';
import { AWS_MEMBER_EMAIL_TEMPLATE_ENV } from '@/lib/fleetShards/awsMemberAccountPlan';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { fleetGrowthEventService } from '@/lib/services/fleetGrowthEventService';
import {
  fleetPoolGrowthService,
  type FleetPoolGrowthDeps,
  type GrowthReading,
} from '@/lib/services/fleetPoolGrowthService';
import { fleetQuotaRaiseService } from '@/lib/services/fleetQuotaRaiseService';
import { fleetQuotaRequestService } from '@/lib/services/fleetQuotaRequestService';
import { fleetShardService } from '@/lib/services/fleetShardService';
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

// ONE POOL GROWTH (Story MOTIR-9362 · MOTIR-9461), against a real database for
// the rows, the claim, the event and the audit entry, and the REAL unattended
// add-shard underneath — GitHub stubbed at `fetch`, the AWS management calls
// behind an in-memory organization, the network over the in-memory EC2.

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
let onPool: boolean;

const deps = (now: Date = NOW): FleetPoolGrowthDeps => ({
  onPool: async () => onPool,
  now: () => now,
  addSpare: {
    raise: { management: () => organization, now: () => now },
    env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: TEMPLATE },
  },
});

/** This pass's figures: the primary at `inUse` of a live `granted`. */
const reading = (inUse: number, granted = 100): GrowthReading => ({
  liveQuotas: [{ shardId: primaryId, fleetKind: 'ci_runner', granted, changed: false }],
  usage: [{ shardId: primaryId, usedVcpu: inUse }],
});

const creates = () => organization.calls.filter((c) => c === 'createOrganizationAccount');
const raises = () => organization.calls.filter((c) => c.startsWith('requestVcpuQuotaIncrease'));
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

/** Approve every filed raise, as AWS would, and read it back. */
async function approveFiledRaises() {
  for (const id of [...organization.quotaRequests.keys()]) {
    organization.settleQuotaRequest(id, 'APPROVED');
  }
  await fleetQuotaRaiseService.refreshOpenRequests('ci_runner', {
    management: () => organization,
    now: () => NOW,
  });
}

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
  onPool = true;
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
      // The STORED value — the decision must never read it.
      limits: { vcpuQuota: 640 },
    })
  ).id;
});

afterEach(() => {
  unregister();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('crossesGrowthThreshold', () => {
  it('is exactly 70% on integers', () => {
    expect(crossesGrowthThreshold(70, 100)).toBe(true);
    expect(crossesGrowthThreshold(69, 100)).toBe(false);
    expect(crossesGrowthThreshold(7, 10)).toBe(true);
    expect(crossesGrowthThreshold(140, 200)).toBe(true);
    expect(crossesGrowthThreshold(139, 200)).toBe(false);
    // A fractional reading rounds up — never under the line.
    expect(crossesGrowthThreshold(69.5, 100)).toBe(true);
  });
});

describe('growKind — the trigger', () => {
  it('at 69% answers below_threshold and writes nothing', async () => {
    const result = await fleetPoolGrowthService.growKind('ci_runner', reading(69), deps());

    expect(result).toEqual({ result: 'below_threshold', fleetKind: 'ci_runner', skipped: [] });
    expect(await events()).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(organization.calls).toEqual([]);
  });

  it('at exactly 70% of the LIVE granted quota grows — the stored 640 is ignored', async () => {
    const result = await fleetPoolGrowthService.growKind('ci_runner', reading(70), deps());

    expect(result).toMatchObject({
      result: 'grown',
      outcome: 'waiting_for_quota',
      triggeringShardId: primaryId,
      vcpuInUse: 70,
      grantedQuota: 100,
      promotedSpareId: null,
    });
    expect(creates()).toHaveLength(1);
  });

  it('skips and reports an account whose live read failed, never comparing a stored quota', async () => {
    const result = await fleetPoolGrowthService.growKind(
      'ci_runner',
      {
        liveQuotas: [
          {
            shardId: primaryId,
            fleetKind: 'ci_runner',
            failure: new LiveQuotaReadFailedError(primaryId, 'ci-runner-use1-1', 'AccessDenied'),
          },
        ],
        usage: [{ shardId: primaryId, usedVcpu: 600 }],
      },
      deps(),
    );

    expect(result).toEqual({
      result: 'below_threshold',
      fleetKind: 'ci_runner',
      skipped: [{ shardId: primaryId, reason: 'AccessDenied' }],
    });
    expect(organization.calls).toEqual([]);
  });

  it('an account with no live reading this pass is skipped too', async () => {
    const result = await fleetPoolGrowthService.growKind(
      'ci_runner',
      { liveQuotas: [], usage: [{ shardId: primaryId, usedVcpu: 600 }] },
      deps(),
    );
    expect(result).toMatchObject({
      result: 'below_threshold',
      skipped: [{ shardId: primaryId, reason: 'no live quota read this pass' }],
    });
  });

  it('a kind still on Fly answers not_aws and touches nothing', async () => {
    onPool = false;
    const result = await fleetPoolGrowthService.growKind('ci_runner', reading(99), deps());

    expect(result).toMatchObject({ result: 'not_aws', fleetKind: 'ci_runner' });
    expect(result.result === 'not_aws' && result.error.code).toBe('GROWTH_KIND_NOT_AWS');
    expect(await events()).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(await adminDb.fleetShard.count()).toBe(1);
    expect(organization.calls).toEqual([]);
  });
});

describe('growKind — promote or create', () => {
  it('promotes a READY spare into the shared pool and creates its replacement', async () => {
    const spare = await spareWithRaise('approved');

    const result = await fleetPoolGrowthService.growKind('ci_runner', reading(80), deps());

    expect(result).toMatchObject({
      result: 'grown',
      outcome: 'spare_promoted',
      promotedSpareId: spare.id,
    });
    expect(await shard(spare.id)).toMatchObject({ role: 'primary', state: 'active' });
    // In a non-exempt org's selection set from the next admission.
    const shared = await withSystemContext((tx) =>
      fleetShardRepository.listActiveForKindInTx('ci_runner', ['primary'], tx),
    );
    expect(shared.map((s) => s.id)).toContain(spare.id);

    const newShardId = result.result === 'grown' ? result.newShardId : '';
    expect(await shard(newShardId)).toMatchObject({ role: 'spare', state: 'provisioning' });
    const [event] = await events();
    expect(event).toMatchObject({
      outcome: 'spare_promoted',
      spareShardId: spare.id,
      newShardId,
      triggeringShardId: primaryId,
      vcpuInUse: 80,
      grantedQuota: 100,
    });
    expect(await events()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it('a person-made spare with no raise is ready when active at the kind’s target', async () => {
    const spare = await spareWithRaise(null);
    const result = await fleetPoolGrowthService.growKind('ci_runner', reading(80), deps());
    expect(result).toMatchObject({ outcome: 'spare_promoted', promotedSpareId: spare.id });
  });

  it.each(['denied', 'not_approved'])(
    'never promotes a spare whose raise is %s — the next account is created',
    async (status) => {
      const spare = await spareWithRaise(status, 'provisioning');

      const result = await fleetPoolGrowthService.growKind('ci_runner', reading(80), deps());

      expect(result).toMatchObject({
        result: 'grown',
        outcome: 'waiting_for_quota',
        promotedSpareId: null,
      });
      expect(await shard(spare.id)).toMatchObject({ role: 'spare', state: 'provisioning' });
      expect(creates()).toHaveLength(1);
    },
  );

  it('never promotes a spare whose raise is pending — it is a growth in flight', async () => {
    const spare = await spareWithRaise('pending', 'provisioning');

    const result = await fleetPoolGrowthService.growKind('ci_runner', reading(80), deps());

    expect(result).toMatchObject({ result: 'in_flight' });
    expect(await shard(spare.id)).toMatchObject({ role: 'spare' });
    expect(creates()).toHaveLength(0);
  });

  it('with no ready spare the new account joins the pool only once its raise is approved', async () => {
    const grown = await fleetPoolGrowthService.growKind('ci_runner', reading(80), deps());
    const newShardId = grown.result === 'grown' ? grown.newShardId : '';
    expect(grown).toMatchObject({ outcome: 'waiting_for_quota' });
    expect(await shard(newShardId)).toMatchObject({ role: 'spare', state: 'provisioning' });

    // Before the raise is granted, settling changes nothing.
    expect(await fleetPoolGrowthService.settleGrantedSpares('ci_runner', deps())).toMatchObject({
      joined: [],
      readied: [],
    });

    await approveFiledRaises();
    const settled = await fleetPoolGrowthService.settleGrantedSpares('ci_runner', deps());

    expect(settled.joined).toEqual([
      { shardId: newShardId, eventId: grown.result === 'grown' ? grown.eventId : '' },
    ]);
    expect(await shard(newShardId)).toMatchObject({
      role: 'primary',
      state: 'active',
      vcpuQuota: 200,
    });
    const [event] = await events();
    expect(event).toMatchObject({ outcome: 'account_created', newShardId });
    expect(await audits()).toHaveLength(1);
  });

  it('a replacement spare becomes the kind’s ready spare once its raise is approved', async () => {
    await spareWithRaise('approved');
    const grown = await fleetPoolGrowthService.growKind('ci_runner', reading(80), deps());
    const replacement = grown.result === 'grown' ? grown.newShardId : '';

    await approveFiledRaises();
    const settled = await fleetPoolGrowthService.settleGrantedSpares('ci_runner', deps());

    expect(settled).toMatchObject({ joined: [], readied: [replacement] });
    expect(await shard(replacement)).toMatchObject({ role: 'spare', state: 'active' });
    expect((await events())[0]).toMatchObject({ outcome: 'spare_promoted' });
  });
});

describe('growKind — one growth in flight', () => {
  it('repeated calls while a growth waits on its raise create, file and write nothing more', async () => {
    const first = await fleetPoolGrowthService.growKind('ci_runner', reading(80), deps());
    const again = await fleetPoolGrowthService.growKind('ci_runner', reading(95), deps());
    const third = await fleetPoolGrowthService.growKind('ci_runner', reading(99), deps());

    expect(again).toMatchObject({
      result: 'in_flight',
      eventId: first.result === 'grown' ? first.eventId : 'x',
    });
    expect(third).toMatchObject({ result: 'in_flight' });
    expect(creates()).toHaveLength(1);
    expect(raises()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it('two concurrent calls produce exactly one growth', async () => {
    const results = await Promise.all([
      fleetPoolGrowthService.growKind('ci_runner', reading(80), deps()),
      fleetPoolGrowthService.growKind('ci_runner', reading(80), deps()),
    ]);

    expect(results.map((r) => r.result).sort()).toEqual(['grown', 'in_flight']);
    expect(creates()).toHaveLength(1);
    expect(raises()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it('a fresh unsettled claim holds the kind; a stale one no longer does', async () => {
    const claim = await adminDb.fleetGrowthEvent.create({
      data: {
        fleetKind: 'ci_runner',
        triggeringShardId: primaryId,
        vcpuInUse: 80,
        grantedQuota: 100,
        outcome: 'waiting_for_quota',
        createdAt: new Date(NOW.getTime() - GROWTH_CLAIM_STALE_MS + 60_000),
      },
    });
    expect(await fleetGrowthEventService.hasUnfinishedGrowth('ci_runner', NOW)).toBe(true);
    expect(await fleetPoolGrowthService.growKind('ci_runner', reading(80), deps())).toMatchObject({
      result: 'in_flight',
      eventId: claim.id,
    });

    const later = new Date(NOW.getTime() + 2 * 60_000);
    expect(await fleetGrowthEventService.hasUnfinishedGrowth('ci_runner', later)).toBe(false);
    expect(
      await fleetPoolGrowthService.growKind('ci_runner', reading(80), deps(later)),
    ).toMatchObject({ result: 'grown' });
    expect(creates()).toHaveLength(1);
  });
});

describe('growKind — a refused create', () => {
  it('returns AWS’s reason and the promoted spare, writes no row and releases the claim', async () => {
    const spare = await spareWithRaise('approved');
    organization.createFailure = 'ACCOUNT_NUMBER_LIMIT_EXCEEDED';

    const result = await fleetPoolGrowthService.growKind('ci_runner', reading(80), deps());

    expect(result).toMatchObject({
      result: 'refused',
      reason: 'ACCOUNT_NUMBER_LIMIT_EXCEEDED',
      promotedSpareId: spare.id,
      triggeringShardId: primaryId,
    });
    // The promotion stands; no new account row; the claim is gone.
    expect(await shard(spare.id)).toMatchObject({ role: 'primary', state: 'active' });
    expect(await adminDb.fleetShard.count()).toBe(2);
    expect(await events()).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(raises()).toEqual([]);
    expect(await fleetGrowthEventService.hasUnfinishedGrowth('ci_runner', NOW)).toBe(false);
  });
});

describe('no secret leaves the growth', () => {
  it('appears in no result, event, audit row or log line', async () => {
    const logs: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void logs.push(args));
    }
    await spareWithRaise('approved');
    const grown = await fleetPoolGrowthService.growKind('ci_runner', reading(80), deps());
    organization.createFailure = 'ACCOUNT_NUMBER_LIMIT_EXCEEDED';
    await approveFiledRaises();
    await fleetPoolGrowthService.settleGrantedSpares('ci_runner', deps());
    const refused = await fleetPoolGrowthService.growKind('ci_runner', reading(80), deps());

    const outputs = JSON.stringify([grown, refused, await events(), await audits(), logs]);
    for (const secret of Object.values(SECRETS)) expect(outputs).not.toContain(secret);
    vi.restoreAllMocks();
  });
});
