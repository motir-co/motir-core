import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { foldersService } from '@/lib/services/foldersService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { seedBlockedBy } from '../helpers/seedBlockedBy';

// MOTIR-6369 / MOTIR-6411 (Story MOTIR-6015), re-ruled by MOTIR-6509
// (`edge-level-is-position.md` Amendment 2) — a `blocked_by` SHOULD join two
// items on the SAME LEVEL — the same depth below their nearest common ancestor
// (MOTIR-6387, a folder adding none) — and may cross parents. The rule is a
// VALIDITY verdict on a committed edge, not a refusal at the link door: a
// cross-level edge is WRITTEN (the dependency is real, and it holds the card out
// of the ready set), and `validate_work_item` reports it INVALID in
// `crossLevelEdges` ("blocked elsewhere"). Only the plan gate refuses one.
//
// The tree every case reads (the decision record's own shapes):
//   epic E1 ─ story S ─ subtask Y
//          ├ task T ─ subtask X          (T: the validation task beside S)
//          └ story S1 ─ task T1 ─ subtask X1
//   epic E2 ─ story S2 ─ subtask Y2
//   task R (root) ─ subtask XR
//   bug B (root, filed in a folder)

const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'link-edge-level', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

async function tree(fx: WorkItemFixture) {
  const mk = (
    kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask',
    title: string,
    parentId?: string,
    folderId?: string,
  ) =>
    workItemsService.createWorkItem(
      { projectId: fx.projectId, kind, title, parentId, folderId },
      fx.ctx,
    );
  const folder = await foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: null, name: 'Parked bugs' },
    fx.ctx,
  );
  const e1 = await mk('epic', 'Epic one');
  const e2 = await mk('epic', 'Epic two');
  const s = await mk('story', 'Story S', e1.id);
  const t = await mk('task', 'Validation task T', e1.id);
  const s1 = await mk('story', 'Story S1', e1.id);
  const s2 = await mk('story', 'Story S2', e2.id);
  const y = await mk('subtask', 'Subtask Y', s.id);
  const x = await mk('subtask', 'Subtask X', t.id);
  const t1 = await mk('task', 'Task T1', s1.id);
  const x1 = await mk('subtask', 'Subtask X1', t1.id);
  const y2 = await mk('subtask', 'Subtask Y2', s2.id);
  const r = await mk('task', 'Root task R');
  const xr = await mk('subtask', 'Subtask XR', r.id);
  const b = await mk('bug', 'Filed bug B', undefined, folder.id);
  return { e1, e2, s, t, s1, s2, y, x, t1, x1, y2, r, xr, b };
}

const linkCount = () => adminDb.workItemLink.count({ where: { kind: 'is_blocked_by' } });

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('link_work_items — the record’s ACCEPTED cases', () => {
  it('case 1 · the validation task under an epic, blocked_by the story beside it', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);
    const made = await call(client, 'link_work_items', {
      fromKey: t.t.identifier,
      toKey: t.s.identifier,
      relationship: 'blocked_by',
    });
    expect(made.isError, text(made)).toBeFalsy();
    expect(await linkCount()).toBe(1);
    await client.close();
  });

  it('case 2 / 2b · a subtask under a task, blocked_by a subtask under a story — same epic, or another', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);
    for (const to of [t.y, t.y2]) {
      const made = await call(client, 'link_work_items', {
        fromKey: t.x.identifier,
        toKey: to.identifier,
        relationship: 'blocked_by',
      });
      expect(made.isError, text(made)).toBeFalsy();
    }
    expect(await linkCount()).toBe(2);
    await client.close();
  });

  it('`relates_to` between two depths is never judged', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);
    const made = await call(client, 'link_work_items', {
      fromKey: t.x1.identifier,
      toKey: t.s.identifier,
      relationship: 'relates_to',
    });
    expect(made.isError, text(made)).toBeFalsy();
    await client.close();
  });
});

