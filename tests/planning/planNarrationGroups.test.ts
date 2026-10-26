import { describe, expect, it } from 'vitest';
import {
  groupNarration,
  liveNarrationSessions,
  mergeNarrationEntries,
  narrationEarlierCount,
  nextHeadAnnouncement,
} from '@/components/planning/planNarration';
import { planReview } from '../helpers/planReview';
import { narrationEntry, narrationSession } from '../helpers/planNarration';

// THE ONE GROUPING of the planner's narration (Story MOTIR-8060 · MOTIR-8064),
// to `design/ai-chat/design-notes.md` § "⭐ Planner narration in the chat panel":
// one group per session in the read's order, each sentence in its own session's
// group in `seq` order, headless groups first, live only by the snapshot.

const settle = narrationSession('s-settle', 'settle');
const lay = narrationSession('s-lay', 'lay', 'Session handling');
const authorA = narrationSession('s-a', 'author', 'Move token refresh');
const authorB = narrationSession('s-b', 'author', 'Expire idle sessions');
const SESSIONS = [settle, lay, authorA, authorB];

describe('groupNarration', () => {
  it('one group per session, in the read’s order, including a session with no sentence', () => {
    const groups = groupNarration({ sessions: SESSIONS, entries: [] }, []);
    expect(groups.map((g) => g.sessionKey)).toEqual(['s-settle', 's-lay', 's-a', 's-b']);
    expect(groups.every((g) => g.messages.length === 0 && g.session !== null)).toBe(true);
  });

  it('interleaved sentences each land only in their own session’s group, in seq order', () => {
    const entries = [
      narrationEntry(1, 's-a', 'a1'),
      narrationEntry(2, 's-b', 'b1'),
      narrationEntry(3, 's-a', 'a2'),
      narrationEntry(4, 's-b', 'b2'),
      narrationEntry(5, 's-a', 'a3'),
    ];
    const groups = groupNarration({ sessions: SESSIONS, entries: [...entries].reverse() }, []);
    const byKey = Object.fromEntries(
      groups.map((g) => [g.sessionKey, g.messages.map((m) => m.body)]),
    );
    expect(byKey).toEqual({
      's-settle': [],
      's-lay': [],
      's-a': ['a1', 'a2', 'a3'],
      's-b': ['b1', 'b2'],
    });
  });

  it('a sentence whose session has no row gets a headless group, before the headed ones', () => {
    const groups = groupNarration(
      {
        sessions: [lay],
        entries: [
          narrationEntry(1, 's-old', 'before the store'),
          narrationEntry(2, 's-lay', 'laying'),
          narrationEntry(3, 's-old', 'again'),
        ],
      },
      ['s-old'],
    );
    expect(groups.map((g) => [g.sessionKey, g.session?.stepKind ?? null, g.live])).toEqual([
      ['s-old', null, false],
      ['s-lay', 'lay', false],
    ]);
    expect(groups[0]!.messages.map((m) => m.seq)).toEqual([1, 3]);
  });

  it('live comes only from the in-flight keys and never changes the step words', () => {
    const groups = groupNarration({ sessions: SESSIONS, entries: [] }, new Set(['s-b']));
    expect(groups.filter((g) => g.live).map((g) => g.sessionKey)).toEqual(['s-b']);
    expect(groups.find((g) => g.sessionKey === 's-a')!.session).toBe(authorA);
  });

  it('a duplicated session row is one group', () => {
    expect(groupNarration({ sessions: [lay, lay], entries: [] }, [])).toHaveLength(1);
  });
});

describe('the window and the kept earlier pages', () => {
  it('merge by seq, the later list winning, ascending', () => {
    const merged = mergeNarrationEntries(
      [narrationEntry(3, 's-a', 'old'), narrationEntry(1, 's-a', 'one')],
      [narrationEntry(3, 's-a', 'new'), narrationEntry(2, 's-a', 'two')],
    );
    expect(merged.map((e) => `${e.seq}:${e.body}`)).toEqual(['1:one', '2:two', '3:new']);
  });

  it('counts the sentences before the earliest in hand', () => {
    expect(narrationEarlierCount([])).toBe(0);
    expect(narrationEarlierCount([narrationEntry(101, 's-a', 'x')])).toBe(100);
  });

  it('live sessions are the in-flight steps of a generating snapshot only', () => {
    const step = {
      sessionKey: 's-a',
      kind: 'author' as const,
      targetRef: 'r',
      startedAt: 'x',
      providerWait: null,
    };
    expect(
      liveNarrationSessions(planReview([], { status: 'generating', inFlightSteps: [step] })),
    ).toEqual(['s-a']);
    expect(
      liveNarrationSessions(planReview([], { status: 'planned', inFlightSteps: [step] })),
    ).toEqual([]);
    expect(liveNarrationSessions(planReview([], { status: 'generating' }))).toEqual([]);
  });
});

describe('nextHeadAnnouncement', () => {
  const head = (sessionKey: string, line: string, live: boolean) => ({ sessionKey, line, live });

  it('a new group’s line, a changed line, and a live session ending', () => {
    expect(nextHeadAnnouncement([], [head('a', 'Writing A', true)])).toEqual({
      line: 'Writing A',
      finished: false,
    });
    expect(
      nextHeadAnnouncement([head('a', 'Laying out X', true)], [head('a', 'Writing A', true)]),
    ).toEqual({ line: 'Writing A', finished: false });
    expect(
      nextHeadAnnouncement([head('a', 'Writing A', true)], [head('a', 'Writing A', false)]),
    ).toEqual({ line: 'Writing A', finished: true });
  });

  it('nothing when nothing a reader needs changed', () => {
    const same = [head('a', 'Writing A', false)];
    expect(nextHeadAnnouncement(same, same)).toBeNull();
    expect(
      nextHeadAnnouncement([head('a', 'Writing A', false)], [head('a', 'Writing A', true)]),
    ).toBeNull();
  });
});
