import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapacityEntry, CapacityRead } from '@/lib/gateway/capacityClient';
import type { GatewayCapacityClient } from '@/lib/gateway/capacityProvider';
import {
  __resetAgentRunCapacityForTests,
  agentRunCapacityService,
  createAgentRunCapacityService,
} from '@/lib/services/agentRunCapacityService';
import { entry, lane, set } from './capacityFixtures';

// THE AGENT-RUN CAPACITY SERVICE (MOTIR-9627) over a stub capacity client (the
// gateway read is the seam — the client's own HTTP is MOTIR-9608's to test).
// Pinned: one read per cache window shared by every caller; fail-open with one
// warning per window and never a secret; the provider map; the 429 window under
// fake timers; the two env settings; and verdicts that carry no number.

const SENTINEL = 'sentinel-capacity-token-9627';
const OPUS = { id: 'claude-opus-5-5', provider: 'anthropic' };
const QWEN = { id: 'qwen3-coder', provider: 'qwen' };
const GLM = { id: 'glm-5', provider: 'z-ai' };

function answered(entries: CapacityEntry[], store: 'live' | 'unavailable' = 'live'): CapacityRead {
  return {
    outcome: 'answered',
    readAt: new Date(),
    counterStore: { state: store, scope: 'shared' },
    entries,
  };
}

/** A stub client whose read answers whatever `next` holds, counting calls. */
function stub(initial: CapacityRead) {
  const state = { next: initial, calls: 0 };
  const client: GatewayCapacityClient & { token: string } = {
    token: SENTINEL,
    read: async () => {
      state.calls += 1;
      return state.next;
    },
    write: async () => {
      throw new Error(`not used (${SENTINEL})`);
    },
  };
  return { state, service: createAgentRunCapacityService(() => client) };
}

const FULL_OPUS = entry({
  model: 'claude-opus-5-5',
  limits: { max_concurrency: set(1) },
  agent: lane({ inFlight: 1 }),
});

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  __resetAgentRunCapacityForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  warn.mockRestore();
});

function loggedText(): string {
  return warn.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}

