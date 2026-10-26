import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { resetFakeGatewayCapacity, gatewayCapacityClient } from '@/lib/gateway/capacityProvider';
import { adminDb } from '../helpers/adminDb';

// ONE PASS OF THE CAPACITY ALERT JOB (Story MOTIR-9539 · MOTIR-9612) against a
// real Postgres, the gateway through the in-memory fake binding, Sentry stubbed:
// raise once, clear below, silent when unconfigured, and never a throw.

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

const { capacityAlertJobService: job } = await import('@/lib/services/capacityAlertJobService');
const { capacityAlertEvaluationService } =
  await import('@/lib/services/capacityAlertEvaluationService');

const SENTINEL = 'sentinel-capacity-token-9612';

// The fake seeds deepseek with 7 in flight (2 planning + 5 agent); a limit of 8
// puts it at 87.5% of its limit, over the default 80% share.
const overShare = () =>
  gatewayCapacityClient().write('deepseek', 'deepseek-example-1', { maxConcurrency: 8 });
const underShare = () =>
  gatewayCapacityClient().write('deepseek', 'deepseek-example-1', { maxConcurrency: 500 });

const fingerprints = () =>
  captureException.mock.calls.map(
    ([, context]) => (context as { fingerprint: string[] }).fingerprint,
  );

beforeEach(async () => {
  await adminDb.capacityRaisedAlert.deleteMany();
  await adminDb.capacityAlertSetting.deleteMany();
  resetFakeGatewayCapacity();
  captureException.mockReset();
  vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '1');
  vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', SENTINEL);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await adminDb.capacityRaisedAlert.deleteMany();
  await db.$disconnect();
});

describe('a pass over the fake gateway', () => {
  it('raises an over-share limit once and alerts once; the next pass sends nothing', async () => {
    await overShare();
    const first = await job.run();
    expect(first).toMatchObject({ outcome: 'evaluated', overShareCount: 1, raisedCount: 1 });
    expect(fingerprints()).toEqual([
      ['capacity-limit-share', 'deepseek', 'deepseek-example-1', 'max_concurrency'],
    ]);
    const second = await job.run();
    expect(second).toMatchObject({ outcome: 'evaluated', raisedCount: 1 });
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('clears the raised row once usage is back under the share, and sends nothing', async () => {
    await overShare();
    await job.run();
    captureException.mockReset();
    await underShare();
    const result = await job.run();
    expect(result).toMatchObject({ outcome: 'evaluated', overShareCount: 0, raisedCount: 0 });
    expect(await adminDb.capacityRaisedAlert.count()).toBe(0);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('a counter store marked unavailable sends no job-level event', async () => {
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', 'unavailable');
    const result = await job.run();
    expect(result).toMatchObject({ outcome: 'unavailable', reason: 'counter_store_unavailable' });
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('an unavailable read', () => {
  it('with no token configured is a silent not_configured pass', async () => {
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '');
    vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', '');
    expect(await job.run()).toMatchObject({ outcome: 'unavailable', reason: 'not_configured' });
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each(['auth_refused', 'bad_response'] as const)(
    '%s sends exactly one fingerprinted warning',
    async (reason) => {
      vi.spyOn(capacityAlertEvaluationService, 'evaluate').mockResolvedValue({
        outcome: 'unavailable',
        reason,
        raised: [],
      });
      expect(await job.run()).toMatchObject({ outcome: 'unavailable', reason });
      expect(fingerprints()).toEqual([['capacity-alert-job', reason]]);
      expect(captureException.mock.calls[0]![1]).toMatchObject({ level: 'warning' });
    },
  );

  it.each(['timeout', 'network', 'server_error', 'config_unavailable'] as const)(
    '%s is transient and sends nothing',
    async (reason) => {
      vi.spyOn(capacityAlertEvaluationService, 'evaluate').mockResolvedValue({
        outcome: 'unavailable',
        reason,
        raised: [],
      });
      expect(await job.run()).toMatchObject({ outcome: 'unavailable', reason });
      expect(captureException).not.toHaveBeenCalled();
    },
  );
});

describe('never throwing', () => {
  it('an evaluation that throws is one error event and a failed pass', async () => {
    vi.spyOn(capacityAlertEvaluationService, 'evaluate').mockRejectedValue(new Error('db down'));
    expect(await job.run()).toEqual({ outcome: 'failed' });
    expect(fingerprints()).toEqual([['capacity-alert-job', 'failed']]);
    expect(captureException.mock.calls[0]![1]).toMatchObject({ level: 'error' });
  });

  it('still returns when Sentry itself throws', async () => {
    vi.spyOn(capacityAlertEvaluationService, 'evaluate').mockRejectedValue(new Error('db down'));
    captureException.mockImplementation(() => {
      throw new Error('sentry down');
    });
    expect(await job.run()).toEqual({ outcome: 'failed' });
  });
});

describe('privacy', () => {
  it('no event or output carries the token or a tenant identifier', async () => {
    await overShare();
    const outputs = [await job.run()];
    vi.spyOn(capacityAlertEvaluationService, 'evaluate').mockResolvedValueOnce({
      outcome: 'unavailable',
      reason: 'auth_refused',
      raised: [],
    });
    outputs.push(await job.run());
    vi.spyOn(capacityAlertEvaluationService, 'evaluate').mockRejectedValueOnce(new Error('boom'));
    outputs.push(await job.run());
    expect(captureException).toHaveBeenCalledTimes(3);
    const written = JSON.stringify([outputs, captureException.mock.calls]);
    expect(written).not.toContain(SENTINEL);
    expect(written).not.toMatch(/userId|organizationId|workspaceId|orgId/i);
  });
});
