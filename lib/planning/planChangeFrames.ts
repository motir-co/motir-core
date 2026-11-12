// THE FRAME CONTRACT (Story MOTIR-4054 · MOTIR-4069) — what a planning run can
// say, and what the rail does with each thing it says.
//
// ⚠️ THIS FILE EXISTS BECAUSE THE CONTRACT DID NOT. MOTIR-4069 asks for a
// renderer that is TOTAL "over the frame contract … enumerated from the contract,
// never from a hand-written list". There was nothing to enumerate from: a frame's
// kind is a bare `string` on both sides of the wire — `motir-ai`'s emitter is
// `(event: string, data: unknown) => Promise<void>` — so no union, no enum and no
// schema existed in either repository. The card's premise was false in a way that
// is only visible from here, and this module is the repair: the enumeration has
// to live SOMEWHERE before anything can be total over it.
//
// ⚠️ AND THE NUMBERS ARE WORSE THAN THE CARD SAYS. It reports that `retrieval`
// narrates nothing. Swept across `motir-ai`'s `origin/main` — every `emit(…)`,
// `signal(…)` and `event:` literal — the producer emits **51 distinct kinds**,
// and `narrateFrame` handled **seven**. Forty-four were dropped through
// `default: return null`, silently, with no signature: nothing threw, nothing
// logged, the rail simply said less than the run did.
//
// ── WHY A MAP, AND WHY `Record` ─────────────────────────────────────────────
// `FRAME_DISPOSITIONS` is typed `Record<PlanChangeFrameKind, FrameDisposition>`,
// so a kind added to {@link PLAN_CHANGE_FRAME_KINDS} without a disposition is a
// COMPILE ERROR. That is stronger than a test: the renderer and the enumeration
// cannot drift apart, because they are the same object. The card's warning —
// "or the test drifts the same way the renderer did" — is answered by there being
// nothing for the test to hold its own copy of.
//
// ── TOTAL MEANS ACCOUNTED FOR, NOT SHOWN ────────────────────────────────────
// The card's own words are that "the renderer accounts for every frame kind",
// and the distinction is load-bearing. A line for all 51 would make the rail a
// LOG, which `design/ai-chat/plan-change-run-live.mock.html` sheet 3 rejects in
// as many words — "a rail read line-by-line is a log, not narration". So a
// disposition is either SHOW (a drawn act line) or QUIET (a decision, with the
// reason written down). What is forbidden is neither: a kind that falls through.
//
// ⚠️ WHAT THIS FILE CANNOT DO, said plainly rather than left to be discovered:
// it does not track `motir-ai` by itself. The list below is a SNAPSHOT of a
// sweep. Two things cover the future, and neither is the user's screen
// (MOTIR-8158): `narrateFrame` draws NOTHING for a kind that is not listed and
// logs a `console.warn` for a developer, and `tests/planning/frameKindParity.test.ts`
// fails when the checked-in list of kinds `motir-ai` emits names one this map has
// no disposition for. An unlisted frame used to be drawn raw as `frame: <name>`.
//
// ⚠️ AND THE CHECK THAT CATCHES A NEW KIND RUNS IN motir-ai, WHERE THE KIND IS
// WRITTEN (MOTIR-10427). Core's parity test reads a checked-in copy of what
// motir-ai emits, and nothing made anyone refresh it: by 2026-11-05 six real kinds
// had shipped unlisted. So core PUBLISHES what it accepts —
// `contracts/plan-change-frame-kinds.json`, generated from this file by
// `pnpm generate:plan-change-frame-kinds` and held fresh by the parity test — and
// motir-ai's CI sweeps its own source against core's `main` copy of it
// (`pnpm check:frame-kinds`). A motir-ai pull request that emits a kind with no
// disposition here goes red there, so the disposition lands in core FIRST.
//
// ⚠️ TWO KINDS JOINED THE LIST AHEAD OF THEIR PRODUCER, NOT FROM A SWEEP
// (Story MOTIR-7974 · MOTIR-7976): `tool_call` and `tool_call_failed`. No
// `motir-ai` emitted either when they were added. They are the per-call frame
// contract below, accepted here FIRST so the consumer is ready before the
// producer talks — which is the opposite order from every other entry, and the
// reason a re-run of the sweep will not find them until the emitters land.
//
// ── THE PER-CALL WIRE CONTRACT (MOTIR-7974) ─────────────────────────────────
// The motir-ai emitters (MOTIR-7977 for retrieval calls, MOTIR-7978 for the
// walk's own session tools) send EXACTLY these field names. motir-ai sends
// STRUCTURE only — it never formats a sentence and never sees a locale; the
// words are motir-core's message catalogues.
//
//   event: tool_call            — emitted AS THE CALL STARTS
//     { callId: string,         // unique within the job
//       tool: string,           // the raw tool name, always present
//       family: string,         // one of TOOL_CALL_FAMILIES
//       verb: string,           // one of TOOL_CALL_VERBS
//       object: { kind: 'path' | 'query' | 'item' | 'parent' | 'none', value?: string },
//       itemRef?: string | null }  // the item the calling AUTHOR session is writing
//                                  // (its key, or its title when it has no key yet)
//
//   event: retrieval            — UNCHANGED as shipped, the AFTER-call audit:
//     { tool, family, ok, args, blocked?, callId?: string }
//     A `callId` joins it to its `tool_call`: `ok: false` marks that call
//     FAILED, `blocked: true` (an older producer's shape) marks it SKIPPED, and a
//     success draws nothing more — the call's line already says it.
//
//   event: tool_call_failed     — a refused or erroring WALK WRITE
//     { callId: string, reason: 'refused' | 'error', code?: string }
//     (retrieval calls report through `retrieval.ok` instead).
//
// A value outside its closed set is not an error on the wire: the rail reads it
// as `null` and shows the family's — or the generic — line. Nothing here throws.

