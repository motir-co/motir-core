// MOTIR-5779 — the preview host through the REAL `proxy()` on real Postgres:
// no cookie goes to preview-access with the host and path; the admission is
// consumed once and sets the `__Host-` cookie; the four refused admissions set
// nothing; a ready preview is forwarded to its release with its origin secret
// and without Motir's session; the gate's 501 / 413 / 411; and app.motir.co
// itself is untouched.
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveOriginSecret } from '@motir/orchestrator';
import en from '@/messages/en.json';
import { db } from '@/lib/db';
import { resetHostingFakes } from '@/lib/orchestrator/hosting';
import {
  ADMISSION_TTL_MS,
  GATE_COOKIE,
  PREVIEW_GATE_PAGE_PATH,
  mintAdmission,
  mintGatePass,
} from '@/lib/preview/gate';
import { UNSUPPORTED_SENTENCE, relay, unsupportedResponse } from '@/lib/preview/gateProxy';
import { resetPreviewRouteCache } from '@/lib/services/previewGateService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { PREVIEW_HOST, makePreviewGateFixture } from '../helpers/previewGateFixture';

const sessionCookie = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('better-auth/cookies', () => ({
  getSessionCookie: () => sessionCookie.value,
}));

const KEY = 'test-gate-signing-key';
const ORIGIN_KEY = 'test-origin-secret-key';

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.previewGateAdmission.deleteMany();
  resetHostingFakes();
  resetPreviewRouteCache();
  sessionCookie.value = null;
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_PREVIEW_DOMAIN', 'preview.motir.site');
  vi.stubEnv('MOTIR_HOSTING_GATE_SIGNING_KEY', KEY);
  vi.stubEnv('MOTIR_HOSTING_ORIGIN_SECRET_KEY', ORIGIN_KEY);
  vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function send(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  const { proxy } = await import('@/proxy');
  const parsed = new URL(url);
  return proxy(
    new NextRequest(url, {
      method: init.method ?? 'GET',
      headers: { host: parsed.host, ...init.headers },
      ...(init.body !== undefined ? { body: init.body } : {}),
    }),
  );
}

function passCookie(host = PREVIEW_HOST): string {
  const { admission } = mintAdmission({ host, sub: 'user-1' }, KEY);
  return `${GATE_COOKIE}=${mintGatePass(admission, KEY)}`;
}

/** The internal page a response was rewritten to, or null. */
function rewrittenTo(res: Response): URL | null {
  const target = res.headers.get('x-middleware-rewrite');
  return target ? new URL(target) : null;
}

describe('a preview host without a gate cookie', () => {
  it('goes to app.motir.co/preview-access carrying the host and the path', async () => {
    const res = await send(`https://${PREVIEW_HOST}/invoices?status=open`);
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe('https://app.motir.co');
    expect(location.pathname).toBe('/preview-access');
    expect(location.searchParams.get('host')).toBe(PREVIEW_HOST);
    expect(location.searchParams.get('return')).toBe('/invoices?status=open');
  });

  it('goes there whatever the host holds — a live row, a closed one or none', async () => {
    await makePreviewGateFixture({ state: 'closed' });
    for (const host of [PREVIEW_HOST, 'pr-99--portal.preview.motir.site']) {
      const res = await send(`https://${host}/`);
      expect(res.status, host).toBe(303);
      expect(new URL(res.headers.get('location')!).pathname).toBe('/preview-access');
    }
  });

  it('a cookie for ANOTHER preview host does not let it in', async () => {
    const res = await send(`https://${PREVIEW_HOST}/`, {
      headers: { cookie: passCookie('pr-15--portal.preview.motir.site') },
    });
    expect(res.status).toBe(303);
  });
});

