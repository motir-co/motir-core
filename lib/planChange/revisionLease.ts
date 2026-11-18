// The PLAN-REVISION LEASE's pure half (Story MOTIR-3595 · Subtask MOTIR-3596) —
// the one window the ADR, the service and the tests all name.
//
// ⚠️ THIS FILE CARRIES A CONSTANT AND NOTHING ELSE. The acquire, the refusal and
// the release are the implementing cards' (`docs/decisions/agent-authored-plans.md`
// AMENDMENT 10, "The constant and the type this card ships"); a decision card that
// shipped the mechanism as well would have decided it twice.
//
// ── WHY A LEASE AT ALL ──────────────────────────────────────────────────────
// `approvePlan` re-reads the proposal set FRESH under the plan row lock and
// materializes it in ONE transaction, so every individual write is atomic and the
// COMPOSITION is not. A revision is a SEQUENCE of transactions — one proposal per
// call, the discipline every shipped sink call site follows — and an approve that
// takes the lock between the third and the fourth of them materializes a tree
// that is neither the plan the reviewer read nor the plan they asked for. Approve
// is one-shot; there is no un-approve.
//
// ── WHY IT LIVES ON THE TRAIL AND NOT IN A TABLE ────────────────────────────
// `PlanRevision.changeKind` is plain text precisely so a new verb is a code
// change rather than a migration (`planRevisionsService` says so in as many
// words), and the lease's two verbs — `revision_started` / `revision_ended` — are
// the eighth and ninth. It also keeps the lease and its VISIBILITY the same
// record: a reviewer learns a revision is running by reading the timeline they
// were already reading.

/**
 * How long a revision lease is good for, measured from the LATEST trail row the
 * revision has written.
 *
 * Sized against what it actually races: ONE motir-ai job over a tree that is
 * already written — minutes, rather than the tens of minutes
 * `PLAN_TARGET_LOCK_LEASE_MS` is sized for (that one races a human-paced planning
 * conversation and a person who steps away mid-review). Short enough that "wait
 * for it to clear" is a real answer to a stuck lease rather than a joke.
 *
 * REFRESHED by every write the revision makes, because the window is measured
 * from the latest row rather than from the acquire: a long revision never ages
 * out while it is doing something, and the clock only starts running down once it
 * STOPS — which is the condition the expiry exists to detect. A job that dies
 * writes no `revision_ended`, and this window is the ONLY thing that recovers the
 * plan, exactly as `targetLock.ts` records of its own.
 */
export const PLAN_REVISION_LEASE_MS = 10 * 60 * 1000;

/** The two trail verbs that BRACKET a revision. They are ordinary
 *  `PlanRevision.changeKind` values — the column is plain text — and the pair IS
 *  the lease. */
export const REVISION_STARTED_KIND = 'revision_started';
export const REVISION_ENDED_KIND = 'revision_ended';

/**
 * The lease's HEARTBEAT (Bug MOTIR-7988) — a row the holder writes for no reason
 * but to say it is still working, so a revision whose next real write is more
 * than {@link PLAN_REVISION_LEASE_MS} away keeps the plan. BOTH kinds of
 * revision need it. An MCP-driven one (`prompts/plan.py --revise`) runs agent
 * sessions that can think for longer than the window between two writes; so does
 * a hosted one, whose job runs a whole conversation and uncapped author sessions
 * before its first proposal write (Bug MOTIR-8523 — this comment used to say a
 * hosted revision never needs it, and a hosted revision lapsed ten minutes in
 * while its job was still running). The MCP holder renews through
 * `hold_plan_revision`; motir-ai's worker renews a hosted revision's lease on a
 * timer for as long as its job runs (`POST /api/internal/ai/plan-revision-lease`).
 * Without it the plan falls back into Waiting on you with a live Approve
 * mid-rewrite — the exact race the lease exists to stop.
 *
 * It is not an EVENT: the timeline drops it (`TRAIL_ONLY_KINDS` in
 * `lib/plans/timeline.ts`), and it brackets nothing — {@link revisionLeaseOf}
 * needs no case for it, because the window is already measured from the latest
 * row, whatever its verb.
 */
export const REVISION_RENEWED_KIND = 'revision_renewed';

/** The shape this module needs of a trail row: nothing but the verb, when it
 *  happened, and who did it. Declared structurally rather than importing the
 *  Prisma model, so the predicate stays pure and unit-testable. */
export interface RevisionLeaseRow {
  changeKind: string;
  changedAt: Date;
  actorHarness?: string | null;
  actorModel?: string | null;
  /** The row's diff — read only by {@link revisionReopenedFrom}, so a reader
   *  that never asks whether a revision RE-OPENED the plan may leave it out. */
  diff?: unknown;
}

/** A held lease: who has the plan, and until when. */
export interface RevisionLease {
  heldBy: string | null;
  expiresAt: Date;
}

