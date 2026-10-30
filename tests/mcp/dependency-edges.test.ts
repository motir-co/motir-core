import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { buildMcpServer } from '@/lib/mcp/registry';
import { runListReady } from '@/lib/mcp/tools/listReady';
import { runSearchWorkItems } from '@/lib/mcp/tools/searchWorkItems';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { attachEdges, edgeMarker } from '@/lib/mcp/dependencyEdges';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { countDelegateCalls } from '../helpers/countDelegateCalls';

// The dependency-EDGE projection for the MCP LIST reads (Subtask 7.9.0f /
// MOTIR-1842) over real Postgres. Three layers, one contract:
//
//   repository — `findBlockedEdgesForItems`, the REVERSE-direction sibling of
//     `findBlockerEdgesForItems`: one query, archived far ends excluded, empty
//     input short-circuits WITHOUT a query, workspace-scoped.
//   service    — `getDependencyEdgesForItems`, both directions keyed by item id,
//     TOTAL (empty arrays, never a missing key), and — the load-bearing claim —
//     TWO queries for a page of ANY size. Asserted by spying on the Prisma
//     delegate itself, so the count is real queries, not repository calls.
//   transport  — `list_ready` + `search_work_items` attach the IDENTICAL
//     `dependencies` block to every structuredContent row and render the same
//     compact marker in the text block.
//
// Plus the CHILD projection (Subtask 7.9.16b / MOTIR-1848): `get_work_item`
// attaches the SAME block to every child of the detail aggregate, from the SAME
// batched reader — the sibling sub-graph `motir show`'s build-order wave view is
// computed from. Same three claims (identical shape, total, two queries), now on
// the aggregate.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const mk = (fx: WorkItemFixture, title: string, projectId?: string) =>
  workItemsService.createWorkItem(
    { projectId: projectId ?? fx.projectId, kind: 'task', title },
    fx.ctx,
  );

/** A story, and a subtask under it — the parent/child shape `get_work_item`
 * projects sibling edges onto. */
const mkStory = (fx: WorkItemFixture, title: string) =>
  workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'story', title }, fx.ctx);

const mkChild = (fx: WorkItemFixture, parentId: string, title: string) =>
  workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', title, parentId },
    fx.ctx,
  );

const block = (fx: WorkItemFixture, blockedId: string, blockerId: string) =>
  workItemsService.linkWorkItems(
    { fromId: blockedId, toId: blockerId, kind: 'is_blocked_by' },
    fx.ctx,
  );

const archive = (id: string) =>
  adminDb.workItem.update({ where: { id }, data: { archivedAt: new Date() } });

const markDone = (id: string) =>
  adminDb.workItem.update({ where: { id }, data: { status: 'done' } });

/**
 * Count REAL `work_item_link` queries issued while `run` executes.
 *
 * ⚠️ The count MUST come off `db` — the `@/lib/db` singleton the code under test
 * reads through — NOT off `adminDb`. `adminDb` is for fixtures, teardown and
 * existence-readbacks only (MOTIR-2513's two-client model); counting there
 * counts a client the repository never touches, so every assertion here
 * silently measures 0 and passes only where 0 is expected.
 *
 * …and off the TRANSACTION client too, which is why this delegates to
 * `countDelegateCalls` rather than spying directly (MOTIR-2846): once the call
 * site is bound the read runs on `(tx ?? dbRead)`'s `tx` arm and a singleton-only
 * spy reports zero — red for a `toBe(2)` and vacuously green for a `toBe(0)`.
 */
async function countLinkQueries<T>(run: () => Promise<T>): Promise<{ result: T; queries: number }> {
  return countDelegateCalls('workItemLink', 'findMany', run);
}

/** Connect an in-memory MCP client to a server bound to `ctx` (no scope gate). */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'dependency-edges', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

type Row = { id: string; dependencies: { blockedBy: unknown[]; blocks: unknown[] } };
const rows = (r: CallToolResult) => (r.structuredContent as { items: Row[] }).items;
const textOf = (r: CallToolResult) => JSON.stringify(r.content);

