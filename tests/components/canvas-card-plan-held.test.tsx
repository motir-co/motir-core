// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// THE CANVAS CARD OF A STORY HELD OUT OF PLANNING (MOTIR-11546). A childless story
// blocked by an unfinished story with no subtasks yet can't be planned — the
// planner holds it and the Plan button refuses it — so the card stops inviting
// the click: no To plan pill, no yellow wash, no Plan button. It shows as blocked,
// as a story with children would: its status chip in the slot and, unless that
// status is the Blocked status itself, the shared blocked flag the board card
// draws. The red blocked-elsewhere flag, when the card carries it, says it already.
vi.mock('next/navigation', () => ({
  usePathname: () => '/roadmap',
  useSearchParams: () => new URLSearchParams('scope=project'),
}));

const { WorkItemNode } = await import('@/components/planning/WorkItemNode');
type WorkItemNodeData = import('@/components/planning/WorkItemNode').WorkItemNodeData;

afterEach(cleanup);

const ON = { plan: true } as const;

const held: WorkItemNodeData = {
  id: 'S1',
  identifier: 'MOTIR-11546',
  title: 'Export a sprint report as a PDF the team can attach to a retro',
  kind: 'story',
  status: 'todo',
  statusLabel: 'To Do',
  statusCategory: 'todo',
  hasChildren: false,
  planHeld: true,
};

function frame(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-node-state]') as HTMLElement;
}

describe('a held story on the roadmap canvas', () => {
  it('wears no To plan pill or wash, and offers no Plan button', () => {
    const { container } = render(<WorkItemNode item={held} nextActions={ON} />);
    const card = frame(container);
    expect(card.getAttribute('data-node-state')).toBe('normal');
    expect(card.className).not.toContain('bg-(--el-tint-yellow)');
    expect(screen.queryByTestId('to-plan-pill')).toBeNull();
    expect(screen.queryByTestId('node-next-action')).toBeNull();
  });

  it('shows its status chip, as a glyph, beside the shared blocked flag', () => {
    const { container } = render(<WorkItemNode item={held} />);
    const chip = container.querySelector<HTMLElement>('[data-status="todo"]');
    expect(chip).not.toBeNull();
    // The give-way rule: a right-hand text tag drops the slot to its glyph.
    expect(chip?.getAttribute('role')).toBe('img');
    expect(chip?.getAttribute('aria-label')).toBe('To Do');
    const flag = screen.getByTestId('cross-blocked-flag');
    // The board card's flag: the readiness sentence, not "blocked elsewhere".
    expect(flag.getAttribute('aria-label')).toBe('Blocked');
    expect(flag.textContent).toBe('blocked');
  });

  it('a held story in the Blocked status shows its Blocked chip and no second flag', () => {
    const { container } = render(
      <WorkItemNode item={{ ...held, status: 'blocked', statusLabel: 'Blocked' }} />,
    );
    const chip = container.querySelector<HTMLElement>('[data-status="blocked"]');
    expect(chip?.textContent).toContain('Blocked');
    expect(screen.queryByTestId('cross-blocked-flag')).toBeNull();
  });

  it('blocked elsewhere keeps its own red flag and frame — the card never wears two flags', () => {
    const { container } = render(<WorkItemNode item={held} crossBlocked nextActions={ON} />);
    expect(frame(container).getAttribute('data-node-state')).toBe('cross-blocked');
    // Its red flag is the top-edge blocked TAB (MOTIR-12158), and the held flag
    // does not join it in the row.
    expect(screen.getAllByTestId('blocked-tab')).toHaveLength(1);
    expect(screen.getByTestId('blocked-tab').getAttribute('aria-label')).toBe('blocked elsewhere');
    expect(screen.queryByTestId('cross-blocked-flag')).toBeNull();
    expect(screen.queryByTestId('to-plan-pill')).toBeNull();
    expect(screen.queryByTestId('node-next-action')).toBeNull();
  });

  it('released (not held) the same story is To plan again, with its Plan button', () => {
    const { container } = render(
      <WorkItemNode item={{ ...held, planHeld: false }} nextActions={ON} />,
    );
    expect(frame(container).getAttribute('data-node-state')).toBe('to-plan');
    expect(screen.getByTestId('to-plan-pill')).toBeTruthy();
    expect(screen.queryByTestId('cross-blocked-flag')).toBeNull();
    expect(screen.getByTestId('node-next-action').getAttribute('data-action')).toBe('plan');
  });

  it('a held story that has started and has children wears no blocked flag', () => {
    const { container } = render(
      <WorkItemNode
        item={{
          ...held,
          status: 'in_progress',
          statusLabel: 'In Progress',
          statusCategory: 'in_progress',
          hasChildren: true,
        }}
      />,
    );
    expect(screen.queryByTestId('cross-blocked-flag')).toBeNull();
    const chip = container.querySelector<HTMLElement>('[data-status="in_progress"]');
    expect(chip?.textContent).toContain('In Progress');
  });

  it('a held story that is Done keeps its Done state and wears no blocked flag', () => {
    const { container } = render(
      <WorkItemNode
        item={{ ...held, status: 'done', statusLabel: 'Done', statusCategory: 'done' }}
      />,
    );
    expect(frame(container).getAttribute('data-node-state')).toBe('done');
    expect(screen.queryByTestId('cross-blocked-flag')).toBeNull();
  });

  it('an epic is never held: planHeld on an epic changes nothing', () => {
    render(<WorkItemNode item={{ ...held, kind: 'epic', planHeld: false }} />);
    expect(screen.getByTestId('to-plan-pill')).toBeTruthy();
  });
});
