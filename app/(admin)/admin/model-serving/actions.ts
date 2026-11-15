'use server';

import { revalidatePath } from 'next/cache';
import {
  GatewayModelServingConfigError,
  GatewayModelServingRefusedError,
  GatewayModelServingUnavailableError,
} from '@/lib/gateway/modelServingClient';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  ModelServingUnavailableError,
  ModelServingUnknownModelError,
  ModelServingUnknownProviderError,
  NotPlatformStaffError,
} from '@/lib/platform/errors';
import { platformModelServingService } from '@/lib/services/platformModelServingService';

/**
 * The MODEL SERVING write (MOTIR-11280; design `platform-admin/design-notes.md`
 * § Model serving, Panels 3–5).
 *
 * Transport only, `run-models/actions.ts`' shape: resolve the principal at
 * `superadmin`, call ONE service method, and turn every typed refusal into a
 * result, because a thrown error would reach the browser as a stripped digest.
 */

export type ModelServingActionResult =
  | { ok: true; servedBy: string | null }
  | {
      ok: false;
      code: 'UNKNOWN_MODEL' | 'UNKNOWN_PROVIDER' | 'UNAVAILABLE' | 'NOT_PERMITTED' | 'FAILED';
    };

export async function setModelServingAction(
  model: string,
  provider: string | null,
): Promise<ModelServingActionResult> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    const saved = await platformModelServingService.setServing(principal, model, provider);
    revalidatePath('/admin/model-serving');
    return { ok: true, servedBy: saved.effective };
  } catch (err) {
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    if (
      err instanceof ModelServingUnknownModelError ||
      err instanceof ModelServingUnknownProviderError ||
      (err instanceof GatewayModelServingRefusedError && err.status === 404) ||
      (err instanceof GatewayModelServingRefusedError &&
        err.code === 'model_serving_unknown_provider')
    ) {
      // The gateway's channels moved since the page loaded; re-read them.
      revalidatePath('/admin/model-serving');
      return {
        ok: false,
        code:
          err instanceof ModelServingUnknownModelError ||
          (err instanceof GatewayModelServingRefusedError && err.status === 404)
            ? 'UNKNOWN_MODEL'
            : 'UNKNOWN_PROVIDER',
      };
    }
    if (
      err instanceof ModelServingUnavailableError ||
      err instanceof GatewayModelServingUnavailableError ||
      err instanceof GatewayModelServingConfigError
    ) {
      return { ok: false, code: 'UNAVAILABLE' };
    }
    console.error('[admin] model serving change failed', { model, provider }, err);
    return { ok: false, code: 'FAILED' };
  }
}
