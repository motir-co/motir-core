import 'server-only';

import { validateCapacityLimitEdit } from '@/lib/capacity/limitEditValidation';
import { evaluateCapacityRead } from '@/lib/capacity/threshold';
import type {
  PlatformCapacityAlertShareDTO,
  PlatformCapacityStoredEntryDTO,
  PlatformCapacityViewDTO,
} from '@/lib/dto/platformCapacity';
import { CAPACITY_EDIT_KEYS } from '@/lib/gateway/capacityClient';
import { gatewayCapacityClient } from '@/lib/gateway/capacityProvider';
import {
  toPlatformCapacityAlertShareDTO,
  toPlatformCapacityStoredEntryDTO,
  toPlatformCapacityViewDTO,
} from '@/lib/mappers/platformCapacityMappers';
import {
  platformRoleAtLeast,
  requirePlatformStaff,
  type PlatformPrincipal,
} from '@/lib/platform/auth';
import { withPlatformRead, type PlatformAuditEntry } from '@/lib/platform/context';
import { capacityAlertEvaluationService } from '@/lib/services/capacityAlertEvaluationService';
import { capacityAlertStateService } from '@/lib/services/capacityAlertStateService';

/**
 * The platform CAPACITY screen's server side — Story MOTIR-9539 · MOTIR-9613.
 *
 * One view model and two writes. The screen renders what these return and never
 * calls the gateway, the alert store or the evaluation itself.
 *
 *  - `getView` — any staff role. It reads the gateway ONCE and hands that same
 *    read to the alert evaluation, so the screen and the alert decision come
 *    from one set of numbers and the gateway gets one poll per refresh. Not
 *    audited, for `platformPlannerModelService.getSettings`' reason: a platform
 *    setting and Motir's own provider limits, no tenant row. Raise and clear run
 *    in the evaluation service's own system context.
 *  - `editLimits` — `operator`. Validated in core by the gateway's rules, then
 *    written INSIDE `withPlatformRead`, so a gateway refusal rolls the audit row
 *    back (`setModel`'s order).
 *  - `setAlertShare` — `operator`, straight through to the alert store, whose
 *    rules, audit and refusals these are.
 *
 * ⚠️ THE ONE RESIDUAL CASE, as in `setModel`: the gateway applies an edit and
 * core's commit then fails. It is logged with provider, model and keys (never
 * the token) so the row can be written by hand; the gateway's row still names
 * the edit's time.
 */

const DEFAULT_EDIT_REASON = 'edited in the capacity screen';
const WIRE_KEY = new Map<string, string>(CAPACITY_EDIT_KEYS);

export const platformCapacityService = {
  /** @throws NotPlatformStaffError for a non-staff caller, before any read. */
  async getView(principal: PlatformPrincipal): Promise<PlatformCapacityViewDTO> {
    await requirePlatformStaff('support');
    const alertShare = await capacityAlertStateService.getAlertShare();
    const read = await gatewayCapacityClient().read();
    const result = await capacityAlertEvaluationService.evaluate({ read });
    // With the counter store down the evaluation writes nothing and carries no
    // rows; the screen still shows every limit, each row `unavailable`.
    const evaluation =
      result.outcome === 'evaluated'
        ? result.evaluation
        : read.outcome === 'answered'
          ? evaluateCapacityRead(read, alertShare.percent)
          : null;
    return toPlatformCapacityViewDTO({
      read,
      evaluation,
      raised: result.raised,
      alertShare,
      canEdit: platformRoleAtLeast(principal.role, 'operator'),
    });
  },

  /**
   * @throws NotPlatformStaffError below `operator`.
   * @throws CapacityLimitEditInvalidError before any gateway call.
   * @throws GatewayCapacityRefusedError / GatewayCapacityUnavailableError /
   *   GatewayCapacityConfigError from the gateway write — each leaves no audit row.
   */
  async editLimits(
    principal: PlatformPrincipal,
    provider: unknown,
    model: unknown,
    edit: unknown,
    reason?: string,
  ): Promise<PlatformCapacityStoredEntryDTO> {
    await requirePlatformStaff('operator');
    const valid = validateCapacityLimitEdit(provider, model, edit);
    const target = { provider: provider as string, model: model as string };
    const keys = Object.fromEntries(
      Object.entries(valid).map(([key, value]) => [WIRE_KEY.get(key)!, value]),
    );
    const entry: PlatformAuditEntry = {
      action: 'capacity.limits.edit',
      targetKind: 'platform',
      targetId: `${target.provider}/${target.model}`,
      reason: reason?.trim() ? reason : DEFAULT_EDIT_REASON,
      metadata: { ...target, keys },
    };
    let applied = false;
    try {
      const row = await withPlatformRead(principal, entry, async () => {
        const written = await gatewayCapacityClient().write(target.provider, target.model, valid);
        applied = true;
        return written;
      });
      return toPlatformCapacityStoredEntryDTO(row);
    } catch (err) {
      if (applied) {
        console.error(
          `[platform-capacity] the gateway applied an edit to ${target.provider}/${target.model} ` +
            `(${Object.keys(keys).join(', ')}), but the audit row did not commit`,
          err,
        );
      }
      throw err;
    }
  },

  /** @throws NotPlatformStaffError, CapacityAlertShareInvalidError, CapacityAlertShareUnchangedError. */
  async setAlertShare(
    principal: PlatformPrincipal,
    percent: unknown,
  ): Promise<PlatformCapacityAlertShareDTO> {
    return toPlatformCapacityAlertShareDTO(
      await capacityAlertStateService.setAlertShare(principal, percent),
    );
  },
};
