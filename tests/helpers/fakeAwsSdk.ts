import type { AwsManagementClientFactory, AwsManagementService } from '@motir/orchestrator';

// A FAKE AWS AT THE SDK BOUNDARY (MOTIR-9850). `FakeOrganization` in
// `addShardFakes.ts` stands in for the whole management PORT; this stands in for
// what the port talks to, so the REAL `createAwsManagementApi` runs over it: STS,
// Organizations, CloudFormation StackSets and Service Quotas, as one stateful
// world. Accounts, their units, the StackSet's instances and operations live
// here, so a run that is interrupted and run again reads the state the first
// run left, not a scripted answer.
//
// A created stack instance builds what the pool-account template builds — the
// tagged network, through `buildNetwork`, and the `motir-fleet-runner` role,
// which only then can be assumed — and answers the template's outputs.
//
// Every command is recorded on `calls` and on the shared `timeline`, which a test
// may also feed with its EC2 calls to assert the order across both.

export interface SdkCall {
  service: AwsManagementService;
  command: string;
  input: Record<string, unknown>;
  /** The access key id the client was built with; undefined on the default chain. */
  accessKeyId: string | undefined;
}

export interface FakeAwsAccount {
  id: string;
  name: string;
  email: string;
  parentId: string;
}

interface FakeStackInstance {
  stackSetName: string;
  accountId: string;
  region: string;
  overrides: Record<string, string>;
  stackId: string;
  outputs: Record<string, string>;
}

/** What creating an instance builds in the account's EC2: the template's network. */
export type NetworkBuilder = (input: {
  accountId: string;
  region: string;
  overrides: Record<string, string>;
}) => {
  vpcId: string;
  internetGatewayId: string;
  routeTableId: string;
  groupId: string;
  subnets: { zone: string; subnetId: string }[];
};

const ROOT = 'r-root';
const MEMBER_ROLE = 'OrganizationAccountAccessRole';
const RUNNER_ROLE = 'motir-fleet-runner';

/** The key ids the world's sessions carry, so a test can tell them apart. */
export const FAKE_AWS_KEYS = {
  management: 'ASIA_MANAGEMENT_SESSION',
  operator: 'ASIA_STACKSET_OPERATOR_SESSION',
  member: (accountId: string) => `ASIA_MEMBER_${accountId}`,
  runner: (accountId: string) => `ASIA_RUNNER_${accountId}`,
} as const;

