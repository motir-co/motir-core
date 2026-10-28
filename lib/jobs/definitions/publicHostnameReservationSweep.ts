import { defineJob } from '../defineJob';

// The EXPIRED NAME-HOLD sweep (Story MOTIR-4528 · Subtask MOTIR-9509). A
// workspace subdomain that is renamed, released or deleted after being held 24
// hours or more leaves a digest in `public_hostname_reservation` until its
// `expires_at` (`docs/decisions/public-tenant-addresses.md` §8 Amendment 3).
// This deletes the rows whose hold has lapsed.
//
// Housekeeping, not a rule: a lapsed row is already ignored by every claim, so
// a late or missed sweep changes nothing anyone can observe. It only keeps the
// table holding digests that still protect a name.
//
// System-scoped: holds span every workspace, so the sweep runs under
// `withSystemContext` and its ledger row is untenanted, like every `system.*`
// job.
//
// `retryPolicy: 'idempotent'`: a re-run deletes whatever is still lapsed and
// finds nothing left the second time.

/** 05:45 every day — after the nightly table-walk cascade (03:30 → 05:00) and
 *  the export expiry sweep at 05:30, so it contends with neither. Daily because
 *  a hold is measured in days and a day's delay changes nothing observable. */
export const PUBLIC_HOSTNAME_RESERVATION_SWEEP_CRON = '45 5 * * *';

export const publicHostnameReservationSweep = defineJob(
  {
    id: 'system.public-hostname-reservation-sweep',
    cron: PUBLIC_HOSTNAME_RESERVATION_SWEEP_CRON,
    // `latest`: one run catches up on every missed tick, because its read is
    // "everything lapsed now".
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('sweep-expired-name-holds', () =>
      services.publicHostnameReservation.sweepExpiredNameHolds(),
    );
  },
);
