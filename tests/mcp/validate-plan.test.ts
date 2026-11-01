import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { buildMcpServer } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import type { PlanWithItemsDto, ProposalInput } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { seedBlockedBy } from '../helpers/seedBlockedBy';
import { truncateAuthTables } from '../helpers/db';

// The PROJECTED MODE on the MCP validators (Story MOTIR-3093 · Subtask
// MOTIR-3095) over real Postgres.
//
// `planValidityService`'s own suite (`tests/integration/plans/planValidityService.test.ts`)
// already covers the projection RULES — every op kind, temp-ref resolution,
// loose vs tight, and the projection == materialize contract. This file covers
// what only becomes reachable once a PAT can call them: the transport, the
// argument contract, the error mapping, and the two invariants that would break
// silently — an un-projected call being byte-identical to before, and forest ≠
// per-root.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Connect an in-memory MCP client to a server bound to `ctx` (no scope gate). */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'validate-plan', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

const struct = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;
const text = (r: CallToolResult) => (r.content as { type: string; text: string }[])[0]!.text;

const mk = (
  fx: WorkItemFixture,
  title: string,
  kind: 'epic' | 'story' | 'task' | 'subtask',
  parentId?: string,
) => workItemsService.createWorkItem({ projectId: fx.projectId, kind, title, parentId }, fx.ctx);

async function freshPlan(fx: WorkItemFixture): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Plan' }, fx.ctx);
  return plan.id;
}

const addProposals = (fx: WorkItemFixture, planId: string, proposals: ProposalInput[]) =>
  plansService.addProposals(planId, proposals, fx.ctx);

const itemIdByTitle = (plan: PlanWithItemsDto, title: string): string =>
  plan.items.find((i) => i.proposedFields?.title === title)!.id;

/** Make an ACTIVE sprint (createSprint + startSprint), returning its id. */
async function activeSprint(fx: WorkItemFixture): Promise<string> {
  const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S1' }, fx.ctx);
  await sprintsService.startSprint(sprint.id, {}, fx.ctx);
  return sprint.id;
}

