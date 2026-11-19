// The runner-normalization policy for the CI-minutes meter (Story MOTIR-1775 ·
// MOTIR-1896), implementing `docs/decisions/ci-minutes-allowance.md` §3.
//
// The pool is denominated in LINEAR-EQUIVALENT minutes:
//
//     linear_equivalent = raw_billable_minutes × multiplier(runner)
//
// and the multiplier is — for every GitHub-hosted row — a PRICE RATIO: the
// runner's own per-minute price
// divided by the Linux 2-core x64 price (the numéraire) — NOT GitHub's
// `Linux ×1 / Windows ×2 / macOS ×10` included-minutes drain multipliers. ADR
// §3.2 is explicit that those are a marketing allotment device rather than a
// cost signal: adopting them would overcharge Windows by 20% (×2 implies
// $0.012 against a real $0.010) and undercharge macOS by 3% (×10 implies
// $0.060 against a real $0.062). This is the shipped `ModelCreditRate` rule one
// domain over — Motir already prices AI cost-plus from each provider's own
// price, and `notes.html` #88 is the recorded lesson from taking a rate off a
// secondary catalog instead of the vendor's own page.
//
// ⚠️ ONE row is deliberately NOT a price ratio: Motir's own runner fleet, which
// meters at ×1.00 as a PRODUCT decision (the ADR's 2026-07-31 amendment §M;
// MOTIR-1915 / MOTIR-1923). Its rationale lives on `MOTIR_FLEET_RATE` below, and
// `RateBasis` marks it in the type so the distinction survives the next edit.
//
// ⚠️ EFFECTIVE-DATED, not a bare constant (ADR §3.3). Each entry carries an
// `effectiveFrom`, and resolution takes the run's own completion timestamp — so
// a GitHub repricing is a NEW ENTRY, never a backfill, and already-metered
// history never silently re-prices. Every metered row additionally stores the
// runner label AND the multiplier it applied, so a rate change cannot rewrite
// what was already counted.
//
// WHY a pure module rather than a DB table: the ADR describes the shape as
// "a table with an `effectiveFrom`, mirroring `ModelCreditRate`'s
// `(model, effectiveFrom)` shape". This ships that SHAPE as pure config,
// deliberately, for the reason §4.5 gives for the period key — the meter must
// resolve a `workflow_run` delivery WITHOUT reading any other state, keeping the
// hot webhook path a single insert and the open-core meter free of commercial
// coupling. It also mirrors §8.4's instruction for the sibling's entitlement
// policy ("pure config + a resolver, no DB, no Stripe, no cloud check"). The
// resolver's signature is the table's read signature, so promoting this to rows
// later is mechanical and needs no call-site change.

/**
 * The runner families the ADR prices. `unknown` is the safe catch-all (§3.4).
 *
 * `motir_fleet` is Motir's OWN ephemeral self-hosted fleet (Story MOTIR-1916).
 * It is a PRICED family, not the §3.4 fallback — see `MOTIR_FLEET_RATE` below.
 */
export type RunnerFamily =
  | 'linux_x64'
  | 'linux_arm64'
  | 'windows_x64'
  | 'macos'
  | 'motir_fleet'
  | 'unknown';

/**
 * What a row's `multiplier` IS — the invariant that holds for it.
 *
 * - `cost_ratio` — the runner's own vendor price ÷ the Linux 2-core x64 price.
 *   `multiplier === usdPerMinute / <linux_x64 usdPerMinute>` holds, and
 *   `runnerRates.test.ts` asserts it for every row carrying this basis.
 * - `product_parity` — a DECIDED customer-facing rate that is deliberately NOT a
 *   ratio of its own `usdPerMinute` (ADR amendment §M.4). Only the Motir fleet
 *   carries it. Marking it in the type is what stops a future reader "fixing"
 *   the row back into a ratio and re-pricing the product by accident.
 */
export type RateBasis = 'cost_ratio' | 'product_parity';

/** One effective-dated rate for a runner family. */
export interface RunnerRate {
  family: RunnerFamily;
  /** The rate applied to this family's billable minutes at `effectiveFrom`. For
   *  a `cost_ratio` row: the runner's price ÷ the Linux 2-core x64 price. */
  multiplier: number;
  /** UTC instant this rate takes effect. A run completing before it uses the
   *  previous entry for the same family (none today — these are the first). */
  effectiveFrom: Date;
  /** The per-minute price in USD this row records. For a `cost_ratio` row it is
   *  the VENDOR price the ratio was computed from, so the arithmetic is
   *  auditable without re-reading the ADR. For the `product_parity` row it is
   *  MOTIR'S OWN cost, which the multiplier is deliberately not a ratio of. */
  usdPerMinute: number;
  /** Which of the two invariants above the row's `multiplier` satisfies. */
  basis: RateBasis;
}

