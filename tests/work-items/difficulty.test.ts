import { describe, expect, it } from 'vitest';
import {
  buildEntryParts,
  dispositionFor,
  isRegisteredDiffKey,
  type DisplayResolvers,
} from '@/lib/activity/renderers';
import { WORK_ITEM_DIFFICULTIES, isWorkItemDifficulty } from '@/lib/issues/difficulty';
import { DifficultyNotAllowedOnKindError, WorkItemError } from '@/lib/workItems/errors';

// Story MOTIR-6016 · MOTIR-6096 — the DIFFICULTY vocabulary, its typed
// refusal, and how the activity feed renders a change to it. The totality of
// `WORK_ITEM_DIFFICULTIES` against the Prisma enum is a COMPILE-time check in
// `lib/issues/difficulty.ts`; this file pins the runtime behaviour around it.

describe('WORK_ITEM_DIFFICULTIES', () => {
  it('lists the scale easiest first', () => {
    expect(WORK_ITEM_DIFFICULTIES).toEqual(['trivial', 'low', 'medium', 'high']);
  });

  it('narrows only a member string', () => {
    for (const d of WORK_ITEM_DIFFICULTIES) expect(isWorkItemDifficulty(d)).toBe(true);
    for (const v of ['LOW', 'extreme', '', null, undefined, 2, {}]) {
      expect(isWorkItemDifficulty(v)).toBe(false);
    }
  });
});

describe('DifficultyNotAllowedOnKindError', () => {
  it('is a WorkItemError with its own code, naming the kind', () => {
    const err = new DifficultyNotAllowedOnKindError('story');
    expect(err).toBeInstanceOf(WorkItemError);
    expect(err.code).toBe('DIFFICULTY_NOT_ALLOWED_ON_KIND');
    expect(err.tag).toBe('DIFFICULTY_NOT_ALLOWED_ON_KIND');
    expect(err.message).toContain('story');
  });
});

// No resolver is reached by a text field; these exist only to satisfy the type.
const resolvers: DisplayResolvers = {
  user: (id) => ({ type: 'user', userId: id, name: id, image: null }),
  status: (key) => ({ type: 'status', key, label: key }),
  sprint: (id) => ({ type: 'sprint', sprintId: id, name: id }),
  issue: (id) => ({ type: 'issue', workItemId: id, identifier: id }),
  folder: (id) => ({ type: 'text', text: id }),
  reviewChecklist: () => [],
};

describe('activity feed — a difficulty change', () => {
  it('is a registered, renderable field', () => {
    expect(isRegisteredDiffKey('difficulty')).toBe(true);
    expect(dispositionFor('difficulty').disposition).toBe('renderable');
  });

  it('renders medium → high as a field change', () => {
    const parts = buildEntryParts(
      'updated',
      { difficulty: { from: 'medium', to: 'high' } },
      resolvers,
    );
    expect(parts).toEqual([
      {
        kind: 'field',
        field: 'difficulty',
        from: { type: 'text', text: 'medium' },
        to: { type: 'text', text: 'high' },
      },
    ]);
  });
});
