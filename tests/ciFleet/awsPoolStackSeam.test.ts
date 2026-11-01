import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  awsManagementCredentials,
  createAwsManagementApi,
  readAwsShardNetwork,
  type ContainerSpec,
  type Ec2Api,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import { capsForPlanKey, HOST_PLAN_KEY } from '@/lib/billing/planCaps';
import { AWS_MEMBER_EMAIL_TEMPLATE_ENV } from '@/lib/fleetShards/awsMemberAccountPlan';
import { AWS_POOL_DEFINITION_ENV, awsPoolUnitEnvName } from '@/lib/fleetShards/awsPoolDefinition';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { AWS_RUNNER_AMI_ENV_VAR, orchestratorForShard } from '@/lib/orchestrator';
import { fleetShardProvisioningService } from '@/lib/services/fleetShardProvisioningService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { hostAccountReconcileService } from '@/lib/services/hostAccountReconcileService';
import { runFleetAdmin } from '@/scripts/fleet/fleetAdmin';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  ADD_SHARD_ENTERPRISE_SLUG as SLUG,
  POOL_DEFINITION,
  installAddShardGithub,
  newGithubWorld,
  stubPoolDefinitionEnv,
} from '../helpers/addShardFakes';
import {
  TEST_MANAGEMENT_KEY,
  stubAwsManagementCredential,
  type AwsManagementCredentialMode,
} from '../helpers/awsRunnerRoleFake';
import { FAKE_AWS_KEYS, FakeAwsWorld } from '../helpers/fakeAwsSdk';

// THE STORY GATE FOR MOTIR-9708'S motir-core HALF (MOTIR-9850): the four cards'
// pieces, run TOGETHER against one fake AWS. The real `aws` provisioning provider
// (its default dependencies), the real management port (`createAwsManagementApi`)
// and the real EC2 read-back run over a stateful fake of the AWS SDK
// (`fakeAwsSdk.ts`: STS, Organizations, CloudFormation StackSets, Service Quotas)
// and one in-memory EC2 per member account. Only the SDK clients are stubbed, so
// what this asserts is what add-shard SENDS: the commands, their order and their
// inputs, and the identifiers the network step and the shard row end up with.
//
// Every case runs twice, once per management-credential mode: the key pair core
// holds on Fly, and the role ARN alone on the SDK's default chain (MOTIR-9839).
//
// ⚠️ `@motir/orchestrator` RESOLVES TO THE PACKAGE SOURCE in this file, as in
// `awsShardSeam.test.ts`: the EC2 fake throws the source's `Ec2ApiError`.

const paths = vi.hoisted(() => ({
  orchestratorSource: '../../packages/orchestrator/src/index',
  ec2Fake: '../../packages/orchestrator/test/contract/awsEc2Fake',
}));

/** The world the mocked package builds its clients over. */
const world = vi.hoisted(() => ({
  aws: null as unknown,
  ec2For: null as unknown as (accountId: string) => object,
  /** The access key id each EC2 client was built with, in order. */
  ec2Keys: [] as string[],
}));

vi.mock('@motir/orchestrator', async () => {
  const source = (await import(
    /* @vite-ignore */ paths.orchestratorSource
  )) as typeof import('@motir/orchestrator');
  const aws = () => world.aws as FakeAwsWorld;
  return {
    ...source,
    // The real port; only its SDK clients are the fake's.
    createAwsManagementApi: (
      management: Parameters<typeof source.createAwsManagementApi>[0],
      options: Parameters<typeof source.createAwsManagementApi>[1] = {},
    ) =>
      source.createAwsManagementApi(management, {
        ...options,
        clientFactory: aws().factory,
        sleep: async () => {},
      }),
    // A key is a member session add-shard holds; a provider is the adapter's
    // runner-role session, resolved on the first call (MOTIR-9847).
    createEc2Api: (config: {
      accessKeyId?: string;
      credentialProvider?: () => Promise<{ accessKeyId: string }>;
    }) => {
      const forKey = (key: string) => {
        world.ec2Keys.push(key);
        const accountId = aws().accountOfKey(key);
        if (!accountId) throw new Error(`no member account signs with ${key}`);
        return world.ec2For(accountId);
      };
      if (config.accessKeyId) return forKey(config.accessKeyId);
      const provider = config.credentialProvider!;
      let resolved: Promise<object> | null = null;
      return new Proxy(
        {},
        {
          get(_t, method) {
            if (method === 'then') return undefined;
            return async (...args: unknown[]) => {
              const ec2 = (await (resolved ??= provider().then((s) =>
                forKey(s.accessKeyId),
              ))) as Record<PropertyKey, (...a: unknown[]) => unknown>;
              return ec2[method]!.apply(ec2, args);
            };
          },
        },
      );
    },
  };
});

