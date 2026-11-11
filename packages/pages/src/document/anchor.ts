import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  absolutePositionToRelativePosition,
  initProseMirrorDoc,
  relativePositionToAbsolutePosition,
} from 'y-prosemirror';
import * as Y from 'yjs';
import { PAGE_FRAGMENT, pageSchema } from './schema';

// The inline-comment ANCHOR codec (Story MOTIR-10867 · MOTIR-10897), pure and
// headless like the conversions beside it (`convert.ts`). A passage of a page is
// written down as Yjs RELATIVE POSITIONS inside the `default` fragment plus the
// text it quoted (`docs/decisions/pages.md` §8.3) — never a mark in the document
// and never a character offset — so it still names that passage after the page
// is edited. Nothing here opens a transaction or writes to the document: an
// anchor is made and resolved by READING it, so it can never become an update
// the autosave loop sends, and `bodyState` / `revision` cannot move because
// somebody commented.
//
// WHICH CHARACTER EACH END BINDS TO is the whole design:
//
//   - `start` binds to the passage's FIRST character and `end` to its LAST, so
//     text typed exactly at either edge lands outside the passage — a highlight
//     never grows onto text nobody commented on.
//   - `before` and `after` bind to the characters just OUTSIDE it. They are
//     consulted only when the inner pair no longer covers any text, and they are
//     what brings a passage back after it was deleted and then restored (an undo,
//     a version restore). Yjs restores deleted text as NEW items, and the link
//     from an old item to its replacement (`Item.redone`) is local to the
//     document that undid it — it is not encoded, so a state merged from it, or
//     re-read from the database, has lost it, and the inner pair alone would
//     answer gone for ever. The restored text is inserted between the passage's
//     surviving neighbours, so the outer pair covers it again. A passage deleted
//     and not restored leaves the two neighbours adjacent: the outer range is
//     empty too, and the answer is gone.
//
//     The outer pair covers ANY text later written between those neighbours,
//     not only restored text: delete a sentence and type its replacement, and
//     the pair covers the replacement. So the fallback is accepted only when
//     the text it covers is recognisably the passage the thread QUOTED (see
//     `sameAsQuote`), and with no quote to check against it is not consulted.
//     This is the quote re-anchoring web annotators do (a stored text quote
//     matched approximately); the inner pair never needs it, because it binds
//     to the passage's own characters.
//
// A position that cannot be placed — an item the document does not hold (another
// page's body), one inside a deleted block, one the ProseMirror mapping cannot
// convert — answers NOTHING. Nothing here falls back to a nearest plausible
// position: a highlight in the wrong place is worse than a thread shown as
// page-level.

/** The longest quote, in code points, the ellipsis included. */
export const PAGE_ANCHOR_QUOTE_MAX = 1000;

/** The first byte of every anchor this codec writes. */
export const PAGE_ANCHOR_FORMAT_VERSION = 1;

/** A passage's two ends, and the two edges just outside it (see above). */
export interface PageAnchorPair {
  /** Bound to the passage's first character (association: the character after). */
  readonly start: Y.RelativePosition;
  /** Bound to the passage's last character (association: the character before). */
  readonly end: Y.RelativePosition;
  /** Bound to the character before the passage — the restore fallback's start. */
  readonly before: Y.RelativePosition;
  /** Bound to the character after the passage — the restore fallback's end. */
  readonly after: Y.RelativePosition;
}

/** Where a passage now is: ProseMirror positions on the page body, `from < to`. */
export interface PageAnchorRange {
  readonly from: number;
  readonly to: number;
}

/** A new anchor: the pair, the bytes the `anchor` column stores, and the quote. */
export interface PageAnchorSelection {
  readonly pair: PageAnchorPair;
  readonly bytes: Uint8Array;
  readonly quote: string;
}

/** A page body read for anchoring: its Yjs document, the fragment, and the
 * ProseMirror document with the mapping positions are made and read through. */
