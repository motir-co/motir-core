import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { ADD_PLAN_ITEMS_TOOL_NAME, CREATE_PLAN_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { foldersService } from '@/lib/services/foldersService';
import { scopeClaimService } from '@/lib/services/scopeClaimService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { InvalidEdgeDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-6370 (Story MOTIR-6015) — a cross-parent edge is VALID only when the
// parents carry it, through the real MCP validators and the real datastore. The
// pure rule is pinned in tests/workItems/crossParentCoverage.test.ts.
//
// The tree every case reads:
//   epic E1 ─ story A ─ subtask Y
//          └ story B ─ subtask X
//   epic E2 ─ story C
//   task T (a root)

const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'cross-parent-coverage', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

async function tree(fx: WorkItemFixture) {
  const mk = (kind: 'epic' | 'story' | 'task' | 'subtask', title: string, parentId?: string) =>
    workItemsService.createWorkItem({ projectId: fx.projectId, kind, title, parentId }, fx.ctx);
  const e1 = await mk('epic', 'Epic one');
  const e2 = await mk('epic', 'Epic two');
  const a = await mk('story', 'Story A', e1.id);
  const b = await mk('story', 'Story B', e1.id);
  const c = await mk('story', 'Story C', e2.id);
  const y = await mk('subtask', 'Subtask Y', a.id);
  const x = await mk('subtask', 'Subtask X', b.id);
  const t = await mk('task', 'Root task');
  return { e1, e2, a, b, c, y, x, t };
}

const link = (fx: WorkItemFixture, fromId: string, toId: string) =>
  workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);

type Verdict = { valid: boolean; blockers: unknown[]; invalidEdges: InvalidEdgeDto[] };
const verdictOf = (r: CallToolResult) => r.structuredContent as unknown as Verdict;

async function openPlan(client: Client, fx: WorkItemFixture): Promise<string> {
  const r = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'Cross-parent plan',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5-5',
  });
  return (r.structuredContent as unknown as PlanWithItemsDto).id;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('validate_work_item — invalidEdges', () => {
  it('X (story B) blocked_by Y (story A) without B→A is INVALID naming X, Y, B, A; B→A clears it', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await link(fx, t.x.id, t.y.id);
    const client = await connectClient(fx.ctx);

    const before = await call(client, 'validate_work_item', { key: t.e1.identifier });
    expect(before.isError, text(before)).toBeFalsy();
    expect(verdictOf(before)).toMatchObject({ valid: false, blockers: [] });
    expect(verdictOf(before).invalidEdges).toEqual([
      {
        item: t.x.identifier,
        blockedBy: t.y.identifier,
        itemParent: t.b.identifier,
        blockerParent: t.a.identifier,
        blockerDone: false,
      },
    ]);
    expect(text(before)).toContain(`${t.b.identifier} is not blocked_by ${t.a.identifier}`);

    await link(fx, t.b.id, t.a.id);
    const after = await call(client, 'validate_work_item', { key: t.e1.identifier });
    expect(verdictOf(after)).toMatchObject({ valid: true, blockers: [], invalidEdges: [] });
    await client.close();
  });

  it('a story edge across EPICS is invalid unless the epics carry it', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await link(fx, t.b.id, t.c.id);
    const client = await connectClient(fx.ctx);

    const before = verdictOf(await call(client, 'validate_work_item', { key: t.e1.identifier }));
    expect(before.invalidEdges).toEqual([
      {
        item: t.b.identifier,
        blockedBy: t.c.identifier,
        itemParent: t.e1.identifier,
        blockerParent: t.e2.identifier,
        blockerDone: false,
      },
    ]);

    await link(fx, t.e1.id, t.e2.id);
    const after = verdictOf(await call(client, 'validate_work_item', { key: t.e1.identifier }));
    expect(after.invalidEdges).toEqual([]);
    await client.close();
  });

  it('siblings are never listed, and an edge between two ROOTS — one of them FILED — is exempt', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const sib = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'Sibling of X', parentId: t.b.id },
      fx.ctx,
    );
    const folder = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Parked' },
      fx.ctx,
    );
    const filed = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Filed task', folderId: folder.id },
      fx.ctx,
    );
    await link(fx, t.x.id, sib.id);
    // Two roots: the same level (both at the project root; a folder adds no
    // depth), and neither has a work-item parent to owe an edge.
    await link(fx, t.t.id, filed.id);
    const client = await connectClient(fx.ctx);

    for (const key of [t.b.identifier, t.t.identifier]) {
      const verdict = verdictOf(await call(client, 'validate_work_item', { key }));
      expect(verdict.invalidEdges).toEqual([]);
    }
    await client.close();
  });
});

