// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { planReview, planReviewItem } from '../helpers/planReview';
import { narrationEntry, narrationRead, narrationSession } from '../helpers/planNarration';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { planGateView } from '@/lib/planning/planGateView';
import { ReaderRoutesProvider } from '@/lib/visitor/useReaderRoutes';
import en from '@/messages/en.json';
import type {
  PlanChangeSessionDto,
  PlanChangeTurnDto,
  PlanSessionFailureDto,
} from '@/lib/dto/planChange';
import type { PlanReviewDto, PlanVersionDto } from '@/lib/dto/planReview';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// THE PLANNING RAIL DURING A PLAN REVISION (Bug MOTIR-11487), built to design
// MOTIR-11486 — `design/ai-chat/design-notes.md` § "⭐ The planning rail during a
// plan revision" and `plan-change-run-live--revision-timeline.mock.html`. Each run
// sits under the turn that started it, each version's briefing where it closed, and
// no decide panel is drawn while the rail's own revision writes. Driven through the
// shipped `PlanChangeRail` with notes from TWO jobs: the first plan run (`job-a`)
// and the revision a follow-up started (`job-b`).

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });
const CONV = en.planningWorkspace.conversation;
const SURFACE = en.approvalGate.planApproval.surface;

const at = (minute: number) => new Date(Date.UTC(2026, 10, 16, 21, minute, 0)).toISOString();

function turn(
  seq: number,
  role: PlanChangeTurnDto['role'],
  body: string,
  jobId: string | null,
  minute: number,
): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role,
    body,
    jobId,
    question: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: at(minute),
  };
}

const ASK = 'Plan the planner finding records.';
const FOLLOW_UP = 'One more requirement: keep the dry run verdict on the record.';
// The first run: asked at :00, its marker at :01, its notes from :02, its version
// closed at :10. The follow-up at :20 starts the revision, its marker at :21.
const FIRST_TURNS = [turn(0, 'user', ASK, null, 0), turn(1, 'system', '', 'job-a', 1)];
const REVISION_TURNS = [
  ...FIRST_TURNS,
  turn(2, 'user', FOLLOW_UP, null, 20),
  turn(3, 'system', '', 'job-b', 21),
];

function session(turns: PlanChangeTurnDto[], extra: Partial<PlanChangeSessionDto> = {}) {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: ['MOTIR-11455'],
    turnCount: turns.length,
    lastJobId: turns.findLast((t) => t.jobId)?.jobId ?? null,
    lastSubmittedAt: null,
    lastActivityAt: at(30),
    origin: 'conversation',
    createdAt: at(0),
    updatedAt: at(30),
    turns,
    workItemRefs: {},
    ...extra,
  } as PlanChangeSessionDto;
}

function sessionAt(key: string, kind: 'settle' | 'lay', minute: number) {
  return { ...narrationSession(key, kind), firstReportedAt: at(minute), updatedAt: at(minute) };
}

const A1 = sessionAt('ai:job-a:1', 'settle', 2);
const A2 = sessionAt('ai:job-a:2', 'lay', 3);
const B1 = sessionAt('ai:job-b:1', 'settle', 22);
const NOTES_A = [
  narrationEntry(1, 'ai:job-a:1', 'The ask is one record per finding.'),
  narrationEntry(2, 'ai:job-a:2', 'Three cards: the table, the write door, the console read.'),
];
const NOTE_B = narrationEntry(3, 'ai:job-b:1', 'The follow-up changes the record itself.');

const V1: PlanVersionDto = {
  id: 'rev-v1',
  plannedAt: at(10),
  itemCount: 3,
  summary: 'Version one briefing.',
};
const V2: PlanVersionDto = { id: 'rev-v2', plannedAt: at(30), itemCount: 4, summary: 'V2.' };

function review(summary: string, versions: PlanVersionDto[]): PlanReviewDto {
  return {
    ...planReview([planReviewItem()]),
    id: 'plan-1',
    status: 'planned',
    summary,
    versions,
    gate: { id: 'gate-1', state: 'awaiting', stamp: 'stamp-1', held: null, canDecide: true },
  } as PlanReviewDto;
}

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: session(REVISION_TURNS),
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

