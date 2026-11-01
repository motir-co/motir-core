import type { AwsTenantAccountAnswer, GithubRepositoryIds } from '@motir/orchestrator';
import { githubRepositoryOwnerId } from '@/lib/github/repositoryOwnerId';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { hostingTenantAccountService } from '@/lib/services/hostingTenantAccountService';
import { withSystemContext } from '@/lib/workspaces/context';

// WHAT THE AWS HOSTING ADAPTER ASKS MOTIR (Story MOTIR-9794 · MOTIR-10010). The
// adapter lives in `@motir/orchestrator` and reads no database, so every fact
// about Motir's own records reaches it as one of these functions, wired by the
// composition root (`lib/orchestrator/awsHosting.ts`) and loaded only when an
// `aws` call is made: which organisation a repository row is, whether it is a
// customer repository (its seed source is the organisation's own, D1), its
// GitHub ids, and whether the organisation's tenant account is ready.

/** The hosting call named a repository row that does not exist. */
export class HostingRepositoryNotFoundError extends Error {
  readonly code = 'HOSTING_REPOSITORY_NOT_FOUND' as const;
  constructor(readonly repositoryId: string) {
    super(`Repository ${repositoryId} does not exist.`);
    this.name = 'HostingRepositoryNotFoundError';
  }
}

async function identityOf(repositoryId: string) {
  const identity = await withSystemContext((tx) =>
    projectRepoRepository.findHostingIdentityInTx(repositoryId, tx),
  );
  if (!identity) throw new HostingRepositoryNotFoundError(repositoryId);
  return identity;
}

export interface AwsHostingLookupDeps {
  /** The owner id of a GitHub repository; the default asks GitHub. */
  ownerIdOf?: (githubRepositoryId: string) => Promise<string>;
}

export const awsHostingLookupService = {
  /** The organisation the repository row belongs to. */
  async organizationOf(repositoryId: string): Promise<string> {
    return (await identityOf(repositoryId)).organizationId;
  },

  /** Whether the row is a customer repository, which Motir never hosts. */
  async isCustomerRepository(repositoryId: string): Promise<boolean> {
    return isOrganizationSeedSource((await identityOf(repositoryId)).seedSource);
  },

  /** The GitHub repository and owner ids the push roles' trust binds, or null
   *  when the row has no realized GitHub repository. */
  async githubIdsOf(
    repositoryId: string,
    deps: AwsHostingLookupDeps = {},
  ): Promise<GithubRepositoryIds | null> {
    const { githubRepositoryId } = await identityOf(repositoryId);
    if (!githubRepositoryId) return null;
    const ownerIdOf = deps.ownerIdOf ?? githubRepositoryOwnerId;
    return { githubRepositoryId, githubOwnerId: await ownerIdOf(githubRepositoryId) };
  },

  /** The organisation's tenant account, asked for when there is none. */
  async ensureTenantAccount(organizationId: string): Promise<AwsTenantAccountAnswer> {
    const { ready, accountId } =
      await hostingTenantAccountService.ensureForOrganization(organizationId);
    return { ready, accountId };
  },
};
