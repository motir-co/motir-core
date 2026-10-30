import { describe, expect, it } from 'vitest';
import type { PlanItemPatch } from '@/lib/dto/plans';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import { planStatusChangeOf, type PlanStatusContext } from '@/lib/plans/planStatusRow';
import { rescopingFields } from '@/lib/plans/rescopeReset';
import { rescopeWarningOf } from '@/lib/plans/rescopeWarning';

// The write door's RE-SCOPE WARNING (bug MOTIR-10106), pinned without a database:
// which patches earn it, what it names, and — the property the card exists for —
// that it fires exactly when the review's status row says `re-scoped while …`.

type Status = Pick<WorkflowStatusDto, 'key' | 'label' | 'category'>;

const STATUSES: Status[] = [
  { key: 'todo', label: 'To Do', category: 'todo' },
  { key: 'blocked', label: 'Blocked', category: 'todo' },
  { key: 'in_progress', label: 'In Progress', category: 'in_progress' },
  { key: 'implemented', label: 'Implemented', category: 'in_progress' },
  { key: 'planning', label: 'Planning', category: 'in_progress' },
  { key: 'in_review', label: 'In Review', category: 'in_progress' },
  { key: 'done', label: 'Done', category: 'done' },
];
const byKey = new Map(STATUSES.map((s) => [s.key, s]));

const target = (status: string) => ({
  id: 'wi_5779',
  identifier: 'MOTIR-5779',
  status,
  title: 'Serving previews',
  descriptionMd: 'The old body.',
  targetRepo: 'motir-core',
  targetRepos: ['motir-core'],
});

const item = { planItemId: 'pi_1', proposal: 'the `modify` of work item wi_5779' };
const none: PlanStatusContext = { gainsChildren: false };

describe('rescopeWarningOf', () => {
  it('warns on a description change to an implemented card, naming key, status, outcomes and field', () => {
    const w = rescopeWarningOf(
      item,
      { descriptionMd: 'Match what shipped.' },
      target('implemented'),
      byKey,
      none,
    );
    expect(w).toEqual({
      planItemId: 'pi_1',
      proposal: item.proposal,
      workItemId: 'wi_5779',
      identifier: 'MOTIR-5779',
      status: 'implemented',
      statusLabel: 'Implemented',
      outcomes: 'To Do, Blocked, or In Progress',
      fields: ['descriptionMd'],
      message: expect.stringContaining(
        'approve will re-open MOTIR-5779 (Implemented → To Do, Blocked, or In Progress) because this patch changes its description.',
      ),
    });
    expect(w!.message).toContain('a correction of record belongs in a new card');
  });

  it('names every field that trips it — the title, the description and the repository', () => {
    const patch: PlanItemPatch = {
      title: 'A new title',
      descriptionMd: 'A new body.',
      targetRepos: ['motir-ai'],
    };
    const w = rescopeWarningOf(item, patch, target('in_review'), byKey, none);
    expect(w?.fields).toEqual(['title', 'descriptionMd', 'repository']);
    expect(w?.message).toContain('(In Review → To Do, Blocked, or In Progress)');
    expect(w?.message).toContain('changes its title, description, and repository');
  });

  it('reads the status a park took the card from, not `planning`', () => {
    const w = rescopeWarningOf(item, { title: 'Renamed' }, target('planning'), byKey, {
      gainsChildren: false,
      park: { priorStatus: 'implemented', statusHeld: true, planId: 'plan_1' },
    });
    expect(w).toMatchObject({
      status: 'implemented',
      statusLabel: 'Implemented',
      fields: ['title'],
    });
  });

  it.each<[string, PlanItemPatch]>([
    ['type', { type: 'test' }],
    ['sizing', { storyPoints: 3, estimateMinutes: 40 }],
    ['priority', { priority: 'high' }],
    ['explanationMd', { explanationMd: 'Why it matters, again.' }],
    ['edges', { blockedByAdd: ['wi_1'], blockedByRemove: ['wi_2'] }],
    ['an unchanged body', { descriptionMd: 'The old body.', title: 'Serving previews' }],
  ])('never warns on a patch carrying only %s', (_label, patch) => {
    expect(rescopeWarningOf(item, patch, target('implemented'), byKey, none)).toBeNull();
  });

  it.each(['todo', 'blocked', 'in_progress', 'done'])(
    'never warns on a card at %s, which claims no built work',
    (status) => {
      expect(
        rescopeWarningOf(item, { descriptionMd: 'A new body.' }, target(status), byKey, none),
      ).toBeNull();
    },
  );

  it('never warns on a mark-only patch', () => {
    expect(
      rescopeWarningOf(item, { obsolescence: 'outdated' }, target('done'), byKey, none),
    ).toBeNull();
  });
});

describe('the warning and the review status row agree (one decision, MOTIR-10106 AC3)', () => {
  const patches: PlanItemPatch[] = [
    { descriptionMd: 'A new body.' },
    { title: 'Renamed' },
    { targetRepo: 'motir-ai' },
    { targetRepoRole: 'other' },
    { storyPoints: 5 },
    { priority: 'low', explanationMd: 'x' },
    { obsolescence: 'outdated' },
    { descriptionMd: 'The old body.' },
  ];
  const contexts: PlanStatusContext[] = [
    { gainsChildren: false },
    { gainsChildren: true },
    { gainsChildren: false, park: { priorStatus: 'implemented', statusHeld: true, planId: 'p' } },
    { gainsChildren: false, park: { priorStatus: 'todo', statusHeld: true, planId: 'p' } },
    { gainsChildren: false, park: { priorStatus: 'in_review', statusHeld: true, planId: null } },
  ];
  const statuses = ['todo', 'in_progress', 'implemented', 'in_review', 'planning', 'done'];

  it('warns exactly where the row reads `re-scoped while <prior>`, and names its outcomes', () => {
    let warned = 0;
    for (const patch of patches)
      for (const status of statuses)
        for (const context of contexts) {
          const row = planStatusChangeOf(patch, target(status), byKey, context);
          const warning = rescopeWarningOf(item, patch, target(status), byKey, context);
          const rowSaysRescope = row?.to.includes('re-scoped while') ?? false;
          expect({ patch, status, context, warned: warning !== null }).toEqual({
            patch,
            status,
            context,
            warned: rowSaysRescope,
          });
          if (warning) {
            warned += 1;
            expect(row!.to).toBe(
              `${warning.outcomes} (re-scoped while ${warning.statusLabel}; decided when this plan is approved)`,
            );
            expect(warning.fields).toEqual(rescopingFields(patch, target(status)));
          }
        }
    // The fixture exercises the warning arm, not only the silent one.
    expect(warned).toBeGreaterThan(10);
  });
});