/** GitHub's 2026-01-01 Actions repricing — the cut that took Linux 2-core from
 *  $0.008 to $0.006 and folded the $0.002/min platform charge into the meter
 *  rates (ADR §9). Every rate below is dated to it because that is when the
 *  prices they are ratios of took effect. */
const GITHUB_2026_REPRICING = new Date('2026-01-01T00:00:00.000Z');

/**
 * The single distinctive `runs-on` label Motir's fleet runners register with
 * (MOTIR-1916 · ADR amendment §M.2). The fleet registers with
 * `--no-default-labels` and exactly this one label, so the classification below
 * is unambiguous under EITHER reading of GitHub's `labels` field — the ADR
 * records as an honest unknown that the REST reference does not say whether it
 * reports the labels `runs-on` REQUESTED or the labels the runner CARRIES, and a
 * single-custom-label runner produces the same one-element set either way.
 * (MOTIR-1920 records which it is from the first real fleet run.)
 *
 * ⚠️ The exact string is load-bearing, and §M.2 constrains it: it must contain
 * none of `ubuntu` / `linux` / `arm` / `windows` / `macos` / `osx`, and must not
 * match the larger-runner pattern. A label containing `linux` would classify as
 * the GitHub `linux_x64` family — the numbers would come out right while the
 * attribution was silently wrong — and one containing `2-core` would take the
 * §3.4 fallback and warn on every fleet run forever. `runnerRates.test.ts`
 * asserts both constraints against the real patterns rather than by eye.
 *
 * It is exported because the provisioning path (MOTIR-1920/1921) selects on the
 * SAME label: one constant, so the meter and the provisioner cannot drift.
 */
export const MOTIR_FLEET_RUNNER_LABEL = 'motir-runner';

/**
 * The fleet's ARM64 label (Story MOTIR-11779 · MOTIR-11781): the one label a
 * Graviton fleet runner registers with, and the value `vars.MOTIR_RUNNER_ARM64`
 * carries. A SECOND fleet pool, disjoint from {@link MOTIR_FLEET_RUNNER_LABEL}:
 * an arm64 runner carries only this label and an x86 runner never carries it,
 * so GitHub can never hand an x86 job to a Graviton runner or the other way
 * round.
 *
 * ⚠️ THE SAME §M.2 CONSTRAINTS, AND THEY ARE WHY IT NAMES THE MACHINE FAMILY
 * RATHER THAN THE ARCHITECTURE. `classifyRunner` falls through to substring
 * matching once the exact fleet pre-pass misses, and `label.includes('arm')`
 * answers `linux_arm64` — so a name like `motir-runner-arm64` would be metered
 * as a GitHub-hosted arm64 minute the moment it missed the pre-pass. This value
 * contains none of `ubuntu` / `linux` / `arm` / `windows` / `macos` / `osx` and
 * does not match the larger-runner pattern; `runnerRates.test.ts` asserts both
 * against the real patterns.
 *
 * Metered as `motir_fleet` at the existing ×1.00 parity row: the default arm64
 * machine (m7g.large) is the same 2 vCPU / 8 GiB class as the x86 one, so no
 * new rate row is decided here.
 *
 * ⚠️ THE ONE LITERAL. `lib/ciFleet/config.ts` re-exports it as
 * `MOTIR_ARM64_RUNNER_LABEL` (the MOTIR-1964 alias pattern), and every other
 * module imports that name — the meter and the provisioner cannot drift.
 */
export const MOTIR_FLEET_ARM64_RUNNER_LABEL = 'motir-graviton';

/** Both fleet labels, lower-case — the set the exact pre-pass compares against. */
const MOTIR_FLEET_LABELS: ReadonlySet<string> = new Set([
  MOTIR_FLEET_RUNNER_LABEL,
  MOTIR_FLEET_ARM64_RUNNER_LABEL,
]);

/**
 * The FAMILY name a fleet job's metered minutes are stored under, in the
 * `runner_breakdown` JSON every metered row carries (§3.3).
 *
 * Exported for the same reason the label is: MOTIR-1924's reconciliation splits
 * a month's metered minutes by this exact string in SQL (`entry->>'family'`),
 * and a query comparing against its own copy of `'motir_fleet'` would keep
 * agreeing with `classifyRunner` right up until one of them was edited — after
 * which fleet minutes would silently rejoin the GitHub-billed population and the
 * phantom drift §Q exists to remove would come back, unexplained. One constant,
 * two readers, no drift (the MOTIR-1964 lesson, applied before the fact).
 */
