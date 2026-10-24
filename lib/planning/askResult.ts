import { readLogBugOffer, type LogBugOfferClaim } from '@/lib/ai/logBugOffer';
import type { RequirementRecommendation, SubmittedRequirement } from '@/lib/ai/types';
import { narrowSharpenedRequirement } from '@/lib/sharpening/requirement';

// The CONSUMING half of MOTIR-1817's boundary contract (MOTIR-1819): reading an
// `ask_project` job's ANSWER — and its REDIRECT — off a motir-ai job result.
//
// Same posture as `plannerTurn.ts` one file over, and for the same reason:
// motir-ai's envelope documents `ask` as "purely additive; core reads results
// loosely", the producer ships ahead of the consumer by design, and a result
// that carries nothing readable is not an error — it is a job with nothing to
// say. What this does NOT do is trust the shape: the field crosses a network
// boundary from a separately-deployed service and every branch of it becomes a
// persisted row, so each is checked and bounded on READ.
//
// ⚠️ THE ONE PLACE THE DEFAULT MATTERS. An unreadable result reads as an
// `ask` that produced no answer — NEVER as a `plan_change`. Getting this
// backwards would turn an unparseable envelope into a dispatched plan-edit job
// the person never asked for: the expensive half of the asymmetry
// `docs/decisions/conversation-turn-intent.md` §4 rests its default on.

/** What an `ask_project` result says, once read defensively. */
export interface AskOutcome {
  /** Which intent the turn RAN AS — `plan_change`, `debug` (MOTIR-7047 · the
   *  ADR's AMENDMENT 1) and `new_session` (MOTIR-7649 · AMENDMENT 3) are the
   *  redirects. */
  intent: 'ask' | 'plan_change' | 'debug' | 'new_session';
  /** The answer body, or null on a redirect and on an empty utterance. */
  answer: string | null;
  /** Work-item keys the answer rests on. Always `[]` on a redirect. */
  citations: string[];
  /**
   * On a `debug` redirect ONLY: the anchor the handler echoed back (the request's
   * `context.anchorKey`), key-shaped, or null when the turn had none or the echo
   * was not a key. Absent on `ask` / `plan_change`. It is a CLAIM from across the
   * boundary, so the dispatch re-resolves and re-gates it before forwarding it —
   * this read only guarantees its shape.
   */
  anchorKey?: string | null;
  /**
   * RUN MODE only (MOTIR-7996; `ask_project` with `context.run`): on a
   * `plan_change`, the person's words to forward to the RUNNING planner. Core
   * never forwards THIS string — it only selects, by exact equality, which of two
   * texts core already holds (the turn's own body, or the pending offer's) is
   * forwarded. A `plan_change` whose `forward` is missing or malformed reads
   * `null`. Absent on every non-`plan_change` outcome.
   */
  forward?: { text: string } | null;
  /**
   * RUN MODE only: on an `ask`, the turn the handler was UNSURE was a change. The
   * answer carries an offer to forward it, and nothing is forwarded until the
   * person's next turn confirms. Null / absent when there is no offer.
   */
  offerForward?: { text: string } | null;
  /** RUN MODE only: whether the answering session could READ the run snapshot core
   *  sent, and why not when it could not. Null / absent on a turn with no run. */
  run?: { readable: boolean; reason: string | null } | null;
  /**
   * On an `ask` ONLY: the one offer the answer ended with (MOTIR-9287 producer ↔
   * MOTIR-9290 consumer). ABSENT when the envelope carried none, or one this build
   * cannot read — an unrecognised `kind` is NO offer, never coerced to `plan`, since
   * the field's membership grows on the far side first. A `log_bug` offer
   * (MOTIR-9322) is read through `parseLogBugOffer`; one that fails any check is no
   * offer, and the answer still lands.
   */
  offer?: AskOffer;
  /**
   * On an `ask` ONLY: the person's decision on the offer that was PENDING when they
   * spoke (MOTIR-9292 producer ↔ MOTIR-9291 consumer). `seq` names that offer's
   * answer turn. ABSENT when the envelope carried none or one this build cannot
   * read: a missing or non-integer `seq`, or a decision other than `agree` /
   * `decline`, is NO reply — never agreement.
   */
  offerReply?: AskOfferReply;
}