/**
 * The lease a plan's trail carries, or `null` when nothing holds it.
 *
 * HELD means: the trail's latest {@link REVISION_STARTED_KIND} has no
 * {@link REVISION_ENDED_KIND} after it, AND the most recent row at or after that
 * start is inside {@link PLAN_REVISION_LEASE_MS}.
 *
 * ⚠️ THE WINDOW IS MEASURED FROM THE LATEST ROW, not from the start — which is
 * what makes the lease REFRESH on every write the revision makes. A long
 * revision never ages out while it is doing something; the clock only runs down
 * once it STOPS, which is the condition the expiry exists to detect. A job that
 * dies writes no `revision_ended`, and this window is the only thing that
 * recovers the plan.
 *
 * `rows` is the whole trail in the order `planRevisionRepository.listByPlan`
 * returns it — OLDEST FIRST. Passing it unsorted would silently pick the wrong
 * start, so the order is part of the contract rather than something re-derived
 * here on every call.
 */
export function revisionLeaseOf(
  rows: readonly RevisionLeaseRow[],
  now: Date,
): RevisionLease | null {
  let startIndex = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const kind = rows[i]!.changeKind;
    // The FIRST terminator walking backwards ends the search: a revision that
    // landed is not holding anything, however many earlier ones there were.
    if (kind === REVISION_ENDED_KIND) return null;
    if (kind === REVISION_STARTED_KIND) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) return null;

  const start = rows[startIndex]!;
  const latest = rows[rows.length - 1]!;
  const expiresAt = new Date(latest.changedAt.getTime() + PLAN_REVISION_LEASE_MS);
  if (expiresAt.getTime() <= now.getTime()) return null;

  // The HARNESS, never the model — the same discriminator the timeline row uses
  // (Part X §4): a harness name is what a reader recognises, and the model is one
  // level of detail below what a refusal needs to say.
  return { heldBy: start.actorHarness ?? null, expiresAt };
}

/**
 * WHICH JOB HOLDS THE LEASE, or `null` when nothing holds it or the holder is not a
 * job (Bug MOTIR-8352). A hosted revision's acquire records its motir-ai job on the
 * `revision_started` row's diff (`{ jobId }`); an MCP `hold_plan_revision` holder
 * records none. So a conversation can tell ITS OWN running revision — the one its
 * `lastJobId` names — from somebody else's, by the lease rather than by the plan's
 * `sourceJobId`, which an MCP hold leaves pointing at the walk that wrote the plan.
 *
 * Same rows and same order contract as {@link revisionLeaseOf}, whose verdict on
 * whether the lease is held this follows exactly.
 */
export function revisionLeaseJobId(rows: readonly RevisionLeaseRow[], now: Date): string | null {
  if (!revisionLeaseOf(rows, now)) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]!.changeKind !== REVISION_STARTED_KIND) continue;
    const diff = rows[i]!.diff;
    const jobId =
      typeof diff === 'object' && diff !== null
        ? (diff as Record<string, unknown>)['jobId']
        : undefined;
    return typeof jobId === 'string' && jobId.length > 0 ? jobId : null;
  }
  return null;
}

/**
 * The `diff` key a `revision_started` row carries when its acquire RE-OPENED the
 * plan (Bug MOTIR-8208): the status the plan held before the revision moved it to
 * `generating`, and so the status the revision's end gives back.
 */
export const REVISION_REOPENED_FROM_KEY = 'reopenedFrom';

/**
 * WHICH STATUS AN OPEN REVISION RE-OPENED THE PLAN FROM, or `null` when the open
 * revision did not re-open it — or no revision is open (Bug MOTIR-8208).
 *
 * A revision of a `planned` plan moves it back to `generating` for as long as the
 * revision runs, so its steps, notes and appends land on a plan that is being
 * written, and its end closes the plan again. The status it came from is recorded
 * on the `revision_started` row that moved it, and this reads it back.
 *
 * ⚠️ IT READS THE WHOLE OPEN CHAIN, not only the latest start. A revision whose
 * lease LAPSED and was taken again writes a second `revision_started` over a plan
 * that is already `generating`, which carries no `reopenedFrom` of its own — and
 * the plan still has to go back to `planned` when that second revision ends. So
 * the walk runs backwards to the first `revision_ended` and answers the
 * `reopenedFrom` of any start inside that chain.
 *
 * Pure, and independent of the lease WINDOW: a lapsed revision that re-opened its
 * plan still owes the plan its status back, which is exactly the case the failure
 * settle and the abandoned-plan sweep exist for. `rows` is oldest first, as
 * {@link revisionLeaseOf} requires.
 */
export function revisionReopenedFrom(
  rows: readonly RevisionLeaseRow[],
): 'planned' | 'stopped' | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.changeKind === REVISION_ENDED_KIND) return null;
    if (row.changeKind !== REVISION_STARTED_KIND) continue;
    const diff = row.diff;
    const from =
      diff !== null && typeof diff === 'object'
        ? (diff as Record<string, unknown>)[REVISION_REOPENED_FROM_KEY]
        : undefined;
    // A `stopped` plan (Bug MOTIR-11701) is re-opened too — the hold an MCP walk's
    // resume takes — and is given back `stopped` unless its close finished the walk.
    if (from === 'planned' || from === 'stopped') return from;
  }
  return null;
}

/**
 * Whether a plan is `generating` because an open revision RE-OPENED it (Bug
 * MOTIR-8208) — what tells a plan being REVISED from one being generated for the
 * first time, for the readers that must treat the two differently (the
 * abandoned-plan sweep, a conversation's next turn, the failure settle).
 */
export function isReopenedByRevision(
  plan: { status: string },
  trail: readonly RevisionLeaseRow[],
): boolean {
  return plan.status === 'generating' && revisionReopenedFrom(trail) !== null;
}
