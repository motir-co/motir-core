import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AWS_INDEX_IAM_ROLE,
  AWS_MEMBER_ROLE_NAME,
  AWS_RUNNER_IAM_ROLE,
  AWS_TENANT_DEPLOY_POLICY_PATH,
  AWS_TENANT_DEPLOY_ROLE,
  AwsTenantApiError,
  FAKE_ADMINISTRATOR_ACCESS_ARN,
  HANDOVER_DEPLOY_POLICY,
  HANDOVER_DEPLOY_ROLE,
  HANDOVER_DEPLOY_ROLE_PATH,
  HandoverInputInvalidError,
  HandoverPreviewDestroyError,
  HandoverRoleConflictError,
  NotAPreviewAppRefError,
  TenantRoleUnavailableError,
  accountRootTrust,
  createAwsHostingDeployPort,
  createFakeTenantClients,
  createFakeTenantIamAccount,
  createTenantHandover,
  destroyAwsPreview,
  awsReleaseRunner,
  fakeAwsTrust,
  handoverDeployPolicy,
  namesMotir,
  previewAppRefOfStack,
  seedFakeTenantIam,
  type AwsHostingDeps,
  type DeployReleaseInput,
  type HostingEnvironment,
  type ReleaseShape,
  type TenantHandoverDeps,
  type TenantIam,
} from '../src/index';

// THE TENANT-ACCOUNT HANDOVER CALLS (MOTIR-12130), over the seam's fakes: a
// tenant account whose CloudFormation holds real deploys made through the AWS
// adapter, and whose IAM refuses a call the way AWS would — by the session that
// makes it. Each call is run twice: the second must answer the same and write
// nothing.

const ORG = 'cmorg1';
const RID = 'cmrepo1';
const OTHER = 'cmrepo2';
const ACCOUNT = '210987654321';
const MANAGEMENT = '111122223333';
const REGION = 'us-east-1';
const T0 = new Date('2026-11-23T00:00:00Z');
const PRODUCTION: HostingEnvironment = { kind: 'production' };
const preview = (pullRequest: number): HostingEnvironment => ({ kind: 'preview', pullRequest });

function harness() {
  const clock = { t: T0.getTime() };
  const now = () => new Date(clock.t);
  const clients = createFakeTenantClients({ accountId: ACCOUNT, region: REGION, now });
  clients.cloudformation.pollsToSettle = 0;
  const sleep = async (ms: number) => {
    clock.t += ms;
  };
  const deps: AwsHostingDeps = {
    clientsFor: () => clients,
    region: REGION,
    ensureTenantAccount: async () => ({ ready: true, accountId: ACCOUNT }),
    organizationOf: async () => ORG,
    isCustomerRepository: async () => false,
    githubIdsOf: async () => ({ githubRepositoryId: '7001', githubOwnerId: '9002' }),
    forwarderPrincipalArn: 'arn:aws:iam::576360162297:role/motir-hosting-forwarder',
    originSecretKey: 'origin-key',
    now,
    sleep,
    pollMs: 5_000,
    timeoutMs: 600_000,
  };
  const port = createAwsHostingDeployPort(deps);
  const memberSessions: TenantIam[] = [];
  const handoverDeps: TenantHandoverDeps = {
    clientsFor: () => clients,
    memberIamFor: () => {
      const session = clients.iamAccount.session(AWS_MEMBER_ROLE_NAME);
      memberSessions.push(session);
      return session;
    },
    region: REGION,
    managementAccountId: MANAGEMENT,
    options: { now, sleep, pollMs: 5_000, timeoutMs: 600_000 },
  };
  const handover = createTenantHandover(handoverDeps);
  return { port, clients, handover, handoverDeps, memberSessions, now, sleep };
}
type Harness = ReturnType<typeof harness>;

