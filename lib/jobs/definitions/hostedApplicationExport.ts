import {
  ExportNotAllowedError,
  ExportNotFoundError,
  ExportTargetUnsupportedError,
} from '@/lib/hosting/errors';
import { OrgForbiddenError } from '@/lib/organizations/errors';
import type { HostedApplicationExportRequestedData } from '@/lib/services/hostedApplicationExportService';
import { defineJob } from '../defineJob';

// A GRACE-WINDOW APPLICATION'S DATABASE EXPORT (Story MOTIR-9800 · MOTIR-12134).
//
// `hosting.application-export` takes the dump an organisation admin asked for:
// the route answers 202 with the export's id and this job runs
// `createExport`, because a dump outlives a request. The id is chosen at the
// request and names the export, so a retried run that finds the export already
// recorded answers it rather than taking a second dump. A refusal the gate
// raises again here — the application left its grace window, the admin is no
// longer one — is an ANSWER, returned and not thrown: a retry cannot change it.
// What is retried is a failed dump or upload (`transient`).
//
// `system.hosted-application-export-expire` deletes every export past
// `expires_at`, the object before the row, so a re-run after a partial failure
// is safe — the `system.data-export-expiry-sweep` shape, for its reasons.

export const hostedApplicationExport = defineJob(
  {
    id: 'hosting.application-export',
    retryPolicy: 'transient',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const data = ctx.event.data as HostedApplicationExportRequestedData;
    return ctx.step.run('take-export', async () => {
      try {
        const exportId = await services.hostedApplicationExport.createExport(
          data.applicationId,
          { kind: 'on_demand', exportId: data.exportId },
          { kind: 'user', userId: data.userId },
        );
        return { outcome: 'stored' as const, exportId };
      } catch (err) {
        if (
          err instanceof ExportNotAllowedError ||
          err instanceof ExportNotFoundError ||
          err instanceof ExportTargetUnsupportedError ||
          err instanceof OrgForbiddenError
        ) {
          return { outcome: 'refused' as const, code: err.code };
        }
        throw err;
      }
    });
  },
);

/** 05:50 every day: after the personal-data export sweep (05:30) and the
 *  name-hold sweep (05:45), before the queue reaper (06:00). Daily, because an
 *  export's retention is measured in days. */
export const HOSTED_APPLICATION_EXPORT_EXPIRY_CRON = '50 5 * * *';

export const hostedApplicationExportExpire = defineJob(
  {
    id: 'system.hosted-application-export-expire',
    cron: HOSTED_APPLICATION_EXPORT_EXPIRY_CRON,
    // `latest`: a missed night is worth one run when the worker returns — the
    // predicate is "past expiry now", so one pass covers every fire it missed.
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('sweep-expired-hosting-exports', () =>
      services.hostedApplicationExport.sweepExpiredExports(),
    );
  },
);
