// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { PLANNER_NOTES_STORAGE_KEY } from '@/components/planning/PlanNarration';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { PlanNarrationReadDto } from '@/lib/dto/plans';
import type {
  PlanChangeConversationState,
  PlanChangeProgress,
} from '@/lib/hooks/usePlanChangeConversation';
import { narrationEntry, narrationRead, narrationSession } from '../helpers/planNarration';

// THE PLANNER'S NARRATION IN THE CHAT PANEL (Story MOTIR-8060 · MOTIR-8064),
// built to MOTIR-8061's design delta: `design/ai-chat/design-notes.md`
// § "⭐ Planner narration in the chat panel" and
// `plan-change-run-live--narration.mock.html`. Every case drives the shipped
// `PlanChangeRail` from a `state.narration` snapshot, exactly what the hook hands
// it from the review read. Expected copy is formatted from the catalogue.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });
const NS = 'planningWorkspace.conversation';
type T = (key: string, values?: Record<string, string | number>) => string;
const tEn = createTranslator({ locale: 'en', messages: en, namespace: NS }) as unknown as T;
const tZh = createTranslator({ locale: 'zh', messages: zh, namespace: NS }) as unknown as T;

const SESSION: PlanChangeSessionDto = {
  id: 's1',
  projectId: 'p1',
  targetKeys: [],
  turnCount: 0,
  lastJobId: null,
  lastSubmittedAt: null,
  lastActivityAt: '2026-01-01T00:00:00.000Z',
  origin: 'conversation',
  createdAt: '2026-07-27T09:00:00.000Z',
  updatedAt: '2026-07-27T10:00:00.000Z',
  turns: [],
  workItemRefs: {},
};

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: SESSION,
  progress: null,
  review: null,
  liveReview: null,
  liveVersion: 0,
  liveFailing: false,
  discardedReview: null,
  decided: null,
  jobId: null,
  planId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
  queued: [],
  earlier: null,
  reopened: null,
  readOnly: false,
  acts: [],
};

const SETTLE = narrationSession('s-settle', 'settle');
const LAY = narrationSession('s-lay', 'lay', 'Session handling');
const AUTHOR_A = narrationSession('s-a', 'author', 'Move token refresh into SessionStore');
const AUTHOR_B = narrationSession('s-b', 'author', 'Expire idle sessions server-side');

function stateWith(
  narration: PlanNarrationReadDto | null,
  extra: Partial<PlanChangeConversationState> & { live?: string[]; earlierSeqs?: number[] } = {},
): PlanChangeConversationState {
  const { live = [], earlierSeqs = [], ...rest } = extra;
  return {
    ...BASE,
    narration,
    narrationKept: narration
      ? {
          planId: 'plan_1',
          live,
          earlier: earlierSeqs.map((seq) => narrationEntry(seq, 's-settle', `earlier ${seq}`)),
          loadingEarlier: false,
        }
      : null,
    ...rest,
  };
}

function rail(state: PlanChangeConversationState, onShowEarlierNarration?: () => void) {
  return (
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={state}
      index={indexPlanReview(state.review)}
      targets={[]}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      {...(onShowEarlierNarration ? { onShowEarlierNarration } : {})}
    />
  );
}

function renderRail(
  state: PlanChangeConversationState,
  { locale = 'en', onShowEarlier }: { locale?: 'en' | 'zh'; onShowEarlier?: () => void } = {},
) {
  return renderWithIntl(rail(state, onShowEarlier), {
    locale,
    messages: locale === 'zh' ? zh : en,
  });
}

const groups = () => screen.getAllByTestId('plan-narration-group');
const group = (key: string) =>
  groups().find((g) => g.getAttribute('data-session-key') === key) as HTMLElement;
const messagesOf = (key: string) =>
  within(group(key))
    .queryAllByTestId('plan-narration-message')
    .map((m) => m.textContent?.trim());
const headLine = (key: string) =>
  within(group(key)).getByTestId('plan-narration-head-line').textContent?.trim() ?? '';

