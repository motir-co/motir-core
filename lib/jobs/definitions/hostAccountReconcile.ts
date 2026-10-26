import { defineJob } from '../defineJob';

/**
 * THE HOST ACCOUNT RECONCILE'S SCHEDULE (Story MOTIR-9365 · MOTIR-9582).
 *
 * Every minute, every organisation whose plan reads `host` gets its three AWS
 * accounts made sure of (`hostAccountReconcileService.runReconcile`).
 *
 * ⚠️ SINGLE-FLIGHT IS THE PASS'S OWN, as the growth pass's: a pass can outlast a
 * minute (it creates AWS accounts), so it takes a lease row and an overlapping
 * run returns `{ ran: false }` at once.
 */
export const HOST_ACCOUNT_RECONCILE_CRON = '* * * * *';

export const hostAccountReconcile = defineJob(
  {
    id: 'system.host-account-reconcile',
    cron: HOST_ACCOUNT_RECONCILE_CRON,
    // `latest`: a pass reconciles against the CURRENT plans and accounts, so a
    // missed one is not work to replay.
    catchUp: 'latest',
    // `none`: a pass creates AWS accounts. The next minute's pass is its retry.
    retryPolicy: 'none',
  },
  (ctx, services) => {
    return ctx.step.run('host-account-reconcile', () =>
      services.hostAccountReconcile.runReconcile(),
    );
  },
);
