import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  PLAN_STATUS_DTO_VALUES,
  WORK_ITEM_PENDING_PLAN_SILENT_STATUSES,
  WORK_ITEM_PENDING_PLAN_STATUSES,
} from '@/lib/dto/plans';
import { AI_PENDING_PLAN_STATUSES } from '@/lib/dto/ai';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

/**
 * Drop the target locks an UN-DECIDED plan holds, so a fixture can build a
 * SECOND open plan over the same card (MOTIR-5645).
 *
 * ⚠️ FIXTURE SURGERY, and it records a real consequence rather than dodging a
 * defect. A plan PARKS every committed target it names and holds it while the
 * plan is open, so a tenant can have at most ONE open plan per card — a second
 * is refused with `PlanTargetLockedError` (AMENDMENT 16 D4). The cases here need
 * several open plans over one card, which no tenant can now produce.
 *
 * The lock's own behaviour, including that refusal, is covered in
 * `tests/planning/planTargetParkDoor.test.ts`.
 */
async function freePlanTargets(planId: string): Promise<string> {
  await adminDb.planTargetLock.deleteMany({ where: { planId } });
  return planId;
}

// The work-item page's PENDING-PLAN read (bug MOTIR-4197 · design MOTIR-4256
// §3 / §5) over real Postgres — `plansService.listPendingProposalsForWorkItem`.
//
// ⚠️ THE ARMS THAT MATTER ARE THE SILENT ONES. A read that returns the
// `planned` plan naming a card is easy to get right and easy to over-return:
// every positive case below passes on a read that lists every proposal that
// ever named the card. Only the `generating` / `approved` / `declined` arms —
// and the sibling card that shares the plan — can fail on it. MOTIR-4197 AC 5
// names those two negatives outright, beside the empty one.
//
// ⚠️ WIDENED by bug MOTIR-4365 · design MOTIR-4364 AMENDMENT A: the read now has
// a SECOND arm — the `add`s whose `parentRef` names this card — and returns ONE
// ROW PER PLAN rather than one per proposal. The `modify` / `remove` BEHAVIOUR
// below is unchanged, which is why every case is kept verbatim; what changed is
// that each whole-object literal carries `childCount: 0`, because the field is
// required and these cases propose no children. Behaviour unchanged, assertion
// literals necessarily not — the amendment says exactly that under GIVES/TAKES.

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

async function seed(fx: WorkItemFixture, title: string): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return dto.id;
}

type Status = (typeof PLAN_STATUS_DTO_VALUES)[number];

/** A plan in `status` carrying ONE proposal of `op` naming `target`, driven
 *  through the real service as far as the service goes. `stale` has no service
 *  path of its own — it is written by the drift guard — so it is set directly,
 *  exactly as `planDrift.test.ts` and `pendingPlansRoute.test.ts` set it. */
async function planNaming(
  fx: WorkItemFixture,
  target: string,
  op: 'modify' | 'remove',
  status: Status,
  title: string | null = 'Rework',
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, title === null ? {} : { title }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [
      op === 'modify'
        ? { op, workItemId: target, patch: { title: 'New' } }
        : { op, workItemId: target },
    ],
    fx.ctx,
  );
  if (status === 'generating') return freePlanTargets(plan.id);
  await plansService.markPlanned(plan.id, fx.ctx);
  if (status === 'planned') return freePlanTargets(plan.id);
  if (status === 'stale') {
    await adminDb.plan.update({ where: { id: plan.id }, data: { status: 'stale' } });
    return freePlanTargets(plan.id);
  }
  // A DECIDED plan releases its own targets.
  if (status === 'approved') await plansService.approvePlan(plan.id, fx.ctx);
  else await plansService.declinePlan(plan.id, fx.ctx);
  return plan.id;
}

/** A plan in `status` carrying `children` × `add` parented on `target`, and
 *  optionally ALSO a `modify` / `remove` of `target` itself — the MIXED claim
 *  the unique constraint permits (one targeting op, N null-target `add`s). */
