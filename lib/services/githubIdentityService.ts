import { withUserContext } from '@/lib/workspaces/context';
import {
  githubIdentityRepository,
  type RefreshedGithubTokens,
} from '@/lib/repositories/githubIdentityRepository';
import { toGithubIdentityDTO } from '@/lib/mappers/githubMappers';
import { encryptToken, decryptToken } from '@/lib/github/tokenCrypto';
import { userOrgsClient, type GithubUserOrg } from '@/lib/github/userOrgs';
import {
  GithubIdentityRefreshUnavailableError,
  GithubIdentityRefusedError,
  GithubOAuthExchangeError,
  GithubOAuthNotConfiguredError,
} from '@/lib/github/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import type { GithubIdentityDTO } from '@/lib/dto/github';

// GitHub OAuth user-identity service (Story 7.10 · MOTIR-1498) — "Grant 1" of
// the verified GitHub-App model: it proves which GitHub user a Motir member is
// and grants NO repo access (that's the installation grant, MOTIR-891). Owns
// the OAuth orchestration (authorize-URL build, code→token exchange, the
// `GET /user` read), token encryption, and the `withUserContext` transaction
// that binds the identity to the acting member. The routes are HTTP-only.
//
// Config is read at CALL time (never module load): a self-hosted deployment
// that never configures GitHub must not crash on boot — the flow simply isn't
// reachable (routes surface GithubOAuthNotConfiguredError as a redirect).

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_API_URL = 'https://api.github.com/user';
const CALLBACK_PATH = '/api/github/oauth/callback';

/**
 * How long before its stated expiry an access token is renewed, in ms (Bug
 * MOTIR-10021). A token with seconds left is useless to the GitHub call it is
 * about to be handed to; the margin is what stops that call carrying a token
 * that expires on the way. Same value as the Sentry and GitLab refresh paths.
 */
export const GITHUB_TOKEN_EXPIRY_SKEW_MS = 60_000;

/** The deadline on one refresh-grant call to GitHub, in ms. */
export const GITHUB_REFRESH_TIMEOUT_MS = 10_000;

/**
 * How long a renewal LEASE lasts, in ms — the refresh call's own deadline plus a
 * margin for the short transactions around it. It must outlive the call, or a
 * second caller could spend the same refresh token while the first still waits
 * on GitHub; and it must EXPIRE, so a process that died mid-call leaves a lease
 * the next caller takes over (the MOTIR-8184 shape, from the Sentry refresh).
 */
export const GITHUB_REFRESH_LEASE_MS = GITHUB_REFRESH_TIMEOUT_MS + 15_000;

/** How often a caller that found a live lease re-reads the identity, in ms. */
export const GITHUB_REFRESH_LEASE_POLL_MS = 250;

/** How many times the write that stores a rotated pair is attempted: GitHub has
 *  already invalidated the old refresh token by then, so this write failing is
 *  the incident MOTIR-8184 was about. */
const STORE_ATTEMPTS = 3;

interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

function resolveConfig(): GithubOAuthConfig {
  const clientId = process.env['GITHUB_APP_CLIENT_ID'];
  const clientSecret = process.env['GITHUB_APP_CLIENT_SECRET'];
  if (!clientId || !clientSecret) throw new GithubOAuthNotConfiguredError();
  return { clientId, clientSecret };
}

/** The redirect_uri GitHub sends the user back to — derived from the canonical
 *  base URL so it matches the value registered on the GitHub App. */
function callbackUrl(): string {
  return `${resolveBaseUrlTrimmed()}${CALLBACK_PATH}`;
}

/** The GitHub user fields the identity binding needs. GitHub's `id` is a JSON
 *  number; we carry it as a string (never do math on it). */
interface GithubUser {
  id: number;
  login: string;
  avatar_url?: string | null;
}

