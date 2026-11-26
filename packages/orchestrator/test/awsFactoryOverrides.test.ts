import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_HOSTING_STATE_PATH_ENV,
  OrchestratorApiError,
  awsManagementOverride,
  awsTenantClientsOverride,
  createAwsManagementApi,
  createFakeHostingDeployPort,
  createFakeTenantClients,
  createTenantClients,
  createTenantMemberIam,
  setAwsManagementOverrideForTests,
  setAwsTenantClientsOverrideForTests,
  type AwsManagementApi,
  type DeployReleaseInput,
  type ReleaseHandle,
} from '../src/index';

// The AWS factories' test overrides and the fake hosting port's `openUpstream`
// (Story MOTIR-9800 · MOTIR-12141): an E2E lane installs a fake behind the
// SHIPPED factories, so whatever composition calls them gets it; unset, the
// factories build the real SDK clients as before.

afterEach(() => {
  setAwsManagementOverrideForTests(null);
  setAwsTenantClientsOverrideForTests(null);
  vi.unstubAllEnvs();
});

const ROLE = { roleArn: 'arn:aws:iam::111122223333:role/motir-org-admin' };

describe('the AWS factory overrides', () => {
  it('createAwsManagementApi answers the override, given the credentials, while one is installed', () => {
    const fake = { getPrimaryEmail: async () => 'x' } as unknown as AwsManagementApi;
    const seen: unknown[] = [];
    setAwsManagementOverrideForTests((credentials) => {
      seen.push(credentials);
      return fake;
    });
    expect(createAwsManagementApi(ROLE)).toBe(fake);
    expect(seen).toEqual([ROLE]);
    expect(awsManagementOverride()).not.toBeNull();
  });

  it('createAwsManagementApi builds the real API with no override', () => {
    expect(awsManagementOverride()).toBeNull();
    const real = createAwsManagementApi(ROLE);
    expect(typeof real.removeAccountFromOrganization).toBe('function');
    expect(real).not.toHaveProperty('then');
  });

  it('the tenant factories, the member-role variant included, answer the override', () => {
    const clients = createFakeTenantClients({ accountId: '210987654321' });
    const targets: unknown[] = [];
    setAwsTenantClientsOverrideForTests({
      clients: (target) => {
        targets.push(['clients', target]);
        return clients;
      },
      memberIam: (target) => {
        targets.push(['member', target]);
        return clients.iamAccount.session('OrganizationAccountAccessRole');
      },
    });
    const management = createAwsManagementApi(ROLE);
    expect(
      createTenantClients({ management, accountId: '210987654321', region: 'us-east-1' }),
    ).toBe(clients);
    const iam = createTenantMemberIam({
      management,
      accountId: '210987654321',
      region: 'eu-west-1',
    });
    expect(typeof iam.getRole).toBe('function');
    expect(targets).toEqual([
      ['clients', { accountId: '210987654321', region: 'us-east-1' }],
      ['member', { accountId: '210987654321', region: 'eu-west-1' }],
    ]);
    expect(awsTenantClientsOverride()).not.toBeNull();
  });

  it('the tenant factories build the real SDK clients with no override', () => {
    const management = createAwsManagementApi(ROLE);
    const clients = createTenantClients({
      management,
      accountId: '210987654321',
      region: 'us-east-1',
    });
    expect(clients.accountId).toBe('210987654321');
    expect(clients).not.toHaveProperty('iamAccount');
    const iam = createTenantMemberIam({
      management,
      accountId: '210987654321',
      region: 'us-east-1',
    });
    expect(typeof iam.deleteRole).toBe('function');
  });

  it('one install reaches every copy of the package: the hook is a process global', () => {
    const fake = {} as AwsManagementApi;
    setAwsManagementOverrideForTests(() => fake);
    const hook = (globalThis as Record<symbol, unknown>)[
      Symbol.for('motir.orchestrator.aws.managementOverride')
    ];
    expect(typeof hook).toBe('function');
  });
});

function release(appRef: string, shape: 'function' | 'container'): DeployReleaseInput {
  return {
    appRef,
    environment: { kind: 'production' },
    artifact: { kind: 'image', ref: 'img', digest: 'sha256:1' },
    runtime: {
      port: 8080,
      healthCheck: { path: '/health' },
      startCommand: '/whoami',
      database: { kind: 'none' },
    },
    env: [],
    idle: { mode: 'always_on' },
    shape,
  };
}

describe('the fake hosting port’s openUpstream', () => {
  it('opens a live release at its shape’s address, the same on a repeat, in every process', async () => {
    vi.stubEnv(
      FAKE_HOSTING_STATE_PATH_ENV,
      join(mkdtempSync(join(tmpdir(), 'fake-open-')), 'hosting.json'),
    );
    const worker = createFakeHostingDeployPort({ target: 'aws', shareAcrossProcesses: true });
    const server = createFakeHostingDeployPort({ target: 'aws', shareAcrossProcesses: true });
    const { appRef } = await worker.ensureApp({
      repositoryId: 'r1',
      environment: { kind: 'production' },
    });
    const handle = await worker.deploy(release(appRef, 'function'));
    const opened = await server.openUpstream(handle);
    expect(opened).toEqual({ upstreamAddress: `https://${appRef}.lambda-url.fake.invalid` });
    expect(await worker.openUpstream(handle)).toEqual(opened);
    expect(worker.app(appRef)?.openedUpstream).toBe(opened.upstreamAddress);
  });

  it('opens a container release at its own host, and an overridden origin where one is set', async () => {
    const port = createFakeHostingDeployPort({ target: 'aws' });
    const { appRef } = await port.ensureApp({
      repositoryId: 'r2',
      environment: { kind: 'production' },
    });
    const handle = await port.deploy(release(appRef, 'container'));
    expect((await port.openUpstream(handle)).upstreamAddress).toBe(
      `https://${appRef}.alb.fake.invalid`,
    );

    const other = createFakeHostingDeployPort({ target: 'aws' });
    const { appRef: ref3 } = await other.ensureApp({
      repositoryId: 'r3',
      environment: { kind: 'production' },
    });
    const h3 = await other.deploy(release(ref3, 'function'));
    other.setUpstream(ref3, 'http://127.0.0.1:4567/path');
    expect((await other.openUpstream(h3)).upstreamAddress).toBe('http://127.0.0.1:4567');
  });

  it('fails once when armed, and refuses an app with nothing to open', async () => {
    const port = createFakeHostingDeployPort({ target: 'aws' });
    const { appRef } = await port.ensureApp({
      repositoryId: 'r4',
      environment: { kind: 'production' },
    });
    const missing: ReleaseHandle = {
      target: 'aws',
      appRef: 'mh-none',
      environment: { kind: 'production' },
      releaseId: 'x',
      providerRef: '',
    };
    await expect(port.openUpstream(missing)).rejects.toBeInstanceOf(OrchestratorApiError);
    await expect(port.openUpstream({ ...missing, appRef })).rejects.toThrow(/no live release/);
    const handle = await port.deploy(release(appRef, 'function'));
    port.failNext('openUpstream', 'boom');
    await expect(port.openUpstream(handle)).rejects.toThrow(/boom/);
    await expect(port.openUpstream(handle)).resolves.toMatchObject({
      upstreamAddress: expect.any(String),
    });
  });
});
