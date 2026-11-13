import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AwsManagementApiError,
  Ec2ApiError,
  type AwsCredentialsConfig,
  type AwsSessionCredentials,
  type Ec2Api,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { PlatformRole } from '@/generated/prisma/client';
import { poolAccountRaiseTargetVcpu } from '@/lib/ciFleet/shardTargets';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import {
  findShardProvisioningProvider,
  registerShardProvisioningProvider,
} from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { runFleetAdmin } from '@/scripts/fleet/fleetAdmin';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  ADD_SHARD_ENTERPRISE_SLUG as SLUG,
  FakeOrganization,
  POOL_DEFINITION,
  buildStacksInto,
  stubPoolDefinitionEnv,
  installAddShardGithub,
  newGithubWorld,
  type GithubWorld,
} from '../helpers/addShardFakes';

// `fleet-admin add-shard --provider aws` (Story MOTIR-9270 · MOTIR-9278), against
// a real database for the row and the audit entry, GitHub stubbed at `fetch`, the
// AWS management calls behind an in-memory organization, and the network built by
// the pool-account definition's stack instance (MOTIR-9845), seeded into the
// in-memory EC2 of the network card and read back by the REAL `readAwsShardNetwork`.

const ec2FakePath = '../../packages/orchestrator/test/contract/awsEc2Fake';

/** The surface of `AwsEc2Fake` this file reads. */
interface Ec2Fake extends Ec2Api {
  mutations(): Array<{ method: string; input: unknown }>;
  count(method: string): number;
  failNext(method: keyof Ec2Api, code?: string, httpStatus?: number): void;
}
let AwsEc2Fake: new () => Ec2Fake;

const ORG = 'motir-fleet-use1-2';
const NAME = 'ci-runner-use1-2';
const PREFIX = 'FLEET_SHARD_CI_RUNNER_USE1_2';
const ACCOUNT_EMAIL = 'aws+ci-runner-use1-2@motir.co';
const CI_TARGET = poolAccountRaiseTargetVcpu('ci_runner');
/** Under the kind's own target, so a first run leaves the quota pending. */
const BELOW_TARGET = CI_TARGET - 50;
const SECRETS = {
  admin: 'ghp_ADMIN_SECRET_never_printed',
  installation: 'ghs_INSTALL_SECRET_never_printed',
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
/** Which access key id each EC2 surface was built with. */
let ec2Keys: string[];
/** The waits the provider slept, on an injected timer (MOTIR-10204). */
let sleeps: number[];
let unregister: () => void;
let operatorEmail: string;

async function staff(role: PlatformRole | null): Promise<string> {
  const user = await createTestUser();
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return user.email;
}

function args(overrides: Record<string, string | null> = {}) {
  const values: Record<string, string | null> = {
    provider: 'aws',
    'fleet-kind': 'ci_runner',
    name: NAME,
    'github-org': ORG,
    'admin-login': 'zhuyue11',
    'account-email': ACCOUNT_EMAIL,
    operator: operatorEmail,
    ...overrides,
  };
  const out = ['add-shard', '--create-org'];
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) out.push(`--${key}`, value);
  }
  return out;
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFleetAdmin(argv, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function shardRow() {
  return adminDb.fleetShard.findUnique({ where: { name: NAME } });
}

/** The step add-shard words when the runner role cannot be assumed yet. */
function roleStep(accountId: string): string {
  return (
    `the role motir-fleet-runner in AWS account ${accountId} could not be assumed yet ` +
    '(IAM propagates within minutes); the next growth pass resumes this account'
  );
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
  vi.stubEnv('GITHUB_ENTERPRISE_ADMIN_TOKEN', SECRETS.admin);
  vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::576360162297:role/motir-add-shard');
  stubPoolDefinitionEnv();
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  github = newGithubWorld();
  organization = new FakeOrganization(SESSION);
  organization.quota = BELOW_TARGET;
  buildStacksInto(organization, () => ec2);
  ec2 = new AwsEc2Fake();
  ec2Keys = [];
  sleeps = [];
  installAddShardGithub(github, SECRETS.installation);
  unregister = registerShardProvisioningProvider(
    createAwsShardProvisioningProvider({
      management: () => organization,
      ec2: (config: AwsCredentialsConfig) => {
        ec2Keys.push(config.accessKeyId);
        return ec2;
      },
      env: () => process.env,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }),
  );
  operatorEmail = await staff('superadmin');
});