async function planUnder(
  fx: WorkItemFixture,
  target: string,
  children: number,
  status: Status,
  also: 'modify' | 'remove' | null = null,
  title: string | null = 'Expand it',
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, title === null ? {} : { title }, fx.ctx);
  const proposals: Parameters<typeof plansService.addProposals>[1] = [];
  if (also === 'modify')
    proposals.push({ op: 'modify', workItemId: target, patch: { title: 'New' } });
  if (also === 'remove') proposals.push({ op: 'remove', workItemId: target });
  for (let i = 0; i < children; i += 1) {
    proposals.push({
      op: 'add',
      proposedFields: { title: `Child ${i + 1}`, kind: 'subtask' },
      parentRef: target,
    });
  }
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  if (status === 'generating') return freePlanTargets(plan.id);
  await plansService.markPlanned(plan.id, fx.ctx);
  if (status === 'planned') return freePlanTargets(plan.id);
  if (status === 'stale') {
    await adminDb.plan.update({ where: { id: plan.id }, data: { status: 'stale' } });
    return freePlanTargets(plan.id);
  }
  // A DECIDED plan releases its own targets.
  if (status === 'approved') await plansService.approvePlan(plan.id, fx.ctx);
  else await plansService.declinePlan(plan.id, fx.ctx);
  return plan.id;
}

const read = (fx: WorkItemFixture, target: string) =>
  plansService.listPendingProposalsForWorkItem(fx.projectId, target, fx.ctx);

describe('the status set is TOTAL over PlanStatus, and is NOT the boundary’s', () => {
  it('announced ∪ silent is exactly PlanStatus, and the two are disjoint', () => {
    const announced = new Set<string>(WORK_ITEM_PENDING_PLAN_STATUSES);
    const silent = new Set<string>(WORK_ITEM_PENDING_PLAN_SILENT_STATUSES);
    expect([...announced].filter((s) => silent.has(s))).toEqual([]);
    expect([...PLAN_STATUS_DTO_VALUES].sort()).toEqual([...announced, ...silent].sort());
  });

  it('differs from AI_PENDING_PLAN_STATUSES on exactly `generating` and `approving`', () => {
    // The boundary asks "is a run in flight for this PROJECT?" and admits
    // `generating`; the item page asks "is a decision pending about THIS card?"
    // and does not. Reusing the one for the other is the mistake the constant
    // exists to prevent, and this pins the difference so a future edit that
    // makes them equal is a red test rather than a silent widening.
    const boundary = new Set<string>(AI_PENDING_PLAN_STATUSES);
    const page = new Set<string>(WORK_ITEM_PENDING_PLAN_STATUSES);
    // `approving` (Bug MOTIR-9006) too: its proposals are still work in flight for a
    // planner, but the decision about the card is already made.
    expect([...boundary].filter((s) => !page.has(s))).toEqual(['generating', 'approving']);
    expect([...page].filter((s) => !boundary.has(s))).toEqual([]);
  });
});

