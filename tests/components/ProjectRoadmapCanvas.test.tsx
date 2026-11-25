// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { fireEvent } from '@testing-library/dom';
import {
  ProjectRoadmapCanvas,
  type CanvasTargetAction,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import type { ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import {
  DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY,
  resetDependencyLegendCollapsedForTests,
} from '@/lib/hooks/useDependencyLegendCollapsed';

afterEach(() => cleanup());

function node(id: string, label: string, drillable = false): ProjectCanvasNode {
  return {
    id,
    parentId: null,
    searchText: label,
    crumbLabel: id,
    drillable,
    content: <div>{label}</div>,
  };
}

// A 2-level tree served per level: root → [E1 (drillable), E2]; E1 → [S1, S2].
const levels: Record<string, RoadmapLevel> = {
  __root__: { nodes: [node('E1', 'Epic one', true), node('E2', 'Epic two')], deps: [] },
  E1: { nodes: [node('S1', 'Story one'), node('S2', 'Story two')], deps: [] },
  // A THIRD level (MOTIR-6161): the follow-move has to be able to ask for a level
  // that is neither where the reader is nor the root, which two levels cannot
  // express. `S1` is not drillable, so nothing reaches this level by hand and no
  // existing test's behaviour changes — `loadLevel` is only called for a FOCUSED
  // id, and only the follow tests focus this one.
  S1: { nodes: [node('T1', 'Subtask one'), node('T2', 'Subtask two')], deps: [] },
};
const loadLevel = (parentId: string | null): Promise<RoadmapLevel> =>
  Promise.resolve(levels[parentId ?? '__root__'] ?? { nodes: [], deps: [] });

function el(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

// Asserting a mock in this file: an EVENT-HANDLER callback (`onSelect`, `onView`,
// the "Reset layout" click → `onResetPositions`, `requestFullscreen`) is invoked
// SYNCHRONOUSLY inside the dispatched handler, so a plain `expect(mock)` right
// after `fireEvent` is deterministic and needs no wait. An EFFECT-driven callback
// (the auto-reset below) is NOT — it must be awaited via `waitFor`. See the note
// on that test.
describe('ProjectRoadmapCanvas', () => {
  it('renders the root level, bare (no breadcrumb / search) by default', async () => {
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} />);
    expect(await screen.findByText('Epic one')).toBeTruthy();
    expect(el('E2')).toBeTruthy();
    expect(el('S1')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('drills into a node (fetching its level), shows the breadcrumb, and Back returns', async () => {
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" />);
    await screen.findByText('Epic one');
    // A click SELECTS (no drill); the explicit "Open" affordance drills.
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });
    expect(el('S1')).toBeNull(); // still on the root level
    fireEvent.click(await screen.findByTestId('drill-button'));
    expect(await screen.findByText('Story one')).toBeTruthy();
    expect(el('S2')).toBeTruthy();
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByText('E1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Epic one')).toBeTruthy();
    expect(el('S1')).toBeNull();
  });

  it('calls onSelect for a LEAF node instead of drilling', async () => {
    const onSelect = vi.fn();
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} onSelect={onSelect} />);
    await screen.findByText('Epic two');
    fireEvent.keyDown(el('E2')!, { key: 'Enter' }); // E2 is not drillable
    expect(onSelect).toHaveBeenCalledWith('E2');
  });

  it('selecting a node highlights it + its connections and dims the rest', async () => {
    const level: RoadmapLevel = {
      nodes: [node('A', 'a'), node('B', 'b'), node('C', 'c')],
      deps: [{ from: 'A', to: 'B', variant: 'firm' }], // A↔B connected; C unrelated
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} />);
    await screen.findByText('a');
    fireEvent.keyDown(el('A')!, { key: 'Enter' });
    expect(el('A')!.querySelector('[data-selected]')).toBeTruthy(); // A is the selection
    expect(el('B')!.firstElementChild!.className).not.toContain('opacity-35'); // dependency stays lit
    expect(el('C')!.firstElementChild!.className).toContain('opacity-35'); // unrelated dims
  });

  it('offers Reset layout when ANY node is hand-moved (incl. a fixed-position station), resets only those', async () => {
    const onResetPositions = vi.fn();
    // A is auto-laid; S is a FIXED-position node (explicit x/y, like a root station).
    const level: RoadmapLevel = {
      nodes: [node('A', 'a'), { ...node('S', 's'), x: 5, y: 5 }],
      deps: [],
    };
    // nothing arranged → no reset affordance
    const { rerender } = render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(level)}
        onResetPositions={onResetPositions}
      />,
    );
    await screen.findByText('a');
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();
    // a saved position for the STATION (fixed-position) node → the button still
    // appears (so the root "Your project" canvas gets it), and resets only S.
    rerender(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(level)}
        positions={{ S: { x: 90, y: 90 } }}
        onResetPositions={onResetPositions}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Reset layout' }));
    expect(onResetPositions).toHaveBeenCalledWith(['S']); // only the arranged node
  });

  // `onResetPositions` is fired from the AUTO-RESET *passive effect*, not from the
  // render — so a rendered node is the WRONG signal to assert it on. React flushes
  // passive effects on a scheduler callback AFTER commit, and RTL's async wrapper
  // turns the act environment OFF for `findBy*` and drains with a bare
  // `setTimeout(0)`; under CI load that macrotask can win the race against the
  // scheduler, so `findByText('c')` resolves with the effect still pending and a
  // plain `expect(mock)` samples 0 calls. Wait on the callback itself — the
  // authoritative signal (the coding convention § E2E tests wait on the AUTHORITATIVE signal /
  // notes.html #37, at the component altitude). This is MOTIR-1736.
  it('auto-resets a level when its auto-laid node set changes (a re-plan)', async () => {
    const onResetPositions = vi.fn();
    let levelNodes = [node('A', 'a'), node('B', 'b')];
    const load = () => Promise.resolve({ nodes: levelNodes, deps: [] });
    const { rerender } = render(
      <ProjectRoadmapCanvas loadLevel={load} onResetPositions={onResetPositions} reloadKey="1" />,
    );
    await screen.findByText('a');
    // Flush the pending effect pass BEFORE the negative assertion — otherwise it
    // races the same way and would pass vacuously (green even if the component
    // wrongly reset on first load).
    await act(async () => {});
    expect(onResetPositions).not.toHaveBeenCalled(); // first render: no prior signature
    // the level's items change → bump reloadKey to refetch
    levelNodes = [node('A', 'a'), node('C', 'c')];
    rerender(
      <ProjectRoadmapCanvas loadLevel={load} onResetPositions={onResetPositions} reloadKey="2" />,
    );
    await screen.findByText('c');
    await waitFor(() =>
      expect(onResetPositions).toHaveBeenCalledWith(expect.arrayContaining(['A', 'C'])),
    );
  });

  it('search-to-focus highlights a match in the current level', async () => {
    render(
      <ProjectRoadmapCanvas loadLevel={loadLevel} searchable searchLabel="Search the roadmap" />,
    );
    await screen.findByText('Epic one');
    fireEvent.change(screen.getByPlaceholderText('Search the roadmap'), {
      target: { value: 'Epic two' },
    });
    expect(el('E2')!.querySelector('[data-highlighted]')).toBeTruthy();
    expect(el('E1')!.querySelector('[data-highlighted]')).toBeNull();
  });

  it('draws a cross-parent edge from the level deps — one warning path, no midpoint chip (MOTIR-12158)', async () => {
    const crossLevel: RoadmapLevel = {
      nodes: [
        { ...node('A', 'a'), parentId: 'P1' },
        { ...node('B', 'b'), parentId: 'P2' },
      ],
      deps: [{ from: 'A', to: 'B', variant: 'cross' }],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(crossLevel)} />);
    await screen.findByText('a');
    const paths = screen.getByTestId('canvas-edges').querySelectorAll('path');
    expect(paths).toHaveLength(1);
    expect(paths[0]!.getAttribute('class')).toContain('stroke-(--el-warning)');
    // The blocked card owns the fact on its own tab; the edge carries no chip.
    expect(screen.queryByTestId('cross-flag')).toBeNull();
  });

  it('fans the top entries of a TABBED card right of its tab, not only the here card (MOTIR-12158)', async () => {
    // A card wearing the blocked tab (or a decided outcome tab) is flagged
    // `topTab` by its level builder; the canvas must honour it exactly as it
    // honours `here`, so no arrowhead lands under the tab.
    const fanIn = (topTab: boolean): RoadmapLevel => ({
      // Explicit positions (the auto-layout would lay them in a row): two blockers
      // stacked above the dependent, so both arrows enter its TOP side.
      nodes: [
        { ...node('A', 'a'), x: 0, y: 0 },
        { ...node('B', 'b'), x: 100, y: 0 },
        { ...node('C', 'c'), x: 0, y: 400, ...(topTab ? { topTab } : {}) },
      ],
      deps: [
        { from: 'A', to: 'C', variant: 'firm' },
        { from: 'B', to: 'C', variant: 'firm' },
      ],
    });
    const ds = () =>
      [...screen.getByTestId('canvas-edges').querySelectorAll('path')].map((p) =>
        p.getAttribute('d'),
      );
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(fanIn(false))} />);
    await screen.findByText('c');
    const plain = ds();
    cleanup();
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(fanIn(true))} />);
    await screen.findByText('c');
    const tabbed = ds();
    expect(tabbed).toHaveLength(2);
    expect(tabbed).not.toEqual(plain);
  });

  it('shows the edge legend when the level has dependency edges', async () => {
    const withDeps: RoadmapLevel = {
      nodes: [node('A', 'a'), node('B', 'b')],
      deps: [{ from: 'A', to: 'B', variant: 'firm' }],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(withDeps)} />);
    await screen.findByText('a');
    const legend = screen.getByTestId('edge-legend');
    expect(within(legend).getByText('Dependencies')).toBeTruthy();
    expect(within(legend).getByText('blocks')).toBeTruthy();
    expect(within(legend).getByText('pending')).toBeTruthy();
    expect(within(legend).getByText('blocked elsewhere')).toBeTruthy();
    // The row carries a static specimen of the blocked TAB (MOTIR-12158), so the
    // red tab on a card and the orange edge read as one fact. Decorative only.
    const specimen = within(legend).getByTestId('legend-blocked-tab');
    expect(specimen.getAttribute('aria-hidden')).toBe('true');
    expect(specimen.textContent).toBe('blocked');
    expect(specimen.className).toContain('bg-(--el-danger)');
    expect(specimen.className).toContain('text-(--el-danger-text)');
    // One specimen, on the warning row only.
    expect(within(legend).getAllByTestId('legend-blocked-tab')).toHaveLength(1);
  });

  it('hides the legend when there are no edges', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve({ nodes: [node('A', 'a')], deps: [] })}
      />,
    );
    await screen.findByText('a');
    expect(screen.queryByTestId('edge-legend')).toBeNull();
  });

  it('hides the legend when the only edges are `flow` (sequence, not dependency)', async () => {
    // The onboarding station serpentine is drawn but is NOT a blocked-by chain, so
    // it must not surface the "Dependencies" legend.
    const flowOnly: RoadmapLevel = {
      nodes: [node('A', 'a'), node('B', 'b')],
      deps: [{ from: 'A', to: 'B', variant: 'firm', kind: 'flow' }],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(flowOnly)} />);
    await screen.findByText('a');
    expect(screen.queryByTestId('edge-legend')).toBeNull();
  });

  it('shows the empty state when a level has no nodes', async () => {
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve({ nodes: [], deps: [] })} />);
    expect(await screen.findByText('Nothing on the roadmap yet')).toBeTruthy();
  });

  // The quick-view "View" affordance (Subtask 7.20.11 / MOTIR-1352) — surfaced on
  // the SELECTED card for a `viewable` node when an `onView` handler is wired.
  // Distinct from select (highlight) and from "Open" (drill).
  it('surfaces a View button on a selected viewable node and calls onView with its id', async () => {
    const onView = vi.fn();
    const level: RoadmapLevel = {
      nodes: [{ ...node('V', 'View me'), viewable: true }],
      deps: [],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} onView={onView} />);
    await screen.findByText('View me');
    // Not shown until the card is selected.
    expect(screen.queryByTestId('view-button')).toBeNull();
    fireEvent.keyDown(el('V')!, { key: 'Enter' });
    const view = await screen.findByTestId('view-button');
    expect(view.getAttribute('aria-label')).toBe('View V'); // labelled by identifier
    fireEvent.click(view);
    expect(onView).toHaveBeenCalledWith('V');
  });

  // MOTIR-8648 — the action buttons render INSIDE the card's focusable wrapper, so
  // a key pressed on a focused button bubbles to the wrapper's own Enter/Space
  // handler. That handler used to `preventDefault()` it, which cancels the click
  // the browser synthesizes for a button, and re-activate the card instead. A
  // `false` from `fireEvent.keyDown` is exactly that cancellation, which happy-dom
  // reports even though it does not synthesize the click itself.
  it.each(['Enter', ' '])(
    'a %j keydown on a focused action button reaches the button, not the card',
    async (key) => {
      const onView = vi.fn();
      const onSelect = vi.fn();
      const level: RoadmapLevel = {
        nodes: [{ ...node('D', 'Drill me', true), viewable: true }],
        deps: [],
      };
      render(
        <ProjectRoadmapCanvas
          loadLevel={() => Promise.resolve(level)}
          onView={onView}
          onSelect={onSelect}
        />,
      );
      await screen.findByText('Drill me');
      fireEvent.keyDown(el('D')!, { key: 'Enter' });
      expect(onSelect).toHaveBeenCalledTimes(1);
      for (const testId of ['view-button', 'drill-button']) {
        const button = await screen.findByTestId(testId);
        button.focus();
        // Not cancelled: the browser goes on to click the button.
        expect(fireEvent.keyDown(button, { key })).toBe(true);
      }
      // And the card was not re-activated underneath the button.
      expect(onSelect).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId('view-button'));
      expect(onView).toHaveBeenCalledWith('D');
    },
  );

  it('surfaces BOTH View and Open on a selected drillable viewable node (View distinct from drill)', async () => {
    const onView = vi.fn();
    const level: RoadmapLevel = {
      nodes: [{ ...node('D', 'Drill me', true), viewable: true }],
      deps: [],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} onView={onView} />);
    await screen.findByText('Drill me');
    fireEvent.keyDown(el('D')!, { key: 'Enter' });
    expect(await screen.findByTestId('view-button')).toBeTruthy();
    expect(screen.getByTestId('drill-button')).toBeTruthy();
  });

  it('shows NO View button on a non-viewable node (e.g. an off-level ghost anchor)', async () => {
    const onView = vi.fn();
    // `node()` omits `viewable` → not viewable.
    const level: RoadmapLevel = { nodes: [node('G', 'ghost')], deps: [] };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} onView={onView} />);
    await screen.findByText('ghost');
    fireEvent.keyDown(el('G')!, { key: 'Enter' });
    expect(screen.queryByTestId('view-button')).toBeNull();
  });

  it('shows NO View button when onView is not wired, even for a viewable node', async () => {
    const level: RoadmapLevel = {
      nodes: [{ ...node('V', 'View me'), viewable: true }],
      deps: [],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} />);
    await screen.findByText('View me');
    fireEvent.keyDown(el('V')!, { key: 'Enter' });
    expect(screen.queryByTestId('view-button')).toBeNull();
  });

  // The PLANNING-TARGET action (MOTIR-6898; design
  // `target-picker--search-and-canvas.mock.html` panel 6) — opt-in, between View
  // and Open on the selected card, absent on every other consumer.
  describe('the planning-target action (targetAction)', () => {
    function action(overrides: Partial<CanvasTargetAction> = {}): CanvasTargetAction {
      return {
        isEligible: (id) => id !== 'F',
        isTarget: () => false,
        keyFor: (id) => `MOTIR-${id}`,
        canAdd: true,
        disabledReason: 'You can plan around up to 20 work items at once.',
        onToggle: vi.fn<(id: string) => void>(),
        ...overrides,
      };
    }
    const level: RoadmapLevel = {
      nodes: [
        { ...node('D', 'Drill me', true), viewable: true },
        { ...node('L', 'Leaf me'), viewable: true },
        node('F', 'A folder tile', true),
      ],
      deps: [],
    };
    const select = (id: string) => fireEvent.keyDown(el(id)!, { key: 'Enter' });
    const actionLabels = () =>
      Array.from(el('D')?.parentElement?.querySelectorAll('button') ?? []).map(
        (b) => b.textContent,
      );

    it('WITHOUT the prop the selected card offers exactly View and Open — every other consumer', async () => {
      render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} onView={vi.fn()} />);
      await screen.findByText('Drill me');
      select('D');

      await screen.findByTestId('view-button');
      expect(screen.queryByTestId('target-toggle-button')).toBeNull();
      expect(actionLabels()).toEqual(['View', 'Open']);
    });

    it('sits BETWEEN View and Open, and calls onToggle with the card id', async () => {
      const a = action();
      render(
        <ProjectRoadmapCanvas
          loadLevel={() => Promise.resolve(level)}
          onView={vi.fn()}
          targetAction={a}
        />,
      );
      await screen.findByText('Drill me');
      select('D');

      const button = await screen.findByTestId('target-toggle-button');
      expect(actionLabels()).toEqual(['View', 'Set as target', 'Open']);
      expect(button.getAttribute('aria-label')).toBe('Set MOTIR-D as the planning target');
      expect(button.getAttribute('aria-pressed')).toBe('false');
      // Pressing it does not start a canvas drag or drop the selection — the
      // press stops at the button, like View's and Open's.
      fireEvent.pointerDown(button);
      expect(screen.getByTestId('target-toggle-button')).toBe(button);
      fireEvent.click(button);
      expect(a.onToggle).toHaveBeenCalledWith('D');
    });

    it('reads REMOVE TARGET on a card that already is one — never disabled, even at the cap', async () => {
      const a = action({ isTarget: (id) => id === 'L', canAdd: false });
      render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} targetAction={a} />);
      await screen.findByText('Leaf me');
      select('L');

      const button = await screen.findByTestId('target-toggle-button');
      expect(button.textContent).toBe('Remove target');
      expect(button.getAttribute('aria-label')).toBe('Remove MOTIR-L from the planning targets');
      expect((button as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(button);
      expect(a.onToggle).toHaveBeenCalledWith('L');
    });

    it('at the CAP, Set is disabled with the reason', async () => {
      const a = action({ canAdd: false });
      render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} targetAction={a} />);
      await screen.findByText('Leaf me');
      select('L');

      const button = (await screen.findByTestId('target-toggle-button')) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe('You can plan around up to 20 work items at once.');
    });

    it('an INELIGIBLE node (a folder tile, a proposal) gets no target action', async () => {
      render(
        <ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} targetAction={action()} />,
      );
      await screen.findByText('A folder tile');
      select('F');

      await screen.findByTestId('drill-button');
      expect(screen.queryByTestId('target-toggle-button')).toBeNull();
    });

    it('does not move the canvas: the level and the selection stay', async () => {
      render(
        <ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} targetAction={action()} />,
      );
      await screen.findByText('Drill me');
      select('D');
      fireEvent.click(await screen.findByTestId('target-toggle-button'));

      expect(screen.getByText('Drill me')).toBeTruthy();
      // Still selected: its action slot (and so the flipped button) is still up.
      expect(screen.getByTestId('target-toggle-button')).toBeTruthy();
      expect(screen.getByTestId('drill-button')).toBeTruthy();
    });
  });

  // FULL-SCREEN mode (MOTIR-1420) — opt-in via `fullScreenable`.
  it('does not offer the full-screen toggle by default', async () => {
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} />);
    await screen.findByText('Epic one');
    expect(screen.queryByTestId('fullscreen-toggle')).toBeNull();
  });

  it('expands to full screen (best-effort Fullscreen API + overlay), shows the ESC hint, and ESC exits', async () => {
    // happy-dom has no Fullscreen API — stub the request so the best-effort call is
    // observable; the overlay (data-fullscreen + state) works regardless.
    const requestFs = vi.fn().mockResolvedValue(undefined);
    (Element.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = requestFs;
    try {
      render(<ProjectRoadmapCanvas loadLevel={loadLevel} fullScreenable />);
      await screen.findByText('Epic one');
      const toggle = screen.getByTestId('fullscreen-toggle');
      const canvas = screen.getByTestId('roadmap-canvas');
      expect(toggle.getAttribute('aria-label')).toBe('Enter full screen');
      expect(screen.queryByTestId('fullscreen-hint')).toBeNull();
      expect(canvas.hasAttribute('data-fullscreen')).toBe(false);

      fireEvent.click(toggle);
      expect(requestFs).toHaveBeenCalled(); // Fullscreen API attempted
      expect(toggle.getAttribute('aria-label')).toBe('Exit full screen');
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(canvas.getAttribute('data-fullscreen')).toBe('true');
      expect(canvas.className).toContain('fixed');
      expect(screen.getByTestId('fullscreen-hint')).toBeTruthy();

      // ESC exits (the overlay-path keydown handler).
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(toggle.getAttribute('aria-label')).toBe('Enter full screen');
      expect(screen.queryByTestId('fullscreen-hint')).toBeNull();
      expect(canvas.hasAttribute('data-fullscreen')).toBe(false);
    } finally {
      delete (Element.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
    }
  });

  it('the Exit button collapses full screen', async () => {
    (Element.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = vi
      .fn()
      .mockResolvedValue(undefined);
    try {
      render(<ProjectRoadmapCanvas loadLevel={loadLevel} fullScreenable />);
      await screen.findByText('Epic one');
      const toggle = screen.getByTestId('fullscreen-toggle');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-label')).toBe('Exit full screen');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-label')).toBe('Enter full screen');
      expect(screen.getByTestId('roadmap-canvas').hasAttribute('data-fullscreen')).toBe(false);
    } finally {
      delete (Element.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
    }
  });

  // LOCATE control (MOTIR-1421) — opt-in via `locatable`. The located node lights up
  // via the same `data-highlighted` treatment the search-locate uses, so the test
  // asserts which node carries it.
  function hl(id: string) {
    return el(id)!.querySelector('[data-highlighted]');
  }
  function sel(id: string) {
    return el(id)!.querySelector('[data-selected]');
  }

  it('does not offer the locate control by default', async () => {
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} />);
    await screen.findByText('Epic one');
    expect(screen.queryByTestId('locate-button')).toBeNull();
  });

  it('locates the "you are here" frontier first — single target, no cycling hint', async () => {
    const level: RoadmapLevel = {
      nodes: [
        { ...node('A', 'a'), here: true },
        { ...node('B', 'b'), ready: true },
      ],
      deps: [],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} locatable />);
    await screen.findByText('a');
    const btn = screen.getByTestId('locate-button');
    expect(btn.getAttribute('aria-label')).toBe('Locate the current item');
    fireEvent.click(btn);
    expect(hl('A')).toBeTruthy(); // the frontier is centred, not the ready node
    expect(hl('B')).toBeNull();
    expect(sel('A')).toBeTruthy(); // ...and SELECTED, so its actions surface
    expect(sel('B')).toBeNull();
    expect(screen.queryByTestId('locate-hint')).toBeNull();
  });

  it('cycles the ready nodes with wrap when there is no frontier, showing the n/m hint', async () => {
    const level: RoadmapLevel = {
      nodes: [
        { ...node('R1', 'r1'), ready: true },
        { ...node('R2', 'r2'), ready: true },
        { ...node('R3', 'r3'), ready: true },
      ],
      deps: [],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} locatable />);
    await screen.findByText('r1');
    const btn = screen.getByTestId('locate-button');
    expect(btn.getAttribute('aria-label')).toBe('Locate the next ready item');
    fireEvent.click(btn); // → R1
    expect(hl('R1')).toBeTruthy();
    expect(screen.getByTestId('locate-hint').textContent).toBe('1 / 3');
    fireEvent.click(btn); // → R2
    expect(hl('R2')).toBeTruthy();
    expect(hl('R1')).toBeNull();
    expect(sel('R2')).toBeTruthy(); // selection follows the cycle
    expect(sel('R1')).toBeNull();
    expect(screen.getByTestId('locate-hint').textContent).toBe('2 / 3');
    fireEvent.click(btn); // → R3
    expect(screen.getByTestId('locate-hint').textContent).toBe('3 / 3');
    fireEvent.click(btn); // wrap → R1
    expect(hl('R1')).toBeTruthy();
    expect(screen.getByTestId('locate-hint').textContent).toBe('1 / 3');
  });

  it('a single ready node locates with no cycling hint', async () => {
    const level: RoadmapLevel = {
      nodes: [{ ...node('R', 'r'), ready: true }, node('X', 'x')],
      deps: [],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} locatable />);
    await screen.findByText('r');
    const btn = screen.getByTestId('locate-button');
    expect(btn.getAttribute('aria-label')).toBe('Locate the ready item');
    fireEvent.click(btn);
    expect(hl('R')).toBeTruthy();
    expect(screen.queryByTestId('locate-hint')).toBeNull();
  });

  it('disables locate when nothing is actionable (no frontier, no ready)', async () => {
    const level: RoadmapLevel = { nodes: [node('A', 'a'), node('B', 'b')], deps: [] };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} locatable />);
    await screen.findByText('a');
    expect(screen.getByTestId('locate-button').hasAttribute('disabled')).toBe(true);
  });

  it('resets the cycle cursor when the level’s ready set changes', async () => {
    let lvl: RoadmapLevel = {
      nodes: [
        { ...node('R1', 'r1'), ready: true },
        { ...node('R2', 'r2'), ready: true },
      ],
      deps: [],
    };
    const load = () => Promise.resolve(lvl);
    const { rerender } = render(<ProjectRoadmapCanvas loadLevel={load} locatable reloadKey="1" />);
    await screen.findByText('r1');
    const btn = screen.getByTestId('locate-button');
    fireEvent.click(btn);
    fireEvent.click(btn); // → 2 / 2
    expect(screen.getByTestId('locate-hint').textContent).toBe('2 / 2');
    // the level's ready set changes (a drill / re-plan) → bump reloadKey to refetch
    lvl = {
      nodes: [
        { ...node('R3', 'r3'), ready: true },
        { ...node('R4', 'r4'), ready: true },
        { ...node('R5', 'r5'), ready: true },
      ],
      deps: [],
    };
    rerender(<ProjectRoadmapCanvas loadLevel={load} locatable reloadKey="2" />);
    await screen.findByText('r3');
    // cursor reset: the first click lands on the FIRST ready of the new set
    fireEvent.click(btn);
    expect(hl('R3')).toBeTruthy();
    expect(screen.getByTestId('locate-hint').textContent).toBe('1 / 3');
  });

  // ── AUTO-DESCEND a single-drillable-parent level (MOTIR-1807) ───────────────────
  // Design: `design/roadmap/auto-drill.mock.html` + its `design-notes.md` section
  // (MOTIR-1805). A level that resolves to exactly ONE drillable node offers no
  // choice, so the canvas descends into it and the roadmap opens on the WORK rather
  // than on one card. The prop is OFF by default because this canvas is the shared
  // foundation behind five consumers.
  describe('autoDescendSingleParent', () => {
    // A two-level chain: root → [P] → [C] → [L1, L2] — it compacts in ONE arrival and
    // stops where the plan actually branches (design panel D).
    const chain: Record<string, RoadmapLevel> = {
      __root__: { nodes: [node('P', 'Parent story', true)], deps: [] },
      P: { nodes: [node('C', 'Child story', true)], deps: [] },
      C: { nodes: [node('L1', 'Leaf one'), node('L2', 'Leaf two')], deps: [] },
    };
    // A single-level version: root → [P] → [S1, S2].
    const oneDeep: Record<string, RoadmapLevel> = {
      __root__: { nodes: [node('P', 'Parent story', true)], deps: [] },
      P: { nodes: [node('S1', 'Story one'), node('S2', 'Story two')], deps: [] },
    };
    const serve = (tree: Record<string, RoadmapLevel>) => (parentId: string | null) =>
      Promise.resolve(tree[parentId ?? '__root__'] ?? { nodes: [], deps: [] });

    const crumbNav = () => screen.getByRole('navigation', { name: 'Breadcrumb' });
    const noCrumbNav = () => screen.queryByRole('navigation', { name: 'Breadcrumb' });
    const crumbLabels = () =>
      within(crumbNav())
        .getAllByRole('listitem')
        .map((li) => li.textContent);

    // THE CONTROL. The prop defaults to `false`, so the consumers that do not opt
    // in (OnboardingCanvas / PlanReviewCanvas / PlanningWorkspaceHost)
    // are provably unaffected by this whole feature.
    it('is OFF by default — a single drillable node renders as itself, no descent', async () => {
      render(<ProjectRoadmapCanvas loadLevel={serve(chain)} />);
      expect(await screen.findByText('Parent story')).toBeTruthy();
      await act(async () => {}); // flush any pending load before the negatives
      expect(el('C')).toBeNull();
      expect(el('L1')).toBeNull();
      expect(noCrumbNav()).toBeNull();
    });

    it('ON: descends into the single drillable node and keeps it as the breadcrumb', async () => {
      render(
        <ProjectRoadmapCanvas
          loadLevel={serve(oneDeep)}
          autoDescendSingleParent
          rootLabel="Roadmap"
        />,
      );
      // We land on the CHILDREN; the skipped level itself is never rendered.
      expect(await screen.findByText('Story one')).toBeTruthy();
      expect(el('S2')).toBeTruthy();
      expect(el('P')).toBeNull();
      expect(crumbLabels()).toEqual(['Roadmap', 'P']);
    });

    it('ON: Back and the crumb both return to the skipped level', async () => {
      render(
        <ProjectRoadmapCanvas
          loadLevel={serve(oneDeep)}
          autoDescendSingleParent
          rootLabel="Roadmap"
        />,
      );
      await screen.findByText('Story one');
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(await screen.findByText('Parent story')).toBeTruthy();
      expect(noCrumbNav()).toBeNull(); // back at the root level

      cleanup();
      render(
        <ProjectRoadmapCanvas
          loadLevel={serve(oneDeep)}
          autoDescendSingleParent
          rootLabel="Roadmap"
        />,
      );
      await screen.findByText('Story one');
      fireEvent.click(within(crumbNav()).getByText('Roadmap'));
      expect(await screen.findByText('Parent story')).toBeTruthy();
      expect(noCrumbNav()).toBeNull();
    });

    it('ON: CHAINS — two nested single-parent levels compact in one arrival, crumbs in descent order', async () => {
      render(
        <ProjectRoadmapCanvas
          loadLevel={serve(chain)}
          autoDescendSingleParent
          rootLabel="Roadmap"
        />,
      );
      expect(await screen.findByText('Leaf one')).toBeTruthy();
      expect(el('L2')).toBeTruthy();
      // Neither skipped ancestor was ever painted — the arrival reads as ONE landing.
      expect(el('P')).toBeNull();
      expect(el('C')).toBeNull();
      expect(screen.queryByText('Parent story')).toBeNull();
      expect(crumbLabels()).toEqual(['Roadmap', 'P', 'C']);
    });

    // The negative cases, drawn in design panel E so this card cannot guess them.
    it('does NOT descend when the level has ≥2 nodes (the choice is the user’s)', async () => {
      render(<ProjectRoadmapCanvas loadLevel={loadLevel} autoDescendSingleParent />);
      expect(await screen.findByText('Epic one')).toBeTruthy();
      await act(async () => {});
      expect(el('E2')).toBeTruthy();
      expect(el('S1')).toBeNull();
      expect(noCrumbNav()).toBeNull();
    });

    // MOTIR-1824 — the ONBOARDED-project shape. `buildWorkItemLevel` pins the
    // planning-origin cluster onto the ROOT level of a project that onboarded, as a
    // `decorative` node. It is provenance drawn beside the road, never a branch in
    // it, so it must not answer the "does this level offer a choice?" question. It
    // did, and the whole feature silently never fired for an onboarded project.
    const origin = (): ProjectCanvasNode => ({
      ...node('ORIGIN', 'Planning origin'),
      decorative: true,
    });

    it('DESCENDS past a decorative node — [origin + one drillable story] is still one choice', async () => {
      const onboarded: Record<string, RoadmapLevel> = {
        __root__: { nodes: [origin(), node('P', 'Parent story', true)], deps: [] },
        P: { nodes: [node('S1', 'Story one'), node('S2', 'Story two')], deps: [] },
      };
      render(
        <ProjectRoadmapCanvas
          loadLevel={serve(onboarded)}
          autoDescendSingleParent
          rootLabel="Roadmap"
        />,
      );
      expect(await screen.findByText('Story one')).toBeTruthy();
      expect(el('S2')).toBeTruthy();
      // Neither the skipped story NOR the cluster pinned beside it was painted —
      // the arrival is the same one a never-onboarded project gets.
      expect(el('P')).toBeNull();
      expect(el('ORIGIN')).toBeNull();
      expect(crumbLabels()).toEqual(['Roadmap', 'P']);
    });

    it('does NOT descend when a decorative node sits beside TWO stories (a real branch)', async () => {
      const twoStories: RoadmapLevel = {
        nodes: [origin(), node('P', 'Parent story', true), node('Q', 'Other story', true)],
        deps: [],
      };
      render(
        <ProjectRoadmapCanvas
          loadLevel={() => Promise.resolve(twoStories)}
          autoDescendSingleParent
        />,
      );
      expect(await screen.findByText('Parent story')).toBeTruthy();
      await act(async () => {});
      expect(el('Q')).toBeTruthy();
      expect(el('ORIGIN')).toBeTruthy(); // decoration still RENDERS; it is only uncounted
      expect(noCrumbNav()).toBeNull();
    });

    // The counting rule is "not decorative", NOT "drillable" — a level holding one
    // drillable story AND a childless bug offers a real choice (open the story, or
    // read the bug), and skipping it would hide the bug behind a card the user never
    // saw. This is the shape the narrower "count only drillable nodes" fix breaks.
    it('does NOT descend when the only drillable node shares the level with a LEAF', async () => {
      const storyAndLoose: RoadmapLevel = {
        nodes: [origin(), node('P', 'Parent story', true), node('B', 'Loose bug')],
        deps: [],
      };
      render(
        <ProjectRoadmapCanvas
          loadLevel={() => Promise.resolve(storyAndLoose)}
          autoDescendSingleParent
        />,
      );
      expect(await screen.findByText('Loose bug')).toBeTruthy();
      await act(async () => {});
      expect(el('P')).toBeTruthy();
      expect(noCrumbNav()).toBeNull();
    });

    it('does NOT descend when the single node is NOT drillable (a childless leaf)', async () => {
      const lone: RoadmapLevel = { nodes: [node('A', 'Lonely leaf')], deps: [] };
      render(
        <ProjectRoadmapCanvas loadLevel={() => Promise.resolve(lone)} autoDescendSingleParent />,
      );
      expect(await screen.findByText('Lonely leaf')).toBeTruthy();
      await act(async () => {});
      expect(noCrumbNav()).toBeNull();
    });

    it('does NOT descend when the level is empty', async () => {
      render(
        <ProjectRoadmapCanvas
          loadLevel={() => Promise.resolve({ nodes: [], deps: [] })}
          autoDescendSingleParent
        />,
      );
      expect(await screen.findByText('Nothing on the roadmap yet')).toBeTruthy();
      expect(noCrumbNav()).toBeNull();
    });

    // Design panel F: after an explicit climb the level SITS STILL — including across a
    // manual refresh, which re-runs the load for the CURRENT level (MOTIR-1542) and
    // must not lose the user's place. `loadLevel` is spied so the refresh assertion
    // waits on the REFETCH ACTUALLY HAVING HAPPENED, not on a timer — otherwise the
    // "still at the root" assertion would pass vacuously.
    it('SUPPRESSES the re-descend after the user climbs back — across a refresh too — until an explicit drill', async () => {
      const load = vi.fn(serve(oneDeep));
      const { rerender } = render(
        <ProjectRoadmapCanvas
          loadLevel={load}
          autoDescendSingleParent
          rootLabel="Roadmap"
          reloadKey="1"
        />,
      );
      await screen.findByText('Story one'); // arrived already drilled
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2)); // root + the descent

      fireEvent.click(within(crumbNav()).getByText('Roadmap'));
      expect(await screen.findByText('Parent story')).toBeTruthy();
      await waitFor(() => expect(load).toHaveBeenCalledTimes(3)); // the root reload
      expect(noCrumbNav()).toBeNull();

      // A MANUAL REFRESH (a `reloadKey` bump) re-reads THIS level and stays put.
      rerender(
        <ProjectRoadmapCanvas
          loadLevel={load}
          autoDescendSingleParent
          rootLabel="Roadmap"
          reloadKey="2"
        />,
      );
      await waitFor(() => expect(load).toHaveBeenCalledTimes(4));
      await act(async () => {});
      expect(el('P')).toBeTruthy();
      expect(el('S1')).toBeNull();
      expect(noCrumbNav()).toBeNull();

      // An EXPLICIT drill re-arms the behaviour.
      fireEvent.keyDown(el('P')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      expect(await screen.findByText('Story one')).toBeTruthy();
      expect(crumbLabels()).toEqual(['Roadmap', 'P']);
    });

    // Design panel C: the two routes in are the same state. Both go through the ONE
    // `applyDrill` transition, so a hand drill and an arrival are indistinguishable.
    it('produces the SAME state as a hand-drilled view (identical crumbs + level)', async () => {
      // Route 1 — the user drills P by hand (prop off).
      render(<ProjectRoadmapCanvas loadLevel={serve(oneDeep)} rootLabel="Roadmap" />);
      await screen.findByText('Parent story');
      fireEvent.keyDown(el('P')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      await screen.findByText('Story one');
      const manualCrumbs = crumbLabels();
      const manualNodes = [...document.querySelectorAll('[data-node-id]')].map(
        (n) => (n as HTMLElement).dataset.nodeId,
      );
      cleanup();

      // Route 2 — the canvas arrives already drilled.
      render(
        <ProjectRoadmapCanvas
          loadLevel={serve(oneDeep)}
          autoDescendSingleParent
          rootLabel="Roadmap"
        />,
      );
      await screen.findByText('Story one');
      expect(crumbLabels()).toEqual(manualCrumbs);
      expect(
        [...document.querySelectorAll('[data-node-id]')].map(
          (n) => (n as HTMLElement).dataset.nodeId,
        ),
      ).toEqual(manualNodes);
    });

    it('clears the selection and the highlight when it descends', async () => {
      // Start on a level with a real choice, select + highlight a node, then let the
      // data change under a refresh so the level now resolves to ONE drillable node.
      let root: RoadmapLevel = { nodes: [node('A', 'Alpha'), node('B', 'Bravo')], deps: [] };
      const load = vi.fn((parentId: string | null) =>
        Promise.resolve(parentId === null ? root : (oneDeep.P as RoadmapLevel)),
      );
      const { rerender } = render(
        <ProjectRoadmapCanvas
          loadLevel={load}
          autoDescendSingleParent
          searchable
          searchLabel="Search the roadmap"
          rootLabel="Roadmap"
          reloadKey="1"
        />,
      );
      await screen.findByText('Alpha');
      fireEvent.keyDown(el('A')!, { key: 'Enter' }); // select
      fireEvent.change(screen.getByPlaceholderText('Search the roadmap'), {
        target: { value: 'Alpha' },
      });
      fireEvent.submit(screen.getByRole('search')); // highlight
      expect(el('A')!.querySelector('[data-selected]')).toBeTruthy();
      expect(el('A')!.querySelector('[data-highlighted]')).toBeTruthy();

      root = { nodes: [node('P', 'Parent story', true)], deps: [] };
      rerender(
        <ProjectRoadmapCanvas
          loadLevel={load}
          autoDescendSingleParent
          searchable
          searchLabel="Search the roadmap"
          rootLabel="Roadmap"
          reloadKey="2"
        />,
      );
      expect(await screen.findByText('Story one')).toBeTruthy();
      expect(document.querySelector('[data-selected]')).toBeNull();
      expect(document.querySelector('[data-highlighted]')).toBeNull();
      expect(crumbLabels()).toEqual(['Roadmap', 'P']);
    });
  });
  // ── ARRIVE ALREADY DRILLED (MOTIR-2070) ───────────────────────────────────
  //
  // The canvas normally arrives at the root. A consumer that knows where the user
  // is headed — the planning workspace, summoned ABOUT a work item — passes the
  // anchor's ancestor trail so the workspace opens on the level that CONTAINS the
  // item instead of the project's epics, where its target ring would be drawn on a
  // level nobody is looking at. The seed must be indistinguishable from a manual
  // drill (design `auto-drill` panel C's rule, applied to an arrival): same
  // breadcrumb, Back climbs the same way, and it is a SEED, not a controlled level.
  describe('the seeded arrival level (initialTrail)', () => {
    // root → [P] → [C] → [L1, L2]
    const deep: Record<string, RoadmapLevel> = {
      __root__: { nodes: [node('P', 'Parent story', true)], deps: [] },
      P: { nodes: [node('C', 'Child story', true)], deps: [] },
      C: { nodes: [node('L1', 'Leaf one'), node('L2', 'Leaf two')], deps: [] },
    };
    const serveDeep = (parentId: string | null) =>
      Promise.resolve(deep[parentId ?? '__root__'] ?? { nodes: [], deps: [] });

    const crumbNav = () => screen.getByRole('navigation', { name: 'Breadcrumb' });
    const crumbLabels = () =>
      within(crumbNav())
        .getAllByRole('listitem')
        .map((li) => li.textContent);

    it('opens on the trail’s LAST level, with the whole trail as the breadcrumb', async () => {
      render(
        <ProjectRoadmapCanvas
          loadLevel={serveDeep}
          rootLabel="Roadmap"
          initialTrail={[
            { id: 'P', label: 'MOTIR-1 · Parent story' },
            { id: 'C', label: 'MOTIR-2 · Child story' },
          ]}
        />,
      );

      // The anchor's LEVEL — not the root, and not the anchor's own children.
      expect(await screen.findByText('Leaf one')).toBeTruthy();
      expect(el('L2')).toBeTruthy();
      expect(el('P')).toBeNull();
      expect(crumbLabels()).toEqual(['Roadmap', 'MOTIR-1 · Parent story', 'MOTIR-2 · Child story']);
    });

    it('is an ordinary drilled view — Back climbs one level, the root crumb returns', async () => {
      render(
        <ProjectRoadmapCanvas
          loadLevel={serveDeep}
          rootLabel="Roadmap"
          initialTrail={[
            { id: 'P', label: 'MOTIR-1 · Parent story' },
            { id: 'C', label: 'MOTIR-2 · Child story' },
          ]}
        />,
      );
      await screen.findByText('Leaf one');

      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(await screen.findByText('Child story')).toBeTruthy();
      expect(crumbLabels()).toEqual(['Roadmap', 'MOTIR-1 · Parent story']);

      fireEvent.click(screen.getByRole('button', { name: 'Roadmap' }));
      expect(await screen.findByText('Parent story')).toBeTruthy();
      expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    });

    it('opens at the ROOT for an EMPTY trail — the shipped, unanchored arrival', async () => {
      render(<ProjectRoadmapCanvas loadLevel={serveDeep} rootLabel="Roadmap" initialTrail={[]} />);

      expect(await screen.findByText('Parent story')).toBeTruthy();
      expect(el('L1')).toBeNull();
      expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    });

    it('is a SEED, not a controlled level — a later prop change never yanks the user', async () => {
      const { rerender } = render(
        <ProjectRoadmapCanvas
          loadLevel={serveDeep}
          rootLabel="Roadmap"
          reloadKey="1"
          initialTrail={[{ id: 'P', label: 'MOTIR-1 · Parent story' }]}
        />,
      );
      await screen.findByText('Child story');

      // The user climbs out; the host then re-renders (a new proposal bumps the
      // reload key) still passing the mount-time trail. The canvas must stay put.
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(await screen.findByText('Parent story')).toBeTruthy();

      rerender(
        <ProjectRoadmapCanvas
          loadLevel={serveDeep}
          rootLabel="Roadmap"
          reloadKey="2"
          initialTrail={[{ id: 'P', label: 'MOTIR-1 · Parent story' }]}
        />,
      );
      expect(await screen.findByText('Parent story')).toBeTruthy();
      expect(el('C')).toBeNull();
    });

    it('does NOT auto-descend out of the level it was aimed at', async () => {
      // The seeded level holds exactly one drillable node, which auto-descend would
      // normally walk past — but the consumer aimed the canvas HERE on purpose.
      render(
        <ProjectRoadmapCanvas
          loadLevel={serveDeep}
          rootLabel="Roadmap"
          autoDescendSingleParent
          initialTrail={[{ id: 'P', label: 'MOTIR-1 · Parent story' }]}
        />,
      );

      expect(await screen.findByText('Child story')).toBeTruthy();
      expect(el('L1')).toBeNull();
      expect(crumbLabels()).toEqual(['Roadmap', 'MOTIR-1 · Parent story']);
    });
  });
});

