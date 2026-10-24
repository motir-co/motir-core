// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/items/ACME-40',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

const client = vi.hoisted(() => ({
  openSharpen: vi.fn(),
  sharpenAct: vi.fn(),
  settleSharpen: vi.fn(),
  resubmitSharpen: vi.fn(),
  getOpenSharpen: vi.fn(),
  getLatestConversationSharpen: vi.fn(),
  getSharpenSession: vi.fn(),
}));
vi.mock('@/lib/planning/sharpenClient', () => client);

import enMessages from '@/messages/en.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { coversOffer, type GrillOffer } from '@/components/planning/useGrillSession';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type {
  PlanAnswerOfferDto,
  PlanChangeSessionDto,
  PlanChangeTurnDto,
} from '@/lib/dto/planChange';
import type { SharpenSessionDto } from '@/lib/dto/sharpen';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// GRILL ME BEFORE PLANNING (Story MOTIR-9221 · Subtask MOTIR-9316; design
// `design/ai-chat/grill-before-planning.mock.html`). With the switch on, an answer
// carrying a plan offer opens a grilling over the conversation and the offer is
// HELD — no Confirm, no Decline — until it ends; then the offer is drawn under the
// thread with what the answers settled. The Sharpen session is mocked at its
// boundary, the door's browser client. No jest-dom: assertions read the DOM.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });
const enOffer = enMessages.planningWorkspace.planOffer;
const enSharpen = enMessages.sharpen;

const OFFER_AT = '2026-10-22T10:00:05.000Z';
const GRILL_AT = '2026-10-22T10:00:06.000Z';

function turn(
  seq: number,
  role: PlanChangeTurnDto['role'] = 'user',
  extra: Partial<PlanChangeTurnDto> = {},
): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role,
    body: role === 'user' ? 'Add a CSV export to reports.' : 'Reports export nothing today.',
    jobId: role === 'assistant' ? `job-${seq}` : null,
    question: null,
    confirm: null,
    isAnswer: role === 'assistant',
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-10-22T10:00:00.000Z',
    ...extra,
  };
}

function offer(extra: Partial<PlanAnswerOfferDto> = {}): PlanAnswerOfferDto {
  return {
    kind: 'plan',
    requestMd: 'Add a CSV export to the reports page.',
    targetKey: null,
    declinedAt: null,
    declinedById: null,
    confirmedAt: null,
    confirmedById: null,
    confirmedSessionId: null,
    state: 'undecided',
    cannotStart: null,
    ...extra,
  };
}

function conversation(turns: PlanChangeTurnDto[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-10-22T10:00:00.000Z',
    origin: 'conversation',
    startedByViewer: true,
    createdAt: '2026-10-22T09:00:00.000Z',
    updatedAt: '2026-10-22T10:00:00.000Z',
    turns,
    workItemRefs: {},
  };
}

const ASKED = conversation([turn(0)]);
/** The thread once the answer carrying the plan offer arrived. */
const OFFERED = conversation([
  turn(0),
  turn(1, 'assistant', { offer: offer(), createdAt: OFFER_AT }),
]);

const QUESTION = {
  id: 'q1',
  text: 'Which columns does the export carry?',
  topic: 'workflow' as const,
  because: null,
  quote: null,
  readings: [
    { id: 'r1', label: 'The columns on screen', detail: 'What you see.', recommended: true },
    { id: 'r2', label: 'Every field', detail: 'All of them.', recommended: false },
  ],
};

function grilling(overrides: Partial<SharpenSessionDto> = {}): SharpenSessionDto {
  return {
    id: 'sh1',
    scope: { kind: 'conversation', conversationId: 's1' },
    status: 'open',
    endReason: null,
    pendingQuestion: QUESTION,
    settled: [],
    assumptions: [],
    writeBack: null,
    inFlight: null,
    turns: [],
    createdAt: GRILL_AT,
    updatedAt: GRILL_AT,
    lastActivityAt: GRILL_AT,
    ...overrides,
  };
}

const ENDED: Partial<SharpenSessionDto> = {
  status: 'ended',
  endReason: 'finished',
  pendingQuestion: null,
  settled: [
    {
      questionId: 'q1',
      question: QUESTION.text,
      answer: 'The columns on screen',
      topic: 'workflow',
      readingId: 'r1',
      source: 'person',
    },
  ],
  assumptions: [
    {
      questionId: 'q2',
      question: 'What happens to an empty report?',
      recommendation: 'Export the header row only',
      why: 'A file always opens.',
      source: 'planner',
    },
  ],
};

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: ASKED,
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

