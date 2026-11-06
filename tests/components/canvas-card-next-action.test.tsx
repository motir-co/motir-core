// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// THE CANVAS CARD, RE-LAID (MOTIR-10509; design MOTIR-10508,
// `design/roadmap/roadmap--canvas-card-tag-row.mock.html`): the tag row, the
// title-only body, the To plan story and the hover next-action button.
//
// The Plan button opens the planning overlay through the shipped launcher
// (`useOpenPlanningWorkspace`), which reads the address — so `next/navigation`
// is mocked, and `shallowPush` is spied to see the overlay address it writes.
const pathname = '/roadmap';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams('scope=project'),
}));
const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/navigation/shallowUrl')>()),
  shallowPush,
}));

const { WorkItemNode, WorkItemCardShell, cardNextAction, isToPlanStory } =
  await import('@/components/planning/WorkItemNode');
const { ToastProvider } = await import('@/components/ui/Toast');
const { withPlanningOverlay } = await import('@/lib/planning/launcher');
type WorkItemNodeData = import('@/components/planning/WorkItemNode').WorkItemNodeData;

const writeText = vi.fn(async (_text: string) => {});
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});
afterEach(() => {
  cleanup();
  writeText.mockClear();
  shallowPush.mockClear();
  vi.useRealTimers();
});

const ON = { plan: true } as const;

const leaf: WorkItemNodeData = {
  id: 'T1',
  identifier: 'MOTIR-10509',
  title: 'Build the redesigned roadmap canvas card',
  kind: 'task',
  status: 'todo',
  statusCategory: 'todo',
  type: 'code',
  executor: 'coding_agent',
  hasChildren: false,
  fixReason: null,
};

const story: WorkItemNodeData = {
  id: 'S1',
  identifier: 'MOTIR-10520',
  title: 'Export a sprint report as a PDF the team can attach to a retro',
  kind: 'story',
  status: 'todo',
  statusCategory: 'todo',
  hasChildren: false,
};

function frame(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-node-state]') as HTMLElement;
}
function nextAction(): HTMLElement | null {
  return screen.queryByTestId('node-next-action');
}

describe('cardNextAction — the state → action table (MOTIR-10508)', () => {
  const base = {
    toPlan: false,
    fixReason: null,
    status: 'todo',
    ready: false,
    manual: false,
    options: ON,
  } as const;

  it('offers nothing without the opt-in (every canvas but the roadmap page, a Visitor)', () => {
    expect(cardNextAction({ ...base, ready: true, options: null })).toBeNull();
    expect(cardNextAction({ ...base, toPlan: true, options: undefined })).toBeNull();
  });

  it('To plan → Plan, and only when the reader may plan', () => {
    expect(cardNextAction({ ...base, toPlan: true })).toEqual({ kind: 'plan' });
    expect(cardNextAction({ ...base, toPlan: true, options: { plan: false } })).toBeNull();
  });

  it('To plan wins over every copy row', () => {
    expect(
      cardNextAction({
        ...base,
        toPlan: true,
        fixReason: 'ci_failed',
        status: 'in_review',
        ready: true,
      }),
    ).toEqual({ kind: 'plan' });
  });

  it('a ci_failed / changes_requested fix reason copies motir fix, and wins over In Review', () => {
    expect(cardNextAction({ ...base, fixReason: 'ci_failed', status: 'implemented' })).toEqual({
      kind: 'copy',
      verb: 'fix',
      reason: 'ci_failed',
    });
    expect(
      cardNextAction({ ...base, fixReason: 'changes_requested', status: 'in_review' }),
    ).toEqual({ kind: 'copy', verb: 'fix', reason: 'changes_requested' });
  });

  it('any other fix reason falls through to the rows below', () => {
    expect(cardNextAction({ ...base, fixReason: 'conflicted', status: 'in_review' })).toEqual({
      kind: 'copy',
      verb: 'review',
      reason: null,
    });
    expect(cardNextAction({ ...base, fixReason: 'run_died', status: 'in_progress' })).toBeNull();
  });

  it('In Review copies motir review', () => {
    expect(cardNextAction({ ...base, status: 'in_review' })).toEqual({
      kind: 'copy',
      verb: 'review',
      reason: null,
    });
  });

  it('Ready copies motir run — never on a manual card', () => {
    expect(cardNextAction({ ...base, ready: true })).toEqual({
      kind: 'copy',
      verb: 'run',
      reason: null,
    });
    expect(cardNextAction({ ...base, ready: true, manual: true })).toBeNull();
  });

  it('anything else draws no button', () => {
    expect(cardNextAction({ ...base, status: 'in_progress' })).toBeNull();
    expect(cardNextAction({ ...base, status: 'done' })).toBeNull();
  });
});

