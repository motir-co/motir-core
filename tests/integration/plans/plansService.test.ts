import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { autoPlanCadenceService } from '@/lib/services/autoPlanCadenceService';
import {
  DuplicatePlanTargetError,
  InvalidProposalError,
  PlanItemNotFoundError,
  PlanNotFoundError,
  PlanNotGeneratingError,
  PlanNotInExpectedStatusError,
  PlanPersistenceError,
} from '@/lib/plans/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { InvalidEstimateError } from '@/lib/estimation/errors';
import type { ProposedTodoInput } from '@/lib/dto/plans';
import {
  TODO_COMMAND_MAX_LENGTH,
  TODO_NOTES_MAX_LENGTH,
  TODO_TEXT_MAX_LENGTH,
} from '@/lib/workItemTodos/limits';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { contentRevisions, statusMoves } from '../../helpers/planTargetRevisions';
import { truncateAuthTables } from '../../helpers/db';

/** Seed a pre-existing work item through the real service, so it carries a
 *  valid fractional `position`/`backlogRank` (the test-fixture `createTestWorkItem`
 *  uses a non-fractional padded key that the materialize's append-after-sibling
 *  cannot extend). Returns the created id. */
async function seedItem(fx: WorkItemFixture, title: string): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return dto.id;
}

// Integration tests for Subtask 7.4.12 / MOTIR-1336 — `plansService`, the Plan
// substrate (Story 7.21). Real Postgres (no mocks), per CLAUDE.md. Proves:
//   • the lifecycle (generating → planned → approved|declined) + its guards;
//   • a PlanItem is a PROPOSAL — NOTHING in the work-item tree changes while a
//     plan is `planned` (no WorkItem for an add; modify/remove targets unchanged);
//   • approve MATERIALIZES per op — add → a new dispatchable WorkItem (intra-plan
//     parent + real/intra-plan blocker refs resolved), modify → same id + one
//     revision, remove → archived;
//   • decline drops all PlanItems with the tree untouched;
//   • concurrent approves resolve to exactly one materialize (atomic).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Create a plan, append the given proposals, and mark it `planned`. */
async function plannedPlan(
  fx: WorkItemFixture,
  proposals: Parameters<typeof plansService.addProposals>[1],
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Build it' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

describe('plansService — lifecycle + proposals', () => {
  it('createPlan opens a generating plan; addProposals appends without touching the tree', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'A feature', sourceJobId: 'job_1' },
      fx.ctx,
    );
    expect(plan.status).toBe('generating');
    expect(plan.itemCount).toBe(0);
    expect(plan.sourceJobId).toBe('job_1');

    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'New task', kind: 'task' } }],
      fx.ctx,
    );
    expect(withItems.items).toHaveLength(1);
    expect(withItems.items[0]!.op).toBe('add');
    expect(withItems.items[0]!.workItemId).toBeNull();

    // Nothing in the work-item tree was created — the add lives only as a PlanItem.
    const created = await adminDb.workItem.findFirst({ where: { title: 'New task' } });
    expect(created).toBeNull();
  });

  it('markPlanned moves generating → planned; addProposals afterwards is rejected', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'X' } }],
      fx.ctx,
    );
    const planned = await plansService.markPlanned(plan.id, fx.ctx);
    expect(planned.status).toBe('planned');
    expect(planned.plannedAt).not.toBeNull();
    expect(planned.itemCount).toBe(1);

    await expect(
      plansService.addProposals(plan.id, [{ op: 'add', proposedFields: { title: 'Y' } }], fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotGeneratingError);
  });

  // ── THE EMPTY CLOSE IS A DECISION, NOT A REVIEW REQUEST (MOTIR-4124) ──────
  //
  // `planned` is the status that puts a plan in front of a person and hands
  // them a button (MOTIR-3560). A plan proposing NOTHING asks for a decision
  // there is nothing to make — and the detail rendered it with no Approve and
  // no Decline at all, so it could not even be ended, while one undecided plan
  // silences that project's auto-plan cadence for good.
  it('markPlanned over a plan holding NO proposals DISCARDS it — it never reaches the review queue', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);

    const closed = await plansService.markPlanned(plan.id, fx.ctx);

    expect(closed.status).toBe('declined');
    expect(closed.decisionReason).toBe('discarded');
    expect(closed.itemCount).toBe(0);
    // The frontier never became something a person was asked to read, which is
    // the fact `plannedAt` records — so it stays unstamped, exactly as it does
    // for the `declinePlan`-from-`generating` ending this reason is shared with.
    expect(closed.plannedAt).toBeNull();
    expect(closed.decidedAt).not.toBeNull();
    // Nobody DECIDED it: the producer finished with nothing. Same shape the
    // abandoned sweep writes, and what keeps the row from claiming a decider.
    expect(closed.decidedById).toBeNull();

    // It is CLOSED by the same rule a `planned` one is — the discard is an
    // ending, not an escape back to `generating`.
    await expect(
      plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title: 'Late' } }],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(PlanNotGeneratingError);
  });

  it('a discarded close leaves the cadence gate nothing to wait on', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { sourceJobId: 'job_empty' }, fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);

    await expect(autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx)).resolves.toBeNull();
  });

  it('a PRE-FIX empty `planned` row stops pausing cadence too — the predicate excludes it', async () => {
    // The rows already in the tenant, written by the close this card changes.
    // They cannot be produced any more, so the fixture writes the shape
    // directly; nothing else in the system can move them, because the
    // abandoned sweep only reaches `generating` plans.
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { sourceJobId: 'job_legacy' }, fx.ctx);
    await adminDb.plan.update({
      where: { id: plan.id },
      data: { status: 'planned', plannedAt: new Date() },
    });

    await expect(autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx)).resolves.toBeNull();
  });

  it('…and a `planned` plan that PROPOSES something still pauses it — the exclusion did not widen', async () => {
    // The counterfactual, against a fixed shape rather than a ratio: the gate
    // exists to stop a second proposal stacking on an undecided one, and that
    // is exactly what this row is.
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'A real proposal', kind: 'task' } },
    ]);

    await expect(
      autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx),
    ).resolves.toMatchObject({ id: planId });
  });

  it('getPlan returns the bundle + lifecycle history; listPlans paginates newest-first', async () => {
    const fx = await makeWorkItemFixture();
    const first = await plansService.createPlan(fx.projectId, { title: 'first' }, fx.ctx);
    const second = await plansService.createPlan(fx.projectId, { title: 'second' }, fx.ctx);

    const detail = await plansService.getPlan(first.id, fx.ctx);
    expect(detail.title).toBe('first');
    expect(detail.items).toEqual([]);

    const page = await plansService.listPlans(fx.projectId, fx.ctx, { limit: 1 });
    expect(page.plans).toHaveLength(1);
    expect(page.plans[0]!.id).toBe(second.id); // newest first
    expect(page.nextCursor).not.toBeNull();

    const page2 = await plansService.listPlans(fx.projectId, fx.ctx, {
      limit: 1,
      cursor: page.nextCursor,
    });
    expect(page2.plans).toHaveLength(1);
    expect(page2.plans[0]!.id).toBe(first.id);
    expect(page2.nextCursor).toBeNull();
  });
});

