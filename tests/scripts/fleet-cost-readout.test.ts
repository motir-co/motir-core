import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  READOUT_WORKLOADS,
  absentWorkloads,
  parsePeriodArg,
  renderMeterDisabled,
  renderReadout,
} from '../../scripts/fleetCostReadout';

// MOTIR-4540 — the fleet cost readout, and the three ways it could lie.
//
// The command itself is a thin caller; what needed a test is the OUTPUT, because
// each of its non-happy paths fails by printing something plausible rather than by
// erroring:
//
//   1. Off-cloud the meter is inert and the rollup is empty. Printing `0.00` would
//      claim the fleet ran and cost nothing, on a build that has no fleet.
//   2. A workload with no rows is ABSENT from the rollup, not zero in it. An
//      omitted line and a zero line lead to opposite conclusions about whether the
//      fleet is behaving, and the difference is one branch.
//   3. `costUsd` is a SQL decimal carried as a string. A float round-trip is
//      invisible per row and systematic across a month, so the money path is
//      asserted with a value a float cannot hold rather than by inspection.

const PERIOD_START = new Date(Date.UTC(2026, 7, 1));
const PERIOD_END = new Date(Date.UTC(2026, 8, 1));

/** A cost a float CANNOT represent — more significant digits than a double has.
 *  If anything on the money path parses or re-serialises, this value changes. */
const UNFLOATABLE_COST = '1234567890123456789.12345678901234567890';

describe('fleet cost readout — the meter is DISABLED', () => {
  it('prints no figure at all, and says the absence is not a zero', () => {
    const out = renderMeterDisabled();

    expect(out).toContain('DISABLED');
    expect(out).toContain('MOTIR_CLOUD');
    expect(out).toMatch(/NOT\s+a\s+reading of zero cost/i);
    // The load-bearing assertion: no digit that could be read as a figure. A `0`
    // anywhere here is the exact misreading this path exists to prevent.
    expect(out).not.toMatch(/\d/);
  });
});

describe('fleet cost readout — ABSENT is not ZERO', () => {
  it('omits a workload that did not run and names it as absent, in words', () => {
    const out = renderReadout({
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      org: {
        organizationId: 'org_1',
        lines: [{ workload: 'index', containerSeconds: 900, costUsd: '1.25', containerCount: 3 }],
      },
      metaSplit: [
        {
          isMeta: true,
          workload: 'index',
          containerSeconds: 900,
          costUsd: '1.25',
          containerCount: 3,
        },
      ],
    });

    expect(out).toContain('index');
    // `ci` and `agent` ran nothing: they must not appear as a figure line...
    expect(out).not.toMatch(/^\s+ci\s+\d/m);
    expect(out).not.toMatch(/^\s+agent\s+\d/m);
    // ...and their absence must be STATED, not left for the reader to notice.
    expect(out).toMatch(/ABSENCE, not a measured zero/);
    expect(out).toContain('ci');
    expect(out).toContain('agent');
  });

  it('reports every workload as absent when the org ran nothing', () => {
    expect(absentWorkloads([])).toEqual(READOUT_WORKLOADS);
    expect(absentWorkloads([{ workload: 'ci' }])).not.toContain('ci');
  });

  it('derives its workload set from the meter map, so every live line is covered', () => {
    // `index` is the retired code-graph index kind's line (MOTIR-12041): past rows
    // still print, but no live kind runs under it, so its absence is not reported.
    expect([...READOUT_WORKLOADS].sort()).toEqual(['agent', 'ci', 'instance']);
  });

  it('says an org with no fleet activity had none, rather than printing zeros', () => {
    const out = renderReadout({
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      org: { organizationId: 'org_quiet', lines: [] },
      metaSplit: [],
    });

    expect(out).toMatch(/No fleet activity for this organization/);
    expect(out).toMatch(/No fleet activity at all in this period/);
    expect(out).not.toMatch(/\b0\.00\b/);
  });
});

