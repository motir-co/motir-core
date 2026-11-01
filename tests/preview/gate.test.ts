// MOTIR-5779 — the preview member gate's PURE half (`lib/preview/gate.ts`): the
// host rule, the signed admission and gate cookie, the return path, and what the
// gate forwards or refuses. The database half and the proxy are
// `previewGateService.test.ts` and `gateProxy.test.ts`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMISSION_TTL_MS,
  GATE_COOKIE_MAX_AGE_SECONDS,
  forwardBodyLimitBytes,
  gateCookieOptions,
  gateSigningKey,
  isMotirCookie,
  isNavigation,
  isUnsupportedKind,
  mintAdmission,
  mintGatePass,
  previewHostOf,
  safeReturnPath,
  stripMotirCookies,
  unsupportedRequest,
  verifyAdmission,
  verifyGatePass,
} from '@/lib/preview/gate';
import { PreviewHostingNotConfiguredError } from '@/lib/preview/errors';

const KEY = 'test-gate-signing-key';
const HOST = 'pr-14--portal.preview.motir.site';
const NOW = new Date('2026-10-29T12:00:00.000Z');

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {
    MOTIR_PREVIEW_DOMAIN: process.env.MOTIR_PREVIEW_DOMAIN,
    MOTIR_HOSTING_GATE_SIGNING_KEY: process.env.MOTIR_HOSTING_GATE_SIGNING_KEY,
  };
  process.env.MOTIR_PREVIEW_DOMAIN = 'preview.motir.site';
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('previewHostOf — which hosts are a preview’s', () => {
  it('answers a preview host, lowercased and without its port', () => {
    expect(previewHostOf(HOST)).toBe(HOST);
    expect(previewHostOf('PR-14--Portal.Preview.Motir.Site:443')).toBe(HOST);
    expect(previewHostOf('pr-7--app-abc123.preview.motir.site')).toBe(
      'pr-7--app-abc123.preview.motir.site',
    );
  });

  it('answers null for every Motir host and every look-alike', () => {
    for (const host of [
      'app.motir.co',
      'motir.co',
      'preview.motir.site',
      'pr-14--portal.preview.motir.site.evil.example',
      'a.pr-14--portal.preview.motir.site',
      'pr-0--portal.preview.motir.site',
      'pr-14-portal.preview.motir.site',
      'pr-14--.preview.motir.site',
      'pr-14--portal.notpreview.motir.site',
      '',
    ]) {
      expect(previewHostOf(host), host).toBeNull();
    }
    expect(previewHostOf(null)).toBeNull();
  });

  it('answers null for EVERY host when no preview domain is configured', () => {
    delete process.env.MOTIR_PREVIEW_DOMAIN;
    expect(previewHostOf(HOST)).toBeNull();
  });

  it('matches what the proxy matcher’s host pattern lets in', async () => {
    // `config.matcher` holds the pattern as a literal (Next reads it statically).
    // Every host the rule admits must reach the proxy, and the pattern must not
    // reach any app.motir.co host.
    const { config } = await import('@/proxy');
    const entry = config.matcher.find((m) => typeof m !== 'string') as {
      source: string;
      has: { type: string; value: string }[];
    };
    expect(entry.source).toBe('/:path*');
    expect(entry.has).toHaveLength(1);
    expect(entry.has[0]!.type).toBe('host');
    const pattern = new RegExp(`^${entry.has[0]!.value}$`);
    for (const host of [HOST, 'pr-7--app-abc123.preview.motir.site', 'pr-1--a.example.dev']) {
      expect(pattern.test(host), host).toBe(true);
    }
    for (const host of ['app.motir.co', 'motir.co', 'localhost', 'preview.motir.site']) {
      expect(pattern.test(host), host).toBe(false);
    }
    expect(config.matcher.filter((m) => typeof m !== 'string')).toHaveLength(1);
  });
});

