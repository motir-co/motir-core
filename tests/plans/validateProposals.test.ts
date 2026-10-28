import { describe, expect, it } from 'vitest';
import {
  assertBlockedByLevels,
  assertProposalSetSelfConsistent,
  collectReferencedWorkItemIds,
  projectedParentChain,
  proposedParentAnchorIds,
  validatePlanProposals,
  type LiveWorkItemState,
  type ProposalNode,
} from '@/lib/plans/validateProposals';
import {
  InvalidProposalError,
  PlanGrammarError,
  PlanRefGraphError,
  PlanTargetImmutableError,
} from '@/lib/plans/errors';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { ISSUE_TYPES, type IssueType } from '@/lib/issues/parentRules';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';

// Subtask 7.12.5 / MOTIR-911 — the confirmation gate's VERDICT, as pure logic
// (no DB). The gate's job: an approved proposal set becomes rows ONLY after an
// independent re-validation, and a rejection happens before any write.
//
// These tests pin the verdict itself. `tests/integration/plans/approvePersistGate`
// proves the other half — that a rejection actually leaves Postgres untouched,
// and that the immutability verdict is re-taken under the row lock.
//
// The kind-parent expectations here are written INDEPENDENTLY of the matrix
// module (the same discipline tests/issues/parentValidation.test.ts uses), so
// these pin the CONTRACT rather than mirror the implementation.

const REAL_PARENT = 'wi_parent';
const REAL_TARGET = 'wi_target';
/** The project the PLAN is in — every live row defaults to it. */
const PLAN_PROJECT = 'proj_plan';
/** A SIBLING project in the same workspace (MOTIR-3581). */
const OTHER_PROJECT = 'proj_other';

function live(overrides: Partial<LiveWorkItemState> & { id: string }): LiveWorkItemState {
  return {
    kind: 'story',
    status: 'todo',
    projectId: PLAN_PROJECT,
    // The identity a refusal NAMES (MOTIR-3936) — derived from the id so a case
    // that does not care about it still produces a message a person could act on.
    key: `MOTIR-${overrides.id}`,
    title: `The ${overrides.id} card`,
    ...overrides,
  };
}

function liveMap(...items: LiveWorkItemState[]): Map<string, LiveWorkItemState> {
  return new Map(items.map((i) => [i.id, i]));
}

function add(id: string, overrides: Partial<ProposalNode> = {}): ProposalNode {
  return {
    id,
    op: 'add',
    workItemId: null,
    parentRef: null,
    blockedByRefs: [],
    proposedFields: { kind: 'task' },
    patch: null,
    ...overrides,
  };
}

function modify(id: string, overrides: Partial<ProposalNode> = {}): ProposalNode {
  return {
    id,
    op: 'modify',
    workItemId: REAL_TARGET,
    parentRef: null,
    blockedByRefs: [],
    proposedFields: null,
    patch: null,
    ...overrides,
  };
}

/** Run the gate with sensible defaults for the parts a case doesn't exercise. */
function validate(
  items: ProposalNode[],
  opts: {
    liveById?: Map<string, LiveWorkItemState>;
    terminalStatusKeys?: Set<string>;
    planProjectId?: string;
    /** The re-parent gate's ancestor chains (MOTIR-3859). Absent means every
     *  proposed parent reads as a ROOT, which is the permissive answer and the
     *  right default for every case that re-parents nothing. */
    ancestorIdsById?: Map<string, readonly string[]>;
    /** The committed `is_blocked_by` edges the plan joins onto (MOTIR-3936).
     *  Absent means the plan is the whole graph, which is the right default for
     *  every case that proposes no edge. */
    existingBlockedByEdges?: Array<{ blockedId: string; blockerId: string }>;
    /** The committed `supersedes` links the plan joins onto (MOTIR-6630). */
    existingSupersedesEdges?: Array<{ fromId: string; toId: string }>;
    /** The folders a `folder:` placement names (MOTIR-5414). */
    folderById?: Map<string, { id: string; projectId: string; name: string }>;
    /** Committed ancestor chains the same-level check places live ends with
     *  (MOTIR-6411). Absent means no live end is placed, so it is skipped. */
    edgeAncestorsById?: Map<string, readonly string[]>;
    /** The mark targets' status CATEGORIES (MOTIR-6663). Absent derives them the
     *  way the service's per-project read would for the default workflow: a
     *  terminal key is `done`, `in_progress` is itself, anything else `todo`. */
    markTargetStatusCategoryById?: Map<string, StatusCategoryDto>;
  } = {},
): void {
  const liveById = opts.liveById ?? liveMap(live({ id: REAL_PARENT }), live({ id: REAL_TARGET }));
  const terminalStatusKeys = opts.terminalStatusKeys ?? new Set(['done', 'cancelled']);
  validatePlanProposals({
    items,
    liveById,
    terminalStatusKeys,
    planProjectId: opts.planProjectId ?? PLAN_PROJECT,
    ancestorIdsById: opts.ancestorIdsById ?? new Map(),
    existingBlockedByEdges: opts.existingBlockedByEdges ?? [],
    existingSupersedesEdges: opts.existingSupersedesEdges ?? [],
    markTargetStatusCategoryById:
      opts.markTargetStatusCategoryById ??
      new Map(
        [...liveById.values()].map((l): [string, StatusCategoryDto] => [
          l.id,
          terminalStatusKeys.has(l.status)
            ? 'done'
            : l.status === 'in_progress'
              ? 'in_progress'
              : 'todo',
        ]),
      ),
    folderById: opts.folderById ?? new Map(),
    edgeAncestorsById: opts.edgeAncestorsById ?? new Map(),
  });
}

describe('validatePlanProposals — the no-op cases', () => {
  it('accepts an empty plan (a declined / all-empty plan writes nothing)', () => {
    expect(() => validate([])).not.toThrow();
  });

  it('accepts a top-level add of a kind that may be a root', () => {
    expect(() => validate([add('p1', { proposedFields: { kind: 'epic' } })])).not.toThrow();
  });

  it('defaults a kindless add to `task` — the same default materialize applies', () => {
    // A task IS a legal root, so a kindless top-level add passes...
    expect(() => validate([add('p1', { proposedFields: null })])).not.toThrow();
    // ...and is rejected under a bug parent, which may only hold subtasks —
    // proving the default really is `task` and not something permissive.
    expect(() =>
      validate([add('p1', { proposedFields: {}, parentRef: REAL_PARENT })], {
        liveById: liveMap(live({ id: REAL_PARENT, kind: 'bug' })),
      }),
    ).toThrow(PlanGrammarError);
  });
});

