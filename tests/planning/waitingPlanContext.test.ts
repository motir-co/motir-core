import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectContext } from '@/lib/projects';
import { planReviewService } from '@/lib/services/planReviewService';
import { planRunContextService } from '@/lib/services/planRunContextService';
import { planReview, planReviewItem } from '../helpers/planReview';

// The WAITING-PLAN snapshot an ask turn carries once its plan is proposed (Bug
// MOTIR-11488). It never throws: an unreadable plan is an honest `readable: false`.

const ctx = { userId: 'u1', workspaceId: 'w1', projectId: 'p1' } as unknown as ProjectContext;

afterEach(() => vi.restoreAllMocks());

describe('planRunContextService.buildWaitingPlanContext', () => {
  it('states the plan, its briefing and its proposals', async () => {
    const review = {
      ...planReview([planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', title: 'CSV writer' })]),
      projectId: 'p1',
      title: 'Fix the export',
      summary: 'Adds a writer.',
    };
    vi.spyOn(planReviewService, 'getPlanReview').mockResolvedValue(review);

    const out = await planRunContextService.buildWaitingPlanContext(review.id, ctx);

    expect(out).toMatchObject({
      planId: review.id,
      readable: true,
      planStatus: 'planned',
      title: 'Fix the export',
      summary: 'Adds a writer.',
      proposals: [{ ref: 'planItem:pi_1', title: 'CSV writer' }],
    });
  });

  it("reads another project's plan as not found", async () => {
    vi.spyOn(planReviewService, 'getPlanReview').mockResolvedValue({
      ...planReview([]),
      projectId: 'other',
    });
    expect(await planRunContextService.buildWaitingPlanContext('plan-x', ctx)).toEqual({
      planId: 'plan-x',
      readable: false,
      reason: 'PLAN_NOT_FOUND',
    });
  });

  it('reports a failed read by its code, never throwing', async () => {
    vi.spyOn(planReviewService, 'getPlanReview').mockRejectedValue(
      Object.assign(new Error('x'), { code: 'PLAN_ACCESS_DENIED' }),
    );
    expect(await planRunContextService.buildWaitingPlanContext('plan-x', ctx)).toEqual({
      planId: 'plan-x',
      readable: false,
      reason: 'PLAN_ACCESS_DENIED',
    });
  });
});
