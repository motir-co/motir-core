// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { toPlanSessionRowDto } from '@/lib/mappers/planSessionMappers';
import type { PlanSessionListRow } from '@/lib/repositories/planChangeSessionRepository';

// MOTIR-8697 — the row mapper's SEED and FIRST-TURN rules for a guide-seeded
// session, beside the gate-seeded rows that must read exactly as before.

function row(over: Partial<PlanSessionListRow> = {}): PlanSessionListRow {
  return {
    id: 's_1',
    origin: 'conversation',
    targetKeys: ['ACME-30'],
    lastActivityAt: new Date('2026-10-15T00:00:00.000Z'),
    starterId: 'u1',
    starterName: 'Yue',
    firstTurn: 'ACME-31 · Rotate the key — the guide could not go further',
    planId: null,
    planStatus: null,
    planTitle: null,
    planSummary: null,
    planCount: 0,
    state: 'none',
    failedAt: null,
    failureReason: null,
    failureStopPhase: null,
    failureStopTitle: null,
    failureNotPlannedYet: [],
    endedAt: null,
    endReason: null,
    endedById: null,
    endedByName: null,
    copiedFromId: null,
    copiedFromEndedAt: null,
    seedGateId: null,
    seedGateKind: null,
    seedGateState: null,
    seedChosenLabel: null,
    seedCardKey: null,
    seedCardInProject: false,
    seedGuideTurnId: null,
    seedGuideCardKey: null,
    seedGuideCardInProject: false,
    ...over,
  };
}

describe('toPlanSessionRowDto — a GUIDE seed (MOTIR-8697)', () => {
  it('names the guided card, with no gate kind and no chosen label, and keeps the first turn', () => {
    const dto = toPlanSessionRowDto(
      row({ seedGuideTurnId: 't_9', seedGuideCardKey: 'ACME-31', seedGuideCardInProject: true }),
    );
    expect(dto.seed).toEqual({
      cardKey: 'ACME-31',
      gateKind: null,
      origin: 'guide',
      chosenLabel: null,
    });
    expect(dto.firstTurn).toBe('ACME-31 · Rotate the key — the guide could not go further');
  });

  it('reads as UNSEEDED, with the first turn withheld, when the guided card left the project', () => {
    const dto = toPlanSessionRowDto(
      row({ seedGuideTurnId: 't_9', seedGuideCardKey: 'OTHER-2', seedGuideCardInProject: false }),
    );
    expect(dto.seed).toBeNull();
    expect(dto.firstTurn).toBeNull();
  });

  it('reads as UNSEEDED, with the first turn withheld, when the guided card is gone', () => {
    const dto = toPlanSessionRowDto(
      row({ seedGuideTurnId: 't_9', seedGuideCardKey: null, seedGuideCardInProject: false }),
    );
    expect(dto.seed).toBeNull();
    expect(dto.firstTurn).toBeNull();
  });
});

describe('toPlanSessionRowDto — gate seeds and no seed, unchanged', () => {
  it('a refusal', () => {
    const dto = toPlanSessionRowDto(
      row({
        seedGateId: 'g_1',
        seedGateKind: 'decision_approval',
        seedGateState: 'changes_requested',
        seedCardKey: 'ACME-44',
        seedCardInProject: true,
      }),
    );
    expect(dto.seed).toEqual({
      cardKey: 'ACME-44',
      gateKind: 'decision_approval',
      origin: 'refusal',
      chosenLabel: null,
    });
    expect(dto.firstTurn).not.toBeNull();
  });

  it('a pick', () => {
    const dto = toPlanSessionRowDto(
      row({
        seedGateId: 'g_2',
        seedGateKind: 'decision_choice',
        seedGateState: 'approved',
        seedChosenLabel: 'Managed object storage',
        seedCardKey: 'ACME-42',
        seedCardInProject: true,
      }),
    );
    expect(dto.seed).toEqual({
      cardKey: 'ACME-42',
      gateKind: 'decision_choice',
      origin: 'pick',
      chosenLabel: 'Managed object storage',
    });
  });

  it('a gate seed out of the project still withholds the first turn', () => {
    const dto = toPlanSessionRowDto(
      row({
        seedGateId: 'g_1',
        seedGateKind: 'decision_approval',
        seedCardKey: 'OTHER-1',
        seedCardInProject: false,
      }),
    );
    expect(dto.seed).toBeNull();
    expect(dto.firstTurn).toBeNull();
  });

  it('no seed at all', () => {
    const dto = toPlanSessionRowDto(row());
    expect(dto.seed).toBeNull();
    expect(dto.firstTurn).not.toBeNull();
  });
});

describe('toPlanSessionRowDto — a halted walk’s not-planned-yet lines (MOTIR-10209)', () => {
  const failed = {
    failedAt: new Date('2026-11-02T00:00:00.000Z'),
    failureReason: 'job_failed',
    failureStopPhase: 'author',
    failureStopTitle: 'Send invoice reminders',
  };

  it('carries the lines verbatim and in order onto the failure', () => {
    const lines = [
      '"D" is not planned yet: plan "B" first, then plan "D".',
      'Not written yet: "T".',
    ];
    const dto = toPlanSessionRowDto(row({ ...failed, failureNotPlannedYet: lines }));
    expect(dto.failure?.notPlannedYet).toEqual(lines);
  });

  it('reads a row without lines as an empty list, the failure otherwise unchanged', () => {
    const dto = toPlanSessionRowDto(
      row({ ...failed, failureNotPlannedYet: null as unknown as string[] }),
    );
    expect(dto.failure).toEqual({
      failedAt: '2026-11-02T00:00:00.000Z',
      reason: 'job_failed',
      stopPhase: 'author',
      stopTitle: 'Send invoice reminders',
      notPlannedYet: [],
    });
  });
});

// MOTIR-11256 — a walk stopped in the reconcile, the final check or its fix keeps
// that phase; a stored value this build does not know reads as no phase.
describe('toPlanSessionRowDto — the stop phase', () => {
  const failed = {
    failedAt: new Date('2026-11-14T00:00:00.000Z'),
    failureReason: 'job_failed',
    failureStopTitle: null,
  };

  it.each(['lay', 'author', 'amend', 'check', 'repair'] as const)('keeps %s', (phase) => {
    const dto = toPlanSessionRowDto(row({ ...failed, failureStopPhase: phase }));
    expect(dto.failure?.stopPhase).toBe(phase);
  });

  it('reads an unknown or missing phase as null', () => {
    for (const failureStopPhase of ['think', null]) {
      const dto = toPlanSessionRowDto(
        row({ ...failed, failureStopPhase: failureStopPhase as unknown as 'lay' }),
      );
      expect(dto.failure?.stopPhase).toBeNull();
    }
  });
});
