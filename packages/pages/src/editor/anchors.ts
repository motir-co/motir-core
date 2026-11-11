import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { Mapping } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type * as Y from 'yjs';
import {
  anchorDocument,
  decodeAnchor,
  resolveAnchors,
  type PageAnchorPair,
  type PageAnchorRange,
} from '../document/anchor';

// The PASSAGE WASH (Story MOTIR-10867 · MOTIR-10899): every open inline thread's
// passage drawn as an editor DECORATION over the text it is anchored to, under
// `design/pages/design-notes.md` § _Commenting on a passage_ (the Passage wash,
// its emphasis, the Overlap hairline and the Passage tooltip).
//
// ⚠️ IT NEVER WRITES. A decoration is view state: it is not in the ProseMirror
// document, so the collaboration binding never turns it into a Yjs update, and
// the page's `bodyState` and `revision` cannot move because somebody commented.
// The one transaction this module dispatches carries metadata only, and only
// when the answer changed.
//
// ⚠️ WHERE THE RESOLVE PASS RUNS. A plugin's `apply` runs BEFORE the
// collaboration binding writes the reader's change into the Yjs document (the
// binding writes from its plugin VIEW's `update`, after the state is applied),
// so a resolve there reads the body as it stood one keystroke ago — a wash that
// trails the text looks exactly like a wash with no bug. So:
//
//   - every transaction MAPS the washes already drawn through its own mapping,
//     which keeps the wash on the text between frames at no cost;
//   - the resolve pass listens on the Yjs document itself (`update`, local and
//     remote alike) and runs ONCE, in a microtask, after the burst that wrote it
//     has settled — when the document holds the change. It reads the body once
//     for the whole list (`resolveAnchors`) and dispatches a META-ONLY
//     transaction, or nothing at all when the answer is what is already drawn.
//
// THE WASH IS A PARTITION. Two threads over one sentence must read as one wash,
// not a darker patch, so the resolved ranges are cut into non-overlapping
// stretches (`partitionWashes`): one wash per connected run of text, each
// stretch carrying the ids that cover it in the order their ranges begin. The
// first id is a click's target and the count is the tooltip's; a stretch two
// threads share carries the Overlap hairline. Each stretch is emitted once per
// textblock it crosses, so a passage running into the next paragraph is washed
// on both sides with no gap.

/** One anchored root as the editor draws it — the host maps the wire to this. */
export interface PageInlineThreadView {
  /** The root comment's id. */
  readonly id: string;
  /** The stored anchor, as bytes (`encodeAnchor`'s output). */
  readonly anchor: Uint8Array;
  /** The text the passage held when the thread was started. */
  readonly quote: string;
  /** The root's author, for the Passage tooltip. */
  readonly authorName: string;
  /** When the thread was resolved; a resolved thread draws no wash. */
  readonly resolvedAt: string | null;
}

/** One thread's resolved range, as `partitionWashes` takes it. */
export interface PageAnchorSpan {
  readonly id: string;
  readonly from: number;
  readonly to: number;
}

/** A part of a wash covered by the same threads. */
export interface PageAnchorStretch {
  readonly from: number;
  readonly to: number;
  /** The threads covering it, ordered by where their ranges begin. */
  readonly ids: readonly string[];
}

/** One wash: a connected run of commented text, and its stretches. */
export interface PageAnchorWash {
  readonly from: number;
  readonly to: number;
  /** Every thread in the wash, ordered by where its range begins. */
  readonly ids: readonly string[];
  readonly stretches: readonly PageAnchorStretch[];
}

/** Each anchored root's verdict after a pass: its range, or `null` when gone. */
export type PageInlineAnchorVerdicts = Readonly<Record<string, PageAnchorRange | null>>;

/** What the drawn passage was hovered or focused over — the tooltip's input. */
export interface PageAnchorTarget {
  /** The stretch's threads, first is the click target. */
  readonly ids: readonly string[];
  /** The washed element, to place the tooltip against. */
  readonly element: HTMLElement;
}