import type { PlanChangeProgress } from '@/lib/hooks/usePlanChangeConversation';

/**
 * Every frame kind `motir-ai` emits, from every call shape: `ctx.emit(…)`,
 * `sink.signal(…)`, `safeEmit(…)` and the `{ event: … }` literals the handlers
 * push. First swept 2026-09-03; last brought level with motir-ai `main` on
 * 2026-11-05 (MOTIR-10427). A kind is added here BEFORE motir-ai emits it: its
 * CI refuses a kind this list does not carry.
 *
 * ⚠️ NOT ALPHABETICAL BY ACCIDENT — it is sorted so a sweep's `sort -u` output
 * diffs cleanly against it. The sweep is {@link FRAME_KIND_SWEEP}, less
 * {@link SWEEP_FALSE_MATCHES}.
 */
export const PLAN_CHANGE_FRAME_KINDS = [
  'assistant',
  'audit',
  'author',
  'clause_list',
  'code_graph',
  'comparables',
  'contextual_context',
  'contextual_scope',
  'convention',
  'conversation',
  'conversation_ack',
  'discovery_doc',
  'empty_run_reply',
  'docs',
  'done',
  'drill',
  'error',
  'explanation',
  'feasibility_doc',
  'feature_catalog',
  'gap',
  'info',
  'lay',
  'lay_stopped',
  'lessons_injected',
  'level_closed_empty',
  'level_complete',
  'model_stop',
  'neighbourhood',
  'note',
  'onboarding_depth',
  'onboarding_routing',
  'packed',
  'partition',
  'pass',
  'pending_plans',
  'plan_cleared',
  'planned',
  'planning_alarm',
  'planning_alarm_filed',
  'planning_failure_commented',
  'planning_failure_filed',
  'planning_record_attached',
  'planning_record_not_filed',
  'post_merge_move_refused',
  'post_merge_moved',
  'provenance',
  'read',
  'reauthor_target',
  'registration',
  'resume_seeded',
  'retrieval',
  'retrieval_ready',
  'revision_landed',
  'revision_seeded',
  'revisions',
  'scanner',
  'search',
  'session_summary',
  'state',
  'status',
  'target_already_covered',
  'target_failed',
  'target_read',
  'target_settled',
  'token',
  'tool_call',
  'tool_call_failed',
  'turn',
  'validate_early_ask',
  'validated',
  'validation_doc',
  'validation_skipped',
  'validity_reopen',
  'validity_unfixable',
  'vision_doc',
  'walk_position',
  'wired',
] as const;

export type PlanChangeFrameKind = (typeof PLAN_CHANGE_FRAME_KINDS)[number];

/**
 * What the rail does with one frame kind.
 *
 * `quiet` carries its REASON as a string rather than being a bare `false`,
 * because the whole failure this card repairs was a silent decision nobody
 * wrote down. A reason is what makes "we do not show this" reviewable.
 */
export type FrameDisposition =
  | { readonly show: PlanChangeProgress['kind'] }
  | { readonly quiet: string };

/** Not part of the drawn act set — the standing reason for most of the list. */
const NOT_AN_ACT = 'not one of the acts MOTIR-4066 sheet 3 draws on the rail';
/** Emitted by a job kind whose frames never reach this surface. */
const OTHER_SURFACE = 'belongs to another job kind; it does not reach the plan-change rail';
/** A lookup or tool call: the narration says what the planner is doing instead. */
const TOOL_CALL =
  'a tool call — it means nothing to the person; the planner’s narration says what it is doing';
