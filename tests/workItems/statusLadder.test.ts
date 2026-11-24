import { describe, expect, it } from 'vitest';
import {
  ladderKeysFrom,
  CONTAINER_CLAIM_BAR_RANK,
  CONTAINER_CLAIM_STATUS_KEYS,
  LADDER,
  RUNG_RANK,
  childrenBelowClaimBar,
  rankOfStatus,
} from '@/lib/workItems/statusLadder';

// The status LADDER as pure logic (Bug MOTIR-3229) — the ordering both halves of
// status derivation and the container-completeness gate read.
//
// No database here, deliberately: this is the module that exists so the gate and
// the derivation cannot disagree about how far along a status is, and that
// property is a property of the FUNCTION. Its behaviour at the seams is proven
// against real Postgres in `tests/workflows/container-completeness-gate.test.ts`
// and `tests/integration/workflows/parentStatusRollup.test.ts`.

/** The default workflow's statuses, as the ladder sees them. */
const DEFAULT_STATUSES = [
  { key: 'todo', category: 'todo' as const },
  { key: 'blocked', category: 'todo' as const },
  { key: 'in_progress', category: 'in_progress' as const },
  { key: 'implemented', category: 'in_progress' as const },
  { key: 'planning', category: 'in_progress' as const },
  { key: 'to_plan', category: 'in_progress' as const },
  { key: 'in_review', category: 'in_progress' as const },
  { key: 'approved', category: 'in_progress' as const },
  { key: 'done', category: 'done' as const },
  { key: 'cancelled', category: 'done' as const },
];

const KEYS = {
  reviewKey: 'in_review',
  implementedKey: 'implemented',
  approvedKey: 'approved',
  toPlanKey: 'to_plan',
};