/**
 * The repository reads below are the SUBJECT of this block, so they stay on the
 * code-under-test's client and get a BOUND transaction — MOTIR-2911's first
 * disposition. They are `(tx ?? dbRead).workItemLink.findMany`, and `work_item_link`
 * is workspace-keyed: called with no `tx` under `motir_app` the policy sees no
 * `app.workspace_id`, admits nothing, and every one of these reads answers `[]`
 * without raising. Moving them to `adminDb` would also make them green — by
 * taking the read off the restricted role, i.e. by deleting the only thing this
 * block proves. So: bind, never re-client.
 */
describe('workItemLinkRepository.findBlockedEdgesForItems — the reverse edge read', () => {
  it('short-circuits on an empty id set WITHOUT issuing a query', async () => {
    const fx = await makeWorkItemFixture();
    const { result, queries } = await countLinkQueries(() =>
      withWorkspaceContext(fx.ctx, (tx) =>
        workItemLinkRepository.findBlockedEdgesForItems([], undefined, tx),
      ),
    );
    expect(result).toEqual([]);
    expect(queries).toBe(0);
  });

  it('returns what each item BLOCKS — key, title, status — in ONE query', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const dependentA = await mk(fx, 'Wire the UI');
    const dependentB = await mk(fx, 'Wire the API');
    await block(fx, dependentA.id, blocker.id);
    await block(fx, dependentB.id, blocker.id);

    const { result, queries } = await countLinkQueries(() =>
      withWorkspaceContext(fx.ctx, (tx) =>
        workItemLinkRepository.findBlockedEdgesForItems([blocker.id], undefined, tx),
      ),
    );
    expect(queries).toBe(1);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.blockedKey).sort()).toEqual(
      [dependentA.identifier, dependentB.identifier].sort(),
    );
    const a = result.find((r) => r.blockedId === dependentA.id)!;
    expect(a).toMatchObject({
      toId: blocker.id,
      blockedKey: dependentA.identifier,
      blockedTitle: 'Wire the UI',
      blockedStatus: 'todo',
      blockedProjectId: fx.projectId,
    });
  });

  it('EXCLUDES an archived item on the far end (the MOTIR-1328 rule, mirrored)', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const live = await mk(fx, 'Live dependent');
    const gone = await mk(fx, 'Archived dependent');
    await block(fx, live.id, blocker.id);
    await block(fx, gone.id, blocker.id);
    await archive(gone.id);

    const edges = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemLinkRepository.findBlockedEdgesForItems([blocker.id], undefined, tx),
    );
    expect(edges.map((e) => e.blockedId)).toEqual([live.id]);
  });

  it('scopes to the given workspace — another tenant’s id yields nothing', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const blocker = await mk(fx, 'Ship the schema');
    const dependent = await mk(fx, 'Wire the UI');
    await block(fx, dependent.id, blocker.id);

    // BOTH reads bind OUR workspace, so the `workspaceId` ARGUMENT stays the only
    // thing that separates them — bind the foreign tenant for the second and the
    // policy hides the row as well, which is the same observation for a different
    // reason and stops testing the parameter at all.
    expect(
      await withWorkspaceContext(fx.ctx, (tx) =>
        workItemLinkRepository.findBlockedEdgesForItems([blocker.id], fx.workspaceId, tx),
      ),
    ).toHaveLength(1);
    expect(
      await withWorkspaceContext(fx.ctx, (tx) =>
        workItemLinkRepository.findBlockedEdgesForItems([blocker.id], other.workspaceId, tx),
      ),
    ).toEqual([]);
  });

  it('its forward sibling carries the blocker’s TITLE for the same projection', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const dependent = await mk(fx, 'Wire the UI');
    await block(fx, dependent.id, blocker.id);

    const edges = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemLinkRepository.findBlockerEdgesForItems([dependent.id], fx.workspaceId, tx),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromId: dependent.id,
      blockerKey: blocker.identifier,
      blockerTitle: 'Ship the schema',
      blockerStatus: 'todo',
    });
  });
});

