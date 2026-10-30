import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_SCHEME_ENV, previewScheme, previewUrl } from '@/lib/preview/url';

// THE ONE COMPOSER OF A PREVIEW ADDRESS (Story MOTIR-5766 · MOTIR-10099).

const HOST = 'pr-41--acme-svc.preview.motir.site';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('previewScheme', () => {
  it('is https when the lane sets nothing', () => {
    vi.stubEnv(PREVIEW_SCHEME_ENV, undefined);
    expect(previewScheme()).toBe('https');
  });

  it('treats an empty or whitespace-only value as unset', () => {
    vi.stubEnv(PREVIEW_SCHEME_ENV, '');
    expect(previewScheme()).toBe('https');
    vi.stubEnv(PREVIEW_SCHEME_ENV, '   ');
    expect(previewScheme()).toBe('https');
  });

  it('takes the lane’s scheme, without its colon and lower-cased', () => {
    vi.stubEnv(PREVIEW_SCHEME_ENV, 'http');
    expect(previewScheme()).toBe('http');
    vi.stubEnv(PREVIEW_SCHEME_ENV, ' HTTP: ');
    expect(previewScheme()).toBe('http');
  });
});

describe('previewUrl', () => {
  it('composes the origin from the stored host', () => {
    vi.stubEnv(PREVIEW_SCHEME_ENV, undefined);
    expect(previewUrl(HOST)).toBe(`https://${HOST}`);
  });

  it('keeps a port and reduces a host written with a path to its origin', () => {
    vi.stubEnv(PREVIEW_SCHEME_ENV, 'http');
    expect(previewUrl(`${HOST}:3101`)).toBe(`http://${HOST}:3101`);
    expect(previewUrl(`${HOST}/invoices?x=1`)).toBe(`http://${HOST}`);
  });

  it('reads the scheme at call time', () => {
    vi.stubEnv(PREVIEW_SCHEME_ENV, 'http');
    expect(previewUrl(HOST)).toBe(`http://${HOST}`);
    vi.stubEnv(PREVIEW_SCHEME_ENV, undefined);
    expect(previewUrl(HOST)).toBe(`https://${HOST}`);
  });
});
