import { IAMClient } from '@aws-sdk/client-iam';
import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import { STSClient } from '@aws-sdk/client-sts';
import { describe, expect, it, vi } from 'vitest';
import {
  AWS_CREATE_ACCOUNT_TIMEOUT_MS,
  AWS_EC2_VCPU_QUOTA_CODE,
  AWS_INDEX_IAM_ROLE,
  AWS_MANAGEMENT_ENV,
  AWS_RUNNER_IAM_POLICY,
  AWS_RUNNER_IAM_ROLE,
  AWS_MANAGED_POLICY_MAX_CHARS,
  AWS_TENANT_DEPLOY_POLICY_PATH,
  AWS_TENANT_DEPLOY_ROLE,
  AwsAccountCreationRefusedError,
  AwsManagedPolicySetInvalidError,
  AwsManagementApiError,
  OrchestratorNotConfiguredError,
  awsManagementCredentials,
  awsManagementRequiredEnv,
  awsAgentHosterPolicyDocument,
  awsRunnerPolicyDocument,
  awsRunnerTrustPolicy,
  createAwsManagementApi,
  createAwsManagementSdkClient,
  type AwsManagedPolicy,
  type AwsManagementClientFactory,
  type AwsManagementCredentials,
  type AwsManagementService,
  type AwsSessionCredentials,
} from '../src/index';

// The AWS management half of add-shard (MOTIR-9278), over a stubbed SDK client:
// every call is recorded by service, command and input, so a test can say which
// credential each client was built with and that no key was ever minted.

const MANAGEMENT = {
  roleArn: 'arn:aws:iam::576360162297:role/motir-add-shard',
};

