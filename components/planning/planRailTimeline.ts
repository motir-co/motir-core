import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { PlanVersionDto } from '@/lib/dto/planReview';
import type { NarrationGroup } from '@/components/planning/planNarration';

/**
 * THE PLANNING RAIL IN THE ORDER THINGS HAPPENED (Bug MOTIR-11487; design
 * MOTIR-11486, `design/ai-chat/design-notes.md` § "⭐ The planning rail during a
 * plan revision", `plan-change-run-live--revision-timeline.mock.html`).
 *
 * Pure and I/O-free: which run each narration group belongs to, which turn each
 * run sits under, and where each version's briefing goes. `PlanChangeRail` draws
 * the slots in the order this returns and never re-sorts them.
 *
 * Before it the rail drew every turn, then ONE working row holding every run's
 * notes, then the old proposal's briefing and its decide panel — so during a
 * revision the follow-up and its notes sat above a stale result, out of view, and
 * the person read their message as lost.
 */

/** One planner RUN: the narration groups of one job (or one `plan.py` run). */
export interface RailRun {
  /** `ai:<jobId>` for the hosted planner, `plan.py:<runId>` for plan.py, else the
   *  group's own key. */
  key: string;
  /** The job the run is, for a hosted run — the `jobId` its submission marker and
   *  its answers carry. Null for a run with no turn to sit under. */
  jobId: string | null;
  groups: NarrationGroup[];
  /** The run's first moment: its earliest session's `firstReportedAt`, else its
   *  earliest sentence. Null for a run with neither. */
  startedAt: string | null;
}

/**
 * The run a narration session belongs to: its key's first two segments. The
 * hosted planner writes `ai:<jobId>:<n>` (`motir-ai` `planStepReporter.ts`) and
 * `ai:<jobId>:<entry key>` (`planEntryRecorder.ts`, whose own key may hold a
 * colon), plan.py writes `plan.py:<runId>:<n>`. A key without that shape names no
 * run, and every such session shares ONE run ({@link UNKEYED_RUN}) — the one list
 * the rail drew before runs existed, so nothing is split on a guess.
 */
export function narrationRunKey(sessionKey: string): string {
  const parts = sessionKey.split(':');
  return parts.length > 2 && parts[0] !== '' && parts[1] !== ''
    ? `${parts[0]}:${parts[1]}`
    : UNKEYED_RUN;
}

/** The run of every session whose key names none. */
export const UNKEYED_RUN = '';

function runJobOf(key: string): string | null {
  return key.startsWith('ai:') && key.length > 3 ? key.slice(3) : null;
}

function groupStartedAt(group: NarrationGroup): string | null {
  return group.session?.firstReportedAt ?? group.messages[0]?.createdAt ?? null;
}

function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
}

/**
 * The narration as RUNS, in the order they started (design rule 1). A group lands
 * only in the run of its own key, and a run keeps its groups in the order the
 * read gave them. A run that started at no known moment sorts last.
 */
export function narrationRuns(groups: readonly NarrationGroup[]): RailRun[] {
  const byKey = new Map<string, RailRun>();
  for (const group of groups) {
    const key = narrationRunKey(group.sessionKey);
    let run = byKey.get(key);
    if (!run) {
      run = { key, jobId: runJobOf(key), groups: [], startedAt: null };
      byKey.set(key, run);
    }
    run.groups.push(group);
    run.startedAt = earliest(run.startedAt, groupStartedAt(group));
  }
  return [...byKey.values()]
    .map((run, i) => ({ run, i }))
    .sort((a, b) => {
      if (a.run.startedAt === b.run.startedAt) return a.i - b.i;
      if (a.run.startedAt === null) return 1;
      if (b.run.startedAt === null) return -1;
      return a.run.startedAt < b.run.startedAt ? -1 : 1;
    })
    .map(({ run }) => run);
}

/** One thing the rail's transcript draws, in order. */
export type RailSlot =
  | { kind: 'turn'; index: number }
  /** A FINISHED run's block: its avatar and its own notes. */
  | { kind: 'run'; run: RailRun }
  /** The shipped working-turn row — the hand-off, the act record and the notes of
   *  the run it holds. Always present, so its live region never remounts. */
  | { kind: 'work'; run: RailRun | null }
  /** A version's briefing, drawn where that version closed. */
  | { kind: 'version'; version: PlanVersionDto; earlier: boolean };

export interface RailLayoutInput {
  turns: readonly PlanChangeTurnDto[];
  runs: readonly RailRun[];
  /** The plan's versions, oldest first — `[]` when no briefing is drawn. */
  versions: readonly PlanVersionDto[];
  /** The run the working-turn row holds (the live run, else the newest one). */
  workRunKey: string | null;
  /** The job the working row is for, so it sits under that job's turn even before
   *  the run's first note lands. */
  workJobId: string | null;
  /** Whether the working row draws anything. An empty row never counts as content
   *  that a briefing comes before. */
  workShown: boolean;
}

export interface RailLayout {
  slots: RailSlot[];
  /**
   * The CURRENT version's briefing is the last thing in the transcript, so the
   * review block draws it where it always has — after the stopped marker, above
   * its panel. False when a later turn or run follows it (a revision is under
   * way, or it failed or stopped), when it sits in `slots`.
   */
  currentTrailing: boolean;
}

type Timed = { at: string; slot: RailSlot };

