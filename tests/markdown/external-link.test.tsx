// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { renderMarkdown } from '@/lib/markdown/render';
import {
  NEW_TAB_LINK_PROPS,
  currentAppOrigin,
  externalLinkProps,
  isExternalHref,
} from '@/lib/markdown/externalLink';

// MOTIR-12300: a link that leaves Motir — a code link above all — opens in a new
// tab; everything that is Motir itself keeps navigating in the current tab.

const APP = 'https://app.motir.co';

describe('isExternalHref', () => {
  it.each([
    'https://github.com/motir-co/motir-core/pull/4400',
    'http://github.com/motir-co/motir-core/blob/main/lib/markdown/render.tsx#L163',
    'HTTPS://GITHUB.COM/motir-co/motir-core/commit/abc123',
    '//github.com/motir-co/motir-core',
    '  https://gitlab.com/acme/web/-/merge_requests/7  ',
    'https://app.motir.co.evil.example/items/MOTIR-1',
    'http://app.motir.co/items/MOTIR-1',
    'https://app.motir.co:8443/items/MOTIR-1',
  ])('%s is external', (href) => {
    expect(isExternalHref(href, APP)).toBe(true);
  });

  it.each([
    'https://app.motir.co/items/MOTIR-1',
    'https://APP.MOTIR.CO/pages/abc',
    '//app.motir.co/items/MOTIR-1',
    '/items/MOTIR-1',
    'items/MOTIR-1',
    '#section',
    '?view=board',
    'mention:cuser1',
    'motir:cwork1',
    'motir-page:cpage1',
    'motir-ref:planItem:abc',
    'mailto:someone@example.com',
    'tel:+31201234567',
    '',
    'https://',
  ])('%s is not external', (href) => {
    expect(isExternalHref(href, APP)).toBe(false);
  });

  it('is false for a missing or non-string href', () => {
    expect(isExternalHref(undefined, APP)).toBe(false);
    expect(isExternalHref(null, APP)).toBe(false);
    expect(isExternalHref(42, APP)).toBe(false);
  });

  it('is false when the app origin itself cannot be parsed', () => {
    expect(isExternalHref('https://github.com/acme', 'not a url')).toBe(false);
  });

  it('defaults to the current page origin', () => {
    expect(isExternalHref(`${window.location.origin}/items/MOTIR-1`)).toBe(false);
    expect(isExternalHref('https://github.com/acme')).toBe(true);
  });
});

describe('externalLinkProps', () => {
  it('is target _blank with rel noopener noreferrer for an external link', () => {
    expect(externalLinkProps('https://github.com/acme', APP)).toEqual({
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    expect(NEW_TAB_LINK_PROPS).toEqual({ target: '_blank', rel: 'noopener noreferrer' });
  });

  it('is empty for an internal link', () => {
    expect(externalLinkProps('/items/MOTIR-1', APP)).toEqual({});
    expect(externalLinkProps(`${APP}/items/MOTIR-1`, APP)).toEqual({});
  });
});

describe('currentAppOrigin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is the page origin in the browser', () => {
    expect(currentAppOrigin()).toBe(window.location.origin);
  });

  it('is the configured application origin on the server', () => {
    vi.stubGlobal('window', undefined);
    vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co/');
    expect(currentAppOrigin()).toBe('https://app.motir.co');
  });
});

describe('renderMarkdown links', () => {
  const origin = window.location.origin;
  const md = [
    '[the PR](https://github.com/motir-co/motir-core/pull/4400)',
    '[a file](https://github.com/motir-co/motir-core/blob/main/README.md)',
    `[same origin](${origin}/items/MOTIR-1)`,
    '[relative](/items/MOTIR-2)',
    '[mail](mailto:someone@example.com)',
    'autolinked https://github.com/motir-co/motir-ai/commit/abc123',
  ].join('\n\n');

  function anchors() {
    const { container } = render(<>{renderMarkdown(md)}</>);
    return Object.fromEntries(
      [...container.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a]),
    );
  }

  it('opens a code link in a new tab, with noopener noreferrer, underlined as before', () => {
    const a = anchors();
    for (const href of [
      'https://github.com/motir-co/motir-core/pull/4400',
      'https://github.com/motir-co/motir-core/blob/main/README.md',
      'https://github.com/motir-co/motir-ai/commit/abc123',
    ]) {
      expect(a[href]?.getAttribute('target')).toBe('_blank');
      expect(a[href]?.getAttribute('rel')).toBe('noopener noreferrer');
      expect((a[href] as HTMLAnchorElement).style.textDecorationLine).toBe('underline');
    }
  });

  it('keeps a same-origin, relative or mailto link in the current tab', () => {
    const a = anchors();
    for (const href of [
      `${origin}/items/MOTIR-1`,
      '/items/MOTIR-2',
      'mailto:someone@example.com',
    ]) {
      expect(a[href]).toBeDefined();
      expect(a[href]?.hasAttribute('target')).toBe(false);
      expect(a[href]?.hasAttribute('rel')).toBe(false);
    }
  });

  it('renders internal-scheme tokens as before — no anchor, so no new tab', () => {
    // The chips for well-formed `motir:` / `motir-page:` tokens are pinned by their
    // own suites; here a mention chip and a malformed work-item token stand in.
    const { container } = render(
      <>{renderMarkdown('[@Ada](mention:cuser1) [MOTIR-1](motir:not a token)')}</>,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('.mention-chip')?.textContent).toBe('@Ada');
  });
});
