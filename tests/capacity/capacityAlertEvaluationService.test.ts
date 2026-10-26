import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import {
  UNKNOWN,
  NA,
  answered,
  concurrency,
  entry,
  lane,
  set,
} from '../fixtures/capacityReadFixtures';

// THE CAPACITY ALERT EVALUATION (Story MOTIR-9539 · MOTIR-9611) against a real
// Postgres: the raised-alert rows are real; the read is handed in (the doors'
// path) and Sentry is the stubbed seam.

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

const { capacityAlertEvaluationService: service } =
  await import('@/lib/services/capacityAlertEvaluationService');

const qwenRpm = (rpm: number, limit = 600) =>
  entry(
    'qwen',
    'qwen-example-1',
    { rpm: set(limit), tpm: set(800_000) },
    {
      planning: lane({ requestsPerMinute: Math.floor(rpm / 2) }),
      agent: lane({ requestsPerMinute: rpm - Math.floor(rpm / 2) }),
    },
  );

async function rows() {
  return adminDb.capacityRaisedAlert.findMany({ orderBy: { limitUnit: 'asc' } });
}

beforeEach(async () => {
  await adminDb.capacityRaisedAlert.deleteMany();
  await adminDb.capacityAlertSetting.deleteMany();
  captureException.mockReset();
});

afterAll(async () => {
  await adminDb.capacityRaisedAlert.deleteMany();
  await db.$disconnect();
});

describe('raise once', () => {
  it('a limit over the share raises and sends exactly one fingerprinted alert', async () => {
    const result = await service.evaluate({ read: answered([concurrency(84, 100)]) });
    expect(result.outcome).toBe('evaluated');
    expect(result.raised).toHaveLength(1);
    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, context] = captureException.mock.calls[0] as [Error, Record<string, unknown>];
    expect(context['fingerprint']).toEqual([
      'capacity-limit-share',
      'deepseek',
      'deepseek-example-1',
      'max_concurrency',
    ]);
    expect(error.message).toBe(
      'deepseek / deepseek-example-1: concurrency is at 84% of its limit (alert share 80%)',
    );

    const before = await rows();
    await service.evaluate({ read: answered([concurrency(84, 100)]) });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual(before);
  });

  it('two concurrent evaluations of one over-share read send one alert', async () => {
    const read = answered([concurrency(90, 100)]);
    await Promise.all([service.evaluate({ read }), service.evaluate({ read })]);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
  });

  it('uses the stored alert share', async () => {
    await adminDb.capacityAlertSetting.create({ data: { id: 'platform', alertSharePercent: 90 } });
    await service.evaluate({ read: answered([concurrency(84, 100)]) });
    expect(captureException).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });
});

describe('clear below the share', () => {
  it('clears, sends nothing, and a later rise alerts again', async () => {
    await service.evaluate({ read: answered([concurrency(85)]) });
    captureException.mockReset();
    await service.evaluate({ read: answered([concurrency(40)]) });
    expect(await rows()).toHaveLength(0);
    expect(captureException).not.toHaveBeenCalled();
    await service.evaluate({ read: answered([concurrency(95)]) });
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('a raised rpm stays raised under the share at second 10 and clears at second 40', async () => {
    await service.evaluate({ read: answered([qwenRpm(500)], { second: 45 }) });
    expect(await rows()).toHaveLength(1);
    await service.evaluate({ read: answered([qwenRpm(100)], { second: 10 }) });
    expect(await rows()).toHaveLength(1);
    await service.evaluate({ read: answered([qwenRpm(100)], { second: 40 }) });
    expect(await rows()).toHaveLength(0);
  });

  it('a raised concurrency or tpd alert clears at any second', async () => {
    await service.evaluate({ read: answered([concurrency(90)], { second: 45 }) });
    await service.evaluate({ read: answered([concurrency(10)], { second: 5 }) });
    expect(await rows()).toHaveLength(0);
  });
});

describe('never raised', () => {
  it('input and output tokens per minute never raise, whatever their limit', async () => {
    const claude = entry(
      'claude',
      'claude-example-1',
      { rpm: set(1000), input_tpm: set(1), output_tpm: set(0) },
      { planning: lane({ tokensPerMinute: 900_000 }), agent: lane({ tokensPerMinute: 900_000 }) },
    );
    await service.evaluate({ read: answered([claude]) });
    expect(await rows()).toHaveLength(0);
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('a partial or failed read changes nothing', () => {
  beforeEach(async () => {
    await service.evaluate({ read: answered([concurrency(90)]) });
    captureException.mockReset();
  });

  it('an unavailable read neither raises nor clears, and returns the raised list', async () => {
    const result = await service.evaluate({ read: { outcome: 'unavailable', reason: 'network' } });
    expect(result).toMatchObject({ outcome: 'unavailable', reason: 'network' });
    expect(result.raised).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it('the counter store down neither raises nor clears', async () => {
    const result = await service.evaluate({
      read: answered([concurrency(10)], { store: 'unavailable' }),
    });
    expect(result).toMatchObject({ outcome: 'unavailable', reason: 'counter_store_unavailable' });
    expect(await rows()).toHaveLength(1);
  });

  it('a slow entry (lanes null) stays raised', async () => {
    const slow = entry(
      'deepseek',
      'deepseek-example-1',
      { max_concurrency: set(100) },
      { planning: null, agent: null },
    );
    await service.evaluate({ read: answered([slow]) });
    expect(await rows()).toHaveLength(1);
  });
});

describe('an alert never outlives its number', () => {
  beforeEach(async () => {
    await service.evaluate({ read: answered([concurrency(90)]) });
  });

  it.each([
    ['unknown', UNKNOWN],
    ['not applicable', NA],
  ])('a raised limit that becomes %s is cleared', async (_label, limit) => {
    const changed = entry(
      'deepseek',
      'deepseek-example-1',
      { max_concurrency: limit },
      { planning: lane({ inFlight: 90 }), agent: lane() },
    );
    await service.evaluate({ read: answered([changed]) });
    expect(await rows()).toHaveLength(0);
  });

  it('a raised limit whose entry is gone from the read is cleared', async () => {
    await service.evaluate({ read: answered([qwenRpm(10)]) });
    expect(await rows()).toHaveLength(0);
  });
});

describe('robustness and privacy', () => {
  it('a throwing Sentry does not stop the evaluation, and the alert stays raised', async () => {
    captureException.mockImplementation(() => {
      throw new Error('sentry down');
    });
    const result = await service.evaluate({ read: answered([concurrency(90)]) });
    expect(result.outcome).toBe('evaluated');
    expect(await rows()).toHaveLength(1);
  });

  it('the alert tags and the result carry only provider, model and limit', async () => {
    const result = await service.evaluate({ read: answered([concurrency(90)]) });
    const [, context] = captureException.mock.calls[0] as [Error, { tags: Record<string, string> }];
    expect(Object.keys(context.tags).sort()).toEqual([
      'capacity_limit',
      'capacity_model',
      'capacity_provider',
      'capacity_share',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/userId|organizationId|workspaceId|token/i);
  });

  it('reads the gateway through the binding when no read is handed in', async () => {
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '1');
    const result = await service.evaluate();
    expect(result.outcome).toBe('evaluated');
    vi.unstubAllEnvs();
  });
});