describe('plansService.listPendingProposalsForWorkItem', () => {
  it('the EMPTY case — a card no plan names reads []', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'nobody proposes anything');
    expect(await read(fx, target)).toEqual([]);
  });

  it('a `planned` plan proposing a MODIFY is announced, with its id, title and op', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'about to be renamed');
    const planId = await planNaming(fx, target, 'modify', 'planned', 'Epic 8 sweep');

    expect(await read(fx, target)).toEqual([
      { planId, planTitle: 'Epic 8 sweep', planStatus: 'planned', op: 'modify', childCount: 0 },
    ]);
  });

  it('a `planned` plan proposing a REMOVE is announced as a remove — a different sentence', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'about to be archived');
    const planId = await planNaming(fx, target, 'remove', 'planned');

    const rows = await read(fx, target);
    expect(rows.map((r) => [r.planId, r.op])).toEqual([[planId, 'remove']]);
  });

  it('a `stale` plan is announced too, for both ops — it is undecided by construction', async () => {
    const fx = await makeWorkItemFixture();
    const modified = await seed(fx, 'stale modify');
    const removed = await seed(fx, 'stale remove');
    const a = await planNaming(fx, modified, 'modify', 'stale');
    const b = await planNaming(fx, removed, 'remove', 'stale');

    expect((await read(fx, modified)).map((r) => [r.planId, r.planStatus, r.op])).toEqual([
      [a, 'stale', 'modify'],
    ]);
    expect((await read(fx, removed)).map((r) => [r.planId, r.planStatus, r.op])).toEqual([
      [b, 'stale', 'remove'],
    ]);
  });

  it('a `generating` plan is SILENT — the claim is not finished being made', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'still being written about');
    await planNaming(fx, target, 'modify', 'generating');
    expect(await read(fx, target)).toEqual([]);
  });

  it('a DECIDED plan is silent — `declined` (history) and `approved` (the tree now)', async () => {
    const fx = await makeWorkItemFixture();
    const declinedTarget = await seed(fx, 'a plan was declined about me');
    await planNaming(fx, declinedTarget, 'modify', 'declined');
    expect(await read(fx, declinedTarget)).toEqual([]);

    // Approving a `modify` writes the patch onto the SAME id (the card survives),
    // so the read is asked of the very card the plan changed — and still says
    // nothing, because there is no future left to announce.
    const approvedTarget = await seed(fx, 'a plan was approved about me');
    await planNaming(fx, approvedTarget, 'modify', 'approved');
    expect(await read(fx, approvedTarget)).toEqual([]);
  });

  it('returns ONE row per plan, in plan-creation order, and a null title as null', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'named by three plans');
    const first = await planNaming(fx, target, 'modify', 'planned', 'First');
    const second = await planNaming(fx, target, 'remove', 'stale', 'Second');
    const third = await planNaming(fx, target, 'modify', 'planned', null);
    // A decided sibling in the middle of the same set is not a row.
    await planNaming(fx, target, 'modify', 'declined', 'Declined');

    expect(await read(fx, target)).toEqual([
      { planId: first, planTitle: 'First', planStatus: 'planned', op: 'modify', childCount: 0 },
      { planId: second, planTitle: 'Second', planStatus: 'stale', op: 'remove', childCount: 0 },
      { planId: third, planTitle: null, planStatus: 'planned', op: 'modify', childCount: 0 },
    ]);
  });

  it('a proposal naming a SIBLING card is not this card’s', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'me');
    const sibling = await seed(fx, 'my sibling');
    await planNaming(fx, sibling, 'modify', 'planned');

    expect(await read(fx, target)).toEqual([]);
    expect((await read(fx, sibling)).map((r) => r.op)).toEqual(['modify']);
  });

  it('is browse-gated — a stranger to the project is refused, not handed []', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'private');
    await planNaming(fx, target, 'modify', 'planned');
    const other = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });

    // A stranger from ANOTHER workspace meets the no-existence-leak shape: the
    // project is `NotFound` to them, not `AccessDenied` — the same refusal every
    // browse-gated plan read gives, and the one the item page turns into a 404.
    // Either way the read never reaches the repository and never hands back
    // an empty list a caller could mistake for "no pending plan".
    await expect(
      plansService.listPendingProposalsForWorkItem(fx.projectId, target, other.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

// ── The `add` ARM (bug MOTIR-4365 · design MOTIR-4364 AMENDMENT A) ────────────
//
// The defect this covers is not a filter chosen too narrowly. An `add` has NO
// `workItemId` — the row it would name does not exist until the plan is
// approved — so it names its parent in `parentRef`, and widening the `op` list
// alone would have returned nothing. Every case below fails on the shipped read.

type ModelOp = string;

/**
 * Record the MODEL operations a call performs inside its own transaction.
 *
 * `withWorkspaceServiceContext` opens `db.$transaction(cb)` and hands `cb` the
 * transaction client, so wrapping THAT client is where the operations are
 * visible — a Prisma client extension would produce a different client the
 * service never reaches. This is what makes AC 3's query count ASSERTED rather
 * than assumed, and it is the assertion that can actually fail: an EXPLAIN on a
 * ten-row test table proves nothing, because Postgres prefers a sequential scan
 * on a tiny table whatever indexes exist (the same reason `quick-search.test.ts`
 * leaves its index check to the large-seed recipe).
 */
async function recordModelOps<T>(run: () => Promise<T>): Promise<{ result: T; ops: ModelOp[] }> {
  const ops: ModelOp[] = [];
  const passthrough = db.$transaction.bind(db) as (
    arg: unknown,
    options?: unknown,
  ) => Promise<unknown>;

  const record = (tx: Prisma.TransactionClient): Prisma.TransactionClient =>
    new Proxy(tx as object, {
      get(client, key) {
        const value = Reflect.get(client, key) as unknown;
        // Only a MODEL delegate is wrapped: `$executeRaw` (the `set_config` the
        // context binds) and the symbols Prisma hangs off the client are not
        // queries this assertion is about.
        if (typeof key !== 'string' || key.startsWith('$') || typeof value !== 'object' || !value) {
          return value;
        }
        return new Proxy(value, {
          get(delegate, method) {
            const fn = Reflect.get(delegate, method) as unknown;
            if (typeof method !== 'string' || typeof fn !== 'function') return fn;
            return (...args: unknown[]) => {
              ops.push(`${key}.${method}`);
              return (fn as (...a: unknown[]) => unknown).apply(delegate, args);
            };
          },
        });
      },
    }) as Prisma.TransactionClient;

  const spy = vi
    .spyOn(db, '$transaction')
    .mockImplementation(((arg: unknown, options?: unknown) =>
      typeof arg === 'function'
        ? passthrough(
            (tx: Prisma.TransactionClient) =>
              (arg as (t: Prisma.TransactionClient) => Promise<unknown>)(record(tx)),
            options,
          )
        : passthrough(arg, options)) as unknown as typeof db.$transaction);

  try {
    return { result: await run(), ops };
  } finally {
    spy.mockRestore();
  }
}

describe('the `add` arm — a plan that proposes CHILDREN under this card', () => {
  it('AC 1 — a `planned` plan whose `add`s are parented HERE is announced, with the child count', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'about to gain a subtree');
    const planId = await planUnder(fx, target, 8, 'planned', null, 'Expand MOTIR-4330');

    // ONE row for ONE plan — eight `add` rows, one claim.
    expect(await read(fx, target)).toEqual([
      {
        planId,
        planTitle: 'Expand MOTIR-4330',
        planStatus: 'planned',
        op: null,
        childCount: 8,
      },
    ]);
  });

  it('AC 1 — the arm matches the RESOLVED id, so an `add` under a SIBLING leaves this card silent', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'me');
    const sibling = await seed(fx, 'my sibling');
    const planId = await planUnder(fx, sibling, 3, 'planned');

    expect(await read(fx, target)).toEqual([]);
    expect((await read(fx, sibling)).map((r) => [r.planId, r.op, r.childCount])).toEqual([
      [planId, null, 3],
    ]);
  });

  it('AC 1 — an intra-plan `planItem:` parent names a PROPOSAL, not this card', async () => {
    // The `add` whose parent is another `add` in the same plan is a grandchild
    // of this card and is correctly NOT its claim: the card gains ONE child, not
    // two. This is the case that would break a fix matching `parentRef` loosely.
    const fx = await makeWorkItemFixture();
    // An EPIC, so the two proposed levels are grammatical (epic → story →
    // subtask) — the kind matrix is not what this case is about.
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'gains exactly one child' },
      fx.ctx,
    );
    const target = epic.id;
    const plan = await plansService.createPlan(fx.projectId, { title: 'Two levels' }, fx.ctx);
    const afterFirst = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'The child', kind: 'story' }, parentRef: target }],
      fx.ctx,
    );
    const child = afterFirst.items.find((i) => i.parentRef === target);
    expect(child).toBeDefined();
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'The grandchild', kind: 'subtask' },
          parentRef: `planItem:${child!.id}`,
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    expect((await read(fx, target)).map((r) => r.childCount)).toEqual([1]);
  });

  it('AC 7 / AC 8 — a plan holding BOTH a `modify` of this card and `add`s under it is ONE row', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'changed and expanded at once');
    const planId = await planUnder(fx, target, 2, 'planned', 'modify', 'Rework and expand');

    // The mixed claim the unique constraint permits: one targeting op, N
    // null-target `add`s. It does NOT dissolve into a list — it is one plan.
    expect(await read(fx, target)).toEqual([
      {
        planId,
        planTitle: 'Rework and expand',
        planStatus: 'planned',
        op: 'modify',
        childCount: 2,
      },
    ]);
  });

  it('AC 7 / AC 8 — `remove` + `add` is expressible, and it is reported rather than tidied away', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'archived while gaining work');
    const planId = await planUnder(fx, target, 3, 'stale', 'remove', null);

    expect(await read(fx, target)).toEqual([
      { planId, planTitle: null, planStatus: 'stale', op: 'remove', childCount: 3 },
    ]);
  });

  it('AC 7 / AC 8 — ACROSS plans: one row each, in plan-creation order, and the count counts PLANS', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'named by three plans of different kinds');
    const expand = await planUnder(fx, target, 8, 'planned', null, 'Expand into subtasks');
    const sweep = await planUnder(fx, target, 2, 'planned', 'modify', 'Epic 8 sweep');
    const cancel = await planNaming(fx, target, 'remove', 'planned', 'Cancel 8.6');

    const rows = await read(fx, target);
    // THREE rows for eleven proposals — the accident `@@unique([planId,
    // workItemId])` used to guarantee, now performed deliberately. A component
    // counting rows would have said "11 pending plans name this item".
    expect(rows).toEqual([
      {
        planId: expand,
        planTitle: 'Expand into subtasks',
        planStatus: 'planned',
        op: null,
        childCount: 8,
      },
      {
        planId: sweep,
        planTitle: 'Epic 8 sweep',
        planStatus: 'planned',
        op: 'modify',
        childCount: 2,
      },
      {
        planId: cancel,
        planTitle: 'Cancel 8.6',
        planStatus: 'planned',
        op: 'remove',
        childCount: 0,
      },
    ]);
    expect(rows).toHaveLength(3);
  });

  it('the silent statuses are silent for the new arm TOO — `generating`, `approved`, `declined`', async () => {
    const fx = await makeWorkItemFixture();
    const generating = await seed(fx, 'still being written');
    await planUnder(fx, generating, 4, 'generating');
    expect(await read(fx, generating)).toEqual([]);

    const declined = await seed(fx, 'an expansion was declined');
    await planUnder(fx, declined, 4, 'declined');
    expect(await read(fx, declined)).toEqual([]);

    // Approving materializes the `add`s into real children, so the read is asked
    // of the card that now HAS them — and says nothing, because there is no
    // future left to announce.
    const approved = await seed(fx, 'an expansion was approved');
    await planUnder(fx, approved, 4, 'approved');
    expect(await read(fx, approved)).toEqual([]);
  });

  it('AC 3 / AC 4 — ONE query for the no-pending-plan card, and ONE for a plan with eight `add`s', async () => {
    const fx = await makeWorkItemFixture();
    const quiet = await seed(fx, 'nobody proposes anything');
    const busy = await seed(fx, 'eight children proposed');
    await planUnder(fx, busy, 8, 'planned');

    // The path this read runs on for nearly every item page.
    const empty = await recordModelOps(() => read(fx, quiet));
    expect(empty.result).toEqual([]);
    expect(empty.ops.filter((o) => o.startsWith('planItem.'))).toEqual(['planItem.findMany']);
    expect(empty.ops.filter((o) => o.startsWith('plan.'))).toEqual([]);

    // And the per-plan collapse is an in-memory fold, not a second query: eight
    // proposal rows still cost exactly one lookup, with the plan's id / title /
    // status riding back on it.
    const loaded = await recordModelOps(() => read(fx, busy));
    expect(loaded.result.map((r) => r.childCount)).toEqual([8]);
    expect(loaded.ops.filter((o) => o.startsWith('planItem.'))).toEqual(['planItem.findMany']);
    expect(loaded.ops.filter((o) => o.startsWith('plan.'))).toEqual([]);
  });

  // AC 6 has TWO halves and they live in two files. The PAGE half — no
  // `ai:view_plan` ⇒ NO READ AT ALL and `pendingPlans === null` — is above the
  // repository and therefore arm-independent by construction; it is guarded by
  // `tests/components/item-detail-reads.test.tsx`, which asserts the read is
  // never called. This is the SERVICE half, and it is the one the new arm could
  // have widened: a second `OR` branch reaching rows the browse gate does not.
  it('is browse-gated on the new arm too — a stranger is refused, not handed []', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'private expansion');
    await planUnder(fx, target, 5, 'planned');
    const other = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });

    await expect(
      plansService.listPendingProposalsForWorkItem(fx.projectId, target, other.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
