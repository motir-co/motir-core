import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PLAN_ITEM_PATCH_KEYS, type PlanItemPatchKey } from '@/lib/dto/plans';
import {
  PLAN_ITEM_CHANGE_FIELDS,
  PLAN_ITEM_SETTABLE_RAIL_FIELDS,
  type PlanItemChangeField,
} from '@/lib/dto/planReview';

// The PARITY GUARD (MOTIR-3084 / bug MOTIR-3070).
//
// ── What went wrong, and why a test rather than four fields ─────────────────
// `PlanReviewItemDto` is the model the plan-review surface renders. It is a
// projection built for a COMPACT CANVAS NODE, and it was used as the whole
// review model — so every proposed value the node does not draw was simply
// absent from the surface a person approves on. `explanationMd` was the
// sharpest: carried on the proposal, diffed, written onto the created work item
// by `materialize`, and read by NOTHING in the review surface. The reviewer
// approved a second content body they were never shown.
//
// Adding the missing fields fixes today's instance. It does not stop the next
// one, and there WAS a next one already: `planningProvenance` was added to
// `PlanItemProposedFields` and not to the review model while the card to fix
// this sat in the backlog, and nothing went red. So the durable half of the fix
// is this test.
//
// ── HOW IT FAILS (the mechanism, stated because a weaker one would not) ─────
// A hand-written list of field names would pass forever — it only ever compares
// itself. This test derives BOTH sides from the source of truth: it parses the
// two interface declarations out of the `.ts` files and compares the key SETS.
// Add a field to `PlanItemProposedFields` alone and this goes red on the next
// run, naming the field, with no list to remember to update.
//
// Reading the source text is deliberate. A type-level check
// (`Exclude<keyof A, keyof B> extends never`) is compile-time and would be
// silenced by the same `tsc` run that the missing field type-checks fine under;
// a runtime shape comparison needs an instance of each, and a DTO has no
// runtime presence at all. The declarations are the only place both sets exist
// side by side.

const ROOT = resolve(__dirname, '../..');

/** The property names declared directly in one interface body. */
function interfaceKeys(file: string, name: string): Set<string> {
  const src = readFileSync(resolve(ROOT, file), 'utf8');
  const start = src.indexOf(`export interface ${name} {`);
  if (start === -1) throw new Error(`${name} not found in ${file}`);

  // Walk the braces so a nested object type (e.g. `planningProvenance`) is
  // consumed whole rather than leaking its members into the key set.
  let depth = 0;
  let i = src.indexOf('{', start);
  const bodyStart = i + 1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = src.slice(bodyStart, i);

  const keys = new Set<string>();
  let nest = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    // Only depth-0 declarations are this interface's own keys.
    if (nest === 0) {
      const m = /^([a-zA-Z_][\w]*)\??:/.exec(line);
      if (m) keys.add(m[1]!);
    }
    nest += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  return keys;
}

/**
 * Proposed fields whose REVIEW half is a named sibling card of the SAME story,
 * still open — each with the card that owes it. EMPTY today: MOTIR-6133's
 * `difficulty` entry was fulfilled and deleted by MOTIR-6137, which carries it
 * on `PlanReviewItemDto`. Kept (rather than deleted) because a story that splits
 * a carrier from its review renderer again needs exactly this ratchet.
 *
 * ⚠️ NOT A RELAXATION THAT CAN OUTLIVE ITS CARD: the `still OWED` test below
 * FAILS as soon as the review model carries a key listed here, so the card that
 * adds it must delete its entry in the same change.
 */
const REVIEW_HALF_OWED_BY: Readonly<Record<string, string>> = {};

/**
 * Proposed fields that are NOT a field of the card at all, so no reviewer decides
 * on them and no op disposition applies — each with the reason. Not a ratchet:
 * a key belongs here only when it is metadata ABOUT other fields.
 */
const NOT_A_CARD_FIELD: Readonly<Record<string, string>> = {
  languages:
    'MOTIR-8743 — the language each text field was WRITTEN in, a statement ABOUT the ' +
    'title / bodies / steps beside it. Approve records it on their language columns; the ' +
    'story adds no review surface for it (it detects and translates nothing).',
  authorFinished:
    'MOTIR-10490 — whether an AUTHOR SESSION finished writing the card: planner state ' +
    'ABOUT the card, set by a driver or by the hand-written stamp. Approve carries nothing ' +
    'of it to the work item, so there is nothing for a reviewer to decide on. The review ' +
    'model reports it read-only as the written state (MOTIR-10496), add-only, for the run ' +
    'context and the plan surface — still not a field anyone decides.',
};

