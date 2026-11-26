import { IAMClient } from '@aws-sdk/client-iam';
import { describe, expect, it } from 'vitest';
import {
  AWS_MEMBER_ROLE_NAME,
  AwsManagementApiError,
  AwsTenantApiError,
  TenantRoleUnavailableError,
  createTenantMemberIam,
  createTenantSdkClient,
  sdkTenantCloudFormation,
  sdkTenantIam,
  type AwsSdkClient,
  type TenantSdkClientFactory,
} from '../src/index';

// The handover's SDK clients (MOTIR-12130): ListStacks across pages with the
// deleted stacks left out, IAM over its URL-encoded documents and its
// `Marker` pages, a delete of something gone answering quietly, and the member
// access role's session.

const commandName = (command: unknown) =>
  (command as { constructor: { name: string } }).constructor.name;
const inputOf = (command: unknown) => (command as { input: Record<string, unknown> }).input;

function sdkError(name: string, status = 400): Error {
  return Object.assign(new Error(`AWS said ${name}`), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

function stub(handlers: Record<string, (input: Record<string, unknown>) => unknown>) {
  const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
  const client: AwsSdkClient = {
    async send(command) {
      const name = commandName(command);
      sent.push({ command: name, input: inputOf(command) });
      const handler = handlers[name];
      if (!handler) throw new Error(`unstubbed ${name}`);
      return handler(inputOf(command));
    },
  };
  return { client, sent };
}

const TRUST = {
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::1:root' }, Action: 'sts:AssumeRole' },
  ],
};
const encoded = (doc: unknown) => encodeURIComponent(JSON.stringify(doc));

describe('listStacks over the SDK', () => {
  it('pages until done, asks AWS to leave deleted stacks out, and drops any it returns', async () => {
    const { client, sent } = stub({
      ListStacksCommand: (input) =>
        input['NextToken']
          ? { StackSummaries: [{ StackName: 'motir-b', StackStatus: 'UPDATE_COMPLETE' }] }
          : {
              StackSummaries: [
                { StackName: 'motir-a', StackStatus: 'CREATE_COMPLETE' },
                { StackName: 'motir-old', StackStatus: 'DELETE_COMPLETE' },
                { StackName: 'motir-odd' },
                {},
              ],
              NextToken: 't2',
            },
    });
    expect(await sdkTenantCloudFormation(client).listStacks()).toEqual([
      { name: 'motir-a', status: 'CREATE_COMPLETE' },
      { name: 'motir-odd', status: 'UNKNOWN' },
      { name: 'motir-b', status: 'UPDATE_COMPLETE' },
    ]);
    const filter = sent[0]!.input['StackStatusFilter'] as string[];
    expect(filter).toContain('CREATE_COMPLETE');
    expect(filter).toContain('DELETE_IN_PROGRESS');
    expect(filter).not.toContain('DELETE_COMPLETE');
  });

  it('carries a refusal as AWS’s code', async () => {
    const { client } = stub({
      ListStacksCommand: () => {
        throw sdkError('AccessDenied', 403);
      },
    });
    await expect(sdkTenantCloudFormation(client).listStacks()).rejects.toMatchObject({
      service: 'cloudformation',
      awsCode: 'AccessDenied',
    });
  });
});

describe('TenantIam over the SDK', () => {
  it('reads a role and its decoded trust, and a missing role as null', async () => {
    const { client } = stub({
      GetRoleCommand: (input) => {
        if (input['RoleName'] === 'gone') throw sdkError('NoSuchEntityException', 404);
        if (input['RoleName'] === 'bare') return { Role: { RoleName: 'bare' } };
        if (input['RoleName'] === 'none') return {};
        return {
          Role: {
            RoleName: 'r',
            Arn: 'arn:aws:iam::1:role/p/r',
            Path: '/p/',
            AssumeRolePolicyDocument: encoded(TRUST),
          },
        };
      },
    });
    const iam = sdkTenantIam(client);
    expect(await iam.getRole('r')).toEqual({
      name: 'r',
      arn: 'arn:aws:iam::1:role/p/r',
      path: '/p/',
      trust: TRUST,
    });
    expect(await iam.getRole('gone')).toBeNull();
    expect(await iam.getRole('none')).toBeNull();
    expect(await iam.getRole('bare')).toEqual({
      name: 'bare',
      arn: '',
      path: '/',
      trust: { Version: '2012-10-17', Statement: [] },
    });
  });

  it('writes roles, trusts and inline policies as JSON', async () => {
    const { client, sent } = stub({
      CreateRoleCommand: () => ({}),
      UpdateAssumeRolePolicyCommand: () => ({}),
      PutRolePolicyCommand: () => ({}),
      GetRolePolicyCommand: (input) => {
        if (input['PolicyName'] === 'gone') throw sdkError('NoSuchEntity', 404);
        return { PolicyDocument: encoded(TRUST) };
      },
    });
    const iam = sdkTenantIam(client);
    await iam.createRole({
      name: 'r',
      path: '/p/',
      trust: TRUST,
      description: 'd',
      maxSessionSeconds: 3600,
      tags: { k: 'v' },
    });
    await iam.createRole({
      name: 'q',
      trust: TRUST,
      description: 'd',
      maxSessionSeconds: 3600,
      tags: {},
    });
    await iam.updateAssumeRolePolicy('r', TRUST);
    await iam.putRolePolicy('r', 'p', TRUST);
    expect(await iam.getRolePolicy('r', 'p')).toEqual(TRUST);
    expect(await iam.getRolePolicy('r', 'gone')).toBeNull();
    expect(sent[0]!.input).toEqual({
      RoleName: 'r',
      Path: '/p/',
      AssumeRolePolicyDocument: JSON.stringify(TRUST),
      Description: 'd',
      MaxSessionDuration: 3600,
      Tags: [{ Key: 'k', Value: 'v' }],
    });
    expect(sent[1]!.input).not.toHaveProperty('Path');
    expect(sent[2]!.input).toEqual({ RoleName: 'r', PolicyDocument: JSON.stringify(TRUST) });
    expect(sent[3]!.input).toEqual({
      RoleName: 'r',
      PolicyName: 'p',
      PolicyDocument: JSON.stringify(TRUST),
    });
  });

  it('pages every list by Marker', async () => {
    const page =
      <T>(first: T[], second: T[], key: string) =>
      (input: Record<string, unknown>) =>
        input['Marker'] ? { [key]: second } : { [key]: first, IsTruncated: true, Marker: 'm' };
    const { client } = stub({
      ListRolePoliciesCommand: page(['a'], ['b'], 'PolicyNames'),
      ListAttachedRolePoliciesCommand: page(
        [{ PolicyName: 'x', PolicyArn: 'arn:x' }],
        [{}],
        'AttachedPolicies',
      ),
      ListInstanceProfilesForRoleCommand: page(
        [{ InstanceProfileName: 'ip' }],
        [{}],
        'InstanceProfiles',
      ),
      ListRolesCommand: page([{ RoleName: 'one' }], [{ RoleName: 'two' }], 'Roles'),
      ListPoliciesCommand: page([{ PolicyName: 'p', Arn: 'arn:p' }], [{}], 'Policies'),
    });
    const iam = sdkTenantIam(client);
    expect(await iam.listRolePolicies('r')).toEqual(['a', 'b']);
    expect(await iam.listAttachedRolePolicies('r')).toEqual([
      { name: 'x', arn: 'arn:x' },
      { name: '', arn: '' },
    ]);
    expect(await iam.listInstanceProfilesForRole('r')).toEqual(['ip']);
    expect((await iam.listRoles()).map((r) => r.name)).toEqual(['one', 'two']);
    expect(await iam.listPolicies('/x/')).toEqual([
      { name: 'p', arn: 'arn:p' },
      { name: '', arn: '' },
    ]);
  });

  it('answers a delete of something gone quietly, and throws any other refusal', async () => {
    const gone = () => {
      throw sdkError('NoSuchEntity', 404);
    };
    const { client } = stub({
      DeleteRolePolicyCommand: gone,
      DetachRolePolicyCommand: gone,
      RemoveRoleFromInstanceProfileCommand: gone,
      DeleteInstanceProfileCommand: gone,
      DeleteRoleCommand: () => {
        throw sdkError('DeleteConflict', 409);
      },
    });
    const iam = sdkTenantIam(client);
    await iam.deleteRolePolicy('r', 'p');
    await iam.detachRolePolicy('r', 'arn:p');
    await iam.removeRoleFromInstanceProfile('ip', 'r');
    await iam.deleteInstanceProfile('ip');
    const err = await iam.deleteRole('r').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwsTenantApiError);
    expect(err).toMatchObject({ service: 'iam', awsCode: 'DeleteConflict' });
  });

  it('throws a refusal of a read other than a missing entity', async () => {
    const denied = () => {
      throw sdkError('AccessDenied', 403);
    };
    const { client } = stub({
      GetRoleCommand: denied,
      GetRolePolicyCommand: denied,
      ListPolicyVersionsCommand: denied,
    });
    const iam = sdkTenantIam(client);
    for (const run of [
      () => iam.getRole('r'),
      () => iam.getRolePolicy('r', 'p'),
      () => iam.deletePolicy('arn:p'),
    ]) {
      await expect(run()).rejects.toMatchObject({ awsCode: 'AccessDenied' });
    }
  });

  it('deletes a policy’s other versions before the policy, and a gone policy quietly', async () => {
    const { client, sent } = stub({
      ListPolicyVersionsCommand: (input) => {
        if (input['PolicyArn'] === 'arn:gone') throw sdkError('NoSuchEntity', 404);
        if (input['PolicyArn'] === 'arn:bare') return {};
        return {
          Versions: [
            { VersionId: 'v3', IsDefaultVersion: true },
            { VersionId: 'v2', IsDefaultVersion: false },
            { IsDefaultVersion: false },
          ],
        };
      },
      DeletePolicyVersionCommand: () => ({}),
      DeletePolicyCommand: () => ({}),
    });
    const iam = sdkTenantIam(client);
    await iam.deletePolicy('arn:p');
    await iam.deletePolicy('arn:gone');
    await iam.deletePolicy('arn:bare');
    expect(sent.map((s) => s.command)).toEqual([
      'ListPolicyVersionsCommand',
      'DeletePolicyVersionCommand',
      'DeletePolicyCommand',
      'ListPolicyVersionsCommand',
      'ListPolicyVersionsCommand',
      'DeletePolicyCommand',
    ]);
    expect(sent[1]!.input).toEqual({ PolicyArn: 'arn:p', VersionId: 'v2' });
  });

  it('builds the real IAM client', () => {
    expect(
      createTenantSdkClient('iam', {
        region: 'us-east-1',
        credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' }),
      }),
    ).toBeInstanceOf(IAMClient);
  });
});

