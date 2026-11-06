import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { boardsService } from '@/lib/services/boardsService';
import { homeService } from '@/lib/services/homeService';
import { reportsService } from '@/lib/services/reportsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { parentStatusRollupService } from '@/lib/services/parentStatusRollupService';
import { buildDefaultBoard } from '@/lib/boards/defaultBoard';
import { canvasStatusLabel } from '@/lib/workflows/canvasStatusMeta';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';
import { classifyApiV1Error } from '@/lib/api/v1/errors';
import { withWorkspaceContext } from '@/lib/workspaces';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { toWorkbenchRowViews } from '@/app/(authed)/workbench/_components/workbenchRows';
import { homePageItems } from '../../helpers/homePage';

// THE `approved` STORY GATE (Story MOTIR-4905 · MOTIR-5142) — the properties
// that belong to no single card of this story, against real Postgres and the
// shipped services.
//
// Every sibling card tested its own half. MOTIR-5139 asserted the status exists
// in the default workflow and that the migration seeds it; MOTIR-5140 asserted
// the ladder ranks it and the rollup reads the rank; MOTIR-5141 asserted the
// chip paints it. What none of them can see is the thing this story actually
// claims:
//
//   **A person's YES is a STATUS, and a status in the `in_progress` CATEGORY is
//   OPEN everywhere the product counts open work.**
//
// That claim is not about `approved`. It is about the four surfaces that decide
// "is this finished?", and about the fact that every one of them decides it by
// reading `workflow_status.category` rather than by consulting a list of status
// keys. The story needed no edit to any of them — which is the whole result, and
// which is also why it is invisible: a story that changes nothing leaves nothing
// to point at. These tests are the pointing.
//
// ⚠️ WHAT THIS SUITE MAY NOT DO. It asserts the ASSEMBLED story and ships no
// product code. A real defect found here is a bug filed against the sibling that
// owns the surface, never a patch smuggled into a test PR — see the card's Scope
// boundary. Nothing below imports a module this story wrote in order to fix it.
//
// ⚠️ AND IT DRIVES THE REAL WRITES. No test here writes `status` as a fixture
// column: every card reaches `approved` through `updateStatus`, over the edges
// the real migration declared. A suite that seeds the status it is asserting
// about would pass against a workflow in which `approved` is unreachable, which
// is the one failure this story could actually have.

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'APG' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const homeCtx = () => ({ ...fx.ctx, projectId: fx.projectId });

async function card(
  title: string,
  opts: { kind?: 'task' | 'story'; parentId?: string } = {},
): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: opts.kind ?? 'task',
      title,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    },
    fx.ctx,
  );
  return { id: item.id, identifier: item.identifier };
}

/** Move a card the way the product does — never a direct `status` write. */
async function move(id: string, ...keys: string[]): Promise<void> {
  for (const key of keys) await workItemsService.updateStatus(id, key, fx.ctx);
}

/** The canonical route to a YES: the full forward path, every hop legal. */
const TO_APPROVED = ['in_progress', 'implemented', 'in_review', 'approved'] as const;

async function statusOf(id: string): Promise<string> {
  const row = await withWorkspaceContext(fx.ctx, (tx) =>
    tx.workItem.findUnique({ where: { id }, select: { status: true } }),
  );
  if (!row) throw new Error(`work item ${id} vanished`);
  return row.status;
}