export const githubIdentityService = {
  /**
   * Build the GitHub authorize URL for the identity grant. `state` is the
   * caller-minted CSRF nonce the callback re-checks. Throws
   * GithubOAuthNotConfiguredError when the app isn't wired.
   */
  buildAuthorizeUrl(state: string): string {
    const { clientId } = resolveConfig();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl());
    url.searchParams.set('state', state);
    // Identity-only grant: no `scope` (a GitHub App's user-to-server token
    // carries no OAuth scopes — repo access comes from the installation, not
    // this token). Force a fresh consent so re-connect always re-binds.
    url.searchParams.set('allow_signup', 'false');
    return url.toString();
  },

  /**
   * Complete the identity grant: exchange `code` for a user access token, read
   * the GitHub user, encrypt the token, and upsert a `GithubIdentity` bound to
   * `userId` (under `withUserContext`, so RLS binds it to the acting member).
   * Returns the token-free DTO. Throws GithubOAuthNotConfiguredError (unwired)
   * or GithubOAuthExchangeError (exchange / user read failed).
   */
  async completeOAuthCallback(args: { code: string; userId: string }): Promise<GithubIdentityDTO> {
    const { clientId, clientSecret } = resolveConfig();

    const grant = await exchangeCodeForToken({
      clientId,
      clientSecret,
      code: args.code,
    });
    const githubUser = await fetchGithubUser(grant.accessToken);

    const row = await withUserContext(args.userId, (tx) =>
      githubIdentityRepository.upsertForUser(
        {
          userId: args.userId,
          githubUserId: String(githubUser.id),
          githubLogin: githubUser.login,
          avatarUrl: githubUser.avatar_url ?? null,
          accessTokenEncrypted: encryptToken(grant.accessToken),
          // Motir Integration expires user tokens (MOTIR-6522): keep what the
          // renewal needs (Bug MOTIR-10021). All three are null for an App that
          // does not, and such a token is then returned as stored.
          refreshTokenEncrypted: grant.refreshToken ? encryptToken(grant.refreshToken) : null,
          tokenExpiresAt: grant.expiresAt,
          refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
        },
        tx,
      ),
    );

    return toGithubIdentityDTO(row);
  },

  /**
   * The acting member's GitHub identity, or null when unbound — the read the
   * settings surface uses. A null result is a valid state (an identity with no
   * installation, or no identity yet), NOT an error.
   */
  async getIdentityForUser(userId: string): Promise<GithubIdentityDTO | null> {
    const row = await withUserContext(userId, (tx) =>
      githubIdentityRepository.findByUserId(userId, tx),
    );
    return row ? toGithubIdentityDTO(row) : null;
  },

  /**
   * The acting member's DECRYPTED GitHub user token, or null when unbound —
   * `getIdentityForUser` (the token-free DTO the surfaces render) with the one
   * field a caller that has to CALL GitHub needs. Same row, same RLS-bound read:
   * a member the settings badge / the import wizard shows as connected is
   * exactly a member this returns a token for, and one it returns null for is
   * exactly the "connect your account" state those surfaces already render.
   *
   * ⚠️ Returns a live credential — callers put it on the wire and never persist,
   * log or echo it. Import's GitHub connector is the second consumer, after
   * `listOrganizations` below (MOTIR-2456).
   *
   * ⚠️ THE TOKEN EXPIRES, AND THIS IS WHERE IT IS RENEWED (Bug MOTIR-10021).
   * Motir Integration runs with "Expire user authorization tokens" ON
   * (MOTIR-6522): GitHub issues an access token that dies after eight hours,
   * with a rotating refresh token good for about six months. So a row linked
   * with a refresh token is renewed here when its access token is within
   * {@link GITHUB_TOKEN_EXPIRY_SKEW_MS} of expiry — single-flight, because GitHub
   * rotates the refresh token on every use and a second concurrent renewal
   * would spend a token the first has already invalidated.
   *
   * - A refused renewal (`bad_refresh_token`: expired or revoked) marks the row
   *   and throws {@link GithubIdentityRefusedError} — the reconnect state of Bug
   *   MOTIR-8984 — and every later call throws it at once, with no GitHub call,
   *   until the member reconnects. Never a retry loop.
   * - A renewal GitHub did not answer throws
   *   {@link GithubIdentityRefreshUnavailableError} and leaves the pair as it was;
   *   the next call tries again.
   * - A row with NO refresh token — linked before this change, or from an App
   *   that does not expire tokens — is returned as stored, never renewed; a dead
   *   one meets MOTIR-8984's reconnect prompt on its first 401.
   */
  async getLiveToken(userId: string): Promise<{ accessToken: string } | null> {
    for (;;) {
      const decision = await decideRenewal(userId);
      if (decision.kind === 'none') return null;
      if (decision.kind === 'fresh') return { accessToken: decision.accessToken };
      if (decision.kind === 'refused') throw new GithubIdentityRefusedError();
      if (decision.kind === 'renew') {
        return { accessToken: await renewWithLease(userId, decision.grant) };
      }
      // Somebody else holds the lease: wait for their pair, then re-read it.
      await sleep(GITHUB_REFRESH_LEASE_POLL_MS);
    }
  },

  /**
   * The organizations the acting member's connected account belongs to (Story
   * MOTIR-1775 · MOTIR-1939) — the takeover picker's "Your organizations" group.
   *
   * ⚠️ A LIVE CALL, because nothing stores them: the identity row holds one
   * login, the PERSONAL one. So this is the only read in the flow that can be
   * slow or fail, and the surface renders both of those as real states.
   *
   * `null` identity → an EMPTY list, never a throw: "no account connected" is
   * answered by the connect prompt the surface already renders for it, not by an
   * error from the organization lookup.
   */
  async listOrganizations(userId: string): Promise<GithubUserOrg[]> {
    const live = await this.getLiveToken(userId);
    if (!live) return [];
    return userOrgsClient.listForToken(live.accessToken);
  },

  /**
   * Unbind the acting member's GitHub identity (Disconnect — MOTIR-895).
   * Independent of the workspace installation — the two grants are independent,
   * so this never touches GithubInstallation (the App is uninstalled on GitHub).
   * Idempotent: disconnecting an already-unbound member is a no-op. Runs under
   * `withUserContext` so RLS narrows the delete to the owner's row.
   */
  async disconnect(userId: string): Promise<void> {
    await withUserContext(userId, (tx) => githubIdentityRepository.deleteByUserId(userId, tx));
  },
};

