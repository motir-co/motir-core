import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISSUE_TYPES } from '@/lib/issues/parentRules';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import { renderSections } from '@/lib/workItems/sections/render';
import { parseSections, PARSE_SIGNALS } from '@/lib/workItems/sections/parse';
import {
  SECTION_CATALOGUE,
  checkSections,
  sectionSetFor,
  type SectionType,
} from '@/lib/workItems/sections/registry';
import { fixture } from './helpers/sectionFixture';

const TYPES: SectionType[] = [null, ...WORK_ITEM_TYPES];

describe('parseSections — round trip', () => {
  for (const kind of ISSUE_TYPES) {
    for (const type of TYPES) {
      it(`${kind} / ${type ?? 'null'}: parse(render(x)) gives x`, () => {
        const sections = fixture(kind, type);
        const expected = {
          ...sections,
          ...(sections.contextRefs
            ? {
                contextRefs: sections.contextRefs.map((r) => ({
                  ...r,
                  ref: r.ref.replace(/^`|`$/g, ''),
                })),
              }
            : {}),
        };
        const parsed = parseSections(renderSections(kind, type, sections), kind, type);
        expect(parsed.sections).toEqual(expected);
        expect(parsed.missing).toEqual([]);
        expect(parsed.invalid).toEqual([]);
        expect(parsed.signals).toEqual([]);
      });
    }
  }
});

const CODE = fixture('task', 'code');
const codeBody = renderSections('task', 'code', CODE, {
  difficulty: { level: 'low', reason: 'small' },
});

