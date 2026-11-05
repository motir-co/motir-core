// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import { planReview, planReviewItem } from '../helpers/planReview';

// BUG MOTIR-10428 — a plan opened from the Workbench Planning tab (or a Plans row, a
// reload, another device) WHILE Motir is still writing it had no Stop. The Stop lives
// in the composer's running bar, which is drawn only while the conversation is
// `streaming`, and only the screen that SENT the turn ever streamed: a screen that
// opened the session watched the plan being written through the poll, with nothing to
// press. The fix adopts the session's running job (`lastJobId`) when the session
// opens, so the bar and its Stop are drawn, and the Stop raises the stop door on that
// job — for a viewer who may plan. A read-only viewer sees the run working and is
// offered no Stop.
//
// The REAL `usePlanChangeConversation` drives the REAL `PlanningWorkspaceHost` (the
// defect lives in the seam: the hook's phase and the rail's bar). Only the transport
// is stubbed — the session read, the plan read, the job stream and the stop door.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
const { fetchPlanningAnchor } = vi.hoisted(() => ({ fetchPlanningAnchor: vi.fn() }));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor }));
vi.mock('@/lib/hooks/useWorkItemTargetSearch', () => ({
  useWorkItemTargetSearch: () => ({ results: [], loading: false, tooShort: true }),
}));

const { getNamed, fetchReview, stopRun, record, stream } = vi.hoisted(() => ({
  getNamed: vi.fn(),
  fetchReview: vi.fn(),
  stopRun: vi.fn(),
  record: vi.fn(),
  stream: vi.fn(),
}));
vi.mock('@/lib/planning/planChangeClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planning/planChangeClient')>()),
  getPlanChangeSession: getNamed,
  stopPlanChangeRun: stopRun,
  recordPlannerTurn: record,
}));
vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planning/planReviewClient')>()),
  fetchPlanReview: fetchReview,
  fetchPlanReviewSince: fetchReview,
}));
vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planning/planEditsClient')>()),
  streamAugmentJob: stream,
}));

import { PlanningWorkspaceHost } from '@/components/planning/PlanningWorkspaceHost';

/** The session a Workbench row opens: its turn was sent elsewhere, and its job runs. */
function named(over: Partial<PlanChangeSessionDto> = {}): PlanChangeSessionDto {
  return {
    id: 's9',
    projectId: 'p1',
    targetKeys: [],
    turnCount: 1,
    lastJobId: 'job-9',
    lastSubmittedAt: '2026-11-05T03:00:00.000Z',
    lastActivityAt: '2026-11-05T03:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-11-05T02:59:00.000Z',
    updatedAt: '2026-11-05T03:00:00.000Z',
    turns: [],
    workItemRefs: {},
    startedBy: { id: 'u1', name: 'Mara Lind' },
    startedByViewer: true,
    viewerCanPlan: true,
    pendingPlanId: 'plan_7',
    ...over,
  };
}

/** The plan Motir is writing — `native`, so a hosted job writes it. */
const generating = (authorSource: 'native' | 'mcp' = 'native') =>
  planReview([planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1' })], {
    id: 'plan_7',
    status: 'generating',
    plannedAt: null,
    authorSource,
  });

type Frame = (event: string, data: unknown) => void;

/** A job stream the test ends when it chooses; `frame` sends one frame into it. */
function heldStream() {
  const ends: Array<() => void> = [];
  const frames: Frame[] = [];
  stream.mockImplementation(
    (_job: string, _signal: AbortSignal, _onError: unknown, _onDone: unknown, onFrame: Frame) =>
      new Promise<void>((resolve) => {
        ends.push(resolve);
        frames.push(onFrame);
      }),
  );
  return {
    frame: (event: string, data: unknown) => act(() => frames.at(-1)?.(event, data)),
    end: () => act(async () => ends.at(-1)?.()),
  };
}

function mount() {
  return renderWithIntl(
    <PlanningWorkspaceHost
      projectKey="ACME"
      projectName="Acme"
      launch={{ ...parsePlanningLaunch({ mode: 'replan', from: 'project' }), sessionId: 's9' }}
      onClose={() => {}}
      initialTarget={null}
    />,
  );
}