describe('the signing key', () => {
  it('is read at call time and refused, named, when unset', () => {
    delete process.env.MOTIR_HOSTING_GATE_SIGNING_KEY;
    expect(() => gateSigningKey()).toThrow(PreviewHostingNotConfiguredError);
    expect(() => gateSigningKey()).toThrow(/MOTIR_HOSTING_GATE_SIGNING_KEY/);
    process.env.MOTIR_HOSTING_GATE_SIGNING_KEY = ` ${KEY} `;
    expect(gateSigningKey()).toBe(KEY);
  });
});

describe('the admission — signed, host-bound, short-lived', () => {
  it('verifies for its own host within 60 seconds', () => {
    const { token, admission } = mintAdmission({ host: HOST, sub: 'user-1' }, KEY, NOW);
    expect(admission.exp - NOW.getTime()).toBe(ADMISSION_TTL_MS);
    const at = new Date(NOW.getTime() + ADMISSION_TTL_MS - 1);
    expect(verifyAdmission(token, HOST, KEY, at)).toEqual({ ok: true, admission });
  });

  it('refuses it for another host, after expiry, tampered, or signed by another key', () => {
    const { token } = mintAdmission({ host: HOST, sub: 'user-1' }, KEY, NOW);
    expect(verifyAdmission(token, 'pr-15--portal.preview.motir.site', KEY, NOW)).toEqual({
      ok: false,
      refusal: 'other_host',
    });
    expect(verifyAdmission(token, HOST, KEY, new Date(NOW.getTime() + ADMISSION_TTL_MS))).toEqual({
      ok: false,
      refusal: 'expired',
    });
    const [body, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), host: 'x' }),
    ).toString('base64url');
    expect(verifyAdmission(`${forged}.${mac}`, HOST, KEY, NOW)).toEqual({
      ok: false,
      refusal: 'tampered',
    });
    expect(verifyAdmission(token, HOST, 'another-key', NOW)).toEqual({
      ok: false,
      refusal: 'tampered',
    });
    for (const junk of ['', 'nodot', 'a.b.c', null]) {
      expect(verifyAdmission(junk, HOST, KEY, NOW).ok).toBe(false);
    }
  });

  it('a payload that is not an admission is malformed', () => {
    const { token } = mintAdmission({ host: HOST, sub: 'u' }, KEY, NOW);
    // A gate cookie is signed for another PURPOSE, so it is never an admission.
    const pass = mintGatePass(
      { host: HOST, sub: 'u', jti: 'j', exp: NOW.getTime() + 1000 },
      KEY,
      NOW,
    );
    expect(verifyAdmission(pass, HOST, KEY, NOW)).toEqual({ ok: false, refusal: 'tampered' });
    expect(verifyAdmission(token.replace(/\..*$/, '.'), HOST, KEY, NOW).ok).toBe(false);
  });
});

describe('the gate cookie', () => {
  it('admits its host for 8 hours, and nothing else', () => {
    const { admission } = mintAdmission({ host: HOST, sub: 'user-1' }, KEY, NOW);
    const pass = mintGatePass(admission, KEY, NOW);
    expect(verifyGatePass(pass, HOST, KEY, NOW)).toMatchObject({ host: HOST, sub: 'user-1' });
    const late = new Date(NOW.getTime() + GATE_COOKIE_MAX_AGE_SECONDS * 1000);
    expect(verifyGatePass(pass, HOST, KEY, late)).toBeNull();
    expect(verifyGatePass(pass, 'pr-15--portal.preview.motir.site', KEY, NOW)).toBeNull();
    expect(verifyGatePass(pass, HOST, 'another-key', NOW)).toBeNull();
    // An admission is not a cookie.
    const { token } = mintAdmission({ host: HOST, sub: 'u' }, KEY, NOW);
    expect(verifyGatePass(token, HOST, KEY, NOW)).toBeNull();
    expect(verifyGatePass(undefined, HOST, KEY, NOW)).toBeNull();
  });

  it('carries the §9 attributes and no Domain', () => {
    expect(gateCookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 8 * 60 * 60,
    });
    expect(gateCookieOptions()).not.toHaveProperty('domain');
  });
});

