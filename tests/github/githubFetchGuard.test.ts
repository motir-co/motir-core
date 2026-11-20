import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-11844 — every GitHub request motir-core sends is COUNTED under a named
// caller (`GithubRequestCount`) and every throttled answer to one writes the
// `github.throttle` line. Both happen in ONE place, `githubFetch`
// (`lib/github/githubFetch.ts`), so this guard holds the line structurally: a
// production module that talks to GitHub may not call `fetch` itself.
//
// "Talks to GitHub" is read two ways, and a module is held if either is true:
//   - it LIVES in a GitHub module path (`lib/github/**`, `lib/git/providers/github*`);
//   - it NAMES GitHub's API — `api.github.com`, a `GITHUB_API` base, or the OAuth
//     token endpoint `github.com/login/oauth`.
// A GitHub module that sends through a shared generic transport instead
// (`fetchWithinDeadline`, `fetchWithRetry`) must hand it the counted send
// (`githubFetchFor`) or the counting hooks (`githubRequestHooks`).

const ROOT = join(__dirname, '..', '..');
const SCANNED = ['lib', 'app'];

/** The one module allowed to call `fetch` for GitHub. */
const THE_DOOR = 'lib/github/githubFetch.ts';

/** Test doubles that ship in `lib/` only so the e2e server can load them. */
const TEST_ONLY = /^lib\/test-/;

const GITHUB_PATH = /^lib\/github\/|^lib\/git\/providers\/github[^/]*\.ts$/;
const GITHUB_HOST = /api\.github\.com|\bGITHUB_API\b|github\.com\/login\/oauth/;
const GENERIC_TRANSPORT = /\b(fetchWithinDeadline|fetchWithRetry)\(/;
const COUNTED_TRANSPORT = /\b(githubFetchFor|githubRequestHooks)\(/;

/** A raw `fetch(` call — not `githubFetch(`, not `.fetch(` on some object. */
const RAW_FETCH = /(^|[^\w.$])fetch\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** The code of a file with its comments blanked, so prose about `fetch(` is not a call. */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '');
}

interface Bypass {
  readonly file: string;
  readonly line: number;
  readonly why: 'raw fetch' | 'uncounted transport';
}

/** Every way `text` (the source of `file`) reaches GitHub around the counted door. */
function bypassesIn(file: string, text: string): Bypass[] {
  if (file === THE_DOOR || TEST_ONLY.test(file)) return [];
  const code = codeOf(text);
  // The host is read off the RAW text: blanking `//` comments would also cut a
  // `'https://api.github.com…'` literal. Naming the host in prose only holds a
  // module to the rule, which costs nothing.
  if (!GITHUB_PATH.test(file) && !GITHUB_HOST.test(text)) return [];
  const found: Bypass[] = [];
  code.split('\n').forEach((line, index) => {
    if (RAW_FETCH.test(line)) found.push({ file, line: index + 1, why: 'raw fetch' });
  });
  if (GENERIC_TRANSPORT.test(code) && !COUNTED_TRANSPORT.test(code)) {
    const line = code.split('\n').findIndex((l) => GENERIC_TRANSPORT.test(l)) + 1;
    found.push({ file, line, why: 'uncounted transport' });
  }
  return found;
}

/** The closed caller set, read off `restRetry.ts` as TEXT: this guard runs in the
 *  structural-guard lane, which may import nothing from `lib/`. */
function declaredCallers(): string[] {
  const src = readFileSync(join(ROOT, 'lib/github/restRetry.ts'), 'utf8');
  const start = src.indexOf('export const GITHUB_CALLERS = [');
  const end = src.indexOf('] as const;', start);
  return [...codeOf(src.slice(start, end)).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

const FILES = SCANNED.flatMap((dir) => sourceFiles(join(ROOT, dir))).map((path) => ({
  file: relative(ROOT, path).split('\\').join('/'),
  path,
}));

describe('every GitHub request goes through the counted door', () => {
  it('no production module reaches GitHub around githubFetch', () => {
    const bypasses = FILES.flatMap(({ file, path }) =>
      bypassesIn(file, readFileSync(path, 'utf8')),
    );
    expect(bypasses).toEqual([]);
  });

  it('the scan actually sees the GitHub modules it guards', () => {
    const held = FILES.filter(
      ({ file, path }) => GITHUB_PATH.test(file) || GITHUB_HOST.test(readFileSync(path, 'utf8')),
    ).map(({ file }) => file);
    // A scan that found nothing would pass vacuously.
    expect(held.length).toBeGreaterThan(40);
    for (const file of [
      'lib/git/providers/github.ts',
      'lib/github/checkRuns.ts',
      'lib/github/repoProvisioning.ts',
      'lib/services/githubIdentityService.ts',
      'lib/import/connectors/githubConnector.ts',
    ])
      expect(held).toContain(file);
  });

  it('every caller in the closed set is used by some call site (no dead dimension)', () => {
    const code = FILES.map(({ path }) => readFileSync(path, 'utf8')).join('\n');
    const callers = declaredCallers();
    expect(callers.length).toBeGreaterThan(50);
    const unused = callers.filter((caller) => !code.includes(`'${caller}'`));
    expect(unused).toEqual([]);
  });
});

describe('bypassesIn — the scanner itself', () => {
  it('flags a raw fetch to api.github.com outside the door', () => {
    const text = "const r = await fetch('https://api.github.com/rate_limit');\n";
    expect(bypassesIn('lib/services/newThing.ts', text)).toEqual([
      { file: 'lib/services/newThing.ts', line: 1, why: 'raw fetch' },
    ]);
  });

  it('flags a raw fetch in a GitHub module even when the URL is built elsewhere', () => {
    expect(bypassesIn('lib/github/newLeaf.ts', 'return fetch(url, init);\n')).toHaveLength(1);
  });

  it('passes the counted door, a method named fetch, and prose about fetch(', () => {
    const text = [
      '// we never call fetch( directly — see githubFetch',
      '/* fetch(url) */',
      "const r = await githubFetch('rateLimit', `${GITHUB_API}/rate_limit`);",
      'await this.client.fetch(url);',
    ].join('\n');
    expect(bypassesIn('lib/github/rateLimit.ts', text)).toEqual([]);
  });

  it('flags a GitHub module that sends through a generic transport without the counted send', () => {
    const text =
      "const GITHUB_API = 'https://api.github.com';\nawait fetchWithinDeadline(url, init);\n";
    expect(bypassesIn('lib/git/providers/githubThing.ts', text)).toEqual([
      { file: 'lib/git/providers/githubThing.ts', line: 2, why: 'uncounted transport' },
    ]);
    const counted = `${text}githubFetchFor('codeHistory.log');\n`;
    expect(bypassesIn('lib/git/providers/githubThing.ts', counted)).toEqual([]);
  });

  it('ignores a module that does not talk to GitHub, the door itself and lib/test-* doubles', () => {
    expect(bypassesIn('lib/services/jira.ts', 'await fetch(jiraUrl);\n')).toEqual([]);
    expect(bypassesIn(THE_DOOR, 'await fetch(input, init);\n')).toEqual([]);
    expect(
      bypassesIn('lib/test-github-mock.ts', "await fetch('https://api.github.com/x');\n"),
    ).toEqual([]);
  });
});