interface SentCall {
  service: AwsManagementService;
  region: string;
  accessKeyId: string | undefined;
  sessionToken: string | undefined;
  /** Whether the client was built with a `credentials` property at all. */
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

function harness(
  handlers: Record<string, Handler>,
  clock = { t: 0 },
  management: AwsManagementCredentials = MANAGEMENT,
) {
  const calls: SentCall[] = [];
  const sleeps: number[] = [];
  const factory: AwsManagementClientFactory = (service, config) => ({
    async send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      const call: SentCall = {
        service,
        region: config.region,
        accessKeyId: config.credentials?.accessKeyId,
        sessionToken: config.credentials?.sessionToken,
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
  const api = createAwsManagementApi(management, {
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

// The two variable names the management key used to be read from (MOTIR-9839),
// derived from the role's own name so the retired names appear nowhere in the
// tree (MOTIR-10302's search criterion): setting them must change nothing.
const RETIRED_KEY_VARIABLES = ['ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'].map((suffix) =>
  AWS_MANAGEMENT_ENV.roleArn.replace(/ROLE_ARN$/, suffix),
);

describe('awsManagementCredentials', () => {
  it('reads the role ARN, trimmed, and nothing else', () => {
    expect(awsManagementCredentials({ AWS_ORG_ADMIN_ROLE_ARN: ' arn ' })).toStrictEqual({
      roleArn: 'arn',
    });
  });

  // MOTIR-10302: the key path is gone; the role is always assumed from the
  // SDK's default credential chain.
  it.each([
    ['the retired access key id', { [RETIRED_KEY_VARIABLES[0]!]: 'AKIA' }],
    ['the retired secret', { [RETIRED_KEY_VARIABLES[1]!]: 's' }],
    [
      'both retired key variables',
      { [RETIRED_KEY_VARIABLES[0]!]: 'AKIA', [RETIRED_KEY_VARIABLES[1]!]: 's' },
    ],
    ['the SDK’s own key', { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 's' }],
  ])('changes nothing when %s is set', (_label, extra) => {
    expect(awsManagementCredentials({ ...extra, AWS_ORG_ADMIN_ROLE_ARN: 'arn' })).toStrictEqual({
      roleArn: 'arn',
    });
  });

  it('names the role ARN, and only it, when it is unset — with a retired key set or not', () => {
    const roleMissing = new OrchestratorNotConfiguredError(`set ${AWS_MANAGEMENT_ENV.roleArn}`);
    expect(() => awsManagementCredentials({})).toThrow(roleMissing);
    expect(() => awsManagementCredentials({ AWS_ORG_ADMIN_ROLE_ARN: '  ' })).toThrow(roleMissing);
    const keyed = Object.fromEntries(RETIRED_KEY_VARIABLES.map((name) => [name, 'x']));
    expect(() => awsManagementCredentials(keyed)).toThrow(roleMissing);
    expect(RETIRED_KEY_VARIABLES).toHaveLength(2);
    expect(RETIRED_KEY_VARIABLES.every((name) => name.startsWith('AWS_ORG_ADMIN_'))).toBe(true);
  });
});

describe('awsManagementRequiredEnv', () => {
  it('is the role ARN alone', () => {
    expect(awsManagementRequiredEnv()).toEqual([AWS_MANAGEMENT_ENV.roleArn]);
    expect(Object.values(AWS_MANAGEMENT_ENV)).toEqual([AWS_MANAGEMENT_ENV.roleArn]);
  });
});

describe('the management role, on the default chain (MOTIR-9839 · MOTIR-10302)', () => {
  it('builds the first STS client with no credentials, so the default chain supplies them', async () => {
    const { api, calls } = harness({
      AssumeRoleCommand: assume,
      ListAccountsCommand: () => ({ Accounts: [] }),
      ListCreateAccountStatusCommand: () => ({ CreateAccountStatuses: [] }),
    });
    await api.findOrganizationAccount('x');
    expect(calls[0]).toMatchObject({
      service: 'sts',
      command: 'AssumeRoleCommand',
      hasCredentials: false,
      accessKeyId: undefined,
      input: { RoleArn: MANAGEMENT.roleArn },
    });
    // Every later call runs on the assumed session.
    expect(calls.slice(1).every((c) => c.accessKeyId === 'ASIAMGMT')).toBe(true);
  });

  it('assumes member roles from the management session', async () => {
    const { api, calls } = harness({ AssumeRoleCommand: assume });
    await api.assumeMemberRole('222222222222');
    expect(calls.map((c) => [c.hasCredentials, c.accessKeyId, c.sessionToken])).toEqual([
      [false, undefined, undefined],
      [true, 'ASIAMGMT', 'token-MGMT'],
    ]);
  });
});

describe('findOrganizationAccount', () => {
  it('assumes the management role, pages ListAccounts and finds the account by name', async () => {
    const { api, calls } = harness({
      AssumeRoleCommand: assume,
      ListAccountsCommand: (input) =>
        input['NextToken']
          ? {
              Accounts: [
                {
                  Id: '222222222222',
                  Name: 'ci-runner-use1-2',
                  State: 'ACTIVE',
                  JoinedTimestamp: new Date('2026-11-01T21:28:51Z'),
                },
              ],
            }
          : { Accounts: [{ Id: '111111111111', Name: 'other' }], NextToken: 'p2' },
    });

    // When it joined is what tells a new account's EC2 activation apart (MOTIR-10204).
    expect(await api.findOrganizationAccount('ci-runner-use1-2')).toEqual({
      account: {
        accountId: '222222222222',
        name: 'ci-runner-use1-2',
        status: 'ACTIVE',
        joinedAt: new Date('2026-11-01T21:28:51Z'),
      },
      inProgressRequestId: null,
    });
    expect(calls[0]).toMatchObject({
      service: 'sts',
      accessKeyId: undefined,
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
          : {
              CreateAccountStatus: {
                Id: 'car-9',
                State: 'SUCCEEDED',
                AccountId: '333333333333',
                CompletedTimestamp: new Date('2026-11-01T21:28:51Z'),
              },
            };
      },
    });

    expect(await api.createOrganizationAccount({ name: 'n', email: 'ops+n@motir.co' })).toEqual({
      accountId: '333333333333',
      name: 'n',
      status: 'ACTIVE',
      joinedAt: new Date('2026-11-01T21:28:51Z'),
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

  it('a SUCCEEDED answer with no completion time dates the account to now (MOTIR-10204)', async () => {
    const { api, clock } = harness({
      AssumeRoleCommand: assume,
      DescribeCreateAccountStatusCommand: () => ({
        CreateAccountStatus: { State: 'SUCCEEDED', AccountId: '444444444444' },
      }),
    });
    clock.t = Date.parse('2026-11-01T21:30:00Z');
    expect(await api.waitForCreateAccount('car-9', 'n')).toEqual({
      accountId: '444444444444',
      name: 'n',
      status: 'ACTIVE',
      joinedAt: new Date('2026-11-01T21:30:00Z'),
    });
  });

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

describe('the quota raise calls (MOTIR-9459)', () => {
  it('files RequestServiceQuotaIncrease for L-1216C47A with the member credentials', async () => {
    const { api, calls } = harness({
      RequestServiceQuotaIncreaseCommand: () => ({
        RequestedQuota: { Id: 'req-1', Status: 'PENDING', DesiredValue: 200 },
      }),
    });
    expect(await api.requestVcpuQuotaIncrease(MEMBER, 'us-east-1', 200)).toEqual({
      requestId: 'req-1',
      status: 'PENDING',
      desiredValue: 200,
    });
    expect(calls[0]).toMatchObject({
      service: 'service-quotas',
      region: 'us-east-1',
      accessKeyId: 'ASIAMEMBER',
      input: { ServiceCode: 'ec2', QuotaCode: AWS_EC2_VCPU_QUOTA_CODE, DesiredValue: 200 },
    });
  });

  it('reads one request by its id, AWS status verbatim', async () => {
    const { api, calls } = harness({
      GetRequestedServiceQuotaChangeCommand: () => ({
        RequestedQuota: { Id: 'req-1', Status: 'CASE_OPENED' },
      }),
    });
    expect(await api.getQuotaRequest(MEMBER, 'us-east-1', 'req-1')).toEqual({
      requestId: 'req-1',
      status: 'CASE_OPENED',
      desiredValue: null,
    });
    expect(calls[0]!.input).toEqual({ RequestId: 'req-1' });
  });

  it('finds an open request by listing PENDING, then CASE_OPENED; none is null', async () => {
    const open = harness({
      ListRequestedServiceQuotaChangeHistoryByQuotaCommand: (input) =>
        input['Status'] === 'CASE_OPENED'
          ? { RequestedQuotas: [{ Id: 'req-9', Status: 'CASE_OPENED', DesiredValue: 400 }] }
          : { RequestedQuotas: [] },
    });
    expect(await open.api.findOpenQuotaRequest(MEMBER, 'us-east-1')).toEqual({
      requestId: 'req-9',
      status: 'CASE_OPENED',
      desiredValue: 400,
    });
    expect(open.calls.map((c) => c.input['Status'])).toEqual(['PENDING', 'CASE_OPENED']);

    const none = harness({ ListRequestedServiceQuotaChangeHistoryByQuotaCommand: () => ({}) });
    expect(await none.api.findOpenQuotaRequest(MEMBER, 'us-east-1')).toBeNull();
  });

  it('a refusal is a typed error carrying the code; an answer without an id is refused', async () => {
    const refused = harness({
      RequestServiceQuotaIncreaseCommand: () => {
        throw sdkError('ResourceAlreadyExistsException');
      },
    });
    await expect(
      refused.api.requestVcpuQuotaIncrease(MEMBER, 'us-east-1', 200),
    ).rejects.toMatchObject({ awsCode: 'ResourceAlreadyExistsException' });
    const empty = harness({
      GetRequestedServiceQuotaChangeCommand: () => ({ RequestedQuota: {} }),
    });
    await expect(empty.api.getQuotaRequest(MEMBER, 'us-east-1', 'x')).rejects.toMatchObject({
      awsCode: 'MissingField:RequestedQuota.Id',
    });
  });
});

describe('the runner role (MOTIR-9460)', () => {
  const policy = awsRunnerPolicyDocument({ shardTag: 'ci-1', regionId: 'us-east-1' });

  it('creates the role trusting the management role, and its policy, minting no key', async () => {
    const { api, calls } = harness({
      GetRoleCommand: () => {
        throw sdkError('NoSuchEntity', 404);
      },
      CreateRoleCommand: () => ({}),
      GetRolePolicyCommand: () => {
        throw sdkError('NoSuchEntity', 404);
      },
      PutRolePolicyCommand: () => ({}),
    });
    expect(await api.ensureRunnerRole(MEMBER, policy)).toEqual({
      created: [`iam-role:${AWS_RUNNER_IAM_ROLE}`, `iam-role-policy:${AWS_RUNNER_IAM_POLICY}`],
    });
    const create = calls.find((c) => c.command === 'CreateRoleCommand')!;
    expect(create.accessKeyId).toBe('ASIAMEMBER');
    expect(JSON.parse(String(create.input['AssumeRolePolicyDocument']))).toEqual(
      awsRunnerTrustPolicy(MANAGEMENT.roleArn),
    );
    expect(calls.map((c) => c.command)).not.toContain('CreateAccessKeyCommand');
  });

  it('changes nothing when the role and an equal policy are there', async () => {
    const { api, calls } = harness({
      GetRoleCommand: () => ({ Role: { RoleName: AWS_RUNNER_IAM_ROLE } }),
      GetRolePolicyCommand: () => ({ PolicyDocument: encodeURIComponent(JSON.stringify(policy)) }),
    });
    expect(await api.ensureRunnerRole(MEMBER, policy)).toEqual({ created: [] });
    expect(calls.map((c) => c.command)).toEqual(['GetRoleCommand', 'GetRolePolicyCommand']);
  });

  it('a refusal other than absence is an error', async () => {
    const { api } = harness({
      GetRoleCommand: () => {
        throw sdkError('AccessDenied', 403);
      },
    });
    await expect(api.ensureRunnerRole(MEMBER, policy)).rejects.toMatchObject({
      awsCode: 'AccessDenied',
    });
  });

  it('assumes motir-fleet-runner in the member account from the management session', async () => {
    const { api, calls } = harness({ AssumeRoleCommand: assume });
    const session = await api.assumeRunnerRole('123456789012');
    expect(session.accessKeyId).toBe('ASIAMEMBER');
    const runner = calls.find((c) => String(c.input['RoleArn']).includes(AWS_RUNNER_IAM_ROLE))!;
    expect(runner).toMatchObject({
      accessKeyId: 'ASIAMGMT',
      input: {
        RoleArn: `arn:aws:iam::123456789012:role/${AWS_RUNNER_IAM_ROLE}`,
        DurationSeconds: 3600,
      },
    });
  });
});

/** Every IAM action a policy document allows: the index role's pass, and no other. */
const iamActionsOf = (doc: { Statement: Array<Record<string, unknown>> }) =>
  doc.Statement.flatMap((s) => [s['Action']].flat() as string[]).filter((a) =>
    a.startsWith('iam:'),
  );

describe('awsRunnerPolicyDocument', () => {
  it('allows the adapter’s EC2 calls only, tag-scoped where EC2 supports it', () => {
    const doc = awsRunnerPolicyDocument({ shardTag: 's1', regionId: 'us-east-1' });
    const actions = doc.Statement.flatMap((s) => [s['Action']].flat());
    expect(new Set(actions)).toEqual(
      new Set([
        'ec2:DescribeInstances',
        'ec2:DescribeSubnets',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeImages',
        'ec2:RunInstances',
        'ec2:CreateTags',
        'ec2:TerminateInstances',
        'ec2:GetConsoleOutput',
        'iam:PassRole',
      ]),
    );
    // Its one IAM action passes the index role, to EC2 only (MOTIR-10123).
    expect(doc.Statement.filter((s) => JSON.stringify(s).includes('iam:'))).toEqual([
      {
        Sid: 'PassIndexRole',
        Effect: 'Allow',
        Action: 'iam:PassRole',
        Resource: `arn:aws:iam::*:role/${AWS_INDEX_IAM_ROLE}`,
        Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
      },
    ]);
    expect(AWS_INDEX_IAM_ROLE).toBe('motir-fleet-index');
    expect(JSON.stringify(doc)).not.toMatch(/CreateAccessKey|ec2:\*/);
    expect(iamActionsOf(doc)).toEqual(['iam:PassRole']);
    const terminate = doc.Statement.find((s) => s['Sid'] === 'TerminateOwn')!;
    expect(terminate['Condition']).toEqual({
      StringEquals: { 'aws:ResourceTag/motir-shard': 's1' },
    });
    const console_ = doc.Statement.find((s) => s['Sid'] === 'ConsoleOfOwn')!;
    expect(console_['Condition']).toEqual({
      StringEquals: { 'aws:ResourceTag/motir-shard': 's1' },
    });
    const launch = doc.Statement.find((s) => s['Sid'] === 'LaunchTagged')!;
    expect(launch['Condition']).toEqual({ StringEquals: { 'aws:RequestTag/motir-shard': 's1' } });
    expect(launch['Resource']).toEqual([
      'arn:aws:ec2:us-east-1:*:instance/*',
      'arn:aws:ec2:us-east-1:*:volume/*',
    ]);
    // A runner account may terminate only shard-tagged instances.
    expect(doc.Statement.some((s) => s['Sid'] === 'TerminateAnyInAccount')).toBe(false);
    const tagAtLaunch = doc.Statement.find((s) => s['Sid'] === 'TagAtLaunch')!;
    expect(tagAtLaunch['Resource']).toContain('arn:aws:ec2:us-east-1:*:network-interface/*');
  });

  it('an indexer account may also terminate an untagged instance (MOTIR-9450)', () => {
    const doc = awsRunnerPolicyDocument({
      shardTag: 'indexer-use1-1',
      regionId: 'us-east-1',
      reapUntagged: true,
    });
    const any = doc.Statement.find((s) => s['Sid'] === 'TerminateAnyInAccount')!;
    expect(any).toMatchObject({
      Effect: 'Allow',
      Action: 'ec2:TerminateInstances',
      Resource: 'arn:aws:ec2:us-east-1:*:instance/*',
    });
    expect(any).not.toHaveProperty('Condition');
    // Nothing else widens: the same actions as a runner account.
    expect(JSON.stringify(doc)).not.toMatch(/CreateAccessKey|ec2:\*/);
    expect(iamActionsOf(doc)).toEqual(['iam:PassRole']);
  });
});

describe('awsAgentHosterPolicyDocument', () => {
  it('adds the persistent instance’s calls to the runner’s, each held to the account’s tag', () => {
    const doc = awsAgentHosterPolicyDocument({ shardTag: 'h1', regionId: 'us-east-1' });
    const runner = awsRunnerPolicyDocument({ shardTag: 'h1', regionId: 'us-east-1' });
    expect(doc.Statement.slice(0, runner.Statement.length)).toEqual(runner.Statement);
    const added = doc.Statement.slice(runner.Statement.length);
    expect(new Set(added.flatMap((s) => [s['Action']].flat()))).toEqual(
      new Set([
        'ec2:DescribeVolumes',
        'ec2:StopInstances',
        'ec2:StartInstances',
        'ec2:DescribeInstanceAttribute',
        'ec2:ModifyInstanceAttribute',
        'ec2:CreateTags',
        'ec2:DeleteVolume',
        'ec2:AuthorizeSecurityGroupIngress',
      ]),
    );
    for (const statement of added.filter((s) => s['Sid'] !== 'DescribeVolumes')) {
      expect(statement['Condition']).toEqual({
        StringEquals: { 'aws:ResourceTag/motir-shard': 'h1' },
      });
    }
    expect(added.find((s) => s['Sid'] === 'DeleteOwnDisk')!['Resource']).toBe(
      'arn:aws:ec2:us-east-1:*:volume/*',
    );
    expect(JSON.stringify(doc)).not.toMatch(/CreateAccessKey|ec2:\*/);
    expect(iamActionsOf(doc)).toEqual(['iam:PassRole']);
  });
});

describe('the Tenants organizational unit (MOTIR-9940)', () => {
  const ROOT = { Roots: [{ Id: 'r-root' }] };

  it('finds an existing OU by name under the root, paging, and creates nothing', async () => {
    const { api, calls } = harness({
      AssumeRoleCommand: assume,
      ListRootsCommand: () => ROOT,
      ListOrganizationalUnitsForParentCommand: (input) =>
        input['NextToken']
          ? { OrganizationalUnits: [{ Id: 'ou-tenants', Name: 'Tenants' }] }
          : { OrganizationalUnits: [{ Id: 'ou-other', Name: 'Other' }], NextToken: 'p2' },
    });

    expect(await api.ensureOrganizationalUnit('Tenants')).toEqual({
      ouId: 'ou-tenants',
      created: false,
    });
    expect(
      calls.find((c) => c.command === 'ListOrganizationalUnitsForParentCommand')!.input,
    ).toEqual({ ParentId: 'r-root' });
    expect(calls.map((c) => c.command)).not.toContain('CreateOrganizationalUnitCommand');
    expect(
      calls
        .filter((c) => c.service === 'organizations')
        .every((c) => c.sessionToken === 'token-MGMT'),
    ).toBe(true);
  });

  it('creates the OU under the root only when absent', async () => {
    const { api, calls } = harness({
      AssumeRoleCommand: assume,
      ListRootsCommand: () => ROOT,
      ListOrganizationalUnitsForParentCommand: () => ({ OrganizationalUnits: [] }),
      CreateOrganizationalUnitCommand: () => ({
        OrganizationalUnit: { Id: 'ou-new', Name: 'Tenants' },
      }),
    });

    expect(await api.ensureOrganizationalUnit('Tenants')).toEqual({
      ouId: 'ou-new',
      created: true,
    });
    const creates = calls.filter((c) => c.command === 'CreateOrganizationalUnitCommand');
    expect(creates.map((c) => c.input)).toEqual([{ ParentId: 'r-root', Name: 'Tenants' }]);
  });

  it('answers the racing OU when AWS says DuplicateOrganizationalUnitException', async () => {
    let lists = 0;
    const { api, calls } = harness({
      AssumeRoleCommand: assume,
      ListRootsCommand: () => ROOT,
      ListOrganizationalUnitsForParentCommand: () =>
        (lists += 1) === 1
          ? { OrganizationalUnits: [] }
          : { OrganizationalUnits: [{ Id: 'ou-raced', Name: 'Tenants' }] },
      CreateOrganizationalUnitCommand: () => {
        throw sdkError('DuplicateOrganizationalUnitException');
      },
    });

    expect(await api.ensureOrganizationalUnit('Tenants')).toEqual({
      ouId: 'ou-raced',
      created: false,
    });
    expect(calls.filter((c) => c.command === 'CreateOrganizationalUnitCommand')).toHaveLength(1);
  });

  it('surfaces any other create failure as a coded error', async () => {
    const { api } = harness({
      AssumeRoleCommand: assume,
      ListRootsCommand: () => ROOT,
      ListOrganizationalUnitsForParentCommand: () => ({ OrganizationalUnits: [] }),
      CreateOrganizationalUnitCommand: () => {
        throw sdkError('AccessDeniedException', 403);
      },
    });

    await expect(api.ensureOrganizationalUnit('Tenants')).rejects.toMatchObject({
      name: 'AwsManagementApiError',
      awsCode: 'AccessDeniedException',
    });
  });
});

describe('the tenant account bootstrap calls (MOTIR-9941)', () => {
  const FARGATE = { serviceCode: 'fargate', quotaCode: 'L-3032A538', desiredValue: 64 };

  it('tags the account only when the value differs', async () => {
    const tagged = harness({
      AssumeRoleCommand: assume,
      ListTagsForResourceCommand: () => ({ Tags: [{ Key: 'motir:organization', Value: 'old' }] }),
      TagResourceCommand: () => ({}),
    });
    expect(await tagged.api.ensureAccountTag('123', 'motir:organization', 'org_1')).toEqual({
      tagged: true,
    });
    expect(tagged.calls.find((c) => c.command === 'TagResourceCommand')).toMatchObject({
      service: 'organizations',
      sessionToken: 'token-MGMT',
      input: { ResourceId: '123', Tags: [{ Key: 'motir:organization', Value: 'org_1' }] },
    });

    const already = harness({
      AssumeRoleCommand: assume,
      ListTagsForResourceCommand: (input) =>
        input['NextToken']
          ? { Tags: [{ Key: 'motir:organization', Value: 'org_1' }] }
          : { Tags: [], NextToken: 'p2' },
    });
    expect(await already.api.ensureAccountTag('123', 'motir:organization', 'org_1')).toEqual({
      tagged: false,
    });
    expect(already.calls.map((c) => c.command)).not.toContain('TagResourceCommand');
  });

  it('files a quota raise below target with none open', async () => {
    const { api, calls } = harness({
      GetServiceQuotaCommand: () => ({ Quota: { Value: 6 } }),
      ListRequestedServiceQuotaChangeHistoryByQuotaCommand: () => ({ RequestedQuotas: [] }),
      RequestServiceQuotaIncreaseCommand: () => ({
        RequestedQuota: { Id: 'q-1', Status: 'PENDING', DesiredValue: 64 },
      }),
    });

    expect(await api.ensureQuotaRaise(MEMBER, 'us-east-1', FARGATE)).toEqual({
      filed: true,
      pending: true,
    });
    const request = calls.find((c) => c.command === 'RequestServiceQuotaIncreaseCommand')!;
    expect(request).toMatchObject({ region: 'us-east-1', accessKeyId: MEMBER.accessKeyId });
    expect(request.input).toEqual({
      ServiceCode: 'fargate',
      QuotaCode: 'L-3032A538',
      DesiredValue: 64,
    });
  });

  it('files nothing for a quota at target, read from the default when never changed', async () => {
    const { api, calls } = harness({
      GetServiceQuotaCommand: () => {
        throw sdkError('NoSuchResourceException');
      },
      GetAWSDefaultServiceQuotaCommand: () => ({ Quota: { Value: 64 } }),
    });

    expect(await api.ensureQuotaRaise(MEMBER, 'us-east-1', FARGATE)).toEqual({
      filed: false,
      pending: false,
    });
    expect(calls.map((c) => c.command)).not.toContain('RequestServiceQuotaIncreaseCommand');
  });

  it('files nothing and reports pending when a raise is already open', async () => {
    const { api, calls } = harness({
      GetServiceQuotaCommand: () => ({ Quota: { Value: 6 } }),
      ListRequestedServiceQuotaChangeHistoryByQuotaCommand: (input) =>
        input['Status'] === 'CASE_OPENED'
          ? { RequestedQuotas: [{ Id: 'q-0', Status: 'CASE_OPENED', DesiredValue: 64 }] }
          : { RequestedQuotas: [] },
    });

    expect(await api.ensureQuotaRaise(MEMBER, 'us-east-1', FARGATE)).toEqual({
      filed: false,
      pending: true,
    });
    expect(calls.map((c) => c.command)).not.toContain('RequestServiceQuotaIncreaseCommand');
  });

  it('answers a raise filed concurrently as pending, and surfaces other errors by code', async () => {
    const raced = harness({
      GetServiceQuotaCommand: () => ({ Quota: { Value: 6 } }),
      ListRequestedServiceQuotaChangeHistoryByQuotaCommand: () => ({ RequestedQuotas: [] }),
      RequestServiceQuotaIncreaseCommand: () => {
        throw sdkError('ResourceAlreadyExistsException');
      },
    });
    expect(await raced.api.ensureQuotaRaise(MEMBER, 'us-east-1', FARGATE)).toEqual({
      filed: false,
      pending: true,
    });

    const denied = harness({
      GetServiceQuotaCommand: () => ({ Quota: { Value: 6 } }),
      ListRequestedServiceQuotaChangeHistoryByQuotaCommand: () => ({ RequestedQuotas: [] }),
      RequestServiceQuotaIncreaseCommand: () => {
        throw sdkError('AccessDeniedException', 403);
      },
    });
    await expect(denied.api.ensureQuotaRaise(MEMBER, 'us-east-1', FARGATE)).rejects.toMatchObject({
      name: 'AwsManagementApiError',
      awsCode: 'AccessDeniedException',
    });
  });
});

// MOTIR-11878 — the tenant deploy role's grants are customer-managed policies.
// The IAM below is a small stateful stand-in, so a test can converge an account,
// look at what it holds, and converge it again to see that nothing is written.
describe('the tenant deploy role’s managed policies (MOTIR-11878)', () => {
  const ACCOUNT = '400000000101';
  const PATH = AWS_TENANT_DEPLOY_POLICY_PATH;
  const doc = (action: string) => ({
    Version: '2012-10-17' as const,
    Statement: [{ Effect: 'Allow', Action: action, Resource: '*' }],
  });
  const policy = (name: string, action: string): AwsManagedPolicy => ({
    name,
    description: `Motir tenant deploys: ${name}.`,
    document: doc(action),
  });
  const WANTED = [
    policy('motir-tenant-deploy-compute', 'ecs:*'),
    policy('motir-tenant-deploy-network', 'ec2:Describe*'),
  ];
  const arnOf = (name: string, path = PATH) => `arn:aws:iam::${ACCOUNT}:policy${path}${name}`;
  const WRITES = new Set([
    'CreateRoleCommand',
    'CreatePolicyCommand',
    'CreatePolicyVersionCommand',
    'DeletePolicyVersionCommand',
    'AttachRolePolicyCommand',
    'DetachRolePolicyCommand',
    'DeletePolicyCommand',
    'DeleteRolePolicyCommand',
    'PutRolePolicyCommand',
  ]);

  interface StoredPolicy {
    name: string;
    path: string;
    versions: Array<{ id: string; document: string; created: number }>;
    defaultId: string;
    next: number;
  }

  /** IAM, as far as the convergence reads and writes it. `pageSize` pages
   *  every list, so the markers are followed. */
  function iamState(seed: { role?: boolean; inline?: string[]; pageSize?: number } = {}) {
    const state = {
      role: seed.role ?? false,
      inline: new Set(seed.inline ?? []),
      policies: new Map<string, StoredPolicy>(),
      attached: new Set<string>(),
      clock: 0,
    };
    const pageSize = seed.pageSize ?? 100;
    const page = <T>(items: T[], input: Record<string, unknown>) => {
      const start = Number(input['Marker'] ?? 0);
      const slice = items.slice(start, start + pageSize);
      const more = start + pageSize < items.length;
      return { slice, IsTruncated: more, ...(more ? { Marker: String(start + pageSize) } : {}) };
    };
    const byArn = (arn: unknown) => {
      const found = state.policies.get(String(arn));
      if (!found) throw sdkError('NoSuchEntity', 404);
      return found;
    };
    const handlers: Record<string, Handler> = {
      GetRoleCommand: () => {
        if (!state.role) throw sdkError('NoSuchEntity', 404);
        return { Role: { RoleName: AWS_TENANT_DEPLOY_ROLE } };
      },
      CreateRoleCommand: () => {
        state.role = true;
        return {};
      },
      ListPoliciesCommand: (input) => {
        expect(input['Scope']).toBe('Local');
        const all = [...state.policies.entries()]
          .filter(([, p]) => p.path.startsWith(String(input['PathPrefix'])))
          .map(([arn, p]) => ({ PolicyName: p.name, Arn: arn, DefaultVersionId: p.defaultId }));
        const { slice, ...rest } = page(all, input);
        return { Policies: slice, ...rest };
      },
      CreatePolicyCommand: (input) => {
        const arn = arnOf(String(input['PolicyName']), String(input['Path']));
        if (state.policies.has(arn)) throw sdkError('EntityAlreadyExists', 409);
        state.policies.set(arn, {
          name: String(input['PolicyName']),
          path: String(input['Path']),
          versions: [
            { id: 'v1', document: String(input['PolicyDocument']), created: state.clock++ },
          ],
          defaultId: 'v1',
          next: 2,
        });
        return { Policy: { Arn: arn } };
      },
      GetPolicyVersionCommand: (input) => {
        const p = byArn(input['PolicyArn']);
        const v = p.versions.find((x) => x.id === input['VersionId'])!;
        return { PolicyVersion: { Document: encodeURIComponent(v.document) } };
      },
      ListPolicyVersionsCommand: (input) => {
        const p = byArn(input['PolicyArn']);
        const all = p.versions.map((v) => ({
          VersionId: v.id,
          IsDefaultVersion: v.id === p.defaultId,
          CreateDate: new Date(v.created),
        }));
        const { slice, ...rest } = page(all, input);
        return { Versions: slice, ...rest };
      },
      DeletePolicyVersionCommand: (input) => {
        const p = byArn(input['PolicyArn']);
        expect(input['VersionId']).not.toBe(p.defaultId);
        p.versions = p.versions.filter((v) => v.id !== input['VersionId']);
        return {};
      },
      CreatePolicyVersionCommand: (input) => {
        const p = byArn(input['PolicyArn']);
        if (p.versions.length >= 5) throw sdkError('LimitExceeded', 409);
        const id = `v${p.next++}`;
        p.versions.push({ id, document: String(input['PolicyDocument']), created: state.clock++ });
        if (input['SetAsDefault']) p.defaultId = id;
        return {};
      },
      DeletePolicyCommand: (input) => {
        const p = byArn(input['PolicyArn']);
        expect(state.attached.has(String(input['PolicyArn']))).toBe(false);
        expect(p.versions).toHaveLength(1);
        state.policies.delete(String(input['PolicyArn']));
        return {};
      },
      ListAttachedRolePoliciesCommand: (input) => {
        const all = [...state.attached]
          .filter((arn) => arn.includes(`:policy${String(input['PathPrefix'])}`))
          .map((arn) => ({ PolicyArn: arn }));
        const { slice, ...rest } = page(all, input);
        return { AttachedPolicies: slice, ...rest };
      },
      AttachRolePolicyCommand: (input) => {
        byArn(input['PolicyArn']);
        state.attached.add(String(input['PolicyArn']));
        return {};
      },
      DetachRolePolicyCommand: (input) => {
        state.attached.delete(String(input['PolicyArn']));
        return {};
      },
      ListRolePoliciesCommand: (input) => {
        const { slice, ...rest } = page([...state.inline], input);
        return { PolicyNames: slice, ...rest };
      },
      DeleteRolePolicyCommand: (input) => {
        if (!state.inline.delete(String(input['PolicyName']))) throw sdkError('NoSuchEntity', 404);
        return {};
      },
    };
    /** What the role holds, as names and default documents. */
    const held = () =>
      [...state.attached].sort().map((arn) => {
        const p = state.policies.get(arn)!;
        return { name: p.name, document: p.versions.find((v) => v.id === p.defaultId)!.document };
      });
    return { state, handlers, held };
  }

  const writesOf = (calls: SentCall[]) => calls.filter((c) => WRITES.has(c.command));
  const asHeld = (policies: readonly AwsManagedPolicy[]) =>
    [...policies]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ name: p.name, document: JSON.stringify(p.document) }));

  it('creates the role, its policies under the path, and attaches each, with the member session', async () => {
    const iam = iamState();
    const { api, calls } = harness(iam.handlers);

    expect(await api.ensureTenantDeployRole(MEMBER, WANTED)).toEqual({
      created: true,
      policyChanged: true,
    });
    expect(iam.held()).toEqual(asHeld(WANTED));
    expect(iam.state.inline.size).toBe(0);
    expect(calls.every((c) => c.service === 'iam' && c.accessKeyId === MEMBER.accessKeyId)).toBe(
      true,
    );
    const creates = calls.filter((c) => c.command === 'CreatePolicyCommand').map((c) => c.input);
    expect(creates).toEqual(
      WANTED.map((p) => ({
        PolicyName: p.name,
        Path: PATH,
        PolicyDocument: JSON.stringify(p.document),
        Description: p.description,
        Tags: [{ Key: 'motir-role', Value: 'tenant-deploy' }],
      })),
    );
    const trust = JSON.parse(
      String(
        calls.find((c) => c.command === 'CreateRoleCommand')!.input['AssumeRolePolicyDocument'],
      ),
    ) as { Statement: Array<{ Principal: unknown }> };
    expect(trust.Statement.map((s) => s.Principal)).toEqual([{ AWS: MANAGEMENT.roleArn }]);
    expect(calls.map((c) => c.command)).not.toContain('PutRolePolicyCommand');
  });

  it('replaces the legacy inline policy: attaches the managed set first, deletes the inline last, and a replay writes nothing', async () => {
    const iam = iamState({ role: true, inline: [AWS_TENANT_DEPLOY_ROLE, 'someone-elses'] });
    const first = harness(iam.handlers);

    expect(await first.api.ensureTenantDeployRole(MEMBER, WANTED)).toEqual({
      created: false,
      policyChanged: true,
    });
    const order = writesOf(first.calls).map((c) => c.command);
    expect(order).toEqual([
      'CreatePolicyCommand',
      'CreatePolicyCommand',
      'AttachRolePolicyCommand',
      'AttachRolePolicyCommand',
      'DeleteRolePolicyCommand',
    ]);
    expect(first.calls.find((c) => c.command === 'DeleteRolePolicyCommand')!.input).toEqual({
      RoleName: AWS_TENANT_DEPLOY_ROLE,
      PolicyName: AWS_TENANT_DEPLOY_ROLE,
    });
    // Only the legacy policy goes; an inline policy it does not own stays.
    expect([...iam.state.inline]).toEqual(['someone-elses']);
    expect(iam.held()).toEqual(asHeld(WANTED));

    const replay = harness(iam.handlers);
    expect(await replay.api.ensureTenantDeployRole(MEMBER, WANTED)).toEqual({
      created: false,
      policyChanged: false,
    });
    expect(writesOf(replay.calls)).toEqual([]);
  });

  it('gives a policy whose document differs a new default version, and leaves the same one alone', async () => {
    const iam = iamState({ role: true });
    await harness(iam.handlers).api.ensureTenantDeployRole(MEMBER, WANTED);
    const changed = [WANTED[0]!, policy('motir-tenant-deploy-network', 'ec2:*')];

    const { api, calls } = harness(iam.handlers);
    expect(await api.ensureTenantDeployRole(MEMBER, changed)).toEqual({
      created: false,
      policyChanged: true,
    });
    expect(writesOf(calls).map((c) => [c.command, c.input])).toEqual([
      [
        'CreatePolicyVersionCommand',
        {
          PolicyArn: arnOf('motir-tenant-deploy-network'),
          PolicyDocument: JSON.stringify(changed[1]!.document),
          SetAsDefault: true,
        },
      ],
    ]);
    expect(iam.held()).toEqual(asHeld(changed));
  });

  it('compares documents by meaning, not by spelling', async () => {
    const iam = iamState({ role: true });
    await harness(iam.handlers).api.ensureTenantDeployRole(MEMBER, WANTED);
    // IAM hands a document back URL-encoded and may re-space it.
    for (const p of iam.state.policies.values()) {
      p.versions[0]!.document = JSON.stringify(JSON.parse(p.versions[0]!.document), null, 2);
    }
    const { api, calls } = harness(iam.handlers);
    expect((await api.ensureTenantDeployRole(MEMBER, WANTED)).policyChanged).toBe(false);
    expect(writesOf(calls)).toEqual([]);
  });

  it('deletes the oldest non-default version first when IAM’s five are taken', async () => {
    const iam = iamState({ role: true, pageSize: 2 });
    await harness(iam.handlers).api.ensureTenantDeployRole(MEMBER, WANTED);
    for (let i = 0; i < 4; i += 1) {
      await harness(iam.handlers).api.ensureTenantDeployRole(MEMBER, [
        WANTED[0]!,
        policy('motir-tenant-deploy-network', `ec2:Step${i}`),
      ]);
    }
    const network = iam.state.policies.get(arnOf('motir-tenant-deploy-network'))!;
    expect(network.versions.map((v) => v.id)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']);

    const { api, calls } = harness(iam.handlers);
    await api.ensureTenantDeployRole(MEMBER, WANTED);
    expect(writesOf(calls).map((c) => [c.command, c.input['VersionId'] ?? null])).toEqual([
      ['DeletePolicyVersionCommand', 'v1'],
      ['CreatePolicyVersionCommand', null],
    ]);
    expect(network.versions.map((v) => v.id)).toEqual(['v2', 'v3', 'v4', 'v5', 'v6']);
    expect(iam.held()).toEqual(asHeld(WANTED));
  });

  it('attaches a policy that exists but is not attached', async () => {
    const iam = iamState({ role: true });
    await harness(iam.handlers).api.ensureTenantDeployRole(MEMBER, WANTED);
    iam.state.attached.delete(arnOf('motir-tenant-deploy-compute'));

    const { api, calls } = harness(iam.handlers);
    expect((await api.ensureTenantDeployRole(MEMBER, WANTED)).policyChanged).toBe(true);
    expect(writesOf(calls).map((c) => [c.command, c.input])).toEqual([
      [
        'AttachRolePolicyCommand',
        { RoleName: AWS_TENANT_DEPLOY_ROLE, PolicyArn: arnOf('motir-tenant-deploy-compute') },
      ],
    ]);
  });

  it('detaches and deletes a policy under the path the role no longer wants, and only after attaching the rest', async () => {
    const iam = iamState({ role: true });
    const retired = policy('motir-tenant-deploy-retired', 'sqs:*');
    await harness(iam.handlers).api.ensureTenantDeployRole(MEMBER, [WANTED[0]!, retired]);
    // Two versions, so the non-default one must go before the policy can.
    await harness(iam.handlers).api.ensureTenantDeployRole(MEMBER, [
      WANTED[0]!,
      policy('motir-tenant-deploy-retired', 'sqs:Get*'),
    ]);
    // A policy under another path is not the role's to remove.
    await iam.handlers['CreatePolicyCommand']!(
      { PolicyName: 'elsewhere', Path: '/other/', PolicyDocument: '{}' },
      {} as SentCall,
    );

    const { api, calls } = harness(iam.handlers);
    expect((await api.ensureTenantDeployRole(MEMBER, WANTED)).policyChanged).toBe(true);
    expect(writesOf(calls).map((c) => [c.command, c.input['PolicyArn'] ?? null])).toEqual([
      ['CreatePolicyCommand', null],
      ['AttachRolePolicyCommand', arnOf('motir-tenant-deploy-network')],
      ['DetachRolePolicyCommand', arnOf('motir-tenant-deploy-retired')],
      ['DeletePolicyVersionCommand', arnOf('motir-tenant-deploy-retired')],
      ['DeletePolicyCommand', arnOf('motir-tenant-deploy-retired')],
    ]);
    expect(iam.held()).toEqual(asHeld(WANTED));
    expect(iam.state.policies.has(arnOf('elsewhere', '/other/'))).toBe(true);
  });

  it('deletes a stale policy that is not attached, and tolerates one a concurrent pass deleted', async () => {
    const iam = iamState({ role: true });
    await iam.handlers['CreatePolicyCommand']!(
      { PolicyName: 'motir-tenant-deploy-old', Path: PATH, PolicyDocument: '{}' },
      {} as SentCall,
    );
    const deletePolicy = iam.handlers['DeletePolicyCommand']!;
    iam.handlers['DeletePolicyCommand'] = (input, call) => {
      deletePolicy(input, call);
      throw sdkError('NoSuchEntity', 404);
    };
    const { api, calls } = harness(iam.handlers);
    expect((await api.ensureTenantDeployRole(MEMBER, WANTED)).policyChanged).toBe(true);
    expect(calls.map((c) => c.command)).not.toContain('DetachRolePolicyCommand');
    expect(iam.state.policies.has(arnOf('motir-tenant-deploy-old'))).toBe(false);
  });

  it('converges the policy a concurrent pass created between the list and the create', async () => {
    const iam = iamState({ role: true });
    const create = iam.handlers['CreatePolicyCommand']!;
    let raced = false;
    iam.handlers['CreatePolicyCommand'] = (input, call) => {
      if (!raced) {
        raced = true;
        create({ ...input, PolicyDocument: JSON.stringify(doc('ecs:Old')) }, call);
        throw sdkError('EntityAlreadyExists', 409);
      }
      return create(input, call);
    };
    const { api, calls } = harness(iam.handlers);
    expect((await api.ensureTenantDeployRole(MEMBER, WANTED)).policyChanged).toBe(true);
    expect(calls.filter((c) => c.command === 'CreatePolicyVersionCommand')).toHaveLength(1);
    expect(iam.held()).toEqual(asHeld(WANTED));
  });

  it('rethrows EntityAlreadyExists on a policy create when the relist does not find it', async () => {
    const iam = iamState({ role: true });
    iam.handlers['CreatePolicyCommand'] = () => {
      throw sdkError('EntityAlreadyExists', 409);
    };
    const { api } = harness(iam.handlers);
    await expect(api.ensureTenantDeployRole(MEMBER, WANTED)).rejects.toMatchObject({
      name: 'AwsManagementApiError',
      awsCode: 'EntityAlreadyExists',
    });
  });

  it('rethrows any other refusal of a policy create', async () => {
    const iam = iamState({ role: true });
    iam.handlers['CreatePolicyCommand'] = () => {
      throw sdkError('LimitExceeded', 409);
    };
    const { api } = harness(iam.handlers);
    await expect(api.ensureTenantDeployRole(MEMBER, WANTED)).rejects.toMatchObject({
      awsCode: 'LimitExceeded',
    });
  });

  it('treats EntityAlreadyExists on the role create as found', async () => {
    const iam = iamState();
    iam.handlers['CreateRoleCommand'] = () => {
      throw sdkError('EntityAlreadyExists', 409);
    };
    const { api } = harness(iam.handlers);
    expect(await api.ensureTenantDeployRole(MEMBER, WANTED)).toEqual({
      created: false,
      policyChanged: true,
    });
  });

  it('tolerates the inline policy a concurrent pass deleted, and rethrows any other refusal', async () => {
    const gone = iamState({ role: true, inline: [AWS_TENANT_DEPLOY_ROLE] });
    gone.handlers['DeleteRolePolicyCommand'] = () => {
      throw sdkError('NoSuchEntity', 404);
    };
    expect(
      (await harness(gone.handlers).api.ensureTenantDeployRole(MEMBER, WANTED)).policyChanged,
    ).toBe(true);

    const denied = iamState({ role: true, inline: [AWS_TENANT_DEPLOY_ROLE] });
    denied.handlers['DeleteRolePolicyCommand'] = () => {
      throw sdkError('AccessDenied', 403);
    };
    await expect(
      harness(denied.handlers).api.ensureTenantDeployRole(MEMBER, WANTED),
    ).rejects.toMatchObject({ awsCode: 'AccessDenied' });
    // The managed set landed before the refusal: the role was never left bare.
    expect(denied.held()).toEqual(asHeld(WANTED));
  });

  it('follows every list’s marker', async () => {
    const iam = iamState({ role: true, inline: ['a', 'b', AWS_TENANT_DEPLOY_ROLE], pageSize: 1 });
    const { api, calls } = harness(iam.handlers);
    await api.ensureTenantDeployRole(MEMBER, WANTED);
    expect(calls.filter((c) => c.command === 'ListRolePoliciesCommand')).toHaveLength(3);
    expect([...iam.state.inline]).toEqual(['a', 'b']);

    const replay = harness(iam.handlers);
    await replay.api.ensureTenantDeployRole(MEMBER, WANTED);
    expect(writesOf(replay.calls)).toEqual([]);
    expect(replay.calls.filter((c) => c.command === 'ListPoliciesCommand')).toHaveLength(2);
    expect(
      replay.calls.filter((c) => c.command === 'ListAttachedRolePoliciesCommand'),
    ).toHaveLength(2);
  });

  it('refuses a set IAM would refuse before making any call', async () => {
    const { api, calls } = harness({});
    const big = policy('motir-tenant-deploy-big', 'x'.repeat(AWS_MANAGED_POLICY_MAX_CHARS));
    await expect(api.ensureTenantDeployRole(MEMBER, [big])).rejects.toBeInstanceOf(
      AwsManagedPolicySetInvalidError,
    );
    await expect(
      api.ensureTenantDeployRole(MEMBER, [WANTED[0]!, WANTED[0]!]),
    ).rejects.toMatchObject({
      code: 'AWS_MANAGED_POLICY_SET_INVALID',
      problems: ['motir-tenant-deploy-compute is named twice'],
    });
    expect(calls).toEqual([]);
  });

  it('rethrows a refusal of the role create or a stale policy delete', async () => {
    const role = iamState();
    role.handlers['CreateRoleCommand'] = () => {
      throw sdkError('AccessDenied', 403);
    };
    await expect(
      harness(role.handlers).api.ensureTenantDeployRole(MEMBER, WANTED),
    ).rejects.toMatchObject({ awsCode: 'AccessDenied' });

    const stale = iamState({ role: true });
    await stale.handlers['CreatePolicyCommand']!(
      { PolicyName: 'motir-tenant-deploy-old', Path: PATH, PolicyDocument: '{}' },
      {} as SentCall,
    );
    stale.handlers['DeletePolicyCommand'] = () => {
      throw sdkError('DeleteConflict', 409);
    };
    await expect(
      harness(stale.handlers).api.ensureTenantDeployRole(MEMBER, WANTED),
    ).rejects.toMatchObject({ awsCode: 'DeleteConflict' });
  });

  it('refuses eleven policies, over the ten a role may hold', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) =>
      policy(`motir-tenant-deploy-${i}`, 'ec2:*'),
    );
    await expect(harness({}).api.ensureTenantDeployRole(MEMBER, eleven)).rejects.toMatchObject({
      problems: ['11 policies, over the 10 a role may hold'],
    });
  });

  it('reads sparse IAM answers — no list bodies, no marker, no version dates — without failing', async () => {
    const versions = Array.from({ length: 5 }, (_, i) => ({
      VersionId: `v${i + 1}`,
      IsDefaultVersion: true,
    }));
    const { api, calls } = harness({
      GetRoleCommand: () => ({}),
      // A truncated page with no marker ends the walk rather than looping.
      ListPoliciesCommand: () => ({ IsTruncated: true }),
      CreatePolicyCommand: (input) => ({
        Policy: { Arn: arnOf(String(input['PolicyName'])) },
      }),
      ListAttachedRolePoliciesCommand: () => ({}),
      AttachRolePolicyCommand: () => ({}),
      ListRolePoliciesCommand: () => ({}),
    });
    expect((await api.ensureTenantDeployRole(MEMBER, WANTED)).policyChanged).toBe(true);
    expect(calls.filter((c) => c.command === 'AttachRolePolicyCommand')).toHaveLength(2);

    const versioned = harness({
      GetRoleCommand: () => ({}),
      ListPoliciesCommand: () => ({
        Policies: WANTED.map((p) => ({
          PolicyName: p.name,
          Arn: arnOf(p.name),
          DefaultVersionId: 'v5',
        })),
      }),
      GetPolicyVersionCommand: () => ({ PolicyVersion: {} }),
      // Five versions, none of them dated and none deletable: the new version
      // is still asked for, and IAM's own refusal would be the answer.
      ListPolicyVersionsCommand: () => ({ Versions: versions }),
      CreatePolicyVersionCommand: () => ({}),
      ListAttachedRolePoliciesCommand: () => ({
        AttachedPolicies: WANTED.map((p) => ({ PolicyArn: arnOf(p.name) })),
      }),
      ListRolePoliciesCommand: () => ({ PolicyNames: [] }),
    });
    await versioned.api.ensureTenantDeployRole(MEMBER, WANTED);
    expect(writesOf(versioned.calls).map((c) => c.command)).toEqual([
      'CreatePolicyVersionCommand',
      'CreatePolicyVersionCommand',
    ]);

    const empty = harness({
      GetRoleCommand: () => ({}),
      ListPoliciesCommand: () => ({
        Policies: [
          {
            PolicyName: 'motir-tenant-deploy-old',
            Arn: arnOf('motir-tenant-deploy-old'),
            DefaultVersionId: 'v1',
          },
        ],
      }),
      CreatePolicyCommand: (input) => ({ Policy: { Arn: arnOf(String(input['PolicyName'])) } }),
      ListAttachedRolePoliciesCommand: () => ({}),
      AttachRolePolicyCommand: () => ({}),
      ListPolicyVersionsCommand: () => ({}),
      DeletePolicyCommand: () => ({}),
      ListRolePoliciesCommand: () => ({}),
    });
    await empty.api.ensureTenantDeployRole(MEMBER, WANTED);
    expect(empty.calls.map((c) => c.command)).toContain('DeletePolicyCommand');
  });

  it('sorts undated versions as the oldest when it must make room', async () => {
    const { api, calls } = harness({
      GetRoleCommand: () => ({}),
      ListPoliciesCommand: () => ({
        Policies: [
          { PolicyName: WANTED[0]!.name, Arn: arnOf(WANTED[0]!.name), DefaultVersionId: 'v5' },
        ],
      }),
      GetPolicyVersionCommand: () => ({
        PolicyVersion: { Document: encodeURIComponent('{"old":true}') },
      }),
      ListPolicyVersionsCommand: () => ({
        Versions: [
          { VersionId: 'v3', CreateDate: new Date(3) },
          { VersionId: 'v1' },
          { VersionId: 'v4', CreateDate: new Date(4) },
          { VersionId: 'v2' },
          { VersionId: 'v5', IsDefaultVersion: true, CreateDate: new Date(5) },
        ],
      }),
      DeletePolicyVersionCommand: () => ({}),
      CreatePolicyVersionCommand: () => ({}),
      ListAttachedRolePoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: arnOf(WANTED[0]!.name) }],
      }),
      ListRolePoliciesCommand: () => ({ PolicyNames: [] }),
    });
    await api.ensureTenantDeployRole(MEMBER, [WANTED[0]!]);
    expect(calls.find((c) => c.command === 'DeletePolicyVersionCommand')!.input['VersionId']).toBe(
      'v1',
    );
  });

  it('answers a missing field in an IAM answer as MissingField', async () => {
    const iam = iamState({ role: true });
    iam.handlers['ListPoliciesCommand'] = () => ({ Policies: [{ PolicyName: 'x' }] });
    await expect(
      harness(iam.handlers).api.ensureTenantDeployRole(MEMBER, WANTED),
    ).rejects.toMatchObject({ awsCode: 'MissingField:Policy.Arn' });
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