/** What GitHub's token endpoint grants: the access token and, for an App that
 *  expires user tokens, the refresh token and both expiries (Bug MOTIR-10021). */
interface GithubTokenGrant {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}

/** The token endpoint's JSON body, success or `{ error }`. */
interface GithubTokenPayload {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
}

/** Read a successful token body into a grant, relative to `now`. */
function toTokenGrant(payload: GithubTokenPayload, now: number): GithubTokenGrant {
  const at = (seconds: number | undefined) =>
    typeof seconds === 'number' && seconds > 0 ? new Date(now + seconds * 1000) : null;
  return {
    accessToken: payload.access_token!,
    refreshToken: payload.refresh_token || null,
    expiresAt: at(payload.expires_in),
    refreshTokenExpiresAt: at(payload.refresh_token_expires_in),
  };
}

/** POST the code→token exchange. GitHub returns `application/json` only when
 *  asked; a body without `access_token` (e.g. `{ error: 'bad_verification_code' }`)
 *  is the failure path. Never surfaces GitHub's raw body (it can echo the code).
 *  Keeps the refresh token and both expiries, which an expiring-token App sends
 *  beside the access token (Bug MOTIR-10021). */
async function exchangeCodeForToken(args: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<GithubTokenGrant> {
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: args.clientId,
        client_secret: args.clientSecret,
        code: args.code,
        redirect_uri: callbackUrl(),
      }),
    });
  } catch (err) {
    throw new GithubOAuthExchangeError(`token endpoint unreachable (${describeError(err)})`);
  }
  if (!res.ok) throw new GithubOAuthExchangeError(`token endpoint returned ${res.status}`);

  let payload: GithubTokenPayload;
  try {
    payload = (await res.json()) as GithubTokenPayload;
  } catch {
    throw new GithubOAuthExchangeError('token endpoint returned a non-JSON body');
  }
  if (!payload.access_token) {
    throw new GithubOAuthExchangeError(
      payload.error ? `token error: ${payload.error}` : 'no access_token in response',
    );
  }
  return toTokenGrant(payload, startedAt);
}

