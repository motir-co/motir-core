import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GatewayModelServingConfigError,
  GatewayModelServingRefusedError,
  GatewayModelServingUnavailableError,
} from '@/lib/gateway/modelServingClient';
import {
  ModelServingUnavailableError,
  ModelServingUnknownModelError,
  ModelServingUnknownProviderError,
  NotPlatformStaffError,
} from '@/lib/platform/errors';

// THE MODEL SERVING ACTION (MOTIR-11280): transport only. Every typed refusal is
// a result code the dialog maps to its copy; the gate is asserted here and again
// in the service.

const requirePlatformStaff = vi.hoisted(() => vi.fn());
vi.mock('@/lib/platform/auth', () => ({ requirePlatformStaff }));
const setServing = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/platformModelServingService', () => ({
  platformModelServingService: { setServing },
}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath }));

const { setModelServingAction } = await import('@/app/(admin)/admin/model-serving/actions');
const PRINCIPAL = { userId: 'u', email: 'root@motir.co', role: 'superadmin' };

afterEach(() => vi.clearAllMocks());

describe('setModelServingAction', () => {
  it('gates at superadmin, saves, re-reads the page and answers who serves it', async () => {
    requirePlatformStaff.mockResolvedValueOnce(PRINCIPAL);
    setServing.mockResolvedValueOnce({ effective: 'qwen' });
    expect(await setModelServingAction('glm-5.3', 'qwen')).toEqual({ ok: true, servedBy: 'qwen' });
    expect(requirePlatformStaff).toHaveBeenCalledWith('superadmin');
    expect(setServing).toHaveBeenCalledWith(PRINCIPAL, 'glm-5.3', 'qwen');
    expect(revalidatePath).toHaveBeenCalledWith('/admin/model-serving');
  });

  it.each([
    ['not staff', new NotPlatformStaffError(), 'NOT_PERMITTED', false],
    ['an unknown model', new ModelServingUnknownModelError('x'), 'UNKNOWN_MODEL', true],
    [
      'an unknown provider',
      new ModelServingUnknownProviderError('glm-5.3', 'openai', ['z-ai']),
      'UNKNOWN_PROVIDER',
      true,
    ],
    [
      "the gateway's unknown model",
      new GatewayModelServingRefusedError(404, 'model_serving_unknown_model', null, []),
      'UNKNOWN_MODEL',
      true,
    ],
    [
      "the gateway's unknown provider",
      new GatewayModelServingRefusedError(400, 'model_serving_unknown_provider', 'provider', [
        'z-ai',
      ]),
      'UNKNOWN_PROVIDER',
      true,
    ],
    ['an unreadable gateway', new ModelServingUnavailableError('network'), 'UNAVAILABLE', false],
    [
      'a write with no answer',
      new GatewayModelServingUnavailableError('down'),
      'UNAVAILABLE',
      false,
    ],
    ['a missing token', new GatewayModelServingConfigError('unset'), 'UNAVAILABLE', false],
  ])('answers %s as %s', async (_name, err, code, rereads) => {
    requirePlatformStaff.mockResolvedValueOnce(PRINCIPAL);
    setServing.mockRejectedValueOnce(err);
    expect(await setModelServingAction('glm-5.3', 'qwen')).toEqual({ ok: false, code });
    expect(revalidatePath).toHaveBeenCalledTimes(rereads ? 1 : 0);
  });

  it('answers anything else as FAILED, and logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    requirePlatformStaff.mockResolvedValueOnce(PRINCIPAL);
    setServing.mockRejectedValueOnce(
      new GatewayModelServingRefusedError(500, 'model_serving_store_error', null, []),
    );
    expect(await setModelServingAction('glm-5.3', null)).toEqual({ ok: false, code: 'FAILED' });
    expect(log).toHaveBeenCalled();
  });
});
