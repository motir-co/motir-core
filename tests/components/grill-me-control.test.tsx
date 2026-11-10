// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { SharpenSessionDto } from '@/lib/dto/sharpen';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// THE "GRILL ME" CONTROL AND ITS PHASE GATE (Task MOTIR-1101 · Subtask MOTIR-8447).
// The rail is presentational, so each phase is asserted by handing it that state;
// the Sharpen session is mocked at its boundary — the door's browser client.

const client = vi.hoisted(() => ({
  openSharpen: vi.fn(),
  sharpenAct: vi.fn(),
  settleSharpen: vi.fn(),
  resubmitSharpen: vi.fn(),
  getOpenSharpen: vi.fn(),
  getSharpenSession: vi.fn(),
}));
vi.mock('@/lib/planning/sharpenClient', () => client);

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });

function userTurn(seq: number, body: string): PlanChangeTurnDto {
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
    createdAt: '2026-10-13T10:00:00.000Z',
  };
}

function session(id: string, turns: PlanChangeTurnDto[] = []): PlanChangeSessionDto {
  return {
    id,
    projectId: 'p1',
    targetKeys: [],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-10-13T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-10-13T09:00:00.000Z',
    updatedAt: '2026-10-13T10:00:00.000Z',
    turns,
    workItemRefs: {},
  };
}

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: session('s1'),
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

/** A plan run in its CONVERSATION phase: streaming, its target not yet settled. */
const CONVERSING: Partial<PlanChangeConversationState> = {
  phase: 'streaming',
  planId: 'plan-1',
  jobId: 'job-1',
  settledJobId: null,
};
/** …and the same run once it has handed off to PLANNING. */
const PLANNING: Partial<PlanChangeConversationState> = { ...CONVERSING, settledJobId: 'job-1' };

const onSend = vi.fn();

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
    />
  );
}

function toggle() {
  return within(screen.getByTestId('grill-me-toggle')).getByRole('switch');
}

