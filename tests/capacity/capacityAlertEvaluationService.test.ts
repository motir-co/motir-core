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

// THE GATEWAY-SATURATION SERIES (MOTIR-9675, design D6): judged from its own
// reading beside the provider limits, raised and cleared under its one key.
describe('gateway saturation', () => {
  const reading = (connectionsInUse: number | null) =>
    ({ outcome: 'answered', connectionsInUse, createdMachines: 12, hardLimit: 750 }) as const;
  const notConfigured = { outcome: 'unavailable', reason: 'not_configured' } as const;
  const read = answered([concurrency(10, 100)]);
  const saturationRows = async () => (await rows()).filter((r) => r.provider === 'gateway');

  it('raises once at 70 % with one fingerprinted alert, and does not re-alert while over', async () => {
    const result = await service.evaluate({ read, saturation: reading(6300) });
    expect(result.saturation.judgement.state).toBe('over_share');
    expect(result.saturation.raised).toMatchObject({
      observedValue: 6300,
      limitValue: 9000,
      alertSharePercent: 70,
    });
    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, context] = captureException.mock.calls[0] as [Error, Record<string, unknown>];
    expect(context['fingerprint']).toEqual(['capacity-gateway-saturation']);
    expect(error.message).toBe(
      'motir-gateway: 6300 connections in use is 70% of 9000 (created machines × hard limit; alert at 70%)',
    );
    // Not a provider alert: the provider list and the gone-entry sweep never see it.
    expect(result.raised).toEqual([]);

    await service.evaluate({ read, saturation: reading(8000) });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(await saturationRows()).toHaveLength(1);
  });

  it('is cleared by a later normal or near-limit reading', async () => {
    await service.evaluate({ read, saturation: reading(7000) });
    const near = await service.evaluate({ read, saturation: reading(6000) });
    expect(near.saturation.judgement.state).toBe('near_limit');
    expect(near.saturation.raised).toBeNull();
    expect(await saturationRows()).toHaveLength(0);

    await service.evaluate({ read, saturation: reading(7000) });
    await service.evaluate({ read, saturation: reading(700) });
    expect(await saturationRows()).toHaveLength(0);
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('an unavailable reading neither raises nor clears', async () => {
    await service.evaluate({ read, saturation: reading(7000) });
    for (const saturation of [notConfigured, reading(null)] as const) {
      const result = await service.evaluate({ read, saturation });
      expect(result.saturation.judgement.state).toBe('unavailable');
      expect(result.saturation.raised).not.toBeNull();
    }
    expect(await saturationRows()).toHaveLength(1);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('is judged even when the capacity read is unavailable, and leaves provider alerts alone', async () => {
    await service.evaluate({ read: answered([concurrency(90, 100)]), saturation: reading(100) });
    const result = await service.evaluate({
      read: { outcome: 'unavailable', reason: 'timeout' },
      saturation: reading(6500),
    });
    expect(result.outcome).toBe('unavailable');
    expect(result.saturation.judgement.state).toBe('over_share');
    expect(result.raised).toHaveLength(1);
    expect(await rows()).toHaveLength(2);
  });

  it('with the default reader, nothing is raised and the row is unavailable', async () => {
    const result = await service.evaluate({ read });
    expect(result.saturation.reading).toEqual(notConfigured);
    expect(result.saturation.judgement.state).toBe('unavailable');
    expect(await saturationRows()).toHaveLength(0);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('the store refuses a gateway provider under any other key', async () => {
    await expect(
      adminDb.capacityRaisedAlert.create({
        data: {
          provider: 'gateway',
          model: 'connections',
          limitUnit: 'rpm',
          observedValue: BigInt(1),
          limitValue: BigInt(1),
          alertSharePercent: 70,
        },
      }),
    ).rejects.toThrow();
  });
});