/** Bookkeeping the run keeps for itself. */
const BOOKKEEPING = 'internal bookkeeping — it says nothing a reader of the run would act on';

/**
 * The TOTAL map. Exhaustive by type: adding a member to
 * {@link PLAN_CHANGE_FRAME_KINDS} without a line here does not compile.
 *
 * The SHOW set is the story's own sentence — *"searching, reading code, laying a
 * level, authoring a card, drilling … and the planner's own prose line"* — plus
 * the outcome frames the rail already narrated before this card.
 */
export const FRAME_DISPOSITIONS: Record<PlanChangeFrameKind, FrameDisposition> = {
  // ── THE ACTS (the story's sentence, and sheet 3's table) ──────────────────
  // No lookup is an act: see the TOOL CALLS block below.
  lay: { show: 'laying' },
  author: { show: 'authoring' },
  /** The planner's own PROSE line. The producer emits nothing at all when the
   *  text is blank (`signalNote` returns early), so "its absence is not an empty
   *  row" is guaranteed upstream as well as here. */
  note: { show: 'note' },

  // ── THE OUTCOMES (narrated before this card; unchanged by it) ─────────────
  pass: { show: 'proposed' },
  planned: { show: 'proposed' },
  level_complete: { show: 'proposed' },
  validated: { show: 'validating' },
  validation_skipped: { show: 'validating' },

  // ── ACCOUNTED FOR, AND DELIBERATELY QUIET ────────────────────────────────
  // `done` and `error` are the stream's own control frames: `consumeStream`
  // handles both before `onFrame` ever sees them, so narrating them here would
  // draw a line for an event the rail has already acted on.
  done: { quiet: 'a stream control frame, consumed by the transport before narration' },
  error: { quiet: 'a stream control frame, surfaced as the run’s error state instead' },

  assistant: { quiet: OTHER_SURFACE },
  conversation: { quiet: OTHER_SURFACE },
  turn: { quiet: OTHER_SURFACE },
  explanation: { quiet: OTHER_SURFACE },
  convention: { quiet: OTHER_SURFACE },
  scanner: { quiet: OTHER_SURFACE },
  code_graph: { quiet: OTHER_SURFACE },
  audit: { quiet: OTHER_SURFACE },
  comparables: { quiet: OTHER_SURFACE },
  discovery_doc: { quiet: OTHER_SURFACE },
  feasibility_doc: { quiet: OTHER_SURFACE },
  validation_doc: { quiet: OTHER_SURFACE },
  vision_doc: { quiet: OTHER_SURFACE },
  feature_catalog: { quiet: OTHER_SURFACE },
  docs: { quiet: OTHER_SURFACE },
  revisions: { quiet: OTHER_SURFACE },
  revision_seeded: { quiet: OTHER_SURFACE },
  revision_landed: { quiet: OTHER_SURFACE },
  pending_plans: { quiet: OTHER_SURFACE },
  plan_cleared: { quiet: OTHER_SURFACE },
  validate_early_ask: { quiet: OTHER_SURFACE },
  validity_reopen: { quiet: OTHER_SURFACE },

  // ── TOOL CALLS ARE NEVER DRAWN (MOTIR-8158) ──────────────────────────────
  // Founder decision 2026-10-10: a lookup means nothing to the person. The
  // planner's own narration (MOTIR-8060 / design MOTIR-8061) says what it is
  // doing, grouped per session from the store, and a reopened rail draws only
  // that. Drawing lookups live as well made the two views of one run disagree
  // (154 `retrieval` rows in one run). This covers every surface `narrateFrame`
  // serves, an ask's and a debug turn's lookups included.
  search: { quiet: TOOL_CALL },
  retrieval: { quiet: TOOL_CALL },
  drill: { quiet: TOOL_CALL },
  tool_call: { quiet: TOOL_CALL },
  tool_call_failed: { quiet: TOOL_CALL },

  // Frames motir-ai emits that core never listed. Left unlisted they were drawn
  // raw as `frame: <name>` (MOTIR-8158).
  model_stop: { quiet: 'per-turn stop record (MOTIR-7718) — run telemetry, not an outcome' },
  session_summary: { quiet: 'per-session cost and context ledger — run telemetry, not an outcome' },
  gap: { quiet: 'a lay session’s note of what it could not cover — the narration carries it' },
  target_already_covered: { quiet: NOT_AN_ACT },
  target_failed: { quiet: NOT_AN_ACT },
  reauthor_target: { quiet: NOT_AN_ACT },
  onboarding_depth: { quiet: NOT_AN_ACT },
  onboarding_routing: { quiet: NOT_AN_ACT },
  planning_record_not_filed: { quiet: BOOKKEEPING },
  planning_failure_filed: { quiet: BOOKKEEPING },
  planning_alarm_filed: { quiet: BOOKKEEPING },
  planning_alarm: { quiet: BOOKKEEPING },
  planning_failure_commented: { quiet: BOOKKEEPING },
  planning_record_attached: { quiet: BOOKKEEPING },

  token: { quiet: BOOKKEEPING },
  packed: { quiet: BOOKKEEPING },
  wired: { quiet: BOOKKEEPING },
  provenance: { quiet: BOOKKEEPING },
  state: { quiet: BOOKKEEPING },
  status: { quiet: BOOKKEEPING },
  info: { quiet: BOOKKEEPING },
  lessons_injected: { quiet: BOOKKEEPING },
  retrieval_ready: { quiet: BOOKKEEPING },

  read: { quiet: NOT_AN_ACT },
  partition: { quiet: NOT_AN_ACT },
  neighbourhood: { quiet: NOT_AN_ACT },
  contextual_context: { quiet: NOT_AN_ACT },
  contextual_scope: { quiet: NOT_AN_ACT },
  target_read: { quiet: NOT_AN_ACT },
  target_settled: { quiet: NOT_AN_ACT },
  /** PART 1's quick reply to what the person sent (MOTIR-10738): one or two
   *  sentences the model writes in the person's language. The hook keeps it by
   *  job and the conversation bubble draws it in place of the keyed fallback, so
   *  it is not an act line. Accepted here BEFORE motir-ai emits it. */
  conversation_ack: {
    quiet: 'drawn as the conversation-phase bubble, in place of its keyed line — not an act',
  },
  /** The run planned nothing and its reply says why (MOTIR-10407): read by the settle. */
  empty_run_reply: { quiet: NOT_AN_ACT },

  // ── THE SIX THE 2026-11-05 SWEEP FOUND UNLISTED (MOTIR-10427) ─────────────
  // Each one was read at its emitter on motir-ai `main` before it was given a
  // disposition. None is an act a person watching the rail would do anything
  // about while the run is live: each is either telemetry another reader owns, or
  // an outcome that reaches the person on the plan they review afterwards.
  /** generationPass `positionChanged`: where the walk is, put on the stream before
   *  every session. Its reader is the stream relay (`lib/ai/jobStream.ts`), which
   *  keeps the latest one as the stop point a failure record names. */
  walk_position: {
    quiet: 'where the walk is, kept by the stream relay as a failure’s stop point — not an act',
  },
  /** handlers/plan.ts: a resumed run's seed counts (proposals, authored cards,
   *  closed levels, gaps). The resumed walk's own lay and author lines narrate
   *  what it does next. */
  resume_seeded: {
    quiet: 'the counts a resumed run starts from — run telemetry; its lay and author lines narrate',
  },
  /** generationPass `closeLevel`: a level sealed with no card of its own while
   *  this pass laid cards elsewhere (MOTIR-8520). A walk defect for the walk
   *  report; the `level_complete` the rail draws follows it in the same call. */
  level_closed_empty: {
    quiet: 'a walk-defect record for the walk report (MOTIR-8520); level_complete follows it',
  },
  /** planningEngine's validity re-open: a card the closing validation moved in
   *  code (MOTIR-10201). The move is on the plan the person reviews. */
  post_merge_moved: { quiet: 'a card the closing validation moved in code — the plan shows it' },
  /** The same step, when core refused the move. The card is handed to the
   *  validity re-open, whose result is on the plan. */
  post_merge_move_refused: {
    quiet: 'a code move core refused — the card goes to the validity re-open, not the rail',
  },
  /** The validity re-open: a finding the re-opened phase could not fix. It is
   *  carried on the plan's validation report, which is where a person reads it. */
  validity_unfixable: {
    quiet: 'a validity finding the re-open could not fix — the validation report carries it',
  },

  // ── LANDED ON motir-ai `main` AFTER THAT SWEEP (MOTIR-10427 review) ───────
  /** generationPass `runLaySession`: a lay session stopped by a session limit
   *  (credits, output limit, …) with part of its level laid (MOTIR-10422). The
   *  ORIGINAL error is rethrown right after it, so the run ends in the error
   *  state the rail already shows; the laid cards stand for the retry or resume.
   *  A rail row naming the limit is a design question, outside this card. */
  lay_stopped: {
    quiet: 'a limit stopped a part-laid level — the rethrown error is the run’s error state',
  },
  /** planningEngine: the numbered clause list taken from the requirement and its page
   *  before the first level is laid (MOTIR-10479). The list is persisted on the job
   *  and printed in section 1 of the plan's briefing, which is where a person reads it;
   *  each level's lay judges its cards against it. */
  clause_list: {
    quiet: 'the clause list taken before the first level — the briefing’s section 1 shows it',
  },
  /** generationPass `register_hand_off` (MOTIR-11073): an author kept a hand-off or a
   *  rename it was forced to make, for its level's amend to apply as a patch. The
   *  amend's edits carry it to the plan, each with its reason, and the walk report
   *  lists every registration (`authoring.registrations`), so it is not an act line. Accepted here
   *  BEFORE motir-ai emits it on `main`. */
  registration: {
    quiet: 'a hand-off or rename kept for the level’s amend — the amend’s edits carry it',
  },
};

