import 'server-only';

import {
  listFailedGatewayUsageGroups,
  replayFailedGatewayUsageGroup,
} from '@/lib/ai/motirAiClient';
import type { FailedUsageGroupDTO, FailedUsageReplayDTO } from '@/lib/dto/failedUsage';
import { JOBS_SYSTEM_REPLAY_ROLE } from '@/lib/jobs/platformStanding';
import { toFailedUsageGroupDTO, toFailedUsageReplayDTO } from '@/lib/mappers/failedUsageMappers';
import {
  platformRoleAtLeast,
  requirePlatformStaff,
  type PlatformPrincipal,
} from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { platformAuditService } from '@/lib/services/platformAuditService';

/**
 * Usage & cost's FAILED USAGE door (MOTIR-11794; design MOTIR-11793) — the core
 * half of motir-ai's `/v1/admin/gateway-usage/failed-groups`.
 *
 * The usage rows motir-ai could not apply are motir-ai's; core's part is the
 * staff gate and the audit trail. Every staff role reads; `operator` replays,
 * the role every replay in the console asks for (`JOBS_SYSTEM_REPLAY_ROLE`),
 * because a replay writes other tenants' usage and credits.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ THE READ is one audited `estate.read`, written whether or not motir-ai
 * answered — the shape `platformReadService.getEstateUsage` gives the rest of
 * this page. The remote call runs FIRST, outside the transaction: a
 * transaction is never held across a network call.
 *
 * ⚠️ THE REPLAY'S AUDIT ROW IS WRITTEN AFTER motir-ai ANSWERS, never around the
 * call. motir-ai drains the group for up to 20 s before it answers, and
 * `withPlatformRead` holds the audit-chain lock that serializes every platform
 * transaction: a replay inside it would stall the whole console and outlive the
 * transaction's timeout. So the replay stands on its own, exactly as the Jobs
 * replay does (`platformJobReplayService`), and the `[gateway_usage.replay]`
 * warn line below is the fallback record if the audit write then fails (the
 * error is rethrown so the operator sees it). motir-ai's `audit: null` — the
 * group had no failed rows left — replayed nothing and records nothing.
 * ---------------------------------------------------------------------------
 */

/** The reason written on every replay row — the confirm has no reason field. */
export const FAILED_USAGE_REPLAY_AUDIT_REASON = 'Failed usage replayed from /admin/usage';

/** How much of the error text the audit row's label keeps. */
const LABEL_MAX = 200;

export const platformFailedUsageService = {
  /**
   * Every error group of the failed usage rows, largest first, or `null` when
   * motir-ai did not answer — the section's Unavailable state, never a throw.
   */
  async listGroups(principal: PlatformPrincipal): Promise<FailedUsageGroupDTO[] | null> {
    await requirePlatformStaff('support');

    const groups = await listFailedGatewayUsageGroups().then(
      (rows) => rows.map(toFailedUsageGroupDTO),
      (err: unknown) => {
        console.warn('[gateway_usage.read]', {
          detail: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
        });
        return null;
      },
    );

    return withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'platform', targetLabel: 'failed usage' },
      async () => groups,
    );
  },

  /**
   * Replay ONE error group: motir-ai puts its failed rows back to pending,
   * applies each exactly once, and answers what became of them.
   *
   * @throws NotPlatformStaffError below `operator`, before anything is sent.
   * @throws whatever motir-ai's client throws when the replay does not answer —
   *   the section's "did not finish" line; rows it did not record stay listed.
   */
  async replayGroup(input: {
    error: string;
    principal: PlatformPrincipal;
  }): Promise<FailedUsageReplayDTO> {
    const { error, principal } = input;
    if (!platformRoleAtLeast(principal.role, JOBS_SYSTEM_REPLAY_ROLE)) {
      throw new NotPlatformStaffError();
    }

    const { replay, audit } = await replayFailedGatewayUsageGroup(error, principal.userId);

    console.warn(
      '[gateway_usage.replay]',
      JSON.stringify({
        actorUserId: principal.userId,
        error: error.slice(0, LABEL_MAX),
        reset: replay.reset,
        applied: replay.applied,
        failedAgain: replay.failedAgain,
        pending: replay.pending,
      }),
    );

    if (audit) {
      await platformAuditService.record(principal, {
        action: 'ai.gateway_usage.replay',
        targetKind: 'platform',
        targetLabel: error.slice(0, LABEL_MAX),
        reason: FAILED_USAGE_REPLAY_AUDIT_REASON,
        metadata: {
          error: audit.before.error,
          failedRows: audit.before.failedRows,
          organizations: audit.before.organizations,
          applied: audit.after.applied,
          failedAgain: audit.after.failedAgain,
          pending: audit.after.pending,
        },
      });
    }

    return toFailedUsageReplayDTO(replay);
  },
};