describe('the member access role’s IAM session', () => {
  it('runs on the member role, assumed through the management API', async () => {
    const assumed: string[] = [];
    const used: string[] = [];
    const factory: TenantSdkClientFactory = (service, config) => ({
      async send() {
        used.push(`${service}:${(await config.credentials()).accessKeyId}`);
        return { Role: { RoleName: AWS_MEMBER_ROLE_NAME } };
      },
    });
    const iam = createTenantMemberIam({
      management: {
        assumeMemberRole: async (accountId) => {
          assumed.push(accountId);
          return {
            accessKeyId: 'ASIAMEMBER',
            secretAccessKey: 's',
            sessionToken: 't',
            expiration: null,
          };
        },
      },
      accountId: '210987654321',
      region: 'us-east-1',
      sdkClientFactory: factory,
      now: () => 0,
    });
    await iam.getRole(AWS_MEMBER_ROLE_NAME);
    await iam.getRole(AWS_MEMBER_ROLE_NAME);
    expect(assumed).toEqual(['210987654321']);
    expect(used).toEqual(['iam:ASIAMEMBER', 'iam:ASIAMEMBER']);
  });

  it('names the member role when it cannot be assumed', async () => {
    const iam = createTenantMemberIam({
      management: {
        assumeMemberRole: async () => {
          throw new AwsManagementApiError('sts', 'AccessDenied', 403);
        },
      },
      accountId: '210987654321',
      region: 'us-east-1',
      sdkClientFactory: (_service, config) => ({
        async send() {
          await config.credentials();
          return {};
        },
      }),
    });
    const err = await iam.getRole(AWS_MEMBER_ROLE_NAME).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenantRoleUnavailableError);
    expect(err).toMatchObject({ roleName: AWS_MEMBER_ROLE_NAME, awsCode: 'AccessDenied' });
  });

  it('uses the real SDK client by default', () => {
    const iam = createTenantMemberIam({
      management: {
        assumeMemberRole: async () => ({
          accessKeyId: 'a',
          secretAccessKey: 's',
          sessionToken: 't',
          expiration: null,
        }),
      },
      accountId: '210987654321',
      region: 'us-east-1',
    });
    expect(typeof iam.getRole).toBe('function');
  });
});
