// THE ONE PROGRESS DERIVATION for a `generating` plan (Story MOTIR-7820 ·
// Subtask MOTIR-7825; design `design/ai-planning/design-notes.md` Part XXVI).
//
// ⚠️ EVERY SURFACE THAT SHOWS A PLAN'S PROGRESS READS IT FROM HERE, BY NAME.
// The progress line (pane and compact form), the canvas cues and the Workbench ›
// Planning row all take a `PlanProgressSnapshot` built by
// `buildPlanProgressSnapshot` and read it through `readPlanProgress`. NONE of
// them may compare a timestamp to the threshold, filter the raw `inFlightSteps`,
// choose a step phrase, or count `add`s on its own — that is exactly how the tab
// row and the plan surface would come to disagree (a dead session drafting on
// the canvas while the line says stalled; "3 of 7" on the tab and "4 of 7" on
// the plan). A new surface imports these two functions; it does not grow a
// third derivation.
//
// The account is TWO HALVES on purpose, and a THIRD thing read off them:
//   1. a SNAPSHOT, built on the server and independent of time — the resolved
//      steps (each with its PHRASE, its target's title and canvas node id),
//      "N of M authored", the plan's start, its last activity, and the server
//      instant it was built at. Titles and counts need the rows, so they cannot
//      be computed in a browser for the tab's list.
//   2. a CLOCK READING, a pure function of (snapshot, now) — the state, the steps
//      still live at `now`, elapsed, time since last activity. Stalled and
//      elapsed keep moving between 2.5 s polls (and across a dropped one), so
//      they cannot be frozen into the server's answer. A ticking client calls it
//      with `serverNow(…)`; the server calls it with server time.
//   3. the AT-WORK STATE (Story MOTIR-8413 · MOTIR-8415; design
//      `design/ai-chat/design-notes.md` § "Motir at work"), a pure function of
//      (reading | null, failing) — whether Motir is writing right now, and which
//      cards it is writing, for the two things that MOVE while it does: the
//      drafted card's cue and the Motir mark. It WIDENS `PlanProgressState` with
//      the two facts a reading cannot express — `settled` (no snapshot: the plan
//      is no longer `generating`) and `reconnecting` (the poll's reads are
//      failing) — and gates the steps for motion. That gate is NOT
//      `liveSteps.length > 0`: while a read fails the clock HOLDS `liveSteps`,
//      so the words and the static cue keep standing while the motion stops.
//
//      | input                                   | state          | atWork | steps            |
//      | --------------------------------------- | -------------- | ------ | ---------------- |
//      | `failing`                               | `reconnecting` | false  | `[]`             |
//      | `reading === null`                      | `settled`      | false  | `[]`             |
//      | `stalled`                               | `stalled`      | false  | `[]`             |
//      | `resuming`                              | `resuming`     | false  | `[]`             |
//      | `starting`                              | `starting`     | true   | `[]` (none exist) |
//      | `working` · `writing`                   | same value     | true   | `liveSteps`      |
//
// PURE AND ISOMORPHIC: no `db`, no `Date.now()` default, no React, no copy. The
// words a phrase reads as are the design's copy keys (`PLAN_STEP_PHRASE_MESSAGE_KEY`),
// rendered by the progress line through `next-intl`.
//
// SERVER TIME IS THE ONLY CLOCK. `startedAt`, `lastActivityAt`, `observedAt` and
// every step's `startedAt` are server instants; a client reads them through
// `serverNow`, never against its raw `Date.now()`, so a skewed laptop clock can
// neither make a live plan read stalled nor a stalled one read live.

import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { isProposalWritten } from '@/lib/plans/proposalWritten';
import type { PlanStepDto, PlanStepKindDto, PlanStepProviderWaitDto } from '@/lib/dto/plans';

