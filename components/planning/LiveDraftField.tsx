'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { LiveField } from '@/lib/planning/liveDraft';

// ONE FIELD OF A CARD BEING WRITTEN (Story MOTIR-11190 · Subtask MOTIR-11201;
// design `design/ai-planning/design-notes.md` Part XXIX §29.2, §29.3, §29.6).
//
// The field's STORED element (or its empty state) stays in the tree, `sr-only`:
// a screen reader never meets a partial value, and nothing is announced as the
// text grows. What a sighted reader sees is an `aria-hidden`, `inert` COPY of the
// field's own element rendering the PARTIAL text, so a list item or a paragraph
// grows inside its real block and the hand-over to the stored value moves
// nothing. When this field grew last it holds the caret — the shipped static
// caret, after the last character, inside the block that character sits in. It
// does not blink: a blink is a loop.
//
// The partial is rendered by React into a `hidden` source and CLONED into the
// copy, because the caret has to sit inside markup React owns (a `<p>` the
// markdown renderer emitted); inserting a node into React's own tree would be
// undone, or trip it, on the next render.
//
// It decides nothing: which fields are live and which one grew last are the
// panel's (`lib/planning/liveDraft.ts`).

export const LIVE_CARET_CLASS =
  'inline-block h-[1em] w-0.5 align-text-bottom bg-(--el-accent-on-surface)';

/** The last non-empty text node under `root`, in document order. */
function lastText(root: Node): Text | null {
  for (let i = root.childNodes.length - 1; i >= 0; i--) {
    const child = root.childNodes[i]!;
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child as Text).data.trim().length > 0) return child as Text;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const found = lastText(child);
      if (found) return found;
    }
  }
  return null;
}

/** The deepest last element under `root` — where the caret goes when no text has arrived. */
function lastElement(root: Element): Element {
  let at = root;
  while (at.lastElementChild) at = at.lastElementChild;
  return at;
}

export function LiveDraftField({
  field,
  partial,
  stored,
  growing,
}: {
  field: LiveField;
  /** The field's own element, rendering the PARTIAL text. */
  partial: ReactNode;
  /** The field's own element, rendering the STORED value or its empty state. */
  stored: ReactNode;
  /** This field grew on the latest read: it holds the caret. */
  growing: boolean;
}) {
  const sourceRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const drawn = useRef<string | null>(null);

  // Every render, but a no-op unless the partial's markup or the caret changed.
  useLayoutEffect(() => {
    const source = sourceRef.current;
    const copy = copyRef.current;
    if (!source || !copy) return;
    const stamp = `${growing ? 1 : 0}${source.innerHTML}`;
    if (drawn.current === stamp) return;
    drawn.current = stamp;
    const clone = document.createElement('div');
    for (const node of source.childNodes) clone.appendChild(node.cloneNode(true));
    for (const el of clone.querySelectorAll('[id]')) el.removeAttribute('id');
    if (growing) {
      const caret = document.createElement('span');
      caret.className = LIVE_CARET_CLASS;
      caret.setAttribute('aria-hidden', 'true');
      caret.setAttribute('data-live-caret', '');
      const text = lastText(clone);
      if (text) text.parentNode!.insertBefore(caret, text.nextSibling);
      else lastElement(clone).appendChild(caret);
    }
    copy.replaceChildren(...clone.childNodes);
  });

  return (
    <div
      className="min-w-0"
      data-testid={`quick-view-live-${field}`}
      data-live-field={growing ? 'growing' : 'partial'}
    >
      {/* The React-rendered source the copy is cloned from: never shown, never read. */}
      <div ref={sourceRef} hidden aria-hidden="true">
        {partial}
      </div>
      <div ref={copyRef} aria-hidden="true" inert data-live-partial="" />
      <div className="sr-only">{stored}</div>
    </div>
  );
}
