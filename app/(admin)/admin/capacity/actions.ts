'use server';

import { revalidatePath } from 'next/cache';
import {
  CapacityAlertShareInvalidError,
  CapacityAlertShareUnchangedError,
  CapacityLimitEditInvalidError,
} from '@/lib/capacity/errors';
import type {
  PlatformCapacityAlertShareDTO,
  PlatformCapacityEditInput,
  PlatformCapacityStoredEntryDTO,
} from '@/lib/dto/platformCapacity';
import {
  GatewayCapacityConfigError,
  GatewayCapacityRefusedError,
  GatewayCapacityUnavailableError,
  type GatewayCapacityErrorCode,
} from '@/lib/gateway/capacityErrors';
import { requirePlatformStaff } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { platformCapacityService } from '@/lib/services/platformCapacityService';

/**
 * The CAPACITY screen's writes — Story MOTIR-9539 · MOTIR-9613.
 *
 * Transport only, the `ai-planning/actions.ts` shape: resolve the platform
 * principal, call ONE service method, translate the typed errors into a closed
 * result the screen maps to its copy. Validation, the audit row and its order
 * live in `platformCapacityService`.
 *
 * ⚠️ THE GATE IS ASSERTED HERE AND AGAIN IN THE SERVICE. A Server Action is a
 * POST the `(admin)` layout never renders, so it resolves the principal itself.
 *
 * ⚠️ A RESULT, NOT A THROW: a thrown error reaches the browser as a stripped
 * digest in production. `field` is the gateway's snake_case key at fault, for
 * core's refusals and the gateway's alike.
 */

const CAPACITY_PATH = '/admin/capacity';

export type CapacityLimitsActionResult =
  | { ok: true; entry: PlatformCapacityStoredEntryDTO }
  | { ok: false; code: 'INVALID_VALUE' | 'INVALID_BODY'; field?: string }
  | {
      ok: false;
      code:
        | 'EMPTY_EDIT'
        | 'UNKNOWN_PROVIDER'
        | 'UNKNOWN_MODEL'
        | 'STORE_ERROR'
        | 'CREDENTIAL'
        | 'UNAVAILABLE'
        | 'NOT_PERMITTED'
        | 'FAILED';
    };

type Refusal = Exclude<CapacityLimitsActionResult, { ok: true }>;

const GATEWAY_CODES: Partial<Record<GatewayCapacityErrorCode, Refusal['code']>> = {
  capacity_auth_missing: 'CREDENTIAL',
  capacity_auth_invalid: 'CREDENTIAL',
  capacity_auth_forbidden: 'CREDENTIAL',
  capacity_config_unavailable: 'UNAVAILABLE',
  capacity_unknown_provider: 'UNKNOWN_PROVIDER',
  capacity_unknown_model: 'UNKNOWN_MODEL',
  capacity_invalid_body: 'INVALID_BODY',
  capacity_empty_edit: 'EMPTY_EDIT',
  capacity_invalid_value: 'INVALID_VALUE',
  capacity_store_error: 'STORE_ERROR',
};

function refusal(code: Refusal['code'], field: string | null): Refusal {
  if ((code === 'INVALID_VALUE' || code === 'INVALID_BODY') && field) {
    return { ok: false, code, field };
  }
  return { ok: false, code } as Refusal;
}

function toLimitsRefusal(err: unknown): Refusal | null {
  if (err instanceof CapacityLimitEditInvalidError || err instanceof GatewayCapacityRefusedError) {
    const code = GATEWAY_CODES[err.code];
    return code ? refusal(code, err.field) : null;
  }
  if (err instanceof GatewayCapacityConfigError) return { ok: false, code: 'CREDENTIAL' };
  if (err instanceof GatewayCapacityUnavailableError) return { ok: false, code: 'UNAVAILABLE' };
  if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
  return null;
}

export async function editCapacityLimitsAction(
  provider: string,
  model: string,
  edit: PlatformCapacityEditInput,
): Promise<CapacityLimitsActionResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    const entry = await platformCapacityService.editLimits(principal, provider, model, edit);
    // The entries are server-rendered props: the re-read shows the new values.
    revalidatePath(CAPACITY_PATH);
    return { ok: true, entry };
  } catch (err) {
    const known = toLimitsRefusal(err);
    if (known) return known;
    console.error('[admin] capacity limits action failed', { provider, model }, err);
    return { ok: false, code: 'FAILED' };
  }
}

export type CapacityAlertShareActionResult =
  | { ok: true; alertShare: PlatformCapacityAlertShareDTO }
  | { ok: false; code: 'INVALID_VALUE' | 'UNCHANGED' | 'NOT_PERMITTED' | 'FAILED' };

export async function setCapacityAlertShareAction(
  percent: number,
): Promise<CapacityAlertShareActionResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    const alertShare = await platformCapacityService.setAlertShare(principal, percent);
    revalidatePath(CAPACITY_PATH);
    return { ok: true, alertShare };
  } catch (err) {
    if (err instanceof CapacityAlertShareInvalidError) return { ok: false, code: 'INVALID_VALUE' };
    if (err instanceof CapacityAlertShareUnchangedError) return { ok: false, code: 'UNCHANGED' };
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    console.error('[admin] capacity alert share action failed', err);
    return { ok: false, code: 'FAILED' };
  }
}
