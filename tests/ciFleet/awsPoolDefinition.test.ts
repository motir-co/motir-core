import { OrchestratorNotConfiguredError, type Ec2Api } from '@motir/orchestrator';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_POOL_DEFINITION_ENV,
  awsPoolDefinitionFromEnv,
  awsPoolDefinitionProblems,
  awsPoolDefinitionRequiredEnv,
  awsPoolStackOverrides,
  awsPoolUnitEnvName,
} from '@/lib/fleetShards/awsPoolDefinition';
import {
  AWS_REAP_UNTAGGED_OPTION,
  createAwsShardProvisioningProvider,
} from '@/lib/fleetShards/awsProvisioningProvider';
import type { ProviderStepContext } from '@/lib/fleetShards/provisioningProviders';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import {
  FakeOrganization,
  POOL_DEFINITION,
  buildStacksInto,
  stubPoolDefinitionEnv,
} from '@/tests/helpers/addShardFakes';

// The pool-account definition as add-shard applies it (MOTIR-9845): the
// configuration reader, the parameter overrides by kind, and the provider's
// network step — move into the kind's unit, apply the stack instance, read its
// outputs and check the tagged network against them — over the in-memory
// organization and EC2, interrupted and replayed at each point.

const ec2FakePath = '../../packages/orchestrator/test/contract/awsEc2Fake';
interface Ec2Fake extends Ec2Api {
  mutations(): Array<{ method: string; input: unknown }>;
  seedShardNetwork(shardTag: string, zones?: readonly string[]): unknown;
  subnets: Map<string, unknown>;
}
let AwsEc2Fake: new () => Ec2Fake;

const SESSION = {
  accessKeyId: 'ASIA_SESSION',
  secretAccessKey: 'session-secret',
  sessionToken: 'session-token',
  expiration: null,
};

const ENV = {
  [AWS_POOL_DEFINITION_ENV.stackSetName]: 'acme-pool-account',
  [AWS_POOL_DEFINITION_ENV.requestedVcpuQuota]: '512',
  [awsPoolUnitEnvName('ci_runner')]: 'ou-ab12-cirunner',
};

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ ec2FakePath)) as {
    AwsEc2Fake: new () => Ec2Fake;
  });
});

describe('awsPoolDefinitionFromEnv', () => {
  it('reads the StackSet, the kind’s unit, the optional admin role and the quota', () => {
    expect(awsPoolDefinitionFromEnv(ENV, 'ci_runner')).toEqual({
      stackSetName: 'acme-pool-account',
      organizationalUnitId: 'ou-ab12-cirunner',
      stackSetAdminRoleArn: null,
      requestedVcpuQuota: 512,
    });
    const roleArn = 'arn:aws:iam::111111111111:role/acme-pool-stackset-operator';
    expect(
      awsPoolDefinitionFromEnv(
        { ...ENV, [AWS_POOL_DEFINITION_ENV.stackSetAdminRoleArn]: ` ${roleArn} ` },
        'ci_runner',
      ).stackSetAdminRoleArn,
    ).toBe(roleArn);
  });

  it('names every missing variable at once, the unit for the run’s own kind', () => {
    expect(awsPoolDefinitionRequiredEnv('agent_instance')).toEqual([
      'AWS_POOL_STACK_SET_NAME',
      'AWS_POOL_UNIT_ID_AGENT_INSTANCE',
      'AWS_POOL_REQUESTED_VCPU_QUOTA',
    ]);
    expect(() => awsPoolDefinitionFromEnv(ENV, 'agent_instance')).toThrow(
      new OrchestratorNotConfiguredError('set AWS_POOL_UNIT_ID_AGENT_INSTANCE'),
    );
    expect(() => awsPoolDefinitionFromEnv({}, 'ci_runner')).toThrow(
      new OrchestratorNotConfiguredError(
        'set AWS_POOL_STACK_SET_NAME, AWS_POOL_UNIT_ID_CI_RUNNER, AWS_POOL_REQUESTED_VCPU_QUOTA',
      ),
    );
  });

  it('refuses a quota that is not a whole number and a role that is not a role ARN', () => {
    expect(
      awsPoolDefinitionProblems({
        [AWS_POOL_DEFINITION_ENV.requestedVcpuQuota]: '1.5',
        [AWS_POOL_DEFINITION_ENV.stackSetAdminRoleArn]: 'arn:aws:iam::1:user/x',
      }),
    ).toEqual([
      'AWS_POOL_REQUESTED_VCPU_QUOTA must be a whole number of vCPUs, got 1.5',
      'AWS_POOL_STACK_SET_ADMIN_ROLE_ARN is not an IAM role ARN',
    ]);
    expect(awsPoolDefinitionProblems(ENV)).toEqual([]);
  });
});