describe('matching a model to its entry', () => {
  it('maps anthropic to claude and matches the bare id', async () => {
    const { service } = stub(answered([FULL_OPUS]));
    expect(await service.verdictFor(OPUS)).toEqual({
      verdict: 'no_capacity',
      reason: 'agent_share_exhausted',
    });
  });

  it('a provider outside the map, or a model with no row, is available', async () => {
    const { service } = stub(answered([FULL_OPUS]));
    expect(await service.verdictFor(GLM)).toEqual({ verdict: 'available' });
    expect(await service.verdictFor({ id: 'claude-fable-5-1', provider: 'anthropic' })).toEqual({
      verdict: 'available',
    });
    // Same id under another provider is not the claude row.
    expect(await service.verdictFor({ id: 'claude-opus-5-5', provider: 'qwen' })).toEqual({
      verdict: 'available',
    });
  });

  it('verdictsFor keys every model by its bare id, from one read', async () => {
    const { service, state } = stub(answered([FULL_OPUS]));
    const map = await service.verdictsFor([OPUS, QWEN, GLM]);
    expect([...map.keys()]).toEqual(['claude-opus-5-5', 'qwen3-coder', 'glm-5']);
    expect(map.get('claude-opus-5-5')?.verdict).toBe('no_capacity');
    expect(map.get('qwen3-coder')).toEqual({ verdict: 'available' });
    expect(state.calls).toBe(1);
  });

  it('a null agent lane reads available for that model only, with no warning', async () => {
    const blind = entry({
      provider: 'qwen',
      model: 'qwen3-coder',
      planningSharePercent: 100,
      limits: { rpm: set(5) },
      agent: null,
    });
    const { service } = stub(answered([FULL_OPUS, blind]));
    const map = await service.verdictsFor([OPUS, QWEN]);
    expect(map.get('qwen3-coder')).toEqual({ verdict: 'available' });
    expect(map.get('claude-opus-5-5')?.verdict).toBe('no_capacity');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('fail open', () => {
  const REASONS = [
    'not_configured',
    'auth_refused',
    'timeout',
    'network',
    'server_error',
    'config_unavailable',
    'bad_response',
  ] as const;

  it.each(REASONS)(
    'an unavailable read (%s) makes every model available, warning once a window',
    async (reason) => {
      const { service } = stub({ outcome: 'unavailable', reason });
      const map = await service.verdictsFor([OPUS, QWEN, GLM]);
      for (const v of map.values()) expect(v).toEqual({ verdict: 'available' });
      await service.verdictFor(OPUS);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(loggedText()).toBe(`agent-run capacity read unavailable: ${reason}`);
      vi.advanceTimersByTime(5_000);
      await service.verdictFor(OPUS);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(loggedText()).not.toContain(SENTINEL);
    },
  );

  it('a down counter store makes every model available, warning once a window', async () => {
    const { service } = stub(answered([FULL_OPUS], 'unavailable'));
    expect(await service.verdictFor(OPUS)).toEqual({ verdict: 'available' });
    await service.verdictsFor([OPUS, QWEN]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(loggedText()).toBe('agent-run capacity read unavailable: counter store unavailable');
    expect(loggedText()).not.toContain(SENTINEL);
  });
});

describe('the cache', () => {
  it('twenty concurrent callers across models make one read; after the window, one more', async () => {
    const { service, state } = stub(answered([FULL_OPUS]));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 ? service.verdictFor(i % 4 === 1 ? OPUS : QWEN) : service.verdictsFor([OPUS, GLM]),
      ),
    );
    expect(state.calls).toBe(1);
    vi.advanceTimersByTime(4_999);
    await service.verdictFor(OPUS);
    expect(state.calls).toBe(1);
    vi.advanceTimersByTime(1);
    await service.verdictFor(OPUS);
    expect(state.calls).toBe(2);
  });

  it('caches an unavailable read for the window too', async () => {
    const { service, state } = stub({ outcome: 'unavailable', reason: 'timeout' });
    await service.verdictFor(OPUS);
    await service.verdictFor(QWEN);
    expect(state.calls).toBe(1);
  });

  it('honours MOTIR_AGENT_CAPACITY_CACHE_MS', async () => {
    vi.stubEnv('MOTIR_AGENT_CAPACITY_CACHE_MS', '1000');
    const { service, state } = stub(answered([]));
    await service.verdictFor(OPUS);
    vi.advanceTimersByTime(1_000);
    await service.verdictFor(OPUS);
    expect(state.calls).toBe(2);
  });

  it.each(['abc', '-5', '1.5'])(
    'a bad cache setting (%s) uses 5000 and warns once',
    async (raw) => {
      vi.stubEnv('MOTIR_AGENT_CAPACITY_CACHE_MS', raw);
      const { service, state } = stub(answered([]));
      await service.verdictFor(OPUS);
      vi.advanceTimersByTime(4_999);
      await service.verdictFor(OPUS);
      expect(state.calls).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(loggedText()).toContain('MOTIR_AGENT_CAPACITY_CACHE_MS');
    },
  );
});

describe('the 429 window', () => {
  const limited = (minute: number) =>
    answered([
      entry({ model: 'claude-opus-5-5', agent: lane({ rateLimited429: { minute, day: minute } }) }),
    ]);

  it('holds the model until the window has passed since a 429 was last seen', async () => {
    const { service, state } = stub(limited(2));
    expect(await service.verdictFor(OPUS)).toEqual({
      verdict: 'no_capacity',
      reason: 'provider_rate_limited',
    });
    state.next = limited(0);
    vi.advanceTimersByTime(5_000);
    expect((await service.verdictFor(OPUS)).verdict).toBe('no_capacity');
    vi.advanceTimersByTime(54_999);
    expect((await service.verdictFor(OPUS)).verdict).toBe('no_capacity');
    vi.advanceTimersByTime(1);
    expect(await service.verdictFor(OPUS)).toEqual({ verdict: 'available' });
  });

  it('honours MOTIR_AGENT_CAPACITY_429_WINDOW_MS', async () => {
    vi.stubEnv('MOTIR_AGENT_CAPACITY_429_WINDOW_MS', '10000');
    const { service, state } = stub(limited(1));
    await service.verdictFor(OPUS);
    state.next = limited(0);
    vi.advanceTimersByTime(10_000);
    expect(await service.verdictFor(OPUS)).toEqual({ verdict: 'available' });
  });

  it('a bad window setting uses 60000 and warns once', async () => {
    vi.stubEnv('MOTIR_AGENT_CAPACITY_429_WINDOW_MS', 'soon');
    const { service, state } = stub(limited(1));
    await service.verdictFor(OPUS);
    state.next = limited(0);
    vi.advanceTimersByTime(59_999);
    expect((await service.verdictFor(OPUS)).verdict).toBe('no_capacity');
    vi.advanceTimersByTime(1);
    expect((await service.verdictFor(OPUS)).verdict).toBe('available');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(loggedText()).toContain('MOTIR_AGENT_CAPACITY_429_WINDOW_MS');
  });
});

describe('the shape of a verdict', () => {
  it('carries only verdict and reason', async () => {
    const { service } = stub(answered([FULL_OPUS]));
    const map = await service.verdictsFor([OPUS, QWEN]);
    expect(Object.keys(map.get('claude-opus-5-5')!).sort()).toEqual(['reason', 'verdict']);
    expect(Object.keys(map.get('qwen3-coder')!)).toEqual(['verdict']);
  });

  it('the module exports a service bound to the real binding', () => {
    expect(typeof agentRunCapacityService.verdictFor).toBe('function');
    expect(typeof agentRunCapacityService.verdictsFor).toBe('function');
  });
});
