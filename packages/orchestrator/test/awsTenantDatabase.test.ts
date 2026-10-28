import { describe, expect, it, vi } from 'vitest';
import {
  AwsTenantApiError,
  ConnectionSecretUnreadableError,
  DATABASE_URL_VARIABLE,
  DatabaseNameInvalidError,
  DatabaseResumeTimeoutError,
  DatabaseStatementError,
  TenantStackOutputMissingError,
  buildDatabaseUrl,
  createFakeTenantClients,
  createFakeTenantRdsData,
  createSqlRunner,
  createStackRunner,
  databaseStackName,
  destroyApplicationDatabase,
  dropPreviewDatabase,
  ensureApplicationDatabase,
  ensureEnvironmentDatabase,
  ensureTenantNetwork,
  environmentDatabaseNames,
  readGeneratedPassword,
  readTenantStackTemplate,
  sdkTenantRdsData,
  sdkTenantSecretsManager,
  stackOutput,
  writeDatabaseUrl,
  type AwsSdkClient,
  type HostingEnvironment,
  type TenantAccountContext,
} from '../src/index';

// The tenant network and the Aurora database (MOTIR-10007), against the seam's
// fakes: CloudFormation, the RDS Data API and Secrets Manager in memory, each
// able to fail at the Nth call.

const ORG = 'cmorg1';
const RID = 'cmrepo1';
const PRODUCTION: HostingEnvironment = { kind: 'production' };
const PREVIEW: HostingEnvironment = { kind: 'preview', pullRequest: 7 };
const noSleep = async () => undefined;

function account() {
  const clients = createFakeTenantClients();
  clients.cloudformation.pollsToSettle = 0;
  const runner = createStackRunner(clients.cloudformation, { sleep: noSleep });
  const context: TenantAccountContext = { organizationId: ORG, clients, runner };
  return { context, ...clients };
}

const secretJson = (a: ReturnType<typeof account>, arn: string) =>
  JSON.parse(a.secretsManager.values.get(arn)!) as { password: string; url?: string };

describe('ensureTenantNetwork', () => {
  it('applies motir-network once, shared, and returns its outputs as plain values', async () => {
    const a = account();
    const network = await ensureTenantNetwork(a.context);
    expect(network).toEqual({
      vpcId: 'vpc-fake',
      privateSubnetIds: ['subnet-private-a', 'subnet-private-b'],
      publicSubnetIds: ['subnet-public-a', 'subnet-public-b'],
      databaseSecurityGroupId: 'sg-database',
      appSecurityGroupId: 'sg-app',
      albArn: expect.stringContaining('loadbalancer/app/motir-tenant'),
      albListenerArn: expect.stringContaining('listener/app/motir-tenant'),
      albDnsName: expect.stringContaining('.elb.amazonaws.com'),
    });
    const stack = a.cloudformation.stacks.get('motir-network')!;
    expect(stack.tags).toEqual({ 'motir:organization': ORG, 'motir:repository': 'shared' });
    expect(stack.templateBody).toBe(readTenantStackTemplate('network.yaml'));

    a.cloudformation.calls.length = 0;
    await ensureApplicationDatabase(a.context, { repositoryId: RID });
    await ensureApplicationDatabase(a.context, { repositoryId: 'cmrepo2' });
    await ensureTenantNetwork(a.context);
    expect(
      a.cloudformation.calls.filter((c) => /(create|update)Stack:motir-network/.test(c)),
    ).toEqual([]);
  });

  it('replayed after a cut-off at each call, ends with one network stack', async () => {
    for (const operation of ['describeStack', 'createStack', 'getTemplateBody'] as const) {
      for (const when of ['before', 'after'] as const) {
        const a = account();
        if (operation === 'getTemplateBody') await ensureTenantNetwork(a.context);
        a.cloudformation.failAt(operation, 1, when);
        await ensureTenantNetwork(a.context).catch(() => undefined);
        await ensureTenantNetwork(a.context);
        expect([...a.cloudformation.stacks.keys()]).toEqual(['motir-network']);
      }
    }
  });

  it('names a missing output', () => {
    expect(() => stackOutput('motir-network', {}, 'VpcId')).toThrow(TenantStackOutputMissingError);
  });
});

