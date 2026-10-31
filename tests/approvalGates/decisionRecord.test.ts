import { describe, expect, it } from 'vitest';
import {
  aiDecisionBlockOf,
  decisionConfirmationSummaryOf,
  parseDecisionRecord,
  supersededKeys,
} from '@/lib/approvalGates/decisionRecord';

// THE DECISION BODY'S PARSER (Story MOTIR-5871 · Subtask MOTIR-5954; ADR
// `approval-gates.md` §1's MOTIR-5952 amendment, points 2–3). Pure: the four
// sections in their order, ONE defect reason per malformed body — the first met,
// in section order — and a stamp over the four sections only.

const COMPLETE = [
  'A note above the sections is not part of the decision.',
  '',
  '## Decision',
  'Exports move to managed object storage.',
  'The team agreed it in the planning conversation.',
  '',
  '## What changed',
  '**Change:** workflow · less requirement',
  'The approved plan kept exports in Postgres; now they live in a bucket.',
  '',
  '## Supersedes',
  '- [MOTIR-6](motir:abc) — the Postgres export table',
  '- MOTIR-7, and MOTIR-6 again',
  '',
  '## Resulting direction',
  'Every export is written to the bucket and linked from the report page.',
].join('\n');

function without(heading: string): string {
  return COMPLETE.replace(new RegExp(`## ${heading}[\\s\\S]*?(?=\\n## |$)`), '');
}

describe('a complete body', () => {
  it('parses the four sections, the change values and the superseded keys', () => {
    const parse = parseDecisionRecord(COMPLETE);
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.decisionMd).toBe(
      'Exports move to managed object storage.\nThe team agreed it in the planning conversation.',
    );
    expect(parse.changes).toEqual(['workflow', 'less_requirement']);
    expect(parse.whatChangedMd).toBe(
      'The approved plan kept exports in Postgres; now they live in a bucket.',
    );
    expect(parse.supersedes).toEqual(['MOTIR-6', 'MOTIR-7']);
    expect(parse.supersedesMd).toContain('the Postgres export table');
    expect(parse.resultingDirectionMd).toBe(
      'Every export is written to the bucket and linked from the report page.',
    );
    expect(parse.subjectVersion).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads the change values case-insensitively, comma-separated, de-duplicated', () => {
    const parse = parseDecisionRecord(
      COMPLETE.replace(
        '**Change:** workflow · less requirement',
        '**change:** More Requirement, workflow, more_requirement',
      ),
    );
    expect(parse.ok && parse.changes).toEqual(['more_requirement', 'workflow']);
  });

  it('a heading matched case-insensitively, and the first of a repeated heading wins', () => {
    const parse = parseDecisionRecord(
      COMPLETE.replace('## Decision', '## DECISION') + '\n## Decision\nA second one is ignored.',
    );
    expect(parse.ok && parse.decisionMd).toContain('managed object storage');
  });
});

describe('the defect reasons — one per malformed body, the first met', () => {
  it('no_decision_section — missing', () => {
    expect(parseDecisionRecord(without('Decision'))).toMatchObject({
      ok: false,
      defect: { reason: 'no_decision_section' },
    });
  });

  it('no_decision_section — present but empty', () => {
    const body = COMPLETE.replace(
      'Exports move to managed object storage.\nThe team agreed it in the planning conversation.\n',
      '',
    );
    expect(parseDecisionRecord(body)).toMatchObject({
      ok: false,
      defect: { reason: 'no_decision_section' },
    });
  });

  it('no_change_section — the section is missing', () => {
    expect(parseDecisionRecord(without('What changed'))).toMatchObject({
      ok: false,
      defect: { reason: 'no_change_section' },
    });
  });

  it('no_change_section — the section has no **Change:** line', () => {
    const body = COMPLETE.replace('**Change:** workflow · less requirement\n', '');
    expect(parseDecisionRecord(body)).toMatchObject({
      ok: false,
      defect: { reason: 'no_change_section' },
    });
  });

  it('unknown_change — QUOTES the value it cannot read', () => {
    const body = COMPLETE.replace('less requirement', 'a new vendor');
    expect(parseDecisionRecord(body)).toMatchObject({
      ok: false,
      defect: { reason: 'unknown_change', value: 'a new vendor' },
    });
  });

  it('unknown_change — an empty **Change:** line names no change at all', () => {
    const body = COMPLETE.replace('**Change:** workflow · less requirement', '**Change:**  ·  ');
    expect(parseDecisionRecord(body)).toMatchObject({
      ok: false,
      defect: { reason: 'unknown_change', value: '·' },
    });
  });

  it('no_supersedes_section', () => {
    expect(parseDecisionRecord(without('Supersedes'))).toMatchObject({
      ok: false,
      defect: { reason: 'no_supersedes_section' },
    });
  });

  it('empty_supersedes — the section names no work-item key', () => {
    const body = COMPLETE.replace(
      '- [MOTIR-6](motir:abc) — the Postgres export table\n- MOTIR-7, and MOTIR-6 again',
      'Nothing, really.',
    );
    expect(parseDecisionRecord(body)).toMatchObject({
      ok: false,
      defect: { reason: 'empty_supersedes' },
    });
  });

  it('no_resulting_direction', () => {
    expect(parseDecisionRecord(without('Resulting direction'))).toMatchObject({
      ok: false,
      defect: { reason: 'no_resulting_direction' },
    });
  });

  it('reports only the FIRST defect, and keeps the draft for the defect state', () => {
    const parse = parseDecisionRecord('## Supersedes\nMOTIR-9');
    expect(parse).toMatchObject({ ok: false, defect: { reason: 'no_decision_section' } });
    if (parse.ok) return;
    expect(parse.draft.supersedes).toEqual(['MOTIR-9']);
    expect(parse.draft.changes).toEqual([]);
  });

  it('an empty or absent body is no_decision_section', () => {
    expect(parseDecisionRecord(null)).toMatchObject({
      ok: false,
      defect: { reason: 'no_decision_section' },
    });
    expect(parseDecisionRecord(undefined)).toMatchObject({ ok: false });
  });
});