/** Two author sessions writing at once, their sentences interleaved by seq. */
const INTERLEAVED = narrationRead(
  [SETTLE, LAY, AUTHOR_A, AUTHOR_B],
  [
    narrationEntry(1, 's-settle', 'Reading your request.'),
    narrationEntry(2, 's-lay', 'Laying out the work under Session handling.'),
    narrationEntry(3, 's-a', 'Reading the refresh service.'),
    narrationEntry(4, 's-b', 'Looking at how idle sessions are kept today.'),
    narrationEntry(5, 's-a', 'Both sign-in routes call it.'),
    narrationEntry(6, 's-b', 'Nothing expires them yet.'),
    narrationEntry(7, 's-a', 'Writing the acceptance criteria.'),
  ],
);

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the narration message, grouped per session', () => {
  it('one session: its sentences, in seq order, under its head, with no bubble and no glyph', () => {
    renderRail(
      stateWith(
        narrationRead(
          [LAY],
          [
            narrationEntry(1, 's-lay', 'First, the layout.'),
            narrationEntry(2, 's-lay', 'Then, the order.'),
          ],
        ),
      ),
    );
    expect(groups()).toHaveLength(1);
    expect(messagesOf('s-lay')).toEqual(['First, the layout.', 'Then, the order.']);
    for (const message of screen.getAllByTestId('plan-narration-message')) {
      expect(message.tagName).toBe('LI');
      expect(message.querySelector('svg')).toBeNull();
      expect(message.className).not.toMatch(/chat-bubble/);
      expect(message.getAttribute('dir')).toBe('auto');
      expect(message.hasAttribute('lang')).toBe(false);
    }
  });

  it('interleaved sessions: each sentence only in its own group, groups in the read’s order', () => {
    renderRail(stateWith(INTERLEAVED, { phase: 'streaming', live: ['s-a', 's-b'] }));
    expect(groups().map((g) => g.getAttribute('data-session-key'))).toEqual([
      's-settle',
      's-lay',
      's-a',
      's-b',
    ]);
    expect(messagesOf('s-a')).toEqual([
      'Reading the refresh service.',
      'Both sign-in routes call it.',
      'Writing the acceptance criteria.',
    ]);
    expect(messagesOf('s-b')).toEqual([
      'Looking at how idle sessions are kept today.',
      'Nothing expires them yet.',
    ]);
  });

  it('a live session: its stored step words, the spinner, and live ink on its newest sentence only', () => {
    renderRail(stateWith(INTERLEAVED, { phase: 'streaming', live: ['s-a'] }));
    const live = group('s-a');
    expect(live.getAttribute('data-session')).toBe('live');
    expect(headLine('s-a')).toBe(
      tEn('act.authoringLine', { title: 'Move token refresh into SessionStore' }),
    );
    expect(within(live).queryByTestId('plan-narration-done')).toBeNull();
    expect(live.querySelector('[role="status"]')).not.toBeNull();
    const inks = within(live)
      .getAllByTestId('plan-narration-message')
      .map((m) => m.classList.contains('text-(--el-text)'));
    expect(inks).toEqual([false, false, true]);
  });

  it('a finished session keeps its stored step words, with the finished mark and no live ink', () => {
    renderRail(stateWith(INTERLEAVED, { phase: 'streaming', live: ['s-a'] }));
    const finished = group('s-b');
    expect(finished.getAttribute('data-session')).toBe('finished');
    expect(headLine('s-b')).toBe(
      `${tEn('act.authoringLine', { title: 'Expire idle sessions server-side' })} ${tEn('narration.done')}`,
    );
    expect(finished.querySelector('[role="status"]')).toBeNull();
    for (const m of within(finished).getAllByTestId('plan-narration-message')) {
      expect(m.classList.contains('text-(--el-text)')).toBe(false);
    }
    expect(within(group('s-lay')).getByTestId('plan-narration-head-line').textContent).toContain(
      tEn('act.layingLine', { target: 'Session handling' }),
    );
  });

  for (const status of ['planned', 'approved', 'declined'] as const) {
    it(`an ended (${status}) plan: every sentence under its real head, nothing live`, () => {
      renderRail(stateWith(INTERLEAVED, { phase: 'review' }));
      expect(screen.getAllByTestId('plan-narration-message')).toHaveLength(7);
      expect(groups().every((g) => g.getAttribute('data-session') === 'finished')).toBe(true);
      expect(screen.getAllByTestId('plan-narration-done')).toHaveLength(4);
      expect(headLine('s-a')).toContain('Move token refresh into SessionStore');
    });
  }

  it('a settle session names the kind alone; a wordless session shows its head alone', () => {
    renderRail(stateWith(narrationRead([SETTLE, LAY], [narrationEntry(1, 's-lay', 'x')])));
    expect(headLine('s-settle')).toBe(`${tEn('narration.settleLine')} ${tEn('narration.done')}`);
    expect(within(group('s-settle')).getByText(tEn('narration.kindSettle'))).toBeTruthy();
    expect(within(group('s-settle')).queryByTestId('plan-narration-messages')).toBeNull();
    expect(within(group('s-settle')).queryByTestId('plan-narration-group-toggle')).toBeNull();
  });

  // MOTIR-11256 — the reconcile, the final check and its fix each head their own
  // group with their own words; none reads as laying, and none says "dry run".
  it('amend, check and repair sessions head their groups with their own words and kind', () => {
    const sessions = [
      narrationSession('s-amend', 'amend', 'Session handling'),
      narrationSession('s-amend-top', 'amend', null),
      narrationSession('s-check', 'check', null),
      narrationSession('s-check-card', 'check', 'Expire idle sessions server-side'),
      narrationSession('s-repair', 'repair', null),
    ];
    renderRail(
      stateWith(
        narrationRead(
          sessions,
          sessions.map((x, i) => narrationEntry(i + 1, x.sessionKey, `note ${i + 1}`)),
        ),
      ),
    );
    const done = ` ${tEn('narration.done')}`;
    expect(headLine('s-amend')).toBe(
      tEn('act.amendingLine', { target: 'Session handling' }) + done,
    );
    expect(headLine('s-amend-top')).toBe(tEn('act.amendingTopLine') + done);
    expect(headLine('s-check')).toBe(tEn('act.checkingLine') + done);
    expect(headLine('s-check-card')).toBe(
      tEn('act.checkingCardLine', { title: 'Expire idle sessions server-side' }) + done,
    );
    expect(headLine('s-repair')).toBe(tEn('act.repairingLine') + done);
    for (const [key, label] of [
      ['s-amend', 'act.amending'],
      ['s-check', 'act.checking'],
      ['s-repair', 'act.repairing'],
    ] as const) {
      expect(within(group(key)).getByText(tEn(label))).toBeTruthy();
      expect(group(key).textContent).not.toMatch(/dry.?run/i);
    }
  });

  it('a sentence with no session row is a headless group before the headed ones', () => {
    renderRail(
      stateWith(narrationRead([LAY], [narrationEntry(1, 's-old', 'Before the store existed.')])),
    );
    const [first, second] = groups();
    expect(first!.getAttribute('data-session')).toBe('unattributed');
    expect(within(first!).queryByTestId('plan-narration-head')).toBeNull();
    expect(first!.textContent).toContain('Before the store existed.');
    expect(second!.getAttribute('data-session-key')).toBe('s-lay');
  });

  it('remounting with the same snapshot — what reopening does — shows every sentence and head again', () => {
    const state = stateWith(INTERLEAVED);
    renderRail(state);
    const before = screen.getByTestId('plan-narration').textContent;
    cleanup();
    renderRail(state);
    expect(screen.getByTestId('plan-narration').textContent).toBe(before);
    expect(screen.getAllByTestId('plan-narration-message')).toHaveLength(7);
  });
});

