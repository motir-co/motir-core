import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AwsManagementApiError,
  FAKE_MANAGEMENT_ACCOUNT_ID,
  HANDOVER_DEPLOY_ROLE,
  OrchestratorNotConfiguredError,
  TenantRoleUnavailableError,
  createAwsManagementApi,
  createTenantClients,
  createTenantMemberIam,
  handoverDeployTrust,
} from '@motir/orchestrator';
import {
  FAKE_AWS_ORG_ADMIN_ROLE_ARN,
  FAKE_AWS_TENANT_STATE_PATH_ENV,
  armFakeAwsTenantFailure,
  fakeAwsTenantClients,
  fakeAwsTenantManagementApi,
  fakeAwsTenantMemberIam,
  fakeAwsTenantStatePath,
  installFakeAwsTenantSeam,
  readFakeAwsTenantState,
  seedFakeAwsTenantAccount,
  uninstallFakeAwsTenantSeam,
} from '@/lib/test-fake-aws-tenant';
import {
  failTenantOperationOnce,
  handoverRoleSubjects,
  markTenantStandaloneDone,
  openedUpstreamOf,
  readTenantAccount,
  readTenantEmailCode,
  resetTakeoverTenant,
  rolesTrusting,
  seedTakeoverTenant,
  tenantCalls,
} from './e2e/_helpers/takeover-handover';

// The acceptance lane's fake AWS tenant (Story MOTIR-9800 · MOTIR-12141): one
// state file standing in for an AWS account the takeover hands over, shared by
// the webServer, the job worker and the spec. Two client bundles over one file
// stand for two processes; the refusals are the in-package fakes' own.

const ACCOUNT = '210987654321';
const REGION = 'us-east-1';
const target = { accountId: ACCOUNT, region: REGION };
let statePath: string;

beforeEach(() => {
  statePath = join(mkdtempSync(join(tmpdir(), 'fake-aws-tenant-')), 'tenant.json');
  vi.stubEnv(FAKE_AWS_TENANT_STATE_PATH_ENV, statePath);
});

afterEach(() => {
  uninstallFakeAwsTenantSeam();
  vi.unstubAllEnvs();
});

function seed(): string[] {
  return seedTakeoverTenant({
    accountId: ACCOUNT,
    primaryEmail: 'motir-tenant@example.com',
    apps: [
      { repositoryId: 'cmrepoa', shape: 'function', previewPullRequest: 3 },
      { repositoryId: 'cmrepob', shape: 'container' },
    ],
  });
}

describe('the fake AWS tenant’s CloudFormation', () => {
  it('lists the seeded stacks in every process, and a delete in one is gone in the others', async () => {
    const seeded = seed();
    expect(seeded).toContain('motir-release-mh-cmrepoa-pr3');
    const server = fakeAwsTenantClients(target);
    const worker = fakeAwsTenantClients(target);
    expect((await server.cloudformation.listStacks()).map((s) => s.name)).toEqual(seeded);

    await worker.cloudformation.deleteStack('motir-release-mh-cmrepoa-pr3');
    expect(await server.cloudformation.describeStack('motir-release-mh-cmrepoa-pr3')).toMatchObject(
      { status: 'DELETE_IN_PROGRESS' },
    );
    // The next describe settles it, in another process again.
    expect(await worker.cloudformation.describeStack('motir-release-mh-cmrepoa-pr3')).toBeNull();
    expect(readTenantAccount(ACCOUNT)!.stacks.map((s) => s.name)).not.toContain(
      'motir-release-mh-cmrepoa-pr3',
    );
  });

  it('creates and updates a stack, settling over polls, and reads its template', async () => {
    seed();
    const cf = fakeAwsTenantClients(target).cloudformation;
    const write = { name: 'motir-network', templateBody: 'T1', parameters: {}, tags: {} };
    await cf.createStack(write);
    expect((await cf.describeStack('motir-network'))!.status).toBe('CREATE_IN_PROGRESS');
    const settled = await cf.describeStack('motir-network');
    expect(settled).toMatchObject({ status: 'CREATE_COMPLETE', outputs: { VpcId: 'vpc-fake' } });
    expect(settled!.createdAt).toBeInstanceOf(Date);
    expect(await cf.getTemplateBody('motir-network')).toBe('T1');
    expect(await cf.updateStack({ ...write, templateBody: 'T2' })).toBe('updating');
    await cf.describeStack('motir-network');
    expect(await cf.describeStack('motir-network')).toMatchObject({ status: 'UPDATE_COMPLETE' });
    expect(await cf.updateStack({ ...write, templateBody: 'T2' })).toBe('no_change');
    await expect(cf.createStack(write)).rejects.toMatchObject({
      awsCode: 'AlreadyExistsException',
    });
  });

  it('refuses every call into an unknown account, or once Motir’s deploy role is gone', async () => {
    const stranger = fakeAwsTenantClients({ accountId: '999999999999', region: REGION });
    await expect(stranger.cloudformation.listStacks()).rejects.toBeInstanceOf(
      TenantRoleUnavailableError,
    );
    seed();
    const member = fakeAwsTenantMemberIam(target);
    for (const arn of (await member.listAttachedRolePolicies('motir-tenant-deploy')).map(
      (p) => p.arn,
    )) {
      await member.detachRolePolicy('motir-tenant-deploy', arn);
    }
    await member.deleteRole('motir-tenant-deploy');
    await expect(fakeAwsTenantClients(target).cloudformation.listStacks()).rejects.toBeInstanceOf(
      TenantRoleUnavailableError,
    );
  });
});

