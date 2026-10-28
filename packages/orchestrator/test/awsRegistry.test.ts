import { describe, expect, it } from 'vitest';
import {
  AWS_REGISTRY_DEPLOY_ACTIONS,
  GithubRepositoryIdsMissingError,
  RegistryNameInvalidError,
  RegistryNotReadyError,
  createFakeTenantCloudFormation,
  createStackRunner,
  ensureRegistry,
  parseRegistryPushNamespace,
  readTenantStackTemplate,
  registryDeployCredential,
  registryImageReference,
  registryNames,
  registryPushNamespace,
  type FakeCloudFormationOperation,
  type GithubRepositoryIdLookup,
} from '../src/index';

// The artifact registry of a repository in its tenant account (MOTIR-10006),
// over the seam's stack runner and fake CloudFormation.

const RID = 'cmrepo1';
const ORG = 'cmorg1';
const ACCOUNT = { accountId: '210987654321', region: 'us-east-1' };
const IDS = { githubRepositoryId: '123456', githubOwnerId: '7890' };
const lookup: GithubRepositoryIdLookup = async (rid) => (rid === RID ? IDS : null);

/** The fake's outputs as the real registry stack names them. */
function registryOutputs(_name: string, p: Readonly<Record<string, string>>) {
  const arn = (env: string) =>
    `arn:aws:iam::${ACCOUNT.accountId}:role/mh-${p['RepositoryId']}-${env}-push`;
  const uri = (env: string) =>
    `${ACCOUNT.accountId}.dkr.ecr.us-east-1.amazonaws.com/mh/${p['RepositoryId']}/${env}`;
  return {
    PreviewRepositoryUri: uri('preview'),
    ProductionRepositoryUri: uri('production'),
    PreviewPushRoleArn: arn('preview'),
    ProductionPushRoleArn: arn('production'),
  };
}

function setup() {
  const cfn = createFakeTenantCloudFormation({ outputs: registryOutputs });
  cfn.pollsToSettle = 0;
  const runner = createStackRunner(cfn, { sleep: async () => undefined });
  return { cfn, runner };
}

describe('registry names', () => {
  it('gives each repository its own two repositories, two roles and a motir- stack', () => {
    expect(registryNames(RID)).toEqual({
      stackName: 'motir-registry-cmrepo1',
      repositories: { preview: 'mh/cmrepo1/preview', production: 'mh/cmrepo1/production' },
      pushRoles: { preview: 'mh-cmrepo1-preview-push', production: 'mh-cmrepo1-production-push' },
    });
    const other = registryNames('cmrepo2');
    const all = [registryNames(RID), other].flatMap((n) => [
      n.stackName,
      ...Object.values(n.repositories),
      ...Object.values(n.pushRoles),
    ]);
    expect(new Set(all).size).toBe(all.length);
    // The longest role name stays within IAM's 64 characters.
    expect(registryNames('c'.repeat(25)).pushRoles.production.length).toBeLessThanOrEqual(64);
  });

  it.each(['CmRepo', 'cm-repo', 'cm/../x', '', 'cm repo'])('refuses %j before any call', (bad) => {
    expect(() => registryNames(bad)).toThrow(RegistryNameInvalidError);
  });

  it('round-trips both push namespaces and refuses any other string', () => {
    for (const env of ['preview', 'production'] as const) {
      expect(parseRegistryPushNamespace(registryPushNamespace(RID, env))).toEqual({
        repositoryId: RID,
        environment: env,
      });
    }
    for (const bad of ['mh-cmrepo1-pv', 'mh/cmrepo1/staging', 'mh/CM/preview', 'x/mh/a/preview']) {
      expect(() => parseRegistryPushNamespace(bad)).toThrow(RegistryNameInvalidError);
    }
  });
});

