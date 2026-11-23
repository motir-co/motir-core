// The takeover handover's wiring (Story MOTIR-9800 · MOTIR-12131): the GitHub
// account-id read the deploy role binds, the handover's configured AWS reach,
// the lookup that lets `openUpstream` reach a handing-over account, the
// production configuration withdrawn before the transfer, the job, and the
// typed errors' messages. Rows against the real database; GitHub a stubbed fetch.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestratorNotConfiguredError, ReleaseNotFoundError } from '@motir/orchestrator';
import { RepositoryOwnerIdApiError, githubAccountIdOfLogin } from '@/lib/github/repositoryOwnerId';
import { repositoryActionsConfigClient } from '@/lib/github/repositoryActionsConfig';
import {
  HandoverNothingToRetryError,
  HandoverStepNotWaitingError,
} from '@/lib/hosting/tenantHandoverErrors';
import {
  HOSTING_TARGET_VARIABLE,
  PRODUCTION_ENVIRONMENT,
  PRODUCTION_IMAGE_VARIABLE,
  PRODUCTION_PUSH_TOKEN_SECRET,
} from '@/lib/hosting/productionEnablementNames';
import { hostingTenantHandoverAdvance } from '@/lib/jobs/definitions/hostingTenantHandoverAdvance';
import { jobDefinitions } from '@/lib/jobs/registry';
import { jobServices } from '@/lib/jobs/services';
import { accountIdOfRoleArn, createConfiguredAwsHandover } from '@/lib/orchestrator/awsHosting';
import { awsHostingLookupService } from '@/lib/services/awsHostingLookupService';
import { productionRepositoryConfigService } from '@/lib/services/productionRepositoryConfigService';
import { tenantAccountHandoverService } from '@/lib/services/tenantAccountHandoverService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { ACCOUNT, seedHandoverWorld } from '../helpers/tenantHandoverFixtures';

vi.mock('@/lib/github/orgTarget', () => ({
  resolveOrgAuth: async () => ({ org: 'motir-hosted', installationId: '1', token: 'ghs_never' }),
}));

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await adminDb.$disconnect();
});

describe('githubAccountIdOfLogin', () => {
  const stubFetch = (impl: () => Promise<Response>) => {
    const fetch = vi.fn((_url: string, _init?: RequestInit) => impl());
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('reads the numeric id of a user or organisation by login', async () => {
    const fetch = stubFetch(async () => Response.json({ id: 880001, login: 'acme-co' }));
    expect(await githubAccountIdOfLogin('acme co')).toBe('880001');
    expect(String(fetch.mock.calls[0]![0])).toBe('https://api.github.com/users/acme%20co');
  });

  it.each([
    ['unreachable', async () => Promise.reject(new Error('ECONNRESET'))],
    ['unreachable without an Error', async () => Promise.reject('down')],
    ['a refusal', async () => new Response('nope', { status: 404 })],
    ['a non-JSON body', async () => new Response('<html>', { status: 200 })],
    ['no numeric id', async () => Response.json({ id: 'x' })],
    ['a null body', async () => Response.json(null)],
  ])('throws the typed error for %s, never the token', async (_, impl) => {
    stubFetch(impl);
    const error = await githubAccountIdOfLogin('acme-co').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RepositoryOwnerIdApiError);
    expect(String((error as Error).message)).not.toContain('ghs_never');
  });
});

describe('the configured AWS reach', () => {
  it('reads the management account out of the management role ARN', () => {
    expect(accountIdOfRoleArn('arn:aws:iam::111122223333:role/motir-org-admin')).toBe(
      '111122223333',
    );
    expect(accountIdOfRoleArn('arn:aws-us-gov:iam::111122223333:role/x')).toBe('111122223333');
    expect(() => accountIdOfRoleArn('motir-org-admin')).toThrow(OrchestratorNotConfiguredError);
  });

  it('builds the handover, the management calls and the open-upstream door from configuration', () => {
    vi.stubEnv('MOTIR_HOSTING_AWS_FORWARDER_PRINCIPAL_ARN', 'arn:aws:iam::1:role/forwarder');
    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::111122223333:role/motir-org-admin');
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const reach = createConfiguredAwsHandover('origin-key');
    expect(typeof reach.handover.destroyPreviewStacks).toBe('function');
    expect(typeof reach.handover.removeMotirAccess).toBe('function');
    expect(typeof reach.management.readStandaloneReadiness).toBe('function');
    expect(typeof reach.openUpstream).toBe('function');
  });

  it('opens through the adapter, asking for a handing-over account first', async () => {
    vi.stubEnv('MOTIR_HOSTING_AWS_FORWARDER_PRINCIPAL_ARN', 'arn:aws:iam::1:role/forwarder');
    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::111122223333:role/motir-org-admin');
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    // An organisation with no account yet: neither reach finds one, and no AWS
    // call is made before the refusal.
    const world = await seedHandoverWorld();
    await adminDb.hostingTenantAccount.delete({ where: { id: world.tenantAccountId } });
    const asked = vi.spyOn(awsHostingLookupService, 'handoverAccountOf');
    const reach = createConfiguredAwsHandover('origin-key');
    await expect(
      reach.openUpstream({
        target: 'aws',
        appRef: `mh-${world.repos[0]!.id}`,
        environment: { kind: 'production' },
        releaseId: 'r',
        providerRef: '',
      }),
    ).rejects.toBeInstanceOf(ReleaseNotFoundError);
    expect(asked).toHaveBeenCalledWith(world.organizationId);
  });
});