/** The revision is WRITING: the follow-up's job streams, settled into planning. */
const WRITING: PlanChangeConversationState = {
  ...BASE,
  phase: 'streaming',
  jobId: 'job-b',
  planId: 'plan-1',
  settledJobId: 'job-b',
  review: review('Version one briefing.', [V1]),
  narration: narrationRead([A1, A2, B1], [...NOTES_A, NOTE_B]),
  narrationKept: { planId: 'plan-1', live: ['ai:job-b:1'], earlier: [], loadingEarlier: false },
};

/** The revision FINISHED: a second version closed under it. */
const FINISHED: PlanChangeConversationState = {
  ...BASE,
  review: review('Version two briefing.', [V1, V2]),
  narration: narrationRead([A1, A2, B1], [...NOTES_A, NOTE_B]),
  narrationKept: { planId: 'plan-1', live: [], earlier: [], loadingEarlier: false },
};

/** The revision FAILED: nothing closed, the first version still waits. */
const FAILURE: PlanSessionFailureDto = {
  failedAt: at(25),
  reason: 'internal',
  stopPhase: null,
  stopRef: null,
  stopTitle: null,
  resumable: false,
};
const FAILED: PlanChangeConversationState = {
  ...BASE,
  session: session(REVISION_TURNS, {
    failure: FAILURE,
    failedWaiting: 'reply',
    waitingPlan: { planId: 'plan-1', title: 'Planner finding records', status: 'planned' },
  }),
  review: review('Version one briefing.', [V1]),
  narration: narrationRead([A1, A2, B1], [...NOTES_A, NOTE_B]),
  narrationKept: { planId: 'plan-1', live: [], earlier: [], loadingEarlier: false },
};

const onApprove = vi.fn();

function rail(state: PlanChangeConversationState, rewriting = false) {
  return (
    <PlanChangeRail
      launch={LAUNCH}
      projectName="Motir"
      state={state}
      index={indexPlanReview(state.review)}
      targets={[]}
      gateView={planGateView({ review: state.review, rewriting })}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={onApprove}
      onDiscard={vi.fn()}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      onRequestDecline={vi.fn()}
    />
  );
}

function renderRail(state: PlanChangeConversationState, rewriting = false) {
  return renderWithIntl(rail(state, rewriting), { locale: 'en', messages: en });
}

/** Every node, asserted to sit in the DOM in the order given. */
function expectInOrder(...nodes: HTMLElement[]) {
  for (let i = 1; i < nodes.length; i++) {
    const before = nodes[i - 1]!;
    const after = nodes[i]!;
    expect(
      before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
      `${before.textContent?.slice(0, 40)} should come before ${after.textContent?.slice(0, 40)}`,
    ).toBeTruthy();
  }
}

const runOf = (job: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="plan-narration-groups"]')].find(
    (list) =>
      list.querySelector(`[data-session-key^="ai:${job}:"]`) !== null &&
      list.querySelectorAll('[data-session-key]').length ===
        list.querySelectorAll(`[data-session-key^="ai:${job}:"]`).length,
  )!;