describe('isToPlanStory', () => {
  it('is a story KNOWN to have no children, in a todo-category status', () => {
    expect(isToPlanStory(story)).toBe(true);
    // A custom todo-category status counts — the rule is the category.
    expect(isToPlanStory({ ...story, status: 'blocked', statusCategory: 'todo' })).toBe(true);
  });

  it('is not a story with children, nor one whose children are unknown', () => {
    expect(isToPlanStory({ ...story, hasChildren: true })).toBe(false);
    expect(isToPlanStory({ ...story, hasChildren: undefined })).toBe(false);
  });

  it('is not an In Progress or Done childless story', () => {
    expect(isToPlanStory({ ...story, status: 'in_progress', statusCategory: 'in_progress' })).toBe(
      false,
    );
    expect(isToPlanStory({ ...story, status: 'done', statusCategory: 'done' })).toBe(false);
  });

  it('is never a task, a bug or an epic', () => {
    expect(isToPlanStory({ ...story, kind: 'task' })).toBe(false);
    expect(isToPlanStory({ ...story, kind: 'epic' })).toBe(false);
  });

  it('falls back to the default todo key when the category did not travel', () => {
    expect(isToPlanStory({ ...story, statusCategory: null })).toBe(true);
    expect(isToPlanStory({ ...story, status: 'custom', statusCategory: null })).toBe(false);
  });
});

describe('the To plan state and its precedence', () => {
  it('a childless todo story wears the To plan pill and the yellow wash', () => {
    const { container } = render(<WorkItemNode item={story} />);
    const card = frame(container);
    expect(card.getAttribute('data-node-state')).toBe('to-plan');
    expect(card.className).toContain('bg-(--el-tint-yellow)');
    expect(card.className).toContain('shadow-(--shadow-card)');
    const pill = screen.getByTestId('to-plan-pill');
    expect(pill.textContent).toBe('To plan');
    expect(pill.getAttribute('title')).toBe('To plan');
  });

  it('To plan wins over Ready: the yellow wash, the To plan pill, no Ready pill', () => {
    const { container } = render(<WorkItemNode item={story} ready />);
    expect(frame(container).getAttribute('data-node-state')).toBe('to-plan');
    expect(screen.queryByTestId('ready-pill')).toBeNull();
    expect(screen.getByTestId('to-plan-pill')).toBeTruthy();
  });

  it('blocked elsewhere wins the frame; the To plan pill keeps the slot as its glyph', () => {
    const { container } = render(<WorkItemNode item={story} crossBlocked />);
    const card = frame(container);
    expect(card.getAttribute('data-node-state')).toBe('cross-blocked');
    expect(card.className).toContain('border-(--el-danger)');
    const pill = screen.getByTestId('to-plan-pill');
    expect(pill.getAttribute('role')).toBe('img');
    expect(pill.getAttribute('aria-label')).toBe('To plan');
    expect(pill.textContent).toBe('');
  });

  it('You are here wins the frame AND the slot', () => {
    const { container } = render(<WorkItemNode item={story} here />);
    expect(frame(container).getAttribute('data-node-state')).toBe('here');
    expect(screen.queryByTestId('to-plan-pill')).toBeNull();
    expect(screen.getByText('You are here')).toBeTruthy();
  });

  it('not in sprint keeps its dotted edge over the yellow wash and drops the shadow', () => {
    const { container } = render(<WorkItemNode item={story} notInSprint />);
    const card = frame(container);
    expect(card.getAttribute('data-node-state')).toBe('to-plan');
    expect(card.className).toContain('border-dotted');
    expect(card.className).toContain('bg-(--el-tint-yellow)');
    expect(card.className).not.toContain('shadow-(--shadow-card)');
  });

  it('a story with children is not To plan', () => {
    const { container } = render(<WorkItemNode item={{ ...story, hasChildren: true }} />);
    expect(frame(container).getAttribute('data-node-state')).toBe('normal');
    expect(screen.queryByTestId('to-plan-pill')).toBeNull();
  });

  it('the Plan button appears in every To plan case, blocked and here included', () => {
    for (const props of [{}, { crossBlocked: true }, { here: true }, { notInSprint: true }]) {
      render(<WorkItemNode item={story} nextActions={ON} {...props} />);
      expect(nextAction()?.getAttribute('data-action')).toBe('plan');
      cleanup();
    }
  });
});