describe('the fake AWS tenant’s IAM', () => {
  it('creates the handover deploy role with its trust, read back by the helper', async () => {
    seed();
    const iam = fakeAwsTenantMemberIam(target);
    const trust = handoverDeployTrust(ACCOUNT, {
      destinationOwnerId: '42',
      repositories: [
        { repositoryId: 'cmrepoa', githubRepositoryId: '7' },
        { repositoryId: 'cmrepob', githubRepositoryId: '8' },
      ],
    });
    await iam.createRole({
      name: HANDOVER_DEPLOY_ROLE,
      path: '/motir-handover/',
      trust,
      description: 'handover',
      maxSessionSeconds: 3600,
      tags: {},
    });
    await iam.putRolePolicy(HANDOVER_DEPLOY_ROLE, 'deploy', {
      Version: '2012-10-17',
      Statement: [],
    });
    expect(await iam.listRolePolicies(HANDOVER_DEPLOY_ROLE)).toEqual(['deploy']);
    expect(handoverRoleSubjects(ACCOUNT)).toEqual([
      'repository_owner_id:42:repository_id:7:*',
      'repository_owner_id:42:repository_id:8:*',
    ]);
    expect(await fakeAwsTenantMemberIam(target).getRole(HANDOVER_DEPLOY_ROLE)).toMatchObject({
      path: '/motir-handover/',
    });
  });

  it('holds the deploy role to its scope, as the in-package fake does', async () => {
    seed();
    const deploy = fakeAwsTenantClients(target).iam;
    await expect(deploy.deleteRole('OrganizationAccountAccessRole')).rejects.toMatchObject({
      awsCode: 'AccessDenied',
    });
    expect(await deploy.getRole('motir-x')).toBeNull();
  });

  it('shows which roles still trust the management account', async () => {
    seed();
    expect(rolesTrusting(ACCOUNT, FAKE_MANAGEMENT_ACCOUNT_ID)).toEqual([
      'OrganizationAccountAccessRole',
      'motir-tenant-deploy',
    ]);
    const member = fakeAwsTenantMemberIam(target);
    await member.updateAssumeRolePolicy('OrganizationAccountAccessRole', {
      Version: '2012-10-17',
      Statement: [],
    });
    expect(rolesTrusting(ACCOUNT, FAKE_MANAGEMENT_ACCOUNT_ID)).toEqual(['motir-tenant-deploy']);
    expect(handoverRoleSubjects(ACCOUNT)).toEqual([]);
    expect(handoverRoleSubjects('000000000000')).toEqual([]);
  });
});

