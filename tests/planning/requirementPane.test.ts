import { describe, expect, it } from 'vitest';
import { assumptionRowsOf, requirementPaneOf } from '@/lib/planning/requirementPane';
import type { PlanOfferRecord, PlanOfferTurn } from '@/lib/planChange/planOffer';

// THE LEFT PANE'S REQUIREMENT, the pure half (MOTIR-9437): the layer is up exactly when the
// live offer is a plan offer with no target, or a targeted one carrying a requirement
// (MOTIR-9878) — the one rule the rail reads.

const REQUIREMENT = {
  outcome: 'Managers export a report.',
  behaviour: 'A button downloads the rows.',
  scopeEdge: '',
  constraints: '',
  acceptance: 'The file opens.',
  assumptions: [{ id: 'r1', text: 'UTF-8.' }],
};

const offer = (over: Partial<PlanOfferRecord> = {}): PlanOfferRecord => ({
  kind: 'plan',
  requestMd: 'Plan the export.',
  targetKey: null,
  declinedAt: null,
  confirmedAt: null,
  confirmedSessionId: null,
  ...over,
});

const turn = (id: string, seq: number, over: Partial<PlanOfferTurn> = {}): PlanOfferTurn => ({
  id,
  seq,
  role: 'assistant',
  ...over,
});

describe('requirementPaneOf', () => {
  it('answers the pending no-target plan offer’s turn, request and requirement', () => {
    const turns = [
      turn('u1', 0, { role: 'user' }),
      turn('a1', 1, { offer: offer({ requirement: REQUIREMENT }) }),
    ];
    expect(requirementPaneOf(turns)).toEqual({
      turnId: 'a1',
      requestMd: 'Plan the export.',
      requirement: REQUIREMENT,
    });
  });

  it('answers requirement null for a no-target offer that carries none', () => {
    expect(requirementPaneOf([turn('a1', 1, { offer: offer() })])).toEqual({
      turnId: 'a1',
      requestMd: 'Plan the export.',
      requirement: null,
    });
  });

  it('answers a targeted offer that carries a requirement (MOTIR-9878)', () => {
    const o = offer({ targetKey: 'ACME-1', requirement: REQUIREMENT });
    expect(requirementPaneOf([turn('a1', 1, { offer: o })])).toEqual({
      turnId: 'a1',
      requestMd: 'Plan the export.',
      requirement: REQUIREMENT,
    });
  });

  it.each([
    ['a targeted offer with no requirement', offer({ targetKey: 'ACME-1' })],
    ['a log_bug offer', offer({ kind: 'log_bug', requirement: REQUIREMENT })],
    ['a declined offer', offer({ declinedAt: '2026-10-24T10:00:00Z', requirement: REQUIREMENT })],
    [
      'a confirmed offer',
      offer({
        confirmedAt: '2026-10-24T10:00:00Z',
        confirmedSessionId: 's2',
        requirement: REQUIREMENT,
      }),
    ],
  ])('answers null for %s', (_label, o) => {
    expect(requirementPaneOf([turn('a1', 1, { offer: o })])).toBeNull();
  });

  it('answers null once a later answer superseded the offer, and for an empty thread', () => {
    const turns = [
      turn('a1', 1, { offer: offer({ requirement: REQUIREMENT }) }),
      turn('u2', 2, { role: 'user' }),
      turn('a2', 3),
    ];
    expect(requirementPaneOf(turns)).toBeNull();
    expect(requirementPaneOf([])).toBeNull();
    expect(requirementPaneOf([turn('u1', 0, { role: 'user' })])).toBeNull();
  });

  it('follows a newer offer: the later turn’s requirement, under its own turn id', () => {
    const newer = { ...REQUIREMENT, outcome: 'Managers export a weekly report.' };
    const turns = [
      turn('a1', 1, { offer: offer({ requirement: REQUIREMENT }) }),
      turn('u2', 2, { role: 'user' }),
      turn('a2', 3, { offer: offer({ requirement: newer }) }),
    ];
    const pane = requirementPaneOf(turns);
    expect(pane?.turnId).toBe('a2');
    expect(pane?.requirement?.outcome).toBe('Managers export a weekly report.');
  });
});

describe('assumptionRowsOf', () => {
  it('turns a bare string into one row, shown as r1', () => {
    expect(assumptionRowsOf('UTF-8.')).toEqual([{ id: 'r1', text: 'UTF-8.' }]);
  });

  it('keeps each entry’s id and shows a missing id as r<position>', () => {
    expect(
      assumptionRowsOf([
        { id: 'a', text: 'One.' },
        { text: 'Two.' },
        'Three.',
        { id: ' ', text: 'Four.' },
      ]),
    ).toEqual([
      { id: 'a', text: 'One.' },
      { id: 'r2', text: 'Two.' },
      { id: 'r3', text: 'Three.' },
      { id: 'r4', text: 'Four.' },
    ]);
  });

  it('turns an empty list, a missing value and blank entries into no rows', () => {
    expect(assumptionRowsOf([])).toEqual([]);
    expect(assumptionRowsOf(undefined)).toEqual([]);
    expect(assumptionRowsOf('   ')).toEqual([]);
    expect(assumptionRowsOf([{ id: 'r1', text: ' ' }])).toEqual([]);
  });
});
