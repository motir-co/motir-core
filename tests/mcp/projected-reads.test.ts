import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { buildMcpServer } from '@/lib/mcp/registry';
import { planProposalLines } from '@/lib/mcp/tools/getWorkItem';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { FILTER_PARAM_VERSION } from '@/lib/filters/ast';
import type { PlanWithItemsDto, ProposalInput } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The PROJECTED READS (Story MOTIR-3093 · Subtask MOTIR-3096) over real
// Postgres — `get_work_item` and `search_work_items` answering over the live
// tree ⊕ a plan's delta.
//
// The projection RULES are `planValidityService`'s suite. What is asserted here
// is what only exists once a read publishes them: the DISCRIMINATOR (a proposal
// is never mixed into a work item's array, and is self-marked besides), the
// per-op behaviour a reader sees (`add` / `modify` / `remove`), the honest
// filter boundary, the read-only invariant, and — the one that would be least
// noticed and most damaging — that a call WITHOUT `planId` is unchanged.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'projected-reads', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

const struct = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;
const text = (r: CallToolResult) => (r.content as { type: string; text: string }[])[0]!.text;

interface Row {
  proposal: boolean;
  key: string | null;
  tempRef: string | null;
  planItemId: string | null;
  title: string | null;
  kind: string | null;
  status: string;
  parent: string | null;
  pendingPatch: Record<string, unknown> | null;
}

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

const refByTitle = (plan: PlanWithItemsDto, title: string): string =>
  `${TEMP_REF_PREFIX}${plan.items.find((i) => i.proposedFields?.title === title)!.id}`;

