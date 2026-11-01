import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { describe, expect, it } from 'vitest';
import {
  AWS_STACK_INSTANCE_TIMEOUT_MS,
  AwsManagementApiError,
  AwsStackInstanceFailedError,
  AwsStackOutputsMissingError,
  awsStackSetOperationId,
  createAwsManagementApi,
  createAwsManagementSdkClient,
  parameterOverridesFor,
  parameterOverridesOf,
  sameParameterOverrides,
  stackInstanceOutcome,
  type AwsManagementClientFactory,
  type AwsManagementOptions,
  type AwsManagementService,
} from '../src/index';

// The StackSet half of the AWS management port (MOTIR-9844), over a stubbed SDK
// client the way `awsManagement.test.ts` drives the rest: every call recorded by
// service, command and input, the clock and `sleep` injected.

const MANAGEMENT = { roleArn: 'arn:aws:iam::576360162297:role/motir-add-shard' };
const OPERATOR_ROLE = 'arn:aws:iam::111111111111:role/motir-pool-stackset-operator';

interface SentCall {
  service: AwsManagementService;
  region: string;
  accessKeyId: string | undefined;
  hasCredentials: boolean;
  command: string;
  input: Record<string, unknown>;
}

type Handler = (input: Record<string, unknown>, call: SentCall) => unknown;

