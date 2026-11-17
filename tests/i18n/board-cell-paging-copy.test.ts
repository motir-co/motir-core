import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { locales } from '@/lib/i18n/locales';

// The grouped board's per-cell paging copy (Story MOTIR-11328 · MOTIR-11447).
// The catalogue gates already hold key parity and ICU shape; this suite pins
// what they cannot see: the cell retry's accessible name STARTS with the visible
// retry line, contiguously, in every locale (WCAG 2.5.3 — speech input matches
// the words on the button), and every new name carries the cell or lane it is
// read out for and no count.

type Boards = Record<string, string>;

function boards(locale: string): Boards {
  const raw = JSON.parse(readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8'));
  return raw.boards as Boards;
}

const CELL_KEYS = ['cellLoadMoreAria', 'cellLoadRetryAria', 'cellLoadingAria'] as const;
const LANE_KEYS = ['laneScrollLeftAria', 'laneScrollRightAria'] as const;

describe.each(locales)('board cell paging copy — %s', (locale) => {
  const b = boards(locale);

  it('the cell retry’s accessible name begins with the visible retry line', () => {
    expect(b['cellLoadRetryAria']!.startsWith(b['laneLoadRetry']!)).toBe(true);
  });

  it('names the column and the lane on every cell name, and the lane on every arrow', () => {
    for (const key of CELL_KEYS) {
      expect(b[key], key).toContain('{column}');
      expect(b[key], key).toContain('{lane}');
    }
    for (const key of LANE_KEYS) {
      expect(b[key], key).toContain('{lane}');
      expect(b[key], key).not.toContain('{column}');
    }
    // No argument on the visible label or the empty-lane line, and no count anywhere.
    expect(b['cellLoadMore']).not.toMatch(/[{}]/);
    expect(b['laneEmpty']).not.toMatch(/[{}]/);
    for (const key of [...CELL_KEYS, ...LANE_KEYS]) expect(b[key]).not.toMatch(/count|plural/);
  });

  it('formats with the board’s own names', () => {
    const t = createTranslator({ locale, messages: { boards: b }, namespace: 'boards' });
    const name = t('cellLoadRetryAria', { column: 'QA-COL', lane: 'QA-LANE' });
    expect(name).toContain('QA-COL');
    expect(name).toContain('QA-LANE');
    expect(t('laneScrollLeftAria', { lane: 'QA-LANE' })).toContain('QA-LANE');
    expect(t('laneScrollRightAria', { lane: 'QA-LANE' })).not.toBe(
      t('laneScrollLeftAria', { lane: 'QA-LANE' }),
    );
  });
});
