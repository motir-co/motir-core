import { describe, expect, it } from 'vitest';
import {
  classifyRunner,
  LINUX_EQUIVALENT_MULTIPLIER,
  MOTIR_FLEET_RUNNER_LABEL,
  multiplierForLabels,
  resolveRunnerRate,
  RUNNER_RATES,
} from '@/lib/ciMetering/runnerRates';
import { MOTIR_ON_DEMAND_RUNNER_LABEL } from '@/lib/ciFleet/config';

// Runner normalization (Story MOTIR-1775 · MOTIR-1896; the Motir fleet family is
// MOTIR-1923) — `docs/decisions/ci-minutes-allowance.md` §3 + amendment §M. Pure
// unit tests: no DB, no clock.
//
// Every instant below is PINNED, never derived from `new Date()`: these assert
// against the table's own `effectiveFrom` values, so a test that read the wall
// clock would be green until the day it silently wasn't (MOTIR-1950/1951/1954).

const AFTER_REPRICING = new Date('2026-07-30T12:00:00.000Z');
const BEFORE_REPRICING = new Date('2025-06-01T00:00:00.000Z');
/** After the fleet's rate takes effect (2026-08-01) — and note it is AFTER
 *  `AFTER_REPRICING`, which predates the fleet row entirely. */
const AFTER_FLEET_PRICED = new Date('2026-08-15T00:00:00.000Z');
/** Before it — the window where a fleet job still takes the §3.4 fallback. */
const BEFORE_FLEET_PRICED = new Date('2026-07-15T00:00:00.000Z');

describe('classifyRunner', () => {
  it.each([
    ['ubuntu-latest', 'linux_x64'],
    ['ubuntu-24.04', 'linux_x64'],
    ['windows-latest', 'windows_x64'],
    ['windows-2022', 'windows_x64'],
    ['macos-latest', 'macos'],
    ['macos-14', 'macos'],
    ['ubuntu-24.04-arm', 'linux_arm64'],
  ] as const)('classifies %s as %s', (label, family) => {
    expect(classifyRunner([label])).toBe(family);
  });

  it('is case-insensitive and tolerant of surrounding whitespace', () => {
    expect(classifyRunner(['  Ubuntu-Latest '])).toBe('linux_x64');
    expect(classifyRunner(['MACOS-14'])).toBe('macos');
  });

  it('classifies a LARGER hosted runner as unknown, not as its OS', () => {
    // The ADR prices the four standard 2-core runners. A larger runner is still
    // Linux, but it is NOT the Linux the x1.00 rate prices — charging it as one
    // would be a priced guess, so it takes the safe x1.00 fallback WITH a log.
    expect(classifyRunner(['ubuntu-latest-4-core'])).toBe('unknown');
    expect(classifyRunner(['windows-latest-8-core'])).toBe('unknown');
    expect(classifyRunner(['ubuntu-latest-xlarge'])).toBe('unknown');
  });

  it('classifies an empty / unrecognised label set as unknown', () => {
    expect(classifyRunner([])).toBe('unknown');
    expect(classifyRunner(['', '   '])).toBe('unknown');
    expect(classifyRunner(['self-hosted-tpu'])).toBe('unknown');
  });

  it('takes the FIRST recognisable label when several are present', () => {
    // GitHub reports `["self-hosted", "linux", "x64"]` style label sets; the
    // first match wins so the classification is deterministic.
    expect(classifyRunner(['macos-14', 'ubuntu-latest'])).toBe('macos');
  });
});

