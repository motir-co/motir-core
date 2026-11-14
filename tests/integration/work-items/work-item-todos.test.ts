import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemTodoRepository } from '@/lib/repositories/workItemTodoRepository';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import {
  EmptyTodoTextError,
  TodoCommandTooLongError,
  TodoNotesTooLongError,
  TodoReorderConflictError,
  TodoTextTooLongError,
  WorkItemTodoNotFoundError,
} from '@/lib/workItemTodos/errors';
import {
  TODO_COMMAND_MAX_LENGTH,
  TODO_NOTES_MAX_LENGTH,
  TODO_TEXT_MAX_LENGTH,
} from '@/lib/workItemTodos/limits';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';

// Integration tests for the work-item TO-DO store (Story MOTIR-3808 ·
// MOTIR-3813) against a REAL Postgres (the no-mocks rule), built to
// `docs/decisions/work-item-todo-list.md`.
//
// What the card's acceptance criteria ask this file to prove, and where:
//   1/2  the RLS policy exists IN THE CATALOG and actually isolates two
//        tenants  → 'row-level security'
//   3    `executor` is the SHIPPED enum, seeded from the card and overridable
//        → 'addTodo — the executor'
//   4    a reorder writes exactly ONE row, counted rather than inferred from
//        the resulting order  → 'moveTodo'
//   5    two SIMULTANEOUS inserts at the same slot both land, with distinct
//        ordered keys  → 'concurrency'
//   6    the granularity bar REJECTS with a typed error, never truncates
//        → 'the granularity bar'
//   7    the done stamp is written and cleared as a PAIR  → 'setTodoDone'
//   8    add / edit / move / delete record a revision and a TICK does not,
//        asserted in BOTH directions  → 'the revision split'

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_todo", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "workspace_membership", "workspace", "session", "account", "verification", "user" RESTART IDENTITY CASCADE',
  );
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeCard(
  fx: WorkItemFixture,
  over: { executor?: 'coding_agent' | 'human'; type?: 'code' | 'manual' } = {},
): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: 'Cut the release',
      ...(over.type ? { type: over.type } : {}),
      ...(over.executor ? { executor: over.executor } : {}),
    },
    fx.ctx,
  );
  return dto.id;
}

/**
 * The revisions AFTER the card's own 'created' one, OLDEST FIRST.
 *
 * The repository's default order is `desc` (newest first — it backs a History
 * feed), so this reverses it: every assertion below indexes by the order the
 * acts HAPPENED in, and reading [1] out of a newest-first list silently gives
 * you the wrong entry rather than failing.
 */
async function todoRevisions(workItemId: string, workspaceId: string) {
  const rows = await withWorkspaceServiceContext(workspaceId, (tx) =>
    workItemRevisionRepository.listByWorkItem(workItemId, {}, tx),
  );
  return rows.filter((r) => r.changeKind === 'updated').reverse();
}

async function positions(workItemId: string, fx: WorkItemFixture): Promise<string[]> {
  const rows = await withWorkspaceContext(fx.ctx, (tx) =>
    workItemTodoRepository.listByWorkItem(workItemId, tx),
  );
  return rows.map((r) => r.text);
}

// ── the shape ───────────────────────────────────────────────────────────────

describe('addTodo', () => {
  it('appends in order and returns the row with its null-command, null-done shape', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);

    const { todo: first } = await workItemTodosService.addTodo(
      card,
      { text: '  Open the DNS panel  ' },
      fx.ctx,
    );
    const { todo: second } = await workItemTodosService.addTodo(
      card,
      { text: 'Add the TXT record' },
      fx.ctx,
    );

    // Trimmed, not Markdown, not a command row, not done.
    expect(first).toMatchObject({
      text: 'Open the DNS panel',
      commandText: null,
      doneAt: null,
      doneBy: null,
      done: false,
    });
    expect(first.position < second.position).toBe(true);
    expect(await positions(card, fx)).toEqual(['Open the DNS panel', 'Add the TXT record']);

    const list = await workItemTodosService.listTodos(card, fx.ctx);
    expect(list.progress).toEqual({ done: 0, total: 2 });
    expect(list.items).toHaveLength(2);
  });

  it('carries a command as its OWN field — the row is copyable because the column is set, not because the text looks like a command', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);

    const { todo: withCommand } = await workItemTodosService.addTodo(
      card,
      { text: 'Apply the migration', commandText: '  pnpm prisma migrate deploy  ' },
      fx.ctx,
    );
    // A step whose TEXT contains backticks is still not a command row.
    const { todo: backticked } = await workItemTodosService.addTodo(
      card,
      { text: 'Run `pnpm build` if it fails' },
      fx.ctx,
    );

    expect(withCommand.commandText).toBe('pnpm prisma migrate deploy');
    expect(backticked.commandText).toBeNull();
  });

  it('normalises a blank command to NULL, so no row renders a copy button for nothing', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo } = await workItemTodosService.addTodo(
      card,
      { text: 'A step', commandText: '   ' },
      fx.ctx,
    );
    expect(todo.commandText).toBeNull();
  });
});

