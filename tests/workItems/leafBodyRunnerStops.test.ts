import { describe, expect, it } from 'vitest';
import {
  isLeafBodyCheckExempt,
  leafNoCriteria,
  leafNoDescription,
  underAuthored,
} from '@/lib/workItems/proseVsGraph';
import { RUNNER_STOP_SEVERITIES } from '@/lib/dto/workItems';

// The RUNNER-STOP body predicates (MOTIR-10380): a childless, non-exempt leaf with
// a blank body, or with a body and no enumerated acceptance criterion — read off
// the body alone, so a typed and sized card is still reported.

const leaf = (over: Partial<Parameters<typeof leafNoDescription>[0]> = {}) => ({
  kind: 'subtask',
  descriptionMd: null as string | null,
  hasChildren: false,
  type: 'code',
  executor: 'coding_agent',
  ...over,
});

const WITH_CRITERION = 'Builds the export.\n\n## Acceptance criteria\n\n- The export downloads.';

describe('leafNoDescription', () => {
  it('fires on a null, an empty and a whitespace-only body, typed and executor-set', () => {
    expect(leafNoDescription(leaf())).toBe(true);
    expect(leafNoDescription(leaf({ descriptionMd: '' }))).toBe(true);
    expect(leafNoDescription(leaf({ descriptionMd: '  \n\t ' }))).toBe(true);
  });

  it('fires on every leaf kind, and on an absent kind (read as a task)', () => {
    for (const kind of ['task', 'bug', 'subtask', undefined]) {
      expect(leafNoDescription(leaf({ kind }))).toBe(true);
    }
  });

  it('is silent on a body', () => {
    expect(leafNoDescription(leaf({ descriptionMd: 'Anything.' }))).toBe(false);
  });

  it('is silent on every exempt card', () => {
    expect(leafNoDescription(leaf({ hasChildren: true }))).toBe(false);
    expect(leafNoDescription(leaf({ kind: 'story' }))).toBe(false);
    expect(leafNoDescription(leaf({ kind: 'epic' }))).toBe(false);
    expect(leafNoDescription(leaf({ type: 'design' }))).toBe(false);
    expect(leafNoDescription(leaf({ executor: 'human' }))).toBe(false);
  });
});

describe('leafNoCriteria', () => {
  it('says `no-heading` for a body with no `## Acceptance criteria` section', () => {
    expect(leafNoCriteria(leaf({ descriptionMd: 'Builds the export.' }))).toBe('no-heading');
  });

  it('says `no-criterion` for the heading with nothing under it', () => {
    expect(
      leafNoCriteria(leaf({ descriptionMd: 'Builds the export.\n\n## Acceptance criteria\n\n' })),
    ).toBe('no-criterion');
  });

  it('is silent when a criterion is enumerated', () => {
    expect(leafNoCriteria(leaf({ descriptionMd: WITH_CRITERION }))).toBeNull();
  });

  it('is silent on a blank body — that is the no-description finding, reported once', () => {
    expect(leafNoCriteria(leaf())).toBeNull();
    expect(leafNoCriteria(leaf({ descriptionMd: ' \n' }))).toBeNull();
  });

  it('fires on a typed, sized card the under-authored check stays silent on', () => {
    const card = {
      ...leaf({ descriptionMd: 'Builds the export.' }),
      storyPoints: 3,
      estimateMinutes: 45,
    };
    expect(underAuthored(card)).toBeNull();
    expect(leafNoCriteria(card)).toBe('no-heading');
  });

  it('reads the card type’s own section cell, and an absent type and kind', () => {
    expect(leafNoCriteria(leaf({ type: null, descriptionMd: 'Body.' }))).toBe('no-heading');
    expect(leafNoCriteria(leaf({ kind: undefined, descriptionMd: WITH_CRITERION }))).toBeNull();
    expect(
      leafNoCriteria(leaf({ kind: 'bug', type: 'test', descriptionMd: WITH_CRITERION })),
    ).toBeNull();
  });

  it('is silent on every exempt card', () => {
    const body = { descriptionMd: 'Builds the export.' };
    expect(leafNoCriteria(leaf({ ...body, hasChildren: true }))).toBeNull();
    expect(leafNoCriteria(leaf({ ...body, kind: 'story' }))).toBeNull();
    expect(leafNoCriteria(leaf({ ...body, type: 'design' }))).toBeNull();
    expect(leafNoCriteria(leaf({ ...body, executor: 'human' }))).toBeNull();
  });
});

describe('isLeafBodyCheckExempt', () => {
  const card = { kind: 'task', type: 'code', executor: 'coding_agent', hasChildren: false };

  it('exempts children, a container kind, a design leaf and a human leaf', () => {
    expect(isLeafBodyCheckExempt({ ...card, hasChildren: true })).toBe(true);
    expect(isLeafBodyCheckExempt({ ...card, kind: 'epic' })).toBe(true);
    expect(isLeafBodyCheckExempt({ ...card, kind: 'story' })).toBe(true);
    expect(isLeafBodyCheckExempt({ ...card, type: 'design' })).toBe(true);
    expect(isLeafBodyCheckExempt({ ...card, executor: 'human' })).toBe(true);
  });

  it('does not exempt a code leaf, an untyped leaf or one with an unknown kind', () => {
    expect(isLeafBodyCheckExempt(card)).toBe(false);
    expect(isLeafBodyCheckExempt({ ...card, type: null, executor: null })).toBe(false);
    expect(isLeafBodyCheckExempt({ ...card, kind: null })).toBe(false);
    expect(isLeafBodyCheckExempt({ ...card, type: 'deploy' })).toBe(false);
  });
});

describe('RUNNER_STOP_SEVERITIES', () => {
  it('lists the two body severities', () => {
    expect(RUNNER_STOP_SEVERITIES).toEqual(
      expect.arrayContaining(['leaf-no-description', 'leaf-no-criteria']),
    );
  });
});