// ── `resolveHeldNode` — following a node the consumer RE-KEYS (bug MOTIR-3439) ─
//
// The canvas holds two things by node id — the drilled `focusId` and every crumb
// — in mount-time state, because `initialTrail` is a SEED and a later prop must
// not move the user. That is a contract about NAVIGATION. A consumer whose node
// ids CHANGE under a mounted canvas (the plan detail, where approving re-keys
// every proposal onto the work item it became) was not covered by it: the focus
// went on pointing at an id that named nothing, the level loaded empty, and the
// breadcrumb offered a crumb that could not navigate.
//
// These hold the prop's own contract, at the foundation, independently of the
// plan surface that needs it.
describe('ProjectRoadmapCanvas — resolveHeldNode', () => {
  /** The tree, with E1 RE-KEYED to E1b and its level moved with it. */
  const rekeyed: Record<string, RoadmapLevel> = {
    __root__: { nodes: [node('E1b', 'Epic one', true), node('E2', 'Epic two')], deps: [] },
    E1b: { nodes: [node('S1', 'Story one'), node('S2', 'Story two')], deps: [] },
  };
  const loadRekeyed = (parentId: string | null): Promise<RoadmapLevel> =>
    Promise.resolve(rekeyed[parentId ?? '__root__'] ?? { nodes: [], deps: [] });

  async function drillIntoE1() {
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('Story one');
  }

  it('re-addresses the drilled level and its crumb when the id it holds changes', async () => {
    const view = render(
      <ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" reloadKey="v1" />,
    );
    await screen.findByText('Epic one');
    await drillIntoE1();
    const nav = () => screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav()).getByText('E1')).toBeTruthy();

    // The consumer re-keys E1 → E1b and re-renders the SAME canvas. Without the
    // resolver the canvas stays focused on `E1`, which `loadRekeyed` no longer
    // knows, and the level goes empty.
    view.rerender(
      <ProjectRoadmapCanvas
        loadLevel={loadRekeyed}
        rootLabel="Roadmap"
        reloadKey="v2"
        resolveHeldNode={(id) => (id === 'E1' ? { id: 'E1b', label: 'E1b' } : null)}
      />,
    );

    expect(await screen.findByText('Story one')).toBeTruthy();
    expect(screen.queryByText('No items at this level')).toBeNull();
    // The crumb moved with it — id AND label — so it still navigates.
    expect(within(nav()).getByText('E1b')).toBeTruthy();
    expect(within(nav()).queryByText('E1')).toBeNull();
  });

  it('leaves an id it does not recognise exactly where it is', async () => {
    const view = render(
      <ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" reloadKey="v1" />,
    );
    await screen.findByText('Epic one');
    await drillIntoE1();

    // A resolver that knows nothing about this id must not disturb the canvas —
    // `null` is "not mine", not "clear it".
    view.rerender(
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        rootLabel="Roadmap"
        reloadKey="v2"
        resolveHeldNode={() => null}
      />,
    );

    expect(await screen.findByText('Story one')).toBeTruthy();
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('E1'),
    ).toBeTruthy();
  });

  it('SETTLES — an id it has already adopted is not re-adopted forever', async () => {
    // The prop's idempotency requirement, held as a test rather than only as a
    // comment: the canvas re-runs the resolver on the id it just took, so one
    // that kept renaming would not converge. This resolver maps E1 → E1b and
    // says nothing about E1b, which is the shape a `planItemId → nodeId` map has.
    const resolve = vi.fn((id: string) => (id === 'E1' ? { id: 'E1b', label: 'E1b' } : null));
    const view = render(
      <ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" reloadKey="v1" />,
    );
    await screen.findByText('Epic one');
    await drillIntoE1();

    view.rerender(
      <ProjectRoadmapCanvas
        loadLevel={loadRekeyed}
        rootLabel="Roadmap"
        reloadKey="v2"
        resolveHeldNode={resolve}
      />,
    );
    await screen.findByText('Story one');

    // It settled on E1b: every later call is asked about the id it already has,
    // and none of them is asked about E1 again.
    const calls = resolve.mock.calls.map(([id]) => id);
    expect(calls).toContain('E1');
    expect(calls.filter((id) => id === 'E1b').length).toBeGreaterThan(0);
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('E1b'),
    ).toBeTruthy();
  });

  it('does not MOVE the canvas — a re-key while the user is at the ROOT changes nothing', async () => {
    const view = render(
      <ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" reloadKey="v1" />,
    );
    await screen.findByText('Epic one');

    view.rerender(
      <ProjectRoadmapCanvas
        loadLevel={loadRekeyed}
        rootLabel="Roadmap"
        reloadKey="v2"
        resolveHeldNode={(id) => (id === 'E1' ? { id: 'E1b', label: 'E1b' } : null)}
      />,
    );

    // Still the root level: the resolver re-addresses what the canvas HOLDS, and
    // at the root it holds nothing. No crumb appears, no drill happens.
    expect(await screen.findByText('Epic two')).toBeTruthy();
    expect(el('S1')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
  });
});

