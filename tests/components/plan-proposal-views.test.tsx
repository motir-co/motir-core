// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import { PLAN_STALLED_AFTER_MS, type PlanProgressSnapshot } from '@/lib/plans/planProgress';

// MOTIR-6185 — `PlanProposalViews`, the plan page's List | Canvas pane lifted into
// ONE component two hosts mount.
//
// What is pinned HERE is the component's OWN contract, and nothing else:
//   * which body renders for a given `view`, and that it is never both;
//   * that it is CONTROLLED — a press reports and changes nothing by itself,
//     which is the property that lets the plan page keep the view in the URL and
//     the planning surface keep it local (Part XXI decision 3);
//   * that `band` renders BETWEEN the header and the body (Part VIII §2);
//   * that `outcome` reaches both bodies (MOTIR-3161's three-valued decision).
//
// The plan page's own wiring — the URL binding, the pinned default, the establish
// band's predicate — stays asserted by `plan-detail-view-switch.test.tsx`, which
// this lift leaves unmodified on purpose: it is the regression net for the move.

// Both bodies are stubbed. This file is about the PANE, and a real
// `PlanReviewCanvas` would drag its level read in — the same `vi.mock` of the same
// module path `plan-detail-view-switch.test.tsx` already uses, which is why the
// lift kept both imports on their original module paths.
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: ({
    outcome,
    ariaLabel,
    live,
    liveSteps,
    movingSteps,
  }: {
    outcome: string | null;
    ariaLabel: string;
    live?: boolean;
    liveSteps?: readonly { targetNodeId: string | null }[] | null;
    movingSteps?: readonly { targetNodeId: string | null }[] | null;
  }) => (
    <div
      data-testid="plan-review-canvas"
      data-outcome={outcome ?? 'none'}
      data-live={String(live ?? false)}
      // What the cue layer is handed (MOTIR-7830): the live steps' targets.
      data-cue-targets={(liveSteps ?? []).map((st) => st.targetNodeId ?? '-').join(',')}
      // …and which of them may MOVE (MOTIR-8416): `readPlanAtWork`'s steps.
      data-moving-targets={(movingSteps ?? []).map((st) => st.targetNodeId ?? '-').join(',')}
      aria-label={ariaLabel}
    />
  ),
}));

vi.mock('@/components/planning/PlanProposalList', () => ({
  PlanProposalList: ({ outcome, items }: { outcome: string | null; items: unknown[] }) => (
    <div
      data-testid="plan-proposal-list"
      data-outcome={outcome ?? 'none'}
      data-count={items.length}
    />
  ),
}));

import { PlanProposalViews } from '@/components/planning/PlanProposalViews';

const items = [{ planItemId: 'pi_1' }, { planItemId: 'pi_2' }] as unknown as PlanReviewItemDto[];

function mount(over: Partial<Parameters<typeof PlanProposalViews>[0]> = {}) {
  const onViewChange = vi.fn();
  const result = renderWithIntl(
    <PlanProposalViews
      items={items}
      outcome={null}
      projectKey="MOTIR"
      version={0}
      ariaLabel="Proposed plan"
      view="canvas"
      onViewChange={onViewChange}
      {...over}
    />,
  );
  return { ...result, onViewChange };
}

afterEach(() => cleanup());

