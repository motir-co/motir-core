import { describe, expect, it } from 'vitest';
import type { AwsPolicyDocument } from '../src/adapters/aws/management';
import {
  convergeServerlessRoles,
  defaultServerlessIamClientFactory,
  iamCanonicalStatements,
  iamPolicyDiff,
  type ServerlessIamClientFactory,
} from '../src/adapters/serverless/roleConvergence';
import { serverlessRoleDefinitions } from '../src/adapters/serverless/roles';
import { OrchestratorApiError } from '../src/errors';
import {
  ServerlessRoleMissingError,
  ServerlessRoleReadBackMismatchError,
  ServerlessRoleTrustRefusedError,
} from '../src/hosting/errors';

// MOTIR-11921 — the converge of the serverless account's two roles: it reads
// both live roles, writes a role's trust or inline policy only when it differs
// from the definition, reads every write back, and reports per role what changed.

const ACCOUNT = '212859366014';
const REGION = 'us-east-1';
const PRINCIPALS = [
  'arn:aws:iam::576360162297:user/zhuyue',
  'arn:aws:iam::576360162297:role/motir-add-shard',
];
const CREDENTIALS = { accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't' };
const INPUT = {
  accountId: ACCOUNT,
  region: REGION,
  deployTrustPrincipals: PRINCIPALS,
  credentials: CREDENTIALS,
};
const [DEPLOY, EXEC] = serverlessRoleDefinitions(INPUT);

interface LiveRole {
  trust: string;
  policies: Record<string, string>;
}

/** IAM answers documents URL-encoded, in its own key order. */
function asIamReturnsIt(document: AwsPolicyDocument): string {
  const reordered = {
    Statement: document.Statement.map((s) => Object.fromEntries(Object.entries(s).reverse())),
    Version: document.Version,
  };
  return encodeURIComponent(JSON.stringify(reordered));
}

function liveAccount(overrides: Partial<Record<string, Partial<LiveRole>>> = {}) {
  const roles = new Map<string, LiveRole>();
  for (const role of [DEPLOY, EXEC]) {
    roles.set(role.roleName, {
      trust: asIamReturnsIt(role.trustPolicy),
      policies: { [role.policyName]: asIamReturnsIt(role.policy) },
      ...overrides[role.roleName],
    });
  }
  const writes: Array<{ command: string; role: string }> = [];
  const reads: string[] = [];
  let ignoreWrites = false;
  let refuse: string | null = null;
  const factoryCalls: unknown[] = [];

  const factory: ServerlessIamClientFactory = (options) => {
    factoryCalls.push(options);
    return {
      async send(command) {
        const name = (command as object).constructor.name;
        const input = (command as { input: Record<string, string> }).input;
        if (refuse)
          throw Object.assign(new Error('the message is never read'), {
            name: refuse,
            $metadata: { httpStatusCode: 403 },
          });
        const role = roles.get(input['RoleName']!);
        const noSuch = () => Object.assign(new Error('x'), { name: 'NoSuchEntityException' });
        switch (name) {
          case 'GetRoleCommand':
            reads.push(`trust ${input['RoleName']}`);
            if (!role) throw noSuch();
            return { Role: { AssumeRolePolicyDocument: role.trust } };
          case 'GetRolePolicyCommand': {
            reads.push(`policy ${input['RoleName']}`);
            const document = role?.policies[input['PolicyName']!];
            if (!document) throw noSuch();
            return { PolicyDocument: document };
          }
          case 'PutRolePolicyCommand':
            writes.push({ command: 'PutRolePolicy', role: input['RoleName']! });
            if (!ignoreWrites)
              role!.policies[input['PolicyName']!] = encodeURIComponent(input['PolicyDocument']!);
            return {};
          case 'UpdateAssumeRolePolicyCommand':
            writes.push({ command: 'UpdateAssumeRolePolicy', role: input['RoleName']! });
            if (!ignoreWrites) role!.trust = encodeURIComponent(input['PolicyDocument']!);
            return {};
        }
        throw new Error(`unexpected ${name}`);
      },
    };
  };
  return {
    roles,
    writes,
    reads,
    factory,
    factoryCalls,
    ignoreWrites: () => {
      ignoreWrites = true;
    },
    refuse: (code: string) => {
      refuse = code;
    },
  };
}

function withoutStatement(document: AwsPolicyDocument, sid: string): AwsPolicyDocument {
  return { ...document, Statement: document.Statement.filter((s) => s['Sid'] !== sid) };
}