describe('the INSTRUCTIONS (notesMd)', () => {
  it('carries the HOW beside the one-line WHAT, as Markdown', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const notes = [
      '1. Dashboard → Developers → **API keys**',
      '2. *Create restricted key*',
      '3. Scope it to `charges:write` only',
    ].join('\n');

    const { todo } = await workItemTodosService.addTodo(
      card,
      { text: 'Create a restricted Stripe key', notesMd: notes },
      fx.ctx,
    );

    // The tickable unit stays one line and one operation; the navigation that
    // gets you there is instructions, not three more rows.
    expect(todo.text).toBe('Create a restricted Stripe key');
    expect(todo.notesMd).toContain('Developers → **API keys**');
    expect(await positions(card, fx)).toEqual(['Create a restricted Stripe key']);
  });

  it('is NULL when the step needs none, and a blank string normalises to null', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const plain = await workItemTodosService.addTodo(card, { text: 'Tick this' }, fx.ctx);
    const blank = await workItemTodosService.addTodo(
      card,
      { text: 'And this', notesMd: '   \n  ' },
      fx.ctx,
    );
    // `null` and `''` must not be two spellings of "no instructions" — the
    // client tests this field to decide whether to draw the disclosure.
    expect(plain.todo.notesMd).toBeNull();
    expect(blank.todo.notesMd).toBeNull();
  });

  it('REJECTS notes past their own cap, and the message asks for a CARD rather than a split', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await expect(
      workItemTodosService.addTodo(
        card,
        { text: 'A step', notesMd: 'x'.repeat(TODO_NOTES_MAX_LENGTH + 1) },
        fx.ctx,
      ),
    ).rejects.toThrow(TodoNotesTooLongError);

    const err = new TodoNotesTooLongError(TODO_NOTES_MAX_LENGTH + 1);
    expect(err.limit).toBe(TODO_NOTES_MAX_LENGTH);
    // The remedy differs from the text cap's, and the copy has to say so.
    expect(err.message).toContain('work item');
    expect(err.message.toLowerCase()).not.toContain('split');
  });

  it('the notes cap does NOT loosen the one-operation bar on the text', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    // Long instructions are fine; a long TITLE is still two steps or a card.
    await expect(
      workItemTodosService.addTodo(
        card,
        { text: 'x'.repeat(TODO_TEXT_MAX_LENGTH + 1), notesMd: 'short' },
        fx.ctx,
      ),
    ).rejects.toThrow(TodoTextTooLongError);
  });

  it('the patch is SPARSE over notes too: editing the text leaves them, an explicit null clears them', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo } = await workItemTodosService.addTodo(
      card,
      { text: 'Create the key', notesMd: 'Dashboard → Developers' },
      fx.ctx,
    );

    const retitled = await workItemTodosService.updateTodo(
      todo.id,
      { text: 'Create the restricted key' },
      fx.ctx,
    );
    expect(retitled.todo.notesMd).toBe('Dashboard → Developers');

    const cleared = await workItemTodosService.updateTodo(todo.id, { notesMd: null }, fx.ctx);
    expect(cleared.todo.notesMd).toBeNull();
    expect(cleared.todo.text).toBe('Create the restricted key');
  });

  it('an edit to the notes records a revision naming both sides', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo } = await workItemTodosService.addTodo(
      card,
      { text: 'A step', notesMd: 'first' },
      fx.ctx,
    );
    await workItemTodosService.updateTodo(todo.id, { notesMd: 'second' }, fx.ctx);
    const edited = (await todoRevisions(card, fx.workspaceId))[1]!;
    expect(edited.diff).toMatchObject({
      todos: { edited: [{ id: todo.id, from: { notesMd: 'first' }, to: { notesMd: 'second' } }] },
    });
  });
});