describe('/__motir/preview-auth — the admission is consumed once', () => {
  it('sets the __Host- cookie with Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain, then returns', async () => {
    const { token } = mintAdmission({ host: PREVIEW_HOST, sub: 'user-1' }, KEY);
    const res = await send(
      `https://${PREVIEW_HOST}/__motir/preview-auth?token=${token}&return=${encodeURIComponent('/invoices?x=1')}`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`https://${PREVIEW_HOST}/invoices?x=1`);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^__Host-motir-gate=[^;]+;/);
    const attributes = setCookie.split(';').map((part) => part.trim().toLowerCase());
    expect(attributes).toContain('secure');
    expect(attributes).toContain('httponly');
    expect(attributes).toContain('samesite=lax');
    expect(attributes).toContain('path=/');
    expect(attributes).toContain(`max-age=${8 * 60 * 60}`);
    expect(attributes.some((a) => a.startsWith('domain'))).toBe(false);
  });

  async function refusedWithNoCookie(url: string) {
    const res = await send(url);
    expect(res.headers.get('set-cookie')).toBeNull();
    // The page the refusal renders: Not found, Closed's layout — a viewer
    // without a pass for this host is shown nothing it could not know.
    expect(rewrittenTo(res)?.pathname).toBe(PREVIEW_GATE_PAGE_PATH);
  }

  it('refuses a token replayed a second time', async () => {
    const { token } = mintAdmission({ host: PREVIEW_HOST, sub: 'user-1' }, KEY);
    const url = `https://${PREVIEW_HOST}/__motir/preview-auth?token=${token}`;
    expect((await send(url)).headers.get('set-cookie')).not.toBeNull();
    await refusedWithNoCookie(url);
  });

  it('refuses a token for another host', async () => {
    const { token } = mintAdmission({ host: 'pr-15--portal.preview.motir.site', sub: 'u' }, KEY);
    await refusedWithNoCookie(`https://${PREVIEW_HOST}/__motir/preview-auth?token=${token}`);
  });

  it('refuses an expired token', async () => {
    const { token } = mintAdmission(
      { host: PREVIEW_HOST, sub: 'u' },
      KEY,
      new Date(Date.now() - ADMISSION_TTL_MS - 1),
    );
    await refusedWithNoCookie(`https://${PREVIEW_HOST}/__motir/preview-auth?token=${token}`);
  });

  it('refuses a tampered token', async () => {
    const { token } = mintAdmission({ host: PREVIEW_HOST, sub: 'u' }, KEY);
    const [body, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), sub: 'admin' }),
    ).toString('base64url');
    await refusedWithNoCookie(
      `https://${PREVIEW_HOST}/__motir/preview-auth?token=${forged}.${mac}`,
    );
  });

  it('never returns off the preview host', async () => {
    for (const raw of ['https://evil.example/x', '//evil.example', '/%2F%2Fevil.example']) {
      const { token } = mintAdmission({ host: PREVIEW_HOST, sub: 'u' }, KEY);
      const res = await send(
        `https://${PREVIEW_HOST}/__motir/preview-auth?token=${token}&return=${encodeURIComponent(raw)}`,
      );
      expect(res.headers.get('location'), raw).toBe(`https://${PREVIEW_HOST}/`);
    }
  });
});