describe('awsPoolStackOverrides', () => {
  const overrides = (fleetKind: string, reapUntagged = false) =>
    awsPoolStackOverrides({
      shardName: 'pool-1',
      fleetKind,
      reapUntagged,
      requestedVcpuQuota: 512,
    });

  it.each([
    ['ci_runner', 'runner', 'false'],
    ['hosted_agent', 'runner', 'false'],
    ['code_graph_index', 'runner', 'true'],
    ['agent_instance', 'hoster', 'false'],
  ])('%s takes the %s policy, ReapUntagged %s', (kind, policy, reap) => {
    expect(overrides(kind)).toEqual({
      ShardTag: 'pool-1',
      RunnerPolicy: policy,
      ReapUntagged: reap,
      RequestedVcpuQuota: '512',
    });
  });

  it('reaps untagged instances whenever the run asks, whatever the kind', () => {
    for (const kind of ['ci_runner', 'hosted_agent', 'agent_instance']) {
      expect(overrides(kind, true).ReapUntagged).toBe('true');
    }
  });
});

describe('the aws provider’s network step', () => {
  let organization: FakeOrganization;
  let ec2: Ec2Fake;
  let accountId: string;

  function provider() {
    return createAwsShardProvisioningProvider({
      management: () => organization,
      ec2: () => ec2,
      env: () => process.env,
    });
  }

  function ctx(overrides: Partial<ProviderStepContext> = {}): ProviderStepContext {
    return {
      name: 'ci-runner-pool-1',
      fleetKind: 'ci_runner',
      region: 'us-east-1',
      options: {},
      credentialRef: 'FLEET_SHARD_CI_RUNNER_POOL_1',
      account: { accountId, credentials: SESSION },
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.unstubAllEnvs();
    stubPoolDefinitionEnv();
    organization = new FakeOrganization(SESSION);
    ec2 = new AwsEc2Fake();
    buildStacksInto(organization, () => ec2);
    accountId = (
      await organization.createOrganizationAccount({ name: 'ci-runner-pool-1', email: 'a@b.co' })
    ).accountId;
    organization.calls.length = 0;
  });

  it('moves the account into its kind’s unit and applies the instance, creating no EC2 resource', async () => {
    const result = await provider().network(ctx());
    expect(organization.calls).toEqual([
      `moveAccountToOrganizationalUnit:${accountId}:${POOL_DEFINITION.unitId('ci_runner')}`,
      `ensureStackInstance:${accountId}`,
      `readStackInstanceOutputs:${accountId}`,
    ]);
    expect(
      organization.stackInstances.get(`${POOL_DEFINITION.stackSetName}/${accountId}/us-east-1`),
    ).toMatchObject({
      unitId: POOL_DEFINITION.unitId('ci_runner'),
      overrides: {
        ShardTag: 'ci-runner-pool-1',
        RunnerPolicy: 'runner',
        ReapUntagged: 'false',
        RequestedVcpuQuota: POOL_DEFINITION.requestedVcpuQuota,
      },
    });
    expect(ec2.mutations()).toEqual([]);
    expect(result.created).toEqual([
      `unit-membership:${POOL_DEFINITION.unitId('ci_runner')}`,
      `stack-instance:${POOL_DEFINITION.stackSetName}/${accountId}/us-east-1 (created)`,
    ]);
    expect(result.detail).toBe(
      'vpc vpc-ci-runner-pool-1, subnets subnet-ci-runner-pool-1-us-east-1a, ' +
        'subnet-ci-runner-pool-1-us-east-1b, subnet-ci-runner-pool-1-us-east-1c, ' +
        'security group sg-ci-runner-pool-1',
    );
  });

  it('a Host account’s row keeps ReapUntagged on a run with no options', async () => {
    await provider().network(ctx({ options: { [AWS_REAP_UNTAGGED_OPTION]: 'true' } }));
    const shard = { role: 'org_owned', aws: { accountId, region: 'us-east-1' } };
    const again = await provider().network(
      ctx({ options: {}, account: undefined, shard: shard as ProviderStepContext['shard'] }),
    );
    expect(again.created).toEqual([]);
    expect([...organization.stackInstances.values()][0]?.overrides.ReapUntagged).toBe('true');
  });

  it.each([
    ['after the account exists', () => undefined],
    [
      'after the move',
      (o: FakeOrganization) => o.accountUnits.set(accountId, POOL_DEFINITION.unitId('ci_runner')),
    ],
    [
      'after the instance is created',
      (o: FakeOrganization) => {
        o.stackInstanceFailure = new Error('the run died waiting for CURRENT');
      },
    ],
  ])('a run that dies %s and runs again creates no second instance', async (_label, arrange) => {
    arrange(organization);
    await provider()
      .network(ctx())
      .catch(() => undefined);
    const replay = await provider().network(ctx());
    expect(organization.stackInstances.size).toBe(1);
    expect(replay.created.filter((c) => c.startsWith('unit-membership'))).toEqual([]);
    const third = await provider().network(ctx());
    expect(third.created).toEqual([]);
    expect(organization.stackInstances.size).toBe(1);
    expect(ec2.mutations()).toEqual([]);
  });

  it('refuses an account whose tagged network the StackSet did not build, before moving it', async () => {
    ec2.seedShardNetwork('ci-runner-pool-1');
    const thrown = await provider()
      .network(ctx())
      .catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(FleetShardProvisioningRefusedError);
    expect(String((thrown as Error).message)).toMatch(/adopt it into the pool-account definition/);
    expect(organization.accountUnits.size).toBe(0);
    expect(organization.stackInstances.size).toBe(0);
  });

  it('refuses when a tagged resource is not the one the stack built, naming it', async () => {
    organization.stackBuilder = null;
    organization.stackOutputs = {};
    const first = await provider()
      .network(ctx())
      .catch((err: unknown) => err);
    // Nothing is tagged: the read-back names the missing VPC.
    expect(first).toMatchObject({ name: 'AwsShardNetworkMissingError', resource: 'VPC' });

    ec2.seedShardNetwork('ci-runner-pool-1', ['us-east-1a']);
    const instance = [...organization.stackInstances.values()][0]!;
    instance.outputs = {
      VpcId: 'vpc-ci-runner-pool-1',
      InternetGatewayId: 'igw-ci-runner-pool-1',
      RouteTableId: 'rtb-ci-runner-pool-1',
      SecurityGroupId: 'sg-other',
      SubnetIdA: 'subnet-ci-runner-pool-1-us-east-1a',
    };
    const second = await provider()
      .network(ctx())
      .catch((err: unknown) => err);
    expect(second).toBeInstanceOf(FleetShardProvisioningRefusedError);
    expect((second as FleetShardProvisioningRefusedError).problems).toEqual([
      'AWS shard network ci-runner-pool-1: security group: the stack built sg-other, the ' +
        'ci-runner-pool-1 tag finds sg-ci-runner-pool-1',
    ]);
  });

  it('lists the definition’s variables in requiredEnv, and its problems in validate', () => {
    expect(provider().requiredEnv(ctx())).toEqual(
      expect.arrayContaining([
        'AWS_POOL_STACK_SET_NAME',
        'AWS_POOL_UNIT_ID_CI_RUNNER',
        'AWS_POOL_REQUESTED_VCPU_QUOTA',
      ]),
    );
    vi.stubEnv(AWS_POOL_DEFINITION_ENV.requestedVcpuQuota, 'lots');
    expect(provider().validate(ctx())).toEqual([
      'AWS_POOL_REQUESTED_VCPU_QUOTA must be a whole number of vCPUs, got lots',
    ]);
  });

  it('confirms the stack-built runner role by assuming it, and never creates it', async () => {
    await provider().network(ctx());
    await expect(provider().runtimeCredential(ctx())).resolves.toEqual({
      created: [],
      confirmed: true,
    });
    expect(organization.calls.some((c) => c.startsWith('ensureRunnerRole'))).toBe(false);
    organization.runnerRoles.clear();
    await expect(provider().runtimeCredential(ctx())).resolves.toEqual({
      created: [],
      confirmed: false,
    });
  });
});
