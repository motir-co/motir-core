import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AwsCredentialsConfig,
  type AwsSessionCredentials,
  type Ec2Api,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { PlatformRole } from '@/generated/prisma/client';
import { SHARD_VCPU_QUOTA_TARGET } from '@/lib/ciFleet/shardTargets';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { awsRunnerPolicyDocument } from '@motir/orchestrator';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { withSystemContext } from '@/lib/workspaces/context';
import { runFleetAdmin } from '@/scripts/fleet/fleetAdmin';
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

// `fleet-admin add-shard --provider aws --fleet-kind code_graph_index` (Story
// MOTIR-9360 · MOTIR-9447): the same command MOTIR-9278 proved for the CI runner,
// putting an account into the INDEXER's pool and only there. The same fakes as
// `fleetShardProvisioningAws.test.ts`: a real database, GitHub stubbed at `fetch`,
// the AWS management calls behind an in-memory organization, and the real network
// function over the in-memory EC2.

const ec2FakePath = '../../packages/orchestrator/test/contract/awsEc2Fake';

/** The surface of `AwsEc2Fake` this file reads. */
interface Ec2Fake extends Ec2Api {
  mutations(): Array<{ method: string; input: unknown }>;
  count(method: string): number;
  failNext(method: keyof Ec2Api, code?: string, httpStatus?: number): void;
}
let AwsEc2Fake: new () => Ec2Fake;