/** The surface of `AwsEc2Fake` this file drives. */
interface Ec2Fake extends Ec2Api {
  zones: { zoneName: string }[];
  calls: { method: string }[];
  mutations(): { method: string }[];
  count(method: string): number;
  seedShardNetwork(
    shardTag: string,
    zones?: readonly string[],
  ): {
    vpcId: string;
    internetGatewayId: string;
    routeTableId: string;
    groupId: string;
    subnetIds: string[];
  };
}

/** The template's parameters a stack instance overrides — motir-infra's
 *  `POOL_TEMPLATE_PARAMETERS`, spelled out so a rename on either side is red here. */
const STACK_PARAMETERS = ['ReapUntagged', 'RequestedVcpuQuota', 'RunnerPolicy', 'ShardTag'];
/** The template's outputs — motir-infra's `POOL_TEMPLATE_OUTPUTS`. */
const STACK_OUTPUTS = [
  'VpcId',
  'InternetGatewayId',
  'RouteTableId',
  'SecurityGroupId',
  'RunnerRoleArn',
  'TrailArn',
];
const SUBNET_OUTPUT = /^SubnetId[A-Z]$/;
/** Every EC2 call that would build a network, which add-shard no longer makes. */
const NETWORK_CREATES = [
  'createVpc',
  'createInternetGateway',
  'attachInternetGateway',
  'createRouteTable',
  'createRoute',
  'associateRouteTable',
  'createSubnet',
  'createSecurityGroup',
];

const REGION = 'us-east-1';
const KINDS = [
  { fleetKind: 'ci_runner', name: 'ci-runner-use1-7', policy: 'runner', reap: 'false' },
  { fleetKind: 'code_graph_index', name: 'indexer-use1-7', policy: 'runner', reap: 'true' },
  { fleetKind: 'hosted_agent', name: 'hosted-agent-use1-7', policy: 'runner', reap: 'false' },
  { fleetKind: 'agent_instance', name: 'agent-host-use1-7', policy: 'hoster', reap: 'false' },
] as const;
const ORG = 'motir-fleet-use1-7';
const TEMPLATE = 'aws+{name}@motir.co';
const AMI = 'ami-0fedcba9876543210';

let AwsEc2Fake: new () => Ec2Fake;
let aws: FakeAwsWorld;
let timeline: string[];
let ec2s: Map<string, Ec2Fake>;
let unregister: () => void;
let operatorEmail: string;

function ec2Of(accountId: string): Ec2Fake {
  let ec2 = ec2s.get(accountId);
  if (!ec2) {
    const fake = new AwsEc2Fake();
    // Every EC2 call joins the SDK's timeline, so the order is one order.
    const record = (fake as unknown as { record(m: string, i: unknown): void }).record.bind(fake);
    (fake as unknown as { record(m: string, i: unknown): void }).record = (method, input) => {
      timeline.push(`ec2:${method}`);
      record(method, input);
    };
    ec2s.set(accountId, fake);
    ec2 = fake;
  }
  return ec2;
}

function newWorld(): FakeAwsWorld {
  return new FakeAwsWorld(({ accountId, region, overrides }) => {
    const ec2 = ec2Of(accountId);
    const zones = ec2.zones
      .map((z) => z.zoneName)
      .filter((z) => z.startsWith(region))
      .sort()
      .slice(0, 3);
    const built = ec2.seedShardNetwork(overrides['ShardTag'] ?? '', zones);
    return {
      ...built,
      subnets: zones.map((zone, i) => ({ zone, subnetId: built.subnetIds[i]! })),
    };
  }, timeline);
}

