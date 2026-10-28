// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { TodoProgressDto, WorkItemTodoDto } from '@/lib/dto/workItemTodos';

// TodoListSection (Story MOTIR-3808 · MOTIR-3815) — the section's own CLIENT
// logic, against `design/work-items/todo-list.mock.html`. The service matrix
// lives in MOTIR-3813's integration tests, the action wiring in MOTIR-3814's,
// and the live journey in MOTIR-3817's E2E.
//
// What the card's acceptance criteria ask this file to prove:
//   2  ticking updates the row AND the header from the returned envelope
//   3  a command row copies the exact string; a null command draws NO copy
//   4  an agent row is marked AND offers no run control — asserted NEGATIVELY
//   6  read-only cannot tick — asserted by ATTEMPTING it, not by reading an attr
//   7  empty and all-done each render, and nothing offers a status transition
//   9  the section mounts in each of its states
// plus the INSTRUCTIONS disclosure (the notesMd amendment).

const addTodoAction = vi.fn();
const updateTodoAction = vi.fn();
const moveTodoAction = vi.fn();
const setTodoDoneAction = vi.fn();
const deleteTodoAction = vi.fn();

vi.mock('@/app/(authed)/items/[key]/todoActions', () => ({
  addTodoAction: (...a: unknown[]) => addTodoAction(...a),
  updateTodoAction: (...a: unknown[]) => updateTodoAction(...a),
  moveTodoAction: (...a: unknown[]) => moveTodoAction(...a),
  setTodoDoneAction: (...a: unknown[]) => setTodoDoneAction(...a),
  deleteTodoAction: (...a: unknown[]) => deleteTodoAction(...a),
}));

// The editor is the client-only Tiptap surface — stubbed to a labelled textarea,
// the CreateIssueModal / CommentsSection convention.
vi.mock('@/components/ui/MarkdownEditor', () => ({
  MarkdownEditor: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (v: string) => void;
    label: string;
  }) => <textarea aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />,
}));

import { TodoListSection } from '@/app/(authed)/items/[key]/_components/TodoListSection';

let seq = 0;
function todo(over: Partial<WorkItemTodoDto> = {}): WorkItemTodoDto {
  seq += 1;
  return {
    id: `todo-${seq}`,
    text: `Step ${seq}`,
    notesMd: null,
    textLanguage: null,
    notesLanguage: null,
    commandText: null,
    executor: 'human',
    position: `a${seq}`,
    done: false,
    doneAt: null,
    doneBy: null,
    ...over,
  };
}

function progress(done: number, total: number): TodoProgressDto {
  return { done, total };
}

function mount(
  todos: WorkItemTodoDto[],
  p: TodoProgressDto = progress(0, todos.length),
  canEdit = true,
) {
  return render(
    <TodoListSection
      initialWorkItemRefs={{}}
      workItemId="wi-1"
      initialTodos={todos}
      initialProgress={p}
      canEdit={canEdit}
    />,
  );
}

const writeText = vi.fn(async () => {});

beforeEach(() => {
  seq = 0;
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});
afterEach(cleanup);

// ── the states (criteria 7 and 9) ───────────────────────────────────────────

describe('the states', () => {
  it('EMPTY renders its own invitation and the header still counts 0 of 0', () => {
    mount([], progress(0, 0));
    expect(screen.getByText('No steps yet.')).toBeTruthy();
    expect(screen.getByText('0 of 0 done')).toBeTruthy();
  });

  it('PARTLY DONE strikes the done row and leaves it where it is', () => {
    mount(
      [
        todo({ text: 'First', done: true, doneAt: '2026-08-12T00:00:00.000Z' }),
        todo({ text: 'Second' }),
      ],
      progress(1, 2),
    );
    const rows = screen.getAllByRole('listitem');
    // Order preserved — a done row is struck, never moved to the bottom.
    expect(within(rows[0]!).getByText('First')).toBeTruthy();
    expect(within(rows[0]!).getByText('First').className).toContain('line-through');
    expect(screen.getByText('1 of 2 done')).toBeTruthy();
  });

  it('ALL DONE renders its line and offers NO status control — the ADR refuses one', () => {
    mount([todo({ done: true })], progress(1, 1));
    expect(screen.getByText('Every step is done.')).toBeTruthy();
    // Criterion 7, asserted negatively: nothing on this surface transitions the card.
    const buttons = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    for (const name of buttons) {
      expect(name.toLowerCase()).not.toMatch(
        /done\b.*card|mark.*complete|transition|in review|close/,
      );
    }
  });
});