afterEach(() => {
  unregister();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('add-shard --provider aws, first run', () => {
  it('creates the account once, builds the network once and writes an aws provisioning row', async () => {
    const result = await run(args());

    expect(result.code).toBe(2);
    expect(organization.calls.filter((c) => c === 'createOrganizationAccount')).toHaveLength(1);
    const account = organization.accounts.get(NAME)!;
    // The network: built by the definition — the account joins its kind's unit
    // and gets one stack instance — and read back in the member account with its
    // session. No EC2 create call is made.
    expect(organization.accountUnits.get(account.accountId)).toBe(
      POOL_DEFINITION.unitId('ci_runner'),
    );
    expect([...organization.stackInstances.keys()]).toEqual([
      `${POOL_DEFINITION.stackSetName}/${account.accountId}/us-east-1`,
    ]);
    expect(ec2.mutations()).toEqual([]);
    expect(new Set(ec2Keys)).toEqual(new Set([SECRETS.sessionKeyId]));

    const row = await shardRow();
    expect(row).toMatchObject({
      provider: 'aws',
      role: 'primary',
      state: 'provisioning',
      fleetKind: 'ci_runner',
      awsAccountId: account.accountId,
      awsRegion: 'us-east-1',
      flyApp: null,
      githubOrg: ORG,
      githubInstallationId: '9001',
      credentialRef: PREFIX,
      vcpuQuota: BELOW_TARGET,
    });
    expect(row!.limitsSource).toMatchObject({
      vcpuQuota: 'provider_read',
      githubRegistrationsPer5Min: 'documented',
    });

    expect(result.out).toMatch(/^provider_account\s+done — created AWS account/m);
    expect(result.out).toMatch(
      /^network\s+done — created unit-membership:.*stack-instance:.*; vpc vpc-/m,
    );
    expect(result.out).toContain('Pending manual steps:');
    expect(result.out).toContain(
      `raise the account's vCPU quota from ${BELOW_TARGET} to at least ` + `${CI_TARGET}`,
    );
    // The runner role the stack built is confirmed by assuming it: no person is
    // asked to mint a key (MOTIR-9847).
    expect(result.out).toMatch(
      /^runtime_credential\s+already — the runtime credential is confirmed/m,
    );
    expect(organization.calls).toContain(`assumeRunnerRole:${account.accountId}`);
    expect(result.out).not.toContain('access key');
    expect(result.out).not.toContain('_ACCESS_KEY');
  });

  it('a re-run files no create and reports every completed step already', async () => {
    await run(args());
    const mutationsAfterFirst = ec2.mutations().length;
    github.calls = [];
    organization.calls.length = 0;

    const result = await run(args());

    expect(result.code).toBe(2);
    expect(organization.calls).not.toContain('createOrganizationAccount');
    expect(ec2.mutations()).toHaveLength(mutationsAfterFirst);
    for (const step of [
      'github_org',
      'app_installation',
      'provider_account',
      'network',
      'account_row',
    ]) {
      expect(result.out).toMatch(new RegExp(`^${step}\\s+already`, 'm'));
    }
    expect(await adminDb.fleetShard.count()).toBe(1);
  });

  it('a resume while CreateAccount is IN_PROGRESS waits on it and files none', async () => {
    organization.inProgress.set(NAME, 'car-earlier');

    const result = await run(args({ 'account-email': null }));

    expect(result.code).toBe(2);
    expect(organization.calls).toContain('waitForCreateAccount:car-earlier');
    expect(organization.calls).not.toContain('createOrganizationAccount');
    expect((await shardRow())!.awsAccountId).toBe(organization.accounts.get(NAME)!.accountId);
  });

  it('with the quota at target, a resume makes the row active and exits 0', async () => {
    await run(args());
    organization.quota = CI_TARGET;
    organization.calls.length = 0;

    const result = await run(args());

    expect(result.code).toBe(0);
    expect(result.out).not.toContain('Pending manual steps');
    expect(result.out).toMatch(/^runtime_credential\s+already/m);
    // The role was confirmed by assuming it; no EC2 call is made with a runner key.
    const accountId = organization.accounts.get(NAME)!.accountId;
    expect(organization.calls).toContain(`assumeRunnerRole:${accountId}`);
    expect(ec2.mutations().some((m) => /run|terminate/.test(m.method))).toBe(false);
    expect(await shardRow()).toMatchObject({
      state: 'active',
      vcpuQuota: CI_TARGET,
    });
  });

  it('a runner role that cannot be assumed yet stays pending, with the role step', async () => {
    // The first run creates the account; the role is refused on the second.
    await run(args());
    organization.quota = CI_TARGET;
    const accountId = organization.accounts.get(NAME)!.accountId;
    organization.runnerAssumeFailures.set(
      accountId,
      new AwsManagementApiError('sts', 'AccessDenied', 403),
    );

    const result = await run(args());

    expect(result.code).toBe(2);
    expect(result.out).toMatch(/^runtime_credential\s+pending/m);
    expect(result.out).toContain(roleStep(accountId));
    expect((await shardRow())!.state).toBe('provisioning');
  });
});

describe('a just-created account whose EC2 is still activating (MOTIR-10204)', () => {
  /** EC2 answers the next `times` VPC reads with OptInRequired, as a new account
   *  does until its activation finishes. The refusal is the package's own
   *  `Ec2ApiError` — the class the provider reads, not the fake's source copy. */
  function refuseVpcReads(times: number): void {
    const read = ec2.describeVpcs.bind(ec2);
    let refused = 0;
    ec2.describeVpcs = async (filters) => {
      if (refused < times) {
        refused += 1;
        throw new Ec2ApiError('OptInRequired', 401, false);
      }
      return read(filters);
    };
  }

  it('waits out OptInRequired on the first EC2 call and builds the account in the same run', async () => {
    refuseVpcReads(1);

    const result = await run(args());

    expect(result.code).toBe(2);
    expect(result.err).not.toContain('OptInRequired');
    expect(sleeps).toEqual([15_000]);
    expect(result.out).toMatch(/^network\s+done — created unit-membership:.*stack-instance:/m);
    expect((await shardRow())!.state).toBe('provisioning');
  });

  it('an account older than a day answering OptInRequired is refused at once, unwaited', async () => {
    await run(args());
    const account = organization.accounts.get(NAME)!;
    organization.accounts.set(NAME, {
      ...account,
      joinedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000),
    });
    refuseVpcReads(1);

    const result = await run(args());

    expect(result.code).toBe(1);
    expect(result.err).toContain('EC2 refused a call (OptInRequired, HTTP 401)');
    expect(sleeps).toEqual([]);
  });
});

describe('refusals', () => {
  it('a missing management variable is refused before any external call', async () => {
    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', '');

    const result = await run(args());

    expect(result.code).toBe(1);
    expect(result.err).toContain('missing env: AWS_ORG_ADMIN_ROLE_ARN');
    expect(github.calls).toEqual([]);
    expect(organization.calls).toEqual([]);
  });

  // MOTIR-9839 · MOTIR-10302: the role ARN alone is the whole management credential.
  it('preflight passes with the role ARN alone', async () => {
    const roleOnly = await run(args({ region: 'Mars' }));
    expect(roleOnly.code).toBe(1);
    expect(roleOnly.err).toContain('--region Mars is not an AWS region id');
    expect(roleOnly.err).not.toContain('missing env');
    expect(github.calls).toEqual([]);
    expect(organization.calls).toEqual([]);
  });

  it('a bad region or email is refused before any external call', async () => {
    const result = await run(args({ region: 'Mars', 'account-email': 'nope' }));

    expect(result.code).toBe(1);
    expect(result.err).toContain('--region Mars is not an AWS region id');
    expect(result.err).toContain('--account-email nope is not an email address');
    expect(organization.calls).toEqual([]);
  });

  it('a non-staff operator is refused before the first external call', async () => {
    const result = await run(args({ operator: await staff(null) }));

    expect(result.code).toBe(1);
    expect(result.err).toContain('is not a superadmin');
    expect(github.calls).toEqual([]);
    expect(organization.calls).toEqual([]);
  });

  it('a name recorded with a different fleet kind, region or org refuses and changes nothing', async () => {
    await run(args());
    const before = await shardRow();
    github.calls = [];
    organization.calls.length = 0;

    for (const overrides of [
      { 'fleet-kind': 'hosted_agent' } as Record<string, string>,
      { region: 'us-west-2' },
      { 'github-org': 'motir-fleet-other' },
    ]) {
      const result = await run(args(overrides));
      expect(result.code).toBe(1);
      expect(result.err).toContain('already the ci_runner account');
    }
    expect(github.calls).toEqual([]);
    expect(organization.calls).toEqual([]);
    expect(await shardRow()).toEqual(before);
  });

  it('a name recorded on a different AWS account refuses and changes nothing', async () => {
    await run(args());
    const before = await shardRow();
    organization.accounts.set(NAME, { accountId: '999999999999', name: NAME, status: 'ACTIVE' });
    const mutations = ec2.mutations().length;

    const result = await run(args());

    expect(result.code).toBe(1);
    expect(result.err).toContain(`recorded on AWS account ${before!.awsAccountId}`);
    expect(organization.calls.some((c) => c.startsWith('assumeMemberRole:999'))).toBe(false);
    expect(ec2.mutations()).toHaveLength(mutations);
    expect(await shardRow()).toEqual(before);
  });

  it('no account of the name and no --account-email is refused, with no row', async () => {
    const result = await run(args({ 'account-email': null }));

    expect(result.code).toBe(1);
    expect(result.err).toContain('pass --account-email <email> to create it');
    expect(organization.calls).not.toContain('createOrganizationAccount');
    expect(await shardRow()).toBeNull();
  });

  it.each(['EMAIL_ALREADY_EXISTS', 'ACCOUNT_LIMIT_EXCEEDED'])(
    'CreateAccount failing with %s is a refusal naming the reason, and writes no row',
    async (reason) => {
      organization.createFailure = reason;

      const result = await run(args());

      expect(result.code).toBe(1);
      expect(result.err).toContain(`AWS refused to create the account ${NAME}: ${reason}`);
      expect(await shardRow()).toBeNull();
      expect(ec2.mutations()).toEqual([]);
    },
  );
});

describe('the secrets', () => {
  it('mints no key, and no secret or session credential reaches stdout, stderr or the audit row', async () => {
    const first = await run(args());
    organization.quota = CI_TARGET;
    const second = await run(args());

    expect(organization.calls.some((c) => /AccessKey/i.test(c))).toBe(false);
    const printed = [first.out, first.err, second.out, second.err].join('\n');
    const audited = JSON.stringify(
      await adminDb.platformAuditLog.findMany({
        where: { action: { startsWith: 'fleet.shard.' } },
      }),
    );
    for (const secret of Object.values(SECRETS)) {
      expect(printed).not.toContain(secret);
      expect(audited).not.toContain(secret);
    }
  });
});

describe('refresh-limits on an aws account', () => {
  it('assumes the recorded account again, re-reads the quota and updates only it', async () => {
    await run(args());
    const before = (await shardRow())!;
    organization.quota = 2_304;
    organization.calls.length = 0;

    const result = await run(['refresh-limits', '--name', NAME, '--operator', operatorEmail]);

    expect(result.code).toBe(0);
    expect(organization.calls).toEqual([
      `assumeMemberRole:${before.awsAccountId}`,
      'readVcpuQuota:us-east-1:true',
    ]);
    const after = (await shardRow())!;
    expect(after.vcpuQuota).toBe(2_304);
    expect({ ...after, vcpuQuota: null, limitsVerifiedAt: null, updatedAt: null }).toEqual({
      ...before,
      vcpuQuota: null,
      limitsVerifiedAt: null,
      updatedAt: null,
    });
  });
});

describe('the registry', () => {
  it('registers the real aws provider, and a test stand-in gives it back', () => {
    const real = findShardProvisioningProvider('aws');
    expect(real).not.toBeNull();
    unregister();
    expect(findShardProvisioningProvider('aws')).not.toBeNull();
    expect(findShardProvisioningProvider('aws')!.options.map((o) => o.name)).toEqual([
      'account-email',
    ]);
    // Re-register so afterEach's unregister has something to remove.
    unregister = registerShardProvisioningProvider(real!);
  });
});
