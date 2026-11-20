import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AwsPolicyDocument } from '../src/adapters/aws/management';
import {
  createServerlessAwsApi,
  type ServerlessSdkClientFactory,
} from '../src/adapters/serverless/client';
import { execRoleArn, SERVERLESS_EXEC_ROLE } from '../src/adapters/serverless/names';
import { serverlessRegistryLogin } from '../src/adapters/serverless/registry';
import {
  SERVERLESS_DEPLOY_POLICY,
  SERVERLESS_DEPLOY_ROLE,
  SERVERLESS_EXEC_POLICY,
  SERVERLESS_EXEC_TRUST_POLICY,
  serverlessDeployPolicy,
  serverlessDeployTrustPolicy,
  serverlessExecPolicy,
  serverlessRoleDefinitions,
} from '../src/adapters/serverless/roles';
import { ServerlessRoleTrustRefusedError } from '../src/hosting/errors';

// MOTIR-11921 — the serverless account's two roles as code. The definitions
// carry every statement the live policies held on 2026-11-20, and the deploy
// role's definition is tied to the adapter itself: every AWS action
// `client.ts` and `registry.ts` can send, the actions a call needs beyond its
// own (CreateFunction's pass and pull, a `docker push`), and the function-URL
// pair `sign.ts` relies on. A grant missing from the definition fails here,
// not in a live deploy.

const ACCOUNT = '212859366014';
const REGION = 'us-east-1';
const SCOPE = { accountId: ACCOUNT, region: REGION };
const DEPLOY = serverlessDeployPolicy(SCOPE);
const EXEC = serverlessExecPolicy(SCOPE);
const OPERATOR = 'arn:aws:iam::576360162297:user/zhuyue';
const MANAGEMENT = 'arn:aws:iam::576360162297:role/motir-add-shard';

// ── A small IAM evaluator: Allow statements, globbed actions and resources, and
//    the two condition operators the definitions use. ───────────────────────

type Statement = Record<string, unknown>;

function list(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).map(String);
}

function glob(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\/]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

function conditionHolds(condition: unknown, context: Record<string, string>): boolean {
  if (!condition) return true;
  return Object.entries(condition as Record<string, Record<string, unknown>>).every(
    ([operator, keys]) =>
      Object.entries(keys).every(([key, wanted]) => {
        const actual = context[key];
        if (actual === undefined) return false;
        if (operator === 'StringEquals' || operator === 'Bool') {
          return list(wanted).includes(actual);
        }
        throw new Error(`the evaluator does not know ${operator}`);
      }),
  );
}

/** The statement ids that allow `action` on `resource` under `context`. */
function allowedBy(
  document: AwsPolicyDocument,
  action: string,
  resource: string,
  context: Record<string, string> = {},
): string[] {
  return (document.Statement as Statement[])
    .filter(
      (s) =>
        s['Effect'] === 'Allow' &&
        list(s['Action']).some((a) => glob(a, action)) &&
        list(s['Resource']).some((r) => glob(r, resource)) &&
        conditionHolds(s['Condition'], context),
    )
    .map((s) => String(s['Sid']));
}

// ── What the adapter sends, read from its own source ──────────────────────────

/** The IAM prefix of each SDK package the adapter imports. A new package fails
 *  the scan until it is named here, and its actions are pinned below. */
const IAM_PREFIX: Record<string, string> = {
  lambda: 'lambda',
  ecr: 'ecr',
  'secrets-manager': 'secretsmanager',
  'cloudwatch-logs': 'logs',
  cloudwatch: 'cloudwatch',
  sts: 'sts',
};

const SERVERLESS_SRC = join(__dirname, '../src/adapters/serverless');