describe('safeReturnPath — only ever a path on the preview host', () => {
  it('keeps a same-host path with its query and hash', () => {
    expect(safeReturnPath('/')).toBe('/');
    expect(safeReturnPath('/invoices?status=open#top')).toBe('/invoices?status=open#top');
    expect(safeReturnPath('/a/../b')).toBe('/b');
  });

  it('lands every off-host spelling on the root', () => {
    for (const raw of [
      'https://evil.example/x',
      '//evil.example',
      '/%2F%2Fevil.example',
      '/%252F%252Fevil.example',
      '/\\evil.example',
      '/%5Cevil.example',
      'javascript:alert(1)',
      'evil.example',
      '/\u0000x',
      '/%0d%0aSet-Cookie:x',
      '%',
      '/%E0%A4%A',
      '',
      null,
      undefined,
      `/${'a'.repeat(3000)}`,
    ]) {
      expect(safeReturnPath(raw), String(raw)).toBe('/');
    }
  });
});

describe('what the gate forwards', () => {
  it('names Motir’s cookies — its session and the gate cookie', () => {
    for (const name of [
      'better-auth.session_token',
      '__Secure-better-auth.session_token',
      'better-auth.session_data',
      '__Host-motir-gate',
    ]) {
      expect(isMotirCookie(name), name).toBe(true);
    }
    for (const name of ['session', 'next-auth.session-token', 'motir_visitor']) {
      expect(isMotirCookie(name), name).toBe(false);
    }
  });

  it('strips them and keeps the preview’s own', () => {
    expect(
      stripMotirCookies(
        'theme=dark; better-auth.session_token=abc; __Host-motir-gate=x; app_session=1; flag',
      ),
    ).toBe('theme=dark; app_session=1; flag');
    expect(stripMotirCookies('__Secure-better-auth.session_token=abc')).toBeNull();
    expect(stripMotirCookies(null)).toBeNull();
  });

  it('refuses rather than truncates (§5): 501, 413 and 411', () => {
    const h = (init: Record<string, string>) => new Headers(init);
    expect(unsupportedRequest('GET', h({ upgrade: 'websocket' }), 'fly')).toBe('websocket');
    expect(unsupportedRequest('GET', h({}), 'fly')).toBeNull();
    expect(unsupportedRequest('DELETE', h({}), 'fly')).toBeNull();
    expect(unsupportedRequest('POST', h({}), 'fly')).toBe('noLength');
    expect(unsupportedRequest('GET', h({ 'transfer-encoding': 'chunked' }), 'fly')).toBe(
      'noLength',
    );
    expect(unsupportedRequest('POST', h({ 'content-length': 'x' }), 'fly')).toBe('noLength');
    const tenMb = String(10 * 1024 * 1024);
    expect(unsupportedRequest('POST', h({ 'content-length': tenMb }), 'fly')).toBeNull();
    expect(unsupportedRequest('POST', h({ 'content-length': `${tenMb}1` }), 'fly')).toBe(
      'tooLarge',
    );
    expect(unsupportedRequest('POST', h({ 'content-length': tenMb }), 'aws')).toBeNull();
    expect(unsupportedRequest('POST', h({ 'content-length': tenMb }), 'serverless')).toBe(
      'tooLarge',
    );
    expect(forwardBodyLimitBytes('serverless')).toBe(6 * 1024 * 1024);
  });

  it('tells a browser navigation from a script', () => {
    expect(isNavigation(new Headers({ 'sec-fetch-dest': 'document' }))).toBe(true);
    expect(isNavigation(new Headers({ 'sec-fetch-dest': 'empty', accept: 'text/html' }))).toBe(
      false,
    );
    expect(isNavigation(new Headers({ accept: 'text/html,application/xhtml+xml' }))).toBe(true);
    expect(isNavigation(new Headers({ accept: '*/*' }))).toBe(false);
  });

  it('knows the three refusal kinds and nothing else', () => {
    expect(['websocket', 'tooLarge', 'noLength'].every(isUnsupportedKind)).toBe(true);
    expect(isUnsupportedKind('toString')).toBe(false);
    expect(isUnsupportedKind(undefined)).toBe(false);
  });
});
