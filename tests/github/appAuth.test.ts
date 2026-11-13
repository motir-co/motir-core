import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import {
  createAppJwt,
  evictInstallationToken,
  mintInstallationToken,
  GithubAppNotConfiguredError,
  GithubAppTokenError,
  _resetInstallationTokenCache,
} from '@/lib/github/appAuth';

// The GitHub-App auth leaf (Story 7.10 · MOTIR-891): App-JWT signing +
// on-demand installation-token mint + in-memory cache. No DB. The App private
// key is a real RSA keypair generated per run; the token endpoint is stubbed via
// a global `fetch` mock — the flow never reaches GitHub.

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APP_ID = '123456';

function configureApp(): void {
  vi.stubEnv('GITHUB_APP_ID', APP_ID);
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
}

/** A `fetch` mock for the installation-token endpoint. Records call count. */
function mockTokenEndpoint(opts: {
  token?: string;
  expiresInMs?: number;
  status?: number;
  body?: unknown;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    if (opts.status && opts.status >= 400) {
      return new Response('nope', { status: opts.status });
    }
    const body = opts.body ?? {
      token: opts.token ?? 'ghs_installation_token',
      expires_at: new Date(Date.now() + (opts.expiresInMs ?? 60 * 60 * 1000)).toISOString(),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  _resetInstallationTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('createAppJwt', () => {
  it('signs a verifiable RS256 JWT carrying the App id and a ≤10-min expiry', () => {
    configureApp();
    const now = 1_700_000_000;
    const jwt = createAppJwt(now);

    const [headerB64, payloadB64, signatureB64] = jwt.split('.');
    expect(headerB64 && payloadB64 && signatureB64).toBeTruthy();

    const header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe(APP_ID);
    expect(payload.iat).toBe(now - 60); // backdated for clock skew
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600); // ≤ 10 min

    // The signature verifies against the App public key over `header.payload`.
    const ok = cryptoVerify(
      'RSA-SHA256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      publicKey,
      Buffer.from(signatureB64!, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('throws GithubAppNotConfiguredError when the App is unwired', () => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '');
    expect(() => createAppJwt()).toThrow(GithubAppNotConfiguredError);
  });
});

describe('mintInstallationToken', () => {
  it('mints a token from the token endpoint and returns it with its expiry', async () => {
    configureApp();
    const fetchMock = mockTokenEndpoint({ token: 'ghs_abc' });

    const tok = await mintInstallationToken('42');
    expect(tok.token).toBe('ghs_abc');
    expect(tok.expiresAt).toBeInstanceOf(Date);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The endpoint is the installation-scoped one, called with the App JWT.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(String((init.headers as Record<string, string>).authorization)).toMatch(/^Bearer /);
  });

  it('caches a still-valid token and does NOT re-mint (never persisted, in-memory)', async () => {
    configureApp();
    const fetchMock = mockTokenEndpoint({ token: 'ghs_cached', expiresInMs: 60 * 60 * 1000 });

    const first = await mintInstallationToken('7');
    const second = await mintInstallationToken('7');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('re-mints when the cached token is within the expiry skew window', async () => {
    configureApp();
    // Expires in 30s — inside the 60s re-mint skew, so every call re-mints.
    const fetchMock = mockTokenEndpoint({ token: 'ghs_soon', expiresInMs: 30 * 1000 });

    await mintInstallationToken('9');
    await mintInstallationToken('9');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches per installation id (distinct installations mint separately)', async () => {
    configureApp();
    const fetchMock = mockTokenEndpoint({ expiresInMs: 60 * 60 * 1000 });

    await mintInstallationToken('100');
    await mintInstallationToken('200');
    await mintInstallationToken('100'); // cached
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws GithubAppTokenError on a non-2xx token response', async () => {
    configureApp();
    mockTokenEndpoint({ status: 500 });
    await expect(mintInstallationToken('1')).rejects.toBeInstanceOf(GithubAppTokenError);
  });

  it('throws GithubAppTokenError on an unexpected response shape', async () => {
    configureApp();
    mockTokenEndpoint({ body: { nope: true } });
    await expect(mintInstallationToken('1')).rejects.toBeInstanceOf(GithubAppTokenError);
  });

  it('throws GithubAppNotConfiguredError when the App is unwired', async () => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '');
    await expect(mintInstallationToken('1')).rejects.toBeInstanceOf(GithubAppNotConfiguredError);
  });
});

// MOTIR-11229: a GitHub token keeps the permissions it was minted with, so a
// permission granted since the mint never reaches the cached token. Evicting it
// is how a caller refused 403 gets one minted under the grant.
describe('evictInstallationToken', () => {
  /** A token endpoint answering a new token on every mint: tok-1, tok-2, … */
  function mockMintingEndpoint(): ReturnType<typeof vi.fn> {
    let minted = 0;
    const fetchMock = vi.fn(async () => {
      minted += 1;
      return new Response(
        JSON.stringify({
          token: `tok-${minted}`,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('drops the cached token, so the next mint is a new one', async () => {
    configureApp();
    const fetchMock = mockMintingEndpoint();

    expect((await mintInstallationToken('42')).token).toBe('tok-1');
    expect((await mintInstallationToken('42')).token).toBe('tok-1'); // cached
    evictInstallationToken('42');
    expect((await mintInstallationToken('42')).token).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('drops only that role’s token for that installation', async () => {
    configureApp();
    vi.stubEnv('GITHUB_STUDIO_APP_ID', '999');
    vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
    mockMintingEndpoint();

    const userFacing = (await mintInstallationToken('42')).token;
    const provisioning = (await mintInstallationToken('42', 'provisioning')).token;
    const other = (await mintInstallationToken('43', 'provisioning')).token;

    evictInstallationToken('42', 'provisioning');

    expect((await mintInstallationToken('42')).token).toBe(userFacing);
    expect((await mintInstallationToken('43', 'provisioning')).token).toBe(other);
    expect((await mintInstallationToken('42', 'provisioning')).token).not.toBe(provisioning);
  });

  it('is a no-op for a token that is not cached', async () => {
    configureApp();
    const fetchMock = mockMintingEndpoint();
    evictInstallationToken('never-minted', 'provisioning');
    expect((await mintInstallationToken('42')).token).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