describe('parseSections — fixtures', () => {
  it('a door-rendered body keeps the difficulty line inside its section', () => {
    const parsed = parseSections(codeBody, 'task', 'code');
    expect(parsed.missing).toEqual([]);
    expect(parsed.sections.deliverables).toBe('A file.');
    // The line sits right above the boundary heading, so it is text of the section before it.
    expect(parsed.sections.assumptions).toEqual(['One assumption', '**Difficulty: low** — small']);
  });

  it('a body with no headings is all framing', () => {
    const parsed = parseSections('Just some words.\nAnd more.', 'task', 'code');
    expect(parsed.signals).toEqual(['no-headings']);
    expect(parsed.sections.framing).toBe('Just some words.\nAnd more.');
    expect(parsed.missing.sort()).toEqual(['acceptanceCriteria', 'contextRefs', 'scopeBoundary']);
  });

  it('a body without a scope boundary names only that', () => {
    const body = codeBody.replace(/## Scope BOUNDARY[\s\S]*?(?=## Acceptance)/, '');
    const parsed = parseSections(body, 'task', 'code');
    expect(parsed.missing).toEqual(['scopeBoundary']);
    expect(parsed.sections.acceptanceCriteria).toHaveLength(3);
  });

  it('an all-gutter copy returns quoted-gutter and hides nothing', () => {
    const gutter = codeBody
      .split('\n')
      .map((l) => `| ${l}`)
      .join('\n');
    const parsed = parseSections(gutter, 'task', 'code');
    expect(parsed.signals).toContain('quoted-gutter');
    expect(parsed.missing).toEqual(expect.arrayContaining(['scopeBoundary', 'acceptanceCriteria']));
    expect(parsed.sections.framing).toContain('| ## Acceptance criteria');
  });

  it('an epic with Acceptance criteria puts it in otherSections', () => {
    const parsed = parseSections(
      'Frame.\n\n## Scope BOUNDARY\n\nWall.\n\n## Acceptance criteria\n\n- x',
      'epic',
      null,
    );
    expect(parsed.sections.acceptanceCriteria).toBeUndefined();
    expect(parsed.sections.otherSections).toEqual([
      { heading: 'Acceptance criteria', body: '- x' },
    ]);
    expect(parsed.missing).toEqual([]);
  });

  it('an unknown heading goes to otherSections verbatim', () => {
    const parsed = parseSections(`${codeBody}\n## Rollout notes\n\nSlowly.\n`, 'task', 'code');
    expect(parsed.sections.otherSections).toEqual([{ heading: 'Rollout notes', body: 'Slowly.' }]);
  });

  it('a chip ref keeps the whole chip and the rest as why', () => {
    const parsed = parseSections(
      '## Context refs\n\n- [The card](motir:cmx1) — because — of `this`',
      'task',
      'code',
    );
    expect(parsed.sections.contextRefs).toEqual([
      { ref: '[The card](motir:cmx1)', why: 'because — of `this`' },
    ]);
  });

  it('nested acceptance bullets stay one item each, nesting kept', () => {
    const parsed = parseSections(
      '## Acceptance criteria\n\n- one\n  - nested\n- two',
      'task',
      'code',
    );
    expect(parsed.sections.acceptanceCriteria).toEqual(['one\n- nested', 'two']);
  });

  it('a duplicate heading signals and sends the second to otherSections', () => {
    const parsed = parseSections(
      '## Acceptance criteria\n\n- a\n\n## Acceptance criteria\n\n- b',
      'task',
      'code',
    );
    expect(parsed.signals).toContain('duplicate-heading');
    expect(parsed.sections.acceptanceCriteria).toEqual(['a']);
    expect(parsed.sections.otherSections).toEqual([
      { heading: 'Acceptance criteria', body: '- b' },
    ]);
  });

  it('a decision body missing its Alternatives names alternatives', () => {
    const body = renderSections('task', 'decision', fixture('task', 'decision'))
      .replace(/## Alternatives considered[\s\S]*?(?=## What changed)/, '')
      .replace(/## Question[\s\S]*?(?=## Scope BOUNDARY)/, '');
    expect(parseSections(body, 'task', 'decision').missing).toEqual(['alternatives']);
  });

  // MOTIR-9211 · MOTIR-10206: the decision's writing brief is six registry sections.
  it.each(['task', 'subtask'] as const)(
    'a %s decision body carrying the writing brief reads it as named sections',
    (kind) => {
      const sections = fixture(kind, 'decision');
      const body = renderSections(kind, 'decision', sections);
      const parsed = parseSections(body, kind, 'decision');
      expect(parsed.sections.decisionBrief).toBe('No intent classifier.');
      expect(parsed.sections.alternatives).toEqual([
        'An intent classifier — it guesses a WHAT the person never said',
      ]);
      expect(parsed.sections.whatChanged).toBe('**Change:** workflow\nIt said X; it says Y.');
      expect(parsed.sections.consumers).toEqual([
        'The export work item builds it',
        '`lib/a/b.ts` `route()`',
      ]);
      expect(parsed.sections.supersedes).toBe('MOTIR-1, MOTIR-2');
      expect(parsed.sections.resultingDirection).toBe('The whole direction.');
      expect(parsed.sections.otherSections).toBeUndefined();
      expect(parsed.missing).toEqual([]);
      expect(renderSections(kind, 'decision', parsed.sections)).toBe(body);
    },
  );

  it('a decision body whose brief was written as otherSections re-renders unchanged', () => {
    const {
      decisionBrief,
      alternatives,
      whatChanged,
      consumers,
      supersedes,
      resultingDirection,
      ...rest
    } = fixture('task', 'decision');
    const asOthers = renderSections('task', 'decision', {
      ...rest,
      otherSections: [
        { heading: 'Decision', body: decisionBrief as string },
        { heading: 'Alternatives considered', body: `- ${(alternatives as string[])[0]}` },
        { heading: 'What changed', body: whatChanged as string },
        {
          heading: 'Consumed by',
          body: (consumers as string[]).map((c) => `- ${c}`).join('\n'),
        },
        { heading: 'Supersedes', body: supersedes as string },
        { heading: 'Resulting direction', body: resultingDirection as string },
      ],
    });
    const parsed = parseSections(asOthers, 'task', 'decision');
    expect(parsed.sections.otherSections).toBeUndefined();
    expect(parsed.missing).toEqual([]);
    expect(renderSections('task', 'decision', parsed.sections)).toBe(asOthers);
  });

  it('a decision body with neither shape names the missing writing brief', () => {
    const parsed = parseSections('Frame.\n\n## Scope BOUNDARY\n\nWall.', 'task', 'decision');
    expect(parsed.missing).toEqual(
      expect.arrayContaining([
        'decisionBrief',
        'alternatives',
        'whatChanged',
        'consumers',
        'supersedes',
        'resultingDirection',
      ]),
    );
    expect(parsed.missing).not.toContain('question');
    expect(parsed.missing).not.toContain('recommendation');
  });

  // MOTIR-10206 AC 5: a committed decision card in the old open-question shape still parses,
  // with no `missing` section, because a STORED body is read with its legacy shape accepted.
  it('a committed decision in the old open-question shape parses with nothing missing', () => {
    const body = readFileSync(
      join(__dirname, '../../../fixtures/sections/corpus/task-decision-options.md'),
      'utf8',
    ).replace(/^---[\s\S]*?---\n+/, '');
    const parsed = parseSections(body, 'task', 'decision');
    expect(parsed.missing).toEqual([]);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.sections.question).toMatch(/download directly/);
    expect(parsed.sections.options).toHaveLength(2);
    expect(parsed.sections.recommendation).toMatch(/^Emailed link/);
  });

  it('a test body whose cases lack an arrow is invalid and keeps its text', () => {
    const parsed = parseSections('## Cases\n\n- no arrow here', 'task', 'test');
    expect(parsed.invalid.map((i) => i.section)).toContain('cases');
    expect(parsed.sections.cases).toBeUndefined();
    expect(parsed.sections.otherSections).toEqual([{ heading: 'Cases', body: '- no arrow here' }]);
  });

  it('null and whitespace are empty with every required section missing', () => {
    for (const input of [null, undefined, '', '  \n ']) {
      const parsed = parseSections(input, 'task', 'code');
      expect(parsed.signals).toEqual(['empty']);
      expect(parsed.missing).toEqual(sectionSetFor('task', 'code').required);
    }
  });

  it('a managed block adds no extra criterion and loses no marker', () => {
    const body =
      '## Acceptance criteria\n\n- first\n<!-- motir:sharpened:start -->\n- settled one\n<!-- motir:sharpened:end -->\n';
    const parsed = parseSections(body, 'task', 'code');
    expect(parsed.sections.acceptanceCriteria).toHaveLength(2);
    expect(JSON.stringify(parsed.sections)).toContain('motir:sharpened:end');
    expect(JSON.stringify(parsed.sections)).toContain('motir:sharpened:start');
  });

  it('a fenced ## line is not a heading', () => {
    const parsed = parseSections('Intro\n\n```\n## Acceptance criteria\n```\n', 'task', 'code');
    expect(parsed.sections.acceptanceCriteria).toBeUndefined();
    expect(parsed.sections.framing).toContain('## Acceptance criteria');
  });

  it('exposes a closed signal list', () => {
    expect(PARSE_SIGNALS).toEqual(['empty', 'no-headings', 'quoted-gutter', 'duplicate-heading']);
  });

  it('missing and invalid equal checkSections on the parsed sections', () => {
    const parsed = parseSections(codeBody.replace('## Context refs', '## Other'), 'task', 'code');
    const check = checkSections('task', 'code', parsed.sections);
    expect(parsed.missing).toEqual(check.missing);
    expect(parsed.invalid).toEqual(check.invalid);
  });

  it('reads a heading added to the registry with no change to the parser', () => {
    const original = SECTION_CATALOGUE.approach.heading;
    SECTION_CATALOGUE.approach.heading = 'How we will do it';
    try {
      const parsed = parseSections('## How we will do it\n\nCarefully.', 'task', 'code');
      expect(parsed.sections.approach).toBe('Carefully.');
    } finally {
      SECTION_CATALOGUE.approach.heading = original;
    }
  });
});

// A deterministic generator: no flake, no dependency.
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}
const POOL = [
  '## Acceptance criteria',
  '## Scope BOUNDARY',
  '## Context refs',
  '## Rollout notes',
  '### Sub heading',
  '# Title',
  '- bullet alpha',
  '  - nested beta',
  '1. numbered gamma',
  '- `lib/x.ts` — why delta',
  '| quoted epsilon',
  '```',
  '\\## escaped zeta',
  'plain eta words',
  '',
  '<!-- motir:sharpened:start -->',
  '<!-- motir:sharpened:end -->',
  '- [chip](motir:cm1) — theta',
];
const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? [];

describe('parseSections — never loses text', () => {
  it('fuzz: no throw, deterministic, every word survives', () => {
    const next = rng(42);
    for (let n = 0; n < 400; n += 1) {
      const lines = Array.from(
        { length: 1 + Math.floor(next() * 12) },
        () => POOL[Math.floor(next() * POOL.length)] as string,
      );
      const md = lines.join('\n');
      for (const [kind, type] of [
        ['task', 'code'],
        ['epic', null],
        ['task', 'test'],
      ] as const) {
        const a = parseSections(md, kind, type);
        expect(parseSections(md, kind, type)).toEqual(a);
        const out = words(JSON.stringify(a.sections).replace(/\\n/g, ' ')).reduce<
          Record<string, number>
        >((m, w) => ({ ...m, [w]: (m[w] ?? 0) + 1 }), {});
        const headings = new Set([
          'Acceptance',
          'criteria',
          'Scope',
          'BOUNDARY',
          'Context',
          'refs',
          'Cases',
          'Tier',
        ]);
        const expected = lines
          .filter((l) => !/^#{2,}\s/.test(l) || !/(Acceptance|Scope|Context|Cases|Tier)/.test(l))
          .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
          .flatMap(words)
          .filter(
            (w) =>
              !headings.has(w) &&
              w !== 'motir' &&
              w !== 'sharpened' &&
              w !== 'start' &&
              w !== 'end',
          );
        const need = expected.reduce<Record<string, number>>(
          (m, w) => ({ ...m, [w]: (m[w] ?? 0) + 1 }),
          {},
        );
        for (const [w, count] of Object.entries(need)) {
          expect(out[w] ?? 0, `${w} in ${JSON.stringify(md)}`).toBeGreaterThanOrEqual(count);
        }
      }
    }
  });
});
