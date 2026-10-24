import { IAMClient } from '@aws-sdk/client-iam';
import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import { STSClient } from '@aws-sdk/client-sts';
import { describe, expect, it, vi } from 'vitest';
import {
  AWS_CREATE_ACCOUNT_TIMEOUT_MS,
  AWS_EC2_VCPU_QUOTA_CODE,
  AWS_MANAGEMENT_ENV,
  AWS_RUNNER_IAM_POLICY,
  AWS_RUNNER_IAM_USER,
  AwsAccountCreationRefusedError,
  AwsManagementApiError,
  OrchestratorNotConfiguredError,
  awsCredentialsFromEnv,
  awsManagementCredentials,
  awsRunnerPolicyDocument,
  awsRuntimeKeyEnvNames,
  createAwsManagementApi,
  createAwsManagementSdkClient,
  type AwsManagementClientFactory,
  type AwsManagementService,
  type AwsSessionCredentials,
} from '../src/index';

// The AWS management half of add-shard (MOTIR-9278), over a stubbed SDK client:
// every call is recorded by service, command and input, so a test can say which
// credential each client was built with and that no key was ever minted.

const MANAGEMENT = {
  accessKeyId: 'AKIAMANAGEMENT',
  secretAccessKey: 'management-secret',
  roleArn: 'arn:aws:iam::576360162297:role/motir-add-shard',
};

