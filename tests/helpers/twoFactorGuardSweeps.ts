import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Story MOTIR-1215 · Subtask MOTIR-3649 — the four sweeps this story's guards
// are built on, extracted so a test can WATCH THEM FAIL.
//
// ⚠️ WHY THEY MOVED HERE. Each guard walked `process.cwd()` directly, which
// makes it un-runnable against anything but the real tree — so the only way to
// see one go red was to break the repository by hand, watch, and put it back.
// A guard nobody has watched fail is indistinguishable from a guard that never
// runs, and this story adds four of them.
//
// Taking the ROOT as a parameter costs one argument and buys
// `tests/integration/twoFactorEnforcementStoryGate.test.ts`, which builds a
// tiny tree in a temp directory with one violation in it and asserts each sweep
// reports exactly that violation — and reports nothing once it is removed.
//
// The guard files keep their own EXEMPT lists, their reasons and their
// both-directions assertions. What lives here is only the walk and the
// predicate: the part that has to be shared for the failure to be observable.

/** Source with comments stripped — a mention in prose is not a call. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Every `.ts`/`.tsx` under `dir`, recursively. Absolute paths. */
export function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkSources(p, out);
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const posix = (root: string, abs: string): string => relative(root, abs).split(sep).join('/');

// ── 1. The route-group totality sweep (MOTIR-3648) ──────────────────────────

/**
 * Every `app/(group)/layout.tsx` that does NOT call `assertTwoFactorCompliance`
 * and is not exempt — the choke point each signed-in group's pages share.
 *
 * Returns the offending group names, so a caller can render its own message.
 */
export function ungatedRouteGroups(appDir: string, exempt: ReadonlySet<string>): string[] {
  return readdirSync(appDir)
    .filter((entry) => entry.startsWith('(') && entry.endsWith(')'))
    .filter((group) => {
      try {
        return statSync(join(appDir, group, 'layout.tsx')).isFile();
      } catch {
        return false;
      }
    })
    .filter((group) => !exempt.has(group))
    .filter(
      (group) =>
        !stripComments(readFileSync(join(appDir, group, 'layout.tsx'), 'utf8')).includes(
          'assertTwoFactorCompliance',
        ),
    )
    .sort();
}

// ── 2. The API sweep (MOTIR-3653) ───────────────────────────────────────────

/** The three helpers a route under `app/api/**` can reach a session through. */
export const SESSION_DOORS = ['getSession', 'getWorkspaceContext', 'getActiveProject'] as const;

/** The gate's entry points. */
export const GATE_ENTRY_POINTS = [
  'requireCompliantSession',
  'requireCompliantWorkspaceContext',
  'refuseIfNonCompliant',
  'resolveTwoFactorHold',
] as const;

export interface ApiAuthFile {
  /** Repo-relative, posix separators. */
  rel: string;
  /** Direct door reads in this file's own source. */
  reads: number;
  gated: boolean;
}

/**
 * ⚠️ COUNT THE CALL, NOT THE IMPORT PATH. Every gated file imports from
 * `@/lib/auth/requireCompliantSession`, so a bare substring test matches the
 * module PATH of all four entry points and reports every one of them adopted.
 */
export const callsGate = (src: string): boolean =>
  GATE_ENTRY_POINTS.some((g) => src.includes(`${g}(`));

/**
 * Every file under `apiDir` that AUTHENTICATES — by reading a door itself, or
 * by calling a gate entry point that reads one for it.
 *
 * ⚠️ BOTH ARMS MATTER. Once a route folds its preamble into the gate, the words
 * `getSession` and `getWorkspaceContext` leave its source entirely; an
 * enumeration by door alone would count the RESIDUE of the sweep and call it
 * the API.
 */
export function apiAuthFiles(root: string, apiDir: string): ApiAuthFile[] {
  return walkSources(apiDir)
    .map((abs) => {
      const src = stripComments(readFileSync(abs, 'utf8'));
      const reads = SESSION_DOORS.reduce(
        (n, door) => n + (src.match(new RegExp(`await ${door}\\(\\)`, 'g')) ?? []).length,
        0,
      );
      return { rel: posix(root, abs), reads, gated: callsGate(src) };
    })
    .filter((f) => f.reads > 0 || f.gated)
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/** The subset that reads a door, gates nothing, and is not exempt. */
export function ungatedApiFiles(
  root: string,
  apiDir: string,
  exempt: ReadonlySet<string>,
): ApiAuthFile[] {
  return apiAuthFiles(root, apiDir).filter((f) => !f.gated && !exempt.has(f.rel));
}

// ── 3. The proxy-matcher totality sweep (MOTIR-3652) ────────────────────────

/** True when this directory, or anything under it, serves a page. */
export function servesAPage(dir: string): boolean {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (servesAPage(p)) return true;
    } else if (entry === 'page.tsx' || entry === 'page.ts') {
      return true;
    }
  }
  return false;
}