describe('addTodo — the executor', () => {
  it('SEEDS from the card and stays overridable per row: a manual card can hold an agent step', async () => {
    const fx = await makeWorkItemFixture();
    const manualCard = await makeCard(fx, { type: 'manual' });

    const { todo: seeded } = await workItemTodosService.addTodo(
      manualCard,
      { text: 'Open the console' },
      fx.ctx,
    );
    const { todo: carved } = await workItemTodosService.addTodo(
      manualCard,
      { text: 'Regenerate the client', executor: 'coding_agent' },
      fx.ctx,
    );

    // `type: manual` seeds the CARD's executor to `human` (executorDefaults),
    // and the to-do inherits it — which is the whole point of the default.
    expect(seeded.executor).toBe('human');
    expect(carved.executor).toBe('coding_agent');
  });

  it('falls back to `human` when the card carries no executor of its own', async () => {
    const fx = await makeWorkItemFixture();
    const untyped = await makeCard(fx);
    const { todo } = await workItemTodosService.addTodo(untyped, { text: 'Ask Yue' }, fx.ctx);
    expect(todo.executor).toBe('human');
  });

  it('an explicit NULL clears it rather than falling back to the card', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx, { type: 'code' });
    const { todo } = await workItemTodosService.addTodo(
      card,
      { text: 'Undecided', executor: null },
      fx.ctx,
    );
    expect(todo.executor).toBeNull();
  });
});

// ── the granularity bar (criterion 6) ───────────────────────────────────────

describe('the granularity bar', () => {
  it('REJECTS an over-long text with a typed error and writes nothing — it does not truncate', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const tooLong = 'x'.repeat(TODO_TEXT_MAX_LENGTH + 1);

    await expect(workItemTodosService.addTodo(card, { text: tooLong }, fx.ctx)).rejects.toThrow(
      TodoTextTooLongError,
    );
    // The failure mode this criterion exists to forbid: a row whose second half
    // is silently gone.
    expect(await positions(card, fx)).toEqual([]);
  });

  it('accepts a text at EXACTLY the cap — the bound is inclusive', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const atCap = 'x'.repeat(TODO_TEXT_MAX_LENGTH);
    const { todo } = await workItemTodosService.addTodo(card, { text: atCap }, fx.ctx);
    expect(todo.text).toHaveLength(TODO_TEXT_MAX_LENGTH);
  });

  it('rejects an empty or whitespace-only text', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await expect(workItemTodosService.addTodo(card, { text: '   ' }, fx.ctx)).rejects.toThrow(
      EmptyTodoTextError,
    );
  });

  it('rejects an over-long COMMAND, at its own separate cap', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await expect(
      workItemTodosService.addTodo(
        card,
        { text: 'Run it', commandText: 'x'.repeat(TODO_COMMAND_MAX_LENGTH + 1) },
        fx.ctx,
      ),
    ).rejects.toThrow(TodoCommandTooLongError);
  });

  it('the error names the bar and the actual length, so the message can tell a user to split the step', async () => {
    const err = new TodoTextTooLongError(240);
    expect(err.limit).toBe(TODO_TEXT_MAX_LENGTH);
    expect(err.actual).toBe(240);
    expect(err.message).toContain('one operation');
    expect(new TodoCommandTooLongError(600).limit).toBe(TODO_COMMAND_MAX_LENGTH);

    // The reorder conflict carries a stable code and a message aimed at the
    // person holding the list, not at the developer: the remedy is to reload,
    // because somebody else changed the thing they were dragging.
    const conflict = new TodoReorderConflictError();
    expect(conflict.code).toBe('TODO_REORDER_CONFLICT');
    expect(conflict.message).toContain('Reload');
  });
});

// ── editing ─────────────────────────────────────────────────────────────────

describe('updateTodo', () => {
  it('is SPARSE: an omitted field is untouched, an explicit null CLEARS', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo } = await workItemTodosService.addTodo(
      card,
      { text: 'Apply it', commandText: 'pnpm migrate', executor: 'coding_agent' },
      fx.ctx,
    );

    // Only the text: the command and the executor must survive.
    const { todo: retitled } = await workItemTodosService.updateTodo(
      todo.id,
      { text: 'Apply the migration' },
      fx.ctx,
    );
    expect(retitled).toMatchObject({
      text: 'Apply the migration',
      commandText: 'pnpm migrate',
      executor: 'coding_agent',
    });

    const { todo: cleared } = await workItemTodosService.updateTodo(
      todo.id,
      { commandText: null, executor: null },
      fx.ctx,
    );
    expect(cleared).toMatchObject({
      commandText: null,
      executor: null,
      text: 'Apply the migration',
    });
  });

  it('an EMPTY patch is a no-op that writes no revision', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo } = await workItemTodosService.addTodo(card, { text: 'A step' }, fx.ctx);
    const before = (await todoRevisions(card, fx.workspaceId)).length;

    const { todo: same } = await workItemTodosService.updateTodo(todo.id, {}, fx.ctx);
    expect(same.text).toBe('A step');
    expect((await todoRevisions(card, fx.workspaceId)).length).toBe(before);
  });

  it('enforces the same bar on an EDIT as on a create', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo } = await workItemTodosService.addTodo(card, { text: 'A step' }, fx.ctx);
    await expect(
      workItemTodosService.updateTodo(
        todo.id,
        { text: 'x'.repeat(TODO_TEXT_MAX_LENGTH + 1) },
        fx.ctx,
      ),
    ).rejects.toThrow(TodoTextTooLongError);
  });
});