describe('ensureApplicationDatabase', () => {
  it('ensures the network first, then applies database.yaml with its outputs as parameters', async () => {
    const a = account();
    const app = await ensureApplicationDatabase(a.context, { repositoryId: RID });
    expect(a.cloudformation.calls.find((c) => c.startsWith('createStack'))).toBe(
      'createStack:motir-network',
    );
    const stack = a.cloudformation.stacks.get('motir-database-cmrepo1')!;
    expect(stack.tags).toEqual({ 'motir:organization': ORG, 'motir:repository': RID });
    expect(stack.parameters).toEqual({
      OrganizationId: ORG,
      RepositoryId: RID,
      PrivateSubnetIds: 'subnet-private-a,subnet-private-b',
      DatabaseSecurityGroupId: 'sg-database',
    });
    expect(app).toMatchObject({
      stackName: 'motir-database-cmrepo1',
      databaseName: 'app',
      endpoint: expect.stringContaining('rds.amazonaws.com'),
      masterSecretArn: expect.stringContaining('database-master'),
      productionSecretArn: expect.stringContaining('production/database'),
    });
    a.cloudformation.calls.length = 0;
    await ensureApplicationDatabase(a.context, { repositoryId: RID });
    expect(a.cloudformation.calls.filter((c) => /create|update/.test(c))).toEqual([]);
  });
});

