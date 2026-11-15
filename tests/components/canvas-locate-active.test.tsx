// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import type { ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import type { LocateStop } from '@/lib/planning/locateWalk';

// LOCATE GOES TO THE CARD BEING WORKED ON (MOTIR-11298). While a plan is written,
// the first click takes the reader to a card a live step targets — on this level
// in layout order, then on another level, which the click opens — and only then
// to the emphasised set, which stays the walk when nothing is in progress.

afterEach(() => cleanup());

const node = (id: string, label: string): ProjectCanvasNode => ({
  id,
  parentId: null,
  searchText: label,
  crumbLabel: id,
  drillable: false,
  content: <div>{label}</div>,
});

// Root: P1 · P2 · P3 in layout order. Level `L2`: Q1 · Q2.
const ROOT: RoadmapLevel = {
  nodes: [node('P1', 'First proposal'), node('P2', 'Second proposal'), node('P3', 'Third')],
  deps: [],
};
const L2: RoadmapLevel = {
  nodes: [node('Q1', 'Deeper one'), node('Q2', 'Deeper two')],
  deps: [],
};
const loadLevel = vi.fn(async (parentId: string | null) => (parentId === 'L2' ? L2 : ROOT));

const ACTIVE_LABEL = 'Locate the item being worked on';
const CHANGE_LABEL = 'Locate the next of this plan’s items';

function emphasis(targets: LocateStop[] | null) {
  return {
    ids: ['P1', 'P2', 'P3', 'Q1', 'Q2'],
    total: 5,
    label: 'Show changes',
    emptyLabel: 'No proposed changes on this level',
    allLabel: 'Every item on this level is this plan’s',
    locateLabel: CHANGE_LABEL,
    active: targets ? { targets, label: ACTIVE_LABEL } : null,
  };
}

const mount = (targets: LocateStop[] | null, onReaderNavigated = vi.fn()) =>
  render(
    <ProjectRoadmapCanvas
      loadLevel={loadLevel}
      rootLabel="Roadmap"
      locatable
      emphasis={emphasis(targets)}
      onReaderNavigated={onReaderNavigated}
    />,
  );

const locate = () => screen.getByTestId('locate-button');
const selectedId = () =>
  document
    .querySelector('[data-node-id] [data-selected]')
    ?.parentElement?.getAttribute('data-node-id') ?? null;
const click = () => fireEvent.click(locate());

describe('Locate goes to the card being worked on first (MOTIR-11298)', () => {
  it('an active card on the shown level is located first, and the label says so', async () => {
    mount([{ nodeId: 'P3', trail: null }]);
    await screen.findByText('First proposal');
    expect(locate().getAttribute('aria-label')).toBe(ACTIVE_LABEL);
    click();
    expect(selectedId()).toBe('P3');
    // Next it moves on to the plan's other cards, and the label follows.
    expect(locate().getAttribute('aria-label')).toBe(CHANGE_LABEL);
    click();
    expect(selectedId()).toBe('P1');
    click();
    expect(selectedId()).toBe('P2');
    // …and the round starts again at the active card.
    click();
    expect(selectedId()).toBe('P3');
  });

  it('two active cards cycle in LAYOUT order before moving on, and the hint counts them', async () => {
    // Given in step order P3 · P1; drawn in layout order P1 · P3.
    mount([
      { nodeId: 'P3', trail: null },
      { nodeId: 'P1', trail: null },
    ]);
    await screen.findByText('First proposal');
    click();
    expect(selectedId()).toBe('P1');
    expect(screen.getByTestId('locate-hint').textContent).toBe('1 / 2');
    click();
    expect(selectedId()).toBe('P3');
    expect(screen.getByTestId('locate-hint').textContent).toBe('2 / 2');
    click();
    expect(selectedId()).toBe('P2');
  });

  it('an active card on ANOTHER level opens that level and centres it', async () => {
    const navigated = vi.fn();
    mount([{ nodeId: 'Q2', trail: [{ id: 'L2', label: 'Level two' }] }], navigated);
    await screen.findByText('First proposal');
    expect(locate().getAttribute('aria-label')).toBe(ACTIVE_LABEL);
    click();
    await screen.findByText('Deeper two');
    await waitFor(() => expect(selectedId()).toBe('Q2'));
    // Centred the way an on-level Locate centres: highlighted, at the locate zoom.
    expect(document.querySelector('[data-node-id="Q2"] [data-highlighted]')).not.toBeNull();
    // The reader moved the level, so a follow-mode host is told.
    expect(navigated).toHaveBeenCalledWith('pick');
    // On the new level the active card has been visited: the walk moves on.
    expect(locate().getAttribute('aria-label')).toBe(CHANGE_LABEL);
    click();
    expect(selectedId()).toBe('Q1');
  });

  it('an active card at the TOP level, from a drilled level, climbs back up to it', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        rootLabel="Roadmap"
        locatable
        initialTrail={[{ id: 'L2', label: 'Level two' }]}
        emphasis={emphasis([{ nodeId: 'P2', trail: [] }])}
      />,
    );
    await screen.findByText('Deeper one');
    click();
    await screen.findByText('Second proposal');
    await waitFor(() => expect(selectedId()).toBe('P2'));
  });

  it('a card that is not on the level it was placed on selects nothing there', async () => {
    mount([{ nodeId: 'Q9', trail: [{ id: 'L2', label: 'Level two' }] }]);
    await screen.findByText('First proposal');
    click();
    await screen.findByText('Deeper one');
    expect(selectedId()).toBeNull();
  });

  it('an active card the consumer cannot place on another level is skipped', async () => {
    mount([{ nodeId: 'Q2', trail: null }]);
    await screen.findByText('First proposal');
    expect(locate().getAttribute('aria-label')).toBe(CHANGE_LABEL);
    click();
    expect(selectedId()).toBe('P1');
  });

  it('no live step: Locate goes to the first card, then keeps the shipped walk', async () => {
    mount(null);
    await screen.findByText('First proposal');
    expect(locate().getAttribute('aria-label')).toBe(CHANGE_LABEL);
    click();
    expect(selectedId()).toBe('P1');
    click();
    expect(selectedId()).toBe('P2');
  });

  it('an empty active list is the same as none', async () => {
    mount([]);
    await screen.findByText('First proposal');
    expect(locate().getAttribute('aria-label')).toBe(CHANGE_LABEL);
    click();
    expect(selectedId()).toBe('P1');
  });
});
