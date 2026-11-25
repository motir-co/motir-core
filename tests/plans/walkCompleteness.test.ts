import { describe, expect, it } from 'vitest';
import type { PlanItemDto } from '@/lib/dto/plans';
import {
  isLeftLaid,
  judgeWalkCompleteness,
  planWasWalked,
  walkListedOf,
} from '@/lib/plans/walkCompleteness';
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
    ).toEqual({ walked: false, complete: true, unwritten: [], leftLaid: [] });
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
      leftLaid: [],
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
    expect(verdict).toEqual({ walked: true, complete: true, unwritten: [], leftLaid: [] });
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

// Story MOTIR-12203 · MOTIR-12207 — a walk that ended ON PURPOSE owes nothing it left.
describe('judgeWalkCompleteness — a deliberate end', () => {
  const add = (id: string, fields: Record<string, unknown>) =>
    ({ id, op: 'add', proposedFields: { title: id, ...fields } }) as unknown as PlanItemDto;
  const facts = {
    liveSteps: [],
    sessions: [{ kind: 'lay' as const, targetRef: null }],
    listed: ['wi_1'],
    committed: [{ id: 'wi_1', key: 'ACME-1', title: 'A card' }],
  };

  it('a leftLaid add is not owed and is named as laid; an unstamped one still is', () => {
    const verdict = judgeWalkCompleteness({
      ...facts,
      items: [add('laid', { leftLaid: true }), add('bare', {})],
      walkEndedBy: 'cadence',
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.unwritten.map((u) => u.ref)).toEqual(['planItem:bare']);
    expect(verdict.leftLaid.map((u) => u.ref)).toEqual(['planItem:laid']);
  });

  it('with walkEndedBy, a listed committed card nobody wrote is not owed', () => {
    const verdict = judgeWalkCompleteness({
      ...facts,
      items: [add('laid', { leftLaid: true })],
      walkEndedBy: 'person_stop',
    });
    expect(verdict).toMatchObject({ walked: true, complete: true, unwritten: [] });
  });

  it('without walkEndedBy the listed committed card is owed even when every add is laid', () => {
    const verdict = judgeWalkCompleteness({
      ...facts,
      items: [add('laid', { leftLaid: true })],
      walkEndedBy: null,
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.unwritten.map((u) => u.key)).toEqual(['ACME-1']);
  });

  it('isLeftLaid: authorFinished wins, and only an add can be laid', () => {
    expect(isLeftLaid(add('a', { leftLaid: true }))).toBe(true);
    expect(isLeftLaid(add('b', { leftLaid: true, authorFinished: true }))).toBe(false);
    expect(isLeftLaid(add('c', {}))).toBe(false);
    expect(isLeftLaid({ op: 'modify', proposedFields: null })).toBe(false);
    expect(isLeftLaid({ op: 'add', proposedFields: null })).toBe(false);
  });
});