// Bug MOTIR-10860: the blocker's STATE decides. An uncovered edge onto a DONE
// (or CANCELLED) blocker holds nothing — readiness already calls the card ready —
// so it is LISTED with `blockerDone: true` and does not make the verdict invalid.
describe('validate_work_item — an uncovered edge onto a TERMINAL blocker (MOTIR-10860)', () => {
  for (const status of ['done', 'cancelled'] as const) {
    it(`X blocked_by a ${status.toUpperCase()} Y without B→A is VALID and still lists the edge`, async () => {
      const fx = await makeWorkItemFixture();
      const t = await tree(fx);
      await link(fx, t.x.id, t.y.id);
      await adminDb.workItem.update({ where: { id: t.y.id }, data: { status } });
      const client = await connectClient(fx.ctx);

      const r = await call(client, 'validate_work_item', { key: t.e1.identifier });
      expect(r.isError, text(r)).toBeFalsy();
      expect(verdictOf(r)).toMatchObject({ valid: true, blockers: [] });
      expect(verdictOf(r).invalidEdges).toEqual([
        {
          item: t.x.identifier,
          blockedBy: t.y.identifier,
          itemParent: t.b.identifier,
          blockerParent: t.a.identifier,
          blockerDone: true,
        },
      ]);
      expect(text(r)).toContain(`Work item ${t.e1.identifier} is VALID`);
      expect(text(r)).toContain('their blocker is DONE');
      expect(text(r)).toContain(`${t.x.identifier} is blocked by ${t.y.identifier} (done)`);
      await client.close();
    });
  }

  it('an OPEN uncovered edge beside a DONE one keeps the verdict INVALID and names both', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const y2 = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'Subtask Y2', parentId: t.a.id },
      fx.ctx,
    );
    await link(fx, t.x.id, t.y.id);
    await link(fx, t.x.id, y2.id);
    await adminDb.workItem.update({ where: { id: t.y.id }, data: { status: 'done' } });
    const client = await connectClient(fx.ctx);

    const r = await call(client, 'validate_work_item', { key: t.e1.identifier });
    expect(verdictOf(r).valid).toBe(false);
    expect(
      verdictOf(r)
        .invalidEdges.map((e) => [e.blockedBy, e.blockerDone])
        .sort(),
    ).toEqual(
      [
        [t.y.identifier, true],
        [y2.identifier, false],
      ].sort(),
    );
    expect(text(r)).toContain('1 cross-parent edge(s) are not carried by their parents — a');
    expect(text(r)).toContain(`${t.x.identifier} is blocked by ${y2.identifier}, but`);
    expect(text(r)).toContain(`${t.x.identifier} is blocked by ${t.y.identifier} (done)`);
    await client.close();
  });
});

