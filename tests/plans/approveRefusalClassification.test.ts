import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PLAN_GRAMMAR_VIOLATIONS,
  PLAN_REF_GRAPH_VIOLATIONS,
  type PlanGrammarViolation,
  type PlanRefGraphViolation,
} from '@/lib/plans/errors';
import { APPROVE_REFUSALS, refusalId } from '@/lib/plans/approveRefusals';

// MOTIR-3936 — EVERY REFUSAL `approvePlan` CAN RAISE IS CLASSIFIED, AND A NEW
// ONE CANNOT DEFAULT INTO THE UN-CHECKED BUCKET.
//
// `planned` is the status that says *the author is finished and a person may now
// decide*, and it only means that if the plan a reviewer is handed is one
// approve accepts. So each refusal has to be sorted: PLAN-INTERNAL (knowable at
// the close, and therefore refused there) or TREE-CAUSED (the world moved, so it
// cannot be — and what is owed instead is a message that routes the reviewer).
//
// ⚠️ THE SUBJECT SET IS DERIVED, NOT LISTED. The reasons come from the two
// runtime arrays in `lib/plans/errors.ts` (each compiler-proved total against
// its union), and the CODES are read out of the error modules' own source — so a
// class or a reason added later appears here on its own and fails until somebody
// classifies it. A hand-written list beside the registry would be a second copy
// that drifts, which is the exact defect this card is about: a check that lives
// in one place and not its neighbour.
//
// The idiom is `tests/navigation/proxy-matcher.test.ts`'s — enumerate the real
// population, fail on an unclassified member, and record the deliberate
// exclusions as intent rather than leaving them to read as oversights.

const ROOT = process.cwd();

/** Every `readonly code = 'X' as const` an error module declares — and the one base
 *  class whose code is WIDENED for its subclass (`PlanNotEditableError`, MOTIR-9006:
 *  `readonly code: 'A' | 'B' = 'A'`), plus the subclass's `override` of it. */
function declaredCodes(relativePath: string): string[] {
  const source = readFileSync(join(ROOT, relativePath), 'utf8');
  const codes = [
    ...source.matchAll(/(?:override )?readonly code(?:: [^=]+)? = '([A-Z_]+)'(?: as const)?;/g),
  ].map((m) => m[1]!);
  return [...new Set(codes)];
}

const PLAN_ERROR_CODES = declaredCodes('lib/plans/errors.ts');
const LINK_ERROR_CODES = declaredCodes('lib/workItems/linkErrors.ts');

/**
 * The link errors approve can meet. `WORK_ITEM_LINK_NOT_FOUND` belongs to
 * `unlinkWorkItems` — approve only ever CREATES edges — so it is excluded here
 * rather than parked in the registry as a `not-approve` entry it would share
 * with plan-door errors.
 */
const APPROVE_LINK_ERROR_CODES = LINK_ERROR_CODES.filter(
  (code) => code !== 'WORK_ITEM_LINK_NOT_FOUND',
);

/** The full refusal-id population: bare codes, plus one id per reason member. */
function refusalPopulation(): string[] {
  const reasoned = new Set(['PLAN_GRAMMAR_VIOLATION', 'INVALID_PLAN_REF_GRAPH']);
  const ids = [
    ...PLAN_ERROR_CODES.filter((c) => !reasoned.has(c)),
    ...APPROVE_LINK_ERROR_CODES,
    ...PLAN_GRAMMAR_VIOLATIONS.map((r: PlanGrammarViolation) =>
      refusalId('PLAN_GRAMMAR_VIOLATION', r),
    ),
    ...PLAN_REF_GRAPH_VIOLATIONS.map((r: PlanRefGraphViolation) =>
      refusalId('INVALID_PLAN_REF_GRAPH', r),
    ),
  ];
  return [...new Set(ids)].sort();
}