/**
 * THE stalled threshold — design Part XXVI §26.9: **15 minutes**, measured (the
 * longest healthy quiet stretch observed on real walks was 582 s, so the
 * story's assumed 10 minutes left 3 % headroom). That figure is a gap between
 * WRITES; a single step can run far longer than it — a hosted lay session on a
 * large story spent 17 m 41 s before its first child (MOTIR-11184) — which is
 * why neither use below measures a step's age. It has TWO uses and they are
 * deliberately the same number:
 *   1. the plan is `stalled` when `now − lastActivityAt > PLAN_STALLED_AFTER_MS`
 *      (equal is NOT stalled; +1 ms is);
 *   2. a single step is dropped as QUIET when `now − step.lastActivityAt >
 *      PLAN_STALLED_AFTER_MS` — its LAST SIGN OF LIFE, the latest of its start,
 *      its provider-wait report, its session's newest narration and the newest
 *      write it made ({@link stepLastActivity}). Author sessions that start
 *      together narrate throughout but write their target late, so the
 *      narration is what keeps their Drafting cues up. A session that died
 *      without clearing stops naming an item even while its siblings keep the
 *      plan alive; one still writing under its target stays named however long
 *      ago it started.
 * The abandoned-plan sweep's DEAD rule reads it too (MOTIR-8132), with the same
 * comparison, so the rail's `stalled` and the sweep's `silent` cannot disagree.
 * A plan RESUMED AUTOMATICALLY (MOTIR-8309) is measured from the resume, for free:
 * the resume's bind stamps `lastActivityAt` with the resume's own instant.
 * Re-measure and change THIS constant; never a surface.
 */
export const PLAN_STALLED_AFTER_MS = 900_000;

/**
 * How long past its `retryAt` a session's provider-retry wait still reads
 * (Story MOTIR-9540 · MOTIR-9619). The walk clears a wait on every way out of
 * it, so this only bounds a job that DIED mid-wait — the case the step's own
 * quiet drop takes {@link PLAN_STALLED_AFTER_MS} to catch.
 */
export const PLAN_PROVIDER_WAIT_GRACE_MS = 300_000;

/**
 * WHICH words a step reads as. A derivation, not a string — it depends on the
 * step's kind, on whether a target exists, and on whether it still resolves —
 * so it is chosen once, here, and rendered by the line in the reader's locale.
 *
 * | kind     | targetRef           | phrase              |
 * | -------- | ------------------- | ------------------- |
 * | settle   | null                | `settling`          |
 * | lay      | null                | `layingTopLevel`    |
 * | lay      | resolves            | `layingChildrenOf`  |
 * | author   | null                | `draftingNew`       |
 * | author   | resolves            | `authoring`         |
 * | amend    | null                | `amendingTopLevel`  |
 * | amend    | resolves            | `amendingChildrenOf`|
 * | check    | null                | `checkingPlan`      |
 * | check    | resolves            | `checkingCard`      |
 * | repair   | null or resolves    | `repairing`         |
 * | any else | set, resolves to ∅  | — DROPPED           |
 *
 * `amend`, `check` and `repair` are MOTIR-11256's: a laid level's amend, the
 * plan's final check and the fix after it, which used to read as laying.
 */
export type PlanStepPhrase =
  | 'settling'
  | 'layingTopLevel'
  | 'layingChildrenOf'
  | 'authoring'
  | 'draftingNew'
  | 'amendingTopLevel'
  | 'amendingChildrenOf'
  | 'checkingPlan'
  | 'checkingCard'
  | 'repairing';

/** The phrase of a step with no target (or, for `settle`, the only one it has). */
const UNTARGETED_PHRASE: Record<PlanStepKindDto, PlanStepPhrase> = {
  settle: 'settling',
  lay: 'layingTopLevel',
  author: 'draftingNew',
  amend: 'amendingTopLevel',
  check: 'checkingPlan',
  repair: 'repairing',
};

/** The phrase of a step whose target resolved. `settle` never has one. */
const TARGETED_PHRASE: Record<Exclude<PlanStepKindDto, 'settle'>, PlanStepPhrase> = {
  lay: 'layingChildrenOf',
  author: 'authoring',
  amend: 'amendingChildrenOf',
  check: 'checkingCard',
  repair: 'repairing',
};

/**
 * The design's copy key for each phrase (Part XXVI §26.13). TOTAL over
 * {@link PlanStepPhrase}, so a sixth phrase fails the compiler here rather than
 * rendering a blank on the line.
 */
export const PLAN_STEP_PHRASE_MESSAGE_KEY: Record<PlanStepPhrase, string> = {
  settling: 'planReview.progress.settling',
  layingTopLevel: 'planReview.progress.layingTopLevel',
  layingChildrenOf: 'planReview.progress.layingChildrenOf',
  authoring: 'planReview.progress.authoring',
  draftingNew: 'planReview.progress.draftingNew',
  amendingTopLevel: 'planReview.progress.amendingTopLevel',
  amendingChildrenOf: 'planReview.progress.amendingChildrenOf',
  checkingPlan: 'planReview.progress.checkingPlan',
  checkingCard: 'planReview.progress.checkingCard',
  repairing: 'planReview.progress.repairing',
};

