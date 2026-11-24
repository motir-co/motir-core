// The canvas card's top-edge TAB, as class strings (MOTIR-12158; design
// MOTIR-12157). `CardEdgeTab` (`WorkItemNode.tsx`) places them on a card's top
// edge; the edge legend draws a static specimen from the same two, so the tab a
// card wears and the one the legend shows can never drift apart. Kept free of
// React so the theme contrast test can import the tone it measures.

/**
 * The tab's own box — its size, shape tokens and type — WITHOUT the placement on
 * the card's top edge: the tag row's one chip size (`h-5`, 11px), the chip's own
 * shape tokens (`--radius-badge` on the top corners, `chip-x-6`), so a style swap
 * reshapes it; the bottom corners stay square because they join the frame.
 */
export const CARD_EDGE_TAB_SHAPE =
  'inline-flex h-5 items-center gap-1 rounded-t-(--radius-badge) px-(--spacing-chip-x-6) text-[11px] leading-none font-semibold whitespace-nowrap';

/** The placement on the card's top-left edge, overlapping the frame's 1px top
 *  border so the tab and the border read as one shape, a folder tab. */
export const CARD_EDGE_TAB_PLACEMENT = 'absolute bottom-[calc(100%-1px)] left-3 z-10';

/**
 * The blocked tab's fill + ink: the DANGER fill / ink pair — the one pair
 * `--el-danger-text` is legal in, `Button`'s danger variant's own — so the tab and
 * the blocked card's danger frame read as one red shape. Its AA floor across every
 * palette is pinned by `tests/theme/dangerFillInkContrast.test.ts`.
 */
export const BLOCKED_TAB_TONE = 'bg-(--el-danger) text-(--el-danger-text)';
