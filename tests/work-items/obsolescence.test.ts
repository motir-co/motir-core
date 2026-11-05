import { describe, expect, it } from 'vitest';
import {
  buildEntryParts,
  dispositionFor,
  isRegisteredDiffKey,
  type DisplayResolvers,
} from '@/lib/activity/renderers';
import {
  WORK_ITEM_OBSOLESCENCES,
  canCarryObsolescence,
  isReopenHeldByMark,
  isWorkItemObsolescence,
} from '@/lib/issues/obsolescence';
import { InvalidObsolescenceError, WorkItemError } from '@/lib/workItems/errors';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';

// Story MOTIR-6574 · MOTIR-6579 — the OBSOLESCENCE vocabulary, its typed
// refusal, and how the activity feed renders a change to the mark and its note.
// The totality of `WORK_ITEM_OBSOLESCENCES` against the Prisma enum is a
// COMPILE-time check in `lib/issues/obsolescence.ts`; this file pins the runtime
// behaviour around it.

describe('canCarryObsolescence — the ONE finished-card predicate (MOTIR-6575 · MOTIR-6663)', () => {
  it('is true only for the `done` category', () => {
    expect(canCarryObsolescence('done')).toBe(true);
    expect(canCarryObsolescence('todo')).toBe(false);
    expect(canCarryObsolescence('in_progress')).toBe(false);
  });

  it('reads an unknown category (a status the workflow does not define) as not finished', () => {
    expect(canCarryObsolescence(null)).toBe(false);
    expect(canCarryObsolescence(undefined)).toBe(false);
  });
});

describe('WORK_ITEM_OBSOLESCENCES', () => {
  it('lists the scale mildest first', () => {
    expect(WORK_ITEM_OBSOLESCENCES).toEqual(['outdated', 'deprecated']);
  });

  it('narrows only a member string', () => {
    for (const o of WORK_ITEM_OBSOLESCENCES) expect(isWorkItemObsolescence(o)).toBe(true);
    for (const v of ['OUTDATED', 'obsolete', 'superseded', '', null, undefined, 1, {}]) {
      expect(isWorkItemObsolescence(v)).toBe(false);
    }
  });

  it('has a value label for every member, in en and zh', () => {
    for (const o of WORK_ITEM_OBSOLESCENCES) {
      expect(enMessages.labels.obsolescence[o]).toBeTruthy();
      expect(zhMessages.labels.obsolescence[o]).toBeTruthy();
    }
  });
});

describe('InvalidObsolescenceError', () => {
  it('is a WorkItemError with its own code, naming the refused value', () => {
    const err = new InvalidObsolescenceError('obsolete');
    expect(err).toBeInstanceOf(WorkItemError);
    expect(err.code).toBe('INVALID_OBSOLESCENCE');
    expect(err.tag).toBe('INVALID_OBSOLESCENCE');
    expect(err.message).toContain('"obsolete"');
  });

  it('describes a non-string value without throwing', () => {
    expect(new InvalidObsolescenceError(undefined).message).toContain('undefined');
    expect(new InvalidObsolescenceError(3).message).toContain('3');
  });
});

// No resolver is reached by a text / edited field; these exist only to satisfy the type.
const resolvers: DisplayResolvers = {
  user: (id) => ({ type: 'user', userId: id, name: id, image: null }),
  status: (key) => ({ type: 'status', key, label: key }),
  sprint: (id) => ({ type: 'sprint', sprintId: id, name: id }),
  issue: (id) => ({ type: 'issue', workItemId: id, identifier: id }),
  folder: (id) => ({ type: 'text', text: id }),
  reviewChecklist: () => [],
};

describe('activity feed — an obsolescence change', () => {
  it('registers both keys as renderable', () => {
    for (const key of ['obsolescence', 'obsolescenceNoteMd']) {
      expect(isRegisteredDiffKey(key)).toBe(true);
      expect(dispositionFor(key).disposition).toBe('renderable');
    }
  });

  it('renders null → outdated as a field change', () => {
    const parts = buildEntryParts(
      'updated',
      { obsolescence: { from: null, to: 'outdated' } },
      resolvers,
    );
    expect(parts).toEqual([
      {
        kind: 'field',
        field: 'obsolescence',
        from: { type: 'none' },
        to: { type: 'text', text: 'outdated' },
      },
    ]);
  });

  it('renders a note change as an edit, never inlining the Markdown', () => {
    const parts = buildEntryParts(
      'updated',
      { obsolescenceNoteMd: { from: null, to: 'Superseded by **MOTIR-2**' } },
      resolvers,
    );
    expect(parts).toEqual([{ kind: 'fieldEdited', field: 'obsolescenceNoteMd' }]);
  });
});

describe('isReopenHeldByMark — a marked card stays finished (MOTIR-6575 · MOTIR-6672)', () => {
  it('holds every move of a marked card out of the done category', () => {
    for (const mark of WORK_ITEM_OBSOLESCENCES) {
      expect(isReopenHeldByMark(mark, 'todo')).toBe(true);
      expect(isReopenHeldByMark(mark, 'in_progress')).toBe(true);
      // An unknown target category is not provably finished, so it is held.
      expect(isReopenHeldByMark(mark, null)).toBe(true);
    }
  });

  it('leaves a move within the done category, and any move of an unmarked card, alone', () => {
    expect(isReopenHeldByMark('outdated', 'done')).toBe(false);
    expect(isReopenHeldByMark('deprecated', 'done')).toBe(false);
    expect(isReopenHeldByMark(null, 'todo')).toBe(false);
    expect(isReopenHeldByMark(undefined, 'in_progress')).toBe(false);
  });
});