describe('plansService.approvePlan — materialize per op', () => {
  it('materializes an add: a new dispatchable WorkItem, intra-plan + real refs resolved, id written back, revision logged', async () => {
    const fx = await makeWorkItemFixture();
    // A real existing work item the add will be blocked_by (real-ref resolution) —
    // one level down under a root of its own, the child's depth (MOTIR-6411).
    const elsewhere = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Elsewhere' },
      fx.ctx,
    );
    const blockerId = (
      await workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: 'Existing blocker',
          parentId: elsewhere.id,
        },
        fx.ctx,
      )
    ).id;

    const plan = await plansService.createPlan(fx.projectId, { title: 'Tree' }, fx.ctx);
    // Add A: a parent story.
    const afterA = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Parent story', kind: 'story' } }],
      fx.ctx,
    );
    const storyItemId = afterA.items[0]!.id;
    // Add B: a subtask under A (intra-plan parent ref) blocked_by the real blocker.
    const afterB = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Child task', kind: 'subtask', type: 'code', priority: 'high' },
          parentRef: `planItem:${storyItemId}`,
          blockedByRefs: [blockerId],
        },
      ],
      fx.ctx,
    );
    const childItemId = afterB.items.find((i) => i.proposedFields?.title === 'Child task')!.id;
    await plansService.markPlanned(plan.id, fx.ctx);

    // While planned, neither add exists in the tree.
    const workItemRow = await adminDb.workItem.findFirst({ where: { title: 'Parent story' } });
    expect(workItemRow).toBeNull();

    const approved = await plansService.approvePlan(plan.id, fx.ctx);
    expect(approved.status).toBe('approved');
    expect(approved.decidedById).toBe(fx.ownerId);
    expect(approved.decidedAt).not.toBeNull();

    // The story + child now exist, dispatchable (real identifier/status/reporter).
    const story = await adminDb.workItem.findFirst({ where: { title: 'Parent story' } });
    const child = await adminDb.workItem.findFirst({ where: { title: 'Child task' } });
    expect(story).not.toBeNull();
    expect(child).not.toBeNull();
    expect(child!.parentId).toBe(story!.id); // intra-plan parent ref resolved
    expect(child!.kind).toBe('subtask');
    expect(child!.type).toBe('code');
    expect(child!.priority).toBe('high');
    expect(child!.identifier).toMatch(/^PROD-\d+$/);
    expect(child!.status).not.toBe('');
    expect(child!.reporterId).toBe(fx.ownerId);

    // The blocked_by link to the REAL existing blocker was created.
    const link = await adminDb.workItemLink.findFirst({
      where: { fromId: child!.id, toId: blockerId, kind: 'is_blocked_by' },
    });
    expect(link).not.toBeNull();

    // The PlanItems carry the written-back work-item ids; a 'created' revision logged.
    const finalChild = approved.items.find((i) => i.id === childItemId)!;
    expect(finalChild.workItemId).toBe(child!.id);
    const revisions = await adminDb.workItemRevision.findMany({ where: { workItemId: child!.id } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.changeKind).toBe('created');
  });

  it('normalizes a bare REAL work-item key in a materialized description to the canonical chip token (bug MOTIR-1440)', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Referenced target');
    const target = await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } });

    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: {
          title: 'Generated card',
          kind: 'task',
          descriptionMd: `Builds on ${target.identifier} — see there.`,
        },
      },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Generated card' } });
    // The bare key was rewritten to the chip token (resolved against the real item).
    expect(created.descriptionMd).toBe(
      `Builds on [${target.identifier}](motir:${target.id}) — see there.`,
    );
  });

  it('rewrites an intra-plan motir-ref token in a materialized description to the real chip + relates_to (MOTIR-1418)', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Tree' }, fx.ctx);
    // Sibling B is proposed first — capture its PlanItem id (the temp-ref the
    // generator embeds in a reference to a sibling it has no real id for yet).
    const afterB = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Sibling B', kind: 'task' } }],
      fx.ctx,
    );
    const bPlanItemId = afterB.items[0]!.id;
    // Card A references B through the intra-plan item-link token.
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Card A',
            kind: 'task',
            descriptionMd: `Depends on [Sibling B](motir-ref:planItem:${bPlanItemId}).`,
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const a = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Card A' } });
    const b = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Sibling B' } });
    // The temp-ref token became a real chip token pointing at B's CREATED id.
    expect(a.descriptionMd).toBe(`Depends on [Sibling B](motir:${b.id}).`);
    // The now-real reference auto-created a `relates_to` edge A → B (source mention)
    // — the materialize analogue of the create-time auto-relate — plus its reciprocal.
    const forward = await adminDb.workItemLink.findFirst({
      where: { fromId: a.id, toId: b.id, kind: 'relates_to' },
    });
    expect(forward).not.toBeNull();
    expect(forward!.source).toBe('mention');
    expect(
      await adminDb.workItemLink.findFirst({
        where: { fromId: b.id, toId: a.id, kind: 'relates_to' },
      }),
    ).not.toBeNull();
  });

  it('materializes the link token a planner HANDS for a proposal into a link to the created card (MOTIR-10096)', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Tree' }, fx.ctx);
    const title = 'Gate [beta] pairs (service layer): `assertLegal`';
    const afterB = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title, kind: 'task' } }],
      fx.ctx,
    );
    const bPlanItemId = afterB.items[0]!.id;
    // Exactly what motir-ai's `proposalLinkToken` and plan.py's `_proposal_link`
    // hand beside this sibling: its title, brackets turned into parentheses, as
    // the label of a `motir-ref:planItem:` link — copied verbatim into both bodies.
    const handed = `[Gate (beta) pairs (service layer): \`assertLegal\`](motir-ref:planItem:${bPlanItemId})`;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Card A',
            kind: 'task',
            descriptionMd: `## Scope BOUNDARY\n\n- Hands the matrix to ${handed}.`,
            explanationMd: `It unblocks ${handed}.`,
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const a = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Card A' } });
    const b = await adminDb.workItem.findFirstOrThrow({ where: { title } });
    const chip = `[Gate (beta) pairs (service layer): \`assertLegal\`](motir:${b.id})`;
    expect(a.descriptionMd).toBe(`## Scope BOUNDARY\n\n- Hands the matrix to ${chip}.`);
    expect(a.explanationMd).toBe(`It unblocks ${chip}.`);
    expect(
      await adminDb.workItemLink.findFirst({
        where: { fromId: a.id, toId: b.id, kind: 'relates_to' },
      }),
    ).not.toBeNull();
  });

  it('rewrites a sibling linked as `motir:<planItemId>` in BOTH bodies to the created card (MOTIR-9993)', async () => {
    const fx = await makeWorkItemFixture();
    const existingId = await seedItem(fx, 'Existing card');
    const plan = await plansService.createPlan(fx.projectId, { title: 'Tree' }, fx.ctx);
    const afterB = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Sibling B', kind: 'task' } }],
      fx.ctx,
    );
    const bPlanItemId = afterB.items[0]!.id;
    // Card A names B with the ORDINARY item-link scheme and B's planItem id — the
    // slip planning-time validation accepts — beside a link to a real work item
    // and one to an id that is neither.
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Card A',
            kind: 'task',
            descriptionMd: `Depends on [Sibling B](motir:${bPlanItemId}) and [Existing](motir:${existingId}); [gone](motir:not_an_item_id).`,
            explanationMd: `Unblocks [Sibling B](motir:${bPlanItemId}).`,
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const a = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Card A' } });
    const b = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Sibling B' } });
    expect(a.descriptionMd).toBe(
      `Depends on [Sibling B](motir:${b.id}) and [Existing](motir:${existingId}); [gone](motir:not_an_item_id).`,
    );
    expect(a.explanationMd).toBe(`Unblocks [Sibling B](motir:${b.id}).`);
    // The rewritten link relates A → B like the canonical token does.
    expect(
      await adminDb.workItemLink.findFirst({
        where: { fromId: a.id, toId: b.id, kind: 'relates_to' },
      }),
    ).not.toBeNull();
  });

  it('leaves a DANGLING intra-plan ref inert when materialized (no crash, no edge)', async () => {
    const fx = await makeWorkItemFixture();
    // The append now refuses a dangling body link (bug MOTIR-9175), so the row is
    // seeded directly: this is the backstop for a plan appended before that shipped.
    // An empty plan is declined at close, so it holds one unrelated `add`.
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Unrelated card', kind: 'task' } },
    ]);
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId,
        op: 'add',
        blockedByRefs: [],
        proposedFields: {
          title: 'Orphan ref card',
          kind: 'task',
          descriptionMd: 'See [gone](motir-ref:planItem:pi_does_not_exist).',
        },
      },
    });
    // Must NOT throw — a dangling temp-ref is body text, never a materialize failure.
    await plansService.approvePlan(planId, fx.ctx);
    const created = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Orphan ref card' },
    });
    expect(created.descriptionMd).toBe('See [gone](motir-ref:planItem:pi_does_not_exist).');
    const workItemLinkCount = await adminDb.workItemLink.count({ where: { fromId: created.id } });
    expect(workItemLinkCount).toBe(0);
  });

  it('normalizes a bare REAL key in a materialized MODIFY patch description (bug MOTIR-1440)', async () => {
    const fx = await makeWorkItemFixture();
    const editTargetId = await seedItem(fx, 'Edit me');
    const refId = await seedItem(fx, 'Ref target');
    const ref = await adminDb.workItem.findUniqueOrThrow({ where: { id: refId } });

    const planId = await plannedPlan(fx, [
      {
        op: 'modify',
        workItemId: editTargetId,
        patch: { descriptionMd: `Now mentions ${ref.identifier}.` },
      },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const modified = await adminDb.workItem.findUniqueOrThrow({ where: { id: editTargetId } });
    expect(modified.descriptionMd).toBe(`Now mentions [${ref.identifier}](motir:${ref.id}).`);
  });

  it('materializes a modify: SAME id, fields updated, exactly ONE revision; and a remove: target archived', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Old title');
    const doomedId = await seedItem(fx, 'To remove');

    const blockerId = await seedItem(fx, 'Blocker for modify');
    const planId = await plannedPlan(fx, [
      {
        op: 'modify',
        workItemId: targetId,
        patch: { title: 'New title', priority: 'high', blockedByAdd: [blockerId] },
      },
      { op: 'remove', workItemId: doomedId },
    ]);

    // While planned, the modify/remove targets are byte-for-byte unchanged.
    const beforeModify = await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(beforeModify.title).toBe('Old title');
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: doomedId } })).archivedAt,
    ).toBeNull();

    await plansService.approvePlan(planId, fx.ctx);

    const modified = await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(modified.id).toBe(targetId); // identity never re-minted
    expect(modified.title).toBe('New title');
    expect(modified.priority).toBe('high');

    // The edge change applied: an is_blocked_by link to the blocker now exists.
    const link = await adminDb.workItemLink.findFirst({
      where: { fromId: targetId, toId: blockerId, kind: 'is_blocked_by' },
    });
    expect(link).not.toBeNull();

    // Exactly ONE `updated` revision for the whole modify (the seed `created`
    // one aside) — the modify lands as a single entry, same id — and the edge
    // change rides it under the existing `links` diff key.
    const modRevisions = await contentRevisions(targetId);
    expect(modRevisions).toHaveLength(1);
    expect(modRevisions[0]!.diff).toMatchObject({
      links: { added: [{ toId: blockerId, kind: 'is_blocked_by' }] },
    });

    const removed = await adminDb.workItem.findUniqueOrThrow({ where: { id: doomedId } });
    expect(removed.archivedAt).not.toBeNull();
  });

  it('materializes a modify that RE-SCOPES leaf sizing: storyPoints + estimateMinutes applied, ONE revision with both diff cells (MOTIR-1532)', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Sized target');
    // Give the target a baseline estimate so the re-scope has a real `from`.
    await adminDb.workItem.update({
      where: { id: targetId },
      data: { storyPoints: 3, estimateMinutes: 60 },
    });

    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: targetId, patch: { storyPoints: 8, estimateMinutes: 120 } },
    ]);

    // While planned, the target's sizing is untouched.
    const beforeApprove = await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(Number(beforeApprove.storyPoints)).toBe(3);
    expect(beforeApprove.estimateMinutes).toBe(60);

    await plansService.approvePlan(planId, fx.ctx);

    const modified = await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(modified.id).toBe(targetId); // identity never re-minted
    expect(Number(modified.storyPoints)).toBe(8);
    expect(modified.estimateMinutes).toBe(120);

    // Exactly ONE `updated` revision for the whole modify, carrying BOTH sizing
    // diff cells (the seed `created` revision aside).
    const revisions = await contentRevisions(targetId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.diff).toMatchObject({
      storyPoints: { from: 3, to: 8 },
      estimateMinutes: { from: 60, to: 120 },
    });
  });

  it('materializes a modify that CLEARS an estimate: storyPoints → null with a diff cell (MOTIR-1532)', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'To unestimate');
    await adminDb.workItem.update({ where: { id: targetId }, data: { storyPoints: 5 } });

    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: targetId, patch: { storyPoints: null } },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const modified = await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(modified.storyPoints).toBeNull();
    const revision = (await contentRevisions(targetId))[0]!;
    expect(revision.diff).toMatchObject({ storyPoints: { from: 5, to: null } });
  });

  // ── A `modify` may REWRITE THE WHY (MOTIR-3111) ───────────────────────────
  // The second body was the one asymmetry left between the two proposal paths:
  // an `add` carried `explanationMd`, a `modify` had nowhere to put it, so the
  // REPLAN ACTION's "patch BOTH bodies" had no door and a re-scoped survivor kept
  // a rationale that no longer described it. These five lock the sparse contract
  // (write / absent / null), the chip normalization the description already got,
  // and the provenance column a patch must NOT be able to forge.

  it('materializes a modify that REWRITES the WHY: explanationMd applied, ONE revision with the diff cell (MOTIR-3111)', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Card with a stale WHY');
    await adminDb.workItem.update({
      where: { id: targetId },
      data: { explanationMd: 'The OLD rationale, written for a shape this card no longer has.' },
    });

    const planId = await plannedPlan(fx, [
      {
        op: 'modify',
        workItemId: targetId,
        patch: { explanationMd: 'The rationale as the re-scope leaves it.' },
      },
    ]);

    // While planned, the target's explanation is byte-for-byte unchanged.
    const beforeApprove = await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(beforeApprove.explanationMd).toBe(
      'The OLD rationale, written for a shape this card no longer has.',
    );

    await plansService.approvePlan(planId, fx.ctx);

    const modified = await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(modified.id).toBe(targetId); // identity never re-minted
    expect(modified.explanationMd).toBe('The rationale as the re-scope leaves it.');

    // ONE `updated` revision carrying the `explanationMd` diff cell — the key
    // already has an `editedField()` disposition in lib/activity/renderers.ts
    // (`buildAddDiff` emits it), so this renders with no new registry entry.
    const revisions = await contentRevisions(targetId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.diff).toMatchObject({
      explanationMd: {
        from: 'The OLD rationale, written for a shape this card no longer has.',
        to: 'The rationale as the re-scope leaves it.',
      },
    });
  });

  it('leaves an existing explanation UNTOUCHED when the patch carries no explanationMd key (MOTIR-3111)', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Re-titled, not re-explained');
    await adminDb.workItem.update({
      where: { id: targetId },
      data: { explanationMd: 'Still the right WHY.' },
    });

    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: targetId, patch: { title: 'A new title only' } },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const modified = await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(modified.title).toBe('A new title only');
    expect(modified.explanationMd).toBe('Still the right WHY.'); // absent ≠ null
    const revision = (await contentRevisions(targetId))[0]!;
    expect(revision.diff).not.toHaveProperty('explanationMd');
  });

  it('CLEARS an explanation on an explicit null, with a diff cell (MOTIR-3111)', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'To un-explain');
    await adminDb.workItem.update({
      where: { id: targetId },
      data: { explanationMd: 'A rationale about to be withdrawn.' },
    });

    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: targetId, patch: { explanationMd: null } },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const modified = await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(modified.explanationMd).toBeNull();
    const revision = (await contentRevisions(targetId))[0]!;
    expect(revision.diff).toMatchObject({
      explanationMd: { from: 'A rationale about to be withdrawn.', to: null },
    });
  });

  it('normalizes a bare REAL key in a materialized MODIFY patch EXPLANATION (MOTIR-3111)', async () => {
    const fx = await makeWorkItemFixture();
    const editTargetId = await seedItem(fx, 'Edit my WHY');
    const refId = await seedItem(fx, 'Ref target');
    const ref = await adminDb.workItem.findUniqueOrThrow({ where: { id: refId } });

    const planId = await plannedPlan(fx, [
      {
        op: 'modify',
        workItemId: editTargetId,
        patch: {
          descriptionMd: `Body mentions ${ref.identifier}.`,
          explanationMd: `It matters because of ${ref.identifier}.`,
        },
      },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    // Both bodies chip, off the ONE resolve `applyModify` makes for the pair.
    const modified = await adminDb.workItem.findUniqueOrThrow({ where: { id: editTargetId } });
    expect(modified.descriptionMd).toBe(`Body mentions [${ref.identifier}](motir:${ref.id}).`);
    expect(modified.explanationMd).toBe(
      `It matters because of [${ref.identifier}](motir:${ref.id}).`,
    );
  });

  it('leaves explanationSource ALONE when a patch rewrites the explanation — a plan cannot forge provenance (MOTIR-3111)', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'AI-drafted WHY');
    await adminDb.workItem.update({
      where: { id: targetId },
      data: { explanationMd: 'Drafted by the generator.', explanationSource: 'ai_draft' },
    });

    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: targetId, patch: { explanationMd: 'Rewritten by the re-plan.' } },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const modified = await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(modified.explanationMd).toBe('Rewritten by the re-plan.');
    // NOT `user_edited`: that auto-transition belongs to the SERVICE edit path.
    // `applyModify` never writes this column, whatever its prior value.
    expect(modified.explanationSource).toBe('ai_draft');
  });

  it('applies a modify carrying NO body keys exactly as before — the regression the new key sits next to (MOTIR-3111)', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Bodies untouched');
    await adminDb.workItem.update({
      where: { id: targetId },
      data: { descriptionMd: 'The WHAT, unchanged.', explanationMd: 'The WHY, unchanged.' },
    });

    const planId = await plannedPlan(fx, [
      {
        op: 'modify',
        workItemId: targetId,
        patch: { title: 'Renamed', priority: 'high', estimateMinutes: 30 },
      },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const modified = await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(modified.title).toBe('Renamed');
    expect(modified.priority).toBe('high');
    expect(modified.estimateMinutes).toBe(30);
    expect(modified.descriptionMd).toBe('The WHAT, unchanged.');
    expect(modified.explanationMd).toBe('The WHY, unchanged.');
    const revision = (await contentRevisions(targetId))[0]!;
    expect(revision.diff).not.toHaveProperty('descriptionMd');
    expect(revision.diff).not.toHaveProperty('explanationMd');
  });

  it('rejects a modify patch with a malformed re-scope estimate (InvalidEstimateError, MOTIR-1532)', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Reject bad re-scope');
    const plan = await plansService.createPlan(fx.projectId, { title: 'Bad re-scope' }, fx.ctx);

    await expect(
      plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: targetId, patch: { estimateMinutes: -5 } }],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidEstimateError); // minutes must be a non-negative integer
  });
});