// ── ordering (criterion 4) ──────────────────────────────────────────────────

describe('moveTodo', () => {
  async function threeSteps(fx: WorkItemFixture, card: string) {
    await workItemTodosService.addTodo(card, { text: 'A' }, fx.ctx);
    await workItemTodosService.addTodo(card, { text: 'B' }, fx.ctx);
    await workItemTodosService.addTodo(card, { text: 'C' }, fx.ctx);
    return withWorkspaceContext(fx.ctx, (tx) => workItemTodoRepository.listByWorkItem(card, tx));
  }

  it('moves to the FRONT, the MIDDLE and the END, and the order survives a re-read', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const rows = await threeSteps(fx, card);

    await workItemTodosService.moveTodo(rows[2]!.id, 0, fx.ctx); // C to the front
    expect(await positions(card, fx)).toEqual(['C', 'A', 'B']);

    await workItemTodosService.moveTodo(rows[0]!.id, 1, fx.ctx); // A to the middle
    expect(await positions(card, fx)).toEqual(['C', 'A', 'B']);

    await workItemTodosService.moveTodo(rows[0]!.id, 2, fx.ctx); // A to the end
    expect(await positions(card, fx)).toEqual(['C', 'B', 'A']);
  });

  it('writes EXACTLY ONE row — counted, not inferred from the resulting order', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const rows = await threeSteps(fx, card);
    const before = new Map(rows.map((r) => [r.id, r.position]));

    await workItemTodosService.moveTodo(rows[2]!.id, 0, fx.ctx);

    const after = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemTodoRepository.listByWorkItem(card, tx),
    );
    const changed = after.filter((r) => before.get(r.id) !== r.position);
    // This is the whole reason `position` is a fractional index and not an
    // integer rank: an integer reorder would have rewritten every row below.
    expect(changed.map((r) => r.text)).toEqual(['C']);
  });

  it('CLAMPS an out-of-range index rather than throwing', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const rows = await threeSteps(fx, card);

    await workItemTodosService.moveTodo(rows[0]!.id, 99, fx.ctx);
    expect(await positions(card, fx)).toEqual(['B', 'C', 'A']);

    await workItemTodosService.moveTodo(rows[0]!.id, -5, fx.ctx);
    expect(await positions(card, fx)).toEqual(['A', 'B', 'C']);
  });

  it('a move to the index it already occupies is still a legal one-row write', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const rows = await threeSteps(fx, card);
    await workItemTodosService.moveTodo(rows[1]!.id, 1, fx.ctx);
    expect(await positions(card, fx)).toEqual(['A', 'B', 'C']);
  });
});

// ── the tick (criteria 7 and 8) ─────────────────────────────────────────────

