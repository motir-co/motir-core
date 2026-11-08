import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { ADD_PLAN_ITEMS_TOOL_NAME, CREATE_PLAN_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { scopeClaimService } from '@/lib/services/scopeClaimService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { CrossLevelEdgeDto, InvalidEdgeDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE STORY GATE for Story MOTIR-6015 in motir-core (MOTIR-6372) — the seams the
// feature cards' units stub, end to end: the real MCP handlers over the real
// persist gate (MOTIR-6367), the real link service (MOTIR-6369), the real
// validity reads over committed rows and over a plan projection (MOTIR-6370),
// all reading ONE level predicate — POSITION, not kind (MOTIR-6387 / 6411).
// Nothing here mocks the persist gate, the link service or the validity reads.
//
// The seed every case reads:
//   epic E1 ─ story A ─ subtask Y
//          └ story B ─ subtask X
//   epic E2 ─ story C
//   task R, bug G (roots — one step below the project, beside the epics)
//
// AMENDMENT 1 (MOTIR-6443): an epic is blocked only by another epic — the epic
// tier is decided by KIND, so R and G are never an epic's peers.

const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'same-level-edges-story-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

async function seed(fx: WorkItemFixture) {
  const mk = (
    kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask',
    title: string,
    parentId?: string,
  ) => workItemsService.createWorkItem({ projectId: fx.projectId, kind, title, parentId }, fx.ctx);
  const e1 = await mk('epic', 'E1');
  const e2 = await mk('epic', 'E2');
  const a = await mk('story', 'A', e1.id);
  const b = await mk('story', 'B', e1.id);
  const c = await mk('story', 'C', e2.id);
  const y = await mk('subtask', 'Y', a.id);
  const x = await mk('subtask', 'X', b.id);
  const r = await mk('task', 'R');
  const g = await mk('bug', 'G');
  return { e1, e2, a, b, c, y, x, r, g };
}

const link = (fx: WorkItemFixture, fromId: string, toId: string) =>
  workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);

type Validity = {
  valid: boolean;
  blockers: unknown[];
  invalidEdges: InvalidEdgeDto[];
  crossLevelEdges: CrossLevelEdgeDto[];
};

async function openPlan(client: Client, fx: WorkItemFixture): Promise<string> {
  const r = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'Story gate plan',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5-5',
  });
  return (r.structuredContent as unknown as PlanWithItemsDto).id;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the plan gate, end to end through add_plan_items', () => {
  it('a subtask blocked_by a story is refused `cross_level`, and nothing is appended', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Subtask under B', kind: 'subtask' },
          parentRef: t.b.id,
          blockedByRefs: [t.a.id],
        },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('INVALID_PLAN_REF_GRAPH');
    expect(text(refused)).toContain('cross_level');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
    await client.close();
  });

  it('a bug blocked_by a subtask in ANOTHER story (the same depth) is accepted and closes', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'A bug under B', kind: 'bug' },
          parentRef: t.b.id,
          blockedByRefs: [t.y.id],
        },
      ],
      final: true,
    });
    expect(appended.isError, text(appended)).toBeFalsy();
    expect((appended.structuredContent as unknown as PlanWithItemsDto).status).toBe('planned');
    await client.close();
  });
});

describe('the link door, end to end through link_work_items (Amendment 2, MOTIR-6509)', () => {
  it('subtask → story is WRITTEN and validate_work_item reports it INVALID; relates_to for the pair is created', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    const client = await connectClient(fx.ctx);

    const written = await call(client, 'link_work_items', {
      fromKey: t.x.identifier,
      toKey: t.a.identifier,
      relationship: 'blocked_by',
    });
    expect(written.isError, text(written)).toBeFalsy();
    expect(await adminDb.workItemLink.count({ where: { kind: 'is_blocked_by' } })).toBe(1);
    const verdict = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as unknown as Validity;
    expect(verdict.valid).toBe(false);
    expect(verdict.crossLevelEdges.map((e) => [e.item, e.blockedBy])).toEqual([
      [t.x.identifier, t.a.identifier],
    ]);

    const related = await call(client, 'link_work_items', {
      fromKey: t.x.identifier,
      toKey: t.a.identifier,
      relationship: 'relates_to',
    });
    expect(related.isError, text(related)).toBeFalsy();
    await client.close();
  });
});

