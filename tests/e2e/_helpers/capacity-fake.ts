import {
  CAPACITY_FAKE_STATE_PATH_ENV_VAR,
  type CapacityFakeMode,
  type CapacityFakeState,
  defaultCapacityFakeState,
  readCapacityFakeStateFile,
  writeCapacityFakeStateFile,
} from '@/lib/gateway/capacityFakeState';
import type { CapacityLimitUnit, CapacityProvider } from '@/lib/capacity/alertKeys';
import type { CapacityEntry, CapacityLimit, LaneUsage } from '@/lib/gateway/capacityClient';

// THE SPEC'S HALF OF THE CAPACITY FAKE (Story MOTIR-9539 · MOTIR-9617).
//
// The acceptance lane points the web server, the job worker and this runner at
// one state file (`playwright.acceptance.config.ts`, the "CAPACITY FAKE" block),
// and the fake re-reads it on every call. So a spec changes what the gateway
// "says" by writing the file — mid-test, with no restart — through the same
// parser and atomic replace the fake itself uses.

function statePath(): string {
  const path = process.env[CAPACITY_FAKE_STATE_PATH_ENV_VAR]?.trim();
  if (!path) {
    throw new Error(
      `${CAPACITY_FAKE_STATE_PATH_ENV_VAR} is not set — run under the acceptance lane`,
    );
  }
  return path;
}

/** Write the whole state; the seed when none is given. */
export function seedCapacityFake(state: CapacityFakeState = defaultCapacityFakeState()): void {
  writeCapacityFakeStateFile(statePath(), state);
}

/** The state as the fake will next read it (seeded first if the file is missing). */
export function readCapacityFake(): CapacityFakeState {
  return readCapacityFakeStateFile(statePath());
}

/** Switch the gateway between live, counter store down, and unreachable. */
export function setCapacityMode(mode: CapacityFakeMode): void {
  seedCapacityFake({ ...readCapacityFake(), mode });
}

export interface CapacityEntryPatch {
  limits?: Partial<Record<CapacityLimitUnit, CapacityLimit>>;
  lanes?: { planning?: Partial<LaneUsage> | null; agent?: Partial<LaneUsage> | null };
  tierNote?: string;
  unknownNote?: string;
  planningSharePercent?: number;
}

function patchLane(
  lane: LaneUsage | null,
  patch: Partial<LaneUsage> | null | undefined,
): LaneUsage | null {
  if (patch === undefined) return lane;
  if (patch === null || lane === null) return patch === null ? null : (patch as LaneUsage);
  return { ...lane, ...patch };
}

/** Change one entry's limits, lane usage or notes, leaving the rest of the file. */
export function patchCapacityEntry(
  provider: CapacityProvider,
  model: string,
  patch: CapacityEntryPatch,
): CapacityEntry {
  const state = readCapacityFake();
  const index = state.entries.findIndex((e) => e.provider === provider && e.model === model);
  if (index < 0) throw new Error(`capacity fake: no entry ${provider}/${model}`);
  const current = state.entries[index]!;
  const next: CapacityEntry = {
    ...current,
    tierNote: patch.tierNote ?? current.tierNote,
    unknownNote: patch.unknownNote ?? current.unknownNote,
    planningSharePercent: patch.planningSharePercent ?? current.planningSharePercent,
    limits: { ...current.limits, ...patch.limits },
    lanes: {
      planning: patchLane(current.lanes.planning, patch.lanes?.planning),
      agent: patchLane(current.lanes.agent, patch.lanes?.agent),
    },
  };
  seedCapacityFake({ ...state, entries: state.entries.map((e, i) => (i === index ? next : e)) });
  return next;
}
