// Background id → its drawer. Kept apart from the registry so the registry
// stays pure data; this module is plain drawing code over a 2D context (no DOM
// at import time), so it is server-safe to import too.
//
// Every registered id has a drawer. An id that ever lacks one draws nothing:
// the runtime clears its box and stops.

import { createAurora } from './aurora';
import { createBriansBrain, createCyclic, createDayNight, createRule110 } from './cellular';
import type { BackgroundId } from './registry';
import { createTopography } from './topography';
import { createWave } from './wave';
import type { BackgroundDrawerFactory } from './types';

export const BACKGROUND_DRAWERS: Partial<Record<BackgroundId, BackgroundDrawerFactory>> = {
  wave: createWave,
  topography: createTopography,
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