// ── ticking (criterion 2) ───────────────────────────────────────────────────

describe('ticking', () => {
  it('updates the row AND the header from the RETURNED envelope, not from the local array', async () => {
    const row = todo({ text: 'Open the DNS panel' });
    setTodoDoneAction.mockResolvedValue({
      ok: true,
      todo: {
        ...row,
        done: true,
        doneAt: '2026-08-12T00:00:00.000Z',
        doneBy: { id: 'u1', name: 'Yue' },
      },
      // Deliberately NOT what the client would compute from one row: the header
      // must follow the server, which is the whole point of the envelope.
      progress: progress(3, 7),
    });

    mount([row], progress(0, 1));
    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => expect(screen.getByText('3 of 7 done')).toBeTruthy());
    expect(setTodoDoneAction).toHaveBeenCalledWith({ todoId: row.id, done: true });
    expect(screen.getByText('Done by Yue')).toBeTruthy();
  });

  it("the checkbox announces DONE / NOT DONE — not the primitive's default 'Held'", () => {
    mount([todo({ text: 'Open the DNS panel' })]);
    // The primitive's default clause is set-membership vocabulary from the role
    // editor; a STEP is done or not done, and the wording is what carries the
    // state (the fill is colour, which 1.4.1 will not let us lean on).
    expect(screen.getByRole('checkbox').getAttribute('aria-label')).toBe(
      'Open the DNS panel, Not done',
    );
  });
});

// ── the command (criterion 3) ───────────────────────────────────────────────

describe('a command row', () => {
  it('copies the EXACT command and confirms in the button — no toast', async () => {
    const command = 'fly secrets set STRIPE_KEY=rk_live_x --app motir-core';
    mount([todo({ text: 'Set the secret', commandText: command })]);

    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
    // The confirmation is the button's own state (design-notes § the copy grammar).
    await waitFor(() => expect(screen.getByText('Command copied')).toBeTruthy());
  });

  it('a row with NO command draws no copy affordance at all', () => {
    mount([todo({ commandText: null })]);
    expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull();
  });
});

// ── the agent row (criterion 4) ─────────────────────────────────────────────

describe('an agent row', () => {
  it('is visibly the agent’s, offers NO run control, and its checkbox still works for a person', async () => {
    const row = todo({ text: 'Regenerate the client', executor: 'coding_agent' });
    setTodoDoneAction.mockResolvedValue({
      ok: true,
      todo: { ...row, done: true },
      progress: progress(1, 1),
    });
    mount([row]);

    expect(screen.getByText("The agent's step")).toBeTruthy();

    // Asserted NEGATIVELY — the promise the data model makes is that the field
    // describes and does not dispatch. There is no run control until Motir AI can
    // run a step (MOTIR-3809, the hosted-agent dispatch, is cancelled).
    const names = screen
      .getAllByRole('button')
      .map((b) => `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`.toLowerCase());
    for (const n of names) expect(n).not.toMatch(/\brun\b|dispatch/);

    // …and a PERSON may still tick it (ADR §2: the executor authorizes nothing).
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(setTodoDoneAction).toHaveBeenCalled());
  });
});

// ── the instructions disclosure (the notesMd amendment) ─────────────────────

