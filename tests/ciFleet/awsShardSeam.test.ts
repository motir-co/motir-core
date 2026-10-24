import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  OrchestratorCapacityError,
  OrchestratorNotConfiguredError,
  type ContainerSpec,
  type Ec2Api,
  type Ec2Instance,
  type Ec2RunInstanceInput,
  type UsageAttribution,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { AWS_RUNNER_AMI_ENV_VAR, orchestratorForShard } from '@/lib/orchestrator';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { runFleetAdmin } from '@/scripts/fleet/fleetAdmin';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  ADD_SHARD_ENTERPRISE_SLUG,
  FakeOrganization,
  installAddShardGithub,
  newGithubWorld,
} from '../helpers/addShardFakes';

// THE STORY'S SEAM (Story MOTIR-9270 · MOTIR-9280): add-shard writes an `aws`
// row, `orchestratorForShard` turns that row into the AWS adapter, and the
// adapter launches in the network add-shard built. Each card tested its own half
// against its own fake; this proves the names cross: the `motir-shard` tag value,
// the region, the `credentialRef` suffixes and the AMI variable one card writes
// are the ones the next card reads.
//
// One in-memory EC2 is the member account: add-shard's network step builds into
// it with the assumed-role session, and the adapter boots into it with the
// runtime key — `createEc2Api` answers it for both, recording which key asked.
//
// ⚠️ `@motir/orchestrator` RESOLVES TO THE PACKAGE SOURCE in this file, as in
// `awsPoolDeferral.test.ts`: the EC2 fake throws the source's `Ec2ApiError`, and
// the adapter types a capacity refusal by `instanceof`.

const paths = vi.hoisted(() => ({
  orchestratorSource: '../../packages/orchestrator/src/index',
  ec2Fake: '../../packages/orchestrator/test/contract/awsEc2Fake',
}));

/** The surface of `AwsEc2Fake` this file drives. */
interface Ec2Fake extends Ec2Api {
  readonly instances: ReadonlyMap<string, Ec2Instance & { request: Ec2RunInstanceInput }>;
  failNextRunInstances(refusal: { code: string; zone?: string }): void;
  plantInstance(instance: Partial<Ec2Instance> & { tags: Ec2Instance['tags'] }): string;
  liveInstanceIds(): string[];
  count(method: string): number;
}

const world = vi.hoisted(() => ({ ec2: null as unknown, keys: [] as string[] }));

vi.mock('@motir/orchestrator', async () => {
  const source = (await import(
    /* @vite-ignore */ paths.orchestratorSource
  )) as typeof import('@motir/orchestrator');
  return {
    ...source,
    createEc2Api: (config: { accessKeyId: string }) => {
      world.keys.push(config.accessKeyId);
      return world.ec2;
    },
  };
});

let AwsEc2Fake: new () => Ec2Fake;
const ec2 = () => world.ec2 as Ec2Fake;

const NAME = 'ci-runner-use1-9';
const ORG = 'motir-fleet-use1-9';
const PREFIX = 'FLEET_SHARD_CI_RUNNER_USE1_9';
const AMI = 'ami-0fedcba9876543210';
const REGION = 'us-east-1';
const SESSION = {
  accessKeyId: 'ASIA_MEMBER_SESSION',
  secretAccessKey: 'member-session-secret',
  sessionToken: 'member-session-token',
  expiration: null,
};
const RUNTIME_KEY = { id: 'AKIA_RUNTIME_KEY', secret: 'runtime-secret' };

const SPEC: ContainerSpec = {
  orgId: 'org-seam',
  workspaceId: 'ws-seam',
  projectId: 'proj-seam',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 92_800,
  image: 'unused-on-aws',
  size: FLEET_CONTAINER_SIZE,
  env: {
    ACTIONS_RUNNER_INPUT_JITCONFIG: 'eyJzZWFtIjp0cnVlfQ==',
    ACTIONS_RUNNER_CONFIG_ARGS: '--no-default-labels',
    MOTIR_RUNNER_LABEL: 'motir-fleet',
    MOTIR_INTENT_ID: 'intent-seam',
    MOTIR_WORKFLOW_JOB_ID: '92800',
  },
  timeoutSeconds: 3600,
  region: REGION,
};

const ATTRIBUTION: UsageAttribution = {
  orgId: 'org-seam',
  workspaceId: 'ws-seam',
  projectId: 'proj-seam',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 92_800,
  size: FLEET_CONTAINER_SIZE,
  observedStartedAt: null,
};

let organization: FakeOrganization;
let unregister: () => void;
let operatorEmail: string;

async function addShard(): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await runFleetAdmin(
    [
      'add-shard',
      '--create-org',
      '--provider',
      'aws',
      '--fleet-kind',
      'ci_runner',
      '--name',
      NAME,
      '--github-org',
      ORG,
      '--admin-login',
      'zhuyue11',
      '--account-email',
      `aws+${NAME}@motir.co`,
      '--operator',
      operatorEmail,
    ],
    { out: (line) => out.push(line), err: (line) => out.push(line) },
  );
  return { code, out: out.join('\n') };
}

