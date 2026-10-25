import { describe, expect, it } from 'vitest';
import {
  normaliseAssumptions,
  renderRequirementMarkdown,
  requirementPageLocale,
} from '@/lib/ai/requirementMarkdown';
import { requirementPageTitle } from '@/lib/services/requirementPageService';

// THE REQUIREMENT PAGE'S BODY AND TITLE (Story MOTIR-9430 · MOTIR-9433): pure, so
// every branch of the six sections, the two languages and the assumption list is a
// plain input → output check.

const AT = new Date('2026-10-24T23:59:59Z');

const FULL = {
  outcome: 'A person plans a small feature from the overlay.',
  behaviour: 'The pane shows the requirement before Confirm.',
  scopeEdge: 'No export.',
  constraints: 'Six fields only.',
  acceptance: 'Six headings appear.',
  assumptions: [
    { id: 'r1', text: 'The pane replaces the canvas.' },
    { id: 'r2', text: 'Decline restores it.' },
  ],
};

describe('renderRequirementMarkdown', () => {
  it('emits the six headings in canonical order, then one provenance line', () => {
    const md = renderRequirementMarkdown(FULL, {
      locale: 'en',
      conversationLabel: 'Plan the pane',
      at: AT,
    });
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toEqual([
      '## Outcome',
      '## Behaviour',
      '## Scope edge',
      '## Constraints',
      '## Acceptance',
      '## Assumptions',
    ]);
    expect(md).toContain('## Outcome\n\nA person plans a small feature from the overlay.');
    expect(md).toContain('- [r1] The pane replaces the canvas.\n- [r2] Decline restores it.');
    expect(md.trimEnd().split('\n').at(-1)).toBe(
      'Composed by Motir AI in the conversation "Plan the pane" on 2026-10-24.',
    );
  });

  it('renders the Chinese headings, None lines and provenance', () => {
    const md = renderRequirementMarkdown(
      { ...FULL, scopeEdge: '', constraints: '  ' },
      { locale: 'zh', conversationLabel: '规划面板', at: AT },
    );
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toEqual([
      '## 成果',
      '## 行为',
      '## 范围边界',
      '## 约束',
      '## 验收',
      '## 假设',
    ]);
    expect(md).toContain('## 范围边界\n\n无。');
    expect(md).toContain('## 约束\n\n无。');
    expect(md).toContain('2026-10-24');
  });

  it('renders a blank scope edge and constraints as the None line, and no assumptions as None', () => {
    const md = renderRequirementMarkdown(
      { ...FULL, scopeEdge: '', constraints: '', assumptions: [] },
      { locale: 'en', conversationLabel: 'c', at: AT },
    );
    expect(md).toContain('## Scope edge\n\nNone.');
    expect(md).toContain('## Constraints\n\nNone.');
    expect(md).toContain('## Assumptions\n\nNone.');
  });
});

describe('normaliseAssumptions', () => {
  it('reads a bare string as ONE entry', () => {
    expect(normaliseAssumptions('One thing.')).toEqual([{ id: 'r1', text: 'One thing.' }]);
  });

  it('gives an entry with no id r<position>, keeping stated ids, and drops blanks', () => {
    expect(
      normaliseAssumptions([
        'first',
        { text: 'second' },
        { id: 'x9', text: 'third' },
        '   ',
        { id: ' ', text: 'fourth' },
      ]),
    ).toEqual([
      { id: 'r1', text: 'first' },
      { id: 'r2', text: 'second' },
      { id: 'x9', text: 'third' },
      { id: 'r4', text: 'fourth' },
    ]);
  });

  it('is empty when there are none', () => {
    expect(normaliseAssumptions(undefined)).toEqual([]);
  });
});

describe('requirementPageLocale', () => {
  it('keeps zh and falls every other locale back to en', () => {
    expect(requirementPageLocale('zh')).toBe('zh');
    expect(requirementPageLocale('fr')).toBe('en');
    expect(requirementPageLocale(null)).toBe('en');
  });
});

describe('requirementPageTitle', () => {
  it('takes the first non-blank line, trimmed', () => {
    expect(requirementPageTitle('\n\n  Plan the pane  \nsecond line', 'en')).toBe('Plan the pane');
  });

  it('caps the title at 255 characters', () => {
    const title = requirementPageTitle('x'.repeat(400), 'en');
    expect(title.length).toBeLessThanOrEqual(255);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to the localized Requirement label for an empty request', () => {
    expect(requirementPageTitle('  \n ', 'en')).toBe('Requirement');
    expect(requirementPageTitle('', 'zh')).toBe('需求');
  });
});