describe('validate_plan — invalidEdges over the PROJECTION', () => {
  it('reports X→Y without B→A; a modify adding B→A clears it; removing a committed B→A brings it back', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);

    // (1) A proposed subtask X2 under B blocked_by Y, and nothing on B.
    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Subtask X2', kind: 'subtask' },
          parentRef: t.b.id,
          blockedByRefs: [t.y.id],
        },
      ],
    });
    // No append refusal for an uncovered edge — it is a validation verdict.
    expect(appended.isError, text(appended)).toBeFalsy();
    const x2 = (appended.structuredContent as unknown as { planItemIds: string[] }).planItemIds[0];

    const first = verdictOf(await call(client, 'validate_plan', { planId }));
    expect(first.valid).toBe(false);
    expect(first.invalidEdges).toEqual([
      {
        item: `planItem:${x2}`,
        blockedBy: t.y.identifier,
        itemParent: t.b.identifier,
        blockerParent: t.a.identifier,
        blockerDone: false,
      },
    ]);

    // (2) The same plan also proposes B→A — the parent edge — and it clears.
    const covered = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: t.b.id, patch: { blockedByAdd: [t.a.id] } }],
    });
    expect(covered.isError, text(covered)).toBeFalsy();
    const second = verdictOf(await call(client, 'validate_plan', { planId }));
    expect(second.invalidEdges).toEqual([]);
    await client.close();
  });

  it('a committed uncovered edge the plan owns onto a DONE blocker: listed, blockerDone, VALID (MOTIR-10860)', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await link(fx, t.b.id, t.a.id);
    await link(fx, t.x.id, t.y.id);
    await adminDb.workItem.update({ where: { id: t.y.id }, data: { status: 'done' } });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    // Removing B→A makes the committed X→Y edge the plan's, and uncovered.
    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: t.b.id, patch: { blockedByRemove: [t.a.id] } }],
    });
    const row = {
      item: t.x.identifier,
      blockedBy: t.y.identifier,
      itemParent: t.b.identifier,
      blockerParent: t.a.identifier,
      blockerDone: true,
    };
    const plan = await call(client, 'validate_plan', { planId });
    expect(verdictOf(plan).invalidEdges).toEqual([row]);
    expect(verdictOf(plan).valid).toBe(true);
    expect(text(plan)).toContain('their blocker is DONE');

    const projected = await call(client, 'validate_work_item', {
      key: t.e1.identifier,
      planId,
    });
    expect(verdictOf(projected)).toMatchObject({ valid: true, blockers: [] });
    expect(verdictOf(projected).invalidEdges).toEqual([row]);

    // The same plan onto an OPEN blocker still answers INVALID.
    await adminDb.workItem.update({ where: { id: t.y.id }, data: { status: 'todo' } });
    const open = verdictOf(
      await call(client, 'validate_work_item', { key: t.e1.identifier, planId }),
    );
    expect(open.valid).toBe(false);
    expect(open.invalidEdges).toEqual([{ ...row, blockerDone: false }]);
    await client.close();
  });

  it('a plan that REMOVES the committed parent edge makes a committed child edge invalid', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await link(fx, t.b.id, t.a.id);
    await link(fx, t.x.id, t.y.id);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: t.b.id, patch: { blockedByRemove: [t.a.id] } }],
    });
    const verdict = verdictOf(await call(client, 'validate_plan', { planId }));
    expect(verdict.invalidEdges).toEqual([
      {
        item: t.x.identifier,
        blockedBy: t.y.identifier,
        itemParent: t.b.identifier,
        blockerParent: t.a.identifier,
        blockerDone: false,
      },
    ]);
    await client.close();
  });
});

describe('the scope claim gates on FINISHABILITY, not on invalidEdges', () => {
  it('story B with an uncovered edge to a DONE blocker is claimable; with an open one it is not_finishable', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await link(fx, t.x.id, t.y.id);

    // Open blocker outside B's subtree → not_finishable, as before.
    const refused = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: t.b.identifier },
      fx.ctx,
    );
    expect(refused.outcome).toBe('not_finishable');

    // The blocker done: B is finishable, and the uncovered edge is still LISTED
    // but satisfied, so it no longer counts against `valid` (MOTIR-10860).
    await adminDb.workItem.update({ where: { id: t.y.id }, data: { status: 'done' } });
    const validity = await workItemsService.validateWorkItem(fx.projectId, t.b.identifier, fx.ctx);
    expect(validity).toMatchObject({ valid: true, blockers: [] });
    expect(validity.invalidEdges).toEqual([expect.objectContaining({ blockerDone: true })]);

    const claimed = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: t.b.identifier },
      fx.ctx,
    );
    expect(claimed.outcome).toBe('claimed');
  });
});
