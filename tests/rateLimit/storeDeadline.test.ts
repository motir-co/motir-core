import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
// ⚠️ From `rateLimitStoreDeadline`, NOT from `rateLimitStore` — this file is a
// filesystem scanner in the structural-guard lane, and the helper reaches
// `@/lib/db` transitively, which throws without a DATABASE_URL (MOTIR-3144).
import { TEST_RATE_LIMIT_STORE_TIMEOUT_MS } from '../helpers/rateLimitStoreDeadline';

// The anti-recurrence guard for MOTIR-2658 / MOTIR-3067 — the STORE-DEADLINE
// class, sibling to the epoch-window class `tests/api/v1/rate-limit-window-alignment.test.ts`
// guards.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
// `createPostgresRateLimitStore()` gives ONE counter increment 250 ms
// (`DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS`), and on expiry `consumeSharedRateLimit`
// FAILS OPEN by design — `{ allowed: true, degraded: true }`. That is a correct
// production contract and this guard does not touch it. What it guards is the
// consequence for TESTS: any assertion that a request was REFUSED silently
// carries a second claim, that the counter was reachable inside 250 ms. On a CI
// shard running 5 000+ tests against one Postgres, that claim is not reliably
// true — and when it fails, the test reports `expected null not to be null` on a
// diff that touched no rate-limiting code at all.
//
// ── WHY A GUARD AND NOT A THIRD FIX ──────────────────────────────────────────
// MOTIR-2658 diagnosed this exact mechanism and fixed its own file. MOTIR-3016
// named it in *Out of scope* and moved on. So the class was understood correctly
// twice and swept zero times — the same *instance fixed, class left standing*
// shape the epoch-window class went through for four months and roughly six red
// pull requests before MOTIR-3016 finally closed it.
//
// ── THE SHAPE, WHICH IS THE REUSABLE PART (MOTIR-3016 AC 4) ──────────────────
// A guard keyed on A WRONG THING BEING PRESENT catches the careless; a guard
// keyed on A RIGHT THING BEING ABSENT catches the unaware — and the unaware are
// the larger population. An absent call matches no pattern, so the subject set
// is DERIVED from the tree rather than listed, the verdict is "the right call is
// present", and opting out is a named entry WITH A REASON. Silence is not an
// opt-out; that is the whole difference between this and the state the defect
// grew in.
//
// Three derivations, none hand-maintained:
//
//  1. **The REACH** comes from `lib/` + `app/`: which modules can end up calling
//     `sharedRateLimitStore()`, by transitive import. This is used only to
//     EXCLUDE — it is a wide over-approximation (a little over half the test
//     tree reaches it), and its whole job is to keep the mocked-429 suites
//     (`tests/import/http.test.ts`, the GitHub API limiter, the CI-fleet rate
//     tables, the component tests) out of the subject set without an exemption
//     anyone had to think of.
//  2. **The REFUSAL VOCABULARY** comes from `lib/`: the `RATE_LIMITED_CODE`
//     literal and every exported rate-limit `Error` class. A renamed code or a
//     new typed refusal joins the vocabulary with no edit here.
//  3. **The SUBJECTS** are the test files that both reach and refuse — minus the
//     ones that pin an IN-PROCESS counter, which has no deadline to miss.
//
// The verdict is per file: it must BIND `tests/helpers/rateLimitStore.ts`.

const REPO_ROOT = process.cwd();

/** The one module allowed to define the test-time deadline. */
const HELPER = 'tests/helpers/rateLimitStore.ts';

/** The function whose resolution is the hazard — the seed of the reach set. */
const RESOLVER = 'sharedRateLimitStore';

/**
 * A real IMPORT of the helper — not a mention of it.
 *
 * ⚠️ This is the trap MOTIR-3016 hit one file over, and it is worth restating
 * because a comment is exactly what a file gets when someone documents an
 * intention instead of acting on it: every file that pins a deadline also
 * EXPLAINS why in prose, and prose names the helper. `source.includes(…)` is
 * therefore satisfied by a file that imports nothing. What an import has and a
 * comment does not is a QUOTED SPECIFIER IN AN IMPORT POSITION — and all three
 * binding forms have it, including the top-level `await import(…)` that
 * `tests/api-coding-convention-route.test.ts` needs so the module is bound
 * before its `vi.mock` factories run. A guard with a false positive gets deleted
 * rather than obeyed, so all three are accepted.
 */
