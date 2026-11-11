import { defineJob } from '../defineJob';
import type { PageCommentCreatedData } from '../types';

// The EMAIL consumer of `page/comment.created` (Story MOTIR-10868 · MOTIR-10925),
// registered as an ADDITIONAL consumer — a distinct id with an explicit trigger —
// because the event has two independent consumers by design (this one and the
// in-app fan-in), and two definitions under the one-to-one id would collide at
// registration. A thin delegate: the whole fan-out runs in ONE durable step and its
// summary is the job's result.
//
// NO event-level idempotency, for the reason `mentionNotify` records: an edit
// re-fires this event under the SAME comment id carrying only the added mention,
// and a comment-scoped dedupe window would drop it. Delivery dedup is the
// per-comment × recipient key each `email.send` carries.

export const pageCommentEmailOnCommentCreated = defineJob(
  {
    id: 'page-comment-email/comment.created',
    trigger: 'page/comment.created',
    retryPolicy: 'transient',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as PageCommentCreatedData;
    return ctx.step.run('page-comment-email', () => services.pageCommentEmail.fanOut(payload));
  },
);