describe('PlanReviewItemDto ⟷ PlanItemProposedFields parity', () => {
  const proposed = interfaceKeys('lib/dto/plans.ts', 'PlanItemProposedFields');
  const review = interfaceKeys('lib/dto/planReview.ts', 'PlanReviewItemDto');

  // `title` and `kind` ARE carried — under the same names — so they need no
  // exception. Nothing else on the proposal is deliberately withheld from the
  // reviewer, which is the whole point: if a field is worth materializing onto
  // the created work item, it is worth showing before it is created.
  it('every proposed field a reviewer decides on is carried by the review model', () => {
    const missing = [...proposed].filter(
      (k) => !review.has(k) && !(k in REVIEW_HALF_OWED_BY) && !(k in NOT_A_CARD_FIELD),
    );
    expect({ missing }).toEqual({ missing: [] });
  });

  it('an owed review half is still OWED — delete its entry once the review model carries it', () => {
    const fulfilled = Object.keys(REVIEW_HALF_OWED_BY).filter((k) => review.has(k));
    const stale = Object.keys(REVIEW_HALF_OWED_BY).filter((k) => !proposed.has(k));
    expect({ fulfilled, stale }).toEqual({ fulfilled: [], stale: [] });
  });

  it('parses BOTH declarations — a guard that read nothing would pass vacuously', () => {
    // Without this, a rename that made either lookup return an empty set would
    // turn the assertion above into a tautology.
    expect(proposed.size).toBeGreaterThan(8);
    expect(review.size).toBeGreaterThan(8);
    expect(proposed.has('explanationMd')).toBe(true);
    expect(review.has('explanationMd')).toBe(true);
  });

  it('would have caught `planningProvenance` — the field that was already missed', () => {
    // The real regression this test is built from: it reached the proposal and
    // not the review model, silently. Both sides must carry it now, and the
    // first assertion is what would have gone red at the time.
    expect(proposed.has('planningProvenance')).toBe(true);
    expect(review.has('planningProvenance')).toBe(true);
  });

  it('ignores the members of a NESTED object type', () => {
    // `planningProvenance: { source?, harness?, model? }` must contribute one
    // key, not four — otherwise the guard demands `source` on the review model
    // and fails for the wrong reason.
    expect(proposed.has('source')).toBe(false);
    expect(proposed.has('harness')).toBe(false);
  });
});

