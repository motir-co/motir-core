// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type {
  PlanChangeConversationState,
  PlanChangeProgress,
} from '@/lib/hooks/usePlanChangeConversation';

// THE ACT RAIL (Story MOTIR-4054 · MOTIR-4069) — the run narrated as a RECORD,
// drawn by `design/ai-chat/plan-change-run-live.mock.html` sheet 3: three
// columns (glyph · mono act label · the line), appended in order, never
// collapsed, the newest line live while the run streams. The hook's half — what
// goes INTO `acts` — is `use-plan-change-conversation-edges.test.tsx`; this file
// hands the rail a state and asserts what it draws.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });

function turn(seq: number, body: string): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role: 'user',
    body,
    jobId: null,
    question: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: 'u1',
    createdAt: '2026-07-27T10:00:00.000Z',
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
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-07-27T09:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    turns,
    workItemRefs: {},
  };
}

const BASE: PlanChangeConversationState = {
  phase: 'streaming',
  session: session([turn(0, 'Add recurring invoices.')]),
  progress: null,
  review: null,
  liveReview: null,
  liveVersion: 0,
  liveFailing: false,
  discardedReview: null,
  decided: null,
  jobId: 'job-1',
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

const handlers = {
  onSend: vi.fn(),
  onRetry: vi.fn(),
  onCorrectTurn: vi.fn(),
  onApprove: vi.fn(),
  onDiscard: vi.fn(),
  onAddTarget: vi.fn(),
  onRemoveTarget: vi.fn(),
};

function stateWith(acts: PlanChangeProgress[], extra: Partial<PlanChangeConversationState> = {}) {
  return {
    ...BASE,
    acts,
    progress: acts.length > 0 ? acts[acts.length - 1]! : null,
    ...extra,
  };
}

function renderRail(state: PlanChangeConversationState, onStop?: () => void) {
  return renderWithIntl(
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={state}
      index={indexPlanReview(state.review)}
      targets={[]}
      {...(onStop ? { onStop } : {})}
      {...handlers}
    />,
  );
}

function rows(): HTMLLIElement[] {
  return Array.from(screen.getByTestId('plan-change-acts').querySelectorAll('li'));
}

// A drawn row that is not a step the tests below care about. (A lookup is never an
// act — MOTIR-8158 — so the record cannot hold one.)
const ROW: PlanChangeProgress = { kind: 'laying', target: 'MOTIR-9' };

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('PlanChangeRail — the act rail is a RECORD, not a replacing line', () => {
  it('draws one row per act, in the order narrated, and two identical rows stay two rows', () => {
    renderRail(stateWith([{ kind: 'submitted' }, ROW, ROW]));

    const list = rows();
    expect(list).toHaveLength(3);
    expect(list[0]!.textContent).toMatch(/submit/i);
    expect(list[0]!.textContent).toContain('Sending the conversation to Motir AI…');
    // ⚠️ Never de-duplicated: a rail that folds these into "2 lookups" has
    // turned a record into a summary.
    expect(list[1]!.textContent).toContain('Laying out MOTIR-9');
    expect(list[2]!.textContent).toContain('Laying out MOTIR-9');
    // The three columns: glyph · mono label · line.
    expect(list[1]!.querySelector('svg')).not.toBeNull();
    expect(list[1]!.querySelector('.font-mono')?.textContent).toBe('lay');
  });

  // ⚠️ AMENDED BY MOTIR-7979, to MOTIR-7975's a11y decision: the record used to
  // sit INSIDE the polite region, so every appended row was read aloud. With one
  // line per tool call that is a log read aloud, so the region (same test id,
  // same politeness) now holds an announcer and the record is its sibling.
  it('keeps the shipped polite live region, and the newest act is announced from it', () => {
    renderRail(stateWith([ROW]));
    const region = screen.getByTestId('plan-change-progress');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.contains(screen.getByTestId('plan-change-acts'))).toBe(false);
    expect(region.textContent).toContain('Laying out MOTIR-9');
  });

  it('the LIVE line is the last one while streaming — full ink and the spinner; the rest are past', () => {
    renderRail(stateWith([{ kind: 'submitted' }, ROW, { kind: 'laying', target: 'MOTIR-1' }]));

    const list = rows();
    expect(list[2]!.classList.contains('text-(--el-text)')).toBe(true);
    // The shipped Spinner keeps its `role="status"`; it takes the glyph slot.
    expect(list[2]!.querySelector('[role="status"]')).not.toBeNull();
    expect(list[2]!.querySelector('svg')).toBeNull();
    // Past lines: secondary ink, and the glyph — not the spinner — in the slot.
    for (const past of [list[0]!, list[1]!]) {
      expect(past.classList.contains('text-(--el-text-secondary)')).toBe(true);
      expect(past.querySelector('[role="status"]')).toBeNull();
      expect(past.querySelector('svg')).not.toBeNull();
    }
  });

  it('the record SURVIVES the run — settled, nothing is live and nothing is dropped', () => {
    renderRail(stateWith([{ kind: 'submitted' }, ROW], { phase: 'review', progress: null }));
    const list = rows();
    expect(list).toHaveLength(2);
    for (const row of list) expect(row.classList.contains('text-(--el-text)')).toBe(false);
  });
});

