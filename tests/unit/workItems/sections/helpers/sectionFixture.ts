import {
  sectionSetFor,
  type SectionType,
  type WorkItemSections,
} from '@/lib/workItems/sections/registry';
import type { IssueType } from '@/lib/issues/parentRules';

export const CRITERIA = [
  'First criterion',
  'Second criterion\nwith a continuation line',
  'Third criterion',
];
export const REFS = [
  { ref: 'lib/a/b.ts', why: 'the plain path' },
  { ref: '`lib/c.ts`', why: 'already backticked' },
  { ref: '[The registry](motir:cmabc123)', why: 'a chip whose why has `code` and - dashes' },
];
export const REF_PATHS = ['lib/a/b.ts', 'lib/c.ts', 'motir:cmabc123'];

export function fixture(kind: IssueType, type: SectionType): WorkItemSections {
  const set = sectionSetFor(kind, type);
  const all: WorkItemSections = {
    framing: 'The framing paragraph.',
    question: 'What should we do?',
    why: { situation: 'two_workflows', evidence: 'It forks.' },
    options: [{ label: 'A', cost: 'low', forecloses: 'nothing' }],
    choiceOptions: [
      { label: 'Alpha', bestFor: 'speed', why: 'Because.' },
      { label: 'Beta', bestFor: 'safety' },
    ],
    recommendation: 'Take A.',
    states: ['empty', 'loaded'],
    cases: [{ condition: 'c', expected: 'e' }],
    tier: 'unit',
    strings: [{ key: 'k', locale: 'en', says: 'Hello' }],
    reproduction: 'Do the thing.',
    deliverables: 'A file.',
    approach: 'Carefully.',
    outline: 'One, two.',
    home: 'docs/x.md',
    steps: 'Step one.',
    postDeployVerification: 'Check it.',
    rollback: 'Revert.',
    verificationRecipe: 'Run it.',
    assumptions: ['One assumption'],
    gates: 'Follow-up work.',
    scopeBoundary: 'The boundary text.',
    acceptanceCriteria: CRITERIA,
    contextRefs: REFS,
    decisionBrief: 'No intent classifier.',
    alternatives: ['An intent classifier — it guesses a WHAT the person never said'],
    whatChanged: '**Change:** workflow\nIt said X; it says Y.',
    consumers: ['The export work item builds it', '`lib/a/b.ts` `route()`'],
    supersedes: 'MOTIR-1, MOTIR-2',
    resultingDirection: 'The whole direction.',
  };
  return Object.fromEntries(
    Object.entries(all).filter(([name]) => set.sections.includes(name as never)),
  );
}
