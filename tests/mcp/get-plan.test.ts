import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { toolScope } from '@/lib/mcp/scopes';
import { GET_PLAN_TOOL_NAME } from '@/lib/mcp/tools/getPlan';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { parseSections } from '@/lib/workItems/sections/parse';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { PlanItemDto, PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `get_plan` (Story 7.9 · MOTIR-1837) — the plan CONTENT read.
//
// `get_plan_status` (MOTIR-1825) reports that a planning pass produced N
// proposals. This tool reports WHAT they are, which is the read a headless
// client needs to show or judge the output instead of sending its user to a
// browser. Three contracts are locked here:
//
//   1. IT IS A TRANSPORT. What comes back is `plansService.getPlan`'s DTO,
//      unchanged — asserted by deep-equality against the service itself, so a
//      future re-mapping at this layer fails rather than silently drifting from
//      the surface the cookie route reads.
//   2. THE PROPOSED TREE SURVIVES THE WIRE. All three ops round-trip with their
//      `parentRef` / `blockedByRefs` intact — including the intra-plan
//      `planItem:` temp-refs — so a client can rebuild the shape that was
//      proposed. The rendered text block is checked for the same nesting.
//   3. IT IS STILL A PROPOSAL. Reading a plan creates nothing. The description
//      says so, and the tree is asserted unchanged across the read.
//
// Real Postgres, real plan rows, the real MCP server over the in-memory
// transport with a FIXED-context resolver (the `tools.test.ts` / `expand-item`
// pattern). motir-ai is never involved — this tool never touches a job.

const struct = (r: CallToolResult) => r.structuredContent as unknown as PlanWithItemsDto;
const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'get-plan', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name: GET_PLAN_TOOL_NAME, arguments: args })) as CallToolResult;
}

/** A `generating` plan in the fixture's project — the state proposals land in. */
async function makePlan(fx: WorkItemFixture, sourceJobId: string | null = 'job_get_plan') {
  return plansService.createPlan(fx.projectId, { title: null, summary: null, sourceJobId }, fx.ctx);
}

/** The proposal with this title, from a returned plan. */
function itemTitled(plan: PlanWithItemsDto, title: string): PlanItemDto {
  const found = plan.items.find((i) => i.proposedFields?.title === title);
  if (!found) throw new Error(`No proposal titled "${title}" in the returned plan.`);
  return found;
}

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('get_plan — registration, scope, and the proposal gate', () => {
  it('is registered under a stable name and gated by the `read` scope', () => {
    expect(MCP_TOOL_NAMES).toContain(GET_PLAN_TOOL_NAME);
    // A pure read: it neither submits a job nor approves anything, so a
    // read-only token must be able to call it (the story-roundtrip scope matrix
    // executes exactly that).
    expect(toolScope(GET_PLAN_TOOL_NAME)).toBe('read');
  });

  it('advertises that these are proposals, and points at get_plan_status for the poll', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === GET_PLAN_TOOL_NAME);
    // The description is the only thing standing between an agent and the
    // inference that these titles are work items.
    expect(tool?.description).toMatch(/PROPOSALS, NOT work items/i);
    expect(tool?.description).toMatch(/approving the plan/i);
    // ...and the only thing telling it which of the two plan reads to reach for.
    expect(tool?.description).toContain('get_plan_status');
    await client.close();
  });
});