describe('ensureRegistry', () => {
  it('applies registry.yaml once, tagged, with the repository and GitHub ids as parameters', async () => {
    const { cfn, runner } = setup();
    const record = await ensureRegistry({ runner, organizationId: ORG, repositoryId: RID, lookup });
    const stack = cfn.stacks.get('motir-registry-cmrepo1')!;
    expect(stack.templateBody).toBe(readTenantStackTemplate('registry.yaml'));
    expect(stack.tags).toEqual({ 'motir:organization': ORG, 'motir:repository': RID });
    expect(stack.parameters).toEqual({
      OrganizationId: ORG,
      RepositoryId: RID,
      GithubRepositoryId: '123456',
      GithubOwnerId: '7890',
    });
    // No parameter carries the repository's owner or name.
    expect(Object.keys(stack.parameters).join()).not.toMatch(/Name|Owner(?!Id)/);
    expect(record.outputs['ProductionPushRoleArn']).toContain('mh-cmrepo1-production-push');

    cfn.calls.length = 0;
    await ensureRegistry({ runner, organizationId: ORG, repositoryId: RID, lookup });
    expect(cfn.calls.filter((c) => /create|update/.test(c))).toEqual([]);
    expect(cfn.stacks.size).toBe(1);
  });

  it.each([
    ['no ids', async () => null],
    ['a non-numeric repository id', async () => ({ ...IDS, githubRepositoryId: 'octo/repo' })],
    ['a non-numeric owner id', async () => ({ ...IDS, githubOwnerId: 'octo' })],
  ])('refuses %s before any AWS call', async (_label, ids: GithubRepositoryIdLookup) => {
    const { cfn, runner } = setup();
    await expect(
      ensureRegistry({ runner, organizationId: ORG, repositoryId: RID, lookup: ids }),
    ).rejects.toBeInstanceOf(GithubRepositoryIdsMissingError);
    expect(cfn.calls).toEqual([]);
  });

  it('resumed after a cut-off at each call, ends with exactly one registry stack', async () => {
    const clean = setup();
    await ensureRegistry({ runner: clean.runner, organizationId: ORG, repositoryId: RID, lookup });
    const operations = [...new Set(clean.cfn.calls.map((c) => c.split(':')[0]))];
    for (const operation of operations) {
      const count = clean.cfn.calls.filter((c) => c.startsWith(`${operation}:`)).length;
      for (let n = 1; n <= count; n += 1) {
        for (const when of ['before', 'after'] as const) {
          const run = setup();
          run.cfn.failAt(operation as FakeCloudFormationOperation, n, when);
          const input = { runner: run.runner, organizationId: ORG, repositoryId: RID, lookup };
          await ensureRegistry(input).catch(() => undefined);
          await ensureRegistry(input);
          expect([...run.cfn.stacks.keys()]).toEqual(['motir-registry-cmrepo1']);
          // One create landed; a create refused before it acted is the only retry.
          const refusedCreate = operation === 'createStack' && when === 'before';
          expect(run.cfn.calls.filter((c) => c.startsWith('createStack')).length).toBe(
            refusedCreate ? 2 : 1,
          );
        }
      }
    }
  });
});

describe('the image reference and the push credential', () => {
  it('names the image by digest, or by tag', () => {
    expect(
      registryImageReference({
        account: ACCOUNT,
        repositoryName: 'mh/cmrepo1/production',
        digest: 'sha256:abc',
      }),
    ).toBe('210987654321.dkr.ecr.us-east-1.amazonaws.com/mh/cmrepo1/production@sha256:abc');
    expect(
      registryImageReference({
        account: ACCOUNT,
        repositoryName: 'mh/cmrepo1/preview',
        tag: 'pr7',
      }),
    ).toBe('210987654321.dkr.ecr.us-east-1.amazonaws.com/mh/cmrepo1/preview:pr7');
    expect(
      registryImageReference({ account: ACCOUNT, repositoryName: 'mh/cmrepo1/preview' }),
    ).toMatch(/:latest$/);
  });

  it('federates to the namespace’s own role only, read from the stack', async () => {
    const { runner } = setup();
    await ensureRegistry({ runner, organizationId: ORG, repositoryId: RID, lookup });
    const preview = await registryDeployCredential({
      runner,
      pushNamespace: 'mh/cmrepo1/preview',
    });
    expect(preview).toEqual({
      kind: 'federated',
      pushNamespace: 'mh/cmrepo1/preview',
      subject: 'arn:aws:iam::210987654321:role/mh-cmrepo1-preview-push',
    });
    const production = await registryDeployCredential({
      runner,
      pushNamespace: 'mh/cmrepo1/production',
    });
    expect(production.kind === 'federated' && production.subject).toBe(
      'arn:aws:iam::210987654321:role/mh-cmrepo1-production-push',
    );
    expect(JSON.stringify(preview)).not.toContain('production');
  });

  it('refuses a namespace whose registry stack does not exist yet', async () => {
    const { runner } = setup();
    await expect(
      registryDeployCredential({ runner, pushNamespace: 'mh/cmrepo9/preview' }),
    ).rejects.toBeInstanceOf(RegistryNotReadyError);
  });

  it('asks the deploy role for no authorization token', () => {
    expect(AWS_REGISTRY_DEPLOY_ACTIONS).not.toContain('ecr:GetAuthorizationToken');
    expect(AWS_REGISTRY_DEPLOY_ACTIONS).toEqual(
      expect.arrayContaining(['ecr:CreateRepository', 'iam:CreateRole', 'iam:PutRolePolicy']),
    );
  });
});