/** The last index of a turn carrying `jobId` — its submission marker or its last
 *  answer, which is the turn a run's block is drawn under (design rule 2, 6). */
function jobAnchors(turns: readonly PlanChangeTurnDto[]): Map<string, number> {
  const anchors = new Map<string, number>();
  turns.forEach((turn, i) => {
    if (turn.jobId) anchors.set(turn.jobId, i);
  });
  return anchors;
}

/**
 * Lay the transcript out (design rules 2–5, 8):
 *
 *  - every turn in `seq` order;
 *  - a run with a turn of its job directly under that job's last turn;
 *  - a run with no turn (plan.py, an MCP agent), and every version, by time:
 *    before the first turn written after it;
 *  - the working row where its run goes, else at the end.
 *
 * It reads only the stored turns, narration and trail, so a reopened rail lays
 * out exactly as the live one did.
 */
export function layoutRail(input: RailLayoutInput): RailLayout {
  const { turns, runs, versions, workRunKey, workJobId, workShown } = input;
  const anchors = jobAnchors(turns);
  const under = new Map<number, RailSlot[]>();
  const timed: Timed[] = [];
  const tail: RailSlot[] = [];

  const place = (slot: RailSlot, jobId: string | null, at: string | null) => {
    const anchor = jobId !== null ? anchors.get(jobId) : undefined;
    if (anchor !== undefined) under.set(anchor, [...(under.get(anchor) ?? []), slot]);
    else if (at !== null) timed.push({ at, slot });
    else tail.push(slot);
  };

  const workRun = runs.find((run) => run.key === workRunKey) ?? null;
  for (const run of runs) {
    if (run === workRun) continue;
    place({ kind: 'run', run }, run.jobId, run.startedAt);
  }
  place(
    { kind: 'work', run: workRun },
    workJobId ?? workRun?.jobId ?? null,
    workRun?.startedAt ?? null,
  );
  // A version follows the block of the run that closed it (design rule 4), which is
  // NOT the same as by time: the planner's reply turn of that job is written on
  // settle, after its close, and the run block sits under that reply. A version no
  // run can be tied to is placed by time.
  const tiedAfter = new Map<string, RailSlot[]>();
  versions.forEach((version, i) => {
    const slot: RailSlot = { kind: 'version', version, earlier: i < versions.length - 1 };
    const closer = closingRun(runs, turns, version.plannedAt);
    if (closer) tiedAfter.set(closer.key, [...(tiedAfter.get(closer.key) ?? []), slot]);
    else timed.push({ at: version.plannedAt, slot });
  });
  // Stable: two things at one instant keep the order they were pushed in — a run
  // before the version it closed with.
  const queue = timed
    .map((entry, i) => ({ ...entry, i }))
    .sort((a, b) => (a.at === b.at ? a.i - b.i : a.at < b.at ? -1 : 1));

  const slots: RailSlot[] = [];
  let next = 0;
  turns.forEach((turn, index) => {
    while (next < queue.length && queue[next]!.at < turn.createdAt) slots.push(queue[next++]!.slot);
    slots.push({ kind: 'turn', index }, ...(under.get(index) ?? []));
  });
  while (next < queue.length) slots.push(queue[next++]!.slot);
  slots.push(...tail);

  return trailingCurrent(withTiedVersions(slots, tiedAfter), workShown);
}

/**
 * The run that closed a version: the latest run started at or before `plannedAt`,
 * provided no person's turn and no turn of ANOTHER job (a follow-up, its marker) was
 * written between that run's start and the close — otherwise the version belongs to a later run that left
 * no notes, and time places it.
 */
function closingRun(
  runs: readonly RailRun[],
  turns: readonly PlanChangeTurnDto[],
  plannedAt: string,
): RailRun | null {
  let closer: RailRun | null = null;
  for (const run of runs) {
    if (run.startedAt !== null && run.startedAt <= plannedAt) {
      if (closer === null || closer.startedAt! <= run.startedAt) closer = run;
    }
  }
  if (closer === null) return null;
  const run = closer;
  const from = run.startedAt!;
  const interrupted = turns.some(
    (turn) =>
      turn.createdAt > from &&
      turn.createdAt < plannedAt &&
      (turn.jobId === null || turn.jobId !== run.jobId),
  );
  return interrupted ? null : run;
}

/** Each run's versions, drawn straight after that run's block (or working row). */
function withTiedVersions(slots: RailSlot[], tiedAfter: Map<string, RailSlot[]>): RailSlot[] {
  if (tiedAfter.size === 0) return slots;
  return slots.flatMap((slot) => {
    const key = slot.kind === 'run' ? slot.run.key : slot.kind === 'work' ? slot.run?.key : null;
    return key != null && tiedAfter.has(key) ? [slot, ...tiedAfter.get(key)!] : [slot];
  });
}

/** Take the current version's briefing out of `slots` when nothing with content
 *  follows it, so the review block draws it in its shipped place. */
function trailingCurrent(slots: RailSlot[], workShown: boolean): RailLayout {
  const at = slots.findIndex((slot) => slot.kind === 'version' && !slot.earlier);
  if (at < 0) return { slots, currentTrailing: true };
  const after = slots.slice(at + 1);
  const followed = after.some((slot) => slot.kind !== 'work' || workShown);
  if (followed) return { slots, currentTrailing: false };
  return { slots: [...slots.slice(0, at), ...after], currentTrailing: true };
}
