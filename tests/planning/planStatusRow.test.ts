import { describe, expect, it } from 'vitest';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import { planStatusChangeOf } from '@/lib/plans/planStatusRow';

// The plan review's STATUS row (bug MOTIR-10102), pinned without a database: every
// arm the approve can take, and what the reviewer is told about it beforehand.

type Status = Pick<WorkflowStatusDto, 'key' | 'label' | 'category'>;

const DEFAULT_STATUSES: Status[] = [
  { key: 'todo', label: 'To Do', category: 'todo' },
  { key: 'blocked', label: 'Blocked', category: 'todo' },
  { key: 'in_progress', label: 'In Progress', category: 'in_progress' },
  { key: 'implemented', label: 'Implemented', category: 'in_progress' },
  { key: 'planning', label: 'Planning', category: 'in_progress' },
  { key: 'in_review', label: 'In Review', category: 'in_progress' },
  { key: 'done', label: 'Done', category: 'done' },
];

const byKey = (statuses: Status[]) => new Map(statuses.map((s) => [s.key, s]));

const target = (status: string) => ({
  status,
  title: 'The card',
  descriptionMd: 'The old body.',
  targetRepo: null,
  targetRepos: [],
});

const RESCOPE = { descriptionMd: 'A new body.' };
const RESIZE = { storyPoints: 3 };
const none = { gainsChildren: false };

describe('planStatusChangeOf', () => {
  it('names the three outcomes for a re-scoped card that claims built work, parked or not', () => {
    expect(
      planStatusChangeOf(RESCOPE, target('implemented'), byKey(DEFAULT_STATUSES), none),
    ).toEqual({
      field: 'status',
      from: 'Implemented',
      to: 'To Do, Blocked, or In Progress (re-scoped while Implemented; decided when this plan is approved)',
    });
    expect(
      planStatusChangeOf(RESCOPE, target('planning'), byKey(DEFAULT_STATUSES), {
        gainsChildren: false,
        park: { priorStatus: 'in_review', statusHeld: true, planId: 'plan_1' },
      }),
    ).toMatchObject({ from: 'Planning', to: expect.stringContaining('re-scoped while In Review') });
  });

  it('names only the outcomes the workflow has — and a custom built status counts', () => {
    const custom = DEFAULT_STATUSES.filter((s) => s.key !== 'in_progress' && s.key !== 'blocked');
    custom.push({ key: 'qa', label: 'QA', category: 'in_progress' });
    expect(planStatusChangeOf(RESCOPE, target('qa'), byKey(custom), none)).toEqual({
      field: 'status',
      from: 'QA',
      to: 'To Do (re-scoped while QA; decided when this plan is approved)',
    });
  });

  it('draws nothing for a re-scope when the workflow offers none of the outcomes', () => {
    const bare = DEFAULT_STATUSES.filter(
      (s) => !['todo', 'blocked', 'in_progress'].includes(s.key),
    );
    expect(planStatusChangeOf(RESCOPE, target('implemented'), byKey(bare), none)).toBeNull();
  });

  it('draws nothing for an unparked card whose status does not move', () => {
    const statuses = byKey(DEFAULT_STATUSES);
    expect(planStatusChangeOf(RESIZE, target('implemented'), statuses, none)).toBeNull();
    expect(planStatusChangeOf(RESCOPE, target('in_progress'), statuses, none)).toBeNull();
    expect(planStatusChangeOf(RESCOPE, target('todo'), statuses, none)).toBeNull();
    // A mark-only patch on a finished card.
    expect(
      planStatusChangeOf({ obsolescence: 'outdated' }, target('done'), statuses, none),
    ).toBeNull();
  });

  it('draws nothing for a status the workflow does not know', () => {
    expect(planStatusChangeOf(RESCOPE, target('ghost'), byKey(DEFAULT_STATUSES), none)).toBeNull();
  });

  it('gives a parked BUILT card its own status back when the patch does not re-scope it', () => {
    expect(
      planStatusChangeOf(RESIZE, target('planning'), byKey(DEFAULT_STATUSES), {
        gainsChildren: false,
        park: { priorStatus: 'implemented', statusHeld: true, planId: 'plan_1' },
      }),
    ).toEqual({
      field: 'status',
      from: 'Planning',
      to: 'Implemented (returned when this plan is approved)',
    });
  });

  it('gives a card a SESSION parked its own status back, whatever the patch', () => {
    expect(
      planStatusChangeOf(RESCOPE, target('planning'), byKey(DEFAULT_STATUSES), {
        gainsChildren: false,
        park: { priorStatus: 'in_progress', statusHeld: true, planId: null },
      }),
    ).toMatchObject({ to: 'In Progress (returned when this plan is approved)' });
  });

  it('names To Do or Blocked for a card this plan parked, a hand park, and a container gaining children', () => {
    const statuses = byKey(DEFAULT_STATUSES);
    const resting = {
      field: 'status',
      from: 'Planning',
      to: 'To Do or Blocked (returned when this plan is approved)',
    };
    expect(
      planStatusChangeOf(RESIZE, target('planning'), statuses, {
        gainsChildren: false,
        park: { priorStatus: 'todo', statusHeld: true, planId: 'plan_1' },
      }),
    ).toEqual(resting);
    expect(planStatusChangeOf(RESCOPE, target('planning'), statuses, none)).toEqual(resting);
    expect(
      planStatusChangeOf(RESIZE, target('planning'), statuses, {
        gainsChildren: true,
        park: { priorStatus: 'implemented', statusHeld: true, planId: 'plan_1' },
      }),
    ).toEqual(resting);
  });

  it('draws nothing for a parked card when the workflow has no resting status', () => {
    const bare = DEFAULT_STATUSES.filter((s) => s.key !== 'todo' && s.key !== 'blocked');
    expect(planStatusChangeOf(RESIZE, target('planning'), byKey(bare), none)).toBeNull();
  });
});