describe('get_plan — the transport contract', () => {
  it('returns plansService.getPlan’s DTO unchanged, items and all', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await makePlan(fx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A proposal', kind: 'subtask' } }],
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    const res = await call(client, { planId: plan.id });
    expect(res.isError).toBeFalsy();
    // Deep equality against the service itself — no re-mapping, no dropped
    // field, no invented one. (JSON round-trips the DTO, which is already all
    // strings/numbers/nulls, so the comparison is exact.)
    //
    // ⚠️ WITH ONE DECLARED WIDENING (MOTIR-5415): every proposal also carries
    // `folderId` / `folderPath`, the folder it names — `null` on this folder-free
    // proposal. The property this test exists for still holds field for field:
    // every DTO key arrives unchanged, and the only keys added are those two.
    // AND ONE MORE (MOTIR-9978): the payload carries the authoring agent's own
    // `plannerRecord`, kept off the plan DTO — `null` on this plan, which has none.
    const fromService = await plansService.getPlan(plan.id, fx.ctx);
    const expected = JSON.parse(JSON.stringify(fromService)) as {
      items: Record<string, unknown>[];
      plannerRecord?: unknown;
    };
    expected.items = expected.items.map((item) => ({ ...item, folderId: null, folderPath: null }));
    expected.plannerRecord = null;
    expect(struct(res)).toEqual(expected);
    await client.close();
  });

  it('reading a plan creates nothing — the tree is untouched', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Host story' },
      fx.ctx,
    );
    const plan = await makePlan(fx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'Would-be child' }, parentRef: story.id },
        { op: 'add', proposedFields: { title: 'Another would-be child' }, parentRef: story.id },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });

    const client = await connectClient(fx.ctx);
    const res = await call(client, { planId: plan.id });
    expect(struct(res).items).toHaveLength(2);

    // Every `add` is still un-materialized, and the host story gained no
    // children: the read is a read.
    const workItemCount = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    expect(workItemCount).toBe(before);
    const workItemCount2 = await adminDb.workItem.count({ where: { parentId: story.id } });
    expect(workItemCount2).toBe(0);
    const planItemCount = await adminDb.planItem.count({
      where: { planId: plan.id, workItemId: null },
    });
    expect(planItemCount).toBe(2);
    await client.close();
  });
});

