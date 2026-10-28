import { describe, expect, it } from 'vitest';
import { sectionFindingFor, sectionFindingsFor } from '@/lib/workItems/sections/validity';
import { renderSections } from '@/lib/workItems/sections/render';
import { sectionSetFor } from '@/lib/workItems/sections/registry';
import { fixture } from './helpers/sectionFixture';

const card = { item: 'MOTIR-1', kind: 'task', type: 'code' as string | null };

describe('sectionFindingFor (MOTIR-9032)', () => {
  it('reports an empty or absent body as unstructured, naming every required section', () => {
    const required = sectionSetFor('task', 'code').required;
    for (const descriptionMd of [null, '', '   \n']) {
      const f = sectionFindingFor({ ...card, descriptionMd });
      expect(f?.state).toBe('unstructured');
      expect(f?.missing).toEqual([...required]);
      expect(f?.signals).toContain('empty');
    }
  });

  it('reports prose with no headings as unstructured, not incomplete', () => {
    const f = sectionFindingFor({ ...card, descriptionMd: 'Just some prose about the work.' });
    expect(f?.state).toBe('unstructured');
    expect(f?.signals).toContain('no-headings');
  });

  it('reports a headed body missing one required section as incomplete, by name', () => {
    const sections = fixture('task', 'code');
    const full = renderSections('task', 'code', sections);
    const { scopeBoundary: _dropped, ...rest } = sections;
    const partial = renderSections('task', 'code', rest);
    expect(sectionFindingFor({ ...card, descriptionMd: full })).toBeNull();
    const f = sectionFindingFor({ ...card, descriptionMd: partial });
    expect(f?.state).toBe('incomplete');
    expect(f?.missing).toEqual(['scopeBoundary']);
  });

  // MOTIR-9835: every section set allows `otherSections`, so an extra heading on an
  // otherwise complete body is not a finding.
  it('is silent for a complete body whose only departure is an extra heading', () => {
    const body = `${renderSections('task', 'code', fixture('task', 'code'))}\n## Appendix\n\nExtra.\n`;
    expect(sectionFindingFor({ ...card, descriptionMd: body })).toBeNull();
  });

  it('lists extra headings beside a missing required section', () => {
    const { scopeBoundary: _dropped, ...rest } = fixture('task', 'code');
    const body = `${renderSections('task', 'code', rest)}\n## Appendix\n\nExtra.\n`;
    const f = sectionFindingFor({ ...card, descriptionMd: body });
    expect(f?.state).toBe('incomplete');
    expect(f?.missing).toEqual(['scopeBoundary']);
    expect(f?.otherHeadings).toEqual(['Appendix']);
  });

  it('is silent for a complete epic body carrying an `## Acceptance criteria` heading', () => {
    const f = sectionFindingFor({
      item: 'MOTIR-3',
      kind: 'epic',
      type: null,
      descriptionMd:
        renderSections('epic', null, fixture('epic', null)) +
        '\n## Acceptance criteria\n\n- done\n',
    });
    expect(f).toBeNull();
  });

  it('is silent for a complete manual body carrying the templates’ `## Steps` heading', () => {
    const body = `${renderSections('subtask', 'manual', fixture('subtask', 'manual'))}\n## Steps\n\n1. Open the console.\n`;
    expect(
      sectionFindingFor({ item: 'MOTIR-8', kind: 'subtask', type: 'manual', descriptionMd: body }),
    ).toBeNull();
  });

  it('names the hidden sections of an all-gutter body and carries quoted-gutter', () => {
    const body = renderSections('task', 'code', fixture('task', 'code'))
      .split('\n')
      .map((l) => (l === '' ? l : `| ${l}`))
      .join('\n');
    const f = sectionFindingFor({ ...card, descriptionMd: body });
    expect(f?.signals).toContain('quoted-gutter');
    expect(f?.missing).toEqual(expect.arrayContaining(['scopeBoundary', 'acceptanceCriteria']));
  });

  it('is silent for a complete door-rendered decision body', () => {
    const body = renderSections('task', 'decision', fixture('task', 'decision'));
    expect(
      sectionFindingFor({ item: 'MOTIR-4', kind: 'task', type: 'decision', descriptionMd: body }),
    ).toBeNull();
  });

  // MOTIR-9211: the planner-recorded decision's brief (`type-decision.md`) used to
  // land in `otherSections` and make every such card `incomplete`.
  it.each(['task', 'subtask'] as const)(
    'is silent for a %s decision body carrying the planner-recorded brief',
    (kind) => {
      const {
        decisionBrief: _d,
        whatChanged: _w,
        supersedes: _s,
        resultingDirection: _r,
        ...researched
      } = fixture(kind, 'decision');
      // Hand-written after the refs, where the brief stood as `otherSections`.
      const body = `${renderSections(kind, 'decision', researched)}
## Decision

No intent classifier.

## What changed

**Change:** workflow
It said X; it says Y.

## Supersedes

MOTIR-1, MOTIR-2

## Resulting direction

The whole direction.
`;
      expect(
        sectionFindingFor({ item: 'MOTIR-5', kind, type: 'decision', descriptionMd: body }),
      ).toBeNull();
    },
  );

  it('still reports a researched decision body missing its required sections', () => {
    const {
      question: _q,
      options: _o,
      recommendation: _r,
      decisionBrief: _d,
      whatChanged: _w,
      supersedes: _s,
      resultingDirection: _rd,
      ...rest
    } = fixture('task', 'decision');
    const f = sectionFindingFor({
      item: 'MOTIR-6',
      kind: 'task',
      type: 'decision',
      descriptionMd: renderSections('task', 'decision', rest),
    });
    expect(f?.state).toBe('incomplete');
    expect(f?.missing).toEqual(['question', 'options', 'recommendation']);
    expect(f?.otherHeadings).toEqual([]);
  });

  it('is silent for a complete decision card carrying an undefined heading', () => {
    const body = `${renderSections('task', 'decision', fixture('task', 'decision'))}
## Notes

Extra.
`;
    const f = sectionFindingFor({
      item: 'MOTIR-7',
      kind: 'task',
      type: 'decision',
      descriptionMd: body,
    });
    expect(f).toBeNull();
  });

  it('is silent for a kind or type the registry has no cell for', () => {
    expect(sectionFindingFor({ ...card, kind: 'nope', descriptionMd: null })).toBeNull();
    expect(sectionFindingFor({ ...card, type: 'nope', descriptionMd: null })).toBeNull();
  });

  it('sorts findings by item and drops clean cards', () => {
    const out = sectionFindingsFor([
      { ...card, item: 'MOTIR-9', descriptionMd: null },
      { ...card, item: 'MOTIR-2', descriptionMd: null },
    ]);
    expect(out.map((f) => f.item)).toEqual(['MOTIR-2', 'MOTIR-9']);
  });
});