const markers = () => screen.getAllByTestId('plan-change-marker');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('while a revision is writing (design panel 2)', () => {
  it('reads first notes → first briefing → follow-up → marker → hand-off → the revision’s notes', () => {
    renderRail(WRITING, true);
    expect(runOf('job-a')).toBeTruthy();
    expect(runOf('job-b')).toBeTruthy();
    // Two runs, two blocks: one finished block for job-a, the working row for job-b.
    expect(runOf('job-a')).not.toBe(runOf('job-b'));
    expectInOrder(
      screen.getByText(ASK),
      markers()[0]!,
      runOf('job-a'),
      screen.getByTestId('plan-change-briefing'),
      screen.getByText(FOLLOW_UP),
      markers()[1]!,
      screen.getByTestId('plan-handoff'),
      runOf('job-b'),
    );
    // The finished run is its own block; the hand-off belongs to the run on screen.
    const block = screen.getByTestId('plan-run-block');
    expect(block.getAttribute('data-run')).toBe('ai:job-a');
    expect(block.contains(runOf('job-a'))).toBe(true);
    expect(screen.getByTestId('plan-work-row').contains(runOf('job-b'))).toBe(true);
  });

  it('draws no decide panel: no Nothing saved yet, no held line, no Approve', () => {
    renderRail(WRITING, true);
    expect(screen.queryByTestId('plan-change-review')).toBeNull();
    expect(screen.queryByText(CONV.nothingSavedYet)).toBeNull();
    expect(screen.queryByText(SURFACE.held)).toBeNull();
    expect(screen.queryByRole('button', { name: SURFACE.approve })).toBeNull();
    // The version above is still the plan on the canvas: no earlier-version label yet.
    expect(screen.queryByText(CONV.revision.earlierVersion)).toBeNull();
  });

  it('also when the rail is ungated: the shipped review panel steps aside too', () => {
    renderWithIntl(
      <PlanChangeRail
        launch={LAUNCH}
        projectName="Motir"
        state={WRITING}
        index={indexPlanReview(WRITING.review)}
        targets={[]}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onCorrectTurn={vi.fn()}
        onApprove={vi.fn()}
        onDiscard={vi.fn()}
        onAddTarget={vi.fn()}
        onRemoveTarget={vi.fn()}
      />,
      { locale: 'en', messages: en },
    );
    expect(screen.queryByTestId('plan-change-review')).toBeNull();
  });

  it('keeps the held panel for a revision this rail is not following (another harness)', () => {
    const heldElsewhere = review('Version one briefing.', [V1]);
    heldElsewhere.gate = {
      ...heldElsewhere.gate!,
      held: { reason: 'revision_in_flight', heldBy: 'Claude Code', expiresAt: at(40) },
    };
    renderRail({ ...BASE, session: session(FIRST_TURNS), review: heldElsewhere });
    expect(screen.getByTestId('plan-change-review')).toBeTruthy();
    expect(screen.getByTestId('plan-change-briefing')).toBeTruthy();
  });
});

