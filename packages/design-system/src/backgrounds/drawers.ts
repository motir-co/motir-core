// Background id → its drawer. Kept apart from the registry so the registry
// stays pure data; this module is plain drawing code over a 2D context (no DOM
// at import time), so it is server-safe to import too.
//
// A registered id with no drawer yet draws nothing: the runtime clears its box
// and stops. Every id is drawn by the time the package is released.

import { createAurora } from './aurora';
import { createBriansBrain, createCyclic, createDayNight, createRule110 } from './cellular';
import type { BackgroundId } from './registry';
import type { BackgroundDrawerFactory } from './types';

export const BACKGROUND_DRAWERS: Partial<Record<BackgroundId, BackgroundDrawerFactory>> = {
  aurora: createAurora,
  cyclic: createCyclic,
  brian: createBriansBrain,
  daynight: createDayNight,
  rule110: createRule110,
};

/** The drawer factory for a background id, or `null` when it has none. */
export function drawerFor(id: BackgroundId): BackgroundDrawerFactory | null {
  return BACKGROUND_DRAWERS[id] ?? null;
}