describe('plansService.approvePlan — AI-drafted explanations (MOTIR-850)', () => {
  it('materializes an add WITH an explanation: explanationMd carried, source ai_draft, intra-plan ref resolved + related', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Tree' }, fx.ctx);
    // Sibling B proposed first — the explanation of A references it by temp-ref.
    const afterB = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Sibling B', kind: 'task' } }],
      fx.ctx,
    );
    const bPlanItemId = afterB.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Card A',
            kind: 'task',
            explanationMd: `Matters because it unblocks [Sibling B](motir-ref:planItem:${bPlanItemId}).`,
            explanationSource: 'ai_draft',
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const a = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Card A' } });
    const b = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Sibling B' } });
    // The explanation carried through, its source is ai_draft, and its intra-plan
    // temp-ref was rewritten to a real chip token pointing at B's CREATED id
    // (the same MOTIR-1418 seam the description path uses).
    expect(a.explanationMd).toBe(`Matters because it unblocks [Sibling B](motir:${b.id}).`);
    expect(a.explanationSource).toBe('ai_draft');
    // The now-real reference in the EXPLANATION auto-created a relates_to edge A → B.
    expect(
      await adminDb.workItemLink.findFirst({
        where: { fromId: a.id, toId: b.id, kind: 'relates_to' },
      }),
    ).not.toBeNull();
    // The created revision records the explanation (renderers.ts has its disposition).
    const rev = await adminDb.workItemRevision.findFirstOrThrow({
      where: { workItemId: a.id, changeKind: 'created' },
    });
    expect((rev.diff as Record<string, unknown>)['explanationMd']).toBeDefined();
  });

  it('respects an explicit explanationSource the proposal carried', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: {
          title: 'Explicit source card',
          kind: 'task',
          explanationMd: 'A human already touched this.',
          explanationSource: 'user_edited',
        },
      },
    ]);
    await plansService.approvePlan(planId, fx.ctx);
    const created = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Explicit source card' },
    });
    expect(created.explanationMd).toBe('A human already touched this.');
    expect(created.explanationSource).toBe('user_edited');
  });

  it('materializes an add with NO explanation: explanationMd null, source at the user_authored default', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'No-explanation card', kind: 'task' } },
    ]);
    await plansService.approvePlan(planId, fx.ctx);
    const created = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'No-explanation card' },
    });
    expect(created.explanationMd).toBeNull();
    expect(created.explanationSource).toBe('user_authored');
  });
});

// Native planning provenance at materialize (Story MOTIR-1685 · MOTIR-1691).
describe('plansService.approvePlan — native planning provenance', () => {
  it('stamps native · Motir · null DEFENSIVELY when the proposal carries no provenance', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Pre-producer card', kind: 'task' } },
    ]);
    await plansService.approvePlan(planId, fx.ctx);
    const created = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Pre-producer card' },
    });
    // Every materialized item is native by construction; harness defaults to Motir.
    expect(created.planningSource).toBe('native');
    expect(created.planningHarness).toBe('Motir');
    expect(created.planningModel).toBeNull();
  });

  it('RECORDS the model from the proposal on the row (for analysis) but STRIPS it from the read DTO', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: {
          title: 'Producer card',
          kind: 'task',
          planningProvenance: { source: 'native', harness: 'Motir', model: 'deepseek-chat' },
        },
      },
    ]);
    await plansService.approvePlan(planId, fx.ctx);
    // The raw ROW records the model (available for internal analysis).
    const row = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Producer card' } });
    expect(row.planningSource).toBe('native');
    expect(row.planningHarness).toBe('Motir');
    expect(row.planningModel).toBe('deepseek-chat');
    // But the read DTO STRIPS the native model — it is never exposed to the API/UI.
    const dto = await workItemsService.getWorkItemByIdentifier(
      fx.projectId,
      row.identifier,
      fx.ctx,
    );
    expect(dto.planningSource).toBe('native');
    expect(dto.planningHarness).toBe('Motir');
    expect(dto.planningModel).toBeNull();
  });

  // ⚠️ THIS TEST ASSERTED THE OPPOSITE UNTIL 2026-08-18, AND THE REVERSAL IS
  // DELIBERATE (MOTIR-2990). It read:
  //
  //   'PINS source AND harness to native/Motir — a forged source/harness on the
  //    proposal is ignored'
  //   … expect(created.planningSource).toBe('native')   // proposal said 'manual'
  //   … expect(created.planningHarness).toBe('Motir')   // proposal said 'evil'
  //
  // `docs/decisions/work-item-provenance.md` Decision 5's pin was lifted because
  // its PREMISE — "every item materialized from an approved plan was planned
  // NATIVELY by Motir" — stopped being true when an agent could author a plan
  // over the MCP (Story MOTIR-2982). The PROPERTY the pin protected did not
  // change and is asserted below: a proposal still cannot CLAIM a source. It is
  // now held by the write seams (every one sets `source` server-side) plus a
  // closed-set guard at the proposal boundary, rather than by refusing to read
  // the field — see `docs/decisions/agent-authored-plans.md` Q4 and
  // `tests/integration/plans/materializeProvenance.test.ts`, which owns the
  // amended contract in full.
  it('materialize READS the proposal’s source/harness, defaulting to native/Motir', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: {
          title: 'Agent-authored card',
          kind: 'task',
          planningProvenance: { source: 'mcp', harness: 'Claude Code', model: 'the-model' },
        },
      },
      {
        op: 'add',
        proposedFields: { title: 'Provenance-less card', kind: 'task' },
      },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const authored = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Agent-authored card' },
    });
    expect(authored.planningSource).toBe('mcp');
    expect(authored.planningHarness).toBe('Claude Code');
    expect(authored.planningModel).toBe('the-model');

    // The default is what keeps every shipped native producer byte-identical.
    const defaulted = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Provenance-less card' },
    });
    expect(defaulted.planningSource).toBe('native');
    expect(defaulted.planningHarness).toBe('Motir');
    expect(defaulted.planningModel).toBeNull();
  });

  it('a source outside the closed set is still refused — the property the pin protected', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    await expect(
      plansService.addProposals(
        plan.id,
        [
          {
            op: 'add',
            proposedFields: {
              title: 'Forged source card',
              kind: 'task',
              planningProvenance: { source: 'trustworthy', harness: 'evil' },
            },
          },
        ],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });
});

describe('plansService.declinePlan', () => {
  // AMENDED by MOTIR-3160 (bug MOTIR-3154). This test used to assert
  // `planItemCount === 0` — the delete this card removes. Not writing to the
  // tree is what declining MEANS; erasing the proposal was a separate act that
  // destroyed the only record of what was offered and refused. Everything the
  // test said about the TREE is unchanged, and is the half that mattered.
  it('KEEPS every PlanItem and leaves the work-item tree untouched', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Untouched');
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Never created', kind: 'task' } },
      { op: 'modify', workItemId: targetId, patch: { title: 'Should not apply' } },
    ]);

    const declined = await plansService.declinePlan(planId, fx.ctx);
    expect(declined.status).toBe('declined');
    expect(declined.decidedById).toBe(fx.ownerId);
    expect(declined.decidedAt).not.toBeNull();

    // The add was never materialized; the modify target is unchanged.
    const workItemRow = await adminDb.workItem.findFirst({ where: { title: 'Never created' } });
    expect(workItemRow).toBeNull();
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } })).title).toBe(
      'Untouched',
    );

    // …and the proposals SURVIVE, as the record of the decision.
    const rows = await adminDb.planItem.findMany({ where: { planId } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.op).sort()).toEqual(['add', 'modify']);
    // No add materialized, so none was stamped with a work item.
    expect(rows.find((r) => r.op === 'add')!.workItemId).toBeNull();
  });

  // The SECOND count site (MOTIR-3160): `declinePlan` returned `toPlanDto(row, 0)`
  // — a hardcoded zero, not a read. With the rows retained that told the caller
  // who had just declined a plan it held no items while `listPlans` (counting
  // through `countByPlanIds`) said otherwise.
  it('returns the plan REAL item count, and the list agrees with it', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'One', kind: 'task' } },
      { op: 'add', proposedFields: { title: 'Two', kind: 'task' } },
      { op: 'add', proposedFields: { title: 'Three', kind: 'task' } },
    ]);

    const declined = await plansService.declinePlan(planId, fx.ctx);
    expect(declined.itemCount).toBe(3);

    const listed = await plansService.listPlans(fx.projectId, fx.ctx);
    const row = listed.plans.find((p: { id: string }) => p.id === planId);
    expect(row?.status).toBe('declined');
    expect(row?.itemCount).toBe(3);
  });

  it('records `reviewed` — the ending this method was written for', async () => {
    // The from-status IS the reason (MOTIR-3189). `declined` covers three
    // histories now, and a plan a person read and rejected is the one that keeps
    // the original wording on the review surface.
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Reviewed and refused', kind: 'task' } },
    ]);

    const declined = await plansService.declinePlan(planId, fx.ctx);

    expect(declined.decisionReason).toBe('reviewed');
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).decisionReason).toBe(
      'reviewed',
    );
  });

  // AMENDED by MOTIR-3189. This used to read "rejects approve/decline from a
  // non-planned status" and assert BOTH deciders refuse a `generating` plan —
  // which was true, and was the defect: with the sweep excluding partial plans
  // to leave the decision to a person, no person had a door. Approve is
  // unchanged (materializing an unfinished plan is a different act); decline
  // now accepts `generating` as a DISCARD.
  it('rejects APPROVE from a non-planned status — materializing an unfinished plan is not a decision to allow', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    // still generating
    await expect(plansService.approvePlan(plan.id, fx.ctx)).rejects.toBeInstanceOf(
      PlanNotInExpectedStatusError,
    );
  });

  it('rejects decline from an ALREADY-DECIDED status, naming both legal origins', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Once only', kind: 'task' } },
    ]);
    await plansService.declinePlan(planId, fx.ctx);

    // The idempotency / lost-race landing, unchanged: the second caller re-reads
    // under the lock, observes `declined`, and gets the typed 409 carrying the
    // ACTUAL status as data (MOTIR-3025) so it need not parse the sentence.
    //
    // The SENTENCE names three origins since MOTIR-3579 — `stale` joined
    // `planned` as a review decision (AMENDMENT 9 D4) — and the assertion below
    // is on `actual`, which is the field a caller is meant to branch on. The
    // message check is deliberately kept but loosened to the part that carries
    // the meaning: this test is about the refusal, not about the prose.
    await expect(plansService.declinePlan(planId, fx.ctx)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof PlanNotInExpectedStatusError &&
        err.actual === 'declined' &&
        err.message.includes('requires it to be planned'),
    );
  });
});

