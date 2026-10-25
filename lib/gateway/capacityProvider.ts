import 'server-only';

import { isE2EProdHarness } from '@/lib/e2eProdHarness';
import {
  CAPACITY_LIMIT_UNITS,
  CAPACITY_PROVIDERS,
  type CapacityEntry,
  type CapacityLimit,
  type CapacityLimitUnit,
  type CapacityLimitsEdit,
  type CapacityProvider,
  type CapacityRead,
  type StoredCapacityRow,
  readGatewayCapacity,
  writeGatewayCapacityLimits,
} from './capacityClient';
import { GatewayCapacityRefusedError } from './capacityErrors';

// THE GATEWAY CAPACITY BINDING (MOTIR-9608) — the same shape as `./statusProvider.ts`:
// one place chooses between the real HTTP client and an in-memory fake, so the
// browser lanes can show the capacity screen without a gateway behind it. Every
// consumer reads through `gatewayCapacityClient()`.
//
// ⚠️ THE FAKE CANNOT ARM IN A REAL PRODUCTION BUILD. A fake reporting healthy
// headroom in production would hide a saturated provider — the blindness the
// capacity screen exists to end. The flag is read at call time and refused when
// `NODE_ENV === 'production'` unless the E2E harness is ALSO set.
//
//   MOTIR_E2E_FAKE_GATEWAY_CAPACITY=1            → the fake, counters live
//   MOTIR_E2E_FAKE_GATEWAY_CAPACITY=unavailable  → the fake, counter store down

const FAKE_FLAG = 'MOTIR_E2E_FAKE_GATEWAY_CAPACITY';

export interface GatewayCapacityClient {
  read(): Promise<CapacityRead>;
  write(provider: string, model: string, edit: CapacityLimitsEdit): Promise<StoredCapacityRow>;
}

/** Is the in-memory binding armed? Never true in a real production build. */
export function usingFakeGatewayCapacity(): boolean {
  if (process.env.NODE_ENV === 'production' && !isE2EProdHarness()) return false;
  const flag = process.env[FAKE_FLAG];
  return flag === '1' || flag === 'unavailable';
}

export const httpGatewayCapacityClient: GatewayCapacityClient = {
  read: readGatewayCapacity,
  write: writeGatewayCapacityLimits,
};

// ── the fake ────────────────────────────────────────────────────────────────

/** Each provider's enforced units, from the contract's §3 table. */
const ENFORCED: Record<CapacityProvider, readonly CapacityLimitUnit[]> = {
  claude: ['rpm', 'input_tpm', 'output_tpm'],
  qwen: ['rpm', 'tpm'],
  deepseek: ['max_concurrency'],
};

function seedLimits(
  provider: CapacityProvider,
  values: Partial<Record<CapacityLimitUnit, number>>,
): Record<CapacityLimitUnit, CapacityLimit> {
  const limits = {} as Record<CapacityLimitUnit, CapacityLimit>;
  for (const unit of CAPACITY_LIMIT_UNITS) {
    const value = values[unit];
    if (value !== undefined) limits[unit] = { status: 'set', value };
    else
      limits[unit] = ENFORCED[provider].includes(unit)
        ? { status: 'unknown' }
        : { status: 'not_applicable' };
  }
  return limits;
}

function seed(): CapacityEntry[] {
  const lane = (n: number) => ({
    inFlight: n,
    requestsPerMinute: n * 10,
    tokensPerMinute: n * 10_000,
    tokensPerDay: n * 200_000,
    rateLimited429: { minute: 0, day: n },
  });
  const entry = (
    provider: CapacityProvider,
    model: string,
    values: Partial<Record<CapacityLimitUnit, number>>,
  ): CapacityEntry => ({
    provider,
    model,
    tierNote: 'Example tier (E2E fake)',
    unknownNote: '',
    planningSharePercent: 50,
    limits: seedLimits(provider, values),
    lanes: { planning: lane(2), agent: lane(5) },
    providerHint: null,
  });
  return [
    entry('claude', 'claude-example-1', { rpm: 1000, input_tpm: 200_000, output_tpm: 40_000 }),
    entry('deepseek', 'deepseek-example-1', { max_concurrency: 500 }),
    entry('qwen', 'qwen-example-1', { rpm: 600, tpm: 800_000 }),
  ];
}

