'use server';

import { revalidatePath } from 'next/cache';
import {
  MotirAiUnavailableError,
  PlannerModelListEntryInUseError,
  PlannerModelListFallbackError,
  PlannerModelListRefusedError,
  PlannerModelNotOfferedError,
  PlannerModelNotQualifiedError,
  PlannerModelUnreachableError,
} from '@/lib/ai/errors';
import type { PlannerModelListReason } from '@/lib/ai/types';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlannerAudienceUnknownError,
  PlannerModelListModelMissingError,
  PlannerModelUnchangedError,
  PlannerReviewModelUnchangedError,
} from '@/lib/platform/errors';
import { platformPlannerModelService } from '@/lib/services/platformPlannerModelService';

/**
 * The PLANNING-MODEL write — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10 (AI planning), card MOTIR-7231.
 *
 * Transport only, the `tenants/[orgId]/actions.ts` shape: resolve the platform
 * principal, call ONE service method, translate the typed errors into the
 * discriminated result the rows map to their copy. Who may do this, the reason
 * rule, the from → to audit row and its ordering live in
 * `platformPlannerModelService.setModel`.
 *
 * ⚠️ THE GATE IS ASSERTED HERE AND AGAIN IN THE SERVICE. A Server Action is a
 * POST the `(admin)` layout never renders, so it resolves the principal itself;
 * the service asserts `superadmin` once more. Hiding the picker from an
 * `operator` is presentation; this is the rule.
 *
 * ⚠️ A RESULT, NOT A THROW: a thrown error reaches the browser as a stripped
 * digest in production, and the page draws a different state for each refusal.
 */

export type PlannerModelActionResult =
  | { ok: true }
  | { ok: false; code: 'NOT_OFFERED' }
  | { ok: false; code: 'UNREACHABLE'; reason: string }
  | {
      ok: false;
      code: 'UNCHANGED' | 'UNAVAILABLE' | 'REASON_REQUIRED' | 'NOT_PERMITTED' | 'FAILED';
    };

export async function setPlannerModelAction(
  audience: string,
  model: string,
  reason: string,
): Promise<PlannerModelActionResult> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    await platformPlannerModelService.setModel(principal, audience, model, reason);
    // The rows are server-rendered props: the re-read is what shows the new
    // model and its last-changed line (`CLAUDE.md`'s page-state contract).
    revalidatePath('/admin/ai-planning');
    return { ok: true };
  } catch (err) {
    if (err instanceof PlannerModelNotOfferedError) {
      // The offered list moved since the page loaded; the island re-reads it.
      revalidatePath('/admin/ai-planning');
      return { ok: false, code: 'NOT_OFFERED' };
    }
    if (err instanceof PlannerModelUnreachableError) {
      return { ok: false, code: 'UNREACHABLE', reason: err.reason };
    }
    if (err instanceof PlannerModelUnchangedError) return { ok: false, code: 'UNCHANGED' };
    if (err instanceof MotirAiUnavailableError) return { ok: false, code: 'UNAVAILABLE' };
    if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    if (err instanceof PlannerAudienceUnknownError) {
      console.error(
        '[admin] planner-model action got an unknown audience',
        JSON.stringify(audience),
      );
      return { ok: false, code: 'FAILED' };
    }
    console.error('[admin] planner-model action failed', { audience }, err);
    return { ok: false, code: 'FAILED' };
  }
}

/**
 * The dry-run REVIEW-MODEL write (MOTIR-10632): `model` is a planning-list model,
 * or `null` for "same as the planning model". The same transport shape and the
 * same gate twice as `setPlannerModelAction`, and the same result codes, so the
 * review row draws the audience rows' states.
 */
export async function setPlannerReviewModelAction(
  model: string | null,
  reason: string,
): Promise<PlannerModelActionResult> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    await platformPlannerModelService.setReviewModel(principal, model, reason);
    revalidatePath('/admin/ai-planning');
    return { ok: true };
  } catch (err) {
    if (err instanceof PlannerModelNotOfferedError) {
      revalidatePath('/admin/ai-planning');
      return { ok: false, code: 'NOT_OFFERED' };
    }
    if (err instanceof PlannerModelUnreachableError) {
      return { ok: false, code: 'UNREACHABLE', reason: err.reason };
    }
    if (err instanceof PlannerReviewModelUnchangedError) return { ok: false, code: 'UNCHANGED' };
    if (err instanceof MotirAiUnavailableError) return { ok: false, code: 'UNAVAILABLE' };
    if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    console.error('[admin] review-model action failed', err);
    return { ok: false, code: 'FAILED' };
  }
}

/**
 * The PLANNING-MODEL LIST writes — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10-04 (Model lists) Panels 1–4 and 12, card MOTIR-7527.
 * The same transport shape as `setPlannerModelAction`, and the same gate twice.
 */
export type PlannerListActionResult =
  | { ok: true }
  | { ok: false; code: 'NOT_QUALIFIED'; reason: PlannerModelListReason | null; detail: string }
  | { ok: false; code: 'IN_USE'; audiences: string[] }
  | { ok: false; code: 'REFUSED'; detail: string }
  | {
      ok: false;
      code:
        | 'FALLBACK'
        | 'MODEL_REQUIRED'
        | 'UNAVAILABLE'
        | 'REASON_REQUIRED'
        | 'NOT_PERMITTED'
        | 'FAILED';
    };

export async function addPlannerListModelAction(
  model: string,
  reason: string,
): Promise<PlannerListActionResult> {
  return changePlannerList('add', model, reason);
}

export async function removePlannerListModelAction(
  model: string,
  reason: string,
): Promise<PlannerListActionResult> {
  return changePlannerList('remove', model, reason);
}

async function changePlannerList(
  action: 'add' | 'remove',
  model: string,
  reason: string,
): Promise<PlannerListActionResult> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    if (action === 'add') await platformPlannerModelService.addModel(principal, model, reason);
    else await platformPlannerModelService.removeModel(principal, model, reason);
    // The list and the audience pickers beside it are server-rendered props.
    revalidatePath('/admin/ai-planning');
    return { ok: true };
  } catch (err) {
    if (err instanceof PlannerModelNotQualifiedError) {
      return { ok: false, code: 'NOT_QUALIFIED', reason: err.reason, detail: err.detail };
    }
    if (err instanceof PlannerModelListEntryInUseError) {
      return { ok: false, code: 'IN_USE', audiences: [...err.audiences] };
    }
    if (err instanceof PlannerModelListFallbackError) return { ok: false, code: 'FALLBACK' };
    if (err instanceof PlannerModelListRefusedError) {
      return { ok: false, code: 'REFUSED', detail: err.detail };
    }
    if (err instanceof PlannerModelListModelMissingError) {
      return { ok: false, code: 'MODEL_REQUIRED' };
    }
    if (err instanceof MotirAiUnavailableError) return { ok: false, code: 'UNAVAILABLE' };
    if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    console.error('[admin] planner-list action failed', { action, model }, err);
    return { ok: false, code: 'FAILED' };
  }
}