// ── `levelCaption` — Part IX §1.4's `lvlcap` slot (bug MOTIR-3453) ────────────
//
// A one-line statement ABOUT the level in view, which the design's mock draws
// and the canvas never had. It is the consumer's to write — the foundation knows
// it has nodes, not what kind of nodes they are — and it is NOT an empty state:
// `emptyDrilled` speaks for a level with nothing on it, this speaks for a level
// that has something on it worth explaining.
describe('ProjectRoadmapCanvas — levelCaption', () => {
  it('renders NOTHING when the consumer passes none — the four other consumers are untouched', async () => {
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} />);
    await screen.findByText('Epic one');
    expect(screen.queryByTestId('level-caption')).toBeNull();
  });

  it('renders the caption the consumer supplies, over the level', async () => {
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} levelCaption="Only this plan's cards" />);
    await screen.findByText('Epic one');
    expect(screen.getByTestId('level-caption').textContent).toBe("Only this plan's cards");
  });

  it('does NOT caption the level while the first read is still in flight', async () => {
    // A caption over the spinner describes a level nobody can see yet.
    let release!: (lvl: RoadmapLevel) => void;
    const pending = new Promise<RoadmapLevel>((r) => {
      release = r;
    });
    render(<ProjectRoadmapCanvas loadLevel={() => pending} levelCaption="Not yet" />);
    expect(screen.queryByTestId('level-caption')).toBeNull();

    await act(async () => {
      release(levels.__root__!);
    });
    expect(await screen.findByText('Epic one')).toBeTruthy();
    expect(screen.getByTestId('level-caption')).toBeTruthy();
  });

  it('clears the TOP BAND’s way — the breadcrumb on the left, the cluster on the right', async () => {
    // Asserted on the STATE, not a pixel offset: the caption sits in the band's
    // flow (MOTIR-12194), so where it lands follows from the chrome above it.
    const bare = render(<ProjectRoadmapCanvas loadLevel={loadLevel} levelCaption="A caption" />);
    await screen.findByText('Epic one');
    // A canvas with NO chrome at all: the band is empty, so the caption has it.
    expect(screen.getByTestId('level-caption').getAttribute('data-below-chrome')).toBeNull();
    bare.unmount();

    // The CLUSTER alone pushes it down — it is on the right, but a caption wide
    // enough to reach the right edge would run under it.
    render(
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        levelCaption="A caption"
        searchable
        searchLabel="Search the roadmap"
      />,
    );
    await screen.findByText('Epic one');
    expect(screen.getByTestId('level-caption').getAttribute('data-below-chrome')).toBe('true');
    cleanup();

    // …and so does the BREADCRUMB, once the canvas is drilled.
    render(
      <ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" levelCaption="A caption" />,
    );
    await screen.findByText('Epic one');
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('Story one');

    expect(screen.getByTestId('level-caption').getAttribute('data-below-chrome')).toBe('true');
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy();
  });

  // Bug MOTIR-12194: the caption was an `absolute` overlay at a `top` worth ONE
  // row of chrome, and a LEVEL CHANGE BAND (MOTIR-6223) makes the breadcrumb card
  // two rows tall — so on a drilled, all-proposed level the caption covered the
  // band's button. jsdom lays nothing out, so what is asserted is the STRUCTURE
  // that makes the overlap impossible: the caption is a full-width row in the
  // top band's flex-wrap flow, AFTER the nav, carrying no positioning of its own.
  it('lays the caption out AFTER the breadcrumb bar in the top band’s flow — never at a fixed `top` — when a level change band stacks a second row', async () => {
    const onBand = vi.fn();
    render(
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        rootLabel="Roadmap"
        levelCaption="Nothing committed here yet"
        searchable
        searchLabel="Search the roadmap"
        levelBand={() => (
          <div data-testid="band-row">
            <button type="button" onClick={onBand}>
              What this plan changes here
            </button>
          </div>
        )}
      />,
    );
    await screen.findByText('Epic one');
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('Story one');

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    // The band really is the bar's second row — the shape that used to collide.
    expect(within(nav).getByTestId('band-row')).toBeTruthy();
    expect(nav.className).toContain('flex-col');

    const caption = screen.getByTestId('level-caption');
    const row = screen.getByTestId('level-caption-row');
    expect(row.contains(caption)).toBe(true);
    // Same parent as the nav: the top band's wrapping flex container…
    const band = nav.parentElement!;
    expect(row.parentElement).toBe(band);
    expect(band.className).toContain('flex-wrap');
    // …as its LAST child, on a row of its own, after the nav and the cluster.
    expect(band.lastElementChild).toBe(row);
    expect(nav.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.className.split(/\s+/)).toContain('basis-full');
    // No positioning of its own: neither the row nor the chip is absolute, and
    // neither carries a computed `top`.
    for (const node of [row, caption]) {
      const classes = node.className.split(/\s+/);
      expect(classes).not.toContain('absolute');
      expect(classes.some((c) => c.startsWith('top-'))).toBe(false);
    }

    // The band's button is reachable and fires.
    fireEvent.click(within(nav).getByRole('button', { name: 'What this plan changes here' }));
    expect(onBand).toHaveBeenCalledTimes(1);
  });

  it('with NO chrome in the band, the caption is the band’s only content — it takes the band’s top', async () => {
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} levelCaption="A caption" />);
    await screen.findByText('Epic one');
    const row = screen.getByTestId('level-caption-row');
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(row.parentElement!.firstElementChild).toBe(row);
    expect(row.parentElement!.className).toContain('top-3');
  });
});

