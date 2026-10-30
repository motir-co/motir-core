import { type GithubRepo } from '@/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planRevisionsService } from '@/lib/services/planRevisionsService';
import { planReviewService } from '@/lib/services/planReviewService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanItemPatch } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { randomToken } from '../../helpers/random';
import { organizationIdOf } from '../../helpers/organizationOf';

// ⚠️ THIS FILE'S SUBJECT WAS SUPERSEDED, AND IT IS AMENDED RATHER THAN DELETED
// (bug MOTIR-5640 · MOTIR-5646, superseding bug MOTIR-5359). The name is kept so
// every citation of it still lands.
//
// ── WHAT IT USED TO PIN ─────────────────────────────────────────────────────
// MOTIR-5359's RE-SCOPE RESET: approving a plan whose `modify` changed a card's
// title, body or repository walked that card back to the project's INITIAL
// status, keyed on `patchRescopes` / `resetsOnRescope`, and recorded the move on
// the modify's own revision as `diff.statusReset` with a `transition` /
// `plan_reset` arm.
//
// ── WHY IT CHANGED ──────────────────────────────────────────────────────────
// The product owner decided (2026-09-16) that approving a plan returns EVERY
// card the plan was about, not only the ones whose body changed:
//
//   "when the plan is accepted, the status is changed back to To Do or Blocked."
//
// So the mechanism moved one level out. Every plan now PARKS its committed
// targets at `planning` when it appends (MOTIR-5645), and the approve rests each
// of them at `blocked` or `todo` from the card's LIVE `blocked_by` EDGES
// (`lib/plans/restingStatus.ts`; `agent-authored-plans.md` AMENDMENT 16 D6–D8).
// `resolveRescopeReset` and `resetsOnRescope` are deleted.
//
// ── WHAT SURVIVES, AND IT IS THE GUARANTEE RATHER THAN THE MECHANISM ────────
// MOTIR-5359's actual complaint — *an `implemented` card goes on claiming that
// code matching the OLD body is on the remote* — still cannot happen, and the
// first case below is the same assertion it always was. What changed underneath
// is the TRAIL: the card now passes through `planning` on its way, so the status
// cells live on the park's and the resting move's revisions rather than on the
// modify's.
//
// ── AND THREE CASES INVERTED, each named where it stands ────────────────────
//   * a type / sizing / priority / edges-only patch used to KEEP the status. It
//     now rests the card too, because the trigger is the card being PARKED and
//     not the patch's contents.
//   * a `blockedByAdd` patch used to keep the status. It now rests at `blocked`,
//     which is D7's second row and the whole point of the loop-risk rule.
//   * the review diff used to emit a row only for a re-scope. It now emits one
//     for any parked target, and names BOTH outcomes rather than predicting one.
//
// ── AND BUG MOTIR-10102 TURNED TWO OF THEM BACK (Yue, 2026-10-30) ───────────
// A card that CLAIMS BUILT WORK (`implemented`, `in_review`, `approved`) is now
// decided by the re-scope move (`lib/plans/rescopeStatus.ts`), parked or not:
//   * a patch that changes only its type, size, priority, explanation, parent or
//     edges gives it back the status it was parked FROM, not `todo`;
//   * a re-scope sends it to `blocked` / `in_progress` / `todo` — `in_progress`
//     while a run is working it — and the review names those three.
// A card at `todo`, `blocked` or `in_progress` still rests at `todo` / `blocked`
// exactly as D7 says. The conversation-plan half of the bug, and the anchor a
// session parks, are pinned in `tests/planning/approveRescopeMovesStatus.test.ts`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedCard(fx: WorkItemFixture, title = 'The card'): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, descriptionMd: 'The old body.' },
    fx.ctx,
  );
  return dto.id;
}

/** Put a card at `status` without walking the workflow — the statuses past
 *  `implemented` are written by CI and by gates, not by a person's move. */
async function setStatus(id: string, status: string): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { status } });
}

