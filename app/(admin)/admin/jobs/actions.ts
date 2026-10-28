'use server';

import { revalidatePath } from 'next/cache';
import { requirePlatformStaff } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { DlqEntryNotFoundError, SystemReplayForbiddenError } from '@/lib/jobs/errors';
import { platformJobReplayService } from '@/lib/services/platformJobReplayService';
import type { ReplayAllResultDTO } from '@/lib/dto/jobs';

/**
 * The platform job ledger's two REPLAY actions — design `platform-admin`
 * AMENDMENT 2026-10-28 § Jobs, card MOTIR-9987, story MOTIR-9980.
 *
 * Transport only, the `fleet-settings/actions.ts` shape: resolve the platform
 * principal, call ONE service method, translate the typed errors into the
 * discriminated result the island maps to its drawn states. The operator rule
 * and the audit rows live in `platformJobReplayService`.
 *
 * ⚠️ THE GATE IS ASSERTED HERE AND AGAIN IN THE SERVICE. A Server Action is a
 * POST the `(admin)` layout never renders, so it resolves the principal itself.
 * The page drawing no Replay button for support is presentation.
 *
 * ⚠️ A RESULT, NOT A THROW: a thrown error reaches the browser as a stripped
 * digest in production, and the island draws a different state per answer.
 */

const PAGE = '/admin/jobs';

export type ReplayDeadLetterActionResult =
  | { ok: true; outcome: 'replayed' | 'already-replayed' }
  | { ok: false; code: 'NOT_PERMITTED' | 'NOT_FOUND' | 'FAILED' };

export type ReplayAllDeadLettersActionResult =
  | { ok: true; result: ReplayAllResultDTO }
  | { ok: false; code: 'NOT_PERMITTED' | 'FAILED' };

function isRefusal(err: unknown): boolean {
  return err instanceof NotPlatformStaffError || err instanceof SystemReplayForbiddenError;
}

export async function replayDeadLetterAction(dlqId: string): Promise<ReplayDeadLetterActionResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    const result = await platformJobReplayService.replayOne({ dlqId, principal });
    // The list, the tab count and the filter counts are server-rendered: the
    // re-read is what moves the row to replayed.
    revalidatePath(PAGE);
    return { ok: true, outcome: result.outcome };
  } catch (err) {
    if (isRefusal(err)) return { ok: false, code: 'NOT_PERMITTED' };
    if (err instanceof DlqEntryNotFoundError) return { ok: false, code: 'NOT_FOUND' };
    console.error('[admin/jobs] replay failed', {
      detail: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
    });
    return { ok: false, code: 'FAILED' };
  }
}

export async function replayAllDeadLettersAction(
  functionId: string,
): Promise<ReplayAllDeadLettersActionResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    const result = await platformJobReplayService.replayAllDeadLettersForFunction({
      functionId,
      principal,
    });
    revalidatePath(PAGE);
    return { ok: true, result };
  } catch (err) {
    if (isRefusal(err)) return { ok: false, code: 'NOT_PERMITTED' };
    console.error('[admin/jobs] replay all failed', {
      detail: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
    });
    return { ok: false, code: 'FAILED' };
  }
}