// ── The OP-AXIS guard (bug MOTIR-4134) ───────────────────────────────────────
//
// The parity guard above holds the review model against WHICH FIELDS an `add`
// proposes. It is total over the field list and has no opinion about the second
// axis every one of those fields also has: for WHICH OPS is it populated? That
// blind spot is not incidental — it is the reason MOTIR-4134 shipped.
//
// ── What went wrong ─────────────────────────────────────────────────────────
// `descriptionMd` and `explanationMd` were `item.op === 'add' ? proposed : null`,
// and `lib/dto/planReview.ts` documented it as intended. That was COHERENT while
// the DTO fed only the canvas node and the list row, which spell a change
// through `changes[]` and never read the flat bodies. It stopped being coherent
// when MOTIR-4022 made a list row a door onto `ProposalQuickView`, which renders
// the flat bodies INLINE and has no diff rendering at all: a `modify` — the
// whole of the re-plan path — opened as `New` / `not yet created` / "No
// description yet." / "No explanation yet.", four false statements on the one
// surface whose purpose is to be read before somebody presses Approve.
//
// ── Why THIS guard, and not the two above ───────────────────────────────────
// The parity guard passed throughout: both fields were PRESENT on the review
// model, carrying null. The change-row guard passed too: `buildChanges` emitted
// correct description and explanation rows the whole time. Nothing was missing
// and nothing was wrong — the defect lived in the COMPOSITION of a producer that
// was right about its own contract and a consumer that was right about its own
// design, which is the shape nothing in the suite was standing in a position to
// see. So the ratchet this adds is the same one `DISPOSITION` below adds for
// patch keys: the answer for a field may legitimately be "add only", but it has
// to be WRITTEN DOWN rather than defaulted into by whoever types the ternary.
describe('PlanReviewItemDto op axis ⟷ planReviewService', () => {
  const proposed = interfaceKeys('lib/dto/plans.ts', 'PlanItemProposedFields');
  const service = readFileSync(resolve(ROOT, 'lib/services/planReviewService.ts'), 'utf8');

  /**
   * The shape the defect is made of, matched literally:
   *
   *     priority: item.op === 'add' ? (proposed?.priority ?? null) : null,
   *
   * — a field whose value for every op but `add` is `null`, regardless of what
   * the proposal or its target actually says. A field NOT written this way is
   * populated on more than one op; the guard does not care how.
   */
  const addOnlyElseNull = (key: string) =>
    new RegExp(`\\n\\s*${key}: item\\.op === 'add' \\? [^\\n]*: null,`);

  /**
   * Per proposed field: is it `add`-only, or does it reach every op — and WHY.
   * The reason is the deliverable; the boolean is just what the guard can check.
   */
  type OpDisposition = { addOnly: string } | { everyOp: string };
  const OP_AXIS: Record<string, OpDisposition> = {
    title: {
      everyOp:
        'MOTIR-4018 — the title the proposal is ASKING for, so a plan renaming a card ' +
        'stops drawing it under the name it is about to stop being called.',
    },
    kind: {
      everyOp: "a modify / remove reports its TARGET's kind; the icon must draw something.",
    },
    descriptionMd: {
      everyOp:
        'MOTIR-4134 — the quick view renders this body INLINE and a modify is the whole ' +
        'of the re-plan path.',
    },
    explanationMd: {
      everyOp: 'MOTIR-4134 — the same, and the body MOTIR-3070 was filed about.',
    },
    explanationSource: {
      addOnly:
        'PlanItemPatch has NO explanationSource twin, on purpose — that column is not the ' +
        "caller's to set, so a patch that could write it would let a plan forge provenance, " +
        'and applyModify leaves the target value alone. Reporting the TARGET source beside a ' +
        'REWRITTEN explanation would attribute the new text to whoever wrote the old.',
    },
    // ── The DECISION fields — FLIPPED TO EVERY-OP by bug MOTIR-4143, and the
    // argument they were add-only under is kept because it was a good one and
    // it is exactly half right.
    //
    // It read: every one of these is a RAIL row, the rail has no old→new
    // affordance, so on a `modify` it would render the target's live value
    // indistinguishably from a proposed one — while a change to any of them IS
    // shown to the approver, in the `changes` diff, the surface built to show
    // two sides at once.
    //
    // That is true of the LIST ROW, which renders the diff. It is false of
    // `ProposalQuickView`, which renders no diff at all and is the ONLY surface
    // these fields reach. So the premise "a change is visible elsewhere" held
    // for the surface nobody was complaining about, and the surface a person
    // approves from showed a `modify`'s whole rail as one Parent row — every
    // other field null, the rail's own `hasRail` collapsing with them. Reported
    // from the running app: *"the fields are not displaying. I only see parent
    // on the right side."*
    //
    // The rail now answers what the card WILL BE, which is the sentence `title`
    // and both bodies already carry on this DTO. The cost the old reason names
    // is real and accepted: a rail row does not say whether its value is
    // proposed or unchanged. Showing the value is strictly more than showing
    // nothing, and the diff still spells the change one surface over.
    priority: {
      everyOp:
        'MOTIR-4143 — a rail row on the one surface with no diff; a modify reports its patch, ' +
        'else the target it will keep (7.21.6 / MOTIR-1370 gave the diff, not the rail).',
    },
    type: {
      everyOp: 'MOTIR-4143 — a rail row, patch-or-target, as priority is and for the same reason.',
    },
    storyPoints: {
      everyOp:
        'MOTIR-4143 — a re-scope is the most consequential thing a re-plan does to a card, and ' +
        'the rail was the only place the quick view could have said so.',
    },
    estimateMinutes: {
      everyOp: 'MOTIR-4143 — the other half of the sizing pair, and the same answer.',
    },
    difficulty: {
      everyOp:
        'MOTIR-6137 (ADR agent-authored-plans AMENDMENT 19 §4) — the sizing group’s third ' +
        'member, patch-or-target like storyPoints: the peek’s rail reads the value approve ' +
        'will WRITE, and a modify’s patch can set, change or clear it.',
    },
    targetRepo: {
      everyOp:
        'MOTIR-4143 — the pin routes dispatch; MOTIR-3868 made a re-pin visible in the diff, ' +
        'and this makes the resulting value visible where it is read.',
    },
    targetRepos: {
      everyOp:
        "MOTIR-4904 — the SET beside `targetRepo`'s primary, and the same answer for the same " +
        'reason: the quick view has no diff, so the rail answers what the card WILL BE. A ' +
        'two-repository card whose second repository were invisible here would be approved by ' +
        'somebody who could not have known it shipped in two.',
    },
    targetRepositories: {
      addOnly:
        'MOTIR-4904 — these are `project_repository` ROW IDS: an AUTHORING form, not a value a ' +
        'reviewer reads, and the names they resolve to are exactly what `targetRepos` already ' +
        "carries on every op. Reporting a committed card's rows here would put cuids on a rail " +
        'beside the same repositories spelled as names, one row up.',
    },
    targetRepositoryRef: {
      addOnly:
        'MOTIR-4924 — the singular ROW-ID pin, and it is `add`-ONLY for exactly the reason ' +
        '`targetRepositories` is: a cuid is an authoring form, not a value a reviewer reads, and ' +
        'the repository it names is what `targetRepo` / `targetRepos` carry once resolved. A ' +
        '`modify` that re-pins by ref shows in the DIFF (`buildChanges`, under `targetRepo`), so ' +
        'the rail need not repeat it.',
    },
    targetRepoRole: {
      everyOp:
        'MOTIR-4143 — patch-only in practice: `work_item.targetRepoRole` is RETIRED, so the ' +
        'target side is empty and a modify reports the role only when its own patch names one.',
    },
    executor: {
      everyOp:
        'MOTIR-4143 — and it has NO patch key, so a modify has no proposed side of its own. ' +
        "The rail reads what the card WILL have: the target's live value, or — when the patch " +
        're-types a target with none — the default the approve seeds (MOTIR-6259).',
    },
    todos: {
      addOnly:
        'AMENDMENT 27 (MOTIR-8668, overturning AMENDMENT 14 D2) — a `modify` patch MAY carry ' +
        '`todos` now, and it REPLACES the list, so the review shows it as a `todos` CHANGE row ' +
        '(`buildChanges`: the live count with its ticked count → the new steps). The peek field ' +
        'stays `add`-only all the same: the target side must NOT be substituted for it the way ' +
        "the MOTIR-4143 rail fields substitute theirs, because a committed card's list is a " +
        "person's PROGRESS — ticked rows — and reporting it here would show work somebody " +
        'already did on the surface that says what approve will WRITE.',
    },
    planningProvenance: {
      addOnly:
        'WHO WROTE THE PROPOSAL, not a field of the card — a modify proposes no provenance ' +
        'of its own, and the plan already records its own harness and model.',
    },
    subject: {
      addOnly:
        'MOTIR-5065 — WHICH RULE PACKS THE PASS READ, not a field of the card. It joins this ' +
        "arm on `planningProvenance`'s terms rather than a new one: `PlanItemPatch` has no " +
        "`subject` twin, so a `modify` proposes none, and reporting the TARGET's would credit " +
        "this pass with a coordinate an earlier pass derived — `explanationSource`'s failure " +
        'mode, one field over.',
    },
    initRepositoryName: {
      addOnly:
        'MOTIR-11051 — the repository an INIT card will create, settled at the append. ' +
        '`PlanItemPatch` has no twin (nothing may re-declare a repository on an existing card), ' +
        "so a `modify` declares none, and reporting the TARGET's would show a declaration this " +
        'proposal never made.',
    },
  };

  it('states an op disposition for EVERY proposed field', () => {
    // Total in both directions, so a field added to `PlanItemProposedFields`
    // cannot reach the review model without somebody answering this question —
    // and a disposition for a field that no longer exists cannot linger.
    const undispositioned = [...proposed].filter(
      (k) => !(k in OP_AXIS) && !(k in REVIEW_HALF_OWED_BY) && !(k in NOT_A_CARD_FIELD),
    );
    const stale = Object.keys(OP_AXIS).filter((k) => !proposed.has(k));
    expect({ undispositioned, stale }).toEqual({ undispositioned: [], stale: [] });
  });

  it('every field matches the disposition it declares, in the service source', () => {
    const wrong = Object.entries(OP_AXIS)
      .map(([key, d]) => {
        const isAddOnly = addOnlyElseNull(key).test(service);
        if ('addOnly' in d && !isAddOnly) return `${key}: declared add-only, reaches every op`;
        if ('everyOp' in d && isAddOnly) return `${key}: declared every-op, is add-only`;
        return null;
      })
      .filter((x): x is string => x !== null);
    expect({ wrong }).toEqual({ wrong: [] });
  });

  it('every disposition carries a REASON — the deliverable is the answer, not the flag', () => {
    const unexplained = Object.entries(OP_AXIS).filter(
      ([, d]) => ('addOnly' in d ? d.addOnly : d.everyOp).trim().length < 20,
    );
    expect(unexplained.map(([k]) => k)).toEqual([]);
  });

  it('the PATTERN it matches is real — a guard that matched nothing would pass vacuously', () => {
    // Both arms must be non-empty, or the assertion above is a tautology in one
    // direction: if the regex matched nothing the every-op fields would all pass
    // for the wrong reason, and if it matched everything the add-only ones would.
    const addOnly = Object.keys(OP_AXIS).filter((k) => addOnlyElseNull(k).test(service));
    const everyOp = Object.keys(OP_AXIS).filter((k) => !addOnlyElseNull(k).test(service));
    // ⚠️ THE ADD-ONLY ARM WAS DOWN TO TWO (MOTIR-4143 moved the six rail fields
    // across), and a COUNT would now be a threshold nobody could defend. So it
    // is asserted by NAME: each is add-only for a reason stated at its own
    // field, and if a later change empties this arm the vacuity guard above it
    // stops being real — which is the thing this case exists to notice.
    //
    // `todos` is the THIRD (MOTIR-4622), and it joins for a reason unlike the
    // other two: not provenance, but that a `modify` has no proposed side AND
    // its target's side is a person's PROGRESS, which must not be drawn on the
    // surface that says what approve will write.
    // `targetRepositories` is the FOURTH (MOTIR-4904), and it joins for a reason
    // unlike any of the other three: not provenance and not progress, but that it
    // is a second SPELLING of a value this DTO already reports as names one field
    // up — so on a `modify` there is nothing for it to say that `targetRepos` is
    // not already saying better.
    // `subject` is the FIFTH (MOTIR-5065), and it is the only one that joins an
    // existing reason rather than bringing its own: it is provenance, exactly as
    // `planningProvenance` is — a record of what the PASS read, not of what the
    // card IS. That the arm now has two provenance members is the point; the
    // three others are each here for a different reason, stated at their fields.
    expect(addOnly.sort()).toEqual([
      'explanationSource',
      'initRepositoryName',
      'planningProvenance',
      'subject',
      'targetRepositories',
      'targetRepositoryRef',
      'todos',
    ]);
    expect(everyOp.length).toBeGreaterThan(2);
    // And it reads the file it thinks it does.
    expect(service).toContain('function proposedBody(');
    expect(service).toContain('function proposedValue');
  });

  it('would have caught the two bodies that shipped null for a modify', () => {
    // The regression this guard is built from, asserted as itself: before the fix
    // both matched the add-only shape while the quick view rendered them inline.
    expect(addOnlyElseNull('descriptionMd').test(service)).toBe(false);
    expect(addOnlyElseNull('explanationMd').test(service)).toBe(false);
    // …and a field that IS still add-only does, so the assertion above is about
    // these two fields rather than about the regex having stopped working.
    // ⚠️ THE CONTROL USED TO BE `priority`, which MOTIR-4143 moved to every-op —
    // so the control moved with it, to a field whose add-only answer is about
    // PROVENANCE and does not move when a rail question is settled.
    expect(addOnlyElseNull('explanationSource').test(service)).toBe(true);
  });

  it('holds the PRESENCE test that separates “unchanged” from “cleared”', () => {
    // `??` and `!== undefined` are indistinguishable on every case except the one
    // that matters: the patch is sparse, so an explicit `null` CLEARS a body. A
    // `??` fallback would show the reviewer the text approval is about to DELETE
    // as the text approval will keep — this bug's own failure mode inverted, and
    // therefore the likeliest thing to ship as its fix.
    // ⚠️ THE RULE MOVED, SO THE READ MOVED WITH IT (MOTIR-4143). `proposedBody`
    // is now a two-line wrapper and `proposedValue` holds the presence test for
    // every field that has one — so reading the wrapper would assert this of a
    // function that no longer decides it, and pass while the rule was gone.
    const start = service.indexOf('function proposedValue');
    expect(start).toBeGreaterThan(-1);
    const body = service.slice(start, service.indexOf('\n}', start));
    expect(body).toContain('!== undefined');
    expect(body).not.toMatch(/item\.patch\?\.\[key\] \?\?/);
  });
});

