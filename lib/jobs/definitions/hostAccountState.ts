import { defineJob } from '../defineJob';

/**
 * THE HOST ACCOUNT STATE PASS'S SCHEDULE (Story MOTIR-9365 · MOTIR-9585).
 *
 * Every minute, every AWS account a Host organisation owns has its state
 * decided and its entry times stored (`hostAccountStateService.runStatePass`) —
 * the cadence of the quota tracker whose reads it follows, so a grant moves an
 * account on within a minute of being read.
 *
 * ⚠️ SINGLE-FLIGHT IS THE PASS'S OWN, as the reconcile's: a pass runs each
 * not-yet-live account's network step and can outlast a minute, so it takes a
 * lease row and an overlapping run returns `{ ran: false }` at once.
 */
export const HOST_ACCOUNT_STATE_CRON = '* * * * *';

export const hostAccountState = defineJob(
  {
    id: 'system.host-account-state',
    cron: HOST_ACCOUNT_STATE_CRON,
    // `latest`: a pass decides from the CURRENT facts, so a missed one is not
    // work to replay.
    catchUp: 'latest',
    // `none`: the next minute's pass is the retry.
    retryPolicy: 'none',
  },
  (ctx, services) => {
    return ctx.step.run('host-account-state', () => services.hostAccountState.runStatePass());
  },
);
