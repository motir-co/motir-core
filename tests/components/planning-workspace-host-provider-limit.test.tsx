// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanProgressSnapshot } from '@/lib/plans/planProgress';
import type { PlanSessionFailureDto } from '@/lib/dto/planChange';

// THE HOST'S PROVIDER-LIMIT WIRING (Story MOTIR-9540 · MOTIR-9622): the progress reading the
// host already ticks carries the session's provider-retry wait, and the host hands the rail ONE
// derived value — `retrying` while a wait is read and the session carries no failure. So a
// mid-retry open (the first snapshot already waiting) shows the banner on first paint, and a
// stored failure wins. The rail is a stub that hands its props out, as in the rail-wiring suite.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

const hook = vi.hoisted(() => ({
  state: null as unknown as PlanChangeConversationState,
  send: vi.fn(),
  startCopied: vi.fn(),
  answerRunPause: vi.fn(),
  planAgain: vi.fn(),
  showEarlierNarration: vi.fn(),
}));
vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: () => ({
    state: hook.state,
    send: hook.send,
    retry: vi.fn(),
    correctTurn: vi.fn(),
    approve: vi.fn(),
    discard: vi.fn(),
    dismissError: vi.fn(),
    stop: vi.fn(),
    startCopied: hook.startCopied,
    requestRestart: vi.fn(),
    answerRestartConfirm: vi.fn(),
    answerRunPause: hook.answerRunPause,
    planAgain: hook.planAgain,
    showEarlierNarration: hook.showEarlierNarration,
  }),
}));

type RailProps = { providerLimit?: 'retrying' | null };
const rail = vi.hoisted(() => ({ props: null as unknown as RailProps }));
vi.mock('@/components/planning/PlanChangeRail', () => ({
  PlanChangeRail: (props: RailProps) => {
    rail.props = props;
    return <div data-testid="rail-stub" />;
  },
}));
vi.mock('@/components/planning/PlanChangeCanvas', () => ({
  PlanChangeCanvas: () => <div data-testid="canvas-stub" />,
}));
vi.mock('@/components/planning/AuditCoverageBanner', () => ({
  AuditCoverageBanner: () => null,
}));

vi.mock('@/components/planning/PlanProposalViews', () => ({
  PlanProposalViews: () => <div data-testid="pane-stub" />,
}));
vi.mock('@/components/planning/FollowPlannerControl', () => ({
  FollowPlannerControl: () => null,
}));

const { PlanningWorkspaceHost } = await import('@/components/planning/PlanningWorkspaceHost');
const { parsePlanningLaunch } = await import('@/lib/planning/launcher');

const NOW = new Date().toISOString();
const snapshot = (waiting: boolean): PlanProgressSnapshot =>
  ({
    startedAt: NOW,
    lastActivityAt: NOW,
    observedAt: NOW,
    authored: 0,
    proposed: 0,
    autoResume: null,
    steps: [
      {
        sessionKey: 'lay:root',
        kind: 'lay',
        phrase: { kind: 'layTop' },
        targetRef: null,
        targetNodeId: null,
        targetTitle: null,
        startedAt: NOW,
        providerWait: waiting
          ? {
              attempt: 1,
              maxAttempts: 3,
              since: NOW,
              retryAt: new Date(Date.now() + 5_000).toISOString(),
            }
          : null,
      },
    ],
  }) as unknown as PlanProgressSnapshot;

const liveReview = (waiting: boolean) =>
  ({
    id: 'plan-1',
    status: 'generating',
    items: [],
    edgeCoverage: null,
    progress: snapshot(waiting),
  }) as unknown as PlanChangeConversationState['liveReview'];

function stateWith(extra: Partial<PlanChangeConversationState>): PlanChangeConversationState {
  return {
    phase: 'streaming',
    turns: [],
    review: null,
    decided: null,
    jobId: 'job-1',
    planId: 'plan-1',
    progress: null,
    errorCode: null,
    approved: null,
    queued: [],
    session: null,
    ...extra,
  } as unknown as PlanChangeConversationState;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

function renderHost() {
  return renderWithIntl(
    <PlanningWorkspaceHost
      projectKey="ACME"
      projectName="Acme"
      launch={parsePlanningLaunch({ mode: 'replan', from: 'project' })}
      anchorId={null}
      onClose={vi.fn()}
    />,
  );
}

const FAILURE: PlanSessionFailureDto = {
  failedAt: NOW,
  reason: 'rate_limited',
  stopPhase: null,
  stopRef: null,
  stopTitle: null,
};

describe('PlanningWorkspaceHost — the provider-limit value the rail is handed', () => {
  it('a first snapshot that already waits (a mid-retry open) hands the rail `retrying` on first paint', () => {
    hook.state = stateWith({ liveReview: liveReview(true) });
    renderHost();
    expect(rail.props.providerLimit).toBe('retrying');
  });

  it('a snapshot with no wait hands it null', () => {
    hook.state = stateWith({ liveReview: liveReview(false) });
    renderHost();
    expect(rail.props.providerLimit).toBeNull();
  });

  it('no plan yet (no snapshot) hands it null', () => {
    hook.state = stateWith({});
    renderHost();
    expect(rail.props.providerLimit).toBeNull();
  });

  it('a stored failure wins over a wait', () => {
    hook.state = stateWith({
      liveReview: liveReview(true),
      session: { id: 's1', targetKeys: [], turns: [], failure: FAILURE } as never,
    });
    renderHost();
    expect(rail.props.providerLimit).toBeNull();
  });
});
