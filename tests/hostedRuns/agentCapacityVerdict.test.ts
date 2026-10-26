import { describe, expect, it } from 'vitest';
import { agentShareOf, computeAgentCapacityVerdict } from '@/lib/hostedRuns/agentCapacityVerdict';
import { AGENT_CAPACITY_REASONS, AGENT_SHARE_EXHAUSTED } from '@/lib/hostedRuns/capacityReasons';
import { entry, lane, set } from './capacityFixtures';

// THE AGENT-RUN CAPACITY RULE (MOTIR-9627) — pure, table-driven. Pinned: the
// agent share is the limit minus the gateway's rounded-up planning share; only
// a SET limit on a compared unit governs (no number is never 0); 429s on either
// lane hold the model, and keep holding it through the window; the verdict
// carries no number.

const NOW = 1_000_000;
const WINDOW = 60_000;

function verdict(e: ReturnType<typeof entry>, since: number | null = null) {
  return computeAgentCapacityVerdict(e, since, NOW, WINDOW);
}

const FULL = { verdict: 'no_capacity', reason: 'agent_share_exhausted' };
const LIMITED = { verdict: 'no_capacity', reason: 'provider_rate_limited' };
const OK = { verdict: 'available' };

describe('the reason vocabulary', () => {
  it('is exactly the two codes, the first being the gateway ReasonAgentShareExhausted value', () => {
    expect(AGENT_CAPACITY_REASONS).toEqual(['agent_share_exhausted', 'provider_rate_limited']);
    expect(AGENT_SHARE_EXHAUSTED).toBe('agent_share_exhausted');
  });
});

describe('rule 1 — the agent share', () => {
  it('rounds the planning share up, as the gateway admission does', () => {
    expect(agentShareOf(4, 25)).toBe(3);
    expect(agentShareOf(600, 40)).toBe(360);
    expect(agentShareOf(800_000, 40)).toBe(480_000);
    expect(agentShareOf(3, 50)).toBe(1);
    expect(agentShareOf(10, 0)).toBe(10);
    expect(agentShareOf(10, 100)).toBe(0);
  });

  it('deepseek max_concurrency 4 at planning 25: full at 3 in flight, available at 2', () => {
    const at = (inFlight: number) =>
      entry({
        provider: 'deepseek',
        model: 'deepseek-v4',
        planningSharePercent: 25,
        limits: { max_concurrency: set(4) },
        agent: lane({ inFlight }),
      });
    expect(verdict(at(3))).toEqual(FULL);
    expect(verdict(at(2))).toEqual(OK);
  });

  it('qwen rpm 600 / tpm 800000 at planning 40: full when tokens reach the share alone', () => {
    const at = (tokensPerMinute: number) =>
      entry({
        provider: 'qwen',
        model: 'qwen3-coder',
        planningSharePercent: 40,
        limits: { rpm: set(600), tpm: set(800_000) },
        agent: lane({ requestsPerMinute: 10, tokensPerMinute }),
      });
    expect(verdict(at(480_000))).toEqual(FULL);
    expect(verdict(at(479_999))).toEqual(OK);
  });

  it('compares tpd against tokensPerDay', () => {
    const e = entry({ limits: { tpd: set(1000) }, agent: lane({ tokensPerDay: 1000 }) });
    expect(verdict(e)).toEqual(FULL);
  });

  it('a planning share of 100 fills every compared unit, even with nothing used', () => {
    for (const unit of ['max_concurrency', 'rpm', 'tpm', 'tpd'] as const) {
      const e = entry({ planningSharePercent: 100, limits: { [unit]: set(50) } });
      expect(verdict(e)).toEqual(FULL);
    }
  });

  it('a planning share of 100 leaves an entry with only input_tpm / output_tpm available', () => {
    const e = entry({
      planningSharePercent: 100,
      limits: { input_tpm: set(10), output_tpm: set(10) },
    });
    expect(verdict(e)).toEqual(OK);
  });

  it('a planning share of 0 leaves the whole limit to the agent lane', () => {
    const at = (inFlight: number) =>
      entry({ limits: { max_concurrency: set(5) }, agent: lane({ inFlight }) });
    expect(verdict(at(4))).toEqual(OK);
    expect(verdict(at(5))).toEqual(FULL);
  });
});

describe('rule 3 — no number means available', () => {
  it('an unknown or not_applicable limit is never read as 0', () => {
    for (const limit of [{ status: 'unknown' }, { status: 'not_applicable' }] as const) {
      const e = entry({
        planningSharePercent: 100,
        limits: { max_concurrency: limit, rpm: limit, tpm: limit, tpd: limit },
        agent: lane({ inFlight: 99, requestsPerMinute: 99, tokensPerMinute: 99 }),
      });
      expect(verdict(e)).toEqual(OK);
    }
  });

  it('a claude entry over only input_tpm / output_tpm is available, while rpm is still compared', () => {
    const at = (requestsPerMinute: number) =>
      entry({
        limits: { input_tpm: set(100), output_tpm: set(100), rpm: set(50) },
        agent: lane({ tokensPerMinute: 10_000, requestsPerMinute }),
      });
    expect(verdict(at(10))).toEqual(OK);
    expect(verdict(at(50))).toEqual(FULL);
  });

  it('a null agent lane governs nothing', () => {
    const e = entry({ planningSharePercent: 100, limits: { rpm: set(5) }, agent: null });
    expect(verdict(e)).toEqual(OK);
  });
});

describe('rule 2 — provider 429s', () => {
  it('a non-zero minute count on either lane holds the model', () => {
    const agent = entry({ agent: lane({ rateLimited429: { minute: 1, day: 1 } }) });
    const planning = entry({ planning: lane({ rateLimited429: { minute: 2, day: 2 } }) });
    expect(verdict(agent)).toEqual(LIMITED);
    expect(verdict(planning)).toEqual(LIMITED);
  });

  it('counts only lanes that were read', () => {
    const e = entry({ agent: null, planning: lane({ rateLimited429: { minute: 1, day: 1 } }) });
    expect(verdict(e)).toEqual(LIMITED);
    expect(verdict(entry({ agent: null, planning: null }))).toEqual(OK);
  });

  it('keeps holding through the window after the count returns to 0', () => {
    const quiet = entry({});
    expect(verdict(quiet, NOW - WINDOW + 1)).toEqual(LIMITED);
    expect(verdict(quiet, NOW - WINDOW)).toEqual(OK);
    expect(verdict(quiet, null)).toEqual(OK);
  });

  it('the share reason wins when both hold', () => {
    const e = entry({
      limits: { max_concurrency: set(1) },
      agent: lane({ inFlight: 1, rateLimited429: { minute: 3, day: 3 } }),
    });
    expect(verdict(e)).toEqual(FULL);
  });
});

describe('the verdict carries no number', () => {
  it('has only verdict, and reason when held', () => {
    expect(Object.keys(verdict(entry({})))).toEqual(['verdict']);
    const held = verdict(entry({ limits: { rpm: set(1) }, agent: lane({ requestsPerMinute: 1 }) }));
    expect(Object.keys(held).sort()).toEqual(['reason', 'verdict']);
  });
});
