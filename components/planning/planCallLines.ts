import type { PlanChangeProgress } from '@/lib/hooks/usePlanChangeConversation';

/**
 * THE ACT RECORD, as data (Story MOTIR-7974 · MOTIR-7979, amended by Story
 * MOTIR-8060 · MOTIR-8064).
 *
 * Everything here is pure: which acts the record draws, which steps are open and
 * what the one live region announces. `PlanActRecord` renders from it.
 *
 * ⚠️ THERE ARE NO TOOL-CALL ACTS. `design/ai-chat/design-notes.md` § "⭐ Planner
 * narration in the chat panel" (MOTIR-8061) amends MOTIR-7975's § "The per-call
 * line on the planning rail": a tool call is not drawn in the rail, for either
 * planner. The planner says what it is doing in its own words instead
 * (`PlanNarration`). The frame map (`planChangeFrames.ts`) keeps every lookup
 * frame quiet, so the record never holds one (MOTIR-8158).
 *
 * ⚠️ THE RECORD STAYS FLAT. `acts` is the hook's append-only list and
 * `applyPlanFrame` owns it; everything below is a VIEW derived at render time.
 */

/** The act rows that name a step of the walk. The others (`submitted`, `note`,
 *  `proposed`, and the debug turn's two) do not. */
const STEP_KINDS: ReadonlySet<PlanChangeProgress['kind']> = new Set([
  'reading',
  'redirected',
  'laying',
  'authoring',
  'amending',
  'checking',
  'repairing',
  'validating',
]);

export function isStep(act: PlanChangeProgress): boolean {
  return STEP_KINDS.has(act.kind);
}

/** The step rows a session head replaces once the plan's narration names its
 *  sessions (MOTIR-8061: "the session heads replace them, from the store") — the
 *  lay and author rows, and the amend, final-check and fix rows (MOTIR-11256). */
export function isSessionStep(act: PlanChangeProgress): boolean {
  return (
    act.kind === 'laying' ||
    act.kind === 'authoring' ||
    act.kind === 'amending' ||
    act.kind === 'checking' ||
    act.kind === 'repairing'
  );
}

/**
 * The OPEN steps (by index into `acts`) while the run streams: the most recent
 * step, and — when it is `authoring` — every `authoring` step back to the
 * previous step of another kind (the parallel level). Once the run ends, none is.
 */
export function openSteps(acts: readonly PlanChangeProgress[], streaming: boolean): Set<number> {
  const open = new Set<number>();
  if (!streaming) return open;
  const steps = acts.flatMap((act, index) => (isStep(act) ? [index] : []));
  const last = steps[steps.length - 1];
  if (last === undefined) return open;
  open.add(last);
  if (acts[last]!.kind !== 'authoring') return open;
  for (let i = steps.length - 2; i >= 0; i -= 1) {
    if (acts[steps[i]!]!.kind !== 'authoring') break;
    open.add(steps[i]!);
  }
  return open;
}

// ── The announcer ─────────────────────────────────────────────────────────────

/** The newest act — what the one polite live region holds on mount. */
export function latestRowAnnouncement(acts: readonly PlanChangeProgress[]): number | null {
  return acts.length > 0 ? acts.length - 1 : null;
}

/**
 * The act a change of record announces, or null to keep the current one: the
 * newest act appended. A record that is not a continuation of the previous one
 * (a new run) is announced afresh.
 */
export function nextAnnouncement(
  prev: readonly PlanChangeProgress[],
  next: readonly PlanChangeProgress[],
): number | null {
  if (!continuesRecord(prev, next)) return latestRowAnnouncement(next);
  return next.length > prev.length ? next.length - 1 : null;
}

/** Is `next` the same run's record as `prev`, grown? */
export function continuesRecord(
  prev: readonly PlanChangeProgress[],
  next: readonly PlanChangeProgress[],
): boolean {
  return prev.length <= next.length && prev.every((act, i) => act.kind === next[i]!.kind);
}