function sdkError(name: string, status = 400): Error {
  return Object.assign(new Error(`AWS said: ${name} with a long message`), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

function session(id: string): Record<string, unknown> {
  return {
    Credentials: {
      AccessKeyId: `ASIA${id}`,
      SecretAccessKey: `secret-${id}`,
      SessionToken: `token-${id}`,
      Expiration: new Date(Date.now() + 900_000),
    },
  };
}

const assume: Handler = (input) => {
  const arn = String(input['RoleArn']);
  if (arn.includes('motir-add-shard')) return session('MGMT');
  if (arn.includes('stackset-operator')) return session('OPERATOR');
  return session('MEMBER');
};

function harness(handlers: Record<string, Handler>, options: AwsManagementOptions = {}) {
  const calls: SentCall[] = [];
  const clock = { t: 0 };
  const factory: AwsManagementClientFactory = (service, config) => ({
    async send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      const call: SentCall = {
        service,
        region: config.region,
        accessKeyId: config.credentials?.accessKeyId,
        hasCredentials: 'credentials' in config,
        command: name,
        input,
      };
      calls.push(call);
      const handler = handlers[name];
      if (!handler) throw new Error(`unstubbed ${name}`);
      return handler(input, call);
    },
  });
  const api = createAwsManagementApi(MANAGEMENT, {
    clientFactory: factory,
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
    ...options,
  });
  const sent = (command: string) => calls.filter((c) => c.command === command);
  return { api, calls, clock, sent };
}

const TARGET = {
  stackSetName: 'motir-pool-account',
  accountId: '000000000001',
  region: 'eu-west-1',
};
const OVERRIDES = { ShardTag: 'ci-eu-1', RunnerPolicy: 'runner', ReapUntagged: 'true' };
const UNIT = 'ou-ab12-cdef3456';
const INPUT = { ...TARGET, organizationalUnitId: UNIT, parameterOverrides: OVERRIDES };

function instance(
  status: string,
  overrides: Record<string, string> | null,
  extra: Record<string, unknown> = {},
) {
  return {
    StackInstance: {
      Status: status,
      StackId: 'arn:aws:cloudformation:eu-west-1:000000000001:stack/StackSet-motir-pool/abc',
      ParameterOverrides: overrides ? parameterOverridesFor(overrides) : [],
      ...extra,
    },
  };
}

/** A StackSet whose instance answers each read from `reads`, the last one repeating. */
function stackSet(reads: (() => unknown)[], more: Record<string, Handler> = {}) {
  let i = 0;
  return {
    AssumeRoleCommand: assume,
    DescribeStackInstanceCommand: () => reads[Math.min(i++, reads.length - 1)]!(),
    CreateStackInstancesCommand: (input: Record<string, unknown>) => ({
      OperationId: input['OperationId'],
    }),
    UpdateStackInstancesCommand: (input: Record<string, unknown>) => ({
      OperationId: input['OperationId'],
    }),
    DescribeStackSetOperationCommand: () => ({ StackSetOperation: { Status: 'SUCCEEDED' } }),
    ...more,
  };
}

const absent = () => {
  throw sdkError('StackInstanceNotFoundException', 404);
};

describe('moveAccountToOrganizationalUnit', () => {
  it('moves the account from its current parent when it sits elsewhere', async () => {
    const { api, sent } = harness({
      AssumeRoleCommand: assume,
      ListParentsCommand: () => ({ Parents: [{ Id: 'r-root', Type: 'ROOT' }] }),
      MoveAccountCommand: () => ({}),
    });
    await expect(api.moveAccountToOrganizationalUnit('000000000001', UNIT)).resolves.toEqual({
      moved: true,
    });
    expect(sent('MoveAccountCommand').map((c) => c.input)).toEqual([
      { AccountId: '000000000001', SourceParentId: 'r-root', DestinationParentId: UNIT },
    ]);
    expect(sent('MoveAccountCommand')[0]?.accessKeyId).toBe('ASIAMGMT');
  });

  it('sends no move when the account is already under the unit, so a second call moves nothing', async () => {
    let parent = 'r-root';
    const { api, sent } = harness({
      AssumeRoleCommand: assume,
      ListParentsCommand: () => ({ Parents: [{ Id: parent }] }),
      MoveAccountCommand: (input) => {
        parent = String(input['DestinationParentId']);
        return {};
      },
    });
    await api.moveAccountToOrganizationalUnit('000000000001', UNIT);
    await expect(api.moveAccountToOrganizationalUnit('000000000001', UNIT)).resolves.toEqual({
      moved: false,
    });
    expect(sent('MoveAccountCommand')).toHaveLength(1);
  });

  it('surfaces a refusal as AwsManagementApiError with the service and code', async () => {
    const { api } = harness({
      AssumeRoleCommand: assume,
      ListParentsCommand: () => {
        throw sdkError('ChildNotFoundException');
      },
    });
    await expect(api.moveAccountToOrganizationalUnit('000000000001', UNIT)).rejects.toEqual(
      new AwsManagementApiError('organizations', 'ChildNotFoundException', 400),
    );
  });
});

describe('awsStackSetOperationId', () => {
  it('is the same for the same inputs, whatever the key order, and different for other overrides', () => {
    const id = awsStackSetOperationId('create', TARGET, OVERRIDES);
    expect(id).toMatch(/^[a-zA-Z][a-zA-Z0-9-]{0,127}$/);
    expect(
      awsStackSetOperationId('create', TARGET, {
        ReapUntagged: 'true',
        ShardTag: 'ci-eu-1',
        RunnerPolicy: 'runner',
      }),
    ).toBe(id);
    expect(
      awsStackSetOperationId('create', TARGET, { ...OVERRIDES, ShardTag: 'ci-eu-2' }),
    ).not.toBe(id);
    expect(
      awsStackSetOperationId('create', { ...TARGET, accountId: '000000000002' }, OVERRIDES),
    ).not.toBe(id);
  });

  it('compares overrides exactly', () => {
    expect(sameParameterOverrides({ ...OVERRIDES }, OVERRIDES)).toBe(true);
    expect(sameParameterOverrides({ ...OVERRIDES, Extra: 'x' }, OVERRIDES)).toBe(false);
    expect(sameParameterOverrides({ ...OVERRIDES, ShardTag: 'x' }, OVERRIDES)).toBe(false);
  });

  it('reads AWS’s ParameterOverrides leniently and writes them in key order (MOTIR-9850)', () => {
    // AWS may leave a value out (an empty override) or answer an entry with no key.
    expect(
      parameterOverridesOf([
        { ParameterKey: 'ShardTag', ParameterValue: 'ci-eu-1' },
        { ParameterKey: 'ReapUntagged' },
        { ParameterValue: 'orphan' },
      ]),
    ).toEqual({ ShardTag: 'ci-eu-1', ReapUntagged: '' });
    expect(parameterOverridesOf(undefined)).toEqual({});
    expect(parameterOverridesFor({ b: '2', a: undefined as unknown as string })).toEqual([
      { ParameterKey: 'a', ParameterValue: '' },
      { ParameterKey: 'b', ParameterValue: '2' },
    ]);
  });
});

describe('ensureStackInstance', () => {
  it('creates an absent instance, as the delegated admin, for the unit and account only', async () => {
    const { api, sent } = harness(stackSet([absent, absent, () => instance('CURRENT', OVERRIDES)]));
    await expect(api.ensureStackInstance(INPUT)).resolves.toEqual({ action: 'created' });
    const creates = sent('CreateStackInstancesCommand');
    expect(creates.map((c) => c.input)).toEqual([
      {
        StackSetName: TARGET.stackSetName,
        Regions: [TARGET.region],
        ParameterOverrides: parameterOverridesFor(OVERRIDES),
        CallAs: 'DELEGATED_ADMIN',
        DeploymentTargets: {
          OrganizationalUnitIds: [UNIT],
          Accounts: [TARGET.accountId],
          AccountFilterType: 'INTERSECTION',
        },
        OperationId: awsStackSetOperationId('create', TARGET, OVERRIDES),
      },
    ]);
    expect(sent('UpdateStackInstancesCommand')).toHaveLength(0);
    for (const call of sent('DescribeStackInstanceCommand')) {
      expect(call.input['CallAs']).toBe('DELEGATED_ADMIN');
    }
    expect(sent('DescribeStackSetOperationCommand')[0]?.input).toEqual({
      StackSetName: TARGET.stackSetName,
      OperationId: awsStackSetOperationId('create', TARGET, OVERRIDES),
      CallAs: 'DELEGATED_ADMIN',
    });
  });

  it('updates an auto-deployed instance holding other overrides, and creates nothing', async () => {
    const { api, sent } = harness(
      stackSet([
        () => instance('CURRENT', { ShardTag: 'default' }),
        () => instance('CURRENT', OVERRIDES),
      ]),
    );
    await expect(api.ensureStackInstance(INPUT)).resolves.toEqual({ action: 'updated' });
    expect(sent('CreateStackInstancesCommand')).toHaveLength(0);
    expect(sent('UpdateStackInstancesCommand').map((c) => c.input)).toEqual([
      expect.objectContaining({
        ParameterOverrides: parameterOverridesFor(OVERRIDES),
        CallAs: 'DELEGATED_ADMIN',
        OperationId: awsStackSetOperationId('update', TARGET, OVERRIDES),
      }),
    ]);
  });

  it('sends neither with the right overrides, and goes straight to waiting', async () => {
    const { api, sent } = harness(
      stackSet([
        () =>
          instance('OUTDATED', OVERRIDES, { StackInstanceStatus: { DetailedStatus: 'RUNNING' } }),
        () => instance('CURRENT', OVERRIDES),
      ]),
    );
    await expect(api.ensureStackInstance(INPUT)).resolves.toEqual({ action: 'none' });
    expect(sent('CreateStackInstancesCommand')).toHaveLength(0);
    expect(sent('UpdateStackInstancesCommand')).toHaveLength(0);
    expect(sent('DescribeStackInstanceCommand')).toHaveLength(2);
  });

  it('a resumed run after success sends no create or update', async () => {
    const { api, sent } = harness(stackSet([() => instance('CURRENT', OVERRIDES)]));
    await api.ensureStackInstance(INPUT);
    await api.ensureStackInstance(INPUT);
    expect(sent('CreateStackInstancesCommand')).toHaveLength(0);
    expect(sent('UpdateStackInstancesCommand')).toHaveLength(0);
  });

  it.each(['NameAlreadyExistsException', 'OperationInProgressException'])(
    'races auto-deployment: a %s refusal re-reads the instance and carries on',
    async (code) => {
      const { api, sent } = harness(
        stackSet(
          [
            absent,
            () =>
              instance('OUTDATED', OVERRIDES, {
                StackInstanceStatus: { DetailedStatus: 'PENDING' },
              }),
            () => instance('CURRENT', OVERRIDES),
          ],
          {
            CreateStackInstancesCommand: () => {
              throw sdkError(code);
            },
          },
        ),
      );
      await expect(api.ensureStackInstance(INPUT)).resolves.toEqual({ action: 'none' });
      expect(sent('CreateStackInstancesCommand')).toHaveLength(1);
      expect(sent('DescribeStackSetOperationCommand')).toHaveLength(0);
    },
  );

  it('re-attaches to its own operation when the operation id was already filed', async () => {
    const { api, sent } = harness(
      stackSet([absent, () => instance('CURRENT', OVERRIDES)], {
        CreateStackInstancesCommand: () => {
          throw sdkError('OperationIdAlreadyExistsException');
        },
      }),
    );
    await expect(api.ensureStackInstance(INPUT)).resolves.toEqual({ action: 'created' });
    expect(sent('DescribeStackSetOperationCommand')[0]?.input['OperationId']).toBe(
      awsStackSetOperationId('create', TARGET, OVERRIDES),
    );
  });

  it('waits on a running operation, then polls the instance until CURRENT', async () => {
    const statuses = ['QUEUED', 'RUNNING', 'SUCCEEDED'];
    const { api, sent, clock } = harness(
      stackSet(
        [
          absent,
          () =>
            instance('OUTDATED', OVERRIDES, { StackInstanceStatus: { DetailedStatus: 'PENDING' } }),
          () =>
            instance('OUTDATED', OVERRIDES, { StackInstanceStatus: { DetailedStatus: 'RUNNING' } }),
          () => instance('CURRENT', OVERRIDES),
        ],
        {
          DescribeStackSetOperationCommand: () => ({
            StackSetOperation: { Status: statuses.shift() },
          }),
        },
      ),
    );
    await expect(api.ensureStackInstance(INPUT)).resolves.toEqual({ action: 'created' });
    expect(sent('DescribeStackSetOperationCommand')).toHaveLength(3);
    expect(clock.t).toBeGreaterThan(0);
  });

  it.each(['FAILED', 'STOPPED'])(
    'a %s operation throws AwsStackInstanceFailedError with its reason',
    async (status) => {
      const { api } = harness(
        stackSet([absent], {
          DescribeStackSetOperationCommand: () => ({
            StackSetOperation: { Status: status, StatusReason: 'quota exceeded' },
          }),
        }),
      );
      const err = await api.ensureStackInstance(INPUT).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AwsStackInstanceFailedError);
      expect(err).toMatchObject({ status: `operation ${status}`, statusReason: 'quota exceeded' });
    },
  );

  it.each([
    ['OUTDATED', 'FAILED'],
    ['OUTDATED', 'CANCELLED'],
    ['INOPERABLE', undefined],
  ])('an instance %s/%s throws with the status and AWS status reason', async (status, detailed) => {
    const { api } = harness(
      stackSet([
        () =>
          instance(status, OVERRIDES, {
            StatusReason: 'Account 000000000001 should have a role',
            ...(detailed ? { StackInstanceStatus: { DetailedStatus: detailed } } : {}),
          }),
      ]),
    );
    const err = await api.ensureStackInstance(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwsStackInstanceFailedError);
    expect(err).toMatchObject({
      status: detailed ? `${status}/${detailed}` : status,
      statusReason: 'Account 000000000001 should have a role',
    });
  });

  it('past the deadline throws an error saying to run again, with no real waiting', async () => {
    const { api, clock } = harness(
      stackSet([
        () =>
          instance('OUTDATED', OVERRIDES, { StackInstanceStatus: { DetailedStatus: 'RUNNING' } }),
      ]),
    );
    await expect(api.ensureStackInstance(INPUT)).rejects.toThrow(
      /run the command again to keep waiting/,
    );
    expect(clock.t).toBeGreaterThanOrEqual(AWS_STACK_INSTANCE_TIMEOUT_MS);
  });

  it('a race that never settles also ends at the deadline', async () => {
    const { api } = harness(
      stackSet([absent], {
        CreateStackInstancesCommand: () => {
          throw sdkError('OperationInProgressException');
        },
      }),
    );
    await expect(api.ensureStackInstance(INPUT)).rejects.toThrow(/run the command again/);
  });

  it('surfaces any other refusal as AwsManagementApiError with the code only', async () => {
    const { api } = harness(
      stackSet([absent], {
        CreateStackInstancesCommand: () => {
          throw sdkError('StackSetNotFoundException', 404);
        },
      }),
    );
    const err = await api.ensureStackInstance(INPUT).catch((e: unknown) => e);
    expect(err).toEqual(
      new AwsManagementApiError('cloudformation', 'StackSetNotFoundException', 404),
    );
    expect(String((err as Error).message)).not.toContain('long message');
  });
});