describe('the stamp — the four sections, and only those', () => {
  const stampOf = (body: string) => {
    const parse = parseDecisionRecord(body);
    if (!parse.ok) throw new Error(`did not parse: ${parse.defect.reason}`);
    return parse.subjectVersion;
  };

  it('is stable across CRLF and trailing or internal whitespace', () => {
    expect(stampOf(COMPLETE.replace(/\n/g, '\r\n'))).toBe(stampOf(COMPLETE));
    expect(stampOf(COMPLETE.replace('bucket.', 'bucket.   '))).toBe(stampOf(COMPLETE));
  });

  it('text outside the four sections does not move it', () => {
    expect(stampOf(COMPLETE.replace('A note above', 'A different note above'))).toBe(
      stampOf(COMPLETE),
    );
  });

  it('a change inside any of the four moves it', () => {
    const base = stampOf(COMPLETE);
    expect(stampOf(COMPLETE.replace('managed object', 'self-hosted object'))).not.toBe(base);
    expect(stampOf(COMPLETE.replace('less requirement', 'more requirement'))).not.toBe(base);
    expect(stampOf(COMPLETE.replace('MOTIR-7,', 'MOTIR-8,'))).not.toBe(base);
    expect(stampOf(COMPLETE.replace('report page', 'export page'))).not.toBe(base);
  });
});

describe('the keys and the row summary', () => {
  it('supersededKeys reads bare keys and link text, in order, de-duplicated', () => {
    expect(supersededKeys('[ACME2-7](motir:x) then ACME2-7 and B-1; not a-1 or MOTIR-')).toEqual([
      'ACME2-7',
      'B-1',
    ]);
  });

  it('summarises a complete body, and returns null for a defective one', () => {
    expect(decisionConfirmationSummaryOf(COMPLETE)).toEqual({
      decision: 'Exports move to managed object storage.',
      changes: ['workflow', 'less_requirement'],
      supersedesCount: 2,
    });
    expect(decisionConfirmationSummaryOf(without('Supersedes'))).toBeNull();
  });
});

describe('the AI boundary block (MOTIR-5958, MOTIR-10146)', () => {
  const at = new Date('2026-09-21T10:00:00.000Z');
  const human = { descriptionMd: COMPLETE, kind: 'decision_confirmation' as const, noteMd: null };
  const agent = { descriptionMd: COMPLETE, kind: 'decision_approval' as const, noteMd: null };

  it('maps each latest-gate state, dating only a decision somebody made', () => {
    expect(aiDecisionBlockOf({ ...human, state: 'approved', decidedAt: at })).toEqual({
      kind: 'decision_confirmation',
      state: 'confirmed',
      decidedAt: '2026-09-21T10:00:00.000Z',
      replanOwed: null,
      noteMd: null,
    });
    expect(
      aiDecisionBlockOf({
        ...human,
        state: 'overturned',
        decidedAt: at,
        noteMd: 'Not what we agreed.',
      }),
    ).toEqual({
      kind: 'decision_confirmation',
      state: 'overturned',
      decidedAt: '2026-09-21T10:00:00.000Z',
      replanOwed: ['MOTIR-6', 'MOTIR-7'],
      noteMd: 'Not what we agreed.',
    });
    expect(aiDecisionBlockOf({ ...human, state: 'awaiting', decidedAt: null })).toEqual({
      kind: 'decision_confirmation',
      state: 'awaiting',
      decidedAt: null,
      replanOwed: null,
      noteMd: null,
    });
  });

  it('a planner-recorded decision approved at decision_approval reads confirmed, dated', () => {
    expect(
      aiDecisionBlockOf({ ...agent, state: 'approved', decidedAt: at, noteMd: 'Looks right.' }),
    ).toEqual({
      kind: 'decision_approval',
      state: 'confirmed',
      decidedAt: '2026-09-21T10:00:00.000Z',
      replanOwed: null,
      noteMd: null,
    });
  });

  it('a decision_approval sent back reads awaiting, undated and without its note', () => {
    expect(
      aiDecisionBlockOf({ ...agent, state: 'changes_requested', decidedAt: at, noteMd: 'Redo' }),
    ).toEqual({
      kind: 'decision_approval',
      state: 'awaiting',
      decidedAt: null,
      replanOwed: null,
      noteMd: null,
    });
  });

  it('a withdrawn question, or no gate at all, reads none; a missing decidedAt stays null', () => {
    for (const state of ['superseded', null]) {
      expect(aiDecisionBlockOf({ ...human, state, decidedAt: at })).toEqual({
        kind: 'decision_confirmation',
        state: 'none',
        decidedAt: null,
        replanOwed: null,
        noteMd: null,
      });
    }
    expect(
      aiDecisionBlockOf({ ...human, descriptionMd: null, state: 'approved', decidedAt: null }),
    ).toEqual({
      kind: 'decision_confirmation',
      state: 'confirmed',
      decidedAt: null,
      replanOwed: null,
      noteMd: null,
    });
    const bare = aiDecisionBlockOf({
      ...human,
      descriptionMd: null,
      state: 'overturned',
      decidedAt: at,
    });
    expect(bare.replanOwed).toEqual([]);
    // An overturn whose note is somehow missing reads null, never undefined.
    expect(bare.noteMd).toBeNull();
  });
});
