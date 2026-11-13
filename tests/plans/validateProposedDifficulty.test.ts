import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { InvalidProposalError } from '@/lib/plans/errors';
import {
  isDifficultyRefusedOnKind,
  validateProposedDifficulty,
} from '@/lib/plans/validateProposedDifficulty';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import { TYPEABLE_KINDS } from '@/lib/issues/executorDefaults';

// MOTIR-6133 — the ONE validator every plan-proposal door calls for a proposed
// `difficulty` (`agent-authored-plans.md` AMENDMENT 19). Pure, so pinned here
// without a database; `tests/integration/plans/proposedDifficulty.test.ts`
// proves each door reaches it and what approve writes.

const LEAVES = ['subtask', 'task', 'bug'] as const;
const CONTAINERS = ['epic', 'story'] as const;

function refusal(run: () => void): InvalidProposalError | null {
  try {
    run();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidProposalError);
    return err as InvalidProposalError;
  }
}

describe('validateProposedDifficulty', () => {
  it('accepts every member of the scale on every leaf kind', () => {
    for (const kind of LEAVES) {
      for (const difficulty of WORK_ITEM_DIFFICULTIES) {
        expect(refusal(() => validateProposedDifficulty(difficulty, kind, 'P'))).toBeNull();
      }
    }
  });

  it('is the four-member scale 6016 shipped', () => {
    expect([...WORK_ITEM_DIFFICULTIES]).toEqual(['trivial', 'low', 'medium', 'high']);
  });

  it('refuses a non-null value on a container, naming the field, the value and the kind', () => {
    for (const kind of CONTAINERS) {
      const err = refusal(() => validateProposedDifficulty('medium', kind, 'Proposal "X"'));
      expect(err?.code).toBe('INVALID_PROPOSAL');
      expect(err?.message).toContain('Proposal "X"');
      expect(err?.message).toContain('`difficulty`');
      expect(err?.message).toContain('medium');
      expect(err?.message).toContain(`\`${kind}\``);
    }
  });

  it('accepts absent and an explicit clear on ANY kind — clearing is always legal', () => {
    for (const kind of [...LEAVES, ...CONTAINERS]) {
      expect(refusal(() => validateProposedDifficulty(undefined, kind, 'P'))).toBeNull();
      expect(refusal(() => validateProposedDifficulty(null, kind, 'P'))).toBeNull();
    }
  });

  it('refuses a value outside the scale — on a leaf, and when the kind is not yet known', () => {
    for (const bad of ['extreme', 'HIGH', '', 3, true, {}]) {
      const onLeaf = refusal(() => validateProposedDifficulty(bad, 'task', 'P'));
      expect(onLeaf?.message).toContain('`difficulty`');
      expect(onLeaf?.message).toContain('trivial, low, medium, high');
      expect(refusal(() => validateProposedDifficulty(bad, null, 'P'))).not.toBeNull();
    }
  });

  it('judges MEMBERSHIP only when the kind is not yet known (a modify before its target read)', () => {
    expect(refusal(() => validateProposedDifficulty('high', null, 'P'))).toBeNull();
  });
});

describe('isDifficultyRefusedOnKind — the predicate the approve gate shares', () => {
  it('reads leaf-ness off TYPEABLE_KINDS, the predicate 6016 and `type` use', () => {
    for (const kind of [...LEAVES, ...CONTAINERS]) {
      expect(isDifficultyRefusedOnKind('low', kind)).toBe(!TYPEABLE_KINDS.has(kind));
    }
  });

  it('never refuses absent or null', () => {
    for (const kind of CONTAINERS) {
      expect(isDifficultyRefusedOnKind(undefined, kind)).toBe(false);
      expect(isDifficultyRefusedOnKind(null, kind)).toBe(false);
    }
  });
});

