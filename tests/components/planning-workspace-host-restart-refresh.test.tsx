// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// THE CARRY REWRITES THE ADDRESS AND NOTHING NAVIGATES BESIDE IT (bug MOTIR-8212,
// retired by Story MOTIR-8539 · MOTIR-8576).
//
// When an ended session is carried into a new one, the host rewrites the
// `planSession` address. That rewrite is itself a router navigation, and bug
// MOTIR-8212 was a route refresh dispatched in the same tick: under CI load the
// pair hard-reloaded the page and aborted the carried turn's submit. The fix then
// held the refresh until the router committed the address. MOTIR-8576 removed the
// refresh outright — the Workbench behind re-reads its own window, which is a
// fetch and not a navigation — so the rewrite has nothing to overlap, at once or
// later.

const { push, refresh, reread } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  reread: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('@/lib/workbench/workbenchReread', () => ({ useRequestWorkbenchReread: () => reread }));

const hook = vi.hoisted(() => ({
  state: null as unknown as PlanChangeConversationState,
  onRestarted: null as ((sessionId: string) => void) | null,
}));
vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: (opts: { onRestarted?: (sessionId: string) => void }) => {
    hook.onRestarted = opts.onRestarted ?? null;
    return {
      state: hook.state,
      send: vi.fn(),
      retry: vi.fn(),
      correctTurn: vi.fn(),
      approve: vi.fn(),
      discard: vi.fn(),
      dismissError: vi.fn(),
      stop: vi.fn(),
      startCopied: vi.fn(),
      confirmRestart: vi.fn(),
      answerRestartConfirm: vi.fn(),
      answerRunPause: vi.fn(),
      planAgain: vi.fn(),
      showEarlierNarration: vi.fn(),
    };
  },
}));
vi.mock('@/components/planning/PlanChangeRail', () => ({
  PlanChangeRail: () => <div data-testid="rail-stub" />,
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
  hook.onRestarted = null;
  hook.state = {
    phase: 'idle',
    turns: [],
    review: null,
    decided: null,
    jobId: null,
    planId: null,
    progress: null,
    errorCode: null,
    approved: null,
    queued: [],
  } as unknown as PlanChangeConversationState;
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function host(sessionId: string | null) {
  const launch = parsePlanningLaunch({ mode: 'replan', from: 'project' });
  return (
    <PlanningWorkspaceHost
      projectKey="ACME"
      projectName="Acme"
      launch={sessionId ? { ...launch, sessionId } : launch}
      anchorId={null}
      onClose={vi.fn()}
    />
  );
}

describe('PlanningWorkspaceHost — the carry navigates nothing beside the address (MOTIR-8212)', () => {
  it('rewrites the address at once, asks the Workbench to re-read, and never refreshes', () => {
    window.history.replaceState(null, '', '/workbench?planning=replan&planSession=s1');
    const view = renderWithIntl(host('s1'));

    act(() => hook.onRestarted?.('s2'));

    expect(new URL(window.location.href).searchParams.get('planSession')).toBe('s2');
    expect(reread).toHaveBeenCalledTimes(1);

    // The router committing the new address asks for nothing more.
    view.rerender(host('s2'));
    view.rerender(host('s2'));
    expect(reread).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('asks the same reread when there is no session address to rewrite', () => {
    window.history.replaceState(null, '', '/workbench?planning=replan');
    renderWithIntl(host(null));

    act(() => hook.onRestarted?.('s2'));

    expect(new URL(window.location.href).searchParams.has('planSession')).toBe(false);
    expect(reread).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