describe('classifyRunner — the MOTIR FLEET family (MOTIR-1923 · ADR §M)', () => {
  it('classifies the fleet label as its OWN family, not as GitHub-hosted Linux', () => {
    // Attribution is the point: metering a fleet run as `linux_x64` would give
    // the right number under the wrong family, which §M calls the worst kind of
    // correct — the breakdown would claim GitHub-hosted minutes Motir never paid.
    expect(classifyRunner([MOTIR_FLEET_RUNNER_LABEL])).toBe('motir_fleet');
  });

  it('is case-insensitive and whitespace-tolerant, like every other family', () => {
    expect(classifyRunner([`  ${MOTIR_FLEET_RUNNER_LABEL.toUpperCase()} `])).toBe('motir_fleet');
  });

  it('wins over an OS label anywhere in the set, whatever the order', () => {
    // The ADR records an honest unknown: GitHub's REST reference does not say
    // whether `labels` reports what `runs-on` REQUESTED or what the runner
    // CARRIES. The fleet registers with `--no-default-labels` so both readings
    // give one element — but the pre-pass makes a mixed set attribute correctly
    // either way, rather than depending on which reading turns out to be true.
    expect(classifyRunner(['ubuntu-latest', MOTIR_FLEET_RUNNER_LABEL])).toBe('motir_fleet');
    expect(classifyRunner(['self-hosted', MOTIR_FLEET_RUNNER_LABEL])).toBe('motir_fleet');
  });

  it('matches EXACTLY — a near-miss variant stays unknown rather than borrowing the rate', () => {
    // `motir-runner-large` is not the 2-core-equivalent spec the ×1.00 parity
    // rate was decided for, so it must NOT silently take it. Falling to unknown
    // meters at the same ×1.00 but WARNS — the signal to price it deliberately.
    expect(classifyRunner(['motir-runner-large'])).toBe('unknown');
    expect(classifyRunner(['motir-runner-4-core'])).toBe('unknown');
    expect(classifyRunner(['motir'])).toBe('unknown');
  });

  it('the label itself satisfies §M.2 — no OS substring, no larger-runner match', () => {
    // §M.2 constrains the string because the classifier matches on substrings:
    // a label containing `linux` would classify as GitHub-hosted Linux, and one
    // containing `2-core` would warn on every fleet run forever. Asserted here
    // against the real classifier so renaming the constant cannot break it by eye.
    for (const forbidden of ['ubuntu', 'linux', 'arm', 'windows', 'macos', 'osx']) {
      expect(MOTIR_FLEET_RUNNER_LABEL).not.toContain(forbidden);
    }
    // If the label ever matched the larger-runner pattern, THIS would classify
    // as `unknown` instead of the fleet — the same guard, machine-checked.
    expect(classifyRunner([MOTIR_FLEET_RUNNER_LABEL])).toBe('motir_fleet');
  });

  it('the on-demand label satisfies §M.2 too, and a job asking for both labels meters as the fleet (MOTIR-11727)', () => {
    for (const forbidden of ['ubuntu', 'linux', 'arm', 'windows', 'macos', 'osx']) {
      expect(MOTIR_ON_DEMAND_RUNNER_LABEL).not.toContain(forbidden);
    }
    // Alone it is no family the meter prices — and, crucially, not the
    // larger-runner `unknown` route with its warning either way it is read.
    expect(MOTIR_ON_DEMAND_RUNNER_LABEL).not.toMatch(/(^|-)(\d+-?core|xlarge|large)(-|$)/i);
    expect(classifyRunner(['motir-runner', 'motir-on-demand'])).toBe('motir_fleet');
    expect(classifyRunner([MOTIR_ON_DEMAND_RUNNER_LABEL, MOTIR_FLEET_RUNNER_LABEL])).toBe(
      'motir_fleet',
    );
  });
});

describe('resolveRunnerRate — effective dating (§3.3)', () => {
  it('resolves each priced family to its cost-proportional multiplier', () => {
    // The ratios are the runner's own GitHub price over the Linux 2-core x64
    // price (the numeraire) — NOT GitHub's included-minutes drain multipliers,
    // which §3.2 records as the wrong basis.
    expect(resolveRunnerRate('linux_x64', AFTER_REPRICING)?.multiplier).toBe(1.0);
    expect(resolveRunnerRate('linux_arm64', AFTER_REPRICING)?.multiplier).toBe(0.83);
    expect(resolveRunnerRate('windows_x64', AFTER_REPRICING)?.multiplier).toBe(1.67);
    expect(resolveRunnerRate('macos', AFTER_REPRICING)?.multiplier).toBe(10.33);
  });

  it('does NOT use GitHub’s included-minutes multipliers (the §3.2 correction)', () => {
    // Adopting Windows x2 / macOS x10 would overcharge Windows by 20% and
    // undercharge macOS by 3%. This test is the guard against re-introducing them.
    expect(resolveRunnerRate('windows_x64', AFTER_REPRICING)?.multiplier).not.toBe(2);
    expect(resolveRunnerRate('macos', AFTER_REPRICING)?.multiplier).not.toBe(10);
  });

  it('every COST_RATIO multiplier equals its own price divided by the Linux x64 price', () => {
    const linux = RUNNER_RATES.find((r) => r.family === 'linux_x64');
    expect(linux).toBeDefined();
    const costRatioRates = RUNNER_RATES.filter((r) => r.basis === 'cost_ratio');
    // Guard the guard: if a future edit flipped every row to `product_parity`
    // this loop would pass vacuously while asserting nothing.
    expect(costRatioRates.length).toBeGreaterThanOrEqual(4);
    for (const rate of costRatioRates) {
      // The ratio is what makes a single blended overage rate honest (§2.3).
      expect(rate.multiplier).toBeCloseTo(rate.usdPerMinute / linux!.usdPerMinute, 2);
    }
  });

  it('the FLEET row is the only product-parity row, and is NOT a cost ratio (§M.4)', () => {
    // The fleet's ×1.00 is a decided customer-facing rate, not a ratio of its own
    // cost — pricing it at the true ~×0.1 ratio would hand every org ~10× more
    // effective CI, which is an allowance change made in a rate table. This test
    // is the guard against a future reader "fixing" the row into a ratio.
    const parity = RUNNER_RATES.filter((r) => r.basis === 'product_parity');
    expect(parity.map((r) => r.family)).toEqual(['motir_fleet']);

    const linux = RUNNER_RATES.find((r) => r.family === 'linux_x64');
    const fleet = parity[0]!;
    expect(fleet.multiplier).toBe(1.0);
    // Its usdPerMinute records MOTIR's own cost, so the ratio deliberately does
    // NOT hold — the fleet is far cheaper than the numéraire it meters at.
    expect(fleet.usdPerMinute).toBeLessThan(linux!.usdPerMinute);
    expect(fleet.multiplier).not.toBeCloseTo(fleet.usdPerMinute / linux!.usdPerMinute, 2);
  });

  it('returns null for a run that PREDATES every entry — history never re-prices', () => {
    // A rate is in force from its `effectiveFrom`, so a run older than the table
    // takes the x1.00 fallback rather than silently borrowing today's price.
    expect(resolveRunnerRate('macos', BEFORE_REPRICING)).toBeNull();
  });

  it('returns null for an unpriced family', () => {
    expect(resolveRunnerRate('unknown', AFTER_REPRICING)).toBeNull();
  });
});