interface SentCall {
  service: AwsManagementService;
  region: string;
  accessKeyId: string;
  sessionToken: string | undefined;
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

function harness(handlers: Record<string, Handler>, clock = { t: 0 }) {
  const calls: SentCall[] = [];
  const sleeps: number[] = [];
  const factory: AwsManagementClientFactory = (service, config) => ({
    async send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      const call: SentCall = {
        service,
        region: config.region,
        accessKeyId: config.credentials.accessKeyId,
        sessionToken: config.credentials.sessionToken,
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
      sleeps.push(ms);
      clock.t += ms;
    },
    now: () => clock.t,
  });
  return { api, calls, sleeps, clock };
}

const assume: Handler = (input) =>
  String(input['RoleArn']).includes('motir-add-shard') ? session('MGMT') : session('MEMBER');

const MEMBER: AwsSessionCredentials = {
  accessKeyId: 'ASIAMEMBER',
  secretAccessKey: 'secret-MEMBER',
  sessionToken: 'token-MEMBER',
  expiration: null,
};

describe('awsManagementCredentials', () => {
  it('reads the three variables', () => {
    expect(
      awsManagementCredentials({
        AWS_ORG_ADMIN_ACCESS_KEY_ID: ' AKIA ',
        AWS_ORG_ADMIN_SECRET_ACCESS_KEY: 's',
        AWS_ORG_ADMIN_ROLE_ARN: 'arn',
      }),
    ).toEqual({ accessKeyId: 'AKIA', secretAccessKey: 's', roleArn: 'arn' });
  });

  it('names every missing variable at once', () => {
    expect(() => awsManagementCredentials({ AWS_ORG_ADMIN_SECRET_ACCESS_KEY: 's' })).toThrow(
      new OrchestratorNotConfiguredError(
        `set ${AWS_MANAGEMENT_ENV.accessKeyId}, ${AWS_MANAGEMENT_ENV.roleArn}`,
      ),
    );
  });
});

describe('awsCredentialsFromEnv', () => {
  it('reads the prefix’s two variables, or null when either is unset', () => {
    expect(awsRuntimeKeyEnvNames('FLEET_SHARD_A')).toEqual({
      accessKeyId: 'FLEET_SHARD_A_ACCESS_KEY_ID',
      secretAccessKey: 'FLEET_SHARD_A_SECRET_ACCESS_KEY',
    });
    expect(awsCredentialsFromEnv('P', { P_ACCESS_KEY_ID: 'k', P_SECRET_ACCESS_KEY: 's' })).toEqual({
      accessKeyId: 'k',
      secretAccessKey: 's',
    });
    expect(awsCredentialsFromEnv('P', { P_ACCESS_KEY_ID: 'k' })).toBeNull();
    expect(awsCredentialsFromEnv('P', {})).toBeNull();
  });
});

describe('findOrganizationAccount', () => {
  it('assumes the management role, pages ListAccounts and finds the account by name', async () => {
    const { api, calls } = harness({
      AssumeRoleCommand: assume,
      ListAccountsCommand: (input) =>
        input['NextToken']
          ? { Accounts: [{ Id: '222222222222', Name: 'ci-runner-use1-2', State: 'ACTIVE' }] }
          : { Accounts: [{ Id: '111111111111', Name: 'other' }], NextToken: 'p2' },
    });

    expect(await api.findOrganizationAccount('ci-runner-use1-2')).toEqual({
      account: { accountId: '222222222222', name: 'ci-runner-use1-2', status: 'ACTIVE' },
      inProgressRequestId: null,
    });
    expect(calls[0]).toMatchObject({
      service: 'sts',
      accessKeyId: MANAGEMENT.accessKeyId,
      sessionToken: undefined,
      command: 'AssumeRoleCommand',
      input: { RoleArn: MANAGEMENT.roleArn, DurationSeconds: 900 },
    });
    expect(calls.slice(1).map((c) => [c.service, c.accessKeyId, c.sessionToken])).toEqual([
      ['organizations', 'ASIAMGMT', 'token-MGMT'],
      ['organizations', 'ASIAMGMT', 'token-MGMT'],
    ]);
  });

  it('reuses the management session within a run', async () => {
    const { api, calls } = harness({
      AssumeRoleCommand: assume,
      ListAccountsCommand: () => ({ Accounts: [{ Id: '1', Name: 'a', Status: 'ACTIVE' }] }),
    });
    await api.findOrganizationAccount('a');
    await api.findOrganizationAccount('a');
    expect(calls.filter((c) => c.command === 'AssumeRoleCommand')).toHaveLength(1);
  });

  it('answers an IN_PROGRESS CreateAccount for the name, paging the statuses', async () => {
    const { api, calls } = harness({
      AssumeRoleCommand: assume,
      ListAccountsCommand: () => ({ Accounts: [] }),
      ListCreateAccountStatusCommand: (input) =>
        input['NextToken']
          ? { CreateAccountStatuses: [{ Id: 'car-2', AccountName: 'n', State: 'IN_PROGRESS' }] }
          : {
              CreateAccountStatuses: [{ Id: 'car-1', AccountName: 'x', State: 'IN_PROGRESS' }],
              NextToken: 't',
            },
    });

    expect(await api.findOrganizationAccount('n')).toEqual({
      account: null,
      inProgressRequestId: 'car-2',
    });
    expect(calls.find((c) => c.command === 'ListCreateAccountStatusCommand')!.input).toEqual({
      States: ['IN_PROGRESS'],
    });
  });

  it('answers neither when nothing has the name', async () => {
    const { api } = harness({
      AssumeRoleCommand: assume,
      ListAccountsCommand: () => ({}),
      ListCreateAccountStatusCommand: () => ({}),
    });
    expect(await api.findOrganizationAccount('n')).toEqual({
      account: null,
      inProgressRequestId: null,
    });
  });

  it('a refusal is a typed error with the code, never AWS’s message', async () => {
    const { api } = harness({
      AssumeRoleCommand: () => {
        throw sdkError('AccessDenied', 403);
      },
    });
    const err = await api.findOrganizationAccount('n').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwsManagementApiError);
    expect(err).toMatchObject({ service: 'sts', awsCode: 'AccessDenied', httpStatus: 403 });
    expect((err as Error).message).not.toContain('long message');
  });
});

