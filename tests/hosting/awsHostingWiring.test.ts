// MOTIR-10010 — what the AWS hosting adapter asks Motir, wired: the repository
// row's organisation, whether it is a customer repository, its GitHub ids, and
// the tenant account answer; plus the GitHub owner-id read. Against the real
// database for the rows; GitHub is a stubbed fetch.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CustomerRepositoryRefusedError,
  GithubRepositoryIdsMissingError,
} from '@motir/orchestrator';
import { TENANT_ACCOUNT_REGION } from '@/lib/ciFleet/hostingTenantAccounts';
import { RepositoryOwnerIdApiError, githubRepositoryOwnerId } from '@/lib/github/repositoryOwnerId';
import { createConfiguredAwsHostingPort } from '@/lib/orchestrator/awsHosting';
import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  HostingRepositoryNotFoundError,
  awsHostingLookupService,
} from '@/lib/services/awsHostingLookupService';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

vi.mock('@/lib/github/orgTarget', () => ({
  resolveOrgAuth: async () => ({ org: 'motir-hosted', installationId: '1', token: 'ghs_never' }),
}));

let seq = 0;

async function seedRepo(seedSource: string, githubRepoId?: string) {
  seq += 1;
  const fx = await makeWorkItemFixture({ name: `Hosting ${seq}` });
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: fx.workspaceId },
    select: { organizationId: true },
  });
  let realized: { id: string } | null = null;
  if (githubRepoId) {
    const installation = await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        accountLogin: 'motir-hosted',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    realized = await adminDb.githubRepo.create({
      data: {
        installationId: installation.id,
        workspaceId: fx.workspaceId,
        organizationId,
        repoId: githubRepoId,
        owner: 'motir-hosted',
        name: `repo-${seq}`,
        defaultBranch: 'main',
        archived: false,
        provider: 'github',
      },
    });
  }
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      position: 'a0',
      name: `repo-${seq}`,
      seedSource,
      ...(realized ? { githubRepoId: realized.id } : {}),
    },
  });
  return { organizationId, repositoryId: row.id };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('awsHostingLookupService', () => {
  it("answers a Motir repository's organisation, not a customer's, and its GitHub ids", async () => {
    const { organizationId, repositoryId } = await seedRepo('blank', '7001');

    expect(await awsHostingLookupService.organizationOf(repositoryId)).toBe(organizationId);
    expect(await awsHostingLookupService.isCustomerRepository(repositoryId)).toBe(false);
    expect(
      await awsHostingLookupService.githubIdsOf(repositoryId, { ownerIdOf: async () => '9002' }),
    ).toEqual({ githubRepositoryId: '7001', githubOwnerId: '9002' });
  });

  it('calls a repository seeded from the organisation a customer repository', async () => {
    const { repositoryId } = await seedRepo('organization');
    expect(await awsHostingLookupService.isCustomerRepository(repositoryId)).toBe(true);
    expect(await awsHostingLookupService.githubIdsOf(repositoryId)).toBeNull();
  });

  it('refuses a repository row that does not exist', async () => {
    await expect(awsHostingLookupService.organizationOf('cmnope')).rejects.toBeInstanceOf(
      HostingRepositoryNotFoundError,
    );
  });

  it("asks for the organisation's tenant account and answers it is not ready yet", async () => {
    const { organizationId } = await seedRepo('blank');
    expect(await awsHostingLookupService.ensureTenantAccount(organizationId)).toEqual({
      ready: false,
      accountId: null,
    });
    expect(await adminDb.hostingTenantAccount.count({ where: { organizationId } })).toBe(1);
  });
});

describe('githubRepositoryOwnerId', () => {
  const stubFetch = (impl: () => Promise<Response>) => {
    const fetch = vi.fn((_url: string, _init?: RequestInit) => impl());
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('reads the owner id by the immutable repository id', async () => {
    const fetch = stubFetch(async () => Response.json({ owner: { id: 9002 } }));
    expect(await githubRepositoryOwnerId('7001')).toBe('9002');
    expect(String(fetch.mock.calls[0]![0])).toBe('https://api.github.com/repositories/7001');
  });

  it.each([
    ['unreachable', async () => Promise.reject(new Error('ECONNRESET'))],
    ['a refusal', async () => new Response('nope', { status: 404 })],
    ['a non-JSON body', async () => new Response('<html>', { status: 200 })],
    ['no owner id', async () => Response.json({ owner: {} })],
  ])('throws the typed error for %s, never the token', async (_, impl) => {
    stubFetch(impl);
    const error = await githubRepositoryOwnerId('7001').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RepositoryOwnerIdApiError);
    expect(String((error as Error).message)).not.toContain('ghs_never');
  });
});

describe('createConfiguredAwsHostingPort', () => {
  function configured() {
    vi.stubEnv('MOTIR_HOSTING_AWS_FORWARDER_PRINCIPAL_ARN', 'arn:aws:iam::1:role/forwarder');
    vi.stubEnv('MOTIR_HOSTING_AWS_APP_DOMAIN', 'apps.motir.test');
    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::1:role/motir-org-admin');
    vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', '');
    vi.stubEnv('AWS_ORG_ADMIN_SECRET_ACCESS_KEY', '');
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    return createConfiguredAwsHostingPort('origin-key');
  }

  it('reaches the rows through the lookups: a customer is refused, a new org waits', async () => {
    const port = configured();
    const customer = await seedRepo('organization');
    await expect(
      port.ensureApp({ repositoryId: customer.repositoryId, environment: { kind: 'production' } }),
    ).rejects.toBeInstanceOf(CustomerRepositoryRefusedError);

    const motir = await seedRepo('blank');
    expect(
      await port.ensureApp({
        repositoryId: motir.repositoryId,
        environment: { kind: 'production' },
      }),
    ).toEqual({
      appRef: `mh-${motir.repositoryId}`,
      pushNamespace: `mh/${motir.repositoryId}/production`,
    });
    expect(
      await adminDb.hostingTenantAccount.count({
        where: { organizationId: motir.organizationId },
      }),
    ).toBe(1);
  });

  it('builds tenant clients for a ready account and refuses a repository with no GitHub repository before any AWS call', async () => {
    const port = configured();
    const { organizationId, repositoryId } = await seedRepo('blank');
    await withSystemContext(async (tx) => {
      await hostingTenantAccountRepository.ensureRequestedInTx(
        organizationId,
        TENANT_ACCOUNT_REGION,
        tx,
      );
      await hostingTenantAccountRepository.recordAccountInTx(
        organizationId,
        '400000000901',
        'ou-1',
        tx,
      );
      await hostingTenantAccountRepository.setStateInTx(organizationId, 'ready', tx);
    });

    await expect(
      port.ensureApp({ repositoryId, environment: { kind: 'production' } }),
    ).rejects.toBeInstanceOf(GithubRepositoryIdsMissingError);
  });
});
