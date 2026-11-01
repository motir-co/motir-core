import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { remeasureFirst } from './remeasureFirst';
import {
  ADJUDICATED_UNBOUND_FILES,
  countByVerdict,
  preAuthKeys,
  repositoryIndex,
  scanTestCallSites,
  type TestCallSite,
} from './testCallSiteScan';

// The TEST call-site guard (MOTIR-2817) — the shared answer eleven batch cards
// read instead of each re-deriving it by eye across ~50 lines.
//
// Same division of labour as the MOTIR-2784 singleton-read guard: the machine
// enumerates and classifies, the ratchets record where the work stands, and a
// change that quietly re-opens settled ground is a red build rather than a
// reviewer's job to notice.
//
// ⚠️ WHY THE NUMBERS BELOW ARE NOT THE STORY'S. MOTIR-2797's body was written
// against a throwaway grep that reported 876 call sites — 577 in-scope, 157
// out-of-scope, 142 needs-binding-first. This classifier is that measurement's
// replacement, and MOTIR-2817's acceptance criteria say so explicitly: if the
// real numbers differ, THE CLASSIFIER WINS and the card updates the story body.
// They differ for two reasons, both expected:
//
//   • The story measured BEFORE MOTIR-2755 merged. The twenty fixture batches
//     plus MOTIR-2774 / 2777 / 2789 bound a large number of these very reads on
//     the way past, which is why `already-bound` is now the second-largest
//     population at 352. Those sites left `in-scope` by being FIXED.
//   • A grep counts lines; this counts CALLS, and it sees the ones a grep cannot
//     (a call wrapped across lines) while refusing to guess at the ones a grep
//     waves through (a method it cannot find, which lands in `unclassifiable`
//     and fails the build rather than defaulting to in-scope).
//
// The batch cards' per-directory counts are therefore also stale and are
// corrected from this run's per-directory report, not from the old table.

const FIXTURE = path.join(process.cwd(), 'tests/rls/__fixtures__/testCallSites');

/**
 * ── THE CLASS IS CLOSED (MOTIR-2829) ──────────────────────────────────────
 *
 * There is no in-scope ratchet any more. While MOTIR-2797 was running, a
 * ceiling tracked how many unbound test call sites remained and a test kept it
 * from rising; that is the right instrument mid-migration. It reached zero, and
 * a number that CAN be edited is a weaker statement than an assertion that the
 * set is empty. So the constant is gone and the assertion below is absolute.
 *
 * The path it took, kept because the arithmetic is the audit trail:
 *   458 measured → 375 after the adjudication sweep → 336 → 283 → 243 → 194
 *   → 152 → 105 → 25 → 0, each step a batch subtracting what it fixed.
 *
 * ── FIVE THINGS THE NEXT AUTHOR SHOULD INHERIT, not re-derive ─────────────
 *
 * 1. THE `db.` PREFIX BLIND SPOT. A sweep keyed on the CLIENT's name cannot see
 *    a call that reaches the client through a named wrapper. That is why this
 *    class survived twenty fixture batches: `workItemRepository.countByStatus(…)`
 *    carries no `db.` anywhere on the line.
 *
 * 2. THE VACUOUS PASS. An assertion of `0` / `null` / `[]` passes when the
 *    policy hid everything. It does not go red; it goes quietly meaningless.
 *    "The suite is green" was never sufficient evidence on this story, and the
 *    only proof a binding did something is that reverting it goes RED.
 *
 * 3. MULTI-LINE SIGNATURES. A single-line regex read `countBacklog` as
 *    unbindable because its `tx?` sits on its own line, inflating the first
 *    measurement by ~60 sites. Hence an AST walk, and hence the test pinning
 *    that exact method at txIndex 4.
 *
 * 4. A MEASUREMENT DECAYS. The original count fell 577 → 458 with no work done,
 *    because a sibling story bound many of these reads while the plan sat still.
 *    A number in a card is a claim about a moving world; the scanner is the only
 *    current answer. (MOTIR-2844.)
 *
 * 5. A SCANNER'S OWN BLIND SPOT IS REPORTED AS A CLEAN VERDICT, NOT AS AN ERROR
 *    (MOTIR-2911). `addressedModels` matched a model only when the client was a
 *    bare identifier, so the inline `(tx ?? db).workItem.findMany` that nearly
 *    every BINDABLE method is written in addressed nothing it could see. The
 *    consequence was not "unknown" — it was `gated: false`, which surfaces as
 *    `not-gated`: a POSITIVE verdict meaning "no policy applies, leave it
 *    alone". Eleven methods carried it and 24 of their call sites were filed as
 *    correct-unbound while this file asserted the class was empty. Two rules
 *    follow. First, a fixture only proves the classifier against the shapes its
 *    author thought of — `fixtureRepository` hoisted `const client = tx ?? db`
 *    in every case, a form the real repositories mostly do not use, so the
 *    fixture agreed with the bug. Second, when a verdict says a table is
 *    ungated, check the MIGRATIONS rather than the parse: `policyGatedModels`
 *    knew `work_item_link` was gated the whole time; nothing ever asked it.
 *
 * ── WHAT THIS GUARD DOES NOT READ ────────────────────────────────────────
 *
 * `tests/` only. Its sibling `singleton-read-guard.test.ts` reads
 * `lib/repositories/`. NEITHER reads `app/` or `scripts/`. Saying so is the
 * sentence whose absence on the earlier scanner let this whole class stay
 * invisible — do not delete it.
 */