describe('validate_plan — the FOREST verdict a PAT can now reach', () => {
  // ⚠️ "OUT OF PLAN" IS NOT WHAT INVALIDATES A FOREST — read this before writing
  // a test that expects it to. The forest's containing set S is the WHOLE
  // projected forest of the plan's project, so a not-done SAME-PROJECT item is
  // IN S and never gates, under `loose` or `tight`. The only invalidating gate
  // is an OUT-of-forest blocker — a cross-project one, which enters the
  // projection off a live edge and is deliberately not a root. That is the
  // shipped MOTIR-1550 rule, and MOTIR-3095 mirrors it 1:1 rather than
  // inventing a stricter one. (MOTIR-3095's acceptance criterion 1 said
  // "out-of-plan" and was amended on the card, with this evidence.)
  it('reports a proposal gated by a not-done CROSS-PROJECT item — and creates no work item', async () => {
    const fx = await makeWorkItemFixture();
    const projectQ = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'BETA',
    });
    const outside = await workItemsService.createWorkItem(
      { projectId: projectQ.id, kind: 'task', title: 'Cross-project blocker' },
      fx.ctx,
    );
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });

    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: { title: 'Proposed leaf', kind: 'task' },
        blockedByRefs: [outside.id],
      },
    ]);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_plan', { planId });

    expect(res.isError).toBeFalsy();
    expect(struct(res)).toMatchObject({ planId, valid: false });
    const blockers = struct(res).blockers as { item: string; blockedBy: string }[];
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.item.startsWith(TEMP_REF_PREFIX)).toBe(true);
    expect(blockers[0]!.blockedBy).toBe(outside.identifier);
    expect(text(res)).toContain('is INVALID');

    // The whole point of the check: it answers BEFORE anything exists.
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
    expect((await plansService.getPlan(planId, fx.ctx)).status).toBe('generating');
  });

  // The mirror of the case above, and the reason it needs saying out loud: a
  // not-done blocker in the SAME project is a forest member, so the plan is
  // VALID. An agent reading `valid: true` must not conclude "nothing gates
  // this" — it means "nothing OUTSIDE this project's forest gates this".
  it('a not-done SAME-PROJECT blocker is IN the forest, so the plan is VALID', async () => {
    const fx = await makeWorkItemFixture();
    const sameProject = await mk(fx, 'Same-project todo', 'task');
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: { title: 'Proposed leaf', kind: 'task' },
        blockedByRefs: [sameProject.id],
      },
    ]);

    const client = await connectClient(fx.ctx);
    expect(struct(await call(client, 'validate_plan', { planId }))).toMatchObject({ valid: true });
    expect(
      struct(await call(client, 'validate_plan', { planId, condition: 'tight' })),
    ).toMatchObject({ valid: true });
  });

  it('is VALID when the only blocker is another proposal in the same plan', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const first = await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Producer', kind: 'task' } },
    ]);
    const producerRef = `${TEMP_REF_PREFIX}${itemIdByTitle(first, 'Producer')}`;
    await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: { title: 'Consumer', kind: 'task' },
        blockedByRefs: [producerRef],
      },
    ]);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_plan', { planId });
    expect(struct(res)).toMatchObject({ planId, valid: true, blockers: [] });
    expect(text(res)).toContain('is VALID');
    expect(text(res)).toContain('No work item was created');
  });

  // ⚠️ THE INVARIANT THIS TOOL EXISTS FOR. A cross-root edge is valid in the
  // forest and a false positive per-root, so a future "simplification" of
  // validate_plan into a loop over validate_work_item would be caught here.
  it('FOREST ≠ PER-ROOT — a cross-root edge between two proposed epics is valid only in the forest', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const roots = await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Epic A', kind: 'epic' } },
      { op: 'add', proposedFields: { title: 'Epic B', kind: 'epic' } },
    ]);
    const epicA = `${TEMP_REF_PREFIX}${itemIdByTitle(roots, 'Epic A')}`;
    const epicB = `${TEMP_REF_PREFIX}${itemIdByTitle(roots, 'Epic B')}`;
    const leaves = await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Story A1', kind: 'story' }, parentRef: epicA },
    ]);
    const storyA1 = `${TEMP_REF_PREFIX}${itemIdByTitle(leaves, 'Story A1')}`;
    await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: { title: 'Story B1', kind: 'story' },
        parentRef: epicB,
        blockedByRefs: [storyA1], // gated by a story under the OTHER proposed epic
      },
    ]);

    const client = await connectClient(fx.ctx);

    // FINISHABLE over the forest (no blocker) — but not VALID since MOTIR-6370:
    // Story B1 and Story A1 sit under different epics that carry no edge.
    const forest = await call(client, 'validate_plan', { planId });
    expect(struct(forest)).toMatchObject({ valid: false, blockers: [] });
    expect(struct(forest).invalidEdges).toEqual([
      expect.objectContaining({ blockedBy: storyA1, itemParent: epicB, blockerParent: epicA }),
    ]);

    // The same plan, asked per-root: epic B's subtree does not contain Story A1,
    // so the subtree rule correctly reports it. Both answers are right for their
    // own question — which is exactly why the forest is not a loop.
    const perRoot = await call(client, 'validate_work_item', { key: epicB, planId });
    expect(struct(perRoot)).toMatchObject({ valid: false });
    expect((struct(perRoot).blockers as unknown[]).length).toBe(1);
  });

  it('names the blocker’s SPRINT when it has one, and the backlog when it does not', async () => {
    const fx = await makeWorkItemFixture();
    const projectQ = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'BETA',
    });
    const outside = await workItemsService.createWorkItem(
      { projectId: projectQ.id, kind: 'task', title: 'Cross-project blocker' },
      fx.ctx,
    );
    const qSprint = await sprintsService.createSprint(projectQ.id, { name: 'Q1' }, fx.ctx);
    await adminDb.workItem.update({ where: { id: outside.id }, data: { sprintId: qSprint.id } });

    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: { title: 'Gated', kind: 'task' },
        blockedByRefs: [outside.id],
      },
    ]);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_plan', { planId });
    expect(struct(res)).toMatchObject({ valid: false });
    expect(text(res)).toContain(`sprint ${qSprint.id}`);

    // …and the backlog arm of the same line, so neither is a never-taken branch.
    await adminDb.workItem.update({ where: { id: outside.id }, data: { sprintId: null } });
    expect(text(await call(client, 'validate_plan', { planId }))).toContain('backlog');
  });

  // ── THE REJECTIONS SECTION (MOTIR-3575) ───────────────────────────────────
  //
  // ⚠️ THE RENDERED TEXT IS THE DELIVERABLE HERE, NOT THE VERDICT.
  // `planValidityService`'s own suite already proves `rejections` is COMPUTED —
  // every rejection class, over real Postgres. What only exists on this surface
  // is the SENTENCE an agent reads, and the whole point of MOTIR-3575 is that a
  // caller must be able to tell the two failure families apart: a rejection
  // means the plan is MALFORMED and re-sequencing cannot help, a blocker means
  // it reaches outside itself. A summary that renders one family as the other,
  // or drops it, is the defect — and it would pass every structured assertion.

  /** A `generating` plan carrying a ref that resolves to nothing. Broken UNDER
   *  the service on purpose: since MOTIR-3573 the pure ref checks run at the
   *  append, and the resolvable-against-the-live-tree arm runs at the close — so
   *  a dangling work-item id is exactly what `validate_plan` exists to catch
   *  BEFORE `final: true`, and seeding it is how a caller's own typo arrives. */
  async function planWithDanglingParent(fx: WorkItemFixture): Promise<string> {
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Hangs off nothing', kind: 'task' } },
    ]);
    const [row] = await adminDb.planItem.findMany({ where: { planId }, select: { id: true } });
    await adminDb.planItem.update({
      where: { id: row!.id },
      data: { parentRef: 'wi_does_not_exist' },
    });
    return planId;
  }

  it('renders the REJECTION as its own labelled section, saying re-sequencing will not help', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await planWithDanglingParent(fx);
    const client = await connectClient(fx.ctx);

    const res = await call(client, 'validate_plan', { planId });
    const out = text(res);

    expect(struct(res).valid).toBe(false);
    // The LABEL is what separates the two families for a reader.
    expect(out).toContain('APPROVE WOULD REFUSE IT');
    expect(out).toContain('INVALID_PLAN_REF_GRAPH');
    expect(out).toContain('dangling');
    // …and the instruction that makes the verdict actionable at the only moment
    // it is cheap: after `final: true` the proposals are frozen.
    expect(out).toContain('Fix this BEFORE `final: true`');
    expect(out).toContain('is reported at a time');
    // No blockers here, so that section must NOT appear — a summary that always
    // prints both would read as two problems where there is one.
    expect(out).not.toContain('neither in the plan nor done');
  });

  it('renders a rejection with NO reason without a dangling separator', async () => {
    const fx = await makeWorkItemFixture();
    const done = await mk(fx, 'Already shipped', 'task');
    // `todo → done` is not a legal edge in this workflow; walk the real ladder
    // rather than writing the row, so the fixture cannot drift from the product.
    await workItemsService.updateStatus(done.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(done.id, 'done', fx.ctx);
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'modify', workItemId: done.id, patch: { title: 'Rewrite it' } },
    ]);
    const client = await connectClient(fx.ctx);

    const out = text(await call(client, 'validate_plan', { planId }));

    // `PLAN_TARGET_IMMUTABLE` is the one rejection class that carries NO
    // `reason` — the code says the whole thing. The line renders the code alone
    // rather than a code followed by an empty ` / `, which is the sort of
    // artefact a reader takes for a truncated message.
    expect(out).toContain('APPROVE WOULD REFUSE IT');
    expect(out).toContain('PLAN_TARGET_IMMUTABLE');
    expect(out).not.toContain('PLAN_TARGET_IMMUTABLE / ');
  });

  it('the VALID arm promises BOTH answers, not finishability alone', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'A clean proposal', kind: 'task' } },
    ]);
    const client = await connectClient(fx.ctx);

    const out = text(await call(client, 'validate_plan', { planId }));

    // ⚠️ THE OLD SENTENCE PROMISED ONLY FINISHABILITY, and a reader took it as
    // *this plan is sound* — which is what made a plan the approve button then
    // refused safe to close. VALID now says both halves out loud.
    expect(out).toContain('is VALID');
    expect(out).toContain('ACCEPTED by approve');
    expect(out).toContain('can be finished');
  });

  it('an unknown plan id is a clean PLAN_NOT_FOUND, never an internal error', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_plan', { planId: 'does-not-exist' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('PLAN_NOT_FOUND');
  });

  it('is registered on all the compile-total registries the surface keeps', async () => {
    // The registries are `Record<McpToolName, …>`, so a missing row is a compile
    // error — this asserts the KEY each one files it under, which is not.
    expect(TOOL_PERMISSIONS.validate_plan).toBe('project:browse');
    expect(TOOL_PERMISSIONS.validate_work_item).toBe('project:browse');
    expect(TOOL_PERMISSIONS.validate_sprint).toBe('project:browse');
    expect(TOOL_SCOPES.validate_plan).toBe('read');

    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('validate_plan');
  });
});

