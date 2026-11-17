// The grouped board's lane-offset store (MOTIR-11449, design MOTIR-11443 § *The
// scroll model*). Each lane scrolls sideways on its own, and the pinned
// column-header row is DRIVEN by the ACTIVE lane — the one last scrolled,
// arrowed, panned or focused: the header follows that lane live, holds its offset
// once no lane is active, and sits at 0 only before any lane has been acted on.
//
// A tiny external store rather than React state on the board: a lane reports its
// offset on every scroll frame, and only the header and the lanes whose
// column-name strip flips should re-render — so each subscriber selects the one
// value it shows (`useSyncExternalStore`), and a scroll never re-renders the grid.

export interface LaneScrollStore {
  subscribe: (listener: () => void) => () => void;
  /** The offset the column-header row sits at: the active lane's. */
  headerOffset: () => number;
  /** The lane the header follows, or null before any lane was acted on. */
  activeLane: () => string | null;
  /** The offset `laneKey` was last seen at (0 before it moved). */
  offsetOf: (laneKey: string) => number;
  /** Does `laneKey` draw its column-name strip — is it off the header's offset? */
  showsStrip: (laneKey: string) => boolean;
  /** `laneKey` was acted on at `offset`: the header follows it. */
  follow: (laneKey: string, offset: number) => void;
}

export function createLaneScrollStore(): LaneScrollStore {
  let header = 0;
  let active: string | null = null;
  const offsets = new Map<string, number>();
  const listeners = new Set<() => void>();
  const offsetOf = (laneKey: string) => offsets.get(laneKey) ?? 0;
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    headerOffset: () => header,
    activeLane: () => active,
    offsetOf,
    showsStrip: (laneKey) => Math.abs(header - offsetOf(laneKey)) >= OFFSET_TOLERANCE_PX,
    follow(laneKey, offset) {
      offsets.set(laneKey, offset);
      if (active === laneKey && header === offset) return;
      active = laneKey;
      header = offset;
      for (const listener of listeners) listener();
    },
  };
}

/** Within this many px a lane reads as sitting at the header's offset. */
export const OFFSET_TOLERANCE_PX = 2;
