// @vitest-environment happy-dom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// MOTIR-7973 — EXPAND STARTS A PLANNING CONVERSATION (story MOTIR-5266; design
// MOTIR-7875, `design/ready/design-notes.md` § *Expand starts a planning
// conversation*). A `planStart=1` address opens the overlay on its stub and SENDS
// `Plan <KEY>` once, for the person, as the thread's first message — the pick's
// once-only seam (MOTIR-6435), keyed `start:<KEY>`.
//
// End to end through the REAL overlay, host and rail; only the conversation hook
// is stubbed (the host tests' own shape), so what reaches `send` — and how often —
// is the assertion.

let params = new URLSearchParams();
let pathname = '/ready';
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

const ADDRESS = withPlanningOverlay('/ready?lane=x', {
  kind: 'work-item',
  itemKey: 'ACME-14',
  startTurn: true,
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
    lastActivityAt: '2026-10-09T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-10-09T09:00:00.000Z',
    updatedAt: '2026-10-09T10:00:00.000Z',
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
      createdAt: '2026-10-09T10:00:00.000Z',
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

const sentTurns = () => conversation.send.mock.calls.map((call) => call[0]);

beforeEach(() => {
  openAt(ADDRESS);
  conversation.state = IDLE;
  fetchPlanningAnchor.mockReset().mockResolvedValue(ANCHOR_14);
  resetPickAutoSendClaimsForTests();
});

afterEach(() => {
  cleanup();
  conversation.send.mockReset();
  shallowReplace.mockReset();
});

describe('planStart — the start turn is SENT once, for the person', () => {
  it('sends “Plan ACME-14” once and leaves the composer empty', async () => {
    await mount();
    expect(sentTurns()).toEqual(['Plan ACME-14']);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('composes the zh turn “规划 ACME-14”', async () => {
    await mount(overlay(), { zh: true });
    expect(sentTurns()).toEqual(['规划 ACME-14']);
  });

  it('sends ONCE under a StrictMode double effect', async () => {
    await mount(<StrictMode>{overlay()}</StrictMode>);
    expect(sentTurns()).toEqual(['Plan ACME-14']);
  });

  it('sends ONCE across a close and a reopen of the same address on this page', async () => {
    (await mount()).unmount();
    await mount();
    expect(sentTurns()).toEqual(['Plan ACME-14']);
  });

  it('a RESUMED thread — one that already holds a user turn — sends nothing', async () => {
    conversation.state = { ...IDLE, session: session(['Plan ACME-14']) };
    await mount();
    expect(conversation.send).not.toHaveBeenCalled();
  });

  it('an anchor that does not resolve for this viewer sends nothing', async () => {
    fetchPlanningAnchor.mockResolvedValue(null);
    await mount();
    expect(conversation.send).not.toHaveBeenCalled();
  });

  it('an address WITHOUT planStart sends nothing — Plan with AI on a card is unchanged', async () => {
    openAt(withPlanningOverlay('/ready?lane=x', { kind: 'work-item', itemKey: 'ACME-14' }));
    await mount();
    expect(conversation.send).not.toHaveBeenCalled();
  });

  it('a FAILED send puts the turn back in the composer, unsent', async () => {
    const { rerender } = await mount();
    conversation.state = { ...IDLE, errorCode: 'PLAN_CHANGE_FAILED' };
    rerender(overlay());
    await act(async () => {});
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Plan ACME-14');
    expect(conversation.send).toHaveBeenCalledTimes(1);
  });
});

describe('planStart — the address names the conversation once it has started', () => {
  it('after the first user turn, ONE replace drops planStart and writes planSession', async () => {
    const { rerender } = await mount();
    expect(shallowReplace).not.toHaveBeenCalled();

    conversation.state = { ...IDLE, phase: 'streaming', session: session(['Plan ACME-14']) };
    rerender(overlay());
    await act(async () => {});

    expect(shallowReplace).toHaveBeenCalledTimes(1);
    expect(shallowReplace).toHaveBeenCalledWith(
      '/ready?lane=x&plan=contextual&planFrom=work-item&planItem=ACME-14&planSession=s1',
    );
  });
});