describe('the approve refusal set is derived, not listed', () => {
  it('reads real codes out of both error modules', () => {
    // A guard on the guard: a regex that stopped matching would silently make
    // every assertion below vacuous.
    expect(PLAN_ERROR_CODES.length).toBeGreaterThan(10);
    expect(PLAN_ERROR_CODES).toContain('INVALID_PLAN_REF_GRAPH');
    expect(APPROVE_LINK_ERROR_CODES).toContain('WORK_ITEM_LINK_CYCLE');
  });

  it('enumerates every reason member of both violation unions', () => {
    // The arrays are compiler-proved total against their unions; this pins that
    // they are also NON-EMPTY, which the type system cannot say.
    expect(PLAN_GRAMMAR_VIOLATIONS).toContain('illegal_parent');
    // MOTIR-6133 — a difficulty on a container. Plan-internal like its
    // neighbours: `markPlanned` runs the same gate over the same target rows.
    expect(PLAN_GRAMMAR_VIOLATIONS).toContain('difficulty_on_container');
    expect(
      APPROVE_REFUSALS[refusalId('PLAN_GRAMMAR_VIOLATION', 'difficulty_on_container')]?.cause,
    ).toBe('plan-internal');
    expect(PLAN_REF_GRAPH_VIOLATIONS).toEqual(
      expect.arrayContaining(['dangling', 'duplicate', 'cycle']),
    );
  });
});

describe('every refusal is classified', () => {
  it('leaves NO member of the derived population unclassified', () => {
    const unclassified = refusalPopulation().filter((id) => !(id in APPROVE_REFUSALS));
    // The failure message is the point: it names the refusal to classify.
    expect(unclassified).toEqual([]);
  });

  it('classifies nothing that is not in the population — the registry cannot rot forward either', () => {
    const population = new Set(refusalPopulation());
    const stale = Object.keys(APPROVE_REFUSALS).filter((id) => !population.has(id));
    expect(stale).toEqual([]);
  });

  it('gives every entry a cause and a written justification', () => {
    for (const [id, entry] of Object.entries(APPROVE_REFUSALS)) {
      expect(['plan-internal', 'tree-caused', 'not-approve'], id).toContain(entry.cause);
      // A reason put in a bucket with no argument is indistinguishable from one
      // nobody looked at — which is why the justification is required rather
      // than optional.
      expect(entry.justification.length, id).toBeGreaterThan(40);
    }
  });

  it('classifies BOTH violation unions as plan-internal — they are properties of the plan alone', () => {
    for (const reason of PLAN_GRAMMAR_VIOLATIONS) {
      expect(APPROVE_REFUSALS[refusalId('PLAN_GRAMMAR_VIOLATION', reason)]?.cause).toBe(
        'plan-internal',
      );
    }
    for (const reason of PLAN_REF_GRAPH_VIOLATIONS) {
      expect(APPROVE_REFUSALS[refusalId('INVALID_PLAN_REF_GRAPH', reason)]?.cause).toBe(
        'plan-internal',
      );
    }
  });
});

describe('no approve failure reaches the caller as a bare 500', () => {
  const ROUTE = readFileSync(join(ROOT, 'app/api/plans/[id]/approve/route.ts'), 'utf8');

  /**
   * Every error class the approve route's catch actually tests for. Read out of
   * the route rather than listed, for the same reason the codes above are.
   */
  const HANDLED_CLASSES = new Set(
    [...ROUTE.matchAll(/err instanceof ([A-Za-z]+Error)/g)].map((m) => m[1]!),
  );

  it('answers every DATABASE-TRIGGER refusal with a typed status — the third occurrence of this shape', () => {
    // `WI_LINK_CYCLE` / `WI_LINK_SELF` / `WI_LINK_CROSS_WORKSPACE` /
    // `WI_LINK_WORKSPACE_MISMATCH` arrive as these typed classes (the link
    // repository translates the SQLSTATE markers) and, until MOTIR-3936, fell
    // through the rethrow to a 500 with an empty body.
    for (const cls of [
      'WorkItemLinkCycleError',
      'SelfLinkError',
      'CrossWorkspaceLinkError',
      'WorkspaceMismatchLinkError',
      'DuplicateLinkError',
    ]) {
      expect(HANDLED_CLASSES, cls).toContain(cls);
    }
  });

  it('still answers every plan-error class it did before', () => {
    for (const cls of [
      'PlanNotFoundError',
      'PlanNotInExpectedStatusError',
      'PlanGrammarError',
      'PlanRefGraphError',
      'PlanTargetImmutableError',
      'PlanApproveTimedOutError',
      'PlanItemFieldRejectedError',
    ]) {
      expect(HANDLED_CLASSES, cls).toContain(cls);
    }
  });

  it('routes the CYCLE refusal to the plan’s AUTHOR in the response body', () => {
    // The reviewer's error is a routing problem: a proposal is not something
    // they can repair, so the message has to say who can.
    expect(ROUTE).toMatch(/author must drop one of the two edges/);
  });
});
