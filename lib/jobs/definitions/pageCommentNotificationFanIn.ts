import { defineJob } from '../defineJob';
import type { PageCommentCreatedData } from '../types';

// The in-app consumer of `page/comment.created` (Story MOTIR-10868 · MOTIR-10924).
// A thin delegate, the shape of the work-item fan-in jobs beside it: the event is
// narrowed, the whole fan-out runs in ONE durable step, and that step's summary is
// the job's result. The recipients, the access re-check, the preference gate and
// the dedupe live in `notificationFanInService.fanInPageComment`.
//
// NO event-level idempotency, for the reason the work-item comment fan-in records:
// an edit re-fires this event under the SAME comment id, and a comment-scoped dedupe
// window would drop the mention the edit added. The rows' shared dedupe key is what
// makes a replay or a re-fire harmless.

export const pageCommentNotificationFanIn = defineJob(
  {
    id: 'notification-fan-in/page-comment.created',
    trigger: 'page/comment.created',
    retryPolicy: 'transient',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as PageCommentCreatedData;
    return ctx.step.run('notification-fan-in', () =>
      services.notificationFanIn.fanInPageComment(payload),
    );
  },
);