describe('link_work_items — the record’s CROSS-LEVEL cases are WRITTEN and reported INVALID', () => {
  it.each([
    ['case 3 · a subtask two levels under a story → a subtask under a story', 'x1', 'y', 3, 2],
    ['case 4 · a root bug filed in a folder → a subtask', 'b', 'y', 0, 2],
    [
      'case 4b · a subtask under a ROOT task → a subtask under a story under an epic',
      'xr',
      'y',
      1,
      2,
    ],
    ['a subtask → a story (a child of an epic)', 'y', 's1', 2, 1],
  ] as const)(
    '%s → the edge is written, and validate names it with both depths',
    async (_label, from, to, dFrom, dTo) => {
      const fx = await makeWorkItemFixture();
      const t = await tree(fx);
      const client = await connectClient(fx.ctx);

      const made = await call(client, 'link_work_items', {
        fromKey: t[from].identifier,
        toKey: t[to].identifier,
        relationship: 'blocked_by',
      });
      expect(made.isError, text(made)).toBeFalsy();
      expect(await linkCount()).toBe(1);

      const res = await call(client, 'validate_work_item', { key: t[from].identifier });
      const verdict = res.structuredContent as {
        valid: boolean;
        crossLevelEdges: Array<Record<string, unknown>>;
      };
      expect(verdict.valid).toBe(false);
      expect(verdict.crossLevelEdges).toEqual([
        expect.objectContaining({
          item: t[from].identifier,
          blockedBy: t[to].identifier,
          itemDepth: dFrom,
          blockedByDepth: dTo,
          reason: 'blocked_elsewhere',
        }),
      ]);
      expect(text(res)).toContain('blocked elsewhere');
      expect(text(res)).toContain(
        `${t[from].identifier} (depth ${dFrom}) is blocked by ${t[to].identifier} (depth ${dTo})`,
      );
      await client.close();
    },
  );

  it('`blocks` is written in its stored direction, and judged there', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);
    const made = await call(client, 'link_work_items', {
      fromKey: t.s1.identifier,
      toKey: t.y.identifier,
      relationship: 'blocks',
    });
    expect(made.isError, text(made)).toBeFalsy();
    expect(
      await adminDb.workItemLink.count({
        where: { fromId: t.y.id, toId: t.s1.id, kind: 'is_blocked_by' },
      }),
    ).toBe(1);
    const verdict = (await call(client, 'validate_work_item', { key: t.s.identifier }))
      .structuredContent as { crossLevelEdges: Array<{ item: string; blockedBy: string }> };
    expect(verdict.crossLevelEdges.map((e) => [e.item, e.blockedBy])).toEqual([
      [t.y.identifier, t.s1.identifier],
    ]);
    await client.close();
  });
});

describe('the MOTIR-6497 shape — a root folder-filed bug blocked_by a subtask under a story', () => {
  it('the edge holds the bug out of the ready set and out of claim_next_ready until the subtask is done', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);

    const made = await call(client, 'link_work_items', {
      fromKey: t.b.identifier,
      toKey: t.y.identifier,
      relationship: 'blocked_by',
    });
    expect(made.isError, text(made)).toBeFalsy();

    const read = (await call(client, 'get_work_item', { key: t.b.identifier }))
      .structuredContent as {
      readiness: { ready: boolean; openBlockers: Array<{ identifier?: string; key?: string }> };
    };
    expect(read.readiness.ready).toBe(false);
    expect(JSON.stringify(read.readiness.openBlockers)).toContain(t.y.identifier);

    // Both leaves in the active sprint: the claim hands out the subtask, then nothing.
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Active' }, fx.ctx);
    await adminDb.workItem.updateMany({
      where: { id: { in: [t.b.id, t.y.id] } },
      data: { sprintId: sprint.id },
    });
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);
    const claimed = new Set<string>();
    for (;;) {
      const res = await call(client, 'claim_next_ready', { projectKey: fx.projectIdentifier });
      expect(res.isError, text(res)).toBeFalsy();
      const item = (res.structuredContent as { item: { key: string } | null }).item;
      if (!item) break;
      claimed.add(item.key);
    }
    expect([...claimed]).toEqual([t.y.identifier]);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: t.b.id } })).status).toBe(
      'todo',
    );

    const verdict = (await call(client, 'validate_work_item', { key: t.b.identifier }))
      .structuredContent as { valid: boolean; crossLevelEdges: Array<Record<string, unknown>> };
    expect(verdict.valid).toBe(false);
    expect(verdict.crossLevelEdges).toEqual([
      expect.objectContaining({
        item: t.b.identifier,
        blockedBy: t.y.identifier,
        itemDepth: 0,
        blockedByDepth: 2,
      }),
    ]);
    await client.close();
  });
});