/**
 * The do-not-touch ratchet, and the load-bearing half of this file.
 *
 * `not-gated` and `pre-auth` sites are CORRECT unbound: no policy applies to the
 * first, and the second was adjudicated deliberately actorless by MOTIR-2784 —
 * "fixing" one contradicts a recorded decision and is indistinguishable from
 * real work in a diff. This counts the out-of-scope sites that pass no `tx`, so
 * a batch that helpfully binds one fails the build instead of passing review.
 *
 * ⚠️ THIS ONE SURVIVES, and does NOT become zero. The two ratchets measure
 * opposite things: the in-scope assertion above is now absolute because that
 * work is FINISHED, while this floor guards work that must never be done at
 * all. A card that zeroed the first and dropped the second would leave the
 * suite less safe than it found it — the risk it covers is the inverse one, a
 * future tidy-up "fixing" a line that was never broken.
 *
 * ⚠️ It may only ever go UP or stay — EXCEPT when the set itself shrinks for a
 * reason that is not "somebody bound one", which is the third cause the original
 * wording did not anticipate.
 *
 * 149 -> 73 (MOTIR-2815/2830): `policyGatedModels` used to decide "is this table
 * under RLS?" from a `workspaceId` FIELD on the Prisma model, and 18 of the 69
 * RLS-protected tables carry no such column — they are gated through a join. It
 * now reads the POLICIES out of the migrations, so 76 sites that were classified
 * `not-gated` are `in-scope` instead: their tables were gated all along and the
 * detector could not see it. NOT ONE of those lines was edited to make the number
 * move; they were re-adjudicated, and then bound as part of the same card.
 *
 * It is NOT the count of out-of-scope sites (79) — 6 of those legitimately pass a
 * `tx` already, because a write method requires one whether or not its model is
 * gated. The verdict alone cannot catch that: a `not-gated` call handed a `tx` is
 * still `not-gated`, which is why the scanner records `bound` separately.
 *
 * 73 -> 49 (MOTIR-2911): the SAME cause as the 149 -> 73 step above, one layer
 * further in. `addressedModels` decided which models a repository method touches
 * by requiring the head of the property access to be a bare identifier, so it saw
 * `db.workItem.findMany` and `client.widget.findMany` but not the INLINE
 * `(tx ?? db).workItem.findMany` — which is how eleven methods across
 * `workItemLinkRepository`, `workItemRepository` and `automationRuleRepository`
 * are written, and is precisely the form that makes a method BINDABLE. Those
 * methods addressed no visible model, came out `gated: false`, and their 24 call
 * sites were classified `not-gated`. Sixteen of them were unbound and counted
 * toward this floor while being, in fact, the story's own work. Five were live
 * reads that answered `[]` under `motir_app` (four in
 * `tests/mcp/dependency-edges.test.ts`, three in
 * `tests/integration/work-items/provenance-backfill-gate.test.ts`, one in the
 * `tests/e2e/_helpers/ai-cadence-seed.ts` helper); the rest were empty-input
 * short-circuits and vacuous `toBeNull()` assertions. As in the earlier step, not
 * one line moved to make this number move — they were re-adjudicated by a
 * corrected detector and then bound.
 */
