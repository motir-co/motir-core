import { resolveOrgAuth } from '@/lib/github/orgTarget';

// The OWNER ID of a GitHub repository (Story MOTIR-9794 · MOTIR-10010) — what an
// AWS tenant account's push roles bind their GitHub-OIDC trust to, beside the
// repository's own id. Motir stores the repository id (`GithubRepo.repoId`) but
// not its owner's, so this asks GitHub by the immutable repository id. A hosted
// repository is always one Motir provisioned (a customer repository is never
// hosted), so the provisioning org's App token is the one that can read it. A
// LEAF PRIMITIVE in the `lib/github/appAuth.ts` sense: services import it.

const GITHUB_API = 'https://api.github.com';

/** GitHub refused or was unreachable while reading a repository's owner. Carries
 *  the status and a short detail, never the raw body. */
export class RepositoryOwnerIdApiError extends Error {
  readonly code = 'REPOSITORY_OWNER_ID_API_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while reading a repository's owner (${detail}).`
        : `GitHub refused a repository read (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'RepositoryOwnerIdApiError';
  }
}

/** The numeric id of the account that owns repository `repositoryId`, as a
 *  string. Anything but a readable repository with a numeric owner id throws. */
export async function githubRepositoryOwnerId(repositoryId: string): Promise<string> {
  const { token } = await resolveOrgAuth();
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/repositories/${encodeURIComponent(repositoryId)}`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
        authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    throw new RepositoryOwnerIdApiError(null, err instanceof Error ? err.message : 'unknown');
  }
  if (!res.ok) throw new RepositoryOwnerIdApiError(res.status, '');
  let body: { owner?: { id?: unknown } } | null;
  try {
    body = (await res.json()) as { owner?: { id?: unknown } } | null;
  } catch {
    throw new RepositoryOwnerIdApiError(res.status, 'a non-JSON body');
  }
  const id = body?.owner?.id;
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new RepositoryOwnerIdApiError(res.status, 'no numeric owner id');
  }
  return String(id);
}