describe('the fake AWS tenant’s management account', () => {
  it('moves the primary email only after the code it mailed is accepted', async () => {
    seed();
    const api = fakeAwsTenantManagementApi();
    expect(await api.getPrimaryEmailUpdateStatus(ACCOUNT)).toBeNull();
    expect(readTenantEmailCode(ACCOUNT)).toBeNull();
    expect(await api.acceptPrimaryEmailUpdate(ACCOUNT, 'owner@example.com', '000000')).toEqual({
      outcome: 'code_refused',
      reason: 'ResourceNotFoundException',
    });
    expect(await api.startPrimaryEmailUpdate(ACCOUNT, 'owner@example.com')).toEqual({
      status: 'PENDING',
    });
    const code = readTenantEmailCode(ACCOUNT)!;
    expect(code).toMatch(/^\d{6}$/);
    expect(await api.getPrimaryEmailUpdateStatus(ACCOUNT)).toMatchObject({ status: 'PENDING' });
    const wrong = code === '000000' ? '111111' : '000000';
    expect(await api.acceptPrimaryEmailUpdate(ACCOUNT, 'owner@example.com', wrong)).toMatchObject({
      outcome: 'code_refused',
      reason: 'ValidationException',
    });
    expect(await api.acceptPrimaryEmailUpdate(ACCOUNT, 'other@example.com', code)).toMatchObject({
      outcome: 'code_refused',
    });
    expect(await api.getPrimaryEmail(ACCOUNT)).toBe('motir-tenant@example.com');

    expect(await api.acceptPrimaryEmailUpdate(ACCOUNT, ' Owner@example.com', code)).toEqual({
      outcome: 'accepted',
      status: 'ACCEPTED',
    });
    expect(await api.getPrimaryEmail(ACCOUNT)).toBe('owner@example.com');
    expect(await api.getPrimaryEmailUpdateStatus(ACCOUNT)).toMatchObject({ status: 'ACCEPTED' });
    expect(await api.getPrimaryEmailUpdateStatus(ACCOUNT)).toMatchObject({ status: 'COMPLETED' });
    expect(readTenantAccount(ACCOUNT)).toMatchObject({ emailUpdateStatus: 'COMPLETED' });
  });

  it('answers not_ready with the missing steps until the standalone steps are done, then removes', async () => {
    seed();
    const api = fakeAwsTenantManagementApi();
    expect(await api.readStandaloneReadiness(ACCOUNT)).toMatchObject({
      inOrganization: true,
      waitPeriod: { status: 'not_met' },
      delegatedAdministrator: { status: 'met' },
      ready: false,
    });
    expect(await api.removeAccountFromOrganization(ACCOUNT)).toEqual({
      outcome: 'not_ready',
      missing: ['wait_period', 'payment_method', 'support_plan', 'contact_information'],
    });
    markTenantStandaloneDone(ACCOUNT);
    expect(await api.readStandaloneReadiness(ACCOUNT)).toMatchObject({ ready: null });
    expect(await api.removeAccountFromOrganization(ACCOUNT)).toEqual({ outcome: 'removed' });
    expect(readTenantAccount(ACCOUNT)!.inOrganization).toBe(false);
    // A replayed removal answers removed, and readiness says it is outside.
    expect(await api.removeAccountFromOrganization(ACCOUNT)).toEqual({ outcome: 'removed' });
    expect(await api.readStandaloneReadiness(ACCOUNT)).toMatchObject({
      inOrganization: false,
      ready: null,
    });
  });

  it('names a delegated administration as missing', async () => {
    seed();
    const state = readFakeAwsTenantState();
    state.accounts[ACCOUNT]!.organization.standalone = {
      waitPeriodMet: true,
      delegatedServices: ['guardduty.amazonaws.com'],
      unreadableMet: true,
    };
    writeFileSync(statePath, JSON.stringify(state));
    const api = fakeAwsTenantManagementApi();
    expect(await api.readStandaloneReadiness(ACCOUNT)).toMatchObject({
      delegatedAdministrator: { status: 'not_met', services: ['guardduty.amazonaws.com'] },
      ready: false,
    });
    expect(await api.removeAccountFromOrganization(ACCOUNT)).toEqual({
      outcome: 'not_ready',
      missing: ['delegated_administrator'],
    });
  });

  it('refuses an unknown account, and every call it does not fake', async () => {
    const api = fakeAwsTenantManagementApi();
    await expect(api.getPrimaryEmail('000000000000')).rejects.toBeInstanceOf(AwsManagementApiError);
    await expect(api.assumeRunnerRole('000000000000')).rejects.toBeInstanceOf(
      OrchestratorNotConfiguredError,
    );
  });
});

