import { githubFetch } from '@/lib/github/githubFetch';
import { resolveOrgAuth, type GithubOrgTarget } from '@/lib/github/orgTarget';

// AN INSTALLATION'S OWN REST BUDGET (Story MOTIR-8953 · MOTIR-8969) — the
// headroom pass reads it instead of counting, because the installation spends
// calls on far more than runners (provisioning, check runs, merges).
//
// `GET /rate_limit` does not count against the REST limit:
// https://docs.github.com/en/rest/rate-limit/rate-limit#get-rate-limit-status-for-the-authenticated-user
// ("Accessing this endpoint does not count against your REST API rate limit.")

const GITHUB_API = 'https://api.github.com';

/** The `core` resource of an installation's REST budget. */
export interface InstallationRateLimit {
  limit: number;
  used: number;
  resetAt: Date;
}

/** The read failed — GitHub refused, could not be reached, or answered a shape
 *  without the `core` resource. Never read as zero. */
export class RateLimitReadError extends Error {
  constructor(
    readonly org: string,
    readonly status: number | null,
    detail: string,
  ) {
    super(
      `Could not read the REST budget of ${org}` +
        `${status === null ? '' : ` (HTTP ${status})`}: ${detail}`,
    );
    this.name = 'RateLimitReadError';
  }
}

/** Read the `core` budget of the installation `target` names, with its token. */
export async function readInstallationRateLimit(
  target: GithubOrgTarget,
): Promise<InstallationRateLimit> {
  const { token } = await resolveOrgAuth(target);
  let res: Response;
  try {
    res = await githubFetch('rateLimit', `${GITHUB_API}/rate_limit`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
        authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    throw new RateLimitReadError(target.org, null, err instanceof Error ? err.message : 'unknown');
  }
  if (!res.ok) throw new RateLimitReadError(target.org, res.status, 'refused');
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const core = (body as { resources?: { core?: Record<string, unknown> } } | null)?.resources?.core;
  const limit = core?.['limit'];
  const used = core?.['used'];
  const reset = core?.['reset'];
  if (typeof limit !== 'number' || typeof used !== 'number' || typeof reset !== 'number') {
    throw new RateLimitReadError(target.org, res.status, 'no core resource in the answer');
  }
  return { limit, used, resetAt: new Date(reset * 1000) };
}
