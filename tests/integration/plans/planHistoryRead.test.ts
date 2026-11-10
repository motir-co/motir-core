import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { PLAN_STATUS_DTO_VALUES } from '@/lib/dto/plans';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { InvalidPlanHistoryCursorError } from '@/lib/plans/errors';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { withWorkspaceServiceContext, type WorkspaceContext } from '@/lib/workspaces/context';
import {
  createTestProject,
  createTestUser,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// The work-item page's PLAN HISTORY read (Story MOTIR-5542 · MOTIR-5546) over
// real Postgres — `planItemRepository.findHistoryByWorkItemId`,
// `plansService.listPlanHistoryForWorkItem` and `GET /api/work-items/[id]/plans`.
//
// ⚠️ EVERY PLAN IS DATED EXPLICITLY. The read orders by `plan.createdAt`, and
// plans created back to back in one test can share a millisecond — the id
// tie-break is a cuid, which is not monotonic — so an ordering assertion on
// undated plans would pass or fail by luck. `stamp` gives each plan its own
// second, in the order the test lists them.
//
// The session is the one thing stubbed, for the route cases: a route test has no
// cookie jar, so the compliance gate hands back the actor. Everything after it
// is the shipped path.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

// Imported after the mock is registered (vi.mock is hoisted above imports anyway).
import { GET } from '@/app/api/work-items/[id]/plans/route';

beforeEach(async () => {
  vi.clearAllMocks();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Status = (typeof PLAN_STATUS_DTO_VALUES)[number];
type Proposals = Parameters<typeof plansService.addProposals>[1];

const BASE = Date.UTC(2026, 0, 1);
let tick = 0;
/** Give a plan its own creation second, later than every plan stamped before it. */
async function stamp(planId: string): Promise<void> {
  tick += 1;
  await adminDb.plan.update({
    where: { id: planId },
    data: { createdAt: new Date(BASE + tick * 1000) },
  });
}

async function seed(fx: WorkItemFixture, title: string): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return dto.id;
}

/** A plan carrying `proposals`, driven through the real service into `status`.
 *  `stale` has no service path (the drift guard writes it), so it is set
 *  directly, as `pendingPlanIndicator.test.ts` does. */
async function planWith(
  fx: WorkItemFixture,
  proposals: Proposals,
  status: Status,
  title: string | null = 'A plan',
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, title === null ? {} : { title }, fx.ctx);
  await stamp(plan.id);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  if (status === 'generating') return freeTargets(plan.id);
  await plansService.markPlanned(plan.id, fx.ctx);
  if (status === 'planned') return freeTargets(plan.id);
  if (status === 'stale') {
    await adminDb.plan.update({ where: { id: plan.id }, data: { status: 'stale' } });
    return freeTargets(plan.id);
  }
  // Being approved (Bug MOTIR-9006): the claim an approve commits before it materializes.
  if (status === 'approving') {
    await adminDb.plan.update({
      where: { id: plan.id },
      data: { status: 'approving', approvingAt: new Date() },
    });
    return freeTargets(plan.id);
  }
  // A DECIDED plan releases its own targets, so these two need nothing.
  if (status === 'approved') await plansService.approvePlan(plan.id, fx.ctx);
  else await plansService.declinePlan(plan.id, fx.ctx);
  return plan.id;
}

/**
 * Drop the target locks an UN-DECIDED plan still holds, so the next plan in a
 * fixture can name the same card (MOTIR-5645).
 *
 * ⚠️ FIXTURE SURGERY, and it is admitting something true rather than working
 * around a defect. A plan PARKS every committed target it names and holds it
 * while the plan is open, so a real tenant can have at most ONE open plan per
 * card — a second is refused with `PlanTargetLockedError`, which is the whole
 * point of D4. Several cases in this file need a card with plans sitting at
 * `generating`, `planned` AND `stale` at once, which no tenant can produce.
 *
 * That is fine because this file's subject is the HISTORY READ's projection over
 * plan statuses, not the lock: it already stamps `stale` straight onto the row
 * for the same reason. The lock has its own coverage in
 * `tests/planning/planTargetParkDoor.test.ts`, including the refusal this
 * bypasses.
 */
async function freeTargets(planId: string): Promise<string> {
  await adminDb.planTargetLock.deleteMany({ where: { planId } });
  return planId;
}

const children = (parent: string, n: number): Proposals =>
  Array.from({ length: n }, (_, i) => ({
    op: 'add' as const,
    proposedFields: { title: `Child ${i + 1}`, kind: 'subtask' as const },
    parentRef: parent,
  }));

/** The work item an APPROVED plan's `add` created, read off the write-back. */
async function createdBy(planId: string, title: string): Promise<string> {
  const rows = await adminDb.planItem.findMany({ where: { planId, op: 'add' } });
  const row = rows.find((r) => (r.proposedFields as { title?: string } | null)?.title === title);
  if (!row?.workItemId) throw new Error(`no materialized add titled ${title} on ${planId}`);
  return row.workItemId;
}

const history = (fx: WorkItemFixture, target: string, opts = {}) =>
  plansService.listPlanHistoryForWorkItem(fx.projectId, target, opts, fx.ctx);

const brief = (page: Awaited<ReturnType<typeof history>>) =>
  page.items.map((e) => [e.planId, e.planStatus, e.relation.op, e.relation.childCount]);

/** A workspace member holding the project `viewer` role: browses, no `ai:view_plan`. */
async function viewerOf(fx: WorkItemFixture): Promise<WorkspaceContext> {
  const user = await createTestUser({ name: 'Viewer' });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await addToProjectAs({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'viewer',
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

const call = (id: string, query = '') =>
  GET(new Request(`https://app.motir.co/api/work-items/${id}/plans${query}`), {
    params: Promise.resolve({ id }),
  });

describe('planItemRepository.findHistoryByWorkItemId — the three arms, every status', () => {
  it('returns created · changed · children rows, with the plan fields on the row', async () => {
    const fx = await makeWorkItemFixture();
    const creator = await planWith(
      fx,
      [{ op: 'add', proposedFields: { title: 'Born', kind: 'task' } }],
      'approved',
    );
    const card = await createdBy(creator, 'Born');
    const changer = await planWith(
      fx,
      [{ op: 'modify', workItemId: card, patch: { title: 'X' } }],
      'declined',
    );
    const expander = await planWith(fx, children(card, 2), 'generating');

    // Bound to the workspace, as the service binds it: under the test app role
    // RLS is live, and an unbound read sees no rows at all.
    const read = (planIds: readonly string[] | null) =>
      withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        planItemRepository.findHistoryByWorkItemId(card, fx.workspaceId, fx.projectId, planIds, tx),
      );
    const rows = await read(null);
    expect(rows.map((r) => [r.plan.id, r.op])).toEqual([
      [creator, 'add'],
      [changer, 'modify'],
      [expander, 'add'],
      [expander, 'add'],
    ]);
    expect(rows[0]!.plan).toMatchObject({ status: 'approved', title: 'A plan' });
    expect(rows[0]!.plan.decidedBy?.name).toBe(fx.owner.name);
    // Narrowed to a page of plan ids, it reads only those plans' rows.
    const narrowed = await read([changer]);
    expect(narrowed.map((r) => r.plan.id)).toEqual([changer]);
  });
});

describe('plansService.listPlanHistoryForWorkItem', () => {
  it('the EMPTY case — a card no plan relates to reads { items: [], nextCursor: null }', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seed(fx, 'untouched');
    // A plan about a DIFFERENT card is not this card's history.
    const other = await seed(fx, 'someone else');
    await planWith(fx, [{ op: 'modify', workItemId: other, patch: { title: 'Y' } }], 'planned');

    expect(await history(fx, card)).toEqual({ items: [], nextCursor: null });
  });

  it('the story’s scenario — created by A, changed by B (approved), expanded by C (declined), oldest first', async () => {
    const fx = await makeWorkItemFixture();
    const a = await planWith(
      fx,
      [{ op: 'add', proposedFields: { title: 'The card', kind: 'task' } }],
      'approved',
      'A',
    );
    const card = await createdBy(a, 'The card');
    const b = await planWith(
      fx,
      [{ op: 'modify', workItemId: card, patch: { title: 'Renamed' } }],
      'approved',
      'B',
    );
    const c = await planWith(fx, children(card, 2), 'declined', 'C');

    const page = await history(fx, card);
    expect(brief(page)).toEqual([
      [a, 'approved', 'add', 0],
      [b, 'approved', 'modify', 0],
      [c, 'declined', null, 2],
    ]);
    expect(page.items.map((e) => e.planTitle)).toEqual(['A', 'B', 'C']);
    expect(page.nextCursor).toBeNull();
  });

  it('lists EVERY status — history is not only what landed', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seed(fx, 'much discussed');
    const ids: string[] = [];
    for (const status of PLAN_STATUS_DTO_VALUES) {
      // `remove` so no plan's materialize changes what a later one proposes against.
      const op = status === 'approved' ? 'modify' : 'remove';
      ids.push(
        await planWith(
          fx,
          op === 'modify'
            ? [{ op, workItemId: card, patch: { title: 'Z' } }]
            : [{ op, workItemId: card }],
          status,
        ),
      );
    }
    const page = await history(fx, card);
    expect(page.items.map((e) => [e.planId, e.planStatus])).toEqual(
      PLAN_STATUS_DTO_VALUES.map((s, i) => [ids[i], s]),
    );
  });

  it('the ARCHIVED arm — a `remove` reads as op remove', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seed(fx, 'to archive');
    const plan = await planWith(fx, [{ op: 'remove', workItemId: card }], 'approved');
    expect(brief(await history(fx, card))).toEqual([[plan, 'approved', 'remove', 0]]);
  });

  it('a plan that CHANGED the card and added three children under it is ONE row naming both', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seed(fx, 'reworked and expanded');
    const plan = await planWith(
      fx,
      [{ op: 'modify', workItemId: card, patch: { title: 'New' } }, ...children(card, 3)],
      'planned',
    );

    const page = await history(fx, card);
    expect(page.items).toHaveLength(1);
    const [entry] = page.items;
    expect(entry!.relation).toEqual({ op: 'modify', childCount: 3 });
    const items = await adminDb.planItem.findMany({
      where: { planId: plan },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const modify = items.find((i) => i.op === 'modify')!;
    expect(entry!.proposalIds.self).toBe(modify.id);
    expect([...entry!.proposalIds.children].sort()).toEqual(
      items
        .filter((i) => i.op === 'add')
        .map((i) => i.id)
        .sort(),
    );
  });

  it('a CHILD a plan created lists that plan as "created it"', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await seed(fx, 'the parent');
    const plan = await planWith(fx, children(parent, 2), 'approved');
    const child = await createdBy(plan, 'Child 1');

    expect(brief(await history(fx, parent))).toEqual([[plan, 'approved', null, 2]]);
    const childPage = await history(fx, child);
    expect(brief(childPage)).toEqual([[plan, 'approved', 'add', 0]]);
    expect(childPage.items[0]!.proposalIds.children).toEqual([]);
  });

  it('carries the author triple and the decider — name on a decided plan, null on an abandoned one', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seed(fx, 'attributed');
    const authored = await plansService.createPlan(
      fx.projectId,
      {
        title: 'Agent plan',
        authorSource: 'mcp',
        authorHarness: 'Claude Code',
        authorModel: 'claude-opus-5',
      },
      fx.ctx,
    );
    await stamp(authored.id);
    await plansService.addProposals(
      authored.id,
      [{ op: 'modify', workItemId: card, patch: { title: 'Q' } }],
      fx.ctx,
    );
    await plansService.markPlanned(authored.id, fx.ctx);
    await plansService.approvePlan(authored.id, fx.ctx);

    const abandoned = await planWith(
      fx,
      [{ op: 'remove', workItemId: card }],
      'generating',
      'Ended by the sweep',
    );
    await adminDb.plan.update({
      where: { id: abandoned },
      data: {
        status: 'declined',
        decidedAt: new Date(),
        decidedById: null,
        decisionReason: 'abandoned',
      },
    });
    const pending = await planWith(
      fx,
      [{ op: 'remove', workItemId: card }],
      'generating',
      'Undecided',
    );
    // Two `remove`s of one card in different plans are legal; only one plan may hold one per card.

    const [a, b, c] = (await history(fx, card)).items;
    expect(a).toMatchObject({
      planId: authored.id,
      author: { source: 'mcp', harness: 'Claude Code', model: 'claude-opus-5' },
      decidedById: fx.ownerId,
      decidedByName: fx.owner.name,
    });
    expect(a!.decidedAt).not.toBeNull();
    expect(a!.plannedAt).not.toBeNull();
    expect(b).toMatchObject({
      planId: abandoned,
      planStatus: 'declined',
      decidedById: null,
      decidedByName: null,
    });
    expect(c).toMatchObject({
      planId: pending,
      author: { source: null, harness: null, model: null },
      decidedAt: null,
      decidedById: null,
      decidedByName: null,
      plannedAt: null,
    });
  });

  it('PAGINATES BY PLAN — a plan with more child adds than the page size is never split', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seed(fx, 'a busy story');
    const big = await planWith(fx, children(card, 5), 'planned', 'Big');
    const second = await planWith(
      fx,
      [{ op: 'modify', workItemId: card, patch: { title: 'M' } }],
      'declined',
      'Second',
    );
    const third = await planWith(fx, [{ op: 'remove', workItemId: card }], 'generating', 'Third');

    const p1 = await history(fx, card, { limit: 1 });
    expect(brief(p1)).toEqual([[big, 'planned', null, 5]]);
    expect(p1.items[0]!.proposalIds.children).toHaveLength(5);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await history(fx, card, { limit: 1, cursor: p1.nextCursor });
    expect(brief(p2)).toEqual([[second, 'declined', 'modify', 0]]);

    const p3 = await history(fx, card, { limit: 1, cursor: p2.nextCursor });
    expect(brief(p3)).toEqual([[third, 'generating', 'remove', 0]]);
    expect(p3.nextCursor).toBeNull();

    // And a page of two holds the big plan whole beside the next one.
    const wide = await history(fx, card, { limit: 2 });
    expect(brief(wide)).toEqual([
      [big, 'planned', null, 5],
      [second, 'declined', 'modify', 0],
    ]);
    const rest = await history(fx, card, { limit: 2, cursor: wide.nextCursor });
    expect(rest.items.map((e) => e.planId)).toEqual([third]);
    expect(rest.nextCursor).toBeNull();
  });

  it('refuses a malformed cursor', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seed(fx, 'cursor');
    await expect(history(fx, card, { cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(
      InvalidPlanHistoryCursorError,
    );
  });

  it('an actor without `ai:view_plan` is refused by permission; a stranger to the project by not-found', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seed(fx, 'guarded');
    await planWith(fx, [{ op: 'remove', workItemId: card }], 'planned');

    const viewer = await viewerOf(fx);
    await expect(
      plansService.listPlanHistoryForWorkItem(fx.projectId, card, {}, viewer),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const elsewhere = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    await expect(
      plansService.listPlanHistoryForWorkItem(fx.projectId, card, {}, elsewhere.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('is scoped to the PROJECT — another project’s plans never surface under this one', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seed(fx, 'in project one');
    const mine = await planWith(fx, [{ op: 'remove', workItemId: card }], 'planned');
    const two = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'TWO',
    });
    // A plan in project TWO whose proposal names project one's card — unreachable
    // through `addProposals`, which validates the target, so written directly.
    const foreign = await adminDb.plan.create({
      data: { workspaceId: fx.workspaceId, projectId: two.id, status: 'planned', title: 'Foreign' },
    });
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId: foreign.id,
        op: 'modify',
        workItemId: card,
        patch: {},
      },
    });

    expect((await history(fx, card)).items.map((e) => e.planId)).toEqual([mine]);
    expect(await plansService.listPlanHistoryForWorkItem(two.id, seedlessId(), {}, fx.ctx)).toEqual(
      { items: [], nextCursor: null },
    );
  });

  it('KNOWN LIMITATION — a child laid under a `planItem:` temp-ref: the story reads "created it", child count 0', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Story and its subtasks' },
      fx.ctx,
    );
    await stamp(plan.id);
    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'New story', kind: 'story' } }],
      fx.ctx,
    );
    const storyItem = first.items.find((i) => i.proposedFields?.title === 'New story')!;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Its subtask', kind: 'subtask' },
          parentRef: `${TEMP_REF_PREFIX}${storyItem.id}`,
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);
    const story = await createdBy(plan.id, 'New story');

    // The plan is NOT lost — it arrives through the story's own `add` — but the
    // subtask's stored `parentRef` names the proposal, so it is not counted.
    expect(brief(await history(fx, story))).toEqual([[plan.id, 'approved', 'add', 0]]);
  });
});