const UNTOUCHED_OUT_OF_SCOPE_FLOOR = 49;

const outOfScope = (s: TestCallSite): boolean =>
  s.verdict === 'not-gated' || s.verdict === 'pre-auth';

describe('the test call-site classifier rules on every shape', () => {
  it('classifies all five verdicts on a fixture built to contain one of each', () => {
    const { sites } = scanTestCallSites(FIXTURE);
    const seen = sites.map((s) => `${s.method}:${s.verdict}`).sort();

    expect(seen).toEqual(
      [
        'countAllUnsafe:pre-auth',
        'findGlobalSettings:not-gated',
        'findGlobalSettingsBindable:not-gated',
        'findGlobalSettingsBindable:not-gated',
        'findWidgets:already-bound',
        'findWidgets:in-scope',
        'findWidgets:in-scope',
        'findWidgetsInlineFallback:already-bound',
        'findWidgetsInlineFallback:in-scope',
        'findWidgetsUnbindable:needs-binding-first',
        'findWidgetsWrapped:already-bound',
        'findWidgetsWrapped:in-scope',
        'rawWidgetCount:in-scope',
      ].sort(),
    );
    expect(countByVerdict(sites)).toEqual({
      'in-scope': 5,
      'not-gated': 3,
      'pre-auth': 1,
      'needs-binding-first': 1,
      'already-bound': 3,
      'adjudicated-unbound': 0,
    });
  });

  it('sees a model addressed through the INLINE `(tx ?? db)` fallback', () => {
    // The blind spot MOTIR-2911 found, pinned as its own case because the count
    // assertion above would go on passing if a future edit re-narrowed the head
    // test and the fixture method happened to leave the population by another
    // route. `findWidgetsInlineFallback` addresses `widget` — a gated model —
    // ONLY through `(tx ?? db).widget`, so it is `gated` exactly when the
    // classifier unwraps the fallback expression.
    //
    // What made this expensive is that the wrong answer is the REASSURING one:
    // an undetected model yields `gated: false`, which the scanner reports as
    // `not-gated` — a positive verdict meaning "no policy applies, leave it" —
    // rather than as an error. Eleven real repository methods carried it, and
    // the class the guard below calls CLOSED contained sixteen unbound reads.
    const inline = repositoryIndex(FIXTURE).get('fixtureRepository.findWidgetsInlineFallback');
    expect(inline?.gated).toBe(true);
    expect(inline?.txIndex).toBe(1);

    // And the two-step form it is the counterpart of still works, so the fix is
    // additive rather than a replacement of one narrow rule with another.
    expect(repositoryIndex(FIXTURE).get('fixtureRepository.findWidgets')?.gated).toBe(true);
  });

  it('DETECTS an out-of-scope call site that has been given a `tx`', () => {
    // The load-bearing case, proven on the fixture rather than only pinned as a
    // count over the real suite. The fixture calls `findGlobalSettingsBindable`
    // twice — once unbound (correct) and once bound (the violation a batch would
    // introduce by "helpfully" fixing a leave-alone site).
    //
    // Both calls keep the verdict `not-gated`, which is exactly why the verdict
    // cannot be the signal: only `bound` separates them. If this ever stops
    // distinguishing the two, the floor assertion over the real suite silently
    // stops protecting anything, because every count would still add up.
    const { sites } = scanTestCallSites(FIXTURE);
    const both = sites.filter((s) => s.method === 'findGlobalSettingsBindable');

    expect(both.map((s) => s.verdict)).toEqual(['not-gated', 'not-gated']);
    expect(both.map((s) => s.bound).sort()).toEqual([false, true]);

    // And the metric the real-suite floor is computed from moves by exactly one.
    // Three, not two: `outOfScope` spans `not-gated` AND `pre-auth`, so the
    // unbound `countAllUnsafe` counts alongside the two `globalSetting` reads.
    const untouched = sites.filter((s) => outOfScope(s) && !s.bound);
    expect(untouched.map((s) => s.method).sort()).toEqual([
      'countAllUnsafe',
      'findGlobalSettings',
      'findGlobalSettingsBindable',
    ]);
  });

  it('a shape it cannot rule on fails LOUDLY instead of defaulting to in-scope', () => {
    const { unclassifiable } = scanTestCallSites(FIXTURE);

    // The fixture calls `ghostRepository.vanished`, which no repository defines.
    // Defaulting it to `in-scope` would send a batch to bind something that does
    // not exist; dropping it silently would hide a renamed method from every
    // future sweep. It must surface.
    expect(unclassifiable).toHaveLength(1);
    expect(unclassifiable[0]?.callee).toBe('ghostRepository.vanished');
  });

  it('an ADJUDICATED pre-auth verdict beats the shape', () => {
    const { sites } = scanTestCallSites(FIXTURE);
    const preAuth = sites.filter((s) => s.verdict === 'pre-auth');

    // `countAllUnsafe` is gated and bindable and passes no `tx` — by shape alone
    // it is indistinguishable from in-scope work. Only the guard's VERDICTS map
    // says otherwise, and that adjudication has to win.
    expect(preAuth.map((s) => s.method)).toEqual(['countAllUnsafe']);
    expect([...preAuthKeys(FIXTURE)]).toEqual(['fixtureRepository.ts#countAllUnsafe']);
  });

  it('reads a MULTI-LINE `tx?` signature — the regression that cost ~60 sites', () => {
    // A single-line regex reports `countBacklog` as unbindable because its `tx?`
    // sits on its own line, which moved ~60 sites into `needs-binding-first` and
    // inflated the first measurement of this story. Pinned as the specific
    // method, not as a general claim, because that is what actually regressed.
    const backlog = repositoryIndex().get('workItemRepository.countBacklog');
    expect(backlog).toBeDefined();
    expect(backlog?.txIndex).toBe(4);

    const wrapped = repositoryIndex(FIXTURE).get('fixtureRepository.findWidgetsWrapped');
    expect(wrapped?.txIndex).toBe(2);
  });

  it('an explicit `undefined` in the tx slot binds NOTHING', () => {
    const { sites } = scanTestCallSites(FIXTURE);
    const explicitUndefined = sites.filter((s) => s.method === 'findWidgets');

    // `findWidgets(ws, undefined)` type-checks and looks bound at a glance. Two
    // of the three calls are unbound, and both must be offered to a batch.
    expect(explicitUndefined.filter((s) => s.verdict === 'in-scope')).toHaveLength(2);
    expect(explicitUndefined.filter((s) => s.bound)).toHaveLength(1);
  });
});

