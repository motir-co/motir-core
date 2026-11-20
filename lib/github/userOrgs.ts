// The connected user's ORGANIZATIONS (Story MOTIR-1775 · MOTIR-1939) — the one
// module that asks GitHub which organizations an identity belongs to.
//
// ⚠️ IT EXISTS BECAUSE NOTHING STORES THEM. `GithubIdentity` holds exactly one
// login — the user's PERSONAL `githubLogin` (`prisma/schema.prisma`) — so the
// takeover picker's "Your organizations" group is a LIVE call that can be slow
// and can fail. That is why `design/repository-set/design-notes.md` §14.5 draws
// the lookup's loading and unavailable states rather than an instantly-populated
// list: an assumed-populated list would be a drawing of a system that does not
// exist. The PERSONAL account is never behind this call, which is what lets a
// failed lookup degrade to a working picker instead of a blocked flow.
//
// The USER-TO-SERVER token, never the provisioning credential: the question is
// "which orgs is THIS PERSON in", and only their own token can answer it. This
// module is the fetch boundary — everything above it is orchestration, and this
// line is where the tests fake, the same shape `repoTransfer.ts` /
// `repoCollaborators.ts` hold.

import { githubFetch } from '@/lib/github/githubFetch';

const GITHUB_API = 'https://api.github.com';

/** One page is plenty: the picker lists organizations a human chooses between,
 *  and GitHub caps `per_page` at 100. Paginating further would add a failure
 *  mode to a lookup whose whole design point is that it degrades gracefully. */
const PER_PAGE = 100;

/**
 * Any GitHub refusal or transport failure while listing organizations.
 *
 * ⚠️ NEVER FATAL TO THE FLOW. The surface renders this as the picker's
 * "couldn't reach your GitHub organizations" state with the personal account
 * still selectable — so this type exists to be REPORTED, not to abort a takeover.
 */
export class GithubUserOrgsError extends Error {
  readonly code = 'GITHUB_USER_ORGS_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while listing your organizations (${detail}).`
        : `GitHub refused the organization list (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'GithubUserOrgsError';
  }
}

/** One organization the connected account belongs to. */
export interface GithubUserOrg {
  login: string;
  avatarUrl: string | null;
}

/** The raw shape of a `GET /user/orgs` element that this module reads. */
interface RawOrg {
  login?: unknown;
  avatar_url?: unknown;
}

export const userOrgsClient = {
  /**
   * `GET /user/orgs` — the organizations the token's own user belongs to.
   *
   * Deliberately NOT `GET /orgs/{org}` per membership or the App's installation
   * list: the picker's question is "where may this PERSON put a repository", and
   * an org the user is in but Motir is not installed on is still a legitimate
   * target (the transfer is what moves it; the App install comes after). Whether
   * GitHub will ACCEPT the transfer is a permission the user may not have, which
   * is stated once under the list rather than used to hide options.
   */
  async listForToken(accessToken: string): Promise<GithubUserOrg[]> {
    let res: Response;
    try {
      res = await githubFetch('user.orgs', `${GITHUB_API}/user/orgs?per_page=${PER_PAGE}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        // A user is waiting on a modal: a lookup that hangs is worse than one
        // that reports it could not reach GitHub, because the picker has a
        // working answer (the personal account) to fall back to either way.
        cache: 'no-store',
      });
    } catch (err) {
      throw new GithubUserOrgsError(null, err instanceof Error ? err.message : 'network error');
    }

    if (!res.ok) {
      throw new GithubUserOrgsError(res.status, await shortDetail(res));
    }

    const body = (await res.json().catch(() => null)) as unknown;
    if (!Array.isArray(body)) throw new GithubUserOrgsError(res.status, 'unexpected body');

    return body
      .map((raw) => toOrg(raw as RawOrg))
      .filter((org): org is GithubUserOrg => org !== null);
  },
};

/** A short, log-safe excuse — never the raw body (the contract every GitHub
 *  client in this repo holds). */
async function shortDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.slice(0, 200);
}

/** An element without a usable `login` is dropped rather than rendered as a
 *  blank option — a picker row the user cannot identify is worse than one fewer
 *  row. */
function toOrg(raw: RawOrg): GithubUserOrg | null {
  if (typeof raw.login !== 'string' || raw.login.trim().length === 0) return null;
  return {
    login: raw.login,
    avatarUrl: typeof raw.avatar_url === 'string' ? raw.avatar_url : null,
  };
}