describe('the tag row and the give-way rule', () => {
  it('carries the tile, the identifier, the status pill and the Manual chip on ONE row', () => {
    const { container } = render(
      <WorkItemNode item={{ ...leaf, type: 'manual', executor: 'human' }} />,
    );
    const row = frame(container).firstElementChild as HTMLElement;
    expect(row.className).toContain('min-w-0');
    expect(row.textContent).toContain('MOTIR-10509');
    expect(row.textContent).toContain('To Do');
    expect(row.textContent).toContain('Manual');
    // The body carries the title alone.
    const body = row.nextElementSibling as HTMLElement;
    expect(body.textContent).toBe(leaf.title);
  });

  it('with no right-hand text tag everything shows in full, the status name on its title', () => {
    render(
      <WorkItemNode item={{ ...leaf, status: 'in_progress', statusCategory: 'in_progress' }} />,
    );
    const pill = document.querySelector('[data-status="in_progress"]') as HTMLElement;
    expect(pill.getAttribute('title')).toBe('In Progress');
    expect(pill.querySelector('.truncate')?.textContent).toBe('In Progress');
    expect(pill.getAttribute('role')).toBeNull();
  });

  it('a right-hand text tag drops the status pill and the Manual chip to their glyphs', () => {
    render(<WorkItemNode item={{ ...leaf, type: 'manual', executor: 'human' }} notInSprint />);
    const pill = document.querySelector('[data-status="todo"]') as HTMLElement;
    expect(pill.getAttribute('role')).toBe('img');
    expect(pill.getAttribute('aria-label')).toBe('To Do');
    expect(pill.textContent).toBe('');
    const manual = screen.getByRole('img', { name: 'Manual' });
    expect(manual.getAttribute('title')).toBe('Manual');
    expect(manual.textContent).toBe('');
    expect(screen.getByTestId('not-in-sprint-tag').className).toContain('text-[11px]');
  });

  it('the blocked flag shows the short label; its full sentence rides title and aria-label', () => {
    render(<WorkItemNode item={leaf} crossBlocked />);
    const flag = screen.getByTestId('cross-blocked-flag');
    expect(flag.textContent).toBe('blocked');
    expect(flag.getAttribute('aria-label')).toBe('blocked elsewhere');
    expect(flag.getAttribute('title')).toBe('blocked elsewhere');
    expect(flag.className).toContain('px-(--spacing-chip-x-6)');
    // The visible label is aria-hidden, so the sentence must be a name a screen
    // reader reads: `aria-label` on a generic span is prohibited, on role=img it is not.
    expect(screen.getByRole('img', { name: 'blocked elsewhere' })).toBe(flag);
  });

  it('the right cluster is rendered only when it holds something', () => {
    const { container } = render(<WorkItemNode item={leaf} />);
    expect(frame(container).querySelector('.ml-auto')).toBeNull();
  });

  it('the title clamps at three lines with no footer and two with one', () => {
    const { rerender } = render(<WorkItemNode item={leaf} />);
    expect(document.querySelector('[data-node-title]')!.className).toContain('line-clamp-3');
    rerender(<WorkItemNode item={{ ...leaf, assigneeName: 'Mo' }} />);
    expect(document.querySelector('[data-node-title]')!.className).toContain('line-clamp-2');
  });

  it('the shell sets the action beside the frame, outside its overflow-hidden', () => {
    const { container } = render(
      <WorkItemCardShell
        frameClassName="bg-(--el-surface)"
        statusRow={null}
        kind="task"
        identifier="MOTIR-1"
        title="t"
        action={<button type="button">act</button>}
      />,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('relative');
    expect(wrapper.style.height).toBe('124px');
    const [cardFrame, act] = [...wrapper.children] as HTMLElement[];
    expect(cardFrame!.className).toContain('overflow-hidden');
    expect(act!.textContent).toBe('act');
  });
});

describe('the next-action button', () => {
  it('draws nothing without the opt-in', () => {
    render(<WorkItemNode item={leaf} ready />);
    expect(nextAction()).toBeNull();
  });

  it('a ready, non-manual card copies motir run, with the success toast and a Check for 2s', async () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <WorkItemNode item={leaf} ready nextActions={ON} />
      </ToastProvider>,
    );
    const button = nextAction()!;
    expect(button.getAttribute('data-action')).toBe('run');
    expect(button.getAttribute('aria-label')).toBe('Copy motir run MOTIR-10509');
    expect(button.textContent).toBe('motir run');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith('motir run MOTIR-10509');
    expect(screen.getByText('Copied')).toBeTruthy();
    expect(screen.getByText('Paste motir run MOTIR-10509 into your terminal.')).toBeTruthy();
    expect(button.getAttribute('data-copied')).toBe('true');
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(button.getAttribute('data-copied')).toBeNull();
  });

  it('a refused clipboard shows the copy-failed toast, and no success or Check', async () => {
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
    render(
      <ToastProvider>
        <WorkItemNode item={leaf} ready nextActions={ON} />
      </ToastProvider>,
    );
    const button = nextAction()!;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(
      screen.getByText("Couldn't copy — select the command and copy it manually."),
    ).toBeTruthy();
    expect(screen.queryByText('Copied')).toBeNull();
    expect(button.getAttribute('data-copied')).toBeNull();
  });

  it('a manual ready card gets no button', () => {
    render(
      <WorkItemNode item={{ ...leaf, type: 'manual', executor: 'human' }} ready nextActions={ON} />,
    );
    expect(nextAction()).toBeNull();
  });

  it('an In Review card copies motir review', async () => {
    render(
      <WorkItemNode
        item={{ ...leaf, status: 'in_review', statusCategory: 'in_progress' }}
        nextActions={ON}
      />,
    );
    const button = nextAction()!;
    expect(button.getAttribute('data-action')).toBe('review');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith('motir review MOTIR-10509');
  });

  it('a ci_failed / changes_requested card copies motir fix', async () => {
    render(
      <WorkItemNode
        item={{
          ...leaf,
          status: 'in_review',
          statusCategory: 'in_progress',
          fixReason: 'changes_requested',
        }}
        nextActions={ON}
      />,
    );
    const button = nextAction()!;
    expect(button.getAttribute('data-action')).toBe('fix');
    expect(button.getAttribute('aria-label')).toBe('Copy motir fix MOTIR-10509');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith('motir fix MOTIR-10509');
  });

  it('any other card shows no button', () => {
    render(
      <WorkItemNode
        item={{ ...leaf, status: 'in_progress', statusCategory: 'in_progress' }}
        nextActions={ON}
      />,
    );
    expect(nextAction()).toBeNull();
  });

  it('a To plan card opens the planning overlay with that card as the target', () => {
    render(<WorkItemNode item={story} nextActions={ON} />);
    const button = nextAction()!;
    expect(button.getAttribute('data-action')).toBe('plan');
    expect(button.getAttribute('aria-label')).toBe('Plan MOTIR-10520');
    expect(button.textContent).toBe('Plan');
    fireEvent.click(button, { button: 0 });
    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush).toHaveBeenCalledWith(
      withPlanningOverlay('/roadmap?scope=project', {
        kind: 'work-item',
        itemKey: 'MOTIR-10520',
        hasPlan: false,
      }),
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it('a To plan card shows no button when the reader may not plan', () => {
    render(<WorkItemNode item={story} nextActions={{ plan: false }} />);
    expect(nextAction()).toBeNull();
  });

  it('pressing it neither drills, selects nor drags the node beneath it', async () => {
    const onPointerDown = vi.fn();
    const onClick = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <div onPointerDown={onPointerDown} onClick={onClick} onKeyDown={onKeyDown}>
        <WorkItemNode item={leaf} ready nextActions={ON} />
      </div>,
    );
    const button = nextAction()!;
    fireEvent.pointerDown(button);
    await act(async () => {
      fireEvent.click(button);
    });
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.keyUp(button, { key: 'Enter' });
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('the Plan press does not reach the node either', () => {
    const onClick = vi.fn();
    const onPointerDown = vi.fn();
    render(
      <div onClick={onClick} onPointerDown={onPointerDown}>
        <WorkItemNode item={story} nextActions={ON} />
      </div>,
    );
    const button = nextAction()!;
    fireEvent.pointerDown(button);
    fireEvent.click(button, { button: 0 });
    expect(onClick).not.toHaveBeenCalled();
    expect(onPointerDown).not.toHaveBeenCalled();
  });

  it('is revealed on hover and focus-within, and always on a no-hover device', () => {
    render(<WorkItemNode item={leaf} ready nextActions={ON} />);
    const cls = nextAction()!.className;
    expect(cls).toContain('opacity-0');
    expect(cls).toContain('group-hover/node:opacity-100');
    expect(cls).toContain('group-focus-within/node:opacity-100');
    expect(cls).toContain('[[data-node-id]:focus-visible_&]:opacity-100');
    expect(cls).toContain('[@media(hover:none)]:opacity-100');
    expect(cls).toContain('translate-y-1/2');
  });
});
