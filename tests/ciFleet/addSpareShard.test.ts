import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AwsManagementApiError,
  type AwsSessionCredentials,
  type Ec2Api,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import {
  FleetShardAccountRefusedError,
  FleetShardProvisioningRefusedError,
} from '@/lib/ciFleet/errors';
import { AWS_MEMBER_EMAIL_TEMPLATE_ENV } from '@/lib/fleetShards/awsMemberAccountPlan';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import {
  fleetShardProvisioningService,
  type AddSpareShardDeps,
} from '@/lib/services/fleetShardProvisioningService';
import { fleetQuotaRequestService } from '@/lib/services/fleetQuotaRequestService';
import { fleetShardService } from '@/lib/services/fleetShardService';
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

// THE UNATTENDED ADD-SHARD (Story MOTIR-9362 · MOTIR-9460), against a real
// database for the rows and the audit entry, GitHub stubbed at `fetch`, the AWS
// management calls behind an in-memory organization and the network built by
// the REAL `ensureAwsShardNetwork` over the in-memory EC2.

const ec2FakePath = '../../packages/orchestrator/test/contract/awsEc2Fake';
interface Ec2Fake extends Ec2Api {
  failNext(method: keyof Ec2Api, code?: string, httpStatus?: number): void;
}
let AwsEc2Fake: new () => Ec2Fake;

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

let github: GithubWorld;
let organization: FakeOrganization;
let ec2: Ec2Fake;
let unregister: () => void;
let systemUserId: string;

const deps = (): AddSpareShardDeps => ({
  raise: { management: () => organization, now: () => new Date() },
  env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: TEMPLATE },
});

