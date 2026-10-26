import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayCapacityRefusedError } from '@/lib/gateway/capacityErrors';
import {
  gatewayCapacityClient,
  httpGatewayCapacityClient,
  resetFakeGatewayCapacity,
  usingFakeGatewayCapacity,
} from '@/lib/gateway/capacityProvider';

// THE GATEWAY CAPACITY BINDING (MOTIR-9608): the real client by default, the
// in-memory fake behind `MOTIR_E2E_FAKE_GATEWAY_CAPACITY`, and never the fake in a
// real production build.

beforeEach(() => resetFakeGatewayCapacity());

afterEach(() => vi.unstubAllEnvs());

describe('gatewayCapacityClient', () => {
  it('is the HTTP binding by default', () => {
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '');
    expect(usingFakeGatewayCapacity()).toBe(false);
    expect(gatewayCapacityClient()).toBe(httpGatewayCapacityClient);
  });

  it('is the fake with the flag set', () => {
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '1');
    expect(usingFakeGatewayCapacity()).toBe(true);
    expect(gatewayCapacityClient()).not.toBe(httpGatewayCapacityClient);
  });

  it('refuses the fake in production without the E2E harness, and arms it with one', () => {
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '1');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    expect(gatewayCapacityClient()).toBe(httpGatewayCapacityClient);
    vi.stubEnv('E2E_PROD_HARNESS', '1');
    expect(gatewayCapacityClient()).not.toBe(httpGatewayCapacityClient);
  });
});

describe('the fake', () => {
  beforeEach(() => vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '1'));

  it('seeds one entry per provider with only its enforced units set', async () => {
    const read = await gatewayCapacityClient().read();
    if (read.outcome !== 'answered') throw new Error('expected an answer');
    expect(read.entries.map((e) => e.provider).sort()).toEqual(['claude', 'deepseek', 'qwen']);
    const deepseek = read.entries.find((e) => e.provider === 'deepseek')!;
    expect(deepseek.limits.max_concurrency.status).toBe('set');
    expect(deepseek.limits.rpm).toEqual({ status: 'not_applicable' });
    expect(deepseek.lanes.agent?.inFlight).toBeGreaterThan(0);
  });

  it('returns an accepted edit on its next read', async () => {
    const client = gatewayCapacityClient();
    const row = await client.write('qwen', 'qwen-example-1', {
      tpm: 1_200_000,
      tierNote: 'Tier 3',
    });
    expect(row.limits.tpm).toEqual({ status: 'set', value: 1_200_000 });
    const read = await client.read();
    if (read.outcome !== 'answered') throw new Error('expected an answer');
    const qwen = read.entries.find((e) => e.model === 'qwen-example-1')!;
    expect(qwen.limits.tpm).toEqual({ status: 'set', value: 1_200_000 });
    expect(qwen.tierNote).toBe('Tier 3');
  });

  it('refuses a negative limit with capacity_invalid_value / rpm and keeps the old value', async () => {
    const client = gatewayCapacityClient();
    const err = await client.write('qwen', 'qwen-example-1', { rpm: -1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayCapacityRefusedError);
    expect(err).toMatchObject({ code: 'capacity_invalid_value', field: 'rpm' });
    const read = await client.read();
    if (read.outcome !== 'answered') throw new Error('expected an answer');
    expect(read.entries.find((e) => e.model === 'qwen-example-1')!.limits.rpm).toEqual({
      status: 'set',
      value: 600,
    });
  });

  it('refuses a share outside 0–100 and an unknown model', async () => {
    const client = gatewayCapacityClient();
    await expect(
      client.write('qwen', 'qwen-example-1', { planningSharePercent: 101 }),
    ).rejects.toMatchObject({ code: 'capacity_invalid_value', field: 'planning_share_percent' });
    await expect(client.write('qwen', 'nope', { rpm: 1 })).rejects.toMatchObject({
      code: 'capacity_unknown_model',
    });
  });

  it('reads the counter store unavailable, with null lanes, in the unavailable mode', async () => {
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', 'unavailable');
    const read = await gatewayCapacityClient().read();
    if (read.outcome !== 'answered') throw new Error('expected an answer');
    expect(read.counterStore.state).toBe('unavailable');
    for (const entry of read.entries) {
      expect(entry.lanes).toEqual({ planning: null, agent: null });
      expect(entry.limits).toBeDefined();
    }
  });
});