describe('validate_work_item — the optional planId', () => {
  it('validates a subtree rooted at a `planItem:<id>` TEMP-REF — the case an authoring agent has', async () => {
    const fx = await makeWorkItemFixture();
    // One level down under a root of its own, at the proposed child's depth
    // (MOTIR-6411: an unrelated ROOT task is on another level).
    const outside = await mk(fx, 'Outside todo', 'task', (await mk(fx, 'Elsewhere', 'story')).id);

    const planId = await freshPlan(fx);
    const parent = await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Proposed story', kind: 'story' } },
    ]);
    const storyRef = `${TEMP_REF_PREFIX}${itemIdByTitle(parent, 'Proposed story')}`;
    await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: { title: 'Proposed child', kind: 'subtask' },
        parentRef: storyRef,
        blockedByRefs: [outside.id],
      },
    ]);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_work_item', { key: storyRef, planId });

    expect(res.isError).toBeFalsy();
    expect(struct(res)).toMatchObject({ key: storyRef, valid: false });
    expect(text(res)).toContain(`once plan ${planId} materializes`);
  });

  // The temp-ref is a cuid inside a case-SENSITIVE prefix. `normalizeIdentifier`
  // upper-cases, which is right for `acme-7` and destroys a temp-ref — so the
  // projected path must not run it. This is that boundary, asserted.
  it('does NOT upper-case a temp-ref (the normalization that is right for a key destroys one)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const plan = await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Proposed root', kind: 'story' } },
    ]);
    const ref = `${TEMP_REF_PREFIX}${itemIdByTitle(plan, 'Proposed root')}`;
    expect(ref).not.toBe(ref.toUpperCase()); // a cuid has lower-case letters

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_work_item', { key: ref, planId });
    expect(res.isError).toBeFalsy();
    expect(struct(res).key).toBe(ref);
  });

  it('a REAL key still resolves on the projected path, and a lower-case one is normalized', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Committed story', 'story');
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Elsewhere', kind: 'task' } },
    ]);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_work_item', {
      key: story.identifier.toLowerCase(),
      planId,
    });
    expect(struct(res)).toMatchObject({ key: story.identifier, valid: true });
  });

  it('an unknown temp-ref is a clean not-found, not an internal error', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_work_item', {
      key: `${TEMP_REF_PREFIX}nope`,
      planId,
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('NOT_FOUND');
  });

  // ⚠️ THE COMPATIBILITY PROMISE. AMENDMENT 3 Q5 makes it a property of the code
  // path (an omitted planId never reaches buildProjection), and this is the
  // observation of it. It is the regression that would be least noticed and most
  // damaging, since every existing consumer depends on it.
  it('WITHOUT planId returns byte-identical output to the un-projected call', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const external = await mk(fx, 'External todo', 'task');
    // Seeded below the door: a child and a ROOT task sit at different depths
    // (MOTIR-6411). This case is about the un-projected path, not the edge.
    await seedBlockedBy(fx, child.id, external.id);
    // A plan exists and is NOT named — its proposals must not leak in.
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Invisible', kind: 'subtask' }, parentRef: story.id },
    ]);

    const client = await connectClient(fx.ctx);
    const committed = await call(client, 'validate_work_item', { key: story.identifier });
    const direct = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);

    expect(struct(committed)).toEqual(direct);
    expect(text(committed)).not.toContain('materializes');
    // The plan's `add` is not in the committed subtree, so it neither appears
    // nor changes the verdict.
    expect(JSON.stringify(struct(committed))).not.toContain(TEMP_REF_PREFIX);
  });
});

