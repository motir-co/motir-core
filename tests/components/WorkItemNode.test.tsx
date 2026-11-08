// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  GhostAnchor,
  WorkItemNode,
  WorkItemStatusPill,
  type WorkItemNodeData,
} from '@/components/planning/WorkItemNode';

afterEach(() => cleanup());

const item: WorkItemNodeData = {
  id: 'T1',
  identifier: 'MOTIR-1194',
  title: 'Standalone work-item canvas component',
  kind: 'subtask',
  status: 'in_progress',
  assigneeName: 'Yue',
};

describe('WorkItemNode', () => {
  it('shows the identifier, title, status label, and assignee', () => {
    render(<WorkItemNode item={item} />);
    expect(screen.getByText('MOTIR-1194')).toBeTruthy();
    expect(screen.getByText('Standalone work-item canvas component')).toBeTruthy();
    expect(screen.getByText('In Progress')).toBeTruthy();
    expect(screen.getByText('Yue')).toBeTruthy();
  });

  it('has a fixed height so a long title cannot overlap the row below it', () => {
    const { container } = render(
      <WorkItemNode
        item={{ ...item, title: 'A very long title that would wrap to many lines '.repeat(4) }}
      />,
    );
    expect((container.firstChild as HTMLElement).style.height).toBe('124px');
  });

  it('shows the drill affordance only when drillable', () => {
    const { rerender } = render(<WorkItemNode item={item} drillable />);
    expect(screen.queryByTestId('drill-affordance')).toBeTruthy();
    rerender(<WorkItemNode item={item} drillable={false} />);
    expect(screen.queryByTestId('drill-affordance')).toBeNull();
  });

  it('flags an off-level blocked node "blocked elsewhere"', () => {
    render(<WorkItemNode item={item} crossBlocked />);
    const flag = screen.getByTestId('cross-blocked-flag');
    // The tag row shows the short label (MOTIR-10508); the sentence rides the name.
    expect(flag.textContent).toBe('blocked');
    expect(flag.getAttribute('aria-label')).toBe('blocked elsewhere');
  });

  it('SPRINT scope: the cross-blocked flag names the blocker ("blocker not in sprint"), not the card (MOTIR-1582)', () => {
    render(<WorkItemNode item={item} crossBlocked crossBlockedSprint />);
    const flag = screen.getByTestId('cross-blocked-flag');
    // Names the out-of-sprint blocker — distinct from the neutral node-membership
    // tag ("not in sprint"), which describes the card itself.
    expect(flag.getAttribute('aria-label')).toBe('blocker not in sprint');
    expect(flag.getAttribute('title')).toBe('blocker not in sprint');
  });

  // MOTIR-1362 — the card sits on the canvas's near-identical `--el-surface-soft`
  // background, so it MUST carry the crisp `--el-border` + a `--shadow-card` lift to
  // stay legible (the weak `border-soft` + `shadow-subtle` made cards vanish, esp. in
  // dark mode). Lock that so a future tweak can't quietly drop the contrast.
  it('renders the card with a crisp border + card shadow for canvas contrast', () => {
    const { container } = render(<WorkItemNode item={item} />);
    const card = container.querySelector('[data-node-state]') as HTMLElement;
    expect(card.className).toContain('border-(--el-border)');
    expect(card.className).not.toContain('border-(--el-border-soft)');
    expect(card.className).toContain('shadow-(--shadow-card)');
    expect(card.className).not.toContain('shadow-(--shadow-subtle)');
  });

  // Subtask 7.20.6 / MOTIR-1013 — the per-container PROGRESS meter.
  it('renders a progress meter on a container, with the done/total count + a11y', () => {
    render(
      <WorkItemNode item={{ ...item, assigneeName: null }} progress={{ done: 2, total: 6 }} />,
    );
    expect(screen.getByTestId('progress-meter')).toBeTruthy();
    expect(screen.getByText('2 / 6')).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuemax')).toBe('6');
    expect((bar.firstChild as HTMLElement).style.width).toBe('33%'); // 2/6 ≈ 33%
  });

  // Subtask 7.10.6 / MOTIR-894 — the "N of M verified" CI roll-up beside the meter.
  it('shows the CI-verified count beside the meter when > 0, and omits it otherwise', () => {
    const { rerender } = render(
      <WorkItemNode
        item={{ ...item, assigneeName: null }}
        progress={{ done: 2, total: 6, verified: 3 }}
      />,
    );
    expect(screen.getByText('2 / 6')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy(); // the verified badge count
    // Zero verified → no badge (only the done/total count renders).
    rerender(
      <WorkItemNode
        item={{ ...item, assigneeName: null }}
        progress={{ done: 2, total: 6, verified: 0 }}
      />,
    );
    expect(screen.queryByText('3')).toBeNull();
  });

  it('omits the meter for a leaf (no progress) or a zero-total container', () => {
    const { rerender } = render(<WorkItemNode item={{ ...item, assigneeName: null }} />);
    expect(screen.queryByTestId('progress-meter')).toBeNull();
    rerender(
      <WorkItemNode item={{ ...item, assigneeName: null }} progress={{ done: 0, total: 0 }} />,
    );
    expect(screen.queryByTestId('progress-meter')).toBeNull();
  });

  // Subtask 7.20.6 / MOTIR-1013 — the "you are here" current-position marker.
  it('marks the active node "you are here": the tab, its own status, aria-current=step', () => {
    const { container } = render(<WorkItemNode item={item} here />);
    // MOTIR-10630: You are here is the card's TAB, so the status pill stays.
    expect(screen.getByTestId('here-tab').textContent).toBe('You are here');
    expect(screen.getByText('In Progress')).toBeTruthy();
    const card = container.querySelector('[data-node-state]') as HTMLElement;
    expect(card.getAttribute('aria-current')).toBe('step');
    expect(card.className).toContain('border-(--el-accent)');
  });

  it('shows the status pill (no marker, no aria-current) when not active', () => {
    const { container } = render(<WorkItemNode item={item} />);
    expect(screen.getByText('In Progress')).toBeTruthy();
    expect(screen.queryByText('You are here')).toBeNull();
    expect(
      (container.querySelector('[data-node-state]') as HTMLElement).getAttribute('aria-current'),
    ).toBeNull();
  });

  // MOTIR-1422 — distinct, zoom-out-legible DONE + READY card styles (both carried in
  // the card body, not a 3px edge).
  it('styles a READY node with the whole-card mint wash + the "Ready" pill', () => {
    const { container } = render(<WorkItemNode item={{ ...item, status: 'todo' }} ready />);
    const card = container.querySelector('[data-node-state]') as HTMLElement;
    expect(card.getAttribute('data-node-state')).toBe('ready');
    expect(card.className).toContain('bg-(--el-tint-mint)');
    expect(screen.getByTestId('ready-pill')).toBeTruthy();
    expect(screen.queryByTestId('done-pill')).toBeNull();
  });

  it('styles a DONE node as a distinct sky-tint card + struck title + dark "Done" stamp', () => {
    const { container } = render(<WorkItemNode item={{ ...item, status: 'done' }} />);
    const card = container.querySelector('[data-node-state]') as HTMLElement;
    expect(card.getAttribute('data-node-state')).toBe('done');
    // a distinct palette-tint fill (--el-tint-sky), clearly different from white todo + mint ready
    expect(card.className).toContain('bg-(--el-tint-sky)');
    // a dark Done stamp (NOT the success-green ready treatment, NOT the light todo chip)
    expect(screen.getByTestId('done-pill')).toBeTruthy();
    expect(screen.queryByTestId('ready-pill')).toBeNull();
    expect(card.className).not.toContain('bg-(--el-tint-mint)');
    // the title is struck
    expect(screen.getByText(item.title).className).toContain('line-through');
  });

  it('keeps done and ready DISTINCT (mint vs sky)', () => {
    const { container: r } = render(<WorkItemNode item={{ ...item, status: 'todo' }} ready />);
    const { container: d } = render(<WorkItemNode item={{ ...item, status: 'done' }} />);
    const ready = r.querySelector('[data-node-state]') as HTMLElement;
    const done = d.querySelector('[data-node-state]') as HTMLElement;
    expect(ready.getAttribute('data-node-state')).not.toBe(done.getAttribute('data-node-state'));
    expect(ready.className).toContain('bg-(--el-tint-mint)'); // ready advances (mint)
    expect(done.className).toContain('bg-(--el-tint-sky)'); // done is a distinct tint
  });

  it('keeps done DISTINCT from a plain todo card (sky tint vs white surface)', () => {
    const { container: t } = render(<WorkItemNode item={{ ...item, status: 'todo' }} />);
    const { container: d } = render(<WorkItemNode item={{ ...item, status: 'done' }} />);
    const todo = t.querySelector('[data-node-state]') as HTMLElement;
    const done = d.querySelector('[data-node-state]') as HTMLElement;
    expect(todo.className).toContain('bg-(--el-surface)'); // raised white card
    expect(done.className).toContain('bg-(--el-tint-sky)'); // a distinct tint, not white
    expect(done.className).not.toContain('bg-(--el-surface)'); // not the same fill as todo
  });

  it('the accent "you are here" frontier wins the done FRAME; the slot still says Done', () => {
    const { container } = render(<WorkItemNode item={{ ...item, status: 'done' }} here />);
    const card = container.querySelector('[data-node-state]') as HTMLElement;
    expect(card.getAttribute('data-node-state')).toBe('here');
    expect(screen.getByTestId('here-tab')).toBeTruthy();
    // MOTIR-10630: the slot is the item's own, so a done here card wears the stamp…
    expect(screen.getByTestId('done-pill')).toBeTruthy();
    // …while the frame (fill and the struck title) stays the here card's.
    expect(card.className).not.toContain('bg-(--el-tint-sky)');
    expect(screen.getByText(item.title).className).not.toContain('line-through');
  });

  it('the red cross-blocked flag wins over the done style', () => {
    const { container } = render(<WorkItemNode item={{ ...item, status: 'done' }} crossBlocked />);
    const card = container.querySelector('[data-node-state]') as HTMLElement;
    expect(card.getAttribute('data-node-state')).toBe('cross-blocked');
    expect(screen.getByTestId('cross-blocked-flag')).toBeTruthy();
    expect(card.className).not.toContain('bg-(--el-tint-sky)');
  });
});

describe('GhostAnchor', () => {
  it('names the off-level blocker and where it lives', () => {
    render(
      <GhostAnchor identifier="PROD-42" title="Migrate tokens" parentTitle="Auth hardening" />,
    );
    expect(screen.getByText('PROD-42')).toBeTruthy();
    expect(screen.getByText('Migrate tokens')).toBeTruthy();
    expect(screen.getByText('in Auth hardening ↗')).toBeTruthy();
  });

  // MOTIR-1581 — the anchor is the only variable-height node on the roadmap. The
  // deterministic layout spaces every row by NODE_H, so the anchor MUST honour the
  // same fixed-box contract WorkItemNode does: a long parent-story title cannot be
  // allowed to grow the box past NODE_H and overlap the card in the row below it.
  it('has a fixed height + clipped box so a long parent title cannot overlap the row below it', () => {
    const { container } = render(
      <GhostAnchor
        identifier="PROD-42"
        title="Migrate design tokens to the new element-semantic swap layer"
        parentTitle={'A very long parent story title that would wrap to many lines '.repeat(3)}
      />,
    );
    const box = container.firstChild as HTMLElement;
    expect(box.style.height).toBe('124px');
    expect(box.className).toContain('overflow-hidden');
    // the un-clamped parent-title line was the unbounded-growth source — it must clamp
    expect(screen.getByText(/in A very long parent story title/).className).toContain(
      'line-clamp-1',
    );
  });

  // FILED BLOCKER (Bug MOTIR-5710 · MOTIR-5739, design sheet 7): the location line
  // names the blocker's FOLDER path in place of its parent.
  it('names a filed blocker’s folder path instead of its parent', () => {
    render(
      <GhostAnchor
        identifier="PROD-42"
        title="Migrate tokens"
        parentTitle="Auth hardening"
        folderPath={['Bugs']}
      />,
    );
    const line = screen.getByTestId('anchor-folder');
    expect(line.textContent).toContain('Folder: Bugs');
    expect(screen.queryByText('in Auth hardening ↗')).toBeNull();
  });

  it('keeps the parent line for an unfiled blocker', () => {
    render(<GhostAnchor identifier="PROD-42" parentTitle="Auth hardening" folderPath={null} />);
    expect(screen.queryByTestId('anchor-folder')).toBeNull();
    expect(screen.getByText('in Auth hardening ↗')).toBeTruthy();
  });

  it('collapses a path deeper than two to its first and last folder, full path in the title', () => {
    render(<GhostAnchor identifier="PROD-42" folderPath={['Archive', '2025', 'Q3', 'Imports']} />);
    const label = screen.getByTestId('folder-path');
    expect(label.getAttribute('title')).toBe('Archive ▸ 2025 ▸ Q3 ▸ Imports');
    const shown = label.querySelector('[aria-hidden="true"]:last-child')?.textContent ?? '';
    expect(shown).toContain('Archive');
    expect(shown).toContain('…');
    expect(shown).toContain('Imports');
    expect(shown).not.toContain('2025');
  });

  it('sprint scope keeps its own verdict over the folder line', () => {
    render(<GhostAnchor identifier="PROD-42" folderPath={['Bugs']} outOfSprint />);
    expect(screen.queryByTestId('anchor-folder')).toBeNull();
  });
});

// MANUAL / HUMAN work-type chip (MOTIR-1642 / 8.8.36) — a human-gated node carries
// a "Manual" chip (the shipped WorkItemTypeChip) on the tag row, after the status
// slot (MOTIR-10508 moved it there from the body id line); an agent node does not.
// The gate is the shipped `isManualReadyItem` predicate
// (`executor === 'human' || type === 'manual'`).
describe('WorkItemNode — manual / human work-type chip (MOTIR-1642)', () => {
  it('renders the Manual chip for a type:manual node', () => {
    render(<WorkItemNode item={{ ...item, type: 'manual', executor: 'human' }} />);
    expect(screen.getByText('Manual')).toBeTruthy();
  });

  it('renders the Manual chip for a human-executor node even when the type is not manual', () => {
    render(<WorkItemNode item={{ ...item, type: 'deploy', executor: 'human' }} />);
    expect(screen.getByText('Manual')).toBeTruthy();
  });

  it('does NOT render the Manual chip for an agent (type:code) node', () => {
    render(<WorkItemNode item={{ ...item, type: 'code', executor: 'coding_agent' }} />);
    expect(screen.queryByText('Manual')).toBeNull();
  });

  it('does NOT render the Manual chip when type/executor are absent (onboarding / plan-preview node)', () => {
    render(<WorkItemNode item={item} />);
    expect(screen.queryByText('Manual')).toBeNull();
  });

  it('keeps the Manual chip on a done node (composes with the state chrome)', () => {
    render(<WorkItemNode item={{ ...item, status: 'done', type: 'manual', executor: 'human' }} />);
    // the done chrome strikes the title but the chip still shows
    expect(screen.getByText('Manual')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
  });
});

// ── THE STATUS CHIP (bug MOTIR-3170) ────────────────────────────────────────
//
// The node used to type `status` as a CLOSED six-member union with a
// `Record<WorkItemStatus, StatusMeta>` beside it. That reads as total and is
// not: the union IS the hand-authored subset, so the compiler certified a map
// that had no row for `implemented` (MOTIR-3003) or `planning` (MOTIR-2425),
// and every producer narrowed to it by coercing the rest to `todo`. The chip
// then rendered `CircleDashed` + "To Do" on a card whose pull request was open.
//
// These assert on RENDERED TEXT, never on the resolver's map — a test that read
// the map would have passed at every point in that history.
describe('WorkItemNode — the status chip (bug MOTIR-3170)', () => {
  const at = (status: string, over: Partial<WorkItemNodeData> = {}): WorkItemNodeData => ({
    ...item,
    assigneeName: null,
    status,
    ...over,
  });

  it('renders `implemented` as "Implemented", not "To Do"', () => {
    render(<WorkItemNode item={at('implemented', { statusCategory: 'in_progress' })} />);
    expect(screen.getByText('Implemented')).toBeTruthy();
    expect(screen.queryByText('To Do')).toBeNull();
  });

  it('renders `planning` as "Planning", not "To Do"', () => {
    render(<WorkItemNode item={at('planning', { statusCategory: 'in_progress' })} />);
    expect(screen.getByText('Planning')).toBeTruthy();
    expect(screen.queryByText('To Do')).toBeNull();
  });

  it("a status in NO map renders its OWN label in its category's tone — never To Do", () => {
    // A custom workflow's own status. The canvas has no per-key treatment for it
    // and must not invent one; it takes the category's chip and its own name.
    const { container } = render(
      <WorkItemNode
        item={at('awaiting_legal', { statusLabel: 'Awaiting legal', statusCategory: 'todo' })}
      />,
    );
    expect(screen.getByText('Awaiting legal')).toBeTruthy();
    expect(screen.queryByText('To Do')).toBeNull();
    // The `todo` category's tone is the receded neutral chip — the same one
    // `todo` itself draws, which is the point of a category fallback.
    const chip = container.querySelector('[data-status="awaiting_legal"]') as HTMLElement;
    expect(chip.className).toContain('bg-(--el-muted)');
  });

  it("an in_progress-category custom status takes THAT category's tone, not the neutral one", () => {
    const { container } = render(
      <WorkItemNode
        item={at('awaiting_vendor', {
          statusLabel: 'Awaiting vendor',
          statusCategory: 'in_progress',
        })}
      />,
    );
    expect(screen.getByText('Awaiting vendor')).toBeTruthy();
    const chip = container.querySelector('[data-status="awaiting_vendor"]') as HTMLElement;
    expect(chip.className).toContain('bg-(--el-tint-sky)');
  });

  it('does not crash on a status with NEITHER a key treatment NOR a category', () => {
    // The degrade of last resort: a row pointing at a status the project's
    // workflow no longer holds. It renders the key it has rather than throwing
    // on a missing map row (the old `STATUS_META[status]` would have).
    const { container } = render(<WorkItemNode item={at('ghost_status')} />);
    expect(screen.getByText('ghost_status')).toBeTruthy();
    const chip = container.querySelector('[data-status="ghost_status"]') as HTMLElement;
    expect(chip.className).toContain('bg-(--el-muted)');
  });

  it('a DEFAULT status is named from the localized catalog, not from the wire label', () => {
    // Protected default statuses cannot be renamed, so their canonical label is
    // translated by key — the shipped rule (`IssueFilterBar`, the advanced-filter
    // editor + summary). Reading the workflow row first would regress every
    // default status to English under `zh`.
    render(<WorkItemNode item={at('in_review', { statusLabel: 'WHATEVER THE ROW SAYS' })} />);
    expect(screen.getByText('In Review')).toBeTruthy();
    expect(screen.queryByText('WHATEVER THE ROW SAYS')).toBeNull();
  });

  it('the six statuses that rendered before render EXACTLY as they did', () => {
    // The regression half. Labels + fills are compared across the whole set that
    // shipped, so the widening cannot have quietly re-skinned one of them.
    const expected: Array<[string, string, string]> = [
      ['todo', 'To Do', 'bg-(--el-muted)'],
      ['in_progress', 'In Progress', 'bg-(--el-tint-sky)'],
      ['in_review', 'In Review', 'bg-(--el-tint-lavender)'],
      ['blocked', 'Blocked', 'bg-(--el-tint-peach)'],
      ['done', 'Done', 'bg-(--el-tint-mint)'],
      ['cancelled', 'Cancelled', 'bg-(--el-muted)'],
    ];
    for (const [key, label, fill] of expected) {
      // `done` swaps the chip for the solid "Done" stamp on the card itself
      // (MOTIR-1422), so the pill is asserted through the shared component the
      // way `PlanItemNode` mounts it — one chip, one resolver, both surfaces.
      const { container, unmount } = render(<WorkItemStatusPill status={key} />);
      const chip = container.querySelector(`[data-status="${key}"]`) as HTMLElement;
      expect(chip.textContent).toBe(label);
      expect(chip.className).toContain(fill);
      unmount();
    }
  });

  it('the two new statuses take DISTINCT fills — no chip impersonates another', () => {
    const fillOf = (key: string) => {
      const { container, unmount } = render(<WorkItemStatusPill status={key} />);
      const cls = (container.querySelector(`[data-status="${key}"]`) as HTMLElement).className;
      const fill = /bg-\(--el-[a-z-]+\)/.exec(cls)?.[0] ?? '';
      unmount();
      return fill;
    };
    const implemented = fillOf('implemented');
    const planning = fillOf('planning');
    expect(implemented).not.toBe(planning);
    for (const other of ['todo', 'in_progress', 'in_review', 'blocked', 'done']) {
      expect(fillOf(other)).not.toBe(implemented);
      expect(fillOf(other)).not.toBe(planning);
    }
  });
});