describe('plansService.declinePlan — DISCARD from `generating` (MOTIR-3189)', () => {
  // A plan whose producer died mid-generation could not be approved, declined or
  // discarded by anyone: both deciders re-read under the row lock and threw
  // unless the status was `planned`. Meanwhile `findUndecidedByProject` read it
  // as UNDECIDED and paused that project's auto-plan cadence for good, and
  // AMENDMENT 2 excluded partial plans from the reconciling sweep precisely to
  // leave the call to a person. Nobody checked the person had a door.

  /** Open a `generating` plan and append proposals WITHOUT closing the frontier
   *  — the shape a crashed generation or an abandoned authoring pass leaves. */
  async function generatingPlan(
    fx: WorkItemFixture,
    proposals: Parameters<typeof plansService.addProposals>[1],
    opts: { sourceJobId?: string | null } = {},
  ): Promise<string> {
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Half-written', ...(opts.sourceJobId ? { sourceJobId: opts.sourceJobId } : {}) },
      fx.ctx,
    );
    if (proposals.length > 0) await plansService.addProposals(plan.id, proposals, fx.ctx);
    return plan.id;
  }

  it('AC 1: moves a PARTIAL `generating` plan to `declined`, and every PlanItem survives', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Untouched');
    const planId = await generatingPlan(fx, [
      { op: 'add', proposedFields: { title: 'Never created', kind: 'task' } },
      { op: 'modify', workItemId: targetId, patch: { title: 'Should not apply' } },
    ]);

    const discarded = await plansService.declinePlan(planId, fx.ctx);

    expect(discarded.status).toBe('declined');
    expect(discarded.decidedById).toBe(fx.ownerId);
    expect(discarded.decidedAt).not.toBeNull();
    // ⚠️ NOTHING IS DELETED — the MOTIR-3154 / MOTIR-3160 rule, unchanged. It
    // matters more here: these proposals are the only record of how far the
    // producer got before it stopped. Asserted by READING THE PLAN BACK, which
    // is what the card asked for rather than a count on the write's own return.
    const readBack = await plansService.getPlan(planId, fx.ctx);
    expect(readBack.items).toHaveLength(2);
    expect(readBack.itemCount).toBe(2);
    expect(readBack.items.map((i) => i.op).sort()).toEqual(['add', 'modify']);
    // …and the tree is untouched, exactly as on a reviewed decline.
    expect(await adminDb.workItem.findFirst({ where: { title: 'Never created' } })).toBeNull();
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } })).title).toBe(
      'Untouched',
    );
  });

  it('AC 3 + AC 4: `plannedAt` stays NULL and the reason is `discarded`', async () => {
    // The frontier genuinely never closed. Back-filling `plannedAt` would make a
    // plan that died halfway indistinguishable from one that finished and was
    // turned down — the exact conflation `decisionReason` exists to remove, so
    // the two assertions belong in one test.
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx, [
      { op: 'add', proposedFields: { title: 'Half a tree', kind: 'task' } },
    ]);

    const discarded = await plansService.declinePlan(planId, fx.ctx);

    expect(discarded.plannedAt).toBeNull();
    expect(discarded.decisionReason).toBe('discarded');
    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(row.plannedAt).toBeNull();
    expect(row.decisionReason).toBe('discarded');
  });

  it('AC 7: a plan with NO PRODUCER is discardable — the sweep can never ask about it', async () => {
    // The agent-authored orphan. `create_plan` over MCP records no
    // `sourceJobId`, so `listAbandonedCandidates` (which asks motir-ai what
    // became of the job) can never reach this row however old it gets — there
    // is nothing to ask about. The discard path is its ONLY exit, which is why
    // this row gets a test of its own rather than riding the one above.
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx, [
      { op: 'add', proposedFields: { title: 'Authored by hand', kind: 'task' } },
    ]);
    expect(
      (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).sourceJobId,
    ).toBeNull();

    const discarded = await plansService.declinePlan(planId, fx.ctx);

    expect(discarded.status).toBe('declined');
    expect(discarded.decisionReason).toBe('discarded');
    expect(discarded.sourceJobId).toBeNull();
  });

  it('discards an EMPTY `generating` plan too — the shape the sweep already had', async () => {
    // Not a new class, but the one MOTIR-3051 and MOTIR-3064 were written about,
    // and a person should not have to wait an hour for a sweep to clear a plan
    // they know is dead. Zero proposals is not a reason to refuse.
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx, []);

    const discarded = await plansService.declinePlan(planId, fx.ctx);

    expect(discarded.status).toBe('declined');
    expect(discarded.itemCount).toBe(0);
    expect(discarded.decisionReason).toBe('discarded');
  });

  it('AC 8: the project’s cadence stops being paused by it', async () => {
    // The harm, closed at the service rather than through the sweep: the plan is
    // no longer UNDECIDED, so the pending-proposal gate stops reading it.
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx, [
      { op: 'add', proposedFields: { title: 'Stranded', kind: 'task' } },
    ]);
    await expect(
      autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx),
    ).resolves.toMatchObject({ id: planId });

    await plansService.declinePlan(planId, fx.ctx);

    await expect(autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx)).resolves.toBeNull();
  });

  it('AC 2: a plan in ANOTHER WORKSPACE is refused exactly as an unknown one is — no existence leak', async () => {
    // The lookup is workspace-scoped (`findById(planId, ctx.workspaceId)`), so a
    // cross-tenant id resolves to null and takes the SAME branch a nonexistent
    // id takes. What the assertion has to prove is that the two are
    // indistinguishable: a 404 for one and a 403 for the other would answer
    // "that plan exists, elsewhere", which is the leak.
    const owner = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
    const stranger = await makeWorkItemFixture({ name: 'Globex', identifier: 'GLBX' });
    const planId = await generatingPlan(owner, [
      { op: 'add', proposedFields: { title: 'Theirs', kind: 'task' } },
    ]);

    await expect(plansService.declinePlan(planId, stranger.ctx)).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
    await expect(
      plansService.declinePlan('plan_does_not_exist', stranger.ctx),
    ).rejects.toBeInstanceOf(PlanNotFoundError);

    // And the plan is untouched — the refusal happened before the transaction.
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'generating',
    );
  });

  it('two concurrent discards resolve to exactly one write; the loser gets the typed error', async () => {
    // The row lock and the re-read are shared with the reviewed path, so this is
    // the same guarantee — asserted from `generating` because that is the entry
    // the lock had never been exercised from.
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx, [
      { op: 'add', proposedFields: { title: 'Contended', kind: 'task' } },
    ]);

    const results = await Promise.allSettled([
      plansService.declinePlan(planId, fx.ctx),
      plansService.declinePlan(planId, fx.ctx),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(PlanNotInExpectedStatusError);
    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(row.status).toBe('declined');
    expect(row.decisionReason).toBe('discarded');
  });
});

describe('plansService.approvePlan — concurrency (atomic one-shot)', () => {
  it('two concurrent approves materialize exactly once; the loser gets a typed error', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Once only', kind: 'task' } },
    ]);

    const results = await Promise.allSettled([
      plansService.approvePlan(planId, fx.ctx),
      plansService.approvePlan(planId, fx.ctx),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser fails with a typed error (no raw DB race escapes).
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      PlanNotInExpectedStatusError,
    );

    // The add materialized EXACTLY once (no double-create).
    const created = await adminDb.workItem.findMany({ where: { title: 'Once only' } });
    expect(created).toHaveLength(1);

    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.status).toBe('approved');
  });
});

