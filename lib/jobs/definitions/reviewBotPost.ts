import { defineJob } from '../defineJob';
import type {
  ReviewBotPostRequestedData,
  ReviewBotReconcileRequestedData,
  ReviewDismissedData,
} from '../types';

// MOTIR'S APP BOT ON THE PULL REQUEST (Story MOTIR-10327 · MOTIR-10335; `approval-gates.md`
// §12 rules 7 and 8) — the triggers, retry budgets and dedup keys. The policy is all in
// `reviewBotPostService`.
//
// `retryPolicy: 'transient'` on all three: a GitHub call that failed is retried, and a
// retry is safe — a post skips every pull request that already has its row, and the
// reconcile reads stored state, so a second run dismisses nothing twice.

/** POST one answering verdict, once per verdict record (`idempotency` on the record). */
export const reviewBotPost = defineJob(
  {
    id: 'review-bot/post',
    trigger: 'review-bot/post.requested',
    retryPolicy: 'transient',
    idempotency: 'event.data.recordId',
  },
  async (ctx, services) =>
    services.reviewBotPost.postVerdict(ctx.event.data as ReviewBotPostRequestedData),
);

/** RECONCILE a card's standing Request changes — the posting switch turned off. */
export const reviewBotReconcile = defineJob(
  {
    id: 'review-bot/reconcile',
    trigger: 'review-bot/reconcile.requested',
    retryPolicy: 'transient',
  },
  async (ctx, services) => {
    const data = ctx.event.data as ReviewBotReconcileRequestedData;
    return { dismissed: await services.reviewBotPost.reconcile(data) };
  },
);

/** RECONCILE after a person's Dismiss — the second consumer shape of the same reconcile. */
export const reviewBotReconcileOnDismissal = defineJob(
  {
    id: 'review-bot/reconcile-on-dismissal',
    trigger: 'review/dismissed',
    retryPolicy: 'transient',
    idempotency: 'event.data.dismissalId',
  },
  async (ctx, services) => {
    const data = ctx.event.data as ReviewDismissedData;
    return {
      dismissed: await services.reviewBotPost.reconcile({
        workspaceId: data.workspaceId,
        workItemId: data.workItemId,
      }),
    };
  },
);
