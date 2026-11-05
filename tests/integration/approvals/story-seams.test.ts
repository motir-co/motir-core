import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { resolvableGateSubject } from '../../helpers/resolvableGateSubject';
import { truncateAuthTables } from '../../helpers/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { homeService, type HomeActorContext } from '@/lib/services/homeService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectsService } from '@/lib/services/projectsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { ApprovalGateKind, ApprovalGateState } from '@/generated/prisma/client';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';

// The STORY-level seam tests for the APPROVALS TAB (Story MOTIR-4879 · Subtask
// MOTIR-5148), against the real Postgres and the shipped services. The subtask
// suites — `tests/approval-gate-awaiting-me.test.ts` for the read,
// `tests/components/workbench-approvals-list.test.tsx` for the row — cover each
// piece's own behaviour; this file covers the STORY's correctness claims at the
// seam between MOTIR-4791's read and MOTIR-4794's tab, and it inherits the
// stricter bar its sibling states:
//
//   ⚠️ NO ASSERTION HERE MAY PASS VACUOUSLY. An access test that passes because
//   the fixture happened to hold no inaccessible gate is worse than no test — it
//   is a green check certifying nothing. So every "must not appear" case is
//   paired with a POSITIVE CONTROL over the SAME fixture, and every count
//   assertion has a non-zero expected value.
//
// ⚠️ AND THE ACCESS FIXTURE IS BUILT SO THE READER'S VIEW AND THE TRUE
// POPULATION DIFFER BY CONSTRUCTION. This is the one property a test actor who
// can see everything destroys: with such an actor a scoped read and an unscoped
// one return the same number, both assertions pass, and neither means anything.
// Here the reader is routed FIVE gates and may browse the project holding only
// TWO of them, so `scoped < unscoped` is a real inequality rather than a
// tautology — and the two they CAN see are the positive control that keeps the
// negative honest.
//
// ⚠️ THE ROUTING NEGATIVE IS THE REASON THIS FILE EXISTS. ADR §2's
// `assigneeId ?? reporterId` and `homeService`'s assignee-OR-reporter union
// agree on every fixture where one person is both — which is most of them. They
// differ on exactly ONE shape: assigned to somebody else, reported by me. A
// suite without that row passes against the union, which is the implementation
// the ADR records itself refusing to be "fixed" back to.

let fx: WorkItemFixture;
let meCtx: HomeActorContext;
let otherId: string;
let storyId: string;

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "approval_gate", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
  fx = await makeWorkItemFixture();
  meCtx = { ...fx.ctx, projectId: fx.projectId };
  const other = await createTestUser({ email: 'other-seam@ex.com', name: 'Other' });
  await workspacesService.addMember({ userId: other.id, workspaceId: fx.workspaceId });
  otherId = other.id;
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'The Approvals tab' },
    fx.ctx,
  );
  storyId = story.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** One card carrying one gate, with the routing columns set EXACTLY. */
async function gate(opts: {
  title: string;
  assigneeId?: string | null;
  reporterId?: string;
  kind?: ApprovalGateKind;
  state?: ApprovalGateState;
  projectId?: string;
  parentId?: string;
  createdAt?: Date;
}) {
  const projectId = opts.projectId ?? fx.projectId;
  const item = await workItemsService.createWorkItem(
    { projectId, kind: 'subtask', parentId: opts.parentId ?? storyId, title: opts.title },
    fx.ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      assigneeId: opts.assigneeId ?? null,
      ...(opts.reporterId ? { reporterId: opts.reporterId } : {}),
    },
  });
  // A subject that RESOLVES — the queue withdraws a gate whose subject is gone (MOTIR-7146).
  const subjectId = await resolvableGateSubject(
    { workspaceId: fx.workspaceId, projectId },
    item.id,
    opts.kind ?? 'design_result',
  );
  const row = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId,
        workItemId: item.id,
        kind: opts.kind ?? 'design_result',
        subjectId,
      },
      tx,
    ),
  );
  if (opts.state && opts.state !== 'awaiting') {
    await adminDb.approvalGate.update({ where: { id: row.id }, data: { state: opts.state } });
  }
  if (opts.createdAt) {
    await adminDb.approvalGate.update({
      where: { id: row.id },
      data: { createdAt: opts.createdAt },
    });
  }
  return { item, gate: row };
}

/** The UNSCOPED population, read as the owner — the control every access
 *  assertion is measured against. */
async function unscopedAwaitingFor(userId: string): Promise<number> {
  return adminDb.approvalGate.count({
    where: {
      state: 'awaiting',
      workItem: { OR: [{ assigneeId: userId }, { assigneeId: null, reporterId: userId }] },
    },
  });
}