/** The latest inputs, read through a getter so a parent re-render never rebuilds the editor. */
export interface InlineCommentInputs {
  readonly threads: readonly PageInlineThreadView[];
  readonly focusedThreadId: string | null;
  readonly onResolved?: (verdicts: PageInlineAnchorVerdicts) => void;
  readonly onClick?: (rootId: string) => void;
  /** A wash hovered or keyboard-focused (`null` when it is left or Esc dismisses it). */
  readonly onTarget?: (target: PageAnchorTarget | null) => void;
}

export interface InlineCommentDecorationsOptions {
  /** The editor's own Yjs document — the one the collaboration binding writes. */
  readonly doc: Y.Doc;
  readonly read: () => InlineCommentInputs;
}

/**
 * Cut resolved ranges into washes: touching and overlapping ranges join one
 * wash, disjoint ones stay apart, and inside a wash each stretch names the
 * threads covering it, ordered by where their ranges begin (ties keep the input
 * order). Empty ranges are dropped.
 */
export function partitionWashes(spans: readonly PageAnchorSpan[]): PageAnchorWash[] {
  const ordered = spans
    .map((span, index) => ({ span, index }))
    .filter(({ span }) => span.from < span.to)
    .sort((a, b) => a.span.from - b.span.from || a.index - b.index)
    .map(({ span }) => span);

  const groups: PageAnchorSpan[][] = [];
  let end = -Infinity;
  for (const span of ordered) {
    const group = groups.at(-1);
    if (group && span.from <= end) {
      group.push(span);
      end = Math.max(end, span.to);
    } else {
      groups.push([span]);
      end = span.to;
    }
  }

  return groups.map((group) => {
    const cuts = [...new Set(group.flatMap((s) => [s.from, s.to]))].sort((a, b) => a - b);
    const stretches: PageAnchorStretch[] = [];
    for (let i = 0; i + 1 < cuts.length; i += 1) {
      const from = cuts[i]!;
      const to = cuts[i + 1]!;
      // Every cut is some range's end, so the set covering a stretch differs
      // from its neighbour's: no two neighbours ever need merging.
      stretches.push({
        from,
        to,
        ids: group.filter((s) => s.from <= from && s.to >= to).map((s) => s.id),
      });
    }
    return {
      from: group[0]!.from,
      to: Math.max(...group.map((s) => s.to)),
      ids: group.map((s) => s.id),
      stretches,
    };
  });
}

// ── The plugin ──────────────────────────────────────────────────────────────

/** The plugin's key; its state is what is drawn now. */
export const inlineCommentsKey = new PluginKey<InlineCommentsState>('motirInlineComments');

interface InlineCommentsState {
  readonly washes: readonly PageAnchorWash[];
  readonly focusedId: string | null;
  readonly hoverId: string | null;
  /** Bumped when the inputs change, so the view runs a pass. */
  readonly version: number;
  readonly decorations: DecorationSet;
}

type InlineCommentsMeta =
  | { readonly type: 'washes'; readonly washes: readonly PageAnchorWash[] }
  | { readonly type: 'inputs'; readonly focusedId: string | null }
  | { readonly type: 'hover'; readonly id: string | null };

/** A wash moved through a transaction's mapping, or dropped when its text went. */
function mapWash(wash: PageAnchorWash, mapping: Mapping): PageAnchorWash | null {
  const stretches = wash.stretches
    .map((s) => ({ ...s, from: mapping.map(s.from, 1), to: mapping.map(s.to, -1) }))
    .filter((s) => s.from < s.to);
  if (stretches.length === 0) return null;
  return {
    ...wash,
    from: stretches[0]!.from,
    to: Math.max(...stretches.map((s) => s.to)),
    stretches,
  };
}

/** One inline decoration per textblock a stretch crosses. */
function stretchDecorations(
  doc: ProseMirrorNode,
  stretch: PageAnchorStretch,
  attrs: Record<string, string>,
): Decoration[] {
  const out: Decoration[] = [];
  doc.nodesBetween(stretch.from, stretch.to, (node, pos) => {
    if (!node.isTextblock) return true;
    const from = Math.max(stretch.from, pos + 1);
    const to = Math.min(stretch.to, pos + node.nodeSize - 1);
    if (from < to) out.push(Decoration.inline(from, to, attrs));
    return false;
  });
  return out;
}