function release(
  appRef: string,
  environment: HostingEnvironment,
  shape: ReleaseShape,
): DeployReleaseInput {
  return {
    appRef,
    environment,
    shape,
    artifact: { kind: 'image', ref: 'release-1', digest: 'sha256:aaa' },
    runtime: {
      port: 3000,
      healthCheck: { path: '/healthz' },
      startCommand: 'node server.js',
      database: { kind: 'postgres' },
    },
    env: [],
    size: 'medium',
    idle: shape === 'function' ? { mode: 'suspend', idleSeconds: 300 } : { mode: 'always_on' },
  };
}

/** A production release with its database, registry and the network, plus two
 *  previews (a function and a container), each with its preview database. */
async function deployed(): Promise<Harness> {
  const h = harness();
  await h.port.deploy(release(`mh-${RID}`, PRODUCTION, 'function'));
  await h.port.deploy(release(`mh-${RID}-pr4`, preview(4), 'function'));
  await h.port.deploy(release(`mh-${RID}-pr7`, preview(7), 'container'));
  return h;
}

const stackNames = (h: Harness) => [...h.clients.cloudformation.stacks.keys()].sort();
const deletes = (h: Harness) =>
  h.clients.cloudformation.calls.filter((c) => c.startsWith('deleteStack:'));
const templates = (h: Harness, names: readonly string[]) =>
  Object.fromEntries(names.map((n) => [n, h.clients.cloudformation.stacks.get(n)!.templateBody]));

const PREVIEW_STACKS = [
  `motir-database-${RID}-pr4`,
  `motir-database-${RID}-pr7`,
  `motir-release-mh-${RID}-pr4`,
  `motir-release-mh-${RID}-pr7`,
];
const PRODUCTION_STACKS = [
  `motir-database-${RID}`,
  'motir-network',
  `motir-registry-${RID}`,
  `motir-release-mh-${RID}`,
];

