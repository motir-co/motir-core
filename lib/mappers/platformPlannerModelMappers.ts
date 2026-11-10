import type { User } from '@/generated/prisma/client';
import {
  PLANNER_AUDIENCES,
  PLANNER_DEFAULT_FUNCTIONS,
  PLANNER_MODEL_FALLBACK,
  type PlannerFunctionModelWriteResult,
  type PlannerModelListRead,
  type PlannerModelSettingsRead,
  type PlannerModelWriteResult,
  type PlannerReviewModelWriteResult,
} from '@/lib/ai/types';
import type {
  PlatformPlannerFunctionModelWriteDTO,
  PlatformPlannerFunctionRowDTO,
  PlatformPlannerModelListDTO,
  PlatformPlannerModelRowDTO,
  PlatformPlannerModelSettingsDTO,
  PlatformPlannerModelWriteDTO,
  PlatformPlannerReviewModelWriteDTO,
} from '@/lib/dto/platformPlannerModel';

/**
 * motir-ai's planner-model read → the console DTO (MOTIR-7227).
 *
 * The rows are put in `customer`, `meta`, `internal` order HERE rather than
 * trusted from the wire, so the page's order is a property of this build and not
 * of whichever motir-ai answered. An audience motir-ai did not return is left
 * out rather than invented — the page draws what exists, never a guess.
 */
export function toPlatformPlannerModelSettingsDTO(
  read: PlannerModelSettingsRead,
  users: readonly Pick<User, 'id' | 'name' | 'email'>[],
  canEdit: boolean,
): PlatformPlannerModelSettingsDTO {
  const nameById = new Map(users.map((u) => [u.id, u.name?.trim() || u.email]));
  const rows: PlatformPlannerModelRowDTO[] = [];
  for (const audience of PLANNER_AUDIENCES) {
    const s = read.settings.find((x) => x.audience === audience);
    if (!s) continue;
    rows.push({
      audience,
      model: s.model,
      offered: s.offered,
      reachable: s.reachable ?? null,
      lastProbeAt: s.lastProbeAt ?? null,
      lastProbeError: s.lastProbeError ?? null,
      updatedAt: s.updatedAt,
      updatedBy: s.updatedByCoreUserId ? (nameById.get(s.updatedByCoreUserId) ?? null) : null,
      seeded: !s.updatedByCoreUserId,
    });
  }
  const review = read.review
    ? {
        model: read.review.model ?? null,
        offered: read.review.offered ?? null,
        updatedAt: read.review.updatedAt ?? null,
        updatedBy: read.review.updatedByCoreUserId
          ? (nameById.get(read.review.updatedByCoreUserId) ?? null)
          : null,
        seeded: !read.review.updatedByCoreUserId,
      }
    : null;
  const functions: PlatformPlannerFunctionRowDTO[] = [];
  for (const fn of PLANNER_DEFAULT_FUNCTIONS) {
    const f = read.functions?.find((x) => x.function === fn);
    if (!f) continue;
    functions.push({
      function: fn,
      model: f.model,
      offered: f.offered,
      updatedAt: f.updatedAt,
      updatedBy: f.updatedByCoreUserId ? (nameById.get(f.updatedByCoreUserId) ?? null) : null,
      seeded: !f.updatedByCoreUserId,
    });
  }
  return {
    rows,
    review,
    functions,
    offered: read.offered.map((m) => ({ id: m.id, provider: m.provider })),
    canEdit,
  };
}

/** motir-ai's review-model write answer → the console DTO, with `fromModel` as core audited it. */
export function toPlatformPlannerReviewModelWriteDTO(
  result: PlannerReviewModelWriteResult,
  fromModel: string | null,
): PlatformPlannerReviewModelWriteDTO {
  return { fromModel, toModel: result.model, updatedAt: result.updatedAt };
}

/** motir-ai's function-default write answer → the console DTO (MOTIR-10844). */
export function toPlatformPlannerFunctionModelWriteDTO(
  result: PlannerFunctionModelWriteResult,
  fromModel: string | null,
): PlatformPlannerFunctionModelWriteDTO {
  return {
    function: result.function,
    fromModel,
    toModel: result.model,
    updatedAt: result.updatedAt,
  };
}

/** motir-ai's write answer → the console DTO, with `fromModel` as core audited it. */
export function toPlatformPlannerModelWriteDTO(
  result: PlannerModelWriteResult,
  fromModel: string,
): PlatformPlannerModelWriteDTO {
  return {
    audience: result.audience,
    fromModel,
    toModel: result.model,
    updatedAt: result.updatedAt,
  };
}

/**
 * motir-ai's planning-model list + the audience settings → the list card's DTO
 * (MOTIR-7524).
 *
 * `inUseBy` is computed HERE from the settings read, because it is what the page
 * needs to say why a remove would be refused before anyone presses it; motir-ai
 * still re-checks it under its row lock on the write. The entries keep motir-ai's
 * order.
 */
export function toPlatformPlannerModelListDTO(
  list: PlannerModelListRead,
  settings: PlannerModelSettingsRead,
  users: readonly Pick<User, 'id' | 'name' | 'email'>[],
  canEdit: boolean,
): PlatformPlannerModelListDTO {
  const nameById = new Map(users.map((u) => [u.id, u.name?.trim() || u.email]));
  return {
    entries: list.entries.map((e) => ({
      model: e.model,
      provider: e.provider,
      offered: e.offered,
      reason: e.offered ? null : e.reason,
      inUseBy: PLANNER_AUDIENCES.filter((audience) =>
        settings.settings.some((s) => s.audience === audience && s.model === e.model),
      ),
      fallback: e.model === PLANNER_MODEL_FALLBACK,
      createdAt: e.createdAt,
      addedBy: e.addedByCoreUserId ? (nameById.get(e.addedByCoreUserId) ?? null) : null,
      seeded: !e.addedByCoreUserId,
    })),
    candidates: list.candidates.map((c) => ({ id: c.id, provider: c.provider })),
    canEdit,
  };
}
