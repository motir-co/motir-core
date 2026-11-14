import type { ProjectContext } from '@/lib/projects';
import { NEW_SESSION_CONFIRM_BODY } from '@/lib/planChange/restart';
import { appendWithin } from '@/lib/services/planChangeSessionsService';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';

/**
 * Seed a LEGACY Plan something new confirm TURN — the `assistant` turn with
 * `confirm: 'new_session'` that the rail-head control wrote onto the thread
 * before MOTIR-11261 moved its question into a dialog.
 *
 * Nothing in the product writes one any more, but a session written before then
 * still carries it and must stay drawn and answerable, so the suites that pin
 * that record seed it directly — through the same locked append every turn
 * takes, with the same stored body the control used to write. Idempotent the
 * way the retired door was: a confirm already latest is left as it is.
 */
export async function seedLegacyRestartConfirm(
  pctx: ProjectContext,
  sessionId: string,
): Promise<void> {
  await withWorkspaceContext(
    { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
    async (tx) => {
      await appendWithin(
        sessionId,
        pctx,
        { role: 'assistant', body: NEW_SESSION_CONFIRM_BODY, confirm: 'new_session' },
        {},
        tx,
        async (t) => {
          const latest = await planChangeTurnRepository.findLatestInSession(
            sessionId,
            pctx.workspaceId,
            t,
          );
          return latest?.role === 'assistant' && latest.confirm === 'new_session';
        },
      );
    },
  );
}
