import { defineJob } from '../defineJob';
import { resolveRetries } from '../retries';
import type { PlanOfferRequirementPageRequestedData } from '../types';

// THE REQUIREMENT PAGE OF A CONFIRMED PLAN OFFER (MOTIR-10091) — one run per offer,
// requested by the confirm after the transaction that claimed the offer commits. The run
// is already started by then: this only keeps the record. The policy is all in
// `requirementPageSaveService`; this file is the trigger, the retry budget, the dedup key
// and the two steps.
//
// `idempotency` on the offer turn's id, so Confirm twice, or Confirm and a typed
// agreement, enqueue ONE run and write one page.
//
// TWO STEPS, so a retry after the page was written re-uses it rather than writing a
// second one: `write` answers the page (or the one already recorded, or null when there
// is nothing to save), `record` puts it on the offer.
//
// `retryPolicy: 'transient'`: a folder or page write that fails is usually a database
// or account blip. The FINAL attempt marks the offer `requirementPageFailed` — the rail's
// confirmed line reads it — then rethrows, so the engine still dead-letters the run.

export const REQUIREMENT_PAGE_RETRY_POLICY = 'transient' as const;

/** Total attempts, first included — what `job_queue.max_attempts` stores. */
export const REQUIREMENT_PAGE_MAX_ATTEMPTS =
  resolveRetries({ retryPolicy: REQUIREMENT_PAGE_RETRY_POLICY }) + 1;

export const planOfferRequirementPage = defineJob(
  {
    id: 'plan-offer/requirement-page.requested',
    retryPolicy: REQUIREMENT_PAGE_RETRY_POLICY,
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const data = ctx.event.data as PlanOfferRequirementPageRequestedData;
    try {
      const page = await ctx.step.run('requirement-page-write', () =>
        services.requirementPageSave.write(data),
      );
      if (!page) return { saved: false };
      await ctx.step.run('requirement-page-record', () =>
        services.requirementPageSave.record(data, page),
      );
      return { saved: true, pageId: page.pageId };
    } catch (err) {
      // `attempt` is zero-indexed.
      if (ctx.attempt + 1 >= REQUIREMENT_PAGE_MAX_ATTEMPTS) {
        await services.requirementPageSave.recordFailure(data);
      }
      throw err;
    }
  },
);