describe('the collapse-all control', () => {
  it('folds every group and unfolds them all; it never hides a turn, a head or the opener', () => {
    renderRail(stateWith(INTERLEAVED));
    const all = screen.getByTestId('plan-narration-toggle-all');
    expect(all.textContent).toBe(tEn('narration.hideAll', { count: 7 }));
    expect(all.getAttribute('aria-expanded')).toBe('true');
    expect(all.getAttribute('aria-controls')!.split(' ')).toHaveLength(4);

    fireEvent.click(all);
    expect(all.textContent).toBe(tEn('narration.showAll', { count: 7 }));
    expect(all.getAttribute('aria-expanded')).toBe('false');
    for (const list of screen.getAllByTestId('plan-narration-messages')) {
      expect(list.hidden).toBe(true);
    }
    expect(screen.getAllByTestId('plan-narration-head')).toHaveLength(4);
    expect(screen.getByText('What should change — or what would you like to know?')).toBeTruthy();

    fireEvent.click(all);
    for (const list of screen.getAllByTestId('plan-narration-messages')) {
      expect(list.hidden).toBe(false);
    }
  });

  it('one group opens alone, and a later collapse-all folds it again', () => {
    renderRail(stateWith(INTERLEAVED));
    const all = screen.getByTestId('plan-narration-toggle-all');
    fireEvent.click(all);
    const toggle = within(group('s-a')).getByTestId('plan-narration-group-toggle');
    expect(toggle.textContent).toBe(tEn('narration.groupCount', { count: 3 }));
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(group('s-a')).getByTestId('plan-narration-messages').hidden).toBe(false);
    expect(within(group('s-b')).getByTestId('plan-narration-messages').hidden).toBe(true);
    expect(all.textContent).toBe(tEn('narration.showAll', { count: 7 }));

    fireEvent.click(all); // Show: everything opens
    fireEvent.click(all); // Hide: everything folds, the one opened alone too
    expect(within(group('s-a')).getByTestId('plan-narration-messages').hidden).toBe(true);
  });

  it('remembers the choice per browser and restores it on a remount', () => {
    renderRail(stateWith(INTERLEAVED));
    fireEvent.click(screen.getByTestId('plan-narration-toggle-all'));
    expect(window.localStorage.getItem(PLANNER_NOTES_STORAGE_KEY)).toBe('collapsed');
    cleanup();

    renderRail(stateWith(INTERLEAVED));
    expect(screen.getByTestId('plan-narration-toggle-all').getAttribute('aria-expanded')).toBe(
      'false',
    );
    fireEvent.click(screen.getByTestId('plan-narration-toggle-all'));
    expect(window.localStorage.getItem(PLANNER_NOTES_STORAGE_KEY)).toBe('expanded');
  });

  it('storage that throws renders expanded, and the control still works', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderRail(stateWith(INTERLEAVED));
    const all = screen.getByTestId('plan-narration-toggle-all');
    expect(all.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(all);
    expect(all.getAttribute('aria-expanded')).toBe('false');
  });

  it('is absent with no sentence; a plan with no narration renders no block at all', () => {
    renderRail(stateWith(narrationRead([LAY], [])));
    expect(screen.queryByTestId('plan-narration-toggle-all')).toBeNull();
    expect(screen.getAllByTestId('plan-narration-head')).toHaveLength(1);
    cleanup();

    renderRail(stateWith(null));
    expect(screen.queryByTestId('plan-narration')).toBeNull();
    cleanup();
    renderRail(stateWith(narrationRead([], [])));
    expect(screen.queryByTestId('plan-narration')).toBeNull();
  });
});