// Subtask 7.21.6 / MOTIR-1370 — edit a proposed `add` in place while the plan is
// `planned`. A PlanItem is a PROPOSAL: editing patches its `proposedFields`; no
// WorkItem is created (that waits for approve). Real Postgres.
describe('plansService.updateProposal — edit a proposed add (7.21.6)', () => {
  it('edits a planned plan’s add proposal in place; no WorkItem is created', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'P' }, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Old title', kind: 'task', priority: 'low' } }],
      fx.ctx,
    );
    const itemId = withItems.items[0]!.id;
    await plansService.markPlanned(plan.id, fx.ctx);

    const updated = await plansService.updateProposal(
      plan.id,
      itemId,
      {
        title: 'New title',
        // A leaf kind: a re-kind to a container may not keep a `type` (MOTIR-8192).
        kind: 'bug',
        priority: 'high',
        type: 'design',
        descriptionMd: 'Why this matters',
      },
      fx.ctx,
    );
    const edited = updated.items.find((i) => i.id === itemId)!;
    expect(edited.proposedFields).toMatchObject({
      title: 'New title',
      kind: 'bug',
      priority: 'high',
      type: 'design',
      descriptionMd: 'Why this matters',
    });
    // Still a proposal — neither the old nor the new title exists in the tree.
    const workItemRow = await adminDb.workItem.findFirst({ where: { title: 'New title' } });
    expect(workItemRow).toBeNull();
    const workItemRow2 = await adminDb.workItem.findFirst({ where: { title: 'Old title' } });
    expect(workItemRow2).toBeNull();
  });

  it('merges sparsely — an absent key is left untouched', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Keep me', kind: 'task', priority: 'low' } }],
      fx.ctx,
    );
    const itemId = withItems.items[0]!.id;
    await plansService.markPlanned(plan.id, fx.ctx);

    const updated = await plansService.updateProposal(
      plan.id,
      itemId,
      { priority: 'highest' },
      fx.ctx,
    );
    const edited = updated.items.find((i) => i.id === itemId)!;
    expect(edited.proposedFields?.title).toBe('Keep me'); // untouched
    expect(edited.proposedFields?.kind).toBe('task'); // untouched
    expect(edited.proposedFields?.priority).toBe('highest'); // changed
  });

  it('rejects an edit that would empty the title (InvalidProposalError)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Has a title', kind: 'task' } },
    ]);
    const item = (await plansService.getPlan(planId, fx.ctx)).items[0]!;
    await expect(
      plansService.updateProposal(planId, item.id, { title: '   ' }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it('rejects editing a non-add (modify) proposal (InvalidProposalError)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Existing target');
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target, patch: { title: 'X' } }],
      fx.ctx,
    );
    const itemId = withItems.items[0]!.id;
    await plansService.markPlanned(plan.id, fx.ctx);
    await expect(
      plansService.updateProposal(plan.id, itemId, { title: 'Y' }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it('rejects an unknown plan item (PlanItemNotFoundError)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'A', kind: 'task' } },
    ]);
    await expect(
      plansService.updateProposal(planId, 'pi_does_not_exist', { title: 'Z' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanItemNotFoundError);
  });

  it('rejects when the plan is not planned (generating, then approved)', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A', kind: 'task' } }],
      fx.ctx,
    );
    const itemId = withItems.items[0]!.id;
    // generating
    await expect(
      plansService.updateProposal(plan.id, itemId, { title: 'B' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotInExpectedStatusError);
    // approved (immutable)
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);
    await expect(
      plansService.updateProposal(plan.id, itemId, { title: 'C' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotInExpectedStatusError);
  });

  it('enforces ai:view_plan — a non-member is denied (MOTIR-2363)', async () => {
    // Was `canEdit` → `ProjectAccessDeniedError`. Editing a PROPOSAL is acting on
    // a generated plan, not on the tree, so it moved to `ai:view_plan` (with
    // approve and decline, which MOTIR-3188 has since split onto
    // `ai:decide_plan` — this path is an AUTHOR write and stays here).
    //
    // The refusal is now the 404-shaped one, and that is the point: this actor
    // holds no workspace membership, so `assertPermission` rejects them as a
    // NON-BROWSER before the key is ever tested. A 403 here would have confirmed
    // the project exists to someone who may not see it, which the old
    // `ProjectAccessDeniedError(browse)` did only by convention.
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'A', kind: 'task' } },
    ]);
    const item = (await plansService.getPlan(planId, fx.ctx)).items[0]!;
    const outsider = await createTestUser();
    const outsiderCtx = { userId: outsider.id, workspaceId: fx.ctx.workspaceId };
    await expect(
      plansService.updateProposal(planId, item.id, { title: 'B' }, outsiderCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('plansService.deepenProposal — deepen a proposed add while generating (7.4.4a)', () => {
  /** Open a `generating` plan with one title-only `add` (the titles-first Phase
   *  1 shape) and return { planId, itemId }. NOT marked planned — the deepen
   *  runs while still generating. */
  async function generatingAdd(
    fx: WorkItemFixture,
    proposedFields: { title: string; kind?: string } = { title: 'Title only', kind: 'story' },
  ): Promise<{ planId: string; itemId: string }> {
    const plan = await plansService.createPlan(fx.projectId, { title: 'Gen' }, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields }],
      fx.ctx,
    );
    return { planId: plan.id, itemId: withItems.items[0]!.id };
  }

  it('patches a generating plan’s add in place (Phase-2 deepen); no WorkItem, stays generating', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await generatingAdd(fx);

    const updated = await plansService.deepenProposal(
      planId,
      itemId,
      {
        descriptionMd: 'The full card body, written now.',
        type: 'code',
        priority: 'high',
        storyPoints: 5,
        estimateMinutes: 55,
      },
      fx.ctx,
    );
    const edited = updated.items.find((i) => i.id === itemId)!;
    expect(edited.proposedFields).toMatchObject({
      title: 'Title only', // untouched
      descriptionMd: 'The full card body, written now.',
      type: 'code',
      priority: 'high',
      storyPoints: 5,
      estimateMinutes: 55,
    });
    // Still a proposal, and the plan is still open for more appends.
    const workItemCount = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    expect(workItemCount).toBe(0);
    expect((await adminDb.plan.findFirst({ where: { id: planId } }))!.status).toBe('generating');
  });

  it('merges sparsely — an explicit null clears the estimate, an absent key is untouched', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await generatingAdd(fx);
    await plansService.deepenProposal(
      planId,
      itemId,
      { storyPoints: 3, estimateMinutes: 30 },
      fx.ctx,
    );

    const cleared = await plansService.deepenProposal(
      planId,
      itemId,
      { estimateMinutes: null },
      fx.ctx,
    );
    const item = cleared.items.find((i) => i.id === itemId)!;
    expect(item.proposedFields?.storyPoints).toBe(3); // untouched
    expect(item.proposedFields?.estimateMinutes).toBeNull(); // cleared
    expect(item.proposedFields?.title).toBe('Title only'); // untouched
  });

  it('rejects once the plan is no longer generating (planned)', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await generatingAdd(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await expect(
      plansService.deepenProposal(planId, itemId, { descriptionMd: 'too late' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotInExpectedStatusError);
  });

  it('rejects an edit that would empty the title (InvalidProposalError)', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await generatingAdd(fx);
    await expect(
      plansService.deepenProposal(planId, itemId, { title: '   ' }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it('rejects deepening a non-add (modify) proposal (InvalidProposalError)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Existing');
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target, patch: { title: 'X' } }],
      fx.ctx,
    );
    await expect(
      plansService.deepenProposal(plan.id, withItems.items[0]!.id, { title: 'Y' }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it('rejects an unknown plan item (PlanItemNotFoundError)', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingAdd(fx);
    await expect(
      plansService.deepenProposal(planId, 'pi_missing', { title: 'Z' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanItemNotFoundError);
  });

  it('rejects a patched-in bad estimate (InvalidEstimateError)', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await generatingAdd(fx);
    await expect(
      plansService.deepenProposal(planId, itemId, { estimateMinutes: -5 }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidEstimateError); // minutes must be a non-negative integer
  });

  it('enforces ai:view_plan — a non-member is denied (MOTIR-2363)', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await generatingAdd(fx);
    const outsider = await createTestUser();
    const outsiderCtx = { userId: outsider.id, workspaceId: fx.ctx.workspaceId };
    await expect(
      plansService.deepenProposal(planId, itemId, { descriptionMd: 'x' }, outsiderCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('plansService.updateProposal — concurrency (edit vs approve)', () => {
  it('an edit racing an approve resolves consistently: plan approved once, one work item, no raw race', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Race', kind: 'task' } },
    ]);
    const item = (await plansService.getPlan(planId, fx.ctx)).items[0]!;

    const results = await Promise.allSettled([
      plansService.approvePlan(planId, fx.ctx),
      plansService.updateProposal(planId, item.id, { title: 'Edited mid-approve' }, fx.ctx),
    ]);

    // Both lock the plan row, so they serialize: either the edit lands first then
    // approve materializes the edited add (both succeed), or approve lands first
    // and the edit observes `approved` and throws the typed guard. Never a raw race.
    const rejected = results.filter((r) => r.status === 'rejected');
    rejected.forEach((r) =>
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(PlanNotInExpectedStatusError),
    );
    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.status).toBe('approved');
    // Exactly ONE work item materialized (no double-create, no orphan), titled by
    // whichever ordering won.
    const created = await adminDb.workItem.findMany({
      where: { projectId: fx.projectId, title: { in: ['Race', 'Edited mid-approve'] } },
    });
    expect(created).toHaveLength(1);
  });
});

// The immutable onboarding-ran marker (Subtask 7.4 / MOTIR-1264): approving the
// project's FIRST plan stamps `project.onboardingRanAt` (the single source of
// truth the /onboarding redirect AND the roadmap planning-origin cluster read);
// it is SET-ONCE — never re-written by a later approve — and a plan that never
// materializes (declined) never stamps it.
describe('plansService.approvePlan — onboarding-ran marker (MOTIR-1264)', () => {
  it('stamps onboardingRanAt on the FIRST plan approve + materialize', async () => {
    const fx = await makeWorkItemFixture();
    const before = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(before.onboardingRanAt).toBeNull(); // a fresh project never onboarded

    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'First tree', kind: 'task' } },
    ]);
    const t0 = Date.now();
    await plansService.approvePlan(planId, fx.ctx);

    const after = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(after.onboardingRanAt).toBeInstanceOf(Date);
    // Stamped with the approval moment (allow generous clock slack on a slow CI box).
    expect(Math.abs(after.onboardingRanAt!.getTime() - t0)).toBeLessThan(60_000);
  });

  it('is immutable — a SECOND approved plan never re-stamps the marker', async () => {
    const fx = await makeWorkItemFixture();

    const planA = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Tree A', kind: 'task' } },
    ]);
    await plansService.approvePlan(planA, fx.ctx);
    const firstStamp = (await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } }))
      .onboardingRanAt;
    expect(firstStamp).toBeInstanceOf(Date);

    // A later, separately-approved plan on the SAME project must NOT move the
    // marker — the null-guarded write is a no-op once the stamp exists.
    const planB = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Tree B', kind: 'task' } },
    ]);
    await plansService.approvePlan(planB, fx.ctx);
    const secondStamp = (await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } }))
      .onboardingRanAt;
    expect(secondStamp!.getTime()).toBe(firstStamp!.getTime());
  });

  it('a DECLINED plan never stamps the marker (no materialize → never onboarded)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Dropped', kind: 'task' } },
    ]);
    await plansService.declinePlan(planId, fx.ctx);

    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(project.onboardingRanAt).toBeNull();
  });
});

// MOTIR-1551 — name the onboarded project from the AI plan. The onboarding
// generation (producer MOTIR-1554) stamps a suggested `productName` on the Plan
// via the FINAL append; approve applies it with `renameProject`'s effect, but
// ONLY on the first onboarding approve of a draft the user hasn't already named.
// Real Postgres. The provisional placeholder string is passed in (the route
// resolves it from i18n); here the tests supply it directly.
const PROVISIONAL = 'Untitled project';

/** Create a plan, append proposals, and mark it planned WITH a productName —
 *  the onboarding-generation final append. */
async function plannedPlanNamed(
  fx: WorkItemFixture,
  productName: string | null,
  proposals: Parameters<typeof plansService.addProposals>[1] = [
    { op: 'add', proposedFields: { title: 'Tree', kind: 'task' } },
  ],
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Build it' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx, { productName });
  return plan.id;
}

describe('plansService.markPlanned — productName persistence (MOTIR-1551)', () => {
  it('persists a trimmed productName onto the Plan on the final append', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlanNamed(fx, '  Recipe Keeper  ');
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.productName).toBe('Recipe Keeper');
  });

  it('leaves productName null when the final append carries none (reconciliation run)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlanNamed(fx, null);
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.productName).toBeNull();
  });

  it('treats a blank/whitespace productName as none', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlanNamed(fx, '   ');
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.productName).toBeNull();
  });
});

describe('plansService.approvePlan — name the onboarded project (MOTIR-1551)', () => {
  it('renames a still-provisional draft to the plan productName on the first onboarding approve', async () => {
    const fx = await makeWorkItemFixture();
    await adminDb.project.update({ where: { id: fx.projectId }, data: { name: PROVISIONAL } });

    const planId = await plannedPlanNamed(fx, 'Recipe Keeper');
    await plansService.approvePlan(planId, fx.ctx, { provisionalProjectName: PROVISIONAL });

    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(project.name).toBe('Recipe Keeper');
    expect(project.onboardingRanAt).toBeInstanceOf(Date); // still stamped
  });

  it('never clobbers a project the user already renamed during review', async () => {
    const fx = await makeWorkItemFixture();
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { name: 'My Cool Project' },
    });

    const planId = await plannedPlanNamed(fx, 'Recipe Keeper');
    await plansService.approvePlan(planId, fx.ctx, { provisionalProjectName: PROVISIONAL });

    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(project.name).toBe('My Cool Project');
  });

  it('is a no-op when the plan carries no productName (a null → keeps the placeholder)', async () => {
    const fx = await makeWorkItemFixture();
    await adminDb.project.update({ where: { id: fx.projectId }, data: { name: PROVISIONAL } });

    const planId = await plannedPlanNamed(fx, null);
    await plansService.approvePlan(planId, fx.ctx, { provisionalProjectName: PROVISIONAL });

    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(project.name).toBe(PROVISIONAL);
  });

  it('does not rename on a LATER approve (onboardingRanAt already set), even if that plan carries a name', async () => {
    const fx = await makeWorkItemFixture();
    await adminDb.project.update({ where: { id: fx.projectId }, data: { name: PROVISIONAL } });

    // First onboarding approve carries NO name → the placeholder survives, and
    // onboardingRanAt is stamped.
    const planA = await plannedPlanNamed(fx, null);
    await plansService.approvePlan(planA, fx.ctx, { provisionalProjectName: PROVISIONAL });
    expect((await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } })).name).toBe(
      PROVISIONAL,
    );

    // A later plan carrying a productName must NOT rename — the project has
    // already onboarded (a reconciliation run wouldn't send a name anyway).
    const planB = await plannedPlanNamed(fx, 'Late Name');
    await plansService.approvePlan(planB, fx.ctx, { provisionalProjectName: PROVISIONAL });

    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(project.name).toBe(PROVISIONAL);
  });
});