const onSend = vi.fn();
const onConfirmPlanOffer = vi.fn();
const onDeclinePlanOffer = vi.fn();

function rail(state: Partial<PlanChangeConversationState> = {}): ReactElement {
  const merged = { ...BASE, ...state };
  return (
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={merged}
      index={indexPlanReview(merged.review)}
      targets={[]}
      onSend={onSend}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      onConfirmPlanOffer={onConfirmPlanOffer}
      onDeclinePlanOffer={onDeclinePlanOffer}
      offerAnsweringTurnId={null}
      offerRefusal={null}
    />
  );
}

function toggle() {
  return within(screen.getByTestId('grill-me-toggle')).getByRole('switch');
}

/** Switch Grill me on before the message is sent ("Your next message starts the
 *  grilling"), then let the message and the answer carrying the offer land. */
async function offeredWithGrillOn() {
  const view = renderWithIntl(rail({ session: conversation([]) }));
  await act(async () => {
    fireEvent.click(toggle());
  });
  await act(async () => {
    view.rerender(rail({ session: OFFERED }));
  });
  return view;
}

beforeEach(() => {
  window.sessionStorage.clear();
  client.getOpenSharpen.mockResolvedValue(null);
  client.getLatestConversationSharpen.mockResolvedValue(null);
  client.openSharpen.mockResolvedValue({
    outcome: 'sharpening',
    jobId: 'sj1',
    turnId: 'st1',
    session: grilling({ pendingQuestion: null, inFlight: { turnId: 'st1', jobId: 'sj1' } }),
  });
  client.settleSharpen.mockResolvedValue({ outcome: 'settled', session: grilling() });
});

afterEach(() => {
  cleanup();
  for (const fn of Object.values(client)) fn.mockReset();
  vi.clearAllMocks();
});

describe('coversOffer', () => {
  const o: GrillOffer = {
    turnId: 't1',
    createdAt: OFFER_AT,
    personTurnsBefore: 1,
    grillable: true,
  };
  it('is a conversation session created at or after the answer', () => {
    expect(coversOffer(grilling(), o)).toBe(true);
    expect(coversOffer(grilling({ createdAt: OFFER_AT }), o)).toBe(true);
    expect(coversOffer(grilling({ createdAt: '2026-10-22T10:00:04.000Z' }), o)).toBe(false);
    expect(coversOffer(grilling({ scope: { kind: 'plan', planId: 'p' } }), o)).toBe(false);
    expect(coversOffer(null, o)).toBe(false);
  });
});

describe('the control before any plan exists', () => {
  it('explains the before-planning behaviour and hints at the offer', async () => {
    renderWithIntl(rail());
    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(screen.getByTestId('grill-me-hint').textContent).toBe(
      enMessages.planningWorkspace.grill.control.hintBeforePlanning,
    );
    fireEvent.click(screen.getByTestId('grill-me-help'));
    expect(screen.getByTestId('grill-me-explanation-before-planning').textContent).toBe(
      enMessages.planningWorkspace.grill.control.popover.beforePlanning,
    );
  });
});

