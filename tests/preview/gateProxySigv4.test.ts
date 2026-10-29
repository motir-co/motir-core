// MOTIR-5779 — a ready preview on a SigV4 release (a Lambda function URL): its
// signature covers the payload, so the gate buffers the body, signs the request
// and FETCHES it, relaying the answer — Next's external rewrite cannot carry a
// signature. The signer and the route are stubbed; the forwarding is real.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GATE_COOKIE, mintAdmission, mintGatePass } from '@/lib/preview/gate';

const { sign } = vi.hoisted(() => ({
  sign: vi.fn(async (_url: string, init: { method?: string; body?: Uint8Array }) => ({
    method: init.method ?? 'GET',
    headers: { authorization: 'AWS4-HMAC-SHA256 signed', 'x-amz-date': '20261029T000000Z' },
    ...(init.body ? { body: init.body } : {}),
  })),
}));
vi.mock('@motir/orchestrator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@motir/orchestrator')>()),
  signFunctionUrlRequest: sign,
}));
const { route } = vi.hoisted(() => ({ route: vi.fn() }));
vi.mock('@/lib/services/previewGateService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/previewGateService')>()),
  previewGateService: { route },
}));

const HOST = 'pr-14--portal.preview.motir.site';
const KEY = 'test-gate-signing-key';
const ORIGIN = 'https://abc123.lambda-url.eu-west-1.on.aws';

beforeEach(() => {
  vi.stubEnv('MOTIR_PREVIEW_DOMAIN', 'preview.motir.site');
  vi.stubEnv('MOTIR_HOSTING_GATE_SIGNING_KEY', KEY);
  route.mockResolvedValue({
    state: 'ready',
    target: 'serverless',
    upstream: { origin: ORIGIN, credential: 'aws_sigv4', headers: {} },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function cookie(): string {
  const { admission } = mintAdmission({ host: HOST, sub: 'u1' }, KEY);
  return `${GATE_COOKIE}=${mintGatePass(admission, KEY)}; better-auth.session_token=s; app=1`;
}

describe('the SigV4 forward', () => {
  it('signs the buffered body, fetches the release and relays its answer', async () => {
    const { previewHostResponse } = await import('@/lib/preview/gateProxy');
    const fetchImpl = vi.fn(
      async (_url: URL | RequestInfo, _init?: RequestInit) =>
        new Response('created', {
          status: 201,
          headers: { location: `${ORIGIN}/items/1`, 'content-encoding': 'gzip' },
        }),
    );
    const res = await previewHostResponse(
      new NextRequest(`https://${HOST}/items?draft=1`, {
        method: 'POST',
        headers: {
          host: HOST,
          cookie: cookie(),
          'content-length': '7',
          'content-type': 'text/plain',
        },
        body: 'payload',
      }),
      HOST,
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('created');
    expect(res.headers.get('location')).toBe(`https://${HOST}/items/1`);
    expect(res.headers.get('content-encoding')).toBeNull();

    const [signedUrl, signInit] = sign.mock.calls[0]!;
    expect(signedUrl).toBe(`${ORIGIN}/items?draft=1`);
    expect(new TextDecoder().decode(signInit.body)).toBe('payload');

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${ORIGIN}/items?draft=1`);
    const headers = init!.headers as Headers;
    expect(headers.get('authorization')).toBe('AWS4-HMAC-SHA256 signed');
    expect(headers.get('cookie')).toBe('app=1');
    expect(headers.get('host')).toBeNull();
    expect(init!.redirect).toBe('manual');
  });

  it('a GET carries no body, and 6 MB is the serverless ceiling', async () => {
    const { previewHostResponse } = await import('@/lib/preview/gateProxy');
    const fetchImpl = vi.fn(async () => new Response('ok'));
    await previewHostResponse(
      new NextRequest(`https://${HOST}/`, { headers: { host: HOST, cookie: cookie() } }),
      HOST,
      fetchImpl as unknown as typeof fetch,
    );
    expect(sign.mock.calls[0]![1]).toEqual({ method: 'GET' });
    const big = await previewHostResponse(
      new NextRequest(`https://${HOST}/upload`, {
        method: 'POST',
        headers: { host: HOST, cookie: cookie(), 'content-length': String(6 * 1024 * 1024 + 1) },
      }),
      HOST,
      fetchImpl as unknown as typeof fetch,
    );
    expect(big.status).toBe(413);
  });

  it('rethrows what is not a configuration refusal', async () => {
    const { previewHostResponse } = await import('@/lib/preview/gateProxy');
    route.mockRejectedValue(new Error('database down'));
    await expect(
      previewHostResponse(
        new NextRequest(`https://${HOST}/`, { headers: { host: HOST, cookie: cookie() } }),
        HOST,
      ),
    ).rejects.toThrow('database down');
  });
});
