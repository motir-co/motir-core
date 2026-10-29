import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { decryptToken, encryptToken } from '@/lib/github/tokenCrypto';
import {
  GithubIdentityRefreshUnavailableError,
  GithubIdentityRefusedError,
  GithubOAuthExchangeError,
  GithubOAuthNotConfiguredError,
} from '@/lib/github/errors';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story 7.10 · MOTIR-1498 — the OAuth user-identity grant service, against a
// real Postgres (the motir-core convention). The GitHub HTTP calls are stubbed
// per-test via a global `fetch` mock — the flow never reaches GitHub.

const PASSWORD = 'hunter2hunter2';

interface GithubUserShape {
  id: number;
  login: string;
  avatar_url?: string | null;
}

/** Install a `fetch` mock that answers the two GitHub endpoints the flow hits. */
function mockGithub(opts: {
  token?: string | null;
  user?: GithubUserShape;
  tokenStatus?: number;
  userStatus?: number;
}): void {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/login/oauth/access_token')) {
      const body =
        opts.token === null
          ? { error: 'bad_verification_code' }
          : { access_token: opts.token ?? 'gho_default_token' };
      return new Response(JSON.stringify(body), {
        status: opts.tokenStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('api.github.com/user')) {
      const user = opts.user ?? { id: 4242, login: 'octocat', avatar_url: 'https://gh/av.png' };
      return new Response(JSON.stringify(user), {
        status: opts.userStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

async function makeUser(email = 'member@example.com') {
  return usersService.createUser({ email, password: PASSWORD, name: 'Member' });
}

/** Count identity rows as the OWNER (MOTIR-2887). The comment this replaces said
 *  a system context "bypasses RLS"; it does not — it binds `app.system_admin`, and
 *  whether that is seen at all depends on the table having an arm that reads it.
 *  `github_identity` does (`github_identity_owner_or_system`), so this count was
 *  correct; a count that must see EVERY row should not rest on that. */
function countIdentities(): Promise<number> {
  return adminDb.githubIdentity.count();
}

/**
 * Run `fn` inside a transaction that binds the `app.user_id` GUC and drops to
 * the non-bypass `motir_app` role — the role switch is what makes the RLS
 * policy actually bite (the default test superuser bypasses even FORCE). Mirrors
 * the local helper in tests/project-rls.test.ts.
 */
async function asAppRole<T>(
  ctx: { userId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('githubIdentityService.buildAuthorizeUrl', () => {
  it('builds the GitHub authorize URL carrying client_id, redirect_uri and state', () => {
    const url = new URL(githubIdentityService.buildAuthorizeUrl('the-state-nonce'));
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(process.env['GITHUB_APP_CLIENT_ID']);
    expect(url.searchParams.get('state')).toBe('the-state-nonce');
    expect(url.searchParams.get('redirect_uri')).toContain('/api/github/oauth/callback');
  });

  it('throws GithubOAuthNotConfiguredError when the app is unwired', () => {
    vi.stubEnv('GITHUB_APP_CLIENT_SECRET', '');
    expect(() => githubIdentityService.buildAuthorizeUrl('s')).toThrow(
      GithubOAuthNotConfiguredError,
    );
  });
});

describe('githubIdentityService.completeOAuthCallback', () => {
  it('persists an identity bound to the member with the token ENCRYPTED, and returns a token-free DTO', async () => {
    const user = await makeUser();
    mockGithub({
      token: 'gho_real_token',
      user: { id: 999, login: 'alice', avatar_url: 'https://x/a.png' },
    });

    const dto = await githubIdentityService.completeOAuthCallback({ code: 'abc', userId: user.id });

    expect(dto).toMatchObject({
      githubUserId: '999',
      githubLogin: 'alice',
      avatarUrl: 'https://x/a.png',
    });
    // The DTO must not carry the token in any form.
    expect(dto).not.toHaveProperty('accessToken');
    expect(dto).not.toHaveProperty('accessTokenEncrypted');

    const row = await withSystemContext((tx) => githubIdentityRepository.findByUserId(user.id, tx));
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(user.id);
    expect(row!.accessTokenEncrypted).not.toBe('gho_real_token'); // stored encrypted
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('gho_real_token'); // recoverable
  });

  it('upserts on re-auth — one row per member, refreshed in place', async () => {
    const user = await makeUser();

    mockGithub({ token: 'tok1', user: { id: 5, login: 'old-login', avatar_url: 'u1' } });
    const first = await githubIdentityService.completeOAuthCallback({
      code: 'c1',
      userId: user.id,
    });

    mockGithub({ token: 'tok2', user: { id: 5, login: 'new-login', avatar_url: 'u2' } });
    const second = await githubIdentityService.completeOAuthCallback({
      code: 'c2',
      userId: user.id,
    });

    expect(second.id).toBe(first.id); // same row
    expect(second.githubLogin).toBe('new-login');
    expect(second.avatarUrl).toBe('u2');
    expect(await countIdentities()).toBe(1);

    const row = await withSystemContext((tx) => githubIdentityRepository.findByUserId(user.id, tx));
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('tok2'); // token refreshed too
  });

  it('throws GithubOAuthExchangeError when the code exchange returns no token', async () => {
    const user = await makeUser();
    mockGithub({ token: null }); // { error: 'bad_verification_code' }
    await expect(
      githubIdentityService.completeOAuthCallback({ code: 'bad', userId: user.id }),
    ).rejects.toBeInstanceOf(GithubOAuthExchangeError);
    expect(await countIdentities()).toBe(0);
  });

  it('throws GithubOAuthExchangeError when the GitHub user read fails', async () => {
    const user = await makeUser();
    mockGithub({ token: 'tok', userStatus: 401 });
    await expect(
      githubIdentityService.completeOAuthCallback({ code: 'c', userId: user.id }),
    ).rejects.toBeInstanceOf(GithubOAuthExchangeError);
    expect(await countIdentities()).toBe(0);
  });

  it('throws GithubOAuthNotConfiguredError when the app is unwired', async () => {
    const user = await makeUser();
    vi.stubEnv('GITHUB_APP_CLIENT_ID', '');
    await expect(
      githubIdentityService.completeOAuthCallback({ code: 'c', userId: user.id }),
    ).rejects.toBeInstanceOf(GithubOAuthNotConfiguredError);
  });
});

describe('githubIdentityService.getIdentityForUser', () => {
  it('returns null when the member has no identity (a valid state, not an error)', async () => {
    const user = await makeUser();
    expect(await githubIdentityService.getIdentityForUser(user.id)).toBeNull();
  });

  it('returns the token-free DTO once bound, preserving a null avatar', async () => {
    const user = await makeUser();
    mockGithub({ token: 't', user: { id: 7, login: 'zed', avatar_url: null } });
    await githubIdentityService.completeOAuthCallback({ code: 'c', userId: user.id });

    const got = await githubIdentityService.getIdentityForUser(user.id);
    expect(got).toMatchObject({ githubUserId: '7', githubLogin: 'zed', avatarUrl: null });
    expect(got).not.toHaveProperty('accessTokenEncrypted');
  });

  it("is RLS-isolated — the migration policy hides another member's row under the app role", async () => {
    const alice = await makeUser('alice@example.com');
    const bob = await makeUser('bob@example.com');
    mockGithub({ token: 't', user: { id: 11, login: 'alice-gh', avatar_url: null } });
    await githubIdentityService.completeOAuthCallback({ code: 'c', userId: alice.id });

    // Same `where user_id = alice` read, run as motir_app: bound to BOB's GUC
    // the policy hides Alice's row; bound to Alice's GUC her own row is visible.
    const underBob = await asAppRole({ userId: bob.id }, (tx) =>
      githubIdentityRepository.findByUserId(alice.id, tx),
    );
    expect(underBob).toBeNull();

    const underAlice = await asAppRole({ userId: alice.id }, (tx) =>
      githubIdentityRepository.findByUserId(alice.id, tx),
    );
    expect(underAlice).not.toBeNull();
  });
});

describe('githubIdentityService.disconnect', () => {
  it("unbinds the member's identity, leaving no row", async () => {
    const user = await makeUser();
    mockGithub({ token: 't', user: { id: 21, login: 'gone', avatar_url: null } });
    await githubIdentityService.completeOAuthCallback({ code: 'c', userId: user.id });
    expect(await countIdentities()).toBe(1);

    await githubIdentityService.disconnect(user.id);

    expect(await countIdentities()).toBe(0);
    expect(await githubIdentityService.getIdentityForUser(user.id)).toBeNull();
  });

  it('is idempotent — disconnecting an unbound member is a no-op', async () => {
    const user = await makeUser();
    await expect(githubIdentityService.disconnect(user.id)).resolves.toBeUndefined();
    expect(await countIdentities()).toBe(0);
  });

  it("removes only the acting member's identity, not another member's", async () => {
    const alice = await makeUser('alice@example.com');
    const bob = await makeUser('bob@example.com');
    mockGithub({ token: 't', user: { id: 1, login: 'alice-gh', avatar_url: null } });
    await githubIdentityService.completeOAuthCallback({ code: 'c', userId: alice.id });
    mockGithub({ token: 't', user: { id: 2, login: 'bob-gh', avatar_url: null } });
    await githubIdentityService.completeOAuthCallback({ code: 'c', userId: bob.id });
    expect(await countIdentities()).toBe(2);

    await githubIdentityService.disconnect(alice.id);

    expect(await countIdentities()).toBe(1);
    expect(await githubIdentityService.getIdentityForUser(alice.id)).toBeNull();
    expect(await githubIdentityService.getIdentityForUser(bob.id)).not.toBeNull();
  });
});

// ─── Bug MOTIR-10021 — the expiring user token is kept and renewed ────────────
//
// Motir Integration expires user tokens after eight hours (MOTIR-6522). These
// assert the link keeps what renewal needs, and that `getLiveToken` renews —
// once, under concurrency — against the real datastore, with GitHub's token
// endpoint faked.

const HOUR = 60 * 60 * 1000;

/** Seed an identity row directly, as a link made at some earlier time left it. */
async function seedIdentity(
  userId: string,
  fields: {
    accessToken: string;
    refreshToken?: string | null;
    tokenExpiresAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
  },
) {
  return adminDb.githubIdentity.create({
    data: {
      userId,
      githubUserId: `gh-${userId}`,
      githubLogin: 'octocat',
      accessTokenEncrypted: encryptToken(fields.accessToken),
      refreshTokenEncrypted: fields.refreshToken ? encryptToken(fields.refreshToken) : null,
      tokenExpiresAt: fields.tokenExpiresAt ?? null,
      refreshTokenExpiresAt: fields.refreshTokenExpiresAt ?? null,
    },
  });
}

function readIdentity(userId: string) {
  return adminDb.githubIdentity.findUniqueOrThrow({ where: { userId } });
}

/** Fake GitHub's token endpoint for the refresh grant, recording every call. */
function mockRefreshEndpoint(answer: {
  body?: Record<string, unknown>;
  status?: number;
  delayMs?: number;
}) {
  const calls: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/login/oauth/access_token')) {
      throw new Error(`unexpected fetch in test: ${url}`);
    }
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const ROTATED = {
  access_token: 'ghu_rotated_access',
  refresh_token: 'ghr_rotated_refresh',
  expires_in: 28_800,
  refresh_token_expires_in: 15_897_600,
  token_type: 'bearer',
};

describe('githubIdentityService — expiring user tokens (Bug MOTIR-10021)', () => {
  it('linking stores the access token, the encrypted refresh token and both expiries', async () => {
    const user = await makeUser();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = url.includes('/login/oauth/access_token')
        ? {
            access_token: 'ghu_linked',
            refresh_token: 'ghr_linked',
            expires_in: 28_800,
            refresh_token_expires_in: 15_897_600,
          }
        : { id: 77, login: 'expiring', avatar_url: null };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const before = Date.now();
    await githubIdentityService.completeOAuthCallback({ code: 'c', userId: user.id });

    const row = await readIdentity(user.id);
    expect(decryptToken(row.accessTokenEncrypted)).toBe('ghu_linked');
    expect(row.refreshTokenEncrypted).not.toBe('ghr_linked'); // encrypted at rest
    expect(decryptToken(row.refreshTokenEncrypted!)).toBe('ghr_linked');
    expect(row.tokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + 28_800_000);
    expect(row.tokenExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 28_800_000);
    expect(row.refreshTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + 15_897_600_000);
  });

  it('renews an access token inside the margin: one refresh grant, the rotated pair persisted', async () => {
    const user = await makeUser();
    await seedIdentity(user.id, {
      accessToken: 'ghu_old',
      refreshToken: 'ghr_old',
      tokenExpiresAt: new Date(Date.now() + 30_000), // inside the 60 s margin
      refreshTokenExpiresAt: new Date(Date.now() + 1000 * HOUR),
    });
    const { calls } = mockRefreshEndpoint({ body: ROTATED });

    const before = Date.now();
    const live = await githubIdentityService.getLiveToken(user.id);

    expect(live).toEqual({ accessToken: 'ghu_rotated_access' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'ghr_old',
      client_id: process.env['GITHUB_APP_CLIENT_ID'],
    });
    const row = await readIdentity(user.id);
    expect(decryptToken(row.accessTokenEncrypted)).toBe('ghu_rotated_access');
    expect(decryptToken(row.refreshTokenEncrypted!)).toBe('ghr_rotated_refresh');
    expect(row.tokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + 8 * HOUR);
    expect(row.refreshTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + 4000 * HOUR);
    expect(row.refreshLeaseUntil).toBeNull();
  });

  it('two concurrent calls on an expiring identity spend ONE refresh and both get its token', async () => {
    const user = await makeUser();
    await seedIdentity(user.id, {
      accessToken: 'ghu_old',
      refreshToken: 'ghr_old',
      tokenExpiresAt: new Date(Date.now() - HOUR),
    });
    const { calls } = mockRefreshEndpoint({ body: ROTATED, delayMs: 400 });

    const [a, b] = await Promise.all([
      githubIdentityService.getLiveToken(user.id),
      githubIdentityService.getLiveToken(user.id),
    ]);

    expect(calls).toHaveLength(1);
    expect(a).toEqual({ accessToken: 'ghu_rotated_access' });
    expect(b).toEqual({ accessToken: 'ghu_rotated_access' });
  });

  it('a refused refresh (bad_refresh_token) lands on the reconnect state and is not retried', async () => {
    const user = await makeUser();
    await seedIdentity(user.id, {
      accessToken: 'ghu_old',
      refreshToken: 'ghr_revoked',
      tokenExpiresAt: new Date(Date.now() - HOUR),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { calls } = mockRefreshEndpoint({
      body: { error: 'bad_refresh_token', error_description: 'The refresh token is invalid.' },
    });

    await expect(githubIdentityService.getLiveToken(user.id)).rejects.toBeInstanceOf(
      GithubIdentityRefusedError,
    );
    const row = await readIdentity(user.id);
    expect(row.refreshRefusedAt).not.toBeNull();
    expect(row.refreshLeaseUntil).toBeNull();
    // The log line names the reason and carries no credential.
    expect(JSON.stringify(warn.mock.calls)).toContain('bad_refresh_token');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ghr_revoked');

    // The next call answers the same state at once, with no call to GitHub.
    await expect(githubIdentityService.getLiveToken(user.id)).rejects.toBeInstanceOf(
      GithubIdentityRefusedError,
    );
    expect(calls).toHaveLength(1);
    warn.mockRestore();
  });

  it('a refresh token past its own expiry is refused without spending a call', async () => {
    const user = await makeUser();
    await seedIdentity(user.id, {
      accessToken: 'ghu_old',
      refreshToken: 'ghr_aged_out',
      tokenExpiresAt: new Date(Date.now() - HOUR),
      refreshTokenExpiresAt: new Date(Date.now() - HOUR),
    });
    const { calls } = mockRefreshEndpoint({ body: ROTATED });

    await expect(githubIdentityService.getLiveToken(user.id)).rejects.toBeInstanceOf(
      GithubIdentityRefusedError,
    );
    expect(calls).toHaveLength(0);
    expect((await readIdentity(user.id)).refreshRefusedAt).not.toBeNull();
  });

  it('a renewal GitHub does not answer is UNAVAILABLE: the pair is kept and the lease released', async () => {
    const user = await makeUser();
    await seedIdentity(user.id, {
      accessToken: 'ghu_old',
      refreshToken: 'ghr_old',
      tokenExpiresAt: new Date(Date.now() - HOUR),
    });
    const { calls } = mockRefreshEndpoint({ status: 502 });

    await expect(githubIdentityService.getLiveToken(user.id)).rejects.toBeInstanceOf(
      GithubIdentityRefreshUnavailableError,
    );
    const row = await readIdentity(user.id);
    expect(decryptToken(row.refreshTokenEncrypted!)).toBe('ghr_old');
    expect(row.refreshRefusedAt).toBeNull();
    expect(row.refreshLeaseUntil).toBeNull();

    // Not a dead sign-in: the next call tries the renewal again.
    mockRefreshEndpoint({ body: ROTATED });
    await expect(githubIdentityService.getLiveToken(user.id)).resolves.toEqual({
      accessToken: 'ghu_rotated_access',
    });
    expect(calls).toHaveLength(1);
  });

  it('a token outside the margin is returned as stored, with no refresh', async () => {
    const user = await makeUser();
    await seedIdentity(user.id, {
      accessToken: 'ghu_fresh',
      refreshToken: 'ghr_fresh',
      tokenExpiresAt: new Date(Date.now() + 4 * HOUR),
    });
    const { calls } = mockRefreshEndpoint({ body: ROTATED });

    await expect(githubIdentityService.getLiveToken(user.id)).resolves.toEqual({
      accessToken: 'ghu_fresh',
    });
    expect(calls).toHaveLength(0);
  });

  it('an identity linked before this change (no refresh token) is returned unchanged, never renewed', async () => {
    const user = await makeUser();
    const seeded = await seedIdentity(user.id, { accessToken: 'gho_legacy' });
    const { calls } = mockRefreshEndpoint({ body: ROTATED });

    await expect(githubIdentityService.getLiveToken(user.id)).resolves.toEqual({
      accessToken: 'gho_legacy',
    });
    expect(calls).toHaveLength(0);
    const row = await readIdentity(user.id);
    expect(row.accessTokenEncrypted).toBe(seeded.accessTokenEncrypted);
    expect(row.updatedAt).toEqual(seeded.updatedAt);
  });

  it('the identity DTO carries the refused state as needsReauth, and no credential field (Bug MOTIR-10047)', async () => {
    const user = await makeUser();
    await seedIdentity(user.id, { accessToken: 'ghu_live', refreshToken: 'ghr_live' });
    expect(await githubIdentityService.getIdentityForUser(user.id)).toMatchObject({
      needsReauth: false,
    });

    await adminDb.githubIdentity.update({
      where: { userId: user.id },
      data: { refreshRefusedAt: new Date() },
    });
    const dto = await githubIdentityService.getIdentityForUser(user.id);

    expect(dto?.needsReauth).toBe(true);
    // The pane needs a yes/no, never the timestamp, and never anything about the
    // tokens behind it. The key set is pinned, so a new field is a decision.
    expect(Object.keys(dto ?? {}).sort()).toEqual(
      ['avatarUrl', 'createdAt', 'githubLogin', 'githubUserId', 'id', 'needsReauth'].sort(),
    );
    expect(JSON.stringify(dto)).not.toContain('ghu_live');
    expect(JSON.stringify(dto)).not.toContain('ghr_live');
  });

  it('reconnecting clears the refused mark, so the new sign-in works', async () => {
    const user = await makeUser();
    await seedIdentity(user.id, { accessToken: 'ghu_dead', refreshToken: 'ghr_dead' });
    await adminDb.githubIdentity.update({
      where: { userId: user.id },
      data: { refreshRefusedAt: new Date() },
    });
    await expect(githubIdentityService.getLiveToken(user.id)).rejects.toBeInstanceOf(
      GithubIdentityRefusedError,
    );

    mockGithub({ token: 'gho_reconnected', user: { id: 5150, login: 'octocat' } });
    await githubIdentityService.completeOAuthCallback({ code: 'c', userId: user.id });

    const row = await readIdentity(user.id);
    expect(row.refreshRefusedAt).toBeNull();
    // A sign-in that came back with no refresh token keeps no stale one.
    expect(row.refreshTokenEncrypted).toBeNull();
    await expect(githubIdentityService.getLiveToken(user.id)).resolves.toEqual({
      accessToken: 'gho_reconnected',
    });
  });
});