let fakeEntries: CapacityEntry[] = seed();

/** Tests only: put the fake back to its seed. */
export function resetFakeGatewayCapacity(): void {
  fakeEntries = seed();
}

const LIMIT_EDITS: ReadonlyArray<[keyof CapacityLimitsEdit, CapacityLimitUnit]> = [
  ['maxConcurrency', 'max_concurrency'],
  ['rpm', 'rpm'],
  ['inputTpm', 'input_tpm'],
  ['outputTpm', 'output_tpm'],
  ['tpm', 'tpm'],
  ['tpd', 'tpd'],
];

function invalid(field: string): GatewayCapacityRefusedError {
  return new GatewayCapacityRefusedError(400, 'capacity_invalid_value', field);
}

/** The gateway's own §4 validation, before anything is applied. */
function validateFakeEdit(edit: CapacityLimitsEdit): void {
  if (Object.values(edit).every((v) => v === undefined)) {
    throw new GatewayCapacityRefusedError(400, 'capacity_empty_edit', null);
  }
  for (const [key, unit] of LIMIT_EDITS) {
    const value = edit[key];
    if (
      value !== undefined &&
      value !== null &&
      (!Number.isInteger(value) || (value as number) < 0)
    ) {
      throw invalid(unit);
    }
  }
  const share = edit.planningSharePercent;
  if (share !== undefined && (!Number.isInteger(share) || share < 0 || share > 100)) {
    throw invalid('planning_share_percent');
  }
  if (edit.tierNote !== undefined && edit.tierNote.length > 1000) throw invalid('tier_note');
}

function applyFakeEdit(entry: CapacityEntry, edit: CapacityLimitsEdit): CapacityEntry {
  const limits = { ...entry.limits };
  for (const [key, unit] of LIMIT_EDITS) {
    const value = edit[key];
    if (value === undefined) continue;
    limits[unit] =
      value === null ? { status: 'unknown' } : { status: 'set', value: value as number };
  }
  return {
    ...entry,
    limits,
    planningSharePercent: edit.planningSharePercent ?? entry.planningSharePercent,
    tierNote: edit.tierNote ?? entry.tierNote,
  };
}

const fakeGatewayCapacityClient: GatewayCapacityClient = {
  read: async () => {
    const down = process.env[FAKE_FLAG] === 'unavailable';
    return {
      outcome: 'answered',
      readAt: new Date(),
      counterStore: { state: down ? 'unavailable' : 'live', scope: 'shared' },
      entries: fakeEntries.map((e) =>
        down ? { ...e, lanes: { planning: null, agent: null }, providerHint: null } : e,
      ),
    };
  },
  write: async (provider, model, edit) => {
    if (!(CAPACITY_PROVIDERS as readonly string[]).includes(provider)) {
      throw new GatewayCapacityRefusedError(400, 'capacity_unknown_provider', null);
    }
    const index = fakeEntries.findIndex((e) => e.provider === provider && e.model === model);
    if (index < 0) throw new GatewayCapacityRefusedError(404, 'capacity_unknown_model', null);
    validateFakeEdit(edit);
    const next = applyFakeEdit(fakeEntries[index]!, edit);
    fakeEntries = fakeEntries.map((e, i) => (i === index ? next : e));
    const { lanes: _lanes, providerHint: _hint, ...row } = next;
    return { ...row, updatedAt: new Date() };
  },
};

/** The client this deployment should use. */
export function gatewayCapacityClient(): GatewayCapacityClient {
  return usingFakeGatewayCapacity() ? fakeGatewayCapacityClient : httpGatewayCapacityClient;
}
