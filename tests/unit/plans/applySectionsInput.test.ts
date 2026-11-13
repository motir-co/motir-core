import { describe, expect, it } from 'vitest';
import { InvalidProposalError } from '@/lib/plans/errors';
import {
  applySectionsInput,
  hasSectionsInput,
  PERSON_CARD_STEPS_REFUSAL,
} from '@/lib/plans/applySectionsInput';
import { splitPlanBody } from '@/lib/markdown/planBody';
import { parseSections } from '@/lib/workItems/sections/parse';
import { renderSections } from '@/lib/workItems/sections/render';

// Story MOTIR-9023 · Subtask MOTIR-9030 — the ONE helper every plan door calls to
// turn a sections INPUT into the `descriptionMd` it stores. Pure, so every rule of
// the card is asserted here without a database; the doors' wiring (the plan row
// lock, the stored JSON, the review PATCH) is `tests/integration/plans/
// proposalSections.test.ts`.

const LABEL = '“A card”';

const base = {
  framing: 'Why this card exists.',
  scopeBoundary: 'Stops at the renderer.',
  acceptanceCriteria: ['It renders.', 'It refuses by name.'],
  contextRefs: [{ ref: 'lib/a.ts', why: 'the module' }],
};

function apply(
  sections: unknown,
  over: Partial<Parameters<typeof applySectionsInput>[0]> = {},
): string {
  return applySectionsInput({
    sections,
    descriptionMd: undefined,
    currentBody: undefined,
    kind: 'task',
    type: 'code',
    label: LABEL,
    ...over,
  });
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidProposalError);
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('hasSectionsInput', () => {
  it('is true for any value but undefined, so an explicit null is refused rather than ignored', () => {
    expect(hasSectionsInput({})).toBe(false);
    expect(hasSectionsInput({ sections: undefined })).toBe(false);
    expect(hasSectionsInput({ sections: null })).toBe(true);
    expect(hasSectionsInput({ sections: {} })).toBe(true);
    expect(hasSectionsInput(null)).toBe(false);
  });
});

describe('an add (no stored body)', () => {
  it('renders exactly what the renderer renders, and the plan-body parser reads it back', () => {
    const body = apply(base);
    expect(body).toBe(renderSections('task', 'code', base));
    const split = splitPlanBody(body);
    expect(split.acceptanceCriteria.map((l) => l.replace(/^\s*-\s*/, ''))).toEqual(
      base.acceptanceCriteria,
    );
    expect(split.contextRefs).toEqual(['lib/a.ts']);
    expect(body).toContain('## Scope BOUNDARY');
  });

  it('names a missing required section', () => {
    const { acceptanceCriteria: _omitted, ...without } = base;
    expect(refusal(() => apply(without))).toBe(
      `${LABEL}: sections missing required section(s): acceptanceCriteria.`,
    );
  });

  it('treats an empty required list as missing, by name', () => {
    expect(refusal(() => apply({ ...base, acceptanceCriteria: [] }))).toContain(
      'missing required section(s): acceptanceCriteria',
    );
  });

  it('names every missing section at once', () => {
    expect(refusal(() => apply({ framing: 'x' }))).toContain(
      'missing required section(s): scopeBoundary, acceptanceCriteria, contextRefs',
    );
  });

  // MOTIR-10206: a decision is the write-up of a decision made in planning, so a NEW one in
  // the old open-question shape is refused, naming the writing brief it lacks.
  it('names the writing brief when a new decision card is sent as an open question', () => {
    const message = refusal(() =>
      apply(
        {
          ...base,
          question: 'Q?',
          options: [{ label: 'A', cost: 'c', forecloses: 'f' }],
          recommendation: 'A',
        },
        { type: 'decision' },
      ),
    );
    expect(message).toContain(
      'missing required section(s): decisionBrief, alternatives, whatChanged, consumers, supersedes, resultingDirection',
    );
  });

  it('accepts a new decision card carrying the writing brief', () => {
    const body = apply(
      {
        ...base,
        decisionBrief: 'No intent classifier.',
        alternatives: ['A classifier — it guesses a WHAT nobody said'],
        whatChanged: '**Change:** workflow\nIt said X; it says Y.',
        consumers: ['MOTIR-3 builds it'],
        supersedes: 'MOTIR-1',
        resultingDirection: 'The whole direction.',
      },
      { type: 'decision' },
    );
    expect(body).toContain('## Alternatives considered');
    expect(body).toContain('## Consumed by');
  });

  it('refuses a section the cell does not define, by name, never dropping it', () => {
    const message = refusal(() =>
      apply(
        { framing: 'f', scopeBoundary: 'b', acceptanceCriteria: ['x'] },
        { kind: 'epic', type: null },
      ),
    );
    expect(message).toContain('not defined for a epic: acceptanceCriteria');
  });

  it('names an invalid section', () => {
    const message = refusal(() => apply({ ...base, contextRefs: [{ ref: 'lib/a.ts' }] }));
    expect(message).toContain('invalid section(s): contextRefs');
  });

  it('refuses a non-object', () => {
    for (const value of [null, 'text', ['a'], 3]) {
      expect(refusal(() => apply(value))).toContain('`sections` must be an object');
    }
  });

  it('refuses a kind or type no cell exists for', () => {
    expect(refusal(() => apply(base, { kind: 'saga' }))).toContain("kind 'saga'");
    expect(refusal(() => apply(base, { type: 'sorcery' }))).toContain("type 'sorcery'");
  });

  it('judges the cell on the kind and type it is handed — null type is the leaf core', () => {
    expect(() => apply(base, { type: null })).not.toThrow();
    expect(() => apply(base, { type: undefined })).not.toThrow();
  });
});

