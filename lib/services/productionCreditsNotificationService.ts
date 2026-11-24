import { NOTIFICATION_EVENT_TYPE } from '@/lib/notifications/preferences';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { notificationFanInService } from '@/lib/services/notificationFanInService';
import { EXHAUSTED_SUSPEND_AFTER_MS } from '@/lib/services/productionUsageService';
import { withSystemContext } from '@/lib/workspaces/context';

// THE ADMINISTRATORS ARE TOLD WHEN THE CREDITS RUN OUT (MOTIR-12166 · Decision
// MOTIR-12100 §9). When an organisation's balance goes below zero while Motir runs
// one of its production apps, the apps keep running, and every owner and admin of
// the organisation gets ONE in-app notification per transition: which apps, and
// that an always-on app is switched to suspend when idle after 7 days still below
// zero. A top-up clears the transition; the next drop below zero is a new one.
//
// The production usage meter calls this with the applications whose
// `credits_exhausted_since` it has just set, and only on the organisation's
// transition (no application was below zero before), so a later pass still below
// zero, or an application added while below zero, notifies nobody.
//
// It follows the shipped producers whose subject is not a work item
// (`orgFleetNotificationService`, the crash notification): the shared
// `notifyProjectEvent` write, which gates on the recipient's in-app cell and
// dedupes on `(dedupeKey, recipient)`. The dedupe key is the organisation, the
// workspace and the time of the transition, so a retried pass writes nothing twice.
//
// ⚠️ ONE ROW PER ADMINISTRATOR PER WORKSPACE. The bell is a per-workspace surface:
// `notificationsService.listNotifications` reads under the active workspace, and
// the `notification_active_workspace` policy shows only that workspace's rows. An
// organisation's apps can span its workspaces, so every workspace that holds a
// running app gets its own row, naming that workspace's apps — an administrator
// working in any of them sees the warning there.
//
// ⚠️ BEST-EFFORT. It never throws: a notification that cannot be written must not
// fail the meter's pass or undo the state it recorded.

const LOG = '[productionCreditsNotificationService]';

function failureName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export const productionCreditsNotificationService = {
  /**
   * Tell the owners and admins of `organizationId` that its balance went below
   * zero at `since` while the RUNNING applications among `applicationIds` serve
   * production — one row per administrator in each workspace that holds one of
   * them. Returns how many notifications were written; none when no listed
   * application is running (a customer repository never is).
   */
  async notifyCreditsExhausted(args: {
    organizationId: string;
    applicationIds: readonly string[];
    since: Date;
  }): Promise<number> {
    try {
      const running = (
        await withSystemContext((tx) =>
          hostedApplicationRepository.listRunningForCreditsNotice(args.applicationIds, tx),
        )
      ).filter((a) => !isOrganizationSeedSource(a.seedSource));
      if (running.length === 0) return 0;

      // The org's Owner and Admins are other people's org rows, read in the
      // userless org-service context of the organisation the meter charged — a
      // trusted id (the application rows it just updated), never caller input.
      const recipients = await withOrgServiceWriteContext(args.organizationId, (tx) =>
        organizationMembershipRepository.findManagerUserIdsByOrganization(args.organizationId, tx),
      );
      if (recipients.length === 0) return 0;

      const type = NOTIFICATION_EVENT_TYPE.productionCreditsExhausted;
      const exhaustedSince = args.since.toISOString();
      const suspendFrom = new Date(args.since.getTime() + EXHAUSTED_SUSPEND_AFTER_MS).toISOString();
      // The running apps by workspace, each list oldest first (the read's order).
      const byWorkspace = new Map<string, typeof running>();
      for (const a of running)
        byWorkspace.set(a.workspaceId, [...(byWorkspace.get(a.workspaceId) ?? []), a]);
      const admins = [...new Set(recipients)].sort();
      let written = 0;
      for (const [workspaceId, apps] of byWorkspace) {
        for (const recipientUserId of admins) {
          const ok = await notificationFanInService.notifyProjectEvent({
            workspaceId,
            recipientUserId,
            type,
            // DIRECT: it is about the recipient's own organisation's apps.
            category: 'direct',
            dedupeKey: `${type}:${args.organizationId}:${workspaceId}:${exhaustedSince}`,
            data: {
              kind: 'production_credits_exhausted',
              apps: apps.map((a) => ({
                repositoryName: a.repositoryName,
                projectKey: a.projectKey,
              })),
              exhaustedSince,
              suspendFrom,
            },
          });
          if (ok) written += 1;
        }
      }
      return written;
    } catch (error) {
      console.error(`${LOG} could not notify the administrators that credits ran out`, {
        organizationId: args.organizationId,
        error: failureName(error),
      });
      return 0;
    }
  },
};