describe('get_work_item — the projected detail', () => {
  it('returns a PROPOSAL by its temp-ref, with no key and no key invented for it', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const plan = await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: { title: 'Invoice PDF', kind: 'subtask', storyPoints: 3, priority: 'high' },
      },
    ]);
    const ref = refByTitle(plan, 'Invoice PDF');

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'get_work_item', { key: ref, planId });

    expect(res.isError).toBeFalsy();
    const target = (struct(res).projection as Record<string, unknown>).target as Row;
    expect(target.proposal).toBe(true);
    expect(target.key).toBeNull();
    expect(target.tempRef).toBe(ref);
    expect(target.title).toBe('Invoice PDF');
    expect(target.kind).toBe('subtask');
    // ⚠️ The rule the whole substrate rests on: no `MOTIR-`-shaped string on a
    // row that no `get_work_item` can fetch. Asserted on the FIELD, never on the
    // summary text (which is prose and free to churn).
    expect(JSON.stringify(target)).not.toMatch(/[A-Z]+-\d+/);
    expect(text(res)).toContain('a PROPOSAL');
  });

  it('shows a plan’s PROPOSED children beside the committed ones, in separate arrays', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const committedChild = await mk(fx, 'Committed child', 'subtask', story.id);

    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: { title: 'Proposed child', kind: 'subtask' },
        parentRef: story.id,
      },
    ]);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'get_work_item', { key: story.identifier, planId });

    const proj = struct(res).projection as Record<string, unknown>;
    const children = proj.committedChildren as Row[];
    const proposed = proj.proposedChildren as Row[];
    // A COMMITTED target answers the full committed read (MOTIR-11340), so the
    // seam's own array holds the committed children exactly as the plain read
    // does; the plan's proposals still never enter it — they ride the projection.
    expect((struct(res).children as Array<{ key: string }>).map((c) => c.key)).toEqual([
      committedChild.identifier,
    ]);
    expect(children.map((c) => c.key)).toEqual([committedChild.identifier]);
    expect(children.every((c) => c.proposal === false)).toBe(true);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.proposal).toBe(true);
    expect(proposed[0]!.title).toBe('Proposed child');
    expect(proposed[0]!.key).toBeNull();
    // The STRUCTURAL half of the discriminator: a proposal never appears in the
    // array a caller reads committed children from.
    expect(children.some((c) => c.proposal)).toBe(false);
  });

  it('a proposal that has not said its KIND yet reads as unknown, not as a default', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    // `proposedFields.kind` is optional — materialize defaults it, and until
    // then the honest answer is that the plan has not said.
    const plan = await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Kindless' } },
    ]);
    const ref = refByTitle(plan, 'Kindless');

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'get_work_item', { key: ref, planId });
    const target = (struct(res).projection as Record<string, unknown>).target as Row;
    expect(target.kind).toBeNull();
    expect(text(res)).toContain('[?]');
  });

  it('a `modify` that re-types a card shows the PROJECTED type, not the stored one', async () => {
    const fx = await makeWorkItemFixture();
    const task = await mk(fx, 'Typed later', 'task');
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'modify', workItemId: task.id, patch: { type: 'design' } },
    ]);

    const client = await connectClient(fx.ctx);
    const target = (
      struct(await call(client, 'get_work_item', { key: task.identifier, planId }))
        .projection as Record<string, unknown>
    ).target as Row & { type: string | null };
    expect(target.type).toBe('design');
    expect(target.pendingPatch).toMatchObject({ type: 'design' });
  });

  it('carries a `modify` patch as pendingPatch — the row as it stands, plus what would change', async () => {
    const fx = await makeWorkItemFixture();
    const task = await mk(fx, 'Original title', 'task');
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'modify', workItemId: task.id, patch: { title: 'Re-scoped title', storyPoints: 5 } },
    ]);

    const client = await connectClient(fx.ctx);
    const target = (
      struct(await call(client, 'get_work_item', { key: task.identifier, planId }))
        .projection as Record<string, unknown>
    ).target as Row;

    expect(target.proposal).toBe(false);
    expect(target.key).toBe(task.identifier);
    // The row's own fields are TODAY's; the patch is what the plan would change.
    expect(target.title).toBe('Original title');
    expect(target.pendingPatch).toMatchObject({ title: 'Re-scoped title', storyPoints: 5 });
  });

  // MOTIR-11340 — a COMMITTED key read through a plan is the full committed answer
  // with the plan's `modify` laid over `item`, so `prompts/plan.py`'s guard can pass
  // the walk's plan on every card read without the session losing the body, the
  // children or the in-flight code the plain read carries.
  it('a COMMITTED key read through a plan answers in full, with `item` as the plan leaves it', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Stored title', 'story');
    await workItemsService.updateWorkItem(story.id, { descriptionMd: 'The stored body.' }, fx.ctx);
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      {
        op: 'modify',
        workItemId: story.id,
        patch: { title: 'Planned title', descriptionMd: 'The planned body.' },
      },
    ]);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'get_work_item', { key: story.identifier, planId });
    expect(res.isError).toBeFalsy();
    const body = struct(res);
    const item = body.item as { title: string; descriptionMd: string; identifier: string };
    expect(item.identifier).toBe(story.identifier);
    expect(item.title).toBe('Planned title');
    expect(item.descriptionMd).toBe('The planned body.');
    expect(body.planProposal).toMatchObject({
      planId,
      op: 'modify',
      approved: false,
      committed: { title: 'Stored title', descriptionMd: 'The stored body.' },
    });
    // Everything the plain read carries is still here.
    expect((body.children as Array<{ key: string }>).map((c) => c.key)).toEqual([child.identifier]);
    expect(body.inFlightCode).toEqual([]);
    expect(body.projection).toBeDefined();
    // The text shows the plan's body and never the stored one.
    expect(text(res)).toContain('MODIFIES this card');
    expect(text(res)).toContain('The planned body.');
    expect(text(res)).not.toContain('The stored body.');

    // Once the plan is no longer undecided, the read is the stored card.
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'declined' } });
    const after = await call(client, 'get_work_item', { key: story.identifier, planId });
    expect((struct(after).item as { title: string }).title).toBe('Stored title');
    expect(struct(after).planProposal).toBeUndefined();
    expect(text(after)).toContain('proposes no change to this card');
  });

  it('a committed key the plan does not touch reads as stored and says so', async () => {
    const fx = await makeWorkItemFixture();
    const task = await mk(fx, 'Untouched', 'task');
    const planId = await freshPlan(fx);
    const client = await connectClient(fx.ctx);
    const res = await call(client, 'get_work_item', {
      key: task.identifier,
      planId,
      includeSections: true,
    });
    expect((struct(res).item as { title: string }).title).toBe('Untouched');
    expect(struct(res).planProposal).toBeUndefined();
    expect(struct(res).parsedSections).toBeDefined();
    expect(text(res)).toContain('proposes no change to this card');
  });

  it('a modify that only moves edges names the projected blockers in the text', async () => {
    const fx = await makeWorkItemFixture();
    const gated = await mk(fx, 'Gated', 'task');
    const blocker = await mk(fx, 'Blocker', 'task');
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'modify', workItemId: gated.id, patch: { blockedByAdd: [blocker.id] } },
    ]);
    const client = await connectClient(fx.ctx);
    const res = await call(client, 'get_work_item', { key: gated.identifier, planId });
    expect(text(res)).toContain('Its text is unchanged.');
    expect(text(res)).toContain(`Blocked by, as the plan leaves it: ${blocker.identifier}`);
  });

  it('a modify that re-parents and clears every blocker says so in the head lines', () => {
    const lines = planProposalLines(
      {
        planId: 'p1',
        planStatus: 'planned',
        planItemId: 'pi1',
        op: 'modify',
        approved: false,
        patch: { parentRef: null, blockedByRemove: ['w2'] },
        committed: {},
        committedRevision: null,
        projectedBlockedBy: [],
        projectedParent: null,
      },
      'p1',
    );
    expect(lines).toEqual([
      '⚠️ Plan p1 MODIFIES this card (proposed, not approved). Its text is unchanged.',
      'Blocked by, as the plan leaves it: none',
      'Parent, as the plan leaves it: none (top level)',
    ]);
    expect(
      planProposalLines(
        {
          planId: 'p1',
          planStatus: 'planned',
          planItemId: 'pi1',
          op: 'modify',
          approved: false,
          patch: { parentRef: 'w9' },
          committed: {},
          committedRevision: null,
          projectedParent: 'PROD-9',
        },
        'p1',
      )[1],
    ).toBe('Parent, as the plan leaves it: PROD-9');
  });

  it('a card the plan REMOVES reads as removed, not as a not-found', async () => {
    const fx = await makeWorkItemFixture();
    const task = await mk(fx, 'Doomed', 'task');
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [{ op: 'remove', workItemId: task.id }]);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'get_work_item', { key: task.identifier, planId });
    expect(res.isError).toBeFalsy();
    const target = (struct(res).projection as Record<string, unknown>).target as Row;
    expect(target.key).toBe(task.identifier);
    expect(target.status).toBe('removed_by_plan');
    expect(text(res)).toContain('REMOVES');
  });

  it('renders projected blockedBy edges — a committed one and a proposed one, side by side', async () => {
    const fx = await makeWorkItemFixture();
    const committedBlocker = await mk(fx, 'Committed blocker', 'task');
    const planId = await freshPlan(fx);
    const first = await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Proposed blocker', kind: 'task' } },
    ]);
    const blockerRef = refByTitle(first, 'Proposed blocker');
    const plan = await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: { title: 'Gated', kind: 'task' },
        blockedByRefs: [committedBlocker.id, blockerRef],
      },
    ]);
    const gatedRef = refByTitle(plan, 'Gated');

    const client = await connectClient(fx.ctx);
    const proj = struct(await call(client, 'get_work_item', { key: gatedRef, planId }))
      .projection as Record<string, unknown>;
    const blockedBy = proj.blockedBy as Row[];

    expect(blockedBy).toHaveLength(2);
    const committed = blockedBy.find((b) => !b.proposal)!;
    const proposed = blockedBy.find((b) => b.proposal)!;
    expect(committed.key).toBe(committedBlocker.identifier);
    expect(committed.title).toBe('Committed blocker');
    expect(proposed.tempRef).toBe(blockerRef);
    expect(proposed.key).toBeNull();
  });

  it('a `modify` that REMOVES an edge drops it from the projected blockedBy', async () => {
    const fx = await makeWorkItemFixture();
    const gated = await mk(fx, 'Gated', 'task');
    const blocker = await mk(fx, 'Blocker', 'task');
    await workItemsService.linkWorkItems(
      { fromId: gated.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'modify', workItemId: gated.id, patch: { blockedByRemove: [blocker.id] } },
    ]);

    const client = await connectClient(fx.ctx);
    const withoutPlan = struct(await call(client, 'get_work_item', { key: gated.identifier }));
    expect((withoutPlan.blockedBy as unknown[]).length).toBe(1);

    const proj = struct(await call(client, 'get_work_item', { key: gated.identifier, planId }))
      .projection as Record<string, unknown>;
    expect(proj.blockedBy).toEqual([]);
  });

  it('an unknown temp-ref and an unknown plan are clean tool errors', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const client = await connectClient(fx.ctx);

    const badRef = await call(client, 'get_work_item', { key: `${TEMP_REF_PREFIX}nope`, planId });
    expect(badRef.isError).toBe(true);
    expect(text(badRef)).toContain('NOT_FOUND');

    const badPlan = await call(client, 'get_work_item', {
      key: 'PROD-1',
      planId: 'does-not-exist',
    });
    expect(badPlan.isError).toBe(true);
    expect(text(badPlan)).toContain('PLAN_NOT_FOUND');
  });

  // ⚠️ THE COMPATIBILITY PROMISE — the regression that would be least noticed
  // and most damaging, since every existing consumer depends on it.
  it('WITHOUT planId returns the committed aggregate, with no projection keys at all', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    await mk(fx, 'Child', 'subtask', story.id);
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Invisible', kind: 'subtask' }, parentRef: story.id },
    ]);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'get_work_item', { key: story.identifier });
    const s = struct(res);

    expect(s.projection).toBeUndefined();
    expect((s.children as unknown[]).length).toBe(1);
    expect(JSON.stringify(s)).not.toContain('Invisible');
    expect(JSON.stringify(s)).not.toContain(TEMP_REF_PREFIX);
  });
});