describe('validatePlanProposals — the kind-parent grammar', () => {
  // The contract, written independently: child → the parents that may hold it.
  const ALLOWED_PARENTS: Record<IssueType, ReadonlySet<IssueType>> = {
    epic: new Set<IssueType>([]),
    story: new Set<IssueType>(['epic']),
    task: new Set<IssueType>(['epic', 'story']),
    bug: new Set<IssueType>(['epic', 'story', 'task']),
    subtask: new Set<IssueType>(['story', 'task', 'bug']),
  };

  for (const parentKind of ISSUE_TYPES) {
    for (const childKind of ISSUE_TYPES) {
      const legal = ALLOWED_PARENTS[childKind].has(parentKind);
      it(`${legal ? 'accepts' : 'rejects'} an add of a ${childKind} under a REAL ${parentKind}`, () => {
        const run = (): void =>
          validate([add('p1', { proposedFields: { kind: childKind }, parentRef: REAL_PARENT })], {
            liveById: liveMap(live({ id: REAL_PARENT, kind: parentKind })),
          });
        if (legal) expect(run).not.toThrow();
        else expect(run).toThrow(PlanGrammarError);
      });

      it(`${legal ? 'accepts' : 'rejects'} an add of a ${childKind} under an INTRA-PLAN ${parentKind}`, () => {
        // Place the PARENT add legally itself (a subtask may not be top-level),
        // so the assertion isolates the CHILD's placement.
        const run = (): void =>
          validate([
            add('parent', {
              proposedFields: { kind: parentKind },
              parentRef: parentKind === 'subtask' ? REAL_PARENT : null,
            }),
            add('child', {
              proposedFields: { kind: childKind },
              parentRef: `${TEMP_REF_PREFIX}parent`,
            }),
          ]);
        if (legal) expect(run).not.toThrow();
        else expect(run).toThrow(PlanGrammarError);
      });
    }
  }

  it('rejects a top-level subtask — a kind that requires a parent', () => {
    expect(() => validate([add('p1', { proposedFields: { kind: 'subtask' } })])).toThrow(
      PlanGrammarError,
    );
  });

  it('reports `illegal_parent` and the offending proposal id', () => {
    try {
      validate([add('p9', { proposedFields: { kind: 'epic' }, parentRef: REAL_PARENT })]);
      expect.unreachable('an epic under a story must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      expect((err as PlanGrammarError).reason).toBe('illegal_parent');
      expect((err as PlanGrammarError).planItemId).toBe('p9');
      expect((err as PlanGrammarError).code).toBe('PLAN_GRAMMAR_VIOLATION');
    }
  });

  it('rejects an add proposing a kind that is not an issue type', () => {
    try {
      validate([add('p1', { proposedFields: { kind: 'milestone' } })]);
      expect.unreachable('an unknown kind must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      expect((err as PlanGrammarError).reason).toBe('unknown_kind');
    }
  });

  it('rejects an add whose intra-plan PARENT proposes an unknown kind', () => {
    expect(() =>
      validate([
        add('parent', { proposedFields: { kind: 'milestone' } }),
        add('child', { proposedFields: { kind: 'task' }, parentRef: `${TEMP_REF_PREFIX}parent` }),
      ]),
    ).toThrow(PlanGrammarError);
  });

  it('rejects a real parent row whose kind is not an issue type (the unreachable guard)', () => {
    try {
      validate([add('p1', { proposedFields: { kind: 'task' }, parentRef: REAL_PARENT })], {
        liveById: liveMap(live({ id: REAL_PARENT, kind: 'milestone' })),
      });
      expect.unreachable('an unknown parent kind must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      expect((err as PlanGrammarError).reason).toBe('unknown_kind');
    }
  });

  it('does not gate a modify on the grammar — a patch cannot re-parent or re-kind', () => {
    expect(() => validate([modify('m1', { patch: { blockedByAdd: [] } })])).not.toThrow();
  });
});

// MOTIR-3654 — the `type` arm, the twin of `unknown_kind` above.
//
// The defect: the plan door's `type` was a bare `z.string()` while `kind`,
// `priority` and `executor` beside it were all `z.enum`, and this gate read only
// `kind`. So `type: "migration"` was stored, `validate_plan` answered
// `{ valid: true }`, and `prisma.workItem.create()` raised a
// `PrismaClientValidationError` from inside the approve transaction.
//
// Written against the CONTRACT (an out-of-enum value is refused; a member is
// not) rather than against the module's list, exactly as the kind-parent cases
// above are — the one exception is the totality case, which asserts precisely
// that the gate and the exported constant agree.
describe('validatePlanProposals — the proposed `type` is a closed set (MOTIR-3654)', () => {
  it('rejects an add proposing a type outside the enum, naming the proposal', () => {
    try {
      validate([add('p1', { proposedFields: { kind: 'task', type: 'migration' } })]);
      expect.unreachable('an out-of-enum type must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      expect((err as PlanGrammarError).reason).toBe('unknown_type');
      expect((err as PlanGrammarError).planItemId).toBe('p1');
      // The message lists the legal members: the caller correcting this is
      // usually an agent, which can act on a list and cannot act on a refusal.
      expect((err as PlanGrammarError).message).toContain('migration');
      expect((err as PlanGrammarError).message).toContain('code');
    }
  });

  it('accepts every member of the shipped enum', () => {
    for (const type of WORK_ITEM_TYPES) {
      expect(() =>
        validate([add(`p-${type}`, { proposedFields: { kind: 'task', type } })]),
      ).not.toThrow();
    }
  });

  it('accepts an add with no type at all, and one that clears it — untyped is legal', () => {
    expect(() => validate([add('p1', { proposedFields: { kind: 'task' } })])).not.toThrow();
    expect(() =>
      validate([add('p2', { proposedFields: { kind: 'task', type: null } })]),
    ).not.toThrow();
  });

  it('reports the TYPE before the parent grammar — the most specific reason wins', () => {
    // Both are wrong on this proposal: `subtask` at the root is an illegal
    // placement AND `migration` is not a work type. The type arm runs first
    // because it is a property of the proposal alone and needs no graph.
    try {
      validate([add('p1', { proposedFields: { kind: 'subtask', type: 'migration' } })]);
      expect.unreachable('must be rejected');
    } catch (err) {
      expect((err as PlanGrammarError).reason).toBe('unknown_type');
    }
  });

  it('is TOTAL over the schema enum — no member the gate rejects, none it misses', () => {
    // The pairing that makes this more than a restatement: the gate must accept
    // every member AND reject a plausible non-member. `migration` is the value
    // that actually reached `prisma.workItem.create()` in production, and it is
    // exactly the shape the old `.describe()` string invited — a five-of-fourteen
    // list ending in an ellipsis.
    expect(WORK_ITEM_TYPES).toHaveLength(15);
    expect((WORK_ITEM_TYPES as readonly string[]).includes('migration')).toBe(false);
  });
});

describe('validatePlanProposals — a DIFFICULTY is refused on a container (MOTIR-6133)', () => {
  function grammarReasonOf(run: () => void): string | null {
    try {
      run();
      return null;
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      return (err as PlanGrammarError).reason;
    }
  }

  it('refuses a modify whose LIVE target is a container — the re-kinded-after-append case', () => {
    // The target was a task at the append; it is a story by approve.
    const liveById = liveMap(live({ id: REAL_PARENT }), live({ id: REAL_TARGET, kind: 'story' }));
    try {
      validate([modify('m1', { patch: { difficulty: 'high' } })], { liveById });
      expect.unreachable('a difficulty on a story must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      expect((err as PlanGrammarError).reason).toBe('difficulty_on_container');
      expect((err as PlanGrammarError).planItemId).toBe('m1');
      expect((err as PlanGrammarError).message).toContain('difficulty');
      expect((err as PlanGrammarError).message).toContain('story');
      expect((err as PlanGrammarError).message).toContain('MOTIR-wi_target');
    }
  });

  it('accepts the same modify on a LEAF target, and a clear (`null`) on a container', () => {
    for (const kind of ['task', 'subtask', 'bug'] as const) {
      const liveById = liveMap(live({ id: REAL_PARENT }), live({ id: REAL_TARGET, kind }));
      expect(
        grammarReasonOf(() =>
          validate([modify('m1', { patch: { difficulty: 'trivial' } })], { liveById }),
        ),
      ).toBeNull();
    }
    const liveById = liveMap(live({ id: REAL_PARENT }), live({ id: REAL_TARGET, kind: 'epic' }));
    expect(
      grammarReasonOf(() =>
        validate([modify('m1', { patch: { difficulty: null } })], { liveById }),
      ),
    ).toBeNull();
  });

  it('refuses an add proposing a container kind with a difficulty, and its default kind is a leaf', () => {
    expect(
      grammarReasonOf(() =>
        validate([add('p1', { proposedFields: { kind: 'epic', difficulty: 'low' } })]),
      ),
    ).toBe('difficulty_on_container');
    expect(
      grammarReasonOf(() =>
        validate([add('p1', { proposedFields: { kind: 'story', difficulty: 'medium' } })]),
      ),
    ).toBe('difficulty_on_container');
    // No `kind` → `DEFAULT_PROPOSED_KIND` (`task`), a leaf.
    expect(
      grammarReasonOf(() => validate([add('p1', { proposedFields: { difficulty: 'high' } })])),
    ).toBeNull();
  });
});

describe('validatePlanProposals — cross-project refs (MOTIR-3581)', () => {
  // The product supports a cross-PROJECT dependency and forbids a cross-project
  // PARENT, and the two are asserted TOGETHER because the bug was that one
  // mechanism — a project-narrowed read — silently applied the parent rule to
  // dependencies. A test for either one alone passes with that bug present.
  const CROSS = 'wi_cross_project';
  const crossLive = liveMap(
    live({ id: REAL_PARENT }),
    live({ id: REAL_TARGET }),
    // A `story`, so `story -> task` is a LEGAL pair and the kind-parent grammar
    // (step 3) has nothing to say — the only thing wrong with it as a parent is
    // the project. A `task` here passes the parent case for the WRONG reason.
    live({ id: CROSS, projectId: OTHER_PROJECT, kind: 'story' }),
  );

  it("ACCEPTS an add's blockedByRefs naming a work item in another project of the workspace", () => {
    expect(() =>
      validate([add('p1', { blockedByRefs: [CROSS] })], { liveById: crossLive }),
    ).not.toThrow();
  });

  it("ACCEPTS a modify's patch.blockedByAdd naming a cross-project work item", () => {
    expect(() =>
      validate([modify('m1', { patch: { blockedByAdd: [CROSS] } })], { liveById: crossLive }),
    ).not.toThrow();
  });

  it("ACCEPTS a modify's patch.blockedByRemove naming a cross-project work item", () => {
    expect(() =>
      validate([modify('m1', { patch: { blockedByRemove: [CROSS] } })], { liveById: crossLive }),
    ).not.toThrow();
  });

  it('REFUSES a parentRef naming a cross-project work item, as an illegal PLACEMENT', () => {
    try {
      validate([add('p1', { parentRef: CROSS })], { liveById: crossLive });
      expect.unreachable('a cross-project parentRef must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      expect((err as PlanGrammarError).reason).toBe('illegal_parent');
    }
  });

  it('says WHY, and does not repeat the false "no work item in this workspace" claim', () => {
    // The expensive half of the original defect was the MESSAGE: it asserted
    // something the caller could observe to be false. Whatever the refusal is, it
    // may not send the reader looking for a missing row.
    try {
      validate([add('p1', { parentRef: CROSS })], { liveById: crossLive });
      expect.unreachable('a cross-project parentRef must be rejected');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('names no work item in this workspace');
      expect(message).toContain('DIFFERENT project');
      expect(message).toContain('blockedByRefs');
    }
  });

  it('still refuses a ref that resolves to NOTHING — with `dangling`, unchanged', () => {
    try {
      validate([add('p1', { blockedByRefs: ['wi_nowhere'] })], { liveById: crossLive });
      expect.unreachable('a ref resolving to nothing must still be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('dangling');
    }
  });

  it('leaves a SAME-project parentRef alone (the check is tenancy, not a new grammar rule)', () => {
    expect(() =>
      validate([add('p1', { proposedFields: { kind: 'task' }, parentRef: REAL_PARENT })], {
        liveById: crossLive,
      }),
    ).not.toThrow();
  });
});

describe('validatePlanProposals — the intra-plan ref graph', () => {
  it('rejects a parentRef naming no add in the plan', () => {
    try {
      validate([add('p1', { parentRef: `${TEMP_REF_PREFIX}ghost` })]);
      expect.unreachable('a dangling temp parentRef must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('dangling');
      expect((err as PlanRefGraphError).code).toBe('INVALID_PLAN_REF_GRAPH');
    }
  });

  it('rejects a parentRef naming a work item outside this workspace', () => {
    expect(() =>
      validate([add('p1', { parentRef: 'wi_elsewhere' })], { liveById: liveMap() }),
    ).toThrow(PlanRefGraphError);
  });

  it('rejects a dangling blockedByRef (temp and real alike)', () => {
    expect(() => validate([add('p1', { blockedByRefs: [`${TEMP_REF_PREFIX}ghost`] })])).toThrow(
      PlanRefGraphError,
    );
    expect(() =>
      validate([add('p1', { blockedByRefs: ['wi_ghost'] })], { liveById: liveMap() }),
    ).toThrow(PlanRefGraphError);
  });

  it('rejects a dangling ref inside a modify patch, either side', () => {
    expect(() =>
      validate([modify('m1', { patch: { blockedByAdd: [`${TEMP_REF_PREFIX}ghost`] } })]),
    ).toThrow(PlanRefGraphError);
    expect(() => validate([modify('m1', { patch: { blockedByRemove: ['wi_ghost'] } })])).toThrow(
      PlanRefGraphError,
    );
  });

  it('accepts modify patch refs that resolve (a null patch is a no-op)', () => {
    expect(() =>
      validate([
        add('a1'),
        modify('m1', {
          patch: { blockedByAdd: [`${TEMP_REF_PREFIX}a1`], blockedByRemove: [REAL_PARENT] },
        }),
        modify('m2', { patch: null }),
      ]),
    ).not.toThrow();
  });

  it('rejects the same blocker listed twice (the is_blocked_by edge is unique)', () => {
    try {
      validate([add('p1', { blockedByRefs: [REAL_TARGET, REAL_TARGET] })]);
      expect.unreachable('a duplicate blockedByRef must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('duplicate');
    }
  });

  it('rejects a proposal that references ITSELF', () => {
    try {
      validate([add('p1', { blockedByRefs: [`${TEMP_REF_PREFIX}p1`] })]);
      expect.unreachable('a self-reference must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('cycle');
    }
  });

  it('rejects a parentRef CYCLE (no parent-before-child order exists)', () => {
    try {
      validate([
        add('a', { parentRef: `${TEMP_REF_PREFIX}b`, proposedFields: { kind: 'story' } }),
        add('b', { parentRef: `${TEMP_REF_PREFIX}a`, proposedFields: { kind: 'story' } }),
      ]);
      expect.unreachable('a parentRef cycle must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('cycle');
    }
  });

  it('rejects a LONGER parentRef cycle (a → b → c → a)', () => {
    expect(() =>
      validate([
        add('a', { parentRef: `${TEMP_REF_PREFIX}c`, proposedFields: { kind: 'story' } }),
        add('b', { parentRef: `${TEMP_REF_PREFIX}a`, proposedFields: { kind: 'story' } }),
        add('c', { parentRef: `${TEMP_REF_PREFIX}b`, proposedFields: { kind: 'story' } }),
      ]),
    ).toThrow(PlanRefGraphError);
  });

  it('accepts a deep intra-plan chain regardless of the proposals order', () => {
    // Child listed FIRST — order in the plan imposes nothing; only the ref graph does.
    expect(() =>
      validate([
        add('leaf', {
          parentRef: `${TEMP_REF_PREFIX}mid`,
          proposedFields: { kind: 'subtask' },
        }),
        add('mid', { parentRef: `${TEMP_REF_PREFIX}root`, proposedFields: { kind: 'story' } }),
        add('root', { proposedFields: { kind: 'epic' } }),
      ]),
    ).not.toThrow();
  });

  it('accepts a diamond — two children under one parent is not a cycle', () => {
    expect(() =>
      validate([
        add('root', { proposedFields: { kind: 'story' } }),
        add('c1', { parentRef: `${TEMP_REF_PREFIX}root`, proposedFields: { kind: 'task' } }),
        add('c2', {
          parentRef: `${TEMP_REF_PREFIX}root`,
          proposedFields: { kind: 'task' },
          blockedByRefs: [`${TEMP_REF_PREFIX}c1`],
        }),
      ]),
    ).not.toThrow();
  });
});

describe('validatePlanProposals — done-work immutability', () => {
  it('rejects a modify targeting a terminal work item', () => {
    try {
      validate([modify('m1')], {
        liveById: liveMap(live({ id: REAL_TARGET, status: 'done' })),
      });
      expect.unreachable('a modify of done work must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanTargetImmutableError);
      expect((err as PlanTargetImmutableError).planItemId).toBe('m1');
      expect((err as PlanTargetImmutableError).workItemId).toBe(REAL_TARGET);
      expect((err as PlanTargetImmutableError).status).toBe('done');
      expect((err as PlanTargetImmutableError).code).toBe('PLAN_TARGET_IMMUTABLE');
    }
  });

  it('rejects a remove targeting a terminal work item', () => {
    expect(() =>
      validate([modify('r1', { op: 'remove' })], {
        liveById: liveMap(live({ id: REAL_TARGET, status: 'done' })),
      }),
    ).toThrow(PlanTargetImmutableError);
  });

  it('is keyed on the `done` CATEGORY, not the `done` key — `cancelled` is terminal too', () => {
    expect(() =>
      validate([modify('m1')], {
        liveById: liveMap(live({ id: REAL_TARGET, status: 'cancelled' })),
      }),
    ).toThrow(PlanTargetImmutableError);
  });

  it('accepts a modify/remove of a non-terminal target', () => {
    expect(() =>
      validate([modify('m1'), modify('r1', { op: 'remove' })], {
        liveById: liveMap(live({ id: REAL_TARGET, status: 'in_review' })),
      }),
    ).not.toThrow();
  });

  it('leaves a target that resolves to nothing to materialize (which rolls back)', () => {
    // Note the ref check does NOT cover `workItemId` — a target archived out from
    // under the plan is the 7.21.3 staleness concern, surfaced by materialize as
    // `PlanItemTargetMissingError` inside the (rolled-back) transaction.
    expect(() => validate([modify('m1', { workItemId: null })])).not.toThrow();
  });

  it('does not gate an `add` on immutability (it targets nothing)', () => {
    expect(() =>
      validate([add('p1')], { terminalStatusKeys: new Set(['done', 'cancelled', 'todo']) }),
    ).not.toThrow();
  });
});

describe('validatePlanProposals — a MARK-ONLY `modify` may reach a terminal target (MOTIR-6629)', () => {
  const MARK_ONLY_PATCHES: ProposalNode['patch'][] = [
    { obsolescence: 'outdated' },
    { obsolescence: 'deprecated', obsolescenceNoteMd: 'Replaced by the new flow.' },
    { obsolescenceNoteMd: 'Why it is marked.' },
    { obsolescence: null, obsolescenceNoteMd: null },
  ];

  it.each(['done', 'cancelled'])(
    'ADMITS a modify carrying only mark keys on a `%s` target',
    (status) => {
      for (const patch of MARK_ONLY_PATCHES) {
        expect(() =>
          validate([modify('m1', { patch })], {
            liveById: liveMap(live({ id: REAL_TARGET, status })),
          }),
        ).not.toThrow();
      }
    },
  );

  it('still REFUSES a modify of a terminal target carrying ANY key beside the mark', () => {
    for (const patch of [
      { title: 'Rewritten', obsolescence: 'outdated' },
      { obsolescence: 'deprecated', parentRef: null },
      { obsolescenceNoteMd: 'n', blockedByAdd: [REAL_PARENT] },
    ] as ProposalNode['patch'][]) {
      expect(() =>
        validate([modify('m1', { patch })], {
          liveById: liveMap(live({ id: REAL_TARGET, status: 'done' }), live({ id: REAL_PARENT })),
        }),
      ).toThrow(PlanTargetImmutableError);
    }
  });

  it('counts a key the gate does not TYPE against the carve-out — the whole key set is read', () => {
    const patch = { obsolescence: 'outdated', storyPoints: 3 } as unknown as ProposalNode['patch'];
    expect(() =>
      validate([modify('m1', { patch })], {
        liveById: liveMap(live({ id: REAL_TARGET, status: 'done' })),
      }),
    ).toThrow(PlanTargetImmutableError);
  });

  it('still REFUSES an empty patch on a terminal target — it marks nothing', () => {
    expect(() =>
      validate([modify('m1', { patch: {} })], {
        liveById: liveMap(live({ id: REAL_TARGET, status: 'done' })),
      }),
    ).toThrow(PlanTargetImmutableError);
  });

  it('still REFUSES a `remove` of a terminal target, whatever its row carries', () => {
    expect(() =>
      validate([modify('r1', { op: 'remove', patch: { obsolescence: 'deprecated' } })], {
        liveById: liveMap(live({ id: REAL_TARGET, status: 'done' })),
      }),
    ).toThrow(PlanTargetImmutableError);
  });
});

describe('validatePlanProposals — a MARK lands only on a FINISHED target (MOTIR-6663)', () => {
  it.each([
    ['outdated', 'todo'],
    ['deprecated', 'todo'],
    ['outdated', 'in_progress'],
    ['deprecated', 'in_progress'],
  ])(
    'REFUSES `%s` on a target at `%s`, naming the target and pointing at `remove`',
    (mark, status) => {
      let caught: unknown;
      try {
        validate([modify('m1', { patch: { obsolescence: mark } })], {
          liveById: liveMap(live({ id: REAL_TARGET, status })),
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidProposalError);
      const err = caught as InvalidProposalError;
      expect(err.code).toBe('INVALID_PROPOSAL');
      expect(err.planItemId).toBe('m1');
      expect(err.message).toBe(
        `the \`modify\` of work item ${REAL_TARGET}: a plan may mark only a finished work item; ` +
          `MOTIR-${REAL_TARGET} is at ${status}. A work item nobody will finish is removed — ` +
          "send `{ op: 'remove', workItemId, reason }` instead.",
      );
    },
  );

  it('ADMITS clearing the mark (`null`) and a patch that leaves it alone on a to-do target', () => {
    for (const patch of [
      { obsolescence: null },
      { obsolescence: null, obsolescenceNoteMd: null },
      { obsolescenceNoteMd: 'Only the note.' },
      { title: 'Rewritten' },
    ] as ProposalNode['patch'][]) {
      expect(() =>
        validate([modify('m1', { patch })], {
          liveById: liveMap(live({ id: REAL_TARGET, status: 'todo' })),
        }),
      ).not.toThrow();
    }
  });

  it('reads the CATEGORY, never the key — a custom done-category `shipped` is finished', () => {
    const shipped = liveMap(live({ id: REAL_TARGET, status: 'shipped' }));
    expect(() =>
      validate([modify('m1', { patch: { obsolescence: 'deprecated' } })], {
        liveById: shipped,
        terminalStatusKeys: new Set(['shipped']),
        markTargetStatusCategoryById: new Map([[REAL_TARGET, 'done']]),
      }),
    ).not.toThrow();
    // ...and a status literally keyed `done` whose category is NOT done is not.
    expect(() =>
      validate([modify('m1', { patch: { obsolescence: 'deprecated' } })], {
        liveById: liveMap(live({ id: REAL_TARGET, status: 'done' })),
        terminalStatusKeys: new Set(['shipped']),
        markTargetStatusCategoryById: new Map([[REAL_TARGET, 'in_progress']]),
      }),
    ).toThrow(InvalidProposalError);
  });

  it('fails SAFE — a mark target with no resolved category reads as not finished', () => {
    expect(() =>
      validate([modify('m1', { patch: { obsolescence: 'outdated' } })], {
        liveById: liveMap(live({ id: REAL_TARGET, status: 'done' })),
        markTargetStatusCategoryById: new Map(),
      }),
    ).toThrow(InvalidProposalError);
  });

  it('leaves a target that resolves to nothing to materialize', () => {
    expect(() =>
      validate([modify('m1', { patch: { obsolescence: 'outdated' } })], {
        liveById: new Map(),
      }),
    ).not.toThrow();
  });
});

describe('validatePlanProposals — a `modify` RE-PARENTS its target (MOTIR-3859)', () => {
  // AMENDMENT 11. The five guards a re-parent owes, each one on its own, written
  // against the CONTRACT rather than against the implementation — the same
  // discipline the kind-parent cases above follow.
  const NEW_PARENT = 'wi_new_parent';

  /** A `modify` of `REAL_TARGET` proposing `parentRef`. */
  function reparent(ref: string | null, overrides: Partial<ProposalNode> = {}): ProposalNode {
    return modify('m1', { patch: { parentRef: ref }, ...overrides });
  }

  it('accepts a legal move — a subtask from one story to another', () => {
    expect(() =>
      validate([reparent(NEW_PARENT)], {
        liveById: liveMap(
          live({ id: REAL_TARGET, kind: 'subtask' }),
          live({ id: NEW_PARENT, kind: 'story' }),
        ),
      }),
    ).not.toThrow();
  });

  it('leaves the parent alone when the patch OMITS the key — absent is not `null`', () => {
    // The whole sparse contract in one case: a patch that touches something else
    // must not be read as proposing a move to the root.
    expect(() =>
      validate([modify('m1', { patch: { blockedByAdd: [] } })], {
        liveById: liveMap(live({ id: REAL_TARGET, kind: 'subtask' })),
      }),
    ).not.toThrow();
  });

  it('an explicit `null` is a move to the ROOT, and the kind decides whether that is legal', () => {
    expect(() =>
      validate([reparent(null)], { liveById: liveMap(live({ id: REAL_TARGET, kind: 'task' })) }),
    ).not.toThrow();

    try {
      validate([reparent(null)], { liveById: liveMap(live({ id: REAL_TARGET, kind: 'subtask' })) });
      expect.unreachable('a subtask has no legal top-level placement');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      expect((err as PlanGrammarError).reason).toBe('illegal_parent');
    }
  });

  it('refuses a KIND-ILLEGAL placement, through the same matrix every human move is gated on', () => {
    try {
      validate([reparent(NEW_PARENT)], {
        liveById: liveMap(
          live({ id: REAL_TARGET, kind: 'story' }),
          live({ id: NEW_PARENT, kind: 'subtask' }),
        ),
      });
      expect.unreachable('a story may not be parented to a subtask');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      expect((err as PlanGrammarError).reason).toBe('illegal_parent');
      expect((err as PlanGrammarError).planItemId).toBe('m1');
    }
  });

  it('refuses a parent in ANOTHER PROJECT — and says which question it is answering', () => {
    try {
      validate([reparent(NEW_PARENT)], {
        liveById: liveMap(
          live({ id: REAL_TARGET, kind: 'subtask' }),
          live({ id: NEW_PARENT, kind: 'story', projectId: OTHER_PROJECT }),
        ),
      });
      expect.unreachable('parentage is same-project by invariant');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      expect((err as PlanGrammarError).reason).toBe('illegal_parent');
      expect((err as Error).message).toContain('DIFFERENT project');
    }
  });

  it('refuses a move onto the target ITSELF', () => {
    try {
      validate([reparent(REAL_TARGET)], {
        liveById: liveMap(live({ id: REAL_TARGET, kind: 'story' })),
      });
      expect.unreachable('a card may not be its own parent');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('cycle');
      expect((err as Error).message).toContain('ITSELF');
    }
  });

  it('refuses a move onto a DESCENDANT — read off the new parent ancestor chain', () => {
    try {
      validate([reparent(NEW_PARENT)], {
        liveById: liveMap(
          live({ id: REAL_TARGET, kind: 'story' }),
          live({ id: NEW_PARENT, kind: 'task' }),
        ),
        // The proposed parent sits UNDER the target: moving the target beneath it
        // closes a cycle.
        ancestorIdsById: new Map([[NEW_PARENT, [REAL_TARGET, 'wi_root']]]),
      });
      expect.unreachable('the move would create a cycle');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('cycle');
      expect((err as Error).message).toContain('DESCENDANT');
    }
  });

  it('refuses a move past the DEPTH CAP, with the trigger own arithmetic', () => {
    try {
      validate([reparent(NEW_PARENT)], {
        liveById: liveMap(
          live({ id: REAL_TARGET, kind: 'subtask' }),
          live({ id: NEW_PARENT, kind: 'bug' }),
        ),
        // The parent has three ancestors, so it sits at depth 4 and the moved row
        // would land at 5 — `ancestor_depth + 1 > 4` in the trigger's terms.
        ancestorIdsById: new Map([[NEW_PARENT, ['wi_a', 'wi_b', 'wi_c']]]),
      });
      expect.unreachable('the move exceeds the depth limit');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      expect((err as PlanGrammarError).reason).toBe('parent_depth_limit');
      expect((err as Error).message).toContain('depth 5');
    }
  });

  it('ACCEPTS the deepest LEGAL move — the cap is a boundary, not an approximation', () => {
    expect(() =>
      validate([reparent(NEW_PARENT)], {
        liveById: liveMap(
          live({ id: REAL_TARGET, kind: 'subtask' }),
          live({ id: NEW_PARENT, kind: 'bug' }),
        ),
        // Two ancestors → the parent is at depth 3 and the row lands at 4.
        ancestorIdsById: new Map([[NEW_PARENT, ['wi_a', 'wi_b']]]),
      }),
    ).not.toThrow();
  });

  it('refuses a TERMINAL parent, naming its status', () => {
    try {
      validate([reparent(NEW_PARENT)], {
        liveById: liveMap(
          live({ id: REAL_TARGET, kind: 'subtask' }),
          live({ id: NEW_PARENT, kind: 'story', status: 'done' }),
        ),
      });
      expect.unreachable('a finished parent may not gain a new open child');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      expect((err as PlanGrammarError).reason).toBe('parent_terminal');
      expect((err as Error).message).toContain('"done"');
    }
  });

  it('is keyed on the terminal CATEGORY — `cancelled` is a terminal parent too', () => {
    expect(() =>
      validate([reparent(NEW_PARENT)], {
        liveById: liveMap(
          live({ id: REAL_TARGET, kind: 'subtask' }),
          live({ id: NEW_PARENT, kind: 'story', status: 'cancelled' }),
        ),
      }),
    ).toThrow(PlanGrammarError);
  });

  describe('under a PROPOSED `add` — AMENDMENT 18 §1 (MOTIR-6050)', () => {
    // AMENDMENT 11 D2 refused this outright. The same five guards now read the
    // PROJECTED parent: the `add`'s kind, its proposed ancestors, and the
    // committed ANCHOR its chain is created under.
    const ANCHOR = 'wi_anchor';
    const under = (addId: string): ProposalNode =>
      modify('m1', { patch: { parentRef: `${TEMP_REF_PREFIX}${addId}` } });

    it('accepts a subtask moved under a proposed story that hangs under a live epic', () => {
      expect(() =>
        validate(
          [add('s1', { proposedFields: { kind: 'story' }, parentRef: ANCHOR }), under('s1')],
          {
            liveById: liveMap(
              live({ id: REAL_TARGET, kind: 'subtask' }),
              live({ id: ANCHOR, kind: 'epic' }),
            ),
          },
        ),
      ).not.toThrow();
    });

    it("refuses a kind the proposed `add` may not parent, read off the add's own kind", () => {
      try {
        validate(
          [add('s1', { proposedFields: { kind: 'subtask' }, parentRef: ANCHOR }), under('s1')],
          {
            liveById: liveMap(
              live({ id: REAL_TARGET, kind: 'story' }),
              live({ id: ANCHOR, kind: 'story' }),
            ),
          },
        );
        expect.unreachable('a story may not hang under a proposed subtask');
      } catch (err) {
        expect(err).toBeInstanceOf(PlanGrammarError);
        expect((err as PlanGrammarError).reason).toBe('illegal_parent');
        expect((err as PlanGrammarError).planItemId).toBe('m1');
      }
    });

    it('defaults a kindless proposed parent to `task`, the way materialize does', () => {
      // A task may hold a subtask but not a story.
      expect(() =>
        validate([add('s1', { proposedFields: null }), under('s1')], {
          liveById: liveMap(live({ id: REAL_TARGET, kind: 'subtask' })),
        }),
      ).not.toThrow();
      expect(() =>
        validate([add('s1', { proposedFields: null }), under('s1')], {
          liveById: liveMap(live({ id: REAL_TARGET, kind: 'story' })),
        }),
      ).toThrow(PlanGrammarError);
    });

    it('counts depth over the PROPOSED ancestors and then the committed chain', () => {
      // epic(anchor, depth 1) → story s1 (proposed, 2) → task t1 (proposed, 3)
      // → the moved subtask at 4: legal.
      const legal = [
        add('s1', { proposedFields: { kind: 'story' }, parentRef: ANCHOR }),
        add('t1', { proposedFields: { kind: 'task' }, parentRef: `${TEMP_REF_PREFIX}s1` }),
        under('t1'),
      ];
      const lv = liveMap(
        live({ id: REAL_TARGET, kind: 'subtask' }),
        live({ id: ANCHOR, kind: 'epic' }),
      );
      expect(() => validate(legal, { liveById: lv })).not.toThrow();

      // The same chain one level lower — the anchor now has a live ancestor —
      // lands the row at depth 5.
      try {
        validate(legal, { liveById: lv, ancestorIdsById: new Map([[ANCHOR, ['wi_root']]]) });
        expect.unreachable('the move exceeds the depth limit');
      } catch (err) {
        expect(err).toBeInstanceOf(PlanGrammarError);
        expect((err as PlanGrammarError).reason).toBe('parent_depth_limit');
        expect((err as Error).message).toContain('depth 5');
      }
    });

    it("refuses a CYCLE a proposal can create — an `add` under the moving card's own child", () => {
      // X (the target) → C (its live child). The plan adds A under C, then moves
      // X under A: walking up from A reaches C and then X.
      const CHILD = 'wi_child';
      try {
        validate(
          [add('a1', { proposedFields: { kind: 'subtask' }, parentRef: CHILD }), under('a1')],
          {
            liveById: liveMap(
              live({ id: REAL_TARGET, kind: 'story' }),
              live({ id: CHILD, kind: 'task' }),
            ),
            ancestorIdsById: new Map([[CHILD, [REAL_TARGET]]]),
          },
        );
        expect.unreachable('the move would create a cycle');
      } catch (err) {
        expect(err).toBeInstanceOf(PlanRefGraphError);
        expect((err as PlanRefGraphError).reason).toBe('cycle');
        expect((err as Error).message).toContain('BELOW');
      }
    });

    it('refuses when the committed ANCHOR the proposal is created under is terminal', () => {
      try {
        validate(
          [add('s1', { proposedFields: { kind: 'story' }, parentRef: ANCHOR }), under('s1')],
          {
            liveById: liveMap(
              live({ id: REAL_TARGET, kind: 'subtask' }),
              live({ id: ANCHOR, kind: 'epic', status: 'done' }),
            ),
          },
        );
        expect.unreachable('a finished anchor may not gain a new open subtree');
      } catch (err) {
        expect(err).toBeInstanceOf(PlanGrammarError);
        expect((err as PlanGrammarError).reason).toBe('parent_terminal');
        expect((err as Error).message).toContain('"done"');
      }
    });

    it('accepts a proposed parent FILED in a folder — a filed card is a root', () => {
      expect(() =>
        validate(
          [add('s1', { proposedFields: { kind: 'story' }, parentRef: 'folder:f1' }), under('s1')],
          {
            liveById: liveMap(live({ id: REAL_TARGET, kind: 'task' })),
            folderById: new Map([['f1', { id: 'f1', projectId: PLAN_PROJECT, name: 'Inbox' }]]),
          },
        ),
      ).not.toThrow();
    });

    it('refuses a temp-ref naming a `modify` or `remove` — only an `add` is a parent', () => {
      try {
        validate(
          [modify('m0', { workItemId: 'wi_other', patch: { blockedByAdd: [] } }), under('m0')],
          {
            liveById: liveMap(
              live({ id: REAL_TARGET, kind: 'subtask' }),
              live({ id: 'wi_other', kind: 'story' }),
            ),
          },
        );
        expect.unreachable('a modify is not a parent');
      } catch (err) {
        expect(err).toBeInstanceOf(PlanRefGraphError);
        expect((err as PlanRefGraphError).reason).toBe('dangling');
      }
    });
  });

  it('reports a parent that RESOLVES TO NOTHING as a dangling ref, not as a grammar violation', () => {
    // The ordered gate's own discipline: a malformed plan fails with the MOST
    // specific reason, and "this ref names nothing" is more specific than "this
    // placement is illegal".
    try {
      validate([reparent('wi_ghost')], {
        liveById: liveMap(live({ id: REAL_TARGET, kind: 'subtask' })),
      });
      expect.unreachable('a dangling parentRef is refused');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('dangling');
      expect((err as Error).message).toContain('patch.parentRef');
    }
  });

  it('leaves a target that resolves to nothing to materialize, exactly as step 4 does', () => {
    expect(() =>
      validate([reparent(NEW_PARENT, { workItemId: 'wi_ghost_target' })], {
        liveById: liveMap(live({ id: NEW_PARENT, kind: 'story' })),
      }),
    ).not.toThrow();
  });

  it('does not read `patch.parentRef` on an op that is not a `modify`', () => {
    // A `remove` carries no patch and an `add` places itself through `parentRef`.
    // The guard is on the OP, so a stray patch on either must change nothing.
    expect(() =>
      validate([modify('r1', { op: 'remove', patch: { parentRef: 'wi_ghost' } })], {
        liveById: liveMap(live({ id: REAL_TARGET })),
      }),
    ).not.toThrow();
  });
});

describe('assertProposalSetSelfConsistent — the PURE half, which runs at the APPEND', () => {
  // MOTIR-3573. `plansService.addProposals` calls this before its first insert,
  // and `validatePlanProposals` calls it as its own step 1 — one implementation,
  // so the two stages cannot disagree about what a self-consistent plan is.
  //
  // ⚠️ Its SIGNATURE is the contract: no `liveById`, no `terminalStatusKeys`.
  // A function that cannot see the workspace cannot be tempted to read it, which
  // is what makes it affordable on every append.

  it('accepts an empty set, and a set of plain top-level adds', () => {
    expect(() => assertProposalSetSelfConsistent([])).not.toThrow();
    expect(() => assertProposalSetSelfConsistent([add('a'), add('b')])).not.toThrow();
  });

  it('rejects the same blocker listed twice, naming the proposal', () => {
    try {
      assertProposalSetSelfConsistent([add('a', { blockedByRefs: [REAL_TARGET, REAL_TARGET] })]);
      expect.unreachable('a duplicated blocker must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('duplicate');
      expect((err as PlanRefGraphError).planItemId).toBe('a');
    }
  });

  it('rejects a duplicate on EITHER side of a modify patch', () => {
    for (const where of ['blockedByAdd', 'blockedByRemove'] as const) {
      expect(() =>
        assertProposalSetSelfConsistent([
          modify('m', { patch: { [where]: [REAL_TARGET, REAL_TARGET] } }),
        ]),
      ).toThrow(PlanRefGraphError);
    }
  });

  it('rejects a proposal that references ITSELF', () => {
    try {
      assertProposalSetSelfConsistent([add('a', { blockedByRefs: [`${TEMP_REF_PREFIX}a`] })]);
      expect.unreachable('a self-reference must be refused');
    } catch (err) {
      expect((err as PlanRefGraphError).reason).toBe('cycle');
    }
  });

  it('rejects a parentRef CYCLE, at two lengths', () => {
    const pair = [
      add('a', { parentRef: `${TEMP_REF_PREFIX}b` }),
      add('b', { parentRef: `${TEMP_REF_PREFIX}a` }),
    ];
    expect(() => assertProposalSetSelfConsistent(pair)).toThrow(PlanRefGraphError);

    const triple = [
      add('a', { parentRef: `${TEMP_REF_PREFIX}b` }),
      add('b', { parentRef: `${TEMP_REF_PREFIX}c` }),
      add('c', { parentRef: `${TEMP_REF_PREFIX}a` }),
    ];
    expect(() => assertProposalSetSelfConsistent(triple)).toThrow(PlanRefGraphError);
  });

  it('accepts a deep chain and a diamond — neither is a cycle', () => {
    expect(() =>
      assertProposalSetSelfConsistent([
        add('c', { parentRef: `${TEMP_REF_PREFIX}b` }),
        add('b', { parentRef: `${TEMP_REF_PREFIX}a` }),
        add('a'),
      ]),
    ).not.toThrow();
    expect(() =>
      assertProposalSetSelfConsistent([
        add('a'),
        add('b', { parentRef: `${TEMP_REF_PREFIX}a` }),
        add('c', { parentRef: `${TEMP_REF_PREFIX}a` }),
      ]),
    ).not.toThrow();
  });

  it('⚠️ IGNORES a REAL ref that resolves to nothing — that arm needs a read, so it belongs to the CLOSE', () => {
    // The whole reason the pure half can run on every append: it never asks a
    // question whose answer lives in the workspace. `markPlanned` catches this.
    expect(() =>
      assertProposalSetSelfConsistent([add('a', { parentRef: 'wi_does_not_exist' })]),
    ).not.toThrow();
    expect(() =>
      assertProposalSetSelfConsistent([add('a', { blockedByRefs: ['wi_does_not_exist'] })]),
    ).not.toThrow();
  });

  it('⚠️ IGNORES a temp-ref naming no add in the set — same reason, one axis over', () => {
    // Deliberate: at the append the batch's own proposals have no ids yet, so a
    // temp-ref pointing "forward" is indistinguishable from one pointing at a
    // proposal this call is about to write. `assertRefsResolvable` decides it.
    expect(() =>
      assertProposalSetSelfConsistent([add('a', { parentRef: `${TEMP_REF_PREFIX}later` })]),
    ).not.toThrow();
  });

  it('is what `validatePlanProposals` runs — the same rejection arrives through the full gate', () => {
    try {
      validate([add('a', { blockedByRefs: [REAL_TARGET, REAL_TARGET] })]);
      expect.unreachable('the full gate must inherit the pure verdict');
    } catch (err) {
      expect((err as PlanRefGraphError).reason).toBe('duplicate');
    }
  });
});

describe('collectReferencedWorkItemIds', () => {
  it('collects every REAL id a plan references, deduplicated, and no temp refs', () => {
    const ids = collectReferencedWorkItemIds([
      add('a1', { parentRef: 'wi_1', blockedByRefs: ['wi_2', `${TEMP_REF_PREFIX}a2`] }),
      add('a2', { parentRef: `${TEMP_REF_PREFIX}a1` }),
      modify('m1', {
        workItemId: 'wi_3',
        patch: { blockedByAdd: ['wi_1'], blockedByRemove: ['wi_4'] },
      }),
      modify('r1', { op: 'remove', workItemId: 'wi_5', patch: { blockedByAdd: ['wi_6'] } }),
    ]);
    // `wi_1` appears twice in the input and once here; `r1` is a remove, so its
    // patch is never read by the gate — but collecting its refs is harmless.
    expect([...ids].sort()).toEqual(['wi_1', 'wi_2', 'wi_3', 'wi_4', 'wi_5', 'wi_6']);
  });

  it('returns nothing for a plan of top-level adds', () => {
    expect(collectReferencedWorkItemIds([add('a1'), add('a2')])).toEqual([]);
  });
});

// ── THE `blocked_by` EDGE GRAPH (MOTIR-3936) ──────────────────────────────────
//
// The cases above read the `planItem:` REF graph. These read the EDGES the plan
// would WRITE — which is the graph `enforce_work_item_link_no_cycle` judges, and
// the one that produced a bare 500 at approve on 2026-08-30 after three separate
// checks called the plan valid.
describe('validatePlanProposals — the blocked_by edge graph', () => {
  const A = 'wi_a';
  const B = 'wi_b';
  const C = 'wi_c';
  const threeLive = liveMap(live({ id: A }), live({ id: B }), live({ id: C }));

  it('refuses TWO `modify` patches writing opposite directions of one edge — the 2026-08-30 fixture', () => {
    // Neither patch is wrong on its own, neither names a `planItem:` ref, and no
    // per-proposal read can see the pair. This is the shape the card exists for.
    let thrown: unknown;
    try {
      validate(
        [
          modify('m1', { workItemId: A, patch: { blockedByAdd: [B] } }),
          modify('m2', { workItemId: B, patch: { blockedByAdd: [A] } }),
        ],
        { liveById: threeLive },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PlanRefGraphError);
    expect((thrown as PlanRefGraphError).reason).toBe('cycle');
  });

  it('names BOTH work items by key and title in the cycle message, not only a proposal id', () => {
    expect(() =>
      validate(
        [
          modify('m1', { workItemId: A, patch: { blockedByAdd: [B] } }),
          modify('m2', { workItemId: B, patch: { blockedByAdd: [A] } }),
        ],
        { liveById: threeLive },
      ),
    ).toThrow(/MOTIR-wi_a "The wi_a card"[\s\S]*MOTIR-wi_b "The wi_b card"/);
  });

  it('refuses ONE proposed edge that closes a ring through COMMITTED edges', () => {
    // B is already blocked by C, and C by A. Adding `A blocked_by B` closes it —
    // invisible to every per-proposal read, and to any check over the plan alone.
    expect(() =>
      validate([modify('m1', { workItemId: A, patch: { blockedByAdd: [B] } })], {
        liveById: threeLive,
        existingBlockedByEdges: [
          { blockedId: B, blockerId: C },
          { blockedId: C, blockerId: A },
        ],
      }),
    ).toThrow(PlanRefGraphError);
  });

  it('accepts the SAME edge when the plan REMOVES the link that would close the ring', () => {
    // The plan is judged on the graph it LEAVES, so a swap is legal.
    expect(() =>
      validate(
        [
          modify('m1', { workItemId: A, patch: { blockedByAdd: [B] } }),
          modify('m2', { workItemId: C, patch: { blockedByRemove: [A] } }),
        ],
        {
          liveById: threeLive,
          existingBlockedByEdges: [
            { blockedId: B, blockerId: C },
            { blockedId: C, blockerId: A },
          ],
        },
      ),
    ).not.toThrow();
  });

  it('refuses a cycle among the plan’s own `add`s, through their temp-refs', () => {
    expect(() =>
      validate([
        add('a1', { blockedByRefs: [`${TEMP_REF_PREFIX}a2`] }),
        add('a2', { blockedByRefs: [`${TEMP_REF_PREFIX}a1`] }),
      ]),
    ).toThrow(PlanRefGraphError);
  });

  it('names a PROPOSED card by its temp ref and title on the ring', () => {
    expect(() =>
      validate([
        add('a1', {
          blockedByRefs: [`${TEMP_REF_PREFIX}a2`],
          proposedFields: { kind: 'task', title: 'The first half' },
        }),
        add('a2', {
          blockedByRefs: [`${TEMP_REF_PREFIX}a1`],
          proposedFields: { kind: 'task', title: 'The second half' },
        }),
      ]),
    ).toThrow(/The first half[\s\S]*The second half/);
  });

  it('leaves a SELF edge to the self-link trigger rather than reporting it as a cycle', () => {
    // `assertRefsSelfConsistent` catches a proposal naming ITSELF through a temp
    // ref; a `modify` naming its own target is a different shape, and calling it
    // a "cycle" would report the wrong reason for what `WI_LINK_SELF` refuses.
    expect(() =>
      validate([modify('m1', { workItemId: A, patch: { blockedByAdd: [A] } })], {
        liveById: threeLive,
      }),
    ).not.toThrow();
  });

  it('collapses a proposed edge that DUPLICATES a committed one', () => {
    // Re-proposing an edge that already exists is not a cycle and not a
    // duplicate within the proposal — it is a no-op the graph already holds.
    expect(() =>
      validate([modify('m1', { workItemId: A, patch: { blockedByAdd: [B] } })], {
        liveById: threeLive,
        existingBlockedByEdges: [{ blockedId: A, blockerId: B }],
      }),
    ).not.toThrow();
  });

  it('accepts a DIAMOND — two paths to one blocker is not a cycle', () => {
    expect(() =>
      validate(
        [
          modify('m1', { workItemId: A, patch: { blockedByAdd: [B, C] } }),
          modify('m2', { workItemId: B, patch: { blockedByAdd: [C] } }),
        ],
        { liveById: threeLive },
      ),
    ).not.toThrow();
  });

  it('accepts a plan that writes no edge at all, whatever the committed graph looks like', () => {
    expect(() =>
      validate([add('a1', { parentRef: REAL_PARENT })], {
        existingBlockedByEdges: [{ blockedId: A, blockerId: B }],
      }),
    ).not.toThrow();
  });

  it('reports a DANGLING ref rather than a cycle when a ref resolves to nothing', () => {
    // Ordering: resolution runs first, so the most specific reason wins.
    let thrown: unknown;
    try {
      validate([modify('m1', { workItemId: A, patch: { blockedByAdd: ['wi_missing'] } })], {
        liveById: threeLive,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as PlanRefGraphError).reason).toBe('dangling');
  });

  it('names the work item AND says a `MOTIR-<n>` key is not a ref — the 2026-08-29 fixture', () => {
    // The correction door stored the literal string `MOTIR-3884`, which resolves
    // to no id. The message a reviewer met named only a cuid.
    expect(() =>
      validate([modify('m1', { workItemId: A, patch: { blockedByRemove: ['MOTIR-3884'] } })], {
        liveById: threeLive,
      }),
    ).toThrow(/MOTIR-wi_a "The wi_a card"[\s\S]*never a `<PREFIX>-<n>` key/);
  });
});

// MOTIR-6057 — the chain walk a move under a PROPOSED parent is judged against
// (AMENDMENT 18 §1). Pure, so its defensive arms are pinned here directly: the
// append and the gate's own ref checks refuse these shapes before the walk is
// reached, which is exactly why no integration path can.
describe('projectedParentChain / proposedParentAnchorIds', () => {
  const t = (id: string) => `${TEMP_REF_PREFIX}${id}`;

  it('climbs the proposed adds to the first COMMITTED row — the anchor', () => {
    const adds = new Map([
      ['s', add('s', { parentRef: t('e'), proposedFields: { kind: 'story' } })],
      ['e', add('e', { parentRef: 'wi_root', proposedFields: { kind: 'epic' } })],
    ]);
    const { proposedAncestors, anchorId } = projectedParentChain(t('s'), adds);
    expect(proposedAncestors.map((n) => n.id)).toEqual(['e']);
    expect(anchorId).toBe('wi_root');
  });

  it('stops with NO anchor when a proposed ancestor does not resolve', () => {
    const adds = new Map([['s', add('s', { parentRef: t('gone') })]]);
    expect(projectedParentChain(t('s'), adds)).toEqual({ proposedAncestors: [], anchorId: null });
  });

  it('has NO anchor at the project root or in a folder', () => {
    const atRoot = new Map([['s', add('s', { parentRef: null })]]);
    expect(projectedParentChain(t('s'), atRoot).anchorId).toBeNull();
    const filed = new Map([['s', add('s', { parentRef: 'folder:f1' })]]);
    expect(projectedParentChain(t('s'), filed).anchorId).toBeNull();
  });

  it('collects the anchors of every move under a proposal — and only of those', () => {
    const items = [
      add('s', { parentRef: 'wi_epic', proposedFields: { kind: 'story' } }),
      add('f', { parentRef: 'folder:f1', proposedFields: { kind: 'story' } }),
      modify('m1', { patch: { parentRef: t('s') } }),
      modify('m2', { workItemId: 'wi_other', patch: { parentRef: t('f') } }),
      modify('m3', { workItemId: 'wi_third', patch: { parentRef: 'wi_live' } }),
      modify('m4', { workItemId: 'wi_fourth', patch: { blockedByAdd: ['wi_blocker'] } }),
    ];
    expect(proposedParentAnchorIds(items)).toEqual(['wi_epic']);
  });

  it('refuses a move under a temp-ref that names no add, as a DANGLING ref, when run alone', () => {
    try {
      validate([modify('m', { patch: { parentRef: t('nowhere') } })]);
      expect.unreachable('a move under nothing is refused');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('dangling');
    }
  });
});

describe('validatePlanProposals — a blocked_by joins two items on the SAME LEVEL: position (MOTIR-6411)', () => {
  // The level is POSITION (MOTIR-6387): the same depth below the nearest common
  // ancestor, in the tree the plan would leave. Live rows are placed by their
  // committed chains; a proposal by its `parentRef`; a re-parented `modify` by
  // its new parent. Nothing here compares KINDS.
  //
  //   E1 ─ S ─ Y          E2 ─ S2
  //      └ T (a task)
  const E1 = 'wi_e1';
  const E2 = 'wi_e2';
  const S = 'wi_s';
  const T = 'wi_t';
  const Y = 'wi_y';
  const S2 = 'wi_s2';
  const levels = liveMap(
    live({ id: E1, kind: 'epic' }),
    live({ id: E2, kind: 'epic' }),
    live({ id: S, kind: 'story' }),
    live({ id: T, kind: 'task' }),
    live({ id: Y, kind: 'subtask' }),
    live({ id: S2, kind: 'story' }),
  );
  const chains = new Map<string, readonly string[]>([
    [E1, []],
    [E2, []],
    [S, [E1]],
    [T, [E1]],
    [Y, [S, E1]],
    [S2, [E2]],
  ]);
  const run = (items: ProposalNode[], extra: Parameters<typeof validate>[1] = {}) =>
    validate(items, { liveById: levels, edgeAncestorsById: chains, ...extra });

  function crossLevel(fn: () => void): PlanRefGraphError {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('cross_level');
      return err as PlanRefGraphError;
    }
    return expect.unreachable('a cross-level blocked_by must be refused') as never;
  }

  it('case 1 — a validation task proposed under an epic, blocked_by the story beside it, is accepted', () => {
    expect(() =>
      run([add('v', { proposedFields: { kind: 'task' }, parentRef: E1, blockedByRefs: [S] })]),
    ).not.toThrow();
  });

  it('case 2 / 2b — a subtask under a task, blocked_by a subtask under a story (same epic, or another), is accepted', () => {
    expect(() =>
      run([
        add('x', { proposedFields: { kind: 'subtask' }, parentRef: T, blockedByRefs: [Y] }),
        add('s3', { proposedFields: { kind: 'story' }, parentRef: E2 }),
      ]),
    ).not.toThrow();
    expect(() =>
      run([
        add('y2', { proposedFields: { kind: 'subtask' }, parentRef: S2 }),
        add('x', {
          proposedFields: { kind: 'subtask' },
          parentRef: T,
          blockedByRefs: [`${TEMP_REF_PREFIX}y2`],
        }),
      ]),
    ).not.toThrow();
  });

  it('case 3 — a subtask two levels under a story, blocked_by a subtask directly under one, is refused naming both depths', () => {
    const err = crossLevel(() =>
      run([
        add('t1', { proposedFields: { kind: 'task', title: 'T1' }, parentRef: S }),
        add('x1', {
          proposedFields: { kind: 'subtask', title: 'X1' },
          parentRef: `${TEMP_REF_PREFIX}t1`,
          blockedByRefs: [Y],
        }),
      ]),
    );
    expect(err.planItemId).toBe('x1');
    expect(err.message).toContain('X1');
    expect(err.message).toContain('sits 3 level(s)');
    expect(err.message).toContain(`MOTIR-${Y}`);
    expect(err.message).toMatch(/sits 2, so they are not on the same level/);
  });

  it('case 4 — a root bug filed in a folder, blocked_by a subtask, is refused (a folder adds no depth)', () => {
    crossLevel(() =>
      run(
        [add('b', { proposedFields: { kind: 'bug' }, parentRef: 'folder:f1', blockedByRefs: [Y] })],
        {
          folderById: new Map([['f1', { id: 'f1', projectId: PLAN_PROJECT, name: 'Bugs' }]]),
        },
      ),
    );
  });

  it('case 4b — a subtask under a ROOT task, blocked_by a subtask under a story under an epic, is refused', () => {
    crossLevel(() =>
      run([
        add('r', { proposedFields: { kind: 'task' } }),
        add('xr', {
          proposedFields: { kind: 'subtask' },
          parentRef: `${TEMP_REF_PREFIX}r`,
          blockedByRefs: [Y],
        }),
      ]),
    );
  });

  it("refuses a modify's patch.blockedByAdd across levels, placing the target by its committed chain", () => {
    const err = crossLevel(() =>
      run([
        {
          ...add('m'),
          op: 'modify',
          workItemId: Y,
          proposedFields: null,
          patch: { blockedByAdd: [S2] },
        },
      ]),
    );
    expect(err.message).toContain('patch.blockedByAdd');
  });

  it('a modify that RE-PARENTS its target is placed under the new parent', () => {
    // T moved under S (depth 2) is then on Y's level.
    expect(() =>
      run([
        {
          ...add('m'),
          op: 'modify',
          workItemId: T,
          proposedFields: null,
          patch: { parentRef: S, blockedByAdd: [Y] },
        },
      ]),
    ).not.toThrow();
  });

  describe('a committed item UNDER a re-parented card is placed where the plan moves it (MOTIR-9756)', () => {
    //   R ─ Z  (a root story and its subtask)  →  the plan moves R under E2
    const R = 'wi_r';
    const Z = 'wi_z';
    const moved = liveMap(
      ...levels.values(),
      live({ id: R, kind: 'story' }),
      live({ id: Z, kind: 'subtask' }),
    );
    const movedChains = new Map<string, readonly string[]>([...chains, [R, []], [Z, [R]]]);
    const moveR = {
      ...add('m'),
      op: 'modify' as const,
      workItemId: R,
      proposedFields: null,
      patch: { parentRef: E2 },
    };
    const runMoved = (items: ProposalNode[]) =>
      validate(items, { liveById: moved, edgeAncestorsById: movedChains });

    it('accepts a new child of the moved card blocked_by its existing child — siblings before and after the move', () => {
      expect(() =>
        runMoved([
          moveR,
          add('n', { proposedFields: { kind: 'subtask' }, parentRef: R, blockedByRefs: [Z] }),
        ]),
      ).not.toThrow();
    });

    it('accepts a subtask elsewhere at the moved depth, blocked_by the existing child', () => {
      expect(() =>
        runMoved([
          moveR,
          add('n', { proposedFields: { kind: 'subtask' }, parentRef: S2, blockedByRefs: [Z] }),
        ]),
      ).not.toThrow();
    });

    it('refuses an edge that only the PRE-move depth would have made same-level', () => {
      // A task directly under E2 sits 1 below the root; Z, moved, sits 2.
      const err = crossLevel(() =>
        runMoved([
          moveR,
          add('t', { proposedFields: { kind: 'task' }, parentRef: E2, blockedByRefs: [Z] }),
        ]),
      );
      expect(err.message).toContain('sits 1 level(s) below the project root');
      expect(err.message).toContain('sits 2');
    });

    it('places a GRANDCHILD of the moved card through the moved ancestor, and the APPEND agrees', () => {
      //   R ─ K ─ G  →  R under E2: G sits 3 below the root, beside a new subtask under S2's new task
      const K = 'wi_k';
      const G = 'wi_g';
      const items = [
        moveR,
        add('k2', { proposedFields: { kind: 'task' }, parentRef: S2 }),
        add('n', {
          proposedFields: { kind: 'subtask' },
          parentRef: `${TEMP_REF_PREFIX}k2`,
          blockedByRefs: [G],
        }),
      ];
      const live3 = liveMap(
        ...moved.values(),
        live({ id: K, kind: 'task' }),
        live({ id: G, kind: 'subtask' }),
      );
      const chains3 = new Map<string, readonly string[]>([...movedChains, [K, [R]], [G, [K, R]]]);
      expect(() => validate(items, { liveById: live3, edgeAncestorsById: chains3 })).not.toThrow();
      expect(() => assertBlockedByLevels(items, live3, chains3, new Set(['n']))).not.toThrow();
    });
  });

  it('never refuses patch.blockedByRemove — a plan can always take a cross-level edge away', () => {
    expect(() =>
      run([
        {
          ...add('m'),
          op: 'modify',
          workItemId: Y,
          proposedFields: null,
          patch: { blockedByRemove: [S] },
        },
      ]),
    ).not.toThrow();
  });

  it('a live end with no chain is skipped rather than guessed', () => {
    expect(() =>
      validate(
        [add('x', { proposedFields: { kind: 'subtask' }, parentRef: T, blockedByRefs: [S] })],
        {
          liveById: levels,
        },
      ),
    ).not.toThrow();
  });

  it('reports a dangling ref as dangling, not as a level question', () => {
    try {
      run([
        add('x', {
          proposedFields: { kind: 'subtask' },
          parentRef: T,
          blockedByRefs: ['wi_nowhere'],
        }),
      ]);
      expect.unreachable('a dangling ref must be refused');
    } catch (err) {
      expect((err as PlanRefGraphError).reason).toBe('dangling');
    }
  });

  it('refuses the level BEFORE the cycle — the more specific reason wins', () => {
    crossLevel(() =>
      run(
        [
          {
            ...add('m'),
            op: 'modify',
            workItemId: Y,
            proposedFields: null,
            patch: { blockedByAdd: [S] },
          },
        ],
        { existingBlockedByEdges: [{ blockedId: S, blockerId: Y }] },
      ),
    );
  });
});

describe('assertBlockedByLevels — the APPEND narrows to the batch (MOTIR-6367)', () => {
  const S = 'wi_s';
  const levels = liveMap(live({ id: S, kind: 'story' }));
  const chains = new Map<string, readonly string[]>([[S, []]]);

  it('judges only the named subjects, while resolving refs against every add', () => {
    const items = [
      add('p', { proposedFields: { kind: 'story' } }),
      add('old', {
        proposedFields: { kind: 'task' },
        parentRef: `${TEMP_REF_PREFIX}p`,
        blockedByRefs: [S],
      }),
      add('new', {
        proposedFields: { kind: 'task' },
        parentRef: `${TEMP_REF_PREFIX}p`,
        blockedByRefs: [`${TEMP_REF_PREFIX}p`],
      }),
    ];
    // `old` is cross-level (depth 1 → 0) but not in the batch — left to the close.
    expect(() => assertBlockedByLevels(items, levels, chains, new Set(['p']))).not.toThrow();
    // `new` is in the batch and names its own parent: depth 1 → 0.
    expect(() => assertBlockedByLevels(items, levels, chains, new Set(['new']))).toThrow(
      PlanRefGraphError,
    );
  });

  it('skips a folder ref, a remove, and a proposal parent cycle — other checks refuse those', () => {
    expect(() =>
      assertBlockedByLevels(
        [
          add('y', { proposedFields: { kind: 'subtask' }, blockedByRefs: ['folder:f1'] }),
          { ...add('r'), op: 'remove', workItemId: S },
          add('c1', { parentRef: `${TEMP_REF_PREFIX}c2`, blockedByRefs: [S] }),
          add('c2', { parentRef: `${TEMP_REF_PREFIX}c1` }),
        ],
        levels,
        chains,
      ),
    ).not.toThrow();
  });
});

// Story MOTIR-6577 · MOTIR-6630 — the five `supersedes` carriers. Each goes
// through the same passes the blocker carriers do (self-consistency,
// resolvability) plus a SEPARATE cycle walk — the database never refuses a
// supersedes ring — and NO level rule.
describe('validatePlanProposals — the `supersedes` carriers (MOTIR-6630)', () => {
  const OLD = 'wi_old';
  const NEW = 'wi_new';
  const EPIC = 'wi_epic';
  const lives = liveMap(
    live({ id: OLD, kind: 'task', status: 'done' }),
    live({ id: NEW, kind: 'task' }),
    live({ id: EPIC, kind: 'epic' }),
    live({ id: REAL_TARGET }),
  );

  const refusal = (fn: () => void): PlanRefGraphError => {
    let thrown: unknown;
    try {
      fn();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PlanRefGraphError);
    return thrown as PlanRefGraphError;
  };

  const PATCH_CARRIERS = [
    'supersedesAdd',
    'supersedesRemove',
    'supersededByAdd',
    'supersededByRemove',
  ] as const;

  it('accepts a real id and a `planItem:` ref on every carrier', () => {
    expect(() =>
      validate(
        [
          add('a1', { supersedesRefs: [OLD] }),
          add('a2', { supersedesRefs: [`${TEMP_REF_PREFIX}a1`] }),
          modify('m1', {
            workItemId: NEW,
            patch: { supersedesAdd: [OLD, `${TEMP_REF_PREFIX}a2`] },
          }),
        ],
        { liveById: lives },
      ),
    ).not.toThrow();
    for (const key of PATCH_CARRIERS) {
      expect(() =>
        validate(
          [
            add('a1'),
            modify('m1', { workItemId: NEW, patch: { [key]: [OLD, `${TEMP_REF_PREFIX}a1`] } }),
          ],
          { liveById: lives },
        ),
      ).not.toThrow();
    }
  });

  it('refuses an unknown id and an unknown temp-ref as `dangling`, naming the carrier', () => {
    const unknownAdd = refusal(() => validate([add('a1', { supersedesRefs: ['wi_ghost'] })]));
    expect(unknownAdd.reason).toBe('dangling');
    expect(unknownAdd.message).toMatch(/supersedesRefs "wi_ghost"/);
    for (const key of PATCH_CARRIERS) {
      const err = refusal(() =>
        validate(
          [modify('m1', { workItemId: NEW, patch: { [key]: [`${TEMP_REF_PREFIX}nope`] } })],
          {
            liveById: lives,
          },
        ),
      );
      expect(err.reason).toBe('dangling');
      expect(err.message).toContain(`patch.${key}`);
    }
  });

  it('refuses a FOLDER ref, a DUPLICATE and a SELF ref on every carrier at the pure pass', () => {
    const folder = refusal(() =>
      assertProposalSetSelfConsistent([add('a1', { supersedesRefs: ['folder:f1'] })]),
    );
    expect(folder.reason).toBe('dangling');
    expect(folder.message).toMatch(/names a folder/);
    const dup = refusal(() =>
      assertProposalSetSelfConsistent([add('a1', { supersedesRefs: [OLD, OLD] })]),
    );
    expect(dup.reason).toBe('duplicate');
    expect(dup.message).toMatch(/a supersedes edge can only be created once/);
    const selfAdd = refusal(() =>
      assertProposalSetSelfConsistent([add('a1', { supersedesRefs: [`${TEMP_REF_PREFIX}a1`] })]),
    );
    expect(selfAdd.reason).toBe('cycle');
    for (const key of PATCH_CARRIERS) {
      expect(
        refusal(() =>
          assertProposalSetSelfConsistent([
            modify('m1', { workItemId: NEW, patch: { [key]: ['folder:f1'] } }),
          ]),
        ).reason,
      ).toBe('dangling');
      expect(
        refusal(() =>
          assertProposalSetSelfConsistent([
            modify('m1', { workItemId: NEW, patch: { [key]: [OLD, OLD] } }),
          ]),
        ).reason,
      ).toBe('duplicate');
      // A `modify` naming its own target: a card cannot replace itself.
      const self = refusal(() =>
        assertProposalSetSelfConsistent([
          modify('m1', { workItemId: NEW, patch: { [key]: [NEW] } }),
        ]),
      );
      expect(self.reason).toBe('cycle');
      expect(self.message).toMatch(/cannot supersede itself/);
    }
  });

  it('a duplicate is judged within ONE carrier — the two spellings of one row are not a duplicate', () => {
    // `modify OLD supersededByAdd [NEW]` and `modify NEW supersedesAdd [OLD]` both
    // describe the row NEW → OLD. Approve writes it once; the gate admits both.
    expect(() =>
      validate(
        [
          modify('m1', { workItemId: OLD, patch: { supersededByAdd: [NEW] } }),
          modify('m2', { workItemId: NEW, patch: { supersedesAdd: [OLD] } }),
        ],
        { liveById: lives },
      ),
    ).not.toThrow();
  });

  it('refuses a TWO-PROPOSAL cycle as `cycle`, naming both cards', () => {
    const err = refusal(() =>
      validate(
        [
          modify('m1', { workItemId: NEW, patch: { supersedesAdd: [OLD] } }),
          modify('m2', { workItemId: OLD, patch: { supersedesAdd: [NEW] } }),
        ],
        { liveById: lives },
      ),
    );
    expect(err.reason).toBe('cycle');
    expect(err.message).toMatch(/SUPERSEDES cycle/);
    expect(err.message).toMatch(/MOTIR-wi_new[\s\S]*MOTIR-wi_old|MOTIR-wi_old[\s\S]*MOTIR-wi_new/);
  });

  it('refuses a cycle through ONE LIVE link and ONE proposal — either spelling', () => {
    // Committed: NEW supersedes OLD. Proposing OLD supersedes NEW closes a ring.
    const committed = [{ fromId: NEW, toId: OLD }];
    expect(
      refusal(() =>
        validate([modify('m1', { workItemId: OLD, patch: { supersedesAdd: [NEW] } })], {
          liveById: lives,
          existingSupersedesEdges: committed,
        }),
      ).reason,
    ).toBe('cycle');
    // The same ring spelled from the other end: NEW is superseded by OLD.
    expect(
      refusal(() =>
        validate([modify('m1', { workItemId: NEW, patch: { supersededByAdd: [OLD] } })], {
          liveById: lives,
          existingSupersedesEdges: committed,
        }),
      ).reason,
    ).toBe('cycle');
  });

  it('refuses a cycle among the plan’s own `add`s and a `modify`', () => {
    // a1 supersedes OLD, and a `modify` has OLD supersede a1 — a ring whose
    // every edge this plan writes, through a temp-ref.
    expect(
      refusal(() =>
        validate(
          [
            add('a1', { supersedesRefs: [OLD] }),
            modify('m1', { workItemId: OLD, patch: { supersedesAdd: [`${TEMP_REF_PREFIX}a1`] } }),
          ],
          { liveById: lives },
        ),
      ).reason,
    ).toBe('cycle');
  });

  it('accepts the reversing edge when the plan REMOVES the committed row it would close a ring with', () => {
    expect(() =>
      validate(
        [
          modify('m1', {
            workItemId: OLD,
            patch: { supersedesAdd: [NEW], supersededByRemove: [NEW] },
          }),
        ],
        { liveById: lives, existingSupersedesEdges: [{ fromId: NEW, toId: OLD }] },
      ),
    ).not.toThrow();
  });

  it('has NO level rule — a task may supersede an epic', () => {
    expect(() =>
      validate([modify('m1', { workItemId: NEW, patch: { supersedesAdd: [EPIC] } })], {
        liveById: lives,
        edgeAncestorsById: new Map([
          [NEW, ['wi_story', EPIC]],
          [EPIC, []],
        ]),
      }),
    ).not.toThrow();
  });

  it('a supersedes-only `modify` of a DONE card is mark-only, and passes step 4', () => {
    expect(() =>
      validate(
        [
          add('a1'),
          modify('m1', { workItemId: OLD, patch: { supersededByAdd: [`${TEMP_REF_PREFIX}a1`] } }),
        ],
        { liveById: lives },
      ),
    ).not.toThrow();
    // Beside a non-mark key it is still refused.
    expect(() =>
      validate(
        [modify('m1', { workItemId: OLD, patch: { supersededByAdd: [NEW], title: 'x' } as never })],
        { liveById: lives },
      ),
    ).toThrow(PlanTargetImmutableError);
  });

  it('collectReferencedWorkItemIds reads all five carriers', () => {
    expect(
      collectReferencedWorkItemIds([
        add('a1', { supersedesRefs: ['wi_1', `${TEMP_REF_PREFIX}x`] }),
        modify('m1', {
          workItemId: 'wi_t',
          patch: {
            supersedesAdd: ['wi_2'],
            supersedesRemove: ['wi_3'],
            supersededByAdd: ['wi_4'],
            supersededByRemove: ['wi_5'],
          },
        }),
      ]).sort(),
    ).toEqual(['wi_1', 'wi_2', 'wi_3', 'wi_4', 'wi_5', 'wi_t']);
  });
});
