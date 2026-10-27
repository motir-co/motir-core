import { describe, expect, it } from 'vitest';
import { renderMock } from '../src/mock';
import type { RenderMockOptions } from '../src/mock';
import { Button } from '../src/index';

// MOTIR-9758 — `boardWidth`: the board used to be hard-coded to a 64rem column,
// so a mock of a page that ships wider was drawn squeezed into the middle, and
// authors string-replaced the class in the rendered HTML to widen it.

const NARROW = 'mx-auto flex max-w-[64rem] flex-col gap-8 p-8';

const base: RenderMockOptions = {
  title: 'Board width',
  axes: { styleId: 'warm-editorial', paletteId: 'motir', typeId: 'motir' },
  panels: [
    {
      label: 'Wide page',
      element: (
        <div className="w-[1400px]">
          <Button>Go</Button>
        </div>
      ),
    },
  ],
};

/** The class attribute of the board's `<main>`. */
function boardClass(html: string): string {
  const match = html.match(/<main class="([^"]*)"/);
  expect(match, 'the document carries the board <main>').not.toBeNull();
  return match![1]!;
}

function styleText(html: string): string {
  return html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
}

describe('renderMock boardWidth', () => {
  it('omitted, the board is the 64rem column it has always been — byte for byte the same as "narrow"', async () => {
    const omitted = await renderMock(base);
    expect(boardClass(omitted)).toBe(NARROW);
    expect(await renderMock({ ...base, boardWidth: 'narrow' })).toBe(omitted);
    expect(omitted).not.toContain('<!-- renderMock: boardWidth');
  });

  it('"full" draws the board at the viewport width, with no 64rem cap anywhere', async () => {
    const html = await renderMock({ ...base, boardWidth: 'full' });
    expect(boardClass(html)).toBe('mx-auto flex w-full flex-col gap-8 p-8');
    expect(html).not.toContain('max-w-[64rem]');
    expect(styleText(html)).not.toContain('64rem');
    expect(styleText(html)).toMatch(/\.w-full\s*\{\s*width:\s*100%/);
  });

  it('a max-width class is put on the board and COMPILED, so the page ships at that width', async () => {
    const html = await renderMock({ ...base, boardWidth: 'max-w-[1400px]' });
    expect(boardClass(html)).toBe('mx-auto flex max-w-[1400px] flex-col gap-8 p-8');
    expect(html).not.toContain('max-w-[64rem]');
    expect(styleText(html)).toMatch(/\.max-w-\\\[1400px\\\]\s*\{\s*max-width:\s*1400px/);
  });

  it.each([
    ['an empty string', ''],
    ['two classes', 'max-w-[1400px] px-0'],
    ['a non-string', 1400 as never],
  ])('%s falls back to "narrow" and says so, never throws', async (_name, boardWidth) => {
    const html = await renderMock({ ...base, boardWidth });
    expect(boardClass(html)).toBe(NARROW);
    expect(html).toMatch(
      /^<!doctype html>\n<!-- renderMock: boardWidth .* fell back to "narrow" -->\n/,
    );
  });
});