// Bug MOTIR-1433 — the Plan substrate must CARRY leaf sizing (storyPoints +
// estimateMinutes, the estimation gate) on a proposed `add`, round-trip it
// through getPlan, MAP it onto the materialized WorkItem, and let updateProposal
// patch it. Real Postgres.
describe('plansService — leaf sizing on proposals (MOTIR-1433)', () => {
  it('round-trips storyPoints + estimateMinutes: addProposals → getPlan → materialize onto the WorkItem', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Sized' }, fx.ctx);
    const after = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Sized leaf',
            kind: 'task',
            type: 'code',
            storyPoints: 5,
            estimateMinutes: 55,
          },
        },
      ],
      fx.ctx,
    );
    // The proposal carries the sizing (the DTO round-trips it from the JSON column).
    expect(after.items[0]!.proposedFields).toMatchObject({ storyPoints: 5, estimateMinutes: 55 });

    // getPlan reads it back identically (no WorkItem yet).
    const reread = await plansService.getPlan(plan.id, fx.ctx);
    expect(reread.items[0]!.proposedFields).toMatchObject({ storyPoints: 5, estimateMinutes: 55 });

    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    // Materialize mapped the sizing onto the created WorkItem (the gate survives).
    const created = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Sized leaf' } });
    expect(Number(created.storyPoints)).toBe(5);
    expect(created.estimateMinutes).toBe(55);

    // The 'created' revision records the sizing (mirrors the normal create diff).
    const rev = await adminDb.workItemRevision.findFirstOrThrow({
      where: { workItemId: created.id, changeKind: 'created' },
    });
    expect(rev.diff).toMatchObject({
      storyPoints: { from: null, to: 5 },
      estimateMinutes: { from: null, to: 55 },
    });
  });

  it('an add with no sizing materializes an unestimated WorkItem (sizing stays null)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Unsized', kind: 'task' } },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Unsized' } });
    expect(created.storyPoints).toBeNull();
    expect(created.estimateMinutes).toBeNull();
  });

  it('updateProposal patches sizing in place; an explicit null clears it', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Resize me', kind: 'task', storyPoints: 2 } }],
      fx.ctx,
    );
    const itemId = withItems.items[0]!.id;
    await plansService.markPlanned(plan.id, fx.ctx);

    // Patch the point value + set a minute estimate.
    const patched = await plansService.updateProposal(
      plan.id,
      itemId,
      { storyPoints: 8, estimateMinutes: 90 },
      fx.ctx,
    );
    expect(patched.items.find((i) => i.id === itemId)!.proposedFields).toMatchObject({
      storyPoints: 8,
      estimateMinutes: 90,
    });

    // An explicit null clears one while leaving the other untouched (sparse).
    const cleared = await plansService.updateProposal(
      plan.id,
      itemId,
      { storyPoints: null },
      fx.ctx,
    );
    const pf = cleared.items.find((i) => i.id === itemId)!.proposedFields!;
    expect(pf.storyPoints).toBeNull();
    expect(pf.estimateMinutes).toBe(90); // untouched
  });

  it('addProposals rejects malformed sizing (negative points, non-integer minutes) — InvalidEstimateError', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    await expect(
      plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title: 'Bad points', storyPoints: -1 } }],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidEstimateError);
    await expect(
      plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title: 'Bad minutes', estimateMinutes: 12.5 } }],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidEstimateError);
  });

  it('updateProposal rejects a patched-in bad estimate (InvalidEstimateError)', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'OK', kind: 'task', storyPoints: 3 } }],
      fx.ctx,
    );
    const itemId = withItems.items[0]!.id;
    await plansService.markPlanned(plan.id, fx.ctx);
    await expect(
      plansService.updateProposal(plan.id, itemId, { estimateMinutes: -5 }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidEstimateError);
  });
});

// ── MOTIR-4616 ─────────────────────────────────────────────────────────────────
// The CARRIER — a proposal can hold the card's ordered STEPS
// (`docs/decisions/agent-authored-plans.md` AMENDMENT 14 D1-D4). These prove the
// two WRITE boundaries over real Postgres: the append and the deepen. What
// approve does with the rows is MOTIR-4618's, and every DOOR onto the field is
// MOTIR-4619's — this block stops at `proposedFields`.
describe('plansService — proposed to-do list on an add (MOTIR-4616)', () => {
  /** A 201-character step: one past `TODO_TEXT_MAX_LENGTH`, built from the constant. */
  const OVER_TEXT = 'x'.repeat(TODO_TEXT_MAX_LENGTH + 1);

  it('round-trips `todos` through proposedFields VERBATIM, in array order', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Steps' }, fx.ctx);
    const todos = [
      { text: 'Create a Stripe restricted key', executor: 'human' as const },
      {
        text: 'Scope it to charges:write',
        notesMd: 'Dashboard → Developers → API keys.',
        executor: 'human' as const,
      },
      {
        text: 'Set it as the deployment secret',
        commandText: 'fly secrets set STRIPE_KEY=… -a motir',
        executor: 'coding_agent' as const,
      },
    ];
    const after = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Provision Stripe', kind: 'task', todos } }],
      fx.ctx,
    );
    expect(after.items[0]!.proposedFields!.todos).toEqual(todos);

    // Read back through getPlan — the JSON column is the persistence, and ORDER
    // is the whole contract (there is no `position` on a proposed row).
    const reread = await plansService.getPlan(plan.id, fx.ctx);
    expect(reread.items[0]!.proposedFields!.todos!.map((t) => t.text)).toEqual([
      'Create a Stripe restricted key',
      'Scope it to charges:write',
      'Set it as the deployment secret',
    ]);
  });

  it('an add with NO todos round-trips unchanged — the field is optional', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const after = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'No steps', kind: 'task' } }],
      fx.ctx,
    );
    expect(after.items[0]!.proposedFields!.todos).toBeUndefined();
  });

  it('accepts the boundary values and an empty list, and refuses every bar past it', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);

    // The boundary values are ACCEPTED — the cap is inclusive.
    await expect(
      plansService.addProposals(
        plan.id,
        [
          {
            op: 'add',
            proposedFields: {
              title: 'At the bar',
              kind: 'task',
              todos: [
                {
                  text: 'x'.repeat(TODO_TEXT_MAX_LENGTH),
                  notesMd: 'y'.repeat(TODO_NOTES_MAX_LENGTH),
                  commandText: 'z'.repeat(TODO_COMMAND_MAX_LENGTH),
                },
              ],
            },
          },
          { op: 'add', proposedFields: { title: 'Empty list', kind: 'task', todos: [] } },
        ],
        fx.ctx,
      ),
    ).resolves.toBeDefined();

    // The last row casts past its own type on purpose: `executor: 'robot'` is a
    // value the DTO forbids and an agent over the MCP is not type-checked by our
    // compiler, so the case that matters is the SERVICE refusing it.
    const refusals: ProposedTodoInput[] = [
      { text: '' },
      { text: OVER_TEXT },
      { text: 'ok', notesMd: 'y'.repeat(TODO_NOTES_MAX_LENGTH + 1) },
      { text: 'ok', commandText: 'z'.repeat(TODO_COMMAND_MAX_LENGTH + 1) },
      { text: 'ok', executor: 'robot' as unknown as 'human' },
    ];
    for (const row of refusals) {
      await expect(
        plansService.addProposals(
          plan.id,
          [{ op: 'add', proposedFields: { title: 'Bad step', kind: 'task', todos: [row] } }],
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(InvalidProposalError);
    }
  });

  it('refuses a non-empty list on a CONTAINER kind — a story’s steps are its children', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    await expect(
      plansService.addProposals(
        plan.id,
        [
          {
            op: 'add',
            proposedFields: { title: 'A story', kind: 'story', todos: [{ text: 'Step one' }] },
          },
        ],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it('updateProposal merges `todos` sparsely: omitted leaves, a new array REPLACES, `[]` empties, `null` clears', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Deepen my steps',
            kind: 'task',
            todos: [{ text: 'First' }, { text: 'Second' }],
          },
        },
      ],
      fx.ctx,
    );
    const itemId = withItems.items[0]!.id;
    await plansService.markPlanned(plan.id, fx.ctx);

    // OMITTED — the list is left exactly as it was.
    const untouched = await plansService.updateProposal(
      plan.id,
      itemId,
      { descriptionMd: 'The body arrives on the deepen turn.' },
      fx.ctx,
    );
    expect(untouched.items.find((i) => i.id === itemId)!.proposedFields!.todos).toHaveLength(2);

    // A NEW ARRAY replaces the set whole — no per-row merge.
    const replaced = await plansService.updateProposal(
      plan.id,
      itemId,
      { todos: [{ text: 'Only step', executor: 'human' }] },
      fx.ctx,
    );
    expect(replaced.items.find((i) => i.id === itemId)!.proposedFields!.todos).toEqual([
      { text: 'Only step', executor: 'human' },
    ]);

    // `[]` EMPTIES it.
    const emptied = await plansService.updateProposal(plan.id, itemId, { todos: [] }, fx.ctx);
    expect(emptied.items.find((i) => i.id === itemId)!.proposedFields!.todos).toEqual([]);

    // `null` CLEARS it.
    const cleared = await plansService.updateProposal(plan.id, itemId, { todos: null }, fx.ctx);
    expect(cleared.items.find((i) => i.id === itemId)!.proposedFields!.todos).toBeNull();
  });

  it('re-validates on the MERGED result: a deepen that flips `kind` to a container is refused', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Leaf with steps', kind: 'task', todos: [{ text: 'Step' }] },
        },
      ],
      fx.ctx,
    );
    const itemId = withItems.items[0]!.id;
    await plansService.markPlanned(plan.id, fx.ctx);

    // The patch alone is innocent — it names only `kind`. It is the MERGE that
    // is illegal, which is exactly why the gate reads the merge.
    await expect(
      plansService.updateProposal(plan.id, itemId, { kind: 'story' }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidProposalError);

    // And the mirror: patching only `todos` onto a proposal that is ALREADY a
    // container is refused on the same read.
    const containerPlan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const container = await plansService.addProposals(
      containerPlan.id,
      [{ op: 'add', proposedFields: { title: 'A story', kind: 'story' } }],
      fx.ctx,
    );
    await plansService.markPlanned(containerPlan.id, fx.ctx);
    await expect(
      plansService.updateProposal(
        containerPlan.id,
        container.items[0]!.id,
        { todos: [{ text: 'Step' }] },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it('refuses a patched-in step past the bar on the deepen turn', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'OK', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await expect(
      plansService.updateProposal(
        plan.id,
        withItems.items[0]!.id,
        { todos: [{ text: OVER_TEXT }] },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });
});

// ── MOTIR-3050 ─────────────────────────────────────────────────────────────────
// An approved plan's dependent cards used to land at the workflow's INITIAL
// status even when the proposal carried `blockedByRefs` naming an unfinished
// item: the edges were wired, the status was not derived from them. These prove
// the derivation happens AT BIRTH and nowhere else — and that it reuses the
// readiness classifier rather than defining a second rule.
describe('plansService.approvePlan — a materialized add is born `blocked` when its edges say so (MOTIR-3050)', () => {
  it('an add blocked_by a NOT-DONE existing item materializes as `blocked`', async () => {
    const fx = await makeWorkItemFixture();
    const blockerId = await seedItem(fx, 'Unfinished blocker');

    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Waits on the blocker', kind: 'task' },
        blockedByRefs: [blockerId],
      },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Waits on the blocker' },
    });
    expect(created.status).toBe('blocked');
  });

  it('an add blocked_by an INTRA-PLAN sibling materializes as `blocked` (the sibling cannot be done)', async () => {
    const fx = await makeWorkItemFixture();

    const plan = await plansService.createPlan(fx.projectId, { title: 'Chain' }, fx.ctx);
    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Produces', kind: 'task' } }],
      fx.ctx,
    );
    const producerItemId = first.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Consumes', kind: 'task' },
          blockedByRefs: [`planItem:${producerItemId}`],
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const producer = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Produces' } });
    const consumer = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Consumes' } });
    expect(producer.status).toBe('todo'); // nothing blocks it
    expect(consumer.status).toBe('blocked');
  });

  it('an add with NO blockers still materializes at the INITIAL status (AC 2 — unchanged)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Free to start', kind: 'task' } },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Free to start' } });
    expect(created.status).toBe('todo');
  });

  it('an add whose only blocker is already DONE materializes at the INITIAL status', async () => {
    const fx = await makeWorkItemFixture();
    const blockerId = await seedItem(fx, 'Finished blocker');
    await adminDb.workItem.update({ where: { id: blockerId }, data: { status: 'done' } });

    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Its blocker landed', kind: 'task' },
        blockedByRefs: [blockerId],
      },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Its blocker landed' },
    });
    expect(created.status).toBe('todo');
  });

  it('reuses the READINESS classifier, not a second rule: an INTEGRATED (session-branch) blocker satisfies too', async () => {
    const fx = await makeWorkItemFixture();
    const blockerId = await seedItem(fx, 'Integrated blocker');
    // Non-terminal, but integrated-awaiting-review — `classifyBlockerReadiness`
    // counts this as satisfied (Subtask 7.8.11), so the dependent is ready and
    // must NOT be born blocked.
    await adminDb.workItem.update({
      where: { id: blockerId },
      data: { status: 'in_review', sessionBranch: 'session/abc' },
    });

    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Rides the session branch', kind: 'task' },
        blockedByRefs: [blockerId],
      },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Rides the session branch' },
    });
    expect(created.status).toBe('todo');
  });

  // ⚠️ AC 3 IS REVERSED BY MOTIR-5646, and this is a DECISION rather than a
  // regression — `agent-authored-plans.md` AMENDMENT 16 D7, row 2.
  //
  // MOTIR-3050's rule was *"FOR AN EDGE, A `modify` NEVER MOVES THE STATUS ON ITS
  // OWN ACCOUNT"*, and its warrant is quoted in `materialize`: an `add` has no
  // prior status to overwrite, while a `modify` target has one that somebody
  // RECORDED — *"that card may be `in_progress` with a live worktree … an approve
  // cannot see any of that."*
  //
  // What changed is the PREMISE, not the argument. The card no longer arrives at
  // the approve wearing a status somebody recorded: its own append PARKED it at
  // `planning` (MOTIR-5645), so the recorded status is already displaced and
  // stored on the lock. The approve is therefore not overwriting a fact it cannot
  // see — it is answering the question the park deferred, and the owner's ruling
  // is that the answer is `todo`, or `blocked` when the card still waits on
  // something. A card that gains a prerequisite waits on something.
  //
  // The half of MOTIR-3050 that is UNTOUCHED is the one about `blocked` not being
  // a projection of the edges: nothing recomputes this column later, no human's
  // externally-motivated block is ever cleared, and the resting status is written
  // exactly once, at the approve, over a status the same plan put there.
  it('AC 3 (REVERSED by MOTIR-5646) — a `modify` that newly blocks an EXISTING card rests it at `blocked`', async () => {
    const fx = await makeWorkItemFixture();
    const blockerId = await seedItem(fx, 'Newly discovered prerequisite');
    const targetId = await seedItem(fx, 'Already in flight');
    await adminDb.workItem.update({ where: { id: targetId }, data: { status: 'in_progress' } });

    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: targetId, patch: { blockedByAdd: [blockerId] } },
    ]);
    // The park has already displaced the recorded status — that is the premise
    // MOTIR-3050's rule rested on, and it no longer holds.
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } })).status).toBe(
      'planning',
    );

    await plansService.approvePlan(planId, fx.ctx);

    const target = await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } });
    // The EDGE lands, and the card rests where the edge says it belongs.
    expect(target.status).toBe('blocked');
    const link = await adminDb.workItemLink.findFirst({
      where: { fromId: targetId, toId: blockerId, kind: 'is_blocked_by' },
    });
    expect(link).not.toBeNull();
    // And the prior status is not lost silently — it is on the park's revision.
    expect(await statusMoves(targetId)).toEqual([
      { from: 'in_progress', to: 'planning' },
      { from: 'planning', to: 'blocked' },
    ]);
  });

  it('AC 4 — the two authoring doors agree: the same tree via create+transition and via approve ends in the same statuses', async () => {
    const fx = await makeWorkItemFixture();

    // Door 1 — DIRECT: create the pair, wire the edge, and set `blocked` by hand
    // (what the planner runbook prescribes on that path).
    const directBlockerId = await seedItem(fx, 'direct blocker');
    const directDependentId = await seedItem(fx, 'direct dependent');
    await workItemsService.linkWorkItems(
      { fromId: directDependentId, toId: directBlockerId, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await adminDb.workItem.update({
      where: { id: directDependentId },
      data: { status: 'blocked' },
    });

    // Door 2 — PROPOSE: the same shape through a plan.
    const plan = await plansService.createPlan(fx.projectId, { title: 'Same tree' }, fx.ctx);
    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'plan blocker', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'plan dependent', kind: 'task' },
          blockedByRefs: [`planItem:${first.items[0]!.id}`],
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const directBlocker = await adminDb.workItem.findUniqueOrThrow({
      where: { id: directBlockerId },
    });
    const directDependent = await adminDb.workItem.findUniqueOrThrow({
      where: { id: directDependentId },
    });
    const planBlocker = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'plan blocker' },
    });
    const planDependent = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'plan dependent' },
    });

    expect(planBlocker.status).toBe(directBlocker.status);
    expect(planDependent.status).toBe(directDependent.status);
  });

  it('AC 5 — readiness is unchanged: it still comes from the edges, and it agrees with the seeded status', async () => {
    const fx = await makeWorkItemFixture();
    const blockerId = await seedItem(fx, 'Readiness blocker');

    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Readiness dependent', kind: 'task' },
        blockedByRefs: [blockerId],
      },
      { op: 'add', proposedFields: { title: 'Readiness free', kind: 'task' } },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const dependent = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Readiness dependent' },
    });
    const free = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Readiness free' } });

    const dependentDetail = await workItemsService.getIssueDetail(
      fx.projectId,
      dependent.identifier,
      fx.ctx,
    );
    const freeDetail = await workItemsService.getIssueDetail(fx.projectId, free.identifier, fx.ctx);
    expect(dependentDetail.readiness.ready).toBe(false);
    expect(dependentDetail.readiness.openBlockers.map((b) => b.id)).toEqual([blockerId]);
    expect(freeDetail.readiness.ready).toBe(true);

    // …and readiness stays a function of the EDGES, not of the stored status:
    // finishing the blocker makes the dependent ready while it still reads `blocked`.
    await adminDb.workItem.update({ where: { id: blockerId }, data: { status: 'done' } });
    const afterDetail = await workItemsService.getIssueDetail(
      fx.projectId,
      dependent.identifier,
      fx.ctx,
    );
    expect(afterDetail.readiness.ready).toBe(true);
    expect(afterDetail.item.status).toBe('blocked');
  });
});

