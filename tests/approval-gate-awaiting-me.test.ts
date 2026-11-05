import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { APPROVAL_QUEUE_CEILING, approvalGatesService } from '@/lib/services/approvalGatesService';
import { homeService } from '@/lib/services/homeService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { designEvidenceRepository } from '@/lib/repositories/designEvidenceRepository';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import type { HomeActorContext } from '@/lib/services/homeService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE ROUTING READ (Story MOTIR-4879 · Subtask MOTIR-4791) — what the
// Workbench's *To approve* tab asks, against a REAL Postgres.
//
// Four things here are load-bearing, and each exists because it fails QUIETLY:
//
//   · THE PREDICATE'S NEGATIVE CASE. `assigneeId ?? reporterId` and
//     `homeService`'s assignee-OR-reporter union return THE SAME ROWS on every
//     card where one person is both — which is most cards, because an item filed
//     through the MCP carries its creator as reporter and that same person runs
//     it. They differ on exactly one shape: assigned to somebody ELSE, reported
//     by ME. A suite without that fixture passes against the union, which is the
//     implementation ADR §2 records itself to stop.
//   · AN ACCESS FIXTURE WHOSE VIEW AND POPULATION DIFFER. With an actor who can
//     see everything, a scoped read and an unscoped one return the same number
//     and the assertion proves nothing. So the reader here is a plain workspace
//     member on a PRIVATE project, with gates genuinely routed to them inside
//     it: the true population is 2 and the honest answer is 0.
//   · COUNT vs LIST, over one fixture. The strip's badge and the tab's rows are
//     two reads of one question, and a badge saying `3` above a list of two is
//     what a second copy of the predicate looks like from the reader's side.
//   · THE PAGER AT A BOUNDARY. A page past the end CLAMPS to the last page
//     rather than returning an empty window (`homeService.windowFor`), and the
//     only way to assert that is to drive a second page rather than the first.

let fx: WorkItemFixture;
/** The reader — the fixture's owner, who is also an admin on its project. */
let meCtx: HomeActorContext;
/** Somebody else in the same workspace, to sit on the other side of a card. */
let otherId: string;
/** A story for the subtasks to hang under (`lib/issues/parentRules.ts`). */
let storyId: string;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "design_evidence" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  meCtx = { ...fx.ctx, projectId: fx.projectId };
  const other = await createTestUser({ email: 'other@ex.com', name: 'Other' });
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

/**
 * One card carrying one gate, with the routing columns set EXACTLY.
 *
 * `assigneeId` / `reporterId` are written at the data layer rather than through
 * the service, because the point of every fixture here is the PAIR — and the
 * create path can only ever make the actor both.
 */
async function gateOn(opts: {
  title: string;
  assigneeId?: string | null;
  reporterId?: string;
  kind?: ApprovalGateKind;
  subjectId?: string;
  projectId?: string;
  workspaceId?: string;
  ctx?: { userId: string; workspaceId: string };
  createdAt?: Date;
}) {
  const ctx = opts.ctx ?? fx.ctx;
  const projectId = opts.projectId ?? fx.projectId;
  const item = await workItemsService.createWorkItem(
    { projectId, kind: 'subtask', parentId: storyId, title: opts.title },
    ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      assigneeId: opts.assigneeId ?? null,
      ...(opts.reporterId ? { reporterId: opts.reporterId } : {}),
    },
  });
  const kind = opts.kind ?? 'design_result';
  // A design gate's subject must RESOLVE unless the test names its own: a gate whose
  // subject is gone is withdrawn by the read that lists it (MOTIR-7146), so a made-up
  // id would take the row out of the very queue under test.
  const subjectId =
    opts.subjectId ??
    (kind === 'design_result'
      ? (
          await adminDb.designEvidence.create({
            // Not CURRENT: the subject is read by id, and a test that publishes the card's
            // own current evidence must not collide with this one.
            data: {
              workspaceId: opts.workspaceId ?? fx.workspaceId,
              workItemId: item.id,
              isCurrent: false,
            },
          })
        ).id
      : `evidence-${item.id}`);
  const gate = await withWorkspaceContext(ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: opts.workspaceId ?? fx.workspaceId,
        projectId,
        workItemId: item.id,
        kind,
        subjectId,
      },
      tx,
    ),
  );
  if (opts.createdAt) {
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: { createdAt: opts.createdAt },
    });
  }
  return { item, gate };
}