export interface PageAnchorDocument {
  readonly ydoc: Y.Doc;
  readonly fragment: Y.XmlFragment;
  readonly doc: ProseMirrorNode;
  readonly mapping: ReturnType<typeof initProseMirrorDoc>['mapping'];
}

/** A stored state, a live Yjs document, or one already read. */
export type PageAnchorSource = Uint8Array | Y.Doc | PageAnchorDocument;

/**
 * Read a page body for anchoring — a stored `bodyState` or the editor's live
 * document. Read-only: a stored state is applied to a FRESH document, and a
 * live one is only read. Unlike the conversions it does not fill an empty body
 * to the schema's minimum: an empty fragment simply holds no passage.
 */
export function anchorDocument(source: Uint8Array | Y.Doc): PageAnchorDocument {
  let ydoc: Y.Doc;
  if (source instanceof Y.Doc) {
    ydoc = source;
  } else {
    ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, source);
  }
  const fragment = ydoc.getXmlFragment(PAGE_FRAGMENT);
  const { doc, mapping } = initProseMirrorDoc(fragment, pageSchema);
  return { ydoc, fragment, doc, mapping };
}

function toAnchorDocument(source: PageAnchorSource): PageAnchorDocument {
  return source instanceof Uint8Array || source instanceof Y.Doc ? anchorDocument(source) : source;
}

// ── The quote ───────────────────────────────────────────────────────────────

/**
 * A leaf's text in a quote. A work-item mention or embed is an atom with no
 * text of its own, so it contributes the label the reader sees on its chip,
 * falling back to its id; a hard break is a space. (`stateToText` answers ''
 * for those chips, and widening it would change the stored plain text.)
 */
function leafText(node: ProseMirrorNode): string {
  if (node.type.name === 'hardBreak') return ' ';
  const label = node.attrs['label'] as unknown;
  const id = node.attrs['id'] as unknown;
  if (typeof label === 'string' && label.length > 0) return label;
  return typeof id === 'string' ? id : '';
}

/** The text a range holds, blocks joined by one space. */
function rangeText(doc: ProseMirrorNode, from: number, to: number): string {
  return doc.textBetween(from, to, ' ', leafText);
}

/** Trimmed, and at most `PAGE_ANCHOR_QUOTE_MAX` code points with the ellipsis inside. */
function toQuote(text: string): string {
  const points = Array.from(text.trim());
  if (points.length <= PAGE_ANCHOR_QUOTE_MAX) return points.join('');
  return `${points
    .slice(0, PAGE_ANCHOR_QUOTE_MAX - 1)
    .join('')
    .trimEnd()}…`;
}

// ── Placing a position ──────────────────────────────────────────────────────

/** True when the type, or any block holding it, has been deleted. */
function insideDeleted(type: Y.AbstractType<unknown>): boolean {
  let item = type._item;
  while (item !== null) {
    if (item.deleted) return true;
    item = (item.parent as Y.AbstractType<unknown>)._item;
  }
  return false;
}

/**
 * A relative position as a ProseMirror position, or `null` when it cannot be
 * placed: an item this document does not hold (another page's body), a block
 * that has been deleted, or a node the mapping does not know. The mapping's
 * walk dereferences a missing node's size and throws a bare TypeError for the
 * last case; that is translated into the same "cannot place" answer, which is
 * exactly what it means.
 */
function place(d: PageAnchorDocument, rel: Y.RelativePosition): number | null {
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, d.ydoc);
  if (abs === null || insideDeleted(abs.type)) return null;
  try {
    return relativePositionToAbsolutePosition(d.ydoc, d.fragment, rel, d.mapping);
  } catch {
    return null;
  }
}

/** A range that holds visible text, or `null`. */
function textRange(d: PageAnchorDocument, from: number | null, to: number | null) {
  if (from === null || to === null || from >= to) return null;
  if (rangeText(d.doc, from, to).trim().length === 0) return null;
  return { from, to };
}

// ── Building, encoding, resolving ───────────────────────────────────────────