/**
 * The top-level URL segments a route group serves. A route group (`(x)`) adds
 * no URL segment and is recursed into; a `_private` folder serves nothing.
 */
export function topLevelSegments(appDir: string, group: string): string[] {
  const base = join(appDir, group);
  const out: string[] = [];
  for (const entry of readdirSync(base)) {
    const p = join(base, entry);
    if (!statSync(p).isDirectory()) continue;
    if (entry.startsWith('_')) continue;
    if (entry.startsWith('(') && entry.endsWith(')')) {
      out.push(...topLevelSegments(appDir, join(group, entry)));
      continue;
    }
    if (servesAPage(p)) out.push(entry);
  }
  return [...new Set(out)].sort();
}

/** `'/items/:path*'` → `'items'`. */
/**
 * The PATH entries of `config.matcher` — every entry but the one host-conditioned
 * object (MOTIR-5779), which matches every path on a PREVIEW host and no path on
 * app.motir.co, so it is no part of the path list these sweeps measure.
 * `tests/preview/gateProxy.test.ts` pins that object.
 */
export const pathMatchers = (matcher: readonly (string | object)[]): string[] =>
  matcher.filter((entry): entry is string => typeof entry === 'string');

export const segmentOf = (matcherEntry: string): string =>
  matcherEntry.replace(/^\//, '').split('/')[0] ?? '';

/** Segments a signed-in group serves that the matcher does not cover. */
export function uncoveredProxySegments(
  appDir: string,
  groups: readonly string[],
  matcher: readonly string[],
): string[] {
  const covered = new Set(matcher.map(segmentOf));
  return groups
    .flatMap((group) => topLevelSegments(appDir, group).filter((s) => !covered.has(s)))
    .sort();
}

/** Matcher entries no signed-in group serves — the other direction. */
export function strayProxyEntries(
  appDir: string,
  groups: readonly string[],
  matcher: readonly string[],
): string[] {
  const served = new Set(groups.flatMap((g) => topLevelSegments(appDir, g)));
  return matcher.map(segmentOf).filter((s) => !served.has(s));
}

// ── 4. The one-implementation sweep (MOTIR-3645) ────────────────────────────

/**
 * Files under `libDir` DECLARING a symbol of this name.
 *
 * ⚠️ A FILESYSTEM WALK, NOT `git grep`. `git grep` reads the INDEX, so a file
 * written but not yet staged is invisible to it — which is exactly the state a
 * second implementation is in on the day somebody adds one, and the reason this
 * guard once passed vacuously.
 */
export function declaringFiles(libDir: string, root: string, name: string): string[] {
  const re = new RegExp(`(function|const) ${name}\\b`);
  return walkSources(libDir)
    .filter((abs) => re.test(stripComments(readFileSync(abs, 'utf8'))))
    .map((abs) => posix(root, abs))
    .sort();
}

/**
 * The two lenses `tests/twoFactorHasSecondFactor.test.ts` reads `lib/` through,
 * over any root.
 *
 * ⚠️ THEY LIVE HERE RATHER THAN IN THAT TEST FILE, and the reason is not tidiness:
 * importing a `*.test.ts` from another test file RE-EXECUTES its `describe`
 * blocks in the importing file's context, so the whole predicate suite would run
 * twice and be reported under the wrong name. A helper module has no suite to
 * re-execute.
 */
export const libFilesContainingIn = (root: string, needle: string): string[] =>
  libFilesWhereIn(root, (source) => source.includes(needle));

export const libFilesMatchingIn = (root: string, pattern: RegExp): string[] =>
  libFilesWhereIn(root, (source) => pattern.test(source));

/**
 * Files under `<root>/lib` whose RAW source satisfies the predicate.
 *
 * ⚠️ RAW, not comment-stripped, and deliberately: the guard this serves treats a
 * documentation mention of `twoFactorEnabled` as something to be declared on an
 * allowlist with a reason. A file that names the column only to say it is NOT
 * the test is still a file a reader will find by grep.
 */
function libFilesWhereIn(root: string, predicate: (source: string) => boolean): string[] {
  return walkSources(join(root, 'lib'))
    .filter((abs) => abs.endsWith('.ts') && predicate(readFileSync(abs, 'utf8')))
    .map((abs) => posix(root, abs))
    .sort();
}