/** What the short locked read decided. */
type RenewalDecision =
  | { kind: 'none' }
  | { kind: 'fresh'; accessToken: string }
  | { kind: 'refused' }
  | { kind: 'wait' }
  | { kind: 'renew'; grant: { id: string; refreshTokenEncrypted: string } };

/** Short transaction #1: lock the member's identity, re-read it and decide —
 *  taking the lease when this caller is the one that renews. Commits before
 *  any call to GitHub. Under `withUserContext`, so RLS binds it to the owner. */
async function decideRenewal(userId: string): Promise<RenewalDecision> {
  return withUserContext(userId, async (tx) => {
    await githubIdentityRepository.lockByUserId(userId, tx);
    const row = await githubIdentityRepository.findByUserId(userId, tx);
    if (!row) return { kind: 'none' };
    if (row.refreshRefusedAt) return { kind: 'refused' };

    // No refresh token: a row linked before MOTIR-10021, or a non-expiring
    // token. Returned as stored — a dead one meets MOTIR-8984's 401 → reconnect.
    const now = Date.now();
    const fresh = { kind: 'fresh', accessToken: decryptToken(row.accessTokenEncrypted) } as const;
    if (!row.refreshTokenEncrypted || !row.tokenExpiresAt) return fresh;

    // Somebody is mid-renewal: wait for their pair rather than spend the same
    // refresh token. Checked before the expiry, as the lease is what guards it.
    if (row.refreshLeaseUntil && row.refreshLeaseUntil.getTime() > now) return { kind: 'wait' };
    if (row.tokenExpiresAt.getTime() - GITHUB_TOKEN_EXPIRY_SKEW_MS > now) return fresh;

    // The refresh token has itself expired (~6 months): GitHub would refuse it,
    // so mark it refused without spending a call.
    if (row.refreshTokenExpiresAt && row.refreshTokenExpiresAt.getTime() <= now) {
      await githubIdentityRepository.markRefreshRefused(row.id, new Date(now), tx);
      return { kind: 'refused' };
    }

    await githubIdentityRepository.setRefreshLease(
      row.id,
      new Date(now + GITHUB_REFRESH_LEASE_MS),
      tx,
    );
    return {
      kind: 'renew',
      grant: { id: row.id, refreshTokenEncrypted: row.refreshTokenEncrypted },
    };
  });
}

/** What one refresh-grant call produced. */
type RefreshAnswer =
  | { kind: 'ok'; grant: GithubTokenGrant }
  | { kind: 'refused'; error: string }
  | { kind: 'unavailable'; detail: string };

/** POST `grant_type=refresh_token` to GitHub's token endpoint. GitHub answers a
 *  refused refresh token with 200 and `{ error: 'bad_refresh_token' }`; no
 *  answer, a timeout or a non-2xx is UNAVAILABLE, never a refusal — the request
 *  may not have reached GitHub at all. Never surfaces GitHub's raw body. */
