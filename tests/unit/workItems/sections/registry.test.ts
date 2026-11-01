import { describe, expect, it } from 'vitest';
import { ISSUE_TYPES } from '@/lib/issues/parentRules';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import {
  SECTION_CATALOGUE,
  SECTION_ORDER,
  checkSections,
  describeSectionSets,
  sectionSetFor,
  sectionsSchemaFor,
  type SectionType,
} from '@/lib/workItems/sections/registry';

const TYPES: SectionType[] = [null, ...WORK_ITEM_TYPES];

const CORE = ['framing', 'scopeBoundary', 'acceptanceCriteria', 'contextRefs'];

const EXTRA_REQUIRED: Record<string, string[]> = {
  decision: [
    'decisionBrief',
    'alternatives',
    'whatChanged',
    'consumers',
    'supersedes',
    'resultingDirection',
  ],
  design: ['states'],
  test: ['cases', 'tier'],
  copy: ['strings'],
  choice: ['question', 'why', 'choiceOptions', 'gates'],
};

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('sectionSetFor', () => {
  it('is total over 5 kinds x (15 types + null)', () => {
    expect(ISSUE_TYPES).toHaveLength(5);
    expect(TYPES).toHaveLength(16);
    for (const kind of ISSUE_TYPES) {
      for (const type of TYPES) {
        const set = sectionSetFor(kind, type);
        expect(set.sections.length).toBeGreaterThan(0);
        expect(set.sections).toContain('otherSections');
        expect(set.required).not.toContain('otherSections');
      }
    }
  });

  it.each(TYPES)('leaf (task / subtask) of type %s requires the core plus its extras', (type) => {
    const expected = [...CORE, ...(type ? (EXTRA_REQUIRED[type] ?? []) : [])];
    for (const kind of ['task', 'subtask'] as const) {
      expect(sorted(sectionSetFor(kind, type).required)).toEqual(sorted(expected));
    }
  });

  it('a code task requires exactly the four core sections', () => {
    expect(sorted(sectionSetFor('task', 'code').required)).toEqual(sorted(CORE));
  });

  it('manual adds nothing beyond the core', () => {
    expect(sorted(sectionSetFor('task', 'manual').required)).toEqual(sorted(CORE));
    expect(sectionSetFor('task', 'manual').sections).not.toContain('steps');
  });

  it.each(TYPES)('a bug of type %s additionally requires reproduction', (type) => {
    const expected = [...CORE, 'reproduction', ...(type ? (EXTRA_REQUIRED[type] ?? []) : [])];
    expect(sorted(sectionSetFor('bug', type).required)).toEqual(sorted(expected));
  });

  it.each(TYPES)('a story ignores its type (%s)', (type) => {
    const set = sectionSetFor('story', type);
    expect(set.type).toBeNull();
    expect(sorted(set.required)).toEqual(
      sorted([
        'framing',
        'scopeBoundary',
        'acceptanceCriteria',
        'verificationRecipe',
        'contextRefs',
      ]),
    );
  });

  it.each(TYPES)(
    'an epic (%s) requires framing and scopeBoundary and has no acceptanceCriteria',
    (type) => {
      const set = sectionSetFor('epic', type);
      expect(sorted(set.required)).toEqual(['framing', 'scopeBoundary']);
      expect(set.sections).not.toContain('acceptanceCriteria');
    },
  );

  it('returns sections in canonical order', () => {
    const { sections } = sectionSetFor('task', 'deploy');
    const positions = sections.map((name) => SECTION_ORDER.indexOf(name));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('checkSections', () => {
  const base = {
    framing: 'f',
    scopeBoundary: 'b',
    acceptanceCriteria: ['a'],
    contextRefs: [{ ref: 'x', why: 'y' }],
  };

  it('accepts a complete code task', () => {
    expect(checkSections('task', 'code', base)).toEqual({ missing: [], unknown: [], invalid: [] });
  });

  it('refuses acceptanceCriteria on an epic by name', () => {
    const result = checkSections('epic', null, {
      framing: 'f',
      scopeBoundary: 'b',
      acceptanceCriteria: ['x'],
    });
    expect(result.unknown).toEqual(['acceptanceCriteria']);
    expect(result.missing).toEqual([]);
  });

  it('reports an empty acceptanceCriteria as missing', () => {
    expect(checkSections('task', 'code', { ...base, acceptanceCriteria: [] }).missing).toContain(
      'acceptanceCriteria',
    );
  });

  it('names alternatives when a decision task has none', () => {
    const result = checkSections('task', 'decision', {
      ...base,
      decisionBrief: 'd',
      whatChanged: 'w',
      consumers: ['c'],
      supersedes: 's',
      resultingDirection: 'r',
    });
    expect(result.missing).toEqual(['alternatives']);
  });

  it('reports an unknown key', () => {
    expect(checkSections('task', 'code', { ...base, options: [] }).unknown).toEqual(['options']);
  });

  it('accepts otherSections on every cell and never requires it', () => {
    for (const kind of ISSUE_TYPES) {
      for (const type of TYPES) {
        const set = sectionSetFor(kind, type);
        const value = Object.fromEntries(set.required.map((n) => [n, validValue(n)]));
        const withOther = { ...value, otherSections: [{ heading: 'Notes', body: 'x' }] };
        expect(checkSections(kind, type, value)).toEqual({ missing: [], unknown: [], invalid: [] });
        expect(checkSections(kind, type, withOther)).toEqual({
          missing: [],
          unknown: [],
          invalid: [],
        });
      }
    }
  });

  it('reports a malformed value by section name', () => {
    const result = checkSections('task', 'test', {
      ...base,
      cases: [{ condition: 'c' }],
      tier: 'smoke',
    });
    expect(result.invalid.map((i) => i.section).sort()).toEqual(['cases', 'tier']);
  });

  it('requires at least two choice options', () => {
    const value = {
      ...base,
      question: 'q',
      why: { situation: 'two_workflows', evidence: 'e' },
      choiceOptions: [{ label: 'a', bestFor: 'b' }],
      gates: 'g',
    };
    expect(checkSections('task', 'choice', value).invalid.map((i) => i.section)).toEqual([
      'choiceOptions',
    ]);
  });

  it('never throws on a non-object value', () => {
    expect(checkSections('task', 'code', null).missing).toEqual(CORE);
    expect(checkSections('task', 'code', 'text').missing).toEqual(CORE);
  });
});

describe('sectionsSchemaFor', () => {
  it('is strict: an unknown key is refused and named', () => {
    const result = sectionsSchemaFor('epic', null).safeParse({
      framing: 'f',
      scopeBoundary: 'b',
      acceptanceCriteria: ['x'],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('acceptanceCriteria');
  });

  it('accepts a complete input', () => {
    const result = sectionsSchemaFor('task', 'code').safeParse({
      framing: 'f',
      scopeBoundary: 'b',
      acceptanceCriteria: ['a'],
      contextRefs: [{ ref: 'x', why: 'y' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('describeSectionSets', () => {
  it('survives a JSON round-trip unchanged', () => {
    const descriptor = describeSectionSets();
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
  });

  it('lists every cell and carries a version', () => {
    const descriptor = describeSectionSets();
    expect(descriptor.version).toMatch(/\S/);
    expect(descriptor.sets).toHaveLength(ISSUE_TYPES.length * TYPES.length);
    expect(Object.keys(descriptor.sections)).toEqual([...SECTION_ORDER]);
  });
});

describe('a decision is the write-up of a decision made in planning (MOTIR-9211, MOTIR-10206)', () => {
  const BRIEF = [
    ['decisionBrief', 'Decision'],
    ['alternatives', 'Alternatives considered'],
    ['whatChanged', 'What changed'],
    ['consumers', 'Consumed by'],
    ['supersedes', 'Supersedes'],
    ['resultingDirection', 'Resulting direction'],
  ] as const;
  const LEGACY = ['question', 'options', 'recommendation'] as const;
  const base = {
    framing: 'f',
    scopeBoundary: 'b',
    acceptanceCriteria: ['a'],
    contextRefs: [{ ref: 'x', why: 'y' }],
  };
  const brief = {
    decisionBrief: 'd',
    alternatives: ['a — not chosen because b'],
    whatChanged: 'w',
    consumers: ['MOTIR-1'],
    supersedes: 's',
    resultingDirection: 'r',
  };
  const legacy = {
    question: 'q',
    options: [{ label: 'a', cost: 'c', forecloses: 'f' }],
    recommendation: 'r',
  };

  it.each(['task', 'subtask', 'bug'] as const)(
    'the %s decision cell serves the six brief sections as REQUIRED and the open-question trio as optional',
    (kind) => {
      const cell = describeSectionSets().sets.find((s) => s.kind === kind && s.type === 'decision');
      for (const [name] of BRIEF) {
        expect(cell?.sections).toContainEqual({ name, required: true });
      }
      for (const name of LEGACY) {
        expect(cell?.sections).toContainEqual({ name, required: false });
      }
    },
  );

  it('carries the headings type-decision.md requires, in its order', () => {
    const { sections } = describeSectionSets();
    expect(BRIEF.map(([name]) => sections[name]?.heading)).toEqual(BRIEF.map(([, h]) => h));
    const order = BRIEF.map(([name]) => SECTION_ORDER.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('a decision written as the brief alone is complete', () => {
    const result = checkSections('task', 'decision', { ...base, ...brief });
    expect(result).toEqual({ missing: [], unknown: [], invalid: [] });
  });

  it('a NEW decision in the old open-question shape is refused, naming the brief it lacks', () => {
    const result = checkSections('task', 'decision', { ...base, ...legacy });
    expect(result.missing).toEqual(BRIEF.map(([name]) => name));
  });

  it.each(['task', 'subtask', 'bug'] as const)(
    'a STORED %s decision in the old open-question shape still reads complete',
    (kind) => {
      const value = { ...base, ...legacy, ...(kind === 'bug' ? { reproduction: 'x' } : {}) };
      expect(checkSections(kind, 'decision', value, { acceptLegacy: true }).missing).toEqual([]);
    },
  );

  it('the legacy shape counts only when every one of its sections is there', () => {
    const { options: _o, ...partial } = legacy;
    const result = checkSections(
      'task',
      'decision',
      { ...base, ...partial },
      { acceptLegacy: true },
    );
    expect(result.missing).toEqual(BRIEF.map(([name]) => name));
  });

  it('the legacy shape never waives the leaf core', () => {
    const { scopeBoundary: _s, ...noBoundary } = base;
    const result = checkSections(
      'task',
      'decision',
      { ...noBoundary, ...legacy },
      {
        acceptLegacy: true,
      },
    );
    expect(result.missing).toEqual(['scopeBoundary']);
  });

  it('only the decision type carries a legacy shape', () => {
    for (const kind of ISSUE_TYPES) {
      for (const type of TYPES) {
        const set = sectionSetFor(kind, type);
        const expected = type === 'decision' && kind !== 'epic' && kind !== 'story' ? LEGACY : [];
        expect(set.legacy).toEqual([...expected]);
      }
    }
  });

  it('acceptLegacy changes nothing for a type with no legacy shape', () => {
    const value = { ...base, states: [] };
    expect(checkSections('task', 'design', value, { acceptLegacy: true })).toEqual(
      checkSections('task', 'design', value),
    );
  });

  it('is not offered to a cell of another type', () => {
    expect(sectionSetFor('task', 'choice').sections).not.toContain('decisionBrief');
    expect(sectionSetFor('task', 'code').sections).not.toContain('supersedes');
    expect(sectionSetFor('task', 'code').sections).not.toContain('alternatives');
  });
});

describe('headings', () => {
  it('matches the regexes planBody.ts reads', () => {
    expect(SECTION_CATALOGUE.acceptanceCriteria.heading).toMatch(/acceptance\s+criteria/i);
    expect(SECTION_CATALOGUE.contextRefs.heading).toMatch(/context\s+refs?/i);
  });

  it('are unique within every set', () => {
    for (const kind of ISSUE_TYPES) {
      for (const type of TYPES) {
        const headings = sectionSetFor(kind, type)
          .sections.map((name) => SECTION_CATALOGUE[name].heading)
          .filter((h): h is string => h !== null);
        expect(new Set(headings).size).toBe(headings.length);
      }
    }
  });

  it('uses the headings choiceOptions.ts reads for a choice', () => {
    expect(SECTION_CATALOGUE.question.heading).toBe('Question');
    expect(SECTION_CATALOGUE.why.heading).toBe('Why this is a choice');
    expect(SECTION_CATALOGUE.choiceOptions.heading).toBe('Options');
    expect(SECTION_CATALOGUE.gates.heading).toBe('What this choice gates');
  });
});

function validValue(name: string): unknown {
  switch (name) {
    case 'acceptanceCriteria':
    case 'states':
    case 'assumptions':
    case 'alternatives':
    case 'consumers':
      return ['x'];
    case 'contextRefs':
      return [{ ref: 'x', why: 'y' }];
    case 'options':
      return [{ label: 'a', cost: 'c', forecloses: 'f' }];
    case 'choiceOptions':
      return [
        { label: 'a', bestFor: 'x' },
        { label: 'b', bestFor: 'y' },
      ];
    case 'cases':
      return [{ condition: 'c', expected: 'e' }];
    case 'strings':
      return [{ key: 'k', locale: 'en', says: 's' }];
    case 'tier':
      return 'unit';
    case 'why':
      return { situation: 'two_workflows', evidence: 'e' };
    default:
      return 'text';
  }
}
