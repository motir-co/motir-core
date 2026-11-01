import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AwsManagementApiError,
  type AwsSessionCredentials,
  type Ec2Api,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { AWS_MEMBER_EMAIL_TEMPLATE_ENV } from '@/lib/fleetShards/awsMemberAccountPlan';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { EXIT_ERROR, EXIT_OK, EXIT_PENDING, runFleetAdmin } from '@/scripts/fleet/fleetAdmin';
import type { FleetAdminPoolDeps } from '@/scripts/fleet/fleetAdminPoolCommands';
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

// `fleet-admin add-spare` (MOTIR-10065), through the command: a real database,
// GitHub stubbed at `fetch`, AWS behind the in-memory organization and EC2 the
// unattended add-shard's own suite uses. The kind's switch is still on Fly when
// the spare is made; `pool-status` is read once the kind is switched.

const ec2FakePath = '../../packages/orchestrator/test/contract/awsEc2Fake';
let AwsEc2Fake: new () => Ec2Api;

const ORG = 'motir-fleet-use1-1';
const OPERATOR = 'fleet-add-spare-operator@example.com';
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
let ec2: Ec2Api;
let unregister: () => void;
let onPool: boolean;
let template: string | undefined;

const deps = (): FleetAdminPoolDeps => ({
  addSpare: {
    raise: { management: () => organization, now: () => new Date() },
    env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: template },
  },
  status: { onPool: async () => onPool, now: () => new Date(), readUsage: async () => [] },
});

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

const addSpare = () => run('add-spare', '--fleet-kind', 'ci_runner', '--operator', OPERATOR);
const awsCalls = () => organization.calls.length;

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
  stubAwsManagementCredential();
  stubPoolDefinitionEnv();
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  github = newGithubWorld();
  github.orgs.add(ORG);
  organization = new FakeOrganization(SESSION);
  buildStacksInto(organization, () => ec2);
  organization.quota = 5;
  ec2 = new AwsEc2Fake();
  installAddShardGithub(github, SECRETS.installation);
  unregister = registerShardProvisioningProvider(
    createAwsShardProvisioningProvider({
      management: () => organization,
      ec2: () => ec2,
      env: () => process.env,
    }),
  );
  onPool = false;
  template = 'aws+{name}@motir.co';
  const operator = await createTestUser({ email: OPERATOR });
  await adminDb.user.update({ where: { id: operator.id }, data: { platformRole: 'superadmin' } });
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
    limits: { vcpuQuota: 640 },
  });
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

describe('fleet-admin add-spare', () => {
  it('makes the kind’s spare while it is still on Fly, one line per step, and exits 0', async () => {
    const { code, out, err } = await addSpare();

    expect(err).toBe('');
    expect(code).toBe(EXIT_OK);
    for (const step of ['preflight', 'provider_account', 'account_row', 'quota_raise']) {
      expect(out).toMatch(new RegExp(`^${step}\\s+(done|already) — `, 'm'));
    }
    expect(out).toContain('account ci-runner-pool-1 (ci_runner) is provisioning');
    expect(out).toContain('filed a raise to 200 vCPU');
  });

  it('then pool-status, once the kind is switched, lists its primary and the new spare', async () => {
    expect((await addSpare()).code).toBe(EXIT_OK);
    onPool = true;

    const { code, out } = await run('pool-status', '--kind', 'ci_runner');

    expect(code).toBe(EXIT_OK);
    expect(out).toMatch(/^ {4}ci-runner-use1-1 {2}active/m);
    expect(out).toMatch(/^ {4}ci-runner-pool-1 {2}spare {2}provisioning {2}quota 5$/m);
  });

  it('refuses a second run with exit 1, naming the spare and its open raise, and calls no AWS', async () => {
    await addSpare();
    const before = awsCalls();

    const { code, out, err } = await addSpare();

    expect(code).toBe(EXIT_ERROR);
    expect(out).toBe('');
    expect(err).toMatch(/^refused:\n {2}- ci_runner's spare ci-runner-pool-1 is in flight/);
    expect(err).toContain('its raise to 200 vCPU is pending and still open');
    expect(awsCalls()).toBe(before);
  });

  it('refuses with exit 1, naming the template, when it is unset', async () => {
    template = undefined;
    const { code, err } = await addSpare();
    expect(code).toBe(EXIT_ERROR);
    expect(err).toContain(`set ${AWS_MEMBER_EMAIL_TEMPLATE_ENV}`);
    expect(awsCalls()).toBe(0);
  });

  it('exits 2 when the raise could not be filed, and the next run files it with exit 0', async () => {
    organization.requestFailure = new AwsManagementApiError(
      'service-quotas',
      'TooManyRequestsException',
      429,
    );
    const first = await addSpare();
    expect(first.code).toBe(EXIT_PENDING);
    expect(first.out).toMatch(/^quota_raise\s+failed — could not file the raise/m);

    organization.requestFailure = null;
    const second = await addSpare();
    expect(second.code).toBe(EXIT_OK);
    expect(second.out).toMatch(/^quota_raise\s+done — filed a raise to 200 vCPU/m);
  });

  it('refuses a run with no flags, naming the missing fleet kind', async () => {
    const { code, err } = await run('add-spare');
    expect(code).toBe(EXIT_ERROR);
    expect(err).toContain('--fleet-kind (none) is not one of');
    expect(awsCalls()).toBe(0);
  });

  it('refuses stray arguments by the strict parser', async () => {
    const { code, err } = await run('add-spare', '--fleet-kind', 'ci_runner', '--name', 'x');
    expect(code).toBe(EXIT_ERROR);
    expect(err).toMatch(/^error: /);
  });

  it('prints no credential, in its output or the audit row', async () => {
    const { out, err } = await addSpare();
    const audits = await adminDb.platformAuditLog.findMany({
      where: { action: 'fleet.shard.add' },
    });
    const printed = JSON.stringify([out, err, audits]);
    for (const secret of Object.values(SECRETS)) expect(printed).not.toContain(secret);
  });

  it('is listed in the usage fleet-admin prints with no command', async () => {
    const { code, err } = await run();
    expect(code).toBe(EXIT_ERROR);
    expect(err).toContain('fleet-admin add-spare --fleet-kind <kind> --operator <email>');
  });
});