function buildDecorations(
  doc: ProseMirrorNode,
  washes: readonly PageAnchorWash[],
  focusedId: string | null,
  hoverId: string | null,
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const wash of washes) {
    for (const stretch of wash.stretches) {
      const emphasis = focusedId !== null && stretch.ids.includes(focusedId);
      const attrs: Record<string, string> = {
        class: stretch.ids.length > 1 ? 'motir-wash is-overlap' : 'motir-wash',
        'data-wash-ids': stretch.ids.join(' '),
        'data-wash-state': emphasis ? 'emphasis' : 'rest',
      };
      if (emphasis) attrs['tabindex'] = '-1';
      if (hoverId !== null && stretch.ids.includes(hoverId)) attrs['data-wash-hover'] = '';
      decorations.push(...stretchDecorations(doc, stretch, attrs));
    }
  }
  return DecorationSet.create(doc, decorations);
}

/** A stable rendering of what is drawn, to tell a pass that changed nothing. */
function washKey(washes: readonly PageAnchorWash[]): string {
  return JSON.stringify(washes.map((w) => w.stretches.map((s) => [s.from, s.to, s.ids])));
}

/** The washed element an event landed in, and the ids it carries. */
function washTarget(target: EventTarget | null): PageAnchorTarget | null {
  if (!target || typeof (target as Element).closest !== 'function') return null;
  const element = (target as Element).closest<HTMLElement>('[data-wash-ids]');
  const ids = element?.dataset['washIds']?.split(' ').filter(Boolean) ?? [];
  return element && ids.length > 0 ? { ids, element } : null;
}

/** How many times a pass waits for the editor to catch up with its document. */
const SETTLE_RETRIES = 5;

