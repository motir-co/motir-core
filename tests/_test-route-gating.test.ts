import { afterEach, describe, expect, it, vi } from 'vitest';
// NOTE: the on-disk folder is `%5Ftest` (URL-encoded `_`), NOT `_test`. Next.js
// App Router treats a literal `_`-prefixed folder as PRIVATE (excluded from
// routing → every `_test/*` URL 404s); `%5Ftest` is the documented escape that
// renders the literal `/api/_test/...` URL while staying routable. See the
// route files' header + PRODECT_FINDINGS for the gory details.
import * as workItemsRoute from '@/app/api/%5Ftest/work-items/route';
import * as workItemLinksRoute from '@/app/api/%5Ftest/work-item-links/route';
import * as legalManifestRoute from '@/app/api/%5Ftest/legal-manifest/route';
import * as docsUrlRoute from '@/app/api/%5Ftest/docs-url/route';
import * as monitorPollRoute from '@/app/api/%5Ftest/monitors/poll/route';
import * as publicAddressFakesRoute from '@/app/api/%5Ftest/public-addresses/fakes/route';
import { productionGate } from '@/app/api/%5Ftest/_helpers';
import { LEGAL_DOCUMENTS_ENV } from '@/lib/legal/documents';
import { DOCS_URL_ENV } from '@/lib/docs/links';

// Production-build gating for the throwaway `_test/*` route handlers (Subtask
// 1.4.8). Every handler returns 404 (NOT 403/501) when NODE_ENV === 'production'
// — the durable mechanism that keeps these endpoints out of production builds.
// The 404 preserves the no-existence-leak contract (a prod probe of `_test/*`
// is indistinguishable from any other unknown path).
//
// The gate is the FIRST thing each handler runs, BEFORE auth/session — so this
// test needs no session, cookies, or DB: flipping NODE_ENV to 'production' and
// invoking the handler is sufficient. The gate reads process.env['NODE_ENV']
// dynamically (not a build-inlined constant), so the runtime flip below takes
// effect against the imported handlers.
//
// (The Playwright spec deliberately SKIPS the production-gating scenario and
// cites this file — gating is a unit-test concern; the E2E server runs in
// development, where the gate is open.)

// `process.env.NODE_ENV` is typed read-only, so flip it through vi.stubEnv
// (which mutates process.env so the handlers' dynamic read sees 'production')
// and restore via unstubAllEnvs.
afterEach(() => {
  vi.unstubAllEnvs();
});

type Handler = (req: Request) => Promise<Response>;

async function assertGated(handler: Handler, url: string): Promise<void> {
  const res = await handler(new Request(url, { method: 'GET' }));
  expect(res.status).toBe(404);
  const body = (await res.json()) as { code?: string };
  expect(body.code).toBe('NOT_FOUND');
}

describe('_test/work-items route — production gating', () => {
  it('returns 404 for GET/POST/PATCH/DELETE when NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const url = 'http://localhost/api/_test/work-items?id=anything';
    await assertGated(workItemsRoute.GET, url);
    await assertGated(workItemsRoute.POST, url);
    await assertGated(workItemsRoute.PATCH, url);
    await assertGated(workItemsRoute.DELETE, url);
  });
});

describe('_test/work-item-links route — production gating', () => {
  it('returns 404 for GET/POST/DELETE when NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const url = 'http://localhost/api/_test/work-item-links?workItemId=anything';
    await assertGated(workItemLinksRoute.GET, url);
    await assertGated(workItemLinksRoute.POST, url);
    await assertGated(workItemLinksRoute.DELETE, url);
  });
});

describe('_test/monitors/poll route — production gating (MOTIR-4929 · MOTIR-5584)', () => {
  it('returns 404 for POST when NODE_ENV=production, before reading a session or a body', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    const res = await monitorPollRoute.POST(
      new Request('http://localhost/api/_test/monitors/poll', {
        method: 'POST',
        body: JSON.stringify({ connectionId: 'anything' }),
      }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe('NOT_FOUND');
  });
});

describe('productionGate — E2E production harness (MOTIR-1679)', () => {
  it('gates (404) in production when the harness flag is NOT set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    expect(productionGate()?.status).toBe(404);
  });

  it('does NOT gate (null) in production UNDER the E2E harness — the suite seeds through these routes', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '1');
    expect(productionGate()).toBeNull();
  });

  it('does NOT gate (null) in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(productionGate()).toBeNull();
  });
});

