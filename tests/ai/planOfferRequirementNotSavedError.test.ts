import { describe, expect, it } from 'vitest';
import {
  PlanOfferRequirementNotSavedError,
  PlanOfferStartRefusedError,
} from '@/lib/planChange/errors';
import { mapPlanChangeError } from '@/app/api/ai/plan-change/_errors';

// A requirement page that could not be saved is a retryable 503, distinct from the 409
// refusal of an offer that cannot start (MOTIR-9436).

describe('PlanOfferRequirementNotSavedError', () => {
  it('maps to 503 with its code, not the 409 of a refused start', async () => {
    const saved = mapPlanChangeError(new PlanOfferRequirementNotSavedError(new Error('x')));
    expect(saved?.status).toBe(503);
    expect(await saved?.json()).toMatchObject({ code: 'PLAN_OFFER_REQUIREMENT_NOT_SAVED' });
    expect(mapPlanChangeError(new PlanOfferStartRefusedError('offer_not_open'))?.status).toBe(409);
  });
});
