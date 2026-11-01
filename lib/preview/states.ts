import type { PreviewDeploymentState } from '@/generated/prisma/client';

// THE PREVIEW STATE MACHINE (MOTIR-5769 §9 "States": `building`, `starting`,
// `ready`, `failed`, `closed`). `previewDeploymentRepository.transition` writes
// a move only when it is legal here AND the row is in one of the caller's
// `from` states, in one conditional statement — so an illegal move (`closed →
// ready`) writes nothing, whatever `from` the caller passed.
//
//   building ──▶ starting ──▶ ready
//      │  ▲          │          │
//      ▼  └──────────┴──────────┘   a new head commit rebuilds from any live state
//   failed  ─────▶ building
//   any live state ──▶ closed ──▶ building   (a reopened pull request)

export const PREVIEW_STATES = ['building', 'starting', 'ready', 'failed', 'closed'] as const;

/** Every state a move INTO `to` may start from. */
const SOURCES: Readonly<Record<PreviewDeploymentState, readonly PreviewDeploymentState[]>> = {
  building: ['building', 'starting', 'ready', 'failed', 'closed'],
  starting: ['building'],
  ready: ['starting'],
  failed: ['building', 'starting', 'ready'],
  closed: ['building', 'starting', 'ready', 'failed'],
};

/** The states a preview is live in — everything but `closed`. */
export const LIVE_PREVIEW_STATES: readonly PreviewDeploymentState[] = [
  'building',
  'starting',
  'ready',
  'failed',
];

/** Whether `from → to` is a move the machine allows. */
export function isLegalPreviewTransition(
  from: PreviewDeploymentState,
  to: PreviewDeploymentState,
): boolean {
  return SOURCES[to].includes(from);
}

/** The caller's `from` states narrowed to those a move into `to` may leave. */
export function legalSourcesFor(
  from: readonly PreviewDeploymentState[],
  to: PreviewDeploymentState,
): PreviewDeploymentState[] {
  return [...new Set(from)].filter((state) => isLegalPreviewTransition(state, to));
}