function inlineCommentsPlugin({ doc, read }: InlineCommentDecorationsOptions): Plugin {
  let target: PageAnchorTarget | null = null;

  const setTarget = (view: EditorView, next: PageAnchorTarget | null) => {
    const same =
      (next === null && target === null) ||
      (next !== null && target !== null && next.element === target.element);
    if (same) return;
    target = next;
    const id = next?.ids[0] ?? null;
    if (inlineCommentsKey.getState(view.state)?.hoverId !== id) {
      view.dispatch(
        view.state.tr
          .setMeta(inlineCommentsKey, { type: 'hover', id } satisfies InlineCommentsMeta)
          .setMeta('addToHistory', false),
      );
    }
    read().onTarget?.(next);
  };

  return new Plugin<InlineCommentsState>({
    key: inlineCommentsKey,
    state: {
      init: () => ({
        washes: [],
        focusedId: read().focusedThreadId,
        hoverId: null,
        version: 0,
        decorations: DecorationSet.empty,
      }),
      apply: (tr: Transaction, prev, _old, next) => {
        const meta = tr.getMeta(inlineCommentsKey) as InlineCommentsMeta | undefined;
        if (!tr.docChanged && meta === undefined) return prev;
        let { washes, focusedId, hoverId, version } = prev;
        if (tr.docChanged) {
          washes = washes
            .map((w) => mapWash(w, tr.mapping))
            .filter((w): w is PageAnchorWash => w !== null);
        }
        if (meta?.type === 'washes') washes = meta.washes;
        if (meta?.type === 'inputs') {
          focusedId = meta.focusedId;
          version += 1;
        }
        if (meta?.type === 'hover') hoverId = meta.id;
        return {
          washes,
          focusedId,
          hoverId,
          version,
          decorations: buildDecorations(next.doc, washes, focusedId, hoverId),
        };
      },
    },
    props: {
      decorations: (state) => inlineCommentsKey.getState(state)?.decorations,
      handleDOMEvents: {
        click: (_view, event) => {
          const hit = washTarget(event.target);
          if (hit) read().onClick?.(hit.ids[0]!);
          // The caret still lands where the reader clicked.
          return false;
        },
        mouseover: (view, event) => {
          setTarget(view, washTarget(event.target));
          return false;
        },
        mouseleave: (view) => {
          setTarget(view, null);
          return false;
        },
        focusin: (view, event) => {
          const hit = washTarget(event.target);
          if (hit) setTarget(view, hit);
          return false;
        },
        focusout: (view, event) => {
          if (washTarget(event.target)) setTarget(view, null);
          return false;
        },
      },
      handleKeyDown: (view, event) => {
        if (event.key === 'Escape' && target !== null) setTarget(view, null);
        return false;
      },
    },
    view: (editorView) => {
      let scheduled = false;
      let destroyed = false;
      let retries = 0;
      let lastVerdicts: string | null = null;

      const pass = () => {
        scheduled = false;
        if (destroyed) return;
        const view = editorView;
        const inputs = read();
        const pairs: (PageAnchorPair | null)[] = inputs.threads.map((t) => decodeAnchor(t.anchor));
        const decodable = pairs.filter((p): p is PageAnchorPair => p !== null);
        let ranges: (PageAnchorRange | null)[] = [];
        if (decodable.length > 0) {
          const body = anchorDocument(doc);
          if (body.fragment.length > 0) {
            // The editor must hold the document the pass read; until the binding
            // has rendered it, wait a tick rather than draw a stale position.
            if (body.doc.content.size !== view.state.doc.content.size) {
              if (retries < SETTLE_RETRIES) {
                retries += 1;
                setTimeout(schedule, 0);
              }
              return;
            }
            ranges = resolveAnchors(decodable, body);
          }
        }
        retries = 0;
        const verdicts: Record<string, PageAnchorRange | null> = {};
        const spans: PageAnchorSpan[] = [];
        let at = 0;
        inputs.threads.forEach((thread, i) => {
          const range = pairs[i] === null ? null : (ranges[at++] ?? null);
          verdicts[thread.id] = range;
          if (range !== null && thread.resolvedAt === null) spans.push({ id: thread.id, ...range });
        });
        const washes = partitionWashes(spans);
        const current = inlineCommentsKey.getState(view.state);
        if (current && washKey(current.washes) !== washKey(washes)) {
          view.dispatch(
            view.state.tr
              .setMeta(inlineCommentsKey, { type: 'washes', washes } satisfies InlineCommentsMeta)
              .setMeta('addToHistory', false),
          );
        }
        const verdictKey = JSON.stringify(verdicts);
        if (verdictKey !== lastVerdicts) {
          lastVerdicts = verdictKey;
          inputs.onResolved?.(verdicts);
        }
      };

      function schedule() {
        if (scheduled || destroyed) return;
        scheduled = true;
        queueMicrotask(pass);
      }

      doc.on('update', schedule);
      schedule();
      return {
        update: (view, prevState) => {
          const before = inlineCommentsKey.getState(prevState)?.version;
          if (inlineCommentsKey.getState(view.state)?.version !== before) schedule();
        },
        destroy: () => {
          destroyed = true;
          doc.off('update', schedule);
        },
      };
    },
  });
}

/**
 * The passage-wash extension. `read` is called for the latest inputs whenever
 * they are needed; after they change, call `refreshInlineComments` so the
 * focus state is redrawn and the list is resolved again.
 */
export function inlineCommentDecorations(options: InlineCommentDecorationsOptions): Extension {
  return Extension.create({
    name: 'motirInlineComments',
    addProseMirrorPlugins: () => [inlineCommentsPlugin(options)],
  });
}

/** The extension with an inputs box of its own — what a React host holds. */
export interface InlineComments {
  readonly extension: Extension;
  /** Replace the inputs; follow with `refreshInlineComments` once the editor exists. */
  setInputs(inputs: InlineCommentInputs): void;
}

/** `inlineCommentDecorations` over a box the caller writes with `setInputs`. */
export function createInlineComments(doc: Y.Doc): InlineComments {
  let inputs: InlineCommentInputs = { threads: [], focusedThreadId: null };
  return {
    extension: inlineCommentDecorations({ doc, read: () => inputs }),
    setInputs: (next) => {
      inputs = next;
    },
  };
}

/** Tell the extension its inputs changed: redraw the focus and resolve again. */
export function refreshInlineComments(view: EditorView, focusedId: string | null): void {
  view.dispatch(
    view.state.tr
      .setMeta(inlineCommentsKey, { type: 'inputs', focusedId } satisfies InlineCommentsMeta)
      .setMeta('addToHistory', false),
  );
}