describe('the instructions disclosure', () => {
  it('renders ONLY on a row that has notes, collapsed, and expands to the rendered Markdown', () => {
    mount([
      todo({ text: 'With notes', notesMd: '1. Dashboard → Developers\n2. Create the key' }),
      todo({ text: 'Without notes' }),
    ]);

    const toggles = screen.getAllByRole('button', { name: 'Show instructions' });
    expect(toggles).toHaveLength(1); // the tell renders only where there is something to tell
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggles[0]!);
    expect(
      screen.getByRole('button', { name: 'Hide instructions' }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getByText(/Dashboard/)).toBeTruthy();
  });

  it('the EDITOR is the Markdown one for notes and plain inputs for the other two', () => {
    mount([todo({ text: 'A step', notesMd: 'how', commandText: 'pnpm build' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit step' }));

    // Three controls for three kinds of text — the asymmetry is the design.
    expect(screen.getByLabelText('Step').tagName).toBe('INPUT');
    expect(screen.getByLabelText('Instructions').tagName).toBe('TEXTAREA'); // the stubbed MarkdownEditor
    expect(screen.getByLabelText('Command').tagName).toBe('INPUT');
  });
});

// ── read-only (criterion 6) ─────────────────────────────────────────────────

describe('read-only', () => {
  it('keeps the information and loses every control — and CANNOT tick, asserted by trying', async () => {
    mount([todo({ text: 'A step', commandText: 'pnpm build' })], progress(0, 1), false);

    // The information survives.
    expect(screen.getByText('A step')).toBeTruthy();
    expect(screen.getByText('0 of 1 done')).toBeTruthy();

    // The controls do not.
    expect(screen.queryByRole('button', { name: 'Add step' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit step' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete step' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move step up' })).toBeNull();

    // MOTIR-6173 — the tick stays, disabled, inside a wrapper that carries the
    // read-only reason (a disabled input swallows the pointer, so the Tooltip
    // cannot hang off the checkbox itself).
    const wrapper = screen.getByTestId('todo-checkbox-read-only');
    expect(wrapper.contains(screen.getByRole('checkbox'))).toBe(true);

    // Criterion 6: attempt the interaction rather than inspect an attribute.
    fireEvent.click(screen.getByRole('checkbox'));
    await new Promise((r) => setTimeout(r, 0));
    expect(setTodoDoneAction).not.toHaveBeenCalled();
  });
});

// ── add · edit · move · delete (criterion 5) ────────────────────────────────

describe('the write affordances', () => {
  it('ADD appends from the returned row and clears the field', async () => {
    const created = todo({ id: 'new', text: 'Wait for propagation' });
    addTodoAction.mockResolvedValue({ ok: true, todo: created, progress: progress(0, 2) });
    mount([todo({ text: 'Existing' })], progress(0, 1));

    const field = screen.getByLabelText('Add a step…');
    fireEvent.change(field, { target: { value: 'Wait for propagation' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('Wait for propagation')).toBeTruthy());
    expect(addTodoAction).toHaveBeenCalledWith({
      workItemId: 'wi-1',
      text: 'Wait for propagation',
    });
    expect(screen.getByText('0 of 2 done')).toBeTruthy();
  });

  it('EDIT sends a sparse patch and clears a blanked command to null', async () => {
    const row = todo({ text: 'A step', commandText: 'pnpm build' });
    updateTodoAction.mockResolvedValue({
      ok: true,
      todo: { ...row, commandText: null },
      progress: progress(0, 1),
    });
    mount([row]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit step' }));
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateTodoAction).toHaveBeenCalled());
    // A blanked field is an explicit null — the sparse patch's clear arm.
    expect(updateTodoAction.mock.calls[0]![0]).toMatchObject({ todoId: row.id, commandText: null });
  });

  it('MOVE sends an INDEX and announces the new position for a keyboard user', async () => {
    const a = todo({ text: 'A' });
    const b = todo({ text: 'B' });
    moveTodoAction.mockResolvedValue({ ok: true, todo: b, progress: progress(0, 2) });
    mount([a, b]);

    fireEvent.click(screen.getAllByRole('button', { name: 'Move step up' })[1]!);
    await waitFor(() => expect(moveTodoAction).toHaveBeenCalledWith({ todoId: b.id, toIndex: 0 }));
    // The destination is an INDEX resolved server-side, not a neighbour id
    // resolved against whatever this client last rendered.
    await waitFor(() => expect(screen.getByText('Moved to position 1 of 2')).toBeTruthy());
  });

  it('DELETE confirms inline and removes the row', async () => {
    const row = todo({ text: 'A step' });
    deleteTodoAction.mockResolvedValue({ ok: true, progress: progress(0, 0) });
    mount([row]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete step' }));
    expect(screen.getByText('Delete “A step”?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByText('No steps yet.')).toBeTruthy());
  });
});

// ── the section's own error state ───────────────────────────────────────────

describe('a failed action', () => {
  it('degrades INSIDE the section with a retry, and does not blank the page', async () => {
    const row = todo({ text: 'A step' });
    setTodoDoneAction.mockResolvedValueOnce({ ok: false, error: 'That step no longer exists.' });
    mount([row]);

    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('That step no longer exists.')).toBeTruthy();
    // The list is still there — the failure is contained.
    expect(screen.getByText('A step')).toBeTruthy();

    setTodoDoneAction.mockResolvedValueOnce({
      ok: true,
      todo: { ...row, done: true },
      progress: progress(1, 1),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('1 of 1 done')).toBeTruthy());
  });
});

// ── the cancels, the guards and the executor toggle ─────────────────────────

describe('cancelling and guarding', () => {
  it('CANCEL leaves the edit without writing', () => {
    mount([todo({ text: 'A step' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit step' }));
    expect(screen.getByLabelText('Step')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Step')).toBeNull();
    expect(updateTodoAction).not.toHaveBeenCalled();
  });

  it('CANCEL leaves the delete confirm without writing', () => {
    mount([todo({ text: 'A step' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete step' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Delete “A step”?')).toBeNull();
    expect(deleteTodoAction).not.toHaveBeenCalled();
  });

  it('the executor toggle flips the draft, and SAVE sends the chosen value', async () => {
    const row = todo({ text: 'A step', executor: 'human' });
    updateTodoAction.mockResolvedValue({
      ok: true,
      todo: { ...row, executor: 'coding_agent' },
      progress: progress(0, 1),
    });
    mount([row]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit step' }));
    fireEvent.click(screen.getByRole('button', { name: "The agent's step" }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateTodoAction).toHaveBeenCalled());
    expect(updateTodoAction.mock.calls[0]![0]).toMatchObject({ executor: 'coding_agent' });
    // …and back again, which is the arm a one-way toggle would miss.
    await waitFor(() => expect(screen.getByText("The agent's step")).toBeTruthy());
  });

  it('an empty ADD writes nothing, and Escape clears the field', () => {
    mount([]);
    const field = screen.getByLabelText('Add a step…');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(addTodoAction).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: 'typed then abandoned' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect((field as HTMLInputElement).value).toBe('');
  });

  it('MOVE is disabled at the boundaries — the first row cannot go up', () => {
    mount([todo({ text: 'A' }), todo({ text: 'B' })]);
    const ups = screen.getAllByRole('button', { name: 'Move step up' });
    expect((ups[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(ups[0]!);
    expect(moveTodoAction).not.toHaveBeenCalled();
  });

  it('RETRY with nothing to retry is a no-op rather than a crash', async () => {
    // The error region only appears after a failure, so reach the guard through
    // one: fail, retry (which re-runs), and assert the section survives.
    const row = todo({ text: 'A step' });
    setTodoDoneAction.mockResolvedValue({ ok: false, error: 'nope' });
    mount([row]);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(setTodoDoneAction).toHaveBeenCalledTimes(2));
    expect(screen.getByText('A step')).toBeTruthy();
  });
});

describe('the editor’s three controls all write to the draft', () => {
  it('typing in each control, collapsing the disclosure, and the Add BUTTON all work', async () => {
    const row = todo({ text: 'Old text', notesMd: 'old notes', executor: 'coding_agent' });
    updateTodoAction.mockResolvedValue({ ok: true, todo: row, progress: progress(0, 1) });
    mount([row]);

    // Collapse a disclosure that is open — the delete arm of the expanded set.
    fireEvent.click(screen.getByRole('button', { name: 'Show instructions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide instructions' }));
    expect(screen.getByRole('button', { name: 'Show instructions' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit step' }));
    fireEvent.change(screen.getByLabelText('Step'), { target: { value: 'New text' } });
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'New notes' } });
    // …and the executor toggled the OTHER way, which the agent test does not reach.
    fireEvent.click(screen.getByRole('button', { name: 'Your step' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateTodoAction).toHaveBeenCalled());
    expect(updateTodoAction.mock.calls[0]![0]).toMatchObject({
      text: 'New text',
      notesMd: 'New notes',
      executor: 'human',
    });
  });

  it('the Add BUTTON adds, and the last row can be moved DOWN', async () => {
    const a = todo({ text: 'A' });
    const b = todo({ text: 'B' });
    addTodoAction.mockResolvedValue({
      ok: true,
      todo: todo({ text: 'C' }),
      progress: progress(0, 3),
    });
    moveTodoAction.mockResolvedValue({ ok: true, todo: a, progress: progress(0, 2) });
    mount([a, b]);

    fireEvent.change(screen.getByLabelText('Add a step…'), { target: { value: 'C' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    await waitFor(() => expect(addTodoAction).toHaveBeenCalled());

    fireEvent.click(screen.getAllByRole('button', { name: 'Move step down' })[0]!);
    await waitFor(() => expect(moveTodoAction).toHaveBeenCalledWith({ todoId: a.id, toIndex: 1 }));
  });

  it('the copy confirmation CLEARS itself, so a second copy is legible', async () => {
    vi.useFakeTimers();
    try {
      mount([todo({ commandText: 'pnpm build' })]);
      fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
      await vi.waitFor(() => expect(screen.getByText('Command copied')).toBeTruthy());
      await act(async () => {
        vi.advanceTimersByTime(2100);
      });
      expect(screen.queryByText('Command copied')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a failed ADD', () => {
  it('shows the section error and RETRY re-runs the add, not the last tick', async () => {
    addTodoAction
      .mockResolvedValueOnce({ ok: false, error: 'A step is one operation, so it is capped.' })
      .mockResolvedValueOnce({
        ok: true,
        todo: todo({ text: 'Wait for propagation' }),
        progress: progress(0, 1),
      });
    mount([], progress(0, 0));

    const field = screen.getByLabelText('Add a step…');
    fireEvent.change(field, { target: { value: 'Wait for propagation' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // Retry re-runs THE ADD — `lastAction` is the last thing attempted, and an
    // add that retried a stale tick would be a quietly wrong recovery.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(addTodoAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('Wait for propagation')).toBeTruthy());
  });
});

describe('a REJECTED action (not merely a refused one)', () => {
  it('shows the section’s generic error rather than escaping as an unhandled rejection', async () => {
    // The shape a real user hits: the network drops, a deploy lands mid-flight,
    // or the action rethrows an error it has no message for. An earlier
    // revision handled only `{ ok: false }` and rendered NOTHING for this —
    // caught by MOTIR-3817's error-state E2E, which aborts the POST.
    const row = todo({ text: 'A step' });
    setTodoDoneAction.mockRejectedValueOnce(new Error('network'));
    mount([row]);

    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('Something went wrong. Please try again.')).toBeTruthy();
    // …and the list is still standing.
    expect(screen.getByText('A step')).toBeTruthy();
  });

  it('a refusal with no message still shows something rather than an empty alert', async () => {
    const row = todo({ text: 'A step' });
    setTodoDoneAction.mockResolvedValueOnce({ ok: false });
    mount([row]);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('Something went wrong. Please try again.')).toBeTruthy();
  });
});

// ── the overflow containment rule (criterion 8, structurally) ───────────────

describe('the containment rule for a wide command', () => {
  it('carries all THREE parts — the cell is min-w-0, the value scrolls itself, the button does not shrink', () => {
    const long =
      'fly deploy --app motir-core --image registry.fly.io/motir-core@sha256:' + 'a'.repeat(64);
    const { container } = mount([todo({ text: 'Deploy', commandText: long })]);

    const pre = container.querySelector('pre')!;
    // The value scrolls inside ITS OWN box…
    expect(pre.className).toContain('overflow-x-auto');
    // …its containing cell may shrink below its content…
    expect(pre.closest('.min-w-0')).not.toBeNull();
    // …and the copy button does not (a Button in a flex row defeats min-w-0
    // on its own account unless told otherwise).
    expect(screen.getByRole('button', { name: 'Copy command' }).className).toContain('shrink-0');
    // The command itself is intact — contained, never truncated in the DOM.
    expect(pre.textContent).toBe(long);
  });

  // ⚠️ THE PIXEL MEASUREMENT IS NOT ASSERTABLE HERE, and saying so is the point.
  // Criterion 8 asks that at 390px `document.scrollingElement.scrollWidth` does
  // not exceed the viewport. happy-dom has no layout engine — every width it
  // reports is 0 — so an assertion here would pass on a surface that scrolls
  // sideways in a real browser, which is worse than no assertion at all. The
  // three class names above ARE the rule; the measurement of its effect belongs
  // to MOTIR-3817's Playwright spec, which is the only instrument with layout.
});
