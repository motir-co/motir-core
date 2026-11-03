// The edge's own pages (MOTIR-10127), rendered as drawn in
// `design/edge-pages/edge-pages.mock.html` and specified in
// `design/edge-pages/design-notes.md` (MOTIR-10124): the Document frame, the
// Token block, and four pages — No-application, Members-only (two sentences),
// Unavailable and Not-found.
//
// The strings are the notes' `edge.*` table, literal here: the image has no
// i18n pipeline. Only `workspace.name` and `opensAt` are interpolated, both
// HTML-escaped; the requested `Host` is never echoed. The Not-found page is ONE
// byte-identical document for every reason it answers, so it reveals nothing
// about which reason applied.

import type { EdgeOutcome } from './contract.ts';

export interface EdgePage {
  readonly status: number;
  readonly body: string;
}

/** The headers every page is served with (notes § Responses). */
export function pageHeaders(body: string): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    'content-length': String(Buffer.byteLength(body)),
  };
}

const STRINGS = {
  noApplication: {
    title: 'Nothing published yet',
    heading: 'Nothing is published here yet',
    sentence: (name: string) => `${name} hasn’t published a site at this address yet.`,
  },
  membersOnly: {
    title: 'Members only',
    heading: 'This site is for members only',
    sentenceWithAddress: (name: string, address: string) =>
      `${name} opens this site to its members at ${address}.`,
    sentenceWithoutAddress: (name: string) =>
      `${name} has made this site available to its members only.`,
  },
  unavailable: {
    title: 'Temporarily unavailable',
    heading: 'This site can’t be reached right now',
    sentence: (name: string) =>
      `${name}’s site exists, but it can’t be reached at the moment. Please try again later.`,
  },
  notFound: {
    title: 'Not found',
    heading: 'There’s no site here',
    sentence: 'Check the address you typed and try again.',
  },
} as const;

/** The Token block, complete (notes § Token block). */
const TOKEN_BLOCK = `:root {
  --el-page-bg: #ffffff;
  --el-text: #16191d;
  --el-text-secondary: #565c64;
  --el-link: #155bc4;
  --el-accent: #1a1d21;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --el-page-bg: #0c0d0f;
    --el-text: #edeef0;
    --el-text-secondary: #a9adb5;
    --el-link: #7db1ff;
    --el-accent: #edeef0;
  }
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: var(--el-page-bg);
  color: var(--el-text);
  font-family: 'Segoe UI', Roboto, -apple-system, BlinkMacSystemFont, sans-serif;
}
main {
  max-width: 30rem;
  margin: 0 auto;
  padding: clamp(96px, 22vh, 200px) 24px 48px;
}
@media (max-width: 420px) {
  main {
    padding-inline: 20px;
  }
}
.eyebrow {
  margin: 0 0 12px;
  font-size: 13px;
  letter-spacing: 0.02em;
  color: var(--el-text-secondary);
  overflow-wrap: anywhere;
}
h1 {
  margin: 0 0 12px;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 30px;
  line-height: 1.15;
  font-weight: 700;
  letter-spacing: -0.01em;
}
p.sentence {
  margin: 0;
  font-size: 16px;
  line-height: 1.6;
  color: var(--el-text-secondary);
}
a {
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 15px;
  color: var(--el-link);
  overflow-wrap: anywhere;
}
a:focus-visible {
  outline: 2px solid var(--el-accent);
  outline-offset: 2px;
}`;

/** Text and attribute values, escaped for HTML. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * The host the Address link names, or null. `opensAt` is the application's
 * production address — a bare host — and an `https://host/` form is accepted
 * too; anything else (another scheme, a path, userinfo, a malformed host)
 * renders the without-address sentence rather than a link.
 */
export function addressOf(opensAt: string | null): string | null {
  if (!opensAt) return null;
  let host = opensAt.trim();
  if (host.startsWith('https://')) {
    let url: URL;
    try {
      url = new URL(host);
    } catch {
      return null;
    }
    if (url.username || url.password || url.port || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    host = url.hostname;
  }
  return HOSTNAME.test(host) ? host.toLowerCase() : null;
}

function documentOf(title: string, main: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>${title}</title>
    <style>
${TOKEN_BLOCK}
    </style>
  </head>
  <body>
    <main>
${main}
    </main>
  </body>
</html>
`;
}

const eyebrow = (name: string) => `      <p class="eyebrow">${escapeHtml(name)}</p>`;
const heading = (text: string) => `      <h1>${text}</h1>`;
const sentence = (html: string) => `      <p class="sentence">${html}</p>`;

/** The one Not-found document, the same bytes for every reason. */
const NOT_FOUND_PAGE: EdgePage = {
  status: 404,
  body: documentOf(
    STRINGS.notFound.title,
    [heading(STRINGS.notFound.heading), sentence(STRINGS.notFound.sentence)].join('\n'),
  ),
};

/** The page an outcome answers with; `forward` has none. Total over the rest. */
export function pageFor(outcome: Exclude<EdgeOutcome, { kind: 'forward' }>): EdgePage {
  switch (outcome.kind) {
    case 'no-application': {
      const s = STRINGS.noApplication;
      return {
        status: 200,
        body: documentOf(
          s.title,
          [
            eyebrow(outcome.name),
            heading(s.heading),
            sentence(s.sentence(escapeHtml(outcome.name))),
          ].join('\n'),
        ),
      };
    }
    case 'members-only': {
      const s = STRINGS.membersOnly;
      const address = addressOf(outcome.opensAt);
      const name = escapeHtml(outcome.name);
      const text = address
        ? s.sentenceWithAddress(
            name,
            `<a href="https://${escapeHtml(address)}/">${escapeHtml(address)}</a>`,
          )
        : s.sentenceWithoutAddress(name);
      return {
        status: 200,
        body: documentOf(
          s.title,
          [eyebrow(outcome.name), heading(s.heading), sentence(text)].join('\n'),
        ),
      };
    }
    case 'unavailable': {
      const s = STRINGS.unavailable;
      return {
        status: 503,
        body: documentOf(
          s.title,
          [
            eyebrow(outcome.name),
            heading(s.heading),
            sentence(s.sentence(escapeHtml(outcome.name))),
          ].join('\n'),
        ),
      };
    }
    case 'not-found':
      return NOT_FOUND_PAGE;
  }
}