describe('setTodoDone', () => {
  it('writes doneAt and doneById TOGETHER and clears them TOGETHER — no row can be half-ticked', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo } = await workItemTodosService.addTodo(card, { text: 'A step' }, fx.ctx);

    const ticked = await workItemTodosService.setTodoDone(todo.id, true, fx.ctx);
    expect(ticked.todo.done).toBe(true);
    expect(ticked.todo.doneAt).not.toBeNull();
    // `doneBy` is the resolved USER, not a bare id — the section renders a name.
    expect(ticked.todo.doneBy).toEqual({ id: fx.ctx.userId, name: fx.owner.name });

    const unticked = await workItemTodosService.setTodoDone(todo.id, false, fx.ctx);
    expect(unticked.todo.done).toBe(false);
    expect(unticked.todo.doneAt).toBeNull();
    expect(unticked.todo.doneBy).toBeNull();
  });

  it('reports the progress counts from the SAME snapshot as the write', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo: a } = await workItemTodosService.addTodo(card, { text: 'A' }, fx.ctx);
    await workItemTodosService.addTodo(card, { text: 'B' }, fx.ctx);

    const result = await workItemTodosService.setTodoDone(a.id, true, fx.ctx);
    expect(result.progress).toEqual({ done: 1, total: 2 });

    const list = await workItemTodosService.listTodos(card, fx.ctx);
    expect(list.progress).toEqual({ done: 1, total: 2 });
  });

  it("a PERSON may tick an AGENT's step — the executor authorizes nothing (ADR §2)", async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo: agentStep } = await workItemTodosService.addTodo(
      card,
      { text: 'Regenerate the client', executor: 'coding_agent' },
      fx.ctx,
    );
    const ticked = await workItemTodosService.setTodoDone(agentStep.id, true, fx.ctx);
    expect(ticked.todo.doneAt).not.toBeNull();
    expect(ticked.todo.executor).toBe('coding_agent');
  });

  it('ticking the LAST to-do does NOT move the card (ADR §3 — no third status authority)', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo: only } = await workItemTodosService.addTodo(
      card,
      { text: 'The only step' },
      fx.ctx,
    );

    // Read the STATUS COLUMN directly rather than through a detail DTO: the
    // claim is about what this write did to `work_item.status`, and a read that
    // goes through a projection could mask it.
    const statusOf = async () =>
      (await withWorkspaceContext(fx.ctx, (tx) => workItemRepository.findById(card, tx)))?.status;

    const before = await statusOf();
    const result = await workItemTodosService.setTodoDone(only.id, true, fx.ctx);
    const after = await statusOf();

    expect(result.progress).toEqual({ done: 1, total: 1 });
    expect(after).toBe(before);
  });
});

describe('the revision split (criterion 8, both directions)', () => {
  it('add, edit, move and delete each record ONE revision', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);

    const { todo: a } = await workItemTodosService.addTodo(card, { text: 'A' }, fx.ctx);
    expect(await todoRevisions(card, fx.workspaceId)).toHaveLength(1);

    await workItemTodosService.addTodo(card, { text: 'B' }, fx.ctx);
    await workItemTodosService.updateTodo(a.id, { text: 'A prime' }, fx.ctx);
    expect(await todoRevisions(card, fx.workspaceId)).toHaveLength(3);

    await workItemTodosService.moveTodo(a.id, 1, fx.ctx);
    expect(await todoRevisions(card, fx.workspaceId)).toHaveLength(4);

    await workItemTodosService.deleteTodo(a.id, fx.ctx);
    const revs = await todoRevisions(card, fx.workspaceId);
    expect(revs).toHaveLength(5);
    expect(revs.map((r) => Object.keys(r.diff as Record<string, unknown>)[0])).toEqual([
      'todos',
      'todos',
      'todos',
      'todos',
      'todos',
    ]);
  });

  it('a TICK records NONE — asserted as the absence, which is the half that regresses silently', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo } = await workItemTodosService.addTodo(card, { text: 'A step' }, fx.ctx);
    const afterAdd = (await todoRevisions(card, fx.workspaceId)).length;

    await workItemTodosService.setTodoDone(todo.id, true, fx.ctx);
    await workItemTodosService.setTodoDone(todo.id, false, fx.ctx);
    await workItemTodosService.setTodoDone(todo.id, true, fx.ctx);

    // Three ticks, zero history entries — the reason a six-step list does not
    // bury the edit that mattered under six ticks.
    expect((await todoRevisions(card, fx.workspaceId)).length).toBe(afterAdd);
  });

  it('the add / edit / move / delete diffs name the row, so History can render what changed', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo } = await workItemTodosService.addTodo(card, { text: 'A step' }, fx.ctx);
    const [added] = await todoRevisions(card, fx.workspaceId);
    expect(added!.diff).toMatchObject({ todos: { added: [{ id: todo.id, text: 'A step' }] } });

    await workItemTodosService.updateTodo(todo.id, { text: 'A better step' }, fx.ctx);
    const edited = (await todoRevisions(card, fx.workspaceId))[1]!;
    expect(edited.diff).toMatchObject({
      todos: { edited: [{ id: todo.id, from: { text: 'A step' }, to: { text: 'A better step' } }] },
    });
  });
});

