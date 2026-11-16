// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Columns3, Rows3 } from 'lucide-react';
import type { BoardTypeDto } from '@/lib/dto/boards';
import { BOARD_TYPE_ICON, BoardTypeIcon } from '@/app/(authed)/boards/_components/boardTypeIcon';

// The shared board type → glyph map (MOTIR-11323): one copy for the switcher
// trigger, the switcher rows and the create dialog.
afterEach(cleanup);

describe('BoardTypeIcon (MOTIR-11323)', () => {
  it('maps kanban to the column glyph and scrum to the row glyph', () => {
    expect(BOARD_TYPE_ICON.kanban).toBe(Columns3);
    expect(BOARD_TYPE_ICON.scrum).toBe(Rows3);
  });

  it('renders the glyph for its type and passes props through', () => {
    const { container } = render(<BoardTypeIcon type="scrum" aria-hidden className="size-4" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('class')).toContain('lucide-rows-3');
    expect(svg.getAttribute('class')).toContain('size-4');
    expect(svg.getAttribute('data-board-type')).toBe('scrum');
  });

  it('falls back to the kanban glyph for a type the map does not know', () => {
    const { container } = render(<BoardTypeIcon type={'roadmap' as BoardTypeDto} />);
    expect(container.querySelector('svg')!.getAttribute('class')).toContain('lucide-columns-3');
  });
});