async function approveModify(
  fx: WorkItemFixture,
  workItemId: string,
  patch: PlanItemPatch,
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await plansService.addProposals(plan.id, [{ op: 'modify', workItemId, patch }], fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
  return plan.id;
}

async function row(id: string) {
  return adminDb.workItem.findUniqueOrThrow({ where: { id } });
}

/** Every status change on a card, oldest first — the TRAIL, which is what
 *  MOTIR-5646 changed. A parked target now passes through `planning`, so the
 *  status cells are spread across the park's revision and the resting move's
 *  rather than riding the modify's. */
async function statusTrail(id: string): Promise<Array<{ from: unknown; to: unknown }>> {
  const revisions = await adminDb.workItemRevision.findMany({
    // `changeKind: 'updated'` excludes the CREATE, whose diff carries
    // `status: { from: null, to: <initial> }` — the card's birth, not a move.
    where: { workItemId: id, changeKind: 'updated' },
    orderBy: { changedAt: 'asc' },
  });
  return revisions
    .map((r) => (r.diff as Record<string, unknown>).status as { from: unknown; to: unknown })
    .filter((cell): cell is { from: unknown; to: unknown } => Boolean(cell));
}

async function modifyRevisionDiff(id: string): Promise<Record<string, unknown>> {
  const revisions = await adminDb.workItemRevision.findMany({
    where: { workItemId: id, changeKind: 'updated' },
    orderBy: { changedAt: 'asc' },
  });
  return revisions.at(-1)!.diff as Record<string, unknown>;
}

describe('approvePlan — every parked target comes back at Blocked or To Do', () => {
  it('an `implemented` card with a new description is at To Do after approve (MOTIR-5359s guarantee, MOTIR-5646s mechanism)', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    // The reproduction the card names: todo → in_progress → implemented.
    await workItemsService.updateStatus(card, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(card, 'implemented', fx.ctx);
    await adminDb.workItem.update({ where: { id: card }, data: { sessionBranch: 'subtask/old' } });

    const planId = await approveModify(fx, card, { descriptionMd: 'A different body.' });

    const after = await row(card);
    expect(after.descriptionMd).toBe('A different body.');
    expect(after.status).toBe('todo');
    // The integration branch goes with the claim — readiness would otherwise treat
    // the reset card as satisfied for its dependents.
    expect(after.sessionBranch).toBeNull();

    // ⚠️ THE TRAIL, not the outcome, is what MOTIR-5646 changed. The card went
    // `implemented → planning` when the plan APPENDED (the park) and
    // `planning → todo` when it was approved (the resting status), so the status
    // cells live on those two revisions and NOT on the modify's — which used to
    // carry `diff.statusReset` with its arm. Both are gone with
    // `resolveRescopeReset`.
    const diff = await modifyRevisionDiff(card);
    expect(diff.statusReset).toBeUndefined();
    // The TAIL of the trail: this case walks the card to `implemented` through
    // the real edges first, so the two moves the plan made are the last two.
    expect((await statusTrail(card)).slice(-2)).toEqual([
      { from: 'implemented', to: 'planning' },
      { from: 'planning', to: 'todo' },
    ]);
    // The plan is still what did it, and the lock it held is gone.
    expect(planId).toBeTruthy();
    expect(await adminDb.planTargetLock.count({ where: { workItemId: card } })).toBe(0);
  });

  it('a `title` patch resets too', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    await setStatus(card, 'implemented');

    await approveModify(fx, card, { title: 'A re-scoped title' });

    const after = await row(card);
    expect(after.title).toBe('A re-scoped title');
    expect(after.status).toBe('todo');
  });

  it('a target-repository patch resets too', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web', 'web');
    await establishRepo(fx, 'acme-api', 'api');
    const card = await seedCard(fx);
    await setStatus(card, 'implemented');

    await approveModify(fx, card, { targetRepo: 'acme-api' });

    const after = await row(card);
    expect(after.targetRepo).toBe('acme-api');
    expect(after.status).toBe('todo');
  });

  // ⚠️ THE `arm` IS GONE, and so is the reason it existed. MOTIR-5359 had to
  // write `plan_reset` past a `restricted` graph because it moved cards to the
  // INITIAL status from `implemented` / `in_review` / `approved`, and the
  // workflow declares no such edge. The resting status moves them from
  // `planning`, and MOTIR-5643 declares `planning → todo` and
  // `planning → blocked` — so every one of these is now an ORDINARY transition
  // and there is no second arm to record.
  it.each([['todo'], ['blocked'], ['in_progress'], ['implemented'], ['in_review'], ['approved']])(
    'a `%s` target is parked and comes back at To Do',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const card = await seedCard(fx);
      await setStatus(card, status);

      await approveModify(fx, card, { descriptionMd: 'Re-scoped.' });

      expect((await row(card)).status).toBe('todo');
      expect(await statusTrail(card)).toEqual([
        { from: status, to: 'planning' },
        { from: 'planning', to: 'todo' },
      ]);
    },
  );

  // ⚠️ INVERTED BY MOTIR-5646, AND BACK BY MOTIR-10102. MOTIR-5646 rested every
  // parked target at `todo`, so a priority change sent a BUILT card back to be
  // built again. A card that claims built work now gets back the status it was
  // parked from when its patch does not change what it asks for.
  it.each<[string, PlanItemPatch]>([
    ['type-only', { type: 'design' }],
    ['estimateMinutes-only', { estimateMinutes: 90 }],
    ['storyPoints-only', { storyPoints: 5 }],
    ['priority-only', { priority: 'high' }],
  ])(
    'an `implemented` target comes back at Implemented after a %s patch',
    async (_label, patch) => {
      const fx = await makeWorkItemFixture();
      const card = await seedCard(fx);
      await setStatus(card, 'implemented');

      await approveModify(fx, card, patch);

      expect((await row(card)).status).toBe('implemented');
      expect(await statusTrail(card)).toEqual([
        { from: 'implemented', to: 'planning' },
        { from: 'planning', to: 'implemented' },
      ]);
    },
  );

  // D7's SECOND ROW: a target that gains a blocker rests at `blocked`, because
  // the resting status is read from the card's LIVE edges after materialize has
  // wired them. Still true for a card that has not started; a BUILT card that
  // only gains an edge keeps its status (MOTIR-10102), and one whose body changed
  // as well lands at `blocked` through the re-scope move.
  it('a `todo` target that GAINS a blocker rests at Blocked, not To Do', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    const blocker = await seedCard(fx, 'A blocker');

    await approveModify(fx, card, { blockedByAdd: [blocker] });

    expect((await row(card)).status).toBe('blocked');
    expect(await statusTrail(card)).toEqual([
      { from: 'todo', to: 'planning' },
      { from: 'planning', to: 'blocked' },
    ]);
  });

  it('an `implemented` target re-scoped WITH a new blocker lands at Blocked; with the edge alone it stays', async () => {
    const fx = await makeWorkItemFixture();
    const rescoped = await seedCard(fx, 'Re-scoped');
    const edgeOnly = await seedCard(fx, 'Edge only');
    const blocker = await seedCard(fx, 'A blocker');
    await setStatus(rescoped, 'implemented');
    await setStatus(edgeOnly, 'implemented');

    await approveModify(fx, rescoped, { descriptionMd: 'New.', blockedByAdd: [blocker] });
    await approveModify(fx, edgeOnly, { blockedByAdd: [blocker] });

    expect((await row(rescoped)).status).toBe('blocked');
    expect((await row(edgeOnly)).status).toBe('implemented');
  });

  it('a target whose blocker is DONE rests at To Do', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    const blocker = await seedCard(fx, 'A finished blocker');
    await workItemsService.linkWorkItems(
      { fromId: card, toId: blocker, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await setStatus(blocker, 'done');
    await setStatus(card, 'implemented');

    await approveModify(fx, card, { descriptionMd: 'Re-scoped.' });

    expect((await row(card)).status).toBe('todo');
  });

  it('a `todo` target round-trips through `planning`, and a `done` target is never parked', async () => {
    const fx = await makeWorkItemFixture();
    const todo = await seedCard(fx, 'Not started');
    const done = await seedCard(fx, 'Finished');
    await setStatus(done, 'done');

    // NET-ZERO but not a no-op: the card is genuinely held while the plan is
    // open, which is the whole reason the park exists, and it comes back.
    await approveModify(fx, todo, { descriptionMd: 'Re-scoped before anyone started.' });
    expect((await row(todo)).status).toBe('todo');
    expect(await statusTrail(todo)).toEqual([
      { from: 'todo', to: 'planning' },
      { from: 'planning', to: 'todo' },
    ]);

    // ⚠️ A TERMINAL target is never parked at all (AMENDMENT 16 D2) — the park
    // reads the project's terminal keys and skips it. The approve is separately
    // refused by the persist gate, so the row is untouched either way; what this
    // pins is that no lock was ever taken on shipped work.
    await approveModify(fx, done, { descriptionMd: 'Re-scoped after it shipped.' }).catch(
      () => undefined,
    );
    expect((await row(done)).status).toBe('done');
    expect(await statusTrail(done)).toEqual([]);
    expect(await adminDb.planTargetLock.count({ where: { workItemId: done } })).toBe(0);
  });

  it('is ONE transaction: a failure after the resting move rolls that move back', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    await setStatus(card, 'implemented');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: card, patch: { descriptionMd: 'Re-scoped.' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    // The plan trail's `approved` row is written AFTER materialize, inside the
    // same transaction — so throwing there is a failure injected after the
    // RESTING MOVE, which runs as materialize's last pass.
    const original = planRevisionsService.recordRevision.bind(planRevisionsService);
    vi.spyOn(planRevisionsService, 'recordRevision').mockImplementation(async (args, tx) => {
      if (args.changeKind === 'approved') throw new Error('injected after the reset');
      return original(args, tx);
    });

    await expect(plansService.approvePlan(plan.id, fx.ctx)).rejects.toThrow(
      'injected after the reset',
    );

    // ⚠️ IT ROLLS BACK TO `planning`, NOT TO `implemented`, and that is correct
    // rather than a leak. The PARK committed in the APPEND's own transaction,
    // which succeeded — the card really is held by a plan that is really open.
    // What rolled back is the approve: the body, the resting status and the lock
    // deletion. So the card is still parked and its lock still stands, which is
    // exactly the state a retried approve needs to find.
    const after = await row(card);
    expect(after.status).toBe('planning');
    expect(after.descriptionMd).toBe('The old body.');
    expect(await adminDb.planTargetLock.count({ where: { workItemId: card } })).toBe(1);
  });
});

