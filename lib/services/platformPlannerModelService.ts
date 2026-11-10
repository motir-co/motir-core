import 'server-only';

import {
  getPlannerModelList,
  getPlannerModelSettings,
  setPlannerFunctionModel,
  setPlannerModel,
  setPlannerReviewModel,
  updatePlannerModelList,
} from '@/lib/ai/motirAiClient';
import {
  PLANNER_AUDIENCES,
  PLANNER_DEFAULT_FUNCTIONS,
  type PlannerAudience,
  type PlannerDefaultFunction,
  type PlannerModelListRead,
} from '@/lib/ai/types';
import type {
  PlatformPlannerFunctionModelWriteDTO,
  PlatformPlannerModelListDTO,
  PlatformPlannerModelSettingsDTO,
  PlatformPlannerModelWriteDTO,
  PlatformPlannerReviewModelWriteDTO,
} from '@/lib/dto/platformPlannerModel';
import {
  toPlatformPlannerFunctionModelWriteDTO,
  toPlatformPlannerModelListDTO,
  toPlatformPlannerModelSettingsDTO,
  toPlatformPlannerModelWriteDTO,
  toPlatformPlannerReviewModelWriteDTO,
} from '@/lib/mappers/platformPlannerModelMappers';
import {
  platformRoleAtLeast,
  requirePlatformStaff,
  type PlatformPrincipal,
} from '@/lib/platform/auth';
import { withPlatformRead, type PlatformAuditEntry } from '@/lib/platform/context';
import {
  PlannerAudienceUnknownError,
  PlannerFunctionUnknownError,
  PlannerFunctionModelUnchangedError,
  PlannerModelListModelMissingError,
  PlannerModelUnchangedError,
  PlannerReviewModelUnchangedError,
} from '@/lib/platform/errors';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import { userRepository } from '@/lib/repositories/userRepository';
import { assertReasonSatisfied } from '@/lib/services/platformAuditService';

/**
 * The platform PLANNING MODEL — Story MOTIR-7220 · MOTIR-7227, the console seam.
 *
 * Which model Motir plans with is one setting per audience (customer orgs, the
 * meta org, internal orgs), stored and validated in motir-ai
 * (`GET` / `PUT /v1/planner-model-settings`). This service is how the operator
 * console reads and changes it: any staff role reads, only a `superadmin`
 * writes, and every write appends one `PlatformAuditLog` row. No Prisma here —
 * the setting is motir-ai's and the audit row goes through `withPlatformRead`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE AUDIT ROW IS IN CORE AND THE SETTING IN MOTIR-AI
 * ---------------------------------------------------------------------------
 * The platform audit log is core's single append-only record of every staff
 * action (`docs/decisions/platform-staff-auth.md` §7: *"Every one of those
 * writes reuses this gate and this `PlatformAuditLog`"*), and the facts that
 * make a model acceptable — a servable catalogue row, a `planning` rate, a probe
 * that answered — are motir-ai's. So the REMOTE write runs INSIDE the audited
 * transaction: a refusal thrown by motir-ai rolls the audit row back with it,
 * and a refused write leaves no row.
 *
 * ⚠️ THE ONE RESIDUAL CASE, named rather than hidden: motir-ai applies the
 * change and core's commit then fails. The setting has moved and the trail has
 * no row for it. Nothing here can make a remote write and a local commit atomic;
 * the case is logged with both values so the row can be written by hand, and
 * motir-ai's own `updatedByCoreUserId` still names who did it.
 */

function isPlannerAudience(value: string): value is PlannerAudience {
  return (PLANNER_AUDIENCES as readonly string[]).includes(value);
}

function isPlannerFunction(value: string): value is PlannerDefaultFunction {
  return (PLANNER_DEFAULT_FUNCTIONS as readonly string[]).includes(value);
}

