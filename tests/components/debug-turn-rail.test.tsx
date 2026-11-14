// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { resetPickAutoSendClaimsForTests } from '@/lib/planning/pickAutoSend';
import { debugAutoSendKey } from '@/lib/planning/surfaceSeed';
import type {
  DebugLandingDto,
  PlanChangeSessionDto,
  PlanChangeTurnDto,
} from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// MOTIR-7050 — the DEBUG turn as the rail renders it
// (`design/ai-chat/debug-turn.mock.html`; `design/ai-chat/design-notes.md`
// § "⭐ Debug with Motir AI" §3–§5), and the widget's one seeded send.
//
// The rail is presentational — the host owns the conversation — so each case
// hands it the state the hook produces, the way `ask-answer-rail.test.tsx` does.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/backlog',
  useSearchParams: () => new URLSearchParams(),
}));

const LAUNCH = parsePlanningLaunch({ mode: 'project', from: 'project' });

let seq = 0;
function turn(
  role: PlanChangeTurnDto['role'],
  body: string,
  extra: Partial<PlanChangeTurnDto> = {},
): PlanChangeTurnDto {
  seq += 1;
  return {
    id: `t${seq}`,
    seq,
    role,
    body,
    jobId: null,
    question: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-09-30T10:00:00.000Z',
    ...extra,
  };
}

function session(turns: PlanChangeTurnDto[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-09-30T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-09-30T09:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    turns,
    workItemRefs: {},
  };
}

const REPORT =
  'Board drag drops the card one column short\n\nDragging a card into the rightmost column puts it in the column to its left.';

/** The widget path's thread: the person's report, anchored on PROD-412, and the
 *  answer turn carrying the landing its confirmed offer recorded. */
function debugged(landing: DebugLandingDto, opts: { anchored?: boolean; landed?: boolean } = {}) {
  const anchored = opts.anchored ?? true;
  const user = turn('user', REPORT, { jobId: 'debug-1', intent: 'debug' });
  const reply = turn('assistant', '**Likely cause:** the drop handler clamps the column index.', {
    jobId: 'debug-1',
    citations: landing.workItemKey ? [landing.workItemKey] : [],
    debugLanding: (opts.landed ?? true) ? landing : null,
  });
  return {
    session: session([user, reply]),
    turnAnchors: anchored ? { [user.id]: 'PROD-412' } : {},
  };
}

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: session([]),
  progress: null,
  acts: [],
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
};

const handlers = {
  onSend: vi.fn(),
  onRetry: vi.fn(),
  onCorrectTurn: vi.fn(),
  onApprove: vi.fn(),
  onDiscard: vi.fn(),
  onAddTarget: vi.fn(),
  onRemoveTarget: vi.fn(),
  onStop: vi.fn(),
};

function railElement(
  state: Partial<PlanChangeConversationState> = {},
  extra: Partial<React.ComponentProps<typeof PlanChangeRail>> = {},
) {
  const merged = { ...BASE, ...state };
  return (
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={merged}
      index={indexPlanReview(merged.review)}
      targets={[]}
      {...handlers}
      {...extra}
    />
  );
}

function renderRail(
  state: Partial<PlanChangeConversationState> = {},
  extra: Partial<React.ComponentProps<typeof PlanChangeRail>> = {},
) {
  return renderWithIntl(railElement(state, extra));
}

beforeEach(() => {
  seq = 0;
  resetPickAutoSendClaimsForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const fn of Object.values(handlers)) fn.mockReset();
});