describe('convergeServerlessRoles', () => {
  it('writes nothing when both live roles match their definitions', async () => {
    const live = liveAccount();
    const results = await convergeServerlessRoles(INPUT, { iamClientFactory: live.factory });
    expect(results).toEqual([
      {
        roleName: 'motir-hosting-serverless-deploy',
        trust: 'unchanged',
        policy: 'unchanged',
        trustDiff: [],
        policyDiff: [],
      },
      {
        roleName: 'mh-shared-exec',
        trust: 'unchanged',
        policy: 'unchanged',
        trustDiff: [],
        policyDiff: [],
      },
    ]);
    expect(live.writes).toEqual([]);
    expect(live.factoryCalls).toEqual([{ region: 'us-east-1', credentials: CREDENTIALS }]);
  });

  it('writes the one drifted policy, to that role only, and reads it back matching', async () => {
    const live = liveAccount({
      'mh-shared-exec': {
        policies: {
          'mh-shared-exec': asIamReturnsIt(withoutStatement(EXEC.policy, 'OverflowEnv')),
        },
      },
    });
    const results = await convergeServerlessRoles(INPUT, { iamClientFactory: live.factory });
    expect(live.writes).toEqual([{ command: 'PutRolePolicy', role: 'mh-shared-exec' }]);
    expect(results[0]).toMatchObject({ trust: 'unchanged', policy: 'unchanged' });
    expect(results[1]).toEqual({
      roleName: 'mh-shared-exec',
      trust: 'unchanged',
      policy: 'changed',
      trustDiff: [],
      policyDiff: ['+OverflowEnv'],
    });
    // the read after the write
    expect(live.reads.filter((r) => r === 'policy mh-shared-exec')).toHaveLength(2);
    expect(
      iamPolicyDiff(
        EXEC.policy,
        decodeURIComponent(live.roles.get('mh-shared-exec')!.policies['mh-shared-exec']!),
      ),
    ).toEqual([]);
  });

  it("restores the deploy role's hand-applied grants and names each statement that differed", async () => {
    const stale = withoutStatement(DEPLOY.policy, 'ServerlessFunctionUrlInvoke');
    stale.Statement = stale.Statement.map((s) =>
      s['Sid'] === 'EcrMh'
        ? { ...s, Action: (s['Action'] as string[]).filter((a) => !a.endsWith('RepositoryPolicy')) }
        : s,
    );
    stale.Statement.push({
      Sid: 'HandAdded',
      Effect: 'Allow',
      Action: 'lambda:InvokeFunction',
      Resource: '*',
    });
    const live = liveAccount({
      'motir-hosting-serverless-deploy': {
        policies: { 'motir-hosting-serverless-deploy': asIamReturnsIt(stale) },
      },
    });
    const [deploy] = await convergeServerlessRoles(INPUT, { iamClientFactory: live.factory });
    expect(deploy!.policyDiff).toEqual(['~EcrMh', '+ServerlessFunctionUrlInvoke', '-HandAdded']);
    expect(live.writes).toEqual([
      { command: 'PutRolePolicy', role: 'motir-hosting-serverless-deploy' },
    ]);
  });

  it('converges a drifted trust policy, and a missing inline policy is written', async () => {
    const live = liveAccount({
      'motir-hosting-serverless-deploy': {
        trust: encodeURIComponent(
          JSON.stringify({
            Version: '2012-10-17',
            Statement: {
              Effect: 'Allow',
              Principal: { AWS: PRINCIPALS[0] },
              Action: 'sts:AssumeRole',
            },
          }),
        ),
      },
      'mh-shared-exec': { policies: {} },
    });
    const results = await convergeServerlessRoles(INPUT, { iamClientFactory: live.factory });
    expect(live.writes).toEqual([
      { command: 'UpdateAssumeRolePolicy', role: 'motir-hosting-serverless-deploy' },
      { command: 'PutRolePolicy', role: 'mh-shared-exec' },
    ]);
    expect(results[0]).toMatchObject({ trust: 'changed', trustDiff: ['~#0'], policy: 'unchanged' });
    expect(results[1]).toMatchObject({
      policy: 'changed',
      policyDiff: ['+OwnLogs', '+OverflowEnv'],
    });
  });

  it('reads the same principals in a different order, or one as a bare string, as unchanged', async () => {
    const live = liveAccount({
      'motir-hosting-serverless-deploy': {
        trust: encodeURIComponent(
          JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Action: ['sts:AssumeRole'],
                Principal: { AWS: [...PRINCIPALS].reverse() },
                Effect: 'Allow',
              },
            ],
          }),
        ),
      },
    });
    const [deploy] = await convergeServerlessRoles(INPUT, { iamClientFactory: live.factory });
    expect(deploy!.trust).toBe('unchanged');
    expect(live.writes).toEqual([]);
  });

  it('reports a drift as would_change and writes nothing in a dry run', async () => {
    const live = liveAccount({ 'mh-shared-exec': { policies: {} } });
    const results = await convergeServerlessRoles(
      { ...INPUT, dryRun: true },
      { iamClientFactory: live.factory },
    );
    expect(results[1]).toMatchObject({
      policy: 'would_change',
      policyDiff: ['+OwnLogs', '+OverflowEnv'],
    });
    expect(results[0]).toMatchObject({ trust: 'unchanged', policy: 'unchanged' });
    expect(live.writes).toEqual([]);
  });

  it('refuses a missing role and never creates it', async () => {
    const live = liveAccount();
    live.roles.delete('mh-shared-exec');
    await expect(
      convergeServerlessRoles(INPUT, { iamClientFactory: live.factory }),
    ).rejects.toThrow(ServerlessRoleMissingError);
    expect(live.writes).toEqual([]);
  });

  it('refuses a write that does not read back', async () => {
    const live = liveAccount({ 'mh-shared-exec': { policies: {} } });
    live.ignoreWrites();
    await expect(
      convergeServerlessRoles(INPUT, { iamClientFactory: live.factory }),
    ).rejects.toThrow(new ServerlessRoleReadBackMismatchError('mh-shared-exec', 'policy'));
    const trustDrift = liveAccount({
      'mh-shared-exec': { trust: encodeURIComponent('{"Statement":[]}') },
    });
    trustDrift.ignoreWrites();
    await expect(
      convergeServerlessRoles(INPUT, { iamClientFactory: trustDrift.factory }),
    ).rejects.toThrow(new ServerlessRoleReadBackMismatchError('mh-shared-exec', 'trust'));
  });

  it("maps an IAM refusal to its code, never AWS's message", async () => {
    const live = liveAccount();
    live.refuse('AccessDenied');
    const err = await convergeServerlessRoles(INPUT, { iamClientFactory: live.factory }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect((err as Error).message).toContain('iam: AccessDenied');
    expect((err as Error).message).not.toContain('never read');
    expect((err as OrchestratorApiError).status).toBe(403);
  });

  it('maps a refused write and a refused policy read too', async () => {
    const live = liveAccount({ 'mh-shared-exec': { policies: {} } });
    const factory: ServerlessIamClientFactory = (options) => {
      const inner = live.factory(options);
      return {
        async send(command) {
          if ((command as object).constructor.name === 'PutRolePolicyCommand')
            throw { Code: 'LimitExceeded' };
          return inner.send(command);
        },
      };
    };
    await expect(convergeServerlessRoles(INPUT, { iamClientFactory: factory })).rejects.toThrow(
      /iam: LimitExceeded/,
    );
    const reads: ServerlessIamClientFactory = (options) => {
      const inner = live.factory(options);
      return {
        async send(command) {
          if ((command as object).constructor.name === 'GetRolePolicyCommand')
            throw new Error('boom');
          return inner.send(command);
        },
      };
    };
    const err = await convergeServerlessRoles(INPUT, { iamClientFactory: reads }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect((err as OrchestratorApiError).status).toBeNull();
  });

  it('refuses an empty trust before any call', async () => {
    const live = liveAccount();
    await expect(
      convergeServerlessRoles(
        { ...INPUT, deployTrustPrincipals: [] },
        { iamClientFactory: live.factory },
      ),
    ).rejects.toThrow(ServerlessRoleTrustRefusedError);
    expect(live.reads).toEqual([]);
  });

  it('builds a real IAM client when no seam is given', () => {
    expect(
      typeof defaultServerlessIamClientFactory({ region: REGION, credentials: CREDENTIALS }).send,
    ).toBe('function');
  });
});

