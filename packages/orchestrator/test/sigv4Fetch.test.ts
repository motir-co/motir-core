import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSigV4Fetch } from '../src/adapters/aws/tenant';
import { defaultChainCredentials } from '../src/adapters/aws/tenant/sdk';

// MOTIR-10011 — the SigV4-signing fetch a function release's IAM-authorised URL
// is read through. No network: the fetch underneath is a recording stub.

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  sessionToken: 'session-token-example',
};

function recording() {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response('ok', { status: 200 });
  };
  return { sent, fetch };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('createSigV4Fetch', () => {
  it('signs a GET for service lambda in the region, with the session token, and sends no host header', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-28T12:00:00Z'), toFake: ['Date'] });
    const { sent, fetch } = recording();
    const signed = createSigV4Fetch({
      region: 'eu-west-1',
      credentials: async () => CREDENTIALS,
      fetch,
    });

    const res = await signed('https://abc.lambda-url.eu-west-1.on.aws/row?x=1', {
      headers: { accept: 'application/json' },
    });

    expect(res.status).toBe(200);
    const [{ url, init }] = sent as [{ url: string; init: RequestInit }];
    expect(url).toBe('https://abc.lambda-url.eu-west-1.on.aws/row?x=1');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    const headers = init.headers as Record<string, string>;
    expect(headers['host']).toBeUndefined();
    expect(headers['accept']).toBe('application/json');
    expect(headers['x-amz-date']).toBe('20261028T120000Z');
    expect(headers['x-amz-security-token']).toBe(CREDENTIALS.sessionToken);
    expect(headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261028\/eu-west-1\/lambda\/aws4_request, SignedHeaders=[a-z0-9;-]*host[a-z0-9;-]*, Signature=[0-9a-f]{64}$/,
    );
    expect(headers['authorization']).not.toContain(CREDENTIALS.secretAccessKey);
  });

  it('signs a port and a HEAD, and a different path signs differently', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-28T12:00:00Z'), toFake: ['Date'] });
    const { sent, fetch } = recording();
    const signed = createSigV4Fetch({
      region: 'eu-west-1',
      credentials: async () => ({ accessKeyId: 'A', secretAccessKey: 'S' }),
      fetch,
    });
    await signed('https://local.test:8443/health', { method: 'HEAD' });
    await signed('https://local.test:8443/row');
    const auth = sent.map((s) => (s.init.headers as Record<string, string>)['authorization']);
    expect(sent[0]!.init.method).toBe('HEAD');
    expect(auth[0]).not.toBe(auth[1]);
    expect((sent[1]!.init.headers as Record<string, string>)['x-amz-security-token']).toBe(
      undefined,
    );
  });

  it('falls back to the default credential chain and the global fetch', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDCHAIN');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'chain-secret');
    vi.stubEnv('AWS_SESSION_TOKEN', '');
    const global = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', global);
    try {
      const res = await createSigV4Fetch({ region: 'eu-west-1' })('https://fn.test/health');
      expect(res.status).toBe(204);
      const init = global.mock.calls[0]![1] as RequestInit;
      expect((init.headers as Record<string, string>)['authorization']).toContain(
        'Credential=AKIDCHAIN/',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('defaultChainCredentials resolves the environment credentials', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDENV');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'env-secret');
    expect(await defaultChainCredentials('eu-west-1')()).toMatchObject({
      accessKeyId: 'AKIDENV',
    });
  });
});
