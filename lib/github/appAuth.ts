import { createSign } from 'node:crypto';
import type { InstallationToken } from '@/lib/git/types';

// GitHub App authentication leaf primitive (Story 7.10 · MOTIR-891). Mints the
// short-lived INSTALLATION access token a service needs to call GitHub on an
// installation's behalf. Two-step, per GitHub's App-auth model:
//   1. sign a JWT (RS256) with the App private key — proves "I am the App"
//      (iss = App id, exp ≤ 10 min);
//   2. POST it to the installation's access-token endpoint → a token scoped by
//      GitHub to that installation's selected repos, valid ~1h.
//
// The token is NEVER persisted (the card's hard requirement): it is cached
// in-memory per installation until just before its reported expiry, then
// re-minted. This is the `lib/email.ts`-style leaf primitive — SERVICES import
// it (through the GitProvider seam); routes never do. Config is read at CALL
// time (never module load), so a self-hosted deploy that never wires the GitHub
// App does not crash on boot — the flow simply isn't reachable.
//
// TWO APPS, one primitive (Story MOTIR-1775 · MOTIR-1779 / MOTIR-1781). The
// `role` argument selects WHICH GitHub App registration signs the JWT, because
// `docs/decisions/project-repository-set.md`'s 2026-07-30 amendment keeps them
// deliberately separate and a shared credential would erase that separation:
//
//   * `'user-facing'` (default) — the App every user installs (MOTIR-890).
//     Least privilege, `Administration` NOT among its permissions. Every shipped
//     caller means this one, which is why it is the default and no call site
//     changed when the second role landed.
//   * `'provisioning'` — the "Motir Studio" App, installed ONLY on Motir's own
//     org, holding `Administration: write` there and nowhere else. It is what
//     creates every new project's repositories. It can never reach a repository
//     a user owns, because it is not installed anywhere a user owns. It also
//     holds `Actions: read and write` on that org: the Fleet status page's
//     Publish latest (`lib/services/fleetStatusImagesService.ts`) starts each
//     image's publish workflow with it (`POST …/actions/workflows/<wf>/dispatches`,
//     which `Actions: read` alone answers 403, MOTIR-11229).
//
// A TOKEN CARRIES THE PERMISSIONS IT WAS MINTED WITH. Granting an App a new
// permission does not reach a token already in the cache below, so a caller that
// is refused 403 and can tell a grant may since have landed drops that token with
// `evictInstallationToken` and mints again rather than wait out its hour.
//
// Folding the two into one registration would force `Administration: write` onto
// the App users install, which the amendment records as a funnel loss (a repo
// admin can no longer install an App that requests it) and a two-sided
// re-consent. So the split is the decision; this parameter is how the code keeps
// it. The token cache is keyed by ROLE + installation id for the same reason —
// two Apps' tokens for the same numeric installation id are different secrets.

/** WHICH GitHub App registration a credential is minted from. See the module
 *  header: the split is an ADR decision, not an implementation detail. */
export type GithubAppRole = 'user-facing' | 'provisioning';

const APP_ENV: Record<GithubAppRole, { appId: string; privateKey: string }> = {
  'user-facing': { appId: 'GITHUB_APP_ID', privateKey: 'GITHUB_APP_PRIVATE_KEY' },
  provisioning: { appId: 'GITHUB_STUDIO_APP_ID', privateKey: 'GITHUB_STUDIO_APP_PRIVATE_KEY' },
};

const GITHUB_API = 'https://api.github.com';

// Re-mint this many ms BEFORE the reported expiry so an in-flight call never
// races the boundary (GitHub installation tokens last ~1h; a 60s skew is ample).
const EXPIRY_SKEW_MS = 60_000;

/** The GitHub App credentials for the requested role are not configured on this
 *  deployment. Read at call time so an instance that never wires the App can't
 *  reach the flow rather than crashing on boot. */
export class GithubAppNotConfiguredError extends Error {
  readonly code = 'GITHUB_APP_NOT_CONFIGURED' as const;
  constructor(role: GithubAppRole = 'user-facing') {
    const env = APP_ENV[role];
    super(`GitHub App (${role}) is not configured. Set ${env.appId} and ${env.privateKey}.`);
    this.name = 'GithubAppNotConfiguredError';
  }
}

/** Minting the installation token failed (JWT signing, the token endpoint, or an
 *  unexpected response). Never carries GitHub's raw body. */
export class GithubAppTokenError extends Error {
  readonly code = 'GITHUB_APP_TOKEN_FAILED' as const;
  constructor(
    detail: string,
    /** The token endpoint's HTTP status, when it ANSWERED with one (MOTIR-6619) —
     *  a 401/403/404 there means the installation is gone or suspended, which a
     *  caller reports differently from an endpoint that never answered. */
    readonly status?: number,
  ) {
    super(`GitHub installation-token mint failed: ${detail}`);
    this.name = 'GithubAppTokenError';
  }
}

