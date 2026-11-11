'use client';

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { MessageSquarePlus, X } from 'lucide-react';
import type { PageEditorMessages } from './messages';
import type { PagePassageAnchor, PagePassagePlacement } from './passageComment';

export type { PagePassageAnchor } from './passageComment';

// COMMENT ON A PASSAGE — the drawn half (Story MOTIR-10867 · MOTIR-10900), the
// design's Selection action and Inline composer frame. Both sit inside the
// editor's positioned body wrapper (`data-mention-anchor`), the mention picker's
// grammar, never in a body portal.
//
// The comment EDITOR inside the composer is the app's shipped composer and
// arrives through `renderComposer`: the package draws the frame around it — the
// Quote slot, the Close control, the placement, focus on open, Esc — and no
// string of its own.

/** What the host's composer is handed. */
export interface PagePassageComposerRenderProps {
  /** The passage captured when the reader chose the action. */
  readonly anchor: PagePassageAnchor;
  /** Close the composer — Cancel, and after a successful post. */
  readonly close: () => void;
}

/**
 * The page editor's passage-comment capability. Supplied → a reader may comment
 * on a passage (`comment:add` on a live page); omitted → no action is offered.
 */
export interface PagePassageCommentProps {
  /** The composer's body: the app's comment editor, posting with the anchor. */
  readonly renderComposer: (props: PagePassageComposerRenderProps) => ReactNode;
}

const placed = (at: PagePassagePlacement) => ({
  left: at.left,
  top: at.top,
  ...(at.width === undefined ? {} : { width: at.width }),
});

/** The Selection action: a pill at the end of the selection. */
export function PassageCommentAction({
  placement,
  messages,
  onChoose,
}: {
  placement: PagePassagePlacement;
  messages: PageEditorMessages['passageComment'];
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      className="motir-passage-action"
      data-side={placement.side}
      style={placed(placement)}
      aria-label={messages.actionLabel}
      // The press must not move focus: the browser would collapse the selection
      // on it and leave nothing to capture. The click does the work, and a
      // keyboard activation fires a click with no press, so both routes meet.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onChoose}
    >
      <MessageSquarePlus className="h-4 w-4" aria-hidden />
      {messages.action}
    </button>
  );
}

/** Focusable things inside the composer, the editor first. */
const EDITABLE = '[contenteditable="true"], textarea, input:not([type="hidden"])';

/** The Inline composer's frame around the host's composer. */
export function PassageCommentComposer({
  anchor,
  placement,
  messages,
  onClose,
  renderComposer,
}: {
  anchor: PagePassageAnchor;
  placement: PagePassagePlacement;
  messages: PageEditorMessages['passageComment'];
  onClose: () => void;
  renderComposer: PagePassageCommentProps['renderComposer'];
}) {
  const frameRef = useRef<HTMLDivElement>(null);

  // Focus moves into the editor on open. The shipped editor renders on the
  // client only, so it mounts some time after the frame does — how long depends
  // on the machine, not on a frame count. The frame takes focus at once (so the
  // body lets go and Esc already works), and focus moves on into the editor the
  // moment it appears, unless the reader has put it somewhere else meanwhile.
  useEffect(() => {
    // The frame is drawn unconditionally, so its ref is set before any effect runs.
    const root = frameRef.current!;
    const editable = () => root.querySelector<HTMLElement>(EDITABLE);
    const present = editable();
    if (present) {
      present.focus();
      return;
    }
    root.focus();
    const observer = new MutationObserver(() => {
      const target = editable();
      if (!target) return;
      observer.disconnect();
      if (root.ownerDocument.activeElement === root) target.focus();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['contenteditable'],
    });
    return () => observer.disconnect();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // Esc closes and never posts; the panel behind does not also take it.
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <div
      ref={frameRef}
      role="group"
      aria-label={messages.composerLabel}
      tabIndex={-1}
      className="motir-passage-composer"
      data-side={placement.side}
      style={placed(placement)}
      onKeyDown={onKeyDown}
    >
      <div className="motir-passage-composer-head">
        <blockquote
          className="motir-passage-quote"
          aria-label={messages.quoteLabel(anchor.quote)}
          data-testid="passage-composer-quote"
        >
          <span>{anchor.quote}</span>
        </blockquote>
        <button
          type="button"
          className="motir-passage-close"
          aria-label={messages.close}
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {renderComposer({ anchor, close: onClose })}
    </div>
  );
}