describe('_test/legal-manifest route — production gating and the door itself (MOTIR-4015)', () => {
  const URL = 'http://localhost/api/_test/legal-manifest';

  /** One valid entry — the shape `validateEntry` accepts, nothing more. */
  const ENTRY = {
    slug: 'terms',
    title: 'Terms of Service',
    version: '2.0.0',
    effectiveDate: '2026-09-01',
    changeSummary: null,
    url: 'https://public.motir.e2e/legal/terms',
  };

  function put(body: unknown): Promise<Response> {
    return legalManifestRoute.PUT(new Request(URL, { method: 'PUT', body: JSON.stringify(body) }));
  }

  it('returns 404 for PUT when NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    // ⚠️ CAPTURED RATHER THAN ASSUMED UNSET, so this holds wherever the case
    // sits in the file — the claim is that the handler changed NOTHING, not
    // that the variable happened to be empty when this ran.
    const before = process.env[LEGAL_DOCUMENTS_ENV];
    const res = await put({ manifest: [ENTRY] });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe('NOT_FOUND');
    // The gate is the first statement in the handler, so a 404 must also mean
    // the environment is untouched — a door that 404s AFTER mutating would be
    // gated in name only.
    expect(process.env[LEGAL_DOCUMENTS_ENV]).toBe(before);
  });

  it('SETS the manifest and reports what the shipped loader made of it', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(LEGAL_DOCUMENTS_ENV, '');
    const res = await put({ manifest: [ENTRY] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'configured',
      slugs: ['terms'],
      faults: [],
    });
  });

  it('UNSETS it for `null` — the self-hoster arm the acceptance spec starts on', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(LEGAL_DOCUMENTS_ENV, JSON.stringify([ENTRY]));
    const res = await put({ manifest: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'unconfigured', slugs: [], faults: [] });
  });

  it('reports a REFUSED entry as faulted rather than as a 200 that hid it', async () => {
    // The mount check the acceptance spec asserts on is only worth asserting if
    // a bad manifest reads back differently from a good one.
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(LEGAL_DOCUMENTS_ENV, '');
    const res = await put({ manifest: [{ ...ENTRY, version: 'v2' }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; slugs: string[] };
    expect(body.status).toBe('faulted');
    expect(body.slugs).toEqual([]);
  });

  it('refuses a body that is neither an array nor null', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const res = await put({ manifest: 'terms' });
    expect(res.status).toBe(400);
  });

  it('refuses a body that is not JSON at all', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const res = await legalManifestRoute.PUT(new Request(URL, { method: 'PUT', body: 'not json' }));
    expect(res.status).toBe(400);
  });
});

describe('_test/docs-url route — production gating and the door itself (MOTIR-4241)', () => {
  const URL = 'http://localhost/api/_test/docs-url';
  const CONFIGURED = 'https://motir.co/docs';

  function put(body: unknown): Promise<Response> {
    return docsUrlRoute.PUT(new Request(URL, { method: 'PUT', body: JSON.stringify(body) }));
  }

  it('returns 404 for GET and PUT when NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    // ⚠️ CAPTURED RATHER THAN ASSUMED UNSET, the same way its sibling above
    // does it: the claim is that the handler changed NOTHING, not that the
    // variable happened to be empty when this ran.
    const before = process.env[DOCS_URL_ENV];

    const read = await docsUrlRoute.GET();
    expect(read.status).toBe(404);
    expect(((await read.json()) as { code?: string }).code).toBe('NOT_FOUND');

    const res = await put({ url: CONFIGURED });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe('NOT_FOUND');
    // The gate is the first statement in the handler, so a 404 must also mean
    // the environment is untouched — a door that 404s AFTER mutating would be
    // gated in name only.
    expect(process.env[DOCS_URL_ENV]).toBe(before);
  });

  it('SETS the url and reports what the shipped resolver made of it', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(DOCS_URL_ENV, '');
    const res = await put({ url: CONFIGURED });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: CONFIGURED });
  });

  it('UNSETS it for `null` — the self-hoster arm the acceptance spec ends on', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(DOCS_URL_ENV, CONFIGURED);
    const res = await put({ url: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: null });
  });

  it('GETs the current arm WITHOUT changing it — the mount read', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(DOCS_URL_ENV, CONFIGURED);
    const res = await docsUrlRoute.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: CONFIGURED });
    expect(process.env[DOCS_URL_ENV]).toBe(CONFIGURED);
  });

  it('reports a REFUSED value as null rather than as a 200 that hid it', async () => {
    // The mount check the acceptance spec asserts on is only worth asserting if
    // a value the resolver rejects reads back differently from one it accepts —
    // and `/docs` is precisely the relative path MOTIR-4167 cured the row of.
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(DOCS_URL_ENV, '');
    const res = await put({ url: '/docs' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: null });
    // …and the variable really was written: the `null` is the RESOLVER's
    // verdict, not the door quietly declining to act.
    expect(process.env[DOCS_URL_ENV]).toBe('/docs');
  });

  it('refuses a body whose `url` is neither a string nor null', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const res = await put({ url: 42 });
    expect(res.status).toBe(400);
  });

  it('refuses a body that is not JSON at all', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const res = await docsUrlRoute.PUT(new Request(URL, { method: 'PUT', body: 'not json' }));
    expect(res.status).toBe(400);
  });
});

describe('_test/public-addresses/fakes route — production gating (MOTIR-9533)', () => {
  it('returns 404 for POST when NODE_ENV=production, before reading a session or a body', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    const res = await publicAddressFakesRoute.POST(
      new Request('http://localhost/api/_test/public-addresses/fakes', {
        method: 'POST',
        body: JSON.stringify({ sweep: true }),
      }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe('NOT_FOUND');
  });
});