describe('the epic tier — an epic is blocked only by another epic (Amendment 1)', () => {
  it('link_work_items writes every one; validate_work_item flags epic → root task and root bug → epic, never epic → epic or root bug → root task', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    const client = await connectClient(fx.ctx);
    const blockedBy = (from: { identifier: string }, to: { identifier: string }) =>
      call(client, 'link_work_items', {
        fromKey: from.identifier,
        toKey: to.identifier,
        relationship: 'blocked_by',
      });

    for (const [from, to] of [
      [t.e1, t.r],
      [t.g, t.e1],
      [t.e1, t.e2],
      [t.g, t.r],
    ] as const) {
      const made = await blockedBy(from, to);
      expect(made.isError, text(made)).toBeFalsy();
    }
    expect(await adminDb.workItemLink.count({ where: { kind: 'is_blocked_by' } })).toBe(4);

    const flagged = async (key: string) =>
      ((await call(client, 'validate_work_item', { key })).structuredContent as unknown as Validity)
        .crossLevelEdges;
    const onEpic = await flagged(t.e1.identifier);
    expect(onEpic.map((e) => [e.item, e.blockedBy])).toEqual([[t.e1.identifier, t.r.identifier]]);
    expect(onEpic[0]!.explanation).toContain('An epic is blocked only by another epic');
    expect((await flagged(t.g.identifier)).map((e) => [e.item, e.blockedBy])).toEqual([
      [t.g.identifier, t.e1.identifier],
    ]);
    await client.close();
  });

  it('add_plan_items: an epic blocked_by a root task, and a root bug blocked_by an epic, are refused `cross_level`; epic → epic and root bug → root task close', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const epicOnTask = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: t.e1.id, patch: { blockedByAdd: [t.r.id] } }],
    });
    expect(epicOnTask.isError).toBe(true);
    expect(text(epicOnTask)).toContain('cross_level');
    expect(text(epicOnTask)).toContain('An epic is blocked only by another epic');
    const bugOnEpic = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'A root bug', kind: 'bug' },
          blockedByRefs: [t.e2.id],
        },
      ],
    });
    expect(bugOnEpic.isError).toBe(true);
    expect(text(bugOnEpic)).toContain('cross_level');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);

    const accepted = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'modify', workItemId: t.e1.id, patch: { blockedByAdd: [t.e2.id] } },
        { op: 'modify', workItemId: t.g.id, patch: { blockedByAdd: [t.r.id] } },
      ],
      final: true,
    });
    expect(accepted.isError, text(accepted)).toBeFalsy();
    expect((accepted.structuredContent as unknown as PlanWithItemsDto).status).toBe('planned');
    await client.close();
  });
});

describe('validity over COMMITTED rows', () => {
  it('X → Y without B → A is an invalidEdges entry on validate_work_item(E1); linking B → A clears it', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    await link(fx, t.x.id, t.y.id);
    const client = await connectClient(fx.ctx);

    const before = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as unknown as Validity;
    expect(before.invalidEdges).toEqual([
      {
        item: t.x.identifier,
        blockedBy: t.y.identifier,
        itemParent: t.b.identifier,
        blockerParent: t.a.identifier,
      },
    ]);
    expect(before.valid).toBe(false);

    await link(fx, t.b.id, t.a.id);
    const after = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as unknown as Validity;
    expect(after.invalidEdges).toEqual([]);
    expect(after.valid).toBe(true);
    await client.close();
  });

  it('a story edge across epics is invalid until the epics carry it', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    await link(fx, t.b.id, t.c.id);
    const client = await connectClient(fx.ctx);

    const before = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as unknown as Validity;
    expect(before.invalidEdges.map((e) => [e.itemParent, e.blockerParent])).toEqual([
      [t.e1.identifier, t.e2.identifier],
    ]);

    await link(fx, t.e1.id, t.e2.id);
    const after = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as unknown as Validity;
    expect(after.invalidEdges).toEqual([]);
    await client.close();
  });
});

