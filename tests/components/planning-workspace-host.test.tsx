// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import { MAX_PLANNING_TARGETS, type PlanningTarget } from '@/lib/planning/planningTargets';

// The established-project planning HOST (Subtask MOTIR-1729, extended by
// MOTIR-1730) — what "Plan with AI" opens once a project has a plan. These lock
// in what the host itself owns: the launcher's mode + originating context
// reaching the surface, the exit chrome (Close / `Esc`) a shell with no app nav
// must carry, and — since MOTIR-1730 — the wiring between the conversation, the
// canvas diff and the confirm-to-persist gate.
//
// The canvas is STUBBED: `PlanChangeCanvas` fetches its own levels, and a plan's
// op treatments are `mergePlanLevel`'s (`plan-level-op-treatments.test.tsx`).
// What matters here is that the host mounts it for a populated project, and
// swaps in the empty state otherwise.

const { push, refresh, reread } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  reread: vi.fn(),
}));
/** The host's `onClose` is REQUIRED since MOTIR-4732 — there is no `backHref`
 *  fallback left, because the reader never leaves the page. */
const noop = () => {};
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
// The Workbench behind the overlay is asked to re-read itself (MOTIR-8576).
vi.mock('@/lib/workbench/workbenchReread', () => ({ useRequestWorkbenchReread: () => reread }));

// The `@`-mention search is the ONE network-backed thing inside the real
// composer. Stubbed so the picker can be driven without a debounce and a
// endpoint — what is under test is that the HOST adds what the composer hands
// it, not what the search returns. Inert unless a test types an `@` query.
const { fetchPlanningAnchor } = vi.hoisted(() => ({ fetchPlanningAnchor: vi.fn() }));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor }));

vi.mock('@/lib/hooks/useWorkItemTargetSearch', () => ({
  useWorkItemTargetSearch: (query: string, enabled: boolean) => ({
    results:
      enabled && query.trim().length >= 2
        ? [{ id: 'wi_9', identifier: 'MOTIR-9', title: 'Billing', kind: 'story' }]
        : [],
    loading: false,
    tooShort: query.trim().length < 2,
  }),
}));

// MOTIR-6186 — the surface now mounts the plan page's own List | Canvas for a
// proposed or decided plan, so this suite needs the review canvas stubbed for the
// same reason the change canvas is: it reads its own level over the network.
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: ({ outcome, ariaLabel }: { outcome?: string | null; ariaLabel?: string }) => (
    <div data-testid="review-canvas-stub" data-outcome={outcome ?? ''} aria-label={ariaLabel} />
  ),
}));

vi.mock('@/components/planning/PlanChangeCanvas', () => ({
  PlanChangeCanvas: ({
    projectKey,
    ariaLabel,
    diffKey,
    targetIds,
    initialTrail,
    followTo,
    loadingFallback,
    emptyRoot,
    onToggleTarget,
    canAddTarget,
  }: {
    projectKey: string;
    ariaLabel?: string;
    diffKey: string | number;
    targetIds?: readonly string[];
    initialTrail?: readonly { id: string; label: string }[];
    followTo?: { key: string; trail: readonly { id: string; label: string }[] } | null;
    loadingFallback?: ReactNode;
    emptyRoot?: ReactNode;
    onToggleTarget?: (
      target: { id: string; identifier: string; title: string; kind: string },
      isTarget: boolean,
    ) => void;
    canAddTarget?: boolean;
  }) => (
    <div
      data-testid="canvas-stub"
      data-project={projectKey}
      data-diff-key={String(diffKey)}
      data-targets={(targetIds ?? []).join(',')}
      data-trail={(initialTrail ?? []).map((c) => c.id).join(',')}
      // THE FOLLOW-MOVE's request (MOTIR-6161) — the host DERIVES it; the canvas
      // decides whether to honour it, and has its own suite for that.
      data-follow-key={followTo?.key ?? ''}
      data-follow-trail={(followTo?.trail ?? []).map((c) => c.id).join(',')}
      aria-label={ariaLabel}
    >
      {/* The two states the host DELEGATES to the canvas (MOTIR-2069). The real
          canvas picks between them off the level it reads itself; the stub
          renders both so the host's side of that contract is assertable. */}
      {/* The canvas's Set as target (MOTIR-6898): the real button lives in
          `ProjectRoadmapCanvas` and has its own suite; the stub hands the HOST
          the call the canvas would make for the card in `stubCard`. */}
      {onToggleTarget ? (
        <button
          type="button"
          data-testid="stub-toggle-target"
          data-can-add={String(canAddTarget)}
          onClick={() =>
            onToggleTarget(stubCard.current, (targetIds ?? []).includes(stubCard.current.id))
          }
        >
          toggle
        </button>
      ) : null}
      <div data-testid="canvas-loading-slot">{loadingFallback}</div>
      <div data-testid="canvas-empty-slot">{emptyRoot}</div>
    </div>
  ),
}));

// The card the canvas stub's toggle acts on — a hoisted box, so a test can move
// it between presses.
const { stubCard } = vi.hoisted(() => ({
  stubCard: {
    current: { id: 'wi_c1', identifier: 'MOTIR-51', title: 'Canvas card', kind: 'story' },
  },
}));

const { conversation } = vi.hoisted(() => ({
  conversation: {
    state: null as PlanChangeConversationState | null,
    send: vi.fn(),
    retry: vi.fn(),
    approve: vi.fn(),
    discard: vi.fn(),
    dismissError: vi.fn(),
    onApproved: null as ((r: unknown) => void) | null,
    anchorId: null as string | null,
    seedGateId: null as string | null,
    confirmRestart: vi.fn(),
    answerRestartConfirm: vi.fn(),
    onRestarted: null as ((sessionId: string) => void) | null,
  },
}));

vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: ({
    onApproved,
    anchorId,
    seedGateId,
    onRestarted,
  }: {
    onApproved?: (r: unknown) => void;
    anchorId?: string | null;
    seedGateId?: string | null;
    onRestarted?: (sessionId: string) => void;
  } = {}) => {
    conversation.onApproved = onApproved ?? null;
    conversation.onRestarted = onRestarted ?? null;
    conversation.anchorId = anchorId ?? null;
    conversation.seedGateId = seedGateId ?? null;
    return conversation;
  },
}));

import { PlanningWorkspaceHost } from '@/components/planning/PlanningWorkspaceHost';
import { planReview, planReviewItem } from '../helpers/planReview';