describe('workItemsService.getDependencyEdgesForItems — the page projection', () => {
  it('returns BOTH directions keyed by item id', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const middle = await mk(fx, 'Wire the service');
    const dependent = await mk(fx, 'Wire the UI');
    await block(fx, middle.id, blocker.id);
    await block(fx, dependent.id, middle.id);

    const edges = await workItemsService.getDependencyEdgesForItems(
      [blocker.id, middle.id, dependent.id],
      fx.ctx,
    );
    expect(edges[middle.id]).toEqual({
      blockedBy: [{ key: blocker.identifier, title: 'Ship the schema', status: 'todo' }],
      blocks: [{ key: dependent.identifier, title: 'Wire the UI', status: 'todo' }],
    });
    expect(edges[blocker.id]!.blockedBy).toEqual([]);
    expect(edges[dependent.id]!.blocks).toEqual([]);
  });

  it('is TOTAL — an edge-free item carries empty arrays, never a missing key', async () => {
    const fx = await makeWorkItemFixture();
    const lonely = await mk(fx, 'No edges at all');

    const edges = await workItemsService.getDependencyEdgesForItems([lonely.id], fx.ctx);
    expect(Object.keys(edges)).toEqual([lonely.id]);
    expect(edges[lonely.id]).toEqual({ blockedBy: [], blocks: [] });
  });

  it('short-circuits an empty page to {} without a query', async () => {
    const fx = await makeWorkItemFixture();
    const { result, queries } = await countLinkQueries(() =>
      workItemsService.getDependencyEdgesForItems([], fx.ctx),
    );
    expect(result).toEqual({});
    expect(queries).toBe(0);
  });

  it('issues at most TWO queries for a 24-item page with edges in both directions', async () => {
    const fx = await makeWorkItemFixture();
    const items: Awaited<ReturnType<typeof mk>>[] = [];
    for (let i = 0; i < 24; i++) items.push(await mk(fx, `Item ${i}`));
    // A chain: every item blocks its successor, so every interior item has an
    // edge in BOTH directions — the worst case for an N+1.
    for (let i = 1; i < items.length; i++) await block(fx, items[i]!.id, items[i - 1]!.id);

    const { result, queries } = await countLinkQueries(() =>
      workItemsService.getDependencyEdgesForItems(
        items.map((i) => i.id),
        fx.ctx,
      ),
    );
    expect(queries).toBe(2);
    expect(Object.keys(result)).toHaveLength(24);
    expect(result[items[12]!.id]).toEqual({
      blockedBy: [{ key: items[11]!.identifier, title: 'Item 11', status: 'todo' }],
      blocks: [{ key: items[13]!.identifier, title: 'Item 13', status: 'todo' }],
    });
  });

  it('resolves an edge to another PROJECT in the same workspace', async () => {
    const fx = await makeWorkItemFixture();
    const otherProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'PLAT',
    });
    const here = await mk(fx, 'Depends on the platform');
    const there = await mk(fx, 'Platform primitive', otherProject.id);
    await block(fx, here.id, there.id);

    const edges = await workItemsService.getDependencyEdgesForItems([here.id], fx.ctx);
    expect(edges[here.id]!.blockedBy).toEqual([
      { key: there.identifier, title: 'Platform primitive', status: 'todo' },
    ]);
    // The far end really is in the OTHER project — the edge crossed a project
    // boundary, which `link_work_items` allows inside one workspace.
    expect(there.projectId).toBe(otherProject.id);
    expect(there.projectId).not.toBe(here.projectId);
  });

  it('never returns a far end from another TENANT (the link itself is rejected)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const here = await mk(fx, 'Ours');
    const theirs = await mk(other, 'Theirs');

    // The boundary owes a plain NOT FOUND here, never `CrossWorkspaceLinkError`
    // — decided 2026-08-17 (MOTIR-2919), reasoning on the error class in
    // `lib/workItems/linkErrors.ts` and in `docs/decisions/public-api-conventions.md`
    // § Errors. Naming the reason would confirm that `theirs.id` resolves in
    // another tenant, which is the existence oracle the 404-not-403 contract
    // refuses. This holds in BOTH connection modes: under `motir_app` RLS hides
    // the row so the resolve fails, and under a bypassing role the service's
    // workspace comparison raises the same error. Do not "fix" this back.
    await expect(block(fx, here.id, theirs.id)).rejects.toBeInstanceOf(WorkItemNotFoundError);
    // …and reading the other tenant's item through OUR context yields nothing.
    const edges = await workItemsService.getDependencyEdgesForItems([here.id, theirs.id], fx.ctx);
    expect(edges[here.id]).toEqual({ blockedBy: [], blocks: [] });
    expect(edges[theirs.id]).toEqual({ blockedBy: [], blocks: [] });
  });

  it('orders each direction by key, numeric-aware (PROD-9 before PROD-10)', async () => {
    const fx = await makeWorkItemFixture();
    const hub = await mk(fx, 'Hub');
    const made: Awaited<ReturnType<typeof mk>>[] = [];
    // Create enough items that the identifiers cross the 9 → 10 boundary.
    for (let i = 0; i < 12; i++) made.push(await mk(fx, `Dep ${i}`));
    // Link in REVERSE creation order so insertion order can't be what sorts them.
    for (const item of [...made].reverse()) await block(fx, item.id, hub.id);

    const edges = await workItemsService.getDependencyEdgesForItems([hub.id], fx.ctx);
    const keys = edges[hub.id]!.blocks.map((e) => e.key);
    expect(keys).toEqual(made.map((m) => m.identifier));
  });
});

