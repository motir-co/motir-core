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
 * Every frame kind `motir-ai` emitted on `origin/main` at the time of the sweep
 * (2026-09-03), from every call shape: `ctx.emit(…)`, `sink.signal(…)` and the
 * `{ event: … }` literals the handlers push.
 *
 * ⚠️ NOT ALPHABETICAL BY ACCIDENT — it is sorted so the next sweep's `sort -u`
 * output diffs cleanly against it. Re-run:
 *
 *   git grep -ohE "emit\??\.?\(\s*'[a-z_]+'|signal\??\.?\(\s*'[a-z_]+'|event: '[a-z_]+'" \
 *     origin/main -- src | grep -oE "'[a-z_]+'" | tr -d "'" | sort -u
 */
export const PLAN_CHANGE_FRAME_KINDS = [
  'assistant',
  'audit',
  'author',
  'code_graph',
  'comparables',
  'contextual_context',
  'contextual_scope',
  'convention',
  'conversation',
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
  'lessons_injected',
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
  'provenance',
  'read',
  'reauthor_target',
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
  'vision_doc',
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
  /** The run planned nothing and its reply says why (MOTIR-10407): read by the settle. */
  empty_run_reply: { quiet: NOT_AN_ACT },
};

/** Is this a kind somebody has decided about? */
export function isKnownFrameKind(event: string): event is PlanChangeFrameKind {
  return Object.prototype.hasOwnProperty.call(FRAME_DISPOSITIONS, event);
}
