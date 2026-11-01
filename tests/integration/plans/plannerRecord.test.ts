import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { InvalidProposalError } from '@/lib/plans/errors';
import { PLANNER_RECORD_MAX_BYTES } from '@/lib/dto/plans';
import { runGetPlan } from '@/lib/mcp/tools/getPlan';
import { runUpdatePlan } from '@/lib/mcp/tools/authorPlan';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-9978 — a plan keeps its PLANNER's own record as data, against real
// Postgres.
//
// plan.py used to keep the targets its PART 1 settled inside the plan's
// `summary`, as a `motir-targets` JSON fence, because `summary` was the only
// field it could write — and the summary is the briefing a reviewer reads, so
// the rail drew the driver's JSON as a code block. The record now lives in
// `Plan.plannerRecord`, written by `update_plan` and read back by `get_plan`.
//
// ⚠️ THE ASSERTIONS THAT MATTER ARE THE NEGATIVE ONES: the record never reaches
// the plan DTO or the review the rail renders, and writing it alone leaves the
// summary and the plan's timeline exactly as they were.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const SUMMARY =
  'Plan the serverless adapter.\n\n## Targets the planner settled\n\n- MOTIR-1 (lay): to walk';
const RECORD = {
  targets: [
    {
      ref: 'MOTIR-1',
      kind: 'story',
      type: null,
      entry: 'lay',
      slice: 'THE SLICE NOBODY SHOULD SEE',
      conflict: '',
      state: 'to walk',
    },
  ],
};

async function openPlan(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(
    fx.projectId,
    {
      title: 'The serverless adapter',
      summary: SUMMARY,
      authorSource: 'mcp',
      authorHarness: 'Claude Code',
      authorModel: 'claude-opus-5',
    },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'A card', kind: 'task' } }],
    fx.ctx,
  );
  return plan.id;
}

const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const briefEdits = (planId: string) =>
  adminDb.planRevision.count({ where: { planId, changeKind: 'brief_edited' } });

describe('the planner record is stored as data, beside the summary', () => {
  it('update_plan writes it and get_plan reads it back, the summary untouched', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);

    const written = await runUpdatePlan({ planId, plannerRecord: RECORD }, fx.ctx);
    expect(written.isError).toBeFalsy();
    expect((written.structuredContent as Record<string, unknown>)['plannerRecord']).toEqual(RECORD);

    const row = await planRow(planId);
    expect(row.plannerRecord).toEqual(RECORD);
    expect(row.summary).toBe(SUMMARY);

    const read = await runGetPlan({ planId }, fx.ctx);
    expect((read.structuredContent as Record<string, unknown>)['plannerRecord']).toEqual(RECORD);
  });

  it('get_plan answers `plannerRecord: null` on a plan that keeps none', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    const read = await runGetPlan({ planId }, fx.ctx);
    const payload = read.structuredContent as Record<string, unknown>;
    expect('plannerRecord' in payload).toBe(true);
    expect(payload['plannerRecord']).toBeNull();
  });

  it('writes the summary and the record in one call, and `null` clears the record', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    await plansService.correctPlanBrief(
      planId,
      { summary: 'The briefing.', plannerRecord: RECORD },
      fx.ctx,
    );
    let row = await planRow(planId);
    expect(row.summary).toBe('The briefing.');
    expect(row.plannerRecord).toEqual(RECORD);

    await plansService.correctPlanBrief(planId, { plannerRecord: null }, fx.ctx);
    row = await planRow(planId);
    expect(row.plannerRecord).toBeNull();
    expect(row.summary).toBe('The briefing.');
  });

  it('a record-only write puts nothing on the timeline; a summary write still does', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);

    await plansService.correctPlanBrief(planId, { plannerRecord: RECORD }, fx.ctx);
    expect(await briefEdits(planId)).toBe(0);

    await plansService.correctPlanBrief(
      planId,
      { summary: 'Corrected.', plannerRecord: RECORD },
      fx.ctx,
    );
    const rows = await adminDb.planRevision.findMany({
      where: { planId, changeKind: 'brief_edited' },
    });
    expect(rows).toHaveLength(1);
    expect((rows[0]!.diff as { fields: string[] }).fields).toEqual(['summary']);
  });

  it('refuses a record that is not an object, or one over the size cap', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    await expect(
      plansService.correctPlanBrief(
        planId,
        { plannerRecord: [1, 2] as unknown as Record<string, unknown> },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidProposalError);
    await expect(
      plansService.correctPlanBrief(
        planId,
        { plannerRecord: { blob: 'x'.repeat(PLANNER_RECORD_MAX_BYTES) } },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidProposalError);
    expect((await planRow(planId)).plannerRecord).toBeNull();
  });
});

describe('the review surface never receives the planner record', () => {
  it('is on neither the plan DTO nor the review the rail renders', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    await plansService.correctPlanBrief(planId, { plannerRecord: RECORD }, fx.ctx);
    await plansService.markPlanned(planId, fx.ctx);

    const dto = await plansService.getPlanForReader(planId, fx.ctx);
    expect('plannerRecord' in dto).toBe(false);
    expect(JSON.stringify(dto)).not.toContain('THE SLICE NOBODY SHOULD SEE');

    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(JSON.stringify(review)).not.toContain('THE SLICE NOBODY SHOULD SEE');
    expect(JSON.stringify(review)).not.toContain('plannerRecord');
  });
});
