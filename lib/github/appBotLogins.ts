import { createAppJwt, isGithubAppConfigured, type GithubAppRole } from '@/lib/github/appAuth';

// MOTIR'S OWN APP BOTS, by login (Story MOTIR-10327 · MOTIR-10335; `approval-gates.md` §12
// rule 8). Motir posts every agent verdict on the pull request as the repository's own
// App — `motir-studio[bot]` on a Motir-created repository, `motir-integration[bot]` on an
// imported one — and the review sync must never count those reviews. This module answers
// "is this login one of ours?" for BOTH registrations.
//
// ⚠️ THE LOGIN IS READ FROM THE APP, NEVER WRITTEN DOWN. A bot's login is `<slug>[bot]`,
// and the slug belongs to the App registration — a self-hosted deployment registers its
// own Apps under its own names. So each configured App is asked for its slug with its own
// JWT (`GET /app`), once per process, exactly as `runGitBotAuthor` reads it. A failed read
// is not cached: the next review asks again.

const GITHUB_API = 'https://api.github.com';
const ROLES: readonly GithubAppRole[] = ['user-facing', 'provisioning'];

const slugs = new Map<GithubAppRole, Promise<string | null>>();

/** One App's slug, or null when that App is not configured here. Throws on a failed read. */
function slugOf(role: GithubAppRole): Promise<string | null> {
  const cached = slugs.get(role);
  if (cached) return cached;
  const pending = (async () => {
    if (!isGithubAppConfigured(role)) return null;
    const res = await fetch(`${GITHUB_API}/app`, {
      headers: {
        authorization: `Bearer ${createAppJwt(undefined, role)}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
      },
    });
    const body = res.ok ? ((await res.json()) as { slug?: unknown }) : {};
    if (typeof body.slug !== 'string' || !body.slug) {
      throw new Error(`GitHub answered ${res.status} when asked for the ${role} App's slug`);
    }
    return body.slug;
  })();
  slugs.set(role, pending);
  pending.catch(() => slugs.delete(role));
  return pending;
}

/**
 * The bot logins of every Motir App configured on this deployment, and whether every
 * configured App answered. `complete: false` means a read failed — the caller must not
 * read a login's absence as proof it is not Motir's.
 */
export async function motirAppBotLogins(): Promise<{ logins: Set<string>; complete: boolean }> {
  const logins = new Set<string>();
  let complete = true;
  for (const role of ROLES) {
    try {
      const slug = await slugOf(role);
      if (slug) logins.add(`${slug}[bot]`.toLowerCase());
    } catch (err) {
      complete = false;
      console.warn('[appBotLogins] could not read a Motir App slug', {
        role,
        reason: err instanceof Error ? err.message : 'unknown',
      });
    }
  }
  return { logins, complete };
}

/** Test seam: forget the per-process slugs. */
export function _resetMotirAppBotLogins(): void {
  slugs.clear();
}