describe('earlier sentences', () => {
  it('“N earlier notes” asks for the page, and kept pages sit in their own groups above the window', () => {
    const onShowEarlier = vi.fn();
    const read = {
      ...narrationRead([SETTLE, LAY], [narrationEntry(101, 's-lay', 'the window')]),
    };
    renderRail(stateWith(read), { onShowEarlier });
    const earlier = screen.getByTestId('plan-narration-earlier');
    expect(earlier.textContent).toBe(tEn('narration.earlier', { count: 100 }));
    fireEvent.click(earlier);
    expect(onShowEarlier).toHaveBeenCalledTimes(1);
    cleanup();

    renderRail(stateWith(read, { earlierSeqs: [99, 100] }), { onShowEarlier });
    expect(screen.getByTestId('plan-narration-earlier').textContent).toBe(
      tEn('narration.earlier', { count: 98 }),
    );
    expect(messagesOf('s-settle')).toEqual(['earlier 99', 'earlier 100']);
    expect(messagesOf('s-lay')).toEqual(['the window']);
    // The count on the control is the plan's total, not what is in hand.
    expect(screen.getByTestId('plan-narration-toggle-all').textContent).toBe(
      tEn('narration.hideAll', { count: 101 }),
    );
  });
});

describe('display length, language and the live regions', () => {
  it('a 200-char sentence, an unbroken path and a long title wrap in full, never clamped', () => {
    const long = 'word '.repeat(40).trim();
    const path = 'lib/' + 'very-long-directory-name/'.repeat(6) + 'file.ts';
    const title = 'A very long target title '.repeat(6).trim();
    renderRail(
      stateWith(
        narrationRead(
          [narrationSession('s-long', 'author', title)],
          [narrationEntry(1, 's-long', long), narrationEntry(2, 's-long', path)],
        ),
      ),
    );
    const [first, second] = screen.getAllByTestId('plan-narration-message');
    expect(first!.textContent).toBe(long);
    expect(second!.textContent).toBe(path);
    for (const m of [first!, second!]) {
      expect(m.className).toContain('wrap-anywhere');
      expect(m.className).not.toMatch(/line-clamp|truncate/);
    }
    const head = screen.getByTestId('plan-narration-head-line');
    expect(head.className).toContain('wrap-anywhere');
    expect(screen.getByTestId('plan-narration-head-title').textContent).toBe(title);
    expect(screen.getByTestId('plan-narration-head-title').getAttribute('dir')).toBe('auto');
  });

  it('zh interface: the copy is Chinese, the sentence and the title are as written', () => {
    renderRail(stateWith(INTERLEAVED, { phase: 'streaming', live: ['s-a'] }), { locale: 'zh' });
    expect(screen.getByTestId('plan-narration-toggle-all').textContent).toBe(
      tZh('narration.hideAll', { count: 7 }),
    );
    expect(headLine('s-b')).toBe(
      `${tZh('act.authoringLine', { title: 'Expire idle sessions server-side' })} ${tZh('narration.done')}`,
    );
    expect(messagesOf('s-a')).toContain('Reading the refresh service.');
    expect(
      within(group('s-a')).getByTestId('plan-narration-messages').getAttribute('aria-label'),
    ).toBe(
      tZh('narration.groupLive', {
        step: tZh('act.authoringLine', { title: 'Move token refresh into SessionStore' }),
      }),
    );
  });

  it('the announcer stays the one live region; the narration block is aria-live="off"', () => {
    renderRail(stateWith(INTERLEAVED, { phase: 'streaming', live: ['s-a'] }));
    const regions = [...document.querySelectorAll('[aria-live]')].filter(
      (el) => el.getAttribute('aria-live') !== 'off',
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]!.getAttribute('data-testid')).toBe('plan-change-progress');
    const block = screen.getByTestId('plan-narration');
    expect(block.getAttribute('aria-live')).toBe('off');
    expect(screen.getByTestId('plan-change-progress').contains(block)).toBe(false);
    expect(screen.getByTestId('plan-change-announcer').textContent).not.toContain(
      'Reading the refresh service.',
    );
  });

  it('the announcer says a new head’s line and a session finishing — never a sentence', () => {
    const view = renderRail(stateWith(INTERLEAVED, { phase: 'streaming', live: ['s-a', 's-b'] }));
    const announcer = screen.getByTestId('plan-change-announcer');
    const lineA = tEn('act.authoringLine', { title: 'Move token refresh into SessionStore' });

    view.rerender(rail(stateWith(INTERLEAVED, { phase: 'streaming', live: ['s-b'] })));
    expect(announcer.textContent).toBe(tEn('narration.groupFinished', { step: lineA }));

    const next = narrationSession('s-c', 'author', 'Log the sign-out');
    const grown = narrationRead(
      [...INTERLEAVED.sessions, next],
      [...INTERLEAVED.entries, narrationEntry(8, 's-c', 'A new sentence.')],
    );
    view.rerender(rail(stateWith(grown, { phase: 'streaming', live: ['s-b', 's-c'] })));
    expect(announcer.textContent).toBe(tEn('act.authoringLine', { title: 'Log the sign-out' }));
    expect(announcer.textContent).not.toContain('A new sentence.');
  });
});

