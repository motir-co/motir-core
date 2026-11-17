// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import type { ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';

// THE LOCATE CONTROL WALKS THE PLAN'S CARDS (MOTIR-4020, design Part XIII §4),
// and the ACTIVE FILL IS A TOKEN THAT EXISTS (§3e).
//
// The control was doubly out of reach on the plan detail: the consumer passed no
// `locatable`, and the ladder behind it targeted `here` / `ready` nodes, which a
// proposal never is. It now walks the EMPHASISED set when one is supplied — one
// prop, so the ringed cards and the walked cards cannot drift into two answers —
// and the `here` / `ready` ladder is untouched for every consumer that supplies
// no emphasis, which is what keeps the roadmap, onboarding and the plan-change
// canvas byte-unchanged.

afterEach(() => cleanup());

const node = (
  id: string,
  label: string,
  flags: Partial<ProjectCanvasNode> = {},
): ProjectCanvasNode => ({
  id,
  parentId: null,
  searchText: label,
  crumbLabel: id,
  drillable: false,
  content: <div>{label}</div>,
  ...flags,
});

// LAYOUT ORDER is the order the level draws them in, and it is deliberately NOT
// the order the plan appended them: P3 sits between two committed siblings.
const level: RoadmapLevel = {
  nodes: [
    node('C1', 'A committed sibling', { ready: true }),
    node('P1', 'A proposal'),
    node('C2', 'Another sibling'),
    node('P3', 'An archived card'),
    node('P2', 'A modified card'),
  ],
  deps: [],
};

const EMPHASIS = {
  ids: ['P1', 'P2', 'P3'],
  total: 3,
  label: 'Show changes',
  emptyLabel: 'No proposed changes on this level',
  allLabel: 'Every item on this level is this plan’s',
  locateLabel: 'Locate the next of this plan’s items',
};

const locate = () => screen.getByTestId('locate-button');
const selected = () => document.querySelector('[data-node-id] [data-selected]')?.parentElement;

describe('the LOCATE control walks the emphasised set (Part XIII §4)', () => {
  const mount = () =>
    render(
      <ProjectRoadmapCanvas
        loadLevel={async () => level}
        rootLabel="Roadmap"
        locatable
        emphasis={EMPHASIS}
      />,
    );

  it('is enabled, and takes the consumer’s own word — not the shipped “ready” one', async () => {
    mount();
    await screen.findByText('A proposal');
    expect(locate().hasAttribute('disabled')).toBe(false);
    expect(locate().getAttribute('aria-label')).toBe('Locate the next of this plan’s items');
    // The shipped strings name a READY frontier, which a proposal never is —
    // the same defect class MOTIR-4021 fixed one control over.
    expect(locate().getAttribute('aria-label')).not.toContain('ready');
  });

  it('walks the plan’s cards in LAYOUT order, and WRAPS after the last', async () => {
    mount();
    await screen.findByText('A proposal');

    // Layout order is P1 · P3 · P2 — NOT the `ids` order the consumer passed
    // (P1 · P2 · P3), which is what proves the walk reads the level rather than
    // the prop. The reader is walking a picture; the walk moves as the eye does.
    for (const expected of ['P1', 'P3', 'P2', 'P1']) {
      fireEvent.click(locate());
      expect(selected()?.getAttribute('data-node-id')).toBe(expected);
    }
  });

  it('reads `n / m` over the LEVEL’s share, not the plan’s total', async () => {
    mount();
    await screen.findByText('A proposal');

    fireEvent.click(locate());
    expect(screen.getByTestId('locate-hint').textContent).toBe('1 / 3');
    fireEvent.click(locate());
    expect(screen.getByTestId('locate-hint').textContent).toBe('2 / 3');
    // The walk cannot reach an off-level card, and a hint counting past where the
    // control can go is a promise it does not keep. The OFF-level total is said
    // once, by the Show-changes control's own `n of m` (Part IX §L5).
  });

  it('is DISABLED, with the emphasis control’s own reason, on a level the plan does not reach', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={async () => level}
        rootLabel="Roadmap"
        locatable
        emphasis={{ ...EMPHASIS, ids: [] }}
      />,
    );
    await screen.findByText('A proposal');
    expect(locate().hasAttribute('disabled')).toBe(true);
    // ONE sentence per situation: the same string the Show-changes control says,
    // rather than a second wording for the same fact.
    expect(locate().getAttribute('title')).toBe('No proposed changes on this level');
  });

  it('stays ENABLED on a level made entirely of the plan’s cards — where the EMPHASIS is disabled', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={async () => level}
        rootLabel="Roadmap"
        locatable
        emphasis={{ ...EMPHASIS, ids: ['C1', 'P1', 'C2', 'P3', 'P2'], total: 5 }}
      />,
    );
    await screen.findByText('A proposal');

    // The two controls fail on OPPOSITE degeneracies, and drawing them as one
    // rule would break the useful half: ringing every card says nothing, because
    // a ring means *this one and not that one*; walking every card says
    // something, because a walk means *this one, now this one*.
    expect(screen.getByTestId('show-changes-toggle').hasAttribute('disabled')).toBe(true);
    expect(locate().hasAttribute('disabled')).toBe(false);
  });
});

describe('every consumer that supplies NO emphasis keeps the `here` / `ready` ladder', () => {
  // The planning overlay's canvas before a plan is the one existing `locatable`
  // caller (`PlanReviewCanvas` with `prePlan`, MOTIR-11513), and this card
  // changes how targets are CHOSEN — so the untouched path is asserted by name.
  it('targets the ready node, and says the shipped words', async () => {
    render(<ProjectRoadmapCanvas loadLevel={async () => level} rootLabel="Roadmap" locatable />);
    await screen.findByText('A proposal');

    expect(locate().getAttribute('aria-label')).toBe('Locate the ready item');
    fireEvent.click(locate());
    expect(selected()?.getAttribute('data-node-id')).toBe('C1');
  });

  it('renders no emphasis toggle at all, so the arming cannot reach it', async () => {
    render(<ProjectRoadmapCanvas loadLevel={async () => level} rootLabel="Roadmap" locatable />);
    await screen.findByText('A proposal');
    expect(screen.queryByTestId('show-changes-toggle')).toBeNull();
  });
});

describe('the ACTIVE fill is a token that EXISTS (Part XIII §3e)', () => {
  const theme = readFileSync(join(process.cwd(), 'packages/design-system/theme.css'), 'utf8');

  it('names `--el-tint-lavender`, and that token is DEFINED', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={async () => level}
        rootLabel="Roadmap"
        emphasis={EMPHASIS}
      />,
    );
    await screen.findByText('A proposal');

    const toggle = screen.getByTestId('show-changes-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.className).toContain('bg-(--el-tint-lavender)');
    // ⚠️ The point of the card, asserted rather than assumed: the class names a
    // token the design system DECLARES. `--el-accent-soft` did not, so an
    // unresolved custom property was dropped as invalid and the pressed control
    // rendered with no background at all — measured `rgba(0, 0, 0, 0)`, under a
    // green build, with nothing red anywhere.
    expect(theme).toMatch(/^\s*--el-tint-lavender\s*:/m);
  });

  it('leaves NO reference to `--el-accent-soft` anywhere in the canvas', () => {
    const canvas = readFileSync(
      join(process.cwd(), 'components/planning/ProjectRoadmapCanvas.tsx'),
      'utf8',
    );
    // The comment explaining the retirement names it; a live class must not.
    expect(canvas).not.toContain('bg-(--el-accent-soft)');
    expect(theme).not.toMatch(/^\s*--el-accent-soft\s*:/m);
  });
});
