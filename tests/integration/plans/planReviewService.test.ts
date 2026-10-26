import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

/**
 * The LIFECYCLE spine of a timeline (MOTIR-3536).
 *
 * The rail's history is one merged sequence since the plan gained a content
 * trail: an `appended` / `edited` row sits between the lifecycle events wherever
 * a fixture appended or deepened a proposal. Every assertion below that predates
 * that merge is a claim about the LIFECYCLE — which of the three endings a
 * `declined` plan reads as (MOTIR-3189), whether a `planned` event exists at all
 * — so it keeps making exactly that claim, over exactly those rows, rather than
 * being widened to absorb whatever the fixture happened to append. The content
 * rows have their own suite (`planTimelineMerge.test.ts`).
 */
const LIFECYCLE_KINDS = new Set([
  'created',
  'planned',
  'approved',
  'declined',
  'discarded',
  'abandoned',
]);
function lifecycleKinds(history: { kind: string }[]): string[] {
  return history.map((h) => h.kind).filter((k) => LIFECYCLE_KINDS.has(k));
}

/**
 * The ONE event of a given lifecycle kind (MOTIR-4136).
 *
 * `lifecycleKinds` above answers *which lifecycle events happened, and in what
 * order*; this answers *what does THAT event say*. An assertion about a
 * particular decision event has to select it BY KIND, never by position:
 * `mergeTimeline` sorts on `at` and puts the DERIVED event first at an equal
 * timestamp, so whenever a fixture's content event lands in the same
 * millisecond as the decision — which on a loaded box it does — the decision is
 * not the last row and `history.at(-1)` reads the content event instead. The
 * assertion then measures the fixture's append rather than the ending it names.
 */
function lifecycleEvent<T extends { kind: string }>(history: T[], kind: string): T {
  const matches = history.filter((h) => h.kind === kind);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

// Integration tests for Subtask 7.4.5 / MOTIR-847 — `planReviewService`, the
// READ assembly behind the plan-detail UI. Real Postgres (no mocks), per
// CLAUDE.md. Proves the assembly the canvas + review rail bind to:
//   • each proposed op is enriched for rendering — an `add` from its proposed
//     fields (no identifier/status yet), a `modify` as the LIVE target plus an
//     old→new diff, a `remove` as the live target marked for archive;
//   • the history timeline tracks the lifecycle (created → planned → decision),
//     with the decider's NAME resolved on a decided plan;
//   • a fresh plan over an unchanged tree is not stale;
//   • a missing/cross-tenant plan is a typed PlanNotFoundError (the route → 404).
//
// This is also the story's integration SEAM: it reads `plansService`/staleness
// output BACK through the review DTO the client consumes, catching key drift the
// unit layers mask.

/** The target's newest revision id — the anchor a `modify` / `remove` carries. */
async function latestRevisionId(workItemId: string): Promise<string> {
  const row = await adminDb.workItemRevision.findFirst({
    where: { workItemId },
    orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  if (!row) throw new Error(`no revision for ${workItemId}`);
  return row.id;
}

async function seedItem(
  fx: WorkItemFixture,
  title: string,
  priority?: 'low' | 'medium' | 'high',
): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, ...(priority ? { priority } : {}) },
    fx.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

/**
 * A target that already CARRIES both bodies (bug MOTIR-4134) — what a `modify`
 * amends and a `remove` archives. The text deliberately contains no
 * `MOTIR-<n>`: `createWorkItem` normalizes a bare key into a link token, which
 * would make an exact-match assertion about the WRONG thing.
 */
async function seedItemWithBodies(
  fx: WorkItemFixture,
  title: string,
  descriptionMd: string,
  explanationMd: string,
): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, descriptionMd, explanationMd },
    fx.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

/**
 * A target carrying every RAIL value (bug MOTIR-4143) — what a `modify` amends
 * and a `remove` archives, on the fields the quick view's rail renders.
 *
 * ⚠️ `targetRepo` is written through `adminDb` rather than the service, on
 * purpose: pinning a repo through the real path requires a CONNECTED repository
 * row realized against the workspace, and none of these cases is about that
 * validation — they are about which SIDE the review model reads. The column is
 * what `planReviewService` reads, so the fixture writes the column.
 */
async function seedItemWithRail(
  fx: WorkItemFixture,
  title: string,
  rail: {
    type: 'code' | 'design' | 'test' | 'chore';
    priority: 'low' | 'medium' | 'high' | 'highest';
    storyPoints: number;
    estimateMinutes: number;
    executor: 'coding_agent' | 'human';
    targetRepo: string;
  },
): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title,
      type: rail.type,
      priority: rail.priority,
      storyPoints: rail.storyPoints,
      estimateMinutes: rail.estimateMinutes,
      executor: rail.executor,
    },
    fx.ctx,
  );
  await adminDb.workItem.update({
    where: { id: dto.id },
    data: { targetRepo: rail.targetRepo },
  });
  return { id: dto.id, identifier: dto.identifier };
}