describe('the debug turn, RUNNING (panel 1)', () => {
  const user = () => turn('user', REPORT, { jobId: 'debug-1', intent: 'debug' });

  it('puts the anchored triage bug on the sent turn as a key chip — no item header', () => {
    const sent = user();
    renderRail({
      phase: 'streaming',
      session: session([sent]),
      turnAnchors: { [sent.id]: 'PROD-412' },
      progress: { kind: 'reading' },
      acts: [{ kind: 'reading' }],
    });

    // The shipped target row: "Targeting 1 item" + the key chip.
    expect(screen.getByText('Targeting 1 item')).toBeTruthy();
    expect(screen.getByText('PROD-412')).toBeTruthy();
    // The person's words, line breaks kept.
    expect(screen.getByText(/Board drag drops the card one column short/)).toBeTruthy();
    // The rail head keeps the PROJECT mode pill: the conversation is the project's.
    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('plan');
  });

  it('draws no target row on an UNANCHORED turn (the orb path)', () => {
    renderRail({ phase: 'streaming', session: session([user()]) });
    expect(screen.queryByText('Targeting 1 item')).toBeNull();
  });

  it('a report is READ: the record shows the reading act, and no debug hand-off (MOTIR-9232)', () => {
    renderRail({
      phase: 'streaming',
      session: session([user()]),
      progress: { kind: 'reading' },
      acts: [{ kind: 'reading' }],
    });

    const acts = screen.getByTestId('plan-change-acts');
    expect(within(acts).getByTestId('plan-change-act-reading')).toBeTruthy();
    expect(screen.queryByTestId('plan-change-handoff-debug')).toBeNull();
    expect(screen.queryByTestId('plan-change-handoff')).toBeNull();
    expect(screen.queryByText(/classif/i)).toBeNull();
    expect(
      screen.queryByText(/Tracing the bug|Checking whether a work item already covers it/),
    ).toBeNull();
  });
});