describe('multiplierForLabels', () => {
  it('prices a known runner and reports it as priced', () => {
    expect(multiplierForLabels(['macos-14'], AFTER_REPRICING)).toEqual({
      family: 'macos',
      multiplier: 10.33,
      priced: true,
    });
  });

  it('falls back to x1.00 and flags an unpriced runner (§3.4)', () => {
    // Under-counting a runner Motir has not priced is the SAFE direction: it
    // never over-bills a user for a rate nobody decided. `priced: false` is what
    // the service logs on — the signal to add a rate.
    expect(multiplierForLabels(['self-hosted-tpu'], AFTER_REPRICING)).toEqual({
      family: 'unknown',
      multiplier: LINUX_EQUIVALENT_MULTIPLIER,
      priced: false,
    });
  });

  it('falls back for a priced FAMILY whose rate is not yet in force', () => {
    expect(multiplierForLabels(['windows-latest'], BEFORE_REPRICING)).toEqual({
      family: 'windows_x64',
      multiplier: LINUX_EQUIVALENT_MULTIPLIER,
      priced: false,
    });
  });
});

describe('multiplierForLabels — the fleet is PRICED at ×1.00, not fallen back to it', () => {
  it('prices a fleet job at ×1.00 and reports priced: true — so it never warns', () => {
    // Both paths produce ×1.00, and that is exactly why this assertion matters:
    // `priced` is the ONLY thing separating "a decided product rate" from "no row
    // exists yet". The meter logs on `priced: false`, so without this row every
    // fleet run would warn forever and bury the genuinely-unpriced signal.
    expect(multiplierForLabels([MOTIR_FLEET_RUNNER_LABEL], AFTER_FLEET_PRICED)).toEqual({
      family: 'motir_fleet',
      multiplier: 1.0,
      priced: true,
    });
  });

  it('an unknown runner STILL falls back and STILL warns — §3.4 is intact', () => {
    // The fleet row must not paper over the safety path it sits next to.
    expect(multiplierForLabels(['some-vendor-gpu'], AFTER_FLEET_PRICED)).toEqual({
      family: 'unknown',
      multiplier: LINUX_EQUIVALENT_MULTIPLIER,
      priced: false,
    });
  });

  it('does NOT re-price a run that predates the row — a new row, never a backfill (§3.3)', () => {
    // The whole point of effective dating: adding this row today leaves every
    // already-metered period exactly as it was charged. A fleet-labelled job
    // completing before the row takes the §3.4 fallback (same ×1.00, but it
    // warns), so history cannot silently change price under an audit.
    expect(multiplierForLabels([MOTIR_FLEET_RUNNER_LABEL], BEFORE_FLEET_PRICED)).toEqual({
      family: 'motir_fleet',
      multiplier: LINUX_EQUIVALENT_MULTIPLIER,
      priced: false,
    });
    expect(resolveRunnerRate('motir_fleet', BEFORE_FLEET_PRICED)).toBeNull();
    expect(resolveRunnerRate('motir_fleet', AFTER_FLEET_PRICED)?.multiplier).toBe(1.0);
  });
});
