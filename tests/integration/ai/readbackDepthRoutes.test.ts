import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { foldersService } from '@/lib/services/foldersService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { mintJobToken } from '@/lib/ai/jobToken';
import { GET as getItemGET } from '@/app/api/internal/ai/get-item/route';
import { GET as getSubtreeGET } from '@/app/api/internal/ai/get-subtree/route';
import { GET as walkBlockingGET } from '@/app/api/internal/ai/walk-blocking/route';
import { GET as skeletonGET } from '@/app/api/internal/ai/skeleton/route';
import {
  makeWorkItemFixture as makeFixture,
  createTestLink,
  createTestProject,
} from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST (Subtask 7.5.1) — the plan-tree graph-traversal read family
// end-to-end through the REAL routes, against a real Postgres. Exercises BOTH
// auth grants (§4a service bearer + §4b job token), the 400 on a missing key,
// and the 404-not-403 cross-tenant posture — the same discipline as 7.1.6's
// readbackRoutes.test.ts, extended to get_item / get_subtree / walk_blocking /
// skeleton.

const SERVICE_SECRET = 'core-callback-secret-test';

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Fx = Awaited<ReturnType<typeof makeFixture>>;

function tokenFor(fx: Fx): string {
  return mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  });
}

function req(
  path: string,
  opts: { bearer?: string; token?: string; query?: Record<string, string> },
): Request {
  const url = new URL(`http://core/api/internal/ai/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request(url, { headers });
}

describe('GET /api/internal/ai/get-item', () => {
  it('returns the item, with comments + history when asked', async () => {
    const fx = await makeFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Item' },
      fx.ctx,
    );
    await commentsService.addComment(item.id, { bodyMd: 'a note' }, fx.ctx);

    const res = await getItemGET(
      req('get-item', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        query: { key: item.identifier, withComments: '1', withHistory: '1' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.item.identifier).toBe(item.identifier);
    expect(body.comments.threads).toHaveLength(1);
    expect(body.history.revisions.length).toBeGreaterThanOrEqual(1);
  });

  it('carries all five link kinds on the item — the whole graph, not the tree', async () => {
    const fx = await makeFixture();
    const make = (title: string) =>
      workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'story', title }, fx.ctx);
    const target = await make('Target');
    const blocker = await make('Blocker');
    const blocked = await make('Blocked');
    const related = await make('Related');
    const duplicate = await make('Duplicate');
    const clone = await make('Clone');
    const link = (
      fromId: string,
      toId: string,
      kind: 'is_blocked_by' | 'relates_to' | 'duplicates' | 'clones',
    ) =>
      createTestLink({ workspaceId: fx.workspaceId, fromId, toId, kind, createdById: fx.ownerId });
    await link(target.id, blocker.id, 'is_blocked_by');
    await link(blocked.id, target.id, 'is_blocked_by');
    await link(target.id, related.id, 'relates_to');
    await link(target.id, duplicate.id, 'duplicates');
    await link(target.id, clone.id, 'clones');

    const res = await getItemGET(
      req('get-item', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        query: { key: target.identifier },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const expected: Record<string, string> = {
      blockedBy: blocker.identifier,
      blocks: blocked.identifier,
      relatesTo: related.identifier,
      duplicates: duplicate.identifier,
      clones: clone.identifier,
    };
    // Per KIND — the enumeration that went short by one is exactly the thing a
    // group-shaped assertion would not have caught (MOTIR-4090).
    for (const [kind, identifier] of Object.entries(expected)) {
      expect(
        body.item[kind].map((l: { item: { identifier: string } }) => l.item.identifier),
        kind,
      ).toEqual([identifier]);
    }
    // Each entry carries what a planner acts on, over the wire.
    expect(body.item.blocks[0].item).toMatchObject({
      identifier: blocked.identifier,
      title: 'Blocked',
      kind: 'story',
      status: 'todo',
    });
  });

  it('withholds a link whose far end is in a project the token is not scoped to', async () => {
    const fx = await makeFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Target' },
      fx.ctx,
    );
    const foreign = await workItemsService.createWorkItem(
      { projectId: other.id, kind: 'story', title: 'Somebody else’s secret' },
      fx.ctx,
    );
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: target.id,
      toId: foreign.id,
      kind: 'relates_to',
      createdById: fx.ownerId,
    });

    const res = await getItemGET(
      req('get-item', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        query: { key: target.identifier },
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).item.relatesTo).toEqual([]);
    // Not merely absent from the array — the other project's key and title do
    // not appear in the payload at all.
    expect(text).not.toContain(foreign.identifier);
    expect(text).not.toContain('secret');
  });

  // MOTIR-10316 — the card's to-do steps ride the item, so a planner re-authoring
  // a committed card reads what its steps are and which are already ticked.
  it('carries the card’s to-do steps in list order, with the ticked state in `done`', async () => {
    const fx = await makeFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'With steps' },
      fx.ctx,
    );
    const first = await workItemTodosService.addTodo(
      item.id,
      { text: 'Create the API key', notesMd: 'Open **Settings › Keys**.', executor: 'human' },
      fx.ctx,
    );
    const second = await workItemTodosService.addTodo(
      item.id,
      { text: 'Store it as a secret', commandText: 'fly secrets set KEY=…' },
      fx.ctx,
    );
    const third = await workItemTodosService.addTodo(
      item.id,
      { text: 'Verify the deploy', executor: 'coding_agent' },
      fx.ctx,
    );
    // Tick the MIDDLE step, so `done` is read per row rather than inferred from
    // a prefix of the list.
    await workItemTodosService.setTodoDone(second.todo.id, true, fx.ctx);
    // Move the last step to the front: the payload follows the LIST order (as
    // `list_work_item_todos` does), not creation order.
    await workItemTodosService.moveTodo(third.todo.id, 0, fx.ctx);

    const res = await getItemGET(
      req('get-item', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        query: { key: item.identifier },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.item.todos).toEqual([
      {
        id: third.todo.id,
        text: 'Verify the deploy',
        notesMd: null,
        commandText: null,
        executor: 'coding_agent',
        done: false,
      },
      {
        id: first.todo.id,
        text: 'Create the API key',
        notesMd: 'Open **Settings › Keys**.',
        commandText: null,
        executor: 'human',
        done: false,
      },
      {
        id: second.todo.id,
        text: 'Store it as a secret',
        notesMd: null,
        commandText: 'fly secrets set KEY=…',
        // Omitted on the add ⇒ the service resolves it (the card's executor, else
        // human); the boundary reports whatever the service stored.
        executor: second.todo.executor,
        done: true,
      },
    ]);
    // The boundary and the MCP tool's read agree, row for row, on order and `done`.
    const list = await workItemTodosService.listTodos(item.id, fx.ctx);
    expect(body.item.todos.map((t: { id: string; done: boolean }) => [t.id, t.done])).toEqual(
      list.items.map((t) => [t.id, t.done]),
    );
  });

  it('carries `todos: []` — present, not absent — for a card with no steps', async () => {
    const fx = await makeFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'No steps' },
      fx.ctx,
    );
    const res = await getItemGET(
      req('get-item', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        query: { key: item.identifier },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.item).toHaveProperty('todos');
    expect(body.item.todos).toEqual([]);
  });

  it('404s a key in another project of the same workspace, and returns none of its steps', async () => {
    const fx = await makeFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const foreign = await workItemsService.createWorkItem(
      { projectId: other.id, kind: 'task', title: 'Elsewhere' },
      fx.ctx,
    );
    await workItemTodosService.addTodo(foreign.id, { text: 'A step nobody here may read' }, fx.ctx);

    const res = await getItemGET(
      req('get-item', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        query: { key: foreign.identifier },
      }),
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('A step nobody here may read');
    expect(JSON.parse(text)).not.toHaveProperty('item');
  });

  it('400s a missing key', async () => {
    const fx = await makeFixture();
    const res = await getItemGET(req('get-item', { bearer: SERVICE_SECRET, token: tokenFor(fx) }));
    expect(res.status).toBe(400);
  });

  it('401s a missing service bearer', async () => {
    const fx = await makeFixture();
    const res = await getItemGET(
      req('get-item', { token: tokenFor(fx), query: { key: 'MOTIR-1' } }),
    );
    expect(res.status).toBe(401);
  });

  it('404s a key from another tenant’s project', async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    const bItem = await workItemsService.createWorkItem(
      { projectId: b.projectId, kind: 'story', title: 'B' },
      b.ctx,
    );
    // A's user + workspace but the token claims B's project id.
    const foreign = mintJobToken({
      userId: a.ctx.userId,
      workspaceId: a.ctx.workspaceId,
      projectId: b.projectId,
    });
    const res = await getItemGET(
      req('get-item', { bearer: SERVICE_SECRET, token: foreign, query: { key: bItem.identifier } }),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/internal/ai/get-subtree', () => {
  it('returns the depth-bounded skeleton neighborhood', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story', parentId: epic.id },
      fx.ctx,
    );

    const res = await getSubtreeGET(
      req('get-subtree', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        query: { rootKey: epic.identifier, depth: '1' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.root).toBe(epic.identifier);
    expect(body.depth).toBe(1);
    expect(body.nodes.length).toBe(2);
  });

  // MOTIR-5410 — a subtree node carries its OWN placement: the filed root has
  // its folder, its child (never filed — the CHECK) has none.
  it('carries folderId on each node — the filed root’s folder, null below it', async () => {
    const fx = await makeFixture();
    const parked = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Parked' },
      fx.ctx,
    );
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Filed epic', folderId: parked.id },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story', parentId: epic.id },
      fx.ctx,
    );

    const res = await getSubtreeGET(
      req('get-subtree', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        query: { rootKey: epic.identifier, depth: '1' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const byKey = new Map(
      body.nodes.map((n: { key: string; folderId: string | null }) => [n.key, n.folderId]),
    );
    expect(byKey.get(epic.identifier)).toBe(parked.id);
    expect(byKey.get(story.identifier)).toBeNull();
  });

  it('400s a missing rootKey', async () => {
    const fx = await makeFixture();
    const res = await getSubtreeGET(
      req('get-subtree', { bearer: SERVICE_SECRET, token: tokenFor(fx) }),
    );
    expect(res.status).toBe(400);
  });

  it('401s a tampered token', async () => {
    const fx = await makeFixture();
    const [payload] = tokenFor(fx).split('.');
    const res = await getSubtreeGET(
      req('get-subtree', {
        bearer: SERVICE_SECRET,
        token: `${payload}.deadbeef`,
        query: { rootKey: 'MOTIR-1' },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /api/internal/ai/walk-blocking', () => {
  it('returns the transitive is_blocked_by closure', async () => {
    const fx = await makeFixture();
    const [a, b] = await Promise.all([
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'A' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'B' },
        fx.ctx,
      ),
    ]);
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: a.id,
      toId: b.id,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });

    const res = await walkBlockingGET(
      req('walk-blocking', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        query: { key: a.identifier },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes.map((n: { key: string }) => n.key)).toEqual([b.identifier]);
    expect(body.edges).toEqual([{ blockedKey: a.identifier, blockerKey: b.identifier }]);
    expect(body.truncated).toBe(false);
  });

  it('400s a missing key', async () => {
    const fx = await makeFixture();
    const res = await walkBlockingGET(
      req('walk-blocking', { bearer: SERVICE_SECRET, token: tokenFor(fx) }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/internal/ai/skeleton', () => {
  it('returns the breadth projection (same as plan-tree) for the token project', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );

    const res = await skeletonGET(req('skeleton', { bearer: SERVICE_SECRET, token: tokenFor(fx) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { key: string }) => i.key)).toContain(epic.identifier);
  });

  it('carries the same folder placement as plan-tree — folderId on the row, folders beside', async () => {
    const fx = await makeFixture();
    const parked = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Parked' },
      fx.ctx,
    );
    const year = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: parked.id, name: '2025' },
      fx.ctx,
    );
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic', folderId: year.id },
      fx.ctx,
    );

    const res = await skeletonGET(req('skeleton', { bearer: SERVICE_SECRET, token: tokenFor(fx) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.find((i: { key: string }) => i.key === epic.identifier)?.folderId).toBe(
      year.id,
    );
    expect(body.folders.map((f: { path: string[] }) => f.path)).toEqual([
      ['Bugs'],
      ['Parked'],
      ['Parked', '2025'],
    ]);
    expect(body.foldersTruncated).toBe(false);
  });

  it('404s a foreign-project token', async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    const foreign = mintJobToken({
      userId: a.ctx.userId,
      workspaceId: a.ctx.workspaceId,
      projectId: b.projectId,
    });
    const res = await skeletonGET(req('skeleton', { bearer: SERVICE_SECRET, token: foreign }));
    expect(res.status).toBe(404);
  });
});