describe('the fake AWS tenant’s failures and call log', () => {
  it('fails a named operation once, in any service, then succeeds', async () => {
    seed();
    const clients = fakeAwsTenantClients(target);
    const api = fakeAwsTenantManagementApi();
    failTenantOperationOnce('cloudformation.listStacks');
    armFakeAwsTenantFailure('iam.getRole');
    armFakeAwsTenantFailure('management.removeAccountFromOrganization');
    await expect(clients.cloudformation.listStacks()).rejects.toThrow(/InjectedFault:listStacks/);
    await expect(clients.cloudformation.listStacks()).resolves.toHaveLength(8);
    await expect(clients.iam.getRole('motir-x')).rejects.toThrow(/InjectedFault/);
    await expect(clients.iam.getRole('motir-x')).resolves.toBeNull();
    await expect(api.removeAccountFromOrganization(ACCOUNT)).rejects.toThrow(/InjectedFault/);
    await expect(api.removeAccountFromOrganization(ACCOUNT)).resolves.toMatchObject({
      outcome: 'not_ready',
    });
  });

  it('logs every construction and every change, per account, with when', async () => {
    seed();
    const start = new Date();
    const clients = fakeAwsTenantClients(target);
    await clients.cloudformation.listStacks();
    await clients.cloudformation.deleteStack('motir-database-cmrepoa-pr3');
    fakeAwsTenantMemberIam(target);
    await fakeAwsTenantManagementApi().startPrimaryEmailUpdate(ACCOUNT, 'o@example.com');
    const calls = tenantCalls(ACCOUNT, start);
    expect(calls.map((c) => `${c.kind}:${c.as}:${c.operation}:${c.target}`)).toEqual([
      `construct:deploy:session:${ACCOUNT}`,
      'operation:deploy:cloudformation.deleteStack:motir-database-cmrepoa-pr3',
      `construct:member:session:${ACCOUNT}`,
      `operation:management:management.startPrimaryEmailUpdate:${ACCOUNT}`,
    ]);
    expect(tenantCalls(ACCOUNT, new Date(Date.now() + 60_000))).toEqual([]);
    expect(tenantCalls('000000000000')).toEqual([]);
  });
});

describe('the fake AWS tenant’s seam and file', () => {
  it('stands behind the shipped factories once installed', async () => {
    seed();
    installFakeAwsTenantSeam();
    const management = createAwsManagementApi({ roleArn: FAKE_AWS_ORG_ADMIN_ROLE_ARN });
    expect(await management.getPrimaryEmail(ACCOUNT)).toBe('motir-tenant@example.com');
    const clients = createTenantClients({ management, ...target });
    expect(await clients.cloudformation.listStacks()).toHaveLength(8);
    const member = createTenantMemberIam({ management, ...target });
    expect(await member.getRole('OrganizationAccountAccessRole')).not.toBeNull();
  });

  it('reads a missing or torn file as no accounts, and resets everything', async () => {
    expect(readFakeAwsTenantState()).toEqual({ accounts: {}, calls: [] });
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, '{"accounts": {');
    expect(readFakeAwsTenantState()).toEqual({ accounts: {}, calls: [] });
    seed();
    failTenantOperationOnce('iam.getRole');
    resetTakeoverTenant();
    expect(readTenantAccount(ACCOUNT)).toBeNull();
    seed();
    await expect(fakeAwsTenantMemberIam(target).getRole('x')).resolves.toBeNull();
    // A torn failure sidecar arms nothing.
    writeFileSync(`${statePath}.fail.json`, '{"operations": [');
    await expect(fakeAwsTenantMemberIam(target).getRole('x')).resolves.toBeNull();
  });

  it('refuses a key that reaches Object.prototype, and is off without the variable', () => {
    expect(() =>
      seedFakeAwsTenantAccount({ accountId: '__proto__', primaryEmail: 'x@example.com' }),
    ).toThrow(/not a fake AWS tenant key/);
    vi.stubEnv(FAKE_AWS_TENANT_STATE_PATH_ENV, ' ');
    expect(fakeAwsTenantStatePath()).toBeNull();
    expect(() => readFakeAwsTenantState()).toThrow(/is off/);
    expect(() => seed()).toThrow(/run under the acceptance lane/);
  });
});

describe('openedUpstreamOf', () => {
  it('reads the address the fake hosting port opened an AWS app at', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const { hostingFakeControls, resetHostingFakes } = await import('@/lib/orchestrator/hosting');
    resetHostingFakes();
    const fake = hostingFakeControls('aws');
    const { appRef } = await fake.ensureApp({
      repositoryId: 'cmrepoa',
      environment: { kind: 'production' },
    });
    expect(openedUpstreamOf(appRef)).toBeNull();
    expect(openedUpstreamOf('mh-none')).toBeNull();
    const handle = await fake.deploy({
      appRef,
      environment: { kind: 'production' },
      artifact: { kind: 'image', ref: 'img', digest: 'sha256:1' },
      runtime: {
        port: 8080,
        healthCheck: { path: '/h' },
        startCommand: '/x',
        database: { kind: 'none' },
      },
      env: [],
      idle: { mode: 'always_on' },
      shape: 'container',
    });
    await fake.openUpstream(handle);
    expect(openedUpstreamOf(appRef)).toBe(`https://${appRef}.alb.fake.invalid`);
    resetHostingFakes();
  });
});
