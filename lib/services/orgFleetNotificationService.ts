import { NOTIFICATION_EVENT_TYPE } from '@/lib/notifications/preferences';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { notificationFanInService } from '@/lib/services/notificationFanInService';
import { withSystemContext } from '@/lib/workspaces/context';

// THE OWNER IS TOLD (MOTIR-10368 · Story MOTIR-10363,
// `docs/decisions/agent-instances.md` §8 AMENDMENT 8): when an organisation owner
// or admin hibernates a member's agent — one agent, or every running one through
// Stop everything — the agent's OWNER gets one in-app notification naming who did
// it, which agent and when.
//
// It follows the one shipped producer whose subject is not a work item, the
// access-refused notification (`notifyRefusals` in projectRepoAccessService): the
// shared `notifyProjectEvent` write, which gates on the recipient's in-app cell and
// dedupes on `(dedupeKey, recipient)`. Two things differ: this event HAS an actor
// (the admin, written to `actorId`), and the drawer row deep-links nowhere.
//
// ⚠️ THE OWNER IS READ FROM THE ROW, never taken from a caller: the stop service
// passes only the instance id, the actor and the time.
//
// ⚠️ BEST-EFFORT. It never throws: a notification that cannot be written must not
// fail or undo the hibernation the caller already made.

const LOG = '[orgFleetNotificationService]';

export const orgFleetNotificationService = {
  /**
   * Tell the owner of `instanceId` that `actorUserId` hibernated it at `at`.
   * Returns whether a notification was written; an admin who hibernated their
   * own agent is not told.
   */
  async notifyOwnerOfAdminHibernate(args: {
    instanceId: string;
    actorUserId: string;
    at: Date;
  }): Promise<boolean> {
    try {
      const row = await withSystemContext((tx) =>
        agentInstanceRepository.findById(args.instanceId, tx),
      );
      if (!row) return false;
      if (row.ownerId === args.actorUserId) return false;
      const hibernatedAt = args.at.toISOString();
      return await notificationFanInService.notifyProjectEvent({
        workspaceId: row.workspaceId,
        recipientUserId: row.ownerId,
        type: NOTIFICATION_EVENT_TYPE.agentHibernatedByAdmin,
        // DIRECT: it is about something done to the recipient's own agent.
        category: 'direct',
        // One hibernation is one event: an agent woken and hibernated again is a
        // new one, while a retried call for the same hibernation writes nothing.
        dedupeKey: `${NOTIFICATION_EVENT_TYPE.agentHibernatedByAdmin}:${row.id}:${hibernatedAt}`,
        actorId: args.actorUserId,
        data: { kind: 'agent_hibernated_by_admin', agentName: row.name, hibernatedAt },
      });
    } catch (err) {
      console.error(`${LOG} could not notify the owner of a hibernated agent`, {
        instanceId: args.instanceId,
        error: err instanceof Error ? err.name : 'UnknownError',
      });
      return false;
    }
  },
};