/** Every `XCommand` the module imports, as the IAM action it is: `lambda:X`. */
function sentActions(file: string): string[] {
  const source = readFileSync(join(SERVERLESS_SRC, file), 'utf8');
  const actions: string[] = [];
  for (const match of source.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*'@aws-sdk\/client-([a-z-]+)'/g,
  )) {
    const prefix = IAM_PREFIX[match[2]!];
    if (!prefix)
      throw new Error(`${file} imports @aws-sdk/client-${match[2]}, which this test does not map`);
    for (const name of match[1]!.split(',').map((n) => n.trim())) {
      if (name.endsWith('Command')) actions.push(`${prefix}:${name.slice(0, -'Command'.length)}`);
    }
  }
  return actions;
}

const ADAPTER_ACTIONS = [...sentActions('client.ts'), ...sentActions('registry.ts')].filter(
  // The CALLER assumes the role; the role does not need to assume itself.
  (action) => action !== 'sts:AssumeRole',
);

const FUNCTION = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:mh-repo1`;
const QUALIFIED = `${FUNCTION}:live`;
const REPOSITORY = `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/mh/repo1/production`;
const SECRET = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:mh-repo1-AbCdEf`;
const LOG_GROUP = `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda/mh-repo1:*`;

/** The resource a hosted unit's call names; `*` for the actions IAM cannot scope. */
function resourceOf(action: string): string {
  const [service, name] = action.split(':') as [string, string];
  if (
    ['lambda:ListFunctions', 'ecr:GetAuthorizationToken', 'cloudwatch:GetMetricData'].includes(
      action,
    )
  ) {
    return '*';
  }
  if (service === 'lambda') return /Alias|Url|Provisioned/.test(name) ? QUALIFIED : FUNCTION;
  if (service === 'ecr') return REPOSITORY;
  if (service === 'secretsmanager') return SECRET;
  if (service === 'logs') return LOG_GROUP;
  throw new Error(`no resource known for ${action}`);
}

/** What a call needs beyond its own action, and the resource it needs it on. */
const IMPLIED: ReadonlyArray<{
  why: string;
  action: string;
  resource: string;
  context?: Record<string, string>;
}> = [
  {
    why: 'CreateFunction passes the execution role',
    action: 'iam:PassRole',
    resource: execRoleArn(ACCOUNT),
    context: { 'iam:PassedToService': 'lambda.amazonaws.com' },
  },
  {
    why: 'CreateFunction lets Lambda pull the image (MOTIR-11920)',
    action: 'ecr:GetRepositoryPolicy',
    resource: REPOSITORY,
  },
  {
    why: 'CreateFunction lets Lambda pull the image (MOTIR-11920)',
    action: 'ecr:SetRepositoryPolicy',
    resource: REPOSITORY,
  },
  { why: 'CreateFunction carries tags', action: 'lambda:TagResource', resource: FUNCTION },
  ...[
    'BatchCheckLayerAvailability',
    'InitiateLayerUpload',
    'UploadLayerPart',
    'CompleteLayerUpload',
    'PutImage',
    'BatchGetImage',
  ].map((name) => ({
    why: 'docker push after the registry login',
    action: `ecr:${name}`,
    resource: REPOSITORY,
  })),
  {
    why: 'sign.ts signs an AWS_IAM function URL request',
    action: 'lambda:InvokeFunctionUrl',
    resource: QUALIFIED,
    context: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' },
  },
  {
    why: 'an AWS_IAM function URL also needs InvokeFunction',
    action: 'lambda:InvokeFunction',
    resource: QUALIFIED,
    context: { 'lambda:InvokedViaFunctionUrl': 'true' },
  },
];

/** The adapter's actions and the implied ones the definition does not grant. */
function missingGrants(document: AwsPolicyDocument): string[] {
  const missing: string[] = [];
  for (const action of ADAPTER_ACTIONS) {
    if (allowedBy(document, action, resourceOf(action)).length === 0) missing.push(action);
  }
  for (const need of IMPLIED) {
    if (allowedBy(document, need.action, need.resource, need.context).length === 0) {
      missing.push(need.action);
    }
  }
  return missing;
}