describe('get_plan — the proposed tree survives the wire', () => {
  it('all three ops round-trip with parentRef / blockedByRefs intact', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Live story' },
      fx.ctx,
    );
    const doomed = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Doomed task' },
      fx.ctx,
    );
    // Two levels down under a root of its own — the child proposal's depth, so its
    // blocked_by is same-level (MOTIR-6411).
    const elsewhere = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Elsewhere' },
      fx.ctx,
    );
    const elsewhereTask = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Elsewhere task', parentId: elsewhere.id },
      fx.ctx,
    );
    const stale = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'Stale task', parentId: elsewhereTask.id },
      fx.ctx,
    );
    const plan = await makePlan(fx);

    // Phase 1: the parent `add`, hanging off a REAL work item.
    const afterParent = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Parent proposal', kind: 'task', type: 'code' },
          parentRef: story.id,
        },
      ],
      fx.ctx,
    );
    const parentProposal = itemTitled(afterParent, 'Parent proposal');

    // Phase 2: a child hanging off THAT proposal via the intra-plan temp-ref,
    // plus the modify / remove ops — the full three-op set.
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Child proposal',
            kind: 'subtask',
            storyPoints: 3,
            estimateMinutes: 40,
          },
          parentRef: `${TEMP_REF_PREFIX}${parentProposal.id}`,
          // Not its own parent too: a parent sits a level above its child, and a
          // blocked_by never crosses levels (MOTIR-6411).
          blockedByRefs: [stale.id],
        },
        {
          op: 'modify',
          workItemId: stale.id,
          patch: { title: 'Refreshed task', priority: 'high' },
        },
        { op: 'remove', workItemId: doomed.id },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const client = await connectClient(fx.ctx);
    const out = struct(await call(client, { planId: plan.id }));
    expect(out.itemCount).toBe(4);
    expect(out.items).toHaveLength(4);

    // The `add`s: an un-materialized workItemId, the proposed fields, and the
    // refs that make the tree rebuildable.
    const parent = itemTitled(out, 'Parent proposal');
    const child = itemTitled(out, 'Child proposal');
    expect(parent.op).toBe('add');
    expect(parent.workItemId).toBeNull();
    expect(parent.parentRef).toBe(story.id);
    expect(child.parentRef).toBe(`${TEMP_REF_PREFIX}${parent.id}`);
    expect(child.blockedByRefs).toEqual([stale.id]);
    expect(child.proposedFields).toMatchObject({ storyPoints: 3, estimateMinutes: 40 });

    // The modify / remove: their targets, verbatim.
    const modify = out.items.find((i) => i.op === 'modify')!;
    expect(modify.workItemId).toBe(stale.id);
    expect(modify.patch).toEqual({ title: 'Refreshed task', priority: 'high' });
    expect(out.items.find((i) => i.op === 'remove')!.workItemId).toBe(doomed.id);

    // A client can rebuild the proposed tree from what came back alone: the
    // child resolves to the parent through the temp-ref, and nothing else does.
    const byId = new Map(out.items.map((i) => [i.id, i]));
    expect(byId.get(child.parentRef!.slice(TEMP_REF_PREFIX.length))).toBe(parent);
    await client.close();
  });

  it('renders the proposals as an indented tree with op markers and sizing', async () => {
    const fx = await makeWorkItemFixture();
    // One level down under a root of its own — the nested add's depth (MOTIR-6411).
    const elsewhere = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Elsewhere' },
      fx.ctx,
    );
    const stale = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Stale task', parentId: elsewhere.id },
      fx.ctx,
    );
    // A plan may carry only ONE op per target (`@@unique([planId, workItemId])`),
    // so the remove aims at its own item.
    const doomed = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Doomed task' },
      fx.ctx,
    );
    const plan = await makePlan(fx);
    const afterParent = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Parent', kind: 'story', type: 'code' } }],
      fx.ctx,
    );
    const parentId = itemTitled(afterParent, 'Parent').id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Nested', kind: 'subtask', storyPoints: 2, estimateMinutes: 30 },
          parentRef: `${TEMP_REF_PREFIX}${parentId}`,
          blockedByRefs: [stale.id],
        },
        { op: 'modify', workItemId: stale.id, patch: { priority: 'low' } },
        { op: 'remove', workItemId: doomed.id },
      ],
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const rendered = text(await call(client, { planId: plan.id }));

    // A client that ignores structuredContent still SEES the shape: the child is
    // indented one level under its proposed parent, each line carries its op
    // marker, and the leaf sizing rides along.
    expect(rendered).toContain('  + [story/code] Parent');
    expect(rendered).toContain(`    + [subtask] Nested (2 pts · 30m) · blocked_by: ${stale.id}`);
    // A `modify` / `remove` names its target by the KEY the reviewer knows it as
    // (MOTIR-3191). It used to print the cuid, which is an identifier for the
    // database and for nobody reading a plan. Both targets are root cards here,
    // so they still sit at the top level — correctly, this time.
    expect(rendered).toContain(`  ~ modify ${stale.identifier} — priority`);
    expect(rendered).toContain(`  - remove ${doomed.identifier}`);
    // And it is told, in the same breath, that none of it exists yet.
    expect(rendered).toContain('These are PROPOSALS, not work items');
    await client.close();
  });

  it('an `add` under a REAL parent hangs off a NAMED branch of the live tree', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Live story' },
      fx.ctx,
    );
    const plan = await makePlan(fx, null);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Hangs off a live item' }, parentRef: story.id }],
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const rendered = text(await call(client, { planId: plan.id }));
    // ⚠️ This used to assert `  + [task] Hangs off a live item` at the TOP level,
    // on the reasoning that a parent outside the plan gives nothing to nest under
    // (MOTIR-3191). But the top level of a plan is where a ROOT card is proposed,
    // and the plan rules reserve that for epics — so "there is nothing to nest it
    // under" rendered as "this proposes a new root". The branch is nameable; name
    // it, and hang the proposal off it.
    expect(rendered).toContain(`  under ${story.identifier} — Live story:`);
    expect(rendered).toContain('    + [task] Hangs off a live item');
    // A plan with no job never claims one.
    expect(rendered).not.toContain('job ');
    await client.close();
  });

  // ── bug MOTIR-3191 — an amendment reads as an amendment ────────────────────
  //
  // A `modify` carries no `parentRef` (its parent is the live card's, and a
  // proposal may not re-parent anything), so it rendered un-indented beside the
  // root-level `add`s — where the plan rules put epics. A plan of two modifies
  // therefore read as two new root cards and was declined on that reading, which
  // was a correct reading of what the surface showed and a wrong description of
  // what the plan did.

  it('lists a `modify` under its target’s committed ANCESTRY, not beside root adds', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'The agent loop' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Plan review', parentId: epic.id },
      fx.ctx,
    );
    const first = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'The canvas', parentId: story.id },
      fx.ctx,
    );
    const second = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'The rail', parentId: story.id },
      fx.ctx,
    );

    const plan = await makePlan(fx, null);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: first.id, patch: { descriptionMd: 'Rewritten.' } },
        { op: 'modify', workItemId: second.id, patch: { descriptionMd: 'Rewritten too.' } },
      ],
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const rendered = text(await call(client, { planId: plan.id }));

    // The whole committed chain names the branch, exactly as the canvas
    // breadcrumb does — and BOTH amendments sit under it.
    expect(rendered).toContain(`  under ${epic.identifier} ▸ ${story.identifier} — Plan review:`);
    expect(rendered).toContain(`    ~ modify ${first.identifier} — descriptionMd`);
    expect(rendered).toContain(`    ~ modify ${second.identifier} — descriptionMd`);
    // Nothing is left at the top level — the reading that got the fixture plan
    // declined ("don't put the cards in the project root, that's for epics").
    const lines = rendered.split('\n');
    expect(lines.filter((l) => /^ {2}[+~-] /.test(l))).toEqual([]);
    await client.close();
  });

  it('places a mixed plan’s add and modify under their OWN branches', async () => {
    const fx = await makeWorkItemFixture();
    const storyA = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Where the add goes' },
      fx.ctx,
    );
    const storyB = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Where the target lives' },
      fx.ctx,
    );
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'An existing card', parentId: storyB.id },
      fx.ctx,
    );

    const plan = await makePlan(fx, null);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', parentRef: storyA.id, proposedFields: { title: 'A brand new card' } },
        { op: 'modify', workItemId: target.id, patch: { title: 'Re-scoped' } },
      ],
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const rendered = text(await call(client, { planId: plan.id }));

    expect(rendered).toContain(`  under ${storyA.identifier} — Where the add goes:`);
    expect(rendered).toContain('    + [task] A brand new card');
    expect(rendered).toContain(`  under ${storyB.identifier} — Where the target lives:`);
    expect(rendered).toContain(`    ~ modify ${target.identifier} — title`);
    await client.close();
  });
});

