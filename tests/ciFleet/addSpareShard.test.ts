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
  buildStacksInto,
  stubPoolDefinitionEnv,
  installAddShardGithub,
  newGithubWorld,
  type GithubWorld,
} from '../helpers/addShardFakes';
import { TEST_MANAGEMENT_KEY, stubAwsManagementCredential } from '../helpers/awsRunnerRoleFake';

// THE UNATTENDED ADD-SHARD (Story MOTIR-9362 · MOTIR-9460), against a real
// database for the rows and the audit entry, GitHub stubbed at `fetch`, the AWS
// management calls behind an in-memory organization and the network built by
// the pool-account definition's stack instance, seeded into the in-memory EC2
// and read back by the REAL `readAwsShardNetwork` (MOTIR-9845) — and its
// person-run caller, `addSpareShardByOperator` (MOTIR-10065).

const ec2FakePath = '../../packages/orchestrator/test/contract/awsEc2Fake';
interface Ec2Fake extends Ec2Api {
  failNext(method: keyof Ec2Api, code?: string, httpStatus?: number): void;
}
let AwsEc2Fake: new () => Ec2Fake;

const ORG = 'motir-fleet-use1-1';
const TEMPLATE = 'aws+{name}@motir.co';
const SECRETS = {
  installation: 'ghs_INSTALL_SECRET_never_printed',
  managementKey: TEST_MANAGEMENT_KEY.accessKeyId,
  managementSecret: TEST_MANAGEMENT_KEY.secretAccessKey,
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
let operatorId: string;

const OPERATOR = 'fleet-spare-operator@example.com';

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
  stubAwsManagementCredential();
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
  systemUserId = (await createTestUser({ email: MOTIR_SYSTEM_USER_EMAIL })).id;
  operatorId = (await createTestUser({ email: OPERATOR })).id;
  await adminDb.user.update({ where: { id: operatorId }, data: { platformRole: 'superadmin' } });
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

    // The pool-account definition's stack built the role (MOTIR-9845); the
    // step only confirms it by assuming it.
    expect(organization.calls).toContain(`ensureStackInstance:${accountId}`);
    expect(organization.calls).not.toContain(`ensureRunnerRole:${accountId}`);
    expect(organization.calls).toContain(`assumeRunnerRole:${accountId}`);
    expect(organization.calls).not.toContain('ensureRunnerIamUser');
    expect(result.steps.find((s) => s.step === 'runtime_credential')).toMatchObject({
      outcome: 'already',
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
    organization.stackInstanceFailure = new Error('the run died waiting for CURRENT');
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
    expect(organization.stackInstances.size).toBe(1);
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

// `fleet-admin add-spare` (MOTIR-10065): the same spare path, run by a person.
describe('addSpareShardByOperator', () => {
  const byOperator = (fleetKind = 'ci_runner', operatorEmail = OPERATOR, d = deps()) =>
    fleetShardProvisioningService.addSpareShardByOperator({ fleetKind, operatorEmail }, d);
  const refusal = async (promise: Promise<unknown>) => {
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetShardProvisioningRefusedError);
    return (err as FleetShardProvisioningRefusedError).problems.join('\n');
  };
  const spare = (name: string, state: 'provisioning' | 'active' | 'disabled', vcpuQuota = 5) =>
    fleetShardService.createShard({
      name,
      fleetKind: 'ci_runner',
      provider: 'aws',
      role: 'spare',
      state,
      githubOrg: ORG,
      githubInstallationId: '9001',
      awsAccountId: '777788889999',
      awsRegion: 'us-east-1',
      credentialRef: 'FLEET_SHARD_SPARE',
      limits: { vcpuQuota },
    });

  it('creates the kind’s spare through addSpareShard: derived name and email, the primary’s org and region, the raise filed', async () => {
    const addSpare = vi.spyOn(fleetShardProvisioningService, 'addSpareShard');
    const result = await byOperator();

    expect(addSpare).toHaveBeenCalledWith(
      { fleetKind: 'ci_runner', operatorEmail: OPERATOR },
      expect.anything(),
    );
    expect(creates()).toHaveLength(1);
    expect(organization.usedEmails).toEqual(new Set(['aws+ci-runner-pool-1@motir.co']));
    expect(result.shard).toMatchObject({
      name: 'ci-runner-pool-1',
      role: 'spare',
      state: 'provisioning',
      github: { org: ORG },
      aws: { region: 'us-east-1' },
    });
    expect(raises()).toEqual([`requestVcpuQuotaIncrease:${result.shard.aws!.accountId}:200`]);
    expect(result.pendingManualSteps).toEqual([]);
    addSpare.mockRestore();
  });

  it('records the operator as the audit actor, with a fleet-admin add-spare reason', async () => {
    const result = await byOperator();
    const audit = await adminDb.platformAuditLog.findFirstOrThrow({
      where: { action: 'fleet.shard.add', targetId: result.shard.id },
    });
    expect(audit.actorUserId).toBe(operatorId);
    expect(audit.reason).toBe('fleet-admin add-spare ci-runner-pool-1 (ci_runner on aws)');
  });

  it('leaves the growth path’s actor and reason as they were', async () => {
    const result = await fleetShardProvisioningService.addSpareShard(
      { fleetKind: 'ci_runner' },
      deps(),
    );
    const audit = await adminDb.platformAuditLog.findFirstOrThrow({
      where: { action: 'fleet.shard.add', targetId: result.shard.id },
    });
    expect(audit.actorUserId).toBe(systemUserId);
    expect(audit.reason).toMatch(/^pool growth: add spare ci-runner-pool-1/);
  });

  it('resumes the same account after an interruption between CreateAccount and the row', async () => {
    organization.stackInstanceFailure = new Error('the run died waiting for CURRENT');
    await expect(byOperator()).rejects.toBeTruthy();
    expect(creates()).toHaveLength(1);
    expect(await spareRows()).toHaveLength(0);

    const result = await byOperator();

    expect(creates()).toHaveLength(1);
    expect(result.shard.name).toBe('ci-runner-pool-1');
    expect(await spareRows()).toHaveLength(1);
  });

  it('resumes a provisioning spare whose raise was never filed', async () => {
    organization.requestFailure = new AwsManagementApiError(
      'service-quotas',
      'TooManyRequestsException',
      429,
    );
    const first = await byOperator();
    expect(first.steps.at(-1)).toMatchObject({ step: 'quota_raise', outcome: 'failed' });

    const second = await byOperator();
    expect(second.shard.id).toBe(first.shard.id);
    expect(second.steps.at(-1)).toMatchObject({ step: 'quota_raise', outcome: 'done' });
    expect(creates()).toHaveLength(1);
  });

  it('refuses a second run after it completed, naming the spare and its open raise, with no external call', async () => {
    await byOperator();
    const calls = organization.calls.length;
    const githubCalls = github.calls.length;

    const problems = await refusal(byOperator());

    expect(problems).toContain('ci-runner-pool-1 is in flight');
    expect(problems).toContain('its raise to 200 vCPU is pending and still open');
    expect(problems).toContain('fleet-admin disable --name ci-runner-pool-1');
    expect(organization.calls).toHaveLength(calls);
    expect(github.calls).toHaveLength(githubCalls);
    expect(await spareRows()).toHaveLength(1);
  });

  it('refuses a spare whose raise has closed', async () => {
    const { shard } = await byOperator();
    await adminDb.fleetQuotaRequest.updateMany({
      where: { shardId: shard.id },
      data: { status: 'denied', closedAt: new Date() },
    });
    expect(await refusal(byOperator())).toContain('its raise to 200 vCPU is denied and closed');
  });

  it('refuses a provisioning spare already at the target with no raise — the resume cannot pick it up', async () => {
    await spare('ci-runner-pool-7', 'provisioning', 200);
    const problems = await refusal(byOperator());
    expect(problems).toContain('ci-runner-pool-7 is in flight (provisioning; no raise was filed)');
    expect(creates()).toHaveLength(0);
  });

  it('refuses while the kind has a ready spare, naming it', async () => {
    await spare('ci-runner-pool-3', 'active', 200);
    const problems = await refusal(byOperator());
    expect(problems).toContain('ci_runner already has a ready spare: ci-runner-pool-3 (active');
    expect(organization.calls).toEqual([]);
  });

  it('refuses while a pool growth of the kind is unfinished, naming it', async () => {
    const primary = await fleetShardService.findShardByName('ci-runner-use1-1');
    const event = await adminDb.fleetGrowthEvent.create({
      data: {
        fleetKind: 'ci_runner',
        triggeringShardId: primary!.id,
        vcpuInUse: 450,
        grantedQuota: 640,
        outcome: 'waiting_for_quota',
      },
    });
    const problems = await refusal(byOperator());
    expect(problems).toContain(`a pool growth of ci_runner is unfinished (event ${event.id}`);
    expect(organization.calls).toEqual([]);
  });

  it('creates a new spare when the kind’s only spare is disabled', async () => {
    await spare('ci-runner-pool-1', 'disabled');
    const result = await byOperator();
    expect(result.shard.name).toBe('ci-runner-pool-2');
    expect(creates()).toHaveLength(1);
  });

  it('refuses a kind with no AWS primary — a Fly primary does not count — naming add-shard --provider aws', async () => {
    await adminDb.fleetShard.update({
      where: { name: 'ci-runner-use1-1' },
      data: { state: 'disabled' },
    });
    await adminDb.fleetShard.create({
      data: {
        name: 'ci-runner-fly-1',
        fleetKind: 'ci_runner',
        provider: 'fly',
        role: 'primary',
        state: 'active',
        githubOrg: 'motir-fly-org',
        githubInstallationId: '9001',
        flyOrg: 'motir',
        flyApp: 'motir-ci-runner-fly-1',
        flyRegion: 'iad',
        credentialRef: 'FLEET_SHARD_FLY_TEST',
        machineLimit: 4,
      },
    });
    const problems = await refusal(byOperator());
    expect(problems).toContain('ci_runner has no primary account on aws');
    expect(problems).toContain(
      'run fleet-admin add-shard --provider aws --fleet-kind ci_runner first',
    );
    expect(organization.calls).toEqual([]);
    expect(github.calls).toEqual([]);
  });

  it.each([
    ['unset', undefined],
    ['without {name}', 'aws@motir.co'],
  ])(
    'refuses with the email template %s, naming it, before any external call',
    async (_, value) => {
      const problems = await refusal(
        byOperator('ci_runner', OPERATOR, {
          ...deps(),
          env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: value },
        }),
      );
      expect(problems).toContain(AWS_MEMBER_EMAIL_TEMPLATE_ENV);
      expect(organization.calls).toEqual([]);
      expect(github.calls).toEqual([]);
    },
  );

  it('refuses an operator who is not a platform superadmin, and an unknown fleet kind', async () => {
    await adminDb.user.update({ where: { id: operatorId }, data: { platformRole: null } });
    expect(await refusal(byOperator())).toContain(`--operator ${OPERATOR} is not a superadmin`);
    expect(await refusal(byOperator('nope'))).toContain('--fleet-kind nope is not one of');
    expect(await refusal(byOperator(''))).toContain('--fleet-kind (none) is not one of');
    expect(organization.calls).toEqual([]);
  });
});