const BINDS_HELPER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"][^'"]*helpers\/rateLimitStore['"]/;

/**
 * A counter that lives in this process — `/api/v1`'s `resetRateLimitStore()`
 * (which installs a fresh Map, deliberately) or the Map's own factory.
 *
 * A file that pins one is not exposed at all: an in-process Map has no deadline
 * to miss, so its refusals cannot be served by a fail-open. Roughly forty suites
 * are in this state and none of them should be edited.
 */
const IN_PROCESS_COUNTER = /\bresetRateLimitStore\s*\(|\bcreateInProcessRateLimitStore\s*\(/;

/**
 * Strip `//` and block comments, keeping string and template literals intact.
 *
 * ⚠️ EVERY predicate in this file runs over the STRIPPED source, and that is
 * load-bearing in BOTH directions. A comment must not satisfy the requirement
 * (the `BINDS_HELPER` note above), and — the direction that is easier to miss —
 * a comment must not grant an EXEMPTION either: `tests/api/v1/shared-store.test.ts`
 * explains at length why it does not call `resetRateLimitStore()`, writing the
 * call with its parentheses twice while calling it zero times. Matched raw, that
 * prose would have excluded the very file this class was first found in.
 */
const DELIMITER = /[/'"`]/g;

function stripComments(source: string): string {
  // Slice-based rather than character-by-character: this runs over ~3 000 files
  // and ~28 MB, where per-character string building costs seconds. Measured on
  // this tree: 2 187 ms char-by-char vs 169 ms here, byte-identical output on
  // every file.
  const kept: string[] = [];
  let cut = 0;
  DELIMITER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DELIMITER.exec(source)) !== null) {
    const at = match.index;
    if (at < cut) {
      DELIMITER.lastIndex = cut;
      continue;
    }
    const c = source[at];
    const next = source[at + 1];
    if (c === '/' && next === '/') {
      kept.push(source.slice(cut, at));
      const end = source.indexOf('\n', at + 2);
      cut = end < 0 ? source.length : end;
    } else if (c === '/' && next === '*') {
      kept.push(source.slice(cut, at));
      const end = source.indexOf('*/', at + 2);
      cut = end < 0 ? source.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      // Keep the literal whole — a `//` or `/*` inside a string is not a comment.
      let end = at + 1;
      while (end < source.length) {
        if (source[end] === '\\') {
          end += 2;
          continue;
        }
        if (source[end] === c) {
          end += 1;
          break;
        }
        end += 1;
      }
      kept.push(source.slice(cut, end));
      cut = end;
    } else {
      DELIMITER.lastIndex = at + 1;
      continue;
    }
    DELIMITER.lastIndex = cut;
  }
  kept.push(source.slice(cut));
  return kept.join('');
}

const asPosix = (absolute: string) => relative(REPO_ROOT, absolute).split(sep).join('/');

function walk(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(asPosix(full));
  }
  return found;
}

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/**
 * Resolve one import specifier to a repo file, honouring the `@/` root alias and
 * the extension/index candidates TypeScript would try. A bare package specifier
 * resolves to nothing, which is correct — `node_modules` cannot reach our store.
 */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(REPO_ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(join(REPO_ROOT, fromFile)), specifier);
  else return null;

  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    base,
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return asPosix(candidate);
  }
  return null;
}

/**
 * The whole scan, memoised at module scope.
 *
 * ⚠️ Memoised because this walks `lib/` + `app/` + `tests/` and runs a fixpoint
 * over the import graph — a few thousand files. Re-deriving it per test passes
 * bare and TIMES OUT under `--coverage`, where the v8 provider instruments every
 * module the scan touches; a sibling structural guard (`tests/rls/callSiteScan.ts`)
 * learned that the expensive way, failing only the coverage lane on a change that
 * added no test. The filesystem cannot change inside a run, so no invalidation is
 * needed.
 */
let scanned: Scan | undefined;