describe('get_plan — plan states', () => {
  it('a still-GENERATING plan returns the proposals that have arrived so far', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await makePlan(fx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'First to land' } }],
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const res = await call(client, { planId: plan.id });
    // Not an error and not an empty answer: proposals stream in, so a caller
    // watching the content sees it fill rather than being told to come back.
    expect(res.isError).toBeFalsy();
    expect(struct(res).status).toBe('generating');
    expect(struct(res).items).toHaveLength(1);
    expect(text(res)).toContain('+ [task] First to land');
    await client.close();
  });

  it('an EMPTY generating plan says the planner is still working; an empty settled one says so plainly', async () => {
    const fx = await makeWorkItemFixture();
    const empty = await makePlan(fx);
    const client = await connectClient(fx.ctx);

    expect(text(await call(client, { planId: empty.id }))).toContain('No proposals have arrived');

    await plansService.markPlanned(empty.id, fx.ctx);
    const settled = await call(client, { planId: empty.id });
    expect(text(settled)).toContain('bundles no proposals');
    expect(struct(settled).items).toEqual([]);
    await client.close();
  });

  it('an APPROVED plan says its proposals were materialized, and carries the plan’s own title/summary', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Expand the CLI story', summary: 'Six subtasks', sourceJobId: 'job_approved' },
      fx.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Materialized item', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const client = await connectClient(fx.ctx);
    const res = await call(client, { planId: plan.id });
    const out = struct(res);
    expect(out.status).toBe('approved');
    // Approved is the ONE state where the summary may speak of work items.
    expect(text(res)).toContain('materialized into work items');
    expect(text(res)).toContain('Title: Expand the CLI story');
    expect(text(res)).toContain('Summary: Six subtasks');
    expect(text(res)).toContain('job job_approved');
    // The approve DID materialize, so the `add` now names its created row —
    // the one state where a proposal has a workItemId.
    expect(out.items[0]!.workItemId).toBeTruthy();
    await client.close();
  });
});

describe('get_plan — access', () => {
  it('an unknown plan, and another tenant’s plan, both read as PLAN_NOT_FOUND (404-not-403)', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const plan = await makePlan(a, 'job_acme');
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Acme’s secret roadmap' } }],
      a.ctx,
    );
    const outsider = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });

    const own = await connectClient(a.ctx);
    const missing = await call(own, { planId: 'plan_nope' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('PLAN_NOT_FOUND');
    await own.close();

    // The rival's answer is INDISTINGUISHABLE from the missing one — no
    // existence leak, and above all no proposal content.
    const rival = await connectClient(outsider.ctx);
    const denied = await call(rival, { planId: plan.id });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('PLAN_NOT_FOUND');
    expect(text(denied)).not.toContain('secret roadmap');
    await rival.close();
  });
});