function setRuntime(): void {
  vi.stubEnv(`${PREFIX}_ACCESS_KEY_ID`, RUNTIME_KEY.id);
  vi.stubEnv(`${PREFIX}_SECRET_ACCESS_KEY`, RUNTIME_KEY.secret);
  vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, AMI);
}

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ paths.ec2Fake)) as {
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
  vi.stubEnv('GITHUB_ENTERPRISE_SLUG', ADD_SHARD_ENTERPRISE_SLUG);
  vi.stubEnv('GITHUB_ENTERPRISE_ADMIN_TOKEN', 'ghp_admin');
  vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', 'AKIA_MANAGEMENT');
  vi.stubEnv('AWS_ORG_ADMIN_SECRET_ACCESS_KEY', 'management-secret');
  vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::576360162297:role/motir-add-shard');
  // The deployment's own selection, so the row resolves through its `aws` case.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
  vi.stubEnv(`${PREFIX}_ACCESS_KEY_ID`, '');
  vi.stubEnv(`${PREFIX}_SECRET_ACCESS_KEY`, '');
  vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, '');
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  installAddShardGithub(newGithubWorld(), 'ghs_installation');
  world.ec2 = new AwsEc2Fake();
  world.keys = [];
  organization = new FakeOrganization(SESSION);
  // The real provider; only its management API is the in-memory organization.
  // Its EC2 goes through the package's `createEc2Api`, the same seam the adapter
  // resolves through.
  unregister = registerShardProvisioningProvider(
    createAwsShardProvisioningProvider({
      management: () => organization,
      ec2: (config) => {
        world.keys.push(config.accessKeyId);
        return ec2();
      },
      env: () => process.env,
    }),
  );
  const user = await createTestUser();
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'superadmin' } });
  operatorEmail = user.email;
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

describe('add-shard → account row → adapter', () => {
  it('the instance lands in the network add-shard built, with its AMI and its shard tag', async () => {
    expect((await addShard()).code).toBe(2);
    const shard = (await fleetShardService.findShardByName(NAME))!;
    expect(shard).toMatchObject({
      provider: 'aws',
      fleetKind: 'ci_runner',
      role: 'primary',
      state: 'provisioning',
      credentialRef: PREFIX,
      aws: { region: REGION },
    });
    expect(ec2().count('createSubnet')).toBeGreaterThan(0);
    const subnets = await ec2().describeSubnets([{ name: 'tag:motir-shard', values: [NAME] }]);
    const groups = await ec2().describeSecurityGroups([
      { name: 'tag:motir-shard', values: [NAME] },
    ]);
    expect(groups).toHaveLength(1);
    // The network was built with the member account's assumed-role session.
    expect(world.keys).toEqual([SESSION.accessKeyId]);

    setRuntime();
    world.keys = [];
    const orchestrator = orchestratorForShard(shard);
    const handle = await orchestrator.provision(SPEC);

    expect(ec2().count('runInstances')).toBe(1);
    const request = ec2().instances.get(handle.id)!.request;
    expect(subnets.map((s) => s.subnetId)).toContain(request.subnetId);
    expect(request.securityGroupIds).toEqual([groups[0]!.groupId]);
    expect(request.imageId).toBe(AMI);
    expect(request.tags).toContainEqual({ key: 'motir-shard', value: NAME });
    // …and booted with the runtime key under the row's credentialRef.
    expect(world.keys).toEqual([RUNTIME_KEY.id]);
  });

  it('with the runtime key and the AMI unset, names every missing variable and launches nothing', async () => {
    await addShard();
    const shard = (await fleetShardService.findShardByName(NAME))!;

    expect(() => orchestratorForShard(shard)).toThrow(
      new OrchestratorNotConfiguredError(
        `set ${PREFIX}_ACCESS_KEY_ID, ${PREFIX}_SECRET_ACCESS_KEY, ${AWS_RUNNER_AMI_ENV_VAR}`,
      ),
    );
    expect(ec2().count('runInstances')).toBe(0);
  });

  it('an aws row whose network was never built refuses to provision, naming the tag and region', async () => {
    const shard = await fleetShardService.createShard({
      name: 'ci-runner-use1-unbuilt',
      fleetKind: 'ci_runner',
      provider: 'aws',
      state: 'active',
      githubOrg: ORG,
      githubInstallationId: '9001',
      awsAccountId: '400000000099',
      awsRegion: REGION,
      credentialRef: PREFIX,
    });
    setRuntime();

    const err = await orchestratorForShard(shard)
      .provision(SPEC)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect((err as Error).message).toContain(`motir-shard=ci-runner-use1-unbuilt in ${REGION}`);
    expect(ec2().count('runInstances')).toBe(0);
  });

  it('reap for one shard terminates its own instance and never another shard’s', async () => {
    await addShard();
    const shard = (await fleetShardService.findShardByName(NAME))!;
    setRuntime();
    const orchestrator = orchestratorForShard(shard);
    const ours = await orchestrator.provision(SPEC);
    const theirs = ec2().plantInstance({
      tags: ec2()
        .instances.get(ours.id)!
        .tags.map((t) => (t.key === 'motir-shard' ? { ...t, value: 'ci-runner-use1-other' } : t)),
    });

    await orchestrator.reap(new Date(Date.now() + 60_000), async () => ATTRIBUTION);

    expect(ec2().liveInstanceIds()).toEqual([theirs]);
  });

  it('a VcpuLimitExceeded refusal is a quota capacity error, and no instance exists', async () => {
    await addShard();
    const shard = (await fleetShardService.findShardByName(NAME))!;
    setRuntime();
    ec2().failNextRunInstances({ code: 'VcpuLimitExceeded' });

    const err = await orchestratorForShard(shard)
      .provision(SPEC)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OrchestratorCapacityError);
    expect(err).toMatchObject({ provider: 'aws', reason: 'quota_exceeded' });
    expect(ec2().liveInstanceIds()).toEqual([]);
  });
});
