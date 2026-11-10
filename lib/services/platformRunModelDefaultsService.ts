import 'server-only';

import { getRunModelDefaults, setRunModelDefault } from '@/lib/ai/motirAiClient';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import {
  RUN_MODEL_DEFAULT_KEYS,
  type RunModelDefaultKey,
  type RunModelDefaultWriteResult,
} from '@/lib/ai/types';
import type {
  PlatformRunModelDefaultsDTO,
  PlatformRunModelDefaultWriteDTO,
} from '@/lib/dto/platformRunModelDefaults';
import { toPlatformRunModelDefaultsDTO } from '@/lib/mappers/platformRunModelDefaultsMappers';
import {
  platformRoleAtLeast,
  requirePlatformStaff,
  type PlatformPrincipal,
} from '@/lib/platform/auth';
import { withPlatformWrite } from '@/lib/platform/context';
import {
  RunModelDefaultKeyUnknownError,
  RunModelDefaultUnchangedError,
} from '@/lib/platform/errors';
import { platformRunModelRepository } from '@/lib/repositories/platformRunModelRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { hostedRunModelService } from '@/lib/services/hostedRunModelService';
import { assertReasonSatisfied } from '@/lib/services/platformAuditService';

/**
 * The RUN-SIDE PLATFORM DEFAULTS — Story MOTIR-10838 · MOTIR-10844, the console
 * seam for motir-ai's `GET` / `PUT /v1/admin/run-model-defaults` (MOTIR-10840).
 *
 * Six settings: the review agent, the design run, and the agent run per
 * difficulty. motir-ai stores and resolves them; motir-core owns which models a
 * hosted run MAY use (`platform_run_model`), so the read is narrowed to that list
 * and every write sends it as `allowedModels`. Any staff role reads, only a
 * `superadmin` writes, and every write is ONE `ai.run_model_default.set` row in
 * the same transaction as motir-ai's write.
 *
 * ---------------------------------------------------------------------------
 * WHY from → to COMES FROM motir-ai's `audit`, AND THE ROW IS RECORDED AFTER
 * ---------------------------------------------------------------------------
 * motir-ai reads the previous value under its own row lock and answers it as
 * `audit`, or `null` when nothing changed. So the row is appended with
 * `withPlatformWrite`'s recorder AFTER the write, carrying that answer — the
 * trail names what the write actually replaced, not what this tab read earlier
 * (`platformLessonsService`'s rule, which reads the same shape). A `null` audit
 * records nothing and throws `RunModelDefaultUnchangedError`, rolling the
 * transaction back. A pre-read still refuses a save to the value already shown,
 * before any transaction opens.
 *
 * ⚠️ THE RESIDUAL CASE is `platformPlannerModelService`'s: motir-ai applied the
 * change and core's commit then failed. It is logged with both values.
 */

function isRunModelDefaultKey(value: string): value is RunModelDefaultKey {
  return (RUN_MODEL_DEFAULT_KEYS as readonly string[]).includes(value);
}

/** The narrowed run offer, or `MotirAiUnavailableError` — never an empty list. */
async function readOffer() {
  const offer = await hostedRunModelService.listOfferedModels();
  if (offer.state === 'unavailable') {
    throw new MotirAiUnavailableError('motir-ai did not answer the hosted-run offer');
  }
  return offer;
}

export const platformRunModelDefaultsService = {
  /**
   * The Run-side defaults card: six rows, the run-model-list models the pickers
   * may offer, and whether this principal may edit. Not audited: it reads no
   * tenant row — a platform setting, the offer and the changers' names.
   *
   * @throws NotPlatformStaffError for a non-staff caller.
   * @throws MotirAiUnavailableError (or another `MotirAiError`) when motir-ai
   *   cannot answer — the card shows its unavailable state, never a guess.
   */
  async getDefaults(principal: PlatformPrincipal): Promise<PlatformRunModelDefaultsDTO> {
    await requirePlatformStaff('support');
    const [read, offer] = await Promise.all([getRunModelDefaults(), readOffer()]);
    const changers = [
      ...new Set(
        read.settings.map((s) => s.updatedByCoreUserId).filter((id): id is string => !!id),
      ),
    ];
    const users = await userRepository.findByIds(changers);
    return toPlatformRunModelDefaultsDTO(
      read,
      offer.models,
      offer.default,
      users,
      platformRoleAtLeast(principal.role, 'superadmin'),
    );
  },

  /**
   * Set one run-side default, or clear it (`model: null`) so it inherits again.
   *
   *   1. `superadmin`, before any remote call; the key is one of the six.
   *   2. The REASON, before the transaction.
   *   3. The current value, so a save to what is already stored is refused
   *      without a transaction.
   *   4. The audited write: motir-ai's write with `allowedModels` = the run-model
   *      list, then ONE row whose metadata is motir-ai's `audit`; `audit: null`
   *      rolls back with no row.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws RunModelDefaultKeyUnknownError for a key that is not one of the six.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws RunModelDefaultUnchangedError when `model` is already stored.
   * @throws RunModelDefaultNotOfferedError when motir-ai refuses the model.
   * @throws MotirAiUnavailableError when motir-ai cannot answer.
   */
  async setDefault(
    principal: PlatformPrincipal,
    key: string,
    model: string | null,
    reason: string,
  ): Promise<PlatformRunModelDefaultWriteDTO> {
    await requirePlatformStaff('superadmin');
    if (!isRunModelDefaultKey(key)) throw new RunModelDefaultKeyUnknownError(key);
    const base = {
      action: 'ai.run_model_default.set' as const,
      targetKind: 'platform' as const,
      targetId: key,
      reason,
    };
    assertReasonSatisfied(base);

    const [current, listed] = await Promise.all([
      getRunModelDefaults(),
      platformRunModelRepository.findListedModelsForOffer(),
    ]);
    if (current.settings.find((s) => s.key === key)?.model === model) {
      throw new RunModelDefaultUnchangedError(key, model);
    }

    let applied = null as RunModelDefaultWriteResult | null;
    try {
      const audit = await withPlatformWrite(principal, async (_tx, record) => {
        const written = await setRunModelDefault({
          key,
          model,
          actorCoreUserId: principal.userId,
          // A list never initialised narrows nothing (`hostedRunModelService`).
          ...(listed === null ? {} : { allowedModels: listed }),
        });
        // Someone got there first: motir-ai changed nothing, so the trail must
        // not claim a change — throwing here rolls the transaction back.
        if (!written.audit) throw new RunModelDefaultUnchangedError(key, model);
        applied = written;
        const fromModel = written.audit.before.model;
        const toModel = written.audit.after.model;
        await record({ ...base, metadata: { key, fromModel, toModel } });
        return written.audit;
      });
      return { key, fromModel: audit.before.model, toModel: audit.after.model, at: audit.at };
    } catch (err) {
      if (applied) {
        const { audit } = applied as RunModelDefaultWriteResult;
        console.error(
          '[platform-run-model-defaults] motir-ai applied a change but the audit row did not commit: %s',
          JSON.stringify({
            key,
            actor: principal.userId,
            before: audit?.before.model,
            after: audit?.after.model,
          }),
          err,
        );
      }
      throw err;
    }
  },
};
