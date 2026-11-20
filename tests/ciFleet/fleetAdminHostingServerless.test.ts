import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerlessIamClientFactory } from '@motir/orchestrator';
import { serverlessRoleDefinitions } from '@motir/orchestrator';
import { serverlessHostingRolesService } from '@/lib/services/serverlessHostingRolesService';
import { EXIT_ERROR, EXIT_OK, runFleetAdmin } from '@/scripts/fleet/fleetAdmin';

// `fleet-admin hosting-serverless converge-roles` (MOTIR-11921): the serverless
// hosting account's deploy role and execution role brought onto their
// definitions, as the account's member access role, writing only what differs.
// The service is driven end to end over an in-memory IAM; the command is a
// printer over it.

const ACCOUNT = '212859366014';
const REGION = 'us-east-1';
const OPERATOR = 'arn:aws:iam::576360162297:user/zhuyue';
const MANAGEMENT = 'arn:aws:iam::576360162297:role/motir-add-shard';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

let out: string[];
let err: string[];
const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };

beforeEach(() => {
  out = [];
  err = [];
});

/** An account holding both roles as defined, with `drift` applied. */
function account(
  drift: (roles: Map<string, { trust: string; policy: string }>) => void = () => {},
) {
  const [deploy, exec] = serverlessRoleDefinitions({ accountId: ACCOUNT, region: REGION });
  const roles = new Map(
    [deploy, exec].map((r) => [
      r.roleName,
      {
        trust: encodeURIComponent(JSON.stringify(r.trustPolicy)),
        policy: encodeURIComponent(JSON.stringify(r.policy)),
      },
    ]),
  );
  drift(roles);
  const writes: string[] = [];
  const sessions: string[] = [];
  const iamClientFactory: ServerlessIamClientFactory = ({ credentials }) => ({
    async send(command) {
      expect(credentials.sessionToken).toBe('member-token');
      const name = (command as object).constructor.name;
      const input = (command as { input: Record<string, string> }).input;
      const role = roles.get(input['RoleName']!)!;
      if (name === 'GetRoleCommand') return { Role: { AssumeRolePolicyDocument: role.trust } };
      if (name === 'GetRolePolicyCommand') return { PolicyDocument: role.policy };
      writes.push(`${name.replace(/Command$/, '')} ${input['RoleName']}`);
      if (name === 'PutRolePolicyCommand')
        role.policy = encodeURIComponent(input['PolicyDocument']!);
      if (name === 'UpdateAssumeRolePolicyCommand')
        role.trust = encodeURIComponent(input['PolicyDocument']!);
      return {};
    },
  });
  const deps = {
    config: { accountId: ACCOUNT, region: REGION },
    management: {
      async assumeMemberRole(accountId: string) {
        sessions.push(accountId);
        return {
          accessKeyId: 'ASIA',
          secretAccessKey: SECRET,
          sessionToken: 'member-token',
          expiration: null,
        };
      },
    },
    converge: { iamClientFactory },
  };
  return { writes, sessions, deps };
}

const run = (argv: string[], deps: ReturnType<typeof account>['deps']) =>
  runFleetAdmin(['hosting-serverless', ...argv], io, {
    hostingServerless: { converge: (input) => serverlessHostingRolesService.converge(input, deps) },
  });