async function addShard(
  kind: (typeof KINDS)[number],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFleetAdmin(
    [
      'add-shard',
      '--create-org',
      '--provider',
      'aws',
      '--fleet-kind',
      kind.fleetKind,
      '--name',
      kind.name,
      '--github-org',
      ORG,
      '--admin-login',
      'zhuyue11',
      '--account-email',
      `aws+${kind.name}@motir.co`,
      '--operator',
      operatorEmail,
    ],
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** The network step's recorded detail: `vpc …, subnets …, security group …`. */
function networkDetail(out: string) {
  const line = /^network\s+(?:done|already) — (.*)$/m.exec(out)?.[1] ?? '';
  const match = /vpc (\S+), subnets (.+), security group (\S+)$/.exec(line);
  if (!match) throw new Error(`no network detail in:\n${out}`);
  return { vpcId: match[1], subnetIds: match[2]!.split(', ').sort(), securityGroupId: match[3] };
}

const at = (event: string) => timeline.indexOf(event);

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ paths.ec2Fake)) as {
    AwsEc2Fake: new () => Ec2Fake;
  });
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe.each<AwsManagementCredentialMode>(['key', 'role'])(
  'with the management credential as the %s',
  (mode) => {
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
      vi.stubEnv('GITHUB_ENTERPRISE_ADMIN_TOKEN', 'ghp_admin');
      stubAwsManagementCredential(mode);
      stubPoolDefinitionEnv();
      vi.stubEnv(AWS_POOL_DEFINITION_ENV.stackSetAdminRoleArn, '');
      vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
      vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, AMI);
      _resetInstallationTokenCache();
      _resetProvisioningInstallationCache();
      const github = newGithubWorld();
      github.orgs.add(ORG);
      installAddShardGithub(github, 'ghs_installation');
      timeline = [];
      ec2s = new Map();
      aws = newWorld();
      world.aws = aws;
      world.ec2For = ec2Of;
      world.ec2Keys = [];
      // The real provider, on its DEFAULT dependencies.
      unregister = registerShardProvisioningProvider(createAwsShardProvisioningProvider());
      operatorEmail = (await createTestUser()).email;
      await adminDb.user.update({
        where: { email: operatorEmail },
        data: { platformRole: 'superadmin' },
      });
    });

    afterEach(() => {
      unregister();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it('the management session is assumed with the key, or on the default chain', async () => {
      await addShard(KINDS[0]);
      const first = aws.sent('AssumeRoleCommand')[0]!;
      expect(first.input['RoleArn']).toBe('arn:aws:iam::576360162297:role/motir-add-shard');
      expect(first.accessKeyId).toBe(mode === 'key' ? TEST_MANAGEMENT_KEY.accessKeyId : undefined);
    });

    describe.each(KINDS)('add-shard for a new $fleetKind account', (kind) => {
      it('moves it to its unit, applies one instance, reads the outputs, then the tags', async () => {
        const result = await addShard(kind);

        expect(result.err).toBe('');
        expect(aws.sent('CreateAccountCommand')).toHaveLength(1);
        const account = aws.account(kind.name)!;
        const unit = POOL_DEFINITION.unitId(kind.fleetKind);

        // Into its kind's unit…
        expect(aws.sent('MoveAccountCommand').map((c) => c.input)).toEqual([
          { AccountId: account.id, SourceParentId: 'r-root', DestinationParentId: unit },
        ]);
        // …one instance, with this run's overrides…
        const creates = aws.sent('CreateStackInstancesCommand');
        expect(creates).toHaveLength(1);
        expect(creates[0]!.input).toMatchObject({
          StackSetName: POOL_DEFINITION.stackSetName,
          Regions: [REGION],
          DeploymentTargets: {
            OrganizationalUnitIds: [unit],
            Accounts: [account.id],
            AccountFilterType: 'INTERSECTION',
          },
        });
        const overrides = creates[0]!.input['ParameterOverrides'] as {
          ParameterKey: string;
          ParameterValue: string;
        }[];
        expect(overrides.map((p) => p.ParameterKey)).toEqual(STACK_PARAMETERS);
        expect(
          Object.fromEntries(overrides.map((p) => [p.ParameterKey, p.ParameterValue])),
        ).toEqual({
          ShardTag: kind.name,
          RunnerPolicy: kind.policy,
          ReapUntagged: kind.reap,
          RequestedVcpuQuota: POOL_DEFINITION.requestedVcpuQuota,
        });
        expect(aws.sent('UpdateStackInstancesCommand')).toEqual([]);

        // …in that order, the outputs before the tag read-back.
        const move = at('organizations:MoveAccountCommand');
        const create = at('cloudformation:CreateStackInstancesCommand');
        const outputs = at('cloudformation:DescribeStacksCommand');
        const readBack = timeline.findIndex((e, i) => i > outputs && e.startsWith('ec2:describe'));
        expect(move).toBeGreaterThan(-1);
        expect(move).toBeLessThan(create);
        expect(create).toBeLessThan(outputs);
        expect(readBack).toBeGreaterThan(outputs);

        // No EC2 call builds a network.
        const ec2 = ec2Of(account.id);
        expect(ec2.mutations().filter((c) => NETWORK_CREATES.includes(c.method))).toEqual([]);
        expect(ec2.mutations()).toEqual([]);
      });

      it('records the network ids the stack output, equal to what the tag finds', async () => {
        const result = await addShard(kind);
        const account = aws.account(kind.name)!;
        const instance = [...aws.instances.values()].find((i) => i.accountId === account.id)!;

        const keys = Object.keys(instance.outputs);
        expect(keys.filter((k) => !SUBNET_OUTPUT.test(k))).toEqual(STACK_OUTPUTS);
        const subnetOutputs = keys
          .filter((k) => SUBNET_OUTPUT.test(k))
          .map((k) => instance.outputs[k]);

        const detail = networkDetail(result.out);
        expect(detail).toEqual({
          vpcId: instance.outputs['VpcId'],
          subnetIds: [...subnetOutputs].sort(),
          securityGroupId: instance.outputs['SecurityGroupId'],
        });
        const tagged = await readAwsShardNetwork({
          ec2: ec2Of(account.id),
          regionId: REGION,
          shardTag: kind.name,
        });
        expect(detail).toEqual({
          vpcId: tagged.vpcId,
          subnetIds: tagged.subnets.map((s) => s.subnetId).sort(),
          securityGroupId: tagged.securityGroupId,
        });
        // The row records the account the ids came from.
        const rows = await adminDb.fleetShard.findMany({ where: { name: kind.name } });
        expect(rows.map((r) => [r.provider, r.awsAccountId, r.awsRegion])).toEqual([
          ['aws', account.id, REGION],
        ]);
      });
    });

    it('an output id that is not the tagged resource refuses, naming it, and writes no row', async () => {
      aws.outputOverrides.set('SecurityGroupId', 'sg-0someoneelses');

      const result = await addShard(KINDS[0]);

      expect(result.code).not.toBe(0);
      expect(result.err).toContain(
        `AWS shard network ${KINDS[0].name}: security group: the stack built sg-0someoneelses, ` +
          `the ${KINDS[0].name} tag finds sg-${KINDS[0].name}`,
      );
      expect(await adminDb.fleetShard.count()).toBe(0);
    });

    it.each([
      {
        missing: 'the VpcId output',
        drop: ['VpcId'],
        names: 'the stack instance has no VpcId output',
      },
      {
        missing: 'one zone’s SubnetId output',
        drop: ['SubnetIdC'],
        names: `subnet subnet-${KINDS[0].name}-us-east-1c in us-east-1c carries the tag but the stack did not build it`,
      },
      {
        missing: 'every SubnetId output',
        drop: ['SubnetIdA', 'SubnetIdB', 'SubnetIdC'],
        names: 'the stack instance has no SubnetId output',
      },
    ])('a stack instance missing $missing refuses, naming it, and writes no row', async (c) => {
      for (const key of c.drop) aws.outputOverrides.set(key, null);

      const result = await addShard(KINDS[0]);

      expect(result.code).not.toBe(0);
      expect(result.err).toContain(`AWS shard network ${KINDS[0].name}: ${c.names}`);
      expect(await adminDb.fleetShard.count()).toBe(0);
    });

    it('an output for a zone the tag finds no subnet in refuses, naming the zone', async () => {
      aws.outputOverrides.set('SubnetIdD', 'subnet-0nowhere');

      const result = await addShard(KINDS[0]);

      expect(result.code).not.toBe(0);
      expect(result.err).toContain(
        `AWS shard network ${KINDS[0].name}: subnet in zone d: the stack built subnet-0nowhere, ` +
          `the ${KINDS[0].name} tag finds none`,
      );
      expect(await adminDb.fleetShard.count()).toBe(0);
    });

    it('a re-run whose instance read fails stops there, creating and moving nothing', async () => {
      await addShard(KINDS[0]);
      const before = aws.calls.length;
      aws.failNext(
        'DescribeStackInstanceCommand',
        Object.assign(new Error('slow down'), {
          name: 'Throttling',
          $metadata: { httpStatusCode: 400 },
        }),
      );

      const result = await addShard(KINDS[0]);

      expect(result.code).not.toBe(0);
      const again = aws.calls.slice(before).map((c) => c.command);
      expect(again).not.toContain('MoveAccountCommand');
      expect(again).not.toContain('CreateStackInstancesCommand');
      expect(aws.instances.size).toBe(1);
    });

    it('with a StackSet-operator role configured, the StackSet calls run on its session', async () => {
      const operator = 'arn:aws:iam::111111111111:role/motir-pool-stackset-operator';
      vi.stubEnv(AWS_POOL_DEFINITION_ENV.stackSetAdminRoleArn, operator);

      const result = await addShard(KINDS[0]);

      expect(result.err).toBe('');
      expect(aws.sent('AssumeRoleCommand').map((c) => c.input['RoleArn'])).toContain(operator);
      for (const command of ['CreateStackInstancesCommand', 'DescribeStackInstanceCommand']) {
        const signers = new Set(aws.sent(command).map((c) => c.accessKeyId));
        expect(signers).toEqual(new Set([FAKE_AWS_KEYS.operator]));
      }
      // The stack's outputs are still read inside the member account.
      expect(aws.sent('DescribeStacksCommand').map((c) => c.accessKeyId)).toEqual([
        FAKE_AWS_KEYS.member(aws.account(KINDS[0].name)!.id),
      ]);
    });

    it('a member account whose admin role cannot be assumed stops before the network', async () => {
      aws.deniedRoles.add('OrganizationAccountAccessRole');

      const result = await addShard(KINDS[0]);

      expect(result.code).not.toBe(0);
      expect(`${result.out}\n${result.err}`).toContain('OrganizationAccountAccessRole');
      expect(aws.sent('MoveAccountCommand')).toEqual([]);
      expect(aws.sent('CreateStackInstancesCommand')).toEqual([]);
    });

    describe.each([
      { point: 'the account exists', dies: 'ListParentsCommand' },
      { point: 'it is in the unit', dies: 'DescribeStackInstanceCommand' },
      { point: 'the instance is created', dies: 'DescribeStacksCommand' },
    ])('a run that dies once $point', ({ dies }) => {
      it('runs again to one account, one instance and one row', async () => {
        aws.failNext(dies);
        const first = await addShard(KINDS[0]);
        expect(first.code).not.toBe(0);
        const createdBefore = aws.sent('CreateStackInstancesCommand').length;
        const callsBefore = aws.calls.length;

        const second = await addShard(KINDS[0]);

        expect(second.err).toBe('');
        expect(aws.sent('CreateAccountCommand')).toHaveLength(1);
        expect(aws.instances.size).toBe(1);
        expect(aws.sent('CreateStackInstancesCommand')).toHaveLength(1);
        expect(aws.sent('UpdateStackInstancesCommand')).toEqual([]);
        if (createdBefore === 1) {
          // The instance was CURRENT with equal overrides: the re-run files nothing.
          const resent = aws.calls.slice(callsBefore).map((c) => c.command);
          expect(resent).not.toContain('CreateStackInstancesCommand');
          expect(resent).not.toContain('MoveAccountCommand');
        }
        expect(await adminDb.fleetShard.count({ where: { name: KINDS[0].name } })).toBe(1);
      });
    });

    it('a run where everything is already right files no create, move or update', async () => {
      await addShard(KINDS[0]);
      const before = aws.calls.length;

      await addShard(KINDS[0]);

      const again = aws.calls.slice(before).map((c) => c.command);
      for (const write of [
        'CreateAccountCommand',
        'MoveAccountCommand',
        'CreateStackInstancesCommand',
        'UpdateStackInstancesCommand',
      ]) {
        expect(again).not.toContain(write);
      }
      expect(await adminDb.fleetShard.count()).toBe(1);
    });

    it('an unset stack-set variable refuses before any AWS call, naming every one', async () => {
      vi.stubEnv(AWS_POOL_DEFINITION_ENV.stackSetName, '');
      vi.stubEnv(AWS_POOL_DEFINITION_ENV.requestedVcpuQuota, '');
      vi.stubEnv(awsPoolUnitEnvName('ci_runner'), '');

      const result = await addShard(KINDS[0]);

      expect(result.code).not.toBe(0);
      for (const name of [
        AWS_POOL_DEFINITION_ENV.stackSetName,
        awsPoolUnitEnvName('ci_runner'),
        AWS_POOL_DEFINITION_ENV.requestedVcpuQuota,
      ]) {
        expect(result.err).toContain(name);
      }
      expect(aws.calls).toEqual([]);
      expect(await adminDb.fleetShard.count()).toBe(0);
    });

    describe('the unattended add-shard reaches the same stack-instance path', () => {
      const management = () => createAwsManagementApi(awsManagementCredentials(process.env));

      async function primary(name: string, fleetKind: string, accountId: string) {
        return fleetShardService.createShard({
          name,
          fleetKind,
          provider: 'aws',
          state: 'active',
          githubOrg: ORG,
          githubInstallationId: '9001',
          awsAccountId: accountId,
          awsRegion: REGION,
          credentialRef: `FLEET_SHARD_${name.toUpperCase().replace(/-/g, '_')}`,
          limits: { vcpuQuota: 640 },
        });
      }

      /** Every account the run created got exactly one instance, from the unit. */
      function expectStackBuilt(): void {
        const created = aws.sent('CreateAccountCommand').length;
        expect(created).toBeGreaterThan(0);
        expect(aws.instances.size).toBe(created);
        for (const instance of aws.instances.values()) {
          const account = [...aws.accounts.values()].find((a) => a.id === instance.accountId)!;
          expect(account.parentId).toMatch(/^ou-test-/);
          expect(ec2Of(account.id).mutations()).toEqual([]);
        }
      }

      beforeEach(async () => {
        await createTestUser({ email: MOTIR_SYSTEM_USER_EMAIL });
      });

      it('self-growth’s spare', async () => {
        await primary('ci-runner-use1-1', 'ci_runner', '111122223333');

        const result = await fleetShardProvisioningService.addSpareShard(
          { fleetKind: 'ci_runner' },
          {
            raise: { management, now: () => new Date() },
            env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: TEMPLATE },
          },
        );

        expect(result.shard).toMatchObject({ role: 'spare', provider: 'aws' });
        expectStackBuilt();
      });

      it('the Host-account reconcile', async () => {
        await primary('ci-runner-use1-1', 'ci_runner', '111122223331');
        await primary('hosted-agent-use1-1', 'hosted_agent', '111122223332');
        await primary('indexer-use1-1', 'code_graph_index', '111122223333');
        await primary('agent-host-use1-1', 'agent_instance', '111122223334');
        const org = await adminDb.organization.create({
          data: { name: 'Host org', slug: `host-seam-${Date.now()}`, aiIncludedSeat: true },
        });

        await hostAccountReconcileService.reconcileOrganization(org.id, {
          now: () => new Date(),
          alert: () => {},
          capsFor: async () => ({
            kind: 'capped',
            planKey: HOST_PLAN_KEY,
            planName: 'Host',
            caps: capsForPlanKey(HOST_PLAN_KEY)!,
          }),
          provisioning: {
            raise: { management, now: () => new Date() },
            env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: TEMPLATE },
          },
        });

        expect(await adminDb.fleetShard.count({ where: { ownerOrganizationId: org.id } })).toBe(4);
        expectStackBuilt();
      });
    });

    it('a runner boots on the assumed role even with a stray key under its credentialRef', async () => {
      await addShard(KINDS[0]);
      const shard = (await fleetShardService.findShardByName(KINDS[0].name))!;
      const prefix = shard.credentialRef!;
      vi.stubEnv(`${prefix}_ACCESS_KEY_ID`, 'AKIA_STRAY_KEY');
      vi.stubEnv(`${prefix}_SECRET_ACCESS_KEY`, 'stray-secret');
      world.ec2Keys = [];
      const assumesBefore = aws.sent('AssumeRoleCommand').length;

      await orchestratorForShard(shard).provision(SPEC);

      const accountId = shard.aws!.accountId;
      expect(ec2Of(accountId).count('runInstances')).toBe(1);
      expect(world.ec2Keys).toEqual([FAKE_AWS_KEYS.runner(accountId)]);
      expect(
        aws
          .sent('AssumeRoleCommand')
          .slice(assumesBefore)
          .map((c) => c.input['RoleArn']),
      ).toContain(`arn:aws:iam::${accountId}:role/motir-fleet-runner`);
      expect(JSON.stringify(aws.calls)).not.toContain('AKIA_STRAY_KEY');
    });
  },
);

const SPEC: ContainerSpec = {
  orgId: 'org-seam',
  workspaceId: 'ws-seam',
  projectId: 'proj-seam',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 98_500,
  image: 'unused-on-aws',
  size: FLEET_CONTAINER_SIZE,
  env: {
    ACTIONS_RUNNER_INPUT_JITCONFIG: 'eyJzZWFtIjp0cnVlfQ==',
    ACTIONS_RUNNER_CONFIG_ARGS: '--no-default-labels',
    MOTIR_RUNNER_LABEL: 'motir-fleet',
    MOTIR_INTENT_ID: 'intent-seam',
    MOTIR_WORKFLOW_JOB_ID: '98500',
  },
  timeoutSeconds: 3600,
  region: REGION,
};