describe('destroyPreviewStacks', () => {
  it('deletes exactly the four preview stacks, each database before its release', async () => {
    const h = await deployed();
    expect(stackNames(h)).toEqual([...PRODUCTION_STACKS, ...PREVIEW_STACKS].sort());
    const before = templates(h, PRODUCTION_STACKS);
    h.clients.cloudformation.calls.length = 0;

    const answer = await h.handover.destroyPreviewStacks(ACCOUNT);

    expect(stackNames(h)).toEqual(PRODUCTION_STACKS);
    expect(templates(h, PRODUCTION_STACKS)).toEqual(before);
    expect(answer).toEqual({ kept: PRODUCTION_STACKS });
    const order = deletes(h);
    expect(order).toEqual([
      `deleteStack:motir-database-${RID}-pr4`,
      `deleteStack:motir-release-mh-${RID}-pr4`,
      `deleteStack:motir-database-${RID}-pr7`,
      `deleteStack:motir-release-mh-${RID}-pr7`,
    ]);
    // The preview databases were dropped on the production cluster first.
    expect(h.clients.rdsData.databases.has(`mh_${RID}_pr4`)).toBe(false);
  });

  it('deletes nothing on a second call and answers the same set', async () => {
    const h = await deployed();
    const first = await h.handover.destroyPreviewStacks(ACCOUNT);
    h.clients.cloudformation.calls.length = 0;
    const second = await h.handover.destroyPreviewStacks(ACCOUNT);
    expect(second).toEqual(first);
    expect(deletes(h)).toEqual([]);
    expect(h.clients.cloudformation.calls.filter((c) => /^(create|update)Stack:/.test(c))).toEqual(
      [],
    );
  });

  it('finishes a teardown cut off after a preview database went', async () => {
    const h = await deployed();
    // The first preview's release delete never lands.
    h.clients.cloudformation.failAt('deleteStack', 2, 'before');
    await expect(h.handover.destroyPreviewStacks(ACCOUNT)).rejects.toBeInstanceOf(
      HandoverPreviewDestroyError,
    );
    // The other preview was still destroyed; the cut one is resumed.
    expect(stackNames(h)).toContain(`motir-release-mh-${RID}-pr4`);
    expect(stackNames(h)).not.toContain(`motir-release-mh-${RID}-pr7`);
    expect(await h.handover.destroyPreviewStacks(ACCOUNT)).toEqual({ kept: PRODUCTION_STACKS });
    expect(stackNames(h)).toEqual(PRODUCTION_STACKS);
  });

  it('names each preview it could not destroy by app ref and AWS code only', async () => {
    const h = await deployed();
    h.clients.cloudformation.failAt('deleteStack', 1, 'before');
    h.clients.cloudformation.failAt('deleteStack', 2, 'before');
    const err = await h.handover.destroyPreviewStacks(ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HandoverPreviewDestroyError);
    expect((err as HandoverPreviewDestroyError).failed).toEqual([
      { appRef: `mh-${RID}-pr4`, reason: 'InjectedFault' },
      { appRef: `mh-${RID}-pr7`, reason: 'InjectedFault' },
    ]);
  });

  it('carries a failure that is not an AWS one by its code', async () => {
    const h = await deployed();
    const failing = {
      ...h.handoverDeps,
      clientsFor: () => ({
        ...h.clients,
        ssm: {
          ...h.clients.ssm,
          getParameter: async () => {
            throw Object.assign(new Error('boom'), { code: 'SSM_DOWN' });
          },
        },
      }),
    };
    // A container preview destroy reads its usage; the release of pr4 is a
    // function and does not, so only pr7 fails.
    (h.clients.cloudformation.stacks as Map<string, unknown>).delete(`motir-release-mh-${RID}-pr7`);
    const err = await createTenantHandover(failing)
      .destroyPreviewStacks(ACCOUNT)
      .catch((e: unknown) => e);
    expect((err as HandoverPreviewDestroyError).failed).toEqual([
      { appRef: `mh-${RID}-pr7`, reason: 'SSM_DOWN' },
    ]);
  });

  it('never deletes a name that fails to parse, a production release or the app database', async () => {
    const h = harness();
    const tags = { 'motir:organization': ORG, 'motir:repository': RID };
    for (const name of [
      'motir-release-not_an_app',
      'motir-release-mh-cmrepo9',
      'motir-release-mh-cmrepo9-pr0',
      `motir-database-cmrepo9`,
      'motir-database-cmrepo9-prx',
      'someone-elses-stack',
    ]) {
      await h.clients.cloudformation.createStack({
        name,
        templateBody: 'x',
        parameters: {},
        tags,
      });
      await h.clients.cloudformation.describeStack(name);
    }
    h.clients.cloudformation.calls.length = 0;
    const answer = await h.handover.destroyPreviewStacks(ACCOUNT);
    expect(deletes(h)).toEqual([]);
    expect(answer.kept).toEqual([
      'motir-database-cmrepo9',
      'motir-database-cmrepo9-prx',
      'motir-release-mh-cmrepo9',
      'motir-release-mh-cmrepo9-pr0',
      'motir-release-not_an_app',
    ]);
  });

  it('selects previews by parsing the name', () => {
    expect(previewAppRefOfStack('motir-release-mh-abc-pr3')).toBe('mh-abc-pr3');
    expect(previewAppRefOfStack('motir-database-abc-pr3')).toBe('mh-abc-pr3');
    expect(previewAppRefOfStack('motir-release-mh-abc')).toBeNull();
    expect(previewAppRefOfStack('motir-release-mh-ABC-pr3')).toBeNull();
    expect(previewAppRefOfStack('motir-database-abc')).toBeNull();
    expect(previewAppRefOfStack('motir-registry-abc')).toBeNull();
  });
});

describe('destroyAwsPreview (the adapter’s single-preview destroy, exported)', () => {
  it('refuses a production app ref before any call', async () => {
    const h = await deployed();
    const account = {
      organizationId: ORG,
      clients: h.clients,
      runner: awsReleaseRunner(h.clients),
    };
    h.clients.cloudformation.calls.length = 0;
    await expect(destroyAwsPreview(account, `mh-${RID}`)).rejects.toBeInstanceOf(
      NotAPreviewAppRefError,
    );
    expect(h.clients.cloudformation.calls).toEqual([]);
  });
});