interface Scan {
  /** Every `.ts` / `.tsx` under `tests/`, repo-relative with POSIX separators. */
  testFiles: string[];
  /** Stripped source, by repo-relative path, for every file the scan read. */
  source: ReadonlyMap<string, string>;
  /** Files that can transitively reach `sharedRateLimitStore()`. */
  reaching: ReadonlySet<string>;
  /** Exported rate-limit `Error` class names, from `lib/`. */
  refusalErrors: string[];
  /** The value of `RATE_LIMITED_CODE`, from `lib/rateLimit/guard.ts`. */
  refusalCode: string;
}

function scan(): Scan {
  if (scanned) return scanned;

  const files = [
    ...walk(join(REPO_ROOT, 'lib')),
    ...walk(join(REPO_ROOT, 'app')),
    ...walk(join(REPO_ROOT, 'tests')),
  ];
  const source = new Map(
    files.map((file) => [file, stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'))]),
  );

  const imports = new Map<string, Set<string>>(
    files.map((file) => [
      file,
      new Set(
        [...source.get(file)!.matchAll(IMPORT_SPECIFIER)]
          .map(([, specifier]) => resolveSpecifier(file, specifier!))
          .filter((resolved): resolved is string => resolved !== null),
      ),
    ]),
  );

  const resolverCall = new RegExp(String.raw`\b${RESOLVER}\s*\(`);
  const reaching = new Set(files.filter((file) => resolverCall.test(source.get(file)!)));
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of files) {
      if (reaching.has(file)) continue;
      for (const dependency of imports.get(file)!) {
        if (reaching.has(dependency)) {
          reaching.add(file);
          changed = true;
          break;
        }
      }
    }
  }

  const refusalErrors = new Set<string>();
  for (const file of files.filter((f) => f.startsWith('lib/'))) {
    for (const [, name] of source
      .get(file)!
      .matchAll(/export\s+class\s+(\w*RateLimit\w*Error|\w*RateLimited\w*Error)\b/g)) {
      refusalErrors.add(name!);
    }
  }

  const refusalCode = /RATE_LIMITED_CODE\s*=\s*'([A-Z_]+)'/.exec(
    source.get('lib/rateLimit/guard.ts') ?? '',
  )?.[1];

  scanned = {
    testFiles: files.filter((file) => file.startsWith('tests/')).sort(),
    source,
    reaching,
    refusalErrors: [...refusalErrors].sort(),
    refusalCode: refusalCode ?? '',
  };
  return scanned;
}

/**
 * THE REFUSAL VOCABULARY — an assertion a fail-open decision falsifies.
 *
 * The literal shapes are the four a refusal can take at the boundaries this
 * codebase actually has: an HTTP 429, a `RateLimitDecision` with
 * `allowed: false` or `degraded: false`, and `enforceRateLimit`'s non-null
 * `response`. The typed-error half is DERIVED from `lib/`, so a new refusal
 * class or a rename joins it without an edit here.
 */
function refusalPattern(): RegExp {
  const { refusalErrors, refusalCode } = scan();
  return new RegExp(
    [
      String.raw`\btoBe\(\s*429\s*\)`,
      String.raw`\bstatus:\s*429\b`,
      String.raw`allowed\s*\)\s*\.toBe\(\s*false\s*\)`,
      String.raw`degraded\s*\)\s*\.toBe\(\s*false\s*\)`,
      String.raw`response\s*\)\s*\.not\.toBeNull\(\)`,
      String.raw`\bRATE_LIMITED_CODE\b`,
      `['"]${refusalCode}['"]`,
      ...refusalErrors.map((name) => String.raw`\b${name}\b`),
    ].join('|'),
  );
}

/**
 * THE PREDICATE. A test file asserts a refusal against the shared Postgres store
 * when it (a) can reach the resolver, (b) asserts a refusal, and (c) has not
 * pinned an in-process counter instead.
 */
function assertsRefusalAgainstSharedStore(file: string): boolean {
  const { reaching, source } = scan();
  if (!reaching.has(file)) return false;
  const text = source.get(file)!;
  return refusalPattern().test(text) && !IN_PROCESS_COUNTER.test(text);
}