describe('PlanProposalViews', () => {
  it('renders the switch and the canvas body, and not the list', () => {
    mount({ view: 'canvas' });

    expect(screen.getByTestId('plan-proposal-views')).toBeTruthy();
    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();
    expect(screen.queryByTestId('plan-proposal-list')).toBeNull();
  });

  it('renders the list body for the list view, and not the canvas', () => {
    mount({ view: 'list' });

    expect(screen.getByTestId('plan-proposal-list')).toBeTruthy();
    expect(screen.queryByTestId('plan-review-canvas')).toBeNull();
  });

  it('carries the plan pages own accessible group name on the switch', () => {
    mount();

    // The catalogue string, not a literal this test owns — the lift introduces no
    // new key, and `planReview.viewSwitchAria` is the one the page already used.
    const group = screen.getByRole('group', { name: 'Plan view' });
    expect(group).toBeTruthy();
    expect(screen.getByRole('button', { name: /List/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /Canvas/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('is CONTROLLED: a press reports the next view and changes no body by itself', () => {
    const { onViewChange } = mount({ view: 'canvas' });

    fireEvent.click(screen.getByRole('button', { name: /List/ }));

    expect(onViewChange).toHaveBeenCalledTimes(1);
    expect(onViewChange).toHaveBeenCalledWith('list');
    // The body did NOT move: the host owns the view. This is the property that
    // lets one component serve a host that keeps the view in the URL and a host
    // that keeps it in local state.
    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();
    expect(screen.queryByTestId('plan-proposal-list')).toBeNull();
  });

  it('renders `band` between the header and the body', () => {
    mount({ view: 'list', band: <div data-testid="a-band" /> });

    const root = screen.getByTestId('plan-proposal-views');
    const children = [...root.children];
    const header = children.findIndex((el) => el.querySelector('[role="group"]') !== null);
    const band = children.findIndex((el) => el.matches('[data-testid="a-band"]'));
    const body = children.findIndex((el) =>
      el.querySelector('[data-testid]') === null
        ? false
        : el.querySelector('[data-testid="plan-proposal-list"]') !== null,
    );

    expect(header).toBeGreaterThanOrEqual(0);
    expect(band).toBe(header + 1);
    expect(body).toBe(band + 1);
  });

  it('renders no band slot when none is given', () => {
    mount({ view: 'list' });

    const root = screen.getByTestId('plan-proposal-views');
    // header + body only.
    expect(root.children.length).toBe(2);
  });

  it.each(['accepted', 'declined'] as const)('passes outcome %s to the list body', (outcome) => {
    mount({ view: 'list', outcome });

    expect(screen.getByTestId('plan-proposal-list').getAttribute('data-outcome')).toBe(outcome);
  });

  it.each(['accepted', 'declined'] as const)('passes outcome %s to the canvas body', (outcome) => {
    mount({ view: 'canvas', outcome });

    expect(screen.getByTestId('plan-review-canvas').getAttribute('data-outcome')).toBe(outcome);
  });

  // ── `preserveCanvasLevel` — the surface's opt-in (MOTIR-6186, Part XXI 21.7) ──
  //
  // The drilled level lives in the canvas's own state, so the only way it can
  // survive Canvas → List → Canvas is for the canvas never to unmount. The plan
  // page must NOT get this: its own suite asserts the canvas is absent under List,
  // and the lift exists not to change that page.

  it('keeps the canvas mounted, hidden and inert under List when asked to', () => {
    mount({ view: 'list', preserveCanvasLevel: true });

    const keepalive = screen.getByTestId('plan-review-canvas-keepalive');
    expect(within(keepalive).getByTestId('plan-review-canvas')).toBeTruthy();
    expect(keepalive.className).toContain('invisible');
    expect(keepalive.className).toContain('pointer-events-none');
    // `inert` is what takes it out of the tab order and the accessibility tree —
    // `invisible` alone would leave a keyboard user able to land inside a canvas
    // they cannot see.
    expect(keepalive.hasAttribute('inert')).toBe(true);
    expect(keepalive.getAttribute('aria-hidden')).toBe('true');
    // The list is the visible body.
    expect(screen.getByTestId('plan-proposal-list')).toBeTruthy();
  });

  it('shows that same canvas plainly on Canvas — not hidden, not inert', () => {
    mount({ view: 'canvas', preserveCanvasLevel: true });

    const keepalive = screen.getByTestId('plan-review-canvas-keepalive');
    expect(keepalive.className).not.toContain('invisible');
    expect(keepalive.hasAttribute('inert')).toBe(false);
    expect(keepalive.hasAttribute('aria-hidden')).toBe(false);
  });

  it('⭐ does NOT keep it mounted by default — the plan page is unchanged', () => {
    // The property `tests/components/plan-detail-view-switch.test.tsx` asserts,
    // stated here from the component's side so the default cannot drift on.
    mount({ view: 'list' });

    expect(screen.queryByTestId('plan-review-canvas')).toBeNull();
    expect(screen.queryByTestId('plan-review-canvas-keepalive')).toBeNull();
  });

  it('hands the items and the canvas aria-label straight through', () => {
    mount({ view: 'list' });
    expect(screen.getByTestId('plan-proposal-list').getAttribute('data-count')).toBe('2');

    cleanup();

    mount({ view: 'canvas', ariaLabel: 'The proposed plan' });
    expect(screen.getByTestId('plan-review-canvas').getAttribute('aria-label')).toBe(
      'The proposed plan',
    );
  });
});

// MOTIR-6300 — `live` is OPT-IN, and the plan page never opts in: without it the
// pane renders exactly what it did before the live pane existed.
describe('PlanProposalViews — live is off by default (the plan page is unchanged)', () => {
  it('renders no live marker, no announcement region and no discarded band, and a still canvas', () => {
    mount();
    expect(screen.queryByTestId('plan-live-state')).toBeNull();
    expect(screen.queryByTestId('plan-live-announce')).toBeNull();
    expect(screen.queryByTestId('plan-live-discarded')).toBeNull();
    expect(screen.getByTestId('plan-review-canvas').getAttribute('data-live')).toBe('false');
  });

  it('live threads to the canvas and draws the marker; a host band wins the band slot', () => {
    mount({ live: true, discarded: true, band: <p data-testid="host-band" /> });
    expect(screen.getByTestId('plan-review-canvas').getAttribute('data-live')).toBe('true');
    expect(screen.getByTestId('plan-live-state').textContent).toBe('Being written');
    expect(screen.getByTestId('host-band')).toBeTruthy();
    expect(screen.queryByTestId('plan-live-discarded')).toBeNull();
  });
});

// MOTIR-7829 — the PROGRESS LINE in the pane header (design Part XXVI §26.2). It
// renders on `progress`, never on `live`: the plan page passes no `live` and
// must still show the plan being written.
describe('PlanProposalViews — the progress line', () => {
  const T0 = Date.parse('2026-10-08T14:00:00.000Z');
  const progress: PlanProgressSnapshot = {
    startedAt: new Date(T0 - 4 * 60_000).toISOString(),
    lastActivityAt: new Date(T0 - 10_000).toISOString(),
    observedAt: new Date(T0).toISOString(),
    authored: 1,
    proposed: 5,
    autoResume: null,
    steps: [
      {
        sessionKey: 's1',
        kind: 'author',
        phrase: 'authoring',
        targetRef: 'planItem:pi_1',
        targetNodeId: 'pi_1',
        targetTitle: 'Invoice export',
        startedAt: new Date(T0 - 60_000).toISOString(),
        providerWait: null,
      },
    ],
  };

  it('renders the line in the HEADER with live={false} (the plan page)', () => {
    mount({ progress });
    const header = screen.getByRole('group', { name: 'Plan view' }).parentElement!;
    expect(within(header).getByTestId('plan-progress')).toBeTruthy();
    expect(within(header).getByTestId('plan-progress-steps').textContent).toBe(
      'Authoring: Invoice export',
    );
    expect(within(header).getByTestId('plan-progress-pointer')).toBeTruthy();
    // The marker comes with the line — its word carries the state (§26.1).
    expect(within(header).getByTestId('plan-live-state').textContent).toBe('Being written');
    // The canvas stays still: the motion layer is `live`'s, not `progress`'s.
    expect(screen.getByTestId('plan-review-canvas').getAttribute('data-live')).toBe('false');
    expect(screen.queryByTestId('plan-live-announce')).toBeNull();
  });

  it('renders no line when progress is null (the hand-over), and the switcher is unchanged', () => {
    mount({ progress: null });
    expect(screen.queryByTestId('plan-progress')).toBeNull();
    expect(screen.queryByTestId('plan-progress-pointer')).toBeNull();
    expect(screen.queryByTestId('plan-live-state')).toBeNull();
    expect(screen.getByRole('group', { name: 'Plan view' })).toBeTruthy();
  });

  it('with live and progress, ONE marker in the shipped slot — same testid, role and word', () => {
    mount({ live: true, progress });
    const markers = screen.getAllByTestId('plan-live-state');
    expect(markers).toHaveLength(1);
    expect(markers[0]!.getAttribute('role')).toBe('status');
    expect(markers[0]!.className).toContain('ml-auto');
    expect(markers[0]!.textContent).toBe('Being written');
    expect(screen.getByTestId('plan-live-announce')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Canvas/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('progressFailing turns the marker to Reconnecting', () => {
    mount({ live: true, progress, progressFailing: true });
    expect(screen.getByTestId('plan-live-state').textContent).toBe(
      'Reconnecting — showing the last update',
    );
  });

  it('live without progress keeps the shipped marker exactly as before', () => {
    mount({ live: true, liveFailing: true });
    expect(screen.getByTestId('plan-live-state').textContent).toBe(
      'Reconnecting — showing the last update',
    );
    expect(screen.queryByTestId('plan-progress')).toBeNull();
  });
});

// MOTIR-7830 — the canvas cues read the SAME clock as the line: `PlanProposalViews`
// hands `PlanReviewCanvas` the hook's `liveSteps`, on `progress`, never on `live`.
describe('PlanProposalViews — the canvas cues read the one clock', () => {
  const T0 = Date.parse('2026-10-08T14:00:00.000Z');
  const progress: PlanProgressSnapshot = {
    startedAt: new Date(T0 - 20 * 60_000).toISOString(),
    lastActivityAt: new Date(T0 - 14 * 60_000).toISOString(),
    observedAt: new Date(T0).toISOString(),
    authored: 1,
    proposed: 2,
    autoResume: null,
    steps: [
      {
        sessionKey: 's1',
        kind: 'author',
        phrase: 'authoring',
        targetRef: 'planItem:pi_1',
        targetNodeId: 'pi_1',
        targetTitle: 'Invoice export',
        startedAt: new Date(T0 - 14 * 60_000).toISOString(),
        providerWait: null,
      },
    ],
  };
  const targets = () => screen.getByTestId('plan-review-canvas').getAttribute('data-cue-targets');

  afterEach(() => {
    vi.useRealTimers();
  });

  it('with live={false} (the plan page) the canvas is handed the drafting step', () => {
    mount({ progress });
    expect(targets()).toBe('pi_1');
  });

  // The STALLED HOLD (Story MOTIR-8413 · MOTIR-8416; `design/ai-chat/design-notes.md`
  // § _Motir at work_, the States table) replaced "every cue leaves": the card last
  // being written keeps its cue, static — it stops MOVING but does not vanish.
  it('past PLAN_STALLED_AFTER_MS with no new snapshot the last cue HOLDS, still', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(T0);
    mount({ progress });
    expect(targets()).toBe('pi_1');
    const moving = () =>
      screen.getByTestId('plan-review-canvas').getAttribute('data-moving-targets');
    expect(moving()).toBe('pi_1');
    act(() => {
      vi.advanceTimersByTime(PLAN_STALLED_AFTER_MS);
    });
    expect(targets()).toBe('pi_1');
    expect(moving()).toBe('');
    expect(screen.getByTestId('plan-live-state').textContent).toBe('Stalled');
  });

  it('with progressFailing the same advance HOLDS the cues', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(T0);
    mount({ progress, progressFailing: true });
    act(() => {
      vi.advanceTimersByTime(PLAN_STALLED_AFTER_MS);
    });
    expect(targets()).toBe('pi_1');
  });

  it('progress: null (the hand-over) removes every cue and leaves the canvas and the live marker as they were', () => {
    const { rerender } = mount({ live: true, progress });
    expect(targets()).toBe('pi_1');
    rerender(
      <PlanProposalViews
        items={items}
        outcome={null}
        projectKey="MOTIR"
        version={0}
        ariaLabel="Proposed plan"
        view="canvas"
        onViewChange={() => {}}
        live
        progress={null}
      />,
    );
    expect(targets()).toBe('');
    expect(screen.getByTestId('plan-review-canvas').getAttribute('data-live')).toBe('true');
    expect(screen.getByTestId('plan-live-state').textContent).toBe('Being written');
    expect(screen.queryByTestId('plan-progress')).toBeNull();
  });
});