describe('when the revision finishes (design panel 3)', () => {
  it('draws the new briefing and a live panel under the revision’s notes', () => {
    renderRail(FINISHED);
    const earlier = screen.getByTestId('plan-change-earlier-briefing');
    const current = screen.getByTestId('plan-change-briefing');
    const panel = screen.getByTestId('plan-change-review');
    expectInOrder(
      runOf('job-a'),
      earlier,
      screen.getByText(FOLLOW_UP),
      markers()[1]!,
      runOf('job-b'),
      current,
      panel,
    );
    expect(within(earlier).getByText(CONV.revision.earlierVersion)).toBeTruthy();
    expect(within(earlier).getByText('Version one briefing.')).toBeTruthy();
    expect(within(current).getByText('Version two briefing.')).toBeTruthy();
    const approve = within(panel).getByRole('button', { name: SURFACE.approve });
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('only the newest version carries a panel', () => {
    renderRail(FINISHED);
    expect(screen.getAllByTestId('plan-change-review')).toHaveLength(1);
  });

  it('a version closed before briefings were kept is one line with its count', () => {
    renderRail({
      ...FINISHED,
      review: review('Version two briefing.', [{ ...V1, summary: null }, V2]),
    });
    expect(screen.queryByTestId('plan-change-earlier-briefing')).toBeNull();
    const unkept = screen.getByTestId('plan-change-earlier-unkept');
    expect(unkept.textContent).toContain(
      'An earlier version of this plan was here (3 items). Its briefing was not kept.',
    );
    expectInOrder(runOf('job-a'), unkept, screen.getByText(FOLLOW_UP));
  });

  it('one rail-wide fold: Hide in one run’s block folds every block', () => {
    renderRail(FINISHED);
    const toggles = screen.getAllByTestId('plan-narration-toggle-all');
    expect(toggles).toHaveLength(2);
    expect(toggles.every((t) => t.getAttribute('aria-expanded') === 'true')).toBe(true);
    fireEvent.click(toggles[1]!);
    expect(
      screen
        .getAllByTestId('plan-narration-toggle-all')
        .every((t) => t.getAttribute('aria-expanded') === 'false'),
    ).toBe(true);
  });
});

describe('when the revision fails or is stopped (design panel 4)', () => {
  it('failed: the failure line under the revision’s notes, then the old version’s live panel', () => {
    renderRail(FAILED);
    const briefing = screen.getByTestId('plan-change-briefing');
    const failure = screen.getByTestId('planning-failure-line');
    const panel = screen.getByTestId('plan-change-review');
    expectInOrder(
      runOf('job-a'),
      briefing,
      screen.getByText(FOLLOW_UP),
      runOf('job-b'),
      failure,
      panel,
    );
    expect(screen.getAllByTestId('planning-failure-line')).toHaveLength(1);
    expect(screen.queryByText(CONV.revision.earlierVersion)).toBeNull();
    const approve = within(panel).getByRole('button', { name: SURFACE.approve });
    expect((approve as HTMLButtonElement).disabled).toBe(false);
  });

  it('stopped: the stopped marker under the revision’s notes, then the old version’s live panel', () => {
    renderRail({ ...FINISHED, stopped: true, review: review('Version one briefing.', [V1]) });
    const panel = screen.getByTestId('plan-change-review');
    expectInOrder(
      screen.getByTestId('plan-change-briefing'),
      screen.getByText(FOLLOW_UP),
      runOf('job-b'),
      screen.getByTestId('plan-change-stopped'),
      panel,
    );
    expect(
      (within(panel).getByRole('button', { name: SURFACE.approve }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe('reopened after the revision (design panel 5)', () => {
  it('draws the same order from the stored turns and narration alone', () => {
    // A reopen: nothing streams and no act is in memory; a later question was asked
    // and answered after the revision, so the revision's notes must stay under its turn.
    const later = [
      ...REVISION_TURNS,
      turn(4, 'user', 'Which card carries the migration?', null, 40),
      turn(5, 'assistant', 'The table card carries it.', 'job-c', 41),
    ];
    renderRail({
      ...FINISHED,
      session: session(later),
      reopened: { mine: true, lastActivityAt: at(41), startedBy: null },
    } as PlanChangeConversationState);
    expectInOrder(
      runOf('job-a'),
      screen.getByTestId('plan-change-earlier-briefing'),
      screen.getByText(FOLLOW_UP),
      runOf('job-b'),
      screen.getByText('Which card carries the migration?'),
    );
  });
});

describe('reopened while the revision still writes', () => {
  it('the working row holds the session’s latest job, under its own turn', () => {
    // Nothing streams on this page: the plan is `generating` and the rail follows it
    // by the session's latest job, which is the revision's.
    renderRail({
      ...WRITING,
      phase: 'idle',
      jobId: null,
      liveReview: { ...planReview([]), id: 'plan-1', status: 'generating', progress: null },
    });
    expect(screen.getByTestId('plan-work-row').contains(runOf('job-b'))).toBe(true);
    expect(screen.getByTestId('plan-run-block').contains(runOf('job-a'))).toBe(true);
    expectInOrder(
      runOf('job-a'),
      screen.getByTestId('plan-change-briefing'),
      screen.getByText(FOLLOW_UP),
      runOf('job-b'),
    );
  });
});

describe('a Visitor (design panel 7)', () => {
  function renderAsVisitor(state: PlanChangeConversationState) {
    return renderWithIntl(
      <ReaderRoutesProvider identifier="MOTIR">{rail(state)}</ReaderRoutesProvider>,
      {
        locale: 'en',
        messages: en,
      },
    );
  }

  it('reads the same order and is drawn no panel once the revision has finished', () => {
    renderAsVisitor({ ...FINISHED, readOnly: true });
    expect(screen.queryByTestId('plan-change-review')).toBeNull();
    expectInOrder(
      runOf('job-a'),
      screen.getByTestId('plan-change-earlier-briefing'),
      screen.getByText(FOLLOW_UP),
      runOf('job-b'),
      screen.getByTestId('plan-change-briefing'),
    );
  });

  it('is drawn no panel while the revision writes either', () => {
    renderAsVisitor({ ...WRITING, readOnly: true });
    expect(screen.queryByTestId('plan-change-review')).toBeNull();
  });
});
