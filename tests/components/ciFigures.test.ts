import { describe, expect, it } from 'vitest';
import {
  ciLineFigures,
  type CiLineVariant,
} from '@/app/(authed)/settings/organization/billing/_components/ciFigures';
import { INCLUDED_MINUTES_PER_SEAT } from '@/lib/ciMetering/allowance';
import type { CiEntitlementStateDTO } from '@/lib/dto/ciAllowance';

// Unit tests for the ③ Motir CI line's pure view model (MOTIR-1903). Every
// figure the panel renders is derived here, so this is where the arithmetic is
// pinned: which drawn state the card is in, how full the meter runs, and where
// the pool boundary sits inside a saturated bar. The rendering itself is
// asserted in BillingClient.test.tsx; the end-to-end "a real, non-null state
// reaches the DTO" proof is in billingService.test.ts.

function state(over: Partial<CiEntitlementStateDTO> = {}): CiEntitlementStateDTO {
  return {
    applicable: true,
    internal: false,
    organizationId: 'org1',
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
    memberCount: 6,
    poolMinutes: 1800,
    floorApplied: false,
    consumedMinutes: 1240,
    consumedBySource: { ci: 1240, preview: 0 },
    remainingMinutes: 560,
    overageMinutes: 0,
    chargedCredits: 0,
    balance: 4420,
    state: 'within_allowance',
    ...over,
  };
}

describe('ciLineFigures', () => {
  it('renders NO line for the not-applicable cases (self-host / no provisioning org / META)', () => {
    // The DTO already models these as a real value, so the panel never has to
    // guess: `applicable: false` + `state: 'bypassed'` means no CI line at all.
    expect(
      ciLineFigures(
        state({
          applicable: false,
          state: 'bypassed',
          poolMinutes: 0,
          consumedMinutes: 0,
          remainingMinutes: 0,
          balance: null,
        }),
      ),
    ).toBeNull();
  });

  it('draws a minutes-only INTERNAL line for the META org: measured minutes, no pool, no charge (MOTIR-8886)', () => {
    const f = ciLineFigures(
      state({
        applicable: false,
        internal: true,
        state: 'bypassed',
        poolMinutes: 0,
        consumedMinutes: 412,
        remainingMinutes: 0,
        balance: null,
      }),
    );
    expect(f).not.toBeNull();
    expect(f!.variant).toBe<CiLineVariant>('internal');
    expect(f!.usedMinutes).toBe(412);
    expect(f!.poolMinutes).toBe(0);
    expect(f!.overageMinutes).toBe(0);
    expect(f!.chargedCredits).toBe(0);
    expect(f!.over).toBe(false);
    expect(f!.balanceUnavailable).toBe(false);
  });

  it('carries the within-allowance figures verbatim and fills the meter proportionally', () => {
    const f = ciLineFigures(state());
    expect(f).not.toBeNull();
    expect(f!.variant).toBe<CiLineVariant>('within_allowance');
    expect(f!.usedMinutes).toBe(1240);
    expect(f!.poolMinutes).toBe(1800);
    expect(f!.remainingMinutes).toBe(560);
    expect(f!.memberCount).toBe(6);
    expect(f!.perSeatMinutes).toBe(INCLUDED_MINUTES_PER_SEAT);
    expect(f!.resetsAt).toBe('2026-08-01T00:00:00.000Z');
    // 1240 / 1800 = 68.9% → 69
    expect(f!.meterPct).toBe(69);
    expect(f!.over).toBe(false);
    // Inside the pool the bar's own end IS the boundary — no notch to draw.
    expect(f!.tickPct).toBeNull();
    expect(f!.balanceUnavailable).toBe(false);
  });

  it('is the ZERO-CONSUMPTION variant, not an empty state, when nothing was consumed', () => {
    const f = ciLineFigures(state({ consumedMinutes: 0, remainingMinutes: 1800 }));
    expect(f!.variant).toBe<CiLineVariant>('nothing_to_bill');
    // The pool is still carried — the copy states what the org WOULD have.
    expect(f!.poolMinutes).toBe(1800);
    expect(f!.meterPct).toBe(0);
  });

  it('saturates the bar and marks the pool boundary once past the pool', () => {
    const f = ciLineFigures(
      state({
        state: 'drawing_on_credits',
        consumedMinutes: 2220,
        remainingMinutes: 0,
        overageMinutes: 420,
        chargedCredits: 420,
      }),
    );
    expect(f!.variant).toBe<CiLineVariant>('drawing_on_credits');
    expect(f!.meterPct).toBe(100);
    expect(f!.over).toBe(true);
    // The notch sits where the included pool ended: 1800 / 2220 = 81%.
    expect(f!.tickPct).toBe(81);
    expect(f!.overageMinutes).toBe(420);
    expect(f!.chargedCredits).toBe(420);
  });

  it('is PAUSED at exhaustion, and reports the credits CI drew (not the AI balance)', () => {
    const f = ciLineFigures(
      state({
        state: 'ci_credits_exhausted',
        consumedMinutes: 2410,
        remainingMinutes: 0,
        overageMinutes: 610,
        chargedCredits: 610,
        balance: 0,
      }),
    );
    expect(f!.variant).toBe<CiLineVariant>('paused');
    expect(f!.chargedCredits).toBe(610);
    expect(f!.meterPct).toBe(100);
    expect(f!.tickPct).toBe(75);
  });

  it('reports the FLOOR derivation for a small org rather than a seat sum', () => {
    const f = ciLineFigures(
      state({
        memberCount: 2,
        poolMinutes: 1000,
        floorApplied: true,
        consumedMinutes: 240,
        remainingMinutes: 760,
      }),
    );
    expect(f!.floorApplied).toBe(true);
    expect(f!.poolMinutes).toBe(1000);
    expect(f!.meterPct).toBe(24);
  });

  it('flags an unreachable balance WITHOUT turning it into exhaustion', () => {
    const f = ciLineFigures(state({ balance: null }));
    expect(f!.balanceUnavailable).toBe(true);
    // A transport blip is not a state change — the line still reads as included.
    expect(f!.variant).toBe<CiLineVariant>('within_allowance');
  });

  it('never divides by a zero pool', () => {
    const f = ciLineFigures(
      state({ poolMinutes: 0, consumedMinutes: 0, remainingMinutes: 0, memberCount: 0 }),
    );
    expect(f!.meterPct).toBe(0);
    expect(f!.tickPct).toBeNull();
  });
});