// ── `showChangesCount` — through the CATALOGUE, not composed in JSX (MOTIR-3453) ─
//
// This shipped as `{n}/{total}` built inline: a string no catalogue could reach,
// so `zh` could never differ from `en` and the parity gate could not see it —
// there was no key for it to find missing. Part IX §5 names the key AND its
// wording, and "3 of 11" is also what a screen reader should say.
describe('ProjectRoadmapCanvas — the Show-changes count is catalogue copy', () => {
  const wide: RoadmapLevel = {
    nodes: [node('A', 'a'), node('B', 'b'), node('C', 'c')],
    deps: [],
  };

  it('reads "{n} of {total}" from the catalogue when the level holds part of the plan', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(wide)}
        emphasis={{
          ids: ['A', 'B', 'C'],
          total: 11,
          label: 'Show changes',
          emptyLabel: 'None',
          allLabel: 'All',
          locateLabel: 'Locate',
        }}
      />,
    );
    await screen.findByText('a');
    // The en catalogue's real string, rendered — not a slash composed in JSX.
    expect(screen.getByTestId('show-changes-toggle').textContent).toContain('3 of 11');
    expect(screen.getByTestId('show-changes-toggle').textContent).not.toContain('3/11');
  });

  it('says nothing when the level holds the WHOLE plan — unchanged', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(wide)}
        emphasis={{
          ids: ['A', 'B', 'C'],
          total: 3,
          label: 'Show changes',
          emptyLabel: 'None',
          allLabel: 'All',
          locateLabel: 'Locate',
        }}
      />,
    );
    await screen.findByText('a');
    expect(screen.getByTestId('show-changes-toggle').textContent).not.toContain('of');
  });
});