/** One in-flight step, resolved. `targetNodeId` / `targetTitle` are null
 *  EXACTLY for the untargeted phrases (`settling`, `layingTopLevel`, `draftingNew`,
 *  `amendingTopLevel`, `checkingPlan`, and an untargeted `repairing`). */
export interface PlanProgressStep {
  sessionKey: string;
  kind: PlanStepKindDto;
  phrase: PlanStepPhrase;
  /** The ref exactly as the planner sent it (`planItem:<id>`, a work-item id, or null). */
  targetRef: string | null;
  /** The canvas node the step names — `PlanReviewItemDto.nodeId`'s rule. */
  targetNodeId: string | null;
  targetTitle: string | null;
  /** Server instant (ISO). The step's IDENTITY and ORDER key — never re-stamped. */
  startedAt: string;
  /**
   * The step's last sign of life (server ISO): the latest of `startedAt`, its
   * provider-wait report, its session's newest narration and the newest write
   * under or to its target ({@link stepLastActivity}). Read ONLY by the
   * quiet drop; identity and order stay on `startedAt` (MOTIR-11184).
   */
  lastActivityAt: string;
  /** The session's provider-retry wait (MOTIR-9619), `null` when it is not waiting. */
  providerWait: PlanStepProviderWaitDto | null;
}

/** The time-independent half — built once, on the server. */
export interface PlanProgressSnapshot {
  /** `Plan.createdAt` (ISO) — elapsed counts from here (design §26.2). */
  startedAt: string;
  /** `Plan.lastActivityAt` (ISO). */
  lastActivityAt: string;
  /** The SERVER instant this snapshot was built at (ISO) — `serverNow`'s anchor. */
  observedAt: string;
  /** N — the `add`s that are WRITTEN ({@link countAuthored}). */
  authored: number;
  /** M — the plan's `add`s. */
  proposed: number;
  /** Ordered by `startedAt`, ties by `sessionKey` — the design's "earliest in words" order. */
  steps: PlanProgressStep[];
  /**
   * The session's LATEST automatic resume (MOTIR-8309; design Part XXVII) — its
   * server instant (ISO, `PlanChangeSession.lastAutoResumedAt`) and the session's
   * `autoResumeCount`. `null` when the plan's session was never resumed
   * automatically, or the plan has no session.
   */
  autoResume: PlanAutoResume | null;
}

export interface PlanAutoResume {
  at: string;
  count: number;
}

export type PlanProgressState = 'starting' | 'working' | 'writing' | 'stalled' | 'resuming';

/** The time-dependent half — `readPlanProgress(snapshot, now)`. */
export interface PlanProgressReading {
  state: PlanProgressState;
  /** The steps still live at `now` (none when stalled), in the snapshot's order. */
  liveSteps: PlanProgressStep[];
  authored: number;
  proposed: number;
  elapsedMs: number;
  sinceActivityMs: number;
  lastActivityAt: string;
  /** The snapshot's {@link PlanProgressSnapshot.autoResume}, passed through for the popover. */
  autoResume: PlanAutoResume | null;
  /**
   * The provider-retry wait the overlay's banner reads (MOTIR-9619): the one
   * with the LATEST `retryAt` across the snapshot's steps — all of them, not only
   * the live ones — among waits no more than {@link PLAN_PROVIDER_WAIT_GRACE_MS}
   * past their `retryAt`. `null` when no step waits, and when `stalled`.
   */
  providerWait: PlanStepProviderWaitDto | null;
}

/**
 * What the derivation needs from ONE `add` row — its identity and whether it is
 * WRITTEN, never its body. The SAME shape `planItemRepository.findProgressRowsByPlanIds`
 * computes in SQL and {@link progressRowOfAdd} computes from an in-memory plan
 * item, so both paths hand over the one flag and cannot disagree.
 */
export interface PlanProgressAddRow {
  id: string;
  workItemId: string | null;
  parentRef: string | null;
  kind: string | null;
  title: string;
  /** The stored `authorFinished` read through `isProposalWritten` — the SQL path's exact twin. */
  authorFinished: boolean;
}