describe('iamCanonicalStatements', () => {
  it('keys statements by Sid, or position, with lists and condition values sorted', () => {
    const a = iamCanonicalStatements({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'X',
          Effect: 'Allow',
          Action: ['b', 'a'],
          Resource: 'r',
          Condition: { Bool: { k: 'true' } },
        },
        {
          Effect: 'Allow',
          Action: 'c',
          Resource: '*',
          Principal: { Service: 'lambda.amazonaws.com' },
        },
      ],
    });
    const b = iamCanonicalStatements(
      JSON.stringify({
        Statement: [
          {
            Condition: { Bool: { k: ['true'] } },
            Resource: ['r'],
            Action: ['a', 'b'],
            Effect: 'Allow',
            Sid: 'X',
          },
          {
            Principal: { Service: ['lambda.amazonaws.com'] },
            Resource: ['*'],
            Action: ['c'],
            Effect: 'Allow',
          },
        ],
      }),
    );
    expect([...a.keys()]).toEqual(['X', '#1']);
    expect(a).toEqual(b);
    expect(iamCanonicalStatements('{}').size).toBe(0);
  });

  it('reports every statement as added when there is no live document', () => {
    expect(iamPolicyDiff(EXEC.policy, null)).toEqual(['+OwnLogs', '+OverflowEnv']);
  });
});