/** A ProseMirror position as a Yjs (type, index) — never on the fragment itself. */
function yIndexAt(d: PageAnchorDocument, pos: number): Y.AbsolutePosition | null {
  try {
    const rel = absolutePositionToRelativePosition(
      pos,
      d.fragment,
      d.mapping,
    ) as Y.RelativePosition;
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, d.ydoc);
    // A position on the fragment's own child list names no block, and a
    // root-level position resolves in ANY page's document — refuse it.
    return abs === null || abs.type === d.fragment ? null : abs;
  } catch {
    return null;
  }
}

/**
 * Anchor the passage between two ProseMirror positions on the page body — the
 * editor's selection, whose positions are interchangeable with this module's
 * because both derive from the same fragment and `pageSchema`. Answers nothing,
 * and never throws, for an empty or whitespace-only range and for one whose ends
 * the mapping cannot convert faithfully, so a degenerate selection cannot
 * become a thread.
 */
export function anchorFromSelection(
  source: PageAnchorSource,
  from: number,
  to: number,
): PageAnchorSelection | null {
  const d = toAnchorDocument(source);
  const size = d.doc.content.size;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > size) return null;
  if (textRange(d, from, to) === null) return null;
  const head = yIndexAt(d, from);
  const tail = yIndexAt(d, to);
  if (head === null || tail === null) return null;
  const pair: PageAnchorPair = {
    start: Y.createRelativePositionFromTypeIndex(head.type, head.index, 0),
    end: Y.createRelativePositionFromTypeIndex(tail.type, tail.index, -1),
    before: Y.createRelativePositionFromTypeIndex(head.type, head.index, -1),
    after: Y.createRelativePositionFromTypeIndex(tail.type, tail.index, 0),
  };
  // The pair must name exactly the selection, read straight back.
  const back = resolveInner(d, pair);
  if (back === null || back.from !== from || back.to !== to) return null;
  return { pair, bytes: encodeAnchor(pair), quote: toQuote(rangeText(d.doc, from, to)) };
}

function resolveInner(d: PageAnchorDocument, pair: PageAnchorPair): PageAnchorRange | null {
  return textRange(d, place(d, pair.start), place(d, pair.end));
}

// ── Is the fallback's text still the quoted passage? ────────────────────────

/**
 * The share of the quote's words a restored passage must keep, in order. A
 * restore can bring back a passage that was edited after it was quoted (the
 * version restored holds the edit), so equality is too strict; text typed
 * fresh in the passage's place shares next to none of them.
 */
export const PAGE_ANCHOR_RESTORE_MATCH = 0.5;

const WORDS =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;

/** A text's words, case- and width-folded. Scripts written without spaces split per word too. */
function words(text: string): string[] {
  const folded = text.normalize('NFKC').toLocaleLowerCase();
  if (WORDS === null) return folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out: string[] = [];
  for (const part of WORDS.segment(folded)) if (part.isWordLike) out.push(part.segment);
  return out;
}

/** The length of the longest common subsequence of two word lists. */
function commonRun(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (const word of a) {
    const next = new Array<number>(b.length + 1).fill(0);
    for (let j = 0; j < b.length; j += 1) {
      next[j + 1] = word === b[j] ? prev[j]! + 1 : Math.max(prev[j + 1]!, next[j]!);
    }
    prev = next;
  }
  return prev[b.length]!;
}

/**
 * True when `text` is recognisably the passage `quote` was taken from: at least
 * `PAGE_ANCHOR_RESTORE_MATCH` of the longer of the two word lists appears in
 * both, in order. A quote cut at `PAGE_ANCHOR_QUOTE_MAX` is compared with the
 * same length of `text`.
 */
export function sameAsQuote(text: string, quote: string): boolean {
  const cut = quote.endsWith('…') && Array.from(quote).length === PAGE_ANCHOR_QUOTE_MAX;
  const head = cut ? quote.slice(0, -1) : quote;
  const candidate = cut ? Array.from(text.trim()).slice(0, Array.from(head).length).join('') : text;
  const a = words(head);
  const b = words(candidate);
  if (a.length === 0 || b.length === 0) return false;
  return commonRun(a, b) >= PAGE_ANCHOR_RESTORE_MATCH * Math.max(a.length, b.length);
}

