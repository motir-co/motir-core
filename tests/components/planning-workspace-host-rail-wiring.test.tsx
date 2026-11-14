// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// THE HOST'S RAIL WIRING — each control the rail draws reaches the ONE hook method
// it names (Story MOTIR-7990's coverage floor, MOTIR-8003).
//
// The host is a switchboard between `PlanChangeRail` and
// `usePlanChangeConversation`, and a crossed wire there is silent: the rail's
// suites mock the host's callbacks and the hook's suites never render the rail,
// so a *Start over* on the planner's pause that called `answerRestartConfirm`, or
// a *Plan again* that sent a turn, would pass both. So the rail is replaced by a
// stub that hands its props out, and each callback is pressed against the hook
// method it must call — with the argument it must carry.

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
    confirmRestart: vi.fn(),
    answerRestartConfirm: vi.fn(),
    answerRunPause: hook.answerRunPause,
    planAgain: hook.planAgain,
    showEarlierNarration: hook.showEarlierNarration,
  }),
}));

type RailProps = {
  declining: boolean;
  onStartNewSession: () => void;
  onAnswerRunPause: (choice: 'start_over' | 'apply') => void;
  onCarrySend: (text: string) => void;
  onPlanAgain: () => void;
  onShowEarlierNarration: () => void;
  onRequestDecline: () => void;
  onCancelDecline: () => void;
};
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

const { PlanningWorkspaceHost } = await import('@/components/planning/PlanningWorkspaceHost');
const { parsePlanningLaunch } = await import('@/lib/planning/launcher');

beforeEach(() => {
  vi.clearAllMocks();
  hook.state = {
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
  } as unknown as PlanChangeConversationState;
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

describe('PlanningWorkspaceHost — the rail’s controls reach the hook', () => {
  it('the planner’s pause answer carries its CHOICE to answerRunPause (MOTIR-8010)', () => {
    renderHost();

    act(() => rail.props.onAnswerRunPause('start_over'));
    act(() => rail.props.onAnswerRunPause('apply'));

    expect(hook.answerRunPause.mock.calls).toEqual([['start_over'], ['apply']]);
  });

  it('an ended session’s send is CARRIED through the hook’s own send, with the composer’s targets (MOTIR-7932 · MOTIR-8983)', () => {
    renderHost();

    act(() => rail.props.onCarrySend('Carry this on.'));

    expect(hook.send).toHaveBeenCalledTimes(1);
    // The composer's target set rides along, so the hook can tell a carry from a
    // turn about a different card; this render has picked none.
    expect(hook.send).toHaveBeenCalledWith('Carry this on.', []);
  });

  it('Start a new session, Plan again and Show earlier each call their own method, once', () => {
    renderHost();

    act(() => rail.props.onStartNewSession());
    act(() => rail.props.onPlanAgain());
    act(() => rail.props.onShowEarlierNarration());

    expect(hook.startCopied).toHaveBeenCalledTimes(1);
    expect(hook.planAgain).toHaveBeenCalledTimes(1);
    expect(hook.showEarlierNarration).toHaveBeenCalledTimes(1);
    // None of them is a turn.
    expect(hook.send).not.toHaveBeenCalled();
    expect(hook.answerRunPause).not.toHaveBeenCalled();
  });

  it('the rail’s decline confirmation opens on request and closes on cancel', () => {
    renderHost();
    expect(rail.props.declining).toBe(false);

    act(() => rail.props.onRequestDecline());
    expect(rail.props.declining).toBe(true);

    act(() => rail.props.onCancelDecline());
    expect(rail.props.declining).toBe(false);
  });
});
