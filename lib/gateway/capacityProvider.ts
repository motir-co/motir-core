import 'server-only';

import { isE2EProdHarness } from '@/lib/e2eProdHarness';
import {
  CAPACITY_PROVIDERS,
  type CapacityEntry,
  type CapacityLimitUnit,
  type CapacityLimitsEdit,
  type CapacityRead,
  type StoredCapacityRow,
  readGatewayCapacity,
  writeGatewayCapacityLimits,
} from './capacityClient';
import { GatewayCapacityRefusedError, GatewayCapacityUnavailableError } from './capacityErrors';
import {
  CAPACITY_FAKE_STATE_PATH_ENV_VAR,
  type CapacityFakeState,
  readCapacityFakeStateFile,
  seedCapacityEntries,
  writeCapacityFakeStateFile,
} from './capacityFakeState';

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
//
// ⚠️ WITH `MOTIR_E2E_FAKE_GATEWAY_CAPACITY_STATE_PATH` SET BESIDE THE FLAG
// (MOTIR-9617), the fake's whole state — mode, limits, lanes — lives in that JSON
// file instead, re-read on every call and replaced whole on an accepted edit. The
// acceptance lane needs it: its route bundles, its job worker and its spec are
// separate module copies and processes, and the file is all they share. Without
// the path the fake is the in-memory one below, unchanged.

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

let fakeEntries: CapacityEntry[] = seedCapacityEntries();

/** Tests only: put the fake back to its seed. */
export function resetFakeGatewayCapacity(): void {
  fakeEntries = seedCapacityEntries();
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
  read: async () =>
    fakeRead({
      mode: process.env[FAKE_FLAG] === 'unavailable' ? 'unavailable' : 'live',
      scope: 'shared',
      entries: fakeEntries,
    }),
  write: async (provider, model, edit) => {
    const { entries, row } = applyFakeWrite(fakeEntries, provider, model, edit);
    fakeEntries = entries;
    return row;
  },
};

/** The gateway's §4 write against a list of entries: refused, or the new list and row. */
function applyFakeWrite(
  entries: CapacityEntry[],
  provider: string,
  model: string,
  edit: CapacityLimitsEdit,
): { entries: CapacityEntry[]; row: StoredCapacityRow } {
  if (!(CAPACITY_PROVIDERS as readonly string[]).includes(provider)) {
    throw new GatewayCapacityRefusedError(400, 'capacity_unknown_provider', null);
  }
  const index = entries.findIndex((e) => e.provider === provider && e.model === model);
  if (index < 0) throw new GatewayCapacityRefusedError(404, 'capacity_unknown_model', null);
  validateFakeEdit(edit);
  const next = applyFakeEdit(entries[index]!, edit);
  const { lanes: _lanes, providerHint: _hint, ...row } = next;
  return {
    entries: entries.map((e, i) => (i === index ? next : e)),
    row: { ...row, updatedAt: new Date() },
  };
}

function fakeRead(state: CapacityFakeState): CapacityRead {
  if (state.mode === 'unreachable') return { outcome: 'unavailable', reason: 'network' };
  const down = state.mode === 'unavailable';
  return {
    outcome: 'answered',
    readAt: new Date(),
    counterStore: { state: down ? 'unavailable' : 'live', scope: state.scope },
    entries: state.entries.map((e) =>
      down ? { ...e, lanes: { planning: null, agent: null }, providerHint: null } : e,
    ),
  };
}

/** The file-backed fake: every call reads the file; an accepted edit replaces it. */
function fileGatewayCapacityClient(path: string): GatewayCapacityClient {
  return {
    read: async () => fakeRead(readCapacityFakeStateFile(path)),
    write: async (provider, model, edit) => {
      const state = readCapacityFakeStateFile(path);
      if (state.mode === 'unreachable') {
        throw new GatewayCapacityUnavailableError('the gateway could not be reached');
      }
      const { entries, row } = applyFakeWrite(state.entries, provider, model, edit);
      writeCapacityFakeStateFile(path, { ...state, entries });
      return row;
    },
  };
}

/** The client this deployment should use. */
export function gatewayCapacityClient(): GatewayCapacityClient {
  if (!usingFakeGatewayCapacity()) return httpGatewayCapacityClient;
  const path = process.env[CAPACITY_FAKE_STATE_PATH_ENV_VAR]?.trim();
  return path ? fileGatewayCapacityClient(path) : fakeGatewayCapacityClient;
}