/**
 * Files that reach the shared store and assert a refusal, and for which the
 * store's deadline is nonetheless irrelevant.
 *
 * The named alternative to silence. An entry is a decision ON THE RECORD with
 * the reason it is one; a file that merely forgot has no entry and fails. Each
 * reason below was established by reading the production path the refusal comes
 * from — none is a guess about how a suite behaves.
 */
const DEADLINE_IRRELEVANT: ReadonlyMap<string, string> = new Map([
  [
    'tests/loadtest/storyGate.refusals.test.ts',
    'Its refusals are BUILT, not counted (MOTIR-8681): `mcpRateLimitedResponse`, ' +
      '`rateLimitedToolError` and `classifyApiV1Error(new RateLimitExceededError(…))` are ' +
      'called directly to produce the response shapes the load-test classifiers and report ' +
      'must read as `limited`. No request reaches a limiter and no increment runs.',
  ],
  [
    'tests/rateLimit/storeGuard.test.ts',
    'Its refusals are the BOOT GUARD’s (`assertRateLimitStoreAllowed`, ' +
      '`lib/rateLimit/storeGuard.ts`, MOTIR-8614): a pure function of the env it is handed, ' +
      'throwing `MemoryRateLimitStoreRefusedError` for a production build configured with ' +
      'the `memory` store. It reaches `lib/rateLimit/store.ts` only to check the re-export; ' +
      'no request is made, no budget is spent and no increment runs.',
  ],
  [
    'tests/two-instance/limits.spec.ts',
    'Its 429s come from two `next start` PROCESSES the lane spawns (MOTIR-8617), each ' +
      'resolving its own shared store from its own env — a store this test process ' +
      'cannot pin, because nothing it sets reaches another process. The deadline those ' +
      'servers count at is the production 250 ms, and the lane accepts that on purpose: ' +
      'it measures the deployed configuration. The exposure is one spec file against one ' +
      'otherwise idle database in its own CI job, not a contended shard.',
  ],
  [
    'tests/agentInstances/agentInstanceUnits.test.ts',
    'Its 429s are not rate limits: they are `mapAgentInstanceError`’s status for the ' +
      'agent lane’s CAPS (`AgentInstanceStartRefusedError` `user_cap`, `fleet_busy`, ' +
      '`org_running_cap` — `lib/agentInstances/errorResponse.ts`), asserted on a constructed ' +
      'error with no request and no store. It started to REACH the resolver when the storage ' +
      'charge began enqueuing its platform meter report (MOTIR-7294: ' +
      '`agentInstanceStorageChargeService` → `platformMeterReportEnqueue` → `sendEvent` → the ' +
      'job registry), which spends no budget either.',
  ],
  [
    'tests/e2e/regression-my-agents.spec.ts',
    'Its one 429 is not a rate limit at all: it is the agent lane’s PERSONAL LIMIT ' +
      '(`AgentInstanceStartRefusedError` `user_cap`, `lib/agentInstances/errorResponse.ts` — ' +
      '"429 for a cap"), decided by a count of the owner’s live agents in the database. ' +
      'No rate-limit budget is spent and no store is resolved (MOTIR-6877).',
  ],
  [
    'tests/e2e/regression-plan-caps.spec.ts',
    'Its one 429 is the agent lane’s PERSONAL LIMIT under the org’s plan ' +
      '(`AgentInstanceStartRefusedError` `user_cap` carrying the plan’s figure, ' +
      '`lib/agentInstances/errorResponse.ts`), decided by a count of the owner’s live agents ' +
      'against `planCapsService.capsFor`. No rate-limit budget is spent and no store is ' +
      'resolved (MOTIR-9379).',
  ],
  [
    'tests/integration/planCapsStoryGate.test.ts',
    'Its one 429 is `mapAgentInstanceError`’s status for a REAL `user_cap` refusal ' +
      '(`lib/agentInstances/errorResponse.ts`), produced by the agent create gate counting ' +
      'the owner’s live agents against the plan’s figure (MOTIR-9378). No request reaches a ' +
      'limiter and no store is resolved.',
  ],
  [
    'tests/e2e/regression-visitor-requested-features.spec.ts',
    'Its one 429 is a refusal the SPEC hands back: `page.route` fulfils the upvote POST ' +
      'with a 429 so the Requested features row’s restore-and-say-so arm is walked ' +
      '(MOTIR-6770). The lane runs with `E2E_DISABLE_RATE_LIMIT`, so no budget is spent ' +
      'and no store is resolved.',
  ],
  [
    'tests/ai/askRoutes.test.ts',
    'Its one 429 is a refusal the SPEC hands back: `enforceAiRateLimit` is mocked to ' +
      'return a prepared Response so the ask route’s early return is exercised ' +
      '(MOTIR-6026). No budget is spent and no store is resolved — every other case ' +
      'passes through to the real limiter and asserts no refusal.',
  ],
  [
    'tests/rateLimit/retryAfterPluralisation.test.ts',
    'Constructs `RateLimitDecision` object literals by hand and passes them to ' +
      '`rateLimitedResponse` / `mcpRateLimitedResponse` to assert the 429’s PROSE and ' +
      'headers. It never spends a budget, never touches a counter, and never resolves a ' +
      'store — the refusals it asserts are inputs it wrote, not outcomes a limiter ' +
      'reached. (MOTIR-3067)',
  ],
  [
    'tests/workspace-invites.test.ts',
    'The invite throttle is NOT the shared limiter. `workspaceInvitesService` counts ' +
      '`verification` ROWS in the window (`countByIdentifierPrefixAndValueAndSince` vs ' +
      '`INVITE_RATE_LIMIT.max`) and throws `InviteRateLimitedError`, which the route maps ' +
      'to the same `RATE_LIMITED` code the limiter uses — which is why it reads as a ' +
      'subject. There is no store, no deadline and no fail-open arm on that path. ' +
      '(MOTIR-3067)',
  ],
  [
    'tests/email-change.test.ts',
    'Same shape as the invite throttle: `usersService.requestEmailChange` compares a ' +
      'recent-row COUNT against `EMAIL_CHANGE_RATE_MAX` and throws ' +
      '`EmailChangeRateLimitedError`. A row count has no deadline to miss. (MOTIR-3067)',
  ],
  [
    'tests/mcp/searchLessons.test.ts',
    'The `search_lessons` tool spec DOUBLES `@/lib/rateLimit/aiGuard` wholesale ' +
      '(`vi.mock`), so `enforceAiRateLimit` is a `vi.fn()` and `enforceRateLimit`, ' +
      '`sharedRateLimitStore()` and the Postgres counter are never reached at all. The 429 it ' +
      'asserts is a `Response` the test CONSTRUCTED to check that the tool renders a refusal as ' +
      'a tool ERROR carrying `Retry-After` rather than throwing — the same shape as ' +
      '`retryAfterPluralisation.test.ts` above: an input it wrote, not an outcome a limiter ' +
      'reached. The real store path IS exercised for this tool, one tier up and unmocked, by ' +
      '`tests/mcp/searchLessonsTransport.test.ts`, which asserts no refusal and so is not a ' +
      'subject. (MOTIR-3480)',
  ],
  [
    'tests/monitoring/sentry-wiring.test.ts',
    'Spends no budget and resolves no store. It reaches the resolver only because it ' +
      'imports `RATE_LIMIT_EXCLUDED_PATHS` from `@/lib/rateLimit/guard` — a frozen array of ' +
      'PATHS — to assert that the Sentry tunnel (`/monitoring`) and the constant naming it ' +
      'have not drifted apart. It reads as a subject because of one line elsewhere in the ' +
      "file: `new ApiV1Error('RATE_LIMITED', 429, …)`, constructed to check that Sentry’s " +
      '`beforeSend` DROPS an expected typed domain 4xx. Same shape as ' +
      '`retryAfterPluralisation.test.ts` at the top of this list — a refusal it wrote as an ' +
      'input, not one a limiter reached. (MOTIR-1162)',
  ],
  [
    'tests/components/DataExportCard.test.tsx',
    'A component test that DOUBLES the Server Action wholesale (`vi.mock` of ' +
      '`app/(authed)/settings/account/data/actions`), so `requestDataExportAction` is a ' +
      '`vi.fn()` and `consumeRateLimit` → `consumeSharedRateLimit` → the Postgres counter ' +
      'are never reached. The `RATE_LIMITED` it asserts is a RESULT the test wrote, to check ' +
      'that the export card surfaces a refusal as a toast and stays IDLE rather than ' +
      'advancing to `preparing` — the same shape as `retryAfterPluralisation.test.ts` at the ' +
      'top of this list. The real store path for that action is production code with no ' +
      'test of its own yet; the limit itself is `account:data-export` in ' +
      '`lib/rateLimit/keys.ts`. (MOTIR-1136)',
  ],
  [
    'tests/password-reset.test.ts',
    'The 429 here is Better-Auth’s OWN limiter — `rateLimit.customRules` in ' +
      '`lib/auth/index.ts`, bound to `/request-password-reset` — reached by calling ' +
      '`auth.handler` directly rather than through the Next middleware where ' +
      '`enforceAuthRateLimit` lives. Better-Auth keeps that counter itself and never ' +
      'consults `sharedRateLimitStore()`. (MOTIR-3067)',
  ],
  [
    'tests/planChange/resumeRoute.test.ts',
    'Its 429 comes from a MOCK of `enforceAiRateLimit` (`rateLimit.mockResolvedValue(new ' +
      'Response(…, { status: 429 }))`): the route runs with the limiter replaced, so no request ' +
      'counts through the shared Postgres store and the production deadline never applies.',
  ],
  [
    'tests/planning/planOfferRoutes.test.ts',
    "Its 429 comes from a MOCK of `enforceAiRateLimit` (`vi.mock('@/lib/rateLimit/aiGuard')`, " +
      '`enforceAiRateLimit.mockResolvedValue(new Response(null, { status: 429 }))`): the plan ' +
      'offer confirm door runs with the limiter replaced, so no request counts through the ' +
      'shared Postgres store and the production deadline never applies. (MOTIR-9295)',
  ],
]);