describe('the debug turn, FINISHED — the outcome line (panels 2–4)', () => {
  function outcomeLine() {
    return screen.getByTestId('plan-change-debug-outcome');
  }

  it('diagnose onto the anchored triage bug: "It stays in Triage", with the card linked', () => {
    renderRail(
      debugged({
        outcome: 'diagnose',
        workItemKey: 'PROD-412',
        title: 'Board drag drops the card one column short',
        createdInTriage: false,
      }),
    );

    const line = outcomeLine();
    expect(line.getAttribute('data-outcome')).toBe('diagnose');
    expect(line.textContent).toBe(
      'Wrote the diagnosis onto PROD-412Board drag drops the card one column short. It stays in Triage, and nothing else changed.',
    );
    // The card is the shipped chip — a peek link, never a navigation away.
    const chip = within(line).getByRole('link');
    expect(chip.className).toContain('wi-chip');
    expect(chip.textContent).toContain('PROD-412');
    // The outcome line takes the foot slot: no "Answered from 1 work item" beside it.
    expect(screen.queryByTestId('plan-change-citation-count')).toBeNull();
    // The prose is Motir AI's own, in the ordinary assistant bubble.
    expect(screen.getByTestId('plan-change-report').textContent).toContain('Likely cause:');
  });

  it('diagnose with no anchor (the orb path): the bug it FILED', () => {
    renderRail(
      debugged(
        {
          outcome: 'diagnose',
          workItemKey: 'PROD-414',
          title: 'Drag drops one column short',
          createdInTriage: true,
        },
        { anchored: false },
      ),
    );

    expect(outcomeLine().textContent).toBe(
      'Filed PROD-414Drag drops one column short with the diagnosis. Nothing else changed.',
    );
  });

  it('enrich_existing on the widget path names the covering card, and the anchor left as it is', () => {
    renderRail(
      debugged({
        outcome: 'enrich_existing',
        workItemKey: 'PROD-318',
        title: 'Last board column rejects drops',
        createdInTriage: false,
      }),
    );

    const line = outcomeLine();
    expect(line.textContent).toBe(
      'Added the diagnosis to PROD-318Last board column rejects drops, which already covers this bug. Nothing new was filed, and PROD-412 is left as it is.',
    );
    // The anchor is PLAIN TEXT — the turn did not touch it — so only one chip.
    expect(within(line).getAllByRole('link')).toHaveLength(1);
  });

  it('enrich_existing on the orb path', () => {
    renderRail(
      debugged(
        {
          outcome: 'enrich_existing',
          workItemKey: 'PROD-318',
          title: 'Last board column rejects drops',
          createdInTriage: false,
        },
        { anchored: false },
      ),
    );

    expect(outcomeLine().textContent).toBe(
      'Added the diagnosis to PROD-318Last board column rejects drops, which already covers this bug. Nothing new was filed.',
    );
  });

  it('ungrounded: nothing written, no card named — an ordinary bubble, not the error block', () => {
    renderRail(
      debugged({ outcome: 'ungrounded', workItemKey: null, title: null, createdInTriage: false }),
    );

    const line = outcomeLine();
    expect(line.textContent).toBe("Couldn't trace this to the code, so nothing was written.");
    expect(within(line).queryByRole('link')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // MOTIR-7068: the chip's rules in `markdown-editor.css` match only under a
  // `.motir-prose` or `.wi-chip-host` ancestor, and this line is not MarkdownView —
  // with neither, the type icon drew at 24px on its own line and the key ran into
  // the title. jsdom applies no stylesheet, so this pins both halves: the host on
  // the line, and the stylesheet's chip rules reaching that host.
  it.each([
    ['diagnose', false],
    ['diagnose', true],
    ['enrich_existing', false],
  ] as const)(
    'renders the %s chip (filed: %s) inside a `.wi-chip-host`, which the chip’s rules match',
    (outcome, createdInTriage) => {
      renderRail(
        debugged({
          outcome,
          workItemKey: 'PROD-412',
          title: 'Board drag drops the card one column short',
          createdInTriage,
        }),
      );

      const chip = within(outcomeLine()).getByRole('link');
      expect(chip.closest('.wi-chip-host')).not.toBeNull();
      const css = readFileSync(join(process.cwd(), 'components/ui/markdown-editor.css'), 'utf8');
      expect(css).toContain(':is(.motir-prose, .wi-chip-host) .wi-chip {');
      expect(css).toContain(':is(.motir-prose, .wi-chip-host) .wi-chip .wi-type-icon {');
      expect(css).not.toMatch(/(^|\n)\.motir-prose \.wi-chip/);
    },
  );

  it('prefers the thread’s resolved reference for the chip (its status dot included)', () => {
    const state = debugged({
      outcome: 'enrich_existing',
      workItemKey: 'PROD-318',
      title: 'Stale title',
      createdInTriage: false,
    });
    state.session.workItemRefs = {
      'PROD-318': {
        accessible: true,
        id: 'wi_318',
        identifier: 'PROD-318',
        title: 'Last board column rejects drops',
        kind: 'bug',
        archived: false,
        status: { key: 'in_progress', label: 'In progress', category: 'in_progress' },
        type: null,
        assignee: null,
      },
    };
    renderRail(state);

    const line = outcomeLine();
    expect(line.textContent).toContain('Last board column rejects drops');
    expect(line.querySelector('.wi-dot.s-inprogress')).not.toBeNull();
  });

  it('carries the correction marker, labelled "Answer this instead", re-running the USER turn', () => {
    const state = debugged({
      outcome: 'diagnose',
      workItemKey: 'PROD-412',
      title: 'Board drag drops the card one column short',
      createdInTriage: false,
    });
    renderRail(state);

    const marker = screen.getByTestId('plan-change-correct');
    expect(marker.textContent).toBe('Answer this instead');
    expect(marker.getAttribute('data-direction')).toBe('ask');
    fireEvent.click(marker);
    expect(handlers.onCorrectTurn).toHaveBeenCalledWith(state.session.turns[0]?.id);
  });

  it('draws the ordinary answer foot for a debug reply the rail holds no landing for', () => {
    // The turn DTO carries no landing (a reply written before MOTIR-7064
    // persisted one, or an offer not yet confirmed), so the reply reads as an
    // ordinary cited answer rather than inventing an outcome.
    const state = debugged(
      {
        outcome: 'diagnose',
        workItemKey: 'PROD-412',
        title: 'Board drag drops the card one column short',
        createdInTriage: false,
      },
      { landed: false },
    );
    renderRail({ session: state.session });

    expect(screen.queryByTestId('plan-change-debug-outcome')).toBeNull();
    expect(screen.getByTestId('plan-change-citation-count').textContent).toBe(
      'Answered from 1 work item',
    );
  });
});

// MOTIR-7064 — a RELOADED thread. The hook's in-memory seed (`turnAnchors`) is
// gone; only the session DTO the
// reload read is left, so the chip and the outcome line must come from the turns.
describe('the debug turn after a RELOAD — drawn from the turn DTOs alone', () => {
  /** The thread as the server returns it: the anchor on the user turn, the
   *  landing on the reply — and nothing in the hook's client-held state. */
  function reloadedThread(landing: DebugLandingDto, anchorKey: string | null) {
    const user = turn('user', REPORT, { jobId: 'debug-1', intent: 'debug', anchorKey });
    const reply = turn('assistant', '**Likely cause:** the drop handler clamps the column index.', {
      jobId: 'debug-1',
      citations: landing.workItemKey ? [landing.workItemKey] : [],
      debugLanding: landing,
    });
    return { session: session([user, reply]) };
  }

  it.each<[string, DebugLandingDto, string | null, string]>([
    [
      'diagnose onto the anchor',
      {
        outcome: 'diagnose',
        workItemKey: 'PROD-412',
        title: 'Board drag drops the card one column short',
        createdInTriage: false,
      },
      'PROD-412',
      'Wrote the diagnosis onto PROD-412Board drag drops the card one column short. It stays in Triage, and nothing else changed.',
    ],
    [
      'diagnose from the orb',
      {
        outcome: 'diagnose',
        workItemKey: 'PROD-414',
        title: 'Drag drops one column short',
        createdInTriage: true,
      },
      null,
      'Filed PROD-414Drag drops one column short with the diagnosis. Nothing else changed.',
    ],
    [
      'a new bug filed from an anchored turn',
      {
        outcome: 'diagnose',
        workItemKey: 'PROD-500',
        title: 'Drag drops one column short',
        createdInTriage: false,
      },
      'PROD-412',
      'Filed PROD-500Drag drops one column short with the diagnosis. Nothing else changed.',
    ],
    [
      'enrich_existing on the widget path',
      {
        outcome: 'enrich_existing',
        workItemKey: 'PROD-318',
        title: 'Last board column rejects drops',
        createdInTriage: false,
      },
      'PROD-412',
      'Added the diagnosis to PROD-318Last board column rejects drops, which already covers this bug. Nothing new was filed, and PROD-412 is left as it is.',
    ],
    [
      'ungrounded',
      { outcome: 'ungrounded', workItemKey: null, title: null, createdInTriage: false },
      'PROD-412',
      "Couldn't trace this to the code, so nothing was written.",
    ],
  ])('%s: the same outcome line as before the reload', (_label, landing, anchorKey, text) => {
    renderRail(reloadedThread(landing, anchorKey));

    const line = screen.getByTestId('plan-change-debug-outcome');
    expect(line.getAttribute('data-outcome')).toBe(landing.outcome);
    expect(line.textContent).toBe(text);
    expect(screen.queryByTestId('plan-change-citation-count')).toBeNull();
  });

  it('puts the persisted anchor on the user turn as its key chip', () => {
    renderRail(
      reloadedThread(
        {
          outcome: 'diagnose',
          workItemKey: 'PROD-412',
          title: 'Board drag drops the card one column short',
          createdInTriage: false,
        },
        'PROD-412',
      ),
    );
    expect(screen.getByText('Targeting 1 item')).toBeTruthy();
  });

  it('a stored debug turn and a stored new-session confirm still render after the debug arm retired (MOTIR-9232)', () => {
    const landing: DebugLandingDto = {
      outcome: 'diagnose',
      workItemKey: 'PROD-412',
      title: 'Board drag drops the card one column short',
      createdInTriage: false,
    };
    const { session: thread } = reloadedThread(landing, 'PROD-412');
    const restartUser = turn('user', 'Forget this, plan the mobile app instead.', {
      intent: 'new_session',
    });
    const confirm = turn('assistant', 'stored body that should never show', {
      confirm: 'new_session',
    });
    renderRail(
      { session: { ...thread, turns: [...thread.turns, restartUser, confirm] } },
      { onConfirmRestart: vi.fn(), onAnswerRestart: vi.fn() },
    );

    const line = screen.getByTestId('plan-change-debug-outcome');
    expect(line.getAttribute('data-outcome')).toBe('diagnose');
    expect(line.textContent).toBe(
      'Wrote the diagnosis onto PROD-412Board drag drops the card one column short. It stays in Triage, and nothing else changed.',
    );
    const confirmTurn = screen.getByTestId('planning-restart-confirm-turn');
    expect(confirmTurn.textContent).toContain('Start something new?');
    expect(confirmTurn.textContent).not.toContain('stored body');
  });

  it('an ordinary ask thread (no anchor, no landing) renders exactly as before', () => {
    const user = turn('user', 'What is in the sprint?', {
      jobId: 'ask-1',
      intent: 'ask',
      anchorKey: null,
      debugLanding: null,
    });
    const reply = turn('assistant', 'Two cards.', {
      jobId: 'ask-1',
      citations: ['PROD-1'],
      anchorKey: null,
      debugLanding: null,
    });
    renderRail({ session: session([user, reply]) });

    expect(screen.queryByText('Targeting 1 item')).toBeNull();
    expect(screen.queryByTestId('plan-change-debug-outcome')).toBeNull();
    expect(screen.getByTestId('plan-change-citation-count').textContent).toBe(
      'Answered from 1 work item',
    );
  });
});

describe('the debug turn, OUT OF CREDITS (panel 5)', () => {
  it('is the shipped paywall, unchanged — the user turn stays, nothing else is drawn', () => {
    const sent = turn('user', REPORT, { jobId: 'ask-1', intent: 'ask' });
    renderRail({
      session: session([sent]),
      turnAnchors: { [sent.id]: 'PROD-412' },
      outOfCredits: true,
    });

    expect(screen.getByText(/you're out of credits/i)).toBeTruthy();
    expect(screen.getByText(/Board drag drops the card one column short/)).toBeTruthy();
    expect(screen.queryByTestId('plan-change-debug-outcome')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the WIDGET’s seeded send — exactly once', () => {
  const seedProps = (onAutoSend: (text: string) => void) => ({
    autoSendTurn: REPORT,
    autoSendKey: debugAutoSendKey('PROD-412'),
    autoSendIntoThread: true,
    onAutoSend,
  });

  it('sends the report once, through its own sender, as soon as the thread is idle', () => {
    const onAutoSend = vi.fn();
    renderRail({}, seedProps(onAutoSend));

    expect(onAutoSend).toHaveBeenCalledTimes(1);
    expect(onAutoSend).toHaveBeenCalledWith(REPORT);
    // Not through the composer's ordinary send, which carries no anchor.
    expect(handlers.onSend).not.toHaveBeenCalled();
  });

  it('JOINS a thread that already holds turns — the project conversation is resumed', () => {
    const onAutoSend = vi.fn();
    renderRail(
      { session: session([turn('user', 'an earlier question', { intent: 'ask' })]) },
      seedProps(onAutoSend),
    );
    expect(onAutoSend).toHaveBeenCalledTimes(1);
  });

  it('waits while the thread is still loading, then sends once', () => {
    const onAutoSend = vi.fn();
    const view = renderRail({ phase: 'loading', session: null }, seedProps(onAutoSend));
    expect(onAutoSend).not.toHaveBeenCalled();

    view.rerender(railElement({ phase: 'idle' }, seedProps(onAutoSend)));
    view.rerender(railElement({ phase: 'streaming' }, seedProps(onAutoSend)));
    view.rerender(railElement({ phase: 'idle' }, seedProps(onAutoSend)));
    expect(onAutoSend).toHaveBeenCalledTimes(1);
  });

  it('a REMOUNT or a second open on the same page does not send it again', () => {
    const onAutoSend = vi.fn();
    const first = renderRail({}, seedProps(onAutoSend));
    first.unmount();
    renderRail({}, seedProps(onAutoSend));

    expect(onAutoSend).toHaveBeenCalledTimes(1);
  });

  it('never sends into a conversation this viewer may only read', () => {
    const onAutoSend = vi.fn();
    renderRail({ readOnly: true }, seedProps(onAutoSend));
    expect(onAutoSend).not.toHaveBeenCalled();
  });
});

describe('the ORB row’s pre-fill — sent by nobody but the person', () => {
  const PREFILL = 'Something is broken. What happens: \nWhat should happen instead: ';

  it('holds the template UNSENT, focused with the caret at the end of the first line', () => {
    renderRail(
      { session: session([turn('user', 'an earlier question', { intent: 'ask' })]) },
      { initialDraft: PREFILL, initialDraftCaret: PREFILL.indexOf('\n') },
    );

    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(field.value).toBe(PREFILL);
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(PREFILL.indexOf('\n'));
    expect(field.selectionEnd).toBe(PREFILL.indexOf('\n'));
    // Nothing went anywhere.
    expect(handlers.onSend).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the starter chips hidden while the template is in the field', () => {
    renderRail({}, { initialDraft: PREFILL, initialDraftCaret: PREFILL.indexOf('\n') });
    expect(screen.queryByText('Add work to an epic')).toBeNull();
  });
});