beforeEach(() => {
  getNamed.mockReset().mockResolvedValue(named());
  fetchReview.mockReset().mockResolvedValue(generating());
  stopRun.mockReset().mockResolvedValue({ turns: [], stopped: true });
  record.mockReset().mockResolvedValue(named());
  stream.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a session opened while Motir is writing its plan', () => {
  it('⭐ draws the Stop, and the Stop raises the stop door on the session’s running job', async () => {
    heldStream();
    mount();

    const stop = await screen.findByTestId('plan-change-stop');
    // The run was ADOPTED: its stream is the session's own job.
    expect(stream).toHaveBeenCalled();
    expect(stream.mock.calls[0]![0]).toBe('job-9');
    // Nothing was sent from this screen, so the bar does not say "Sending…".
    expect(screen.getByTestId('plan-change-running-bar').textContent).toContain(
      'Motir AI is writing this plan…',
    );

    fireEvent.click(stop);
    await waitFor(() => expect(stopRun).toHaveBeenCalledTimes(1));
    expect(stopRun).toHaveBeenCalledWith('s9', 'job-9', 'stop:job-9');
    // The stop is RECORDED, not the run over: the bar says it is stopping.
    await waitFor(() =>
      expect(screen.getByTestId('plan-change-stop').textContent).toContain('Stopping…'),
    );
  });

  it('the live pane stays on the plan being written while the run is adopted', async () => {
    heldStream();
    mount();

    await screen.findByTestId('plan-change-stop');
    // The canvas is not cleared by the adoption: the plan stays drawn.
    expect(screen.queryByTestId('planning-pane-opening')).toBeNull();
  });

  it('the adopted stream narrates the run, and the bar goes when the run ends', async () => {
    const run = heldStream();
    mount();

    await screen.findByTestId('plan-change-stop');
    // The replayed run: a progress frame lands on the bar, then the job's end.
    run.frame('status', { status: 'running' });
    run.frame('validated', { seq: 1 });
    run.frame('status', { status: 'succeeded' });
    await run.end();

    await waitFor(() => expect(screen.queryByTestId('plan-change-stop')).toBeNull());
    expect(screen.queryByTestId('plan-change-running-bar')).toBeNull();
    // The settle records the planner's turn on the session, as the sending screen does.
    expect(record).toHaveBeenCalledWith('s9', 'job-9', null, expect.anything());
    // Adopted ONCE: the plan still reading `generating` does not adopt it again.
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('a READ-ONLY viewer sees the run working and is offered no Stop', async () => {
    getNamed.mockResolvedValue(named({ viewerCanPlan: false, startedByViewer: false }));
    heldStream();
    mount();

    const readOnly = await screen.findByTestId('planning-read-only');
    await waitFor(() =>
      expect(readOnly.querySelector('[data-testid="plan-change-running-bar"]')).not.toBeNull(),
    );
    expect(readOnly.textContent).toContain('Motir AI is writing this plan…');
    expect(screen.queryByTestId('plan-change-stop')).toBeNull();
    expect(stopRun).not.toHaveBeenCalled();
    // Not adopted: it only replays the run for its `target_settled` frame, and
    // records nothing on a session it may not write.
    expect(record).not.toHaveBeenCalled();
  });

  it('a plan an agent writes over MCP (plan.py) draws no Stop — no Motir job runs it', async () => {
    fetchReview.mockResolvedValue(generating('mcp'));
    mount();

    await waitFor(() => expect(fetchReview).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByTestId('plan-change-stop')).toBeNull();
    expect(screen.queryByTestId('plan-change-running-bar')).toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });

  // Bug MOTIR-10431: the session Motir opens for the auto-plan cadence, an expand or a
  // generation now records its job as `lastJobId` (`attachPlanSessionWithin`), so it
  // is adopted like a conversation's, with nobody as its starter.
  it('⭐ a CADENCE session, which carries its own job, draws the Stop on that job', async () => {
    getNamed.mockResolvedValue(
      named({
        lastJobId: 'job-cad',
        origin: 'cadence',
        turnCount: 0,
        startedBy: null,
        startedByViewer: false,
      }),
    );
    heldStream();
    mount();

    const stop = await screen.findByTestId('plan-change-stop');
    expect(stream.mock.calls[0]![0]).toBe('job-cad');
    fireEvent.click(stop);
    await waitFor(() => expect(stopRun).toHaveBeenCalledWith('s9', 'job-cad', 'stop:job-cad'));
  });

  it('a session that names no job draws no Stop', async () => {
    getNamed.mockResolvedValue(
      named({ lastJobId: null, lastSubmittedAt: null, origin: 'cadence' }),
    );
    mount();

    await waitFor(() => expect(fetchReview).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByTestId('plan-change-stop')).toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });

  it('a session WAITING on a failed attempt is not adopted — Resume is its way on', async () => {
    getNamed.mockResolvedValue(
      named({
        failure: {
          reason: 'machine_lost',
          stopPhase: null,
          stopRef: null,
          stopTitle: null,
          failedAt: '2026-11-05T03:05:00.000Z',
        } as unknown as PlanChangeSessionDto['failure'],
      }),
    );
    heldStream();
    mount();

    await waitFor(() => expect(fetchReview).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByTestId('plan-change-stop')).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });
});
