import { defineJob } from '../defineJob';

/**
 * THE INDEX CATCH-UP SWEEP (MOTIR-5290 · Story MOTIR-4335) — re-asks the internal
 * index allowance for repositories MOTIR-4593 paused, and resumes indexing where
 * it may. See `codeGraphIndexCatchUpService` for why this is a pull.
 *
 * It also RE-DISPATCHES, bounded, the repositories whose claimed index or refresh
 * run ended terminal for a reason other than size (MOTIR-10819), as a second step
 * on the same tick so the two passes memoize — and fail — independently.
 *
 * Every 5 minutes — the one sub-hourly cadence (`SUB_HOURLY_CADENCE`,
 * `lib/jobs/schedules.ts`). Five minutes is the latency between a top-up and the
 * index resuming.
 */
export const CODE_GRAPH_INDEX_CATCH_UP_CRON = '*/5 * * * *';

export const codeGraphIndexCatchUp = defineJob(
  {
    id: 'system.code-graph-index-catch-up',
    cron: CODE_GRAPH_INDEX_CATCH_UP_CRON,
    // A missed tick is not work to replay: the next pass selects from the current
    // pauses and asks the current allowance.
    catchUp: 'latest',
    // Each pass is a recompute from live state; a retried pass asks again and
    // enqueues what the refresh job's debounce coalesces.
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const paused = await ctx.step.run('catch-up-paused-indexes-v2', () =>
      services.codeGraphIndexCatchUp.catchUp(),
    );
    // Each repository's re-dispatch is claimed by a conditional release, so a
    // retried pass re-reads live state and never enqueues one twice.
    const retried = await ctx.step.run('retry-failed-indexes', () =>
      services.codeGraphIndexCatchUp.retryFailed(),
    );
    return { paused, retried };
  },
);