describe('fleet-admin hosting-serverless converge-roles', () => {
  it('writes nothing to roles that match, as the member access role of the account', async () => {
    const live = account();
    expect(await run(['converge-roles'], live.deps)).toBe(EXIT_OK);
    expect(live.sessions).toEqual([ACCOUNT]);
    expect(live.writes).toEqual([]);
    expect(out).toEqual([
      'role motir-hosting-serverless-deploy: trust unchanged, policy unchanged',
      'role mh-shared-exec: trust unchanged, policy unchanged',
      `serverless roles in ${ACCOUNT}: 2 role(s), 0 changed, 2 unchanged`,
    ]);
  });

  it('writes the drifted role only, and says which statements differed', async () => {
    const live = account((roles) => {
      roles.get('motir-hosting-serverless-deploy')!.policy = encodeURIComponent(
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Sid: 'EcrMh', Effect: 'Allow', Action: 'ecr:PutImage', Resource: '*' }],
        }),
      );
    });
    expect(await run(['converge-roles'], live.deps)).toBe(EXIT_OK);
    expect(live.writes).toEqual(['PutRolePolicy motir-hosting-serverless-deploy']);
    expect(out[0]).toBe(
      'role motir-hosting-serverless-deploy: trust unchanged, policy changed ' +
        '(~EcrMh +SecretsMh +LambdaMh +PassExecRole +LogsMh +LogsDescribe +UnscopableReads +ServerlessFunctionUrlInvoke)',
    );
    expect(out[2]).toBe(`serverless roles in ${ACCOUNT}: 2 role(s), 1 changed, 1 unchanged`);
    // A second run finds nothing left to write.
    out = [];
    expect(await run(['converge-roles'], live.deps)).toBe(EXIT_OK);
    expect(live.writes).toHaveLength(1);
    expect(out[2]).toContain('0 changed, 2 unchanged');
  });

  it('names the principal a trust change would remove, and --dry-run writes nothing', async () => {
    // Someone hand-edited the live trust: the management role is gone and a
    // stranger is in. The dry run says so principal by principal.
    const live = account((roles) => {
      roles.get('motir-hosting-serverless-deploy')!.trust = encodeURIComponent(
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: [OPERATOR, 'arn:aws:iam::111111111111:user/stranger'] },
              Action: 'sts:AssumeRole',
            },
          ],
        }),
      );
    });
    expect(await run(['converge-roles', '--dry-run'], live.deps)).toBe(EXIT_OK);
    expect(live.writes).toEqual([]);
    expect(out).toEqual([
      `role motir-hosting-serverless-deploy: trust would_change (+${MANAGEMENT} -arn:aws:iam::111111111111:user/stranger), policy unchanged`,
      'role mh-shared-exec: trust unchanged, policy unchanged',
      `serverless roles in ${ACCOUNT}: 2 role(s), 1 would change, 1 unchanged (dry run, nothing written)`,
    ]);
    // Applied, the trust is back to the code's two principals.
    out = [];
    expect(await run(['converge-roles'], live.deps)).toBe(EXIT_OK);
    expect(live.writes).toEqual(['UpdateAssumeRolePolicy motir-hosting-serverless-deploy']);
  });

  it.each([
    ['a positional', ['converge-roles', 'extra']],
    ['another subcommand', ['ensure']],
  ])('prints the usage and exits 1 for %s', async (_, argv) => {
    expect(await run(argv, account().deps)).toBe(EXIT_ERROR);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('hosting-serverless converge-roles [--dry-run]');
  });

  it('exits 1 with the error, never a credential, when the converge refuses', async () => {
    const live = account((roles) => roles.delete('mh-shared-exec'));
    const refusing = {
      ...live.deps,
      converge: {
        iamClientFactory: () => ({
          async send() {
            throw Object.assign(new Error(SECRET), { name: 'NoSuchEntityException' });
          },
        }),
      },
    };
    expect(await run(['converge-roles'], refusing)).toBe(EXIT_ERROR);
    expect(err.join('\n')).toContain('motir-hosting-serverless-deploy does not exist');
    expect([...out, ...err].join('\n')).not.toContain(SECRET);
  });

  it('refuses --trust: who may assume the role is defined in code, not typed', async () => {
    const live = account();
    expect(await run(['converge-roles', '--trust', OPERATOR], live.deps)).toBe(EXIT_ERROR);
    expect(err.join('\n')).toContain("Unknown option '--trust'");
    expect(live.sessions).toEqual([]);
  });

  it('reaches the service by default, which names the unset account variable', async () => {
    const saved = process.env['MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN'];
    delete process.env['MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN'];
    try {
      expect(await runFleetAdmin(['hosting-serverless', 'converge-roles'], io)).toBe(EXIT_ERROR);
      expect(err.join('\n')).toContain('MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN');
    } finally {
      if (saved !== undefined) process.env['MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN'] = saved;
    }
  });

  it('lists the command in the usage', async () => {
    expect(await runFleetAdmin([], io)).toBe(EXIT_ERROR);
    expect(err.join('\n')).toContain('fleet-admin hosting-serverless converge-roles [--dry-run]');
  });
});

describe('serverlessHostingRolesService defaults', () => {
  it('names the variable when the serverless account is not configured', async () => {
    const saved = process.env['MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN'];
    delete process.env['MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN'];
    try {
      await expect(serverlessHostingRolesService.converge({ dryRun: true })).rejects.toThrow(
        /MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN/,
      );
    } finally {
      if (saved !== undefined) process.env['MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN'] = saved;
    }
  });

  it('names the management variable when it is not set', async () => {
    const saved = process.env['AWS_ORG_ADMIN_ROLE_ARN'];
    delete process.env['AWS_ORG_ADMIN_ROLE_ARN'];
    try {
      await expect(
        serverlessHostingRolesService.converge(
          { dryRun: true },
          { config: { accountId: ACCOUNT, region: REGION } },
        ),
      ).rejects.toThrow(/AWS_ORG_ADMIN_ROLE_ARN/);
    } finally {
      if (saved !== undefined) process.env['AWS_ORG_ADMIN_ROLE_ARN'] = saved;
    }
  });
});