describe('ensureEnvironmentDatabase', () => {
  it('gives production and a preview a distinct database and role, each URL only in its secret', async () => {
    const a = account();
    const prod = await ensureEnvironmentDatabase(a.context, {
      repositoryId: RID,
      environment: PRODUCTION,
    });
    const pr = await ensureEnvironmentDatabase(a.context, {
      repositoryId: RID,
      environment: PREVIEW,
    });
    expect(prod).toEqual({ secretArn: expect.any(String), variable: DATABASE_URL_VARIABLE });
    expect(Object.keys(pr)).toEqual(['secretArn', 'variable']);
    expect(pr.secretArn).not.toBe(prod.secretArn);

    expect(a.rdsData.databases.get('app')).toEqual({ owner: 'app_cmrepo1' });
    expect(a.rdsData.databases.get('app_pr7')).toEqual({ owner: 'app_cmrepo1_pr7' });
    const endpoint = 'motir-cmrepo1.cluster-fake.us-east-1.rds.amazonaws.com';
    for (const [ref, role, db] of [
      [prod, 'app_cmrepo1', 'app'],
      [pr, 'app_cmrepo1_pr7', 'app_pr7'],
    ] as const) {
      const value = secretJson(a, ref.secretArn);
      expect(value.url).toBe(
        `postgres://${role}:${value.password}@${endpoint}:5432/${db}?sslmode=require`,
      );
      // The role accepts the password the secret holds.
      expect(a.rdsData.roles.get(role)!.password).toBe(value.password);
    }
    // The secrets are stacks' resources: the module only reads and puts values.
    expect(new Set(a.secretsManager.calls.map((c) => c.split(':')[0]))).toEqual(
      new Set(['getSecretValue', 'putSecretValue']),
    );
    expect(a.cloudformation.stacks.has('motir-database-cmrepo1-pr7')).toBe(true);
  });

  it('a repeat writes nothing new, and a preview re-created gets a differently named secret', async () => {
    const a = account();
    const first = await ensureEnvironmentDatabase(a.context, {
      repositoryId: RID,
      environment: PREVIEW,
    });
    const puts = a.secretsManager.calls.filter((c) => c.startsWith('put')).length;
    expect(
      await ensureEnvironmentDatabase(a.context, { repositoryId: RID, environment: PREVIEW }),
    ).toEqual(first);
    expect(a.secretsManager.calls.filter((c) => c.startsWith('put')).length).toBe(puts);

    await dropPreviewDatabase(a.context, { repositoryId: RID, pullRequest: 7 });
    const again = await ensureEnvironmentDatabase(a.context, {
      repositoryId: RID,
      environment: PREVIEW,
    });
    expect(again.secretArn).not.toBe(first.secretArn);
  });

  it('never puts the URL or the password in a returned value or an error', async () => {
    const a = account();
    const seen: string[] = [];
    seen.push(
      JSON.stringify(
        await ensureEnvironmentDatabase(a.context, { repositoryId: RID, environment: PREVIEW }),
      ),
    );
    a.rdsData.failAt('executeStatement', 1);
    await ensureEnvironmentDatabase(a.context, {
      repositoryId: RID,
      environment: PRODUCTION,
    }).catch((e: Error) => seen.push(e.message));
    a.secretsManager.failAt('putSecretValue', 1);
    await ensureEnvironmentDatabase(a.context, {
      repositoryId: RID,
      environment: PRODUCTION,
    }).catch((e: Error) => seen.push(e.message));
    expect(seen).toHaveLength(3);
    const secretsSeen = [...a.secretsManager.values.values()].flatMap((v) => {
      const { password, url } = JSON.parse(v) as { password: string; url?: string };
      return url ? [password, url] : [password];
    });
    expect(secretsSeen.length).toBeGreaterThan(2);
    for (const text of seen) for (const secret of secretsSeen) expect(text).not.toContain(secret);
  });

  it('cut off at every CloudFormation, Secrets Manager and Data API call, then replayed, ends in one of each', async () => {
    const clean = account();
    const reference = await ensureEnvironmentDatabase(clean.context, {
      repositoryId: RID,
      environment: PREVIEW,
    });
    const plan: Array<[string, number]> = [
      ...countBy(clean.cloudformation.calls).map(([op, n]) => [`cfn:${op}`, n] as [string, number]),
      ...countBy(clean.secretsManager.calls).map(([op, n]) => [`sm:${op}`, n] as [string, number]),
      ['rds:executeStatement', clean.rdsData.statements.length],
    ];
    let cuts = 0;
    for (const [target, count] of plan) {
      for (let n = 1; n <= count; n += 1) {
        for (const when of ['before', 'after'] as const) {
          const a = account();
          const [service, operation] = target.split(':') as [string, string];
          if (service === 'cfn') a.cloudformation.failAt(operation as 'createStack', n, when);
          if (service === 'sm') a.secretsManager.failAt(operation as 'getSecretValue', n, when);
          if (service === 'rds') a.rdsData.failAt('executeStatement', n, when);
          const input = { repositoryId: RID, environment: PREVIEW };
          await ensureEnvironmentDatabase(a.context, input).catch(() => undefined);
          const replay = await ensureEnvironmentDatabase(a.context, input);
          cuts += 1;
          expect(replay.secretArn.replace(/-g\d+$/, ''), `${target}#${n} ${when}`).toBe(
            reference.secretArn.replace(/-g\d+$/, ''),
          );
          expect([...a.rdsData.roles.keys()]).toEqual(['app_cmrepo1_pr7']);
          expect([...a.rdsData.databases.keys()].sort()).toEqual(['app', 'app_pr7']);
          const value = secretJson(a, replay.secretArn);
          expect(a.rdsData.roles.get('app_cmrepo1_pr7')!.password).toBe(value.password);
          expect(value.url).toContain(value.password);
          expect(
            [...a.cloudformation.stacks.keys()].filter((k) => k.endsWith('-pr7')),
          ).toHaveLength(1);
        }
      }
    }
    expect(cuts).toBeGreaterThan(20);
  });

  it('retries a resuming cluster with backoff, then gives up with a typed timeout', async () => {
    const a = account();
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    a.rdsData.resumingFor(3);
    await ensureEnvironmentDatabase(
      a.context,
      { repositoryId: RID, environment: PRODUCTION },
      { sleep },
    );
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);

    a.rdsData.resumingFor(1_000);
    const err = await ensureEnvironmentDatabase(
      a.context,
      { repositoryId: RID, environment: PRODUCTION },
      { sleep },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseResumeTimeoutError);
  });

  it('surfaces an unrelated Data API error as a typed error with no statement text', async () => {
    const a = account();
    const original = a.rdsData.executeStatement.bind(a.rdsData);
    a.rdsData.executeStatement = async (statement) => {
      if (statement.sql.startsWith('CREATE ROLE')) throw new Error('boom: ' + statement.sql);
      return original(statement);
    };
    const err = await ensureEnvironmentDatabase(a.context, {
      repositoryId: RID,
      environment: PREVIEW,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseStatementError);
    expect(err).toMatchObject({ operation: 'create role', awsCode: 'UnknownError' });
    expect((err as Error).message).not.toMatch(/PASSWORD|CREATE/);
  });
});

