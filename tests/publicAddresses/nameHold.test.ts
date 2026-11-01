import { describe, expect, it } from 'vitest';

import {
  CHANGE_INTERVAL_DAYS,
  GRACE_HOURS,
  QUARANTINE_DAYS,
  addDays,
  canChangeNow,
  holdOutcome,
  nextChangeAllowedAt,
} from '@/lib/publicAddresses/nameHold';

// THE NAME-HOLD RULE — Story MOTIR-4528 · MOTIR-9506. Pure: every instant is an
// argument, so each boundary is asserted to the millisecond.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CLAIMED = new Date('2026-03-01T09:00:00.000Z');

describe('holdOutcome — the 24-hour grace and the 90-day quarantine', () => {
  it('returns the name at once when it was held 1 ms under the grace', () => {
    const releasedAt = new Date(CLAIMED.getTime() + GRACE_HOURS * HOUR_MS - 1);
    expect(holdOutcome({ claimedAt: CLAIMED, releasedAt })).toEqual({ kind: 'return_now' });
  });

  it('quarantines a name held exactly the grace, until 90 days after the release', () => {
    const releasedAt = new Date(CLAIMED.getTime() + GRACE_HOURS * HOUR_MS);
    const outcome = holdOutcome({ claimedAt: CLAIMED, releasedAt });
    expect(outcome).toEqual({
      kind: 'quarantine',
      returnsAt: new Date(releasedAt.getTime() + QUARANTINE_DAYS * DAY_MS),
    });
  });

  it('quarantines a name held longer than the grace', () => {
    const releasedAt = addDays(CLAIMED, 200);
    const outcome = holdOutcome({ claimedAt: CLAIMED, releasedAt });
    expect(outcome.kind).toBe('quarantine');
    if (outcome.kind === 'quarantine') {
      expect(outcome.returnsAt.getTime() - releasedAt.getTime()).toBe(QUARANTINE_DAYS * DAY_MS);
    }
  });

  it('states the rule constants once', () => {
    expect([GRACE_HOURS, QUARANTINE_DAYS, CHANGE_INTERVAL_DAYS]).toEqual([24, 90, 30]);
  });
});

describe('the 30-day change limit', () => {
  // Spans the EU daylight-saving change of 29 March 2026: the limit is UTC
  // milliseconds, so the shift moves nothing.
  const changed = new Date('2026-03-20T12:00:00.000Z');

  it('allows the next change exactly 30 UTC days after the last one', () => {
    expect(nextChangeAllowedAt(changed)).toEqual(new Date('2026-04-19T12:00:00.000Z'));
  });

  it('refuses at 29 days 23 h 59 m and allows at exactly 30 days', () => {
    const almost = new Date(changed.getTime() + CHANGE_INTERVAL_DAYS * DAY_MS - 60 * 1000);
    const exactly = new Date(changed.getTime() + CHANGE_INTERVAL_DAYS * DAY_MS);
    expect(canChangeNow(changed, almost)).toBe(false);
    expect(canChangeNow(changed, new Date(exactly.getTime() - 1))).toBe(false);
    expect(canChangeNow(changed, exactly)).toBe(true);
  });

  it('allows a change for a workspace that has never changed its name', () => {
    expect(canChangeNow(null, changed)).toBe(true);
  });
});

describe('purity', () => {
  it('imports nothing from Prisma, the database or the clock', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile('lib/publicAddresses/nameHold.ts', 'utf8');
    expect(source).not.toMatch(/^import /m);
    expect(source).not.toMatch(/Date\.now\(|new Date\(\)/);
  });
});
