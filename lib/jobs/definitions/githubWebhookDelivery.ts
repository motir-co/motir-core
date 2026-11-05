import { defineJob } from '../defineJob';
import type { GithubWebhookDeliveryData } from '../types';

// THE GITHUB WEBHOOK INBOX'S TWO JOBS (Bug MOTIR-10425). The policy is all in
// `githubWebhookInboxService`; these files are the triggers.
//
// `system.github-webhook-delivery` — one run per delivery the webhook route
// persisted. It is where `githubWebhookService.handleEvent` runs now, after the
// route has answered GitHub, so a delivery that waits on the CI-feedback gate waits
// here, where no ten-second clock is running.
//
//   * `idempotency` on `<deliveryId>:<generation>`: GitHub redelivering a delivery
//     still in hand, or the sweep re-enqueueing one whose run already exists,
//     enqueues nothing new.
//   * `retryPolicy: 'idempotent'` — five attempts on the worker's backoff. A
//     handler that throws is retried; the handlers converge under a repeat by
//     construction, because GitHub's own redeliveries already exercised them that
//     way. Once the budget is spent the run is dead-lettered and the inbox row
//     stays `failed` with its error.
//
// `system.github-webhook-inbox-sweep` — every five minutes. Re-enqueues a row
// still `received` minutes after it arrived (its enqueue was lost), and prunes
// rows past their retention. `catchUp: 'latest'`: one pass sees everything every
// missed pass would have, because both of its reads are by elapsed time.

export const githubWebhookDelivery = defineJob(
  {
    id: 'system.github-webhook-delivery',
    retryPolicy: 'idempotent',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const data = ctx.event.data as GithubWebhookDeliveryData;
    return ctx.step.run('process-delivery', () =>
      services.githubWebhookInbox.processDelivery({
        deliveryId: data.deliveryId,
        generation: data.generation,
      }),
    );
  },
);

/** Every 5 minutes — the one sub-hourly cadence (`SUB_HOURLY_CADENCE`,
 *  `lib/jobs/schedules.ts`). The sweep is a backstop for a lost enqueue, so a
 *  delivery it rescues waits at most its two-minute threshold plus one gap. */
export const GITHUB_WEBHOOK_INBOX_SWEEP_CRON = '*/5 * * * *';

export const githubWebhookInboxSweep = defineJob(
  {
    id: 'system.github-webhook-inbox-sweep',
    cron: GITHUB_WEBHOOK_INBOX_SWEEP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => ctx.step.run('sweep-inbox', () => services.githubWebhookInbox.sweep()),
);