describe('fleet cost readout — the MONEY PATH is a string end to end', () => {
  it('prints the repository decimal verbatim, with no float round-trip', () => {
    const out = renderReadout({
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      org: {
        organizationId: 'org_1',
        lines: [
          {
            workload: 'index',
            containerSeconds: 10,
            costUsd: UNFLOATABLE_COST,
            containerCount: 1,
          },
        ],
      },
      metaSplit: [],
    });

    // A `parseFloat`/`Number` anywhere on this path returns 1234567890123456800
    // and this assertion fails. That is the point of choosing this value.
    expect(out).toContain(UNFLOATABLE_COST);
    expect(out).not.toContain('1234567890123456800');
  });

  it('keeps a trailing-zero decimal exactly as the repository produced it', () => {
    // `Number('0.10').toString()` is `'0.1'` — a silent narrowing of a money
    // figure that no rounding check would catch.
    const out = renderReadout({
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      org: {
        organizationId: 'org_1',
        lines: [{ workload: 'ci', containerSeconds: 60, costUsd: '0.10', containerCount: 1 }],
      },
      metaSplit: [],
    });

    expect(out).toMatch(/\b0\.10\b/);
  });

  it('coerces nothing on any line that touches cost, anywhere in the module', () => {
    // The STRUCTURAL half of the same criterion. The behavioural tests above cover
    // the paths they exercise; this one covers the path a later edit adds, and it
    // is scoped to the MONEY path rather than to the file — `Number()` on a month
    // or a container count is fine, and a guard that banned it outright would be
    // turned off the first time somebody needed one.
    const source = readFileSync(join(process.cwd(), 'scripts', 'fleetCostReadout.ts'), 'utf8');
    const moneyLines = source.split('\n').filter((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'))
        return false;
      return /cost/i.test(line);
    });

    expect(moneyLines.length).toBeGreaterThan(0); // the guard can actually fail
    for (const line of moneyLines) {
      expect(line).not.toMatch(/parseFloat/);
      expect(line).not.toMatch(/\bNumber\(/);
      expect(line).not.toMatch(/\btoFixed\(/);
      expect(line).not.toMatch(/[+\-*/]=/);
    }
  });
});

describe('fleet cost readout — what the figures MEAN is on the page', () => {
  it('states the period boundary it used and that the index line counts failures', () => {
    const out = renderReadout({
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      metaSplit: [
        {
          isMeta: false,
          workload: 'ci',
          containerSeconds: 60,
          costUsd: '0.01',
          containerCount: 1,
        },
      ],
    });

    expect(out).toContain('2026-08-01T00:00:00Z');
    expect(out).toContain('2026-09-01T00:00:00Z');
    expect(out).toMatch(/COUNTS CONTAINERS THAT FAILED/);
    // The terminology is load-bearing for this whole story: internal accounting,
    // never a customer charge.
    expect(out).toMatch(/Nothing here is charged to anyone/);
    expect(out).not.toMatch(/\bbilled\b|\bpriced\b/i);
  });

  it('separates the meta line from the tenant line', () => {
    const out = renderReadout({
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      metaSplit: [
        {
          isMeta: true,
          workload: 'index',
          containerSeconds: 900,
          costUsd: '1.25',
          containerCount: 3,
        },
        {
          isMeta: false,
          workload: 'ci',
          containerSeconds: 60,
          costUsd: '0.01',
          containerCount: 1,
        },
      ],
    });

    expect(out).toMatch(/META \(Motir's own\)/);
    expect(out).toMatch(/TENANT \(paying orgs\)/);
    expect(out.indexOf('META')).toBeLessThan(out.indexOf('TENANT'));
  });
});

describe('fleet cost readout — the --period argument', () => {
  it('resolves YYYY-MM to the first instant of that UTC month', () => {
    expect(parsePeriodArg('2026-08').toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(parsePeriodArg('2026-12').toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('refuses anything that is not a month', () => {
    expect(() => parsePeriodArg('2026-13')).toThrow(/out of range/);
    expect(() => parsePeriodArg('August')).toThrow(/YYYY-MM/);
    expect(() => parsePeriodArg('2026-08-14')).toThrow(/YYYY-MM/);
  });
});