async function requestRefreshGrant(refreshToken: string): Promise<RefreshAnswer> {
  const { clientId, clientSecret } = resolveConfig();
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(GITHUB_REFRESH_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: 'unavailable', detail: `token endpoint unreachable (${describeError(err)})` };
  }
  if (!res.ok) return { kind: 'unavailable', detail: `token endpoint returned ${res.status}` };

  let payload: GithubTokenPayload;
  try {
    payload = (await res.json()) as GithubTokenPayload;
  } catch {
    return { kind: 'unavailable', detail: 'token endpoint returned a non-JSON body' };
  }
  if (!payload.access_token || !payload.refresh_token) {
    return { kind: 'refused', error: payload.error ?? 'no token pair in response' };
  }
  return { kind: 'ok', grant: toTokenGrant(payload, startedAt) };
}

/**
 * Spend the refresh token and commit what GitHub answered — with NO transaction
 * open while it answers.
 *
 * ⚠️ WHY NOT A ROW LOCK HELD ACROSS THE CALL (the Sentry refresh's MOTIR-5988 and
 * MOTIR-8184). GitHub rotates the refresh token the moment it accepts the
 * request, so anything that rolls our write back after that point — a
 * transaction budget, an abort, a stop before `COMMIT` — leaves a refresh token
 * GitHub has already invalidated. So the rotated pair is written in its own
 * transaction the instant it arrives, and single-flight is the lease column.
 */
async function renewWithLease(
  userId: string,
  grant: Extract<RenewalDecision, { kind: 'renew' }>['grant'],
): Promise<string> {
  const answer = await requestRefreshGrant(decryptToken(grant.refreshTokenEncrypted));

  if (answer.kind === 'ok') {
    await storeRotatedPair(userId, grant.id, {
      accessTokenEncrypted: encryptToken(answer.grant.accessToken),
      refreshTokenEncrypted: encryptToken(answer.grant.refreshToken!),
      // GitHub always states it for an expiring token; a pair without one is
      // treated as due again at once rather than as never expiring.
      tokenExpiresAt: answer.grant.expiresAt ?? new Date(),
      refreshTokenExpiresAt: answer.grant.refreshTokenExpiresAt,
    });
    return answer.grant.accessToken;
  }

  if (answer.kind === 'refused') {
    await withUserContext(userId, (tx) =>
      githubIdentityRepository.markRefreshRefused(grant.id, new Date(), tx),
    );
    // One line, no credential: the reason GitHub gave is what tells a reader
    // whether the member revoked the App or the token simply aged out.
    console.warn('[githubIdentityService] refresh refused; the member must reconnect', {
      identityId: grant.id,
      reason: answer.error,
    });
    throw new GithubIdentityRefusedError();
  }

  await withUserContext(userId, (tx) => githubIdentityRepository.releaseRefreshLease(grant.id, tx));
  throw new GithubIdentityRefreshUnavailableError(answer.detail);
}

/** Short transaction #2: the rotated pair, ALONE, retried on a transient error. */
async function storeRotatedPair(
  userId: string,
  identityId: string,
  tokens: RefreshedGithubTokens,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await withUserContext(userId, (tx) =>
        githubIdentityRepository.storeRefreshedTokens(identityId, tokens, tx),
      );
      return;
    } catch (error) {
      if (attempt >= STORE_ATTEMPTS) throw error;
      await sleep(250 * attempt);
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read the authenticated GitHub user for the freshly-minted token. */
async function fetchGithubUser(accessToken: string): Promise<GithubUser> {
  let res: Response;
  try {
    res = await fetch(USER_API_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
      },
    });
  } catch (err) {
    throw new GithubOAuthExchangeError(`user endpoint unreachable (${describeError(err)})`);
  }
  if (!res.ok) throw new GithubOAuthExchangeError(`user endpoint returned ${res.status}`);

  let user: GithubUser;
  try {
    user = (await res.json()) as GithubUser;
  } catch {
    throw new GithubOAuthExchangeError('user endpoint returned a non-JSON body');
  }
  if (typeof user.id !== 'number' || typeof user.login !== 'string') {
    throw new GithubOAuthExchangeError('user endpoint returned an unexpected shape');
  }
  return user;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}