describe('validate_sprint — the optional planId', () => {
  it('answers over the projected ACTIVE sprint without a projectKey', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const member = await mk(fx, 'In sprint', 'task');
    const outside = await mk(fx, 'Outside todo', 'task');
    await adminDb.workItem.update({ where: { id: member.id }, data: { sprintId } });

    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'modify', workItemId: member.id, patch: { blockedByAdd: [outside.id] } },
    ]);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_sprint', { planId });

    expect(res.isError).toBeFalsy();
    expect(struct(res)).toMatchObject({ sprintId, valid: false });
    expect(text(res)).toContain(`once plan ${planId} materializes`);
  });

  // REFUSED, not ignored: accepting an argument the path cannot honour is the
  // fiction the ADR forbids one layer down, in the permission map.
  it('REFUSES sprintId alongside planId rather than silently ignoring it', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const planId = await freshPlan(fx);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_sprint', { planId, sprintId });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('VALIDATE_SPRINT_INVALID');
    expect(text(res)).toContain('ACTIVE sprint');
  });

  it('still REQUIRES projectKey when no planId is given', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_sprint', {});
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('projectKey is required');
  });

  it('a project with no active sprint REFUSES rather than answering "no blockers"', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_sprint', { planId });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('NO_ACTIVE_SPRINT');
  });

  it('WITHOUT planId returns byte-identical output to the un-projected call', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const member = await mk(fx, 'In sprint', 'task');
    await adminDb.workItem.update({ where: { id: member.id }, data: { sprintId } });

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_sprint', { projectKey: fx.projectIdentifier });
    const direct = await sprintsService.validateSprint(fx.projectId, null, fx.ctx);
    expect(struct(res)).toEqual(direct);
    expect(text(res)).not.toContain('materializes');
  });
});