describe('a member with a gate cookie', () => {
  it('a ready preview is forwarded to its release with the origin secret and no Motir session', async () => {
    const p = await makePreviewGateFixture();
    const res = await send(`https://${PREVIEW_HOST}/invoices?status=open`, {
      headers: {
        cookie: `${passCookie()}; better-auth.session_token=secret-session; __Secure-better-auth.session_token=s2; theme=dark`,
        'x-motir-origin-secret': 'forged-by-the-viewer',
      },
    });
    const target = rewrittenTo(res)!;
    expect(target.origin).toBe(`https://${p.appRef}.fake.invalid`);
    expect(`${target.pathname}${target.search}`).toBe('/invoices?status=open');
    // The forwarded request's headers (Next's request-override protocol).
    const forwarded = (name: string) => res.headers.get(`x-middleware-request-${name}`);
    expect(forwarded('x-motir-origin-secret')).toBe(deriveOriginSecret(ORIGIN_KEY, p.appRef));
    expect(forwarded('cookie')).toBe('theme=dark');
    expect(forwarded('x-forwarded-host')).toBe(PREVIEW_HOST);
    expect(res.headers.get('x-middleware-override-headers')).toContain('cookie');
  });

  it('a request carrying ONLY Motir cookies is forwarded with no Cookie header', async () => {
    await makePreviewGateFixture();
    const res = await send(`https://${PREVIEW_HOST}/`, {
      headers: { cookie: `${passCookie()}; better-auth.session_token=x` },
    });
    expect(res.headers.get('x-middleware-override-headers')?.split(',')).not.toContain('cookie');
  });

  it('a non-ready preview is rewritten to the gate page, its address kept', async () => {
    for (const state of ['building', 'starting', 'failed', 'closed'] as const) {
      await truncateAuthTables();
      resetPreviewRouteCache();
      await makePreviewGateFixture({ state });
      const res = await send(`https://${PREVIEW_HOST}/invoices`, {
        headers: { cookie: passCookie() },
      });
      expect(rewrittenTo(res)?.pathname, state).toBe(PREVIEW_GATE_PAGE_PATH);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it('a write to a non-ready preview is a 503, never a page', async () => {
    await makePreviewGateFixture({ state: 'building' });
    const res = await send(`https://${PREVIEW_HOST}/api/save`, {
      method: 'POST',
      headers: { cookie: passCookie(), 'content-length': '2' },
      body: '{}',
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
  });

  it('a host with no row is rewritten to the page, which shows Not found', async () => {
    const res = await send(`https://${PREVIEW_HOST}/`, { headers: { cookie: passCookie() } });
    expect(rewrittenTo(res)?.pathname).toBe(PREVIEW_GATE_PAGE_PATH);
  });

  it('the unsupported page is the gate page with its kind, and only a known kind', async () => {
    const ok = await send(`https://${PREVIEW_HOST}/__motir/preview-unsupported?kind=tooLarge`, {
      headers: { cookie: passCookie() },
    });
    expect(rewrittenTo(ok)?.searchParams.get('unsupported')).toBe('tooLarge');
    const junk = await send(`https://${PREVIEW_HOST}/__motir/preview-unsupported?kind=__proto__`, {
      headers: { cookie: passCookie() },
    });
    expect(rewrittenTo(junk)?.searchParams.has('unsupported')).toBe(false);
  });
});

describe('§5 — the gate refuses rather than truncates', () => {
  beforeEach(async () => {
    await makePreviewGateFixture();
  });

  it('a websocket upgrade is 501, with the sentence as text for a script', async () => {
    const res = await send(`https://${PREVIEW_HOST}/socket`, {
      headers: { cookie: passCookie(), upgrade: 'websocket', connection: 'Upgrade' },
    });
    expect(res.status).toBe(501);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect((await res.text()).trim()).toBe(UNSUPPORTED_SENTENCE.websocket);
  });

  it('a body over 10 MB is 413 and a write with no length is 411', async () => {
    const big = await send(`https://${PREVIEW_HOST}/upload`, {
      method: 'POST',
      headers: { cookie: passCookie(), 'content-length': String(10 * 1024 * 1024 + 1) },
    });
    expect(big.status).toBe(413);
    const unsized = await send(`https://${PREVIEW_HOST}/upload`, {
      method: 'POST',
      headers: { cookie: passCookie(), 'transfer-encoding': 'chunked' },
    });
    expect(unsized.status).toBe(411);
  });

  it('a browser navigation keeps the status and is sent on to the Panel 6b page', async () => {
    const res = unsupportedResponse(
      new Request(`https://${PREVIEW_HOST}/upload`, {
        method: 'POST',
        headers: { 'sec-fetch-dest': 'document' },
      }),
      'tooLarge',
    );
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('/__motir/preview-unsupported?kind=tooLarge');
  });

  it('the script sentences are en.json’s copy, word for word', () => {
    const copy = en.previewGate.unsupported;
    expect(UNSUPPORTED_SENTENCE).toEqual({
      websocket: copy.websocket,
      tooLarge: copy.tooLarge,
      noLength: copy.noLength,
    });
  });
});

describe('relay — a fetched (SigV4) answer handed back to the viewer', () => {
  it('keeps every Set-Cookie, drops the framing fetch undid, and brings a redirect home', async () => {
    const headers = new Headers({
      location: 'https://abc.lambda-url.eu-west-1.on.aws/next',
      'content-encoding': 'gzip',
      'content-length': '10',
      'x-app': '1',
    });
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; Path=/');
    const res = relay(
      new Response(null, { status: 302, headers }),
      PREVIEW_HOST,
      'https://abc.lambda-url.eu-west-1.on.aws',
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://${PREVIEW_HOST}/next`);
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('x-app')).toBe('1');
  });
});

describe('app.motir.co is untouched', () => {
  it('a cookie-less app route still bounces to sign-in, and the preview branch never runs', async () => {
    const res = await send('https://app.motir.co/backlog');
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/sign-in');
  });

  it('with no preview domain configured, a preview-shaped host is ordinary', async () => {
    vi.stubEnv('MOTIR_PREVIEW_DOMAIN', '');
    const res = await send(`https://${PREVIEW_HOST}/backlog`);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/sign-in');
  });

  it('answers 503 on a preview host when the gate has no signing key', async () => {
    vi.stubEnv('MOTIR_HOSTING_GATE_SIGNING_KEY', '');
    const res = await send(`https://${PREVIEW_HOST}/`);
    expect(res.status).toBe(503);
  });
});