describe('rankOfStatus — six rungs, by category with three keys pulled out', () => {
  it.each([
    ['todo', RUNG_RANK.todo],
    ['blocked', RUNG_RANK.todo],
    ['in_progress', RUNG_RANK.in_progress],
    // ⚠️ `planning` is an in_progress-CATEGORY status (MOTIR-2425) and ranks with
    // in_progress — a card whose plan is being reconsidered is emphatically not
    // built, and the gate must refuse a parent that claims it is.
    ['planning', RUNG_RANK.in_progress],
    ['implemented', RUNG_RANK.implemented],
    ['in_review', RUNG_RANK.in_review],
    // ⚠️ MOTIR-5140 — `approved` is an in_progress-CATEGORY status like
    // `planning` two lines up, and ranks nowhere near it: a person has said yes.
    // The category says it is not FINISHED; the rung says how far along it is.
    ['approved', RUNG_RANK.approved],
    ['done', RUNG_RANK.done],
    ['cancelled', RUNG_RANK.done],
  ])('ranks %s at %i', (key, rank) => {
    expect(rankOfStatus(key, DEFAULT_STATUSES, KEYS)).toBe(rank);
  });

  it('ranks the strictly increasing lifecycle in order', () => {
    const ranks = ['todo', 'in_progress', 'implemented', 'in_review', 'approved', 'done'].map((k) =>
      rankOfStatus(k, DEFAULT_STATUSES, KEYS),
    );
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(6);
  });

  it('ranks `approved` ABOVE in_review and BELOW done — the whole of MOTIR-5140', () => {
    // Stated as an ordering rather than as a number, because the numbers are an
    // implementation detail and this relation is the card's actual claim.
    const rank = (k: string) => rankOfStatus(k, DEFAULT_STATUSES, KEYS);
    expect(rank('approved')).toBeGreaterThan(rank('in_review'));
    expect(rank('approved')).toBeLessThan(rank('done'));
    // And the regression it fixes, named: before the rung it returned this.
    expect(rank('approved')).not.toBe(rank('in_progress'));
  });

  it('a project WITHOUT an approved status is completely unaffected', () => {
    // The inertness guarantee — a project the backfill never reached passes a
    // null key and every other rank is byte-identical to what it was.
    const noApproved = { ...KEYS, approvedKey: null };
    for (const key of ['todo', 'in_progress', 'implemented', 'in_review', 'done', 'cancelled']) {
      expect(rankOfStatus(key, DEFAULT_STATUSES, noApproved)).toBe(
        rankOfStatus(key, DEFAULT_STATUSES, KEYS),
      );
    }
    // …and the status itself falls back to its CATEGORY, which is in_progress.
    expect(rankOfStatus('approved', DEFAULT_STATUSES, noApproved)).toBe(RUNG_RANK.in_progress);
  });

  it('ranks `to_plan` at the TODO rung — planned, not started (MOTIR-12174)', () => {
    // Its category is in_progress (that keeps it out of the claim doors), so by
    // category alone it would rank as started — and an epic over a story the
    // mark moved would derive to In Progress. Pulled DOWN, not up.
    const rank = (k: string) => rankOfStatus(k, DEFAULT_STATUSES, KEYS);
    expect(rank('to_plan')).toBe(RUNG_RANK.todo);
    expect(rank('to_plan')).toBe(rank('todo'));
    expect(rank('to_plan')).toBeLessThan(rank('in_progress'));
    // A project without the status: the key is null and it ranks by category.
    expect(rankOfStatus('to_plan', DEFAULT_STATUSES, { ...KEYS, toPlanKey: null })).toBe(
      RUNG_RANK.in_progress,
    );
  });

  it('a to_plan child is BELOW the container-claim bar', () => {
    const rows = [{ identifier: 'X-1', status: 'to_plan' }];
    expect(childrenBelowClaimBar(rows, DEFAULT_STATUSES, KEYS)).toHaveLength(1);
  });

  it('ranks an UNKNOWN key lowest — a status nobody can classify is not evidence of progress', () => {
    expect(rankOfStatus('nonesuch', DEFAULT_STATUSES, KEYS)).toBe(RUNG_RANK.todo);
  });

  it('falls back to the CATEGORY for a project that renamed the two lifecycle statuses', () => {
    // A team whose workflow has neither key: everything in the in_progress
    // category ranks as in_progress, which is exactly the four-rung reading that
    // shipped before this module — the degenerate case, not a failure.
    const renamed = [
      { key: 'backlog', category: 'todo' as const },
      { key: 'doing', category: 'in_progress' as const },
      { key: 'qa', category: 'in_progress' as const },
      { key: 'shipped', category: 'done' as const },
    ];
    const noKeys = { reviewKey: null, implementedKey: null, approvedKey: null, toPlanKey: null };
    expect(rankOfStatus('doing', renamed, noKeys)).toBe(RUNG_RANK.in_progress);
    expect(rankOfStatus('qa', renamed, noKeys)).toBe(RUNG_RANK.in_progress);
    expect(rankOfStatus('shipped', renamed, noKeys)).toBe(RUNG_RANK.done);
  });

  it('honours a project’s OWN review / implemented keys, whatever they are called', () => {
    const renamed = [
      { key: 'doing', category: 'in_progress' as const },
      { key: 'built', category: 'in_progress' as const },
      { key: 'qa', category: 'in_progress' as const },
    ];
    const keys = {
      reviewKey: 'qa',
      implementedKey: 'built',
      approvedKey: 'signed-off',
      toPlanKey: null,
    };
    expect(rankOfStatus('built', renamed, keys)).toBe(RUNG_RANK.implemented);
    expect(rankOfStatus('qa', renamed, keys)).toBe(RUNG_RANK.in_review);
    expect(rankOfStatus('doing', renamed, keys)).toBe(RUNG_RANK.in_progress);
    expect(rankOfStatus('signed-off', renamed, keys)).toBe(RUNG_RANK.approved);
  });

  it('gives the HIGHER rung precedence when a project aliases rungs onto one key', () => {
    // Pathological but expressible. The higher rung is the conservative answer for
    // the derivation and the stricter one for the gate.
    const one = [{ key: 'qa', category: 'in_progress' as const }];
    expect(
      rankOfStatus('qa', one, {
        reviewKey: 'qa',
        implementedKey: 'qa',
        approvedKey: null,
        toPlanKey: null,
      }),
    ).toBe(RUNG_RANK.in_review);
    // MOTIR-5140 — and APPROVED outranks review, so it wins over both. This is
    // the same precedence `aggregateChildrenStatus` applies when it buckets, and
    // the two must not drift: the rank and the bucket are one decision.
    expect(
      rankOfStatus('qa', one, {
        reviewKey: 'qa',
        implementedKey: 'qa',
        approvedKey: 'qa',
        toPlanKey: null,
      }),
    ).toBe(RUNG_RANK.approved);
  });
});

