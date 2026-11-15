// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  useAdvancedConditionText,
  type AdvancedConditionTextLookups,
} from '@/app/(authed)/items/_components/useAdvancedConditionText';
import type { FilterCondition } from '@/lib/filters/ast';

// The shared condition → text resolution (MOTIR-11335) that the toolbar's
// applied chips (`AdvancedFilterSummary`) and the board's stored-filter
// indicator both read. Pinned value by value: every vocabulary it names a value
// through, the stale-value text for a referent that is gone, and the raw value
// for what has no vocabulary.

afterEach(() => cleanup());

const LOOKUPS: AdvancedConditionTextLookups = {
  statuses: [
    { id: 's1', key: 'todo', label: 'To Do' } as never,
    { id: 's2', key: 'qa', label: 'Quality check' } as never,
  ],
  members: [{ userId: 'u-ana', name: 'Ana Ruiz' } as never],
  sprints: [{ id: 'sp1', name: 'Sprint 24' } as never],
  customFields: [
    {
      id: 'f-size',
      key: 'size',
      label: 'Size',
      fieldType: 'select',
      description: null,
      position: 'a0',
      options: [
        { id: 'o-s', label: 'S', position: 'a0', archived: false },
        { id: 'o-xl', label: 'XL', position: 'a1', archived: true },
      ] as never,
      valueCount: 0,
    },
    {
      id: 'f-owner',
      key: 'owner',
      label: 'Owner',
      fieldType: 'user',
      description: null,
      position: 'a1',
      options: [],
      valueCount: 0,
    },
    {
      id: 'f-ship',
      key: 'ship',
      label: 'Ship date',
      fieldType: 'date',
      description: null,
      position: 'a2',
      options: [],
      valueCount: 0,
    },
    {
      id: 'f-note',
      key: 'note',
      label: 'Note',
      fieldType: 'text',
      description: null,
      position: 'a3',
      options: [],
      valueCount: 0,
    },
  ],
  components: [{ id: 'cmp-api', name: 'API', description: null, defaultAssigneeId: null }],
  folders: {
    folders: [{ id: 'fld-a', parentFolderId: null, name: 'B', position: 'a0', path: ['A', 'B'] }],
    truncated: false,
  },
  referencedLabels: [{ id: 'lab-mobile', name: 'mobile' }],
};

function Lines({
  conditions,
  lookups = LOOKUPS,
}: {
  conditions: FilterCondition[];
  lookups?: AdvancedConditionTextLookups;
}) {
  const text = useAdvancedConditionText(lookups);
  return (
    <ul>
      {conditions.map((c, i) => (
        <li key={i}>{text.sentence(c)}</li>
      ))}
    </ul>
  );
}

function lines(conditions: FilterCondition[], lookups?: AdvancedConditionTextLookups) {
  renderWithIntl(<Lines conditions={conditions} lookups={lookups} />);
  return screen.getAllByRole('listitem').map((li) => li.textContent);
}

const c = (field: string, operator: string, value: FilterCondition['value']) =>
  ({ field, operator, value }) as FilterCondition;

describe('useAdvancedConditionText', () => {
  it('names built-in vocabularies, and shows an unknown value raw', () => {
    expect(
      lines([
        c('kind', 'is_any_of', ['bug']),
        c('status', 'is_any_of', ['todo', 'qa', 'gone']),
        c('priority', 'is_any_of', ['high']),
        c('type', 'is_any_of', ['code']),
        c('difficulty', 'is_any_of', ['low', 'weird']),
        c('fixReason', 'is_any_of', ['run_died', 'weird']),
        c('obsolescence', 'is_any_of', ['outdated', 'weird']),
        c('assignee', 'is_any_of', ['unassigned', 'u-ana', 'u-gone']),
        c('reporter', 'is_none_of', ['u-ana']),
        c('sprint', 'is_any_of', ['backlog', 'sp1', 'sp-gone']),
      ]),
    ).toEqual([
      'Kind is any of Bug',
      'Status is any of To Do, Quality check, gone',
      'Priority is any of High',
      'Type is any of Code',
      'Difficulty is any of Low, weird',
      expect.stringMatching(/^To fix is any of .+, weird$/),
      'Obsolescence is any of Outdated, weird',
      'Assignee is any of Unassigned, Ana Ruiz, u-gone',
      'Reporter is none of Ana Ruiz',
      'Sprint is any of Backlog, Sprint 24, sp-gone',
    ]);
  });

  it('names referents, and marks one that is gone with the stale-value text', () => {
    expect(
      lines([
        c('lbl', 'is_any_of', ['lab-mobile', 'lab-gone']),
        c('cmp', 'is_any_of', ['cmp-api', 'cmp-gone']),
        c('folder', 'is_any_of', ['fld-a', 'fld-gone']),
      ]),
    ).toEqual([
      'Label is any of mobile, Unknown value',
      'Component is any of API, Unknown value',
      'Folder is any of A ▸ B, Unknown value',
    ]);
  });

  it('cannot call a folder gone from a truncated list, or with no folders at all', () => {
    const folder = [c('folder', 'is_any_of', ['fld-gone'])];
    expect(lines(folder, { ...LOOKUPS, folders: { folders: [], truncated: true } })).toEqual([
      'Folder is any of fld-gone',
    ]);
    cleanup();
    expect(lines(folder, { ...LOOKUPS, folders: undefined })).toEqual([
      'Folder is any of fld-gone',
    ]);
  });

  it('names custom-field values through their definitions', () => {
    expect(
      lines([
        c('cf:f-size', 'is_any_of', ['o-s', 'o-xl', 'o-gone']),
        c('cf:f-owner', 'is_any_of', ['u-ana', 'u-gone']),
        c('cf:f-note', 'contains', 'beta'),
        c('cf:f-ship', 'on_or_after', '2026-11-15'),
        c('cf:f-gone', 'is_any_of', ['x']),
      ]),
    ).toEqual([
      'Size is any of S, XL (archived), Unknown value',
      'Owner is any of Ana Ruiz, u-gone',
      'Note contains beta',
      'Ship date on or after Nov 15, 2026',
      'Unknown field is any of Unknown value',
    ]);
  });

  it('formats dates, ranges, day counts, numbers, free text and value-less operators', () => {
    expect(
      lines([
        c('created', 'between', ['2026-11-01', '2026-11-15']),
        c('due', 'on_or_before', '2026-12-01'),
        c('updated', 'in_last_days', 7),
        c('storyPoints', 'gte', 3),
        c('text', 'contains', 'export'),
        c('assignee', 'is_empty', null),
      ]),
    ).toEqual([
      'Created is between Nov 1, 2026 and Nov 15, 2026',
      'Due on or before Dec 1, 2026',
      'Updated in the last 7 days',
      'Story points ≥ 3',
      'Text contains export',
      'Assignee is empty',
    ]);
  });
});