/**
 * WHAT THE SWEEP MATCHES THAT IS NOT A FRAME KIND (MOTIR-10427), with the reason
 * beside each. The sweep is a regex over `motir-ai`'s source
 * ({@link FRAME_KIND_SWEEP}), and its `event: '…'` arm also matches a TypeScript
 * parameter annotation. A name here is left out of the sweep's result on BOTH
 * sides: `tests/planning/frameKindParity.test.ts`'s live sweep and motir-ai's own
 * `pnpm check:frame-kinds`, which reads this list from the published contract.
 *
 * An entry the sweep stops finding is reported as STALE by both, so an exclusion
 * cannot outlive the false match it was written for and quietly hide a real kind
 * of the same name later.
 */
export const SWEEP_FALSE_MATCHES: Readonly<Record<string, string>> = {
  end: "src/pool/jobQueuedChannel.ts types the pg LISTEN client: `on(event: 'end', …)` is a parameter annotation, not a frame",
  notification:
    "src/pool/jobQueuedChannel.ts types the pg LISTEN client: `on(event: 'notification', …)` is a parameter annotation, not a frame",
};

/**
 * The sweep both repositories run over `motir-ai`'s `src/`, as a `git grep -E`
 * pattern. Four arms, each a call shape motir-ai really emits through:
 *
 *   - the first argument of `emit(…)` / `signal(…)` / `safeEmit(…)`, optional
 *     chaining included — `ctx.emit?.('lay', …)`;
 *   - the same call choosing between two kinds by a ternary —
 *     `safeEmit(failure ? 'planning_failure_filed' : 'planning_alarm_filed', …)`;
 *   - the two quiet wrappers the tool-call narration emits through —
 *     `quietly('tool_call_failed', …)` and `emitQuietly(deps.emit, 'tool_call', …)`;
 *   - an `event: '…'` literal — `{ event: 'done', data }`.
 *
 * The middle two arms are MOTIR-10427's: before it the sweep missed the three
 * kinds sent that way, and the checked-in list carried them by hand. It is
 * PUBLISHED with the kind list, so motir-ai's check and core's live sweep cannot
 * disagree about what was swept.
 */