/**
 * Where a pair's passage now is, or `null` when it is gone (see the header).
 * The outer pair answers only for text that matches `quote`.
 */
function resolveIn(
  d: PageAnchorDocument,
  pair: PageAnchorPair,
  quote: string | null | undefined,
): PageAnchorRange | null {
  const inner = resolveInner(d, pair);
  if (inner !== null || !quote) return inner;
  const outer = textRange(d, place(d, pair.before), place(d, pair.after));
  if (outer === null) return null;
  return sameAsQuote(rangeText(d.doc, outer.from, outer.to), quote) ? outer : null;
}

/**
 * Where a passage is now, against a page body; `null` when it is gone.
 * Recomputed every call. `quote` is the text the thread quoted; without it a
 * deleted-then-restored passage is not looked for (see the header).
 */
export function resolveAnchor(
  pair: PageAnchorPair,
  source: PageAnchorSource,
  quote?: string | null,
): PageAnchorRange | null {
  return resolveIn(toAnchorDocument(source), pair, quote);
}

/**
 * `resolveAnchor` for each pair, in order, reading the page body ONCE for the
 * list. `quotes[i]` is pair i's quote.
 */
export function resolveAnchors(
  pairs: readonly PageAnchorPair[],
  source: PageAnchorSource,
  quotes: readonly (string | null | undefined)[] = [],
): (PageAnchorRange | null)[] {
  const d = toAnchorDocument(source);
  return pairs.map((pair, i) => resolveIn(d, pair, quotes[i]));
}

const POSITION_ORDER = ['start', 'end', 'before', 'after'] as const;

/**
 * The bytes the `anchor` column stores: the format version, then each of the
 * four positions as Yjs encodes a relative position, each preceded by its
 * length as four big-endian bytes.
 */
export function encodeAnchor(pair: PageAnchorPair): Uint8Array {
  const parts = POSITION_ORDER.map((name) => Y.encodeRelativePosition(pair[name]));
  const out = new Uint8Array(1 + parts.reduce((n, part) => n + 4 + part.length, 0));
  const view = new DataView(out.buffer);
  out[0] = PAGE_ANCHOR_FORMAT_VERSION;
  let at = 1;
  for (const part of parts) {
    view.setUint32(at, part.length);
    out.set(part, at + 4);
    at += 4 + part.length;
  }
  return out;
}

/** Split the version-1 body into its four length-prefixed parts, or `null`. */
function splitParts(bytes: Uint8Array): Uint8Array[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  let at = 1;
  for (let i = 0; i < POSITION_ORDER.length; i += 1) {
    if (at + 4 > bytes.length) return null;
    const length = view.getUint32(at);
    if (length === 0 || at + 4 + length > bytes.length) return null;
    parts.push(bytes.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return at === bytes.length ? parts : null;
}

/**
 * A stored anchor read back, or `null` for bytes that are not this format —
 * empty, truncated, trailing garbage, an unknown version, or a position Yjs
 * cannot decode. It never throws: one unreadable row must render as a
 * page-level thread, never fail the page read.
 */
export function decodeAnchor(bytes: Uint8Array): PageAnchorPair | null {
  if (bytes.length === 0 || bytes[0] !== PAGE_ANCHOR_FORMAT_VERSION) return null;
  const parts = splitParts(bytes);
  if (parts === null) return null;
  try {
    const [start, end, before, after] = parts.map((part) => Y.decodeRelativePosition(part));
    return { start: start!, end: end!, before: before!, after: after! };
  } catch {
    return null;
  }
}

/** The one call for bytes that came out of a row: where the passage is, or `null`. */
export function resolveStoredAnchor(
  bytes: Uint8Array,
  source: PageAnchorSource,
  quote?: string | null,
): PageAnchorRange | null {
  const pair = decodeAnchor(bytes);
  return pair === null ? null : resolveAnchor(pair, source, quote);
}
