import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-11838 — the `clear_container_type_executor` forward data migration.
//
// Plan approval's `materialize` copied a proposal's `executor` (and `type`) onto
// every `add`, epics and stories included, and a container stored that way could
// not be edited afterwards (TYPE_NOT_ALLOWED_ON_KIND on every update). The code
// fix stops new rows acquiring the values; this migration clears the old ones.
//
// The suite replays the migration's real SQL against real Postgres and pins its
// predicate from both sides: every epic and story ends with neither field, and
// no leaf loses either.

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261119230000_clear_container_type_executor/migration.sql',
  ),
  'utf8',
);

/** Apply the migration as `migrate deploy` would: one `DO $$ … $$` block, sent whole. */
async function runMigration(): Promise<void> {
  await adminDb.$executeRawUnsafe(MIGRATION_SQL);
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * A work item of `kind`, then forced to the given leaf fields through the owner
 * client — the state the bug wrote, which no service door will create.
 */
async function seed(
  fx: WorkItemFixture,
  kind: 'epic' | 'story' | 'task' | 'subtask' | 'bug',
  title: string,
  fields: {
    type?: 'code' | 'design' | 'manual' | null;
    executor?: 'coding_agent' | 'human' | null;
  },
  parentId?: string,
) {
  const item = await createTestWorkItem(fx, { kind, title, ...(parentId ? { parentId } : {}) });
  await adminDb.workItem.update({
    where: { id: item.id },
    data: { type: fields.type ?? null, executor: fields.executor ?? null },
  });
  return item;
}

const fieldsOf = async (id: string) => {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return { type: row.type, executor: row.executor };
};

describe('clear_container_type_executor', () => {
  it('clears type and executor from every epic and story that carries one', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seed(fx, 'epic', 'Epic', { type: 'code', executor: 'human' });
    const story = await seed(fx, 'story', 'Story', { executor: 'coding_agent' }, epic.id);
    const typedStory = await seed(fx, 'story', 'Typed story', { type: 'design' }, epic.id);

    await runMigration();

    expect(await fieldsOf(epic.id)).toEqual({ type: null, executor: null });
    expect(await fieldsOf(story.id)).toEqual({ type: null, executor: null });
    expect(await fieldsOf(typedStory.id)).toEqual({ type: null, executor: null });
    // Only the two leaf fields move — the row is otherwise as it was.
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(row.kind).toBe('story');
    expect(row.parentId).toBe(epic.id);
  });

  it('leaves every LEAF kind its type and executor', async () => {
    const fx = await makeWorkItemFixture();
    const story = await seed(fx, 'story', 'Story', { executor: 'coding_agent' });
    const task = await seed(fx, 'task', 'Task', { type: 'manual', executor: 'human' }, story.id);
    const subtask = await seed(
      fx,
      'subtask',
      'Subtask',
      { type: 'code', executor: 'coding_agent' },
      task.id,
    );
    const bug = await seed(fx, 'bug', 'Bug', { type: 'code', executor: 'coding_agent' });

    await runMigration();

    expect(await fieldsOf(task.id)).toEqual({ type: 'manual', executor: 'human' });
    expect(await fieldsOf(subtask.id)).toEqual({ type: 'code', executor: 'coding_agent' });
    expect(await fieldsOf(bug.id)).toEqual({ type: 'code', executor: 'coding_agent' });
  });

  it('after it runs, no epic or story in any project carries a type or executor', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme' });
    const b = await makeWorkItemFixture({ name: 'Globex' });
    await seed(a, 'epic', 'A epic', { executor: 'human' });
    await seed(b, 'story', 'B story', { type: 'code', executor: 'coding_agent' });

    await runMigration();

    const remaining = await adminDb.workItem.count({
      where: {
        kind: { in: ['epic', 'story'] },
        OR: [{ type: { not: null } }, { executor: { not: null } }],
      },
    });
    expect(remaining).toBe(0);
  });

  it('is idempotent — a second apply changes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const story = await seed(fx, 'story', 'Story', { executor: 'coding_agent' });
    const task = await seed(fx, 'task', 'Task', { type: 'code', executor: 'coding_agent' });

    await runMigration();
    const before = await adminDb.workItem.findMany({ orderBy: { id: 'asc' } });
    await runMigration();
    const after = await adminDb.workItem.findMany({ orderBy: { id: 'asc' } });

    expect(after).toEqual(before);
    expect(await fieldsOf(story.id)).toEqual({ type: null, executor: null });
    expect(await fieldsOf(task.id)).toEqual({ type: 'code', executor: 'coding_agent' });
  });

  it('a story the migration cleared can be re-parented through the service again', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seed(fx, 'epic', 'Target', {});
    const story = await seed(fx, 'story', 'Stuck story', { executor: 'coding_agent' });

    // The bug's symptom, at the reporter's state: the item page's parent edit
    // (`updateWorkItem` with a `parentId`) is refused for the hidden executor.
    await expect(
      workItemsService.updateWorkItem(story.id, { parentId: epic.id }, fx.ctx),
    ).rejects.toMatchObject({ code: 'TYPE_NOT_ALLOWED_ON_KIND' });

    await runMigration();

    const moved = await workItemsService.updateWorkItem(story.id, { parentId: epic.id }, fx.ctx);
    expect(moved.parentId).toBe(epic.id);
  });
});
