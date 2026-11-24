import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AWS_TENANT_DEPLOY_ROLE,
  AwsManagementApiError,
  AwsTenantApiError,
  StackFailedError,
  StackNameRefusedError,
  StackTagsRequiredError,
  StackWaitTimeoutError,
  TENANT_SESSION_RENEW_MS,
  TenantRoleUnavailableError,
  createAwsManagementApi,
  createFakeTenantClients,
  createFakeTenantCloudFormation,
  createStackRunner,
  createTenantClients,
  createTenantSdkClient,
  createFakeTenantLogs,
  fakeFilterPatternMatches,
  sdkTenantCloudFormation,
  sdkTenantEcs,
  sdkTenantLambda,
  sdkTenantLogs,
  tenantApiError,
  type ApplyStackInput,
  type AwsManagementClientFactory,
  type AwsSdkClient,
  type FakeCloudFormationOperation,
  type TenantSdkClientFactory,
} from '../src/index';

// THE AWS TENANT SEAM (MOTIR-10004): the deploy-role client factory, the
// CloudFormation client over the SDK, the idempotent stack runner and its
// fault-injecting fake. No live AWS call: the SDK is a recording stub.

const ACCOUNT = '210987654321';
const MANAGEMENT = { roleArn: 'arn:aws:iam::576360162297:role/motir-org-admin' };
const TAGS = { 'motir:organization': 'cmorg1', 'motir:repository': 'cmrepo1' };
const INPUT: ApplyStackInput = {
  stackName: 'motir-registry-cmrepo1',
  template: 'Resources: {}',
  parameters: { RepositoryId: 'cmrepo1' },
  tags: TAGS,
};

function sdkError(name: string, message = `${name} said something`, status = 400): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
}

const commandName = (command: unknown) =>
  (command as { constructor: { name: string } }).constructor.name;
const inputOf = (command: unknown) => (command as { input: Record<string, unknown> }).input;

