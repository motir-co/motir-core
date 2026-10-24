import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BULK_LEG_IDS,
  SPEC_COST_SECONDS,
  assignBulkLegs,
  legCostSeconds,
  legTestMatch,
  specsForLeg,
} from './e2e/shard-plan';

// Guard for MOTIR-2617. The E2E bulk legs no longer take Playwright's
// `--shard=i/5` count-based slice; membership is bin-packed from the measured
// per-spec costs in tests/e2e/shard-plan.ts. Two things must hold for that to be
// safe, and NOTHING else in the repo checks either — the Playwright config is
// only exercised by the E2E lane itself, which is precisely the lane a mistake
// here would break:
//
//   TOTALITY — every spec file the main config can run is assigned to exactly
//   one leg. A spec with no measured cost would otherwise be silently assigned
//   to no leg and simply never run, which is strictly worse than the imbalance
//   this replaced. THIS is the assertion the card asks for: "a test asserts the
//   mapping so a future spec cannot silently rejoin the overloaded shard."
//
//   BALANCE — the packing actually balances. Regressions here are quiet: the
//   suite stays green while one leg drifts back into being the long pole where
//   the webServer crosses its memory cliff.
//
// Plus the wiring: ci.yml must pass the leg id through `E2E_SHARD` and must not
// have grown a `--shard=` back.

const E2E_DIR = join(process.cwd(), 'tests/e2e');
const CI_YML = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const PW_CONFIG = readFileSync(join(process.cwd(), 'playwright.config.ts'), 'utf8');

/**
 * The `testIgnore` patterns the main Playwright config excludes. Read from the
 * config rather than restated, so a THIRD pattern fails this test (and sends its
 * author here) instead of silently making the cost table over-broad.
 */
const testIgnorePatterns = (/testIgnore:\s*\[([^\]]*)\]/.exec(PW_CONFIG)?.[1] ?? '')
  .split(',')
  .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
  .filter(Boolean);

/** Every spec file the MAIN Playwright config can run. */
const runnableSpecs = readdirSync(E2E_DIR)
  .filter((f) => f.endsWith('.spec.ts'))
  .filter(
    (f) =>
      // The lanes the main config testIgnore's: the receipt lane, the done
      // stories' regression lane (MOTIR-9411), the cloud-on regression lane
      // (MOTIR-2849) and its original billing member, and the observability
      // lane (MOTIR-8557).
      !(
        f.startsWith('acceptance') ||
        f.startsWith('regression-') ||
        f.startsWith('cloud-') ||
        f === 'billing-cloud.spec.ts' ||
        f.startsWith('observability-')
      ),
  )
  .sort();

/** The `e2e:` job body from ci.yml (job ids sit at exactly two spaces). */
function jobBody(jobId: string): string {
  const lines = CI_YML.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^ {2}${jobId}:\\s*$`).test(l));
  expect(start, `ci.yml has a \`${jobId}:\` job`).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * The E2E legs live in TWO jobs since MOTIR-3148 — `e2e` carries the bulk and
 * @a11y legs on every pull request, `e2e-at-scale` carries the volume legs on
 * push-to-`main` and on an opted-in PR. Every assertion below is about the
 * PARTITION across both, so reading one job would let a leg go missing from
 * the other and still pass: that is precisely the "a spec silently stops being
 * covered" failure this file exists to prevent (`notes.html` #267 — a card
 * that moves work between lanes must compare the lanes, not just the selector
 * that routes into one of them).
 */
function e2eJobBody(): string {
  return `${jobBody('e2e')}\n${jobBody('e2e-at-scale')}`;
}

