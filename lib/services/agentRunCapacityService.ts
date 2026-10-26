import 'server-only';

import type { AgentModel } from '@/lib/ai/motirAiClient';
import type { CapacityEntry, CapacityRead } from '@/lib/gateway/capacityClient';
import { gatewayCapacityClient, type GatewayCapacityClient } from '@/lib/gateway/capacityProvider';
import {
  computeAgentCapacityVerdict,
  rateLimitedThisMinute,
  type AgentCapacityVerdict,
} from '@/lib/hostedRuns/agentCapacityVerdict';

// THE AGENT-RUN CAPACITY VERDICT (MOTIR-9627) — the ONE answer to "does this
// agent model have agent-run capacity right now?". The picker read and the
// launch check both call it, so they cannot disagree. The rule is pure
// (`lib/hostedRuns/agentCapacityVerdict.ts`); this service owns the I/O.
//
// ⚠️ ONE GATEWAY READ PER CACHE WINDOW. One read answers every model, so one
// process-level snapshot serves them all, concurrent callers share one in-flight
// read, and an `unavailable` read is cached for the window too — a dead gateway
// is not called once per render.
//
// ⚠️ FAIL OPEN. A read that is unavailable for any reason, or a counter store
// that is down, makes every model `available`, with one warning per cache window
// naming the reason only. The gateway's own typed 429 (MOTIR-9601) is the backstop.

export const CAPACITY_CACHE_MS_ENV_VAR = 'MOTIR_AGENT_CAPACITY_CACHE_MS';
export const CAPACITY_429_WINDOW_MS_ENV_VAR = 'MOTIR_AGENT_CAPACITY_429_WINDOW_MS';
const DEFAULT_CACHE_MS = 5_000;
const DEFAULT_429_WINDOW_MS = 60_000;

/** motir-ai's provider vocabulary → the gateway's. A provider outside it is never counted. */
const GATEWAY_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'claude',
  qwen: 'qwen',
  deepseek: 'deepseek',
});

const AVAILABLE: AgentCapacityVerdict = Object.freeze({ verdict: 'available' });

interface Snapshot {
  read: CapacityRead;
  fetchedAt: number;
}

const warnedEnv = new Set<string>();

/** A millisecond setting, read at call time; a bad value falls back with one warning. */
function readMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (/^\d+$/.test(raw)) return Number(raw);
  const key = `${name}=${raw}`;
  if (!warnedEnv.has(key)) {
    warnedEnv.add(key);
    console.warn(`${name} is not a non-negative integer; using ${fallback}`);
  }
  return fallback;
}

function entryKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** Why the read cannot be trusted, or null when its counters are live. */
function unavailableReason(read: CapacityRead): string | null {
  if (read.outcome === 'unavailable') return read.reason;
  return read.counterStore.state === 'unavailable' ? 'counter store unavailable' : null;
}

function findEntry(read: CapacityRead, model: AgentModel): CapacityEntry | null {
  const provider = GATEWAY_PROVIDER[model.provider];
  if (!provider || read.outcome !== 'answered') return null;
  return read.entries.find((e) => e.provider === provider && e.model === model.id) ?? null;
}

/** One service instance — the module exports one; tests build their own over a stub client. */
export function createAgentRunCapacityService(
  clientOf: () => GatewayCapacityClient = gatewayCapacityClient,
) {
  let snapshot: Snapshot | null = null;
  let inflight: Promise<Snapshot> | null = null;
  const rateLimitedSince = new Map<string, number>();

  /** A fresh read has landed: warn if it cannot be used, stamp every model seen 429ing. */
  function settle(read: CapacityRead, fetchedAt: number): Snapshot {
    const reason = unavailableReason(read);
    if (reason) console.warn(`agent-run capacity read unavailable: ${reason}`);
    if (read.outcome === 'answered') {
      for (const entry of read.entries) {
        if (rateLimitedThisMinute(entry) > 0) {
          rateLimitedSince.set(entryKey(entry.provider, entry.model), fetchedAt);
        }
      }
    }
    snapshot = { read, fetchedAt };
    return snapshot;
  }

  async function current(now: number): Promise<Snapshot> {
    const cacheMs = readMs(CAPACITY_CACHE_MS_ENV_VAR, DEFAULT_CACHE_MS);
    if (snapshot && now - snapshot.fetchedAt < cacheMs) return snapshot;
    if (inflight) return inflight;
    inflight = clientOf()
      .read()
      .then((read) => settle(read, now))
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  function verdictOf(snap: Snapshot, model: AgentModel, now: number): AgentCapacityVerdict {
    if (unavailableReason(snap.read)) return AVAILABLE;
    const entry = findEntry(snap.read, model);
    if (!entry) return AVAILABLE;
    const since = rateLimitedSince.get(entryKey(entry.provider, entry.model)) ?? null;
    const windowMs = readMs(CAPACITY_429_WINDOW_MS_ENV_VAR, DEFAULT_429_WINDOW_MS);
    return computeAgentCapacityVerdict(entry, since, now, windowMs);
  }

  return {
    /** One model's verdict. */
    async verdictFor(model: AgentModel, now: number = Date.now()): Promise<AgentCapacityVerdict> {
      return verdictOf(await current(now), model, now);
    },
    /** Every model's verdict from one read, keyed by the bare id. */
    async verdictsFor(
      models: AgentModel[],
      now: number = Date.now(),
    ): Promise<Map<string, AgentCapacityVerdict>> {
      const snap = await current(now);
      return new Map(models.map((m) => [m.id, verdictOf(snap, m, now)]));
    },
    /** Tests only: forget the snapshot, the in-flight read and the 429 stamps. */
    reset(): void {
      snapshot = null;
      inflight = null;
      rateLimitedSince.clear();
    },
  };
}

export const agentRunCapacityService = createAgentRunCapacityService();

/** Tests only: put the module's service and its env warnings back to a cold start. */
export function __resetAgentRunCapacityForTests(): void {
  agentRunCapacityService.reset();
  warnedEnv.clear();
}