/**
 * One proposal's LAST WRITE, as the quiet drop reads it (MOTIR-11184): the
 * proposal's identity, the refs that say which step's target it is under or is,
 * and when it was last written — the later of its append and its latest `edited`
 * timeline row. ANY op, because an author step on a committed card writes a
 * `modify`. The SAME shape `planItemRepository.findWriteRowsByPlanIds` computes in
 * SQL for both snapshot doors.
 */
export interface PlanProgressWriteRow {
  id: string;
  op: string;
  workItemId: string | null;
  parentRef: string | null;
  writtenAt: string | Date;
}

/**
 * One session's NEWEST narration sentence (MOTIR-11184): a session that is still
 * talking is still working, whether or not it has written its target yet. Keyed
 * by the `session_key` the step row carries.
 */
export interface PlanProgressNarrationRow {
  sessionKey: string;
  narratedAt: string | Date;
}

// ── The authored test ─────────────────────────────────────────────────────────
//
// "N authored" answers *has its author session finished writing it?* (Story
// MOTIR-10413 · MOTIR-10496), and the answer is the stored fact, `authorFinished`
// on the proposal — the same one `get_plan_authoring_state` and `validate_plan`'s
// `notYetWritten` read. It used to be a body test mirrored from motir-ai's walk
// completeness (a description, an explanation when the pass owed one, and on a
// leaf its sizing); a boundary-only card then read authored wherever explanations
// were off, and a body a failed session left read authored everywhere. The
// project's explanation setting therefore no longer matters to this number.

/**
 * N of M. **M** = the plan's `add` rows (pass ONLY adds — a `modify` / `remove`
 * is in neither number). **N** = those that are written (`authorFinished`).
 */
export function countAuthored(addRows: readonly PlanProgressAddRow[]): {
  authored: number;
  proposed: number;
} {
  let authored = 0;
  for (const row of addRows) if (row.authorFinished) authored += 1;
  return { authored, proposed: addRows.length };
}

/**
 * Whether an `add` owes `explanationMd` to be COMPLETE. `mcp` → always (its
 * runbook owes both bodies); every other source — `native`, a cadence plan,
 * `null` — → the project's `aiGenerateExplanations`. Read by the one-time
 * `authorFinished` carry-over (MOTIR-10491), which judged an open plan's cards
 * complete under the plan's own rule; the count no longer reads it.
 */
export function requireExplanationFor(args: {
  authorSource: string | null;
  projectAiGenerateExplanations: boolean;
}): boolean {
  return args.authorSource === 'mcp' ? true : args.projectAiGenerateExplanations;
}

/**
 * The in-memory twin of `findProgressRowsByPlanIds`'s SQL — the review read
 * already holds the plan's items, so it derives the same flag without a query.
 */
export function progressRowOfAdd(item: {
  id: string;
  workItemId: string | null;
  parentRef: string | null;
  proposedFields: Record<string, unknown> | null;
}): PlanProgressAddRow {
  const f = item.proposedFields ?? {};
  return {
    id: item.id,
    workItemId: item.workItemId,
    parentRef: item.parentRef,
    kind: typeof f.kind === 'string' ? f.kind : null,
    title: typeof f.title === 'string' ? f.title : '',
    authorFinished: isProposalWritten(f),
  };
}

// ── The snapshot ──────────────────────────────────────────────────────────────

const iso = (v: string | Date): string => (typeof v === 'string' ? v : v.toISOString());

/** Whether `write` is a write the step makes — the table on {@link stepLastActivity}. */
function isStepWrite(
  step: { kind: PlanStepKindDto; targetRef: string | null },
  write: PlanProgressWriteRow,
): boolean {
  // An amend writes where a lay does: the cards it adds land on the level it reconciles.
  if (step.kind === 'lay' || step.kind === 'amend') {
    return write.op === 'add' && write.parentRef === step.targetRef;
  }
  if (step.kind !== 'author' || step.targetRef === null) return false;
  if (step.targetRef.startsWith(TEMP_REF_PREFIX)) {
    return write.id === step.targetRef.slice(TEMP_REF_PREFIX.length);
  }
  return write.workItemId === step.targetRef;
}