describe('sections beside descriptionMd', () => {
  it('is refused, naming both keys', () => {
    const message = refusal(() => apply(base, { descriptionMd: 'a body' }));
    expect(message).toContain('`sections`');
    expect(message).toContain('`descriptionMd`');
  });

  it('is refused even when descriptionMd is an explicit null', () => {
    expect(refusal(() => apply(base, { descriptionMd: null }))).toContain('not both');
  });
});

describe('a sparse edit over the stored body', () => {
  const stored = renderSections('task', 'code', {
    ...base,
    assumptions: ['A stays true.'],
  });

  it('keeps every section the patch omits and changes only the one sent', () => {
    const next = apply({ scopeBoundary: 'Stops at the parser.' }, { currentBody: stored });
    const before = parseSections(stored, 'task', 'code').sections;
    const after = parseSections(next, 'task', 'code').sections;
    expect(after).toEqual({ ...before, scopeBoundary: 'Stops at the parser.' });
    expect(splitPlanBody(next).acceptanceCriteria).toEqual(
      splitPlanBody(stored).acceptanceCriteria,
    );
    expect(splitPlanBody(next).contextRefs).toEqual(splitPlanBody(stored).contextRefs);
  });

  it('REPLACES a list rather than merging into it', () => {
    const next = apply({ acceptanceCriteria: ['Only this.'] }, { currentBody: stored });
    expect(parseSections(next, 'task', 'code').sections.acceptanceCriteria).toEqual(['Only this.']);
  });

  it('clears an optional section on an explicit null', () => {
    const next = apply({ assumptions: null }, { currentBody: stored });
    expect(parseSections(next, 'task', 'code').sections.assumptions).toBeUndefined();
    expect(next).not.toContain('Assumptions');
  });

  it('refuses clearing a required section, by name', () => {
    expect(refusal(() => apply({ scopeBoundary: null }, { currentBody: stored }))).toContain(
      'missing required section(s): scopeBoundary',
    );
  });

  it('is idempotent: re-sending a section it already holds changes nothing', () => {
    expect(apply({ scopeBoundary: base.scopeBoundary }, { currentBody: stored })).toBe(stored);
  });

  it('judges the MERGED cell: a re-typed card needs the sections its new type requires', () => {
    expect(
      refusal(() => apply({ framing: 'Still framed.' }, { currentBody: stored, type: 'decision' })),
    ).toContain(
      'missing required section(s): decisionBrief, alternatives, whatChanged, consumers, supersedes, resultingDirection',
    );
  });

  it('keeps a STORED decision in the old open-question shape editable (MOTIR-10206)', () => {
    const legacy = renderSections('task', 'decision', {
      ...base,
      question: 'Q?',
      options: [{ label: 'A', cost: 'c', forecloses: 'f' }],
      recommendation: 'A',
    });
    const next = apply(
      { acceptanceCriteria: ['It renders.', 'It refuses by name.', 'A third.'] },
      { currentBody: legacy, type: 'decision' },
    );
    expect(next).toContain('- A third.');
    expect(next).toContain('## Recommendation');
  });

  it('keeps every line of a hand-written body that has no headings, in framing', () => {
    const handWritten = 'Free text the planner wrote.\nA second line of it.';
    const next = apply(
      {
        scopeBoundary: base.scopeBoundary,
        acceptanceCriteria: base.acceptanceCriteria,
        contextRefs: base.contextRefs,
      },
      { currentBody: handWritten },
    );
    for (const line of handWritten.split('\n')) expect(next).toContain(line);
  });

  it('names the sections a hand-written body still lacks', () => {
    const message = refusal(() =>
      apply({ scopeBoundary: 'b' }, { currentBody: 'Free text, no headings.' }),
    );
    expect(message).toContain('missing required section(s): acceptanceCriteria, contextRefs');
  });

  it('carries an unplaced heading through otherSections', () => {
    const withExtra = `${stored}\n## Notes from review\n\nKeep the retry.\n`;
    const next = apply({ scopeBoundary: 'New boundary.' }, { currentBody: withExtra });
    expect(next).toContain('## Notes from review');
    expect(next).toContain('Keep the retry.');
  });

  it('does not silently fix a section the stored body carries but cannot be read — it names it', () => {
    const corrupt = `${stored}\n## Tier\n\nnot-a-tier\n`;
    const message = refusal(() =>
      apply({ scopeBoundary: 'b' }, { currentBody: corrupt, type: 'test' }),
    );
    expect(message).toContain('tier');
  });
});