describe('E2E bulk-leg shard plan (MOTIR-2617)', () => {
  it('reads the fixtures it is meant to guard', () => {
    // Every assertion below is vacuous if the directory scan or the config parse
    // silently found nothing.
    expect(runnableSpecs.length).toBeGreaterThan(50);
    expect(testIgnorePatterns).toEqual([
      '**/billing-cloud.spec.ts',
      '**/cloud-*.spec.ts',
      '**/acceptance*.spec.ts',
      '**/regression-*.spec.ts',
      '**/observability-*.spec.ts',
    ]);
  });

  it('has a measured cost for every spec the main config can run', () => {
    const missing = runnableSpecs.filter((s) => !(s in SPEC_COST_SECONDS));
    expect(
      missing,
      'a new E2E spec must record its measured cost in tests/e2e/shard-plan.ts — see that file ' +
        'for how to measure it. Without an entry the spec is assigned to NO leg and never runs.',
    ).toEqual([]);
  });

  it('has no cost entry for a spec that no longer exists', () => {
    const stale = Object.keys(SPEC_COST_SECONDS).filter((s) => !runnableSpecs.includes(s));
    expect(stale, 'delete the cost entry when the spec goes').toEqual([]);
  });

  it('assigns every spec to exactly one leg', () => {
    const assignment = assignBulkLegs();
    expect(Object.keys(assignment).sort()).toEqual([...BULK_LEG_IDS].sort());
    const assigned = Object.values(assignment).flat();
    expect(assigned.sort()).toEqual([...runnableSpecs].sort());
    expect(new Set(assigned).size, 'no spec is assigned twice').toBe(assigned.length);
  });

  it('balances the legs to within 15% of the mean measured cost', () => {
    const costs = BULK_LEG_IDS.map((id) => legCostSeconds(id));
    const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
    const spread = Math.max(...costs) - Math.min(...costs);
    // The count-based `--shard=i/5` this replaced measured 55% of mean on the
    // same data (159-280s). 15% is loose enough to absorb re-measurement noise
    // and tight enough that a leg cannot drift back into being the long pole.
    expect(spread / mean, `leg costs: ${costs.map((c) => c.toFixed(1)).join(', ')}`).toBeLessThan(
      0.15,
    );
  });

  it('is deterministic — every leg computes the same assignment independently', () => {
    // The Playwright config runs assignBulkLegs() separately on each of the five
    // runners. If it were order-dependent the legs would disagree about who owns
    // a spec, and it would run twice or not at all.
    expect(assignBulkLegs()).toEqual(assignBulkLegs());
  });

  it('puts the heaviest specs on different legs', () => {
    const heaviest = Object.entries(SPEC_COST_SECONDS)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([spec]) => spec);
    const legs = heaviest.map((spec) => BULK_LEG_IDS.find((id) => specsForLeg(id)?.includes(spec)));
    expect(new Set(legs).size, `${heaviest.join(', ')} landed on ${legs.join(', ')}`).toBe(
      heaviest.length,
    );
  });

  describe('legTestMatch', () => {
    it('matches exactly its own leg’s spec files', () => {
      for (const legId of BULK_LEG_IDS) {
        const match = legTestMatch(legId);
        expect(match).not.toBeNull();
        const mine = new Set(specsForLeg(legId));
        for (const spec of runnableSpecs) {
          expect(match?.test(`/repo/tests/e2e/${spec}`), `${legId} vs ${spec}`).toBe(
            mine.has(spec),
          );
        }
      }
    });

    it('does not match a spec outside tests/e2e, or a longer name ending in one', () => {
      const legId = BULK_LEG_IDS[0];
      const spec = specsForLeg(legId)?.[0] as string;
      const match = legTestMatch(legId) as RegExp;
      expect(match.test(`/repo/tests/other/${spec}`)).toBe(false);
      expect(match.test(`/repo/tests/e2e/${spec}.bak`)).toBe(false);
      expect(match.test(`/repo/tests/e2e/extra-${spec}`)).toBe(false);
    });

    it('returns null for anything that is not a bulk leg', () => {
      // This is what leaves the a11y / at-scale / billing lanes seeing every
      // file: they set no E2E_SHARD, so the config adds no testMatch at all.
      // The out-of-range sentinel has to stay one PAST the last leg: it was
      // `bulk-6` while there were five, and MOTIR-3913's 5→8 bump made that a
      // real leg — so this case started asserting that a live leg matches
      // nothing. Bump it with the leg count, or derive it, but never leave it
      // naming a leg that exists.
      for (const id of ['', 'a11y-1', 'board-at-scale', `bulk-${BULK_LEG_IDS.length + 1}`]) {
        expect(legTestMatch(id), id).toBeNull();
      }
    });
  });

  describe('the ci.yml wiring', () => {
    const body = e2eJobBody();
    /** Each matrix leg as { id, shard?, args? } — the keys are one per line. */
    const legs = [...body.matchAll(/^ +- id: (\S+)\n((?:^ +\w+: .*\n)*)/gm)].map((m) => ({
      id: m[1] as string,
      shard: /^\s+shard: (\S+)/m.exec(m[2] ?? '')?.[1],
      args: /^\s+args: (.*)$/m.exec(m[2] ?? '')?.[1] ?? '',
    }));

    it('parses the matrix it is meant to guard', () => {
      expect(legs.map((l) => l.id)).toEqual(
        expect.arrayContaining([...BULK_LEG_IDS, 'a11y-1', 'billing-cloud']),
      );
      expect(legs.length).toBeGreaterThan(BULK_LEG_IDS.length);
    });

    it('declares a `shard:` for exactly the bulk legs', () => {
      for (const leg of legs) {
        expect(leg.shard, `leg ${leg.id}`).toBe(
          BULK_LEG_IDS.includes(leg.id as never) ? leg.id : undefined,
        );
      }
    });

    it('passes the leg id to Playwright as E2E_SHARD', () => {
      expect(body).toContain('E2E_SHARD: ${{ matrix.shard }}');
    });

    it('no longer partitions a BULK leg with --shard', () => {
      // A `--shard=i/N` on top of the testMatch would slice the leg's OWN specs
      // again — a silent way to stop running four fifths of them. The a11y legs
      // still shard legitimately: they select by tag across every file.
      const bulk = legs.filter((l) => BULK_LEG_IDS.includes(l.id as never));
      expect(bulk).toHaveLength(BULK_LEG_IDS.length);
      expect(bulk.filter((l) => l.args.includes('--shard='))).toEqual([]);
      expect(
        bulk.every((l) => l.args.includes('--grep-invert')),
        'tag selection kept',
      ).toBe(true);
    });

    it('uploads the harness watchdog series with every leg', () => {
      expect(body).toContain('out/e2e-harness');
    });
  });
});