describe('validate_plan — the MISLABELLED-LINK advisory beside the verdict (MOTIR-9007)', () => {
  it('reports a crossed link in a PROPOSED body in `advisories` and the text, and stays VALID', async () => {
    const fx = await makeWorkItemFixture();
    const meant = await mk(fx, 'Meant', 'task');
    const opened = await mk(fx, 'Opened', 'task');
    const planId = await freshPlan(fx);
    const plan = await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: {
          title: 'New card',
          kind: 'task',
          type: 'code',
          descriptionMd: `Depends on [${meant.identifier}](motir:${opened.id}).`,
        },
      },
    ]);
    await plansService.markPlanned(planId, fx.ctx);
    const addRef = `planItem:${itemIdByTitle(plan, 'New card')}`;

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_plan', { planId });
    expect(struct(res).valid).toBe(true);
    expect(struct(res).advisories).toEqual([
      {
        kind: 'shape',
        item: addRef,
        severity: 'likely-mislabelled-link',
        label: meant.identifier,
        targetId: opened.id,
        targetKey: opened.identifier,
        field: 'descriptionMd',
      },
    ]);
    expect(text(res)).toContain('is VALID');
    expect(text(res)).toContain(
      `${addRef} links "${meant.identifier}" to motir:${opened.id} in its descriptionMd, which is ${opened.identifier}.`,
    );
    await client.close();
  });

  it('reports a link in a PROPOSED explanation, naming `explanationMd` (MOTIR-9938)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const plan = await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: {
          title: 'Explained card',
          kind: 'task',
          type: 'code',
          descriptionMd: 'Nothing linked.',
          explanationMd: 'Matters because of [PROD-404](motir:cl_dead).',
        },
      },
    ]);
    await plansService.markPlanned(planId, fx.ctx);
    const addRef = `planItem:${itemIdByTitle(plan, 'Explained card')}`;

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_plan', { planId });
    expect(struct(res).advisories).toEqual([
      {
        kind: 'shape',
        item: addRef,
        severity: 'likely-mislabelled-link',
        label: 'PROD-404',
        targetId: 'cl_dead',
        targetKey: null,
        field: 'explanationMd',
      },
    ]);
    expect(text(res)).toContain(
      `${addRef} links "PROD-404" to motir:cl_dead in its explanationMd, which opens NO work item.`,
    );
    await client.close();
  });

  it('a plan with no such link carries an empty `advisories` and no advisory prose', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Plain', kind: 'task', type: 'code' } },
    ]);
    await plansService.markPlanned(planId, fx.ctx);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_plan', { planId });
    expect(struct(res).advisories).toEqual([]);
    expect(text(res)).not.toContain('Advisory');
    await client.close();
  });
});