/**
 * Cases whose SUBJECT is the deadline, so a generous one would delete their
 * coverage. Recorded here rather than enforced, because the enforcement above is
 * per file and these are per case — a reader who tightens one of these numbers
 * needs to find out from this list that it is load-bearing.
 *
 * Both files also pin a test-time deadline for their ordinary refusals, so
 * neither appears as an offender; the pairing is the point.
 */
const DEADLINE_IS_THE_SUBJECT: ReadonlyMap<string, string> = new Map([
  [
    'tests/rateLimit/sharedStore.test.ts',
    '`a HANGING store times out and still allows the request` builds a store at ' +
      '`timeoutMs: 20` over a service call that never settles, and asserts the adapter ' +
      'rejects and the limiter fails OPEN. `a store that answers within the deadline is ' +
      'NOT treated as a failure` uses 5 s for the mirror arm. Raising the 20 ms would ' +
      'delete the fail-open coverage outright.',
  ],
  [
    'tests/api/v1/shared-store.test.ts',
    '`ALLOWS the request when the store HANGS` pins 50 ms and asserts it is BELOW ' +
      '`DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS`; the MOTIR-2658 guard case stages partial ' +
      'timeouts at a deliberately tight deadline so the atomicity assertion can be ' +
      'watched going red. Both are the deadline as subject, not as environment.',
  ],
]);