// ── ONE PROPOSAL PER EXISTING TARGET, AND A CONTAINED ORM BOUNDARY (MOTIR-3194) ─
//
// `PlanItem @@unique([planId, workItemId])` has always refused a second
// `modify`/`remove` for one target. What it refused WITH was Prisma's own
// ``Invalid `prisma.planItem.create()` invocation: Unique constraint failed on
// the (not available)`` — an ORM method name, no subject, and a constraint field
// rendering as nothing, delivered to a plan-authoring agent through
// `toToolError`'s re-throw.
//
// Two things are locked here, and the SECOND is the one a "fix the duplicate
// message" change would have left open:
//
//   1. The duplicate is refused in WORDS — a typed error naming the work item,
//      the op already held, and both alternatives — across batches, INSIDE one
//      batch (which never reaches the database at all), and across the two ops
//      the constraint spans. And the refusal is a refusal: nothing from the
//      rejected batch lands.
//   2. ANY OTHER Prisma failure on the same path is contained too. Asserted with
//      a REAL foreign-key violation against the real database — a `modify`
//      naming a work item that does not exist — because a boundary proven only
//      by the one error it was written for is not a boundary.

describe('plansService.addProposals — one proposal per existing target (MOTIR-3194)', () => {
  it('MERGES a second modify into the one the plan holds (AMENDMENT 18 §2) — one row, and the survivor’s id back', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'The survivor');
    const blocker = await seedItem(fx, 'A blocker');
    const plan = await plansService.createPlan(fx.projectId, { title: 'A re-plan' }, fx.ctx);

    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target, patch: { title: 'Re-scoped', priority: 'low' } }],
      fx.ctx,
    );
    const second = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target, patch: { priority: 'high', blockedByAdd: [blocker] } }],
      fx.ctx,
    );

    expect(second.appendedItemIds).toEqual(first.appendedItemIds);
    const after = await plansService.getPlan(plan.id, fx.ctx);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]!.patch).toEqual({
      title: 'Re-scoped',
      priority: 'high',
      blockedByAdd: [blocker],
    });
  });

  it('merges two modifies of one card INSIDE one batch, in batch order', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'The survivor');
    const plan = await plansService.createPlan(fx.projectId, { title: 'A re-plan' }, fx.ctx);

    const appended = await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'A new leaf' } },
        { op: 'modify', workItemId: target, patch: { title: 'Re-scoped' } },
        { op: 'modify', workItemId: target, patch: { title: 'Re-scoped again', priority: 'high' } },
      ],
      fx.ctx,
    );

    expect(appended.items).toHaveLength(2);
    expect(appended.appendedItemIds).toHaveLength(3);
    expect(appended.appendedItemIds[2]).toBe(appended.appendedItemIds[1]);
    const modifyRow = appended.items.find((i) => i.op === 'modify')!;
    expect(modifyRow.id).toBe(appended.appendedItemIds[1]);
    expect(modifyRow.patch).toEqual({ title: 'Re-scoped again', priority: 'high' });
  });

  it('refuses a modify + remove of one card INSIDE one batch, and appends NOTHING from it', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'The survivor');
    const plan = await plansService.createPlan(fx.projectId, { title: 'A re-plan' }, fx.ctx);

    await expect(
      plansService.addProposals(
        plan.id,
        [
          { op: 'add', proposedFields: { title: 'A new leaf' } },
          { op: 'modify', workItemId: target, patch: { title: 'Re-scoped' } },
          { op: 'remove', workItemId: target },
        ],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(DuplicatePlanTargetError);

    // ONE transaction: the legal proposals ahead of the collision are rolled
    // back with it, so a retry of the corrected batch cannot double-append.
    const after = await plansService.getPlan(plan.id, fx.ctx);
    expect(after.items).toHaveLength(0);
  });

  it('still refuses a `modify` after a `remove`, and a second `remove`, naming the way out', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'The obsolete card');
    const plan = await plansService.createPlan(fx.projectId, { title: 'A re-plan' }, fx.ctx);
    await plansService.addProposals(plan.id, [{ op: 'remove', workItemId: target }], fx.ctx);

    const modifyAfter = await plansService
      .addProposals(plan.id, [{ op: 'modify', workItemId: target, patch: { title: 'X' } }], fx.ctx)
      .catch((err: unknown) => err);
    expect(modifyAfter).toBeInstanceOf(DuplicatePlanTargetError);
    const err = modifyAfter as DuplicatePlanTargetError;
    expect(err.code).toBe('DUPLICATE_PLAN_TARGET');
    expect(err.existingOp).toBe('remove');
    expect(err.op).toBe('modify');
    expect(err.message).toContain(target);
    expect(err.message).toContain('withdraw_plan_proposal');
    expect(err.message).toContain('link_work_items');
    expect(err.message).not.toMatch(/prisma/i);

    const secondRemove = await plansService
      .addProposals(plan.id, [{ op: 'remove', workItemId: target }], fx.ctx)
      .catch((e: unknown) => e);
    expect(secondRemove).toBeInstanceOf(DuplicatePlanTargetError);
    expect((await plansService.getPlan(plan.id, fx.ctx)).items).toHaveLength(1);
  });

  it('spans the two ops — a `remove` for a target already carrying a `modify` is refused', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'The survivor');
    const plan = await plansService.createPlan(fx.projectId, { title: 'A re-plan' }, fx.ctx);

    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target, patch: { title: 'Re-scoped' } }],
      fx.ctx,
    );

    const refusal = await plansService
      .addProposals(plan.id, [{ op: 'remove', workItemId: target }], fx.ctx)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(DuplicatePlanTargetError);
    expect((refusal as DuplicatePlanTargetError).existingOp).toBe('modify');
    expect((refusal as DuplicatePlanTargetError).op).toBe('remove');
  });

  it('leaves `add` proposals alone — a plan may hold as many as it likes', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'A tree' }, fx.ctx);

    // Every `add` carries `workItemId: null` until materialize, and Postgres
    // treats NULLs as distinct — which is the whole reason the unique index can
    // constrain real targets without constraining a tree.
    const appended = await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'One' } },
        { op: 'add', proposedFields: { title: 'Two' } },
        { op: 'add', proposedFields: { title: 'Three' } },
      ],
      fx.ctx,
    );
    expect(appended.items).toHaveLength(3);
    expect(appended.items.every((i) => i.workItemId === null)).toBe(true);
  });

  it('contains ANY other ORM failure on the same path — a real FK violation, typed', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'A re-plan' }, fx.ctx);

    // A `modify` naming a work item that does not exist. `plan_item.work_item_id`
    // is a real foreign key, so this is a genuine Prisma failure (P2003) raised by
    // the real database on the real insert — no mock, and a DIFFERENT error from
    // the duplicate the card was filed about. Before the boundary was contained,
    // this escaped to an agent as Prisma's own invocation trace exactly as the
    // duplicate did.
    const refusal = await plansService
      .addProposals(
        plan.id,
        [{ op: 'modify', workItemId: 'cm_no_such_work_item', patch: { title: 'x' } }],
        fx.ctx,
      )
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(PlanPersistenceError);
    const err = refusal as PlanPersistenceError;
    expect(err.code).toBe('PLAN_PERSISTENCE_FAILED');
    expect(err.operation).toBe('plan proposal append');
    // The ORM's code rides as DATA — readable by a caller, absent from the prose.
    expect(err.ormCode).toBe('P2003');
    expect(err.message).not.toMatch(/prisma/i);
    expect(err.message).not.toMatch(/invocation/i);

    // The append is atomic, so the failed batch left the plan empty.
    const after = await plansService.getPlan(plan.id, fx.ctx);
    expect(after.items).toHaveLength(0);
  });

  it('passes the service’s OWN typed refusals through the containment untouched', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'A re-plan' }, fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);

    // The containment wraps the whole transaction, so the errors thrown INSIDE it
    // travel through the same catch. A wrapper that swallowed them would trade one
    // opaque failure for another.
    await expect(
      plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title: 'Late' } }],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(PlanNotGeneratingError);
  });
});