// ── The EDGE-CARRIER guard (bug MOTIR-3366) ──────────────────────────────────
//
// The parity test above holds the review model against what an `add` PROPOSES.
// A plan's `blocked_by` edges have a second carrier that lives nowhere near
// `PlanItemProposedFields`: a `modify` states them in `patch.blockedByAdd`,
// because a proposal about a card that already exists has no proposed-fields bag
// to put them in. `planReviewService` resolved the `add`'s carrier alone, so
// every edge proposed onto an existing card reached the canvas as an empty
// array — the added card drew with no line to the card it blocks, while the same
// patch was already being read to render the "+1 blocker" diff row.
//
// Adding the second read fixes today's instance; this is the half that survives
// a THIRD carrier. `PlanItemPatch` is where a new one would be declared, and the
// review model is the consumer that must then decide what it means.
describe('PlanItemPatch edge carriers ⟷ planReviewService', () => {
  const patchKeys = interfaceKeys('lib/dto/plans.ts', 'PlanItemPatch');
  const carriers = [...patchKeys].filter((k) => k.startsWith('blockedBy'));
  const service = readFileSync(resolve(ROOT, 'lib/services/planReviewService.ts'), 'utf8');

  it('names EVERY edge carrier the patch declares', () => {
    // A carrier the review model never mentions is one whose edges cannot reach
    // the canvas — and the failure is silent, because an unread carrier renders
    // as a level with one fewer arrow rather than as an error.
    const unread = carriers.filter((k) => !service.includes(k));
    expect({ unread }).toEqual({ unread: [] });
  });

  it('parses the patch — a guard that read nothing would pass vacuously', () => {
    expect(patchKeys.size).toBeGreaterThan(5);
    expect(carriers.sort()).toEqual(['blockedByAdd', 'blockedByRemove']);
  });

  it('resolves BOTH carriers — each into its own field, never into one set', () => {
    // ⚠️ RE-SCOPED FROM THE FILE TO THE FUNCTION (bug MOTIR-4092), and the
    // invariant it protects is UNCHANGED.
    //
    // This assertion used to read `expect(service).not.toContain(
    // 'item.patch?.blockedByRemove')` — the service must not read the removal
    // carrier AT ALL. That was a correct proxy while there was nowhere for a
    // removal to go: the canvas had no treatment for an edge going away, so the
    // only thing reading the key could have done was fold it in with the adds.
    //
    // The proxy and the invariant come apart the moment the treatment exists.
    // What must never happen is a removal becoming a DECLARED BLOCKER — drawing
    // an edge the plan deletes as one it is adding says the opposite of what the
    // plan proposes. What is now correct is reading the key into its OWN field,
    // so the canvas can SUBTRACT it — `mergePlanLevel` drops the committed dep
    // it names. A file-wide string ban cannot tell those two apart, and it
    // failed the one that is right.
    //
    // So the ban moves to the function it was always about: `blockedByNodeIdsOf`
    // is the set that becomes arrows, and the removal carrier may not appear
    // inside it.
    const fn = (name: string): string => {
      const start = service.indexOf(`const ${name} = `);
      expect(start).toBeGreaterThan(-1);
      const end = service.indexOf('\n    };', start);
      expect(end).toBeGreaterThan(start);
      return service.slice(start, end);
    };

    // The DECLARED blockers: the add carriers, and NOT the removal one.
    const declaredBlockers = fn('blockedByNodeIdsOf');
    expect(declaredBlockers).toContain('item.patch?.blockedByAdd');
    expect(declaredBlockers).not.toContain('blockedByRemove');

    // The removal travels on its own channel, and reads only its own carrier.
    const removed = fn('blockedByRemovedNodeIdsOf');
    expect(removed).toContain('item.patch?.blockedByRemove');
    expect(removed).not.toContain('blockedByAdd');

    // …and the two land on DIFFERENT DTO fields, which is the property the whole
    // separation exists for.
    expect(service).toContain('blockedByNodeIds: blockedByNodeIdsOf(item)');
    expect(service).toContain('blockedByRemovedNodeIds: blockedByRemovedNodeIdsOf(item)');

    // The reasoning stays on the record at the site, so a later reader still
    // cannot mistake the separation for an oversight.
    expect(service).toMatch(/`blockedByRemove` is deliberately NOT here/);
  });
});