describe('the offer is held while the grilling is open', () => {
  it('opens a grilling over the conversation and draws the Held notice, no Confirm or Decline', async () => {
    await offeredWithGrillOn();
    expect(client.getLatestConversationSharpen).toHaveBeenCalledWith('s1', expect.anything());
    expect(client.openSharpen).toHaveBeenCalledTimes(1);
    expect(client.openSharpen.mock.calls[0]![0]).toEqual({ conversationId: 's1' });
    const question = await screen.findByTestId('sharpen-question');
    expect(question.textContent).toContain(QUESTION.text);
    const held = screen.getByTestId('plan-offer-held');
    expect(held.getAttribute('role')).toBe('status');
    expect(held.textContent).toBe(enOffer.held);
    expect(screen.getByTestId('conversation-grill').getAttribute('data-hold')).toBe('held');
    expect(screen.queryByTestId('plan-offer')).toBeNull();
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
    expect(screen.queryByTestId('plan-offer-decline')).toBeNull();
  });

  it('answers the open question with a typed message instead of sending it to the planner', async () => {
    await offeredWithGrillOn();
    await screen.findByTestId('sharpen-question');
    client.sharpenAct.mockResolvedValue({
      outcome: 'sharpening',
      jobId: 'sj2',
      turnId: 'st2',
      session: grilling({ pendingQuestion: null, inFlight: { turnId: 'st2', jobId: 'sj2' } }),
    });
    const box = screen.getByRole('textbox', { name: 'Or type your own answer…' });
    fireEvent.change(box, { target: { value: 'Only the visible columns' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(client.sharpenAct.mock.calls[0]!.slice(0, 3)).toEqual([
      'sh1',
      'own_words',
      { text: 'Only the visible columns' },
    ]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('gives up on grilling the offer when Stop is pressed on a failed open', async () => {
    client.openSharpen.mockRejectedValue(new Error('down'));
    await offeredWithGrillOn();
    expect(await screen.findByTestId('sharpen-error')).toBeTruthy();
    expect(screen.getByTestId('plan-offer-held')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('sharpen-stop'));
    });
    expect(screen.queryByTestId('plan-offer-held')).toBeNull();
    expect(screen.getByTestId('plan-offer-confirm')).toBeTruthy();
  });
});

describe('the offer is shown once the grilling ended', () => {
  it('draws the offer under the thread with the settled answers and assumptions', async () => {
    client.getLatestConversationSharpen.mockResolvedValue(grilling(ENDED));
    renderWithIntl(rail({ session: OFFERED }));
    const settled = await screen.findByTestId('plan-offer-settled');
    expect(settled.textContent).toContain(enOffer.settledHeading);
    expect(screen.getByTestId('plan-offer-settled-answer').textContent).toContain(
      'The columns on screen',
    );
    expect(screen.getByTestId('plan-offer-settled-assumption').textContent).toContain(
      'Export the header row only',
    );
    expect(screen.getByTestId('conversation-grill').getAttribute('data-hold')).toBe('shown');
    // The ended conversation grilling draws no summary of its own: the offer lists it.
    expect(screen.queryByTestId('sharpen-summary')).toBeNull();
    fireEvent.click(screen.getByTestId('plan-offer-confirm'));
    expect(onConfirmPlanOffer).toHaveBeenCalledWith('t1');
    expect(client.openSharpen).not.toHaveBeenCalled();
  });

  it('says the request was clear enough when there was nothing to ask', async () => {
    client.getLatestConversationSharpen.mockResolvedValue(
      grilling({
        status: 'ended',
        endReason: 'nothing_to_ask',
        pendingQuestion: null,
        settled: [],
        assumptions: [],
      }),
    );
    renderWithIntl(rail({ session: OFFERED }));
    expect((await screen.findByTestId('plan-offer-clear')).textContent).toContain(
      enOffer.clearEnough,
    );
    expect(screen.getByTestId('sharpen-thread').textContent).toContain(
      enSharpen.conversation.nothingToAsk,
    );
  });

  it('says nothing was settled when the grilling stopped before any answer', async () => {
    client.getLatestConversationSharpen.mockResolvedValue(
      grilling({
        status: 'ended',
        endReason: 'stopped',
        pendingQuestion: null,
        settled: [],
        assumptions: [],
      }),
    );
    renderWithIntl(rail({ session: OFFERED }));
    expect((await screen.findByTestId('plan-offer-clear')).textContent).toContain(
      enOffer.nothingSettled,
    );
    expect(screen.getByTestId('sharpen-thread').textContent).toContain(
      enSharpen.conversation.stoppedNoAnswer,
    );
  });
});

describe('an offer that is never held', () => {
  it('draws the offer as planned with Grill me off, opening nothing', async () => {
    renderWithIntl(rail({ session: OFFERED }));
    await act(async () => {});
    expect(screen.getByTestId('plan-offer-confirm')).toBeTruthy();
    expect(screen.queryByTestId('plan-offer-held')).toBeNull();
    expect(client.openSharpen).not.toHaveBeenCalled();
  });

  it('does not hold an offer whose message was sent before the switch went on', async () => {
    renderWithIntl(rail({ session: OFFERED }));
    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(screen.getByTestId('plan-offer-confirm')).toBeTruthy();
    expect(screen.queryByTestId('plan-offer-held')).toBeNull();
    expect(client.openSharpen).not.toHaveBeenCalled();
  });

  it('does not hold an offer that cannot start, and draws its cannot-start line', async () => {
    const view = renderWithIntl(rail({ session: conversation([]) }));
    await act(async () => {
      fireEvent.click(toggle());
    });
    await act(async () => {
      view.rerender(
        rail({
          session: conversation([
            turn(0),
            turn(1, 'assistant', {
              offer: offer({ cannotStart: 'planning_unavailable' }),
              createdAt: OFFER_AT,
            }),
          ]),
        }),
      );
    });
    expect(screen.queryByTestId('plan-offer-held')).toBeNull();
    expect(screen.getByTestId('plan-offer-cannot-start')).toBeTruthy();
    expect(client.openSharpen).not.toHaveBeenCalled();
  });
});