async function primaryAccount() {
  return fleetShardService.createShard({
    name: 'ci-runner-use1-1',
    fleetKind: 'ci_runner',
    provider: 'aws',
    state: 'active',
    githubOrg: ORG,
    githubInstallationId: '9001',
    awsAccountId: '111122223333',
    awsRegion: 'us-east-1',
    credentialRef: 'FLEET_SHARD_CI_RUNNER_USE1_1',
    limits: { vcpuQuota: 640 },
  });
}

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ ec2FakePath)) as {
    AwsEc2Fake: new () => Ec2Fake;
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
  systemUserId = (await createTestUser({ email: MOTIR_SYSTEM_USER_EMAIL })).id;
  await primaryAccount();
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

const spareRows = () =>
  adminDb.fleetShard.findMany({ where: { role: 'spare' }, orderBy: { createdAt: 'asc' } });
const creates = () => organization.calls.filter((c) => c === 'createOrganizationAccount');
const raises = () => organization.calls.filter((c) => c.startsWith('requestVcpuQuotaIncrease'));

describe('addSpareShard, given only a fleet kind', () => {
  it('creates one member account from the template and writes a provisioning spare', async () => {
    const result = await fleetShardProvisioningService.addSpareShard(
      { fleetKind: 'ci_runner' },
      deps(),
    );

    expect(creates()).toHaveLength(1);
    const account = organization.accounts.get('ci-runner-pool-1')!;
    expect(organization.usedEmails).toEqual(new Set(['aws+ci-runner-pool-1@motir.co']));

    expect(result.shard).toMatchObject({
      name: 'ci-runner-pool-1',
      fleetKind: 'ci_runner',
      role: 'spare',
      state: 'provisioning',
      provider: 'aws',
      aws: { accountId: account.accountId, region: 'us-east-1' },
      github: { org: ORG },
      limits: { vcpuQuota: 5 },
    });
    expect(result.shard.limitsSource.vcpuQuota).toBe('provider_read');
    expect(result.pendingManualSteps).toEqual([]);
  });

  it('takes the runtime credential from the runner role — no key read, minted or asked for', async () => {
    const result = await fleetShardProvisioningService.addSpareShard(
      { fleetKind: 'ci_runner' },
      deps(),
    );
    const accountId = result.shard.aws!.accountId;

    expect(organization.calls).toContain(`ensureRunnerRole:${accountId}`);
    expect(organization.calls).toContain(`assumeRunnerRole:${accountId}`);
    expect(organization.calls).not.toContain('ensureRunnerIamUser');
    expect(result.steps.find((s) => s.step === 'runtime_credential')).toMatchObject({
      outcome: 'done',
    });
  });

  it('files the kind’s raise once, at creation, and stores its AWS request id', async () => {
    const result = await fleetShardProvisioningService.addSpareShard(
      { fleetKind: 'ci_runner' },
      deps(),
    );

    expect(raises()).toEqual([`requestVcpuQuotaIncrease:${result.shard.aws!.accountId}:200`]);
    const [request] = await fleetQuotaRequestService.listByShard(result.shard.id);
    expect(request).toMatchObject({ desiredValue: 200, awsRequestId: 'quota-req-1' });
    expect(result.steps.at(-1)).toMatchObject({ step: 'quota_raise', outcome: 'done' });
  });

  it.each([
    ['hosted_agent', 32],
    ['agent_instance', 32],
    ['code_graph_index', 16],
  ] as const)('a %s spare asks for %d vCPU', async (kind, target) => {
    await fleetShardService.createShard({
      name: `${kind.replace(/_/g, '-')}-primary`,
      fleetKind: kind,
      provider: 'aws',
      state: 'active',
      githubOrg: ORG,
      githubInstallationId: '9001',
      awsAccountId: '444455556666',
      awsRegion: 'us-east-1',
      credentialRef: 'FLEET_SHARD_OTHER',
    });
    const result = await fleetShardProvisioningService.addSpareShard({ fleetKind: kind }, deps());
    expect(raises()).toEqual([`requestVcpuQuotaIncrease:${result.shard.aws!.accountId}:${target}`]);
  });

  it('audits the add as Motir’s system account, with the steps and no secret', async () => {
    const result = await fleetShardProvisioningService.addSpareShard(
      { fleetKind: 'ci_runner' },
      deps(),
    );
    const audit = await adminDb.platformAuditLog.findFirstOrThrow({
      where: { action: 'fleet.shard.add', targetId: result.shard.id },
    });
    expect(audit.actorUserId).toBe(systemUserId);

    const printed = JSON.stringify([result, audit, await adminDb.fleetQuotaRequest.findMany()]);
    for (const secret of Object.values(SECRETS)) expect(printed).not.toContain(secret);
  });

  it('a second spare of the kind is numbered past every existing name', async () => {
    await fleetShardProvisioningService.addSpareShard({ fleetKind: 'ci_runner' }, deps());
    const second = await fleetShardProvisioningService.addSpareShard(
      { fleetKind: 'ci_runner' },
      deps(),
    );
    expect(second.shard.name).toBe('ci-runner-pool-2');
    expect(creates()).toHaveLength(2);
  });
});

describe('resuming', () => {
  it('after an interruption following CreateAccount, finds the account and creates nothing twice', async () => {
    ec2.failNext('createVpc', 'RequestLimitExceeded', 503);
    await expect(
      fleetShardProvisioningService.addSpareShard({ fleetKind: 'ci_runner' }, deps()),
    ).rejects.toBeTruthy();
    expect(creates()).toHaveLength(1);
    expect(await spareRows()).toHaveLength(0);

    const result = await fleetShardProvisioningService.addSpareShard(
      { fleetKind: 'ci_runner' },
      deps(),
    );

    expect(creates()).toHaveLength(1);
    expect(result.shard.name).toBe('ci-runner-pool-1');
    expect(result.steps.find((s) => s.step === 'provider_account')!.outcome).toBe('already');
    expect(await spareRows()).toHaveLength(1);
    expect(raises()).toHaveLength(1);
  });

  it('a raise that fails to file leaves the account and row, reports a failed step, and the next run files it', async () => {
    organization.requestFailure = new AwsManagementApiError(
      'service-quotas',
      'TooManyRequestsException',
      429,
    );
    const first = await fleetShardProvisioningService.addSpareShard(
      { fleetKind: 'ci_runner' },
      deps(),
    );
    expect(first.steps.at(-1)).toMatchObject({ step: 'quota_raise', outcome: 'failed' });
    expect(first.steps.at(-1)!.detail).toContain('TooManyRequestsException');
    expect(await spareRows()).toHaveLength(1);
    expect(await adminDb.fleetQuotaRequest.count()).toBe(0);

    const second = await fleetShardProvisioningService.addSpareShard(
      { fleetKind: 'ci_runner' },
      deps(),
    );
    expect(second.shard.id).toBe(first.shard.id);
    expect(second.steps.at(-1)).toMatchObject({ step: 'quota_raise', outcome: 'done' });
    expect(creates()).toHaveLength(1);
    expect(await adminDb.fleetQuotaRequest.count()).toBe(1);
  });
});

describe('refusals', () => {
  it('AWS refusing CreateAccount is a typed refusal with AWS’s reason; no row, no raise', async () => {
    organization.createFailure = 'ACCOUNT_NUMBER_LIMIT_EXCEEDED';
    const err = await fleetShardProvisioningService
      .addSpareShard({ fleetKind: 'ci_runner' }, deps())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FleetShardAccountRefusedError);
    expect(err).toMatchObject({ reason: 'ACCOUNT_NUMBER_LIMIT_EXCEEDED' });
    expect(await spareRows()).toHaveLength(0);
    expect(raises()).toHaveLength(0);
  });

  it('an email clash is refused the same way', async () => {
    organization.usedEmails.add('aws+ci-runner-pool-1@motir.co');
    await expect(
      fleetShardProvisioningService.addSpareShard({ fleetKind: 'ci_runner' }, deps()),
    ).rejects.toMatchObject({ reason: 'EMAIL_ALREADY_EXISTS' });
  });

  it('refuses before any external call with no email template, or no primary account', async () => {
    await expect(
      fleetShardProvisioningService.addSpareShard(
        { fleetKind: 'ci_runner' },
        { ...deps(), env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: 'aws@motir.co' } },
      ),
    ).rejects.toBeInstanceOf(FleetShardProvisioningRefusedError);
    await expect(
      fleetShardProvisioningService.addSpareShard({ fleetKind: 'hosted_agent' }, deps()),
    ).rejects.toThrow(/no primary account/);
    expect(organization.calls).toEqual([]);
    expect(github.calls).toEqual([]);
  });
});