describe('beside the act record and the turns', () => {
  it('the session heads replace the stream’s laying / authoring rows; the run rows stay', () => {
    const acts: PlanChangeProgress[] = [
      { kind: 'submitted' },
      { kind: 'laying', target: 'Session handling' },
      { kind: 'authoring', title: 'Move token refresh into SessionStore' },
    ];
    renderRail(stateWith(INTERLEAVED, { phase: 'streaming', acts, live: ['s-a'] }));
    expect(screen.getByTestId('plan-change-act-submitted')).toBeTruthy();
    expect(screen.queryByTestId('plan-change-act-laying')).toBeNull();
    expect(screen.queryByTestId('plan-change-act-authoring')).toBeNull();
    // With no narration the stream's step rows are drawn as before.
    cleanup();
    renderRail(stateWith(null, { phase: 'streaming', acts }));
    expect(screen.getByTestId('plan-change-act-laying')).toBeTruthy();
  });

  it('a Visitor (read-only) sees the same sentences and heads, the control, and no composer', async () => {
    renderRail(stateWith(INTERLEAVED, { readOnly: true }));
    await act(async () => {});
    expect(screen.getByTestId('planning-read-only')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getAllByTestId('plan-narration-message')).toHaveLength(7);
    expect(screen.getByTestId('plan-narration-toggle-all')).toBeTruthy();
  });
});