describe('validate_plan — every SHAPE advisory on the plan’s proposals (MOTIR-10087)', () => {
  // Both planners close on `validate_plan` alone. Until MOTIR-10087 it carried
  // only the mislabelled link, so a proposal the detector flagged
  // `likely-self-blocking-design` was sealed and reached the runner, whose guard
  // #4 reads a two-index shape entry as LIFT and stops.

  /** The reconstructed MOTIR-3154 criteria set: criterion 1 draws, 3 builds. */
  const selfBlockingBody = [
    '## Acceptance criteria',
    '',
    '1. a `design/ai-planning/` three-file amendment — the accepted and declined node treatments',
    '2. decline no longer deletes the proposal rows',
    '3. the plan-detail canvas draws a DECIDED plan, one node per approved add',
  ].join('\n');

  const leaf = (title: string, descriptionMd: string) => ({
    title,
    kind: 'subtask' as const,
    type: 'code' as const,
    executor: 'coding_agent' as const,
    storyPoints: 2,
    estimateMinutes: 30,
    descriptionMd,
  });

  it('lists a proposed leaf’s self-blocking design with its ref and BOTH indices, and stays VALID', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const planId = await freshPlan(fx);
    const plan = await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: leaf('Draws and builds', selfBlockingBody),
        parentRef: story.id,
      },
    ]);
    await plansService.markPlanned(planId, fx.ctx);
    const addRef = `planItem:${itemIdByTitle(plan, 'Draws and builds')}`;

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_plan', { planId });
    expect(struct(res).valid).toBe(true);
    expect(struct(res).advisories).toEqual([
      {
        kind: 'shape',
        item: addRef,
        severity: 'likely-self-blocking-design',
        designCriterionIndex: 1,
        surfaceCriterionIndex: 3,
      },
    ]);
    expect(text(res)).toContain('is VALID');
    expect(text(res)).toContain('NOT a blocker — the plan is still VALID either way');
    expect(text(res)).toContain(
      `${addRef}: criterion 1 produces a design asset, criterion 3 builds a rendered surface (likely-self-blocking-design)`,
    );
    await client.close();
  });

  it('lists the same entry `validate_work_item { planId }` yields for that proposal', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: leaf('Draws and builds', selfBlockingBody),
        parentRef: story.id,
      },
    ]);
    await plansService.markPlanned(planId, fx.ctx);

    const client = await connectClient(fx.ctx);
    const whole = struct(await call(client, 'validate_plan', { planId })).advisories;
    const subtree = struct(
      await call(client, 'validate_work_item', { key: story.identifier, planId }),
    ).advisories as { kind?: string }[];
    expect(whole).toEqual(subtree.filter((a) => a.kind === 'shape'));
    await client.close();
  });

  it('lists none once the plan LIFTS the design into a sibling the leaf is blocked_by', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const planId = await freshPlan(fx);
    const withDesign = await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: { ...leaf('The drawing', 'Draws the canvas.'), type: 'design' },
        parentRef: story.id,
      },
    ]);
    const designRef = `planItem:${itemIdByTitle(withDesign, 'The drawing')}`;
    await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: leaf('Draws and builds', selfBlockingBody),
        parentRef: story.id,
        blockedByRefs: [designRef],
      },
    ]);
    await plansService.markPlanned(planId, fx.ctx);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_plan', { planId });
    expect(struct(res).advisories).toEqual([]);
    expect(text(res)).not.toContain('Advisory');
    await client.close();
  });

  it('lists a committed card the plan MODIFIES, by its key — and never one the plan leaves untouched', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const commit = (title: string) =>
      workItemsService.createWorkItem(
        { projectId: fx.projectId, parentId: story.id, ...leaf(title, selfBlockingBody) },
        fx.ctx,
      );
    const touched = await commit('Touched');
    await commit('Untouched');
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'modify', workItemId: touched.id, patch: { title: 'Touched, renamed' } },
    ]);
    await plansService.markPlanned(planId, fx.ctx);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_plan', { planId });
    expect(struct(res).advisories).toEqual([
      {
        kind: 'shape',
        item: touched.identifier,
        severity: 'likely-self-blocking-design',
        designCriterionIndex: 1,
        surfaceCriterionIndex: 3,
      },
    ]);
    await client.close();
  });

  it('lists a proposed card laid inside the container whose merge it waits on, and says where it goes', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const planId = await freshPlan(fx);
    const plan = await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: {
          ...leaf('Walk it', 'Walk the canvas once deployed, on staging.'),
          type: 'verification',
          executor: 'human',
        },
        parentRef: story.id,
      },
    ]);
    await plansService.markPlanned(planId, fx.ctx);
    const addRef = `planItem:${itemIdByTitle(plan, 'Walk it')}`;

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_plan', { planId });
    expect(struct(res).advisories).toEqual([
      {
        kind: 'shape',
        item: addRef,
        severity: 'likely-post-merge-child-under-container',
        phrase: 'once deployed',
        container: story.identifier,
      },
    ]);
    expect(text(res)).toContain(
      `${addRef} reads the deployment ("once deployed") while it sits INSIDE ${story.identifier}, whose merge it waits on.`,
    );
    await client.close();
  });

  it('keeps a MISLABELLED LINK to the bodies the plan writes: a title-only modify does not report its stored link', async () => {
    const fx = await makeWorkItemFixture();
    const opened = await mk(fx, 'Opened', 'task');
    const old = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        ...leaf('Old card', `Built on [PROD-99](motir:${opened.id}).`),
        kind: 'task',
      },
      fx.ctx,
    );
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'modify', workItemId: old.id, patch: { title: 'Old card, renamed' } },
    ]);
    await plansService.markPlanned(planId, fx.ctx);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_plan', { planId });
    expect(struct(res).advisories).toEqual([]);
    await client.close();
  });
});

describe('validate_plan — SECTION findings, advisory (MOTIR-9032)', () => {
  it('names a prose-only proposal in a VALID plan, states the count, and never flips `valid`', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const plan = await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: {
          title: 'Prose card',
          kind: 'task',
          type: 'code',
          descriptionMd: 'Just prose.',
        },
      },
    ]);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_plan', { planId });
    expect(res.isError).toBeFalsy();
    expect(struct(res)).toMatchObject({ planId, valid: true });
    const findings = struct(res).sectionFindings as { item: string; state: string }[];
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      item: `${TEMP_REF_PREFIX}${itemIdByTitle(plan, 'Prose card')}`,
      state: 'unstructured',
    });
    expect(text(res)).toContain('is VALID');
    expect(text(res)).toContain('Section findings (1, advisory — they do NOT change VALID)');
  });
});