function sdkError(name: string, status = 400): Error {
  return Object.assign(new Error(`AWS said: ${name}`), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

function session(accessKeyId: string) {
  return {
    Credentials: {
      AccessKeyId: accessKeyId,
      SecretAccessKey: `secret-of-${accessKeyId}`,
      SessionToken: `token-of-${accessKeyId}`,
      Expiration: new Date(Date.now() + 3_600_000),
    },
  };
}

function overridesOf(input: Record<string, unknown>): Record<string, string> {
  const list = (input['ParameterOverrides'] ?? []) as {
    ParameterKey: string;
    ParameterValue: string;
  }[];
  return Object.fromEntries(list.map((p) => [p.ParameterKey, p.ParameterValue]));
}

export class FakeAwsWorld {
  readonly calls: SdkCall[] = [];
  readonly accounts = new Map<string, FakeAwsAccount>();
  readonly instances = new Map<string, FakeStackInstance>();
  readonly operations = new Map<string, string>();
  /** Each member account's applied vCPU quota. */
  readonly quotas = new Map<string, number>();
  readonly quotaRequests = new Map<
    string,
    { accountId: string; status: string; desiredValue: number }
  >();
  /** A new account's quota, AWS's default for a fresh account. */
  defaultQuota = 5;
  /** Output values to answer instead of what the stack built, by output key;
   *  null leaves the output out. */
  readonly outputOverrides = new Map<string, string | null>();
  /** Member-account roles every assume of is refused, by role name. */
  readonly deniedRoles = new Set<string>();
  private readonly failures = new Map<string, Error>();
  private seq = 0;

  constructor(
    private readonly buildNetwork: NetworkBuilder,
    /** The shared order of events; a test pushes its EC2 calls here too. */
    readonly timeline: string[] = [],
  ) {}

  /** The next `command` throws `error` once, BEFORE it changes anything. */
  failNext(command: string, error: Error = sdkError('InternalFailure', 500)): void {
    this.failures.set(command, error);
  }

  sent(command: string): SdkCall[] {
    return this.calls.filter((c) => c.command === command);
  }

  account(name: string): FakeAwsAccount | undefined {
    return this.accounts.get(name);
  }

  /** The member account a session key belongs to, member or runner. */
  accountOfKey(accessKeyId: string): string | null {
    const match = /^ASIA_(?:MEMBER|RUNNER)_(\d+)$/.exec(accessKeyId);
    return match?.[1] ?? null;
  }

  readonly factory: AwsManagementClientFactory = (service, config) => ({
    send: async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      this.calls.push({
        service,
        command: name,
        input,
        accessKeyId: config.credentials?.accessKeyId,
      });
      this.timeline.push(`${service}:${name}`);
      const failure = this.failures.get(name);
      if (failure) {
        this.failures.delete(name);
        throw failure;
      }
      return this.answer(name, input, config.credentials?.accessKeyId);
    },
  });

  private byId(accountId: string): FakeAwsAccount {
    const account = [...this.accounts.values()].find((a) => a.id === accountId);
    if (!account) throw sdkError('AccountNotFoundException');
    return account;
  }

  private requireKey(actual: string | undefined, wanted: string, command: string): void {
    if (actual !== wanted) {
      throw new Error(`${command} was signed with ${actual ?? 'the default chain'}, not ${wanted}`);
    }
  }

  private instanceKey(stackSetName: unknown, accountId: unknown, region: unknown): string {
    return `${String(stackSetName)}/${String(accountId)}/${String(region)}`;
  }

  private answer(
    command: string,
    input: Record<string, unknown>,
    key: string | undefined,
  ): unknown {
    switch (command) {
      case 'AssumeRoleCommand': {
        const arn = String(input['RoleArn']);
        if (arn.endsWith(':role/motir-add-shard')) return session(FAKE_AWS_KEYS.management);
        this.requireKey(key, FAKE_AWS_KEYS.management, `AssumeRole ${arn}`);
        if (arn.includes('stackset-operator')) return session(FAKE_AWS_KEYS.operator);
        const [, accountId, role] = /^arn:aws:iam::(\d+):role\/(.+)$/.exec(arn) ?? [];
        if (!accountId) throw sdkError('ValidationError');
        this.byId(accountId);
        if (role && this.deniedRoles.has(role)) throw sdkError('AccessDenied', 403);
        if (role === MEMBER_ROLE) return session(FAKE_AWS_KEYS.member(accountId));
        // The runner role exists once the stack instance built it.
        const built = [...this.instances.values()].some((i) => i.accountId === accountId);
        if (role === RUNNER_ROLE && built) return session(FAKE_AWS_KEYS.runner(accountId));
        throw sdkError('AccessDenied', 403);
      }

      case 'ListAccountsCommand':
        return {
          Accounts: [...this.accounts.values()].map((a) => ({
            Id: a.id,
            Name: a.name,
            Email: a.email,
            State: 'ACTIVE',
          })),
        };
      case 'ListCreateAccountStatusCommand':
        return { CreateAccountStatuses: [] };
      case 'CreateAccountCommand': {
        const name = String(input['AccountName']);
        const email = String(input['Email']);
        if ([...this.accounts.values()].some((a) => a.email === email)) {
          return { CreateAccountStatus: { Id: 'car-refused', State: 'FAILED' } };
        }
        this.seq += 1;
        const id = String(500_000_000_000 + this.seq);
        this.accounts.set(name, { id, name, email, parentId: ROOT });
        return { CreateAccountStatus: { Id: `car-${id}`, State: 'IN_PROGRESS' } };
      }
      case 'DescribeCreateAccountStatusCommand': {
        const id = String(input['CreateAccountRequestId']).replace(/^car-/, '');
        if (id === 'refused') {
          return {
            CreateAccountStatus: { State: 'FAILED', FailureReason: 'EMAIL_ALREADY_EXISTS' },
          };
        }
        const account = this.byId(id);
        return {
          CreateAccountStatus: { State: 'SUCCEEDED', AccountId: id, AccountName: account.name },
        };
      }
      case 'ListParentsCommand':
        return { Parents: [{ Id: this.byId(String(input['ChildId'])).parentId }] };
      case 'MoveAccountCommand': {
        const account = this.byId(String(input['AccountId']));
        if (account.parentId !== input['SourceParentId'])
          throw sdkError('SourceParentNotFoundException');
        account.parentId = String(input['DestinationParentId']);
        return {};
      }

      case 'DescribeStackInstanceCommand': {
        const instance = this.instances.get(
          this.instanceKey(
            input['StackSetName'],
            input['StackInstanceAccount'],
            input['StackInstanceRegion'],
          ),
        );
        if (!instance) throw sdkError('StackInstanceNotFoundException');
        return {
          StackInstance: {
            Status: 'CURRENT',
            StackInstanceStatus: { DetailedStatus: 'SUCCEEDED' },
            StackId: instance.stackId,
            ParameterOverrides: Object.keys(instance.overrides)
              .sort()
              .map((k) => ({ ParameterKey: k, ParameterValue: instance.overrides[k] })),
          },
        };
      }
      case 'CreateStackInstancesCommand':
      case 'UpdateStackInstancesCommand': {
        const operationId = String(input['OperationId']);
        if (this.operations.has(operationId)) throw sdkError('OperationIdAlreadyExistsException');
        const targets = input['DeploymentTargets'] as {
          OrganizationalUnitIds: string[];
          Accounts: string[];
        };
        const regions = input['Regions'] as string[];
        const overrides = overridesOf(input);
        for (const accountId of targets.Accounts) {
          // INTERSECTION: an account outside the named unit gets nothing.
          if (!targets.OrganizationalUnitIds.includes(this.byId(accountId).parentId)) continue;
          for (const region of regions) {
            const key = this.instanceKey(input['StackSetName'], accountId, region);
            const existing = this.instances.get(key);
            if (command === 'UpdateStackInstancesCommand') {
              if (existing) existing.overrides = overrides;
              continue;
            }
            const built = this.buildNetwork({ accountId, region, overrides });
            this.instances.set(key, {
              stackSetName: String(input['StackSetName']),
              accountId,
              region,
              overrides,
              stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/StackSet-pool-${accountId}/1`,
              outputs: {
                VpcId: built.vpcId,
                InternetGatewayId: built.internetGatewayId,
                RouteTableId: built.routeTableId,
                SecurityGroupId: built.groupId,
                ...Object.fromEntries(
                  built.subnets.map((s) => [
                    `SubnetId${s.zone.slice(-1).toUpperCase()}`,
                    s.subnetId,
                  ]),
                ),
                RunnerRoleArn: `arn:aws:iam::${accountId}:role/${RUNNER_ROLE}`,
                TrailArn: `arn:aws:cloudtrail:${region}:${accountId}:trail/motir-pool`,
              },
            });
          }
        }
        this.operations.set(operationId, 'SUCCEEDED');
        return { OperationId: operationId };
      }
      case 'DescribeStackSetOperationCommand':
        return {
          StackSetOperation: { Status: this.operations.get(String(input['OperationId'])) ?? '' },
        };
      case 'DescribeStacksCommand': {
        const instance = [...this.instances.values()].find((i) => i.stackId === input['StackName']);
        if (!instance) throw sdkError('ValidationError');
        // The stack is read inside its own account, with the member session.
        this.requireKey(key, FAKE_AWS_KEYS.member(instance.accountId), 'DescribeStacks');
        const outputs = { ...instance.outputs };
        for (const [k, v] of this.outputOverrides) {
          if (v === null) delete outputs[k];
          else outputs[k] = v;
        }
        return {
          Stacks: [
            {
              Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({
                OutputKey,
                OutputValue,
              })),
            },
          ],
        };
      }

      case 'GetServiceQuotaCommand': {
        const accountId = key ? this.accountOfKey(key) : null;
        const value = accountId ? this.quotas.get(accountId) : undefined;
        if (value === undefined) throw sdkError('NoSuchResourceException');
        return { Quota: { Value: value } };
      }
      case 'GetAWSDefaultServiceQuotaCommand':
        return { Quota: { Value: this.defaultQuota } };
      case 'RequestServiceQuotaIncreaseCommand': {
        const accountId = (key && this.accountOfKey(key)) ?? 'unknown';
        this.seq += 1;
        const id = `quota-req-${this.seq}`;
        const desiredValue = Number(input['DesiredValue']);
        this.quotaRequests.set(id, { accountId, status: 'PENDING', desiredValue });
        return { RequestedQuota: { Id: id, Status: 'PENDING', DesiredValue: desiredValue } };
      }
      case 'GetRequestedServiceQuotaChangeCommand': {
        const request = this.quotaRequests.get(String(input['RequestId']));
        if (!request) throw sdkError('NoSuchResourceException');
        return {
          RequestedQuota: {
            Id: input['RequestId'],
            Status: request.status,
            DesiredValue: request.desiredValue,
          },
        };
      }
      case 'ListRequestedServiceQuotaChangeHistoryByQuotaCommand': {
        const accountId = key ? this.accountOfKey(key) : null;
        const open = [...this.quotaRequests.entries()].filter(
          ([, r]) => r.accountId === accountId && r.status === input['Status'],
        );
        return {
          RequestedQuotas: open.map(([Id, r]) => ({
            Id,
            Status: r.status,
            DesiredValue: r.desiredValue,
          })),
        };
      }
    }
    throw new Error(`the fake AWS has no ${command}`);
  }
}