describe('the SQL runner', () => {
  it('waits on real timers by default while the cluster resumes', async () => {
    vi.useFakeTimers();
    try {
      const rds = createFakeTenantRdsData();
      rds.resumingFor(1);
      const sql = createSqlRunner(rds, { clusterArn: 'c', masterSecretArn: 's', database: 'app' });
      const rows = sql.run('find role', 'SELECT 1 FROM pg_roles WHERE rolname = :name', {
        name: 'x',
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await rows).toEqual([]);
      await expect(sql.run('bad', 'VACUUM')).rejects.toMatchObject({
        awsCode: 'UnsupportedStatement',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dropPreviewDatabase and destroyApplicationDatabase', () => {
  it('drops the preview’s database WITH (FORCE) and its role, deletes its stack, and leaves production', async () => {
    const a = account();
    await ensureEnvironmentDatabase(a.context, { repositoryId: RID, environment: PRODUCTION });
    await ensureEnvironmentDatabase(a.context, { repositoryId: RID, environment: PREVIEW });
    await dropPreviewDatabase(a.context, { repositoryId: RID, pullRequest: 7 });
    expect(a.rdsData.statements.map((s) => s.sql)).toContain(
      'DROP DATABASE IF EXISTS "app_pr7" WITH (FORCE)',
    );
    expect(a.rdsData.databases.has('app_pr7')).toBe(false);
    expect(a.rdsData.roles.has('app_cmrepo1_pr7')).toBe(false);
    expect(a.rdsData.roles.has('app_cmrepo1')).toBe(true);
    expect(a.cloudformation.stacks.has('motir-database-cmrepo1-pr7')).toBe(false);
    // Already gone: still fine.
    await dropPreviewDatabase(a.context, { repositoryId: RID, pullRequest: 7 });

    await destroyApplicationDatabase(a.context, { repositoryId: RID });
    await destroyApplicationDatabase(a.context, { repositoryId: RID });
    expect(a.cloudformation.stacks.has('motir-database-cmrepo1')).toBe(false);
    expect(a.cloudformation.stacks.has('motir-network')).toBe(true);
    // With no application stack, a drop has no SQL to run.
    const before = a.rdsData.statements.length;
    await dropPreviewDatabase(a.context, { repositoryId: RID, pullRequest: 9 });
    expect(a.rdsData.statements.length).toBe(before);
  });

  it('a drop cut off at each call and replayed ends with the preview gone', async () => {
    for (const target of ['executeStatement', 'deleteStack'] as const) {
      for (const n of [1, 2]) {
        const a = account();
        await ensureEnvironmentDatabase(a.context, { repositoryId: RID, environment: PREVIEW });
        if (target === 'executeStatement') a.rdsData.failAt(target, n, 'after');
        else a.cloudformation.failAt(target, n, 'before');
        await dropPreviewDatabase(a.context, { repositoryId: RID, pullRequest: 7 }).catch(
          () => undefined,
        );
        await dropPreviewDatabase(a.context, { repositoryId: RID, pullRequest: 7 });
        expect(a.rdsData.databases.has('app_pr7')).toBe(false);
        expect(a.cloudformation.stacks.has('motir-database-cmrepo1-pr7')).toBe(false);
      }
    }
  });
});

describe('database names', () => {
  it('are deterministic, distinct and within 63 characters', () => {
    expect(databaseStackName(RID)).toBe('motir-database-cmrepo1');
    const longest = environmentDatabaseNames('c'.repeat(40), {
      kind: 'preview',
      pullRequest: 999_999_999,
    });
    expect(longest.role.length).toBeLessThanOrEqual(63);
    expect(environmentDatabaseNames(RID, PRODUCTION)).toEqual({
      role: 'app_cmrepo1',
      database: 'app',
      previewStackName: null,
    });
  });

  it.each(['cm"; DROP TABLE x; --', "cm'repo", 'CmRepo', 'c'.repeat(41), ''])(
    'refuses the repository id %j',
    (bad) => {
      expect(() => environmentDatabaseNames(bad, PREVIEW)).toThrow(DatabaseNameInvalidError);
      expect(() => databaseStackName(bad)).toThrow(DatabaseNameInvalidError);
    },
  );

  it.each([0, -1, 1.5, 1_000_000_000])('refuses the pull request %s', (pullRequest) => {
    expect(() => environmentDatabaseNames(RID, { kind: 'preview', pullRequest })).toThrow(
      DatabaseNameInvalidError,
    );
  });
});

describe('the connection secret', () => {
  it('refuses a value that is not the generated JSON', async () => {
    const a = account();
    const arn = 'arn:aws:secretsmanager:us-east-1:1:secret:x';
    for (const value of ['not json', '[1]', '{"password":"short"}', 'null']) {
      a.secretsManager.values.set(arn, value);
      await expect(readGeneratedPassword(a.secretsManager, arn)).rejects.toBeInstanceOf(
        ConnectionSecretUnreadableError,
      );
    }
    await expect(readGeneratedPassword(a.secretsManager, 'not-an-arn')).rejects.toMatchObject({
      awsCode: 'GetSecretValue:ResourceNotFoundException',
    });
    const failing = {
      getSecretValue: async () => {
        throw new Error('down');
      },
      putSecretValue: async () => undefined,
    };
    await expect(writeDatabaseUrl(failing, arn, 'u')).rejects.toMatchObject({
      awsCode: 'GetSecretValue:UnknownError',
    });
    expect(buildDatabaseUrl({ role: 'r', password: 'p', endpoint: 'h', database: 'd' })).toBe(
      'postgres://r:p@h:5432/d?sslmode=require',
    );
  });
});

describe('the Data API and Secrets Manager over the SDK', () => {
  const stub = (handler: (command: unknown) => unknown): AwsSdkClient => ({
    async send(command) {
      return handler(command);
    },
  });
  const inputOf = (command: unknown) => (command as { input: Record<string, unknown> }).input;

  it('sends a statement with string parameters and reads every field type', async () => {
    let sent: Record<string, unknown> = {};
    const rds = sdkTenantRdsData(
      stub((command) => {
        sent = inputOf(command);
        return {
          records: [
            [
              { stringValue: 's' },
              { longValue: 1 },
              { doubleValue: 1.5 },
              { booleanValue: true },
              { isNull: true },
              {},
            ],
          ],
        };
      }),
    );
    const rows = await rds.executeStatement({
      resourceArn: 'c',
      secretArn: 's',
      database: 'app',
      sql: 'SELECT 1 FROM pg_roles WHERE rolname = :name',
      parameters: { name: 'r' },
    });
    expect(rows).toEqual([['s', 1, 1.5, true, null, null]]);
    expect(sent).toMatchObject({
      resourceArn: 'c',
      secretArn: 's',
      database: 'app',
      parameters: [{ name: 'name', value: { stringValue: 'r' } }],
    });
    expect(await sdkTenantRdsData(stub(() => ({}))).executeStatement({ ...sentShape() })).toEqual(
      [],
    );
    await expect(
      sdkTenantRdsData(
        stub(() => {
          throw Object.assign(new Error('x'), { name: 'DatabaseResumingException' });
        }),
      ).executeStatement(sentShape()),
    ).rejects.toMatchObject({ service: 'rds-data', awsCode: 'DatabaseResumingException' });
  });

  it('gets and puts a secret value, and names AWS’s code on a refusal', async () => {
    const calls: unknown[] = [];
    const sm = sdkTenantSecretsManager(
      stub((command) => {
        calls.push(inputOf(command));
        return { SecretString: '{"password":"x"}' };
      }),
    );
    expect(await sm.getSecretValue('arn')).toBe('{"password":"x"}');
    await sm.putSecretValue('arn', 'v');
    expect(calls).toEqual([{ SecretId: 'arn' }, { SecretId: 'arn', SecretString: 'v' }]);
    expect(await sdkTenantSecretsManager(stub(() => ({}))).getSecretValue('a')).toBe('');
    const refusing = sdkTenantSecretsManager(
      stub(() => {
        throw Object.assign(new Error('x'), { name: 'AccessDeniedException' });
      }),
    );
    await expect(refusing.getSecretValue('a')).rejects.toBeInstanceOf(AwsTenantApiError);
    await expect(refusing.putSecretValue('a', 'v')).rejects.toMatchObject({
      awsCode: 'AccessDeniedException',
    });
  });
});

function sentShape() {
  return { resourceArn: 'c', secretArn: 's', database: 'app', sql: 'SELECT 1' };
}

function countBy(calls: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const op = call.split(':')[0]!;
    counts.set(op, (counts.get(op) ?? 0) + 1);
  }
  return [...counts];
}