export const MOTIR_FLEET_RUNNER_FAMILY: RunnerFamily = 'motir_fleet';

/** When the fleet's rate takes effect — the day the row landed (MOTIR-1923).
 *  Per §3.3 this is a NEW ROW, never a backfill: a run that completed before it
 *  keeps whatever it was already metered at, and history never re-prices. The
 *  fleet does not exist before this instant, so nothing real predates it; a job
 *  that somehow did takes the §3.4 fallback (×1.00 + a warning), which is the
 *  safe direction. */
const MOTIR_FLEET_PRICED_FROM = new Date('2026-08-01T00:00:00.000Z');

/**
 * The Motir fleet's rate (MOTIR-1923, implementing the ADR's 2026-07-31
 * amendment §M) — effective-dated like every other row, and ×1.00.
 *
 * ⚠️ **THE ×1.00 IS A PRODUCT DECISION, NOT A COST RATIO — do not "fix" it into
 * one.** Every other row in this table is a price ratio against the Linux 2-core
 * numéraire (§3.1). This one is not, and that is deliberate:
 *
 * - The fleet's real cost to Motir is roughly **$0.0005–0.001/min** on spot
 *   compute (§L) — a ~6–12× lower basis for the identical workload. Pricing the
 *   family at that true cost ratio (~×0.1) would silently hand every org ~10×
 *   more effective CI, which is a **customer-facing allowance change made in a
 *   rate table instead of in the open** (§M).
 * - The fleet's runner spec is fixed to be **Linux-2-core-EQUIVALENT**, so
 *   metering it at parity with the numéraire charges the user exactly what they
 *   were already promised. §L keeps the shipped allowance and rate untouched;
 *   the improved margin funds the fleet's own operating cost. Passing the saving
 *   on would re-open §1 with its own card — not silently, and not here.
 * - `usdPerMinute` below therefore records **MOTIR'S OWN cost, not GitHub's**,
 *   and is the one row where the price and the multiplier are deliberately not a
 *   ratio of each other (§M.4). `basis: 'product_parity'` is what says so to the
 *   type system, and it is why the ratio invariant in `runnerRates.test.ts`
 *   skips this row instead of failing on it.
 *
 * The figure is the conservative (high) end of §L's estimate — it understates
 * margin rather than overstating it — and it is an ESTIMATE until MOTIR-1924
 * meters the fleet's real container-seconds. Nothing the customer is charged
 * depends on it: it feeds margin reporting only, because `multiplier` is what
 * meters the run.
 *
 * See also: MOTIR-1915 (the decision), `docs/decisions/ci-minutes-allowance.md`
 * §L (the price is not re-opened) and §M (this family, its label, this rate).
 */
const MOTIR_FLEET_RATE: RunnerRate = {
  family: 'motir_fleet',
  multiplier: 1.0, // parity with the Linux 2-core numéraire — a PRODUCT decision (§M)
  effectiveFrom: MOTIR_FLEET_PRICED_FROM,
  usdPerMinute: 0.001, // Motir's own spot cost, NOT a ratio basis (§M.4)
  basis: 'product_parity',
};

/**
 * The effective-dated rate table (ADR §3.1). Ordered newest-last per family;
 * `resolveRunnerRate` picks the latest entry whose `effectiveFrom` is at or
 * before the run's completion. ADDING a repricing = appending an entry with the
 * new `effectiveFrom`, never editing one in place.
 */
export const RUNNER_RATES: readonly RunnerRate[] = [
  {
    family: 'linux_x64',
    multiplier: 1.0,
    effectiveFrom: GITHUB_2026_REPRICING,
    usdPerMinute: 0.006,
    basis: 'cost_ratio',
  },
  {
    family: 'linux_arm64',
    multiplier: 0.83, // $0.005 / $0.006
    effectiveFrom: GITHUB_2026_REPRICING,
    usdPerMinute: 0.005,
    basis: 'cost_ratio',
  },
  {
    family: 'windows_x64',
    multiplier: 1.67, // $0.010 / $0.006
    effectiveFrom: GITHUB_2026_REPRICING,
    usdPerMinute: 0.01,
    basis: 'cost_ratio',
  },
  {
    family: 'macos',
    multiplier: 10.33, // $0.062 / $0.006
    effectiveFrom: GITHUB_2026_REPRICING,
    usdPerMinute: 0.062,
    basis: 'cost_ratio',
  },
  MOTIR_FLEET_RATE,
];