/**
 * The budget for a case that touches {@link scan}.
 *
 * ⚠️ `vitest.config.ts`'s `testTimeout` is 15 s, sized for a database test. This
 * scan reads and comment-strips ~3 000 files and runs a fixpoint over their
 * import graph — ~3 s on an idle box, and comfortably past 15 s when the runner
 * is saturated (measured here: it blew the default while seven other suites ran
 * beside it). The same shape red-lighted ONLY the coverage lane for
 * `tests/rls/callSiteScan.ts`, where the v8 provider instruments every module a
 * scan touches — a failure that reads as a broken guard rather than a slow one.
 * The scan is memoised at module scope, so exactly one case pays this.
 */
const SCAN_TIMEOUT_MS = 60_000;

describe('a refusal asserted against the shared store PINS the store deadline', () => {
  it(
    'finds the trees at all (a guard over zero files proves nothing)',
    () => {
      const { testFiles, reaching } = scan();

      expect(testFiles.length).toBeGreaterThan(100);
      expect(testFiles).toContain(HELPER);
      // The seed of the reach set is where the hazard actually lives.
      expect(reaching.has('lib/rateLimit/store.ts')).toBe(true);
      expect(reaching.has('lib/rateLimit/limiter.ts')).toBe(true);
      expect(reaching.has('lib/rateLimit/guard.ts')).toBe(true);
      expect(reaching.has('lib/api/v1/rateLimit.ts')).toBe(true);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    'derives the refusal vocabulary from lib/ (an empty vocabulary proves nothing)',
    () => {
      const { refusalErrors, refusalCode } = scan();

      expect(refusalCode).toBe('RATE_LIMITED');
      // The typed refusals the app actually throws, found rather than listed.
      expect(refusalErrors).toContain('RateLimitExceededError');
      expect(refusalErrors).toContain('PublicSubmissionRateLimitedError');
      expect(refusalErrors).toContain('InviteRateLimitedError');
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    'the predicate finds the suites that actually assert a refusal',
    () => {
      const subjects = scan().testFiles.filter(assertsRefusalAgainstSharedStore);

      // The instance MOTIR-3067 was filed for, and the two the sweep added that no
      // earlier pass had looked at.
      expect(subjects).toContain('tests/rateLimit/guard.test.ts');
      expect(subjects).toContain('tests/attachments/attachments-service.test.ts');
      expect(subjects).toContain('tests/publicProjects/publicSubmit.test.ts');
      // A suite that pins an in-process Map is NOT a subject — otherwise the
      // assertion below would cover ~40 files that have no deadline to pin.
      expect(subjects).not.toContain('tests/api/v1/rate-limit.test.ts');
      expect(subjects).not.toContain('tests/api/v1/story-gate.test.ts');
      // …and neither is a 429 that never came from our limiter.
      expect(subjects).not.toContain('tests/import/http.test.ts');
      expect(subjects).not.toContain('tests/github/pullRequestBase.test.ts');
      expect(subjects).not.toContain('tests/ciFleet/runnerJitConfig.test.ts');
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    'every such file binds the shared test-time deadline',
    () => {
      const { source } = scan();
      const offenders = scan()
        .testFiles.filter(
          (file) =>
            file !== HELPER &&
            !DEADLINE_IRRELEVANT.has(file) &&
            assertsRefusalAgainstSharedStore(file) &&
            !BINDS_HELPER.test(source.get(file)!),
        )
        .sort();

      expect(
        offenders,
        `these test files assert that a request was REFUSED while counting through the ` +
          `shared Postgres store at its PRODUCTION deadline (${'DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS'} ` +
          `= 250 ms). \`consumeSharedRateLimit\` fails OPEN when one increment outlives it, so ` +
          `on a loaded runner the call they expect to be refused is SERVED and the assertion ` +
          `goes red on a diff that touched no rate-limiting code. Call ` +
          `\`pinSharedRateLimitStoreDeadline()\` from ${HELPER} in the suite's \`beforeEach\` ` +
          `(after any \`__resetSharedRateLimitStoreForTest()\`, which drops it), or — if the ` +
          `refusal genuinely does not come from the shared store — add the file to ` +
          `DEADLINE_IRRELEVANT with the production path it DOES come from. See MOTIR-3067`,
      ).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  // ⚠️ Proven by DELIBERATELY introducing the violation, and by deliberately
  // introducing the near-misses. A guard nobody has watched fail is
  // indistinguishable from no guard — and this one detects an ABSENCE, where an
  // assertion that nothing is missing passes just as happily when it is looking
  // at nothing at all.
  it(
    'the requirement fires on a suite that asserts a refusal and binds nothing',
    () => {
      // `tests/rateLimit/guard.test.ts` as it stood before this card, in two lines.
      const violating = [
        `import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';`,
        `expect((await enforceRateLimit([limb])).response).not.toBeNull();`,
      ].join('\n');

      expect(refusalPattern().test(violating)).toBe(true);
      expect(BINDS_HELPER.test(violating)).toBe(false);
      expect(IN_PROCESS_COUNTER.test(violating)).toBe(false);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    'a COMMENT naming the helper does not count as binding it',
    () => {
      // The mutation that proves it: strip the import and every file's explanatory
      // paragraph still says `tests/helpers/rateLimitStore.ts`. This is the exact
      // trap MOTIR-3016 hit one file over.
      const mentions = [
        `// See tests/helpers/rateLimitStore.ts for why the deadline is pinned.`,
        `expect(res.status).toBe(429);`,
      ].join('\n');
      const aliased = `import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';`;
      const relativeForm = `import { pinSharedRateLimitStoreDeadline } from '../helpers/rateLimitStore';`;
      // The form `tests/api-coding-convention-route.test.ts` needs, so the module
      // is bound before its `vi.mock` factories run.
      const dynamic = `const { pinSharedRateLimitStoreDeadline } = await import('./helpers/rateLimitStore');`;

      expect(BINDS_HELPER.test(stripComments(mentions))).toBe(false);
      expect(BINDS_HELPER.test(aliased)).toBe(true);
      expect(BINDS_HELPER.test(relativeForm)).toBe(true);
      expect(BINDS_HELPER.test(dynamic)).toBe(true);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    'a COMMENT naming resetRateLimitStore() does not grant the in-process exemption',
    () => {
      // `tests/api/v1/shared-store.test.ts`'s shape exactly — it explains twice, in
      // prose and with parentheses, that it never calls `resetRateLimitStore()`.
      // Matched against the raw text that prose would have excluded the one file
      // this whole class was first found in.
      const prose = [
        `// This suite never calls resetRateLimitStore(): it drives the shipped`,
        `// wrapper in the state a real process starts in.`,
        `expect(refused.status).toBe(429);`,
      ].join('\n');

      expect(IN_PROCESS_COUNTER.test(prose)).toBe(true); // raw — the false exemption
      expect(IN_PROCESS_COUNTER.test(stripComments(prose))).toBe(false); // stripped — correct
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    'does NOT fire on a 429 that never came from our limiter',
    () => {
      // `tests/import/http.test.ts`'s shape: a mocked upstream response. It is kept
      // out by the REACH derivation rather than by an exemption, which is what
      // keeps the opt-out list short enough to stay honest.
      expect(scan().reaching.has('tests/import/http.test.ts')).toBe(false);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    'the deadline is sized inside the runner’s own timeout',
    () => {
      // If this ever exceeds `vitest.config.ts`'s `testTimeout`, a store that
      // genuinely hangs starts failing on the test timeout — which names nothing —
      // instead of on `RateLimitStoreTimeoutError`, which names the store.
      const config = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8');
      const testTimeout = Number(/testTimeout:\s*([\d_]+)/.exec(config)?.[1]?.replace(/_/g, ''));

      expect(testTimeout).toBeGreaterThan(0);
      expect(TEST_RATE_LIMIT_STORE_TIMEOUT_MS).toBeLessThan(testTimeout);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    'every opt-out names a real file and says why',
    () => {
      const { testFiles } = scan();
      for (const [file, reason] of [...DEADLINE_IRRELEVANT, ...DEADLINE_IS_THE_SUBJECT]) {
        expect(testFiles, `${file} opts out but does not exist`).toContain(file);
        expect(reason.length, `${file}'s opt-out needs a reason`).toBeGreaterThan(20);
      }
    },
    SCAN_TIMEOUT_MS,
  );

  // An opt-out that has stopped being needed is a lie the next reader inherits,
  // and the cheapest moment to notice is the one where the file stops matching.
  it(
    'every DEADLINE_IRRELEVANT entry is still a file the requirement would otherwise catch',
    () => {
      for (const file of DEADLINE_IRRELEVANT.keys()) {
        expect(
          assertsRefusalAgainstSharedStore(file),
          `${file} no longer matches the predicate — delete its opt-out rather than keeping a ` +
            `reason nobody can check`,
        ).toBe(true);
      }
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    'every DEADLINE_IS_THE_SUBJECT file also pins a test-time deadline for its other cases',
    () => {
      const { source } = scan();
      for (const file of DEADLINE_IS_THE_SUBJECT.keys()) {
        expect(BINDS_HELPER.test(source.get(file)!), `${file} should bind ${HELPER}`).toBe(true);
      }
    },
    SCAN_TIMEOUT_MS,
  );
});
