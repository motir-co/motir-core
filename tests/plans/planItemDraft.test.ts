import { describe, expect, it } from 'vitest';
import {
  PLAN_ITEM_DRAFT_BODY_MAX,
  PLAN_ITEM_DRAFT_TITLE_MAX,
  PlanItemDraftRefusal,
  parsePlanItemDraft,
} from '@/lib/plans/planItemDraft';

// The in-flight card's parser (MOTIR-11199): a malformed body is a `shape`
// refusal (the door's 400), a field over its cap a `cap` refusal (the store's
// 422), and a good one comes back with only the fields it carried.

function refusal(raw: unknown): PlanItemDraftRefusal {
  try {
    parsePlanItemDraft(raw);
  } catch (err) {
    if (err instanceof PlanItemDraftRefusal) return err;
    throw err;
  }
  throw new Error('parsed');
}

describe('parsePlanItemDraft', () => {
  it('keeps exactly the fields a report carries', () => {
    expect(parsePlanItemDraft({ target: 'planItem:a', seq: 2, descriptionMd: 'Bo' })).toEqual({
      target: 'planItem:a',
      seq: 2,
      descriptionMd: 'Bo',
    });
    expect(
      parsePlanItemDraft({
        target: 'planItem:a',
        seq: 1,
        title: '',
        descriptionMd: 'd',
        explanationMd: 'e',
        extra: 'ignored',
      }),
    ).toEqual({ target: 'planItem:a', seq: 1, title: '', descriptionMd: 'd', explanationMd: 'e' });
  });

  it.each([
    [null, '`itemDraft` must be an object.'],
    [[], '`itemDraft` must be an object.'],
    ['x', '`itemDraft` must be an object.'],
    [{ seq: 1, title: 'x' }, '`itemDraft.target`'],
    [{ target: ' ', seq: 1, title: 'x' }, '`itemDraft.target`'],
    [{ target: 't', seq: 0, title: 'x' }, '`itemDraft.seq`'],
    [{ target: 't', seq: 2.5, title: 'x' }, '`itemDraft.seq`'],
    [{ target: 't', title: 'x' }, '`itemDraft.seq`'],
    [{ target: 't', seq: 1, title: 3 }, '`itemDraft.title` must be a string.'],
    [{ target: 't', seq: 1, explanationMd: null }, '`itemDraft.explanationMd` must be a string.'],
    [{ target: 't', seq: 1 }, 'at least one of'],
  ])('refuses %j as malformed', (raw, message) => {
    const err = refusal(raw);
    expect(err.reason).toBe('shape');
    expect(err.message).toContain(message);
  });

  it('refuses a field over its cap, and keeps one at it', () => {
    const title = refusal({
      target: 't',
      seq: 1,
      title: 'x'.repeat(PLAN_ITEM_DRAFT_TITLE_MAX + 1),
    });
    expect(title.reason).toBe('cap');
    expect(title.message).toContain('`itemDraft.title`');
    const body = refusal({
      target: 't',
      seq: 1,
      descriptionMd: 'x'.repeat(PLAN_ITEM_DRAFT_BODY_MAX + 1),
    });
    expect(body.reason).toBe('cap');
    expect(
      parsePlanItemDraft({ target: 't', seq: 1, title: 'x'.repeat(PLAN_ITEM_DRAFT_TITLE_MAX) })
        .title,
    ).toHaveLength(PLAN_ITEM_DRAFT_TITLE_MAX);
  });
});