export const platformPlannerModelService = {
  /**
   * The AI PLANNING page: three rows in `customer`, `meta`, `internal` order,
   * the offered models, and whether this principal may edit.
   *
   * Not audited: it reads no tenant row and no person's data — a platform
   * setting and the offered catalogue — and the ADR's read row is about crossing
   * the tenant boundary. The changer NAMES come from core's `User` table, which
   * is reference data here (`CLAUDE.md`: a read of unrelated reference data
   * needs no transaction).
   *
   * @throws NotPlatformStaffError for a non-staff caller.
   * @throws MotirAiUnavailableError when motir-ai cannot answer — the page shows
   *   its error card rather than a guessed value.
   */
  async getSettings(principal: PlatformPrincipal): Promise<PlatformPlannerModelSettingsDTO> {
    await requirePlatformStaff('support');
    const read = await getPlannerModelSettings();
    const changers = [
      ...new Set(
        [
          ...read.settings.map((s) => s.updatedByCoreUserId),
          read.review?.updatedByCoreUserId,
          ...(read.functions ?? []).map((f) => f.updatedByCoreUserId),
        ].filter((id): id is string => !!id),
      ),
    ];
    const users = await userRepository.findByIds(changers);
    return toPlatformPlannerModelSettingsDTO(
      read,
      users,
      platformRoleAtLeast(principal.role, 'superadmin'),
    );
  },

  /**
   * Set one audience's planning model.
   *
   * The ORDER is the contract, and each step is placed where it is so a refusal
   * leaves no audit row:
   *
   *   1. `superadmin`, before any remote call.
   *   2. The REASON, before the transaction — `withPlatformRead` writes the audit
   *      row as its first statement, so a reason checked later would be checked
   *      after its row existed (`setInternalBilling`'s ordering, for the same
   *      reason).
   *   3. The CURRENT model, read through the client, so the row can say from → to
   *      and a save to the model already held is refused as a non-change.
   *   4. The audited transaction, with motir-ai's write inside it: a
   *      `PlannerModelNotOfferedError` or `PlannerModelUnreachableError` thrown
   *      there rolls the row back.
   *
   * If motir-ai's `previousModel` (read under its own row lock) is not the
   * `fromModel` read in step 3, another write landed in between. The save still
   * succeeds — the new model is what the superadmin chose — and a warning
   * carries both, because the row's `fromModel` then names the model this
   * superadmin SAW, not the one the write replaced.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws PlannerAudienceUnknownError for an audience that is not one of the three.
   * @throws PlannerModelUnchangedError when the audience already holds `model`.
   * @throws PlannerModelNotOfferedError / PlannerModelUnreachableError from motir-ai.
   */
  async setModel(
    principal: PlatformPrincipal,
    audience: string,
    model: string,
    reason: string,
  ): Promise<PlatformPlannerModelWriteDTO> {
    await requirePlatformStaff('superadmin');
    if (!isPlannerAudience(audience)) throw new PlannerAudienceUnknownError(audience);
    const base = {
      action: 'ai.planner_model.set' as const,
      targetKind: 'platform' as const,
      targetId: audience,
      reason,
    };
    assertReasonSatisfied(base);

    const current = await getPlannerModelSettings();
    const fromModel = current.settings.find((s) => s.audience === audience)?.model ?? null;
    if (fromModel === model) throw new PlannerModelUnchangedError(audience, model);

    const entry: PlatformAuditEntry = {
      ...base,
      metadata: { audience, fromModel, toModel: model },
    };
    let applied = null as { previousModel: string; model: string } | null;
    try {
      const result = await withPlatformRead(principal, entry, async () => {
        const written = await setPlannerModel({
          audience,
          model,
          actorCoreUserId: principal.userId,
        });
        applied = written;
        return written;
      });
      if (result.previousModel !== fromModel) {
        console.warn(
          `[platform-planner-model] concurrent write on the ${audience} audience: this save read ` +
            `"${fromModel}" but replaced "${result.previousModel}" (now "${result.model}")`,
        );
      }
      return toPlatformPlannerModelWriteDTO(result, fromModel ?? result.previousModel);
    } catch (err) {
      if (applied) {
        // The residual case in this file's header: motir-ai moved the setting and
        // core's commit did not land, so the trail has no row for a real change.
        const { previousModel, model: toModel } = applied;
        console.error(
          `[platform-planner-model] motir-ai applied ${audience}: "${previousModel}" → ` +
            `"${toModel}" by ${principal.userId}, but the audit row did not commit`,
          err,
        );
      }
      throw err;
    }
  },

  /**
   * Set the dry-run REVIEW model (MOTIR-10632): a model from the planning-model
   * list, or `null` for "same as the planning model". `setModel`'s order, for its
   * reasons — superadmin, the reason, the current value read through the client
   * so the row says from → to, then the audited transaction with motir-ai's write
   * inside it, so a refusal rolls the row back. The residual case and the
   * concurrent-write warning are `setModel`'s too.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws PlannerReviewModelUnchangedError when `model` is already stored.
   * @throws PlannerModelNotOfferedError / PlannerModelUnreachableError from motir-ai.
   * @throws MotirAiUnavailableError when motir-ai serves no review setting (an
   *   older release) — the write has nowhere to land.
   */
  async setReviewModel(
    principal: PlatformPrincipal,
    model: string | null,
    reason: string,
  ): Promise<PlatformPlannerReviewModelWriteDTO> {
    await requirePlatformStaff('superadmin');
    const base = {
      action: 'ai.planner_review_model.set' as const,
      targetKind: 'platform' as const,
      targetId: 'review',
      reason,
    };
    assertReasonSatisfied(base);

    const current = await getPlannerModelSettings();
    if (!current.review) {
      throw new MotirAiUnavailableError('motir-ai serves no dry-run review-model setting');
    }
    const fromModel = current.review.model;
    if (fromModel === model) throw new PlannerReviewModelUnchangedError(model);

    const entry: PlatformAuditEntry = { ...base, metadata: { fromModel, toModel: model } };
    let applied = null as { previousModel: string | null; model: string | null } | null;
    try {
      const result = await withPlatformRead(principal, entry, async () => {
        const written = await setPlannerReviewModel({ model, actorCoreUserId: principal.userId });
        applied = written;
        return written;
      });
      if (result.previousModel !== fromModel) {
        console.warn(
          `[platform-planner-model] concurrent write on the review model: this save read ` +
            `"${fromModel}" but replaced "${result.previousModel}" (now "${result.model}")`,
        );
      }
      return toPlatformPlannerReviewModelWriteDTO(result, fromModel);
    } catch (err) {
      if (applied) {
        const { previousModel, model: toModel } = applied;
        console.error(
          `[platform-planner-model] motir-ai applied the review model: "${previousModel}" → ` +
            `"${toModel}" by ${principal.userId}, but the audit row did not commit`,
          err,
        );
      }
      throw err;
    }
  },

  /**
   * Set Guide's, Debug's or Ask's platform default (MOTIR-10844): a model from the
   * planning-model list, or `null` to follow the audience's Planning model.
   * `setReviewModel`'s order, for its reasons — superadmin, the reason, the
   * current value read through the client so the row says from → to, then the
   * audited transaction with motir-ai's write inside it, so a refusal rolls the
   * row back. The concurrent-write warning and the residual case are its too.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws PlannerFunctionUnknownError for a function that is not one of the three.
   * @throws PlannerFunctionModelUnchangedError when `model` is already stored.
   * @throws PlannerModelNotOfferedError / PlannerModelUnreachableError from motir-ai.
   * @throws MotirAiUnavailableError when motir-ai serves no function rows (an
   *   older release) — the write has nowhere to land.
   */
  async setFunctionModel(
    principal: PlatformPrincipal,
    fn: string,
    model: string | null,
    reason: string,
  ): Promise<PlatformPlannerFunctionModelWriteDTO> {
    await requirePlatformStaff('superadmin');
    if (!isPlannerFunction(fn)) throw new PlannerFunctionUnknownError(fn);
    const base = {
      action: 'ai.planner_function_model.set' as const,
      targetKind: 'platform' as const,
      targetId: fn,
      reason,
    };
    assertReasonSatisfied(base);

    const current = await getPlannerModelSettings();
    const row = current.functions?.find((f) => f.function === fn);
    if (!row) throw new MotirAiUnavailableError(`motir-ai serves no ${fn} default`);
    const fromModel = row.model;
    if (fromModel === model) throw new PlannerFunctionModelUnchangedError(fn, model);

    const entry: PlatformAuditEntry = {
      ...base,
      metadata: { function: fn, fromModel, toModel: model },
    };
    let applied = null as { previousModel: string | null; model: string | null } | null;
    try {
      const result = await withPlatformRead(principal, entry, async () => {
        const written = await setPlannerFunctionModel({
          function: fn,
          model,
          actorCoreUserId: principal.userId,
        });
        applied = written;
        return written;
      });
      if (result.previousModel !== fromModel) {
        console.warn(
          `[platform-planner-model] concurrent write on the ${fn} default: this save read ` +
            `"${fromModel}" but replaced "${result.previousModel}" (now "${result.model}")`,
        );
      }
      return toPlatformPlannerFunctionModelWriteDTO(result, fromModel);
    } catch (err) {
      if (applied) {
        const { previousModel, model: toModel } = applied;
        console.error(
          `[platform-planner-model] motir-ai applied the ${fn} default: "${previousModel}" → ` +
            `"${toModel}" by ${principal.userId}, but the audit row did not commit`,
          err,
        );
      }
      throw err;
    }
  },

  /**
   * The PLANNING-MODEL LIST card (Story MOTIR-7521 · MOTIR-7524): every listed
   * model with its offered state and reason, which audiences use it, and whether
   * this principal may edit. Any staff role reads; not audited, for
   * `getSettings`' reason.
   *
   * The settings are read beside the list so each entry can say which audiences
   * are set to it — the thing a remove is refused for.
   *
   * @throws NotPlatformStaffError for a non-staff caller.
   * @throws MotirAiUnavailableError when motir-ai cannot answer — never an empty list.
   */
  async listModels(principal: PlatformPrincipal): Promise<PlatformPlannerModelListDTO> {
    await requirePlatformStaff('support');
    const [list, settings] = await Promise.all([getPlannerModelList(), getPlannerModelSettings()]);
    const adders = [
      ...new Set(list.entries.map((e) => e.addedByCoreUserId).filter((id): id is string => !!id)),
    ];
    const users = await userRepository.findByIds(adders);
    return toPlatformPlannerModelListDTO(
      list,
      settings,
      users,
      platformRoleAtLeast(principal.role, 'superadmin'),
    );
  },

  /**
   * Add a model to the planning list. `setModel`'s order, for its reasons:
   * superadmin, then the reason, then the audited transaction with motir-ai's
   * write inside it, so a refusal rolls the row back.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws PlannerModelNotQualifiedError when motir-ai would not plan with it.
   */
  async addModel(
    principal: PlatformPrincipal,
    model: string,
    reason: string,
  ): Promise<PlatformPlannerModelListDTO> {
    return changeList(principal, 'add', model, reason);
  },

  /**
   * Remove a model from the planning list, on `addModel`'s pattern.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws PlannerModelListFallbackError for the planner's fallback.
   * @throws PlannerModelListEntryInUseError for a model an audience is set to.
   */
  async removeModel(
    principal: PlatformPrincipal,
    model: string,
    reason: string,
  ): Promise<PlatformPlannerModelListDTO> {
    return changeList(principal, 'remove', model, reason);
  },
};

