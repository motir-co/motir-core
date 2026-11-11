import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import type * as Y from 'yjs';
import { anchorFromSelection } from '../document/anchor';

// COMMENT ON A PASSAGE — the headless half (Story MOTIR-10867 · MOTIR-10900):
// read the reader's selection, decide whether it may become a thread, capture it
// as the anchor the create door stores, and place the two floating surfaces
// (`design/pages/design-notes.md` § _Commenting on a passage_, the Selection
// action and the Inline composer).
//
// ⚠️ THE SELECTION IS THE BROWSER'S. A reader who may comment but not edit reads
// a body the editor keeps non-editable, and there ProseMirror holds no selection
// of its own — the reader's is the window's. So both bodies are read the same
// way: the window's selection, kept only when both its ends lie inside the
// editor's DOM, mapped to document positions through the view.
//
// ⚠️ NOTHING HERE WRITES. The anchor is bytes in a request; capturing it reads the
// editor's live Yjs document through the codec and opens no transaction.

/** The keyboard route to the Selection action (the design leaves the binding here). */
export const PASSAGE_COMMENT_KEY = 'Mod-Shift-m';

/** A captured passage: the codec's bytes as standard padded base64, and its quote. */
export interface PagePassageAnchor {
  readonly bytes: string;
  readonly quote: string;
}

/** A selected range on the page body, `from < to`. */
export interface PagePassageRange {
  readonly from: number;
  readonly to: number;
}

/** Where a floating surface sits in the body wrapper, and on which side of the passage. */
export interface PagePassagePlacement {
  readonly left: number;
  readonly top: number;
  /** `above` — the surface's bottom edge is at `top` (the CSS lifts it by its height). */
  readonly side: 'below' | 'above';
  /** The composer's width; absent for the action, which sizes itself. */
  readonly width?: number;
}

/** True for the `Mod-Shift-m` binding, Mod being ⌘ or Ctrl. */
export function isPassageCommentKey(event: KeyboardEvent): boolean {
  return (
    event.shiftKey && !event.altKey && (event.metaKey || event.ctrlKey) && event.code === 'KeyM'
  );
}

/**
 * The window's selection as a range on the page body, or `null`: no selection,
 * a collapsed one, or one with an end outside the editor's DOM. A selection made
 * right to left arrives with its ends swapped and is put in order.
 */
export function readPassageSelection(view: EditorView): PagePassageRange | null {
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (!anchorNode || !focusNode) return null;
  if (!view.dom.contains(anchorNode) || !view.dom.contains(focusNode)) return null;
  try {
    const a = view.posAtDOM(anchorNode, anchorOffset);
    const b = view.posAtDOM(focusNode, focusOffset);
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    return from < to ? { from, to } : null;
  } catch {
    // A DOM point ProseMirror cannot map (inside a node view's own chrome).
    return null;
  }
}

/** A leaf's text, as the codec's quote reads it: a chip's label, a break's space. */
function leafText(node: ProseMirrorNode): string {
  if (node.type.name === 'hardBreak') return ' ';
  const label = node.attrs['label'] as unknown;
  const id = node.attrs['id'] as unknown;
  if (typeof label === 'string' && label.length > 0) return label;
  return typeof id === 'string' ? id : '';
}

/** The cheap visibility test: the range holds more than whitespace. */
export function selectionIsCommentable(doc: ProseMirrorNode, range: PagePassageRange): boolean {
  if (range.from < 0 || range.to > doc.content.size || range.from >= range.to) return false;
  return doc.textBetween(range.from, range.to, ' ', leafText).trim().length > 0;
}

/** Standard padded base64 — the form the create door's grammar accepts. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The passage as the create door stores it, read from the editor's live Yjs
 * document — or `null` whenever the codec answers nothing (whitespace, an empty
 * range, ends it cannot place), so such a range can never become a thread.
 */
export function capturePassageAnchor(
  doc: Y.Doc,
  range: PagePassageRange,
): PagePassageAnchor | null {
  const anchor = anchorFromSelection(doc, range.from, range.to);
  return anchor === null ? null : { bytes: toBase64(anchor.bytes), quote: anchor.quote };
}

/** The viewport the placement reads, passed in so it stays a pure function. */
export interface PagePassageViewport {
  readonly width: number;
  readonly height: number;
}

/** Below this the panel is a sheet, the action goes above, the composer takes the body's width. */
export const PASSAGE_WIDE_MIN = 1280;
/** The composer's width on a wide screen (the design's 320–420px band). */
const COMPOSER_WIDTH = 380;

function lines(rects: readonly DOMRect[], box: DOMRect) {
  const first = rects[0] ?? box;
  const last = rects[rects.length - 1] ?? box;
  return { first, last };
}

/**
 * The Selection action: at the END of the selection, 4px under its last line —
 * or, below 1280px, 4px above it, out of the way of the platform's handles.
 */
export function placeAction(
  box: DOMRect,
  rects: readonly DOMRect[],
  viewport: PagePassageViewport,
): PagePassagePlacement {
  const { last } = lines(rects, box);
  const left = Math.max(0, Math.round(last.right - box.left));
  if (viewport.width < PASSAGE_WIDE_MIN) {
    return { left, top: Math.round(last.top - box.top - 4), side: 'above' };
  }
  return { left, top: Math.round(last.bottom - box.top + 4), side: 'below' };
}

/**
 * The Inline composer: 8px under the passage's last line, aligned to its start
 * — above its first line when the passage ends in the viewport's bottom third.
 * 380px wide and never over the body's width; at the body's width below 1280px.
 */
export function placeComposer(
  box: DOMRect,
  rects: readonly DOMRect[],
  viewport: PagePassageViewport,
): PagePassagePlacement {
  const { first, last } = lines(rects, box);
  const body = Math.max(0, Math.round(box.width));
  const width = viewport.width < PASSAGE_WIDE_MIN ? body : Math.min(body, COMPOSER_WIDTH);
  const left = Math.min(Math.max(0, Math.round(first.left - box.left)), Math.max(0, body - width));
  if (last.bottom > (viewport.height * 2) / 3) {
    return { left, top: Math.round(first.top - box.top - 8), side: 'above', width };
  }
  return { left, top: Math.round(last.bottom - box.top + 8), side: 'below', width };
}