describe('the ratchets over the real test suite', () => {
  // ⚠️ Scan ONCE and share it. `scanTestCallSites()` parses every `.ts` under
  // `tests/` plus all of `lib/repositories/` — ~1.3 s locally. Calling it per
  // test cost 4× that, which fits comfortably in the 15 s default on a quiet
  // machine and does NOT on a CI runner with three vitest shards competing for
  // the box: every test in this block timed out on the first parent PR while
  // passing locally. The scan is pure and the files do not change mid-run, so
  // one call is not just faster, it is the honest shape.
  let scan: ReturnType<typeof scanTestCallSites>;
  beforeAll(() => {
    scan = scanTestCallSites();
  }, 60_000);
  it('NO test call site reads a gated table unbound — the class is closed', () => {
    const inScope = scan.sites.filter((s) => s.verdict === 'in-scope');

    expect(
      inScope.map((s) => `${s.key} ${s.repository}.${s.method}`),
      `A test call site reads a policy-gated table with no bound \`tx\`.\n\n` +
        `Under \`motir_app\` that read returns an EMPTY result and RAISES NOTHING. ` +
        `If your assertion expects rows it will fail confusingly; if it expects ` +
        `emptiness it will PASS while checking nothing, which is worse.\n\n` +
        `Wrap it: withWorkspaceServiceContext(wsId, (tx) => repo.method(…, tx)).\n` +
        `Bind the workspace the ASSERTION is about — for a cross-workspace gate ` +
        `test that is the OWN workspace, not the foreign one being read, or the ` +
        `policy hides the row too and the gate stops being tested.\n\n` +
        `If the read is correct unbound, it belongs in a verdict, not here: ` +
        `\`not-gated\`, \`pre-auth\` (singleton-read-guard's VERDICTS), or ` +
        `ADJUDICATED_UNBOUND_FILES with the card that decided it. Do NOT ` +
        `re-introduce a ceiling.`,
    ).toEqual([]);
  });

  it('no out-of-scope call site has been given a `tx`', () => {
    const untouched = scan.sites.filter((s) => outOfScope(s) && !s.bound);

    expect(
      untouched.length,
      remeasureFirst('UNTOUCHED_OUT_OF_SCOPE_FLOOR') +
        `${UNTOUCHED_OUT_OF_SCOPE_FLOOR - untouched.length} out-of-scope call site(s) ` +
        `acquired a \`tx\` or were deleted.\n` +
        `\`not-gated\` and \`pre-auth\` sites are CORRECT unbound — no policy applies ` +
        `to the first, and the second is an adjudicated actorless read ` +
        `(MOTIR-2784). Binding one contradicts a recorded decision, and it looks ` +
        `exactly like real work in the diff, which is why it is a build failure ` +
        `rather than a review note.\n` +
        `Run the classifier and compare against your batch's target directories.`,
    ).toBeGreaterThanOrEqual(UNTOUCHED_OUT_OF_SCOPE_FLOOR);
  });

  it('every call site in the suite is classifiable', () => {
    const { unclassifiable } = scan;

    expect(
      unclassifiable,
      `these test call sites name a repository method the classifier cannot find, ` +
        `usually because the method was renamed or removed:\n` +
        unclassifiable.map((u) => `  ${u.file}:${u.line} ${u.callee}`).join('\n'),
    ).toEqual([]);
  });

  it('the file-level adjudication is exactly what a human put there', () => {
    // `adjudicated-unbound` is the one verdict a parser cannot derive: the call
    // site looks exactly like in-scope work and only the FILE's subject says
    // otherwise. So the set is pinned, and a new entry fails here until somebody
    // adds it on purpose — an entry silently converts real work into "leave it".
    expect(Object.keys(ADJUDICATED_UNBOUND_FILES).sort()).toEqual([
      'tests/app-role-bound-context-reads.test.ts',
      'tests/comments/repositories.test.ts',
      'tests/custom-fields/repositories.test.ts',
      'tests/environmentConfig/storyIntegration.test.ts',
      'tests/integration/sprints/repository.test.ts',
      'tests/integration/translation/autoTranslateStory.test.ts',
      'tests/labels-components-watch/repositories.test.ts',
      'tests/mcp/comment-counts.test.ts',
      'tests/notifications/repositories.test.ts',
      'tests/project-details-service.test.ts',
      'tests/rls/tx-fallback-arm.test.ts',
    ]);
    for (const [file, reason] of Object.entries(ADJUDICATED_UNBOUND_FILES)) {
      expect(existsSync(path.join(process.cwd(), file)), `${file} does not exist`).toBe(true);
      expect(reason, `${file}'s adjudication must cite the card that decided it`).toMatch(
        /MOTIR-\d+/,
      );
    }

    const adjudicated = scan.sites.filter((s) => s.verdict === 'adjudicated-unbound');
    expect(adjudicated.length).toBeGreaterThan(0);
    // A write in an adjudicated file still requires its `tx` and still reads as
    // bound: the decision is "do not bind these READS", not "this file is exempt".
    expect(adjudicated.every((s) => !s.bound)).toBe(true);
  });

  it('the pre-auth adjudication is actually being read', () => {
    // `preAuthKeys` parses the MOTIR-2784 guard's VERDICTS map by NAME. A rename
    // there would make it return an empty set — silently re-opening the settled
    // sites as in-scope work. This is the tripwire for that.
    expect([...preAuthKeys()].sort()).toEqual([
      'databaseConnectionRepository.ts#ping',
      'rateLimitCounterRepository.ts#countAllUnsafe',
      'rateLimitCounterRepository.ts#findCountUnsafe',
    ]);
  });
});