describe('deleteTodo', () => {
  it('removes the row and leaves its siblings ordered', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo: a } = await workItemTodosService.addTodo(card, { text: 'A' }, fx.ctx);
    await workItemTodosService.addTodo(card, { text: 'B' }, fx.ctx);

    await workItemTodosService.deleteTodo(a.id, fx.ctx);
    expect(await positions(card, fx)).toEqual(['B']);
    await expect(workItemTodosService.updateTodo(a.id, { text: 'gone' }, fx.ctx)).rejects.toThrow(
      WorkItemTodoNotFoundError,
    );
  });
});

// ── the permission gate (ADR §4) ────────────────────────────────────────────

describe('permissions', () => {
  it('every WRITE is `work_item:edit`: a project VIEWER is refused add, edit, move, tick and delete alike', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo } = await workItemTodosService.addTodo(card, { text: 'A step' }, fx.ctx);

    const viewer = await createTestUser({ email: 'viewer@ex.com', name: 'Viewer' });
    await workspacesService.addMember({
      userId: viewer.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'viewer',
    });
    await withWorkspaceContext(fx.ctx, (tx) =>
      projectMembershipRepository.create(
        { workspaceId: fx.workspaceId, projectId: fx.projectId, userId: viewer.id },
        tx,
      ),
    );
    const viewerCtx = { userId: viewer.id, workspaceId: fx.workspaceId };

    // The TICK is in this list deliberately: it is the one write somebody
    // would reach for a softer key on, and the ADR says there is no split.
    await expect(workItemTodosService.addTodo(card, { text: 'nope' }, viewerCtx)).rejects.toThrow(
      ProjectAccessDeniedError,
    );
    await expect(
      workItemTodosService.updateTodo(todo.id, { text: 'nope' }, viewerCtx),
    ).rejects.toThrow(ProjectAccessDeniedError);
    await expect(workItemTodosService.moveTodo(todo.id, 0, viewerCtx)).rejects.toThrow(
      ProjectAccessDeniedError,
    );
    await expect(workItemTodosService.setTodoDone(todo.id, true, viewerCtx)).rejects.toThrow(
      ProjectAccessDeniedError,
    );
    await expect(workItemTodosService.deleteTodo(todo.id, viewerCtx)).rejects.toThrow(
      ProjectAccessDeniedError,
    );
  });

  it('a VIEWER can READ the list and its progress — they lose the controls, not the information', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo } = await workItemTodosService.addTodo(card, { text: 'A step' }, fx.ctx);
    await workItemTodosService.setTodoDone(todo.id, true, fx.ctx);

    const viewer = await createTestUser({ email: 'reader@ex.com', name: 'Reader' });
    await workspacesService.addMember({
      userId: viewer.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'viewer',
    });
    await withWorkspaceContext(fx.ctx, (tx) =>
      projectMembershipRepository.create(
        { workspaceId: fx.workspaceId, projectId: fx.projectId, userId: viewer.id },
        tx,
      ),
    );

    const list = await workItemTodosService.listTodos(card, {
      userId: viewer.id,
      workspaceId: fx.workspaceId,
    });
    expect(list.progress).toEqual({ done: 1, total: 1 });
  });

  it('a CROSS-WORKSPACE card is a 404, not a 403 — no existence leak', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Beta', identifier: 'BETA' });
    const theirCard = await makeCard(other);

    await expect(workItemTodosService.addTodo(theirCard, { text: 'nope' }, fx.ctx)).rejects.toThrow(
      WorkItemNotFoundError,
    );
    await expect(workItemTodosService.listTodos(theirCard, fx.ctx)).rejects.toThrow(
      WorkItemNotFoundError,
    );
  });

  it('an unknown to-do id is a 404', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemTodosService.setTodoDone('cmno0000000000000000000', true, fx.ctx),
    ).rejects.toThrow(WorkItemTodoNotFoundError);
  });
});

// ── row-level security (criteria 1 and 2) ───────────────────────────────────

