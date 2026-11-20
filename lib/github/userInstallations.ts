// The Motir App installations the signed-in PERSON can access on GitHub (Story
// MOTIR-8216 · MOTIR-8220) — the one module that asks GitHub "which accounts is
// this App installed on that you can see?".
//
// ⚠️ THE ANSWER COMES FROM GITHUB, NEVER FROM `github_installation` ROWS. The
// row for an account is deleted when its last organisation disconnects, and an
// account a person can see is a fact about GitHub, not about Motir. Listing from
// rows would make a disconnected account vanish from the picker and would offer
// an account the person has no access to.
//
// The USER-TO-SERVER token (the member's linked GitHub identity), never the App's
// own credential: only the person's token can say what the PERSON may reach. For
// a GitHub App user token, `GET /user/installations` already returns only this
// App's installations; the `app_id` filter below is a second fence for a token
// minted by a different App. Same fetch-boundary shape as `userOrgs.ts`.

import { githubFetch } from '@/lib/github/githubFetch';

const GITHUB_API = 'https://api.github.com';
const PER_PAGE = 100;

/** Any GitHub refusal or transport failure while listing installations. */
export class GithubUserInstallationsError extends Error {
  readonly code = 'GITHUB_USER_INSTALLATIONS_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while listing your installations (${detail}).`
        : `GitHub refused the installation list (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'GithubUserInstallationsError';
  }
}

/** One account the App is installed on, as the person sees it. */
export interface GithubUserInstallation {
  /** GitHub's installation id, as a string (never do math on it). */
  installationId: string;
  accountLogin: string;
  accountType: string;
  avatarUrl: string | null;
  /** `all` or `selected` — which repositories the account granted the App. */
  repositorySelection: string;
}

interface RawInstallation {
  id?: unknown;
  app_id?: unknown;
  repository_selection?: unknown;
  account?: { login?: unknown; type?: unknown; avatar_url?: unknown } | null;
}

export const userInstallationsClient = {
  /** `GET /user/installations` — the installations of this App the token's user
   *  can access. One page of 100: a person chooses between a handful. */
  async listForToken(accessToken: string): Promise<GithubUserInstallation[]> {
    let res: Response;
    try {
      res = await githubFetch(
        'user.installations',
        `${GITHUB_API}/user/installations?per_page=${PER_PAGE}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          cache: 'no-store',
        },
      );
    } catch (err) {
      throw new GithubUserInstallationsError(
        null,
        err instanceof Error ? err.message : 'network error',
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GithubUserInstallationsError(res.status, text.slice(0, 200));
    }
    const body = (await res.json().catch(() => null)) as { installations?: unknown } | null;
    if (!body || !Array.isArray(body.installations)) {
      throw new GithubUserInstallationsError(res.status, 'unexpected body');
    }
    const appId = process.env['GITHUB_APP_ID'];
    return (body.installations as RawInstallation[])
      .filter((raw) => !appId || raw.app_id === undefined || String(raw.app_id) === appId)
      .map(toInstallation)
      .filter((inst): inst is GithubUserInstallation => inst !== null);
  },
};

function toInstallation(raw: RawInstallation): GithubUserInstallation | null {
  const login = raw.account?.login;
  if ((typeof raw.id !== 'number' && typeof raw.id !== 'string') || typeof login !== 'string') {
    return null;
  }
  return {
    installationId: String(raw.id),
    accountLogin: login,
    accountType: typeof raw.account?.type === 'string' ? raw.account.type : 'Organization',
    avatarUrl: typeof raw.account?.avatar_url === 'string' ? raw.account.avatar_url : null,
    repositorySelection:
      typeof raw.repository_selection === 'string' ? raw.repository_selection : 'selected',
  };
}
