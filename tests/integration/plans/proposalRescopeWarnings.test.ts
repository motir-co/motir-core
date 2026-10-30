import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { PlanItemPatch } from '@/lib/dto/plans';
import { runValidatePlan } from '@/lib/mcp/tools/validatePlan';
import { planReviewService } from '@/lib/services/planReviewService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-10106 — a `modify` that approve will send back from built work is
// WRITTEN, and the write door says so. Approve moves a card at `implemented` /
// `in_review` / `approved` to To Do, Blocked or In Progress when the patch changes
// its title, description or repository (`patchRescopes`, MOTIR-10102); the
// reviewer is shown that as a status row, and now the planner is told too — at the
// append, the deepen and the correction, and on `validate_plan` — through the same
// read the row is built from.
//
// Real Postgres, through the service — the layer every door shares.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedCard(fx: WorkItemFixture, status: string): Promise<{ id: string; key: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Serving previews', descriptionMd: 'Old.' },
    fx.ctx,
  );
  // Statuses past `in_progress` are written by CI and gates, not a person's move.
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status } });
  return { id: dto.id, key: dto.identifier };
}

async function openPlan(fx: WorkItemFixture): Promise<string> {
  return (await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx)).id;
}

const modify = (workItemId: string, patch: PlanItemPatch) =>
  ({ op: 'modify', workItemId, patch }) as const;

describe('the APPEND door warns on a `modify` approve will re-open (MOTIR-10106)', () => {
  it('writes a description change to an implemented card and warns with key, status, outcomes and field', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx, 'implemented');
    const planId = await openPlan(fx);

    const result = await plansService.addProposals(
      planId,
      [modify(card.id, { descriptionMd: 'Match what shipped.' })],
      fx.ctx,
    );

    const modifyId = result.appendedItemIds[0]!;
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyId } });
    expect((row.patch as { descriptionMd?: string }).descriptionMd).toBe('Match what shipped.');
    expect(result.rescopeWarnings).toEqual([
      {
        planItemId: modifyId,
        proposal: `the \`modify\` of work item ${card.id}`,
        workItemId: card.id,
        identifier: card.key,
        status: 'implemented',
        statusLabel: 'Implemented',
        outcomes: 'To Do, Blocked, or In Progress',
        fields: ['descriptionMd'],
        message: expect.stringContaining(
          `approve will re-open ${card.key} (Implemented → To Do, Blocked, or In Progress) because this patch changes its description.`,
        ),
      },
    ]);
  });

  it('names a title and a repository re-pin too', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx, 'in_review');
    const planId = await openPlan(fx);

    const result = await plansService.addProposals(
      planId,
      [modify(card.id, { title: 'Renamed', targetRepoRole: 'other' })],
      fx.ctx,
    );

    expect(result.rescopeWarnings).toEqual([
      expect.objectContaining({ status: 'in_review', fields: ['title', 'repository'] }),
    ]);
  });

  it('writes a type / sizing / priority / explanation / edges patch to an implemented card with no warning', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx, 'implemented');
    const blocker = await seedCard(fx, 'todo');
    const planId = await openPlan(fx);

    const result = await plansService.addProposals(
      planId,
      [
        modify(card.id, {
          type: 'test',
          storyPoints: 3,
          estimateMinutes: 30,
          priority: 'high',
          explanationMd: 'Why, again.',
          blockedByAdd: [blocker.id],
        }),
      ],
      fx.ctx,
    );

    expect(result.appendedItemIds).toHaveLength(1);
    expect(result).not.toHaveProperty('rescopeWarnings');
  });

  it('never warns on a To Do card, whatever the patch rewrites', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx, 'todo');
    const planId = await openPlan(fx);

    const result = await plansService.addProposals(
      planId,
      [modify(card.id, { title: 'Renamed', descriptionMd: 'A new body.' })],
      fx.ctx,
    );

    expect(result).not.toHaveProperty('rescopeWarnings');
  });
});