describe('PlanChangeRail — the lines (sheet 3’s table)', () => {
  it('the planner’s OWN prose line renders verbatim', () => {
    renderRail(stateWith([{ kind: 'note', text: 'the billing epic already owns this' }]));
    const [row] = rows();
    expect(row!.textContent).toContain('the billing epic already owns this');
    expect(row!.querySelector('.font-mono')?.textContent).toBe('note');
  });

  it('laying and authoring name what is being laid and written; the shipped lines are unchanged', () => {
    renderRail(
      stateWith([
        { kind: 'laying', target: 'MOTIR-42' },
        { kind: 'authoring', title: 'Monthly schedule' },
        { kind: 'proposed', count: 2 },
        { kind: 'validating' },
      ]),
    );
    const text = rows().map((r) => r.textContent ?? '');
    expect(text[0]).toContain('Laying out MOTIR-42');
    expect(text[1]).toContain('Writing Monthly schedule');
    expect(text[2]).toContain('2 items proposed so far…');
    expect(text[3]).toContain('Checking the proposal against your plan…');
  });
});

// MOTIR-11256 — the reconcile, the final check and its fix read as themselves.
describe('PlanChangeRail — the amend, check and repair acts', () => {
  it('each has its own label and line; none reads as laying or says dry run', () => {
    renderRail(
      stateWith([
        { kind: 'amending', target: 'MOTIR-42' },
        { kind: 'amending', target: null },
        { kind: 'checking' },
        { kind: 'repairing' },
      ]),
    );
    const all = rows();
    expect(all.map((r) => r.querySelector('.font-mono')?.textContent)).toEqual([
      'reconcile',
      'reconcile',
      'check',
      'fix',
    ]);
    const text = all.map((r) => r.textContent ?? '');
    expect(text[0]).toContain('Reconciling the items under MOTIR-42');
    expect(text[1]).toContain('Reconciling the items at the top level');
    expect(text[2]).toContain('Running the final check');
    expect(text[3]).toContain('Fixing what the final check found');
    for (const line of text) {
      expect(line).not.toMatch(/laying|dry.?run/i);
    }
    // The newest row is live and takes the spinner; the past ones carry their glyph.
    for (const row of all.slice(0, -1)) expect(row.querySelector('svg')).not.toBeNull();
  });
});

describe('PlanChangeRail — the running bar repeats the live act’s OWN line', () => {
  it('a note in the bar is the planner’s words', () => {
    const onStop = vi.fn();
    renderRail(stateWith([ROW, { kind: 'note', text: 'billing already owns this' }]), onStop);
    expect(screen.getByTestId('plan-change-running-bar').textContent).toContain(
      'billing already owns this',
    );
  });
});

describe('PlanChangeRail — the transcript FOLLOWS the newest act (sheet 5)', () => {
  // Nine act lines fit at the 1366×768 floor after the ordinary opening, and a
  // real run emits several times that, so the transcript WILL scroll. Following
  // the newest act is what keeps the record readable; NOT following once the
  // reader has scrolled up is what makes leaving them alone safe.
  function tall(log: HTMLElement, scrollHeight: number) {
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 300 });
  }

  it('scrolls to the bottom as acts arrive while the reader is at the bottom', () => {
    const view = renderRail(stateWith([{ kind: 'submitted' }]));
    const log = screen.getByRole('log');
    tall(log, 1000);

    view.rerender(
      <PlanChangeRail
        launch={LAUNCH}
        projectName="PayFlow"
        state={stateWith([{ kind: 'submitted' }, ROW])}
        index={indexPlanReview(null)}
        targets={[]}
        {...handlers}
      />,
    );
    expect(log.scrollTop).toBe(1000);
  });

  it('leaves a reader who scrolled UP where they are — the pinned bar carries the live line instead', () => {
    const view = renderRail(stateWith([{ kind: 'submitted' }]));
    const log = screen.getByRole('log');
    tall(log, 1000);
    // The reader scrolls up to re-read an earlier act…
    log.scrollTop = 100;
    fireEvent.scroll(log);

    view.rerender(
      <PlanChangeRail
        launch={LAUNCH}
        projectName="PayFlow"
        state={stateWith([{ kind: 'submitted' }, ROW])}
        index={indexPlanReview(null)}
        targets={[]}
        {...handlers}
      />,
    );
    // …and the next act does not yank them back down.
    expect(log.scrollTop).toBe(100);
  });
});

describe('PlanChangeRail — the record sits ABOVE the surviving proposal (sheet 2, state D)', () => {
  it('acts, then the stopped marker, then the review block', () => {
    renderRail(
      stateWith([{ kind: 'submitted' }, ROW], {
        phase: 'review',
        progress: null,
        stopped: true,
        review: planReview([
          planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story', title: 'Recurring' }),
        ]),
      }),
    );
    const acts = screen.getByTestId('plan-change-acts');
    const stopped = screen.getByTestId('plan-change-stopped');
    const review = screen.getByTestId('plan-change-review');
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(acts, stopped)).toBe(true);
    expect(follows(stopped, review)).toBe(true);
  });
});

// The per-call lines (MOTIR-7979) replaced the interim `call` arm this file used
// to pin, MOTIR-8064 stopped drawing them and MOTIR-8158 removed the `call` act:
// every lookup and tool-call frame is quiet, pinned in
// `plan-change-frame-totality.test.ts`.