// ── The CHANGE-ROW totality guard (bug MOTIR-3868) ───────────────────────────
//
// The two guards above hold the review model against what a proposal CARRIES.
// This one holds the review VOCABULARY against what a `modify` can PATCH — the
// third consumer of `PlanItemPatch`, and the one where a missing key is most
// nearly invisible.
//
// ── What went wrong ─────────────────────────────────────────────────────────
// `buildChanges` emits a `PlanItemChangeDto` per patched field, and it had no row
// for `targetRepo` (MOTIR-1884) or `targetRepoRole` (MOTIR-1912) — two keys that
// `applyModify` read and applied. So a `modify` carrying `{ targetRepo: 'motir-ai' }`
// and nothing else rendered in the review dock and on the canvas as a proposal
// with an EMPTY change list: a row that says a card is being modified and
// declines to say how. The approver's only options were to approve a change they
// could not see, or decline a plan that may have been entirely correct.
//
// It is silent in the direction that hides it. An empty `changes` array is a
// legal, ordinary shape (a `remove` has one), so nothing rendered wrong and
// nothing failed. `buildChanges` is typed to the closed wire vocabulary, which
// makes a WRONG literal a compile error and says nothing about a MISSING one.
//
// ── Why THIS test, and not the one that already exists ──────────────────────
// `tests/components/plan-change-field-labels.test.tsx` is total over
// `PLAN_ITEM_CHANGE_FIELDS` — it holds the three label maps and both catalogs to
// the vocabulary, and it could never see this: it holds the labels to the
// vocabulary, and the VOCABULARY is what was short. Totality over a list cannot
// detect that the list itself is missing a member; only a comparison against a
// SECOND, independently-maintained list can.
//
// This is the third time a key added to `PlanItemPatch` reached one consumer and
// not another — the sizing pair reached the producer and not the labels
// (MOTIR-3151), three keys reached the core patch and not motir-ai (MOTIR-3860),
// and these two reached the applier and not the review. Each was found by
// accident, months later. `motir-ai`'s `MODIFY_PATCH_KEYS` is this same
// instrument one boundary over, and is what this mirrors.
describe('PlanItemPatch ⟷ PLAN_ITEM_CHANGE_FIELDS totality', () => {
  // `languages` (MOTIR-8743) annotates the text keys and is outside the constant
  // by design — the same exclusion `_planItemPatchKeysAreExhaustive` names.
  const declared = new Set(
    [...interfaceKeys('lib/dto/plans.ts', 'PlanItemPatch')].filter((k) => !(k in NOT_A_CARD_FIELD)),
  );

  /**
   * What the review surface does with each patch key: the change row it produces,
   * or a NAMED reason it deliberately produces none.
   *
   * ⚠️ `Record<PlanItemPatchKey, …>` is total by TYPE, so a key added to
   * `PlanItemPatch` (and therefore to `PLAN_ITEM_PATCH_KEYS`, which the compiler
   * already forces) fails to compile HERE until somebody states what the approver
   * sees for it. That is the whole ratchet: the answer may legitimately be
   * "nothing", but it has to be written down rather than defaulted into.
   *
   * `noRow` is EMPTY: every key a `modify` can carry is visible to the approver.
   * The obsolescence pair (MOTIR-6629) and the four supersedes edge lists
   * (MOTIR-6630) were recorded here as owed until MOTIR-6632 drew their rows.
   */
  type ChangeRowDisposition = { row: PlanItemChangeField } | { noRow: string };
  const DISPOSITION: Record<PlanItemPatchKey, ChangeRowDisposition> = {
    title: { row: 'title' },
    descriptionMd: { row: 'description' },
    explanationMd: { row: 'explanation' },
    priority: { row: 'priority' },
    type: { row: 'type' },
    // A RE-KIND of the target (bug MOTIR-8192 · AMENDMENT 25).
    kind: { row: 'kind' },
    storyPoints: { row: 'storyPoints' },
    estimateMinutes: { row: 'estimateMinutes' },
    // A leaf's DIFFICULTY (MOTIR-6133 carries it, MOTIR-6137 renders it).
    difficulty: { row: 'difficulty' },
    todos: { row: 'todos' },
    // The two this bug was filed about.
    targetRepo: { row: 'targetRepo' },
    // The SET spellings of the SAME axis (bug MOTIR-4904) land on the same row.
    // They are mutually exclusive with `targetRepo` and with each other at the
    // append, so at most one of the three can move the row on any one patch —
    // which is why one row is enough and a second would be a second name for one
    // change.
    targetRepos: { row: 'targetRepo' },
    targetRepositories: { row: 'targetRepo' },
    targetRepositoryRef: { row: 'targetRepo' },
    targetRepoRole: { row: 'targetRepoRole' },
    parentRef: { row: 'parent' },
    // BOTH edge carriers collapse onto one row — the diff cell reads
    // `+2 / −1 blockers` rather than naming each edge (MOTIR-3366's carriers).
    blockedByAdd: { row: 'links' },
    blockedByRemove: { row: 'links' },
    // The OBSOLESCENCE mark and its note — carried by MOTIR-6629, drawn by
    // MOTIR-6632 (design Part XXIV §24.3 / §24.6): `Mark  Current → Outdated`
    // and the note's first line.
    obsolescence: { row: 'obsolescence' },
    obsolescenceNoteMd: { row: 'obsolescenceNote' },
    // The four `supersedes` edge lists — carried by MOTIR-6630, drawn by
    // MOTIR-6632 as TWO rows, one per direction, each carrying resolved chips
    // (§24.7). Unlike the blocker carriers they are NOT folded into `links`: no
    // canvas edge draws them, so the chips are the whole of what the approver sees.
    supersedesAdd: { row: 'supersedes' },
    supersedesRemove: { row: 'supersedes' },
    supersededByAdd: { row: 'supersededBy' },
    supersededByRemove: { row: 'supersededBy' },
  };

  /**
   * The rows NO patch key produces, each with the reason — the approve DERIVES
   * them from a patch plus the live target. Kept as a named map rather than a
   * relaxed assertion, so a vocabulary member only escapes the ratchet below by
   * stating what produces it.
   */
  const DERIVED_ROWS: Partial<Record<PlanItemChangeField, string>> = {
    status:
      'MOTIR-5359 — a re-scoping patch (title / description / repository) on an in-progress-category target resets its status on approve',
    executor:
      'MOTIR-6259 — a patch that re-types a target with NO executor seeds the type default on approve (`resolveExecutor`); MOTIR-8192 — a re-kind to a container clears it',
  };

  it('declares the patch key set exactly — the constant cannot drift from the interface', () => {
    // The COMPILE-TIME half lives in `lib/dto/plans.ts`
    // (`_planItemPatchKeysAreExhaustive`). This is the runtime half, and it is not
    // redundant: it reads the interface's own source text, so it still fails if
    // someone relaxes that assertion, and it names the offending key rather than
    // producing a `never` type error.
    expect([...PLAN_ITEM_PATCH_KEYS].sort()).toEqual([...declared].sort());
  });

  it('states a disposition for EVERY patch key', () => {
    const undispositioned = [...PLAN_ITEM_PATCH_KEYS].filter((k) => !(k in DISPOSITION));
    const stale = Object.keys(DISPOSITION).filter(
      (k) => !(PLAN_ITEM_PATCH_KEYS as readonly string[]).includes(k),
    );
    expect({ undispositioned, stale }).toEqual({ undispositioned: [], stale: [] });
  });

  it('emits only rows the wire vocabulary can name', () => {
    const rows = Object.values(DISPOSITION).flatMap((d) => ('row' in d ? [d.row] : []));
    const unknown = rows.filter((r) => !(PLAN_ITEM_CHANGE_FIELDS as readonly string[]).includes(r));
    expect({ unknown }).toEqual({ unknown: [] });
  });

  it('leaves no vocabulary member that nothing can produce', () => {
    // The other direction. A member of the vocabulary that no patch key emits is
    // dead copy every catalog and all three label maps are nonetheless forced to
    // carry — the mirror-image drift, and the one a totality-over-the-vocabulary
    // test reads as healthy.
    const produced = new Set([
      ...Object.values(DISPOSITION).flatMap((d) => ('row' in d ? [d.row as string] : [])),
      ...Object.keys(DERIVED_ROWS),
    ]);
    const unproducible = PLAN_ITEM_CHANGE_FIELDS.filter((f) => !produced.has(f));
    expect({ unproducible }).toEqual({ unproducible: [] });
  });

  it('parses the interface — a guard that read nothing would pass vacuously', () => {
    expect(declared.size).toBeGreaterThan(10);
    expect(declared.has('targetRepo')).toBe(true);
  });

  // ── MOTIR-4183 · the OP AXIS now covers the PEEK's projection too ─────────
  //
  // This guard was written for the review MODEL's fields. The peek reads that
  // model through a `proposal` envelope, so the axis it holds has one more
  // consumer — and one field that stays `add`-only ON PURPOSE, which is exactly
  // the shape this file exists to record rather than leave to be re-derived.

  it('records `explanationSource` as add-ONLY, WITH the reason', () => {
    // `PlanItemPatch` has no `explanationSource` twin, deliberately: that column
    // is not the caller's to set, so a patch that could write it would let a
    // plan forge provenance, and `applyModify` leaves the target's value alone.
    // A `modify` therefore has nothing to say here, and reporting the TARGET's
    // source beside a REWRITTEN explanation would attribute the new text to
    // whoever wrote the old one — MOTIR-4134's own defect, pointing the other way.
    expect(PLAN_ITEM_PATCH_KEYS).not.toContain('explanationSource' as PlanItemPatchKey);
    // …and therefore not a field the peek's marker or its denominator can name.
    expect(PLAN_ITEM_SETTABLE_RAIL_FIELDS).not.toContain(
      'explanationSource' as PlanItemChangeField,
    );
  });

  it('records `executor` as add-ONLY too — and this one was got WRONG in a design', () => {
    // Part XIV's first draft marked `executor` changeable on a `modify`.
    // `PlanItemPatch` has no key for it and `plansService.applyModify` never
    // writes one; it is settable on an `add` and deepenable, and on every other
    // op it is the TARGET's. Recorded here so the next reader of the op axis
    // finds the answer rather than the assumption.
    expect(PLAN_ITEM_PATCH_KEYS).not.toContain('executor' as PlanItemPatchKey);
    expect(PLAN_ITEM_SETTABLE_RAIL_FIELDS).not.toContain('executor' as PlanItemChangeField);
  });

  it('every SETTABLE rail field is a patch key’s row — the denominator cannot outrun the patch', () => {
    // The peek's count line reads "{n} of {m} fields it can set". If `m` could
    // name a field no patch key produces, the line would promise the reviewer a
    // field the plan cannot move.
    const produced = new Set(
      Object.values(DISPOSITION).flatMap((d) => ('row' in d ? [d.row as string] : [])),
    );
    const unproducible = PLAN_ITEM_SETTABLE_RAIL_FIELDS.filter((f) => !produced.has(f));
    expect({ unproducible }).toEqual({ unproducible: [] });
  });

  it('would have caught the two keys that shipped invisible', () => {
    // The regression this guard is built from, asserted as itself: before the fix
    // the vocabulary held neither, so the first assertion in this block went red
    // only once `PLAN_ITEM_PATCH_KEYS` existed — and `unproducible` / `unknown`
    // are what keep them there.
    expect(PLAN_ITEM_CHANGE_FIELDS).toContain('targetRepo');
    expect(PLAN_ITEM_CHANGE_FIELDS).toContain('targetRepoRole');
  });
});