describe('createOrganizationAccount', () => {
  it('files CreateAccount once and polls DescribeCreateAccountStatus to SUCCEEDED', async () => {
    let polls = 0;
    const { api, calls, sleeps } = harness({
      AssumeRoleCommand: assume,
      CreateAccountCommand: () => ({ CreateAccountStatus: { Id: 'car-9', State: 'IN_PROGRESS' } }),
      DescribeCreateAccountStatusCommand: () => {
        polls += 1;
        return polls < 3
          ? { CreateAccountStatus: { Id: 'car-9', State: 'IN_PROGRESS' } }
          : { CreateAccountStatus: { Id: 'car-9', State: 'SUCCEEDED', AccountId: '333333333333' } };
      },
    });

    expect(await api.createOrganizationAccount({ name: 'n', email: 'ops+n@motir.co' })).toEqual({
      accountId: '333333333333',
      name: 'n',
      status: 'ACTIVE',
    });
    expect(calls.filter((c) => c.command === 'CreateAccountCommand')).toHaveLength(1);
    expect(calls.find((c) => c.command === 'CreateAccountCommand')!.input).toEqual({
      AccountName: 'n',
      Email: 'ops+n@motir.co',
      RoleName: 'OrganizationAccountAccessRole',
    });
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  it.each(['EMAIL_ALREADY_EXISTS', 'ACCOUNT_LIMIT_EXCEEDED'])(
    'FAILED with %s is a typed refusal naming the reason',
    async (reason) => {
      const { api } = harness({
        AssumeRoleCommand: assume,
        CreateAccountCommand: () => ({ CreateAccountStatus: { Id: 'car-9' } }),
        DescribeCreateAccountStatusCommand: () => ({
          CreateAccountStatus: { State: 'FAILED', FailureReason: reason },
        }),
      });
      const err = await api
        .createOrganizationAccount({ name: 'n', email: 'e@x.co' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AwsAccountCreationRefusedError);
      expect(err).toMatchObject({ accountName: 'n', reason });
    },
  );

  it('a FAILED with no reason says UNKNOWN', async () => {
    const { api } = harness({
      AssumeRoleCommand: assume,
      CreateAccountCommand: () => ({ CreateAccountStatus: { Id: 'car-9' } }),
      DescribeCreateAccountStatusCommand: () => ({ CreateAccountStatus: { State: 'FAILED' } }),
    });
    await expect(api.waitForCreateAccount('car-9', 'n')).rejects.toMatchObject({
      reason: 'UNKNOWN',
    });
  });

  it('gives up after ten minutes still IN_PROGRESS, naming the request', async () => {
    const { api, clock } = harness({
      AssumeRoleCommand: assume,
      DescribeCreateAccountStatusCommand: () => ({ CreateAccountStatus: {} }),
    });
    await expect(api.waitForCreateAccount('car-7', 'n')).rejects.toThrow(/car-7.*10 minutes/);
    expect(clock.t).toBeGreaterThanOrEqual(AWS_CREATE_ACCOUNT_TIMEOUT_MS);
  });

  it('a CreateAccount answer with no request id is refused', async () => {
    const { api } = harness({ AssumeRoleCommand: assume, CreateAccountCommand: () => ({}) });
    await expect(api.createOrganizationAccount({ name: 'n', email: 'e' })).rejects.toBeInstanceOf(
      AwsManagementApiError,
    );
  });

  it('renews the management session once it nears expiry', async () => {
    const clock = { t: Date.now() };
    const { api, calls } = harness(
      {
        AssumeRoleCommand: assume,
        DescribeCreateAccountStatusCommand: () => ({
          CreateAccountStatus: { State: 'IN_PROGRESS' },
        }),
        ListAccountsCommand: () => ({ Accounts: [{ Id: '1', Name: 'n' }] }),
      },
      clock,
    );
    await api.waitForCreateAccount('car', 'n').catch(() => undefined);
    clock.t += 300_000; // the 15-minute session is now under a minute from expiry
    await api.findOrganizationAccount('n');
    expect(calls.filter((c) => c.command === 'AssumeRoleCommand')).toHaveLength(2);
  });
});

describe('the default clock', () => {
  it('waits between polls on a real timer', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const factory: AwsManagementClientFactory = () => ({
        async send(command: unknown) {
          const name = (command as { constructor: { name: string } }).constructor.name;
          if (name === 'AssumeRoleCommand') return session('MGMT');
          polls += 1;
          return polls < 2
            ? { CreateAccountStatus: { State: 'IN_PROGRESS' } }
            : { CreateAccountStatus: { State: 'SUCCEEDED', AccountId: '4' } };
        },
      });
      const waiting = createAwsManagementApi(MANAGEMENT, {
        clientFactory: factory,
      }).waitForCreateAccount('car', 'n');
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(waiting).resolves.toMatchObject({ accountId: '4' });
      expect(polls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('assumeMemberRole', () => {
  it('assumes OrganizationAccountAccessRole in the member account with the management session', async () => {
    const { api, calls } = harness({ AssumeRoleCommand: assume });

    const creds = await api.assumeMemberRole('333333333333');

    expect(creds).toMatchObject({
      accessKeyId: 'ASIAMEMBER',
      secretAccessKey: 'secret-MEMBER',
      sessionToken: 'token-MEMBER',
    });
    expect(calls[1]).toMatchObject({
      accessKeyId: 'ASIAMGMT',
      sessionToken: 'token-MGMT',
      input: {
        RoleArn: 'arn:aws:iam::333333333333:role/OrganizationAccountAccessRole',
        DurationSeconds: 900,
      },
    });
  });

  it('retries AccessDenied while a new account’s role propagates, then gives up', async () => {
    let denied = 2;
    const retry = harness({
      AssumeRoleCommand: (input, call) => {
        if (call.sessionToken && denied-- > 0) throw sdkError('AccessDenied', 403);
        return assume(input, call);
      },
    });
    expect(await retry.api.assumeMemberRole('3')).toMatchObject({ accessKeyId: 'ASIAMEMBER' });
    expect(retry.sleeps).toEqual([5_000, 5_000]);

    const never = harness({
      AssumeRoleCommand: (input, call) => {
        if (call.sessionToken) throw sdkError('AccessDenied', 403);
        return assume(input, call);
      },
    });
    await expect(never.api.assumeMemberRole('3')).rejects.toMatchObject({
      awsCode: 'AccessDenied',
    });
    expect(never.sleeps).toHaveLength(5);
  });

  it('any other refusal is not retried', async () => {
    const { api, sleeps } = harness({
      AssumeRoleCommand: (input, call) => {
        if (call.sessionToken) throw Object.assign(new Error('x'), { Code: 'RegionDisabled' });
        return assume(input, call);
      },
    });
    await expect(api.assumeMemberRole('3')).rejects.toMatchObject({
      awsCode: 'RegionDisabled',
      httpStatus: null,
    });
    expect(sleeps).toEqual([]);
  });

  it('a session answer missing a field is refused', async () => {
    const { api } = harness({ AssumeRoleCommand: () => ({ Credentials: { AccessKeyId: 'a' } }) });
    await expect(api.assumeMemberRole('3')).rejects.toMatchObject({
      awsCode: 'MissingField:SecretAccessKey',
    });
  });
});

describe('readVcpuQuota', () => {
  it('reads L-1216C47A in the region with the member credentials', async () => {
    const { api, calls } = harness({
      GetServiceQuotaCommand: () => ({ Quota: { Value: 1152.0 } }),
    });
    expect(await api.readVcpuQuota(MEMBER, 'us-east-1')).toBe(1152);
    expect(calls[0]).toMatchObject({
      service: 'service-quotas',
      region: 'us-east-1',
      accessKeyId: 'ASIAMEMBER',
      sessionToken: 'token-MEMBER',
      input: { ServiceCode: 'ec2', QuotaCode: AWS_EC2_VCPU_QUOTA_CODE },
    });
  });

  it('falls back to the AWS default when no applied value exists', async () => {
    const { api } = harness({
      GetServiceQuotaCommand: () => {
        throw sdkError('NoSuchResourceException');
      },
      GetAWSDefaultServiceQuotaCommand: () => ({ Quota: { Value: 5 } }),
    });
    expect(await api.readVcpuQuota(MEMBER, 'us-east-1')).toBe(5);
  });

  it('any other refusal, or no value, is an error', async () => {
    const denied = harness({
      GetServiceQuotaCommand: () => {
        throw sdkError('AccessDeniedException', 400);
      },
    });
    await expect(denied.api.readVcpuQuota(MEMBER, 'us-east-1')).rejects.toMatchObject({
      awsCode: 'AccessDeniedException',
    });
    const empty = harness({ GetServiceQuotaCommand: () => ({}) });
    await expect(empty.api.readVcpuQuota(MEMBER, 'us-east-1')).rejects.toBeInstanceOf(
      AwsManagementApiError,
    );
    const unknown = harness({
      GetServiceQuotaCommand: () => {
        throw 'boom';
      },
    });
    await expect(unknown.api.readVcpuQuota(MEMBER, 'us-east-1')).rejects.toMatchObject({
      awsCode: 'UnknownError',
    });
  });
});

describe('ensureRunnerIamUser', () => {
  const policy = awsRunnerPolicyDocument({ shardTag: 'ci-runner-use1-2', regionId: 'us-east-1' });

  it('creates the user and its policy when absent, and never mints a key', async () => {
    const { api, calls } = harness({
      GetUserCommand: () => {
        throw sdkError('NoSuchEntityException', 404);
      },
      CreateUserCommand: () => ({}),
      GetUserPolicyCommand: () => {
        throw Object.assign(new Error('x'), { Code: 'NoSuchEntity' });
      },
      PutUserPolicyCommand: () => ({}),
    });

    expect(await api.ensureRunnerIamUser(MEMBER, policy)).toEqual({
      created: [`iam-user:${AWS_RUNNER_IAM_USER}`, `iam-policy:${AWS_RUNNER_IAM_POLICY}`],
    });
    expect(calls.map((c) => c.command)).toEqual([
      'GetUserCommand',
      'CreateUserCommand',
      'GetUserPolicyCommand',
      'PutUserPolicyCommand',
    ]);
    expect(calls.every((c) => c.service === 'iam' && c.accessKeyId === 'ASIAMEMBER')).toBe(true);
    expect(JSON.parse(String(calls[3]!.input['PolicyDocument']))).toEqual(policy);
    expect(calls.some((c) => c.command === 'CreateAccessKeyCommand')).toBe(false);
  });

  it('creates nothing when the user and the same policy exist', async () => {
    const { api, calls } = harness({
      GetUserCommand: () => ({ User: { UserName: AWS_RUNNER_IAM_USER } }),
      GetUserPolicyCommand: () => ({
        PolicyDocument: encodeURIComponent(JSON.stringify(policy)),
      }),
    });
    expect(await api.ensureRunnerIamUser(MEMBER, policy)).toEqual({ created: [] });
    expect(calls.map((c) => c.command)).toEqual(['GetUserCommand', 'GetUserPolicyCommand']);
  });

  it('rewrites a policy that differs, or one that is not JSON', async () => {
    for (const document of [
      encodeURIComponent(JSON.stringify({ Version: '2012-10-17', Statement: [] })),
      'not-json',
      '',
    ]) {
      const { api, calls } = harness({
        GetUserCommand: () => ({}),
        GetUserPolicyCommand: () => ({ PolicyDocument: document }),
        PutUserPolicyCommand: () => ({}),
      });
      expect(await api.ensureRunnerIamUser(MEMBER, policy)).toEqual({
        created: [`iam-policy:${AWS_RUNNER_IAM_POLICY}`],
      });
      expect(calls.at(-1)!.command).toBe('PutUserPolicyCommand');
    }
  });

  it('a refusal other than not-found stops it', async () => {
    const user = harness({
      GetUserCommand: () => {
        throw sdkError('AccessDenied', 403);
      },
    });
    await expect(user.api.ensureRunnerIamUser(MEMBER, policy)).rejects.toMatchObject({
      awsCode: 'AccessDenied',
    });
    const doc = harness({
      GetUserCommand: () => ({}),
      GetUserPolicyCommand: () => {
        throw sdkError('ServiceFailure', 500);
      },
    });
    await expect(doc.api.ensureRunnerIamUser(MEMBER, policy)).rejects.toMatchObject({
      awsCode: 'ServiceFailure',
    });
  });
});

describe('awsRunnerPolicyDocument', () => {
  it('allows the adapter’s EC2 calls only, tag-scoped where EC2 supports it', () => {
    const doc = awsRunnerPolicyDocument({ shardTag: 's1', regionId: 'us-east-1' });
    const actions = doc.Statement.flatMap((s) => [s['Action']].flat());
    expect(new Set(actions)).toEqual(
      new Set([
        'ec2:DescribeInstances',
        'ec2:DescribeSubnets',
        'ec2:DescribeSecurityGroups',
        'ec2:RunInstances',
        'ec2:CreateTags',
        'ec2:TerminateInstances',
      ]),
    );
    expect(JSON.stringify(doc)).not.toMatch(/iam:|CreateAccessKey|ec2:\*/);
    const terminate = doc.Statement.find((s) => s['Sid'] === 'TerminateOwn')!;
    expect(terminate['Condition']).toEqual({
      StringEquals: { 'aws:ResourceTag/motir-shard': 's1' },
    });
    const launch = doc.Statement.find((s) => s['Sid'] === 'LaunchTagged')!;
    expect(launch['Condition']).toEqual({ StringEquals: { 'aws:RequestTag/motir-shard': 's1' } });
    expect(launch['Resource']).toEqual([
      'arn:aws:ec2:us-east-1:*:instance/*',
      'arn:aws:ec2:us-east-1:*:volume/*',
    ]);
  });
});

describe('the default client factory', () => {
  it('builds each service’s real SDK client, without calling AWS', () => {
    const config = { region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 's' } };
    expect(createAwsManagementSdkClient('sts', config)).toBeInstanceOf(STSClient);
    expect(createAwsManagementSdkClient('organizations', config)).toBeInstanceOf(
      OrganizationsClient,
    );
    expect(createAwsManagementSdkClient('service-quotas', config)).toBeInstanceOf(
      ServiceQuotasClient,
    );
    expect(createAwsManagementSdkClient('iam', config)).toBeInstanceOf(IAMClient);
    expect(typeof createAwsManagementApi(MANAGEMENT).findOrganizationAccount).toBe('function');
  });
});