/** The numéraire's multiplier — also the fallback for an unpriced runner (§3.4). */
export const LINUX_EQUIVALENT_MULTIPLIER = 1.0;

/** A larger/xlarge runner: GitHub's hosted-runner labels carry an explicit core
 *  count (`ubuntu-latest-4-core`, `windows-latest-8-core`) or an `xlarge` size,
 *  and those bill at HIGHER per-minute prices the ADR does not price. They are
 *  deliberately classified `unknown` rather than folded into the 2-core rate —
 *  see `classifyRunner`. */
const LARGER_RUNNER = /(^|-)(\d+-?core|xlarge|large)(-|$)/i;

/**
 * Classify a job's runner from its GitHub `labels` (and, as a weaker hint, its
 * `runner_name`). PURE.
 *
 * The ADR prices the four standard 2-core hosted runners, plus Motir's own fleet
 * (§M). Anything else — a larger hosted runner, someone else's self-hosted
 * label, a future OS — is `unknown`, which
 * §3.4 meters at ×1.00 and LOGS: under-counting a runner Motir has not priced is
 * the safe direction (it never over-bills a user for a rate nobody decided), and
 * the log entry is the signal to add a rate.
 *
 * Note the larger-runner check runs BEFORE the OS match on purpose: an
 * `ubuntu-latest-4-core` job is Linux, but it is NOT the Linux the ×1.00 rate
 * prices, and silently charging it as one would be a priced guess.
 *
 * The MOTIR FLEET is matched first of all — either of its two labels, the x86
 * one or the arm64 one (MOTIR-11781) — and by EXACT label rather than by
 * substring (§M.3). Exact is the safe direction twice over: a near-miss variant
 * like `motir-runner-large` is NOT the 2-core-equivalent spec the ×1.00 parity
 * rate was decided for, so it correctly falls through to `unknown` and warns
 * instead of silently borrowing the fleet's rate. The scan is a PRE-PASS over
 * the whole label set rather than a branch inside the loop, so a job whose set
 * also carries an OS label still attributes to the fleet — the family is what
 * §3.3's stored breakdown reports, and a fleet run must never be recorded as
 * GitHub-hosted Linux (the "numbers right, attribution wrong" failure §M names).
 */
export function classifyRunner(labels: readonly string[]): RunnerFamily {
  for (const raw of labels) {
    if (MOTIR_FLEET_LABELS.has(raw.trim().toLowerCase())) return 'motir_fleet';
  }
  for (const raw of labels) {
    const label = raw.trim().toLowerCase();
    if (label.length === 0) continue;
    if (LARGER_RUNNER.test(label)) return 'unknown';
    if (label.includes('macos') || label.includes('osx')) return 'macos';
    if (label.includes('windows')) return 'windows_x64';
    if (label.includes('arm')) return 'linux_arm64';
    if (label.includes('ubuntu') || label.includes('linux')) return 'linux_x64';
  }
  return 'unknown';
}

/**
 * The rate in force for `family` at instant `at` — the latest entry whose
 * `effectiveFrom <= at`. Returns null when the family is unpriced (`unknown`),
 * or when the run predates every entry for it; the caller then applies
 * `LINUX_EQUIVALENT_MULTIPLIER` and logs (§3.4).
 */
export function resolveRunnerRate(family: RunnerFamily, at: Date): RunnerRate | null {
  let best: RunnerRate | null = null;
  for (const rate of RUNNER_RATES) {
    if (rate.family !== family) continue;
    if (rate.effectiveFrom.getTime() > at.getTime()) continue;
    if (best === null || rate.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = rate;
  }
  return best;
}

/** The multiplier to APPLY for a job, plus whether it fell back — the caller
 *  stores the multiplier on the metered row and logs when `priced` is false. */
export interface ResolvedMultiplier {
  family: RunnerFamily;
  multiplier: number;
  /** False when no rate covered the family at that instant (the §3.4 fallback). */
  priced: boolean;
}

/** Resolve the multiplier for a job's labels at a completion instant (§3.1/§3.4). */
export function multiplierForLabels(labels: readonly string[], at: Date): ResolvedMultiplier {
  const family = classifyRunner(labels);
  const rate = resolveRunnerRate(family, at);
  if (!rate) return { family, multiplier: LINUX_EQUIVALENT_MULTIPLIER, priced: false };
  return { family, multiplier: rate.multiplier, priced: true };
}
