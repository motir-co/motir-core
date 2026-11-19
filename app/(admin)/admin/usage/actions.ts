'use server';

import { requirePlatformStaff } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { platformFailedUsageService } from '@/lib/services/platformFailedUsageService';
import type { FailedUsageReplayDTO } from '@/lib/dto/failedUsage';

/**
 * Usage & cost's one write: REPLAY a group of failed usage (MOTIR-11794; design
 * MOTIR-11793). Transport only, the `jobs/actions.ts` shape: resolve the
 * platform principal, call ONE service method, and translate a typed error into
 * the result the section draws. The operator rule and the audit row live in
 * `platformFailedUsageService`.
 *
 * ⚠️ THE GATE IS ASSERTED HERE AND AGAIN IN THE SERVICE. A Server Action is a
 * POST the `(admin)` layout never renders; support seeing no Replay button is
 * presentation.
 *
 * ⚠️ NO revalidatePath. The island keeps the result under its group and
 * re-reads the page itself once the answer is drawn, as Jobs' Replay all does,
 * so the answer and the re-read never race.
 */

export type ReplayFailedUsageActionResult =
  | { ok: true; replay: FailedUsageReplayDTO }
  | { ok: false; code: 'NOT_PERMITTED' | 'INVALID' | 'FAILED' };

export async function replayFailedUsageAction(
  error: unknown,
): Promise<ReplayFailedUsageActionResult> {
  if (typeof error !== 'string') return { ok: false, code: 'INVALID' };
  try {
    const principal = await requirePlatformStaff('operator');
    const replay = await platformFailedUsageService.replayGroup({ error, principal });
    return { ok: true, replay };
  } catch (err) {
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    console.error('[admin/usage] failed-usage replay failed', {
      detail: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
    });
    return { ok: false, code: 'FAILED' };
  }
}