// ── Show changes dims the EDGES too (MOTIR-5639) ────────────────────────────
//
// The mode faded the unchanged cards and left every arrow between two of them at
// full strength, so on a dense level the rings drowned in lines. An edge touching
// a changed card stays lit; every other edge takes the selection's shipped 0.12.
describe('ProjectRoadmapCanvas — Show changes dims the edges between unchanged cards', () => {
  // A and B are the plan's; C and D are not. A→B is changed→changed, B→C
  // changed→unchanged, C→D unchanged→unchanged.
  const level: RoadmapLevel = {
    nodes: [node('A', 'a'), node('B', 'b'), node('C', 'c'), node('D', 'd')],
    deps: [
      { from: 'A', to: 'B', variant: 'firm' },
      { from: 'B', to: 'C', variant: 'firm' },
      { from: 'C', to: 'D', variant: 'firm' },
    ],
  };
  const emphasis = (ids: string[]) => ({
    ids,
    total: ids.length,
    label: 'Show changes',
    emptyLabel: 'None',
    allLabel: 'All',
    locateLabel: 'Locate',
  });
  const opacities = () =>
    [...screen.getByTestId('canvas-edges').querySelectorAll('path')].map(
      (p) => (p as SVGPathElement).style.opacity,
    );
  const toggle = () => screen.getByTestId('show-changes-toggle');

  it('dims exactly the edges with neither end changed, while nothing is selected', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(level)}
        emphasis={emphasis(['A', 'B'])}
      />,
    );
    await screen.findByText('a');
    // Armed on arrival (MOTIR-4020).
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(opacities()).toEqual(['1', '1', '0.12']);
  });

  it('a selection takes over the edge dim, and clearing it restores the Show-changes dim', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(level)}
        emphasis={emphasis(['A', 'B'])}
      />,
    );
    await screen.findByText('a');
    fireEvent.keyDown(el('D')!, { key: 'Enter' });
    expect(el('D')!.querySelector('[data-selected]')).toBeTruthy();
    // Today's selection rule: only D's own edge stays lit.
    expect(opacities()).toEqual(['0.12', '0.12', '1']);

    // A press on empty canvas that does not pan clears the selection.
    const region = screen.getByRole('application');
    fireEvent.pointerDown(region, { pointerId: 1, clientX: 5, clientY: 5, button: 0 });
    fireEvent.pointerUp(region, { pointerId: 1, clientX: 5, clientY: 5, button: 0 });
    expect(document.querySelector('[data-selected]')).toBeNull();
    expect(opacities()).toEqual(['1', '1', '0.12']);
  });

  it('dims no edge with Show changes turned off', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(level)}
        emphasis={emphasis(['A', 'B'])}
      />,
    );
    await screen.findByText('a');
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(opacities()).toEqual(['1', '1', '1']);
  });

  it('dims no edge when none of the plan’s cards is on this level', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(level)}
        emphasis={emphasis(['elsewhere'])}
      />,
    );
    await screen.findByText('a');
    expect(opacities()).toEqual(['1', '1', '1']);
  });
});

