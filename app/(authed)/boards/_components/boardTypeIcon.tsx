import { createElement } from 'react';
import { Columns3, Rows3, type LucideIcon, type LucideProps } from 'lucide-react';
import type { BoardTypeDto } from '@/lib/dto/boards';

// The board type → glyph map (MOTIR-11323). ONE copy, read by every surface that
// draws a board's type: the switcher trigger (keyed on the ACTIVE board), each
// board row in the switcher menu, and the create dialog's Kanban / Scrum tiles.
// Kanban is the column glyph and Scrum the row glyph, as the create dialog drew
// them first (design/boards/multi-board.mock.html).
export const BOARD_TYPE_ICON: Readonly<Record<BoardTypeDto, LucideIcon>> = {
  kanban: Columns3,
  scrum: Rows3,
};

/** A board type's glyph — the kanban one for a type the map does not know. */
export function BoardTypeIcon({ type, ...props }: { type: BoardTypeDto } & LucideProps) {
  // `data-board-type` names the drawn type for tests and styling; a data attribute
  // is not in LucideProps, so it rides a spread object rather than a literal.
  const svgProps = { ...props, 'data-board-type': type };
  return createElement(BOARD_TYPE_ICON[type] ?? Columns3, svgProps);
}