describe('a framing whose every line carries a "| " gutter', () => {
  it('hides nothing: the separately sent criteria and refs stay readable', () => {
    const body = apply({
      ...base,
      framing: '| The planner pasted this\n| from a quoted block',
    });
    const split = splitPlanBody(body);
    expect(split.acceptanceCriteria).toHaveLength(2);
    expect(split.contextRefs).toEqual(['lib/a.ts']);
  });
});

// Bug MOTIR-11161 — a person's card keeps its steps in `todos`. Both planners were
// told the steps live in the list alone AND offered a deploy `## Steps` section, so
// a person's deploy carried its procedure twice and the copies drifted. The door
// every body write passes refuses a SENT `steps` on a person's card by name.
describe("a `steps` section on a person's card (MOTIR-11161)", () => {
  const steps = '- Run the suite.\n- Record the result.';
  const deploy = { type: 'deploy' } as const;
  const personMessage = `${LABEL}: sections invalid section(s): steps (${PERSON_CARD_STEPS_REFUSAL}).`;

  it('refuses a human deploy that sends `steps`, naming the section and pointing at todos', () => {
    const message = refusal(() => apply({ ...base, steps }, { ...deploy, executor: 'human' }));
    expect(message).toBe(personMessage);
    expect(message).toContain('`todos`');
  });

  it('refuses it on a `manual` card with no executor, by the same name — not as an unknown section', () => {
    const message = refusal(() => apply({ ...base, steps }, { type: 'manual' }));
    expect(message).toBe(personMessage);
    expect(message).not.toContain('not defined');
  });

  it('refuses a malformed `steps` on a person’s card with the one finding, not two', () => {
    const message = refusal(() =>
      apply({ ...base, steps: 42 }, { type: 'verification', executor: 'human' }),
    );
    expect(message).toBe(personMessage);
  });

  it('names the refusal beside the other findings of the same write', () => {
    const { acceptanceCriteria: _omitted, ...without } = base;
    const message = refusal(() => apply({ ...without, steps }, { ...deploy, executor: 'human' }));
    expect(message).toContain('missing required section(s): acceptanceCriteria');
    expect(message).toContain(`steps (${PERSON_CARD_STEPS_REFUSAL})`);
  });

  it('keeps `steps` on an agent-run deploy, explicit or seeded', () => {
    for (const executor of ['coding_agent', null, undefined]) {
      const body = apply({ ...base, steps }, { ...deploy, executor });
      expect(body).toBe(renderSections('task', 'deploy', { ...base, steps }));
      expect(body).toContain('## Steps');
    }
  });

  it('lets an edit of a stored human deploy that already holds `## Steps` land when it does not resend it', () => {
    const stored = renderSections('task', 'deploy', { ...base, steps });
    const next = apply(
      { scopeBoundary: 'Stops at the deploy.' },
      { ...deploy, executor: 'human', currentBody: stored },
    );
    expect(next).toContain('Stops at the deploy.');
    expect(next).toContain('## Steps');
  });

  it('lets an explicit `steps: null` clear the stored section on a person’s card', () => {
    const stored = renderSections('task', 'deploy', { ...base, steps });
    const next = apply({ steps: null }, { ...deploy, executor: 'human', currentBody: stored });
    expect(next).not.toContain('## Steps');
    expect(parseSections(next, 'task', 'deploy').sections.steps).toBeUndefined();
  });
});