// ── THE LEVEL SEAM (MOTIR-3835) ─────────────────────────────────────────────
//
// `initialTrail` seeds the level once; these two props are the other two
// directions — REPORTING where the canvas went, and being TOLD to go somewhere
// without a remount. Both are opt-in and absent by default, which the "three
// other consumers" test at the bottom of this block is what actually protects.
describe('ProjectRoadmapCanvas — the level seam (onLevelChange + controlledTrail)', () => {
  // A two-level tree with a KEY on every drillable node, so the reported trail
  // can be asserted to carry the identifier and not only the display label.
  function keyed(id: string, label: string, key: string, drillable = false): ProjectCanvasNode {
    return {
      id,
      parentId: null,
      searchText: label,
      crumbLabel: `${key} · ${label}`,
      crumbKey: key,
      drillable,
      content: <div>{label}</div>,
    };
  }
  const tree: Record<string, RoadmapLevel> = {
    __root__: {
      nodes: [keyed('E1', 'Epic one', 'MOTIR-1', true), keyed('E2', 'Epic two', 'MOTIR-2')],
      deps: [],
    },
    E1: {
      nodes: [keyed('S1', 'Story one', 'MOTIR-11', true), keyed('S2', 'Story two', 'MOTIR-12')],
      deps: [],
    },
    S1: { nodes: [keyed('T1', 'Task one', 'MOTIR-111')], deps: [] },
  };
  const load = (parentId: string | null): Promise<RoadmapLevel> =>
    Promise.resolve(tree[parentId ?? '__root__'] ?? { nodes: [], deps: [] });

  describe('onLevelChange — reporting the level', () => {
    it('is NOT called for the mount-time seed, nor when a level LOAD resolves', async () => {
      const onLevelChange = vi.fn();
      render(
        <ProjectRoadmapCanvas
          loadLevel={load}
          onLevelChange={onLevelChange}
          initialTrail={[{ id: 'E1', label: 'MOTIR-1 · Epic one', crumbKey: 'MOTIR-1' }]}
        />,
      );
      // The seeded level has loaded — the canvas is sitting on it.
      expect(await screen.findByText('Story one')).toBeTruthy();
      expect(onLevelChange).not.toHaveBeenCalled();
    });

    it('reports the full trail root-first on a DRILL, with the crumb KEY', async () => {
      const onLevelChange = vi.fn();
      render(
        <ProjectRoadmapCanvas loadLevel={load} onLevelChange={onLevelChange} rootLabel="Root" />,
      );
      await screen.findByText('Epic one');
      fireEvent.keyDown(el('E1')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      await screen.findByText('Story one');
      expect(onLevelChange).toHaveBeenCalledTimes(1);
      expect(onLevelChange.mock.calls[0]![0]).toEqual([
        { id: 'E1', label: 'MOTIR-1 · Epic one', crumbKey: 'MOTIR-1' },
      ]);

      // A second drill APPENDS — the trail is cumulative, root-first.
      fireEvent.keyDown(el('S1')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      await screen.findByText('Task one');
      expect(onLevelChange).toHaveBeenCalledTimes(2);
      expect(onLevelChange.mock.calls[1]![0]).toEqual([
        { id: 'E1', label: 'MOTIR-1 · Epic one', crumbKey: 'MOTIR-1' },
        { id: 'S1', label: 'MOTIR-11 · Story one', crumbKey: 'MOTIR-11' },
      ]);
    });

    it('reports `[]` when Back returns the canvas to its ROOT level', async () => {
      const onLevelChange = vi.fn();
      render(
        <ProjectRoadmapCanvas loadLevel={load} onLevelChange={onLevelChange} rootLabel="Root" />,
      );
      await screen.findByText('Epic one');
      fireEvent.keyDown(el('E1')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      await screen.findByText('Story one');
      onLevelChange.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      await screen.findByText('Epic one');
      expect(onLevelChange).toHaveBeenCalledTimes(1);
      expect(onLevelChange.mock.calls[0]![0]).toEqual([]);
    });

    it('reports the TRUNCATED trail when a middle crumb is clicked', async () => {
      const onLevelChange = vi.fn();
      render(
        <ProjectRoadmapCanvas loadLevel={load} onLevelChange={onLevelChange} rootLabel="Root" />,
      );
      await screen.findByText('Epic one');
      fireEvent.keyDown(el('E1')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      await screen.findByText('Story one');
      fireEvent.keyDown(el('S1')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      await screen.findByText('Task one');
      onLevelChange.mockClear();

      const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
      fireEvent.click(within(crumb).getByText('MOTIR-1 · Epic one'));
      await screen.findByText('Story one');
      expect(onLevelChange.mock.calls[0]![0]).toEqual([
        { id: 'E1', label: 'MOTIR-1 · Epic one', crumbKey: 'MOTIR-1' },
      ]);
    });

    it('an AUTO-DESCENDED arrival reports exactly like a hand-drilled one', async () => {
      // A root level of ONE drillable node: nobody clicks, the canvas descends
      // itself — and the report must still name the level it landed on.
      const lone: Record<string, RoadmapLevel> = {
        __root__: { nodes: [keyed('E1', 'Epic one', 'MOTIR-1', true)], deps: [] },
        E1: {
          nodes: [keyed('S1', 'Story one', 'MOTIR-11'), keyed('S2', 'Story two', 'MOTIR-12')],
          deps: [],
        },
      };
      const onLevelChange = vi.fn();
      render(
        <ProjectRoadmapCanvas
          loadLevel={(p) => Promise.resolve(lone[p ?? '__root__'] ?? { nodes: [], deps: [] })}
          onLevelChange={onLevelChange}
          autoDescendSingleParent
        />,
      );
      await screen.findByText('Story one');
      expect(onLevelChange).toHaveBeenCalledTimes(1);
      expect(onLevelChange.mock.calls[0]![0]).toEqual([
        { id: 'E1', label: 'MOTIR-1 · Epic one', crumbKey: 'MOTIR-1' },
      ]);
    });

    it('omits crumbKey entirely for a node that carries none', async () => {
      const onLevelChange = vi.fn();
      render(
        <ProjectRoadmapCanvas
          loadLevel={loadLevel}
          onLevelChange={onLevelChange}
          rootLabel="Root"
        />,
      );
      await screen.findByText('Epic one');
      fireEvent.keyDown(el('E1')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      await screen.findByText('Story one');
      // `node()` (the file's own helper) sets no crumbKey — the crumb has none.
      expect(onLevelChange.mock.calls[0]![0]).toEqual([{ id: 'E1', label: 'E1' }]);
    });
  });

  describe('controlledTrail — being told where to go', () => {
    it('ADOPTS a level that differs from the canvas’s own, without a remount', async () => {
      const seen: Array<string | null> = [];
      const spy = (p: string | null) => {
        seen.push(p);
        return load(p);
      };
      const { rerender } = render(<ProjectRoadmapCanvas loadLevel={spy} controlledTrail={[]} />);
      await screen.findByText('Epic one');
      expect(seen).toEqual([null]);

      rerender(
        <ProjectRoadmapCanvas
          loadLevel={spy}
          controlledTrail={[{ id: 'E1', label: 'MOTIR-1 · Epic one', crumbKey: 'MOTIR-1' }]}
        />,
      );
      expect(await screen.findByText('Story one')).toBeTruthy();
      // ONE further read — the adopted level itself. Not a walk of the chain.
      expect(seen).toEqual([null, 'E1']);
      // The breadcrumb is the adopted trail, so Back / the crumbs keep working.
      const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
      expect(within(crumb).getByText('MOTIR-1 · Epic one')).toBeTruthy();
    });

    it('is a NO-OP when the controlled level equals the current one — one read, no loop', async () => {
      const spy = vi.fn(load);
      const trail = [{ id: 'E1', label: 'MOTIR-1 · Epic one', crumbKey: 'MOTIR-1' }];
      const { rerender } = render(<ProjectRoadmapCanvas loadLevel={spy} controlledTrail={trail} />);
      await screen.findByText('Story one');
      const callsAfterMount = spy.mock.calls.length;
      rerender(<ProjectRoadmapCanvas loadLevel={spy} controlledTrail={[...trail]} />);
      await screen.findByText('Story one');
      expect(spy.mock.calls.length).toBe(callsAfterMount);
    });

    it('does NOT report back through onLevelChange — an adoption is the consumer’s own word', async () => {
      const onLevelChange = vi.fn();
      const { rerender } = render(
        <ProjectRoadmapCanvas
          loadLevel={load}
          controlledTrail={[]}
          onLevelChange={onLevelChange}
        />,
      );
      await screen.findByText('Epic one');
      rerender(
        <ProjectRoadmapCanvas
          loadLevel={load}
          controlledTrail={[{ id: 'E1', label: 'MOTIR-1 · Epic one', crumbKey: 'MOTIR-1' }]}
          onLevelChange={onLevelChange}
        />,
      );
      await screen.findByText('Story one');
      expect(onLevelChange).not.toHaveBeenCalled();
    });

    it('SUPPRESSES auto-descend for the adopted level', async () => {
      // The adopted level holds exactly one drillable node, so an unsuppressed
      // canvas would descend straight back out of the level it was just told to
      // show. The consumer asked to SEE this level.
      const chain: Record<string, RoadmapLevel> = {
        __root__: {
          nodes: [keyed('E1', 'Epic one', 'MOTIR-1', true), keyed('E2', 'Epic two', 'MOTIR-2')],
          deps: [],
        },
        E1: { nodes: [keyed('S1', 'Story one', 'MOTIR-11', true)], deps: [] },
        S1: { nodes: [keyed('T1', 'Task one', 'MOTIR-111')], deps: [] },
      };
      const { rerender } = render(
        <ProjectRoadmapCanvas
          loadLevel={(p) => Promise.resolve(chain[p ?? '__root__'] ?? { nodes: [], deps: [] })}
          controlledTrail={[]}
          autoDescendSingleParent
        />,
      );
      await screen.findByText('Epic one');
      rerender(
        <ProjectRoadmapCanvas
          loadLevel={(p) => Promise.resolve(chain[p ?? '__root__'] ?? { nodes: [], deps: [] })}
          controlledTrail={[{ id: 'E1', label: 'MOTIR-1 · Epic one', crumbKey: 'MOTIR-1' }]}
          autoDescendSingleParent
        />,
      );
      // It stays on E1's level, showing the lone story — it does not descend to T1.
      expect(await screen.findByText('Story one')).toBeTruthy();
      expect(el('T1')).toBeNull();
    });

    it('clears the per-level state a drill clears — the selection does not survive', async () => {
      const { rerender } = render(<ProjectRoadmapCanvas loadLevel={load} controlledTrail={[]} />);
      await screen.findByText('Epic one');
      fireEvent.keyDown(el('E2')!, { key: 'Enter' });
      expect(el('E2')!.querySelector('[data-selected]')).toBeTruthy();
      rerender(
        <ProjectRoadmapCanvas
          loadLevel={load}
          controlledTrail={[{ id: 'E1', label: 'MOTIR-1 · Epic one', crumbKey: 'MOTIR-1' }]}
        />,
      );
      await screen.findByText('Story one');
      expect(document.querySelector('[data-selected="true"]')).toBeNull();
    });
  });
});

// ── THE ARRIVAL VIEW (MOTIR-3837) ───────────────────────────────────────────
//
// The GEOMETRY is unit-tested in `tests/planning/canvasGeometry.test.ts` and the
// FOCAL LADDER in `tests/planning/projectCanvasModel.test.ts` — both pure. What
// this component owns is that the opt-in defaults OFF, so the three consumers
// that do not ask for a readable arrival keep today's plain fit.
describe('ProjectRoadmapCanvas — arriveAtReadableScale is opt-in', () => {
  const one: RoadmapLevel = { nodes: [node('A', 'a')], deps: [] };

  it('renders the engine with no arrival configuration by default', async () => {
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(one)} />);
    expect(await screen.findByText('a')).toBeTruthy();
    expect(screen.getByTestId('planning-canvas')).toBeTruthy();
  });

  it('renders the same level when the roadmap adapter opts in', async () => {
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(one)} arriveAtReadableScale />);
    expect(await screen.findByText('a')).toBeTruthy();
    expect(screen.getByTestId('planning-canvas')).toBeTruthy();
  });
});

// ── THE COLLAPSIBLE DEPENDENCIES LEGEND (MOTIR-3838) ────────────────────────
describe('ProjectRoadmapCanvas — the Dependencies legend collapses', () => {
  const withDeps: RoadmapLevel = {
    nodes: [node('A', 'a'), node('B', 'b')],
    deps: [{ from: 'A', to: 'B', kind: 'dependency' }],
  };
  const flowOnly: RoadmapLevel = {
    nodes: [node('A', 'a'), node('B', 'b')],
    deps: [{ from: 'A', to: 'B', kind: 'flow' }],
  };

  beforeEach(() => {
    window.localStorage.clear();
    resetDependencyLegendCollapsedForTests();
  });

  it('renders EXPANDED by default — the shipped state — with the three style rows', async () => {
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(withDeps)} />);
    const legend = await screen.findByTestId('edge-legend');
    expect(within(legend).getByText('blocks')).toBeTruthy();
    expect(within(legend).getByText('pending')).toBeTruthy();
    const toggle = screen.getByTestId('edge-legend-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Hide the dependency legend');
    // `aria-controls` names a real element in the document.
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeTruthy();
  });

  it('COLLAPSES to the heading alone — the control stays findable', async () => {
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(withDeps)} />);
    const toggle = await screen.findByTestId('edge-legend-toggle');
    fireEvent.click(toggle);

    const legend = screen.getByTestId('edge-legend');
    // The heading survives; a legend that vanished entirely could not be reopened.
    expect(within(legend).getByText('Dependencies')).toBeTruthy();
    // The rows are HIDDEN, not unmounted — the disclosure pattern, so
    // `aria-controls` keeps naming a real element and `hidden` takes the rows out
    // of the accessibility tree and out of the layout.
    const rows = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(rows.hidden).toBe(true);
    expect(rows.contains(within(legend).getByText('blocks'))).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Show the dependency legend');
  });

  it('PERSISTS the choice under the shipped `motir.*` key, and re-reads it on a fresh mount', async () => {
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(withDeps)} />);
    fireEvent.click(await screen.findByTestId('edge-legend-toggle'));
    expect(window.localStorage.getItem(DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY)).toBe('true');

    cleanup();
    resetDependencyLegendCollapsedForTests();
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(withDeps)} />);
    const toggle2 = await screen.findByTestId('edge-legend-toggle');
    expect(toggle2.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(toggle2.getAttribute('aria-controls')!)!.hidden).toBe(true);
  });

  it('renders EXPANDED and does not throw when localStorage is unavailable', async () => {
    // happy-dom's `localStorage` is a Proxy, so an instance spy must be restored
    // explicitly (`restoreAllMocks` does not undo it) — see the `finally` below.
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: private mode');
    });
    try {
      render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(withDeps)} />);
      const toggle3 = await screen.findByTestId('edge-legend-toggle');
      expect(toggle3.getAttribute('aria-expanded')).toBe('true');
      expect(document.getElementById(toggle3.getAttribute('aria-controls')!)!.hidden).toBe(false);
    } finally {
      getItem.mockRestore();
    }
  });

  it('still shows NO legend at all on a level whose edges are all `flow`', async () => {
    // The onboarding station serpentine — drawn, but not dependencies.
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(flowOnly)} />);
    await screen.findByText('a');
    expect(screen.queryByTestId('edge-legend')).toBeNull();
    expect(screen.queryByTestId('edge-legend-toggle')).toBeNull();
  });

  it('collapsing does NOT move the legend, the zoom cluster, Locate or Reset layout', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(withDeps)}
        locatable
        onResetPositions={() => {}}
        onNodeMove={() => {}}
      />,
    );
    const legend = await screen.findByTestId('edge-legend');
    const before = legend.className;
    const locateBefore = screen.getByTestId('locate-button').parentElement!.className;

    fireEvent.click(screen.getByTestId('edge-legend-toggle'));

    // The panel collapses IN PLACE — same slot, so it can never land on the
    // engine's zoom cluster at `bottom-4 left-4`.
    expect(screen.getByTestId('edge-legend').className).toBe(before);
    expect(screen.getByTestId('locate-button').parentElement!.className).toBe(locateBefore);
  });
});