describe('validity over a PROJECTION', () => {
  it('a plan proposing B → A leaves no entry', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    await link(fx, t.x.id, t.y.id);
    const client = await connectClient(fx.ctx);

    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: t.b.id, patch: { blockedByAdd: [t.a.id] } }],
    });
    expect(appended.isError, text(appended)).toBeFalsy();
    const verdict = (await call(client, 'validate_plan', { planId }))
      .structuredContent as unknown as Validity;
    expect(verdict.invalidEdges).toEqual([]);
    await client.close();
  });

  it('a plan removing a committed B → A has the entry', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    await link(fx, t.x.id, t.y.id);
    await link(fx, t.b.id, t.a.id);
    const client = await connectClient(fx.ctx);

    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: t.b.id, patch: { blockedByRemove: [t.a.id] } }],
    });
    expect(appended.isError, text(appended)).toBeFalsy();
    const verdict = (await call(client, 'validate_plan', { planId }))
      .structuredContent as unknown as Validity;
    expect(verdict.invalidEdges).toEqual([
      {
        item: t.x.identifier,
        blockedBy: t.y.identifier,
        itemParent: t.b.identifier,
        blockerParent: t.a.identifier,
      },
    ]);
    await client.close();
  });
});

describe('a COMMITTED cross-level edge over a PROJECTION (MOTIR-6509)', () => {
  // REVERSED by MOTIR-7727. This case used to pin "a plan touching nothing of it
  // stays INVALID" — the shape that made every plan on a project with one old
  // bad edge read `valid: false` with no blocker and no rejection. A PLAN now
  // answers for the edges it owns; the committed verdict still reports the edge.
  it('a plan touching nothing of it is VALID through validate_plan and validate_work_item with a planId; the committed validate_work_item still reports it', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    await link(fx, t.x.id, t.a.id); // depth 2 → 1
    const client = await connectClient(fx.ctx);

    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Another story', kind: 'story' },
          parentRef: t.e2.id,
        },
      ],
    });
    expect(appended.isError, text(appended)).toBeFalsy();

    const planVerdict = (await call(client, 'validate_plan', { planId }))
      .structuredContent as unknown as Validity;
    expect(planVerdict.valid).toBe(true);
    expect(planVerdict.crossLevelEdges).toEqual([]);
    expect(planVerdict.invalidEdges).toEqual([]);

    const subtree = (await call(client, 'validate_work_item', { key: t.e1.identifier, planId }))
      .structuredContent as unknown as Validity;
    expect(subtree.valid).toBe(true);
    expect(subtree.crossLevelEdges).toEqual([]);
    expect(subtree.invalidEdges).toEqual([]);

    const committed = await call(client, 'validate_work_item', { key: t.e1.identifier });
    const committedVerdict = committed.structuredContent as unknown as Validity;
    expect(committedVerdict.valid).toBe(false);
    expect(committedVerdict.crossLevelEdges).toEqual([
      expect.objectContaining({
        item: t.x.identifier,
        blockedBy: t.a.identifier,
        itemDepth: 2,
        blockedByDepth: 1,
        reason: 'blocked_elsewhere',
      }),
    ]);
    expect(text(committed)).toContain('blocked elsewhere');
    await client.close();
  });

  it('a plan that re-wires the item end makes the old edge its own: reported, and INVALID', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    const x2 = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'X2', parentId: t.b.id },
      fx.ctx,
    );
    await link(fx, t.x.id, t.a.id); // depth 2 → 1
    const client = await connectClient(fx.ctx);

    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      // An edge UNRELATED to the old one, on its item end.
      proposals: [{ op: 'modify', workItemId: t.x.id, patch: { blockedByAdd: [x2.id] } }],
    });
    expect(appended.isError, text(appended)).toBeFalsy();

    const planVerdict = (await call(client, 'validate_plan', { planId }))
      .structuredContent as unknown as Validity;
    expect(planVerdict.valid).toBe(false);
    expect(planVerdict.crossLevelEdges.map((e) => [e.item, e.blockedBy])).toEqual([
      [t.x.identifier, t.a.identifier],
    ]);
    const subtree = (await call(client, 'validate_work_item', { key: t.e1.identifier, planId }))
      .structuredContent as unknown as Validity;
    expect(subtree.valid).toBe(false);
    expect(subtree.crossLevelEdges.map((e) => [e.item, e.blockedBy])).toEqual([
      [t.x.identifier, t.a.identifier],
    ]);
    await client.close();
  });

  it('a plan that re-wires the item end does NOT report the old edge once its blocker is DONE (MOTIR-10627)', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    const x2 = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'X2', parentId: t.b.id },
      fx.ctx,
    );
    await link(fx, t.x.id, t.a.id); // depth 2 → 1
    await adminDb.workItem.update({ where: { id: t.a.id }, data: { status: 'done' } });
    const client = await connectClient(fx.ctx);

    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: t.x.id, patch: { blockedByAdd: [x2.id] } }],
    });
    expect(appended.isError, text(appended)).toBeFalsy();

    const planVerdict = (await call(client, 'validate_plan', { planId }))
      .structuredContent as unknown as Validity;
    expect(planVerdict.crossLevelEdges).toEqual([]);
    const subtree = (await call(client, 'validate_work_item', { key: t.e1.identifier, planId }))
      .structuredContent as unknown as Validity;
    expect(subtree.crossLevelEdges).toEqual([]);
    // The committed verdict agrees: the edge onto a done blocker is satisfied.
    const committed = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as unknown as Validity;
    expect(committed.crossLevelEdges).toEqual([]);
    await client.close();
  });

  it("a title-only modify on the item end does NOT make the old edge the plan's", async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    await link(fx, t.x.id, t.a.id);
    const client = await connectClient(fx.ctx);

    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: t.x.id, patch: { title: 'X, renamed' } }],
    });
    expect(appended.isError, text(appended)).toBeFalsy();

    const planVerdict = (await call(client, 'validate_plan', { planId }))
      .structuredContent as unknown as Validity;
    expect(planVerdict.valid).toBe(true);
    expect(planVerdict.crossLevelEdges).toEqual([]);
    await client.close();
  });

  it('a blocker in ANOTHER project is not judged over the projection', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'FAR',
    });
    const far = await workItemsService.createWorkItem(
      { projectId: other.id, kind: 'epic', title: 'Far epic' },
      fx.ctx,
    );
    await link(fx, t.x.id, far.id);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    // Re-parent x in place so the plan OWNS its edges (MOTIR-7727) — otherwise
    // the far edge would go unreported for the ownership reason, not this one.
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: t.x.id, patch: { parentRef: t.b.id } }],
    });
    expect(appended.isError, text(appended)).toBeFalsy();
    const verdict = (await call(client, 'validate_plan', { planId }))
      .structuredContent as unknown as Validity;
    expect(verdict.crossLevelEdges).toEqual([]);
    await client.close();
  });
});