describe('CLAIM 1 · routing is `assigneeId ?? reporterId`, and the NEGATIVE case is the test', () => {
  it('pins all three shapes in ONE fixture: assigned-to-me, unassigned-reported-by-me, assigned-to-someone-else', async () => {
    const assignedToMe = await gate({ title: 'Assigned to me', assigneeId: meCtx.userId });
    const fallback = await gate({ title: 'Unassigned, filed by me', assigneeId: null });
    // ⚠️ THE ROW THAT SEPARATES THE TWO PREDICATES. The sibling tabs' union
    // returns it; ADR §2's fallback does not.
    const theirs = await gate({
      title: 'Theirs now',
      assigneeId: otherId,
      reporterId: meCtx.userId,
    });

    const mine = await approvalGatesService.listAwaitingMe(meCtx);
    const ids = mine.items.map((row) => row.gateId);

    // POSITIVE — both shapes the predicate admits.
    expect(ids).toContain(assignedToMe.gate.id);
    expect(ids).toContain(fallback.gate.id);
    // NEGATIVE — the shape it refuses.
    expect(ids).not.toContain(theirs.gate.id);
    expect(mine.total).toBe(2);

    // POSITIVE CONTROL for the negative: the row EXISTS and is routed — to the
    // person it is assigned to. It was excluded by the predicate, not absent
    // from the fixture.
    const theirQueue = await approvalGatesService.listAwaitingMe({
      userId: otherId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect(theirQueue.items.map((row) => row.gateId)).toEqual([theirs.gate.id]);
  });
});

describe('CLAIM 2 · access is enforced IN the query, over a population the reader cannot fully see', () => {
  it('returns STRICTLY FEWER rows than the true population, with a positive control in the same fixture', async () => {
    // A second project in the same workspace, which the reader will NOT be able
    // to browse — so their view and the true population differ by construction.
    const hiddenProject = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Hidden',
    });
    const hiddenStory = await workItemsService.createWorkItem(
      { projectId: hiddenProject.id, kind: 'story', title: 'Hidden story' },
      fx.ctx,
    );

    const reader = await createTestUser({ email: 'reader@ex.com', name: 'Reader' });
    await workspacesService.addMember({ userId: reader.id, workspaceId: fx.workspaceId });

    // TWO gates in the project they may browse …
    const visibleA = await gate({ title: 'Visible A', assigneeId: reader.id });
    const visibleB = await gate({ title: 'Visible B', assigneeId: reader.id });
    // … and THREE in the project they may not.
    for (let i = 0; i < 3; i += 1) {
      await gate({
        title: `Hidden ${i}`,
        assigneeId: reader.id,
        projectId: hiddenProject.id,
        parentId: hiddenStory.id,
      });
    }
    await projectMembersService.setAccessMode({
      key: hiddenProject.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    await adminDb.projectMembership.deleteMany({
      where: { userId: reader.id, projectId: hiddenProject.id },
    });

    // The TRUE population routed to this reader is five.
    expect(await unscopedAwaitingFor(reader.id)).toBe(5);

    const readerCtx: HomeActorContext = {
      userId: reader.id,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    };
    const scoped = await approvalGatesService.listAwaitingMe(readerCtx);

    // ⚠️ STRICTLY FEWER — the inequality is the assertion. A reader who could
    // see everything would make this line read `5 < 5` and fail.
    expect(scoped.total).toBeLessThan(5);
    // POSITIVE CONTROL: they genuinely see the two they may browse, so the
    // scoping is narrowing rather than emptying.
    expect(scoped.total).toBe(2);
    expect(scoped.items.map((row) => row.gateId).sort()).toEqual(
      [visibleA.gate.id, visibleB.gate.id].sort(),
    );
    expect(await approvalGatesService.countAwaitingMe(readerCtx)).toBe(2);

    // And pointed at the project they may NOT browse, the same reader with the
    // same three routed gates gets an empty page rather than an error.
    const atHidden = await approvalGatesService.listAwaitingMe({
      ...readerCtx,
      projectId: hiddenProject.id,
    });
    expect(atHidden).toEqual({ items: [], total: 0, truncated: false, reviewsToRun: [] });
  });
});

describe('CLAIM 3 · the COUNT and the LIST are one answer, not two', () => {
  it('agrees over one fixture — and still agrees after a gate is decided mid-test', async () => {
    for (let i = 0; i < 4; i += 1) {
      await gate({ title: `Mine ${i}`, assigneeId: meCtx.userId });
    }
    // Rows the pair must both exclude, each for a different reason.
    await gate({ title: 'Theirs', assigneeId: otherId, reporterId: meCtx.userId });
    await gate({ title: 'Already approved', assigneeId: meCtx.userId, state: 'approved' });

    const before = await approvalGatesService.listAwaitingMe(meCtx);
    expect(before.total).toBe(4);
    expect(await approvalGatesService.countAwaitingMe(meCtx)).toBe(before.total);
    // The STRIP reads the same number through `tabCounts`, which is the seam the
    // tab actually consumes.
    expect((await homeService.tabCounts(meCtx)).approvals).toBe(4);

    // Decide one, the way the tab does.
    const toDecide = before.items[0]!;
    await adminDb.approvalGate.update({
      where: { id: toDecide.gateId },
      data: { state: 'changes_requested' },
    });

    const after = await approvalGatesService.listAwaitingMe(meCtx);
    expect(after.total).toBe(3);
    expect(await approvalGatesService.countAwaitingMe(meCtx)).toBe(after.total);
    expect((await homeService.tabCounts(meCtx)).approvals).toBe(3);
    expect(after.items.map((r) => r.gateId)).not.toContain(toDecide.gateId);
  });

  it('never returns a decided or withdrawn gate — all three terminal states in one fixture', async () => {
    const live = await gate({ title: 'Live', assigneeId: meCtx.userId });
    for (const state of ['approved', 'changes_requested', 'superseded'] as const) {
      await gate({ title: `Already ${state}`, assigneeId: meCtx.userId, state });
    }

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    // POSITIVE CONTROL: the awaiting one IS returned, so the filter is selecting
    // rather than emptying.
    expect(page.items.map((r) => r.gateId)).toEqual([live.gate.id]);
    expect(page.items[0]!.state).toBe('awaiting');
    // And the fixture really did hold four.
    expect(await adminDb.approvalGate.count()).toBe(4);
  });
});

describe('CLAIM 4 · the tab reads the WHOLE set — no page — under a ceiling it SAYS (MOTIR-5998)', () => {
  it('reads every gate once — no repeats, no drops, an honest total', async () => {
    for (let i = 0; i < 7; i += 1) {
      await gate({
        title: `Waiting ${i}`,
        assigneeId: meCtx.userId,
        createdAt: new Date(Date.UTC(2026, 8, i + 1)),
      });
    }

    const queue = await approvalGatesService.listAwaitingMe(meCtx);

    const seen = queue.items.map((r) => r.gateId);
    // NO DROPS — every gate in the set appears exactly once …
    expect(seen).toHaveLength(7);
    // … and NO REPEATS.
    expect(new Set(seen).size).toBe(7);
    expect(queue).toMatchObject({ total: 7, truncated: false });
  });

  it('a ceiling below the set keeps the OLDEST and reports the whole total', async () => {
    const created: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const made = await gate({
        title: `Waiting ${i}`,
        assigneeId: meCtx.userId,
        createdAt: new Date(Date.UTC(2026, 8, i + 1)),
      });
      created.push(made.gate.id);
    }

    const cut = await approvalGatesService.listAwaitingMe(meCtx, { ceiling: 3 });

    // The oldest-waiting come first, so the cut drops the NEWEST — the question
    // that has waited least is the one a reader loses to the ceiling.
    expect(cut.items.map((r) => r.gateId)).toEqual(created.slice(0, 3));
    expect(cut).toMatchObject({ total: 4, truncated: true });
  });

  it('orders oldest-waiting first, against `createdAt` values set EXPLICITLY', async () => {
    // Inserted newest-first, so insertion order cannot produce a passing result.
    const newest = await gate({
      title: 'Newest',
      assigneeId: meCtx.userId,
      createdAt: new Date('2026-09-10T00:00:00Z'),
    });
    const middle = await gate({
      title: 'Middle',
      assigneeId: meCtx.userId,
      createdAt: new Date('2026-09-05T00:00:00Z'),
    });
    const oldest = await gate({
      title: 'Oldest',
      assigneeId: meCtx.userId,
      createdAt: new Date('2026-09-01T00:00:00Z'),
    });

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    expect(page.items.map((r) => r.gateId)).toEqual([
      oldest.gate.id,
      middle.gate.id,
      newest.gate.id,
    ]);
  });
});

describe('THE BOUNDARY · a kind this build registers no handler for', () => {
  it('is RETURNED and marked as unregistered rather than throwing or being dropped', async () => {
    const registered = await gate({ title: 'A design', assigneeId: meCtx.userId });
    const unregistered = await gate({
      title: 'An approval',
      assigneeId: meCtx.userId,
      // The one declared hole left — RETIRED by MOTIR-5616. (`decision_approval` stood
      // here until MOTIR-5676 registered it.)
      kind: 'pull_request_merge',
    });

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    // NOT DROPPED — the fixture's two gates are both in the answer.
    expect(page.total).toBe(2);
    const ids = page.items.map((r) => r.gateId);
    expect(ids).toContain(registered.gate.id);
    expect(ids).toContain(unregistered.gate.id);

    // MARKED — the row says the kind rather than pretending it has a subject.
    const row = page.items.find((r) => r.gateId === unregistered.gate.id)!;
    expect(row.subject).toEqual({ kind: 'pull_request_merge' });
    // POSITIVE CONTROL: the registered kind's arm is genuinely different, so the
    // assertion above is not just "everything is unregistered".
    const designRow = page.items.find((r) => r.gateId === registered.gate.id)!;
    expect(designRow.subject).toMatchObject({ kind: 'design_result' });
    expect(designRow.kind).toBe('design_result');
  });
});
