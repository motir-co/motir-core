import type { ContainerSize, OrchestratorProvider } from './types';

// The CONTAINER RATE TABLE (Story MOTIR-1916 · MOTIR-1921) —
// `docs/decisions/ci-runner-fleet.md` §4's third rule on the port:
//
//   > The per-second rate is NOT a constant in the adapter. It comes from an
//   > effective-dated `(provider, size, region, effectiveFrom) → usdPerSecond`
//   > table mirroring `lib/ciMetering/runnerRates.ts` — so a Fly price change is
//   > a NEW ROW, never a code edit.
//
// It deliberately mirrors `runnerRates.ts` in shape, dating and prose, because
// the two answer the same question one level apart: that one prices what the
// CUSTOMER is charged, this one prices what MOTIR PAYS. Keeping them the same
// shape is what lets MOTIR-1924's margin readout subtract one from the other
// without a translation layer.
//
// ⚠️ WHY A PURE MODULE AND NOT A DB TABLE, and why that is not a shortcut. This
// is the same trade `runnerRates.ts` states: the rate must resolve at TEARDOWN,
// inside the same unit of work that guarantees the container is destroyed, and a
// database read on that path is one more thing that can fail between "the
// container is gone" and "we know what it cost". The resolver's signature IS the
// table's read signature, so promoting these rows to a table later is mechanical
// and changes no call site.
//
// ⚠️ THAT PROMOTION IS STILL OPEN, and MOTIR-1924 is not it. That card persists
// the RESULT — the resolved `usdPerSecond` and `rateEffectiveFrom` are stored on
// every `ci_container_usage` row, so which rate was applied is a queryable fact
// and history can never be re-priced by editing this file. What it deliberately
// did NOT do is move the rates themselves into the database: the teardown-path
// argument above is unchanged by having a table to write to.
//
// ⚠️ EFFECTIVE-DATED, NEVER EDITED IN PLACE. A Fly repricing appends a row with
// a later `effectiveFrom`; a container that ran before it keeps the rate it was
// costed at. History never silently re-prices — the property §5's reconciliation
// depends on to be an audit rather than a comparison of two estimates.

/**
 * One effective-dated per-second price for a (provider, size, region) triple.
 *
 * `usdPerSecond` is a DECIMAL STRING, never a number. §5 requires it, and the
 * reason is that these are ~3×10⁻⁵ figures multiplied by up to five-digit second
 * counts: in binary floating point the rounding is invisible per row and
 * systematic across a month, which is the shape of error a reconciliation is
 * least able to catch.
 */
export interface ContainerRate {
  readonly provider: OrchestratorProvider;
  readonly cpuKind: ContainerSize['cpuKind'];
  readonly cpus: number;
  readonly memoryMb: number;
  readonly region: string;
  readonly usdPerSecond: string;
  readonly effectiveFrom: Date;
  /** The vendor page the figure came from, so the arithmetic is auditable
   *  without re-reading the ADR (`notes.html` #88: a vendor-direct price, never
   *  a category estimate or an aggregator). */
  readonly source: string;
}

/** When the fleet's rates take effect — the day the fleet's own card landed.
 *  Per §3.3's convention nothing real predates it; a container that somehow did
 *  resolves to no rate and is recorded unpriced-and-logged, which is the safe
 *  direction (it under-reports Motir's cost rather than inventing one). */
const FLEET_PRICED_FROM = new Date('2026-08-01T00:00:00.000Z');

/** When the AWS row takes effect — the day it was read and the adapter landed. */
const AWS_PRICED_FROM = new Date('2026-10-24T00:00:00.000Z');

/**
 * Additional RAM, per second, per the 4 GB the fleet runner adds on top of
 * `performance-2x`'s included 4 GB to reach §M's 8 GB.
 *
 * Fly: "about $5 per 30 days per GB of additional RAM". 4 GB × $5 = $20 per 30
 * days; 30 days is 2,592,000 s; $20 / 2,592,000 s = $0.0000077160493827/s. It is
 * folded into each row's `usdPerSecond` rather than kept as a separate addend
 * because what the meter needs is ONE price for the machine class as actually
 * provisioned — a two-part rate is a second thing to get wrong at every call
 * site, and the components are recorded here in prose where they are auditable.
 */
const EXTRA_RAM_USD_PER_SECOND = '0.000007716049';

/**
 * The fleet's machine class (§M / §8): 2 dedicated vCPU, 8 GB — GitHub's
 * `ubuntu-latest` on a PRIVATE repository, which is what ×1.00 promises parity
 * with.
 */
export const FLEET_CONTAINER_SIZE: ContainerSize = {
  cpuKind: 'performance',
  cpus: 2,
  memoryMb: 8192,
};

/**
 * The rate table.
 *
 * ⚠️ FLY'S COMPUTE PRICE VARIES BY REGION, and the ADR's §8 figures are
 * AMSTERDAM. Verified against Fly's own pricing page on 2026-08-02:
 * `performance-2x` is **$0.00002392/s in `iad`** and **$0.00002484/s in `ams`**.
 * §8 flags this explicitly — "a per-region ratio applies and MOTIR-1924 must
 * read the `iad` row from the same table" — and §11 fixes the fleet in `iad`,
 * co-located with Neon and `motir-core`. Both rows ship so the difference is a
 * DATUM rather than a caveat, and so a second region is a new row rather than an
 * arithmetic exercise.
 *
 * Reproducing §8's Amsterdam figure from these components is the check that the
 * method is right: $0.000032556049/s × 60 = **$0.00195336/min**, which is §8's
 * "≈ $0.00195 / min" exactly. The `iad` row the fleet actually runs on is
 * $0.000031636049/s × 60 = **$0.00189816/min**.
 */