const REPOS = [
  { repositoryId: OTHER, githubRepositoryId: '8002' },
  { repositoryId: RID, githubRepositoryId: '7001' },
];
const DEST_OWNER = '5550001';

describe('createHandoverDeployRole', () => {
  it('trusts only the GitHub provider, the sts audience and each repository at the destination owner', async () => {
    const h = harness();
    const answer = await h.handover.createHandoverDeployRole(ACCOUNT, {
      destinationOwnerId: DEST_OWNER,
      repositories: REPOS,
    });
    expect(answer).toEqual({
      roleName: HANDOVER_DEPLOY_ROLE,
      roleArn: `arn:aws:iam::${ACCOUNT}:role${HANDOVER_DEPLOY_ROLE_PATH}${HANDOVER_DEPLOY_ROLE}`,
    });
    const role = h.clients.iamAccount.roles.get(HANDOVER_DEPLOY_ROLE)!;
    expect(role.trust.Statement).toHaveLength(1);
    const [statement] = role.trust.Statement as Array<Record<string, unknown>>;
    expect(statement!['Principal']).toEqual({
      Federated: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
    });
    expect(statement!['Action']).toBe('sts:AssumeRoleWithWebIdentity');
    expect(statement!['Condition']).toEqual({
      StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
      StringLike: {
        'token.actions.githubusercontent.com:sub': [
          `repository_owner_id:${DEST_OWNER}:repository_id:7001:*`,
          `repository_owner_id:${DEST_OWNER}:repository_id:8002:*`,
        ],
      },
    });
    // No AWS account principal, no Motir role, no other repository.
    const text = JSON.stringify(role.trust);
    expect(text).not.toContain(MANAGEMENT);
    expect(text).not.toMatch(/"AWS"/);
    expect(text).not.toMatch(/role\/motir-/);
    expect(namesMotir(statement!, MANAGEMENT)).toBe(false);
    // Built on the deploy role's session.
    expect(
      h.clients.iamAccount.calls.every((c) => c.startsWith(`${AWS_TENANT_DEPLOY_ROLE}:`)),
    ).toBe(true);
  });

  it('changes nothing on a second call with the same input, in any order', async () => {
    const h = harness();
    const input = { destinationOwnerId: DEST_OWNER, repositories: REPOS };
    const first = await h.handover.createHandoverDeployRole(ACCOUNT, input);
    const writes = h.clients.iamAccount.writes.length;
    const second = await h.handover.createHandoverDeployRole(ACCOUNT, {
      ...input,
      repositories: [...REPOS].reverse(),
    });
    expect(second).toEqual(first);
    expect(h.clients.iamAccount.writes.length).toBe(writes);
  });

  it('replaces the trust and the policy of a role that differs', async () => {
    const h = harness();
    await h.handover.createHandoverDeployRole(ACCOUNT, {
      destinationOwnerId: DEST_OWNER,
      repositories: [REPOS[1]!],
    });
    h.clients.iamAccount.writes.length = 0;
    await h.handover.createHandoverDeployRole(ACCOUNT, {
      destinationOwnerId: DEST_OWNER,
      repositories: REPOS,
    });
    expect(h.clients.iamAccount.writes).toEqual([
      `${AWS_TENANT_DEPLOY_ROLE}:updateAssumeRolePolicy:${HANDOVER_DEPLOY_ROLE}`,
      `${AWS_TENANT_DEPLOY_ROLE}:putRolePolicy:${HANDOVER_DEPLOY_ROLE}/${HANDOVER_DEPLOY_POLICY}`,
    ]);
  });

  it('refuses a role of that name it did not make', async () => {
    const h = harness();
    h.clients.iamAccount.putRole(HANDOVER_DEPLOY_ROLE, {
      trust: fakeAwsTrust('arn:aws:iam::1:root'),
    });
    await expect(
      h.handover.createHandoverDeployRole(ACCOUNT, {
        destinationOwnerId: DEST_OWNER,
        repositories: REPOS,
      }),
    ).rejects.toBeInstanceOf(HandoverRoleConflictError);
  });

  it.each([
    [{ destinationOwnerId: 'acme', repositories: REPOS }, 'destinationOwnerId'],
    [{ destinationOwnerId: DEST_OWNER, repositories: [] }, 'repositories'],
    [
      {
        destinationOwnerId: DEST_OWNER,
        repositories: [{ repositoryId: 'Bad', githubRepositoryId: '1' }],
      },
      'repositoryId',
    ],
    [
      {
        destinationOwnerId: DEST_OWNER,
        repositories: [{ repositoryId: RID, githubRepositoryId: 'acme/app' }],
      },
      'githubRepositoryId',
    ],
  ])('refuses an input that is not ids (%#)', async (input, field) => {
    const h = harness();
    const err = await h.handover.createHandoverDeployRole(ACCOUNT, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HandoverInputInvalidError);
    expect((err as HandoverInputInvalidError).field).toBe(field);
    expect(h.clients.iamAccount.calls).toEqual([]);
  });

  it('answers the role ARN it made when a read after the create finds nothing', async () => {
    const h = harness();
    const iam = h.clients.iam;
    let reads = 0;
    const deps = {
      ...h.handoverDeps,
      clientsFor: () => ({
        ...h.clients,
        iam: {
          ...iam,
          getRole: async (name: string) =>
            reads++ === 0 ? null : iam.getRole(name).then(() => null),
        },
      }),
    };
    const answer = await createTenantHandover(deps).createHandoverDeployRole(ACCOUNT, {
      destinationOwnerId: DEST_OWNER,
      repositories: REPOS,
    });
    expect(answer.roleArn).toBe(
      `arn:aws:iam::${ACCOUNT}:role${HANDOVER_DEPLOY_ROLE_PATH}${HANDOVER_DEPLOY_ROLE}`,
    );
  });
});

