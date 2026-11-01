import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * MOTIR-3884 — the moved public surfaces leave the application host. Once the
 * public origin is configured (`MOTIR_PUBLIC_SITE_URL` → motir.co), the proxy
 * 308s `/explore/*`, `/docs/*`, `/legal/*` AND `/p/*` onto it, path and query
 * preserved, and nothing fires while the public origin is unconfigured (a
 * redirect would loop onto this origin).
 *
 * MOTIR-7819 — the root `/` is NOT one of them. It is the application's entry:
 * the proxy forwards it untouched, signed in or not, so `app/page.tsx` answers
 * it by session (`tests/onboarding/entry-rework.test.tsx` holds that half).
 */

const sessionCookie = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('better-auth/cookies', () => ({
  getSessionCookie: () => sessionCookie.value,
}));

const PUBLIC = 'https://motir.co';
const APP = 'https://app.motir.co';

afterEach(() => {
  sessionCookie.value = null;
  delete process.env['MOTIR_PUBLIC_SITE_URL'];
  delete process.env['MOTIR_BASE_URL'];
});

const redirect = async (path: string) => {
  const { proxy } = await import('@/proxy');
  return proxy(new NextRequest(`${APP}${path}`));
};

describe('the application root / is the app entry, never a move to motir.co (MOTIR-7819)', () => {
  // Both session states, because the bug was invisible to whichever one a test
  // happened to encode: the 308 answered a signed-in reader and a signed-out
  // one identically. The proxy must forward `/` in BOTH, so the page decides.
  for (const [state, cookie] of [
    ['signed out', null],
    ['signed in', 'a-session-token'],
  ] as const) {
    it(`forwards / untouched for a ${state} request once the public origin is configured`, async () => {
      process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
      process.env['MOTIR_BASE_URL'] = APP;
      sessionCookie.value = cookie;
      const res = await redirect('/');
      expect(res.status).not.toBe(308);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('x-middleware-next')).toBe('1');
    });

    it(`forwards / untouched for a ${state} request on a self-hosted build`, async () => {
      sessionCookie.value = cookie;
      const res = await redirect('/');
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('x-middleware-next')).toBe('1');
    });
  }

  it('keeps the query on a forwarded root — nothing rewrites it', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    const res = await redirect('/?ref=motir.co');
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('the moved public surfaces 308 to motir.co', () => {
  it('308s /explore with path and query preserved', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    const res = await redirect('/explore?rank=popular');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://motir.co/explore?rank=popular');
  });

  it('308s a topic landing page', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    const res = await redirect('/explore/topic/design');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://motir.co/explore/topic/design');
  });

  it('308s /docs and everything beneath it', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    const res = await redirect('/docs/api/getting-started');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://motir.co/docs/api/getting-started');
  });

  it('308s /legal and a document beneath it', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    const res = await redirect('/legal/privacy');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://motir.co/legal/privacy');
  });

  it('308s /p/* — its move to motir.co was folded into this redirect set', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    const res = await redirect('/p/PROD');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://motir.co/p/PROD');
  });

  // MOTIR-6669 — the Visitor's consent screen asks a SIGNED-IN reader, so it is
  // answered here where the session lives; every other /p/* path keeps its 308.
  it('does NOT 308 the Visitor consent screen /p/<id>/consent — it is answered in the app', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    const res = await redirect('/p/PROD/consent?next=%2Fp%2FPROD%2Fboard');
    expect(res.status).not.toBe(308);
    expect(res.headers.get('location')).toBeNull();
    // …and neither is it bounced to sign-in by the proxy: the page decides.
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('does NOT 308 the Visitor views /p/<id>/<view> — they are served in the app (MOTIR-6648)', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    for (const path of [
      '/p/PROD/board',
      '/p/PROD/items',
      '/p/PROD/items/PROD-7',
      '/p/PROD/tree',
      '/p/PROD/roadmap',
      '/p/PROD/plans',
      '/p/PROD/plans/cplan1',
      '/p/PROD/approvals',
      '/p/PROD/runs',
      '/p/PROD/enter?next=%2Fp%2FPROD%2Fboard',
    ]) {
      const res = await redirect(path);
      expect(res.status, path).not.toBe(308);
      expect(res.headers.get('location'), path).toBeNull();
      expect(res.headers.get('x-middleware-next'), path).toBe('1');
    }
  });

  it('still 308s the bare /p/<id> and any other /p/* path', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    for (const path of [
      '/p/PROD',
      '/p/PROD/changelog',
      '/p/PROD/consent/extra',
      '/p/PROD/board/extra',
    ]) {
      const res = await redirect(path);
      expect(res.status, path).toBe(308);
    }
  });

  it('does not redirect while the public origin is unconfigured (no self-loop)', async () => {
    delete process.env['MOTIR_PUBLIC_SITE_URL'];
    delete process.env['MOTIR_BASE_URL'];
    const res = await redirect('/explore');
    expect(res.status).not.toBe(308);
  });
});

describe('the matcher covers the root and the moved surfaces, including /p', () => {
  it('lists /, /explore, /docs, /legal and /p — and only the last four move', async () => {
    const { config, PUBLIC_REDIRECT_SEGMENTS } = await import('@/proxy');
    const segments = config.matcher
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.replace(/^\//, '').split('/')[0]);
    expect(segments).toContain('');
    expect(segments).toContain('explore');
    expect(segments).toContain('docs');
    expect(segments).toContain('legal');
    expect(segments).toContain('p');
    expect([...PUBLIC_REDIRECT_SEGMENTS]).toEqual(['explore', 'docs', 'legal', 'p']);
  });
});