/**
 * A step's LAST SIGN OF LIFE (MOTIR-11184): the latest of its `startedAt`, its
 * provider-wait report (`providerWait.since`), its session's newest narration
 * (`narratedAt`) and the newest write it makes. A step is reported ONCE, when its
 * session starts, so its start says nothing about whether it is still working —
 * its session's sentences and the plan's own items do. The narration is the
 * author signal: parallel author sessions narrate throughout and may not write
 * their target for longer than the threshold. The writes are the lay signal.
 *
 * The writes that count:
 *
 * | kind     | targetRef            | the writes that count                          |
 * | -------- | -------------------- | ---------------------------------------------- |
 * | lay      | a ref R              | the `add`s whose `parentRef` is R              |
 * | lay      | null                 | the top-level `add`s (`parentRef` null)        |
 * | amend    | as `lay`             | as `lay` — the cards it adds to its level      |
 * | author   | `planItem:<id>`      | that proposal                                  |
 * | author   | a work-item id W     | the proposals ON W (`workItemId` W)            |
 * | author   | null · settle        | none — its start                               |
 * | check · repair | any            | none — its start (a check writes nothing; a    |
 * |          |                      | fix's writes are anywhere, so none is its own) |
 *
 * A write older than the start never moves it back, so a step that writes
 * nothing is measured from its start exactly as before.
 */
export function stepLastActivity(
  step: {
    kind: PlanStepKindDto;
    targetRef: string | null;
    startedAt: string | Date;
    providerWait?: { since: string } | null;
  },
  writes: readonly PlanProgressWriteRow[],
  narratedAt: string | Date | null = null,
): string {
  let latest = iso(step.startedAt);
  let latestMs = Date.parse(latest);
  const consider = (v: string | Date) => {
    const at = iso(v);
    const atMs = Date.parse(at);
    if (atMs > latestMs) {
      latest = at;
      latestMs = atMs;
    }
  };
  if (step.providerWait) consider(step.providerWait.since);
  if (narratedAt !== null) consider(narratedAt);
  for (const write of writes) {
    if (isStepWrite(step, write)) consider(write.writtenAt);
  }
  return latest;
}

/**
 * Build the time-independent half. Each step resolves by the phrase table:
 * - a NULL target is KEPT with its untargeted phrase — a real state of both
 *   walks (an untargeted plan's root lay, a no-id author session), never a
 *   missing value;
 * - `planItem:<id>` → that `add`'s title, node id = its `workItemId` if
 *   materialized, else the PlanItem id (`PlanReviewItemDto.nodeId`'s rule);
 * - a work-item id → its title from `committedTitles`, node id = that id;
 * - a SET target that no longer resolves is DROPPED: a withdrawn `planItem:`
 *   (withdrawal deletes the row) or a committed id with no title. Naming it
 *   would point the canvas at nothing.
 * - with `autoResume` set, a step that STARTED BEFORE the resume is DROPPED: it
 *   is the lost machine's own row, never cleared, and naming it would say a
 *   dead session is authoring an item (MOTIR-8309). Dropping it HERE, not at
 *   read time, keeps the canvas cues and the words on one list.
 * Each kept step carries its `lastActivityAt` from `writes`, its session's
 * newest narration in `narrations` and its provider wait
 * ({@link stepLastActivity}); with none of them it is the step's start.
 * Steps are ordered by `startedAt`, ties by `sessionKey`.
 */