describe('row-level security', () => {
  it('the policy is asserted from the RUNNING DATABASE, not from the migration file', async () => {
    const policies = await adminDb.$queryRawUnsafe<
      { policyname: string; qual: string; with_check: string }[]
    >(`SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = 'work_item_todo'`);

    // The catalog is the fact; the migration is a claim about it (the
    // `tests/rls/policyArms.ts` distinction, applied to this table's own gate).
    expect(policies.map((p) => p.policyname)).toEqual(['work_item_todo_active_workspace']);
    expect(policies[0]!.qual).toContain(`current_setting('app.workspace_id'::text, true)`);
    expect(policies[0]!.with_check).toContain(`current_setting('app.workspace_id'::text, true)`);

    const [flags] = await adminDb.$queryRawUnsafe<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'work_item_todo'`);
    expect(flags).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('a row written under workspace A is INVISIBLE to a read bound to workspace B', async () => {
    const a = await makeWorkItemFixture();
    const b = await makeWorkItemFixture({ name: 'Beta', identifier: 'BETA' });
    const cardA = await makeCard(a);
    await workItemTodosService.addTodo(cardA, { text: 'A secret step' }, a.ctx);

    // Bound to B, reading A's card id directly at the repository — the policy
    // is the only thing standing between the two, and it returns an EMPTY LIST
    // rather than raising, which is exactly why the repository's reads take a
    // required `tx`.
    const seenFromB = await withWorkspaceContext(b.ctx, (tx) =>
      workItemTodoRepository.listByWorkItem(cardA, tx),
    );
    expect(seenFromB).toEqual([]);

    const seenFromA = await withWorkspaceContext(a.ctx, (tx) =>
      workItemTodoRepository.listByWorkItem(cardA, tx),
    );
    expect(seenFromA.map((r) => r.text)).toEqual(['A secret step']);
  });
});

// ── concurrency (criterion 5) ───────────────────────────────────────────────

describe('concurrency', () => {
  it('TWO SIMULTANEOUS appends both land, with DISTINCT keys in a stable order', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await workItemTodosService.addTodo(card, { text: 'seed' }, fx.ctx);

    // Fired together, through a warm pool — a serial version of this test
    // passes against a service with no lock at all, which is the whole reason
    // the criterion says SIMULTANEOUS.
    const [one, two] = await Promise.all([
      workItemTodosService.addTodo(card, { text: 'first' }, fx.ctx),
      workItemTodosService.addTodo(card, { text: 'second' }, fx.ctx),
    ]);

    expect(one!.todo.position).not.toBe(two!.todo.position);
    const order = await positions(card, fx);
    expect(order).toHaveLength(3);
    expect(order[0]).toBe('seed');
    expect(new Set(order.slice(1))).toEqual(new Set(['first', 'second']));
  });

  it('FIVE simultaneous appends produce five distinct keys and a total order', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);

    const created = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((t) => workItemTodosService.addTodo(card, { text: t }, fx.ctx)),
    );

    expect(new Set(created.map((r) => r.todo.position)).size).toBe(5);
    expect(await positions(card, fx)).toHaveLength(5);
  });

  it('a simultaneous MOVE and APPEND leave the list intact', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo: a } = await workItemTodosService.addTodo(card, { text: 'A' }, fx.ctx);
    await workItemTodosService.addTodo(card, { text: 'B' }, fx.ctx);

    await Promise.all([
      workItemTodosService.moveTodo(a.id, 1, fx.ctx),
      workItemTodosService.addTodo(card, { text: 'C' }, fx.ctx),
    ]);

    const order = await positions(card, fx);
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set(['A', 'B', 'C']));
  });

  // ── one lock order (MOTIR-11259) ──────────────────────────────────────────
  //
  // A move takes the card's row lock and then writes the step's row. A delete
  // or an edit that wrote the step's row FIRST and only then inserted its
  // revision — whose foreign key takes `FOR KEY SHARE` on the same card row —
  // took the two locks in the opposite order, and Postgres killed one of them
  // with `40P01`. A plain `Promise.all` only hits that window now and then
  // (it reddened an unrelated pull request's CI), so these tests FORCE the
  // interleaving: a third transaction holds the card's row, the move is let
  // through its gate read and parks on the lock, the second writer is started
  // and parks too, and only then is the card released.

  /**
   * Run `body` while a separate admin transaction holds `FOR UPDATE` on the
   * card's row, and release it when `body` asks. The holder is always awaited,
   * so no backend outlives the test.
   */
  async function whileCardIsHeld(
    cardId: string,
    body: (release: () => void) => Promise<void>,
  ): Promise<void> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const holder = adminDb.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "work_item" WHERE "id" = ${cardId} FOR UPDATE`;
        markHeld();
        await released;
      },
      { timeout: 15_000 },
    );
    try {
      await held;
      await body(release);
    } finally {
      release();
      await holder;
    }
  }

  /** Wait until `count` backends on this database are blocked on a lock. */
  async function untilLockWaiters(count: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = await adminDb.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND backend_type = 'client backend'
            AND wait_event_type = 'Lock'`,
      );
      if ((rows[0]?.n ?? 0) >= count) return;
      if (Date.now() > deadline)
        throw new Error(`fewer than ${count} backends ever waited on a lock`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Every settled result, so a rejection never leaves its sibling running. */
  async function settle<A, B>(a: Promise<A>, b: Promise<B>) {
    return Promise.allSettled([a, b]) as Promise<
      [PromiseSettledResult<A>, PromiseSettledResult<B>]
    >;
  }

  it('a MOVE queued ahead of a DELETE of the same step both finish — no deadlock', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await workItemTodosService.addTodo(card, { text: 'Stays' }, fx.ctx);
    const { todo: doomed } = await workItemTodosService.addTodo(card, { text: 'Doomed' }, fx.ctx);

    let results!: [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];
    await whileCardIsHeld(card, async (release) => {
      const move = workItemTodosService.moveTodo(doomed.id, 0, fx.ctx);
      await untilLockWaiters(1);
      const del = workItemTodosService.deleteTodo(doomed.id, fx.ctx);
      await untilLockWaiters(2);
      release();
      results = await settle(move, del);
    });

    const [moved, deleted] = results;
    expect(deleted.status === 'rejected' ? deleted.reason : null).toBeNull();
    // The move was queued first, so it holds the card lock first and wins; the
    // only other legitimate answer is the typed conflict if the delete got in.
    if (moved.status === 'rejected') expect(moved.reason).toBeInstanceOf(TodoReorderConflictError);
    expect(await positions(card, fx)).toEqual(['Stays']);
  });

  it('a DELETE queued ahead of a MOVE of the same step answers the typed conflict', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await workItemTodosService.addTodo(card, { text: 'Stays' }, fx.ctx);
    const { todo: doomed } = await workItemTodosService.addTodo(card, { text: 'Doomed' }, fx.ctx);

    let results!: [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];
    await whileCardIsHeld(card, async (release) => {
      const del = workItemTodosService.deleteTodo(doomed.id, fx.ctx);
      await untilLockWaiters(1);
      const move = workItemTodosService.moveTodo(doomed.id, 0, fx.ctx);
      await untilLockWaiters(2);
      release();
      results = await settle(del, move);
    });

    const [deleted, moved] = results;
    expect(deleted.status === 'rejected' ? deleted.reason : null).toBeNull();
    expect(moved.status).toBe('rejected');
    if (moved.status === 'rejected') expect(moved.reason).toBeInstanceOf(TodoReorderConflictError);
    expect(await positions(card, fx)).toEqual(['Stays']);
  });

  it('a MOVE queued ahead of an EDIT of the same step both finish — no deadlock', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await workItemTodosService.addTodo(card, { text: 'First' }, fx.ctx);
    const { todo: step } = await workItemTodosService.addTodo(card, { text: 'Second' }, fx.ctx);

    let results!: [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];
    await whileCardIsHeld(card, async (release) => {
      const move = workItemTodosService.moveTodo(step.id, 0, fx.ctx);
      await untilLockWaiters(1);
      const edit = workItemTodosService.updateTodo(step.id, { text: 'Second, edited' }, fx.ctx);
      await untilLockWaiters(2);
      release();
      results = await settle(move, edit);
    });

    for (const r of results) expect(r.status === 'rejected' ? r.reason : null).toBeNull();
    expect(await positions(card, fx)).toEqual(['Second, edited', 'First']);
    // The edit read the step AFTER the move committed, so its revision's
    // `from` is the row as it stood, not a snapshot from before the lock.
    const edits = (await todoRevisions(card, fx.workspaceId)).filter(
      (r) => (r.diff as { todos?: { edited?: unknown } }).todos?.edited,
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]!.diff).toMatchObject({
      todos: {
        edited: [{ id: step.id, from: { text: 'Second' }, to: { text: 'Second, edited' } }],
      },
    });
  });

  it('two DELETEs of the same step: one removes it, the other is a typed not-found', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo: doomed } = await workItemTodosService.addTodo(card, { text: 'Doomed' }, fx.ctx);

    let results!: [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];
    await whileCardIsHeld(card, async (release) => {
      const first = workItemTodosService.deleteTodo(doomed.id, fx.ctx);
      await untilLockWaiters(1);
      const second = workItemTodosService.deleteTodo(doomed.id, fx.ctx);
      await untilLockWaiters(2);
      release();
      results = await settle(first, second);
    });

    const [first, second] = results;
    expect(first.status === 'rejected' ? first.reason : null).toBeNull();
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected')
      expect(second.reason).toBeInstanceOf(WorkItemTodoNotFoundError);
    expect(await positions(card, fx)).toEqual([]);
  });
});
