import { describe, expect, it } from 'vitest';
import type { EdgeOutcome } from '../../packages/hosting-edge/src/contract';
import { addressOf, pageFor, pageHeaders } from '../../packages/hosting-edge/src/pages';

// THE EDGE PAGES (MOTIR-10127), rendered to `design/edge-pages/design-notes.md`
// (MOTIR-10124): total over the outcomes that answer a page, each with its own
// status and the shared response headers, the names escaped, and none of Motir's
// chrome.

type PageOutcome = Exclude<EdgeOutcome, { kind: 'forward' }>;

/** Every page-answering outcome, one per variant. */
const OUTCOMES: Record<string, PageOutcome> = {
  noApplication: { kind: 'no-application', name: 'Acme' },
  membersWithAddress: { kind: 'members-only', name: 'Acme', opensAt: 'shop--acme.motir.site' },
  membersWithoutAddress: { kind: 'members-only', name: 'Acme', opensAt: null },
  unavailable: { kind: 'unavailable', name: 'Acme' },
  notFound: { kind: 'not-found' },
};

const count = (body: string, re: RegExp) => (body.match(re) ?? []).length;

describe('outcome → page', () => {
  it.each([
    ['noApplication', 200, 'Nothing is published here yet'],
    ['membersWithAddress', 200, 'This site is for members only'],
    ['membersWithoutAddress', 200, 'This site is for members only'],
    ['unavailable', 503, 'This site can’t be reached right now'],
    ['notFound', 404, 'There’s no site here'],
  ])('%s answers %i with its heading', (key, status, heading) => {
    const page = pageFor(OUTCOMES[key]!);
    expect(page.status).toBe(status);
    expect(page.body).toContain(`<h1>${heading}</h1>`);
  });

  it('the members-only page has two sentences, chosen by opensAt', () => {
    const withAddress = pageFor(OUTCOMES.membersWithAddress!).body;
    expect(withAddress).toContain(
      'Acme opens this site to its members at <a href="https://shop--acme.motir.site/">shop--acme.motir.site</a>.',
    );
    const without = pageFor(OUTCOMES.membersWithoutAddress!).body;
    expect(without).toContain('Acme has made this site available to its members only.');
    expect(without).not.toContain('<a ');
  });

  it('the Not-found page names no workspace and is one document for every reason', () => {
    const page = pageFor({ kind: 'not-found' });
    expect(page.body).not.toContain('class="eyebrow"');
    expect(pageFor({ kind: 'not-found' }).body).toBe(page.body);
  });
});

describe('the document frame and responses', () => {
  it.each(Object.keys(OUTCOMES))('%s: one main, one h1, noindex, and no chrome', (key) => {
    const { body } = pageFor(OUTCOMES[key]!);
    expect(body.startsWith('<!doctype html>')).toBe(true);
    expect(body).toContain('<html lang="en">');
    expect(body).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(count(body, /<main>/g)).toBe(1);
    expect(count(body, /<h1>/g)).toBe(1);
    expect(count(body, /<style>/g)).toBe(1);
    for (const absent of [
      /<script/i,
      /<img/i,
      /<link/i,
      /<header/i,
      /<nav/i,
      /<footer/i,
      /motir\.co/i,
      /@font-face/i,
    ]) {
      expect(body).not.toMatch(absent);
    }
  });

  it('every page is served no-store, noindex, as html', () => {
    const { body } = pageFor({ kind: 'not-found' });
    expect(pageHeaders(body)).toEqual({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'content-length': String(Buffer.byteLength(body)),
    });
  });
});

describe('interpolation', () => {
  it('escapes the workspace name everywhere it appears', () => {
    const name = 'Ben & Jerry\'s <script>alert(1)</script> "Shop"';
    for (const kind of ['no-application', 'unavailable'] as const) {
      const { body } = pageFor({ kind, name });
      expect(body).not.toContain('<script>');
      expect(body).toContain(
        'Ben &amp; Jerry&#39;s &lt;script&gt;alert(1)&lt;/script&gt; &quot;Shop&quot;',
      );
    }
    const members = pageFor({ kind: 'members-only', name, opensAt: null }).body;
    expect(members).not.toContain('<script>');
  });

  it.each([
    ['javascript:alert(1)'],
    ['http://shop.acme.com'],
    ['https://shop.acme.com/path'],
    ['https://u:p@shop.acme.com'],
    ['shop.acme.com"><script>'],
    ['not a host'],
    [''],
  ])('an opensAt of %j renders the without-address sentence', (opensAt) => {
    expect(addressOf(opensAt)).toBeNull();
    const { body } = pageFor({ kind: 'members-only', name: 'Acme', opensAt });
    expect(body).toContain('has made this site available to its members only.');
    expect(body).not.toContain('<a ');
  });

  it('accepts the production address bare or as an https origin', () => {
    expect(addressOf('Shop--Acme.motir.site')).toBe('shop--acme.motir.site');
    expect(addressOf('https://shop--acme.motir.site/')).toBe('shop--acme.motir.site');
  });
});