export function buildPlanProgressSnapshot(args: {
  plan: { createdAt: string | Date; lastActivityAt: string | Date };
  steps: readonly PlanStepDto[];
  addRows: readonly PlanProgressAddRow[];
  committedTitles: ReadonlyMap<string, string>;
  observedAt: string | Date;
  autoResume?: { at: string | Date; count: number } | null;
  /** Every proposal's last write ({@link PlanProgressWriteRow}) — the quiet drop's input. */
  writes?: readonly PlanProgressWriteRow[];
  /** Each session's newest narration ({@link PlanProgressNarrationRow}) — the author signal. */
  narrations?: readonly PlanProgressNarrationRow[];
}): PlanProgressSnapshot {
  const writes = args.writes ?? [];
  const narratedAt = new Map((args.narrations ?? []).map((n) => [n.sessionKey, n.narratedAt]));
  const addById = new Map(args.addRows.map((r) => [r.id, r]));
  const autoResume = args.autoResume
    ? { at: iso(args.autoResume.at), count: args.autoResume.count }
    : null;
  const resumedAtMs = autoResume ? Date.parse(autoResume.at) : null;
  const resolved: PlanProgressStep[] = [];
  for (const step of args.steps) {
    if (resumedAtMs !== null && Date.parse(iso(step.startedAt)) < resumedAtMs) continue;
    const base = {
      sessionKey: step.sessionKey,
      kind: step.kind,
      targetRef: step.targetRef,
      startedAt: iso(step.startedAt),
      lastActivityAt: stepLastActivity(step, writes, narratedAt.get(step.sessionKey) ?? null),
      providerWait: step.providerWait ?? null,
    };
    if (step.kind === 'settle' || step.targetRef === null) {
      resolved.push({
        ...base,
        phrase: UNTARGETED_PHRASE[step.kind],
        targetNodeId: null,
        targetTitle: null,
      });
      continue;
    }
    let target: { nodeId: string; title: string } | null = null;
    if (step.targetRef.startsWith(TEMP_REF_PREFIX)) {
      const add = addById.get(step.targetRef.slice(TEMP_REF_PREFIX.length));
      if (add) target = { nodeId: add.workItemId ?? add.id, title: add.title };
    } else {
      const title = args.committedTitles.get(step.targetRef);
      if (title !== undefined) target = { nodeId: step.targetRef, title };
    }
    if (!target) continue; // withdrawn / gone — dropped
    resolved.push({
      ...base,
      phrase: TARGETED_PHRASE[step.kind],
      targetNodeId: target.nodeId,
      targetTitle: target.title,
    });
  }
  resolved.sort((a, b) => {
    const d = Date.parse(a.startedAt) - Date.parse(b.startedAt);
    if (d !== 0) return d;
    return a.sessionKey < b.sessionKey ? -1 : a.sessionKey > b.sessionKey ? 1 : 0;
  });
  const { authored, proposed } = countAuthored(args.addRows);
  return {
    startedAt: iso(args.plan.createdAt),
    lastActivityAt: iso(args.plan.lastActivityAt),
    observedAt: iso(args.observedAt),
    authored,
    proposed,
    steps: resolved,
    autoResume,
  };
}

// ── The clock reading ─────────────────────────────────────────────────────────

/**
 * Read a snapshot at `nowMs` (a SERVER-time instant — `serverNow(…)` on a
 * client). Precedence: `stalled` (quiet past the threshold; no live steps) →
 * `resuming` (Motir resumed the plan by itself and its new job has neither
 * signalled nor written since: `lastActivityAt` has not moved past the resume's
 * own stamp, and no step started at or after it — design Part XXVII §27.6) →
 * `working` (any live step) → `starting` (nothing proposed yet) → `writing`
 * (a planner between steps, or one that never signals: counts and times, no
 * step words, no cue).
 *
 * `resuming` is an EQUALITY test, not a tolerance: the automatic resume records
 * its instant with the same `now` the bind stamps on the plan's activity.
 */
export function readPlanProgress(
  snapshot: PlanProgressSnapshot,
  nowMs: number,
): PlanProgressReading {
  const sinceActivityMs = Math.max(0, nowMs - Date.parse(snapshot.lastActivityAt));
  const elapsedMs = Math.max(0, nowMs - Date.parse(snapshot.startedAt));
  const common = {
    authored: snapshot.authored,
    proposed: snapshot.proposed,
    elapsedMs,
    sinceActivityMs,
    lastActivityAt: snapshot.lastActivityAt,
    autoResume: snapshot.autoResume,
  };
  if (sinceActivityMs > PLAN_STALLED_AFTER_MS) {
    return { ...common, state: 'stalled', liveSteps: [], providerWait: null };
  }
  // The QUIET drop — a session that died without clearing stops naming an item.
  // Measured from the step's LAST SIGN OF LIFE, never its start (MOTIR-11184).
  const liveSteps = snapshot.steps.filter(
    (s) => nowMs - lastSignOfLifeMs(s) <= PLAN_STALLED_AFTER_MS,
  );
  const resuming =
    snapshot.autoResume !== null &&
    liveSteps.length === 0 &&
    Date.parse(snapshot.lastActivityAt) <= Date.parse(snapshot.autoResume.at);
  const state: PlanProgressState = resuming
    ? 'resuming'
    : liveSteps.length > 0
      ? 'working'
      : snapshot.proposed === 0
        ? 'starting'
        : 'writing';
  return { ...common, state, liveSteps, providerWait: providerWaitAt(snapshot.steps, nowMs) };
}