/** One node of a real epic → story → task CHAIN, for the ancestor-trail cases. */
async function seedChild(
  fx: WorkItemFixture,
  kind: 'epic' | 'story' | 'task',
  title: string,
  parentId?: string,
): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('planReviewService.getPlanReview', () => {
  // ⚠️ THE `status` ROW IS NEW AND IT IS ON EVERY PARKED TARGET (MOTIR-5646).
  // A plan PARKS its committed targets when it appends, and the review surface
  // tells the reviewer each one comes back — `status → To Do or Blocked
  // (returned when this plan is approved)`. So a `modify`'s change list now
  // carries that row in addition to the fields the patch touched.
  //
  // The cases below are about those OTHER fields, and their exact-set assertions
  // are the point (a per-field `find` passes vacuously on `undefined`). So they
  // drop the resting-status row rather than being relaxed to a bigger set — the
  // row has its own cases in `approveRescopeResetsStatus.test.ts`.
  const contentFields = (changes: ReadonlyArray<{ field: string }>) =>
    changes.filter((c) => c.field !== 'status');

  it('enriches add / modify / remove and builds the history timeline', async () => {
    const fx = await makeWorkItemFixture();
    const modifyTarget = await seedItem(fx, 'Seller onboarding', 'medium');
    const removeTarget = await seedItem(fx, 'Manual payout export');
    const modifyBase = await latestRevisionId(modifyTarget.id);
    const removeBase = await latestRevisionId(removeTarget.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Payouts plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'Marketplace payouts', kind: 'epic' } },
        {
          op: 'modify',
          workItemId: modifyTarget.id,
          patch: { title: 'Seller onboarding v2', priority: 'high' },
          baseRevision: modifyBase,
        },
        { op: 'remove', workItemId: removeTarget.id, baseRevision: removeBase },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    // A real edit after the plan read the card — the drift the model surfaces.
    await workItemsService.updateWorkItem(
      modifyTarget.id,
      { descriptionMd: 'Edited out of band' },
      fx.ctx,
    );

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);

    expect(review.status).toBe('planned');
    expect(review.itemCount).toBe(3);

    const add = review.items.find((i) => i.op === 'add')!;
    expect(add.identifier).toBeNull();
    expect(add.status).toBeNull();
    expect(add.title).toBe('Marketplace payouts');
    expect(add.kind).toBe('epic');
    expect(add.nodeId).toBe(add.planItemId);
    expect(add.stale).toBe(false); // an add with no parent/blockers has no drift

    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(modify.identifier).toBe(modifyTarget.identifier);
    expect(modify.nodeId).toBe(modifyTarget.id); // SAME id — not a ghost copy
    expect(modify.targetMissing).toBe(false);
    const priorityChange = modify.changes.find((c) => c.field === 'priority');
    expect(priorityChange).toEqual({ field: 'priority', from: 'medium', to: 'high' });
    expect(modify.changes.find((c) => c.field === 'title')?.to).toBe('Seller onboarding v2');

    // Staleness is JOINED into the model: the modify's target was edited after
    // its `baseRevision`, which surfaces as a drift reason, and the plan-level
    // roll-up reflects it.
    expect(modify.stale).toBe(true);
    expect(modify.staleReasons.some((r) => r.code === 'base_revision_drift')).toBe(true);
    expect(review.stale).toBe(true);
    expect(review.staleCount).toBeGreaterThanOrEqual(1);

    const remove = review.items.find((i) => i.op === 'remove')!;
    expect(remove.identifier).toBe(removeTarget.identifier);
    expect(remove.title).toBe('Manual payout export');
    expect(remove.targetMissing).toBe(false);

    // History: created + planned, no decision yet, no decider.
    expect(lifecycleKinds(review.history)).toEqual(['created', 'planned']);
    expect(review.decidedByName).toBeNull();
  });

  // ── THE TITLE A PROPOSAL IS ASKING FOR (MOTIR-4018, design Part XIII §1) ──
  //
  // The model used to report the TARGET's live title for every non-`add` op, so
  // a plan renaming a card drew the node, its crumb, its search text and the list
  // row's headline under the name the card is about to stop being called — while
  // the same response carried the proposed one three lines away as a `changes`
  // row. All four ops are asserted together, because the defect is not "a modify
  // is wrong" but "the field means two different things depending on the op".
  it('reports a MODIFY’s `patch.title`, and leaves add / remove / an untitled patch exactly as they were (MOTIR-4018)', async () => {
    const fx = await makeWorkItemFixture();
    const renamed = await seedItem(fx, 'Invoice templates');
    const rescoped = await seedItem(fx, 'Dunning emails', 'low');
    const archived = await seedItem(fx, 'Legacy CSV export');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Billing plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'Usage metering', kind: 'story' } },
        // (1) a modify that RENAMES
        { op: 'modify', workItemId: renamed.id, patch: { title: 'Invoice templates + branding' } },
        // (2) a modify whose patch carries NO title — the sparse-patch case, and
        //     the one a naive `patch.title` read would report as undefined.
        { op: 'modify', workItemId: rescoped.id, patch: { priority: 'high' } },
        // (3) a remove, which has no proposed title and never did
        { op: 'remove', workItemId: archived.id },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const byTarget = (id: string) => review.items.find((i) => i.nodeId === id)!;

    expect(review.items.find((i) => i.op === 'add')!.title).toBe('Usage metering');
    expect(byTarget(renamed.id).title).toBe('Invoice templates + branding');
    expect(byTarget(rescoped.id).title).toBe('Dunning emails');
    expect(byTarget(archived.id).title).toBe('Legacy CSV export');
  });

  // ── THE BODIES A PROPOSAL IS ASKING FOR (bug MOTIR-4134) ─────────────────
  //
  // The same field-means-two-things-by-op defect as MOTIR-4018 directly above,
  // one axis over and with a sharper consumer. Both bodies were
  // `op === 'add' ? proposed : null`, which was coherent while the DTO fed the
  // canvas node and the list row — neither reads them — and stopped being so
  // when MOTIR-4022 made a list row open `ProposalQuickView`, which renders the
  // flat bodies INLINE and has no diff rendering at all. A `modify` opened there
  // showed "No description yet." / "No explanation yet." over a patch carrying
  // both, rewritten.
  //
  // ⚠️ THIS IS THE PRODUCER HALF OF A SEAM, and it is asserted as such. The
  // component half (`tests/components/proposal-quick-view.test.tsx`) renders the
  // DTO; neither half can see the defect alone, which is why it shipped. So the
  // assertions below are written as the PRECONDITIONS that component reads on —
  // a non-null `identifier` and two non-null bodies for a `modify` — rather than
  // as free-standing facts about the service.
  //
  // All four cases together, because the defect is per-op AND per-body: a test
  // covering only `descriptionMd` leaves the explanation regressing unseen,
  // which is the exact history of this surface (MOTIR-3070).
  it('reports BOTH bodies on every op — a modify’s patched, a modify’s untouched, and a remove’s (MOTIR-4134)', async () => {
    const fx = await makeWorkItemFixture();
    // The live bodies each `modify` is amending, and the `remove` is archiving.
    const rewritten = await seedItemWithBodies(
      fx,
      'Invoice templates',
      'The live WHAT of the rewritten card.',
      'The live WHY of the rewritten card.',
    );
    const untouched = await seedItemWithBodies(
      fx,
      'Dunning emails',
      'The live WHAT of the untouched card.',
      'The live WHY of the untouched card.',
    );
    const archived = await seedItemWithBodies(
      fx,
      'Legacy CSV export',
      'The live WHAT of the archived card.',
      'The live WHY of the archived card.',
    );

    const plan = await plansService.createPlan(fx.projectId, { title: 'Billing plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Usage metering',
            kind: 'story',
            descriptionMd: 'The proposed WHAT.',
            explanationMd: 'The proposed WHY.',
          },
        },
        // (1) a modify that REWRITES both bodies — the reported case
        {
          op: 'modify',
          workItemId: rewritten.id,
          patch: {
            descriptionMd: 'The rewritten WHAT.',
            explanationMd: 'The rewritten WHY.',
          },
        },
        // (2) a modify whose patch touches NEITHER body. "Nothing changes here"
        //     and "there is nothing here" are different facts and only one is
        //     true, so it reports the target's CURRENT bodies, not the empty
        //     state.
        { op: 'modify', workItemId: untouched.id, patch: { priority: 'high' } },
        // (3) a remove — the third op, which no assertion above would reach, and
        //     the one whose body is the only thing making the archive legible.
        { op: 'remove', workItemId: archived.id },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const byTarget = (id: string) => review.items.find((i) => i.nodeId === id)!;

    const added = review.items.find((i) => i.op === 'add')!;
    expect(added.descriptionMd).toBe('The proposed WHAT.');
    expect(added.explanationMd).toBe('The proposed WHY.');
    // The `add` arm asserted beside the others so the fix cannot be a swap.
    expect(added.identifier).toBeNull();

    expect(byTarget(rewritten.id).descriptionMd).toBe('The rewritten WHAT.');
    expect(byTarget(rewritten.id).explanationMd).toBe('The rewritten WHY.');

    expect(byTarget(untouched.id).descriptionMd).toBe('The live WHAT of the untouched card.');
    expect(byTarget(untouched.id).explanationMd).toBe('The live WHY of the untouched card.');

    expect(byTarget(archived.id).descriptionMd).toBe('The live WHAT of the archived card.');
    expect(byTarget(archived.id).explanationMd).toBe('The live WHY of the archived card.');

    // THE SEAM PRECONDITION. `ProposalQuickView` shows the empty state on a null
    // body and `New` / `not yet created` on a null identifier, so these three
    // nulls ARE the rendered defect — asserted here, at the producer, because
    // the component test cannot reach the producer and this is the half that was
    // silently wrong.
    for (const t of [rewritten, untouched, archived]) {
      expect(byTarget(t.id).identifier).toBe(t.identifier);
      expect(byTarget(t.id).descriptionMd).not.toBeNull();
      expect(byTarget(t.id).explanationMd).not.toBeNull();
    }
  });

  it('a patch that CLEARS a body reports the clear, not the body it deletes (MOTIR-4134)', async () => {
    // ⚠️ The case `??` gets wrong and presence gets right, and it is this bug's
    // own failure mode INVERTED — so it would ship as the fix for it. The patch
    // is sparse with two meanings `applyModify` already honours: absent leaves
    // the body alone, an explicit `null` CLEARS it. Under `?? target?.body` an
    // explicit null falls through to the live body, and the reviewer is shown
    // the text approval is about to DELETE as the text approval will keep.
    const fx = await makeWorkItemFixture();
    const target = await seedItemWithBodies(
      fx,
      'Invoice templates',
      'The body about to be deleted.',
      'The WHY about to go.',
    );

    const plan = await plansService.createPlan(fx.projectId, { title: 'Billing plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { descriptionMd: null, explanationMd: null },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const item = review.items[0]!;
    expect(item.descriptionMd).toBeNull();
    expect(item.explanationMd).toBeNull();
    // …and the DIFF still says what is being deleted, which is where a reviewer
    // reads the outgoing side. The flat field says what the card will BE.
    expect(item.changes.find((c) => c.field === 'description')?.from).toContain(
      'The body about to be deleted.',
    );
    expect(item.changes.find((c) => c.field === 'explanation')?.from).toContain(
      'The WHY about to go.',
    );
  });

  // ── THE RAIL A PROPOSAL IS ASKING FOR (bug MOTIR-4143) ───────────────────
  //
  // The SAME defect as the bodies directly above, one field group over, and it
  // survived that fix because that card wrote the rest down as add-only rather
  // than leaving them unexamined. The argument was real — a rail row has no
  // old→new affordance, and a change IS shown in the `changes` diff — and it is
  // true of the LIST ROW, which renders that diff. `ProposalQuickView` renders
  // no diff at all, and it is the only surface these fields reach: on a
  // `modify` every one of them was null, so the rail collapsed to the single
  // field that was never gated (`parentIdentifier`) and the surface a person
  // approves from showed a re-scoped, re-typed, re-estimated card as one Parent
  // row. Reported from the running app.
  //
  // Asserted PER FIELD, deliberately: the rail renders each row on its own
  // non-null test and computes `hasRail` from the union, so a test that asserts
  // the rail is present passes with one field restored and five still missing —
  // which is exactly the state being fixed.
  it('reports every RAIL field on a modify — the patch’s value, and the target’s where the patch is silent (MOTIR-4143)', async () => {
    const fx = await makeWorkItemFixture();
    const rescoped = await seedItemWithRail(fx, 'Invoice templates', {
      type: 'code',
      priority: 'low',
      storyPoints: 2,
      estimateMinutes: 30,
      executor: 'coding_agent',
      targetRepo: 'motir-core',
    });
    const untouched = await seedItemWithRail(fx, 'Dunning emails', {
      type: 'design',
      priority: 'high',
      storyPoints: 5,
      estimateMinutes: 45,
      executor: 'human',
      targetRepo: 'motir-ai',
    });
    const archived = await seedItemWithRail(fx, 'Legacy CSV export', {
      type: 'chore',
      priority: 'medium',
      storyPoints: 1,
      estimateMinutes: 15,
      executor: 'coding_agent',
      targetRepo: 'motir-core',
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Billing plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Usage metering',
            kind: 'task',
            type: 'test',
            priority: 'highest',
            storyPoints: 8,
            estimateMinutes: 65,
            executor: 'coding_agent',
          },
        },
        // (1) a RE-SCOPE — the shape a re-plan actually produces, and the one
        //     the reviewer most needs to see before approving.
        {
          op: 'modify',
          workItemId: rescoped.id,
          patch: { type: 'test', priority: 'highest', storyPoints: 8, estimateMinutes: 65 },
        },
        // (2) a modify whose patch touches NO rail field. "This is not
        //     changing" and "there is nothing here" are different facts.
        { op: 'modify', workItemId: untouched.id, patch: { title: 'Dunning emails, revised' } },
        // (3) the third op, which no assertion above reaches.
        { op: 'remove', workItemId: archived.id },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const byTarget = (id: string) => review.items.find((i) => i.nodeId === id)!;

    // The `add` arm, asserted beside the others so the fix cannot be a swap.
    const added = review.items.find((i) => i.op === 'add')!;
    expect({
      type: added.type,
      priority: added.priority,
      storyPoints: added.storyPoints,
      estimateMinutes: added.estimateMinutes,
    }).toEqual({ type: 'test', priority: 'highest', storyPoints: 8, estimateMinutes: 65 });

    // (1) the four fields the patch names report the PROPOSED value…
    const changed = byTarget(rescoped.id);
    expect({
      type: changed.type,
      priority: changed.priority,
      storyPoints: changed.storyPoints,
      estimateMinutes: changed.estimateMinutes,
    }).toEqual({ type: 'test', priority: 'highest', storyPoints: 8, estimateMinutes: 65 });
    // …and the two it does not name report what the card will KEEP. `executor`
    // has no patch key at all — a plan cannot move work between an agent and a
    // person — so the target's value is the only value it can have.
    expect(changed.targetRepo).toBe('motir-core');
    expect(changed.executor).toBe('coding_agent');

    // (2) a patch that names no rail field leaves every one of them reporting
    //     the target, rather than reporting nothing.
    const same = byTarget(untouched.id);
    expect({
      type: same.type,
      priority: same.priority,
      storyPoints: same.storyPoints,
      estimateMinutes: same.estimateMinutes,
      targetRepo: same.targetRepo,
      executor: same.executor,
    }).toEqual({
      type: 'design',
      priority: 'high',
      storyPoints: 5,
      estimateMinutes: 45,
      targetRepo: 'motir-ai',
      executor: 'human',
    });

    // (3) a remove reports the target's — what the reviewer is being asked to
    //     archive, which is the only thing that makes the archive legible.
    const gone = byTarget(archived.id);
    expect({
      type: gone.type,
      priority: gone.priority,
      storyPoints: gone.storyPoints,
      estimateMinutes: gone.estimateMinutes,
    }).toEqual({ type: 'chore', priority: 'medium', storyPoints: 1, estimateMinutes: 15 });

    // THE SEAM PRECONDITION, in the shape the component reads on: the rail
    // mounts on the UNION of these fields being non-null, so what the defect
    // rendered was one row. Assert the union is no longer one field wide.
    for (const t of [rescoped, untouched, archived]) {
      const item = byTarget(t.id);
      const railFields = [
        item.type,
        item.priority,
        item.storyPoints,
        item.estimateMinutes,
        item.targetRepo,
        item.executor,
      ];
      expect(railFields.filter((v) => v != null)).toHaveLength(6);
    }
  });

  it('a patch that CLEARS a rail field reports the clear, not the value it deletes (MOTIR-4143)', async () => {
    // The presence-vs-nullishness case, on the rail this time: the patch is
    // sparse, an explicit `null` UNSETS a field, and `?? target` would show the
    // estimate approval is about to delete as the estimate it will keep.
    const fx = await makeWorkItemFixture();
    const target = await seedItemWithRail(fx, 'Sized card', {
      type: 'code',
      priority: 'high',
      storyPoints: 5,
      estimateMinutes: 45,
      executor: 'coding_agent',
      targetRepo: 'motir-core',
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Unsize it' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { storyPoints: null, estimateMinutes: null },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const item = review.items.find((i) => i.nodeId === target.id)!;
    expect({ storyPoints: item.storyPoints, estimateMinutes: item.estimateMinutes }).toEqual({
      storyPoints: null,
      estimateMinutes: null,
    });
    // The untouched half of the same card still reports the target — the clear
    // is per key, not per card.
    expect(item.priority).toBe('high');
    expect(item.type).toBe('code');
  });

  it('leaves `changes` untouched — the fix ADDS a reading, it does not move one (MOTIR-4134)', async () => {
    // The list row's existing diff rendering is what a reviewer reads to see
    // what a `modify` is LEAVING. The quick view answers what the card will BE.
    // Both must hold at once, so the old→new pairs are asserted beside the flat
    // bodies rather than assumed to have survived.
    const fx = await makeWorkItemFixture();
    const target = await seedItemWithBodies(
      fx,
      'Invoice templates',
      'The outgoing WHAT.',
      'The outgoing WHY.',
    );

    const plan = await plansService.createPlan(fx.projectId, { title: 'Billing plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { descriptionMd: 'The incoming WHAT.', explanationMd: 'The incoming WHY.' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const item = (await planReviewService.getPlanReview(plan.id, fx.ctx)).items[0]!;
    const description = item.changes.find((c) => c.field === 'description')!;
    const explanation = item.changes.find((c) => c.field === 'explanation')!;
    expect(description.from).toContain('The outgoing WHAT.');
    expect(description.to).toContain('The incoming WHAT.');
    expect(explanation.from).toContain('The outgoing WHY.');
    expect(explanation.to).toContain('The incoming WHY.');
    // The flat field carries the INCOMING side — the two readings coexist.
    expect(item.descriptionMd).toBe('The incoming WHAT.');
    expect(item.explanationMd).toBe('The incoming WHY.');
  });

  it('keeps BOTH sides of the rename in `changes` — the diff is untouched by MOTIR-4018', async () => {
    // The node is a SIGNAL and the list is where a change is SPELLED (Part VIII
    // §3). So `title` says what the card will BE and the diff says what it is
    // leaving; a card that reported the proposed title in both would have taken
    // the outgoing name off the one surface that shows it.
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Invoice templates');
    const plan = await plansService.createPlan(fx.projectId, { title: 'Billing plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { title: 'Invoice templates + branding' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const item = (await planReviewService.getPlanReview(plan.id, fx.ctx)).items[0]!;
    expect(item.changes.find((c) => c.field === 'title')).toEqual({
      field: 'title',
      from: 'Invoice templates',
      to: 'Invoice templates + branding',
    });
    expect(item.identifier).toBe(target.identifier); // still anchored to the real key
  });

  // ── THE ARRIVAL LEVEL'S SIZE (MOTIR-4024, design Part XIII §6) ─────────────
  //
  // The client cannot compute it: `defaultPlanView` runs before the canvas has
  // fetched anything, and the answer is about the level's COMMITTED
  // neighbourhood, which the plan's own items say nothing about. All three
  // container shapes are covered here because each resolves differently — and the
  // proposal case is the one a naive implementation gets wrong by counting the
  // children of an id no work item has.
  it('counts the arrival level under a COMMITTED parent — its siblings PLUS the plan’s adds (MOTIR-4024)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'Billing overhaul');
    for (let i = 0; i < 4; i += 1) await seedChild(fx, 'story', `Committed ${i}`, epic.id);
    const modified = await seedChild(fx, 'story', 'Invoice templates', epic.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Billing plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Usage metering', kind: 'story' },
          parentRef: epic.id,
        },
        { op: 'add', proposedFields: { title: 'Credit notes', kind: 'story' }, parentRef: epic.id },
        // A `modify` SHARES its node with the committed card it targets, so it
        // must NOT be counted again — the level draws five committed cards, not
        // six, and this is the assertion that says so.
        { op: 'modify', workItemId: modified.id, patch: { title: 'Invoice templates + branding' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.arrivalLevelSize).toBe(7); // 5 committed + 2 adds
    expect(review.arrivalLevelTotal).toBe(7); // nothing truncated
  });

  it('counts ZERO committed siblings when the arrival container is itself a PROPOSAL', async () => {
    // The shape an agent-authored skeleton produces almost every time: a story
    // under a committed epic, with its subtasks hung off the story by intra-plan
    // ref. The fullest container is then the PROPOSED story, and no work item
    // carries that id — so the count is the plan's own adds and nothing else.
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'Marketplace payouts');
    await seedChild(fx, 'story', 'A committed sibling', epic.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Reconciliation' }, fx.ctx);
    const after = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Payout reconciliation', kind: 'story' },
          parentRef: epic.id,
        },
      ],
      fx.ctx,
    );
    const storyItemId = after.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      ['Reconcile rows', 'Backfill payouts', 'Alert on drift'].map((title) => ({
        op: 'add' as const,
        proposedFields: { title, kind: 'subtask' as const },
        parentRef: `planItem:${storyItemId}`,
      })),
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    // The proposed story holds three subtasks and is the fullest container.
    expect(review.arrivalLevelSize).toBe(3);
    expect(review.arrivalLevelTotal).toBe(3);
  });

  it('counts the project ROOT for a plan of pure roots', async () => {
    const fx = await makeWorkItemFixture();
    await seedChild(fx, 'epic', 'A committed root epic');
    await seedChild(fx, 'epic', 'Another root epic');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Roots' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A proposed root', kind: 'epic' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    // `parentId: null` scoped by project — the root level, not every project's.
    expect(review.arrivalLevelSize).toBe(3);
    expect(review.arrivalLevelTotal).toBe(3);
  });

  it('surfaces a leaf-sizing re-scope in the change preview so the approver SEES it (MOTIR-1532)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Resized card');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { storyPoints: 3, estimateMinutes: 45 },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-scope plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { storyPoints: 8, estimateMinutes: 90 } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(modify.changes.find((c) => c.field === 'storyPoints')).toEqual({
      field: 'storyPoints',
      from: '3',
      to: '8',
    });
    expect(modify.changes.find((c) => c.field === 'estimateMinutes')).toEqual({
      field: 'estimateMinutes',
      from: '45',
      to: '90',
    });
  });

  it('surfaces a rewritten EXPLANATION in the change preview so the approver SEES it (MOTIR-3111)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card whose WHY moved');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { explanationMd: 'The rationale as first planned.' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-explain plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { explanationMd: 'The rationale the re-scope leaves behind.' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    // ⚠️ BOTH SIDES, previewed (bug MOTIR-3191). This used to read
    // `from: null, to: 'updated'` — a notification that the half a reviewer most
    // needs to judge had moved, with no way to see where to. Long prose is still
    // previewed rather than carried whole; a preview of the ACTUAL values is a
    // diff, and the word "updated" was not.
    expect(modify.changes.find((c) => c.field === 'explanation')).toEqual({
      field: 'explanation',
      from: 'The rationale as first planned.',
      to: 'The rationale the re-scope leaves behind.',
    });
  });

  it('says NOTHING about the explanation when the patch does not carry one (MOTIR-3111)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card whose WHY stands');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { explanationMd: 'Still right.' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-title plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { title: 'A new title' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(contentFields(modify.changes).map((c) => c.field)).toEqual(['title']);
  });

  // ── WHERE THE CARD SHIPS (bug MOTIR-3868) ────────────────────────────────
  // The SHIPS half of D3's `SITS or SHIPS` pair. Both keys reached `applyModify`
  // and neither reached `buildChanges`, so a `modify` carrying only a re-pin
  // rendered as a proposal with an EMPTY change list — a row that says a card is
  // being changed and declines to say how.

  it('surfaces a repo RE-PIN in the change preview so the approver SEES it (MOTIR-3868)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card that moves repo');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { targetRepo: 'motir-core' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-pin plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { targetRepo: 'motir-ai' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(modify.changes.find((c) => c.field === 'targetRepo')).toEqual({
      field: 'targetRepo',
      from: 'motir-core',
      to: 'motir-ai',
    });
  });

  it('renders a NON-EMPTY change list for a modify whose ONLY change is a re-pin (MOTIR-3868)', async () => {
    // ⚠️ THE DEFECT'S WHOLE SHAPE, asserted directly. An empty `changes` array is
    // a legal, ordinary value elsewhere (a `remove` has one), so nothing rendered
    // wrong and nothing failed — the approver's only options were to approve a
    // change they could not see or to decline a plan that may have been entirely
    // correct. A count assertion is what this case needs; a per-field `find` on a
    // short vocabulary passes vacuously on `undefined`.
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card whose only change is where it ships');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { targetRepo: 'motir-core' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Pin-only plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { targetRepo: 'motir-ai' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(contentFields(modify.changes)).not.toHaveLength(0);
    expect(contentFields(modify.changes).map((c) => c.field)).toEqual(['targetRepo']);
  });

  it('renders an explicit UNPIN as an empty NEW side, and says nothing when the key is absent (MOTIR-3868)', async () => {
    // Sparse in BOTH directions — the half a `find`-based assertion cannot state.
    const fx = await makeWorkItemFixture();
    const unpinned = await seedItem(fx, 'Card that loses its pin');
    const untouched = await seedItem(fx, 'Card whose pin stands');
    await adminDb.workItem.updateMany({
      where: { id: { in: [unpinned.id, untouched.id] } },
      data: { targetRepo: 'motir-core' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Unpin plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: unpinned.id, patch: { targetRepo: null } },
        { op: 'modify', workItemId: untouched.id, patch: { title: 'Renamed only' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const unpin = review.items.find((i) => i.nodeId === unpinned.id)!;
    expect(contentFields(unpin.changes)).toEqual([
      { field: 'targetRepo', from: 'motir-core', to: null },
    ]);

    const stands = review.items.find((i) => i.nodeId === untouched.id)!;
    expect(contentFields(stands.changes).map((c) => c.field)).toEqual(['title']);
  });

  it('surfaces a repo ROLE re-pin on KEY PRESENCE, with no old side to read (MOTIR-3868)', async () => {
    // ⚠️ `work_item.targetRepoRole` is RETIRED (MOTIR-2732 · MOTIR-3040), so the
    // target cannot supply a `from` and a difference cannot be computed. Presence
    // is the right trigger anyway: `applyModify` rewrites the item's repository
    // REFERENCE whenever this key is present, including when the resolved name
    // does not change — so the row appears exactly when the approve will act.
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card that changes repo ROLE');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-role plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { targetRepoRole: 'api' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(contentFields(modify.changes)).toEqual([
      { field: 'targetRepoRole', from: null, to: 'api' },
    ]);
  });

  // ── The SINGULAR ROW-ID pin (bug MOTIR-4924, AC3) ─────────────────────────
  // motir-ai emits `targetRepositoryRef` on `proposedFields`, and core read
  // NOTHING off it until this bug — the pin was persisted and dropped at
  // approve. The approval surface has to SHOW the decision, both when an `add`
  // pins by ref and when a `modify` re-pins by ref, or an approver is shown a
  // proposal "with no repository at all".

  it('surfaces a `modify` ROW-REF re-pin in the change list, on KEY PRESENCE (MOTIR-4924, AC3)', async () => {
    // Same presence-triggered row as `targetRepoRole` above: the ref is resolved
    // at approve, so there is no old-side name to compare against — the diff row
    // appears precisely when the approve will act.
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card that moves to a specific row');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-pin by ref' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { targetRepositoryRef: 'row-web-1' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(contentFields(modify.changes)).toEqual([
      { field: 'targetRepo', from: null, to: 'row row-web-1' },
    ]);
  });

  it('carries the `add` ROW-REF pin on the review item, add-only, so an approver is not shown a proposal with no repository at all (MOTIR-4924, AC3)', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Row-pinned add' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Pinned to a row',
            kind: 'task',
            targetRepositoryRef: 'row-web-1',
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const add = review.items.find((i) => i.op === 'add')!;
    expect(add.targetRepositoryRef).toBe('row-web-1');
    // A `modify` reports the pin through the DIFF, not the add-only rail field.
    expect(add.changes).toEqual([]);
  });

  it('resolves the decider name + an approved history event after approve', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Tiny plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A new task', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);

    expect(review.status).toBe('approved');
    expect(review.stale).toBe(false); // an add-only plan over an unchanged tree
    expect(review.decidedByName).toBe(fx.owner.name);
    const decision = review.history.find((h) => h.kind === 'approved');
    expect(decision).toBeDefined();
    expect(decision!.byName).toBe(fx.owner.name);
    expect(decision!.at).not.toBeNull();
  });

  // ── The COMMITTED parent (MOTIR-3083) ──────────────────────────────────────
  // The canvas opens a LEVEL at this parent and the breadcrumb names it, so the
  // review model has to carry it. Before this it carried no field that could:
  // a proposal under a committed item drew at the top level, indistinguishable
  // from a genuine root.

  it('resolves the COMMITTED parent a proposal will be created under', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await seedItem(fx, 'Payouts epic');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Payouts plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: parent.id,
          proposedFields: { title: 'Seller ledger', kind: 'subtask' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const item = review.items[0]!;

    expect(item.parentNodeId).toBe(parent.id);
    expect(item.parentIdentifier).toBe(parent.identifier);
    expect(item.parentTitle).toBe('Payouts epic');
    expect(item.parentKind).toBe('task');
  });

  it('leaves the parent fields NULL for a root and for an intra-plan parent', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Fresh tree' }, fx.ctx);
    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A proposed epic', kind: 'epic' } }],
      fx.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: `planItem:${first.items[0]!.id}`,
          proposedFields: { title: 'A proposed story', kind: 'story' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const root = review.items.find((i) => i.title === 'A proposed epic')!;
    const child = review.items.find((i) => i.title === 'A proposed story')!;

    // A genuine root: nothing to name.
    expect(root.parentIdentifier).toBeNull();
    // An intra-plan parent already HAS a node in the proposed set, so it needs no
    // resolution — the canvas draws it, the breadcrumb does not.
    expect(child.parentNodeId).toBe(root.nodeId);
    expect(child.parentIdentifier).toBeNull();
  });

  it('DEGRADES to the root rendering when the parent has been archived', async () => {
    // Never throw over a parent that no longer resolves: an unreadable parent is
    // the same rendering a genuine root gets.
    const fx = await makeWorkItemFixture();
    const parent = await seedItem(fx, 'Doomed parent');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Orphan plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: parent.id,
          proposedFields: { title: 'Orphaned proposal', kind: 'subtask' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.workItem.delete({ where: { id: parent.id } });

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const item = review.items[0]!;

    expect(item.parentIdentifier).toBeNull();
    expect(item.parentTitle).toBeNull();
  });

  // ── The committed ANCESTOR CHAIN (bug MOTIR-3152) ─────────────────────────
  // The canvas breadcrumb walks the whole path down to the arrival level, not
  // its last link. `parentIdentifier` can only ever name the immediate parent, so
  // the canvas synthesised ONE crumb and every ancestor above it was missing —
  // and the crumb it did draw sat under a root labelled "Plan" that navigated to
  // the project roadmap root. The chain has to be carried.

  it('carries the committed ancestor path down to the parent — ROOT FIRST, the parent LAST', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'The agent loop');
    const story = await seedChild(fx, 'story', 'Plan review', epic.id);
    const task = await seedChild(fx, 'task', 'The canvas', story.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Canvas plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: task.id,
          proposedFields: { title: 'A proposed subtask', kind: 'subtask' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const item = review.items[0]!;

    expect(item.parentTrail).toEqual([
      { id: epic.id, identifier: epic.identifier, title: 'The agent loop' },
      { id: story.id, identifier: story.identifier, title: 'Plan review' },
      { id: task.id, identifier: task.identifier, title: 'The canvas' },
    ]);
    // The immediate parent stays exactly what it was — the trail is an addition,
    // and its LAST element is that same parent.
    expect(item.parentTrail.at(-1)!.id).toBe(item.parentNodeId);
  });

  it('is a one-element trail when the committed parent is itself a root', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'A root epic');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Root plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: epic.id, proposedFields: { title: 'A proposed story' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]!.parentTrail).toEqual([
      { id: epic.id, identifier: epic.identifier, title: 'A root epic' },
    ]);
  });

  // ── A RE-PARENTING modify carries the DESTINATION's chain (bug MOTIR-5272) ──
  //
  // The walk above is seeded from two of the three carriers that reach
  // `lookupIds`: an `add`'s own `parentRef`, and the TARGET's CURRENT `parentId`.
  // A `modify` that proposes a MOVE (MOTIR-3859) states its destination in
  // `patch.parentRef` — the third carrier — whose ROW was read and whose own
  // parent was never queued, so the walk climbed the chain the card is LEAVING
  // and `trailFor` stopped at the destination parent. The breadcrumb then drew
  // `Roadmap › <destination>` with every ancestor above it missing, which is the
  // shape this surface uses to mean *an ancestor was archived*.
  //
  // Why no existing case caught it: every other re-parent test in this file moves
  // a card onto a ROOT epic, where a one-element trail is the correct answer.
  it('carries the DESTINATION’s chain for a modify that RE-PARENTS its target (MOTIR-5272)', async () => {
    const fx = await makeWorkItemFixture();
    // The chain the card is LEAVING — deep enough that walking it would look like
    // a working walk.
    const oldEpic = await seedChild(fx, 'epic', 'Where it lives now');
    const oldStory = await seedChild(fx, 'story', 'Its current story', oldEpic.id);
    const card = await seedChild(fx, 'task', 'The card that moves', oldStory.id);
    // …and the chain it is JOINING, whose top crumb is the one that went missing.
    const newEpic = await seedChild(fx, 'epic', 'Where it should land');
    const newStory = await seedChild(fx, 'story', 'Its destination story', newEpic.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Move it' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: card.id, patch: { parentRef: newStory.id } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const item = review.items[0]!;

    expect(item.parentNodeId).toBe(newStory.id);
    expect(item.parentTrail).toEqual([
      { id: newEpic.id, identifier: newEpic.identifier, title: 'Where it should land' },
      { id: newStory.id, identifier: newStory.identifier, title: 'Its destination story' },
    ]);
    // The trail is the DESTINATION's, so nothing from the chain it leaves is in it.
    expect(item.parentTrail.map((c) => c.id)).not.toContain(oldEpic.id);
    expect(item.parentTrail.at(-1)!.id).toBe(item.parentNodeId);
  });

  it('resolves MANY re-parents onto one destination in the SAME rounds as one (MOTIR-5272)', async () => {
    // The seeding this card widens is a FRONTIER, and the property that makes it
    // safe to widen is the one the walk was built for: ids are collected per
    // ROUND and de-duplicated, so a destination named by thirty proposals is
    // resolved once. Asserted RELATIVELY — many vs one — rather than as a fixed
    // number, so an unrelated batched read added later does not read as a
    // regression here while the N+1 this guards against still would.
    const fx = await makeWorkItemFixture();
    const oldEpic = await seedChild(fx, 'epic', 'The old epic');
    const oldStory = await seedChild(fx, 'story', 'The old story', oldEpic.id);
    const newEpic = await seedChild(fx, 'epic', 'The new epic');
    const newStory = await seedChild(fx, 'story', 'The new story', newEpic.id);
    // ⚠️ DISJOINT CARD SETS for the two plans, since MOTIR-5645. A plan PARKS
    // every committed target it names, and one card cannot be held by two plans
    // at once — so re-using `cards[0]` in both plans was refused with
    // `PlanTargetLockedError`, which is the one-holder-per-card rule working
    // rather than a defect. The comparison this case makes is MANY vs ONE
    // proposals in a plan, and it does not need the same rows in both.
    const solo = await seedChild(fx, 'task', 'Mover solo', oldStory.id);
    const cards = [
      await seedChild(fx, 'task', 'Mover one', oldStory.id),
      await seedChild(fx, 'task', 'Mover two', oldStory.id),
      await seedChild(fx, 'task', 'Mover three', oldStory.id),
    ];

    const movePlan = async (moving: { id: string }[]) => {
      const plan = await plansService.createPlan(fx.projectId, { title: 'Move them' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        moving.map((c) => ({
          op: 'modify' as const,
          workItemId: c.id,
          patch: { parentRef: newStory.id },
        })),
        fx.ctx,
      );
      await plansService.markPlanned(plan.id, fx.ctx);
      return plan.id;
    };
    const onePlan = await movePlan([solo]);
    const manyPlan = await movePlan(cards);

    // A pass-through counter, never a mock: the reads still hit the real database.
    const batched = vi.spyOn(workItemRepository, 'findByIdsInWorkspace');
    const perParent = vi.spyOn(workItemRepository, 'findAncestors');

    await planReviewService.getPlanReview(onePlan, fx.ctx);
    const roundsForOne = batched.mock.calls.length;
    // The counter must be able to go RED: a spy that records nothing would make
    // the comparison below pass vacuously. One batched read for the targets plus
    // at least one walk round is the floor.
    expect(roundsForOne).toBeGreaterThanOrEqual(2);
    batched.mockClear();

    const many = await planReviewService.getPlanReview(manyPlan, fx.ctx);
    expect(batched.mock.calls.length).toBe(roundsForOne);
    // …and the alternative this walk exists to avoid is still not taken.
    expect(perParent).not.toHaveBeenCalled();
    batched.mockRestore();
    perParent.mockRestore();

    // The trails are right on every one of them, not merely cheap.
    expect(many.items).toHaveLength(3);
    for (const item of many.items) {
      expect(item.parentTrail.map((c) => c.id)).toEqual([newEpic.id, newStory.id]);
    }
  });

  it('is EMPTY for a root proposal, an intra-plan parent, and a deleted parent', async () => {
    const fx = await makeWorkItemFixture();
    const doomed = await seedItem(fx, 'Doomed parent');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Mixed plan' }, fx.ctx);
    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A proposed epic', kind: 'epic' } }],
      fx.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: `planItem:${first.items[0]!.id}`,
          proposedFields: { title: 'A proposed story', kind: 'story' },
        },
        {
          op: 'add',
          parentRef: doomed.id,
          proposedFields: { title: 'An orphaned proposal', kind: 'subtask' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.workItem.delete({ where: { id: doomed.id } });

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    for (const title of ['A proposed epic', 'A proposed story', 'An orphaned proposal']) {
      expect({ title, trail: review.items.find((i) => i.title === title)!.parentTrail }).toEqual({
        title,
        trail: [],
      });
    }
  });

  // ── bug MOTIR-3191 — a proposal ABOUT an existing card sits where that card
  // sits ───────────────────────────────────────────────────────────────────────
  //
  // A `modify` / `remove` carries no `parentRef` and cannot: its parent is the
  // live card's, and the contract forbids a proposal from re-parenting anything.
  // Placement read off `parentRef` alone therefore came back null, which every
  // consumer draws as A ROOT — so an amendment to a subtask five levels down drew
  // beside the `add`s the plan rules reserve the project root for. A plan of two
  // modifies was declined on exactly that reading, and the reading was correct.
  //
  // These read the placement BACK through the review DTO, which is the only place
  // the canvas, the breadcrumb and `get_plan` all agree from.

  it('places a MODIFY at its target’s live position — parent, trail and all (MOTIR-3191)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'The agent loop');
    const story = await seedChild(fx, 'story', 'Plan review', epic.id);
    const task = await seedChild(fx, 'task', 'The canvas', story.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Amend one card' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: task.id, patch: { title: 'The canvas, redrawn' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items[0]!;

    // THE assertion: the target's position, not the root.
    expect(modify.parentNodeId).toBe(story.id);
    expect(modify.parentIdentifier).toBe(story.identifier);
    expect(modify.parentTitle).toBe('Plan review');
    expect(modify.parentKind).toBe('story');
    // …and the whole committed chain down to it, so the canvas opens at the level
    // the card lives on rather than at the project root.
    expect(modify.parentTrail).toEqual([
      { id: epic.id, identifier: epic.identifier, title: 'The agent loop' },
      { id: story.id, identifier: story.identifier, title: 'Plan review' },
    ]);
  });

  it('places a REMOVE the same way — the op differs, the reason does not (MOTIR-3191)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'Payouts');
    const task = await seedChild(fx, 'task', 'Manual payout export', epic.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Drop one card' }, fx.ctx);
    await plansService.addProposals(plan.id, [{ op: 'remove', workItemId: task.id }], fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]!.parentNodeId).toBe(epic.id);
    expect(review.items[0]!.parentTrail).toEqual([
      { id: epic.id, identifier: epic.identifier, title: 'Payouts' },
    ]);
  });

  it('leaves a MODIFY of a genuinely ROOT card at the root (MOTIR-3191)', async () => {
    // The inherited parent is the TARGET's parent, whatever that is — including
    // none. A root card's amendment belongs at the root, and reads as one.
    const fx = await makeWorkItemFixture();
    const rootCard = await seedChild(fx, 'epic', 'A root epic');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Amend a root' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: rootCard.id, patch: { title: 'A root epic, renamed' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]!.parentNodeId).toBeNull();
    expect(review.items[0]!.parentIdentifier).toBeNull();
    expect(review.items[0]!.parentTrail).toEqual([]);
  });

  it('DEGRADES a modify whose target is gone to the root rendering (MOTIR-3191)', async () => {
    // No target ⇒ no parent to inherit. The same degrade-rather-than-throw
    // contract an archived `parentRef` already had (MOTIR-3083 AC 5).
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'Doomed branch');
    const doomed = await seedChild(fx, 'task', 'Doomed card', epic.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Amend a ghost' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: doomed.id, patch: { title: 'Never lands' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.workItem.delete({ where: { id: doomed.id } });

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]!.targetMissing).toBe(true);
    expect(review.items[0]!.parentNodeId).toBeNull();
    expect(review.items[0]!.parentTrail).toEqual([]);
  });

  it('places BOTH halves of a mixed plan — an add under its proposed parent, a modify under its target’s (MOTIR-3191)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'The agent loop');
    const storyA = await seedChild(fx, 'story', 'Where the add goes', epic.id);
    const storyB = await seedChild(fx, 'story', 'Where the target lives', epic.id);
    const target = await seedChild(fx, 'task', 'An existing card', storyB.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'A mixed plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', parentRef: storyA.id, proposedFields: { title: 'A brand new card' } },
        { op: 'modify', workItemId: target.id, patch: { title: 'An existing card, re-scoped' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const add = review.items.find((i) => i.op === 'add')!;
    const modify = review.items.find((i) => i.op === 'modify')!;

    // Two different levels — which is the drill-down model working, not a gap.
    expect(add.parentNodeId).toBe(storyA.id);
    expect(modify.parentNodeId).toBe(storyB.id);
    expect(modify.parentTrail.map((c) => c.id)).toEqual([epic.id, storyB.id]);
    // Neither is at the root, and the two do not collapse onto one level.
    expect(add.parentNodeId).not.toBe(modify.parentNodeId);
  });

  // ── bug MOTIR-3366 — a proposed EDGE reaches the canvas whichever CARRIER it
  // travels on ────────────────────────────────────────────────────────────────
  //
  // A plan's `blocked_by` edges have TWO carriers: an `add` names its blockers in
  // its own `blockedByRefs`, and a `modify` names them in `patch.blockedByAdd` —
  // the only way to propose an edge ONTO a card that already exists, and so the
  // shape every mid-run correction takes (`add` the prerequisite, `modify` the
  // in-flight card to be blocked by it, one approval for both).
  //
  // `blockedByNodeIds` was built from the first carrier alone, so the second
  // reached the review model as an EMPTY array: `mergePlanLevel` had nothing to
  // draw, and the added card rendered beside the card it blocks with no line
  // between them. Ten such proposals were approved in the dogfooding tenant and
  // not one drew its arrow — while the same patch was already being read eleven
  // lines away to produce the `links` diff row. Present as a counted word,
  // absent as a shape.
  //
  // These assert the EDGE SET the canvas consumes, which is the only place the
  // two carriers are supposed to become one thing.

  it('resolves a MODIFY’s `patch.blockedByAdd` into `blockedByNodeIds` (MOTIR-3366)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await seedChild(fx, 'story', 'Warm sync worker');
    const inFlight = await seedChild(fx, 'task', 'The worker lifecycle', story.id);

    // The correction shape: propose the prerequisite, and block the in-flight
    // card on it, so one approval lands both halves.
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Split the runtime out' },
      fx.ctx,
    );
    const afterAdd = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: story.id,
          proposedFields: { title: 'The RESIDENT worker runtime' },
        },
      ],
      fx.ctx,
    );
    const addId = afterAdd.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: inFlight.id,
          // ⚠️ ONE ref, not two. The duplicate this test used to send is now
          // refused at the APPEND (MOTIR-3573) — a blocker named twice is a
          // pure property of the proposal set, so it never reaches a plan at
          // all and the review layer can no longer be handed one. That
          // rejection is covered in `authoringGates.test.ts`; the subject here
          // is the RESOLUTION of the ref into `blockedByNodeIds`.
          patch: { blockedByAdd: [`planItem:${addId}`] },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const add = review.items.find((i) => i.op === 'add')!;
    const modify = review.items.find((i) => i.op === 'modify')!;

    // THE assertion: the edge the plan proposes, as the canvas reads it —
    // blocker → blocked, resolved to NODE ids, de-duplicated.
    expect(modify.blockedByNodeIds).toEqual([add.nodeId]);
    // …and both ends sit on the same level, so `mergePlanLevel` can draw it.
    expect(add.parentNodeId).toBe(story.id);
    expect(modify.parentNodeId).toBe(story.id);
    // The `links` diff row is a SECOND reader of the patch, not a move of the
    // first: it counts the patch's REFS, while `blockedByNodeIds` is what will
    // be DRAWN. The two still answer separately — they simply agree at one now
    // that a duplicate can no longer be appended (MOTIR-3573), so the count the
    // diff row reports is the count the plan actually wrote.
    expect(modify.changes).toContainEqual({ field: 'links', from: null, to: '+1 blocker' });
  });

  it('follows the node id an approved `add` BECAME — the edge survives materialize (MOTIR-3366)', async () => {
    // The intra-plan temp-ref resolves to the referenced item's NODE id, which
    // moves from the plan-item id to the created work item's at approve
    // (MOTIR-3160). An edge that resolved to the pre-approval id would point at
    // a node that is no longer on the canvas.
    const fx = await makeWorkItemFixture();
    const story = await seedChild(fx, 'story', 'Offboarding');
    const inFlight = await seedChild(fx, 'task', 'Reach the live worker', story.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Approve me' }, fx.ctx);
    const afterAdd = await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: story.id, proposedFields: { title: 'The orchestrator port' } }],
      fx.ctx,
    );
    const addId = afterAdd.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: inFlight.id, patch: { blockedByAdd: [`planItem:${addId}`] } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const approved = await plansService.approvePlan(plan.id, fx.ctx);
    const createdId = approved.items.find((i) => i.op === 'add')!.workItemId;

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const add = review.items.find((i) => i.op === 'add')!;
    const modify = review.items.find((i) => i.op === 'modify')!;

    expect(createdId).not.toBeNull();
    expect(add.nodeId).toBe(createdId);
    expect(add.nodeId).not.toBe(add.planItemId);
    expect(modify.blockedByNodeIds).toEqual([createdId]);
  });

  it('still resolves an ADD’s OWN `blockedByRefs` — the carrier that always worked (MOTIR-3366)', async () => {
    // The control. A committed blocker stays as-is, an intra-plan one resolves
    // to that proposal's node id, and the two carriers do not interfere.
    const fx = await makeWorkItemFixture();
    const story = await seedChild(fx, 'story', 'Incremental indexing');
    const committed = await seedChild(fx, 'task', 'The decision', story.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Two blockers' }, fx.ctx);
    const afterFirst = await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: story.id, proposedFields: { title: 'The measurement' } }],
      fx.ctx,
    );
    const firstId = afterFirst.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: story.id,
          blockedByRefs: [committed.id, `planItem:${firstId}`],
          proposedFields: { title: 'The worker' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const first = review.items.find((i) => i.planItemId === firstId)!;
    const second = review.items.find((i) => i.planItemId !== firstId)!;

    expect(second.blockedByNodeIds).toEqual([committed.id, first.nodeId]);
    // Nothing was added to the proposal that carries no edges at all.
    expect(first.blockedByNodeIds).toEqual([]);
  });

  it('renders a description change as a DIFF of the live and proposed bodies, previewed (MOTIR-3191)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card whose body moved');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { descriptionMd: '# Before\n\nThe body   as first   planned.' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Rewrite plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { descriptionMd: '# After\n\nThe body the re-scope leaves behind.' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    // Whitespace squeezed (a body is multi-paragraph, the cell is one line), and
    // the ACTUAL values on both sides — this cell used to read `— → updated`.
    expect(review.items[0]!.changes.find((c) => c.field === 'description')).toEqual({
      field: 'description',
      from: '# Before The body as first planned.',
      to: '# After The body the re-scope leaves behind.',
    });
  });

  it('CAPS each side of a prose diff so a long body cannot ride the wire whole (MOTIR-3191)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card with a long body');
    const long = 'x'.repeat(400);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Long plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { descriptionMd: long } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const change = review.items[0]!.changes.find((c) => c.field === 'description')!;
    // 140 characters, the last of them the ellipsis that says so.
    expect(change.to).toHaveLength(140);
    expect(change.to!.endsWith('…')).toBe(true);
    // Nothing there before ⇒ the old side is null, not an empty string.
    expect(change.from).toBeNull();
  });

  // ── MOTIR-3160 (bug MOTIR-3154) — the DECIDED review model ────────────────
  //
  // Two seams that destroyed or mis-keyed the data a decided card is drawn from.
  // Both are read BACK through the review DTO here, which is where the drift
  // would otherwise only show up as a canvas that draws nothing (declined) or a
  // keyless duplicate node (approved).

  it('returns a DECLINED plan its proposals — the rows are the record of the decision', async () => {
    const fx = await makeWorkItemFixture();
    const modifyTarget = await seedItem(fx, 'Left alone');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Refused plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'Never created', kind: 'task' } },
        { op: 'modify', workItemId: modifyTarget.id, patch: { title: 'Never applied' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.declinePlan(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);

    expect(review.status).toBe('declined');
    expect(review.itemCount).toBe(2);
    expect(review.items).toHaveLength(2);
    expect(review.items.map((i) => i.op).sort()).toEqual(['add', 'modify']);
    expect(review.decidedByName).not.toBeNull();
    expect(lifecycleKinds(review.history)).toEqual(['created', 'planned', 'declined']);
    // MOTIR-3189 — a plan a person read and rejected keeps the `declined` event
    // and the original wording. It is the OTHER two endings that had to change.
    expect(review.decisionReason).toBe('reviewed');

    // The refused `add` never became anything, so it keys by its own id and has
    // no identifier — inventing one would be the surface asserting a work item
    // that does not exist.
    const add = review.items.find((i) => i.op === 'add')!;
    expect(add.nodeId).toBe(add.planItemId);
    expect(add.identifier).toBeNull();
    expect(add.status).toBeNull();
    expect(add.title).toBe('Never created');
  });

  it('keys a MATERIALIZED add by the work item it became, and names it', async () => {
    const fx = await makeWorkItemFixture();

    const plan = await plansService.createPlan(fx.projectId, { title: 'Accepted plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Becomes a real card', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    // BEFORE the decision: not about anything yet.
    const before = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const pending = before.items[0]!;
    expect(pending.nodeId).toBe(pending.planItemId);
    expect(pending.identifier).toBeNull();
    expect(pending.status).toBeNull();

    await plansService.approvePlan(plan.id, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Becomes a real card' },
    });
    const after = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const accepted = after.items[0]!;

    // AFTER: the SAME node as the committed item, not a keyless ghost beside it.
    expect(accepted.nodeId).toBe(created.id);
    expect(accepted.nodeId).not.toBe(accepted.planItemId);
    expect(accepted.identifier).toBe(created.identifier);
    expect(accepted.status).toBe(created.status);
  });

  it('resolves an intra-plan ref to the referenced add NODE id once it materializes', async () => {
    // The rule above makes a node id differ from the plan-item id, so a
    // `planItem:<id>` parent / blocker ref can no longer resolve to the
    // referenced id itself — it has to follow the referenced item to its node,
    // or an approved parent's children point at a node that is not on the canvas.
    const fx = await makeWorkItemFixture();

    const plan = await plansService.createPlan(fx.projectId, { title: 'Two layers' }, fx.ctx);
    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Proposed parent', kind: 'story' } }],
      fx.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: `planItem:${first.items[0]!.id}`,
          proposedFields: { title: 'Proposed child', kind: 'task' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const parent = review.items.find((i) => i.title === 'Proposed parent')!;
    const child = review.items.find((i) => i.title === 'Proposed child')!;

    expect(parent.nodeId).not.toBe(parent.planItemId); // materialized
    expect(child.parentNodeId).toBe(parent.nodeId); // …and the child follows it
    expect(parent.hasChildren).toBe(true);
  });

  it('leaves modify / remove node-id resolution exactly as it was', async () => {
    const fx = await makeWorkItemFixture();
    const modifyTarget = await seedItem(fx, 'Modify me');
    const removeTarget = await seedItem(fx, 'Remove me');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Pin plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: modifyTarget.id, patch: { title: 'Modified' } },
        { op: 'remove', workItemId: removeTarget.id },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    const remove = review.items.find((i) => i.op === 'remove')!;

    expect(modify.nodeId).toBe(modifyTarget.id);
    expect(modify.identifier).toBe(modifyTarget.identifier);
    expect(remove.nodeId).toBe(removeTarget.id);
    expect(remove.identifier).toBe(removeTarget.identifier);
  });

  // ── The target status's own IDENTITY (bug MOTIR-3170) ────────────────────
  //
  // The canvas chip received a bare status KEY and narrowed it against a
  // six-member literal, so a `modify` whose live target had an open pull request
  // drew as "To Do". The key alone can never fix it — a CUSTOM workflow status
  // has no entry in the `labels.defaultStatus` catalog the chip named itself
  // from — so the review model carries the status's label + category too.
  //
  // The label and category are read off the SAME `target` as `status`, so they
  // follow MOTIR-3160's rule directly: whenever a status is non-null it is
  // nameable, including on a materialized `add` (asserted below).
  it("carries the target status's LABEL and CATEGORY on a modify", async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'A built card');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { status: 'implemented' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Status plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: target.id, patch: { priority: 'high' } },
        { op: 'add', proposedFields: { title: 'A new card', kind: 'task' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    // ⚠️ `planning`, not `implemented`, since MOTIR-5645 — and the case is still
    // about what it was about. A plan PARKS its committed targets when it
    // appends, so by the time a reviewer reads the plan the card is at
    // `planning`; what this pins is that the surface names the target's LIVE
    // status with its label and category rather than defaulting them, whatever
    // that status happens to be.
    expect(modify.status).toBe('planning');
    expect(modify.statusLabel).toBe('Planning');
    expect(modify.statusCategory).toBe('in_progress');

    // An UN-MATERIALIZED `add` has no live target, so it has no status at all —
    // not a defaulted one, which is precisely the failure this card is about.
    const add = review.items.find((i) => i.op === 'add')!;
    expect(add.status).toBeNull();
    expect(add.statusLabel).toBeNull();
    expect(add.statusCategory).toBeNull();
  });

  it('names the status of a MATERIALIZED add too — label and category track `status`', async () => {
    // MOTIR-3160 gave an approved `add` its live target, so it now HAS a status.
    // A status the surface can show but not name is the same defect one card
    // over, so the two identity fields have to move with it rather than keep the
    // `op === 'add'` guard that rule removed.
    const fx = await makeWorkItemFixture();

    const plan = await plansService.createPlan(fx.projectId, { title: 'Accepted' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Becomes real and named', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Becomes real and named' },
    });
    await adminDb.workItem.update({
      where: { id: created.id },
      data: { status: 'implemented' },
    });

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const accepted = review.items[0]!;
    expect(accepted.status).toBe('implemented');
    expect(accepted.statusLabel).toBe('Implemented');
    expect(accepted.statusCategory).toBe('in_progress');
  });

  it("carries a CUSTOM workflow status's own label — the catalog cannot name it", async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Waiting on counsel');
    const anyStatus = await adminDb.workflowStatus.findFirst({
      where: { projectId: fx.projectId },
    });
    await adminDb.workflowStatus.create({
      data: {
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        key: 'awaiting_legal',
        label: 'Awaiting legal',
        category: 'todo',
        position: `${anyStatus!.position}z`,
        isInitial: false,
      },
    });
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { status: 'awaiting_legal' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Custom plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { priority: 'high' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(modify.statusLabel).toBe('Awaiting legal');
    expect(modify.statusCategory).toBe('todo');
  });

  // MOTIR-3189 — `declined` covers three histories, and until this card the
  // service pushed ONE `declined` event for all of them, so the rail rendered a
  // plan that died halfway through generating exactly like one somebody read and
  // rejected: you could see that it ended, not why. The reason is a private
  // column rather than a fourth `PlanStatus` member (AMENDMENT 6), so the
  // TIMELINE is where the difference has to become visible.
  describe('the timeline distinguishes the three endings (MOTIR-3189)', () => {
    /** A `generating` plan holding one proposal — the shape a crashed generation
     *  or an abandoned authoring pass leaves. Deliberately not `markPlanned`ed,
     *  which is what keeps `plannedAt` null. */
    async function halfWritten(fx: WorkItemFixture): Promise<string> {
      const plan = await plansService.createPlan(fx.projectId, { title: 'Half' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title: 'Got this far', kind: 'task' } }],
        fx.ctx,
      );
      return plan.id;
    }

    it('a DISCARDED plan reads `discarded`, and has no `planned` event at all', async () => {
      const fx = await makeWorkItemFixture();
      const planId = await halfWritten(fx);
      await plansService.declinePlan(planId, fx.ctx);

      const review = await planReviewService.getPlanReview(planId, fx.ctx);

      // No `planned` event: the generation frontier never closed, and the
      // timeline says so by ABSENCE rather than by a back-filled timestamp.
      expect(lifecycleKinds(review.history)).toEqual(['created', 'discarded']);
      expect(review.plannedAt).toBeNull();
      expect(review.decisionReason).toBe('discarded');
      // A PERSON discarded it, so the decider is named — which is exactly what
      // separates this ending from the sweep's.
      //
      // ⚠️ Selected BY KIND (MOTIR-4136), and this one was PASSING FOR THE
      // WRONG REASON. It read `history.at(-1)`, and the last row is
      // `halfWritten`'s own `appended` event whenever that ties with the
      // decision on the millisecond — a content event carries an actor too, so
      // `not.toBeNull()` was satisfied by the row this assertion is not about.
      // Green either way, which is why nothing ever drew attention to it; the
      // `abandoned` sibling below is the same shape with the polarity that
      // fails.
      expect(lifecycleEvent(review.history, 'discarded').byName).not.toBeNull();
      // And the proposal it managed to produce survives to be read.
      expect(review.itemCount).toBe(1);
      expect(review.items).toHaveLength(1);
    });

    it('an ABANDONED plan reads `abandoned`, with NOBODY named', async () => {
      // The sweep's ending. It writes `decisionReason: 'abandoned'` and leaves
      // `decidedById` null, so the row is the one case where a decision event
      // carries no actor — the surface must not render it as a person's call.
      const fx = await makeWorkItemFixture();
      const planId = await halfWritten(fx);
      await adminDb.plan.update({
        where: { id: planId },
        data: { status: 'declined', decidedAt: new Date(), decisionReason: 'abandoned' },
      });

      const review = await planReviewService.getPlanReview(planId, fx.ctx);

      expect(lifecycleKinds(review.history)).toEqual(['created', 'abandoned']);
      expect(review.decisionReason).toBe('abandoned');
      expect(review.decidedByName).toBeNull();
      // The `abandoned` event ITSELF, not the last row (MOTIR-4136).
      // `halfWritten` appends a proposal attributed to the Owner, and
      // `mergeTimeline` puts the derived event FIRST at an equal timestamp — so
      // in the millisecond where the two collide, `abandoned` is never last and
      // `history.at(-1)` read the append. Nothing in the product was wrong: the
      // question was.
      expect(lifecycleEvent(review.history, 'abandoned').byName).toBeNull();
    });

    it('a `declined` row with NO recorded reason keeps the ORIGINAL event — a null is not a fourth ending', async () => {
      // Every row written before the column existed. `null` means *not
      // recorded*, and the pre-column wording is the one that was true for
      // those plans, so the timeline must fall back rather than guess.
      const fx = await makeWorkItemFixture();
      const plan = await plansService.createPlan(fx.projectId, { title: 'Legacy' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title: 'Old', kind: 'task' } }],
        fx.ctx,
      );
      await plansService.markPlanned(plan.id, fx.ctx);
      await adminDb.plan.update({
        where: { id: plan.id },
        data: { status: 'declined', decidedAt: new Date(), decisionReason: null },
      });

      const review = await planReviewService.getPlanReview(plan.id, fx.ctx);

      expect(review.decisionReason).toBeNull();
      expect(lifecycleKinds(review.history)).toEqual(['created', 'planned', 'declined']);
    });

    it('an APPROVED plan carries no reason — an approval has one history', async () => {
      const fx = await makeWorkItemFixture();
      const plan = await plansService.createPlan(fx.projectId, { title: 'Yes' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title: 'Built', kind: 'task' } }],
        fx.ctx,
      );
      await plansService.markPlanned(plan.id, fx.ctx);
      await plansService.approvePlan(plan.id, fx.ctx);

      const review = await planReviewService.getPlanReview(plan.id, fx.ctx);

      expect(lifecycleKinds(review.history)).toEqual(['created', 'planned', 'approved']);
      expect(review.decisionReason).toBeNull();
    });
  });

  it('throws PlanNotFoundError for a missing plan', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      planReviewService.getPlanReview('plan_does_not_exist', fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });
});