interface AppConfig {
  appId: string;
  privateKeyPem: string;
}

function resolveConfig(role: GithubAppRole): AppConfig {
  const env = APP_ENV[role];
  const appId = process.env[env.appId];
  const rawKey = process.env[env.privateKey];
  if (!appId || !rawKey) throw new GithubAppNotConfiguredError(role);
  // Env commonly stores the PEM with escaped newlines (`\n`); restore real
  // newlines so the crypto layer can parse it. A key already carrying literal
  // newlines is left unchanged.
  const privateKeyPem = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  return { appId, privateKeyPem };
}

/** Whether the App registration for `role` is wired on this deployment — both of
 *  its variables set. Read at call time, never at import, like `resolveConfig`. */
export function isGithubAppConfigured(role: GithubAppRole): boolean {
  const env = APP_ENV[role];
  return Boolean(process.env[env.appId]) && Boolean(process.env[env.privateKey]);
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/**
 * Build a signed App JWT (RS256). `nowSeconds` is injectable for tests and
 * defaults to the wall clock; `role` selects the App registration and defaults
 * to the user-facing one, so every shipped caller reads unchanged. `iat` is
 * backdated 60s to tolerate clock skew between us and GitHub (GitHub's
 * documented guidance); `exp` stays under the 10-minute ceiling. Throws
 * {@link GithubAppNotConfiguredError} when unwired or {@link GithubAppTokenError}
 * when the key can't sign.
 */
export function createAppJwt(
  nowSeconds: number = Math.floor(Date.now() / 1000),
  role: GithubAppRole = 'user-facing',
): string {
  const { appId, privateKeyPem } = resolveConfig(role);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60, // ≤ 10 min; 9 stays clear of the ceiling
    iss: appId,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem, 'base64url');
  } catch (err) {
    throw new GithubAppTokenError(
      `could not sign the App JWT (${err instanceof Error ? err.message : 'unknown'})`,
    );
  }
  return `${signingInput}.${signature}`;
}

// In-memory installation-token cache — process-local, NEVER persisted. Keyed by
// ROLE + the provider installation id: the two Apps mint different secrets, and
// GitHub's installation ids are per-App, so the role has to be part of the key
// for the cache to be sound rather than merely usually-right.
const cache = new Map<string, InstallationToken>();

/**
 * Mint (or return a still-valid cached) installation access token for
 * `installationId`. Minted from the App JWT of `role` (default: the user-facing
 * App), scoped by GitHub to the installation's repos, cached until
 * `EXPIRY_SKEW_MS` before its reported expiry, then re-minted. NEVER persisted.
 * Throws {@link GithubAppNotConfiguredError} (unwired) or
 * {@link GithubAppTokenError} (endpoint / shape failure).
 */
export async function mintInstallationToken(
  installationId: string,
  role: GithubAppRole = 'user-facing',
): Promise<InstallationToken> {
  const key = `${role}:${installationId}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt.getTime() - EXPIRY_SKEW_MS > Date.now()) {
    return cached;
  }

  const jwt = createAppJwt(undefined, role);
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
      },
    });
  } catch (err) {
    throw new GithubAppTokenError(
      `token endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
    );
  }
  if (!res.ok) throw new GithubAppTokenError(`token endpoint returned ${res.status}`, res.status);

  let body: { token?: string; expires_at?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new GithubAppTokenError('token endpoint returned a non-JSON body');
  }
  if (!body.token || !body.expires_at) {
    throw new GithubAppTokenError('token endpoint returned an unexpected shape');
  }

  const token: InstallationToken = { token: body.token, expiresAt: new Date(body.expires_at) };
  cache.set(key, token);
  return token;
}

/**
 * Drop the cached installation token of `role` for `installationId`, so the next
 * {@link mintInstallationToken} mints a new one. A GitHub token keeps the
 * permissions it was minted with, so a permission granted since the mint is
 * invisible to the cached token for the rest of its hour (MOTIR-11229); a caller
 * refused 403 evicts and retries once. Evicting a token that is not cached is a
 * no-op. Only the entry of that role is dropped: the two Apps' tokens for the
 * same numeric id are different secrets.
 */
export function evictInstallationToken(
  installationId: string,
  role: GithubAppRole = 'user-facing',
): void {
  cache.delete(`${role}:${installationId}`);
}

/** Test-only: clear the in-memory installation-token cache between tests. */
export function _resetInstallationTokenCache(): void {
  cache.clear();
}
