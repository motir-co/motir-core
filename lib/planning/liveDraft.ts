import type { PlanItemDraftDto } from '@/lib/dto/plans';
import type { CardCueState } from '@/lib/planning/cueState';

// A CARD BEING WRITTEN, AS THE PROPOSAL QUICK VIEW READS IT (Story MOTIR-11190 ·
// MOTIR-11201; design `design/ai-planning/design-notes.md` Part XXIX).
//
// While a plan is generating, the overlay's live read carries `inFlightDrafts`
// (MOTIR-11199): per proposal, the partial title, description and explanation an
// `author` session's model has written so far — held BESIDE the proposal, never as
// it. The quick view shows that text in the fields' own elements while it grows,
// then the stored proposal once the draft is gone. Nothing is replayed: the text
// grows because the read grew.
//
// This module decides, purely:
//   - which draft (if any) the open quick view honours — only on the LIVE overlay,
//     only for a proposal, only for the fields the draft carries;
//   - which field grew last (it holds the caret);
//   - how an unterminated partial is shown (plain text up to the cut, never
//     broken markup);
//   - the in-progress cue's state across reads: `writing` while the card is being
//     written, `written` once the stored card landed (the hand-over), `idle` when
//     the draft went with no stored change (the refused write).
//
// PURE: no React, no I/O.

/** The three fields that can be live — and only these (Part XXIX §29.2). */
export const LIVE_FIELDS = ['title', 'descriptionMd', 'explanationMd'] as const;
export type LiveField = (typeof LIVE_FIELDS)[number];

/** The live read's in-flight state, as a host hands it down. */
export interface LiveDrafts {
  /** `PlanReviewDto.inFlightDrafts` — one entry per proposal being written. */
  drafts: readonly PlanItemDraftDto[];
  /** Proposals an `author` step targets right now (bare `planItemId`s). */
  authoring: ReadonlySet<string>;
  /**
   * What the planner is doing to each proposal (MOTIR-11254, Part XXXI §31.7) —
   * `thinking` · `drafting` · `checking`, after the two-read hold, by bare
   * `planItemId`. Absent ⇒ the quick view's cue reads as it shipped.
   */
  cues?: ReadonlyMap<string, CardCueState>;
}

/** What the open quick view shows of a card being written. */
export interface PeekLiveDraft {
  /** The card is being written: the cue shows, even before any partial. */
  writing: true;
  /** The partial text of each field the draft carries; an absent field is waiting. */
  fields: Partial<Record<LiveField, string>>;
}

const PLAN_ITEM_PREFIX = 'planItem:';

/** The bare proposal ids an `author` step targets, from the live read's steps. */
export function authoringTargets(
  steps: readonly { kind: string; targetRef: string | null }[] | null | undefined,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const step of steps ?? []) {
    if (step.kind !== 'author' || !step.targetRef) continue;
    out.add(
      step.targetRef.startsWith(PLAN_ITEM_PREFIX)
        ? step.targetRef.slice(PLAN_ITEM_PREFIX.length)
        : step.targetRef,
    );
  }
  return out;
}

/**
 * The draft the quick view of `planItemId` honours, or null. Ignored entirely off
 * the live overlay (`live` false: the plan page, a finished plan) and on a
 * committed card's host (`proposal` false) — a draft is never shown there.
 */
export function liveDraftFor(
  liveDrafts: LiveDrafts | null | undefined,
  planItemId: string,
  host: { live: boolean; proposal: boolean },
): PeekLiveDraft | null {
  if (!host.live || !host.proposal || !liveDrafts) return null;
  const draft = liveDrafts.drafts.find((d) => d.planItemId === planItemId) ?? null;
  if (draft === null && !liveDrafts.authoring.has(planItemId)) return null;
  const fields: Partial<Record<LiveField, string>> = {};
  for (const field of LIVE_FIELDS) {
    const value = draft?.[field];
    if (typeof value === 'string') fields[field] = value;
  }
  return { writing: true, fields };
}

/**
 * The field that grew on this read — the last one in reading order whose partial
 * changed — or null when none changed (the caller keeps the caret where it was).
 */