describe('the handover deploy policy', () => {
  const policy = handoverDeployPolicy(ACCOUNT, REGION, [RID]);
  const statements = policy.Statement as Array<{ Action: string[]; Resource: string[] }>;

  it('has no * resource and no iam:* action', () => {
    for (const statement of statements) {
      for (const resource of statement.Resource) {
        expect(resource).not.toBe('*');
        expect(resource).toContain(ACCOUNT);
      }
      for (const action of statement.Action) expect(action).not.toMatch(/^iam:\*|^\*$/);
    }
  });

  it('reaches only the repository’s production resources, never a preview', () => {
    const resources = statements.flatMap((s) => s.Resource);
    for (const resource of resources) expect(resource).toContain(RID);
    expect(resources.some((r) => /-pr\d|\/preview/.test(r))).toBe(false);
  });

  it('is the document the role carries', async () => {
    const h = harness();
    await h.handover.createHandoverDeployRole(ACCOUNT, {
      destinationOwnerId: DEST_OWNER,
      repositories: [REPOS[1]!],
    });
    expect(
      h.clients.iamAccount.roles.get(HANDOVER_DEPLOY_ROLE)!.inline.get(HANDOVER_DEPLOY_POLICY),
    ).toEqual(policy);
  });
});

/** An account Motir has been running: its fleet roles, a release role whose
 *  trust also names the management account, a customer role, a push role and
 *  a service-linked role. */