describe('the review diff shows the RETURN before approve', () => {
  async function reviewChanges(fx: WorkItemFixture, workItemId: string, patch: PlanItemPatch) {
    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
    await plansService.addProposals(plan.id, [{ op: 'modify', workItemId, patch }], fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);
    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    return review.items.find((i) => i.op === 'modify')!.changes;
  }

  // ⚠️ THIS SECTION INVERTED, and the reason is worth reading before "fixing" it
  // back. The row used to read `To Do (re-scoped while Implemented)` and appear
  // ONLY for a patch that changed the body. Two things changed:
  //
  //   1. its TRIGGER is now the target being PARKED — which every modify's target
  //      is, by its own append — so it appears for a type-only patch too;
  //   2. it names BOTH outcomes instead of predicting one. The resting status is
  //      decided AT APPROVE from the card's live `blocked_by` edges, including the
  //      ones this plan wires, so a row promising `To Do` could be falsified
  //      between the read and the press. That is the review-shows-what-approve-does
  //      drift MOTIR-3868 and MOTIR-3070 were filed about, and naming both
  //      outcomes is what makes this row unable to drift at all.
  it('emits "To Do or Blocked (returned when this plan is approved)" for a parked target that has not started', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);

    const changes = await reviewChanges(fx, card, { descriptionMd: 'A different body.' });

    expect(changes.find((c) => c.field === 'status')).toEqual({
      field: 'status',
      // The card is at `planning` by the time the reviewer reads the plan: its
      // own append parked it.
      from: 'Planning',
      to: 'To Do or Blocked (returned when this plan is approved)',
    });
  });

  // MOTIR-10102: a BUILT card whose body changes leaves its status for one of
  // three — named, not predicted, for the same no-drift reason.
  it('names the re-scope move for a parked `implemented` target whose body changed', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    await setStatus(card, 'implemented');

    const changes = await reviewChanges(fx, card, { descriptionMd: 'A different body.' });

    expect(changes.find((c) => c.field === 'status')).toEqual({
      field: 'status',
      from: 'Planning',
      to: 'To Do, Blocked, or In Progress (re-scoped while Implemented; decided when this plan is approved)',
    });
  });

  it.each<[string, PlanItemPatch]>([
    ['type', { type: 'design' }],
    ['estimateMinutes', { estimateMinutes: 90 }],
    ['storyPoints', { storyPoints: 5 }],
    ['priority', { priority: 'high' }],
    ['explanationMd', { explanationMd: 'A new why.' }],
  ])(
    'emits the row for a %s-only patch too — a parked BUILT card is given back at its own status',
    async (_label, patch) => {
      const fx = await makeWorkItemFixture();
      const card = await seedCard(fx);
      await setStatus(card, 'implemented');

      const changes = await reviewChanges(fx, card, patch);

      expect(changes.find((c) => c.field === 'status')).toMatchObject({
        to: 'Implemented (returned when this plan is approved)',
      });
    },
  );

  it('emits NO status row for a target that is not parked', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: card, patch: { title: 'Re-scoped' } }],
      fx.ctx,
    );
    // A person moved it out of `planning` while the plan sat in review — the
    // MANUAL RELEASE. There is nothing for the approve to give back, so the
    // reviewer is promised nothing.
    await adminDb.workItem.update({ where: { id: card }, data: { status: 'in_progress' } });
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const changes = review.items.find((i) => i.op === 'modify')!.changes;
    expect(changes.find((c) => c.field === 'status')).toBeUndefined();
  });
});

/** Connect one repo to the workspace and give the project an ESTABLISHED set row
 *  for it (mirrors `approvePlanTargetRepo.test.ts`). */
async function establishRepo(
  fx: WorkItemFixture,
  name: string,
  role: 'web' | 'api',
): Promise<void> {
  const setRow = await projectRepoSetService.addRow(fx.projectId, { role, name }, fx.ctx);
  const repo = await connectRepo(fx.workspaceId, name);
  await projectRepoSetService.attachRealizedRepo(setRow.id, repo.id, fx.ctx);
}

async function connectRepo(workspaceId: string, name: string): Promise<GithubRepo> {
  const installationId = `inst-${workspaceId}-github`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId,
      organizationId: await organizationIdOf(workspaceId),
      repoId: `${name}-${randomToken(8)}`,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
}