/** The deploy policy with `action` taken out of every statement. */
function without(document: AwsPolicyDocument, action: string): AwsPolicyDocument {
  return {
    ...document,
    Statement: (document.Statement as Statement[])
      .map((s) => ({ ...s, Action: list(s['Action']).filter((a) => a !== action) }))
      .filter((s) => (s['Action'] as string[]).length > 0),
  };
}

describe('the deploy role grants every action the serverless adapter sends', () => {
  it('reads a real command list from the adapter source', () => {
    expect(ADAPTER_ACTIONS).toEqual(
      expect.arrayContaining([
        'lambda:CreateFunction',
        'lambda:CreateFunctionUrlConfig',
        'ecr:CreateRepository',
        'ecr:GetAuthorizationToken',
        'secretsmanager:PutSecretValue',
        'logs:DeleteLogGroup',
        'cloudwatch:GetMetricData',
      ]),
    );
    expect(ADAPTER_ACTIONS.length).toBeGreaterThanOrEqual(20);
  });

  it('covers every command the client actually sends, so the scan cannot miss one', async () => {
    const sent = new Set<string>();
    const service: Record<string, string> = {};
    const factory: ServerlessSdkClientFactory = (svc) => ({
      async send(command) {
        const name = (command as object).constructor.name.replace(/Command$/, '');
        if (name === 'AssumeRole') {
          return { Credentials: { AccessKeyId: 'A', SecretAccessKey: 'S', SessionToken: 'T' } };
        }
        service[name] = svc;
        sent.add(name);
        if (name === 'CreateSecret')
          throw Object.assign(new Error('x'), { name: 'ResourceExistsException' });
        if (name === 'GetAuthorizationToken') {
          return {
            authorizationData: [
              {
                authorizationToken: Buffer.from('AWS:pw').toString('base64'),
                proxyEndpoint: 'https://r',
              },
            ],
          };
        }
        return {
          Version: '1',
          FunctionUrl: 'https://u',
          FunctionVersion: '1',
          Status: 'READY',
          Configuration: { FunctionArn: FUNCTION },
        };
      },
    });
    const config = {
      roleArn: `arn:aws:iam::${ACCOUNT}:role/${SERVERLESS_DEPLOY_ROLE}`,
      region: REGION,
    };
    const api = createServerlessAwsApi(config, { clientFactory: factory });
    const spec = {
      name: 'mh-repo1',
      imageUri: 'i',
      roleArn: execRoleArn(ACCOUNT),
      memoryMb: 1,
      timeoutSeconds: 1,
      command: [],
      variables: {},
    };
    await api.ensureRepository('mh/repo1/production');
    await api.deleteRepository('mh/repo1/production');
    await api.getFunction('mh-repo1');
    await api.createFunction(spec, {});
    await api.updateFunctionConfiguration(spec);
    await api.updateFunctionCode('mh-repo1', 'i');
    await api.publishVersion('mh-repo1');
    await api.getAliasVersion('mh-repo1', 'live');
    await api.putAlias('mh-repo1', 'live', '1', false);
    await api.putAlias('mh-repo1', 'live', '1', true);
    await api.getFunctionUrl('mh-repo1', 'live');
    sent.add('CreateFunctionUrlConfig'); // ensureFunctionUrl stops at an existing URL
    await api.tagFunction(FUNCTION, {});
    await api.deleteFunction('mh-repo1');
    await api.listFunctionNames();
    await api.putSecret('mh-repo1', 'v');
    await api.deleteSecret('mh-repo1');
    await api.deleteLogGroup('/aws/lambda/mh-repo1');
    await api.metricSums('mh-repo1', new Date(0), new Date(1), 60);
    await api.putProvisionedConcurrency('mh-repo1', 'live', 1);
    await api.getProvisionedConcurrency('mh-repo1', 'live');
    await api.deleteProvisionedConcurrency('mh-repo1', 'live');
    await serverlessRegistryLogin({ config, clientFactory: factory });

    const scanned = new Set(ADAPTER_ACTIONS.map((a) => a.split(':')[1]));
    expect([...sent].filter((name) => !scanned.has(name))).toEqual([]);
    expect(sent.size).toBe(scanned.size);
  });

  it('grants each of them, and each implied action, on the hosted unit it names', () => {
    expect(missingGrants(DEPLOY)).toEqual([]);
  });

  it.each([...ADAPTER_ACTIONS, ...IMPLIED.map((n) => n.action)])(
    'fails when the definition loses %s',
    (action) => {
      expect(missingGrants(without(DEPLOY, action))).toContain(action);
    },
  );

  it('holds the function-URL pair, InvokeFunction only through a function URL', () => {
    expect(allowedBy(DEPLOY, 'lambda:InvokeFunctionUrl', QUALIFIED)).toEqual(['LambdaMh']);
    expect(
      allowedBy(DEPLOY, 'lambda:InvokeFunction', QUALIFIED, {
        'lambda:InvokedViaFunctionUrl': 'true',
      }),
    ).toEqual(['ServerlessFunctionUrlInvoke']);
    expect(allowedBy(DEPLOY, 'lambda:InvokeFunction', FUNCTION)).toEqual([]);
    expect(
      allowedBy(DEPLOY, 'lambda:InvokeFunction', FUNCTION, {
        'lambda:InvokedViaFunctionUrl': 'false',
      }),
    ).toEqual([]);
  });

  it('passes only the execution role, and only to Lambda', () => {
    const pass = (DEPLOY.Statement as Statement[]).filter((s) =>
      list(s['Action']).includes('iam:PassRole'),
    );
    expect(pass).toHaveLength(1);
    expect(list(pass[0]!['Resource'])).toEqual([execRoleArn(ACCOUNT)]);
    expect(pass[0]!['Condition']).toEqual({
      StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' },
    });
    expect(
      allowedBy(DEPLOY, 'iam:PassRole', `arn:aws:iam::${ACCOUNT}:role/other`, {
        'iam:PassedToService': 'lambda.amazonaws.com',
      }),
    ).toEqual([]);
    expect(
      allowedBy(DEPLOY, 'iam:PassRole', execRoleArn(ACCOUNT), {
        'iam:PassedToService': 'ec2.amazonaws.com',
      }),
    ).toEqual([]);
  });

  it('reaches nothing outside the mh names, and holds no other IAM action', () => {
    expect(
      allowedBy(
        DEPLOY,
        'lambda:DeleteFunction',
        `arn:aws:lambda:${REGION}:${ACCOUNT}:function:motir-fleet-index`,
      ),
    ).toEqual([]);
    expect(
      allowedBy(
        DEPLOY,
        'ecr:CreateRepository',
        `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/other-readback-test`,
      ),
    ).toEqual([]);
    expect(
      allowedBy(
        DEPLOY,
        'secretsmanager:DeleteSecret',
        `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:motir-x`,
      ),
    ).toEqual([]);
    const iam = (DEPLOY.Statement as Statement[])
      .flatMap((s) => list(s['Action']))
      .filter((a) => a.startsWith('iam:'));
    expect(iam).toEqual(['iam:PassRole']);
    const star = (DEPLOY.Statement as Statement[]).filter((s) => list(s['Resource']).includes('*'));
    expect(star.map((s) => s['Sid'])).toEqual(['UnscopableReads']);
    expect(list(star[0]!['Action']).sort()).toEqual([
      'cloudwatch:GetMetricData',
      'cloudwatch:GetMetricStatistics',
      'ecr:GetAuthorizationToken',
      'lambda:ListFunctions',
    ]);
  });
});