function lived(h: Harness) {
  const account = h.clients.iamAccount;
  account.putRole(AWS_RUNNER_IAM_ROLE, {
    trust: fakeAwsTrust(`arn:aws:iam::${MANAGEMENT}:role/motir-org-admin`),
    inline: new Map([['motir-fleet-runner-ec2', { Version: '2012-10-17', Statement: [] }]]),
  });
  const indexPolicy = account.putPolicy('motir-index-pull', '/');
  account.putRole(AWS_INDEX_IAM_ROLE, {
    trust: {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' },
      ],
    },
    attached: new Set([indexPolicy]),
    instanceProfiles: new Set([AWS_INDEX_IAM_ROLE]),
  });
  account.putRole('motir-mh-cmrepo1-fn', {
    trust: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
        { Effect: 'Allow', Principal: { AWS: MANAGEMENT }, Action: 'sts:AssumeRole' },
      ],
    },
    inline: new Map([['run', { Version: '2012-10-17', Statement: [] }]]),
  });
  account.putRole('motir-debug', {
    trust: fakeAwsTrust(`arn:aws:iam::999988887777:role/motir-tenant-deploy`),
    inline: new Map([['debug', { Version: '2012-10-17', Statement: [] }]]),
  });
  account.putRole('customer-ops', {
    trust: fakeAwsTrust(`arn:aws:iam::${ACCOUNT}:root`),
    attached: new Set([FAKE_ADMINISTRATOR_ACCESS_ARN]),
  });
  account.putRole('AWSServiceRoleForECS', {
    path: '/aws-service-role/ecs.amazonaws.com/',
    trust: fakeAwsTrust(`arn:aws:iam::${MANAGEMENT}:root`),
  });
}