/**
 * The instant the quiet drop measures from: the step's `lastActivityAt`, never
 * earlier than its start. A snapshot without the field — one a server built
 * before MOTIR-11184, read by a newer client mid-deploy — falls back to the start,
 * which is exactly the old rule.
 */
function lastSignOfLifeMs(step: PlanProgressStep): number {
  const startedMs = Date.parse(step.startedAt);
  const activityMs = Date.parse(step.lastActivityAt);
  return Number.isNaN(activityMs) ? startedMs : Math.max(startedMs, activityMs);
}

/**
 * The wait a reading carries (MOTIR-9619). Read from ALL the snapshot's steps:
 * a wait report never re-stamps `startedAt`, so a session whose step began more
 * than {@link PLAN_STALLED_AFTER_MS} before its 429 is out of `liveSteps` while
 * still waiting. The grace bounds a dead job's wait instead.
 */
function providerWaitAt(
  steps: readonly PlanProgressStep[],
  nowMs: number,
): PlanStepProviderWaitDto | null {
  let latest: PlanStepProviderWaitDto | null = null;
  for (const step of steps) {
    const wait = step.providerWait;
    if (!wait) continue;
    const retryAtMs = Date.parse(wait.retryAt);
    if (nowMs - retryAtMs > PLAN_PROVIDER_WAIT_GRACE_MS) continue;
    if (latest === null || retryAtMs > Date.parse(latest.retryAt)) latest = wait;
  }
  return latest;
}

/**
 * The client's clock, held to SERVER time: the snapshot's `observedAt` advanced
 * by how long the client has held it (`clientNowMs − receivedAtMs`, both on the
 * client's own clock, so its skew cancels). Pass the result to
 * {@link readPlanProgress}.
 */
export function serverNow(observedAt: string, receivedAtMs: number, clientNowMs: number): number {
  return Date.parse(observedAt) + Math.max(0, clientNowMs - receivedAtMs);
}

// ── The at-work state ─────────────────────────────────────────────────────────

/**
 * The reading's state WIDENED by what the reading cannot say: `settled` (there is
 * no snapshot, because the plan is no longer `generating`) and `reconnecting`
 * (the poll's reads are failing). The reading's own values keep their names.
 */
export type PlanAtWorkState = PlanProgressState | 'settled' | 'reconnecting';

export interface PlanAtWorkReading {
  state: PlanAtWorkState;
  /** Whether Motir is writing right now — what lets the cue and the mark MOVE. */
  atWork: boolean;
  /** The steps whose cards may move: the reading's `liveSteps` while at work, else `[]`. */
  steps: PlanProgressStep[];
}

/**
 * Whether each state moves. TOTAL over {@link PlanAtWorkState}, so a value added
 * to `PlanProgressState` is a compile error here until somebody decides whether
 * it moves, rather than falling silently into `writing`.
 */
export const PLAN_AT_WORK_MOVES: Record<PlanAtWorkState, boolean> = {
  starting: true,
  working: true,
  writing: true,
  stalled: false,
  resuming: false,
  settled: false,
  reconnecting: false,
};

/**
 * THE AT-WORK STATE — the one rule both the drafted card and the Motir mark read
 * (header, part 3). `failing` wins over everything (the shipped marker's own
 * precedence), then a null reading is `settled`, then the reading's state. It
 * never mutates `reading`: a surface still reads the held `liveSteps` for its
 * words and its static cue. Reporting a state is not an instruction to animate —
 * whether motion plays stays the surface's opt-in and the CSS reduced-motion gate.
 */
export function readPlanAtWork(
  reading: PlanProgressReading | null,
  opts: { failing?: boolean } = {},
): PlanAtWorkReading {
  const state = atWorkStateOf(reading, opts.failing === true);
  const atWork = PLAN_AT_WORK_MOVES[state];
  return { state, atWork, steps: atWork && reading ? [...reading.liveSteps] : [] };
}

function atWorkStateOf(reading: PlanProgressReading | null, failing: boolean): PlanAtWorkState {
  if (failing) return 'reconnecting';
  if (reading === null) return 'settled';
  switch (reading.state) {
    case 'starting':
    case 'working':
    case 'writing':
    case 'stalled':
    case 'resuming':
      return reading.state;
    default: {
      const unhandled: never = reading.state;
      return unhandled;
    }
  }
}
