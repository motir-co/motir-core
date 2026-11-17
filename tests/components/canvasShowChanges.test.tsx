// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import type { ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';

// MOTIR-3261 — SHOW CHANGES: one control lights every card the plan touches on
// the level in view and pushes the rest back. Built to
// `design/ai-planning/design-notes.md` Part IX §L and
// `plan-canvas-arrival.mock.html` panels 3–4.
//
// ⚠️ THE TREATMENT IS NOT NEW AND MUST NOT BE. `ProjectRoadmapCanvas`'s node
// wrapper already rings a selected or search-matched node
// (`ring-2 ring-(--el-accent-on-surface) ring-offset-2 ring-offset-(--el-surface-soft)`)
// — the accent INK since MOTIR-4474, never the fill — and
// already dims everything outside the connected set (`opacity-35`). This applies
// THAT PAIR to a SET — one ring value, one dim value, one vocabulary — so the
// assertions below are on the shipped class strings, and a second dim or a second
// ring fails them even if it looks right on screen.

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

// A busy committed level with three of the plan's cards on it, plus a level below
// that the plan does not reach at all.
const levels: Record<string, RoadmapLevel> = {
  __root__: {
    nodes: [
      node('P1', 'A proposal'),
      node('C1', 'A committed sibling', true),
      node('P2', 'A modified card'),
      node('C2', 'Another sibling'),
      node('P3', 'An archived card'),
    ],
    deps: [],
  },
  C1: { nodes: [node('X1', 'Nothing proposed here'), node('X2', 'Nor here')], deps: [] },
};
const loadLevel = (parentId: string | null): Promise<RoadmapLevel> =>
  Promise.resolve(levels[parentId ?? '__root__'] ?? { nodes: [], deps: [] });

const el = (id: string) => document.querySelector(`[data-node-id="${id}"]`);
/** The wrapper `renderNode` puts the ring and the dim on — a CHILD of the
 *  positioned `[data-node-id]` box the canvas engine owns. */
const box = (id: string) => el(id)!.querySelector(':scope > div')!;
const toggle = () => screen.getByTestId('show-changes-toggle');

const EMPHASIS = {
  ids: ['P1', 'P2', 'P3'],
  total: 3,
  label: 'Show changes',
  emptyLabel: 'No proposed changes on this level',
  allLabel: 'Every item on this level is this plan\u2019s',
  locateLabel: 'Locate the next of this plan\u2019s items',
};

const renderCanvas = (emphasis: typeof EMPHASIS | null = EMPHASIS) =>
  render(
    <ProjectRoadmapCanvas
      loadLevel={loadLevel}
      rootLabel="Roadmap"
      {...(emphasis ? { emphasis } : {})}
    />,
  );

describe('the prop is OPT-IN (MOTIR-3261)', () => {
  it('a canvas with no `emphasis` renders no toggle at all', async () => {
    // The other consumers — `OnboardingCanvas`, the planning overlay's canvas
    // before a plan, `WorkItemRoadmap`, `RoadmapView` — mount this component without the prop,
    // so this is what keeps them byte-unchanged. An onboarding canvas that grew a
    // Show-changes toggle would be a regression.
    renderCanvas(null);

    await screen.findByText('A proposal');
    expect(screen.queryByTestId('show-changes-toggle')).toBeNull();
  });
});

