'use server';

import { revalidatePath } from 'next/cache';
import {
  MotirAiBadRequestError,
  MotirAiConflictError,
  MotirAiError,
  PlannerFindingNotFoundError,
} from '@/lib/ai/errors';
import type { PlannerFindingRowDTO } from '@/lib/dto/plannerFindings';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  NotPlatformStaffError,
  PlannerFindingInvalidError,
  PlannerFindingLessonNotLinkedError,
  PlannerFindingUnchangedError,
} from '@/lib/platform/errors';
import {
  plannerFindingsTriageService,
  type PlannerFindingAttributionInput,
  type PlannerFindingPromoteForm,
} from '@/lib/services/plannerFindingsTriageService';

/**
 * The PLANNER-FINDING triage writes — Story MOTIR-10353, card MOTIR-10520.
 *
 * Transport only, the `planning-lessons/actions.ts` shape: resolve the platform
 * principal, call ONE `plannerFindingsTriageService` method, translate the typed
 * errors into the discriminated result the triage controls draw. The gate,
 * validation, the motir-ai calls, the promote ordering and the audit row live in
 * the service.
 *
 * ⚠️ THE GATE IS ASSERTED HERE AND AGAIN IN THE SERVICE. A Server Action is a
 * POST the `(admin)` layout never renders, so it resolves the principal itself.
 *
 * ⚠️ A RESULT, NOT A THROW: a thrown error reaches the browser as a stripped
 * digest in production, and the controls draw a different answer per refusal.
 *
 * Two differences from the lesson actions: success carries the finding as it
 * now stands (the controls re-render from it, the promote control shows the
 * linked lesson at once), and revalidation is the whole `/admin/planner-findings`
 * layout, so the list, the grouped view, a group page and every detail re-read
 * without this file naming their paths.
 */

export type PlannerFindingActionResult =
  | { ok: true; finding: PlannerFindingRowDTO }
  | {
      ok: false;
      code: 'NOT_PERMITTED' | 'GONE' | 'UNCHANGED' | 'INVALID' | 'UNAVAILABLE' | 'FAILED';
    }
  | { ok: false; code: 'LESSON_NOT_LINKED'; lessonId: string }
  | { ok: false; code: 'DUPLICATE_LESSON'; detail: string };

function revalidateConsole(): void {
  revalidatePath('/admin/planner-findings', 'layout');
}

// The order matters: the specific classes come before the generic `MotirAiError`
// arm, because `PlannerFindingNotFoundError`, `MotirAiBadRequestError` and
// `MotirAiConflictError` are all `MotirAiError`s, and a lesson that was created
// but not linked must never read as a retryable failure.
function refused(err: unknown, findingId: string, act: string): PlannerFindingActionResult {
  if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
  if (err instanceof PlannerFindingNotFoundError) {
    // The re-read is what drops the finding from the list.
    revalidateConsole();
    return { ok: false, code: 'GONE' };
  }
  if (err instanceof PlannerFindingUnchangedError) {
    // The re-read shows where the finding actually is.
    revalidateConsole();
    return { ok: false, code: 'UNCHANGED' };
  }
  if (err instanceof PlannerFindingInvalidError || err instanceof MotirAiBadRequestError) {
    return { ok: false, code: 'INVALID' };
  }
  if (err instanceof PlannerFindingLessonNotLinkedError) {
    // The lesson exists now; the control names it so nobody creates it again.
    revalidateConsole();
    return { ok: false, code: 'LESSON_NOT_LINKED', lessonId: err.lessonId };
  }
  if (err instanceof MotirAiConflictError) {
    // motir-ai's near-duplicate refusal names the existing lesson: pass it on.
    return { ok: false, code: 'DUPLICATE_LESSON', detail: err.detail };
  }
  if (err instanceof MotirAiError) {
    console.error(`[admin] planner finding ${act} could not reach motir-ai`, { findingId }, err);
    return { ok: false, code: 'UNAVAILABLE' };
  }
  console.error(`[admin] planner finding ${act} failed`, { findingId }, err);
  return { ok: false, code: 'FAILED' };
}

function saved(finding: PlannerFindingRowDTO): PlannerFindingActionResult {
  revalidateConsole();
  return { ok: true, finding };
}

export async function setPlannerFindingAttributionAction(
  findingId: string,
  input: PlannerFindingAttributionInput,
): Promise<PlannerFindingActionResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    const { finding } = await plannerFindingsTriageService.setAttribution(
      principal,
      findingId,
      input,
    );
    return saved(finding);
  } catch (err) {
    return refused(err, findingId, 'attribution');
  }
}

export async function recordPlannerFindingBugKeyAction(
  findingId: string,
  bugKey: string,
): Promise<PlannerFindingActionResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    const { finding } = await plannerFindingsTriageService.recordBugKey(
      principal,
      findingId,
      bugKey,
    );
    return saved(finding);
  } catch (err) {
    return refused(err, findingId, 'bug key');
  }
}

export async function dismissPlannerFindingAction(
  findingId: string,
  note?: string,
): Promise<PlannerFindingActionResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    const { finding } = await plannerFindingsTriageService.dismiss(principal, findingId, note);
    return saved(finding);
  } catch (err) {
    return refused(err, findingId, 'dismiss');
  }
}

export async function restorePlannerFindingAction(
  findingId: string,
): Promise<PlannerFindingActionResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    const { finding } = await plannerFindingsTriageService.restore(principal, findingId);
    return saved(finding);
  } catch (err) {
    return refused(err, findingId, 'restore');
  }
}

export async function promotePlannerFindingAction(
  findingId: string,
  form: PlannerFindingPromoteForm,
): Promise<PlannerFindingActionResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    const { finding } = await plannerFindingsTriageService.promoteToLesson(
      principal,
      findingId,
      form,
    );
    return saved(finding);
  } catch (err) {
    // No retry: a LESSON_NOT_LINKED answer means the lesson already exists.
    return refused(err, findingId, 'promote');
  }
}