/** One audited planning-list write — the body `addModel` and `removeModel` share. */
async function changeList(
  principal: PlatformPrincipal,
  action: 'add' | 'remove',
  rawModel: string,
  reason: string,
): Promise<PlatformPlannerModelListDTO> {
  await requirePlatformStaff('superadmin');
  const model = rawModel.trim();
  const entry: PlatformAuditEntry = {
    action: action === 'add' ? 'ai.planner_model_list.add' : 'ai.planner_model_list.remove',
    targetKind: 'platform',
    targetId: model,
    reason,
    metadata: { action, model },
  };
  assertReasonSatisfied(entry);
  if (!model) throw new PlannerModelListModelMissingError();

  let applied = false;
  let list: PlannerModelListRead;
  try {
    list = await withPlatformRead(principal, entry, async () => {
      const written = await updatePlannerModelList({
        action,
        model,
        actorCoreUserId: principal.userId,
      });
      applied = true;
      return written;
    });
  } catch (err) {
    if (applied) {
      // The residual case in this file's header, for the list.
      // A constant format string: the model id is operator input (CodeQL).
      console.error(
        '[platform-planner-model] motir-ai applied a planning-list change, but the audit row did not commit',
        { action, model, actorCoreUserId: principal.userId },
        err,
      );
    }
    throw err;
  }
  // The settings and the adders' names are reference reads after the commit, so
  // a failure here is not the residual case above: the change and its row landed.
  const [settings, users] = await Promise.all([
    getPlannerModelSettings(),
    userRepository.findByIds([
      ...new Set(list.entries.map((e) => e.addedByCoreUserId).filter((id): id is string => !!id)),
    ]),
  ]);
  return toPlatformPlannerModelListDTO(list, settings, users, true);
}
