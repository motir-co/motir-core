import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CAPACITY_LIMIT_UNITS,
  CAPACITY_PROVIDERS,
  type CapacityLimitUnit,
  type CapacityProvider,
} from '@/lib/capacity/alertKeys';
import { readFixtureFileSync, replaceFixtureFileSync } from '@/lib/test-fixture-file';
import type { CapacityEntry, CapacityLimit } from './capacityClient';

// THE CAPACITY FAKE'S STATE (Story MOTIR-9539 · MOTIR-9608, MOTIR-9617) — its
// seed, and the file the acceptance lane keeps it in.
//
// Not `server-only`, on purpose: the acceptance spec's helper
// (`tests/e2e/_helpers/capacity-fake.ts`) writes the same file through these same
// functions, so the fake and the spec share ONE parser and cannot disagree about
// the file's shape.
//
// ⚠️ THE FILE IS RE-READ ON EVERY CALL, never cached. The lane's production
// build gives each route bundle its own module copy, the job worker is a third
// process, and the spec a fourth; the file is the only state they share.

export const CAPACITY_FAKE_STATE_PATH_ENV_VAR = 'MOTIR_E2E_FAKE_GATEWAY_CAPACITY_STATE_PATH';

/** `live` answers with counters; `unavailable` with the counter store down
 *  (contract §5); `unreachable` as a gateway that cannot be reached. */
export type CapacityFakeMode = 'live' | 'unavailable' | 'unreachable';

export interface CapacityFakeState {
  mode: CapacityFakeMode;
  scope: 'shared' | 'instance';
  entries: CapacityEntry[];
}

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

/** One entry per provider, each with only its enforced units set. */
export function seedCapacityEntries(): CapacityEntry[] {
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

export function defaultCapacityFakeState(): CapacityFakeState {
  return { mode: 'live', scope: 'shared', entries: seedCapacityEntries() };
}

const MODES: ReadonlySet<string> = new Set<CapacityFakeMode>([
  'live',
  'unavailable',
  'unreachable',
]);

/** Parse the file's text, refusing a shape the fake would misread. */
export function parseCapacityFakeState(text: string): CapacityFakeState {
  const data = JSON.parse(text) as Partial<CapacityFakeState>;
  if (!data || typeof data.mode !== 'string' || !MODES.has(data.mode)) {
    throw new Error('capacity fake state: mode must be live, unavailable or unreachable');
  }
  if (data.scope !== 'shared' && data.scope !== 'instance') {
    throw new Error('capacity fake state: scope must be shared or instance');
  }
  if (!Array.isArray(data.entries)) throw new Error('capacity fake state: entries must be a list');
  for (const entry of data.entries) {
    if (!(CAPACITY_PROVIDERS as readonly string[]).includes(entry.provider)) {
      throw new Error(`capacity fake state: unknown provider ${String(entry.provider)}`);
    }
  }
  return data as CapacityFakeState;
}

/** The state in `path`, creating the file from the seed when it is missing. */
export function readCapacityFakeStateFile(path: string): CapacityFakeState {
  let text: string;
  try {
    text = readFixtureFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const seeded = defaultCapacityFakeState();
    writeCapacityFakeStateFile(path, seeded);
    return seeded;
  }
  return parseCapacityFakeState(text);
}

/** Replace the file whole (a sibling, renamed over it), so no reader sees half. */
export function writeCapacityFakeStateFile(path: string, state: CapacityFakeState): void {
  mkdirSync(/* turbopackIgnore: true */ dirname(path), { recursive: true });
  replaceFixtureFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}