describe('a PLAN owns only the edge findings it introduces (MOTIR-7727)', () => {
  // Both old findings on one committed tree: X → Y is an uncovered cross-parent
  // edge (B carries no edge to A), X → A a cross-level one. Neither is touched by
  // the plans below unless the case says so.
  async function oldBadEdges(fx: WorkItemFixture) {
    const t = await seed(fx);
    await link(fx, t.x.id, t.y.id);
    await link(fx, t.x.id, t.a.id);
    return t;
  }
  const validatePlan = async (client: Client, planId: string) =>
    (await call(client, 'validate_plan', { planId })).structuredContent as unknown as Validity;
  const validateProjected = async (client: Client, key: string, planId: string) =>
    (await call(client, 'validate_work_item', { key, planId }))
      .structuredContent as unknown as Validity;

  it('a plan adding an unrelated item is VALID with both arrays empty, through both validators', async () => {
    const fx = await makeWorkItemFixture();
    const t = await oldBadEdges(fx);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Unrelated', kind: 'story' }, parentRef: t.e2.id },
      ],
    });
    expect(appended.isError, text(appended)).toBeFalsy();

    for (const verdict of [
      await validatePlan(client, planId),
      await validateProjected(client, t.e1.identifier, planId),
    ]) {
      expect(verdict.valid).toBe(true);
      expect(verdict.invalidEdges).toEqual([]);
      expect(verdict.crossLevelEdges).toEqual([]);
    }
    // The committed verdict is unmoved: both old edges, still reported.
    const committed = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as unknown as Validity;
    expect(committed.valid).toBe(false);
    expect(committed.invalidEdges.map((e) => [e.item, e.blockedBy])).toEqual([
      [t.x.identifier, t.y.identifier],
    ]);
    expect(committed.crossLevelEdges.map((e) => [e.item, e.blockedBy])).toEqual([
      [t.x.identifier, t.a.identifier],
    ]);
    await client.close();
  });

  it('a NEW uncovered edge is still caught — exactly that one, none of the old', async () => {
    const fx = await makeWorkItemFixture();
    const t = await oldBadEdges(fx);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Subtask under C', kind: 'subtask' },
          parentRef: t.c.id,
          blockedByRefs: [t.y.id],
        },
      ],
    });
    expect(appended.isError, text(appended)).toBeFalsy();
    const added = (appended.structuredContent as unknown as { planItemIds: string[] })
      .planItemIds[0];

    const verdict = await validatePlan(client, planId);
    expect(verdict.valid).toBe(false);
    expect(verdict.invalidEdges).toEqual([
      {
        item: `planItem:${added}`,
        blockedBy: t.y.identifier,
        itemParent: t.c.identifier,
        blockerParent: t.a.identifier,
      },
    ]);
    expect(verdict.crossLevelEdges).toEqual([]);
    await client.close();
  });

  it('a plan that REMOVES an ancestor of an edge end owns that edge, and reports it as the post-plan tree judges it', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    await link(fx, t.x.id, t.y.id); // uncovered: B carries no edge to A
    const client = await connectClient(fx.ctx);

    // Removing E1 orphans A and B. The projected chains stop at the removed node,
    // so only the removed-parent clause of the ownership test can see that the
    // plan reached X → Y — and the post-plan tree still finds it uncovered.
    const removingEpic = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId: removingEpic,
      proposals: [{ op: 'remove', workItemId: t.e1.id }],
    });
    expect(appended.isError, text(appended)).toBeFalsy();
    const verdict = await validatePlan(client, removingEpic);
    expect(verdict.valid).toBe(false);
    expect(verdict.invalidEdges).toEqual([
      {
        item: t.x.identifier,
        blockedBy: t.y.identifier,
        itemParent: t.b.identifier,
        blockerParent: t.a.identifier,
      },
    ]);
    await client.close();
  });

  it('a plan that REMOVES the parent a covered child edge read reports whatever the post-plan tree says of it — here, nothing', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    await link(fx, t.b.id, t.a.id);
    await link(fx, t.x.id, t.y.id); // covered by B → A
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'remove', workItemId: t.a.id }],
    });
    expect(appended.isError, text(appended)).toBeFalsy();

    // The plan OWNS X → Y (A is Y's removed parent). The projection orphans Y, so
    // the edge joins two depths and both rules leave it unjudged — the same
    // verdict the whole-tree walk gave before MOTIR-7727 (measured at 5920f4f),
    // so nothing is being HIDDEN by the ownership filter.
    const verdict = await validatePlan(client, planId);
    expect(verdict.valid).toBe(true);
    expect(verdict.invalidEdges).toEqual([]);
    expect(verdict.crossLevelEdges).toEqual([]);
    await client.close();
  });

  it('an EMPTY plan, and an all-remove plan that uncovers nothing, report no edge findings', async () => {
    const fx = await makeWorkItemFixture();
    const t = await oldBadEdges(fx);
    const client = await connectClient(fx.ctx);

    const empty = await openPlan(client, fx);
    const emptyVerdict = await validatePlan(client, empty);
    expect(emptyVerdict.invalidEdges).toEqual([]);
    expect(emptyVerdict.crossLevelEdges).toEqual([]);
    expect(emptyVerdict.valid).toBe(true);

    const removing = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId: removing,
      proposals: [{ op: 'remove', workItemId: t.c.id }],
    });
    expect(appended.isError, text(appended)).toBeFalsy();
    for (const verdict of [
      await validatePlan(client, removing),
      await validateProjected(client, t.e1.identifier, removing),
    ]) {
      expect(verdict.invalidEdges).toEqual([]);
      expect(verdict.crossLevelEdges).toEqual([]);
    }
    await client.close();
  });
});

describe('the scope claim is decoupled from invalidEdges', () => {
  it('story B with an uncovered edge and no open out-of-subtree blocker is claimable; with an open one it is not_finishable', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    await link(fx, t.x.id, t.y.id);

    const refused = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: t.b.identifier },
      fx.ctx,
    );
    expect(refused.outcome).toBe('not_finishable');

    await adminDb.workItem.update({ where: { id: t.y.id }, data: { status: 'done' } });
    const validity = await workItemsService.validateWorkItem(fx.projectId, t.b.identifier, fx.ctx);
    expect(validity.blockers).toEqual([]);
    expect(validity.invalidEdges).toHaveLength(1);

    const claimed = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: t.b.identifier },
      fx.ctx,
    );
    expect(claimed.outcome).toBe('claimed');
  });
});