const ORG = 'motir-fleet-use1-3';
const NAME = 'code-graph-index-use1-1';
const PREFIX = 'FLEET_SHARD_CODE_GRAPH_INDEX_USE1_1';
const ACCOUNT_EMAIL = 'aws+code-graph-index-use1-1@motir.co';
const SECRETS = {
  admin: 'ghp_ADMIN_SECRET_never_printed',
  installation: 'ghs_INSTALL_SECRET_never_printed',
  managementKey: 'AKIA_MANAGEMENT_never_printed',
  managementSecret: 'MANAGEMENT_SECRET_never_printed',
  runtimeKeyId: 'AKIA_RUNTIME_never_printed',
  runtimeSecret: 'RUNTIME_SECRET_never_printed',
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
    'fleet-kind': 'code_graph_index',
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

async function shardRow(name = NAME) {
  return adminDb.fleetShard.findUnique({ where: { name } });
}

/** The pool read admission uses, for one kind. */
function poolOf(kind: string): Promise<string[]> {
  return withSystemContext(async (tx) =>
    (await fleetShardRepository.listActiveForKindInTx(kind, ['primary'], tx)).map((s) => s.name),
  );
}

/** Make every account row active — the state the pool read admits. */
async function activateAll(): Promise<void> {
  await adminDb.fleetShard.updateMany({ data: { state: 'active' } });
}

/** The person's step, exactly as add-shard words it. */
function credentialStep(accountId: string): string {
  return (
    `create an access key for the IAM user motir-fleet-runner in AWS account ${accountId} ` +
    '(IAM console → Users → motir-fleet-runner → Security credentials → Create access key), ' +
    `then run: flyctl secrets set -a motir-core ${PREFIX}_ACCESS_KEY_ID=… ${PREFIX}_SECRET_ACCESS_KEY=…`
  );
}

function setRuntimeKey(): void {
  vi.stubEnv(`${PREFIX}_ACCESS_KEY_ID`, SECRETS.runtimeKeyId);
  vi.stubEnv(`${PREFIX}_SECRET_ACCESS_KEY`, SECRETS.runtimeSecret);
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
  vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', SECRETS.managementKey);
  vi.stubEnv('AWS_ORG_ADMIN_SECRET_ACCESS_KEY', SECRETS.managementSecret);
  vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::576360162297:role/motir-add-shard');
  stubPoolDefinitionEnv();
  vi.stubEnv(`${PREFIX}_ACCESS_KEY_ID`, '');
  vi.stubEnv(`${PREFIX}_SECRET_ACCESS_KEY`, '');
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  github = newGithubWorld();
  organization = new FakeOrganization(SESSION);
  buildStacksInto(organization, () => ec2);
  ec2 = new AwsEc2Fake();
  ec2Keys = [];
  installAddShardGithub(github, SECRETS.installation);
  unregister = registerShardProvisioningProvider(
    createAwsShardProvisioningProvider({
      management: () => organization,
      ec2: (config: AwsCredentialsConfig) => {
        ec2Keys.push(config.accessKeyId);
        return ec2;
      },
      env: () => process.env,
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

describe('add-shard --provider aws --fleet-kind code_graph_index', () => {
  it('writes ONE aws / primary row in the indexer pool, in us-east-1, and exits 2 while pending', async () => {
    const result = await run(args());

    expect(result.code).toBe(2);
    const account = organization.accounts.get(NAME)!;
    expect(await adminDb.fleetShard.count()).toBe(1);
    expect(await shardRow()).toMatchObject({
      provider: 'aws',
      role: 'primary',
      state: 'provisioning',
      fleetKind: 'code_graph_index',
      awsAccountId: account.accountId,
      awsRegion: 'us-east-1',
      credentialRef: PREFIX,
      vcpuQuota: SHARD_VCPU_QUOTA_TARGET - 1_000,
    });
    // Pending on both: the quota is short and the runtime key is unset.
    expect(result.out).toContain('Pending manual steps:');
    expect(result.out).toContain(
      `raise the account's vCPU quota from ${SHARD_VCPU_QUOTA_TARGET - 1_000} to at least`,
    );
    expect(result.out).toContain(credentialStep(account.accountId));
  });

  it('becomes active, and exits 0, once the quota is met and the runtime key works', async () => {
    await run(args());
    organization.quota = SHARD_VCPU_QUOTA_TARGET;
    setRuntimeKey();

    const result = await run(args());

    expect(result.code).toBe(0);
    expect(await shardRow()).toMatchObject({ state: 'active', fleetKind: 'code_graph_index' });
  });

  it('keeps the pools apart: two indexer accounts, and two CI accounts the indexer read never returns', async () => {
    const second = 'code-graph-index-use1-2';
    expect((await run(args())).code).toBe(2);
    expect((await run(args({ name: second, 'account-email': 'aws+cgi-2@motir.co' }))).code).toBe(2);
    for (const name of ['ci-runner-use1-8', 'ci-runner-use1-9']) {
      const result = await run(
        args({ name, 'fleet-kind': 'ci_runner', 'account-email': `aws+${name}@motir.co` }),
      );
      expect(result.code).toBe(2);
    }
    await activateAll();

    expect((await poolOf('code_graph_index')).sort()).toEqual([NAME, second]);
    expect((await poolOf('ci_runner')).sort()).toEqual(['ci-runner-use1-8', 'ci-runner-use1-9']);
    // Each account has its own runtime key, derived from its own name.
    const refs = (await adminDb.fleetShard.findMany()).map((s) => s.credentialRef);
    expect(new Set(refs).size).toBe(4);
    expect((await shardRow(second))!.credentialRef).toBe('FLEET_SHARD_CODE_GRAPH_INDEX_USE1_2');
  });

  it('an existing name re-run under another fleet kind refuses and changes nothing', async () => {
    await run(args());
    const before = await shardRow();
    github.calls = [];
    organization.calls.length = 0;

    const result = await run(args({ 'fleet-kind': 'ci_runner' }));

    expect(result.code).toBe(1);
    expect(result.err).toContain('already the code_graph_index account');
    expect(github.calls).toEqual([]);
    expect(organization.calls).toEqual([]);
    expect(await shardRow()).toEqual(before);
  });

  it('an unknown fleet kind refuses by name before any external call', async () => {
    const result = await run(args({ 'fleet-kind': 'code_graph_indexer' }));

    expect(result.code).toBe(1);
    expect(result.err).toContain('--fleet-kind code_graph_indexer is not one of');
    expect(github.calls).toEqual([]);
    expect(organization.calls).toEqual([]);
    expect(await shardRow()).toBeNull();
  });

  it('names code_graph_index among the kinds the usage text accepts', async () => {
    const result = await run([]);
    expect(`${result.out}\n${result.err}`).toMatch(/--fleet-kind: one of .*code_graph_index/);
  });

  it('sizes the indexer account by the 2 vCPU / 8 GB container: quota 16 holds 8, as for CI', async () => {
    await run(args());
    await run(
      args({
        name: 'ci-runner-use1-8',
        'fleet-kind': 'ci_runner',
        'account-email': 'aws+c8@motir.co',
      }),
    );
    await adminDb.fleetShard.updateMany({ data: { vcpuQuota: 16 } });

    const index = (await shardRow())!;
    const ci = (await shardRow('ci-runner-use1-8'))!;
    expect(fleetShardAdmissionService.effectiveCeiling(index)).toBe(8);
    expect(fleetShardAdmissionService.effectiveCeiling(ci)).toBe(8);
  });

  it('applies the shared runtime policy, which covers the index VM’s calls', async () => {
    await run(args());

    // The document the account's IAM user was given is the shared one, scoped to
    // this account's tag — plus, for an indexer account, the terminate the
    // attribution pass needs to reap an untagged VM (MOTIR-9450).
    const expected = JSON.stringify(
      awsRunnerPolicyDocument({ shardTag: NAME, regionId: 'us-east-1', reapUntagged: true }),
    );
    expect(expected).toContain('TerminateAnyInAccount');
    expect([...organization.iamUsers]).toEqual([expected]);
    const policy = expected;
    for (const action of [
      'ec2:RunInstances',
      'ec2:DescribeInstances',
      'ec2:TerminateInstances',
      'ec2:CreateTags',
      'ec2:GetConsoleOutput',
    ]) {
      expect(policy).toContain(action);
    }
  });
});
