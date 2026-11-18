import { describe, expect, it } from 'vitest';
import { judgeWalkCompleteness, planWasWalked, walkListedOf } from '@/lib/plans/walkCompleteness';
import { revisionReopenedFrom } from '@/lib/planChange/revisionLease';
import { isUnfinishedWalkStatus } from '@/lib/planChange/sessionWaitingState';

// Bug MOTIR-11701 — the pure half of the walk-completeness verdict. The verdict over a
// real walk (proposals, committed cards, Resume) is `tests/integration/plans/stoppedWalk.test.ts`.

describe('planWasWalked', () => {
  it('is false only when there is no step, no session and no listed card', () => {
    expect(planWasWalked({ liveSteps: [], sessions: [], listed: [] })).toBe(false);
    expect(
      planWasWalked({ liveSteps: [{ kind: 'lay', targetRef: null }], sessions: [], listed: [] }),
    ).toBe(true);
    expect(
      planWasWalked({ liveSteps: [], sessions: [{ kind: 'lay', targetRef: null }], listed: [] }),
    ).toBe(true);
    expect(planWasWalked({ liveSteps: [], sessions: [], listed: ['wi_1'] })).toBe(true);
  });
});

describe('judgeWalkCompleteness', () => {
  it('a plan nobody walked is complete by construction, whatever it holds', () => {
    expect(
      judgeWalkCompleteness({ items: [], liveSteps: [], sessions: [], listed: [], committed: [] }),
    ).toEqual({ walked: false, complete: true, unwritten: [] });
  });

  it('a listed committed card no session wrote is owed, by key and title', () => {
    const verdict = judgeWalkCompleteness({
      items: [],
      liveSteps: [],
      sessions: [{ kind: 'lay', targetRef: null }],
      listed: ['wi_1'],
      committed: [{ id: 'wi_1', key: 'ACME-1', title: 'A card' }],
    });
    expect(verdict).toEqual({
      walked: true,
      complete: false,
      unwritten: [{ ref: 'wi_1', key: 'ACME-1', title: 'A card' }],
    });
  });

  it('a committed card whose author session ended is written', () => {
    const verdict = judgeWalkCompleteness({
      items: [],
      liveSteps: [],
      sessions: [{ kind: 'author', targetRef: 'wi_1' }],
      listed: ['wi_1'],
      committed: [{ id: 'wi_1', key: 'ACME-1', title: 'A card' }],
    });
    expect(verdict).toEqual({ walked: true, complete: true, unwritten: [] });
  });
});

describe('walkListedOf', () => {
  it('reads the string ids, and nothing from a record that is not an object', () => {
    expect(walkListedOf({ walkListed: ['a', '', 3, 'b'], other: 1 })).toEqual(['a', 'b']);
    expect(walkListedOf({ walkListed: 'a' })).toEqual([]);
    expect(walkListedOf(null)).toEqual([]);
    expect(walkListedOf(['a'])).toEqual([]);
    expect(walkListedOf('a')).toEqual([]);
  });
});

describe('the unfinished-walk statuses', () => {
  it('are `generating` and `stopped`', () => {
    expect(isUnfinishedWalkStatus('generating')).toBe(true);
    expect(isUnfinishedWalkStatus('stopped')).toBe(true);
    expect(isUnfinishedWalkStatus('planned')).toBe(false);
  });

  it('a revision hold that re-opened a stopped plan gives it back `stopped`', () => {
    const started = (from: string) => ({
      changeKind: 'revision_started',
      changedAt: new Date(),
      diff: { reopenedFrom: from },
    });
    expect(revisionReopenedFrom([started('stopped')])).toBe('stopped');
    expect(revisionReopenedFrom([started('planned')])).toBe('planned');
    expect(revisionReopenedFrom([started('generating')])).toBeNull();
  });
});