function sharpen(overrides: Partial<SharpenSessionDto> = {}): SharpenSessionDto {
  return {
    id: 'sh1',
    scope: { kind: 'plan', planId: 'plan-1' },
    status: 'open',
    endReason: null,
    pendingQuestion: {
      id: 'q1',
      text: 'Who can use a shared preset?',
      topic: 'workflow',
      because: null,
      quote: null,
      readings: [
        { id: 'r1', label: 'Everyone in the project', detail: 'All members.', recommended: true },
        { id: 'r2', label: 'Only its author', detail: 'Private by default.', recommended: false },
      ],
    },
    settled: [],
    assumptions: [],
    writeBack: null,
    inFlight: null,
    turns: [],
    notes: [],
    createdAt: '2026-10-13T10:00:00.000Z',
    updatedAt: '2026-10-13T10:00:00.000Z',
    lastActivityAt: '2026-10-13T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
  client.getOpenSharpen.mockResolvedValue(null);
  client.openSharpen.mockResolvedValue({
    outcome: 'sharpening',
    jobId: 'sj1',
    turnId: 'st1',
    session: sharpen({ pendingQuestion: null, inFlight: { turnId: 'st1', jobId: 'sj1' } }),
  });
  client.settleSharpen.mockResolvedValue({ outcome: 'settled', session: sharpen() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const fn of Object.values(client)) fn.mockReset();
  onSend.mockReset();
});

describe('Grill me — the phase gate', () => {
  it('is drawn in the conversation phase, off, with its label and "?"', () => {
    renderWithIntl(rail(CONVERSING));
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(document.getElementById(toggle().getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Grill me',
    );
    expect(screen.getByTestId('grill-me-help').getAttribute('aria-label')).toBe(
      'What is Grill me?',
    );
  });

  it('is drawn before any run has started, so it can be turned on before the first message', () => {
    renderWithIntl(rail());
    expect(screen.getByTestId('grill-me-toggle')).toBeTruthy();
  });

  it('is NOT rendered once the run hands off to planning', () => {
    renderWithIntl(rail(PLANNING));
    expect(screen.queryByTestId('grill-me-control')).toBeNull();
  });

  it('is NOT rendered over a plan no run is writing (planRunPhase null)', () => {
    const review = planReview([planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1' })]);
    renderWithIntl(rail({ phase: 'review', planId: 'plan-1', review }));
    expect(screen.queryByTestId('grill-me-control')).toBeNull();
  });

  it('is NOT rendered for a read-only viewer', () => {
    renderWithIntl(rail({ ...CONVERSING, readOnly: true }));
    expect(screen.queryByTestId('grill-me-control')).toBeNull();
  });

  it('comes back, still on, when the conversation phase is entered again', () => {
    const view = renderWithIntl(rail(CONVERSING));
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    view.rerender(rail(PLANNING));
    expect(screen.queryByTestId('grill-me-control')).toBeNull();
    view.rerender(rail({ ...CONVERSING, jobId: 'job-2', settledJobId: 'job-1' }));
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('starts OFF in a different session', () => {
    const view = renderWithIntl(rail(CONVERSING));
    fireEvent.click(toggle());
    view.rerender(rail({ ...CONVERSING, session: session('s2') }));
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('is kept by the session that did not exist yet when it was turned on', () => {
    const view = renderWithIntl(rail({ session: null }));
    fireEvent.click(toggle());
    view.rerender(rail({ ...CONVERSING, session: session('s9') }));
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });
});

describe('Grill me — the "?" explanation', () => {
  it('opens on press with what turning it on does', () => {
    renderWithIntl(rail(CONVERSING));
    fireEvent.click(screen.getByTestId('grill-me-help'));
    const panel = screen.getByTestId('grill-me-explanation');
    expect(panel.textContent).toContain('one question at a time');
    expect(panel.textContent).toContain("written into the plan's requirement");
  });
});

describe('Grill me — opt-in only', () => {
  it('turning it on sends nothing, opens nothing and asks nothing', async () => {
    renderWithIntl(rail(CONVERSING));
    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(screen.getByTestId('grill-me-hint').textContent).toContain(
      'Your next message starts the grilling.',
    );
    expect(client.openSharpen).not.toHaveBeenCalled();
    expect(client.sharpenAct).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sharpen-question')).toBeNull();
  });

  it('a run starting with it off opens no session', async () => {
    const view = renderWithIntl(rail());
    await act(async () => {
      view.rerender(rail({ ...CONVERSING, session: session('s1', [userTurn(1, 'Presets')]) }));
    });
    expect(client.openSharpen).not.toHaveBeenCalled();
    expect(client.getOpenSharpen).not.toHaveBeenCalled();
  });
});

describe('Grill me — the route', () => {
  async function grilling() {
    const view = renderWithIntl(rail());
    await act(async () => {
      fireEvent.click(toggle());
    });
    // The person's next message starts a run over the plan it writes.
    await act(async () => {
      view.rerender(rail({ ...CONVERSING, session: session('s1', [userTurn(1, 'Presets')]) }));
    });
    return view;
  }

  it("opens a session over the run's own plan and draws its question on the rail", async () => {
    await grilling();
    expect(client.openSharpen).toHaveBeenCalledTimes(1);
    expect(client.openSharpen.mock.calls[0]![0]).toEqual({ planId: 'plan-1' });
    expect(client.settleSharpen).toHaveBeenCalledWith('sh1', 'sj1', expect.anything());
    const question = await screen.findByTestId('sharpen-question');
    expect(question.textContent).toContain('Who can use a shared preset?');
    expect(question.textContent).toContain('asking · question 1');
    expect(screen.getByTestId('sharpen-reading-r1').getAttribute('aria-label')).toBe(
      'Everyone in the project (recommended)',
    );
    // The control stays, without the "next message" hint, while it grills.
    expect(screen.queryByTestId('grill-me-hint')).toBeNull();
  });

  it('sends each act as exactly one act, disables the rest while it is in flight, and keeps Stop', async () => {
    await grilling();
    await screen.findByTestId('sharpen-question');
    let release!: (v: unknown) => void;
    client.sharpenAct.mockReturnValueOnce(new Promise((r) => (release = r)));
    await act(async () => {
      fireEvent.click(screen.getByTestId('sharpen-reading-r1'));
    });
    expect(client.sharpenAct).toHaveBeenCalledTimes(1);
    expect(client.sharpenAct.mock.calls[0]!.slice(0, 3)).toEqual([
      'sh1',
      'answer',
      { readingId: 'r1' },
    ]);
    expect((screen.getByTestId('sharpen-reading-r2') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('sharpen-skip') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('sharpen-you-decide') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('sharpen-stop') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('sharpen-skip'));
    expect(client.sharpenAct).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ outcome: 'sharpening', jobId: null, turnId: 'st2', session: sharpen() });
    });
  });

  it('a typed message while the question waits is an own-words answer, not a turn', async () => {
    await grilling();
    await screen.findByTestId('sharpen-question');
    client.sharpenAct.mockResolvedValueOnce({
      outcome: 'sharpening',
      jobId: null,
      turnId: 'st2',
      session: sharpen(),
    });
    const field = screen.getByRole('textbox', { name: 'Or type your own answer…' });
    fireEvent.change(field, { target: { value: 'Admins only' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(client.sharpenAct.mock.calls[0]!.slice(0, 3)).toEqual([
      'sh1',
      'own_words',
      { text: 'Admins only' },
    ]);
  });

  it('a typed message is not a second answer to a question whose read failed (MOTIR-10865)', async () => {
    const turnOf = (
      seq: number,
      role: 'person' | 'planner',
      extra: Partial<SharpenSessionDto['turns'][number]> = {},
    ): SharpenSessionDto['turns'][number] => ({
      id: `st${seq}`,
      seq,
      role,
      action: role === 'person' ? 'answer' : null,
      body: role === 'person' ? 'Everyone in the project' : 'Who can use a shared preset?',
      readingId: null,
      jobId: `sj${seq}`,
      failed: false,
      outOfCredits: false,
      createdAt: '2026-10-13T10:00:00.000Z',
      ...extra,
    });
    const turns = [
      turnOf(1, 'person', { action: 'start', body: 'start', jobId: 'sj1' }),
      turnOf(2, 'planner', { jobId: 'sj1' }),
      turnOf(3, 'person', { readingId: 'r1', jobId: 'sj3' }),
      turnOf(4, 'planner', { jobId: 'sj3', failed: true, body: 'failed' }),
    ];
    // The stored question outlives the answer until the next planner turn lands.
    client.settleSharpen.mockResolvedValue({ outcome: 'failed', session: sharpen({ turns }) });
    await grilling();
    expect(await screen.findByTestId('sharpen-error')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Or type your own answer…' })).toBeNull();
    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: 'Admins only' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    // With no question open it is an ordinary message to the run, as during any read.
    expect(client.sharpenAct).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith('Admins only');
  });

  it('switching it off while it grills is Stop grilling', async () => {
    await grilling();
    await screen.findByTestId('sharpen-question');
    client.sharpenAct.mockResolvedValueOnce({
      outcome: 'sharpening',
      jobId: null,
      turnId: 'st2',
      session: sharpen({ status: 'ended', endReason: 'stopped', pendingQuestion: null }),
    });
    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(client.sharpenAct.mock.calls[0]!.slice(0, 2)).toEqual(['sh1', 'stop']);
  });

  it('the hand-off hides the interview and the control, and discards nothing', async () => {
    const view = await grilling();
    await screen.findByTestId('sharpen-question');
    await act(async () => {
      view.rerender(rail({ ...PLANNING, session: session('s1', [userTurn(1, 'Presets')]) }));
    });
    expect(screen.queryByTestId('sharpen-question')).toBeNull();
    expect(screen.queryByTestId('grill-me-control')).toBeNull();
    expect(client.sharpenAct).not.toHaveBeenCalled();
  });
});