describe('the emphasis (MOTIR-3261)', () => {
  it('lights EVERY id on the level and dims the rest, with the SHIPPED classes — ON ARRIVAL', async () => {
    // ⚠️ AMENDED by MOTIR-4020 (Part XIII §3), not rewritten: the emphasis is
    // ARMED from first paint, so the click that used to precede these assertions
    // is gone. What the case guards is unchanged — the SHIPPED ring and the
    // SHIPPED dim, applied to a SET, with no second vocabulary.
    renderCanvas();
    await screen.findByText('A proposal');

    for (const id of ['P1', 'P2', 'P3']) {
      const cls = box(id).className;
      expect(cls).toContain('ring-2 ring-(--el-accent-on-surface)');
      expect(cls).not.toContain('opacity-35');
      expect(box(id).getAttribute('data-emphasised')).toBe('true');
    }
    for (const id of ['C1', 'C2']) {
      const cls = box(id).className;
      expect(cls).toContain('opacity-35');
      expect(cls).not.toContain('ring-2');
      expect(box(id).getAttribute('data-emphasised')).toBeNull();
    }
  });

  it('pressing it once DISARMS — a reader who did not arm it can still turn it off', async () => {
    renderCanvas();
    await screen.findByText('A proposal');

    fireEvent.click(toggle());

    for (const id of ['P1', 'P2', 'P3', 'C1', 'C2']) {
      const cls = box(id).className;
      expect(cls).not.toContain('opacity-35');
      expect(cls).not.toContain('ring-2');
    }
  });

  it('carries `aria-pressed` reflecting its state', async () => {
    renderCanvas();
    await screen.findByText('A proposal');

    // Pressed from first paint (Part XIII §3b): the treatment plus `aria-pressed`
    // IS the affordance, and a screen-reader user is told the mode is on WITHOUT
    // anybody having pressed anything — the case a visual state cannot cover.
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('honours reduced motion — the opacity transition is dropped', async () => {
    // Turning this on changes the opacity of most of the screen at once
    // (Part IX §L8).
    renderCanvas();
    await screen.findByText('A proposal');

    expect(box('P1').className).toContain('motion-reduce:transition-none');
  });
});

describe('a live SELECTION wins, and the toggle stays pressed (Part IX §L4)', () => {
  it('turn it ON, then SELECT — the selection decides the dimming', async () => {
    renderCanvas();
    await screen.findByText('A proposal');

    fireEvent.keyDown(el('C1')!, { key: 'Enter' });

    // The selected committed node is ringed and NOT dimmed; a proposal outside
    // its connected set is dimmed like any other unconnected node.
    expect(box('C1').className).toContain('ring-2');
    expect(box('C1').className).not.toContain('opacity-35');
    expect(box('P1').className).toContain('opacity-35');
    // …and the toggle is STILL pressed, so clearing the selection restores the
    // emphasis rather than making the reader re-arm it.
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('SELECT, then turn it on — the same state, in the other order', async () => {
    renderCanvas();
    await screen.findByText('A proposal');

    // The mode is already on, so this is the SELECTION arriving second rather
    // than the toggle — the order Part IX §L4 says must not change the outcome.
    fireEvent.keyDown(el('C1')!, { key: 'Enter' });

    expect(box('C1').className).toContain('ring-2');
    expect(box('P1').className).toContain('opacity-35');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('clearing the selection RESTORES the emphasis', async () => {
    renderCanvas();
    await screen.findByText('A proposal');

    fireEvent.keyDown(el('C1')!, { key: 'Enter' });
    expect(box('P1').className).toContain('opacity-35');

    // A press on empty canvas that does not pan clears the selection — the real
    // gesture, driven as the component listens for it (pointer down then up on
    // the viewport, with no movement between).
    const viewport = screen.getByTestId('planning-canvas');
    viewport.setPointerCapture = () => {};
    viewport.releasePointerCapture = () => {};
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 10, clientY: 10 });

    // …and the emphasis comes back, because the toggle was never un-pressed.
    await waitFor(() => expect(box('P1').className).toContain('ring-2'));
    expect(box('C1').className).toContain('opacity-35');
  });
});

describe('the toggle RESETS on a level change — and RE-ARMS (MOTIR-3261 · MOTIR-4020)', () => {
  // ⚠️ The RESET is unchanged; its TARGET flipped (Part XIII §3a). A stale
  // emphasis still never survives a level change — what a level change now
  // restores is the level's OWN default, which is armed wherever the emphasis
  // can say anything. A reader who turns it off and then drills arrives armed
  // again: the reset is per LEVEL, and a drill is a new question about a new set
  // of cards.
  it('a level the plan does not reach arrives DISABLED, not merely un-armed', async () => {
    renderCanvas();
    await screen.findByText('A proposal');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');

    fireEvent.keyDown(el('C1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('Nothing proposed here');

    expect(toggle().hasAttribute('disabled')).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('coming BACK to a level the plan DOES reach re-arms it', async () => {
    renderCanvas();
    await screen.findByText('A proposal');
    // Turn it OFF here, so the return cannot be confused with a state that
    // merely survived the round trip.
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('false');

    fireEvent.keyDown(el('C1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('Nothing proposed here');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByText('A proposal');

    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(box('P1').className).toContain('ring-2');
  });
});

describe('the degenerate levels (Part IX §L6)', () => {
  it('a level with NO proposals DISABLES the toggle, with its reason', async () => {
    renderCanvas();
    await screen.findByText('A proposal');
    fireEvent.keyDown(el('C1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('Nothing proposed here');

    // An ON state here would dim every card and ring none — a screen that says
    // nothing, which is worse than a control that says why it cannot help.
    expect(toggle().hasAttribute('disabled')).toBe(true);
    expect(toggle().getAttribute('title')).toBe('No proposed changes on this level');
  });

  it('a level that is ENTIRELY the plan’s DISABLES the toggle too, with its OWN reason', async () => {
    // ⚠️ THIS REVERSES Part IX §L6's second bullet, on the record (Part XIII §3d).
    // §L6 called this state *"correct and harmless"* — and it was, of a state the
    // reader CHOSE. Armed on ARRIVAL the same screen arrives unasked: every card
    // ringed, none dimmed, teaching the reader at the moment they land that the
    // ring means nothing. That is §L6's own argument for the empty case, applied
    // to its mirror. Same disposition, opposite emptiness, different reason.
    render(
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        rootLabel="Roadmap"
        emphasis={{ ...EMPHASIS, ids: ['P1', 'C1', 'P2', 'C2', 'P3'], total: 5 }}
      />,
    );
    await screen.findByText('A proposal');

    expect(toggle().hasAttribute('disabled')).toBe(true);
    expect(toggle().getAttribute('title')).toBe('Every item on this level is this plan\u2019s');
    // Nothing is ringed and nothing is dimmed — the screen says nothing, and now
    // says so with a control that explains why rather than with a lit board.
    for (const id of ['P1', 'C1', 'P2', 'C2', 'P3']) {
      expect(box(id).className).not.toContain('ring-2');
      expect(box(id).className).not.toContain('opacity-35');
    }
  });
});

describe('the OFF-LEVEL count (Part IX §L5)', () => {
  // ⚠️ AMENDED by bug MOTIR-3453, not rewritten. This asserted the literal
  // `3/11` — and that string was the defect: the count was composed in JSX, so
  // no catalogue could reach it, `zh` could never differ from `en`, and the
  // parity gate could not see it because there was no key to be missing. Part IX
  // §5 names the key AND its wording (`showChangesCount`, "{n} of {total}").
  //
  // What this case GUARDS is unchanged and is why it survives the amendment:
  // that the control states the off-level share at all, and offers no way to
  // reach the rest. Only the string it reads for has moved into the catalogue.
  it('reads `{n} of {total}` when the level holds fewer than the whole plan', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        rootLabel="Roadmap"
        emphasis={{ ...EMPHASIS, total: 11 }}
      />,
    );
    await screen.findByText('A proposal');

    // The canvas is per-level and most of a spread plan is off-screen. The
    // control says so and offers no way to reach the rest — that is the list
    // view's job.
    expect(within(toggle()).getByText('3 of 11')).toBeTruthy();
    // …and the shape that shipped is gone, so a revert cannot pass this quietly.
    expect(within(toggle()).queryByText('3/11')).toBeNull();
  });

  it('shows NO count when the level holds all of them', async () => {
    renderCanvas();
    await screen.findByText('A proposal');

    expect(within(toggle()).queryByText(/\bof\b/)).toBeNull();
  });
});