describe('the StackSet client credentials', () => {
  it('assumes stackSetAdmin.roleArn on the management session when it is set', async () => {
    const { api, calls } = harness(stackSet([() => instance('CURRENT', OVERRIDES)]), {
      stackSetAdmin: { roleArn: OPERATOR_ROLE },
    });
    await api.ensureStackInstance(INPUT);
    const operatorAssume = calls.find(
      (c) => c.command === 'AssumeRoleCommand' && c.input['RoleArn'] === OPERATOR_ROLE,
    );
    expect(operatorAssume?.accessKeyId).toBe('ASIAMGMT');
    const cfn = calls.filter((c) => c.service === 'cloudformation');
    expect(cfn.length).toBeGreaterThan(0);
    for (const call of cfn) {
      expect(call.accessKeyId).toBe('ASIAOPERATOR');
      expect(call.region).toBe(TARGET.region);
    }
  });

  it('builds the client with no credentials when stackSetAdmin is unset', async () => {
    const { api, calls } = harness(stackSet([() => instance('CURRENT', OVERRIDES)]));
    await api.ensureStackInstance(INPUT);
    const cfn = calls.filter((c) => c.service === 'cloudformation');
    expect(cfn.every((c) => !c.hasCredentials)).toBe(true);
    expect(calls.some((c) => c.command === 'AssumeRoleCommand')).toBe(false);
  });

  it('the SDK factory builds a CloudFormationClient for the new service', () => {
    expect(createAwsManagementSdkClient('cloudformation', { region: 'eu-west-1' })).toBeInstanceOf(
      CloudFormationClient,
    );
  });
});