const SESSION = { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c', expiration: null };

const instant = () => {
  const clock = { t: 0 };
  return {
    clock,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
    now: () => clock.t,
  };
};

describe('the deploy-role client factory', () => {
  it('runs every tenant call on the deploy-role session, assumed base → management → deploy role', async () => {
    const managementCalls: Array<{ key: string | undefined; command: string; role: string }> = [];
    const managementFactory: AwsManagementClientFactory = (_service, config) => ({
      async send(command) {
        const role = String(inputOf(command)['RoleArn']);
        managementCalls.push({
          key: config.credentials?.accessKeyId,
          command: commandName(command),
          role,
        });
        const id = role.endsWith(`role/${AWS_TENANT_DEPLOY_ROLE}`) ? 'DEPLOY' : 'MGMT';
        return {
          Credentials: {
            AccessKeyId: `ASIA${id}`,
            SecretAccessKey: `secret-${id}`,
            SessionToken: `token-${id}`,
            Expiration: new Date(Date.now() + 3_600_000),
          },
        };
      },
    });
    const management = createAwsManagementApi(MANAGEMENT, { clientFactory: managementFactory });

    const tenantCalls: Array<{ region: string; key: string; command: string }> = [];
    const sdkFactory: TenantSdkClientFactory = (_service, config) => ({
      async send(command) {
        const creds = await config.credentials();
        tenantCalls.push({
          region: config.region,
          key: creds.accessKeyId,
          command: commandName(command),
        });
        return { Stacks: [] };
      },
    });
    const clients = createTenantClients({
      management,
      accountId: ACCOUNT,
      region: 'eu-west-1',
      sdkClientFactory: sdkFactory,
    });
    expect(clients).toMatchObject({ accountId: ACCOUNT, region: 'eu-west-1' });
    await clients.cloudformation.describeStack('motir-network');
    await clients.cloudformation.describeStack('motir-network');

    expect(tenantCalls).toEqual([
      { region: 'eu-west-1', key: 'ASIADEPLOY', command: 'DescribeStacksCommand' },
      { region: 'eu-west-1', key: 'ASIADEPLOY', command: 'DescribeStacksCommand' },
    ]);
    // The base identity only assumes the management role; the management
    // session only assumes the deploy role — once, held for the second call.
    expect(managementCalls).toEqual([
      // The default chain's identity: the client is built with no credentials.
      { key: undefined, command: 'AssumeRoleCommand', role: MANAGEMENT.roleArn },
      {
        key: 'ASIAMGMT',
        command: 'AssumeRoleCommand',
        role: `arn:aws:iam::${ACCOUNT}:role/${AWS_TENANT_DEPLOY_ROLE}`,
      },
    ]);
  });

  it('holds the session in memory and assumes again once it is near expiry', async () => {
    const { clock, now } = instant();
    let assumed = 0;
    const management = {
      async assumeTenantDeployRole(accountId: string) {
        assumed += 1;
        expect(accountId).toBe(ACCOUNT);
        return {
          accessKeyId: `ASIA${assumed}`,
          secretAccessKey: 's',
          sessionToken: 't',
          expiration: new Date(clock.t + 3_600_000),
        };
      },
    };
    const keys: string[] = [];
    const clients = createTenantClients({
      management,
      accountId: ACCOUNT,
      region: 'us-east-1',
      now,
      sdkClientFactory: (_s, config) => ({
        async send() {
          keys.push((await config.credentials()).accessKeyId);
          return { Stacks: [] };
        },
      }),
    });
    await clients.cloudformation.describeStack('motir-a');
    clock.t = 3_600_000 - TENANT_SESSION_RENEW_MS - 1;
    await clients.cloudformation.describeStack('motir-a');
    clock.t = 3_600_000 - TENANT_SESSION_RENEW_MS + 1;
    await clients.cloudformation.describeStack('motir-a');
    expect(keys).toEqual(['ASIA1', 'ASIA1', 'ASIA2']);
  });

  it('reuses a session with no expiry, and names the account — never a key — when the role is refused', async () => {
    let assumed = 0;
    const ok = createTenantClients({
      management: {
        async assumeTenantDeployRole() {
          assumed += 1;
          return { accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: null };
        },
      },
      accountId: ACCOUNT,
      region: 'us-east-1',
      sdkClientFactory: (_s, config) => ({
        async send() {
          await config.credentials();
          return { Stacks: [] };
        },
      }),
    });
    await ok.cloudformation.describeStack('motir-a');
    await ok.cloudformation.describeStack('motir-a');
    expect(assumed).toBe(1);

    const refuse = (err: Error) =>
      createTenantClients({
        management: {
          async assumeTenantDeployRole() {
            throw err;
          },
        },
        accountId: ACCOUNT,
        region: 'us-east-1',
        sdkClientFactory: (_s, config) => ({
          async send() {
            return config.credentials();
          },
        }),
      }).cloudformation.describeStack('motir-a');
    const refused = refuse(new AwsManagementApiError('sts', 'AccessDenied', 403));
    await expect(refused).rejects.toBeInstanceOf(TenantRoleUnavailableError);
    await expect(refused).rejects.toThrow(`tenant account ${ACCOUNT}`);
    await expect(refuse(new Error('network down'))).rejects.toBeInstanceOf(AwsTenantApiError);
  });

  it('builds the real CloudFormation client with the region and a credential provider', () => {
    const client = createTenantSdkClient('cloudformation', {
      region: 'us-east-1',
      credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c' }),
    });
    expect(client.constructor.name).toBe('CloudFormationClient');
    const real = createTenantClients({
      management: { assumeTenantDeployRole: async () => ({ ...SESSION }) },
      accountId: ACCOUNT,
      region: 'us-east-1',
    });
    expect(real.cloudformation.describeStack).toBeTypeOf('function');
  });
});

describe('the CloudFormation client over the SDK', () => {
  function stub(handler: (command: unknown) => unknown) {
    const sent: unknown[] = [];
    const client: AwsSdkClient = {
      async send(command) {
        sent.push(command);
        return handler(command);
      },
    };
    return { cfn: sdkTenantCloudFormation(client), sent };
  }

  it('reads a stack as plain records, and a missing stack as null', async () => {
    const { cfn } = stub((command) => {
      if (inputOf(command)['StackName'] === 'motir-gone') {
        throw sdkError('ValidationError', 'Stack with id motir-gone does not exist');
      }
      return {
        Stacks: [
          {
            StackStatus: 'CREATE_COMPLETE',
            Parameters: [{ ParameterKey: 'A', ParameterValue: '1' }, {}],
            Tags: [{ Key: 'motir:organization', Value: 'o' }, {}],
            Outputs: [{ OutputKey: 'VpcId', OutputValue: 'vpc-1' }, {}],
          },
        ],
      };
    });
    expect(await cfn.describeStack('motir-network')).toEqual({
      name: 'motir-network',
      status: 'CREATE_COMPLETE',
      parameters: { A: '1', '': '' },
      tags: { 'motir:organization': 'o', '': '' },
      outputs: { VpcId: 'vpc-1', '': '' },
    });
    expect(await cfn.describeStack('motir-gone')).toBeNull();

    const empty = stub(() => ({ Stacks: [{}] })).cfn;
    expect(await empty.describeStack('motir-x')).toMatchObject({ status: 'UNKNOWN', outputs: {} });
    expect(await stub(() => ({})).cfn.describeStack('motir-x')).toBeNull();
  });

  it('creates and updates with named-IAM capability, parameters and stack tags', async () => {
    const { cfn, sent } = stub((command) =>
      commandName(command) === 'GetTemplateCommand' ? { TemplateBody: 'body' } : {},
    );
    const write = { name: 'motir-a', templateBody: 'body', parameters: { P: 'v' }, tags: TAGS };
    await cfn.createStack(write);
    expect(await cfn.updateStack(write)).toBe('updating');
    expect(await cfn.getTemplateBody('motir-a')).toBe('body');
    await cfn.deleteStack('motir-a');
    expect(inputOf(sent[0])).toEqual({
      StackName: 'motir-a',
      TemplateBody: 'body',
      Parameters: [{ ParameterKey: 'P', ParameterValue: 'v' }],
      Tags: [
        { Key: 'motir:organization', Value: 'cmorg1' },
        { Key: 'motir:repository', Value: 'cmrepo1' },
      ],
      Capabilities: ['CAPABILITY_NAMED_IAM'],
    });
    expect(inputOf(sent[2])).toEqual({ StackName: 'motir-a', TemplateStage: 'Original' });
    expect(sent.map(commandName)).toEqual([
      'CreateStackCommand',
      'UpdateStackCommand',
      'GetTemplateCommand',
      'DeleteStackCommand',
    ]);
    expect(await stub(() => ({})).cfn.getTemplateBody('motir-a')).toBe('');
  });

  it('reads "No updates" as no change, and every other refusal as a typed error without AWS’s message', async () => {
    const write = { name: 'motir-a', templateBody: 'b', parameters: {}, tags: TAGS };
    const noUpdates = stub(() => {
      throw sdkError('ValidationError', 'No updates are to be performed.');
    }).cfn;
    expect(await noUpdates.updateStack(write)).toBe('no_change');

    const refused = stub(() => {
      throw sdkError('AccessDenied', 'User arn:aws:sts::1:assumed-role/x secret-ish detail', 403);
    }).cfn;
    for (const call of [
      () => refused.describeStack('motir-a'),
      () => refused.updateStack(write),
      () => refused.createStack(write),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AwsTenantApiError);
      expect(err).toMatchObject({
        service: 'cloudformation',
        awsCode: 'AccessDenied',
        status: 403,
      });
      expect((err as Error).message).not.toMatch(/assumed-role|secret/);
    }
  });

  it('classifies an error by its Code, its name, or as unknown', () => {
    expect(tenantApiError('s', { Code: 'Throttling' }).awsCode).toBe('Throttling');
    expect(tenantApiError('s', 'boom')).toMatchObject({ awsCode: 'UnknownError', status: null });
    const typed = new AwsTenantApiError('s', 'X', 500);
    expect(tenantApiError('s', typed)).toBe(typed);
    const role = new TenantRoleUnavailableError(ACCOUNT, 'AccessDenied');
    expect(tenantApiError('s', role)).toBe(role);
  });
});

describe('the stack runner', () => {
  function setup() {
    const t = instant();
    const cfn = createFakeTenantCloudFormation();
    const runner = createStackRunner(cfn, { sleep: t.sleep, now: t.now });
    return { ...t, cfn, runner };
  }

  it.each([
    ['a name outside motir-', { stackName: 'mh-cmrepo1' }, StackNameRefusedError],
    ['no organisation tag', { tags: { 'motir:repository': 'cmrepo1' } }, StackTagsRequiredError],
    ['no repository tag', { tags: { 'motir:organization': 'cmorg1' } }, StackTagsRequiredError],
    [
      'shared on a stack that is not the network',
      { tags: { ...TAGS, 'motir:repository': 'shared' } },
      StackNameRefusedError,
    ],
  ])('refuses %s before any CloudFormation call', async (_label, change, error) => {
    const { cfn, runner } = setup();
    await expect(runner.applyStack({ ...INPUT, ...change })).rejects.toBeInstanceOf(error);
    expect(cfn.calls).toEqual([]);
  });

  it('accepts shared on the account’s network stack', async () => {
    const { runner } = setup();
    const network = {
      ...INPUT,
      stackName: 'motir-network',
      tags: { ...TAGS, 'motir:repository': 'shared' },
    };
    expect((await runner.applyStack(network)).outcome).toBe('created');
  });

  it('creates, then answers no change with no write, then updates a changed parameter', async () => {
    const { cfn, runner } = setup();
    expect(await runner.applyStack(INPUT)).toEqual({
      outcome: 'created',
      outputs: { StackName: INPUT.stackName, RepositoryId: 'cmrepo1' },
    });
    expect(cfn.stacks.get(INPUT.stackName)!.tags).toEqual(TAGS);

    cfn.calls.length = 0;
    expect((await runner.applyStack(INPUT)).outcome).toBe('no_change');
    expect(cfn.calls.filter((c) => /create|update/.test(c))).toEqual([]);

    const changed = { ...INPUT, parameters: { RepositoryId: 'cmrepo1', Extra: 'x' } };
    expect(await runner.applyStack(changed)).toEqual({
      outcome: 'updated',
      outputs: { StackName: INPUT.stackName, RepositoryId: 'cmrepo1', Extra: 'x' },
    });
    expect(cfn.calls.filter((c) => c.startsWith('updateStack'))).toHaveLength(1);
  });

  it('answers no change when CloudFormation finds nothing to update', async () => {
    const { cfn, runner } = setup();
    await runner.applyStack(INPUT);
    // Same stack, but its recorded tags read differently (as a NoEcho value would).
    cfn.stacks.get(INPUT.stackName)!.tags = { ...TAGS, extra: 'x' };
    const fake = cfn.updateStack.bind(cfn);
    cfn.updateStack = async (input) => {
      await fake(input);
      return 'no_change';
    };
    expect((await runner.applyStack(INPUT)).outcome).toBe('no_change');
  });

  it('waits on a stack already in progress instead of creating again', async () => {
    const { cfn, runner } = setup();
    await runner.applyStack(INPUT);
    cfn.setStatus(INPUT.stackName, 'UPDATE_IN_PROGRESS', 3, 'UPDATE_COMPLETE');
    cfn.calls.length = 0;
    expect((await runner.applyStack(INPUT)).outcome).toBe('no_change');
    expect(cfn.calls.filter((c) => c.startsWith('describeStack'))).toHaveLength(4);
    expect(cfn.calls.some((c) => c.startsWith('createStack'))).toBe(false);
  });

  it('deletes and re-creates a failed create once; a second failure is a typed error', async () => {
    const { cfn, runner } = setup();
    cfn.failNextCreate(INPUT.stackName);
    await expect(runner.applyStack(INPUT)).rejects.toMatchObject({ status: 'ROLLBACK_COMPLETE' });
    expect(cfn.stacks.get(INPUT.stackName)!.status).toBe('ROLLBACK_COMPLETE');
    expect((await runner.applyStack(INPUT)).outcome).toBe('created');
    expect(cfn.calls.filter((c) => c.startsWith('deleteStack'))).toHaveLength(1);

    const again = setup();
    again.cfn.failNextCreate(INPUT.stackName);
    await again.runner.applyStack(INPUT).catch(() => undefined);
    again.cfn.failNextCreate(INPUT.stackName);
    await expect(again.runner.applyStack(INPUT)).rejects.toBeInstanceOf(StackFailedError);
  });

  it('refuses any other failed state, naming it', async () => {
    const { cfn, runner } = setup();
    await runner.applyStack(INPUT);
    cfn.setStatus(INPUT.stackName, 'UPDATE_ROLLBACK_FAILED');
    await expect(runner.applyStack(INPUT)).rejects.toThrow(/UPDATE_ROLLBACK_FAILED/);
    cfn.setStatus(INPUT.stackName, 'REVIEW_IN_PROGRESS');
    await expect(runner.applyStack(INPUT)).rejects.toBeInstanceOf(StackFailedError);
  });

  it('refuses an update that rolled back, and a create or update whose stack vanished', async () => {
    const { cfn, runner } = setup();
    await runner.applyStack(INPUT);
    const changed = { ...INPUT, parameters: { RepositoryId: 'other' } };
    const update = cfn.updateStack.bind(cfn);
    cfn.updateStack = async (input) => {
      const answer = await update(input);
      cfn.setStatus(INPUT.stackName, 'UPDATE_ROLLBACK_IN_PROGRESS', 0, 'UPDATE_ROLLBACK_COMPLETE');
      return answer;
    };
    await expect(runner.applyStack(changed)).rejects.toMatchObject({
      status: 'UPDATE_ROLLBACK_COMPLETE',
    });
    cfn.updateStack = async (input) => {
      const answer = await update(input);
      cfn.setStatus(INPUT.stackName, 'DELETE_IN_PROGRESS', 0, 'DELETE_COMPLETE');
      return answer;
    };
    await expect(
      runner.applyStack({ ...changed, parameters: { RepositoryId: 'x' } }),
    ).rejects.toMatchObject({ status: 'DELETE_COMPLETE' });

    const gone = setup();
    const create = gone.cfn.createStack.bind(gone.cfn);
    gone.cfn.createStack = async (input) => {
      await create(input);
      gone.cfn.setStatus(input.name, 'DELETE_IN_PROGRESS', 0, 'DELETE_COMPLETE');
    };
    await expect(gone.runner.applyStack(INPUT)).rejects.toMatchObject({
      status: 'DELETE_COMPLETE',
    });
  });

  it('gives up waiting with a typed timeout', async () => {
    const t = instant();
    const cfn = createFakeTenantCloudFormation();
    const runner = createStackRunner(cfn, { ...t, timeoutMs: 30_000, pollMs: 10_000 });
    await runner.applyStack(INPUT);
    cfn.setStatus(INPUT.stackName, 'UPDATE_IN_PROGRESS', 100, 'UPDATE_COMPLETE');
    await expect(runner.applyStack(INPUT)).rejects.toBeInstanceOf(StackWaitTimeoutError);
  });

  it('deletes a stack and waits for it to go; deleting an absent stack succeeds', async () => {
    const { cfn, runner } = setup();
    await runner.deleteStack(INPUT.stackName);
    await runner.applyStack(INPUT);
    expect(await runner.describeStack(INPUT.stackName)).toEqual({
      status: 'CREATE_COMPLETE',
      parameters: INPUT.parameters,
      outputs: { StackName: INPUT.stackName, RepositoryId: 'cmrepo1' },
      createdAt: expect.any(Date),
    });
    await runner.deleteStack(INPUT.stackName);
    expect(cfn.stacks.has(INPUT.stackName)).toBe(false);
    expect(await runner.describeStack(INPUT.stackName)).toBeNull();

    await runner.applyStack(INPUT);
    const del = cfn.deleteStack.bind(cfn);
    cfn.deleteStack = async (name) => {
      await del(name);
      cfn.setStatus(name, 'DELETE_FAILED');
    };
    await expect(runner.deleteStack(INPUT.stackName)).rejects.toMatchObject({
      status: 'DELETE_FAILED',
    });
    cfn.setStatus(INPUT.stackName, 'DELETE_COMPLETE');
    expect(await runner.describeStack(INPUT.stackName)).toBeNull();
  });

  it('uses real timers by default', async () => {
    const cfn = createFakeTenantCloudFormation();
    expect((await createStackRunner(cfn, { pollMs: 1 }).applyStack(INPUT)).outcome).toBe('created');
  });
});

describe('cut off at every call, then replayed', () => {
  const CHANGED = { ...INPUT, parameters: { RepositoryId: 'cmrepo1', Size: 'large' } };

  async function scenario(kind: 'create' | 'update') {
    const t = instant();
    const cfn = createFakeTenantCloudFormation();
    const runner = createStackRunner(cfn, t);
    if (kind === 'update') await runner.applyStack(INPUT);
    cfn.calls.length = 0;
    return { cfn, runner, input: kind === 'update' ? CHANGED : INPUT };
  }

  it.each(['create', 'update'] as const)(
    'a %s ends with one stack and the same outputs',
    async (kind) => {
      const clean = await scenario(kind);
      const expected = await clean.runner.applyStack(clean.input);
      const operations = new Map<FakeCloudFormationOperation, number>();
      for (const call of clean.cfn.calls) {
        const op = call.split(':')[0] as FakeCloudFormationOperation;
        operations.set(op, (operations.get(op) ?? 0) + 1);
      }
      expect([...operations.keys()]).toContain(kind === 'create' ? 'createStack' : 'updateStack');

      let cuts = 0;
      for (const [operation, count] of operations) {
        for (let n = 1; n <= count; n += 1) {
          for (const when of ['before', 'after'] as const) {
            const run = await scenario(kind);
            run.cfn.failAt(operation, n, when);
            await expect(run.runner.applyStack(run.input)).rejects.toBeInstanceOf(
              AwsTenantApiError,
            );
            cuts += 1;
            const replay = await run.runner.applyStack(run.input);
            expect(replay.outputs, `${operation}#${n} ${when}`).toEqual(expected.outputs);
            expect([...run.cfn.stacks.keys()]).toEqual([INPUT.stackName]);
            expect(run.cfn.stacks.get(INPUT.stackName)!.status).toMatch(/_COMPLETE$/);
            expect(
              run.cfn.calls.filter((c) => c.startsWith('createStack')).length,
            ).toBeLessThanOrEqual(kind === 'create' ? 2 : 0);
          }
        }
      }
      expect(cuts).toBeGreaterThan(4);
    },
  );
});

describe('the fake tenant account', () => {
  it('bundles the clients and refuses what CloudFormation refuses', async () => {
    const clients = createFakeTenantClients({ accountId: '1', region: 'eu-west-1' });
    expect(clients).toMatchObject({ accountId: '1', region: 'eu-west-1' });
    expect(createFakeTenantClients().accountId).toBe('210987654321');
    const cfn = clients.cloudformation;
    const write = { name: 'motir-a', templateBody: 'b', parameters: {}, tags: TAGS };
    await expect(cfn.getTemplateBody('motir-a')).rejects.toBeInstanceOf(AwsTenantApiError);
    await expect(cfn.updateStack(write)).rejects.toBeInstanceOf(AwsTenantApiError);
    expect(() => cfn.setStatus('motir-a', 'CREATE_COMPLETE')).toThrow(AwsTenantApiError);
    await cfn.createStack(write);
    await expect(cfn.createStack(write)).rejects.toMatchObject({
      awsCode: 'AlreadyExistsException',
    });
    await expect(cfn.updateStack(write)).rejects.toMatchObject({
      awsCode: 'ValidationError:InProgress',
    });
    // A delete while in progress does nothing.
    await cfn.deleteStack('motir-a');
    expect(cfn.stacks.get('motir-a')!.status).toBe('CREATE_IN_PROGRESS');
    await cfn.describeStack('motir-a');
    await cfn.describeStack('motir-a');
    expect(await cfn.updateStack(write)).toBe('no_change');
    cfn.failAt('getTemplateBody', 1, 'after');
    await expect(cfn.getTemplateBody('motir-a')).rejects.toMatchObject({
      awsCode: 'InjectedFault',
    });
  });

  it('takes the outputs a test gives it', async () => {
    const cfn = createFakeTenantCloudFormation({ outputs: (name) => ({ Name: name }) });
    cfn.pollsToSettle = 0;
    await createStackRunner(cfn).applyStack(INPUT);
    expect(cfn.stacks.get(INPUT.stackName)!.outputs).toEqual({ Name: INPUT.stackName });
  });
});

describe('the seam’s SDK boundary', () => {
  const DIR = join(__dirname, '..', 'src', 'adapters', 'aws', 'tenant');
  const SDK_IMPORT = /import\s*\{([^}]*)\}\s*from\s*'@aws-sdk\/[^']+'/g;

  it('imports the SDK in sdk.ts only, and exports no SDK name from it or the entry', () => {
    const files = readdirSync(DIR, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => relative(DIR, join(e.parentPath, e.name)));
    expect(files.length).toBeGreaterThan(8);
    const importers = files.filter((f) => /@aws-sdk\//.test(readFileSync(join(DIR, f), 'utf8')));
    expect(importers).toEqual(['sdk.ts']);

    const sdk = readFileSync(join(DIR, 'sdk.ts'), 'utf8');
    const sdkNames = [...sdk.matchAll(SDK_IMPORT)]
      .flatMap((m) => m[1]!.split(','))
      .map((n) => n.replace(/^\s*type\s+/, '').trim())
      .filter(Boolean);
    expect(sdkNames).toContain('Stack');
    // No exported declaration's own line names an SDK type or class.
    const exported = sdk.split('\n').filter((l) => l.startsWith('export'));
    for (const line of exported) {
      for (const name of sdkNames) expect(line, line).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    const entry = readFileSync(join(DIR, 'index.ts'), 'utf8');
    expect(entry).not.toMatch(/export \* from '\.\/sdk'/);
  });
});

describe('the runtime reads over the SDK (MOTIR-12104)', () => {
  function stub(handlers: Record<string, (input: Record<string, unknown>) => unknown>) {
    const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
    const client: AwsSdkClient = {
      async send(command) {
        const name = commandName(command);
        sent.push({ command: name, input: inputOf(command) });
        const handler = handlers[name];
        if (!handler) throw sdkError('UnrecognizedClientException');
        return handler(inputOf(command));
      },
    };
    return { client, sent };
  }

  it('builds the CloudWatch Logs client, and the bundle carries it', () => {
    const client = createTenantSdkClient('logs', {
      region: 'us-east-1',
      credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c' }),
    });
    expect(client.constructor.name).toBe('CloudWatchLogsClient');
    const real = createTenantClients({
      management: { assumeTenantDeployRole: async () => ({ ...SESSION }) },
      accountId: ACCOUNT,
      region: 'us-east-1',
    });
    expect(real.logs.filterLogEvents).toBeTypeOf('function');
  });

  it('reads a FilterLogEvents page as plain events, a missing group as null, a refusal by code', async () => {
    const { client, sent } = stub({
      FilterLogEventsCommand: (i) => {
        if (i['logGroupName'] === 'gone') throw sdkError('ResourceNotFoundException');
        if (i['logGroupName'] === 'denied') {
          throw sdkError('AccessDeniedException', 'arn:aws:logs:secret detail', 403);
        }
        if (i['logGroupName'] === 'empty') return { nextToken: '' };
        return {
          events: [
            { eventId: 'e1', timestamp: 5, message: 'one\n', logStreamName: 'app/app/t1' },
            { timestamp: 6, logStreamName: 's' },
            { timestamp: Number.NaN, message: 'no instant' },
            { message: 'no timestamp' },
          ],
          nextToken: 'n2',
        };
      },
    });
    const logs = sdkTenantLogs(client);
    expect(
      await logs.filterLogEvents('/motir/hosting/mh-a', {
        startMs: 1,
        endMs: 9,
        filterPattern: '%[eE]%',
        nextToken: 'n1',
      }),
    ).toEqual({
      events: [
        { eventId: 'e1', timestamp: 5, message: 'one\n' },
        { eventId: 's:6:', timestamp: 6, message: '' },
      ],
      nextToken: 'n2',
    });
    expect(sent[0]!.input).toEqual({
      logGroupName: '/motir/hosting/mh-a',
      startTime: 1,
      endTime: 9,
      filterPattern: '%[eE]%',
      nextToken: 'n1',
    });
    expect(await logs.filterLogEvents('empty', { startMs: 1, endMs: 2 })).toEqual({
      events: [],
      nextToken: null,
    });
    expect(sent[1]!.input).toEqual({ logGroupName: 'empty', startTime: 1, endTime: 2 });
    expect(await logs.filterLogEvents('gone', { startMs: 1, endMs: 2 })).toBeNull();
    const denied = await logs.filterLogEvents('denied', { startMs: 1, endMs: 2 }).catch((e) => e);
    expect(denied).toBeInstanceOf(AwsTenantApiError);
    expect(denied).toMatchObject({ service: 'logs', awsCode: 'AccessDeniedException' });
    expect(String((denied as Error).message)).not.toContain('secret detail');
  });

  it('reads a version’s state, last update and change time, and the alias’s provisioned concurrency', async () => {
    const { client } = stub({
      GetFunctionConfigurationCommand: (i) => {
        if (i['Qualifier'] === '9') throw sdkError('ResourceNotFoundException');
        if (i['Qualifier'] === '8') throw sdkError('ServiceException', 'x', 500);
        if (i['Qualifier'] === '7') return {};
        if (i['Qualifier'] === '6') return { State: 'Active', LastModified: 'yesterday' };
        return {
          State: 'Failed',
          LastUpdateStatus: 'Failed',
          LastModified: '2026-11-23T10:00:00.000+0000',
        };
      },
      GetProvisionedConcurrencyConfigCommand: (i) => {
        if (i['FunctionName'] === 'none')
          throw sdkError('ProvisionedConcurrencyConfigNotFoundException');
        if (i['FunctionName'] === 'gone') throw sdkError('ResourceNotFoundException');
        if (i['FunctionName'] === 'denied') throw sdkError('AccessDeniedException', 'x', 403);
        if (i['FunctionName'] === 'bare') return {};
        return { Status: 'READY' };
      },
    });
    const lambda = sdkTenantLambda(client);
    expect(await lambda.getFunctionVersion('f', '1')).toEqual({
      state: 'failed',
      lastUpdateStatus: 'failed',
      lastModified: new Date('2026-11-23T10:00:00.000Z'),
    });
    expect(await lambda.getFunctionVersion('f', '7')).toEqual({
      state: 'pending',
      lastUpdateStatus: null,
      lastModified: null,
    });
    expect((await lambda.getFunctionVersion('f', '6'))!.lastModified).toBeNull();
    expect(await lambda.getFunctionVersion('f', '9')).toBeNull();
    await expect(lambda.getFunctionVersion('f', '8')).rejects.toMatchObject({
      awsCode: 'ServiceException',
    });
    expect(await lambda.getProvisionedConcurrency('f', 'live')).toBe('READY');
    expect(await lambda.getProvisionedConcurrency('bare', 'live')).toBe('IN_PROGRESS');
    expect(await lambda.getProvisionedConcurrency('none', 'live')).toBeNull();
    expect(await lambda.getProvisionedConcurrency('gone', 'live')).toBeNull();
    await expect(lambda.getProvisionedConcurrency('denied', 'live')).rejects.toMatchObject({
      service: 'lambda',
      awsCode: 'AccessDeniedException',
    });
  });

  it('reads a stopped task’s exit from its only container when none is named app', async () => {
    const { client } = stub({
      ListTasksCommand: (i) => (i['desiredStatus'] === 'STOPPED' ? { taskArns: ['t1', 't2'] } : {}),
      DescribeTasksCommand: () => ({
        tasks: [
          { taskArn: 't1', lastStatus: 'STOPPED', containers: [{ name: 'web', exitCode: 3 }] },
          { taskArn: 't2', lastStatus: 'STOPPED', containers: [{ name: 'web' }] },
        ],
      }),
    });
    const tasks = await sdkTenantEcs(client).listTasks('c', 's');
    expect(tasks.map((t) => t.container)).toEqual([{ exitCode: 3, reason: null }, null]);
  });
});

describe('the fake CloudWatch Logs (MOTIR-12104)', () => {
  it('matches the patterns the adapter sends as CloudWatch does: a regex, alternatives, a term', () => {
    expect(fakeFilterPatternMatches('%[eE][rR]%', 'An ERror')).toBe(true);
    expect(fakeFilterPatternMatches('%[eE][rR]%', 'none')).toBe(false);
    expect(fakeFilterPatternMatches('?REPORT ?"Runtime exited"', 'x Runtime exited y')).toBe(true);
    expect(fakeFilterPatternMatches('?REPORT ?"Runtime exited"', 'report')).toBe(false);
    expect(fakeFilterPatternMatches('REPORT', 'REPORT RequestId: r')).toBe(true);
    expect(fakeFilterPatternMatches('"a b"', 'x a b')).toBe(true);
  });

  it('pages a group forward, answers a missing group as null, and refuses or fails on demand', async () => {
    const logs = createFakeTenantLogs();
    logs.pageSize = 2;
    for (let i = 0; i < 3; i += 1) logs.write('g', new Date(100 + i), `line ${i}`);
    logs.write('g', 200, 'outside');
    const first = await logs.filterLogEvents('g', { startMs: 100, endMs: 150 });
    expect(first!.events.map((e) => e.message)).toEqual(['line 0', 'line 1']);
    const second = await logs.filterLogEvents('g', {
      startMs: 100,
      endMs: 150,
      nextToken: first!.nextToken!,
    });
    expect(second).toEqual({
      events: [{ eventId: 'e000003', timestamp: 102, message: 'line 2' }],
      nextToken: null,
    });
    expect(await logs.filterLogEvents('nope', { startMs: 0, endMs: 1 })).toBeNull();
    expect(logs.queries.map((q) => q.group)).toEqual(['g', 'g', 'nope']);

    logs.refuseNext('ThrottlingException', 400);
    await expect(logs.filterLogEvents('g', { startMs: 0, endMs: 1 })).rejects.toMatchObject({
      service: 'logs',
      awsCode: 'ThrottlingException',
    });
    logs.failAt('filterLogEvents', 1, 'after');
    await expect(logs.filterLogEvents('g', { startMs: 0, endMs: 1 })).rejects.toMatchObject({
      awsCode: 'InjectedFault',
    });
    expect(await logs.filterLogEvents('g', { startMs: 0, endMs: 1 })).toEqual({
      events: [],
      nextToken: null,
    });
  });
});
