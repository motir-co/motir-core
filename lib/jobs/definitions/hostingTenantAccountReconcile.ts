import { defineJob } from '../defineJob';

/**
 * THE TENANT ACCOUNT RECONCILE'S SCHEDULE (Story MOTIR-9792 · MOTIR-9942).
 *
 * Every minute, every enterprise tenant AWS account not yet `ready` is walked a
 * step on (`hostingTenantAccountService.runReconcile`): created or found, then
 * bootstrapped.
 *
 * ⚠️ SINGLE-FLIGHT IS THE PASS'S OWN, as the Host reconcile's: a pass can outlast
 * a minute (it creates AWS accounts), so it takes a lease row and an overlapping
 * run returns `{ ran: false }` at once.
 */
export const HOSTING_TENANT_ACCOUNT_RECONCILE_CRON = '* * * * *';

export const hostingTenantAccountReconcile = defineJob(
  {
    id: 'system.hosting-tenant-account-reconcile',
    cron: HOSTING_TENANT_ACCOUNT_RECONCILE_CRON,
    // `latest`: a pass reconciles against the CURRENT rows, so a missed one is
    // not work to replay.
    catchUp: 'latest',
    // `none`: a pass creates AWS accounts. The next minute's pass is its retry.
    retryPolicy: 'none',
  },
  (ctx, services) => {
    return ctx.step.run('hosting-tenant-account-reconcile', () =>
      services.hostingTenantAccountReconcile.runReconcile(),
    );
  },
);