describe('get_plan — malformed rows are rendered, never crash the read', () => {
  it('a temp-ref CYCLE and field-less proposals still come back listed', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await makePlan(fx);

    // These rows CANNOT be produced through `addProposals` — it requires a title
    // on an `add` and a target on a `modify`, and `approvePlan` rejects a
    // parent-ref cycle outright. They are written straight to the table (under
    // the workspace GUC the RLS policy reads) precisely because the renderer
    // walks caller-supplied refs: a cycle would otherwise recurse until the
    // stack blows, and a listing that silently dropped rows would under-report a
    // plan the client is trusting it to show in full.
    const { first, second } = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      async (tx) => {
        const a = await tx.planItem.create({
          data: { workspaceId: fx.workspaceId, planId: plan.id, op: 'add', blockedByRefs: [] },
        });
        const b = await tx.planItem.create({
          data: {
            workspaceId: fx.workspaceId,
            planId: plan.id,
            op: 'add',
            blockedByRefs: [],
            parentRef: `${TEMP_REF_PREFIX}${a.id}`,
          },
        });
        await tx.planItem.update({
          where: { id: a.id },
          data: { parentRef: `${TEMP_REF_PREFIX}${b.id}` },
        });
        await tx.planItem.create({
          data: { workspaceId: fx.workspaceId, planId: plan.id, op: 'modify', blockedByRefs: [] },
        });
        return { first: a.id, second: b.id };
      },
    );

    const client = await connectClient(fx.ctx);
    const res = await call(client, { planId: plan.id });
    expect(res.isError).toBeFalsy();
    const rendered = text(res);
    // Both halves of the cycle are printed exactly once, and the target-less
    // modify is printed rather than dropped.
    expect(struct(res).items).toHaveLength(3);
    expect(rendered.match(/\(untitled\)/g)).toHaveLength(2);
    expect(rendered).toContain('~ modify (no target)');
    // Neither half of the cycle was swallowed by the root-set walk.
    expect(struct(res).items.map((i) => i.id)).toEqual(expect.arrayContaining([first, second]));
    await client.close();
  });
});

describe('get_plan — includeSections (MOTIR-9033)', () => {
  const planWithProposals = async (fx: WorkItemFixture) => {
    const existing = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', type: 'code', title: 'Existing' },
      fx.ctx,
    );
    const other = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', type: 'code', title: 'Other' },
      fx.ctx,
    );
    const plan = await makePlan(fx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Prose add',
            kind: 'task',
            type: 'code',
            descriptionMd: 'Plain body, no headings.',
          },
        },
        { op: 'modify', workItemId: existing.id, patch: { title: 'Renamed' } },
        { op: 'remove', workItemId: other.id },
      ],
      fx.ctx,
    );
    return plan;
  };

  it('an unasked call is unchanged: no parsedSections, no suffix', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await planWithProposals(fx);
    const client = await connectClient(fx.ctx);
    const res = await call(client, { planId: plan.id });
    expect(res.structuredContent).not.toHaveProperty('parsedSections');
    expect(text(res)).not.toContain('· sections');
    await client.close();
  });

  it('an asked call parses every add, none of the modify / remove, and leaves items alone', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await planWithProposals(fx);
    const client = await connectClient(fx.ctx);
    const unasked = await call(client, { planId: plan.id });
    const asked = await call(client, { planId: plan.id, includeSections: true });

    const view = (asked.structuredContent as { parsedSections: Record<string, unknown> })
      .parsedSections;
    const adds = struct(asked).items.filter((i) => i.op === 'add');
    expect(Object.keys(view)).toEqual(adds.map((i) => i.id));
    // The wire view omits `headed` (the parser's own extra), so compare without it.
    const { headed: _headed, ...onWire } = parseSections(
      'Plain body, no headings.',
      'task',
      'code',
    );
    expect(view[adds[0]!.id]).toEqual(onWire);
    expect(struct(asked).items).toEqual(struct(unasked).items);
    expect(text(asked)).toMatch(/Prose add.* · sections missing: /);
    await client.close();
  });
});