// ── ONE validator, every door ──────────────────────────────────────────────
//
// The card's bar: "the three proposal doors share ONE validator module,
// asserted by a test that fails if any door is changed to call a different
// function". Read out of the SOURCE, per function body, because the drift this
// guards against is a door quietly growing its own copy — a local membership
// check, a `TYPEABLE_KINDS` test, or the work-item service's error — which a
// behavioural test on one door cannot see on another. The behaviour of each
// door against real Postgres is `tests/integration/plans/proposedDifficulty.test.ts`.

const ROOT = process.cwd();
const PLANS_SERVICE = readFileSync(join(ROOT, 'lib/services/plansService.ts'), 'utf8');
const GATE = readFileSync(join(ROOT, 'lib/plans/validateProposals.ts'), 'utf8');

/** The source of one top-level function / object method, from its signature to
 *  the next declaration at the same indentation. */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const indent = /^\s*/.exec(source.slice(source.lastIndexOf('\n', start) + 1, start))![0];
  const close = source.indexOf(`\n${indent}}`, start);
  expect(close, signature).toBeGreaterThan(start);
  return source.slice(start, close);
}

describe('ONE validator module serves every proposal door (MOTIR-6133)', () => {
  const DOORS: ReadonlyArray<[string, string, number]> = [
    // [door, signature, how many calls it makes]
    ['the append — add + modify membership', 'function validateProposal(p: ProposalInput)', 2],
    [
      "the append — a modify's container half",
      'async function assertModifyLeafFieldsLegalAtAppend(',
      1,
    ],
    // MOTIR-8175 split the edit's in-transaction half out of `editAddProposal`
    // so the Sharpen write-back can apply several edits under one lock; the
    // validator call moved with it, and every edit door reaches it from there.
    ['the deepen / human edit', 'async function applyAddProposalEdit(', 1],
    // MOTIR-11225 split the correction's per-proposal half out of
    // `correctProposal` so the BATCH door can build several corrections under
    // one lock; the validator calls moved with it, and both doors reach them.
    ['the correction — merged add + modify patch', 'async function buildCorrection(', 2],
  ];

  it.each(DOORS)('%s calls validateProposedDifficulty', (_door, signature, calls) => {
    const body = bodyOf(PLANS_SERVICE, signature);
    expect(body.match(/validateProposedDifficulty\(/g) ?? []).toHaveLength(calls);
  });

  it('the deepen / human edit runs its in-transaction half — the helper is actually called', () => {
    const body = bodyOf(PLANS_SERVICE, 'async function editAddProposal(');
    expect(body.match(/applyAddProposalEdit\(/g) ?? []).toHaveLength(1);
  });

  it('the append runs the modify container half — the helper is actually called', () => {
    const body = bodyOf(PLANS_SERVICE, 'async addProposals(');
    expect(body).toContain('await assertModifyLeafFieldsLegalAtAppend(');
    expect(body).toContain('proposals.forEach(validateProposal)');
  });

  it('imports it from the ONE module, and grows no local copy of the rule', () => {
    expect(PLANS_SERVICE).toContain(
      "import { validateProposedDifficulty } from '@/lib/plans/validateProposedDifficulty';",
    );
    for (const source of [PLANS_SERVICE, GATE]) {
      expect(source).not.toMatch(/isWorkItemDifficulty|WORK_ITEM_DIFFICULTIES/);
      expect(source).not.toMatch(/DifficultyNotAllowedOnKind/);
    }
  });

  it('the approve gate asks the same module’s predicate', () => {
    expect(GATE).toContain(
      "import { isDifficultyRefusedOnKind } from '@/lib/plans/validateProposedDifficulty';",
    );
    const body = bodyOf(GATE, 'function assertDifficultyOnLeaf(');
    expect(body.match(/isDifficultyRefusedOnKind\(/g) ?? []).toHaveLength(2);
    expect(bodyOf(GATE, 'export function validatePlanProposals(')).toContain(
      'assertDifficultyOnLeaf(item, projectedLiveById)',
    );
  });
});