export const CONTAINER_RATES: readonly ContainerRate[] = [
  {
    provider: 'fly',
    cpuKind: 'performance',
    cpus: 2,
    memoryMb: 8192,
    region: 'iad',
    // $0.00002392 (performance-2x, iad) + $0.000007716049 (4 GB extra RAM)
    usdPerSecond: '0.000031636049',
    effectiveFrom: FLEET_PRICED_FROM,
    source: 'https://fly.io/docs/about/pricing/ (read 2026-08-02)',
  },
  {
    provider: 'fly',
    cpuKind: 'performance',
    cpus: 2,
    memoryMb: 8192,
    region: 'ams',
    // $0.00002484 (performance-2x, ams — the ADR §8 figure) + extra RAM
    usdPerSecond: '0.000032556049',
    effectiveFrom: FLEET_PRICED_FROM,
    source: 'https://fly.io/docs/about/pricing/ (read 2026-08-02)',
  },
  {
    // AWS (MOTIR-9276): one runner VM in us-east-1, as the adapter launches it —
    // the instance, its two gp3 volumes (the AMI's 30 GB root and the 20 GB Docker
    // disk, both DeleteOnTermination) and its hourly public IPv4 address. Read
    // from AWS's own price files on 2026-10-24:
    //   m6i.large, Linux, on-demand        $0.096/h      → $0.000026666667/s
    //   gp3 storage $0.08/GB-month × 50 GB  (730 h month) → $0.000001522070/s
    //   in-use public IPv4                 $0.005/h      → $0.000001388889/s
    // gp3's baseline 3,000 IOPS / 125 MB/s is free and the fleet provisions no
    // more. A Docker disk sized other than 20 GB is a new row, not a code edit.
    provider: 'aws',
    cpuKind: 'performance',
    cpus: 2,
    memoryMb: 8192,
    region: 'us-east-1',
    usdPerSecond: '0.000029577626',
    effectiveFrom: AWS_PRICED_FROM,
    source:
      'https://aws.amazon.com/ec2/pricing/on-demand/ (m6i.large, us-east-1), ' +
      'https://aws.amazon.com/ebs/pricing/ (gp3), https://aws.amazon.com/vpc/pricing/ ' +
      '(public IPv4) — read 2026-10-24',
  },
  {
    // The FAKE adapter prices at the `iad` row it stands in for, so a test drives
    // the SAME priced path production does. It is not a commercial figure and
    // nothing bills against it; without it the fake would exercise only the
    // unpriced fallback, and the one branch MOTIR-1927 most needs to drive —
    // "teardown produced a costed row" — would never run outside production.
    provider: 'fake',
    cpuKind: 'performance',
    cpus: 2,
    memoryMb: 8192,
    region: 'iad',
    usdPerSecond: '0.000031636049',
    effectiveFrom: FLEET_PRICED_FROM,
    source: 'mirrors the fly/iad row; test-only, never billed',
  },
];

/**
 * The rate in force for a machine class in a region at instant `at` — the latest
 * row whose `effectiveFrom <= at`.
 *
 * Returns NULL when the triple is unpriced or the instant predates every row.
 * A null is not swallowed: the caller records the usage with a zero rate AND
 * logs, exactly as `multiplierForLabels`' `priced: false` does one domain over.
 * Under-reporting Motir's own cost is the safe direction — it never over-bills
 * anyone — and the log line is the signal to add a row.
 *
 * ⚠️ `table` EXISTS SO THE LATEST-WINS RULE IS TESTABLE, and that is not a
 * convenience. §3.3's whole promise — "a repricing is a NEW ROW, never a
 * backfill" — lives in the one comparison below, and with a single row per key
 * shipped today that comparison can never run: the rule would be unproven until
 * the first real repricing, which is the worst possible moment to discover it is
 * wrong. Production callers pass nothing and get {@link CONTAINER_RATES}.
 */
export function resolveContainerRate(
  provider: OrchestratorProvider,
  size: ContainerSize,
  region: string,
  at: Date,
  table: readonly ContainerRate[] = CONTAINER_RATES,
): ContainerRate | null {
  const wantedRegion = region.trim().toLowerCase();
  let best: ContainerRate | null = null;
  for (const rate of table) {
    if (rate.provider !== provider) continue;
    if (rate.cpuKind !== size.cpuKind) continue;
    if (rate.cpus !== size.cpus) continue;
    if (rate.memoryMb !== size.memoryMb) continue;
    if (rate.region !== wantedRegion) continue;
    if (rate.effectiveFrom.getTime() > at.getTime()) continue;
    if (best === null || rate.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = rate;
  }
  return best;
}

/** The rate applied when no row covers the container — recorded so a usage row
 *  always has a value in the column, and always distinguishable from a real
 *  zero-second row by `rateEffectiveFrom === null`. */
export const UNPRICED_USD_PER_SECOND = '0';

export { EXTRA_RAM_USD_PER_SECOND };