/** The typed reply to a pending offer, once read. */
export interface AskOfferReply {
  seq: number;
  kind: string;
  decision: 'agree' | 'decline';
}

/** The one offer an answer carries, once read: a plan, or a bug to log. */
export type AskOffer = AskPlanOffer | LogBugOfferClaim;

/** The plan offer an answer carries, once read. `requestText` is mapped onto the
 *  store's `requestMd` here; `targetKey` is the CLAIM the far side made, which the
 *  landing re-resolves under the caller's access before anything is stored. */
export interface AskPlanOffer {
  kind: 'plan';
  requestMd: string;
  targetKey: string | null;
  /** The turn plainly said "plan this" with a grounded target: it starts at once and
   *  stores no offer. A missing or non-boolean value reads `false`. */
  immediate: boolean;
  /** The six-field requirement the answering session composed (MOTIR-9432), present
   *  only when the envelope carried one that reads. The landing keeps it on a
   *  no-target offer alone. */
  requirement?: SubmittedRequirement;
}

// Bounds applied on READ, not merely trusted from the producer — this text
// becomes a database row. The answer is allowed more room than a planner's
// findings report because it is the deliverable rather than a narration.
export const ASK_ANSWER_MAX_CHARS = 8000;
/** A defensive cap on how many citations one answer may carry. An answer resting
 *  on forty work items is not an answer a person can check, and the rail renders
 *  each as a chip. */
export const ASK_MAX_CITATIONS = 20;
/** A defensive cap on how many assumptions one composed requirement may carry. */
export const ASK_REQUIREMENT_MAX_ASSUMPTIONS = 20;

/** A work-item identifier, as the boundary is allowed to name one. Anchored on
 *  both ends: a value that merely CONTAINS a key is not a key. */
const WORK_ITEM_KEY = /^[A-Z][A-Z0-9]{1,15}-\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** A string trimmed and capped like `boundedString`, except that blank stays blank:
 *  an empty `scopeEdge` or `constraints` is an answer, not a missing part. */
function boundedPart(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** The composed requirement an offer carries, narrowed through the ONE shipped
 *  narrowing and then bounded on read: every string part, and every assumption's
 *  text, is trimmed and capped; the assumption list is capped in length. */
function readRequirementField(value: unknown): SubmittedRequirement | undefined {
  const narrowed = narrowSharpenedRequirement(value);
  if (!narrowed) return undefined;
  const { assumptions, ...parts } = narrowed;
  const out: SubmittedRequirement = {};
  for (const [part, text] of Object.entries(parts) as [
    keyof Omit<SubmittedRequirement, 'assumptions'>,
    string | undefined,
  ][]) {
    if (typeof text === 'string') out[part] = boundedPart(text, ASK_ANSWER_MAX_CHARS);
  }
  if (typeof assumptions === 'string') {
    out.assumptions = boundedPart(assumptions, ASK_ANSWER_MAX_CHARS);
  } else if (assumptions) {
    out.assumptions = assumptions
      .slice(0, ASK_REQUIREMENT_MAX_ASSUMPTIONS)
      .map((entry): string | RequirementRecommendation =>
        typeof entry === 'string'
          ? boundedPart(entry, ASK_ANSWER_MAX_CHARS)
          : { ...entry, text: boundedPart(entry.text, ASK_ANSWER_MAX_CHARS) },
      );
  }
  return out;
}

/** The envelope's offer, or null when it is absent, of an unknown kind, or carries
 *  no request text. The target is kept only when it is key-shaped. A `log_bug`
 *  offer is read whole by `readLogBugOffer`, or not at all. */
function readOfferField(value: unknown): AskOffer | null {
  if (isRecord(value) && value['kind'] === 'log_bug') return readLogBugOffer(value);
  if (!isRecord(value) || value['kind'] !== 'plan') return null;
  const requestMd = boundedString(value['requestText'], ASK_ANSWER_MAX_CHARS);
  if (!requestMd) return null;
  const target = typeof value['targetKey'] === 'string' ? value['targetKey'].trim() : '';
  const requirement = readRequirementField(value['requirement']);
  return {
    kind: 'plan',
    requestMd,
    targetKey: WORK_ITEM_KEY.test(target) ? target : null,
    immediate: value['immediate'] === true,
    ...(requirement ? { requirement } : {}),
  };
}

/** The envelope's `offerReply`, or null when it is not exactly that shape. */
function readOfferReplyField(value: unknown): AskOfferReply | null {
  if (!isRecord(value)) return null;
  const seq = value['seq'];
  const kind = value['kind'];
  const decision = value['decision'];
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;
  if (typeof kind !== 'string' || kind.trim().length === 0) return null;
  if (decision !== 'agree' && decision !== 'decline') return null;
  return { seq, kind, decision };
}

/** The citations, de-duplicated, key-shaped and bounded. A malformed entry is
 *  dropped rather than failing the read: the answer is still worth showing with
 *  the citations that ARE readable, and the service re-validates every survivor
 *  against the project's own work items before persisting one. */
/** `{ text }` with a bounded, non-blank string, else null. */
function readTextField(value: unknown): { text: string } | null {
  if (!isRecord(value)) return null;
  const text = boundedString(value['text'], ASK_ANSWER_MAX_CHARS);
  return text ? { text } : null;
}

/** The run-mode echo `{ readable, reason? }`, or null when it is not that shape. */
function readRunField(value: unknown): { readable: boolean; reason: string | null } | null {
  if (!isRecord(value) || typeof value['readable'] !== 'boolean') return null;
  return { readable: value['readable'], reason: boundedString(value['reason'], 200) };
}

function readCitations(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const key = entry.trim();
    if (!WORK_ITEM_KEY.test(key) || out.includes(key)) continue;
    out.push(key);
    if (out.length === ASK_MAX_CITATIONS) break;
  }
  return out;
}