/** A design result the summary loader can actually resolve. */
async function designEvidence(opts: {
  id: string;
  workItemId: string;
  producedByKey?: string | null;
  commitSha?: string | null;
  noteMd?: string | null;
  assets?: number;
}) {
  await adminDb.designEvidence.create({
    data: {
      id: opts.id,
      workspaceId: fx.workspaceId,
      workItemId: opts.workItemId,
      producedByKey: opts.producedByKey ?? null,
      commitSha: opts.commitSha ?? null,
      noteMd: opts.noteMd ?? null,
    },
  });
  for (let i = 0; i < (opts.assets ?? 0); i += 1) {
    await adminDb.designAsset.create({
      data: {
        workspaceId: fx.workspaceId,
        designEvidenceId: opts.id,
        kind: 'mock',
        sourcePath: `design/workbench/panel-${i}.mock.html`,
        position: i,
      },
    });
  }
}

describe('approvalGatesService.listAwaitingMe — the routing predicate', () => {
  it('returns the gates routed to me: assigned to me, and unassigned-but-reported-by-me', async () => {
    const mine = await gateOn({ title: 'Assigned to me', assigneeId: meCtx.userId });
    const fallback = await gateOn({ title: 'Unassigned, filed by me', assigneeId: null });

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    expect(page.items.map((row) => row.gateId).sort()).toEqual(
      [mine.gate.id, fallback.gate.id].sort(),
    );
  });

  it('does NOT return an item assigned to somebody ELSE and reported by me — the case that distinguishes this predicate from the sibling tabs’ union', async () => {
    // ⚠️ THE ASSERTION THE WHOLE CARD TURNS ON. `homeService`'s
    // assignee-OR-reporter union returns this row; ADR §2's fallback does not,
    // because a gate shown to two people is a decision neither owns. Every other
    // fixture in this file passes under BOTH predicates.
    await gateOn({ title: 'Theirs now', assigneeId: otherId, reporterId: meCtx.userId });

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    // And the same row IS routed to the person it is assigned to — the gate has
    // not vanished, it has one owner.
    const theirs = await approvalGatesService.listAwaitingMe({
      userId: otherId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect(theirs.total).toBe(1);
  });

  it('does not return a gate on a card that is nothing to do with me', async () => {
    await gateOn({ title: 'Theirs entirely', assigneeId: otherId, reporterId: otherId });

    expect((await approvalGatesService.listAwaitingMe(meCtx)).items).toEqual([]);
  });

  it('orders oldest-waiting first — a queue is about what has been waiting', async () => {
    const newer = await gateOn({
      title: 'Newer',
      assigneeId: meCtx.userId,
      createdAt: new Date('2026-09-10T10:00:00Z'),
    });
    const older = await gateOn({
      title: 'Older',
      assigneeId: meCtx.userId,
      createdAt: new Date('2026-09-01T10:00:00Z'),
    });

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    expect(page.items.map((row) => row.gateId)).toEqual([older.gate.id, newer.gate.id]);
    expect(page.items[0]!.waitingSince).toBe('2026-09-01T10:00:00.000Z');
  });

  it('returns only AWAITING gates — a decided or withdrawn one is not something anybody is waiting on', async () => {
    const awaiting = await gateOn({ title: 'Live', assigneeId: meCtx.userId });
    for (const state of ['approved', 'changes_requested', 'superseded'] as const) {
      const decided = await gateOn({ title: `Already ${state}`, assigneeId: meCtx.userId });
      await adminDb.approvalGate.update({ where: { id: decided.gate.id }, data: { state } });
    }

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    expect(page.items.map((row) => row.gateId)).toEqual([awaiting.gate.id]);
    expect(page.items[0]!.state).toBe('awaiting');
  });
});

describe('approvalGatesService.listAwaitingMe — access, enforced IN the query', () => {
  it('returns an empty page to a reader who may not browse their own active project — while the true population is NOT empty', async () => {
    // ⚠️ THE FIXTURE'S VIEW AND THE TRUE POPULATION DIFFER, which is the only
    // way this assertion can distinguish a scoped read from an unscoped one. The
    // stranger is a plain workspace MEMBER — RLS admits them — with two gates
    // genuinely routed to them inside a PRIVATE project they hold no role on.
    const stranger = await createTestUser({ email: 'stranger@ex.com', name: 'Stranger' });
    await workspacesService.addMember({ userId: stranger.id, workspaceId: fx.workspaceId });
    await gateOn({ title: 'Routed to the stranger A', assigneeId: stranger.id });
    await gateOn({ title: 'Routed to the stranger B', assigneeId: stranger.id });
    await projectMembersService.setAccessMode({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    // ⚠️ AND THEIR PROJECT MEMBERSHIP IS REVOKED — joining a workspace enrols a
    // user in its projects, so a workspace member is a project member until
    // somebody removes them. That REVOCATION is the exact state the service's
    // scope resolver is written for: *"an actor's ACTIVE project can be one they
    // may not browse, because the pointer is a stored preference and project
    // membership can be revoked under it."* Without this line the fixture asserts
    // nothing — the reader can browse, and a scoped read and an unscoped one
    // agree.
    await adminDb.projectMembership.deleteMany({
      where: { userId: stranger.id, projectId: fx.projectId },
    });

    const strangerCtx: HomeActorContext = {
      userId: stranger.id,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    };

    // The UNSCOPED population: two rows genuinely routed to them.
    const trueCount = await adminDb.approvalGate.count({
      where: { state: 'awaiting', workItem: { assigneeId: stranger.id } },
    });
    expect(trueCount).toBe(2);

    // The SCOPED answer: nothing, and not an error — the no-existence-leak
    // convention. A scoped and an unscoped read cannot return the same number
    // over this fixture, which is what makes the assertion mean something.
    const page = await approvalGatesService.listAwaitingMe(strangerCtx);
    expect(page).toEqual({ items: [], total: 0, truncated: false, reviewsToRun: [] });
    expect(await approvalGatesService.countAwaitingMe(strangerCtx)).toBe(0);
  });

  it('returns an empty page when the active-project pointer names another workspace’s project', async () => {
    await gateOn({ title: 'Mine', assigneeId: meCtx.userId });
    const elsewhere = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHR' });

    const page = await approvalGatesService.listAwaitingMe({
      ...meCtx,
      projectId: elsewhere.projectId,
    });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });
});

describe('approvalGatesService.listAwaitingMe — the WHOLE set, under a stated ceiling (MOTIR-5998)', () => {
  it('reads every awaiting gate in ONE call — no page, no pageSize — past the old 25-row window', async () => {
    for (let i = 0; i < 30; i += 1) {
      await gateOn({
        title: `Waiting ${i}`,
        assigneeId: meCtx.userId,
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)),
      });
    }

    const queue = await approvalGatesService.listAwaitingMe(meCtx);

    expect(queue).toEqual({
      items: expect.any(Array),
      total: 30,
      truncated: false,
      reviewsToRun: [],
    });
    expect(queue.items).toHaveLength(30);
    expect(new Set(queue.items.map((row) => row.gateId)).size).toBe(30);
  });

  it('stops at the ceiling and SAYS so — `truncated`, with the whole set’s total', async () => {
    for (let i = 0; i < 4; i += 1) {
      await gateOn({
        title: `Waiting ${i}`,
        assigneeId: meCtx.userId,
        createdAt: new Date(Date.UTC(2026, 8, i + 1)),
      });
    }

    const cut = await approvalGatesService.listAwaitingMe(meCtx, { ceiling: 3 });
    expect(cut.items).toHaveLength(3);
    expect(cut).toMatchObject({ total: 4, truncated: true });

    // AT the ceiling is not past it: nothing was cut, so nothing is said.
    const exact = await approvalGatesService.listAwaitingMe(meCtx, { ceiling: 4 });
    expect(exact).toMatchObject({ total: 4, truncated: false });
    expect(exact.items).toHaveLength(4);
  });

  it('the shipped ceiling sits far above any real queue', () => {
    expect(APPROVAL_QUEUE_CEILING).toBe(500);
  });

  it('answers an empty tab with an empty set, never an error', async () => {
    expect(await approvalGatesService.listAwaitingMe(meCtx)).toEqual({
      items: [],
      total: 0,
      truncated: false,
      reviewsToRun: [],
    });
  });
});

describe('approvalGatesService.listRecords — the ROOM still pages (its window helpers moved here from the tab)', () => {
  it('clamps the limit, and answers an empty room with page 1 rather than page 0', async () => {
    const clamped = await approvalGatesService.listRecords(meCtx, { limit: 5000 });
    expect(clamped.pageSize).toBe(100);
    expect(clamped.page).toBe(1);
    expect(clamped.total).toBe(0);
    expect((await approvalGatesService.listRecords(meCtx, { limit: 0 })).pageSize).toBe(25);
  });

  it('a page of 0 — or one that truncates to 0 — is served as page 1, never as page 0', async () => {
    // `Math.trunc(page ?? 1) || 1` is the guard; a page that reached 0 would ask
    // Postgres for `OFFSET -pageSize` on input a hand-typed `?page=0` produces.
    for (const page of [0, 0.4, Number.NaN]) {
      const served = await approvalGatesService.listRecords(meCtx, { page, limit: 3 });
      expect(served).toMatchObject({ page: 1, pageSize: 3 });
    }
  });
});

describe('approvalGatesService.countAwaitingMe', () => {
  it('agrees with the length of an UNPAGED read over the same fixture', async () => {
    for (let i = 0; i < 5; i += 1) {
      await gateOn({ title: `Mine ${i}`, assigneeId: meCtx.userId });
    }
    // Rows the predicate must exclude, so agreement is not agreement on "all".
    await gateOn({ title: 'Theirs', assigneeId: otherId, reporterId: meCtx.userId });
    const decided = await gateOn({ title: 'Decided', assigneeId: meCtx.userId });
    await adminDb.approvalGate.update({
      where: { id: decided.gate.id },
      data: { state: 'approved' },
    });

    const unpaged = await approvalGatesService.listAwaitingMe(meCtx);

    expect(await approvalGatesService.countAwaitingMe(meCtx)).toBe(unpaged.items.length);
    expect(unpaged.total).toBe(unpaged.items.length);
    expect(unpaged.total).toBe(5);
  });
});

describe('approvalGatesService.listAwaitingMe — the subject summary', () => {
  it('names WHICH design is waiting, from the registry’s registered kind', async () => {
    const { item } = await gateOn({
      title: 'Draw the row',
      assigneeId: meCtx.userId,
      subjectId: 'evidence-fixed',
    });
    await designEvidence({
      id: 'evidence-fixed',
      workItemId: item.id,
      producedByKey: 'MOTIR-5147',
      commitSha: 'abc1234',
      noteMd: '## The To-approve row\n\nDrawn **in situ** beneath the shipped strip.',
      assets: 3,
    });

    const [row] = (await approvalGatesService.listAwaitingMe(meCtx)).items;

    expect(row!.subject).toEqual({
      kind: 'design_result',
      designEvidenceId: 'evidence-fixed',
      producedByKey: 'MOTIR-5147',
      commitSha: 'abc1234',
      assetCount: 3,
      // The excerpt is FLATTENED, not sliced: a `##` arriving verbatim in a
      // one-line row is the tell of an excerpt taken with `slice` alone.
      noteExcerpt: 'The To-approve row Drawn in situ beneath the shipped strip.',
    });
  });

  it('says a kind is NOT BUILT YET rather than erroring on it — a real row the day this ships', async () => {
    // `pull_request_merge` is a declared registry HOLE (RETIRED by MOTIR-5616), so
    // there is no handler and no summariser. The honest row names the kind. (This
    // used `pull_request_merge` until MOTIR-4793 registered that kind, then
    // `pull_request_approval` until MOTIR-5481 did, then `decision_approval` until
    // MOTIR-5676 did — and now the retired merge kind again, the one hole left.)
    await gateOn({
      title: 'An approval waiting',
      assigneeId: meCtx.userId,
      kind: 'pull_request_merge',
    });

    const [row] = (await approvalGatesService.listAwaitingMe(meCtx)).items;

    expect(row!.kind).toBe('pull_request_merge');
    expect(row!.subject).toEqual({ kind: 'pull_request_merge' });
  });

  // ⚠️ AMENDED (Bug MOTIR-7146). This read used to LIST such a gate with a null subject,
  // for ever — a *Gone* row nobody could answer, counted in the tab. It now WITHDRAWS it:
  // superseded `subject_gone`, out of the list and its count. Distinct from not-built-yet
  // still — the not-built row above is listed, because a kind that has not shipped is not
  // a subject that went away.
  it('WITHDRAWS a gate whose subject no longer resolves — out of the list and its count', async () => {
    const { gate } = await gateOn({
      title: 'Points at nothing',
      assigneeId: meCtx.userId,
      subjectId: 'evidence-that-is-gone',
    });

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(await approvalGatesService.countAwaitingMe(meCtx)).toBe(0);
    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.state).toBe('superseded');
    expect(row.supersededCause).toBe('subject_gone');
  });

  it('resolves a whole page of subjects without a per-row read, and identifies each card', async () => {
    for (let i = 0; i < 3; i += 1) {
      const { item } = await gateOn({
        title: `Design ${i}`,
        assigneeId: meCtx.userId,
        subjectId: `evidence-${i}`,
        createdAt: new Date(Date.UTC(2026, 8, i + 1)),
      });
      await designEvidence({ id: `evidence-${i}`, workItemId: item.id, commitSha: `sha-${i}` });
    }

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    expect(page.items).toHaveLength(3);
    for (const [i, row] of page.items.entries()) {
      expect(row.subject).toMatchObject({ kind: 'design_result', commitSha: `sha-${i}` });
      // Each row names the card it belongs to, so the reader can act from the list.
      expect(row.workItem?.identifier).toMatch(/^PROD-\d+$/);
      expect(row.workItem?.title).toBe(`Design ${i}`);
      expect(row.workItem?.kind).toBe('subtask');
    }
  });
});

describe('homeService.tabCounts — the strip badge (MOTIR-4794)', () => {
  it('reports the SAME number the tab lists, over the same fixture — one question, not two', async () => {
    for (let i = 0; i < 3; i += 1) {
      await gateOn({ title: `Mine ${i}`, assigneeId: meCtx.userId });
    }
    // Rows the badge must NOT count, each for a different reason.
    await gateOn({ title: 'Theirs', assigneeId: otherId, reporterId: meCtx.userId });
    const decided = await gateOn({ title: 'Decided', assigneeId: meCtx.userId });
    await adminDb.approvalGate.update({
      where: { id: decided.gate.id },
      data: { state: 'approved' },
    });

    const counts = await homeService.tabCounts(meCtx);
    const listed = await approvalGatesService.listAwaitingMe(meCtx);

    expect(counts.approvals).toBe(3);
    // ⚠️ THE ASSERTION THAT MATTERS IS THE AGREEMENT, not the literal. A badge
    // reading `3` above a list of two is what a second copy of the predicate
    // looks like from the reader's side, and the two are only safe from that
    // because they call ONE `where` builder in the repository.
    expect(counts.approvals).toBe(listed.total);
    expect(counts.approvals).toBe(listed.items.length);
  });

  it("is NOT the sibling tabs' membership union — the badge diverges exactly where the predicate does", async () => {
    // Assigned to somebody else, reported by me: a WORK tab would count it.
    await gateOn({ title: 'Theirs now', assigneeId: otherId, reporterId: meCtx.userId });

    expect((await homeService.tabCounts(meCtx)).approvals).toBe(0);
  });

  it('counts nothing for a reader who may not browse the active project', async () => {
    const stranger = await createTestUser({ email: 'badge-stranger@ex.com', name: 'Badge' });
    await workspacesService.addMember({ userId: stranger.id, workspaceId: fx.workspaceId });
    await gateOn({ title: 'Routed to the stranger', assigneeId: stranger.id });
    await projectMembersService.setAccessMode({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    await adminDb.projectMembership.deleteMany({
      where: { userId: stranger.id, projectId: fx.projectId },
    });

    const counts = await homeService.tabCounts({
      userId: stranger.id,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });

    expect(counts.approvals).toBe(0);
  });
});

describe('designEvidenceRepository.findManyByIds — the batch behind the subject summaries', () => {
  it('returns an EMPTY map for an empty id list, without a round trip', async () => {
    // ⚠️ THE GUARD HAS A REAL CALLER, which is why it is a branch rather than
    // defensive code: `summarizeGateSubjects` groups a page's gates by KIND, and
    // a page whose gates are ALL of an unregistered kind leaves the registered
    // bucket empty. Without the guard that is `IN ()` — legal SQL, a pointless
    // round trip, and one more query per page of not-built-yet rows.
    const rows = await withWorkspaceContext(fx.ctx, (tx) =>
      designEvidenceRepository.findManyByIds([], tx),
    );

    expect(rows.size).toBe(0);
  });

  it('keys the map by ID and OMITS an id that resolves to nothing', async () => {
    const { item } = await gateOn({ title: 'Has evidence', assigneeId: meCtx.userId });
    await designEvidence({ id: 'ev-real', workItemId: item.id, commitSha: 'abc1234', assets: 2 });

    const rows = await withWorkspaceContext(fx.ctx, (tx) =>
      designEvidenceRepository.findManyByIds(['ev-real', 'ev-that-is-gone'], tx),
    );

    // POSITIVE CONTROL: the row that exists comes back, with its asset COUNT
    // rather than its assets.
    expect(rows.get('ev-real')).toMatchObject({ commitSha: 'abc1234', _count: { assets: 2 } });
    // And the one that does not is ABSENT rather than mapped to a placeholder —
    // the caller decides what a row with an unresolvable subject says.
    expect(rows.has('ev-that-is-gone')).toBe(false);
    expect(rows.size).toBe(1);
  });
});

describe('approvalGatesService.listAwaitingMe — the *waiting on* name (MOTIR-5191)', () => {
  // The Approvals tab mounts the SAME approval frame the item page does, so it
  // inherited the same hardcoded `routedToLabel={null}` when MOTIR-4879 added
  // it — a second instance of the defect, created two hours after the bug that
  // reported the first. The row carries the name so the frame's state `B` line
  // ("see but not decide", Panel 5) can draw it.

  it('names the routed person on every row', async () => {
    await gateOn({ title: 'Assigned to me', assigneeId: fx.ctx.userId });

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    const me = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ctx.userId } });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.routedToName).toBe(me.name?.trim() || me.email);
  });

  it('reads it off the ROW, not off the session — an unassigned card names its REPORTER', async () => {
    // ⚠️ THE ASSERTION THAT MAKES THE FIELD WORTH CARRYING. Every row in this
    // queue is routed to the reader by the predicate, so a surface that drew
    // the SESSION user's name would pass every other test in this file. It
    // would also start lying the day §2's routing widened past one recipient.
    // Here the reader is the reporter and the assignee column is empty, so the
    // two derivations coincide in VALUE while differing in SOURCE — which is
    // why the next assertion drives them apart.
    await gateOn({ title: 'Unassigned, reported by me', assigneeId: null });

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    const me = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ctx.userId } });
    expect(page.items[0]!.routedToName).toBe(me.name?.trim() || me.email);
  });

  it('resolves a whole page of names without a per-row read', async () => {
    // The same property `summarizeGateSubjects` is asserted for one read up: a
    // 25-row queue that named its recipients one at a time would be 25 round
    // trips to draw one list. Asserted by OUTCOME — every row named, over a
    // page with repeats — because the batch is what makes that affordable.
    for (const title of ['One', 'Two', 'Three']) {
      await gateOn({ title, assigneeId: fx.ctx.userId });
    }

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    expect(page.items).toHaveLength(3);
    expect(page.items.every((row) => row.routedToName !== null)).toBe(true);
    expect(new Set(page.items.map((row) => row.routedToName)).size).toBe(1);
  });
});