describe('readStackInstanceOutputs', () => {
  const stackId = instance('CURRENT', OVERRIDES).StackInstance.StackId;

  it('reads the stack the instance names, in the member account, as key to value', async () => {
    const { api, sent } = harness(
      stackSet([() => instance('CURRENT', OVERRIDES)], {
        DescribeStacksCommand: () => ({
          Stacks: [
            {
              Outputs: [
                { OutputKey: 'VpcId', OutputValue: 'vpc-1' },
                { OutputKey: 'SubnetIdA', OutputValue: 'subnet-a' },
              ],
            },
          ],
        }),
      }),
    );
    await expect(api.readStackInstanceOutputs(TARGET)).resolves.toEqual({
      VpcId: 'vpc-1',
      SubnetIdA: 'subnet-a',
    });
    const [describe] = sent('DescribeStacksCommand');
    expect(describe?.input).toEqual({ StackName: stackId });
    expect(describe?.accessKeyId).toBe('ASIAMEMBER');
    expect(describe?.region).toBe(TARGET.region);
    expect(
      sent('AssumeRoleCommand').some((c) =>
        String(c.input['RoleArn']).endsWith(':000000000001:role/OrganizationAccountAccessRole'),
      ),
    ).toBe(true);
  });

  it.each([
    ['stack instance', { DescribeStackInstanceCommand: absent }],
    [
      'stack id',
      {
        DescribeStackInstanceCommand: () => instance('CURRENT', OVERRIDES, { StackId: undefined }),
      },
    ],
    ['stack', { DescribeStacksCommand: () => ({ Stacks: [] }) }],
    [
      'stack',
      {
        DescribeStacksCommand: () => {
          throw sdkError('ValidationError');
        },
      },
    ],
    ['outputs', { DescribeStacksCommand: () => ({ Stacks: [{ Outputs: [] }] }) }],
  ] as [string, Record<string, Handler>][])(
    'a missing %s throws AwsStackOutputsMissingError',
    async (missing, more) => {
      const { api } = harness(stackSet([() => instance('CURRENT', OVERRIDES)], more));
      const err = await api.readStackInstanceOutputs(TARGET).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AwsStackOutputsMissingError);
      expect(err).toMatchObject({ missing });
    },
  );
});

describe('stackInstanceOutcome', () => {
  const state = (status: string, detailedStatus: string | null) => ({
    status,
    detailedStatus,
    statusReason: null,
    stackId: null,
    parameterOverrides: {},
  });
  it('is current on CURRENT and waiting while a create or update is in flight', () => {
    expect(stackInstanceOutcome(TARGET, state('CURRENT', 'SUCCEEDED'))).toBe('current');
    expect(stackInstanceOutcome(TARGET, state('OUTDATED', 'PENDING'))).toBe('waiting');
    expect(stackInstanceOutcome(TARGET, state('OUTDATED', 'RUNNING'))).toBe('waiting');
    expect(stackInstanceOutcome(TARGET, state('OUTDATED', null))).toBe('waiting');
  });
  it('throws on a terminal detailed status', () => {
    expect(() =>
      stackInstanceOutcome(TARGET, state('OUTDATED', 'SKIPPED_SUSPENDED_ACCOUNT')),
    ).toThrow(AwsStackInstanceFailedError);
  });
});