/**
 * Read an `ask_project` job's outcome. Total over any input — an arbitrary JSON
 * value is a legitimate argument and yields the safe default rather than
 * throwing.
 *
 * `null` means the result carried no `ask` unit at all: an older engine, a
 * different job kind, or a job that failed before it produced one. That is
 * distinct from `{ intent: 'ask', answer: null }`, which is a job that RAN and
 * had nothing to say — the caller renders those differently, so the read keeps
 * them apart.
 */
export function readAskOutcome(result: unknown): AskOutcome | null {
  if (!isRecord(result)) return null;
  const ask = result['ask'];
  if (!isRecord(ask)) return null;

  // The redirect: no answer and no citations, whatever else the field carried.
  const run = readRunField(ask['run']);
  if (ask['intent'] === 'plan_change') {
    // `forward` is read only here: it is the run-mode form of the redirect. A
    // malformed one reads `null` — the intent is unchanged, and the caller treats
    // a forward-less mid-run `plan_change` as nothing to forward.
    return {
      intent: 'plan_change',
      answer: null,
      citations: [],
      // Present only when the result CARRIED a `forward` key (a run-mode result);
      // a legacy redirect has none, and keeps its exact old shape.
      ...('forward' in ask ? { forward: readTextField(ask['forward']) } : {}),
      ...(run ? { run } : {}),
    };
  }
  // The second redirect (MOTIR-7047): the turn reported broken behaviour. Same
  // shape — nothing answered, nothing cited — plus the echoed anchor, which is
  // kept only when it is a key and never trimmed into one.
  if (ask['intent'] === 'debug') {
    const anchor = ask['anchorKey'];
    return {
      intent: 'debug',
      answer: null,
      citations: [],
      anchorKey: typeof anchor === 'string' && WORK_ITEM_KEY.test(anchor) ? anchor : null,
    };
  }

  // The third redirect (MOTIR-7649 · AMENDMENT 3, A3.1): the turn asked to plan
  // something new. Nothing answered, nothing cited, no anchor echo.
  if (ask['intent'] === 'new_session') {
    return { intent: 'new_session', answer: null, citations: [] };
  }

  const offer = readOfferField(ask['offer']);
  const offerReply = readOfferReplyField(ask['offerReply']);
  return {
    intent: 'ask',
    answer: boundedString(ask['answer'], ASK_ANSWER_MAX_CHARS),
    citations: readCitations(ask['citations']),
    ...('offerForward' in ask ? { offerForward: readTextField(ask['offerForward']) } : {}),
    ...(run ? { run } : {}),
    ...(offer ? { offer } : {}),
    ...(offerReply ? { offerReply } : {}),
  };
}
