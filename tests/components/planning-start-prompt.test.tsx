// @vitest-environment happy-dom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// MOTIR-10624 — THE PLANNER ASKS TO START PLANNING when the overlay opens from a
// card's Plan / Re-plan button (design MOTIR-10623,
// `design/ai-chat/design-notes.md` § *The planner asks to start planning…* with
// `planning-workspace--start-from-card.mock.html`). A `planAsk=1` address opens on
// a planner message naming the card with ONE Start button; nothing is sent until
// the person presses it or sends, and both send ONE first turn.
//
// End to end through the REAL overlay, host and rail; only the conversation hook
// is stubbed (the shape `planning-start-turn.test.tsx` uses), so what reaches
// `send` — and how often — is the assertion.

let params = new URLSearchParams();
let pathname = '/items/ACME-14';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => params,
}));
const { shallowReplace } = vi.hoisted(() => ({ shallowReplace: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace }));

const { fetchPlanningAnchor } = vi.hoisted(() => ({ fetchPlanningAnchor: vi.fn() }));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor }));
vi.mock('@/lib/planning/planningSeedClient', () => ({ fetchPlanningSeed: vi.fn() }));
vi.mock('@/lib/planning/onboardingRoutingClient', () => ({
  resolveOnboardingRouting: vi.fn(() => new Promise(() => {})),
}));
vi.mock('@/app/(authed)/_components/ProjectAccessProvider', () => ({
  useProjectAccess: () => ({ can: (key: string) => key === 'project:browse' }),
}));
vi.mock('@/lib/hooks/useWorkItemTargetSearch', () => ({
  useWorkItemTargetSearch: () => ({ results: [], loading: false, tooShort: true }),
}));
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: () => <div data-testid="review-canvas-stub" />,
}));
vi.mock('@/components/planning/PlanChangeCanvas', () => ({
  PlanChangeCanvas: () => <div data-testid="canvas-stub" />,
}));

const { conversation } = vi.hoisted(() => ({
  conversation: {
    state: null as PlanChangeConversationState | null,
    send: vi.fn(),
    retry: vi.fn(),
    correctTurn: vi.fn(),
    approve: vi.fn(),
    discard: vi.fn(),
    dismissError: vi.fn(),
    stop: vi.fn(),
  },
}));
vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: () => conversation,
}));

const { PlanningWorkspaceOverlay } = await import('@/components/planning/PlanningWorkspaceOverlay');
const { withPlanningOverlay } = await import('@/lib/planning/launcher');
const { resetPickAutoSendClaimsForTests } = await import('@/lib/planning/pickAutoSend');
const { renderWithIntl } = await import('../helpers/renderWithIntl');
const zhMessages = (await import('@/messages/zh.json')).default;

const PLAN_ADDRESS = withPlanningOverlay('/items/ACME-14', {
  kind: 'work-item',
  itemKey: 'ACME-14',
  confirmStart: true,
});
const REPLAN_ADDRESS = withPlanningOverlay('/items/ACME-14', {
  kind: 'work-item',
  itemKey: 'ACME-14',
  hasPlan: true,
  confirmStart: true,
});
const ANCHOR_14 = {
  anchor: { id: 'wi_14', identifier: 'ACME-14', title: 'Export reports', kind: 'story' as const },
  ancestors: [],
  hasChildren: false,
};

function session(userTurns: string[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: ['ACME-14'],
    turnCount: userTurns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-11-08T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-11-08T09:00:00.000Z',
    updatedAt: '2026-11-08T10:00:00.000Z',
    turns: userTurns.map((body, seq) => ({
      id: `t${seq}`,
      seq,
      role: 'user' as const,
      body,
      jobId: null,
      question: null,
      isAnswer: false,
      intent: null,
      intentCorrected: false,
      citations: [],
      authorId: 'u1',
      createdAt: '2026-11-08T10:00:00.000Z',
    })),
    workItemRefs: {},
  };
}