export function grewLast(
  prev: Partial<Record<LiveField, string>> | null,
  next: Partial<Record<LiveField, string>>,
): LiveField | null {
  let last: LiveField | null = null;
  for (const field of LIVE_FIELDS) {
    if (next[field] !== undefined && next[field] !== prev?.[field]) last = field;
  }
  return last;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const BARE_BLOCK_START = /^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s*$/;

/**
 * An unterminated partial, safe to render as markdown (Part XXIX §29.3): every
 * closed block renders as it will; a list item that has begun renders in its
 * list; an inline run still open — `**`, a backtick, a link — shows its text as
 * plain text with its opening marker WITHHELD until it closes. Never a literal
 * `**`, never a half link, never a `- ` with nothing after it. An open code fence
 * is left alone: it renders as code up to the cut, which is what it is.
 */
export function partialMarkdown(text: string): string {
  const lines = text.split('\n');
  let fence: string | null = null;
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (!m) continue;
    const marker = m[1]![0]!;
    if (fence === null) fence = marker;
    else if (fence === marker) fence = null;
  }
  if (fence !== null) return text;
  // A block that has begun with nothing in it yet is withheld.
  while (lines.length > 0 && BARE_BLOCK_START.test(lines[lines.length - 1]!)) lines.pop();
  if (lines.length === 0) return '';
  let tail = lines[lines.length - 1]!;
  // A half link: `[text` or `[text](partial-url` → its text alone.
  tail = tail.replace(/\[([^\]]*)\]\([^)]*$/, '$1').replace(/\[([^\]]*)$/, '$1');
  // An open inline code run: withhold its backtick.
  if ((tail.match(/`/g) ?? []).length % 2 === 1) {
    const at = tail.lastIndexOf('`');
    tail = tail.slice(0, at) + tail.slice(at + 1);
  }
  // An open strong run: withhold its `**`.
  if ((tail.match(/\*\*/g) ?? []).length % 2 === 1) {
    const at = tail.lastIndexOf('**');
    tail = tail.slice(0, at) + tail.slice(at + 2);
  }
  lines[lines.length - 1] = tail.replace(/\s+$/, '');
  return lines.join('\n');
}

/** The in-progress cue's state (Part XXIX §29.4). */
export type LiveCueState = 'writing' | 'written' | 'idle';

export interface LiveCue {
  state: LiveCueState;
  /** The stored card when writing was last seen — what tells a hand-over from a refusal. */
  storedAtWriting: string | null;
}

export const IDLE_CUE: LiveCue = { state: 'idle', storedAtWriting: null };

/** A stable key of the stored card's three live-able fields. */
export function storedKey(stored: {
  title: string | null;
  descriptionMd: string | null;
  explanationMd: string | null;
}): string {
  return JSON.stringify([stored.title, stored.descriptionMd, stored.explanationMd]);
}

const WRITTEN_CUE: LiveCue = { state: 'written', storedAtWriting: null };

/**
 * The cue after a read. Writing ⇒ `writing`. Writing just stopped ⇒ `written` if
 * the stored card changed since writing was seen (the hand-over, announced), else
 * `idle` (the refused write: nothing is announced). Otherwise unchanged — the same
 * object, so a host can compare by reference.
 *
 * ⚠️ THE HAND-OVER DOES NOT WAIT FOR THE STEP TO END (§29.2 _stored hand-over_: "the
 * read that carries no draft and a changed proposal"). The write clears the draft,
 * but the session's `author` step may still target the card for a read or two
 * before it ends. `drafted` says whether the read carries a partial at all: a read
 * with none whose stored card changed since writing was seen IS the hand-over, and
 * a later partial-free read keeps it `written` rather than calling the stored card
 * _Being written_ again. Omitted, `drafted` follows `writing`.
 */
export function nextLiveCue(
  prev: LiveCue,
  read: { writing: boolean; drafted?: boolean; stored: string },
): LiveCue {
  if (read.writing && !(read.drafted ?? true)) {
    if (prev.state === 'written') return prev;
    if (prev.state === 'writing' && prev.storedAtWriting !== read.stored) return WRITTEN_CUE;
  }
  if (read.writing) {
    return prev.state === 'writing' && prev.storedAtWriting === read.stored
      ? prev
      : { state: 'writing', storedAtWriting: read.stored };
  }
  if (prev.state !== 'writing') return prev;
  return prev.storedAtWriting !== read.stored ? WRITTEN_CUE : IDLE_CUE;
}

/** What the quick view's cue line shows (Part XXXI §31.7, MOTIR-11254): the
 *  shipped three, plus THINKING (authored, nothing written yet) and CHECKING (the
 *  final check is reviewing the card). */
export type CueLineState = LiveCueState | 'thinking' | 'checking';

/**
 * The cue line's state from the read's fold (`nextLiveCue`) and the planner's cue
 * on the card (`cueState.ts`, after its two-read hold): Checking first — the
 * latest stage — then Thinking while the writing cue has no text yet, then the
 * shipped state. Without a planner cue the line reads as it shipped.
 */
export function cueLineState(
  state: LiveCueState,
  planner: CardCueState | null | undefined,
): CueLineState {
  if (planner === 'checking') return 'checking';
  if (state === 'writing' && planner === 'thinking') return 'thinking';
  return state;
}