describe('the definitions as they stood live on 2026-11-20', () => {
  it('names the deploy role statements by their live ids', () => {
    expect((DEPLOY.Statement as Statement[]).map((s) => s['Sid'])).toEqual([
      'EcrMh',
      'SecretsMh',
      'LambdaMh',
      'PassExecRole',
      'LogsMh',
      'LogsDescribe',
      'UnscopableReads',
      'ServerlessFunctionUrlInvoke',
    ]);
  });

  it("keeps MOTIR-11920's two actions on repository/mh/* only", () => {
    const ecr = (DEPLOY.Statement as Statement[]).find((s) => s['Sid'] === 'EcrMh')!;
    expect(list(ecr['Action'])).toEqual(
      expect.arrayContaining(['ecr:GetRepositoryPolicy', 'ecr:SetRepositoryPolicy']),
    );
    expect(ecr['Resource']).toBe(`arn:aws:ecr:${REGION}:${ACCOUNT}:repository/mh/*`);
  });

  it('keeps ServerlessFunctionUrlInvoke as applied by hand', () => {
    expect(
      (DEPLOY.Statement as Statement[]).find((s) => s['Sid'] === 'ServerlessFunctionUrlInvoke'),
    ).toEqual({
      Sid: 'ServerlessFunctionUrlInvoke',
      Effect: 'Allow',
      Action: 'lambda:InvokeFunction',
      Resource: [
        `arn:aws:lambda:${REGION}:${ACCOUNT}:function:mh-*`,
        `arn:aws:lambda:${REGION}:${ACCOUNT}:function:mh-*:*`,
      ],
      Condition: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
    });
  });

  it('gives the execution role its own log streams and its overflow secret, nothing else', () => {
    expect(EXEC.Statement).toEqual([
      {
        Sid: 'OwnLogs',
        Effect: 'Allow',
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda/mh-*:*`,
      },
      {
        Sid: 'OverflowEnv',
        Effect: 'Allow',
        Action: 'secretsmanager:GetSecretValue',
        Resource: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:mh-*`,
      },
    ]);
    expect(
      allowedBy(
        EXEC,
        'logs:PutLogEvents',
        `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda/mh-repo1:log-stream:x`,
      ),
    ).toEqual(['OwnLogs']);
    expect(allowedBy(EXEC, 'secretsmanager:GetSecretValue', SECRET)).toEqual(['OverflowEnv']);
  });

  it('trusts Lambda for the execution role and exactly the named principals for the deploy role', () => {
    expect(SERVERLESS_EXEC_TRUST_POLICY.Statement).toEqual([
      { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
    ]);
    expect(serverlessDeployTrustPolicy([MANAGEMENT, OPERATOR]).Statement).toEqual([
      { Effect: 'Allow', Principal: { AWS: [MANAGEMENT, OPERATOR] }, Action: 'sts:AssumeRole' },
    ]);
  });

  it('pairs each role with its policy name, deploy role first, and drops a repeated principal', () => {
    const [deploy, exec] = serverlessRoleDefinitions({
      ...SCOPE,
      deployTrustPrincipals: [OPERATOR, OPERATOR, MANAGEMENT],
    });
    expect([deploy.roleName, deploy.policyName]).toEqual([
      SERVERLESS_DEPLOY_ROLE,
      SERVERLESS_DEPLOY_POLICY,
    ]);
    expect([exec.roleName, exec.policyName]).toEqual([
      SERVERLESS_EXEC_ROLE,
      SERVERLESS_EXEC_POLICY,
    ]);
    expect(deploy.trustPolicy).toEqual(serverlessDeployTrustPolicy([OPERATOR, MANAGEMENT]));
    expect(exec.trustPolicy).toBe(SERVERLESS_EXEC_TRUST_POLICY);
  });

  it('refuses a deploy role nobody may assume, or a principal that is not a user or role', () => {
    expect(() => serverlessRoleDefinitions({ ...SCOPE, deployTrustPrincipals: [] })).toThrow(
      ServerlessRoleTrustRefusedError,
    );
    expect(() => serverlessRoleDefinitions({ ...SCOPE, deployTrustPrincipals: ['*'] })).toThrow(
      /is not an IAM user or role ARN/,
    );
    expect(() =>
      serverlessRoleDefinitions({
        ...SCOPE,
        deployTrustPrincipals: ['arn:aws:iam::576360162297:root'],
      }),
    ).toThrow(ServerlessRoleTrustRefusedError);
  });
});