describe('search_work_items — the projected page', () => {
  it('returns committed rows and proposals in SEPARATE arrays, each self-marked', async () => {
    const fx = await makeWorkItemFixture();
    const committed = await mk(fx, 'Committed task', 'task');
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Proposed task', kind: 'task' } },
    ]);

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'search_work_items', {
      projectKey: fx.projectIdentifier,
      planId,
    });
    const s = struct(res);

    const items = s.items as { key: string }[];
    const proposals = s.proposals as Row[];
    expect(items.map((i) => i.key)).toContain(committed.identifier);
    expect(items.some((i) => (i as unknown as Row).proposal)).toBe(false);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!).toMatchObject({ proposal: true, key: null, title: 'Proposed task' });
    expect(s.projection).toMatchObject({ planId, filterAppliesTo: 'items' });
  });

  it('omits a committed row the plan REMOVES, and says how many it removed', async () => {
    const fx = await makeWorkItemFixture();
    const kept = await mk(fx, 'Kept', 'task');
    const doomed = await mk(fx, 'Doomed', 'task');
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [{ op: 'remove', workItemId: doomed.id }]);

    const client = await connectClient(fx.ctx);
    const s = struct(
      await call(client, 'search_work_items', { projectKey: fx.projectIdentifier, planId }),
    );
    const keys = (s.items as { key: string }[]).map((i) => i.key);
    expect(keys).toContain(kept.identifier);
    expect(keys).not.toContain(doomed.identifier);
    expect((s.projection as { removedIds: string[] }).removedIds).toEqual([doomed.id]);
  });

  // ⚠️ THE FILTER BOUNDARY — the behaviour the card asked to be the SAME every
  // time rather than an accident of which fields a proposal carries. The filter
  // narrows `items` and does not touch `proposals`, and the response SAYS so.
  it('applies the filter to `items` ONLY — proposals come back unfiltered, and the payload declares it', async () => {
    const fx = await makeWorkItemFixture();
    await mk(fx, 'Matching story', 'story');
    await mk(fx, 'Non-matching task', 'task');
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Proposed task', kind: 'task' } },
      { op: 'add', proposedFields: { title: 'Proposed story', kind: 'story' } },
    ]);

    const client = await connectClient(fx.ctx);
    const s = struct(
      await call(client, 'search_work_items', {
        projectKey: fx.projectIdentifier,
        planId,
        filter: {
          version: FILTER_PARAM_VERSION,
          combinator: 'and',
          conditions: [{ field: 'kind', operator: 'is_any_of', value: ['story'] }],
        },
      }),
    );

    // The committed page IS narrowed by the filter…
    expect((s.items as { kind: string }[]).every((i) => i.kind === 'story')).toBe(true);
    // …and BOTH proposals come back, including the one the filter would exclude.
    expect((s.proposals as Row[]).map((p) => p.title).sort()).toEqual([
      'Proposed story',
      'Proposed task',
    ]);
    expect((s.projection as { filterAppliesTo: string }).filterAppliesTo).toBe('items');
  });

  it('WITHOUT planId the response has no projection keys — byte-identical to before', async () => {
    const fx = await makeWorkItemFixture();
    await mk(fx, 'Committed task', 'task');
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Invisible', kind: 'task' } },
    ]);

    const client = await connectClient(fx.ctx);
    const s = struct(await call(client, 'search_work_items', { projectKey: fx.projectIdentifier }));
    expect(s.projection).toBeUndefined();
    expect(s.proposals).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('Invisible');
  });
});

