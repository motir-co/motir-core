import { defineJob } from '../defineJob';

/**
 * THE PREVIEW ENABLEMENT SWEEP (Story MOTIR-5766 · MOTIR-5775).
 *
 * Every hour, `previewEnablementService.sweep` switches previews on for every
 * Motir-hosted web repository that does not have them — the BACKFILL for every
 * repository established before previews existed, and the retry for one whose
 * establishment could not switch them on — and re-mints a push credential with
 * under 14 days left (decision MOTIR-5769 §4). A row already on and current is
 * not visited, so a second run with nothing due does nothing.
 *
 * Hourly rather than daily so a repository whose enablement failed at creation
 * gets its previews within the hour; within the hourly cadence, so it needs no
 * `SUB_HOURLY_CADENCE_EXCEPTIONS` entry.
 */
export const PREVIEW_ENABLEMENT_SWEEP_CRON = '23 * * * *';

export const previewEnablementSweep = defineJob(
  {
    id: 'system.preview-enablement-sweep',
    cron: PREVIEW_ENABLEMENT_SWEEP_CRON,
    // `latest`: the sweep selects from the CURRENT rows, so a missed tick is not
    // work to replay.
    catchUp: 'latest',
    // Every step of `enable` is idempotent (ensure, upsert, read-then-write), so a
    // retried run converges on the same configuration.
    retryPolicy: 'idempotent',
  },
  (ctx, services) => {
    return ctx.step.run('preview-enablement-sweep', () => services.previewEnablement.sweep());
  },
);