describe('the `dependencies` block on the MCP list reads', () => {
  it('list_ready rows carry the block; a ready item shows what it BLOCKS', async () => {
    const fx = await makeWorkItemFixture();
    const ready = await mk(fx, 'Ship the schema');
    const dependent = await mk(fx, 'Wire the UI');
    await block(fx, dependent.id, ready.id);

    const res = await runListReady({ projectKey: 'PROD' }, fx.ctx);
    const items = rows(res);
    // `dependent` is blocked, so only `ready` is in the ready set.
    expect(items).toHaveLength(1);
    expect(items[0]!.dependencies).toEqual({
      blockedBy: [],
      blocks: [{ key: dependent.identifier, title: 'Wire the UI', status: 'todo' }],
    });
    expect(textOf(res)).toContain(`blocks ${dependent.identifier}`);
  });

  it('list_ready shows a satisfied blocker in blockedBy (a done blocker keeps it ready)', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const item = await mk(fx, 'Wire the UI');
    await block(fx, item.id, blocker.id);
    await markDone(blocker.id);

    const items = rows(await runListReady({ projectKey: 'PROD' }, fx.ctx));
    const row = items.find((r) => r.id === item.id)!;
    expect(row.dependencies).toEqual({
      blockedBy: [{ key: blocker.identifier, title: 'Ship the schema', status: 'done' }],
      blocks: [],
    });
  });

  it('an edge-free row still carries both arrays, and its text line is unchanged', async () => {
    const fx = await makeWorkItemFixture();
    await mk(fx, 'All alone');

    const res = await runListReady({ projectKey: 'PROD' }, fx.ctx);
    expect(rows(res)[0]!.dependencies).toEqual({ blockedBy: [], blocks: [] });
    expect(textOf(res)).not.toContain('blocked by');
    expect(textOf(res)).not.toContain('blocks ');
  });

  it('search_work_items carries the IDENTICAL block for the same item', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const middle = await mk(fx, 'Wire the service');
    const dependent = await mk(fx, 'Wire the UI');
    await block(fx, middle.id, blocker.id);
    await block(fx, dependent.id, middle.id);
    await markDone(blocker.id);

    const readyRow = rows(await runListReady({ projectKey: 'PROD' }, fx.ctx)).find(
      (r) => r.id === middle.id,
    )!;
    const searchRow = rows(await runSearchWorkItems({ projectKey: 'PROD' }, fx.ctx)).find(
      (r) => r.id === middle.id,
    )!;
    expect(searchRow.dependencies).toEqual(readyRow.dependencies);
    expect(searchRow.dependencies).toEqual({
      blockedBy: [{ key: blocker.identifier, title: 'Ship the schema', status: 'done' }],
      blocks: [{ key: dependent.identifier, title: 'Wire the UI', status: 'todo' }],
    });
  });

  it('search_work_items renders both directions in its text block', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const middle = await mk(fx, 'Wire the service');
    const dependent = await mk(fx, 'Wire the UI');
    await block(fx, middle.id, blocker.id);
    await block(fx, dependent.id, middle.id);

    const text = textOf(await runSearchWorkItems({ projectKey: 'PROD' }, fx.ctx));
    expect(text).toContain(`blocked by ${blocker.identifier} · blocks ${dependent.identifier}`);
  });

  it('both tools advertise the block, and it survives the real transport', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const dependent = await mk(fx, 'Wire the UI');
    await block(fx, dependent.id, blocker.id);

    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    for (const name of ['list_ready', 'search_work_items']) {
      expect(tools.find((t) => t.name === name)!.description).toContain('dependencies');
    }
    const res = (await client.callTool({
      name: 'search_work_items',
      arguments: { projectKey: 'PROD' },
    })) as CallToolResult;
    const row = rows(res).find((r) => r.id === dependent.id)!;
    expect(row.dependencies).toEqual({
      blockedBy: [{ key: blocker.identifier, title: 'Ship the schema', status: 'todo' }],
      blocks: [],
    });
    await client.close();
  });
});