/** Back-date a row's `updatedAt` past the board's Done-age window. */
async function backdate(id: string, days: number): Promise<void> {
  await adminDb.$executeRawUnsafe(
    `UPDATE "work_item" SET "updatedAt" = now() - INTERVAL '${days} days' WHERE "id" = $1`,
    id,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// PART 1 — THE THREE INTEGRATION SEAMS
// ───────────────────────────────────────────────────────────────────────────

describe('the integration seams', () => {
  it('REFUSES a hand `in_review → approved` while an open pull request delivers the card, and the refusal classifies as 422', async () => {
    // ⚠️ `approved` is a PERSON's yes, and while an open pull request delivers
    // the card only a deciding gate may write it — §6d rule 2b. Asserted on
    // `in_review → approved`, the one declared way in: `implemented → approved`
    // is ABSENT again (MOTIR-5630 declared it for Queue again; MOTIR-5804
    // removed it under §4's FOURTH AMENDMENT, point 6), asserted below.
    const c = await card('a card the agent has built');
    await move(c.id, 'in_progress', 'implemented', 'in_review');
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: 'inst-apg-story-gate',
        accountLogin: 'acme',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        installationId: installation.id,
        repoId: 'repo-apg-story-gate',
        owner: 'acme',
        name: 'web',
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: 11,
        title: 'a card the agent has built',
        state: 'open',
        merged: false,
        headRef: 'subtask/built',
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: c.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });

    const err = await workItemsService.updateStatus(c.id, 'approved', fx.ctx).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('APPROVAL_GATE_PENDING');
    // …and it is a REFUSAL the API renders, not a fault that 500s. The status
    // comes from the shipped classifier rather than from a literal in this
    // file: asserting `422` against a number I typed would pass even if the
    // mapping were deleted.
    expect(classifyApiV1Error(err)?.status).toBe(422);

    // The card did not move.
    expect(await statusOf(c.id)).toBe('in_review');

    // The edge itself is declared, so the refusal above is the guard's, not the
    // workflow table's — and `implemented → approved` is not declared at all.
    const canReach = async (from: string, to: string) =>
      workflowsService.canTransition(fx.projectId, from, to, fx.workspaceId);
    expect(await canReach('in_review', 'approved')).toBe(true);
    expect(await canReach('implemented', 'in_review')).toBe(true);
    expect(await canReach('implemented', 'approved')).toBe(false);
  });

  it('accepts EVERY declared hop out of approved', async () => {
    // ⚠️ THE REFUSAL IS ONLY HALF THE CONTRACT. A workflow that refused a hand
    // move into approved by refusing everything would pass the test above and be
    // catastrophically wrong. The migration declared one way in and THREE
    // ways out — `done` when the merge lands, `in_progress` to pull work back
    // after approval, and `cancelled` by the constant's own convention that
    // cancellation is reachable from anywhere. Each is driven on its own card,
    // because a hop asserted only as a boolean is a claim about the table rather
    // than about the service that reads it.
    for (const out of ['done', 'in_progress', 'cancelled']) {
      const c = await card(`approved, then ${out}`);
      await move(c.id, ...TO_APPROVED);
      await move(c.id, out);
      expect(await statusOf(c.id)).toBe(out);
    }
  });

  it('does NOT complete a parent whose children are ALL approved', async () => {
    // The rollup's job is to say what the parent IS. With every child approved
    // the honest answer is `approved` — the children are approved, and nothing
    // about that says the work is DONE. The bug this guards is the one the
    // six-rung ladder fixed from the other side: a story whose children all
    // reached `approved` used to derive to In Progress, going BACKWARDS as its
    // children went forwards.
    //
    // ⚠️ THE CHILDREN WALK THE WHOLE PATH AND THE PARENT IS ROLLED UP AT EVERY
    // HOP, because the recompute moves the parent over LEGAL EDGES only. Jumping
    // the children straight to `approved` and rolling up once would ask the
    // parent for a hop (`todo → approved`) the workflow does not declare, and the
    // test would fail for a reason that has nothing to do with the claim.
    const story = await card('a story with two approved children', { kind: 'story' });
    const a = await card('child a', { parentId: story.id });
    const b = await card('child b', { parentId: story.id });

    for (const hop of TO_APPROVED) {
      await move(a.id, hop);
      await move(b.id, hop);
      await parentStatusRollupService.rollUpForChild(a.id, fx.workspaceId);
    }

    const derived = await statusOf(story.id);
    expect(derived).toBe('approved');
    // The two claims that matter, said separately so a failure names which one
    // broke: it is not finished, and it is still OPEN.
    expect(derived).not.toBe('done');
    const category = DEFAULT_STATUSES.find((s) => s.key === derived)?.category;
    expect(category).toBe('in_progress');
  });

  it('keeps a card blocked by an APPROVED card out of the READY SET', async () => {
    // ⚠️ ASSERTED THROUGH THE READY-SET READ, not through the pure predicate.
    // `blockerReadiness` is a function over a blocker's terminality and it is
    // already unit-tested; what no unit can see is whether the READ that feeds
    // it resolves the blocker's category from the project's own workflow. An
    // `approved` blocker is non-terminal, so the dependent is NOT ready — and
    // the only way to know the list agrees is to read the list.
    //
    // The ready set is the STARTABLE set (`category = 'todo'` and unblocked), so
    // the three phases below each say something different: the blocker is
    // startable and the dependent is not; approving the blocker empties the list
    // WITHOUT releasing the dependent; finishing it releases the dependent.
    const blocker = await card('the blocker');
    const dependent = await card('the dependent');
    await workItemsService.linkWorkItems(
      { fromId: dependent.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const readyKeys = async () =>
      (await workItemsService.listReady(fx.projectId, {}, fx.ctx)).items.map((r) => r.key);

    // Phase 1 — the read works, and the dependency is already in force.
    expect(await readyKeys()).toEqual([blocker.identifier]);

    // Phase 2 — THE CLAIM. An approved blocker has not finished, so it releases
    // nothing.
    await move(blocker.id, ...TO_APPROVED);
    expect(await readyKeys()).not.toContain(dependent.identifier);

    // Phase 3 — THE COUNTERFACTUAL, measured rather than argued. Without it,
    // "absent in phase 2" could equally mean the read is simply broken.
    await move(blocker.id, 'done');
    expect(await readyKeys()).toContain(dependent.identifier);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PART 2 — THE FOUR SURFACES THAT DECIDE "IS THIS FINISHED?"
// ───────────────────────────────────────────────────────────────────────────

describe('every surface that counts open work counts an approved card', () => {
  it('BOARD — an old approved card sits in the Approved lane, never the Done lane', async () => {
    // The board pages every lane (MOTIR-10535; the Done-age window it replaced
    // is gone), so age no longer decides whether a card shows. What still
    // decides "is this finished?" is the lane: `isTerminalColumn` asks the
    // project's workflow which statuses are `category = 'done'`. The Approved
    // column is not one, so an approved card — however old — is in an open lane,
    // ordered by rank with the work still in flight.
    const approved = await card('approved long ago');
    const done = await card('done long ago');
    await move(approved.id, ...TO_APPROVED);
    await move(done.id, ...TO_APPROVED, 'done');
    await backdate(approved.id, 30);
    await backdate(done.id, 30);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const doneColumn = board.columns.find((col) => col.statusKeys.includes('done'));
    expect(doneColumn?.cards.map((r) => r.identifier)).toEqual([done.identifier]);

    // …and it is in the APPROVED column, not merely somewhere on the board. A
    // status the migration seeded without a column would be reported in
    // `unmappedStatuses` — surfaced, never silently dropped — and its cards
    // would sit in no column at all.
    const column = board.columns.find((col) => col.statusKeys.includes('approved'));
    expect(column?.cards.map((r) => r.identifier)).toContain(approved.identifier);
    expect(board.unmappedStatuses.map((st) => st.key)).not.toContain('approved');
  });

  it('BOARD — a card blocked by an APPROVED card still reads as blocked', async () => {
    // The board's blocked badge comes from `getReadinessForItems`, a BATCHED
    // read over every card on the board — a different path from `listReady`,
    // which resolves one project's startable leaves. Both have to agree that an
    // approved blocker is unsatisfied, and only asserting both can show they do.
    const blocker = await card('the blocker');
    const dependent = await card('the dependent');
    await workItemsService.linkWorkItems(
      { fromId: dependent.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await move(blocker.id, ...TO_APPROVED);

    const cardsOf = async () =>
      (await boardsService.getBoard(fx.projectId, fx.ctx)).columns.flatMap((col) => col.cards);

    expect((await cardsOf()).find((r) => r.identifier === dependent.identifier)?.ready).toBe(false);

    // The counterfactual, on the same read.
    await move(blocker.id, 'done');
    expect((await cardsOf()).find((r) => r.identifier === dependent.identifier)?.ready).toBe(true);
  });

  it('WORKBENCH — an approved card is In progress, never Recently finished', async () => {
    const c = await card('awaiting the merge');
    await move(c.id, ...TO_APPROVED);

    const inProgress = await homeService.listInProgress(homeCtx());
    const finished = await homeService.listRecentlyFinished(homeCtx());

    expect(homePageItems(inProgress).map((r) => r.identifier)).toContain(c.identifier);
    expect(homePageItems(finished).map((r) => r.identifier)).not.toContain(c.identifier);

    // …and the ROW the tab renders carries the open category, which is what
    // decides the chip's tone. A row whose category came back `done` would sit
    // in the In progress tab wearing a finished pill.
    const workflow = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    const [row] = toWorkbenchRowViews(
      homePageItems(inProgress).filter((r) => r.identifier === c.identifier),
      workflow,
      [],
      false,
    );
    expect(row?.statusCategory).toBe('in_progress');
  });

  it('OPEN-ITEMS COUNT — an approved card is still open; a done one is not', async () => {
    const approved = await card('approved, still open');
    const done = await card('done, not open');
    await move(approved.id, ...TO_APPROVED);

    const before = await reportsService.getAverageAge(
      { projectId: fx.projectId },
      { period: 'day', daysBack: 7 },
      fx.ctx,
    );
    expect(before.state).toBe('ok');
    const openBefore = before.state === 'ok' ? lastOpenCount(before.data) : -1;

    await move(done.id, ...TO_APPROVED, 'done');

    const after = await reportsService.getAverageAge(
      { projectId: fx.projectId },
      { period: 'day', daysBack: 7 },
      fx.ctx,
    );
    const openAfter = after.state === 'ok' ? lastOpenCount(after.data) : -1;

    // Two cards existed throughout; exactly one of them finished. The approved
    // one is still being counted, which is the whole assertion — the count fell
    // by one, not by two.
    expect(openBefore).toBe(2);
    expect(openAfter).toBe(1);
  });

  it('REPORTS — approving does not RESOLVE; the merge does', async () => {
    const c = await card('resolved only when done');
    await move(c.id, ...TO_APPROVED);

    const atApproved = await reportsService.getCreatedVsResolved(
      { projectId: fx.projectId },
      { period: 'day', daysBack: 7, cumulative: false },
      fx.ctx,
    );
    expect(atApproved.state).toBe('ok');
    expect(atApproved.state === 'ok' ? totalResolved(atApproved.data) : -1).toBe(0);

    await move(c.id, 'done');

    const atDone = await reportsService.getCreatedVsResolved(
      { projectId: fx.projectId },
      { period: 'day', daysBack: 7, cumulative: false },
      fx.ctx,
    );
    expect(atDone.state === 'ok' ? totalResolved(atDone.data) : -1).toBe(1);
  });
});

function lastOpenCount(data: { buckets: Array<{ count: number }> }): number {
  return data.buckets.at(-1)?.count ?? -1;
}

function totalResolved(data: { buckets: Array<{ resolved: number }> }): number {
  return data.buckets.reduce((sum, b) => sum + b.resolved, 0);
}

// ───────────────────────────────────────────────────────────────────────────
// PART 3 — NOTHING COUNTS THE STATUSES
// ───────────────────────────────────────────────────────────────────────────

describe('no surface carries a hard-coded status count', () => {
  it('the default board seeds one column per workflow status, derived', async () => {
    // ⚠️ THE EXPECTATION IS DERIVED FROM `DEFAULT_STATUSES`, NEVER A LITERAL.
    // A `toHaveLength(9)` here would have to be edited by the next status, which
    // makes it a reminder rather than a guard — and the edit that updates it is
    // the same edit that would have been the bug.
    const statuses = await workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId);
    const spec = buildDefaultBoard(statuses);
    expect(spec.columns).toHaveLength(DEFAULT_STATUSES.length);
    expect(spec.columns.flatMap((c) => c.statusKeys)).toContain('approved');

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(board.columns).toHaveLength(DEFAULT_STATUSES.length);
  });

  it('a swimlane lane COUNTS a card at the NEW status', async () => {
    // Lane membership is computed over the union of the board's MAPPED status
    // keys. A status seeded without a column maps to nothing, and its cards fall
    // out of every lane silently — no error, just work that stops appearing. The
    // lane's own `count` is the aggregate the header renders, so asserting the
    // card's `swimlaneKey` alone would miss a lane that placed the card and
    // counted it nowhere.
    await boardsService.setSwimlaneGroupBy(await defaultBoardId(), 'assignee', fx.ctx);
    const c = await card('in a lane');
    await workItemsService.updateWorkItem(c.id, { assigneeId: fx.ownerId }, fx.ctx);
    await move(c.id, ...TO_APPROVED);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const placed = board.columns.flatMap((col) =>
      col.cards.filter((r) => r.identifier === c.identifier),
    );
    expect(placed).toHaveLength(1);
    expect(placed[0]?.swimlaneKey).toBe(fx.ownerId);

    const lane = board.swimlanes.find((l) => l.key === fx.ownerId);
    expect(lane?.count).toBe(1);
  });

  it('the scrum board derives its columns from the workflow too', async () => {
    await boardsService.ensureScrumBoard(fx.projectId, fx.ctx);
    const boards = await boardsService.listBoards(fx.projectId, fx.ctx);
    const scrum = boards.find((b) => b.type === 'scrum');
    expect(scrum).toBeDefined();
    const board = await boardsService.getBoard(fx.projectId, fx.ctx, scrum!.id);
    expect(board.columns).toHaveLength(DEFAULT_STATUSES.length);
  });

  it('a CUSTOMER status keeps its own name on the canvas', async () => {
    // The other half of "nothing counts the statuses": a key the default set
    // does not hold must render the label the WIRE carried, not a translation
    // lookup that would silently miss. This is `canvasStatusLabel`'s open-set
    // fallback — the branch the story's own suites never reach, because every
    // key they pass is a default one.
    const translate = (key: string) => `translated:${key}`;
    expect(canvasStatusLabel('approved', 'ignored', translate)).toBe('translated:approved');
    expect(canvasStatusLabel('awaiting_legal', 'Awaiting legal', translate)).toBe('Awaiting legal');
    // …and with no wire label at all, the KEY, never a plausible default member.
    expect(canvasStatusLabel('awaiting_legal', null, translate)).toBe('awaiting_legal');
  });
});

async function defaultBoardId(): Promise<string> {
  const boards = await withWorkspaceServiceContext(fx.workspaceId, async () =>
    boardsService.listBoards(fx.projectId, fx.ctx),
  );
  const dflt = boards.find((b) => b.isDefault) ?? boards[0];
  if (!dflt) throw new Error('no board seeded for the fixture project');
  return dflt.id;
}
