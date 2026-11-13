import { describe, expect, it } from 'vitest';
import { lastEditedAtByItem, PLAN_ITEM_EDITED_KIND } from '@/lib/plans/planItemEdits';

// The per-proposal edit time the live plan read carries (MOTIR-11185): the newest
// `edited` trail row per item, and nothing else.

const at = (iso: string) => new Date(iso);

describe('lastEditedAtByItem', () => {
  it('keeps the NEWEST edited time per item, whatever order the trail is in', () => {
    const out = lastEditedAtByItem([
      { changeKind: 'edited', planItemId: 'a', changedAt: at('2026-11-13T11:10:00Z') },
      { changeKind: 'edited', planItemId: 'a', changedAt: at('2026-11-13T11:12:00Z') },
      { changeKind: 'edited', planItemId: 'a', changedAt: at('2026-11-13T11:08:00Z') },
      { changeKind: 'edited', planItemId: 'b', changedAt: at('2026-11-13T11:09:00Z') },
    ]);
    expect(Object.fromEntries(out)).toEqual({
      a: '2026-11-13T11:12:00.000Z',
      b: '2026-11-13T11:09:00.000Z',
    });
  });

  it('counts only edited rows that name a proposal', () => {
    const out = lastEditedAtByItem([
      { changeKind: 'appended', planItemId: null, changedAt: at('2026-11-13T11:00:00Z') },
      { changeKind: 'withdrawn', planItemId: 'w', changedAt: at('2026-11-13T11:01:00Z') },
      { changeKind: 'created', planItemId: null, changedAt: at('2026-11-13T11:02:00Z') },
      {
        changeKind: PLAN_ITEM_EDITED_KIND,
        planItemId: null,
        changedAt: at('2026-11-13T11:03:00Z'),
      },
    ]);
    expect(out.size).toBe(0);
  });
});