describe('attachEdges', () => {
  it('is TOTAL — a row the reader had no entry for still gets two empty arrays', () => {
    const edges = { a: { blockedBy: [{ key: 'PROD-1', title: 'x', status: 'todo' }], blocks: [] } };
    expect(attachEdges([{ id: 'a' }, { id: 'b' }], edges)).toEqual([
      { id: 'a', dependencies: edges.a },
      { id: 'b', dependencies: { blockedBy: [], blocks: [] } },
    ]);
  });

  it('leaves the row’s own fields untouched', () => {
    expect(attachEdges([{ id: 'a', title: 'Keep me' }], {})[0]).toMatchObject({
      id: 'a',
      title: 'Keep me',
    });
  });
});

describe('the `dependencies` block on get_work_item’s CHILDREN (MOTIR-1848)', () => {
  type Child = {
    id: string;
    identifier: string;
    dependencies: { blockedBy: { key: string }[]; blocks: { key: string }[] };
  };
  const children = (r: CallToolResult) => (r.structuredContent as { children: Child[] }).children;

  it('every child carries the block, with 1842’s key names, in BOTH directions', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mkStory(fx, 'The story');
    const first = await mkChild(fx, story.id, 'Ship the schema');
    const second = await mkChild(fx, story.id, 'Wire the service');
    await block(fx, second.id, first.id);

    const rows = children(await runGetWorkItem({ key: story.identifier }, fx.ctx));
    expect(rows.map((c) => c.identifier)).toEqual([first.identifier, second.identifier]);
    expect(rows.find((c) => c.id === second.id)!.dependencies).toEqual({
      blockedBy: [{ key: first.identifier, title: 'Ship the schema', status: 'todo' }],
      blocks: [],
    });
    expect(rows.find((c) => c.id === first.id)!.dependencies).toEqual({
      blockedBy: [],
      blocks: [{ key: second.identifier, title: 'Wire the service', status: 'todo' }],
    });
  });

  it('is TOTAL — an edge-free child carries empty arrays, never a missing key', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mkStory(fx, 'The story');
    await mkChild(fx, story.id, 'All alone');

    const rows = children(await runGetWorkItem({ key: story.identifier }, fx.ctx));
    expect(rows[0]!.dependencies).toEqual({ blockedBy: [], blocks: [] });
  });

  it('a many-child aggregate issues NO per-child query — the batched reader, twice', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mkStory(fx, 'The story');
    const kids: Awaited<ReturnType<typeof mkChild>>[] = [];
    for (let i = 0; i < 20; i++) kids.push(await mkChild(fx, story.id, `Child ${i}`));
    // A chain, so every interior child has an edge in BOTH directions.
    for (let i = 1; i < kids.length; i++) await block(fx, kids[i]!.id, kids[i - 1]!.id);

    const { result, queries } = await countLinkQueries(() =>
      runGetWorkItem({ key: story.identifier }, fx.ctx),
    );
    const rows = children(result);
    expect(rows).toHaveLength(20);
    // TWO for the child projection; the aggregate's OWN link groups (blockedBy /
    // blocks / relatesTo / duplicates / clones + readiness) cost a fixed handful
    // more. What matters is that the count does not scale with the child count.
    expect(queries).toBeLessThanOrEqual(10);
    expect(rows[10]!.dependencies.blockedBy.map((e) => e.key)).toEqual([kids[9]!.identifier]);
    expect(rows[10]!.dependencies.blocks.map((e) => e.key)).toEqual([kids[11]!.identifier]);
  });

  it('a childless item costs the projection NOTHING and still answers', async () => {
    const fx = await makeWorkItemFixture();
    const lonely = await mk(fx, 'No children');

    const res = await runGetWorkItem({ key: lonely.identifier }, fx.ctx);
    expect(children(res)).toEqual([]);
  });

  it('names the child’s blocker STATUS, so a done blocker is distinguishable', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mkStory(fx, 'The story');
    const blocker = await mkChild(fx, story.id, 'Ship the schema');
    const dependent = await mkChild(fx, story.id, 'Wire the UI');
    await block(fx, dependent.id, blocker.id);
    await markDone(blocker.id);

    const rows = children(await runGetWorkItem({ key: story.identifier }, fx.ctx));
    expect(rows.find((c) => c.id === dependent.id)!.dependencies.blockedBy).toEqual([
      { key: blocker.identifier, title: 'Ship the schema', status: 'done' },
    ]);
  });

  it('the block is IDENTICAL to the one the list reads project for the same item', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mkStory(fx, 'The story');
    const blocker = await mkChild(fx, story.id, 'Ship the schema');
    const middle = await mkChild(fx, story.id, 'Wire the service');
    await block(fx, middle.id, blocker.id);

    const childRow = children(await runGetWorkItem({ key: story.identifier }, fx.ctx)).find(
      (c) => c.id === middle.id,
    )!;
    const searchRow = rows(await runSearchWorkItems({ projectKey: 'PROD' }, fx.ctx)).find(
      (r) => r.id === middle.id,
    )!;
    expect(childRow.dependencies).toEqual(searchRow.dependencies);
  });

  it('advertises the block, and it survives the real transport', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mkStory(fx, 'The story');
    const blocker = await mkChild(fx, story.id, 'Ship the schema');
    const dependent = await mkChild(fx, story.id, 'Wire the UI');
    await block(fx, dependent.id, blocker.id);

    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'get_work_item')!.description).toContain(
      'Every CHILD row also carries `dependencies: { blockedBy, blocks }`',
    );
    const res = (await client.callTool({
      name: 'get_work_item',
      arguments: { key: story.identifier },
    })) as CallToolResult;
    expect(children(res).find((c) => c.id === dependent.id)!.dependencies).toEqual({
      blockedBy: [{ key: blocker.identifier, title: 'Ship the schema', status: 'todo' }],
      blocks: [],
    });
    await client.close();
  });

  it('leaves the rest of the aggregate byte-identical to the service’s own DTO', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mkStory(fx, 'The story');
    await mkChild(fx, story.id, 'Only child');

    const res = await runGetWorkItem({ key: story.identifier }, fx.ctx);
    const structured = res.structuredContent as Record<string, unknown>;
    const detail = await workItemsService.getIssueDetail(fx.projectId, story.identifier, fx.ctx);
    // Only the TRANSPORT attachments differ — `children`'s edge block (7.9.0f),
    // the item's `commentCount` (MOTIR-2001), the card's `deliveries`
    // (MOTIR-3697) and its declared `folderPath` (MOTIR-5413). The web-facing `IssueDetailDto` is untouched by all three,
    // so no route-shape test that reads this aggregate back can drift — which is
    // the reason each attaches at the transport rather than widening the DTO,
    // and the reason this list is allowed to grow while the assertion stays
    // exact.
    //
    // One difference runs the OTHER way: the DTO carries `placementFolder`, the
    // work item PAGE's placement read (MOTIR-5375), which the tool deliberately
    // WITHHOLDS — which folder vocabulary agents see is Story MOTIR-5310's. So it
    // is removed from the DTO side here, and its absence from the tool is pinned.
    expect(structured).not.toHaveProperty('placementFolder');
    // So are `fixReason` / `fixDetail` (Story MOTIR-6589): the item page's To fix
    // banner reads them, and publishing them to agents is not that story's call.
    expect(structured).not.toHaveProperty('fixReason');
    expect(structured).not.toHaveProperty('fixDetail');
    // And `fixGroup` (MOTIR-7589), the To fix entry the banner points at, for the same reason.
    expect(structured).not.toHaveProperty('fixGroup');
    const {
      children: _ignored,
      item: toolItem,
      deliveries: _deliveries,
      folderPath: _folderPath,
      // The work item's monitor links (MOTIR-5981): a tool-only read, like
      // `deliveries`, that the aggregate DTO does not carry.
      errors: _errors,
      // The card's latest Motir-pressed refusal and its verdict (MOTIR-6422): a
      // tool-only read handed to the next run, which the aggregate DTO does not carry.
      latestRefusal: _latestRefusal,
      // Where the item's unmerged code is (MOTIR-10069): a tool-only read shared with
      // the hosted get_item, which the aggregate DTO does not carry.
      inFlightCode: _inFlightCode,
      mergedRepos: _mergedRepos,
      ...restOfTool
    } = structured;
    const {
      children: _alsoIgnored,
      item: dtoItem,
      placementFolder: _pageOnly,
      fixReason: _pageFixReason,
      fixDetail: _pageFixDetail,
      fixGroup: _pageFixGroup,
      ...restOfDto
    } = detail as unknown as Record<string, unknown>;
    const { commentCount: _count, ...toolItemRest } = toolItem as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(toolItemRest))).toEqual(JSON.parse(JSON.stringify(dtoItem)));
    expect(JSON.parse(JSON.stringify(restOfTool))).toEqual(JSON.parse(JSON.stringify(restOfDto)));
  });
});

describe('edgeMarker', () => {
  it('renders nothing for an absent projection or an edge-free item', () => {
    expect(edgeMarker(undefined)).toBe('');
    expect(edgeMarker({ blockedBy: [], blocks: [] })).toBe('');
  });

  it('renders each direction that has edges', () => {
    const e = { key: 'PROD-3', title: 'x', status: 'todo' };
    expect(edgeMarker({ blockedBy: [e], blocks: [] })).toBe(' · blocked by PROD-3');
    expect(edgeMarker({ blockedBy: [], blocks: [e] })).toBe(' · blocks PROD-3');
    expect(edgeMarker({ blockedBy: [e], blocks: [{ ...e, key: 'PROD-9' }] })).toBe(
      ' · blocked by PROD-3 · blocks PROD-9',
    );
  });
});