// MOTIR-3804 — a `modify` proposal's body could not carry an intra-plan CHIP.
// Pass 3 rewrote `motir-ref:planItem:<id>` over `createdAdds` only, so a token in a
// `modify`'s patch materialized VERBATIM: a dead href on a real work item, with not
// even the dangling-ref warning an `add` gets, because the rewrite never ran on it.
// That is the shape a RE-PLAN takes by default — `add` the new card, `remove` the
// superseded one, `modify` the survivor to name the card that took over its scope.
//
// Asserted END TO END through `approvePlan`, never on the helper: the defect was
// that a correct helper was not CALLED on this path, so a helper-level test would
// have passed throughout.
describe('plansService.approvePlan — a MODIFY body carries an intra-plan chip (MOTIR-3804)', () => {
  it('rewrites a `motir-ref:planItem:` token in a modify patch DESCRIPTION to the created card', async () => {
    const fx = await makeWorkItemFixture();
    const survivorId = await seedItem(fx, 'Survivor');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
    const afterAdd = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Took over the scope', kind: 'task' } }],
      fx.ctx,
    );
    const newPlanItemId = afterAdd.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: survivorId,
          patch: {
            descriptionMd: `Half of this moved to [the new card](motir-ref:planItem:${newPlanItemId}).`,
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Took over the scope' },
    });
    const survivor = await adminDb.workItem.findUniqueOrThrow({ where: { id: survivorId } });
    expect(survivor.descriptionMd).toBe(
      `Half of this moved to [the new card](motir:${created.id}).`,
    );
  });

  it('rewrites the same token in a modify patch EXPLANATION', async () => {
    const fx = await makeWorkItemFixture();
    const survivorId = await seedItem(fx, 'Survivor with a why');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
    const afterAdd = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'The successor', kind: 'task' } }],
      fx.ctx,
    );
    const newPlanItemId = afterAdd.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: survivorId,
          patch: {
            explanationMd: `It matters less now that [the successor](motir-ref:planItem:${newPlanItemId}) exists.`,
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({ where: { title: 'The successor' } });
    const survivor = await adminDb.workItem.findUniqueOrThrow({ where: { id: survivorId } });
    expect(survivor.explanationMd).toBe(
      `It matters less now that [the successor](motir:${created.id}) exists.`,
    );
  });

  it('leaves an UNRESOLVABLE ref in a modify body inert — the same way an add fails', async () => {
    const fx = await makeWorkItemFixture();
    const survivorId = await seedItem(fx, 'Survivor with a dangling ref');

    // An empty plan is declined at close, so it holds one unrelated `add`.
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Unrelated card', kind: 'task' } },
    ]);
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId,
        op: 'modify',
        workItemId: survivorId,
        blockedByRefs: [],
        patch: { descriptionMd: 'See [gone](motir-ref:planItem:pi_does_not_exist).' },
      },
    });
    // Must NOT throw — a dangling temp-ref is body text on either op.
    await plansService.approvePlan(planId, fx.ctx);

    const survivor = await adminDb.workItem.findUniqueOrThrow({ where: { id: survivorId } });
    expect(survivor.descriptionMd).toBe('See [gone](motir-ref:planItem:pi_does_not_exist).');
  });

  it('leaves a modify body with NO such token byte-identical (no incidental rewriting)', async () => {
    const fx = await makeWorkItemFixture();
    const survivorId = await seedItem(fx, 'Untouched prose');
    const body = 'Plain prose with a bare `motir-ref:` word and a [link](https://example.com).';

    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: survivorId, patch: { descriptionMd: body } },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const survivor = await adminDb.workItem.findUniqueOrThrow({ where: { id: survivorId } });
    expect(survivor.descriptionMd).toBe(body);
  });

  it('does NOT auto-relate from a rewritten MODIFY body — the decision, asserted', async () => {
    // AC 5 of MOTIR-3804 asks for this to be DECIDED rather than left to inference.
    // The `add` path auto-relates because a card born here has no edge set to
    // disturb; a `modify` targets a card that already has one, and the plan grammar
    // gives it an explicit `blockedByAdd` / `blockedByRemove` channel. So the body
    // CHIPS and no edge is written. If that is ever reversed, this test is the
    // sentence to change.
    const fx = await makeWorkItemFixture();
    const survivorId = await seedItem(fx, 'Survivor that must not be rewired');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
    const afterAdd = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Mentioned but not related', kind: 'task' } }],
      fx.ctx,
    );
    const newPlanItemId = afterAdd.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: survivorId,
          patch: { descriptionMd: `See [it](motir-ref:planItem:${newPlanItemId}).` },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Mentioned but not related' },
    });
    const survivor = await adminDb.workItem.findUniqueOrThrow({ where: { id: survivorId } });
    // The chip landed …
    expect(survivor.descriptionMd).toBe(`See [it](motir:${created.id}).`);
    // … and no `relates_to` edge was derived from it, in either direction.
    expect(
      await adminDb.workItemLink.count({
        where: {
          kind: 'relates_to',
          OR: [
            { fromId: survivorId, toId: created.id },
            { fromId: created.id, toId: survivorId },
          ],
        },
      }),
    ).toBe(0);
  });
});

// Bug MOTIR-9175 — a body `motir-ref:planItem:<id>` link naming no proposal on the
// plan is refused at every proposal write door, instead of shipping as dead text.
describe('plansService — a body link to a planItem the plan does not hold (MOTIR-9175)', () => {
  const DEAD = 'See [gone](motir-ref:planItem:pi_does_not_exist).';

  async function openPlanWithSibling(fx: WorkItemFixture) {
    const plan = await plansService.createPlan(fx.projectId, { title: 'Links' }, fx.ctx);
    const withSibling = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Sibling', kind: 'task' } }],
      fx.ctx,
    );
    return { planId: plan.id, siblingId: withSibling.items[0]!.id };
  }

  it('the append refuses an `add` and a `modify` whose body names an unknown id, and appends nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await openPlanWithSibling(fx);
    const targetId = await seedItem(fx, 'Committed target');

    for (const field of ['descriptionMd', 'explanationMd'] as const) {
      const err = await plansService
        .addProposals(
          planId,
          [{ op: 'add', proposedFields: { title: 'Links it', kind: 'task', [field]: DEAD } }],
          fx.ctx,
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidProposalError);
      expect((err as Error).message).toContain('pi_does_not_exist');
    }
    await expect(
      plansService.addProposals(
        planId,
        [{ op: 'modify', workItemId: targetId, patch: { descriptionMd: DEAD } }],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidProposalError);
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(1);
  });

  it('the append accepts a link to an `add` the plan already holds, and refuses one to a sibling of the same call', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, siblingId } = await openPlanWithSibling(fx);

    const ok = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Links it',
            kind: 'task',
            descriptionMd: `After [the sibling](motir-ref:planItem:${siblingId}). Syntax: \`[x](motir-ref:planItem:pi_not_checked)\`.`,
          },
        },
      ],
      fx.ctx,
    );
    expect(ok.items).toHaveLength(2);

    // An id belonging to a proposal in the SAME call cannot exist yet, so the
    // only way to write one is to name an id the plan does not hold.
    await expect(
      plansService.addProposals(
        planId,
        [
          { op: 'add', proposedFields: { title: 'Later', kind: 'task' } },
          {
            op: 'add',
            proposedFields: { title: 'Early', kind: 'task', descriptionMd: DEAD },
          },
        ],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it('the deepen / review edit refuses a dangling link it writes, accepts a resolving one, and leaves the proposal as it was', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, siblingId } = await openPlanWithSibling(fx);
    const withTarget = await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Target', kind: 'task' } }],
      fx.ctx,
    );
    const targetItemId = withTarget.items.find((i) => i.id !== siblingId)!.id;

    await expect(
      plansService.deepenProposal(planId, targetItemId, { descriptionMd: DEAD }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidProposalError);
    const untouched = await adminDb.planItem.findUniqueOrThrow({ where: { id: targetItemId } });
    expect((untouched.proposedFields as { descriptionMd?: string }).descriptionMd).toBeUndefined();

    await plansService.deepenProposal(
      planId,
      targetItemId,
      { descriptionMd: `Needs [the sibling](motir-ref:planItem:${siblingId}).` },
      fx.ctx,
    );
  });

  it('the correction refuses a dangling link on an `add` and on a `modify`, and accepts a resolving one', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, siblingId } = await openPlanWithSibling(fx);
    const targetId = await seedItem(fx, 'Committed target');
    const withModify = await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: targetId, patch: { title: 'Renamed' } }],
      fx.ctx,
    );
    const modifyItemId = withModify.items.find((i) => i.op === 'modify')!.id;

    await expect(
      plansService.correctProposal(planId, siblingId, { descriptionMd: DEAD }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidProposalError);
    await expect(
      plansService.correctProposal(
        planId,
        modifyItemId,
        { patch: { descriptionMd: DEAD } },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidProposalError);

    await plansService.correctProposal(
      planId,
      modifyItemId,
      { patch: { descriptionMd: `After [the sibling](motir-ref:planItem:${siblingId}).` } },
      fx.ctx,
    );
  });
});