const IDLE: PlanChangeConversationState = {
  phase: 'idle',
  session: {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: 0,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    origin: 'conversation',
    createdAt: '',
    updatedAt: '',
    turns: [],
    workItemRefs: {},
  },
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

afterEach(() => {
  cleanup();
  push.mockReset();
  refresh.mockReset();
  reread.mockReset();
  conversation.state = null;
  conversation.approve.mockReset();
  conversation.discard.mockReset();
  conversation.send.mockReset();
});

/** Render the host exactly as the page does — parse the query, derive the href.
 *  Note what is NOT passed: the host takes no roadmap data at all (MOTIR-2069). */
function renderHost(
  searchParams: Record<string, string | string[] | undefined>,
  {
    state = IDLE,
    anchorId = null,
    initialTarget = null,
    initialCanvasTrail,
    canManage = false,
    onClose,
  }: {
    state?: PlanChangeConversationState;
    anchorId?: string | null;
    initialTarget?: PlanningTarget | null;
    initialCanvasTrail?: readonly { id: string; label: string }[];
    canManage?: boolean;
    onClose?: () => void;
  } = {},
) {
  const launch = parsePlanningLaunch(searchParams);
  conversation.state = state;
  return renderWithIntl(
    <PlanningWorkspaceHost
      projectKey="ACME"
      projectName="Acme"
      launch={launch}
      anchorId={anchorId}
      onClose={onClose ?? noop}
      initialTarget={initialTarget}
      initialCanvasTrail={initialCanvasTrail}
      canManage={canManage}
    />,
  );
}

/** The same element `renderHost` mounts, for a RE-render — the way a test walks
 *  a thread turn by turn without unmounting the surface between them, which is
 *  the whole property the footer slot is asserted on. */
function hostElement(searchParams: Record<string, string | string[] | undefined>) {
  const launch = parsePlanningLaunch(searchParams);
  return (
    <PlanningWorkspaceHost
      projectKey="ACME"
      projectName="Acme"
      launch={launch}
      anchorId={null}
      onClose={noop}
      initialTarget={null}
      canManage={false}
    />
  );
}

describe('PlanningWorkspaceHost — the item ANCHOR (MOTIR-910)', () => {
  it('hands the resolved anchor to the conversation, so the turn rides the ITEM’s thread', () => {
    renderHost({ mode: 'replan', from: 'work-item', item: 'MOTIR-5' }, { anchorId: 'wi_123' });
    expect(conversation.anchorId).toBe('wi_123');
  });

  it('falls back to the PROJECT conversation when no anchor resolved', () => {
    // A hand-edited `?item=` for something deleted or in another tenant must not
    // dead-end the workspace — the page resolves it to no anchor and the surface
    // still opens, talking to the project thread.
    renderHost({ mode: 'contextual', from: 'work-item', item: 'GONE-9' });
    expect(conversation.anchorId).toBeNull();
  });
});

describe('PlanningWorkspaceHost — the launcher context reaches the surface', () => {
  it('opens an established project in the plan-change mode with its tree on the canvas', () => {
    renderHost({ mode: 'replan', from: 'project' });

    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('plan change');
    expect(screen.getByText("Opened to change Acme's existing plan.")).toBeTruthy();
    // The canvas is seeded with the project's EXISTING tree (design panel 2).
    expect(screen.getByTestId('canvas-stub').getAttribute('data-project')).toBe('ACME');
  });

  it('opens in the contextual mode and names the work item it was launched from', () => {
    renderHost({ mode: 'contextual', from: 'work-item', item: 'MOTIR-7' });

    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('in context');
    expect(screen.getByText('Opened in the context of MOTIR-7.')).toBeTruthy();
  });

  it('opens in the roadmap mode from the roadmap door', () => {
    renderHost({ mode: 'roadmap', from: 'roadmap' });

    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('roadmap');
    expect(screen.getByText('Opened from the roadmap.')).toBeTruthy();
  });

  it('falls back to the project-scoped default for an unknown mode instead of erroring', () => {
    renderHost({ mode: 'teleport', from: 'nowhere' });

    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('plan');
    expect(screen.getByText('Opened on Acme.')).toBeTruthy();
  });

  it('mounts the CONVERSATION in the chat pane — the surface can be talked to', () => {
    renderHost({ mode: 'replan', from: 'project' });

    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe(
      'Reply, or refine further…',
    );
  });

  it('gives the canvas the workspace’s own empty-canvas statement to show', () => {
    // The honest empty canvas for an established-but-emptied project survived
    // the move (MOTIR-2069): the host no longer DECIDES it — the canvas does,
    // off the level it reads itself — but the copy is still the workspace's,
    // not the raw canvas's bare "nothing here" panel.
    renderHost({ mode: 'replan', from: 'project' });

    const empty = screen.getByTestId('canvas-empty-slot');
    expect(empty.textContent).toContain('Nothing on the canvas yet');
    expect(empty.textContent).toContain('This project has no work items to draw');
  });
});

describe('PlanningWorkspaceHost — the frame opens BEFORE any canvas data (MOTIR-2069)', () => {
  // The bug: `/planning` painted nothing at all until the root roadmap read had
  // resolved. The page awaited that read to compute a `hasItems` boolean before
  // returning a single element, on a segment with no instant-loading UI — so the
  // user sat on the PREVIOUS surface and the whole workspace then appeared at
  // once, already populated. The read was also a duplicate of the one the canvas
  // performs itself. These lock in that the host waits on nothing.

  it('takes NO roadmap data — the frame cannot be held hostage by a read', () => {
    // Rendered with no data prop of any kind, the entire frame is there: exit
    // chrome, project name, mode, and a live conversation. This is the assertion
    // the old shape could not make — the host could not render at all without
    // the page having already awaited the roots.
    renderHost({ mode: 'replan', from: 'project' });

    expect(screen.getByRole('button', { name: /Close/ })).toBeTruthy();
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('plan change');
    // The conversation is live immediately — it depends on no roadmap data, so a
    // user can start typing before the canvas has drawn a single node.
    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe(
      'Reply, or refine further…',
    );
  });

  it('hands the canvas a SKELETON for its pending level, in the same box the level fills', () => {
    const { container } = renderHost({ mode: 'replan', from: 'project' });

    // The canvas is the only child of the flex-sized slot whether it is loading,
    // empty or drawn — so nothing around it moves when the level arrives (the
    // no-layout-shift requirement).
    const slot = container.querySelector('.min-h-0.flex-1.overflow-hidden')!;
    expect(slot).toBeTruthy();
    expect(slot.childElementCount).toBe(1);
    expect(slot.firstElementChild!.getAttribute('data-testid')).toBe('canvas-stub');

    // …and what it shows while the level is in flight is a skeleton, not a
    // blank pane and not a bare spinner.
    const loading = screen.getByTestId('canvas-loading-slot');
    expect(loading.firstElementChild).toBeTruthy();
    expect(loading.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
    expect(loading.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});

describe('PlanningWorkspaceHost — the proposal is reviewed on the CANVAS', () => {
  const REVIEWING: PlanChangeConversationState = {
    ...IDLE,
    phase: 'review',
    jobId: 'job-1',
    planId: 'plan-1',
    review: planReview([
      planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story', title: 'Recurring' }),
      planReviewItem({
        planItemId: 'pi_2',
        op: 'modify',
        nodeId: 'wi_21',
        identifier: 'PAY-21',
        title: 'Email reminders',
        changes: [{ field: 'title', from: 'Payment reminders', to: 'Email reminders' }],
      }),
    ]),
  };

  it('shows NO confirm gate while nothing is proposed', () => {
    renderHost({ mode: 'replan', from: 'project' });
    expect(screen.queryByTestId('plan-change-confirm-bar')).toBeNull();
  });

  it("hands the proposal to the PLAN PAGE'S OWN views and raises the confirm-to-persist gate", () => {
    renderHost({ mode: 'replan', from: 'project' }, { state: REVIEWING });

    const bar = screen.getByTestId('plan-change-confirm-bar');
    expect(bar.textContent).toContain('1 added, 1 changed');
    expect(bar.textContent).toContain('Nothing is saved until you approve.');

    // ⭐ MOTIR-6186 — the pane is the SHARED component now, not the roadmap with
    // the proposal decorated over it. This is the story's central claim: what the
    // plan's own page shows, the surface shows, through one component.
    expect(screen.getByTestId('plan-proposal-views')).toBeTruthy();
    expect(screen.queryByTestId('canvas-stub')).toBeNull();
  });

  it('mounts the shared component for a PROPOSED plan, and the roadmap otherwise', () => {
    const { rerender } = renderHost({ mode: 'replan', from: 'project' });
    // No plan: the roadmap, exactly as before, and NO List | Canvas switch.
    expect(screen.getByTestId('canvas-stub')).toBeTruthy();
    expect(screen.queryByTestId('plan-proposal-views')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Plan view' })).toBeNull();

    conversation.state = REVIEWING;
    rerender(hostElement({ mode: 'replan', from: 'project' }));
    expect(screen.getByTestId('plan-proposal-views')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Plan view' })).toBeTruthy();
  });

  it('keeps the canvas MOUNTED under List, so the drilled level survives a round trip', () => {
    // The surface opts into `preserveCanvasLevel`; the plan page does not
    // (Part XXI 21.7). Hidden and `inert`, never unmounted.
    renderHost({ mode: 'replan', from: 'project' }, { state: REVIEWING });

    fireEvent.click(screen.getByRole('button', { name: /List/ }));

    const keepalive = screen.getByTestId('plan-review-canvas-keepalive');
    expect(keepalive.className).toContain('invisible');
    expect(keepalive.hasAttribute('inert')).toBe(true);
    // …and it is still THERE, which is the whole point.
    expect(within(keepalive).getByTestId('review-canvas-stub')).toBeTruthy();
  });

  it('never writes the view to the URL — the overlay does not own the address bar', () => {
    // Part XXI 21.4. `push` is the spy that must stay silent: Back already means
    // "close the workspace" here, through the pending guard.
    renderHost({ mode: 'replan', from: 'project' }, { state: REVIEWING });

    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    fireEvent.click(screen.getByRole('button', { name: /Canvas/ }));

    expect(push).not.toHaveBeenCalled();
  });

  // ── MOTIR-3162 (bug MOTIR-3154) — the overlay SURVIVES the decision ────────
  //
  // The host derives its ENTIRE diff index from `state.review`, so the hooks
  // nulling that field on approve and on discard erased the canvas overlay in
  // the same tick the decision landed.

  it.each(['accepted', 'declined'] as const)(
    'keeps a NON-EMPTY diff index after a plan is %s, and hands the outcome to the canvas',
    (decided) => {
      renderHost(
        { mode: 'replan', from: 'project' },
        { state: { ...REVIEWING, phase: 'idle', decided } },
      );

      // A DECIDED plan keeps the shared component, in Part VI's decided
      // treatment, and the outcome reaches its bodies (MOTIR-6186).
      expect(screen.getByTestId('plan-proposal-views')).toBeTruthy();
      expect(screen.getByTestId('review-canvas-stub').getAttribute('data-outcome')).toBe(decided);
    },
  );

  // ── MOTIR-1820 · the FOOTER SLOT ──────────────────────────────────────────
  //
  // The gate used to MOUNT and UNMOUNT, and it is a `shrink-0` sibling below a
  // `min-h-0 flex-1` canvas box — so the box grew and shrank by its full height
  // every time. The canvas anchors three control clusters to the BOTTOM of that
  // box, so all three hopped. Now one slot is always mounted and only its
  // CONTENT changes, which is what makes alternating between a question and a
  // change feel like one surface rather than two.

  it('⭐ HIDES the footer when there is nothing to show', () => {
    // MOTIR-6186 / Part XXI 21.8. The resting footer is gone: the pane's foot is
    // not a quiet box, it is nothing at all, and the body runs to the edge.
    renderHost({ mode: 'replan', from: 'project' });

    expect(screen.queryByTestId('plan-change-canvas-footer')).toBeNull();
    expect(screen.queryByTestId('plan-change-confirm-bar')).toBeNull();
  });

  it('⭐ the body box does NOT resize when the gate appears — the bar OVERLAYS it', () => {
    // THE ASSERTION MOTIR-1815 NEVER HAD, and the reason its fix looked safe to
    // remove. That bug was the bar being a `shrink-0` SIBLING of the body box: a
    // bar that came and went resized the box and slid the three control clusters
    // anchored to its bottom. The fix that shipped was an always-there resting
    // footer, which held the box constant by always spending the space.
    //
    // The footer is gone now, so the box is held constant a different way: it is
    // ALWAYS the full remainder, and the bar is absolutely positioned over it.
    // What is pinned here is exactly that — the same box, with and without a
    // proposal, and a bar that is positioned rather than stacked.
    const { rerender, container } = renderHost({ mode: 'replan', from: 'project' });
    const body = () => container.querySelector('[style*="--canvas-foot"]')!;

    const resting = body();
    expect(resting).toBeTruthy();
    expect(resting.className).toContain('flex-1');
    const restingChildren = resting.children.length;

    conversation.state = REVIEWING;
    rerender(hostElement({ mode: 'replan', from: 'project' }));

    const gated = body();
    // The SAME box: still the full remainder, still carrying the inset.
    expect(gated.className).toContain('flex-1');
    expect(gated.getAttribute('style')).toContain('--canvas-foot');
    // The bar is INSIDE it and absolutely positioned — not a sibling below it.
    const bar = screen.getByTestId('plan-change-confirm-bar');
    expect(gated.contains(bar)).toBe(true);
    expect(bar.closest('[class*="absolute"]')).toBeTruthy();
    // …and the box gained exactly the bar, not a layout row.
    expect(gated.children.length).toBe(restingChildren + 1);
  });

  it('⭐ chrome follows the LATEST TURN across an alternating thread', () => {
    // ask → change → ask. The rail is the same rail throughout and the user
    // changed no mode; only what the last turn produced decides the footer.
    const { rerender } = renderHost({ mode: 'replan', from: 'project' });
    expect(screen.queryByTestId('plan-change-confirm-bar')).toBeNull();

    conversation.state = REVIEWING;
    rerender(hostElement({ mode: 'replan', from: 'project' }));
    expect(screen.getByTestId('plan-change-confirm-bar')).toBeTruthy();

    // A question after a change does NOT discard the pending proposal — asking
    // mid-review is a lookup, not an abandonment — so the gate STAYS.
    conversation.state = { ...REVIEWING, phase: 'idle' };
    rerender(hostElement({ mode: 'replan', from: 'project' }));
    expect(screen.getByTestId('plan-change-confirm-bar')).toBeTruthy();

    // …and once it is decided, the foot goes with the bar (21.8).
    conversation.state = { ...REVIEWING, phase: 'idle', decided: 'accepted' };
    rerender(hostElement({ mode: 'replan', from: 'project' }));
    expect(screen.queryByTestId('plan-change-canvas-footer')).toBeNull();
    expect(screen.queryByTestId('plan-change-confirm-bar')).toBeNull();
  });

  it('drops the confirm gate once decided — a review is no longer a pending decision', () => {
    // The gate used to be keyed on "there IS a review", which was a safe proxy
    // only while a decision threw the review away. It is keyed on `decided` now.
    renderHost(
      { mode: 'replan', from: 'project' },
      { state: { ...REVIEWING, phase: 'idle', decided: 'accepted' } },
    );
    expect(screen.queryByTestId('plan-change-confirm-bar')).toBeNull();
    // …and the component is still there, drawing what was accepted.
    expect(screen.getByTestId('plan-proposal-views')).toBeTruthy();
  });

  it('routes Approve and Discard to the one conversation both panes share', () => {
    renderHost({ mode: 'replan', from: 'project' }, { state: REVIEWING });

    fireEvent.click(screen.getByRole('button', { name: /Approve changes/ }));
    expect(conversation.approve).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole('button', { name: 'Discard' })[0]!);
    expect(conversation.discard).toHaveBeenCalledTimes(1);
  });

  it('⭐ deciding from LIST is the same press as deciding from Canvas', () => {
    // The story's own claim. The bar is the pane's gate, not either body's, so
    // switching the body must not change what the verbs do — or where they are.
    renderHost({ mode: 'replan', from: 'project' }, { state: REVIEWING });

    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    expect(screen.getByTestId('plan-proposal-list')).toBeTruthy();
    // Still there, still one bar.
    expect(screen.getAllByTestId('plan-change-confirm-bar')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /Approve changes/ }));
    expect(conversation.approve).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole('button', { name: 'Discard' })[0]!);
    expect(conversation.discard).toHaveBeenCalledTimes(1);
  });

  it('⭐ switching views leaves the rail’s composer draft alone', () => {
    // The draft lives in the RAIL — the other pane — so a switch in the left pane
    // cannot reach it (Part XXI 21.7). Asserted rather than assumed, because "it
    // is in a different component" is exactly the kind of reasoning a later
    // refactor invalidates silently.
    renderHost({ mode: 'replan', from: 'project' }, { state: REVIEWING });

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'What about billing?' } });
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    fireEvent.click(screen.getByRole('button', { name: /Canvas/ }));

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('What about billing?');
  });

  it('⭐ seeds the view from the plan’s own shape, and PINS it across a re-read', () => {
    // `defaultPlanView` is the plan page's rule, unchanged (Part XXI 21.3): the
    // canvas, and the LIST when the proposals straddle more than one container.
    // Seeded ONCE per plan — a re-read must not move a reader between views.
    const { rerender } = renderHost({ mode: 'replan', from: 'project' }, { state: REVIEWING });
    expect(screen.getByRole('button', { name: /Canvas/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    // The reader moves to List…
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    expect(screen.getByRole('button', { name: /List/ }).getAttribute('aria-pressed')).toBe('true');

    // …and a re-read of the SAME plan (a stale refusal, a revision landing) must
    // leave them there.
    conversation.state = {
      ...REVIEWING,
      review: { ...REVIEWING.review!, status: 'stale' },
    };
    rerender(hostElement({ mode: 'replan', from: 'project' }));
    expect(screen.getByRole('button', { name: /List/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('page state after approve: no route refresh, a Workbench reread, and the canvas island re-keys', () => {
    renderHost({ mode: 'replan', from: 'project' }, { state: REVIEWING });

    // What the hook calls once the commit lands.
    fireEvent.click(screen.getByRole('button', { name: /Approve changes/ }));
    conversation.state = {
      ...REVIEWING,
      phase: 'idle',
      review: null,
      decided: null,
      jobId: null,
      planId: null,
    };
    act(() => conversation.onApproved?.({ created: ['wi_30'], updated: [], removed: [] }));

    // Nothing refreshes the route (MOTIR-8576); the Workbench behind re-reads itself…
    expect(refresh).not.toHaveBeenCalled();
    expect(reread).toHaveBeenCalledTimes(1);
    // …and the canvas — a client island seeded once — is re-keyed.
    //
    // ⚠️ The key is compared to the TREE VERSION rather than to a value captured
    // before the press (MOTIR-6186). While a plan is proposed the pane is the
    // shared component, so there is no `canvas-stub` at that moment to read a
    // "before" from; the review is cleared by the approve and the roadmap comes
    // back. `diffKey` opens with `treeVersion`, which `onApproved` bumps, so
    // asserting the bump IS the re-key — and it says so more directly than an
    // inequality against a string that happens to differ.
    const key = screen.getByTestId('canvas-stub').getAttribute('data-diff-key')!;
    expect(key.startsWith('1:')).toBe(true);
  });
});

describe('PlanningWorkspaceHost — the session ENDS (MOTIR-7643)', () => {
  it('an end releases the held cards: a Workbench reread, no refresh, and the canvas re-keys', () => {
    const view = renderHost({ mode: 'replan', from: 'project' });
    expect(reread).not.toHaveBeenCalled();

    conversation.state = {
      ...IDLE,
      session: { ...IDLE.session!, endedAt: '2026-07-27T11:00:00.000Z', endReason: 'failed' },
    };
    view.rerender(hostElement({ mode: 'replan', from: 'project' }));

    expect(reread).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    const key = screen.getByTestId('canvas-stub').getAttribute('data-diff-key')!;
    expect(key.startsWith('1:')).toBe(true);
  });

  it('a session that MOUNTS already ended refreshes nothing — nothing changed', () => {
    renderHost(
      { mode: 'replan', from: 'project' },
      {
        state: {
          ...IDLE,
          session: { ...IDLE.session!, endedAt: '2026-07-27T11:00:00.000Z', endReason: 'idle' },
        },
      },
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(reread).not.toHaveBeenCalled();
    expect(screen.getByTestId('canvas-stub').getAttribute('data-diff-key')!.startsWith('0:')).toBe(
      true,
    );
  });
});

describe('PlanningWorkspaceHost — Plan something new (MOTIR-7650)', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('wires the rail control, its dialog and the legacy confirm answers to the conversation', () => {
    renderHost(
      { mode: 'replan', from: 'project' },
      {
        state: {
          ...IDLE,
          session: {
            ...IDLE.session!,
            turns: [
              {
                id: 't0',
                seq: 0,
                role: 'assistant',
                body: 'Start something new?',
                jobId: null,
                question: null,
                confirm: 'new_session',
                isAnswer: false,
                intent: null,
                intentCorrected: false,
                citations: [],
                authorId: null,
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        },
      },
    );
    // The legacy confirm turn's answers (a session written before MOTIR-11261).
    fireEvent.click(screen.getByTestId('planning-restart-keep'));
    expect(conversation.answerRestartConfirm).toHaveBeenCalledWith('keep');
    fireEvent.click(screen.getByTestId('planning-restart-confirm'));
    expect(conversation.answerRestartConfirm).toHaveBeenCalledWith('confirm');
    // The control opens the dialog; its confirm is the conversation's `confirmRestart`.
    fireEvent.click(screen.getByTestId('planning-restart-control'));
    expect(conversation.confirmRestart).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByTestId('planning-restart-confirm'),
    );
    expect(conversation.confirmRestart).toHaveBeenCalledTimes(1);
  });

  it('the swap re-points an address that named the old session, re-keys the canvas and asks a reread', () => {
    window.history.replaceState(null, '', '/items/ACME-1?plan=replan&planSession=s1');
    renderHost({ mode: 'replan', from: 'project' });

    act(() => conversation.onRestarted!('s2'));

    expect(new URL(window.location.href).searchParams.get('planSession')).toBe('s2');
    // No refresh rides beside the address swap any more (MOTIR-8576), so there is
    // no second navigation to overlap it (MOTIR-8212) and nothing to wait for.
    expect(refresh).not.toHaveBeenCalled();
    expect(reread).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('canvas-stub').getAttribute('data-diff-key')!.startsWith('1:')).toBe(
      true,
    );
  });

  it('an address that named no session is left alone', () => {
    window.history.replaceState(null, '', '/items/ACME-1?plan=replan');
    renderHost({ mode: 'replan', from: 'project' });

    act(() => conversation.onRestarted!('s2'));

    expect(new URL(window.location.href).searchParams.has('planSession')).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(reread).toHaveBeenCalledTimes(1);
  });
});

describe('PlanningWorkspaceHost — the TARGET set is shared by both panes (MOTIR-1491)', () => {
  const TARGET: PlanningTarget = {
    id: 'wi-812',
    identifier: 'MOTIR-812',
    title: 'Billing — invoicing',
    kind: 'story',
  };

  it('pre-fills the entrance’s item as the INITIAL target — the chat and the map agree', () => {
    renderHost(
      { mode: 'contextual', from: 'work-item', item: 'MOTIR-812' },
      {
        initialTarget: TARGET,
      },
    );

    expect(screen.getByTestId('planning-target-chip').getAttribute('data-target-key')).toBe(
      'MOTIR-812',
    );
    // The same set reaches the canvas, which rings it.
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('wi-812');
  });

  it('the pre-filled target is INITIAL, not locked — it can be removed', () => {
    renderHost(
      { mode: 'contextual', from: 'work-item', item: 'MOTIR-812' },
      {
        initialTarget: TARGET,
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove MOTIR-812' }));

    expect(screen.queryByTestId('planning-target-chip')).toBeNull();
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('');
  });

  it('sends the turn WITH the target set, so the rail never has to know how a turn is scoped', () => {
    renderHost(
      { mode: 'contextual', from: 'work-item', item: 'MOTIR-812' },
      {
        initialTarget: TARGET,
      },
    );

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Expand this.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(conversation.send).toHaveBeenCalledWith('Expand this.', [TARGET]);
  });

  it('a project-scoped launch opens with NO target — the picker is opt-in', () => {
    renderHost({ mode: 'replan', from: 'project' });

    expect(screen.queryByTestId('planning-target-tray')).toBeNull();
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('');
  });
});

describe('PlanningWorkspaceHost — the anchor reaches the CANVAS too (MOTIR-2070)', () => {
  const TRAIL = [
    { id: 'wi-464', label: 'MOTIR-464 · Epic 7: AI Planning Layer' },
    { id: 'wi-812', label: 'MOTIR-812 · Contextual planning from each work item' },
  ];

  it('hands the anchor’s ancestor trail to the canvas, so it opens on the anchor’s level', () => {
    renderHost(
      { mode: 'contextual', from: 'work-item', item: 'MOTIR-909' },
      { anchorId: 'wi-909', initialCanvasTrail: TRAIL },
    );

    // The whole bug in one assertion: before this, the anchor reached the
    // conversation and NOTHING reached the canvas, which seeded itself at the root.
    expect(screen.getByTestId('canvas-stub').getAttribute('data-trail')).toBe('wi-464,wi-812');
    expect(conversation.anchorId).toBe('wi-909');
  });

  it('leaves the canvas at the root when there is no trail — project launch, or an epic', () => {
    renderHost({ mode: 'replan', from: 'project' });
    expect(screen.getByTestId('canvas-stub').getAttribute('data-trail')).toBe('');

    cleanup();
    renderHost(
      { mode: 'replan', from: 'work-item', item: 'MOTIR-464' },
      { anchorId: 'wi-464', initialCanvasTrail: [] },
    );
    expect(screen.getByTestId('canvas-stub').getAttribute('data-trail')).toBe('');
  });
});

describe('PlanningWorkspaceHost — the shell carries its own exit chrome', () => {
  // ⚠️ RE-POINTED (MOTIR-4729). These asserted a `<Link>` labelled with the
  // ORIGIN — *Back to roadmap* / *Back to MOTIR-7* — and a `keydown` listener on
  // `document`. Both belonged to the ROUTE: an overlay has no destination to
  // name, and the dialog owns `Esc` (one handler, not two — the collision
  // `design/runs/design-notes.md` warned about). The tests are re-pointed at
  // what replaced them rather than deleted, because the property they were
  // protecting — the shell carries its OWN way out, since it has no app nav —
  // is unchanged.

  it('renders ONE Close control, as a button, labelled without a destination', () => {
    renderHost({ mode: 'replan', from: 'project' });

    const close = screen.getByRole('button', { name: /Close/ });
    // Not a link: there is nowhere to go. The reader is already on the page.
    expect(close.tagName).toBe('BUTTON');
    expect(screen.queryByRole('link', { name: /Back to/ })).toBeNull();
    // The `Esc` hint stays beside it — the key still closes, from the dialog.
    expect(within(close).getByText('Esc')).toBeTruthy();
  });

  it('says the same thing whatever the launch was — the label names no origin', () => {
    const project = renderHost({ mode: 'replan', from: 'project' });
    const projectLabel = screen.getByRole('button', { name: /Close/ }).textContent;
    project.unmount();

    renderHost({ mode: 'contextual', from: 'work-item', item: 'MOTIR-7' });
    const close = screen.getByRole('button', { name: /Close/ });
    expect(close.textContent).toBe(projectLabel);
    // The RAIL still says which item the turn is about — that is its job. The
    // exit chrome is what stopped naming a destination.
    expect(close.textContent).not.toContain('MOTIR-7');
  });

  it('calls `onClose` — the seam the overlay routes every vector through', () => {
    const onClose = vi.fn();
    renderHost({ mode: 'contextual', from: 'work-item', item: 'MOTIR-7' }, { onClose });

    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // It does NOT navigate: the page underneath must not unmount.
    expect(push).not.toHaveBeenCalled();
  });

  it('has NO navigation fallback left — closing never routes anywhere', () => {
    // ⚠️ RE-POINTED (MOTIR-4732). This asserted the `backHref` arm, which
    // existed for one caller: the `(planning)` page, a Server Component that
    // could not hand a callback across the boundary. That page is deleted, the
    // prop with it, and `onClose` is required — there is nowhere to navigate
    // BACK to, because the reader never left.
    const onClose = vi.fn();
    renderHost({ mode: 'contextual', from: 'work-item', item: 'MOTIR-7' }, { onClose });

    fireEvent.click(screen.getByRole('button', { name: /Close/ }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('no longer listens for `Esc` itself — the dialog owns the key', () => {
    const onClose = vi.fn();
    renderHost({ mode: 'replan', from: 'project' }, { onClose });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('mounts the workspace CHROME-FITTED, not viewport-sized', () => {
    // Inside a `h-dvh` dialog panel a second `h-dvh` child overflows by whatever
    // the panel's own box costs. `PlanningWorkspace`'s own docstring offers this
    // variant for exactly a chrome-fitted container.
    const { container } = renderHost({ mode: 'replan', from: 'project' });
    const frame = container.querySelector('.grid');
    expect(frame?.className).toContain('h-full');
    expect(frame?.className).not.toContain('h-dvh');
  });
});

// ── The audit-coverage banner's HOST gate (MOTIR-2250) ──────────────────────
//
// ⚠️ `/planning` lives in the `(planning)` route group, OUTSIDE `(authed)`, so
// `ProjectAccessProvider` is NOT mounted here and `useProjectAccess()` would
// return its documented PERMISSIVE default — showing an admin-only prompt to
// every member. The capability is therefore threaded as an explicit prop, and
// these pin that the gate is real rather than inherited from that default.
describe('PlanningWorkspaceHost — the audit-coverage banner is admin-only', () => {
  const coverage = { repos: [], notAuditedCount: 2 };

  function stubCoverage() {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (input: string) => {
      calls.push(String(input));
      return Promise.resolve({ ok: true, json: async () => coverage } as unknown as Response);
    });
    return calls;
  }

  it('renders it for a viewer who CAN manage the project', async () => {
    stubCoverage();
    renderHost({ mode: 'replan', from: 'project' }, { canManage: true });
    await act(async () => {});

    expect(screen.getByRole('status').textContent).toContain('2 repositories have no code-health');
    vi.unstubAllGlobals();
  });

  it('renders NOTHING for a viewer who cannot — and never even asks', async () => {
    const calls = stubCoverage();
    renderHost({ mode: 'replan', from: 'project' }, { canManage: false });
    await act(async () => {});

    expect(screen.queryByRole('status')).toBeNull();
    // The member's browser does not even issue the read: the banner is not
    // mounted, so there is no request for the server gate to refuse.
    expect(calls.filter((c) => c.includes('audit-coverage'))).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('defaults to NOT rendering when the capability is not supplied at all', async () => {
    stubCoverage();
    renderHost({ mode: 'replan', from: 'project' });
    await act(async () => {});

    expect(screen.queryByRole('status')).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('coverage · the TARGET SET the host owns (MOTIR-4733)', () => {
  it('ADDS a target the composer’s `@` picker hands it', async () => {
    // The other half of the set the host owns. The composer's mention picker is
    // its only producer, so it is driven for real — only the search is stubbed
    // (see the mock at the top of this file), because a candidate list is not
    // what this asserts.
    renderHost({ mode: 'replan', from: 'project' });
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('');

    // The Search control opens the target search; the query goes in ITS field
    // (MOTIR-6897), never in the message.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Search work items to plan' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('planning-target-search-field'), {
        target: { value: 'Billing' },
      });
    });

    const option = screen.queryByRole('option', { name: /MOTIR-9/ });
    // If the listbox did not open, say so rather than passing on a missing
    // element — a `queryBy` that finds nothing is not a green test.
    expect(option, 'the target search listbox did not open').not.toBeNull();
    // ⚠️ `mouseDown`, not `click`: the option commits on POINTER DOWN so the
    // composer's input never loses focus to it (`TargetSearchListbox`). A
    // `click` here would assert nothing and pass silently.
    await act(async () => {
      fireEvent.mouseDown(option!);
    });

    // The CANVAS rings it — which is the point of the set living on the host
    // rather than in the rail: both panes read it.
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('wi_9');
  });

  it('removes the entrance’s pre-filled target when the chip’s ⨉ is pressed', () => {
    // `addTarget` / `removeTarget` live on the HOST, not the rail, because both
    // panes read the set: the composer collects it and the canvas rings it. They
    // are handed to the real composer, so this drives the real chip — the only
    // place either is reachable from.
    const target = { id: 'wi_7', identifier: 'MOTIR-7', title: 'The anchor', kind: 'subtask' };
    renderHost(
      { mode: 'contextual', from: 'work-item', item: 'MOTIR-7' },
      { initialTarget: target as PlanningTarget },
    );

    // The canvas RINGS it while it is in the set…
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('wi_7');

    const remove = screen.getByRole('button', { name: /MOTIR-7/ });
    fireEvent.click(remove);

    // …and stops the moment it leaves. The entrance's item is a SEED, not a
    // lock: the user can drop it and plan about something else.
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('');
    expect(screen.queryByTestId('planning-target-chip')).toBeNull();
  });
});

describe('PlanningWorkspaceHost — Set as target on the CANVAS (MOTIR-6898)', () => {
  const toggle = () => screen.getByTestId('stub-toggle-target');
  const card = (n: number) => ({
    id: `wi_c${n}`,
    identifier: `MOTIR-${50 + n}`,
    title: `Canvas card ${n}`,
    kind: 'story',
  });

  afterEach(() => {
    stubCard.current = card(1);
  });

  it('adds the card to the SAME set the composer feeds — the chip and the ring agree', () => {
    renderHost({ mode: 'replan', from: 'project' });
    stubCard.current = card(1);

    fireEvent.click(toggle());

    expect(screen.getByTestId('planning-target-chip').getAttribute('data-target-key')).toBe(
      'MOTIR-51',
    );
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('wi_c1');
  });

  it('a card that already IS a target is removed by the same toggle', () => {
    renderHost({ mode: 'replan', from: 'project' });
    stubCard.current = card(1);

    fireEvent.click(toggle());
    fireEvent.click(toggle());

    expect(screen.queryByTestId('planning-target-chip')).toBeNull();
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('');
  });

  it('tells the canvas when the set is at the CAP, and again when it is not', () => {
    renderHost({ mode: 'replan', from: 'project' });
    expect(toggle().getAttribute('data-can-add')).toBe('true');

    for (let n = 1; n <= MAX_PLANNING_TARGETS; n++) {
      stubCard.current = card(n);
      fireEvent.click(toggle());
    }
    expect(toggle().getAttribute('data-can-add')).toBe('false');

    // Remove still works at the cap.
    stubCard.current = card(1);
    fireEvent.click(toggle());
    expect(toggle().getAttribute('data-can-add')).toBe('true');
  });

  it('a target picked ON THE CANVAS never arms the follow-move — the canvas stays put', async () => {
    fetchPlanningAnchor.mockReset();
    renderHost({ mode: 'replan', from: 'project' });
    stubCard.current = card(1);

    await act(async () => {
      fireEvent.click(toggle());
    });

    expect(fetchPlanningAnchor).not.toHaveBeenCalled();
    expect(screen.getByTestId('canvas-stub').getAttribute('data-follow-key')).toBe('');
  });
});

// ── THE FOLLOW-MOVE's REQUEST (MOTIR-6161, Story MOTIR-6154) ─────────────────
//
// The host DERIVES it; the canvas decides whether to honour it and has its own
// suite for that. What is ruled on here is only the deriving: which of the two
// moments fires, which one wins, and — the clause that is easiest to get wrong —
// that a surface which ALREADY arrived inside a target never asks to move again.
describe('PlanningWorkspaceHost — the follow-move request', () => {
  const canvas = () => screen.getByTestId('canvas-stub');

  // The composer's `@` picker is the only producer of a target, so it is driven
  // for real. ⚠️ `mouseDown`, not `click`: the option commits on POINTER DOWN so
  // the input never loses focus to it (`TargetSearchListbox`) — a `click` adds
  // nothing and the test passes on an empty target set.
  async function addBillingTarget() {
    // The Search control opens the target search; the query goes in ITS field
    // (MOTIR-6897), never in the message.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Search work items to plan' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('planning-target-search-field'), {
        target: { value: 'Billing' },
      });
    });
    const option = screen.queryByRole('option', { name: /MOTIR-9/ });
    expect(option, 'the target search listbox did not open').not.toBeNull();
    await act(async () => {
      fireEvent.mouseDown(option!);
    });
  }

  // ⚠️ `generating`, NOT `planned`, AND THAT IS THE MERGE OF TWO STORIES
  // (MOTIR-6154's follow-move meeting MOTIR-6155's pane swap).
  //
  // The follow-move asks `ProjectRoadmapCanvas` to move, so it only means anything
  // while the ROADMAP canvas is the pane. Since MOTIR-6155 a PROPOSED plan
  // (`planned` / `stale`) is drawn by the plan page's own List | Canvas component
  // instead, and that component ARRIVES at the level the plan fills by itself —
  // through `arrivalLevel`, the very rule `followFromPlan` asks. So on the
  // proposed path there is no canvas to move and no move to make: the outcome the
  // person sees is identical, reached one layer down.
  //
  // What is left live for trigger 2 is the window where a review is in hand and is
  // NOT proposed — a plan still being written, or re-read mid-revise — which is
  // where the roadmap canvas is still the pane. That is the state these three
  // cases now describe, so they rule on a delivery that can actually happen.
  //
  // The RULE itself (which level, folders, stale folders, roots-only) is ruled on
  // directly in `tests/planning/surfaceFollow.test.ts`; these cases are about the
  // host DELIVERING it to the canvas.
  function reviewLandingUnder(parentNodeId: string): PlanChangeConversationState {
    return {
      ...IDLE,
      review: planReview(
        [
          planReviewItem({
            op: 'add',
            nodeId: 'p1',
            parentNodeId,
            parentIdentifier: 'MOTIR-1',
            parentTitle: 'The epic',
            parentTrail: [{ id: parentNodeId, identifier: 'MOTIR-1', title: 'The epic' }],
          }),
        ],
        { status: 'generating' },
      ),
    };
  }

  it('asks for the level the PLAN lands in, when the surface opened with no target', () => {
    renderHost({ mode: 'replan', from: 'project' }, { state: reviewLandingUnder('wi_e1') });

    expect(canvas().getAttribute('data-follow-key')).toBe('plan:wi_e1');
    expect(canvas().getAttribute('data-follow-trail')).toBe('wi_e1');
  });

  it('asks for NOTHING when the surface already arrived inside a target', () => {
    // A work-item launch is already standing in the right place, and a second
    // target must not move the canvas off the first (the story's rule: with
    // several targets the canvas is inside the FIRST one).
    renderHost(
      { mode: 'replan', from: 'work-item', item: 'MOTIR-3' },
      {
        state: reviewLandingUnder('wi_e1'),
        initialTarget: { id: 'wi_3', identifier: 'MOTIR-3', title: 'The story', kind: 'story' },
      },
    );

    expect(canvas().getAttribute('data-follow-key')).toBe('');
  });

  it('asks for NOTHING while the plan proposes only roots', () => {
    // A plan that names no container lands at the top level, which is where a
    // target-less surface already is — so there is no move to ask for.
    renderHost(
      { mode: 'replan', from: 'project' },
      {
        state: {
          ...IDLE,
          // `generating` for the same reason `reviewLandingUnder` is — see its note.
          review: planReview([planReviewItem({ op: 'add', nodeId: 'p1', parentNodeId: null })], {
            status: 'generating',
          }),
        },
      },
    );

    expect(canvas().getAttribute('data-follow-key')).toBe('');
  });

  it('asks for NOTHING before there is a plan at all', () => {
    renderHost({ mode: 'replan', from: 'project' });
    expect(canvas().getAttribute('data-follow-key')).toBe('');
  });

  it('⭐ has NO canvas to move once the plan is PROPOSED — the component arrives itself', () => {
    // The seam between the two stories, stated positively so the merge is pinned
    // rather than inferred. The same plan that asks for `plan:wi_e1` while it is
    // being written asks for nothing once it is proposed, because the pane is no
    // longer a roadmap canvas: it is the plan page's List | Canvas, which lands on
    // the level the plan fills through `arrivalLevel` — the rule `followFromPlan`
    // itself asks. Same destination, one layer down.
    renderHost(
      { mode: 'replan', from: 'project' },
      {
        state: {
          ...IDLE,
          review: planReview([
            planReviewItem({
              op: 'add',
              nodeId: 'p1',
              parentNodeId: 'wi_e1',
              parentIdentifier: 'MOTIR-1',
              parentTitle: 'The epic',
              parentTrail: [{ id: 'wi_e1', identifier: 'MOTIR-1', title: 'The epic' }],
            }),
          ]),
        },
      },
    );

    expect(screen.queryByTestId('canvas-stub')).toBeNull();
    expect(screen.getByTestId('review-canvas-stub')).toBeTruthy();
  });

  it('asks for the TARGET the person added, reading its ancestors from the anchor', async () => {
    // Trigger 1. The trail needs the target's ANCESTORS, which only the anchor
    // read has — hence a fetch rather than a derivation from the chip.
    //
    // ⚠️ Ruled on WITHOUT a competing plan on purpose. Which of the two triggers
    // WINS is a property of `followRequest`, and it is ruled on directly in
    // `tests/planning/surfaceFollow.test.ts`; asserting it again through two
    // async arrivals in a component would be testing the scheduler, not the rule.
    fetchPlanningAnchor.mockResolvedValue({
      anchor: { id: 'wi_e1', identifier: 'MOTIR-1', title: 'The epic', kind: 'epic' },
      ancestors: [],
      hasChildren: true,
    });
    renderHost({ mode: 'replan', from: 'project' });

    await addBillingTarget();

    // Asserted by ARGUMENT, not merely "was called": the effect asks for the
    // target's KEY, and a bare `toHaveBeenCalled` would pass on a call another
    // test left behind.
    await waitFor(() =>
      expect(fetchPlanningAnchor).toHaveBeenCalledWith('MOTIR-9', expect.anything()),
    );
    // The anchor read resolves in a microtask OUTSIDE an act scope, so its
    // setState needs one to flush — the act-environment contract CLAUDE.md
    // states, in the "an async action resolving after the last assertion" shape.
    await act(async () => {});
    expect(canvas().getAttribute('data-follow-key')).toBe('target:wi_e1');
    expect(canvas().getAttribute('data-follow-trail')).toBe('wi_e1');
  });

  it('says NOTHING when the added target cannot be read — an outage is not a move', async () => {
    fetchPlanningAnchor.mockRejectedValue(new Error('502'));
    renderHost({ mode: 'replan', from: 'project' });

    await addBillingTarget();

    // Asserted by ARGUMENT, not merely "was called": the effect asks for the
    // target's KEY, and a bare `toHaveBeenCalled` would pass on a call another
    // test left behind.
    await waitFor(() =>
      expect(fetchPlanningAnchor).toHaveBeenCalledWith('MOTIR-9', expect.anything()),
    );
    expect(canvas().getAttribute('data-follow-key')).toBe('');
  });

  it('says NOTHING when the added target resolves to no level — a 404 is silent', async () => {
    fetchPlanningAnchor.mockResolvedValue(null);
    renderHost({ mode: 'replan', from: 'project' });

    await addBillingTarget();

    // Asserted by ARGUMENT, not merely "was called": the effect asks for the
    // target's KEY, and a bare `toHaveBeenCalled` would pass on a call another
    // test left behind.
    await waitFor(() =>
      expect(fetchPlanningAnchor).toHaveBeenCalledWith('MOTIR-9', expect.anything()),
    );
    expect(canvas().getAttribute('data-follow-key')).toBe('');
  });
});

describe('coverage · a SEEDED re-plan (MOTIR-6210 · MOTIR-6212)', () => {
  it('the composer holds the seed unsent, and the conversation carries the gate for the first send', () => {
    const turn = 'ACME-44 · Where exports live\n\nRe-plan this work item from that reason.';
    conversation.state = { ...IDLE, session: null };
    renderWithIntl(
      <PlanningWorkspaceHost
        projectKey="ACME"
        projectName="Acme"
        launch={parsePlanningLaunch({ mode: 'replan', from: 'work-item', item: 'ACME-44' })}
        anchorId="wi_44"
        onClose={noop}
        initialTarget={null}
        initialDraft={turn}
        seedGateId="gate-44"
      />,
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(turn);
    expect(conversation.seedGateId).toBe('gate-44');
    expect(conversation.send).not.toHaveBeenCalled();
  });
});

// THE ZERO-TURN MCP RAIL (Subtask MOTIR-6298; design Part XXIII §23.11). The host
// derives the rail's note from the plan's OWN attribution — the live review while an
// agent writes it, the proposed review after — and the thread's turn count, and keeps
// it once a turn is sent, because it is still true.
describe('PlanningWorkspaceHost — the conversation happened ELSEWHERE (MOTIR-6298)', () => {
  const PARAMS = { mode: 'replan', from: 'project', planSession: 's1' };
  const note = () => screen.queryByTestId('planning-mcp-no-turns');
  const byAgent = (
    over: Partial<ReturnType<typeof planReview>> = {},
  ): ReturnType<typeof planReview> =>
    planReview([planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story' })], {
      authorSource: 'mcp',
      authorHarness: 'Claude Code',
      ...over,
    });
  const WRITING: PlanChangeConversationState = {
    ...IDLE,
    planId: 'plan-1',
    liveReview: byAgent({ status: 'generating' }),
  };
  const withTurn = (state: PlanChangeConversationState): PlanChangeConversationState => ({
    ...state,
    session: {
      ...IDLE.session!,
      turnCount: 1,
      turns: [
        {
          id: 't1',
          seq: 1,
          role: 'user',
          body: 'Split the billing story.',
          jobId: 'job-2',
          question: null,
          isAnswer: false,
          intent: null,
          intentCorrected: false,
          citations: [],
          authorId: 'u1',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  });

  it('names the harness from the LIVE review of a plan an agent is still writing', () => {
    renderHost(PARAMS, { state: WRITING });
    expect(note()?.textContent).toContain('happened in Claude Code,');
    // The composer stays live beside it.
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('names it from the PROPOSED review once the plan is proposed', () => {
    renderHost(PARAMS, {
      state: { ...IDLE, phase: 'review', planId: 'plan-1', review: byAgent() },
    });
    expect(note()?.textContent).toContain('happened in Claude Code,');
  });

  it('never shows for a HOSTED plan — its conversation IS the rail', () => {
    renderHost(PARAMS, {
      state: {
        ...IDLE,
        planId: 'plan-1',
        liveReview: byAgent({ status: 'generating', authorSource: 'native', authorHarness: null }),
      },
    });
    expect(note()).toBeNull();
  });

  it('does not show for an MCP plan with NO recorded harness', () => {
    renderHost(PARAMS, {
      state: { ...WRITING, liveReview: byAgent({ status: 'generating', authorHarness: null }) },
    });
    expect(note()).toBeNull();
  });

  it('does not show for an MCP session that ALREADY had turns when its plan was read', () => {
    renderHost(PARAMS, { state: withTurn(WRITING) });
    expect(note()).toBeNull();
  });

  it('⭐ STAYS once a turn is sent — the new run clears the review, and it is still true', () => {
    const { rerender } = renderHost(PARAMS, { state: WRITING });
    expect(note()).not.toBeNull();

    // The person asks Motir AI: the thread gains a turn and the run's own state
    // replaces the agent's review.
    conversation.state = { ...withTurn(IDLE), phase: 'streaming', jobId: 'job-2' };
    rerender(hostElement(PARAMS));
    expect(note()?.textContent).toContain('happened in Claude Code,');
  });

  it('is keyed on the SESSION — a different session does not inherit it', () => {
    const { rerender } = renderHost(PARAMS, { state: WRITING });
    expect(note()).not.toBeNull();

    conversation.state = {
      ...withTurn(IDLE),
      session: { ...withTurn(IDLE).session!, id: 's2' },
    };
    rerender(hostElement(PARAMS));
    expect(note()).toBeNull();
  });
});

describe('PlanningWorkspaceHost — what Approve says while it runs (MOTIR-5249 / MOTIR-5251)', () => {
  // The host DERIVES the progress once and hands it to both doors (design Part XXV
  // §25.10): both show it while the approve runs, and only the pressed door is the
  // live region, so one press is read once. A timeout is said only at the pressed door.
  const REVIEW: PlanChangeConversationState = {
    ...IDLE,
    phase: 'review',
    jobId: 'job-1',
    planId: 'plan-1',
    review: planReview([
      planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story', title: 'Recurring' }),
      planReviewItem({ planItemId: 'pi_2', nodeId: 'pi_2', kind: 'task', title: 'Invoices' }),
      planReviewItem({ planItemId: 'pi_3', nodeId: 'pi_3', kind: 'task', title: 'Receipts' }),
    ]),
  };

  // The canvas bar's verb reads *Approve changes*; the rail review block's mirror
  // reads *Approve*.
  const barVerb = () => screen.queryByRole('button', { name: /Approve changes/ });
  const railVerb = () => screen.queryByRole('button', { name: 'Approve' });
  function pressApprove(door: 0 | 1) {
    fireEvent.click((door === 0 ? barVerb() : railVerb())!);
  }

  it('shows the progress in BOTH doors once an approve is in flight, live only where it was pressed', () => {
    const { rerender } = renderHost({ mode: 'replan', from: 'project' }, { state: REVIEW });
    pressApprove(0);
    expect(conversation.approve).toHaveBeenCalledTimes(1);

    conversation.state = { ...REVIEW, phase: 'deciding' };
    rerender(hostElement({ mode: 'replan', from: 'project' }));

    const shown = screen.getAllByTestId('plan-approve-progress');
    expect(shown.map((el) => el.getAttribute('data-place')).sort()).toEqual(['bar', 'rail']);
    const live = shown.filter((el) => el.getAttribute('role') === 'status');
    expect(live).toHaveLength(1);
    expect(live[0]!.getAttribute('data-place')).toBe('bar');
    // An all-adds plan of three says it creates three.
    expect(live[0]!.textContent).toContain('Adding 3 items to your backlog…');
    // No verb is left to press twice, in either door.
    expect(barVerb()).toBeNull();
    expect(railVerb()).toBeNull();
  });

  it('moves the live region to the RAIL when the rail’s Approve was the press', () => {
    const { rerender } = renderHost({ mode: 'replan', from: 'project' }, { state: REVIEW });
    pressApprove(1);
    conversation.state = { ...REVIEW, phase: 'deciding' };
    rerender(hostElement({ mode: 'replan', from: 'project' }));

    const live = screen
      .getAllByTestId('plan-approve-progress')
      .filter((el) => el.getAttribute('role') === 'status');
    expect(live).toHaveLength(1);
    expect(live[0]!.getAttribute('data-place')).toBe('rail');
  });

  it('says "changes" once any proposal is not an add', () => {
    const mixed: PlanChangeConversationState = {
      ...REVIEW,
      review: planReview([
        planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story', title: 'Recurring' }),
        planReviewItem({
          planItemId: 'pi_2',
          op: 'modify',
          nodeId: 'wi_21',
          identifier: 'PAY-21',
          title: 'Email reminders',
          changes: [{ field: 'title', from: 'Payment reminders', to: 'Email reminders' }],
        }),
      ]),
    };
    const { rerender } = renderHost({ mode: 'replan', from: 'project' }, { state: mixed });
    pressApprove(0);
    conversation.state = { ...mixed, phase: 'deciding' };
    rerender(hostElement({ mode: 'replan', from: 'project' }));

    const live = screen
      .getAllByTestId('plan-approve-progress')
      .find((el) => el.getAttribute('role') === 'status');
    expect(live!.textContent).toContain('Applying 2 changes to your backlog…');
  });

  it('shows NO approve progress while a DECLINE is in flight', () => {
    const { rerender } = renderHost({ mode: 'replan', from: 'project' }, { state: REVIEW });
    fireEvent.click(screen.getAllByRole('button', { name: 'Discard' })[0]!);
    expect(conversation.discard).toHaveBeenCalledTimes(1);

    conversation.state = { ...REVIEW, phase: 'deciding' };
    rerender(hostElement({ mode: 'replan', from: 'project' }));
    expect(screen.queryByTestId('plan-approve-progress')).toBeNull();
  });

  it('says a TIMEOUT only at the door that was pressed, with the verbs back', () => {
    const { rerender } = renderHost({ mode: 'replan', from: 'project' }, { state: REVIEW });
    pressApprove(1);
    conversation.state = { ...REVIEW, phase: 'deciding' };
    rerender(hostElement({ mode: 'replan', from: 'project' }));

    conversation.state = { ...REVIEW, errorCode: 'timedOut' };
    rerender(hostElement({ mode: 'replan', from: 'project' }));

    const bands = screen.getAllByTestId('plan-approve-timed-out');
    expect(bands).toHaveLength(1);
    expect(bands[0]!.getAttribute('data-place')).toBe('rail');
    expect(bands[0]!.getAttribute('role')).toBe('alert');
    expect(screen.queryByTestId('plan-approve-progress')).toBeNull();
    // Deciding again is safe, so both verbs are back.
    expect(barVerb()).toBeTruthy();
    expect(railVerb()).toBeTruthy();
  });
});