export const FRAME_KIND_SWEEP = {
  pattern:
    "\\b(emit|signal|safeEmit)\\??\\.?\\(\\s*('[a-z_]+'|[a-zA-Z_.]+\\s*\\?\\s*'[a-z_]+'\\s*:\\s*'[a-z_]+')" +
    "|\\b(quietly\\(\\s*|emitQuietly\\(\\s*[a-zA-Z_.]+,\\s*)'[a-z_]+'" +
    "|event: '[a-z_]+'",
  paths: ['src'],
} as const;

/** Is this a kind somebody has decided about? */
export function isKnownFrameKind(event: string): event is PlanChangeFrameKind {
  return Object.prototype.hasOwnProperty.call(FRAME_DISPOSITIONS, event);
}

/** The longest quick reply the conversation bubble draws (MOTIR-10738). */
export const CONVERSATION_ACK_MAX_CHARS = 400;

/**
 * The text of a `conversation_ack` frame (MOTIR-10738) — `{ text: string }` on the
 * wire — trimmed and held to {@link CONVERSATION_ACK_MAX_CHARS}, or `null` when the
 * frame carries no usable text. Model output: the caller renders it as plain text.
 */
export function conversationAckText(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const text = (data as Record<string, unknown>).text;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return trimmed.length > CONVERSATION_ACK_MAX_CHARS
    ? trimmed.slice(0, CONVERSATION_ACK_MAX_CHARS).trimEnd()
    : trimmed;
}