// ── THE REMOVAL CARRIER (bug MOTIR-4092) ────────────────────────────────────
//
// The MOTIR-3366 block above resolved the two carriers that ADD an edge, and
// deliberately left `patch.blockedByRemove` out — an edge the plan DELETES is
// not a blocker the proposal declares, and drawing it as one would say the
// opposite of what the plan proposes. That reasoning was right; the half it
// deferred to "its own card" is this one. Unread, a removal reached the canvas
// as NOTHING — `mergePlanLevel` starts from the committed deps verbatim, so the
// edge on its way out kept rendering exactly like one being kept.
describe('planReviewService — the edge a plan REMOVES', () => {
  it('resolves a MODIFY’s `patch.blockedByRemove` into `blockedByRemovedNodeIds`', async () => {
    const fx = await makeWorkItemFixture();
    const story = await seedChild(fx, 'story', 'The MAY-I-START gate');
    const first = await seedChild(fx, 'task', 'Withdraw the ask', story.id);
    const second = await seedChild(fx, 'task', 'Build the surface it moves to', story.id);
    // The committed edge, pointing the WRONG way: the card that BUILDS the
    // surface is blocked by the card that puts a tool on it.
    await workItemsService.linkWorkItems(
      { fromId: second.id, toId: first.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const plan = await plansService.createPlan(fx.projectId, { title: 'Invert the edge' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: second.id, patch: { blockedByRemove: [first.id] } },
        { op: 'modify', workItemId: first.id, patch: { blockedByAdd: [second.id] } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    // A `modify`'s node id IS its target's work-item id, which is what makes the
    // two halves of the swap findable here.
    const remover = review.items.find((i) => i.nodeId === second.id)!;
    const adder = review.items.find((i) => i.nodeId === first.id)!;

    // THE assertion: the removal reaches the canvas on its OWN channel.
    expect(remover.blockedByRemovedNodeIds).toEqual([first.id]);
    // …and is NOT folded into the declared-blockers set, which would draw it as
    // an arriving dependency and invert the plan's meaning.
    expect(remover.blockedByNodeIds).toEqual([]);
    // The other half of the swap is unaffected.
    expect(adder.blockedByNodeIds).toEqual([second.id]);
    expect(adder.blockedByRemovedNodeIds).toEqual([]);
    // The `links` diff row is the SECOND reader of the same patch and still
    // reports the removal as a count — it always did, which is why the defect
    // was invisible on the list view and only wrong on the canvas.
    expect(remover.changes).toContainEqual({ field: 'links', from: null, to: '−1 blocker' });
  });

  it('is EMPTY for an `add` and for a `remove` — neither carries a patch', async () => {
    const fx = await makeWorkItemFixture();
    const story = await seedChild(fx, 'story', 'A story');
    const victim = await seedChild(fx, 'task', 'Superseded', story.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Mixed ops' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', parentRef: story.id, proposedFields: { title: 'A new card' } },
        { op: 'remove', workItemId: victim.id },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    for (const item of review.items) expect(item.blockedByRemovedNodeIds).toEqual([]);
  });
});

// ── THE THIRD CARRIER (bug MOTIR-4951) ──────────────────────────────────────
//
// The two blocks above resolve what a plan SAYS about edges: the two add
// carriers, and the removal on its own channel. Both are complete for a proposal
// that stays where it is, because the canvas gets everything else from the
// COMMITTED level the roadmap read returned.
//
// A `modify` that RE-PARENTS its target (MOTIR-3859) is the case that breaks
// that arrangement, and it breaks it silently. Reported by Yue on a live plan:
// *"before I approved the plan I don't see the edge from 4942 to 4925, after I
// approved the plan I see the edge."* The edge was committed before the plan was
// written and untouched by it — the card was simply not yet a child of the level
// it was drawn on, so the level's own read did not carry it, and a relocation
// proposes no edge for the carriers above to carry.
//
// What the review model owes, therefore, is what the moving card BRINGS. Its
// blocker's STATUS rides along because the canvas's committed treatment is
// status-derived and the level builder cannot look it up: the blocker may be a
// card this same plan is relocating too, in which case it is not in the roadmap
// read for that level either — which is exactly the reported fixture.
describe('planReviewService — the committed edges a proposal BRINGS', () => {
  it('carries a re-parented target’s committed blockers, with the blocker’s doneness', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'Approval gates');
    // Two ROOT cards with a committed edge between them — the reported shape.
    const design = await seedChild(fx, 'task', 'Design the acceptance-video gate');
    const build = await seedChild(fx, 'task', 'The per-project switch');
    await workItemsService.linkWorkItems(
      { fromId: build.id, toId: design.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    // The plan moves BOTH onto the epic's level, and proposes no edge — because
    // the edge already exists.
    const plan = await plansService.createPlan(fx.projectId, { title: 'Adopt the pair' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: design.id, patch: { parentRef: epic.id } },
        { op: 'modify', workItemId: build.id, patch: { parentRef: epic.id } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const blocked = review.items.find((i) => i.nodeId === build.id)!;
    const blocker = review.items.find((i) => i.nodeId === design.id)!;

    // THE assertion: the edge the plan does not state reaches the canvas anyway.
    expect(blocked.committedBlockedBy).toEqual([{ nodeId: design.id, isDone: false }]);
    // …and it is not folded into either carrier, both of which are correctly
    // empty: the plan proposes no edge and removes none.
    expect(blocked.blockedByNodeIds).toEqual([]);
    expect(blocked.blockedByRemovedNodeIds).toEqual([]);
    // The blocker itself brings nothing — the edge is directional.
    expect(blocker.committedBlockedBy).toEqual([]);
    // Both land on the epic's level, so `mergePlanLevel` can draw it there.
    expect(blocked.parentNodeId).toBe(epic.id);
    expect(blocker.parentNodeId).toBe(epic.id);
  });

  it('reports `isDone` off the blocker’s live status', async () => {
    // The half the level builder cannot compute for itself. A committed edge is
    // drawn `firm` once its blocker is `done` and `pending` while it is not, and
    // the drawing must agree with the level the reviewer gets AFTER approve.
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'An epic');
    const blocker = await seedChild(fx, 'task', 'Already shipped');
    const blocked = await seedChild(fx, 'task', 'Waiting on it');
    await workItemsService.linkWorkItems(
      { fromId: blocked.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await adminDb.workItem.update({ where: { id: blocker.id }, data: { status: 'done' } });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Move it' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: blocked.id, patch: { parentRef: epic.id } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]!.committedBlockedBy).toEqual([{ nodeId: blocker.id, isDone: true }]);
  });

  it('is EMPTY for an un-materialized `add` — it is not a work item yet', async () => {
    const fx = await makeWorkItemFixture();
    const story = await seedChild(fx, 'story', 'A story');

    const plan = await plansService.createPlan(fx.projectId, { title: 'A new card' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: story.id, proposedFields: { title: 'A new card' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]!.committedBlockedBy).toEqual([]);
  });

  it('EXCLUDES an archived blocker, as every readiness read does', async () => {
    // A stale edge to a soft-removed card must not phantom-draw an arrow on the
    // surface a plan is approved from, for the same reason it must not
    // phantom-gate a sprint.
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'An epic');
    const gone = await seedChild(fx, 'task', 'Retired');
    const blocked = await seedChild(fx, 'task', 'Still live');
    await workItemsService.linkWorkItems(
      { fromId: blocked.id, toId: gone.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await adminDb.workItem.update({ where: { id: gone.id }, data: { archivedAt: new Date() } });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Move it' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: blocked.id, patch: { parentRef: epic.id } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]!.committedBlockedBy).toEqual([]);
  });
});

// ── THE NAMING STUBS (bug MOTIR-5387) ───────────────────────────────────────
//
// The edge carriers name a blocker by node id, which is all a within-level arrow
// needs. A blocker on ANOTHER level is drawn with the roadmap's off-level
// treatment — a ghost anchor NAMING it — and before approve nothing on the review
// model could name it, so the canvas drew no edge, no anchor and no flag. The
// stub is what an anchor needs, and `parentNodeId` is where the blocker will SIT,
// which is how the canvas tells "off this level" from "a member it did not read".
describe('planReviewService — the blockers a proposal names, NAMED', () => {
  it('names a COMMITTED blocker under another story — key, title, doneness and parent', async () => {
    const fx = await makeWorkItemFixture();
    const here = await seedChild(fx, 'story', 'The story the card lands in');
    const there = await seedChild(fx, 'story', 'Another story');
    const blocker = await seedChild(fx, 'task', 'The blocker elsewhere', there.id);
    await adminDb.workItem.update({ where: { id: blocker.id }, data: { status: 'done' } });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Cross-story' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: here.id,
          blockedByRefs: [blocker.id],
          proposedFields: { title: 'The new card' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]!.blockerStubs).toEqual([
      {
        nodeId: blocker.id,
        identifier: blocker.identifier,
        title: 'The blocker elsewhere',
        isDone: true,
        parentNodeId: there.id,
        // The two stories are not linked, so over the projection the edge is
        // UNCOVERED — flagged whatever the blocker's status (MOTIR-6362).
        coverage: 'uncovered',
      },
    ]);
  });

  it('names a blocker that is itself a PROPOSAL — no key, its proposed title, the parent the plan gives it', async () => {
    const fx = await makeWorkItemFixture();
    const here = await seedChild(fx, 'story', 'Here');
    const there = await seedChild(fx, 'story', 'There');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Two new cards' }, fx.ctx);
    const afterFirst = await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: there.id, proposedFields: { title: 'A card the plan adds there' } }],
      fx.ctx,
    );
    const firstId = afterFirst.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: here.id,
          blockedByRefs: [`planItem:${firstId}`],
          proposedFields: { title: 'A card it blocks here' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const blocked = review.items.find((i) => i.planItemId !== firstId)!;
    expect(blocked.blockerStubs).toEqual([
      {
        nodeId: firstId,
        identifier: null,
        title: 'A card the plan adds there',
        isDone: false,
        parentNodeId: there.id,
        coverage: 'uncovered',
      },
    ]);
  });

  it('names the blocker a MODIFY adds through `patch.blockedByAdd`', async () => {
    const fx = await makeWorkItemFixture();
    const here = await seedChild(fx, 'story', 'Here');
    const there = await seedChild(fx, 'story', 'There');
    const target = await seedChild(fx, 'task', 'The card being amended', here.id);
    const blocker = await seedChild(fx, 'task', 'Its new blocker', there.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Add an edge' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { blockedByAdd: [blocker.id] } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]!.blockerStubs).toEqual([
      {
        nodeId: blocker.id,
        identifier: blocker.identifier,
        title: 'Its new blocker',
        isDone: false,
        parentNodeId: there.id,
        coverage: 'uncovered',
      },
    ]);
  });

  it('names a COMMITTED edge’s blocker at the level the plan MOVES it to', async () => {
    // MOTIR-4951's fixture: both cards re-parented onto the epic, one blocked by
    // the other. The blocker's stub reports its DESTINATION, or the canvas would
    // call a card the plan puts beside the dependent "blocked elsewhere".
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'Approval gates');
    const design = await seedChild(fx, 'task', 'Design the acceptance-video gate');
    const build = await seedChild(fx, 'task', 'The per-project switch');
    await workItemsService.linkWorkItems(
      { fromId: build.id, toId: design.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const plan = await plansService.createPlan(fx.projectId, { title: 'Adopt the pair' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: design.id, patch: { parentRef: epic.id } },
        { op: 'modify', workItemId: build.id, patch: { parentRef: epic.id } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const blocked = review.items.find((i) => i.nodeId === build.id)!;
    expect(blocked.blockerStubs).toEqual([
      {
        nodeId: design.id,
        identifier: design.identifier,
        title: 'Design the acceptance-video gate',
        isDone: false,
        parentNodeId: epic.id,
        // Both land under the same epic: siblings, so the edge needs no parent
        // edge (MOTIR-6362).
        coverage: 'exempt',
      },
    ]);
  });

  it('adds NO read — the stubs ride the batched row read, however many blockers the plan names', async () => {
    const fx = await makeWorkItemFixture();
    const here = await seedChild(fx, 'story', 'Here');
    const there = await seedChild(fx, 'story', 'There');
    const blockers = [
      await seedChild(fx, 'task', 'B1', there.id),
      await seedChild(fx, 'task', 'B2', there.id),
      await seedChild(fx, 'task', 'B3', there.id),
    ];
    // ⚠️ ONE PARENT PER PLAN, since MOTIR-5645. This helper used to lay both
    // plans under `here`, and a plan now PARKS the committed `parentRef` of every
    // `add` it carries — so the second plan was refused with
    // `PlanTargetLockedError`, which is the one-holder-per-card rule working
    // rather than a defect. The two plans get their own container; nothing this
    // case measures depends on them sharing one.
    const planBlockedBy = async (parentId: string, refs: string[][]) => {
      const plan = await plansService.createPlan(fx.projectId, { title: 'Blocked' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        refs.map((blockedByRefs, n) => ({
          op: 'add' as const,
          parentRef: parentId,
          blockedByRefs,
          proposedFields: { title: `Card ${n}` },
        })),
        fx.ctx,
      );
      await plansService.markPlanned(plan.id, fx.ctx);
      return plan.id;
    };
    const alsoHere = await seedChild(fx, 'story', 'Here as well');
    const unblocked = await planBlockedBy(here.id, [[]]);
    const threeBlocked = await planBlockedBy(
      alsoHere.id,
      blockers.map((b) => [b.id]),
    );

    // Pass-through counters, never mocks: the reads still hit the real database.
    const rowReads = vi.spyOn(workItemRepository, 'findByIdsInWorkspace');
    const edgeReads = vi.spyOn(workItemLinkRepository, 'findBlockerEdgesForItems');

    await planReviewService.getPlanReview(unblocked, fx.ctx);
    const rowsForNone = rowReads.mock.calls.length;
    const edgesForNone = edgeReads.mock.calls.length;
    // The counters must be able to go RED.
    expect(rowsForNone).toBeGreaterThanOrEqual(1);
    rowReads.mockClear();
    edgeReads.mockClear();

    const review = await planReviewService.getPlanReview(threeBlocked, fx.ctx);
    expect(rowReads.mock.calls.length).toBe(rowsForNone);
    expect(edgeReads.mock.calls.length).toBe(edgesForNone);
    rowReads.mockRestore();
    edgeReads.mockRestore();

    expect(review.items.flatMap((i) => i.blockerStubs.map((s) => s.title)).sort()).toEqual([
      'B1',
      'B2',
      'B3',
    ]);
  });
});
