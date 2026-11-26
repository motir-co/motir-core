import type { ApplicationGraceNoticeData } from '@/lib/jobs/types';
import { defineJob } from '../defineJob';

// A GRACE-WINDOW NOTICE (Story MOTIR-9800 · MOTIR-12136).
//
// `hosting.application-grace.notice` is enqueued by `startGrace` when the
// repository's transfer lands (`transferred`), by `stopApplication` at the stop
// (`stopped`), and by the hourly reminder sweep 7 days and 1 day before
// `stopsAt`. It runs `hostedApplicationGraceNotifier.notify`, which enqueues one
// `email.send` per Owner and Admin and then records the notice. Keyed
// `<applicationId>:<kind>`, so the queue holds one of each kind; a retried run
// finds the notice recorded and sends nothing (`idempotent`).

export const hostedApplicationGraceNotice = defineJob(
  {
    id: 'hosting.application-grace.notice',
    retryPolicy: 'idempotent',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const data = ctx.event.data as ApplicationGraceNoticeData;
    return ctx.step.run('send-grace-notice', () =>
      services.hostedApplicationGraceNotifier.notify({
        applicationId: data.applicationId,
        kind: data.kind,
      }),
    );
  },
);