// ── THE BOTTOM-RIGHT CONTROL AND THE FOLD (MOTIR-3839) ──────────────────────
describe('ProjectRoadmapCanvas — "Reset layout" respects the fold inset', () => {
  const arranged: RoadmapLevel = { nodes: [node('A', 'a'), node('B', 'b')], deps: [] };

  it('offsets from the bottom by `--canvas-fold-inset`, which DEFAULTS to 0 for every other mount', async () => {
    // The floating Plan-with-AI orb is `fixed right-5 bottom-5` — a 76px reach from
    // both edges — so only a bottom-RIGHT control can meet it. A consumer whose box
    // SPENDS the shell's clearance band declares the inset; every other mount
    // inherits nothing and the control stays exactly where it is today.
    render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(arranged)}
        positions={{ A: { x: 500, y: 500 } }}
        onResetPositions={() => {}}
        onNodeMove={() => {}}
      />,
    );
    await screen.findByText('a');
    const reset = screen.getByRole('button', { name: 'Reset layout' });
    // Asserted on the variable by NAME, not on the whole offset string: MOTIR-6186
    // added a second, full-width inset this control also adds, and a literal here
    // would fail for a change that leaves this property perfectly intact.
    expect(reset.className).toContain('var(--canvas-fold-inset,0px)');
    expect(reset.className).toMatch(/bottom-\[calc\(1rem\+/);
    // Anchored right — the only side the orb can reach.
    expect(reset.className).toContain('right-3');
  });

  it('leaves every LEFT-anchored overlay clear of the FOLD inset', async () => {
    const withDep: RoadmapLevel = {
      nodes: [node('A', 'a'), node('B', 'b')],
      deps: [{ from: 'A', to: 'B', kind: 'dependency' }],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(withDep)} locatable />);
    // The legend and Locate are bottom-LEFT; the orb cannot reach them, so the fold
    // must not move them. THIS IS THE PROPERTY MOTIR-3839 BOUGHT, and it is asserted
    // on the fold variable by NAME rather than on a whole offset string — because
    // MOTIR-6186 added a second, full-width inset that these overlays DO read, and
    // an assertion on the literal offset would have made the two indistinguishable.
    const legend = await screen.findByTestId('edge-legend');
    expect(legend.className).toContain('left-3');
    expect(legend.className).not.toContain('--canvas-fold-inset');

    const locate = screen.getByTestId('locate-button').parentElement!;
    expect(locate.className).toContain('left-[8.25rem]');
    expect(locate.className).not.toContain('--canvas-fold-inset');
  });

  // ── THE FULL-WIDTH FOOT (MOTIR-6186) ──────────────────────────────────────
  //
  // The planning surface's confirm bar used to be a `shrink-0` sibling BELOW this
  // canvas's box. Since MOTIR-6186 it floats OVER the box's bottom edge, so that
  // hiding it when there is nothing to decide resizes nothing — and a bar that
  // spans the full width reaches every bottom-anchored overlay, not just the
  // bottom-RIGHT one the orb can touch.
  //
  // So `--canvas-foot-inset` is a SECOND variable rather than a reuse of
  // `--canvas-fold-inset`: the two describe differently-shaped obstructions, and
  // the test above is the reason they cannot be merged. Both default to `0px`.
  it('lifts EVERY bottom-anchored overlay by the FOOT inset — all four read it', async () => {
    const withDep: RoadmapLevel = {
      nodes: [node('A', 'a'), node('B', 'b')],
      deps: [{ from: 'A', to: 'B', kind: 'dependency' }],
    };
    render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(withDep)}
        locatable
        onResetPositions={() => {}}
        onNodeMove={() => {}}
        positions={{ A: { x: 500, y: 500 } }}
      />,
    );

    const legend = await screen.findByTestId('edge-legend');
    expect(legend.className).toContain('var(--canvas-foot-inset,0px)');
    expect(screen.getByTestId('locate-button').parentElement!.className).toContain(
      'var(--canvas-foot-inset,0px)',
    );
    // …including the bottom-RIGHT one, which therefore adds BOTH insets.
    const reset = screen.getByRole('button', { name: 'Reset layout' });
    expect(reset.className).toContain('var(--canvas-foot-inset,0px)');
    expect(reset.className).toContain('var(--canvas-fold-inset,0px)');
  });

  it('defaults the foot inset to 0, so every other mount is where it was', async () => {
    // The whole safety of a second variable: a consumer that declares neither —
    // `/roadmap`, the plan page, the item page's Children panel — is untouched.
    const withDep: RoadmapLevel = {
      nodes: [node('A', 'a'), node('B', 'b')],
      deps: [{ from: 'A', to: 'B', kind: 'dependency' }],
    };
    const { container } = render(
      <ProjectRoadmapCanvas loadLevel={() => Promise.resolve(withDep)} locatable />,
    );
    await screen.findByTestId('edge-legend');

    // Nothing in the rendered tree DECLARES the variable, so every reader of it
    // resolves to its `0px` fallback.
    expect(container.innerHTML).not.toContain('--canvas-foot-inset:');
  });

  // ── THE TARGET CRUMB (MOTIR-6160, Story MOTIR-6154) ───────────────────────
  //
  // The planning surface opens INSIDE the node being planned, so the target stops
  // being a node on the level and becomes the level. MOTIR-2070 objected to
  // exactly that ("Opening on the anchor's CHILDREN would hide the item the
  // conversation is about"); the mark moving to the crumb is the answer, so these
  // rule on the answer rather than on a decoration.
  describe('the planning-target crumb', () => {
    const trail = [{ id: 'E1', label: 'MOTIR-1 · Epic one' }];

    it('marks the crumb the consumer names, in WORDS as well as colour', async () => {
      render(
        <ProjectRoadmapCanvas
          loadLevel={loadLevel}
          rootLabel="Roadmap"
          initialTrail={trail}
          isTargetCrumb={(c) => c.id === 'E1'}
        />,
      );
      await screen.findByText('Story one');
      const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
      // NOT COLOUR ALONE — the state reaches a screen reader as text, the same
      // discipline the folder crumb and the node's "Target" pill already keep.
      expect(within(crumb).getByText('Planning target:')).toBeTruthy();
      // …and it is the ACTIVE crumb, i.e. the level being stood in.
      const current = within(crumb).getByRole('button', { current: 'page' });
      expect(current.textContent).toContain('MOTIR-1 · Epic one');
    });

    it('marks NOTHING when the consumer does not answer — every other canvas', async () => {
      render(
        <ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" initialTrail={trail} />,
      );
      await screen.findByText('Story one');
      const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
      expect(within(crumb).queryByText('Planning target:')).toBeNull();
    });

    it('marks no crumb when the target is not one — the LEAF arrival', async () => {
      // A subtask target is a NODE on the level, not a crumb, so the ring keeps
      // the mark and the breadcrumb says nothing. Exactly one of the two is
      // marked, which is the property that makes them one fact.
      render(
        <ProjectRoadmapCanvas
          loadLevel={loadLevel}
          rootLabel="Roadmap"
          initialTrail={trail}
          isTargetCrumb={(c) => c.id === 'S1'}
        />,
      );
      await screen.findByText('Story one');
      const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
      expect(within(crumb).queryByText('Planning target:')).toBeNull();
    });
  });

  // ── THE FOLLOW-MOVE (MOTIR-6161, Story MOTIR-6154) ────────────────────────
  //
  // A keyed, one-shot REQUEST the canvas may DECLINE. All three clauses of the
  // contract are ruled on here, because each of them is a way the feature could
  // be wrong while looking right: moving twice, moving on a re-render, and
  // moving a reader who had already gone somewhere else.
  describe('followTo', () => {
    const inside = [{ id: 'E1', label: 'MOTIR-1 · Epic one' }];
    const deeper = [
      { id: 'E1', label: 'MOTIR-1 · Epic one' },
      { id: 'S1', label: 'MOTIR-2 · Story one' },
    ];

    it('moves inside the target, and says where it went', async () => {
      const view = render(<ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" />);
      expect(await screen.findByText('Epic one')).toBeTruthy();

      view.rerender(
        <ProjectRoadmapCanvas
          loadLevel={loadLevel}
          rootLabel="Roadmap"
          followTo={{ key: 'plan:E1', trail: inside }}
        />,
      );
      expect(await screen.findByText('Story one')).toBeTruthy();
      // The announcement is the half a reader who was not watching gets.
      expect(screen.getByTestId('canvas-follow-live').textContent).toContain('MOTIR-1 · Epic one');
    });

    it('honours a given key AT MOST ONCE — a re-render is not a second move', async () => {
      const req = { key: 'plan:E1', trail: inside };
      const view = render(
        <ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" followTo={req} />,
      );
      expect(await screen.findByText('Story one')).toBeTruthy();

      // the reader drills on, then the SAME request re-renders
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(await screen.findByText('Epic one')).toBeTruthy();
      view.rerender(
        <ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" followTo={{ ...req }} />,
      );
      await act(async () => {});
      // Still at the root: the key was already honoured.
      expect(screen.getByText('Epic one')).toBeTruthy();
      expect(screen.queryByText('Story one')).toBeNull();
    });

    it('moves AT MOST ONCE per mount — a second target does not move it again', async () => {
      const view = render(
        <ProjectRoadmapCanvas
          loadLevel={loadLevel}
          rootLabel="Roadmap"
          followTo={{ key: 'target:E1', trail: inside }}
        />,
      );
      expect(await screen.findByText('Story one')).toBeTruthy();

      view.rerender(
        <ProjectRoadmapCanvas
          loadLevel={loadLevel}
          rootLabel="Roadmap"
          followTo={{ key: 'target:S1', trail: deeper }}
        />,
      );
      await act(async () => {});
      // The reader has already been shown where the plan is; a second move would
      // be the canvas wandering.
      expect(screen.getByText('Story one')).toBeTruthy();
      expect(screen.queryByText('Subtask one')).toBeNull();
    });

    it('DECLINES after the reader drilled, and offers to go there instead', async () => {
      const onFollowDeclined = vi.fn();
      const view = render(
        <ProjectRoadmapCanvas
          loadLevel={loadLevel}
          rootLabel="Roadmap"
          onFollowDeclined={onFollowDeclined}
        />,
      );
      expect(await screen.findByText('Epic one')).toBeTruthy();

      // the reader navigates FIRST
      fireEvent.keyDown(el('E1')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      expect(await screen.findByText('Story one')).toBeTruthy();

      // …and only then does a target settle, somewhere else
      view.rerender(
        <ProjectRoadmapCanvas
          loadLevel={loadLevel}
          rootLabel="Roadmap"
          onFollowDeclined={onFollowDeclined}
          followTo={{ key: 'plan:S1', trail: deeper }}
        />,
      );
      await act(async () => {});

      // NOT moved — a deliberate navigation is not overridden.
      expect(screen.getByText('Story one')).toBeTruthy();
      expect(screen.queryByText('Subtask one')).toBeNull();
      expect(onFollowDeclined).toHaveBeenCalledWith('plan:S1');

      // …and the reader is told, rather than left beside a plan they cannot see.
      const offer = screen.getByTestId('canvas-follow-offer');
      expect(offer).toBeTruthy();

      // Taking the offer IS an explicit act, so it moves.
      fireEvent.click(offer);
      expect(await screen.findByText('Subtask one')).toBeTruthy();
      expect(screen.queryByTestId('canvas-follow-offer')).toBeNull();
    });

    it('DECLINES after a crumb click too — Back is navigation', async () => {
      const view = render(
        <ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" initialTrail={inside} />,
      );
      expect(await screen.findByText('Story one')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(await screen.findByText('Epic one')).toBeTruthy();

      view.rerender(
        <ProjectRoadmapCanvas
          loadLevel={loadLevel}
          rootLabel="Roadmap"
          initialTrail={inside}
          followTo={{ key: 'plan:E1', trail: inside }}
        />,
      );
      await act(async () => {});
      expect(screen.getByText('Epic one')).toBeTruthy();
      expect(screen.getByTestId('canvas-follow-offer')).toBeTruthy();
    });

    it('carries the reduced-motion escape on the level it fades', async () => {
      // The move is instant under `prefers-reduced-motion` DECLARATIVELY — the
      // class is what the engine drops, so there is no media query here to fall
      // out of step with the design.
      const view = render(<ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" />);
      await screen.findByText('Epic one');
      view.rerender(
        <ProjectRoadmapCanvas
          loadLevel={loadLevel}
          rootLabel="Roadmap"
          followTo={{ key: 'plan:E1', trail: inside }}
        />,
      );
      await screen.findByText('Story one');
      const canvas = screen.getByTestId('planning-canvas').parentElement!;
      expect(canvas.className).toContain('motion-reduce:transition-none');
      expect(canvas.className).toContain('transition-opacity');
    });

    it('announces NOTHING on an ordinary drill', async () => {
      render(<ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" />);
      await screen.findByText('Epic one');
      fireEvent.keyDown(el('E1')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      await screen.findByText('Story one');
      expect(screen.getByTestId('canvas-follow-live').textContent).toBe('');
    });
  });
});