/** An id no work item has, for reads that must return empty rather than throw. */
function seedlessId(): string {
  return 'cnoworkitem000000000000000';
}

describe('GET /api/work-items/[id]/plans', () => {
  it('200 — one page of the card’s history, oldest first', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seed(fx, 'via the route');
    const a = await planWith(
      fx,
      [{ op: 'modify', workItemId: card, patch: { title: 'R' } }],
      'declined',
    );
    const b = await planWith(fx, children(card, 2), 'planned');
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });

    const res = await call(card);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Awaited<ReturnType<typeof history>>;
    expect(brief(body)).toEqual([
      [a, 'declined', 'modify', 0],
      [b, 'planned', null, 2],
    ]);
    expect(body.nextCursor).toBeNull();

    const paged = await call(card, '?limit=1');
    const first = (await paged.json()) as Awaited<ReturnType<typeof history>>;
    expect(first.items.map((e) => e.planId)).toEqual([a]);
    const next = await call(card, `?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(
      ((await next.json()) as Awaited<ReturnType<typeof history>>).items.map((e) => e.planId),
    ).toEqual([b]);
  });

  it('200 with an empty page on a card no plan relates to; a nonsense limit is clamped, not refused', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seed(fx, 'quiet');
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });
    const res = await call(card, '?limit=abc');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
  });

  it('403 for a member without `ai:view_plan`', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seed(fx, 'viewer cannot');
    const viewer = await viewerOf(fx);
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: viewer });
    const res = await call(card);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ permission: 'ai:view_plan' });
  });

  it('404 for an unknown id and for another workspace’s item — the same answer', async () => {
    const fx = await makeWorkItemFixture();
    const elsewhere = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    const theirs = await seed(elsewhere, 'not yours');
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });

    const unknown = await call(seedlessId());
    const cross = await call(theirs);
    expect(unknown.status).toBe(404);
    expect(cross.status).toBe(404);
    expect((await cross.json()).code).toBe(new WorkItemNotFoundError('x').code);
  });

  it('400 for a malformed cursor', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seed(fx, 'bad cursor');
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });
    const res = await call(card, '?cursor=garbage');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_PLAN_HISTORY_CURSOR');
  });

  // MOTIR-5548 — the route's two remaining branches, measured by the story gate.
  it('answers the compliance gate’s own response when the session does not pass it', async () => {
    const refused = new Response(null, { status: 401 });
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: false, response: refused });
    const listed = vi.spyOn(plansService, 'listPlanHistoryByWorkItemId');
    expect(await call(seedlessId())).toBe(refused);
    expect(listed).not.toHaveBeenCalled();
    listed.mockRestore();
  });

  it('rethrows an error it has no status for — a 500, never a silent empty page', async () => {
    const fx = await makeWorkItemFixture();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });
    const listed = vi
      .spyOn(plansService, 'listPlanHistoryByWorkItemId')
      .mockRejectedValueOnce(new Error('boom'));
    await expect(call(seedlessId())).rejects.toThrow('boom');
    listed.mockRestore();
  });
});
