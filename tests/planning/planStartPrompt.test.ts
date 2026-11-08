import { describe, expect, it } from 'vitest';
import {
  composeStartTurn,
  isStartTurn,
  planStartClaimKey,
  planStartPhase,
} from '@/lib/planning/planStartPrompt';

// MOTIR-10624 — the start prompt's pure core (design MOTIR-10623 panels 2–6): the
// ONE first turn Start and Send both send, and the phase derived from the thread.

describe('composeStartTurn', () => {
  it('is the start line alone when nothing was typed', () => {
    expect(composeStartTurn('Plan ACME-14', '')).toBe('Plan ACME-14');
    expect(composeStartTurn('Plan ACME-14', '   \n ')).toBe('Plan ACME-14');
  });

  it('puts the typed conditions after a blank line, trimmed', () => {
    expect(composeStartTurn('Re-plan ACME-14', '  No UI.\nKeep the API.  ')).toBe(
      'Re-plan ACME-14\n\nNo UI.\nKeep the API.',
    );
  });
});

describe('isStartTurn', () => {
  it('matches the start line with or without conditions', () => {
    expect(isStartTurn('Plan ACME-14', 'Plan ACME-14')).toBe(true);
    expect(isStartTurn('Plan ACME-14\n\nNo UI.', 'Plan ACME-14')).toBe(true);
  });

  it('does not match another turn, or another card that shares a prefix', () => {
    expect(isStartTurn('Plan ACME-140', 'Plan ACME-14')).toBe(false);
    expect(isStartTurn('What does it block?', 'Plan ACME-14')).toBe(false);
    expect(isStartTurn('Plan ACME-14 now', 'Plan ACME-14')).toBe(false);
  });
});

describe('planStartPhase', () => {
  const startLine = 'Plan ACME-14';

  it('is live with no user turn, and starting while a press is in flight', () => {
    expect(planStartPhase({ userTurnBodies: [], startLine, starting: false })).toBe('live');
    expect(planStartPhase({ userTurnBodies: [], startLine, starting: true })).toBe('starting');
  });

  it('is spent once the first user turn is the start turn', () => {
    expect(
      planStartPhase({ userTurnBodies: ['Plan ACME-14', 'More.'], startLine, starting: true }),
    ).toBe('spent');
  });

  it('is null for a thread begun some other way', () => {
    expect(
      planStartPhase({ userTurnBodies: ['Hi', 'Plan ACME-14'], startLine, starting: false }),
    ).toBe(null);
  });
});

describe('planStartClaimKey', () => {
  it('is per anchor and never the expansion nudge’s `start:<KEY>`', () => {
    expect(planStartClaimKey('ACME-14')).toBe('confirm-start:ACME-14');
    expect(planStartClaimKey('ACME-14')).not.toBe('start:ACME-14');
  });
});
