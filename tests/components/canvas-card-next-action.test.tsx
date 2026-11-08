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
const { ProjectRoadmapCanvas } = await import('@/components/planning/ProjectRoadmapCanvas');
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

  it('Ready copies motir run on a card that is not manual', () => {
    expect(cardNextAction({ ...base, ready: true })).toEqual({
      kind: 'copy',
      verb: 'run',
      reason: null,
    });
  });

  // MOTIR-10559: a ready manual / human card copies `motir guide`, the walk through
  // a human card's steps, where it used to draw no button.
  it('Ready and manual copies motir guide', () => {
    expect(cardNextAction({ ...base, ready: true, manual: true })).toEqual({
      kind: 'copy',
      verb: 'guide',
      reason: null,
    });
  });

  it('the fix and In Review rows still win over a ready manual card', () => {
    expect(cardNextAction({ ...base, ready: true, manual: true, fixReason: 'ci_failed' })).toEqual({
      kind: 'copy',
      verb: 'fix',
      reason: 'ci_failed',
    });
    expect(cardNextAction({ ...base, ready: true, manual: true, status: 'in_review' })).toEqual({
      kind: 'copy',
      verb: 'review',
      reason: null,
    });
  });

  it('a manual card that is not ready, or a canvas without the opt-in, draws no button', () => {
    expect(cardNextAction({ ...base, manual: true })).toBeNull();
    expect(cardNextAction({ ...base, manual: true, status: 'in_progress' })).toBeNull();
    expect(cardNextAction({ ...base, ready: true, manual: true, options: null })).toBeNull();
    expect(cardNextAction({ ...base, ready: true, manual: true, options: undefined })).toBeNull();
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

  it('You are here wins the frame; the To plan pill keeps the slot (MOTIR-10630)', () => {
    const { container } = render(<WorkItemNode item={story} here />);
    expect(frame(container).getAttribute('data-node-state')).toBe('here');
    expect(frame(container).className).not.toContain('bg-(--el-tint-yellow)');
    expect(screen.getByTestId('to-plan-pill').textContent).toContain('To plan');
    expect(screen.getByTestId('here-tab').textContent).toBe('You are here');
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

// MOTIR-10630 (design MOTIR-10629): You are here is a TAB hung on the card's top
// edge, left, outside the frame — it no longer takes the status slot, so the here
// card's tag row reads exactly as any other card's in the same state.
describe('the You are here tab', () => {
  const tab = () => screen.getByTestId('here-tab');
  const wrapperOf = (container: HTMLElement) => container.firstElementChild as HTMLElement;

  it('hangs on the top edge, left, in the chip size and shape tokens, with no shadow', () => {
    render(<WorkItemNode item={leaf} here />);
    const cls = classes(tab());
    for (const c of [
      'absolute',
      'bottom-[calc(100%-1px)]',
      'left-3',
      'z-10',
      'h-5',
      'text-[11px]',
      'whitespace-nowrap',
      'rounded-t-(--radius-badge)',
      'px-(--spacing-chip-x-6)',
      'bg-(--el-accent)',
      'text-(--el-accent-text)',
    ]) {
      expect(cls).toContain(c);
    }
    expect(cls.some((c) => c.startsWith('shadow'))).toBe(false);
  });

  it('is a sibling rendered BEFORE the frame, outside its overflow-hidden and footprint', () => {
    const { container } = render(<WorkItemNode item={leaf} here ready nextActions={ON} />);
    const wrapper = wrapperOf(container);
    expect(wrapper.style.height).toBe('124px');
    expect(wrapper.style.width).toBe('280px');
    const [first, second] = [...wrapper.children] as HTMLElement[];
    expect(first).toBe(tab());
    expect(second).toBe(frame(container));
    expect(frame(container).style.height).toBe('124px');
    expect(frame(container).contains(tab())).toBe(false);
    // The hover next-action button keeps its top-right seam beside the tab.
    expect(classes(nextAction()!)).toContain('right-3');
  });

  it('its words are read out: shown in full, not aria-hidden, the glyph decorative', () => {
    render(<WorkItemNode item={leaf} here notInSprint />);
    expect(tab().textContent).toBe('You are here');
    expect(tab().getAttribute('aria-hidden')).toBeNull();
    expect(tab().getAttribute('role')).toBeNull();
    expect(tab().querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the accent frame, data-node-state and aria-current on the frame', () => {
    const { container } = render(<WorkItemNode item={leaf} here />);
    const card = frame(container);
    expect(card.getAttribute('data-node-state')).toBe('here');
    expect(card.getAttribute('aria-current')).toBe('step');
    expect(card.className).toContain('border-(--el-accent)');
  });

  it('is drawn on no other card', () => {
    render(<WorkItemNode item={leaf} ready />);
    expect(screen.queryByTestId('here-tab')).toBeNull();
  });

  it('the here card shows its own status pill, in full', () => {
    render(
      <WorkItemNode item={{ ...leaf, status: 'in_review', statusCategory: 'in_progress' }} here />,
    );
    const pill = document.querySelector('[data-status="in_review"]') as HTMLElement;
    expect(pill.getAttribute('title')).toBe('In Review');
    expect(pill.textContent).toContain('In Review');
  });

  it('here + ready: the Ready pill in the slot, no mint wash (here wins the frame)', () => {
    const { container } = render(<WorkItemNode item={leaf} here ready />);
    expect(screen.getByTestId('ready-pill')).toBeTruthy();
    expect(frame(container).className).not.toContain('bg-(--el-tint-mint)');
    expect(tab()).toBeTruthy();
  });

  it('here + blocked: the danger frame keeps the border, the tab stays accent', () => {
    const { container } = render(<WorkItemNode item={leaf} here crossBlocked />);
    const card = frame(container);
    expect(card.getAttribute('data-node-state')).toBe('cross-blocked');
    expect(card.className).toContain('border-(--el-danger)');
    expect(classes(tab())).toContain('bg-(--el-accent)');
    expect(screen.getByTestId('cross-blocked-flag')).toBeTruthy();
    // The give-way rule still applies to the slot, exactly as on any blocked card.
    expect(document.querySelector('[data-status="todo"]')!.getAttribute('role')).toBe('img');
  });

  it('here + not in sprint: the tag, the slot as its glyph, and the tab in full', () => {
    render(<WorkItemNode item={leaf} here notInSprint />);
    expect(screen.getByTestId('not-in-sprint-tag')).toBeTruthy();
    expect(document.querySelector('[data-status="todo"]')!.getAttribute('role')).toBe('img');
    expect(tab().textContent).toBe('You are here');
  });

  it('here + Manual: the status pill and the Manual chip both show, as on any card', () => {
    const manual = { ...leaf, type: 'manual' as const, executor: 'human' as const };
    const { container: a } = render(<WorkItemNode item={manual} here />);
    const { container: b } = render(<WorkItemNode item={manual} />);
    const tagRow = (c: HTMLElement) => frame(c).firstElementChild!.innerHTML;
    expect(tagRow(a)).toBe(tagRow(b));
    expect(screen.getAllByText('Manual')).toHaveLength(2);
  });

  it('here + a run disposition: the disposition rides the row beside the status', () => {
    render(<WorkItemNode item={leaf} here runLeg={{ tone: 'running', label: 'Running' }} />);
    expect(screen.getByText('Running')).toBeTruthy();
    expect(document.querySelector('[data-status="todo"]')).toBeTruthy();
    expect(tab()).toBeTruthy();
  });

  it('on the roadmap, edges entering the here card’s top land right of its tab', async () => {
    const endX = (path: Element) =>
      Number(
        path
          .getAttribute('d')!
          .match(/-?[\d.]+/g)!
          .at(-2),
      );
    const node = (id: string, x: number, y: number, here = false) => ({
      id,
      parentId: null,
      searchText: id,
      crumbLabel: id,
      drillable: false,
      viewable: true,
      x,
      y,
      ...(here ? { here } : {}),
      content: <WorkItemNode item={{ ...leaf, id, title: `card ${id}` }} here={here} />,
    });
    const draw = async (here: boolean) => {
      const level = {
        nodes: [node('A', 0, 0), node('B', 100, 0), node('T', 0, 400, here)],
        deps: [
          { from: 'A', to: 'T' },
          { from: 'B', to: 'T' },
        ],
      };
      render(
        <ToastProvider>
          <ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} />
        </ToastProvider>,
      );
      await screen.findByText('card T');
      const xs = [...screen.getByTestId('canvas-edges').querySelectorAll('path')].map(endX);
      cleanup();
      return xs;
    };
    expect(await draw(false)).toEqual([78.4, 201.6]);
    expect(await draw(true)).toEqual([140, 201.6]);
  });

  it('the shell draws a tab first and nothing in its place without one', () => {
    const { container, rerender } = render(
      <WorkItemCardShell
        frameClassName="bg-(--el-surface)"
        statusRow={null}
        kind="task"
        identifier="MOTIR-1"
        title="t"
        tab={<span>tab</span>}
      />,
    );
    expect(wrapperOf(container).children).toHaveLength(2);
    expect(wrapperOf(container).firstElementChild!.textContent).toBe('tab');
    rerender(
      <WorkItemCardShell
        frameClassName="bg-(--el-surface)"
        statusRow={null}
        kind="task"
        identifier="MOTIR-1"
        title="t"
      />,
    );
    expect(wrapperOf(container).children).toHaveLength(1);
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

  describe('a ready manual or human card copies motir guide (MOTIR-10559)', () => {
    const manual = { ...leaf, type: 'manual', executor: 'human' } as const;

    it.each([
      ['type manual', { ...leaf, type: 'manual' }],
      ['executor human', { ...leaf, executor: 'human' }],
    ] as const)('on a %s card', async (_label, item) => {
      render(
        <ToastProvider>
          <WorkItemNode item={item} ready nextActions={ON} />
        </ToastProvider>,
      );
      const button = nextAction()!;
      expect(button.getAttribute('data-action')).toBe('guide');
      expect(button.textContent).toBe('motir guide');
      expect(button.getAttribute('aria-label')).toBe('Copy motir guide MOTIR-10509');
      await act(async () => {
        fireEvent.click(button);
      });
      expect(writeText).toHaveBeenCalledWith('motir guide MOTIR-10509');
    });

    it('with the success toast and a Check for 2s, as the run button', async () => {
      vi.useFakeTimers();
      render(
        <ToastProvider>
          <WorkItemNode item={manual} ready nextActions={ON} />
        </ToastProvider>,
      );
      const button = nextAction()!;
      await act(async () => {
        fireEvent.click(button);
      });
      expect(screen.getByText('Copied')).toBeTruthy();
      expect(screen.getByText('Paste motir guide MOTIR-10509 into your terminal.')).toBeTruthy();
      expect(button.getAttribute('data-copied')).toBe('true');
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(button.getAttribute('data-copied')).toBeNull();
    });

    it('a refused clipboard shows the same copy-failed toast', async () => {
      writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
      render(
        <ToastProvider>
          <WorkItemNode item={manual} ready nextActions={ON} />
        </ToastProvider>,
      );
      const button = nextAction()!;
      await act(async () => {
        fireEvent.click(button);
      });
      expect(
        screen.getByText("Couldn't copy — select the command and copy it manually."),
      ).toBeTruthy();
      expect(button.getAttribute('data-copied')).toBeNull();
    });

    it('its tooltip says the card is work a person does and names the guide command', async () => {
      render(<WorkItemNode item={manual} ready nextActions={ON} />);
      fireEvent.focus(nextAction()!);
      const tip = await screen.findByRole('tooltip', {}, { timeout: 3000 });
      expect(tip.textContent).toBe('Work a person does — copy motir guide MOTIR-10509');
    });

    it('uses the same reveal: hover, focus-within, always on a no-hover device', () => {
      render(<WorkItemNode item={manual} ready nextActions={ON} />);
      const cls = nextAction()!.className;
      expect(cls).toContain('opacity-0');
      expect(cls).toContain('group-hover/node:opacity-100');
      expect(cls).toContain('group-focus-within/node:opacity-100');
      expect(cls).toContain('[@media(hover:none)]:opacity-100');
    });

    it('a manual card that is not ready gets no button', () => {
      render(<WorkItemNode item={manual} nextActions={ON} />);
      expect(nextAction()).toBeNull();
    });

    it('a canvas built without next-action options (onboarding, plan preview) gets none', () => {
      render(<WorkItemNode item={manual} ready />);
      expect(nextAction()).toBeNull();
    });
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

  it('a To plan card opens the planning overlay with that card as the target', async () => {
    // Since MOTIR-10544 the click CHECKS first (`GET /api/work-items/plannability`)
    // and opens the overlay on a plannable answer; the alert and failure outcomes
    // are `tests/components/canvas-card-plan-check.test.tsx`.
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ plannable: true, reasons: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<WorkItemNode item={story} nextActions={ON} />);
    const button = nextAction()!;
    expect(button.getAttribute('data-action')).toBe('plan');
    expect(button.getAttribute('aria-label')).toBe('Plan MOTIR-10520');
    expect(button.textContent).toBe('Plan');
    await act(async () => {
      fireEvent.click(button, { button: 0 });
    });
    vi.unstubAllGlobals();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('the Plan press does not reach the node either', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ plannable: true, reasons: [] }), { status: 200 }),
      ),
    );
    const onClick = vi.fn();
    const onPointerDown = vi.fn();
    render(
      <div onClick={onClick} onPointerDown={onPointerDown}>
        <WorkItemNode item={story} nextActions={ON} />
      </div>,
    );
    const button = nextAction()!;
    fireEvent.pointerDown(button);
    await act(async () => {
      fireEvent.click(button, { button: 0 });
    });
    vi.unstubAllGlobals();
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
  });

  // MOTIR-10536: it hangs on the card's TOP edge, so it never shares the bottom edge
  // the selected card's action slot (View / Open) hangs on.
  it('hangs on the card top edge, right-aligned — never the bottom edge', () => {
    render(<WorkItemNode item={leaf} ready nextActions={ON} />);
    const cls = classes(nextAction()!);
    expect(hungEdge(cls)).toBe('top');
    expect(cls).toContain('right-3');
  });

  // MOTIR-10631: centred on the edge (`top-0 -translate-y-1/2`), the 32px button
  // reached 16px into the frame and sat 0.3–4.3px over the tag row's status chip
  // in every style. Its BOTTOM is now anchored on the frame's top padding edge,
  // lifted by the elevated shadow's hard drop, so neither the button nor its
  // shadow reaches the chips whatever the style's density.
  it.each([
    ['the copy button', leaf, true],
    ['the To plan Plan button', story, false],
  ] as const)('%s keeps its bottom above the tag row', (_label, item, ready) => {
    render(<WorkItemNode item={item} ready={ready} nextActions={ON} />);
    const cls = classes(nextAction()!);
    expect(cls).toContain(
      'top-[calc(var(--spacing-card-padding-12)-var(--spacing-shadow-elevated-drop))]',
    );
    expect(cls).toContain('-translate-y-full');
    expect(cls).not.toContain('-translate-y-1/2');
    expect(cls).not.toContain('top-0');
  });

  it('the To plan Plan button hangs on the same top edge', () => {
    render(<WorkItemNode item={story} nextActions={ON} />);
    expect(nextAction()!.dataset.action).toBe('plan');
    expect(hungEdge(classes(nextAction()!))).toBe('top');
  });
});

/** The element's class tokens. */
function classes(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

/**
 * Which edge of its containing box an absolutely-positioned control HANGS across,
 * read from its Tailwind utilities: anchored `top-*` and lifted by a negative
 * translate (or a negative `-top-*` inset) ⇒ `top`; anchored `bottom-*` and dropped
 * by a positive translate (or a negative `-bottom-*` inset) ⇒ `bottom`. happy-dom
 * lays nothing out, so the classes ARE the geometry this suite can read.
 */
function hungEdge(cls: string[]): 'top' | 'bottom' | null {
  const top = cls.some((c) => /^-?top-/.test(c));
  const bottom = cls.some((c) => /^-?bottom-/.test(c));
  if (top && !bottom) return 'top';
  if (bottom && !top) return 'bottom';
  return null;
}

// MOTIR-10536 — the collision itself. On the roadmap a SELECTED card draws its
// action slot (View · planning target · Open) centred across the bottom edge; on a
// 280px card View + Open reach into the right corner, where the next-action button
// used to hang, and the slot (drawn after the card) painted over it.
describe('the next-action button on a SELECTED roadmap card (MOTIR-10536)', () => {
  async function selectedCard(item: WorkItemNodeData, ready: boolean) {
    const level = {
      nodes: [
        {
          id: item.id,
          parentId: null,
          searchText: item.title,
          crumbLabel: item.identifier,
          drillable: true,
          viewable: true,
          content: <WorkItemNode item={item} ready={ready} nextActions={ON} />,
        },
      ],
      deps: [],
    };
    render(
      <ToastProvider>
        <ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} onView={vi.fn()} />
      </ToastProvider>,
    );
    await screen.findByText(item.title);
    const node = document.querySelector(`[data-node-id="${item.id}"]`) as HTMLElement;
    fireEvent.keyDown(node, { key: 'Enter' });
    const view = await screen.findByTestId('view-button');
    expect(screen.getByTestId('drill-button')).toBeTruthy();
    return { slot: view.parentElement as HTMLElement, button: nextAction()! };
  }

  it.each([
    ['a ready leaf (motir run)', leaf, true],
    ['a To plan story (Plan)', story, false],
  ] as const)(
    'on %s the button and the View / Open slot hang on different edges',
    async (_label, item, ready) => {
      const { slot, button } = await selectedCard(item, ready);
      // Both present at once — the slot did not replace the button.
      expect(slot.contains(button)).toBe(false);
      expect(hungEdge(classes(slot))).toBe('bottom');
      expect(hungEdge(classes(button))).toBe('top');
    },
  );

  it('pressing the button on the selected card still reaches neither the node nor the slot', async () => {
    const { button } = await selectedCard(leaf, true);
    fireEvent.click(button, { button: 0 });
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('motir run MOTIR-10509');
    // Still selected: the press neither drilled (the slot would be gone with the
    // level) nor re-selected.
    expect(screen.getByTestId('view-button')).toBeTruthy();
  });
});