// ⚠️ ASSERT THE ABSENCE OF THE WRITE, not merely that no error was thrown — a
// projection that accidentally materialized would pass every other test here.
describe('the projection persists NOTHING', () => {
  it('a full projected read + detail leaves the row count, every updatedAt, and the plan status unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    await mk(fx, 'Child', 'subtask', story.id);
    const planId = await freshPlan(fx);
    const plan = await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Proposed', kind: 'subtask' }, parentRef: story.id },
      { op: 'modify', workItemId: story.id, patch: { title: 'Re-scoped' } },
    ]);
    const ref = refByTitle(plan, 'Proposed');

    const before = await adminDb.workItem.findMany({
      where: { projectId: fx.projectId },
      select: { id: true, updatedAt: true, title: true },
      orderBy: { id: 'asc' },
    });

    const client = await connectClient(fx.ctx);
    await call(client, 'search_work_items', { projectKey: fx.projectIdentifier, planId });
    await call(client, 'get_work_item', { key: story.identifier, planId });
    await call(client, 'get_work_item', { key: ref, planId });
    await call(client, 'validate_plan', { planId });

    const after = await adminDb.workItem.findMany({
      where: { projectId: fx.projectId },
      select: { id: true, updatedAt: true, title: true },
      orderBy: { id: 'asc' },
    });
    expect(after).toEqual(before);
    expect((await plansService.getPlan(planId, fx.ctx)).status).toBe('generating');
    // And the `modify` did NOT touch the stored title, which is the specific way
    // an accidental materialize would show up first.
    expect(after.find((r) => r.id === story.id)!.title).toBe('Story');
  });
});