describe('awsHostingLookupService.handoverAccountOf', () => {
  it('answers the account id only while the handover holds the account', async () => {
    const world = await seedHandoverWorld();
    const read = () => awsHostingLookupService.handoverAccountOf(world.organizationId);
    expect(await read()).toBeNull();
    await adminDb.hostingTenantAccount.update({
      where: { id: world.tenantAccountId },
      data: { state: 'handing_over' },
    });
    expect(await read()).toBe(ACCOUNT);
    expect(await awsHostingLookupService.handoverAccountOf('org-with-no-account')).toBeNull();
  });
});

describe('productionRepositoryConfigService.removeFromRepository', () => {
  it('withdraws the production credential, then the image and target variables', async () => {
    const world = await seedHandoverWorld();
    const row = await adminDb.projectRepo.findUniqueOrThrow({
      where: { id: world.repos[0]!.id },
      include: { githubRepo: true },
    });
    const calls: string[] = [];
    vi.spyOn(repositoryActionsConfigClient, 'deleteEnvironmentSecret').mockImplementation(
      async (coordinates, environment, name) => {
        calls.push(`secret:${coordinates.installationId}:${environment}:${name}`);
        return 'deleted';
      },
    );
    vi.spyOn(repositoryActionsConfigClient, 'deleteVariable').mockImplementation(
      async (coordinates, name) => {
        calls.push(`variable:${coordinates.owner}/${coordinates.repo}:${name}`);
        return 'absent';
      },
    );
    await productionRepositoryConfigService.removeFromRepository({
      id: row.id,
      githubRepo: {
        installationId: row.githubRepo!.installationId,
        owner: row.githubRepo!.owner,
        name: row.githubRepo!.name,
      },
    });
    expect(calls).toEqual([
      `secret:556677:${PRODUCTION_ENVIRONMENT}:${PRODUCTION_PUSH_TOKEN_SECRET}`,
      `variable:motir-projects/shop:${PRODUCTION_IMAGE_VARIABLE}`,
      `variable:motir-projects/shop:${HOSTING_TARGET_VARIABLE}`,
    ]);
  });

  it('does nothing for a row with no realized repository', async () => {
    const del = vi.spyOn(repositoryActionsConfigClient, 'deleteVariable');
    await productionRepositoryConfigService.removeFromRepository({ id: 'r', githubRepo: null });
    expect(del).not.toHaveBeenCalled();
  });
});

describe('the advance job', () => {
  it('is registered and runs one turn of the handover in its memoized step', async () => {
    expect(jobDefinitions).toContain(hostingTenantHandoverAdvance);
    expect(jobServices.tenantAccountHandover).toBe(tenantAccountHandoverService);
    const advance = vi
      .spyOn(tenantAccountHandoverService, 'advance')
      .mockResolvedValue({ outcome: 'complete' });
    const run = vi.fn(async (_id: string, fn: () => unknown) => fn());
    const ctx = {
      event: {
        name: 'hosting.tenant-handover.advance',
        data: { tenantAccountId: 'acct-1', workspaceId: null },
        id: 'e',
      },
      runId: 'run',
      attempt: 0,
      step: { run },
    } as unknown as Parameters<typeof hostingTenantHandoverAdvance.handler>[0];
    await expect(hostingTenantHandoverAdvance.handler(ctx, jobServices)).resolves.toEqual({
      outcome: 'complete',
    });
    expect(run).toHaveBeenCalledWith('advance-tenant-handover', expect.any(Function));
    expect(advance).toHaveBeenCalledWith('acct-1');
  });
});

describe('the typed errors say where the handover is', () => {
  it('names the current step, or that the handover is complete', () => {
    const at = { step: 'move_email' as const, status: 'pending' };
    expect(new HandoverStepNotWaitingError('a', ['move_email'], at).message).toContain(
      'move_email, pending',
    );
    expect(new HandoverStepNotWaitingError('a', ['move_email'], null).message).toContain(
      'complete',
    );
    expect(new HandoverNothingToRetryError('a', at).message).toContain('move_email, pending');
    expect(new HandoverNothingToRetryError('a', null).message).toContain('complete');
  });
});
