import 'server-only';

import type {
  ModelServingEntryDTO,
  PlatformModelServingViewDTO,
} from '@/lib/dto/platformModelServing';
import {
  readGatewayModelServing,
  writeGatewayModelServing,
} from '@/lib/gateway/modelServingClient';
import { toModelServingEntryDTO } from '@/lib/mappers/platformModelServingMappers';
import {
  platformRoleAtLeast,
  requirePlatformStaff,
  type PlatformPrincipal,
} from '@/lib/platform/auth';
import { withPlatformRead, type PlatformAuditEntry } from '@/lib/platform/context';
import {
  ModelServingUnavailableError,
  ModelServingUnknownModelError,
  ModelServingUnknownProviderError,
} from '@/lib/platform/errors';

/**
 * The platform MODEL SERVING screen's server side (MOTIR-11280; design
 * `platform-admin/design-notes.md` § Model serving).
 *
 * A model several providers sell (GLM-5.3: Z.ai, its maker, and Alibaba) is
 * ALWAYS charged its original provider's official price plus margin. Which
 * provider's gateway channel SERVES it is a platform admin's choice, and only
 * moves what Motir pays. The gateway owns the choice; this service reads it and
 * writes it, and records every write in the platform audit log.
 *
 *  - `getView` — any staff role. Not audited, for `platformCapacityService.getView`'s
 *    reason: a platform setting with no tenant row in it.
 *  - `setServing` — `superadmin` only. The service reads the gateway first, so a
 *    model or provider the gateway does not list is refused here by name, and the
 *    audit row records the provider it moved FROM. The gateway write runs INSIDE
 *    `withPlatformRead`, so a refused write rolls the audit row back.
 */

const DEFAULT_REASON = 'changed in the model serving screen';

export const platformModelServingService = {
  /** @throws NotPlatformStaffError for a non-staff caller, before any read. */
  async getView(principal: PlatformPrincipal): Promise<PlatformModelServingViewDTO> {
    await requirePlatformStaff('support');
    const read = await readGatewayModelServing();
    if (read.outcome === 'unavailable') {
      console.error('[platform-model-serving] the gateway could not be read', {
        reason: read.reason,
      });
      return { state: 'unavailable' };
    }
    return {
      state: 'ok',
      canChange: platformRoleAtLeast(principal.role, 'superadmin'),
      entries: read.entries.map(toModelServingEntryDTO),
    };
  },

  /**
   * Choose the provider that serves `model`, or clear the choice (`null`) so the
   * original provider serves it again.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws ModelServingUnavailableError when the gateway cannot be read first.
   * @throws ModelServingUnknownModelError / ModelServingUnknownProviderError
   *   before any write.
   * @throws GatewayModelServingRefusedError / GatewayModelServingUnavailableError /
   *   GatewayModelServingConfigError from the write — each leaves no audit row.
   */
  async setServing(
    principal: PlatformPrincipal,
    model: string,
    provider: string | null,
  ): Promise<ModelServingEntryDTO> {
    await requirePlatformStaff('superadmin');
    const read = await readGatewayModelServing();
    if (read.outcome === 'unavailable') throw new ModelServingUnavailableError(read.reason);
    const current = read.entries.find((e) => e.model === model);
    if (!current) throw new ModelServingUnknownModelError(model);
    const sellers = [...new Set(current.offerings.map((o) => o.provider))];
    if (provider !== null && !sellers.includes(provider)) {
      throw new ModelServingUnknownProviderError(model, provider, sellers);
    }
    const entry: PlatformAuditEntry = {
      action: 'model_serving.set',
      targetKind: 'platform',
      targetId: model,
      reason: DEFAULT_REASON,
      metadata: {
        model,
        fromProvider: current.selected,
        toProvider: provider,
        originProvider: current.originProvider,
      },
    };
    let applied = false;
    try {
      const saved = await withPlatformRead(principal, entry, async () => {
        const written = await writeGatewayModelServing(model, provider, principal.email);
        applied = true;
        return written;
      });
      return toModelServingEntryDTO(saved);
    } catch (err) {
      if (applied) {
        // A constant message: the model and provider are the caller's input.
        console.error(
          '[platform-model-serving] the gateway saved a choice, but the audit row did not commit',
          { model, provider },
          err,
        );
      }
      throw err;
    }
  },
};