describe('removeMotirAccess', () => {
  it('leaves no Motir role or policy, no trust naming Motir, and a powerless member role', async () => {
    const h = harness();
    lived(h);
    await h.handover.createHandoverDeployRole(ACCOUNT, {
      destinationOwnerId: DEST_OWNER,
      repositories: REPOS,
    });
    const answer = await h.handover.removeMotirAccess(ACCOUNT);
    expect(answer).toEqual({ outcome: 'removed', memberRole: AWS_MEMBER_ROLE_NAME });

    const roles = h.clients.iamAccount.roles;
    for (const gone of [AWS_TENANT_DEPLOY_ROLE, AWS_RUNNER_IAM_ROLE, AWS_INDEX_IAM_ROLE]) {
      expect(roles.has(gone), gone).toBe(false);
    }
    expect(h.clients.iamAccount.instanceProfiles.has(AWS_INDEX_IAM_ROLE)).toBe(false);
    expect(
      [...h.clients.iamAccount.policies.values()].filter((p) =>
        p.path.startsWith(AWS_TENANT_DEPLOY_POLICY_PATH),
      ),
    ).toEqual([]);
    for (const [name, role] of roles) {
      if (role.path.startsWith('/aws-service-role/')) continue;
      for (const statement of role.trust.Statement) {
        expect(namesMotir(statement, MANAGEMENT), name).toBe(false);
      }
    }
    // The release role keeps Lambda's trust; the role that trusted only Motir
    // now trusts the account's root.
    expect(roles.get('motir-mh-cmrepo1-fn')!.trust.Statement).toEqual([
      { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
    ]);
    expect(roles.get('motir-debug')!.trust).toEqual(accountRootTrust(ACCOUNT));
    expect(roles.get('customer-ops')!.attached.size).toBe(1);
    expect(roles.has(HANDOVER_DEPLOY_ROLE)).toBe(true);

    const member = roles.get(AWS_MEMBER_ROLE_NAME)!;
    expect(member.trust).toEqual(accountRootTrust(ACCOUNT));
    expect(member.inline.size).toBe(0);
    expect(member.attached.size).toBe(0);
    // The member role's last detach was the session's last write.
    expect(h.clients.iamAccount.writes.at(-1)).toBe(
      `${AWS_MEMBER_ROLE_NAME}:detachRolePolicy:${AWS_MEMBER_ROLE_NAME}/${FAKE_ADMINISTRATOR_ACCESS_ARN}`,
    );
  });

  it('answers the same on a second call and writes nothing', async () => {
    const h = harness();
    lived(h);
    const first = await h.handover.removeMotirAccess(ACCOUNT);
    const writes = h.clients.iamAccount.writes.length;
    const second = await h.handover.removeMotirAccess(ACCOUNT);
    expect(second).toEqual(first);
    expect(h.clients.iamAccount.writes.length).toBe(writes);
  });

  it('makes each call on a session still allowed to make it — the member role is stripped last', async () => {
    const h = harness();
    lived(h);
    const member = h.clients.iamAccount.roles.get(AWS_MEMBER_ROLE_NAME)!;
    member.inline.set('extra', { Version: '2012-10-17', Statement: [] });
    await h.handover.removeMotirAccess(ACCOUNT);
    // The member session made every call, and none was refused.
    const calls = h.clients.iamAccount.calls;
    expect(calls.every((c) => c.startsWith(`${AWS_MEMBER_ROLE_NAME}:`))).toBe(true);
    const firstMemberWrite = h.clients.iamAccount.writes.findIndex((w) =>
      w.includes(`:${AWS_MEMBER_ROLE_NAME}`),
    );
    const lastOtherWrite = h.clients.iamAccount.writes.findLastIndex(
      (w) => !w.includes(`:${AWS_MEMBER_ROLE_NAME}`),
    );
    expect(firstMemberWrite).toBeGreaterThan(lastOtherWrite);
  });

  it('cannot strip in another order: the fake refuses a call on a stripped role', async () => {
    const h = harness();
    lived(h);
    const iam = h.clients.iamAccount.session(AWS_MEMBER_ROLE_NAME);
    await iam.detachRolePolicy(AWS_MEMBER_ROLE_NAME, FAKE_ADMINISTRATOR_ACCESS_ARN);
    await expect(iam.deleteRole(AWS_RUNNER_IAM_ROLE)).rejects.toMatchObject({
      awsCode: 'AccessDenied',
    });
  });

  it('the deploy role cannot delete itself, which is why the member role does it', async () => {
    const h = harness();
    await expect(h.clients.iam.deleteRole(AWS_TENANT_DEPLOY_ROLE)).rejects.toMatchObject({
      awsCode: 'AccessDenied',
    });
    await expect(h.clients.iam.listRoles()).rejects.toMatchObject({ awsCode: 'AccessDenied' });
    await expect(h.clients.iam.getRole('customer-ops')).rejects.toMatchObject({
      awsCode: 'AccessDenied',
    });
  });

  it('resumes a removal cut off at every step and reaches the same end', async () => {
    const baseline = harness();
    lived(baseline);
    await baseline.handover.removeMotirAccess(ACCOUNT);
    const total = baseline.clients.iamAccount.writes.length;
    for (let cut = 1; cut <= total; cut += 1) {
      const h = harness();
      lived(h);
      const account = h.clients.iamAccount;
      // Cut the run off right after its `cut`th write lands.
      let seen = 0;
      const original = account.writes.push.bind(account.writes);
      account.writes.push = (...items: string[]) => {
        const n = original(...items);
        seen += items.length;
        if (seen === cut) throw new AwsTenantApiError('iam', 'InjectedFault', null);
        return n;
      };
      await h.handover.removeMotirAccess(ACCOUNT).catch(() => undefined);
      account.writes.push = original;
      expect(await h.handover.removeMotirAccess(ACCOUNT), `cut at ${cut}`).toEqual({
        outcome: 'removed',
        memberRole: AWS_MEMBER_ROLE_NAME,
      });
      expect(account.roles.get(AWS_MEMBER_ROLE_NAME)!.trust, `cut at ${cut}`).toEqual(
        accountRootTrust(ACCOUNT),
      );
    }
  });

  it('treats an AccessDenied on the final strip as done once a fresh session is refused', async () => {
    // Without the fleet roles, the deploy role's four detaches come first and
    // the member role's own detach is the fifth.
    const h = harness();
    h.clients.iamAccount.failAt('detachRolePolicy', 1, 'after', 'AccessDenied');
    // On the deploy role's detach (step 2) an AccessDenied is a real failure.
    await expect(h.handover.removeMotirAccess(ACCOUNT)).rejects.toMatchObject({
      awsCode: 'AccessDenied',
    });
    // On the member role's own detach it is the closed role: done.
    const g = harness();
    g.clients.iamAccount.failAt('detachRolePolicy', 5, 'after', 'AccessDenied');
    expect(await g.handover.removeMotirAccess(ACCOUNT)).toEqual({
      outcome: 'removed',
      memberRole: AWS_MEMBER_ROLE_NAME,
    });
    expect(g.clients.iamAccount.roles.get(AWS_MEMBER_ROLE_NAME)!.attached.size).toBe(0);
  });

  it('does not call a refused strip done while a fresh member session still opens', async () => {
    const h = harness();
    // A fresh member session is one on another account where the role still
    // trusts Motir: the closed-out probe opens it, so the refusal stands.
    const elsewhere = createFakeTenantIamAccount({
      accountId: ACCOUNT,
      managementAccountId: MANAGEMENT,
    });
    seedFakeTenantIam(elsewhere);
    let calls = 0;
    const deps: TenantHandoverDeps = {
      ...h.handoverDeps,
      memberIamFor: () =>
        calls++ === 0
          ? h.clients.iamAccount.session(AWS_MEMBER_ROLE_NAME)
          : elsewhere.session(AWS_MEMBER_ROLE_NAME),
    };
    h.clients.iamAccount.failAt('detachRolePolicy', 5, 'before', 'AccessDenied');
    await expect(createTenantHandover(deps).removeMotirAccess(ACCOUNT)).rejects.toMatchObject({
      awsCode: 'AccessDenied',
    });
  });

  it('does not call an unassumable member role done while the deploy role still opens', async () => {
    const h = harness();
    // A member role that never trusted Motir, with the deploy role intact.
    h.clients.iamAccount.roles.get(AWS_MEMBER_ROLE_NAME)!.trust = accountRootTrust(ACCOUNT);
    const err = await h.handover.removeMotirAccess(ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenantRoleUnavailableError);
    expect((err as TenantRoleUnavailableError).roleName).toBe(AWS_MEMBER_ROLE_NAME);
    expect(h.clients.iamAccount.roles.has(AWS_TENANT_DEPLOY_ROLE)).toBe(true);
  });

  it('rethrows a probe failure that is not a closed role', async () => {
    const h = harness();
    h.clients.iamAccount.roles.get(AWS_MEMBER_ROLE_NAME)!.trust = accountRootTrust(ACCOUNT);
    const deps: TenantHandoverDeps = {
      ...h.handoverDeps,
      clientsFor: () => ({
        ...h.clients,
        iam: {
          ...h.clients.iam,
          getRole: async () => {
            throw new AwsTenantApiError('iam', 'Throttling', 400);
          },
        },
      }),
    };
    await expect(createTenantHandover(deps).removeMotirAccess(ACCOUNT)).rejects.toMatchObject({
      awsCode: 'Throttling',
    });
  });
});

describe('what the handover may never touch', () => {
  // The criterion: no method takes, stores, logs or returns a payment detail or
  // a root credential. Every log line and error the new files write, read as text.
  const files = ['src/adapters/aws/tenant/handover.ts'].map((f) =>
    readFileSync(join(__dirname, '..', f), 'utf8'),
  );
  const managementText = readFileSync(
    join(__dirname, '..', 'src/adapters/aws/management.ts'),
    'utf8',
  );
  const handoverManagement = managementText.slice(
    managementText.indexOf('async startPrimaryEmailUpdate'),
    managementText.indexOf('async assumeMemberRole'),
  );
  const FORBIDDEN =
    /payment|\bcard\b|iban|billing|root(Password|Credential|AccessKey)|accessKeyId|secretAccessKey|password|\botp\b|\bcode\b|email/i;

  it('names no payment or root-credential field in a log or error call', () => {
    const calls = [...files, handoverManagement].flatMap((text) =>
      [
        ...text.matchAll(/(?:\blog\(|options\.log\?\.\(|new \w+Error\(|toApiError\()([^;]*?)\)/g),
      ].map((m) => m[1]!),
    );
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) expect(call).not.toMatch(FORBIDDEN);
  });
});