// Bug MOTIR-10627 — the same shape once its blocker is DONE. Readiness already
// reads the edge as satisfied, so the verdict must not keep calling it "blocked
// elsewhere", nor tell the reader it holds the card out of the ready set.
describe('validate_work_item — a cross-level edge onto a DONE blocker is satisfied (MOTIR-10627)', () => {
  it('the bug is ready, VALID, and neither list nor text names the edge', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await seedBlockedBy(fx, t.b.id, t.y.id);
    await adminDb.workItem.update({ where: { id: t.y.id }, data: { status: 'done' } });
    const client = await connectClient(fx.ctx);

    const read = (await call(client, 'get_work_item', { key: t.b.identifier }))
      .structuredContent as { readiness: { ready: boolean; openBlockers: unknown[] } };
    expect(read.readiness).toMatchObject({ ready: true, openBlockers: [] });

    const res = await call(client, 'validate_work_item', { key: t.b.identifier });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ valid: true, crossLevelEdges: [] });
    expect(text(res)).not.toContain('blocked elsewhere');
    expect(text(res)).not.toContain('out of the ready set');
    await client.close();
  });

  it('a NOT-done blocker is still reported, and the text says it holds the item until done', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await seedBlockedBy(fx, t.b.id, t.y.id);
    const client = await connectClient(fx.ctx);

    const res = await call(client, 'validate_work_item', { key: t.b.identifier });
    expect(res.structuredContent).toMatchObject({
      valid: false,
      crossLevelEdges: [
        expect.objectContaining({ item: t.b.identifier, blockedBy: t.y.identifier }),
      ],
    });
    expect(text(res)).toContain('blocked elsewhere');
    expect(text(res)).toContain(
      'Until its blocker is done, the edge holds the item out of the ready set.',
    );
    await client.close();
  });

  it('a done blocker drops out of a MIXED subtree while an open one stays', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    // Both inside E1, both depth 2 → 1: Y waits on S1 (done), X1's chain is
    // depth 3, so X1 → S (depth 1) is cross-level too and S stays open.
    await seedBlockedBy(fx, t.y.id, t.s1.id);
    await seedBlockedBy(fx, t.x1.id, t.s.id);
    await adminDb.workItem.update({ where: { id: t.s1.id }, data: { status: 'done' } });
    const client = await connectClient(fx.ctx);

    const verdict = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as { valid: boolean; crossLevelEdges: Array<{ item: string }> };
    expect(verdict.valid).toBe(false);
    expect(verdict.crossLevelEdges.map((e) => e.item)).toEqual([t.x1.identifier]);
    await client.close();
  });
});

describe('createWorkItem with links — the create path writes a cross-level edge too', () => {
  it('a new subtask under a task, created blocked_by a STORY, is created with its link', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const made = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        title: 'Born cross-level',
        parentId: t.t.id,
        links: [{ targetId: t.s.id, relationship: 'blocked_by' }],
      },
      fx.ctx,
    );
    expect(
      await adminDb.workItemLink.count({
        where: { fromId: made.id, toId: t.s.id, kind: 'is_blocked_by' },
      }),
    ).toBe(1);
  });

  it('a new task under an epic, created blocked_by the story beside it (case 1), is created with its link', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const made = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Validate the epic',
        parentId: t.e1.id,
        links: [{ targetId: t.s.id, relationship: 'blocked_by' }],
      },
      fx.ctx,
    );
    expect(
      await adminDb.workItemLink.count({
        where: { fromId: made.id, toId: t.s.id, kind: 'is_blocked_by' },
      }),
    ).toBe(1);
  });

  it('a new ROOT story created as a blocker of a subtask (`blocks`) writes the stored direction', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const made = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'story',
        title: 'Blocks a leaf',
        links: [{ targetId: t.y.id, relationship: 'blocks' }],
      },
      fx.ctx,
    );
    expect(
      await adminDb.workItemLink.count({
        where: { fromId: t.y.id, toId: made.id, kind: 'is_blocked_by' },
      }),
    ).toBe(1);
  });
});

describe('validate_work_item — a cross-level edge is a VERDICT, and a same-level one is not', () => {
  it('a story blocked_by an EPIC yields one `crossLevelEdges` entry and no advisory', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);
    await seedBlockedBy(fx, t.s1.id, t.e2.id);

    const res = await call(client, 'validate_work_item', { key: t.e1.identifier });
    expect(res.isError, text(res)).toBeFalsy();
    const verdict = res.structuredContent as {
      valid: boolean;
      crossLevelEdges: Array<Record<string, unknown>>;
      invalidEdges: unknown[];
      advisories: Array<Record<string, unknown>>;
    };
    expect(verdict.valid).toBe(false);
    expect(verdict.crossLevelEdges).toEqual([
      {
        item: t.s1.identifier,
        blockedBy: t.e2.identifier,
        itemDepth: 1,
        blockedByDepth: 0,
        reason: 'blocked_elsewhere',
        explanation: expect.stringContaining('An epic is blocked only by another epic'),
      },
    ]);
    // Never both: a cross-level edge is not ALSO an uncovered cross-parent one.
    expect(verdict.invalidEdges).toEqual([]);
    expect(verdict.advisories.filter((a) => a.severity === 'cross-level-edge')).toEqual([]);
    await client.close();
  });

  it('an in-subtree cross-level edge makes `valid` false; a same-level edge (case 1) adds no entry', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await workItemsService.linkWorkItems(
      { fromId: t.t.id, toId: t.s.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);
    const clean = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as { valid: boolean; crossLevelEdges: unknown[] };
    expect(clean).toMatchObject({ valid: true, crossLevelEdges: [] });

    await workItemsService.linkWorkItems(
      { fromId: t.y.id, toId: t.s1.id, kind: 'is_blocked_by' },
      fx.ctx,
    ); // depth 2 → 1, inside E1
    const verdict = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as {
      valid: boolean;
      blockers: unknown[];
      crossLevelEdges: Array<{ item: string }>;
    };
    expect(verdict.valid).toBe(false);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.crossLevelEdges.map((e) => e.item)).toEqual([t.y.identifier]);
    await client.close();
  });
});
