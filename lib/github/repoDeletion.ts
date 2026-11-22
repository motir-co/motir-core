import { githubFetch } from '@/lib/github/githubFetch';
import { mintInstallationToken } from '@/lib/github/appAuth';

// The repository-DELETE boundary (Story MOTIR-6306 · MOTIR-6397) — the one module
// that deletes a repository on GitHub. Its only caller is the organization Git
// offboarding (`organizationGitOffboardingService`), which runs when an erased
// organization's Motir-HOSTED repositories must go with it.
//
// The sibling of `repoTransfer.ts` and shaped like it: the host mechanics live
// here, none of the row bookkeeping does, and the line between them is where the
// tests fake. A LEAF PRIMITIVE — services import it, routes never do.
//
// ⚠️ IT DELETES WHATEVER IT IS HANDED, SO IT MUST ONLY EVER BE HANDED A REPOSITORY
// MOTIR HOSTS. The discriminator is `isMotirHostedOwner` (`lib/git/hostOwnership.ts`)
// and it is the CALLER's to apply, per repository, before the call. This module
// cannot apply it for the caller without reading the environment, which is the
// thing `hostOwnership.ts` is careful not to do.
//
// ⚠️ THE PERMISSION IS ONE THE PROVISIONING APP ALREADY HOLDS. `DELETE
// /repos/{owner}/{repo}` runs under Repository → "Administration" write — the grant
// the provisioning App (MOTIR-1779) carries because CREATING a repository needs it,
// recorded in `docs/decisions/ci-minutes-allowance.md` (the provisioning App's
// "Repository permissions for Administration, write") and relied on by
// `repoTransfer.ts` for the transfer under the same permission. No re-consent.
//
// IDEMPOTENT: a `404` is SUCCESS. The intent is "this repository no longer
// exists", and its absence satisfies it — which is what lets a sweep that crashed
// between the remote delete and the row delete simply run again. (The opposite of
// `repoTransfer.ts`, where a missing repository means the handoff cannot happen.)

const GITHUB_API = 'https://api.github.com';

/** Every failure this module raises. No raw GitHub body ever escapes. */
export class RepoDeletionError extends Error {
  readonly code = 'REPO_DELETION_FAILED' as const;
  constructor(
    readonly status: number | null,
    readonly detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while deleting the repository (${detail}).`
        : `GitHub refused the repository delete (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'RepoDeletionError';
  }
}

export interface DeleteRepoInput {
  /** GitHub's numeric installation id the repository lives in — for a Motir-hosted
   *  repository, the PROVISIONING installation. */
  installationId: string;
  owner: string;
  repo: string;
}

export const repoDeletionClient = {
  /**
   * Delete one repository. Resolves `'deleted'` on `204`, `'absent'` on `404`
   * (already gone — success), and throws {@link RepoDeletionError} otherwise.
   */
  async deleteRepo(input: DeleteRepoInput): Promise<'deleted' | 'absent'> {
    let token: string;
    try {
      ({ token } = await mintInstallationToken(input.installationId, 'provisioning'));
    } catch (err) {
      throw new RepoDeletionError(null, err instanceof Error ? err.message : 'unknown');
    }
    const url = repoUrl(input);

    let res: Response;
    try {
      res = await githubFetch('repoDeletion', url, {
        method: 'DELETE',
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
          authorization: `Bearer ${token}`,
        },
      });
    } catch (err) {
      throw new RepoDeletionError(null, err instanceof Error ? err.message : 'unknown');
    }
    if (res.status === 204) return 'deleted';
    if (res.status === 404) return 'absent';
    throw new RepoDeletionError(res.status, await errorDetail(res));
  },

  /**
   * Whether the repository still exists — the read the hosted delete's confirm
   * makes before it says what it would delete (MOTIR-11981; design
   * repository-set §19.4). The same installation token and the same 404 rule as
   * the delete: `'present'` on `200`, `'absent'` on `404`, and
   * {@link RepoDeletionError} otherwise, so a confirm never guesses.
   */
  async probeRepo(input: DeleteRepoInput): Promise<'present' | 'absent'> {
    let token: string;
    try {
      ({ token } = await mintInstallationToken(input.installationId, 'provisioning'));
    } catch (err) {
      throw new RepoDeletionError(null, err instanceof Error ? err.message : 'unknown');
    }
    let res: Response;
    try {
      res = await githubFetch('repoDeletion', repoUrl(input), {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
          authorization: `Bearer ${token}`,
        },
      });
    } catch (err) {
      throw new RepoDeletionError(null, err instanceof Error ? err.message : 'unknown');
    }
    if (res.status === 200) return 'present';
    if (res.status === 404) return 'absent';
    throw new RepoDeletionError(res.status, await errorDetail(res));
  },
};

function repoUrl(input: DeleteRepoInput): string {
  return (
    `${GITHUB_API}/repos/${encodeURIComponent(input.owner)}/` + `${encodeURIComponent(input.repo)}`
  );
}

/** GitHub's `message`, trimmed to a short developer detail — never the payload. */
export async function errorDetail(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    const message =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['message']
        : null;
    return typeof message === 'string' ? message.slice(0, 200) : '';
  } catch {
    return '';
  }
}