describe('the DEEPEN door answers only for what it wrote (MOTIR-10106)', () => {
  it('a deepen of an `add` carries no re-scope warning, even on a plan holding one', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx, 'implemented');
    const planId = await openPlan(fx);
    const appended = await plansService.addProposals(
      planId,
      [
        modify(card.id, { descriptionMd: 'A new body.' }),
        { op: 'add', proposedFields: { title: 'New card', kind: 'task' } },
      ],
      fx.ctx,
    );
    expect(appended.rescopeWarnings).toHaveLength(1);
    const addId = appended.appendedItemIds[1]!;

    const result = await plansService.deepenProposal(
      planId,
      addId,
      { descriptionMd: 'Deepened.' },
      fx.ctx,
    );

    expect(result).not.toHaveProperty('rescopeWarnings');
  });
});

describe('the CORRECTION door warns on the patch it writes (MOTIR-10106)', () => {
  it('a correction that turns a sizing patch into a body rewrite is warned; correcting it back is not', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx, 'implemented');
    const planId = await openPlan(fx);
    const appended = await plansService.addProposals(
      planId,
      [modify(card.id, { storyPoints: 2 })],
      fx.ctx,
    );
    expect(appended).not.toHaveProperty('rescopeWarnings');
    const modifyId = appended.appendedItemIds[0]!;
    await plansService.markPlanned(planId, fx.ctx);

    const rewritten = await plansService.correctProposal(
      planId,
      modifyId,
      { patch: { storyPoints: 2, descriptionMd: 'Match what shipped.' } },
      fx.ctx,
    );
    expect(rewritten.rescopeWarnings).toEqual([
      expect.objectContaining({
        planItemId: modifyId,
        identifier: card.key,
        status: 'implemented',
        fields: ['descriptionMd'],
      }),
    ]);

    const back = await plansService.correctProposal(
      planId,
      modifyId,
      { patch: { storyPoints: 2 } },
      fx.ctx,
    );
    expect(back).not.toHaveProperty('rescopeWarnings');
  });
});

describe('validate_plan lists the same entry, and it agrees with the review row (MOTIR-10106)', () => {
  it('names the re-scoping `modify` beside the verdict, and the review row reads the same move', async () => {
    const fx = await makeWorkItemFixture();
    const built = await seedCard(fx, 'implemented');
    const resized = await seedCard(fx, 'implemented');
    const fresh = await seedCard(fx, 'todo');
    const planId = await openPlan(fx);
    const appended = await plansService.addProposals(
      planId,
      [
        modify(built.id, { descriptionMd: 'Match what shipped.' }),
        modify(resized.id, { storyPoints: 5 }),
        modify(fresh.id, { descriptionMd: 'A new body.' }),
      ],
      fx.ctx,
    );

    const tool = await runValidatePlan({ planId }, fx.ctx);
    const payload = tool.structuredContent as { rescopeWarnings: unknown[] };
    expect(payload.rescopeWarnings).toEqual(appended.rescopeWarnings);
    expect(payload.rescopeWarnings).toEqual([
      expect.objectContaining({
        workItemId: built.id,
        identifier: built.key,
        status: 'implemented',
      }),
    ]);
    const text = (tool.content[0] as { text: string }).text;
    expect(text).toContain(`(${built.key}): approve will re-open ${built.key}`);

    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    const statusRowOf = (planItemId: string) =>
      review.items
        .find((i) => i.planItemId === planItemId)!
        .changes.find((c) => c.field === 'status')?.to ?? '';
    const [builtId, resizedId, freshId] = appended.appendedItemIds as [string, string, string];
    expect(statusRowOf(builtId)).toBe(
      'To Do, Blocked, or In Progress (re-scoped while Implemented; decided when this plan is approved)',
    );
    expect(statusRowOf(resizedId)).not.toContain('re-scoped while');
    expect(statusRowOf(freshId)).not.toContain('re-scoped while');
  });
});