const IDLE: PlanChangeConversationState = {
  phase: 'idle',
  session: null,
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

function openAt(href: string) {
  const [path, qs = ''] = href.split('?');
  pathname = path!;
  params = new URLSearchParams(qs);
  window.history.replaceState(null, '', href);
}

const overlay = () => (
  <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />
);

async function mount(ui = overlay(), opts: { zh?: boolean } = {}) {
  const result = renderWithIntl(ui, opts.zh ? { locale: 'zh', messages: zhMessages } : {});
  await act(async () => {});
  return result;
}

/** A press of the button the way the hook answers it: the run starts at once. */
function sendStarts() {
  conversation.send.mockImplementation(() => {
    conversation.state = { ...IDLE, phase: 'streaming' };
  });
}

const prompt = () => screen.queryByTestId('plan-start-prompt');
const startButton = () => screen.getByTestId('plan-start-confirm');
const field = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const sentTurns = () => conversation.send.mock.calls.map((call) => call[0]);

beforeEach(() => {
  openAt(PLAN_ADDRESS);
  conversation.state = IDLE;
  fetchPlanningAnchor.mockReset().mockResolvedValue(ANCHOR_14);
  resetPickAutoSendClaimsForTests();
});

afterEach(() => {
  cleanup();
  conversation.send.mockReset();
  shallowReplace.mockReset();
});

describe('the start prompt appears on the Plan / Re-plan door, and sends nothing by itself', () => {
  it('Plan: asks, names the card, offers Start planning, and focuses the composer', async () => {
    await mount();
    const section = screen.getByRole('region', { name: 'Start planning ACME-14' });
    expect(section.dataset.face).toBe('plan');
    expect(section.dataset.state).toBe('live');
    expect(within(section).getByText('Shall I start planning this work item?')).toBeTruthy();
    expect(within(section).getByText('ACME-14')).toBeTruthy();
    expect(within(section).getByText('Export reports')).toBeTruthy();
    expect(startButton().textContent).toBe('Start planning');
    expect(
      within(section).getByText(/Want to add conditions, like “keep it to the API, no UI”\?/),
    ).toBeTruthy();
    // The composer invites conditions, and has the focus — not the button.
    expect(field().getAttribute('placeholder')).toBe('Add conditions (optional)…');
    expect(document.activeElement).toBe(field());
    // In place of the opener and its starter chips.
    expect(screen.queryByText(/Opened in the context of/)).toBeNull();
    expect(screen.queryByText('What should change — or what would you like to know?')).toBeNull();
    // A client message: no turn is sent until the person acts.
    expect(conversation.send).not.toHaveBeenCalled();
  });

  it('Re-plan: the same block says re-plan', async () => {
    openAt(REPLAN_ADDRESS);
    await mount();
    const section = screen.getByRole('region', { name: 'Start re-planning ACME-14' });
    expect(section.dataset.face).toBe('replan');
    expect(within(section).getByText('Shall I start re-planning this work item?')).toBeTruthy();
    expect(startButton().textContent).toBe('Start re-planning');
    expect(within(section).getByText(/Know what’s wrong\?/)).toBeTruthy();
    expect(field().getAttribute('placeholder')).toBe('What’s wrong? (optional)…');
    expect(conversation.send).not.toHaveBeenCalled();
  });

  it('speaks the locale: zh', async () => {
    await mount(overlay(), { zh: true });
    expect(screen.getByRole('region', { name: '开始规划 ACME-14' })).toBeTruthy();
    expect(startButton().textContent).toBe('开始规划');
  });
});

describe('Start sends the start turn once', () => {
  it('one click sends “Plan ACME-14” and draws the loading state', async () => {
    sendStarts();
    const { rerender } = await mount();
    fireEvent.click(startButton());
    rerender(overlay());
    await act(async () => {});
    expect(sentTurns()).toEqual(['Plan ACME-14']);
    expect(prompt()?.dataset.state).toBe('starting');
    expect(startButton().textContent).toBe('Starting…');
    expect((startButton() as HTMLButtonElement).disabled).toBe(true);
    // The composer is held until the turn is accepted.
    expect(field().disabled).toBe(true);
  });

  it('Re-plan sends “Re-plan ACME-14”', async () => {
    openAt(REPLAN_ADDRESS);
    await mount();
    fireEvent.click(startButton());
    expect(sentTurns()).toEqual(['Re-plan ACME-14']);
  });

  it('a double click sends once', async () => {
    await mount();
    fireEvent.click(startButton());
    fireEvent.click(startButton());
    expect(sentTurns()).toEqual(['Plan ACME-14']);
  });

  it('two presses inside one tick send once — the claim decides', async () => {
    await mount();
    const button = startButton();
    act(() => {
      button.click();
      button.click();
    });
    expect(sentTurns()).toEqual(['Plan ACME-14']);
  });

  it('a failed start leaves a newer draft alone', async () => {
    const { rerender } = await mount();
    fireEvent.click(startButton());
    fireEvent.change(field(), { target: { value: 'Something newer.' } });
    conversation.state = { ...IDLE, errorCode: 'PLAN_CHANGE_FAILED' };
    rerender(overlay());
    await act(async () => {});
    expect(prompt()?.dataset.state).toBe('live');
    expect(field().value).toBe('Something newer.');
  });

  it('a remount while the workspace is still sending shows the press in flight and sends nothing more', async () => {
    (await mount()).unmount();
    sendStarts();
    await mount();
    fireEvent.click(startButton());
    cleanup();
    await mount(<StrictMode>{overlay()}</StrictMode>);
    // The claim is held on this page and the conversation is still working on it.
    expect(prompt()?.dataset.state).toBe('starting');
    fireEvent.click(startButton());
    expect(sentTurns()).toEqual(['Plan ACME-14']);
  });

  it('a remount after the send ended with the rail is live again, and Start works', async () => {
    await mount();
    fireEvent.click(startButton());
    cleanup();
    // Idle with no user turn: the send went with the rail that made it, so the
    // claim it left on this page is not a press in flight.
    await mount();
    expect(prompt()?.dataset.state).toBe('live');
    expect(field().disabled).toBe(false);
    fireEvent.click(startButton());
    expect(sentTurns()).toEqual(['Plan ACME-14', 'Plan ACME-14']);
  });

  it('Plan something new onto an empty session draws the live prompt, composer enabled', async () => {
    const { rerender } = await mount();
    fireEvent.click(startButton());
    conversation.state = { ...IDLE, phase: 'review', session: session(['Plan ACME-14']) };
    rerender(overlay());
    await act(async () => {});
    expect(prompt()?.dataset.state).toBe('spent');
    // The swap happens in place: the rail is not remounted.
    conversation.state = {
      ...IDLE,
      session: { ...session([]), id: 's2' },
      restartedFrom: 's1',
    };
    rerender(overlay());
    await act(async () => {});
    expect(prompt()?.dataset.state).toBe('live');
    expect(field().disabled).toBe(false);
    fireEvent.click(startButton());
    expect(sentTurns()).toEqual(['Plan ACME-14', 'Plan ACME-14']);
  });

  it('once the turn lands, the prompt is spent: the question stays, the chip replaces Start', async () => {
    const { rerender } = await mount();
    fireEvent.click(startButton());
    conversation.state = { ...IDLE, phase: 'streaming', session: session(['Plan ACME-14']) };
    rerender(overlay());
    await act(async () => {});
    expect(prompt()?.dataset.state).toBe('spent');
    expect(screen.getByTestId('plan-start-spent').textContent).toBe('Planning started');
    expect(screen.queryByTestId('plan-start-confirm')).toBeNull();
    expect(screen.getByText('Shall I start planning this work item?')).toBeTruthy();
    // The ordinary placeholder is back.
    expect(field().getAttribute('placeholder')).not.toBe('Add conditions (optional)…');
  });

  it('a failed start returns to the live prompt with the typed text kept, and Start works again', async () => {
    const { rerender } = await mount();
    fireEvent.change(field(), { target: { value: 'Keep it to the API.' } });
    fireEvent.click(startButton());
    expect(field().value).toBe('');
    conversation.state = { ...IDLE, errorCode: 'PLAN_CHANGE_FAILED' };
    rerender(overlay());
    await act(async () => {});
    expect(prompt()?.dataset.state).toBe('live');
    expect(field().value).toBe('Keep it to the API.');
    conversation.state = IDLE;
    rerender(overlay());
    fireEvent.click(startButton());
    expect(sentTurns()).toEqual([
      'Plan ACME-14\n\nKeep it to the API.',
      'Plan ACME-14\n\nKeep it to the API.',
    ]);
  });
});

describe('typed conditions ride the start', () => {
  it('the help line says Start sends the typed text too', async () => {
    await mount();
    fireEvent.change(field(), { target: { value: 'No UI.' } });
    expect(
      screen.getByText(
        'Starts planning with what you typed as extra conditions. Send does the same.',
      ),
    ).toBeTruthy();
  });

  it('Send while the prompt is live sends the start line plus the text, once', async () => {
    const { rerender } = await mount();
    fireEvent.change(field(), { target: { value: 'Keep it to the API, no UI.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sentTurns()).toEqual(['Plan ACME-14\n\nKeep it to the API, no UI.']);
    // Spent: the button cannot start it a second time.
    conversation.state = {
      ...IDLE,
      session: session(['Plan ACME-14\n\nKeep it to the API, no UI.']),
    };
    rerender(overlay());
    await act(async () => {});
    expect(prompt()?.dataset.state).toBe('spent');
    expect(conversation.send).toHaveBeenCalledTimes(1);
  });

  it('Start with text typed sends the same one turn as Send', async () => {
    openAt(REPLAN_ADDRESS);
    await mount();
    fireEvent.change(field(), { target: { value: '  Split the mapping step out.  ' } });
    fireEvent.click(startButton());
    expect(sentTurns()).toEqual(['Re-plan ACME-14\n\nSplit the mapping step out.']);
  });

  it('a reply after the start is an ordinary turn', async () => {
    conversation.state = { ...IDLE, session: session(['Plan ACME-14']) };
    await mount();
    fireEvent.change(field(), { target: { value: 'Also flag blockers.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sentTurns()).toEqual(['Also flag blockers.']);
  });
});

describe('where the prompt does not appear', () => {
  it('a resumed thread that began some other way keeps today’s opener', async () => {
    conversation.state = { ...IDLE, session: session(['What does this card block?']) };
    await mount();
    expect(prompt()).toBeNull();
    expect(screen.getByText(/Opened in the context of ACME-14/)).toBeTruthy();
    expect(conversation.send).not.toHaveBeenCalled();
  });

  it('a resumed thread this prompt started draws the spent record, never a live button', async () => {
    conversation.state = { ...IDLE, session: session(['Plan ACME-14']) };
    await mount();
    expect(prompt()?.dataset.state).toBe('spent');
    expect(screen.queryByTestId('plan-start-confirm')).toBeNull();
  });

  it('nothing while the thread is still loading', async () => {
    conversation.state = { ...IDLE, phase: 'loading' };
    await mount();
    expect(prompt()).toBeNull();
  });

  it('an anchor that does not resolve degrades to the project conversation, with no prompt', async () => {
    fetchPlanningAnchor.mockResolvedValue(null);
    await mount();
    expect(prompt()).toBeNull();
  });

  it('a named session reopen carries no ask', async () => {
    openAt(
      withPlanningOverlay('/items/ACME-14', {
        kind: 'work-item',
        itemKey: 'ACME-14',
        sessionId: 's1',
        confirmStart: true,
      }),
    );
    await mount();
    expect(prompt()).toBeNull();
  });

  it('Plan with AI on a card (no planAsk) is unchanged', async () => {
    openAt(withPlanningOverlay('/items/ACME-14', { kind: 'work-item', itemKey: 'ACME-14' }));
    await mount();
    expect(prompt()).toBeNull();
    expect(screen.getByText(/Opened in the context of ACME-14/)).toBeTruthy();
  });

  it('a read-only viewer sees no prompt', async () => {
    conversation.state = { ...IDLE, readOnly: true };
    await mount();
    expect(prompt()).toBeNull();
  });

  it('the expansion nudge still sends outright, and asks nothing', async () => {
    openAt(
      withPlanningOverlay('/ready', {
        kind: 'work-item',
        itemKey: 'ACME-14',
        startTurn: true,
        confirmStart: true,
      }),
    );
    await mount();
    expect(prompt()).toBeNull();
    expect(sentTurns()).toEqual(['Plan ACME-14']);
  });
});
