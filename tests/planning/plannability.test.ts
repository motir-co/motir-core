import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  holdsStory,
  planBlockReasons,
  plannabilityOf,
  type PlannabilityBlockerFacts,
} from '@/lib/planning/plannability';
import { fetchPlannability } from '@/lib/planning/plannabilityClient';

// MOTIR-10544 — the Plan button's pre-check rule, pure (`lib/planning/plannability.ts`),
// and its client read (`lib/planning/plannabilityClient.ts`). The database half —
// the edges, the child counts and the workflow categories the rule is fed — is
// `tests/api/plannability-route.test.ts`.

const childlessStory: PlannabilityBlockerFacts = {
  id: 'blk-10550',
  identifier: 'MOTIR-10550',
  key: 10550,
  title: 'Store each sprint report as a snapshot',
  kind: 'story',
  statusCategory: 'todo',
  archived: false,
  liveChildCount: 0,
  sameProject: true,
};

describe('holdsStory — rule 1, "a childless story still holds"', () => {
  it('an open childless story holds', () => {
    expect(holdsStory(childlessStory)).toBe(true);
    expect(holdsStory({ ...childlessStory, statusCategory: 'in_progress' })).toBe(true);
  });

  it('a done-category, an archived and a broken-down story do not', () => {
    expect(holdsStory({ ...childlessStory, statusCategory: 'done' })).toBe(false);
    expect(holdsStory({ ...childlessStory, archived: true })).toBe(false);
    expect(holdsStory({ ...childlessStory, liveChildCount: 2 })).toBe(false);
  });

  it('an unclassified status is NOT finished: the hold stays (the fail-safe direction)', () => {
    expect(holdsStory({ ...childlessStory, statusCategory: null })).toBe(true);
  });

  it('a task, a bug, an epic or a subtask blocker never holds', () => {
    for (const kind of ['task', 'bug', 'epic', 'subtask']) {
      expect(holdsStory({ ...childlessStory, kind })).toBe(false);
    }
  });
});

describe('planBlockReasons', () => {
  it('only a STORY card is held', () => {
    expect(planBlockReasons({ kind: 'task' }, [childlessStory])).toEqual([]);
    expect(planBlockReasons({ kind: 'story' }, [childlessStory])).toHaveLength(1);
  });

  it('lists every held blocker once, in key order, and drops the rest', () => {
    const later = {
      ...childlessStory,
      id: 'blk-10551',
      identifier: 'MOTIR-10551',
      key: 10551,
      title: 'Later',
    };
    const earlier = {
      ...childlessStory,
      id: 'blk-9',
      identifier: 'MOTIR-9',
      key: 9,
      title: 'Earlier',
    };
    const free = {
      ...childlessStory,
      id: 'blk-3',
      identifier: 'MOTIR-3',
      key: 3,
      liveChildCount: 1,
    };
    expect(planBlockReasons({ kind: 'story' }, [later, free, earlier])).toEqual([
      {
        kind: 'blocker_has_no_subtasks',
        blockers: [
          { id: 'blk-9', identifier: 'MOTIR-9', title: 'Earlier', toPlan: true },
          { id: 'blk-10551', identifier: 'MOTIR-10551', title: 'Later', toPlan: true },
        ],
      },
    ]);
  });

  it('a blocker is To plan only in a todo category AND in the card’s own project', () => {
    const [inProgress] = planBlockReasons({ kind: 'story' }, [
      { ...childlessStory, statusCategory: 'in_progress' },
    ]);
    expect(inProgress!.blockers[0]!.toPlan).toBe(false);
    const [foreign] = planBlockReasons({ kind: 'story' }, [
      { ...childlessStory, sameProject: false },
    ]);
    expect(foreign!.blockers[0]!.toPlan).toBe(false);
  });
});

describe('plannabilityOf', () => {
  it('plannable is exactly "no reasons"', () => {
    expect(plannabilityOf({ kind: 'story' }, [])).toEqual({ plannable: true, reasons: [] });
    expect(plannabilityOf({ kind: 'story' }, [childlessStory]).plannable).toBe(false);
  });
});

describe('fetchPlannability — the client read', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(status: number, body: unknown) {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(body), { status }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('asks the route with the key encoded, uncached', async () => {
    const fetchMock = stubFetch(200, { plannable: true, reasons: [] });
    await expect(fetchPlannability('MOTIR-1 x')).resolves.toEqual({
      plannable: true,
      reasons: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/work-items/plannability?key=MOTIR-1%20x',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('returns the reasons of a refusal', async () => {
    const reasons = [
      {
        kind: 'blocker_has_no_subtasks',
        blockers: [{ id: 'blk-1', identifier: 'M-1', title: 'T', toPlan: true }],
      },
    ];
    stubFetch(200, { plannable: false, reasons });
    await expect(fetchPlannability('M-2')).resolves.toEqual({ plannable: false, reasons });
  });

  it('a body that carries reasons is never plannable', async () => {
    const reasons = [{ kind: 'blocker_has_no_subtasks', blockers: [] }];
    stubFetch(200, { plannable: true, reasons });
    await expect(fetchPlannability('M-2')).resolves.toEqual({ plannable: false, reasons });
  });

  it('an unreadable body, or a refusal with no reason, is a FAILED check', async () => {
    stubFetch(200, {});
    await expect(fetchPlannability('M-2')).rejects.toThrow('unreadable');
    stubFetch(200, { plannable: 'yes', reasons: [] });
    await expect(fetchPlannability('M-2')).rejects.toThrow('unreadable');
    stubFetch(200, { plannable: false, reasons: [] });
    await expect(fetchPlannability('M-2')).rejects.toThrow('no reason');
  });

  it('throws on every non-2xx — a 404 included', async () => {
    stubFetch(500, {});
    await expect(fetchPlannability('M-2')).rejects.toThrow('(500)');
    stubFetch(404, {});
    await expect(fetchPlannability('M-2')).rejects.toThrow('(404)');
  });
});