describe('the ladder itself', () => {
  it('is ordered highest rung FIRST, so "first match wins" is a plain scan', () => {
    const ranks = LADDER.map((entry) => RUNG_RANK[entry.rung]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  it('names every rung exactly once', () => {
    expect(LADDER.map((e) => e.rung)).toEqual([
      'done',
      'approved',
      'in_review',
      'implemented',
      'in_progress',
      'todo',
    ]);
  });
});

describe('the container-completeness bar', () => {
  it('is `implemented`, and gates exactly the statuses that CLAIM the work is built', () => {
    // The BAR is unchanged by MOTIR-5140 and is now correct rather than merely
    // unchanged: an approved child ranks ABOVE it, so it clears.
    expect(CONTAINER_CLAIM_BAR_RANK).toBe(RUNG_RANK.implemented);
    expect([...CONTAINER_CLAIM_STATUS_KEYS].sort()).toEqual([
      'approved',
      'implemented',
      'in_review',
    ]);
    // ⚠️ `done` is NOT here, and its absence is the decision: completing a parent
    // is a decision that completes its children (ADR §4), so gating it would break
    // the feature rather than the defect.
    expect(CONTAINER_CLAIM_STATUS_KEYS.has('done')).toBe(false);
  });

  it('returns the children below the bar, and nothing else', () => {
    const children = [
      { id: 'a', status: 'todo' },
      { id: 'b', status: 'blocked' },
      { id: 'c', status: 'in_progress' },
      { id: 'd', status: 'planning' },
      { id: 'e', status: 'implemented' },
      { id: 'f', status: 'in_review' },
      { id: 'i', status: 'approved' },
      { id: 'g', status: 'done' },
      { id: 'h', status: 'cancelled' },
    ];

    expect(childrenBelowClaimBar(children, DEFAULT_STATUSES, KEYS).map((c) => c.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('is empty for an all-built child set, and for no children at all', () => {
    expect(
      childrenBelowClaimBar(
        [
          { id: 'a', status: 'implemented' },
          { id: 'b', status: 'done' },
        ],
        DEFAULT_STATUSES,
        KEYS,
      ),
    ).toEqual([]);
    // ⚠️ MOTIR-5140's second regression, asserted directly: an APPROVED child
    // clears the bar. Before the rung it ranked as plain in-progress, so it was
    // counted as un-built and `applyStatusTransition` refused the parent's move
    // with CONTAINER_HAS_OPEN_CHILDREN — on a container every one of whose
    // children had been approved.
    expect(
      childrenBelowClaimBar(
        [
          { id: 'a', status: 'approved' },
          { id: 'b', status: 'approved' },
        ],
        DEFAULT_STATUSES,
        KEYS,
      ),
    ).toEqual([]);
    expect(childrenBelowClaimBar([], DEFAULT_STATUSES, KEYS)).toEqual([]);
  });

  it('returns the ROWS, not ids — the refusal has to be able to name the cards', () => {
    // MOTIR-3218 and MOTIR-3219 had to be reconstructed from a job log. An error
    // that says "children are open" without saying which repeats that.
    const rows = [{ identifier: 'MOTIR-3218', status: 'todo' }];
    expect(childrenBelowClaimBar(rows, DEFAULT_STATUSES, KEYS)[0]!.identifier).toBe('MOTIR-3218');
  });
});

describe('ladderKeysFrom (MOTIR-6537)', () => {
  it('resolves each named rung by literal key, and null where the project has none', () => {
    expect(ladderKeysFrom([{ key: 'todo' }, { key: 'implemented' }, { key: 'in_review' }])).toEqual(
      { reviewKey: 'in_review', implementedKey: 'implemented', approvedKey: null, toPlanKey: null },
    );
    expect(ladderKeysFrom([{ key: 'to_plan' }])).toMatchObject({ toPlanKey: 'to_plan' });
    expect(ladderKeysFrom([])).toEqual({
      reviewKey: null,
      implementedKey: null,
      approvedKey: null,
      toPlanKey: null,
    });
  });
});
