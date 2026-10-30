# The per-seat CI-MINUTES allowance + credit overage

**Status:** accepted · **Date:** 2026-07-30 · **Card:** MOTIR-1898 (Story MOTIR-1775 —
establish the project's repository set at plan approval) · **Evidence pinned at:**
`motir-core` `origin/main` @ `a5ac04a2` (**includes the MOTIR-1893 ownership amendment**),
`motir-ai` `origin/main` @ `93afca4`, `nextjs-prisma-vercel-starter`
`.github/workflows/ci.yml` · **Vendor pricing + API status read 2026-07-30** (sources in §9)

**Amended:** 2026-07-30 (MOTIR-1906) — **§6 enforcement**: `ci_credits_exhausted` now
**pauses GitHub Actions** on the org's Motir-owned repositories, not only refuses the next
dispatch. §6.3's dispatch-only enforcement is **superseded in place** (kept below, marked),
§6.4's overshoot bound is **corrected**, §6.5's state machine gains an Actions column, and
**§7.3 item 5 is rewritten** to a two-option decision for an admin and an alert for a
member. See
[the amendment](#amendment-2026-07-30-motir-1906--the-refusal-is-enforced-at-the-compute-not-only-at-dispatch).
Nothing in §1–§5 or §8–§9 changes: the numbers, the rate, the normalization, the pool and
the attribution stand. The planning defect is logged as MOTIR-1909.

**Amended:** 2026-07-31 (Yue · MOTIR-1915) — **the SUBSTRATE**: project CI stops running on
GitHub-hosted runners and runs on **Motir-operated ephemeral self-hosted runners**, for
repositories in `motir-projects` only. **§1–§4 are UNCHANGED** (the allowance, the rate, the
normalization method and the pool are all denominated in Linux-equivalent minutes and are
indifferent to who owns the machine); §5 is unchanged **except §5.8's reconciliation source**,
whose text is corrected; §6–§8 are unchanged. The amendment adds a **new runner family at a
deliberate ×1.00**, a **runner-selection seam** that keeps a handed-over repo portable, and a
**second meter** for Motir's own cost. See
[the amendment](#amendment-2026-07-31-yue--motir-1915--project-ci-runs-on-motirs-own-runner-fleet).
Everything it records is BUILT by MOTIR-1916; the planning defect is logged as MOTIR-1917.

**Amended:** 2026-10-29 (MOTIR-5777) — **PREVIEW USAGE is counted in the pool.** A
Motir-hosted repository's pull-request previews are converted to Linux-equivalent minutes at
the factors the hosting decision page sets, counted in the same per-seat pool, and charged as
the existing `ci_overage` past it. **§1–§8 are unchanged**: no new ledger kind, no new rate,
no second path. See
[the amendment](#amendment-2026-10-29-motir-5777--preview-usage-is-counted-in-the-pool).

Motir hosts some of its users' repositories, so Motir pays some of their CI bill. This
record prices that: the **included allowance** every seat carries, the **rate** the
overage draws from the credit ledger, how the pool is **pooled and reset**, how minutes
are **normalized** across runner types, the **two exhaustion thresholds**, how a workflow
run is **attributed** to an org, **what the user sees**, and **which repo owns** the
entitlement.

The charging MODEL was fixed by Yue on 2026-07-30: _"we give every seat a default CI
minutes per month; when that amount is exceeded, we start charging the credits."_ This ADR
supplies the numbers and the mechanics; it does not re-open the model.

## Context

### The cost — and it applies to EVERY new project, not a subset

`docs/decisions/project-repository-set.md` §3 establishes every new project's repository
set. Private-repo Actions minutes bill to the **repository owner**, so where Motir owns
the repo, Motir pays for the CI — from the first `motir run` onward, because every
dispatch ends in a PR and every PR runs CI. That is why this is not an Epic 9 concern: it
starts the day the pre-Epic-9 loop works.

**The 2026-07-30 amendment (Yue · MOTIR-1893) makes that universal.** _"Every repository
Motir CREATES for a new project is created under Motir's own organization, for both
audiences, with no branch on what the user has."_ The earlier §3.1/§3.2 branch — repos in
the user's account when a GitHub identity is connected — is **superseded**. So the metered
population is **every newly created project repository**, and the amendment says so in its
own standing-consequences note: _"Every new project's repositories live there, so their
Actions minutes and storage bill to Motir."_

Only two paths reach a repo Motir does **not** pay for, and both are exits rather than
alternatives:

| Path                                        | Repo lives in      | Who GitHub bills | Metered here |
| ------------------------------------------- | ------------------ | ---------------- | ------------ |
| **Created** for a new project (the default) | **Motir's org**    | **Motir**        | **yes**      |
| **Connect-existing** (code the user has)    | the user's account | the user         | no           |
| **After the 9.3.7 handoff** (MOTIR-711)     | the user's account | the user         | no           |

This is the full exposure, not a fraction of it: **every org that dispatches drains the
pool.** §1's numbers are set against that, and §1.5 states the risk it creates rather than
discounting it.

The hosting org is a **GitHub** org (MOTIR-1779, working login `motir-projects`), created
through `POST /orgs/{org}/repos` with an org-scoped provisioning App. **Motir never creates
a GitLab repository** — GitLab is reachable only through connect-existing, i.e. a namespace
the user already owns and GitLab already bills them for. §5.5 records what follows for the
meter.

### What one dispatch actually costs — derived from the starter's own CI

The metered workload is **the seeded starter's** CI, not `motir-core`'s (a sharded E2E
matrix that no user project runs). `nextjs-prisma-vercel-starter/.github/workflows/ci.yml`
is four jobs, all `ubuntu-latest`, plus a cleanup workflow on PR close:

| Job                           | What it runs                                                        | Est. min |
| ----------------------------- | ------------------------------------------------------------------- | -------- |
| `lint`                        | install → `lint` → `format:check`                                   | ~3       |
| `typecheck`                   | install → `prisma generate` → `typecheck`                           | ~3       |
| `build`                       | install → generate → `migrate deploy` → `next build` (+ PG service) | ~5       |
| `e2e` (`needs: build`)        | install → generate → migrate → `playwright install` → `test:e2e`    | ~8       |
| `cleanup-preview-deployments` | one short job, on PR close                                          | ~1       |

**The suite runs TWICE per merged dispatch.** The workflow triggers on
`pull_request` **and** `push: branches: [main]`, and the two are separate concurrency
groups — so the four jobs bill once on the PR and again on the merge commit. GitHub bills
**per job, rounded up to the minute**, and jobs bill in parallel by wall clock, so the
figure is the sum of the jobs, not the critical path:

```
(3 + 3 + 5 + 8) × 2 suites + 1 cleanup  ≈  39 Linux minutes per merged dispatch
```

**~35–40 minutes per dispatch, and that is a FLOOR** — every fix-up commit pushed to the
PR branch re-runs the PR suite (the `cancel-in-progress` concurrency group keeps it to one
live run per push, not one per dispatch), and a CI failure the agent has to chase
multiplies it.

MOTIR-1898's own calibration said _"~20 minutes ≈ one dispatch"_. That counts the PR run
only and misses the merge-to-`main` re-run and the cleanup job. **The planning figure this
ADR uses is ~39 minutes**, and it is an estimate from the workflow's shape, not a
measurement — MOTIR-1896's meter is what produces the real number, and §1.4 names the
trigger to re-derive from it.

### The three prices this is set against (verified at source, §9)

| Fact                              | Value                                         |
| --------------------------------- | --------------------------------------------- |
| A Motir seat                      | **$5/mo**, $40/yr (`lib/billing/catalog.ts`)  |
| A Motir credit, retail            | **~$0.01** (top-up: 1,000 credits for $10)    |
| A Linux 2-core x64 Actions minute | **$0.006** (GitHub, since the 2026-01-01 cut) |

## Decision

### §1 — 300 included Linux-equivalent minutes per seat per month, with a 1,000-minute per-org floor

**The pool for an org, evaluated at read time:**

```
pool(org) = max( members × 300 , 1000 )   Linux-equivalent minutes, per calendar month
```

**1.1 · Why 300 per seat.** At full drain it costs Motir **300 × $0.006 = $1.80 per seat
per month**, and it buys **~7–8 dispatches per person per month** at the §Context figure
of ~39 min per merged dispatch.

Measured against revenue three ways, because the seat line alone is the wrong denominator:

| Org                            | Pool            | Cost at full drain | Revenue            | % of revenue |
| ------------------------------ | --------------- | ------------------ | ------------------ | ------------ |
| Per seat, monthly cadence      | 300             | $1.80              | $5.00 seat         | **36%**      |
| Per seat, annual cadence       | 300             | $1.80              | $3.33 seat (¹⁄₁₂)  | **54%**      |
| Solo, Standard AI (seat incl.) | 1,000 _(floor)_ | $6.00              | $25.00             | **24%**      |
| 5-person team, Standard AI     | 1,500           | $9.00              | $45.00 ($25+4×$5)  | **20%**      |
| 8-person team, Pro AI          | 2,400           | $14.40             | $110.00 ($75+7×$5) | **13%**      |

**The seat fee is not the right denominator, and this is the load-bearing argument.** CI
minutes are generated by _dispatches_, a dispatch requires a _plan_, and planning burns
_credits_ — so **an org that consumes this pool necessarily holds a paid AI plan.** Per
`billing-tiering.md` §1 a paid AI plan even bundles the first seat, so the solo case has
$25 of AI revenue and $0 of seat revenue: reading the allowance against the $5 seat line
alone would price it against revenue that org does not pay. Against total ①+② revenue the
worst case is **13–24%**, and the 36%/54% seat-only rows are the honest ceiling for the
one shape that pays seats without AI — a tracker-only org, which by construction dispatches
nothing and drains nothing.

**These rows are the LIVE case, not a remote ceiling** — see §1.5. Since MOTIR-1893 every
created repo is Motir-owned, so there is no subset of projects that quietly costs nothing.

**1.2 · Why a 1,000-minute per-org floor, and why 1,000.** A pure `seats × 300` pool
starves exactly the user this hosting model exists for — the solo founder whose whole
project lives in Motir's org and who has no second machine to run CI on. At 300 minutes a
solo user gets ~7 dispatches a month; the product's own loop is not usable at that rate.

The floor binds for orgs of **1–3 members** (3 × 300 = 900 < 1,000); a 4-person org
(1,200) clears it. At full drain it costs **$6.00/org/month**, 24% of the $25 Standard AI
plan such an org holds.

**1.3 · Where that sits against the mirrors — Motir is deliberately below both.**

| Product                   | Included compute, private repos | Priced at              |
| ------------------------- | ------------------------------- | ---------------------- |
| GitLab Free               | 400 / namespace / mo            | $0                     |
| **Motir (floor)**         | **1,000 / org / mo**            | the AI plan it implies |
| GitHub Free               | 2,000 / account / mo            | $0                     |
| GitHub Team               | 3,000 / org / mo                | $4 / user / mo         |
| **Motir (4-person team)** | **1,200 / org / mo**            | $25 AI + 3 × $5        |
| GitLab Premium            | 10,000 / namespace / mo         | $29 / user / mo        |

Both mirrors pool **flat per account, not per seat**, and both are more generous than
Motir at small sizes. That is a deliberate deviation on both axes, and the reasoning is
not "we are cheaper":

- **Per-seat, not flat**, because here CI is generated by _people dispatching agents_. A
  hand-written commit's CI does not scale with headcount the way an agent loop's does, so a
  flat pool that is right for a 2-person team is a blank cheque for a 20-person one.
- **Smaller than GitHub/GitLab**, because they are compute vendors selling a DevOps
  platform, for whom included minutes are a loss-leader on their own infrastructure. Motir
  **resells GitHub's compute** — the same $0.006 GitHub charges it — so a 3,000-minute
  giveaway is $18/org/month of pure pass-through cost against a $5 seat. The floor exists
  so the solo case is not starved, not to match a compute vendor's marketing allotment.

**1.4 · The number does NOT vary by tier or cadence.** One figure for `free` / `standard`
/ `pro` / `max` / `enterprise`, monthly and annual alike. A tier-varying CI pool would add
a fourth entitlement axis (AI tier × seat count × CI minutes) whose only function would be
price discrimination on a cost Motir passes through near-cost. **Revisit trigger, named so
it is recognisable:** measured consumption showing a tier's median org routinely past its
pool while a cheaper tier's sits under half — i.e. the pool tracking plan size in practice.
That is a datum MOTIR-1896's meter produces; it is not guessable now.

**1.5 · The risk this number carries, stated rather than discounted.** Because MOTIR-1893
made every created repo Motir-owned, **§1.1's table is the expected case, not a tail
case** — there is no population of self-hosted-by-the-user projects diluting it. Two
things bound the exposure, and neither is a guess:

- **A tracker-only org drains nothing.** Consuming the pool requires dispatches, which
  require a plan, which burns credits — so the 36%/54% seat-only rows describe an org that
  by construction generates no CI at all. The orgs that DO drain are the ones paying $25–$150
  of AI, where the ratio is 13–24%.
- **The credit gate is the backstop.** An org cannot dispatch indefinitely on an empty
  balance: §6.2 refuses at zero, so unbounded consumption is not reachable even in the worst
  case.

What is genuinely unknown is the **utilisation rate** — what fraction of the pool a typical
org actually burns. Every figure above is full-drain, and full drain is unlikely; but the
honest position is that Motir does not know the real number yet. **The first month of
MOTIR-1896's meter is the check**, and §1.4's revisit trigger is how the 300 gets corrected
if it is wrong. Nothing here should be read as "this is safe" — it is "this is bounded, and
measured shortly."

### §2 — 1 credit = 1 Linux-equivalent minute

**2.1 · The rate.** Overage converts at **1 credit per Linux-equivalent minute**.

**2.2 · The margin, stated rather than buried in a constant.** At the $10/1,000 top-up a
credit retails at **$0.01**; a Linux-equivalent minute costs **$0.006**. That is a **40%
gross margin** on overage. It also lands at **exactly GitLab's published extra-compute
price** ($10 per 1,000 minutes), so the overage is at market rather than above it.

**2.3 · A single blended number is correct — because normalization already happened.** The
rate is not per-runner-type, and that is safe only because the **meter** converts every
runner to Linux-equivalents first (§3). A blended rate over _raw wall clock_ would be a
lie — one macOS minute costs 10.33× a Linux one — but a single rate over a
cost-normalized unit is exactly right, and it gives the user one number to hold: **a
minute is a credit.**

### §3 — Normalize by COST, using GitHub's real per-minute prices — not its included-minutes multipliers

**3.1 · The pool is denominated in Linux-equivalent minutes**, defined as
`raw_wall_clock_minutes × multiplier(runner)`, where the multiplier is the runner's price
divided by the Linux 2-core x64 price:

| Runner             | GitHub price / min | Multiplier | Source basis    |
| ------------------ | ------------------ | ---------- | --------------- |
| Linux 2-core x64   | $0.006             | **×1.00**  | the numéraire   |
| Linux 2-core arm64 | $0.005             | **×0.83**  | $0.005 / $0.006 |
| Windows 2-core x64 | $0.010             | **×1.67**  | $0.010 / $0.006 |
| macOS 3/4-core     | $0.062             | **×10.33** | $0.062 / $0.006 |
| **Motir fleet**    | ~$0.001 (Motir's)  | **×1.00**  | **not a ratio** |

> ⚠️ The **Motir fleet** row is the one entry whose multiplier is a **product
> decision, not a cost ratio** — parity with the numéraire, because the fleet's spec is
> Linux-2-core-equivalent. Its price column records **Motir's own cost**, which the
> multiplier is deliberately not a ratio of. Full rationale in the amendment's **§M**; the
> row ships in `lib/ciMetering/runnerRates.ts` (MOTIR-1923) carrying `basis: 'product_parity'`
> so the distinction is machine-checked rather than remembered.

**3.2 · GitHub's own `Linux ×1 / Windows ×2 / macOS ×10` multipliers are the WRONG basis,
and MOTIR-1898's recommendation to adopt them was mistaken.** Those are the rates at which
a plan's _included_ minutes drain — a marketing allotment device — not a cost signal, and
they do not match what GitHub actually charges. Adopting them would **overcharge Windows by
20%** (×2 implies $0.012 against a real $0.010) and **undercharge macOS by 3%** (×10
implies $0.060 against a real $0.062).

This is the shipped `ModelCreditRate` rule one domain over: Motir already prices AI
cost-plus from each provider's own price (`credits = tokens × per-1k-rate × margin`), and
`notes.html` #88 is the recorded lesson from taking a rate off a secondary catalog instead
of the provider's own page. CI follows the same rule — **the multiplier is a price ratio,
sourced from the vendor's own pricing page.**

**3.3 · Multipliers are effective-DATED policy, not a hardcoded constant.** They live in a
table with an `effectiveFrom`, mirroring `ModelCreditRate`'s `(model, effectiveFrom)`
shape, and each metered row **stores the raw wall clock, the runner label, and the
multiplier it applied**. A GitHub repricing is then a new row, never a backfill, and
already-charged history never silently re-prices. (This is MOTIR-1896's "keep the raw
wall-clock alongside" requirement, and this section is why.)

**3.4 · An unknown runner label meters at ×1.00 and is logged.** Under-counting a runner
Motir has not priced is the safe direction — it never over-bills a user for a rate nobody
decided. The log entry is the signal to add the row.

> ⚠️ **EXTENDED by the 2026-07-31 amendment (MOTIR-1915) — the Motir fleet is a PRICED
> family at ×1.00, which is not the same thing as this fallback.** §3.4's ×1.00 means _"no
> row exists yet"_ and logs; the fleet's ×1.00 is a **decided product rate** and must not
> log. The distinction, the family's classification rule, and why the fleet is NOT priced at
> its cost ratio are **§M** of the amendment; the row itself is MOTIR-1923's.

### §4 — The pool is org-level, derived from membership, and resets on the calendar month

**4.1 · Pooled at the ORG, never per member.** Credits are org-level (`AiOrganization` —
one balance, one tier per org) and seats are counted org-wide, so a per-member pool would
be the only per-member quantity in the billing model, and would strand minutes on the
members who did not dispatch.

**4.2 · The seat count is the ORG MEMBERSHIP COUNT, not the Stripe quantity.** The shipped
seat sync (`lib/billing/seatSync.ts`, `lib/jobs/definitions/billingSeatSync.ts`) is an
**absolute recompute of membership pushed TO Stripe** — membership is upstream, the Stripe
quantity is a lagging mirror of it, and its enqueue is explicitly best-effort and
droppable. Deriving the pool from the mirror would make it lag a lagging copy of a number
motir-core holds directly.

**4.3 · An org with no scaled-tracker subscription still gets a pool** —
`max(members × 300, 1000)`, the same formula. Two reasons: the floor dominates for the
small orgs this describes anyway, and a free-tracker org can hold a paid AI plan
(`billing-tiering.md` §1: _"a free-tracker org can buy AI"_), so a subscription-gated pool
would refuse dispatches to a paying AI customer. **The free-AI-tier org is bounded by the
credit gate, not by the pool**: at ~39 minutes a dispatch (Context, above) the 1,000-minute
floor takes about 26 merged dispatches, and the 300 one-time credits must pay for every one
of them, so the pool is reachable only if a dispatch costs under about 11 credits. Planning
a single card alone costs several times that, so the free org cannot generate enough
dispatches to approach 1,000 minutes, and at balance ≤ 0 §6 refuses the next dispatch
regardless.

_Re-checked 2026-10-13 (MOTIR-8349) against the Motir AI planning lane's multiplier from
MOTIR-7579 (0.261, effective 2026-10-12): the conclusion still holds._ Cheaper planning
raises how many cards 300 credits plan, but the argument above does not count planning
passes: it rests on the credits one dispatch costs against the minutes one dispatch burns,
and the measured planning cost per card (`motir-meta` `margin-analysis.md` §13.0) is still
several times the ~11-credit line. This section states no credits-to-passes conversion on
purpose: it moves with every rate change and every planner model. Re-check it when the
free allotment changes, or when the credits a dispatch costs fall to about 11.

**4.4 · The META org (`Organization.isMeta`) is bypassed entirely** — no pool accounting,
no overage, no refusal. It mirrors the shipped credit-gate bypass (`AiOrganization.isMeta`
→ `assertHasCredits` treats it as always-funded) and the `meta` PM tier that lifts every
cap. moooon B.V. pays its own GitHub bill directly; metering it would bill the house to
itself.

**4.5 · The reset boundary is the CALENDAR MONTH in UTC** — `date_trunc('month', at AT
TIME ZONE 'UTC')`. MOTIR-1898 recommended the seat subscription's period
(`SeatSummaryDTO.currentPeriodEnd`); that is rejected on three grounds:

1. **It is undefined for a large share of the population.** `currentPeriodEnd` exists only
   for an org with an ACTIVE scaled-tracker subscription. §4.3 gives free/unscaled orgs a
   pool, so a subscription-derived boundary has no value to use for exactly the orgs the
   floor was written for.
2. **It couples the meter to billing state.** A calendar month is a pure function of the
   run's timestamp, so MOTIR-1896 can key a metering row **without reading any subscription
   at all** — which keeps an open-core meter free of commercial coupling and makes the
   `workflow_run` write a single insert. A Stripe-period key would require resolving a
   subscription on every webhook delivery.
3. **A moving period needs backfills.** A plan change or proration shifts
   `currentPeriodEnd`, which would re-bucket already-written consumption rows. A calendar
   month never moves.

The cost of this choice, stated: the CI line's reset date will not match the seat line's
renewal date on the billing panel. §7 requires the panel to show it explicitly rather than
let the user assume they coincide.

**4.6 · Mid-period seat changes: absolute recompute, no proration, and no back-billing.**
The pool is **evaluated at read time from current membership** — never accrued, never
prorated — following the shipped seat sync's absolute-recompute model exactly. Two
consequences, both deliberate:

- A member **added** on day 20 adds a **whole month** of pool (300 minutes) for the
  remainder of that month. This is generous, bounded at $1.80, and it is the same
  direction the shipped seat sync errs.
- A member **removed** shrinks the pool immediately, which can leave a period retroactively
  over a pool it was under when the minutes were consumed. **This never back-bills.**
  Overage is charged **incrementally as it is consumed** — the charge is computed against
  the pool as it stood when the minutes were metered — and an already-charged minute is
  never re-charged, so a shrink cannot produce a surprise bill for compute that was free
  when it ran. (Binding on MOTIR-1901: charge on the metering event, not by re-summing the
  period.)

### §5 — Attribution: meter a run iff MOTIR'S ORG owns the repository

**5.1 · The predicate keys on the REPOSITORY OWNER, not on a project column.** A completed
workflow run is metered **if and only if its repository's owner login is Motir's
provisioning org** (`GITHUB_FALLBACK_ORG`, MOTIR-1779). Everything else is a no-op — not an
error, not a zero-credit debit, simply not metered.

The owner login is the right key because **it is exactly what GitHub bills on**: private-repo
Actions minutes bill to the repository owner, so "does Motir pay for this run?" and "is the
owner Motir's org?" are the same question. `Project.repoSetOwnership` is a good
_reporting_ signal but the wrong _gate_ — it is SET-level on `Project`, so it cannot
express a set containing both a created row and a connect-existing row, and it would drift
from reality on any path that moves a repo without updating the column. Reading the owner
cannot drift, because it is the billing fact itself.

**5.2 · The chain**, every hop verified in shipped schema. The gate is at the top; the rest
resolves WHOM to charge:

```
workflow_run (owner/name)   ── gate: owner == GITHUB_FALLBACK_ORG  (Motir pays)
  → GithubRepo            (the mirror; owner/name is the identity GitHub reports)
  → ProjectRepo           (via githubRepoId @unique — at most one project row per repo)
  → Project               (projectId)
  → Workspace             (workspaceId)
  → Organization          (organizationId)  ── the pool + the ledger are keyed here
```

`resolveTenantOrg` already performs the last two hops and returns `{ organizationId,
isMeta }`; §4.4's bypass reads the same flag.

**5.3 · Since MOTIR-1893 the gate passes for every CREATED repo.** The amendment removed
the what-the-user-has branch, so a newly created project repository is always in Motir's
org and always metered. The predicate is unchanged by that — it just stops being selective,
which is the §1.5 risk.

**5.4 · The edge cases, each decided:**

| Situation                                            | Behaviour                                                                                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connect-existing** repo (the user's own account)   | **Not metered** — the owner is not Motir's org, and GitHub bills the user directly. Charging would bill for compute Motir never bought.                                                       |
| Repo in the installation belonging to **no project** | **Not metered.** A repo connected only for code-graph is in the user's account.                                                                                                               |
| Repo in Motir's org whose **project was deleted**    | **Metered as a cost, charged to nobody, and LOGGED.** Motir is still billed by GitHub, but the chain resolves no org. The log is the signal — silence here would hide real spend.             |
| Repo **transferred** to the user (MOTIR-711 / 9.3.7) | **Metering STOPS at the transfer**, because the owner login changes at the transfer itself. §5.5 is the one edge that needs care. Minutes metered before it stay attributed and stay charged. |
| A **GitLab** project's pipelines                     | **Never metered** — Motir creates no GitLab repos (§Context); a connected GitLab namespace is the user's and GitLab bills them. §5.6.                                                         |
| Run reported **twice**                               | **Counted once** — idempotent on the GitHub run id (MOTIR-1896's duplicate-report test).                                                                                                      |

**5.5 · The transfer edge — read the owner from the RUN, not from the mirror.** Because the
gate is the owner login, a transfer flips it automatically; but the `GithubRepo` mirror row
may still hold the pre-transfer `owner` until a webhook reconciles it. So the meter takes
the owner from **the run's own payload**, not from the mirror, and treats the mirror purely
as the join to the project. A run that completes after the transfer then correctly falls
outside the gate even if the mirror is briefly stale. (Binding on MOTIR-1896.)

**5.6 · GitLab is out of scope for the meter, and that is structural, not an omission.**
Motir creates repositories only in its own **GitHub** org (MOTIR-1779 —
`POST /orgs/{org}/repos`); the shipped GitLab provider (`provider: 'gitlab'` on the shared
installation model) exists for **connect-existing** only, which by definition reaches a
namespace the user owns and GitLab already bills them for. There is therefore no GitLab
compute Motir pays for, and the meter needs no GitLab read. **If that ever changes** — a
decision to create repos on GitLab — it is a new card and an amendment here, and §9 records
where GitLab's usage data would come from so the option stays costed rather than unknown.

**5.7 · The predicate is evaluated at RUN COMPLETION, not at dispatch**, which is what
makes the transfer case fall out with no special handling.

**5.8 · ⚠️ WHERE the minutes come from — a hard constraint on MOTIR-1896, because the
obvious endpoint is being switched off.** MOTIR-1896 owns the mechanism choice, but two of
the three candidates are closing down and it must not build on them:

| Source                                            | Gives                                                                                                                  | Status                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /repos/{o}/{r}/actions/runs/{id}/timing`     | `billable` per OS: `total_ms`, `jobs`, `job_runs[]` — exactly what we want                                             | ❌ **Closing down** — _"This endpoint is in the process of closing down."_                  |
| `GET /orgs/{org}/settings/billing/actions`        | org totals + `minutes_used_breakdown` by OS                                                                            | ❌ **Closing down** (product-specific billing APIs, 2025-09-26 changelog)                   |
| `GET /organizations/{org}/settings/billing/usage` | `usageItems[]`: `date`, `product`, `sku` (e.g. "Actions Linux"), `quantity`, `unitType: minutes`, **`repositoryName`** | ✅ The enhanced-billing replacement — but **summarised by SKU/repo/day, no per-run detail** |
| `GET /repos/{o}/{r}/actions/runs/{id}/jobs`       | per job: `started_at`, `completed_at`, `labels`, `runner_name`, `run_attempt`                                          | ✅ Not deprecated — the durable per-run source                                              |

**The recommended shape, which the acceptance criteria already fit:**

- **Real-time + attributable:** the `workflow_run` **completion webhook** (not currently
  handled — the shipped `parseCiStatusEvent` covers `check_run`/`check_suite` and carries no
  timing) → read that run's **jobs**, and compute
  `Σ ceil(per-job wall-clock minutes) × multiplier(labels)`. **Per-job rounding UP is not
  optional** — it is how GitHub bills, and summing the run's wall clock instead would
  undercount a 4-job suite badly. Idempotent on **`(run_id, run_attempt)`**, since a re-run
  is a new attempt that bills again.
- **Reconciliation:** the enhanced-billing **usage endpoint** monthly, filtered to
  `product: Actions`. It carries `repositoryName`, so it reconciles per repo against the
  meter's own sum. Drift is **logged, not silently trusted in either direction** — the
  webhook path is the operational meter; the billing report is the audit.

This also means the ADR's own margin depends on the meter matching GitHub's billing within
a tolerance MOTIR-1896 should state. §3.3's stored raw wall-clock + multiplier is what makes
that reconciliation possible after the fact.

> ⚠️ **CORRECTED by the 2026-07-31 amendment (MOTIR-1915) — the reconciliation source stops
> covering the metered population.** The **webhook + jobs** half of 5.8 is unchanged and is
> exactly why the substrate change costs the meter nothing (self-hosted jobs are reported by
> the same jobs endpoint). The **audit** half is not: the enhanced-billing usage endpoint
> reports **GitHub-BILLED minutes only**, so once a repo's CI runs on the fleet its
> `product: Actions` rows go to ~0 while the meter keeps counting — the audit would log
> unbounded drift on every repo, every month, and the signal would be worthless. The
> corrected scope, and where the fleet's own audit source comes from instead, is **§Q** of
> the amendment. The code change is MOTIR-1924's; this text is the record.

### §6 — Two thresholds, two named states, and only one of them stops anything

These are separate events and must never be conflated.

**6.1 · (a) The POOL is exhausted → `drawing_on_credits`. Work continues; the state is
VISIBLE, not silent.** Consumption past the pool converts at §2's rate and debits the
credit ledger. Nothing is blocked. It is surfaced on the billing panel's CI line (§7),
because an allowance nobody can see is not an allowance and a charge nobody was told about
is a support ticket.

**6.2 · (b) The BALANCE hits ≤ 0 → `ci_credits_exhausted`. The next dispatch is REFUSED.**
The three candidates are not equivalent:

- **Refuse at dispatch** — chosen. It fails **before** the user waits on a run, and it is
  the only option that keeps the verification gate intact.
- **Let the PR open but skip CI** — rejected. It silently degrades the exact gate the whole
  agent loop leans on: an unverified PR that looks verified is worse than no PR.
- **Run it and go negative** — rejected as a policy. Motir would be funding unbounded
  compute for an org that has stopped paying.

**6.3 · The refusal sits on the DISPATCH/claim path**, so the user sees it before work
starts, and it raises a typed error mirroring the shipped `MotirAiOutOfCreditsError` — a
motir-core `CiCreditsExhaustedError` with a stable `code`, carrying the org, the balance,
and the pool state, so the surface can render _why_ rather than a generic failure. Never a
raw provider payload.

> ⚠️ **SUPERSEDED IN PART by the 2026-07-30 amendment (MOTIR-1906) below.** §6.3 as written
> makes the dispatch path the **only** gate, which does not stop the spend: GitHub bills on
> any push or PR to a Motir-owned repository, and four routes reach that without a dispatch
> (Amendment §A). The dispatch refusal is **kept** — it fails before the user waits on a
> run and it is the only gate that can carry a typed, renderable reason — but it is no
> longer the enforcement point. **Amendment §A adds the repo-side pause that makes this
> refusal true.**

**6.4 · The balance MAY go transiently negative, by at most the cost of runs already in
flight — and that is accepted, not a bug.** CI cannot be un-run: a run that starts while
the balance is positive and completes after it crosses zero still consumed real compute.
The invariant is therefore **"the next DISPATCH is refused"**, not "the balance never goes
negative". The overshoot is bounded by concurrent in-flight runs (~39 minutes each) and is
recorded honestly in the ledger rather than clamped at zero, which would lose the fact that
Motir paid for it. This mirrors the AI side's contract, where `≤ 0` means exhausted rather
than asserting the balance can never be negative.

> ⚠️ **CORRECTED by the 2026-07-30 amendment (MOTIR-1906) — the bound above was stated
> against the wrong event.** "Runs already in flight" bounds the overshoot only if dispatch
> is the sole trigger, which Amendment §A disproves: with a dispatch-only gate the overshoot
> is **unbounded**, because a collaborator push, a fix-up commit, a `manual`-lane push or a
> repo-resident trigger keeps billing indefinitely. The corrected bound is stated against
> the **pause**, in **Amendment §H**. The rest of 6.4 stands: the invariant is a refusal,
> not a non-negative balance, and the ledger records the overshoot rather than clamping it.

**6.5 · The state machine, complete** (the **Actions** column added by the 2026-07-30
amendment; `ci_credits_exhausted` has TWO effects, not one):

| State                  | Condition                        | Dispatch    | Actions on the org's Motir-owned repos | Charged               |
| ---------------------- | -------------------------------- | ----------- | -------------------------------------- | --------------------- |
| `within_allowance`     | period consumption < pool        | allowed     | enabled                                | nothing               |
| `drawing_on_credits`   | consumption ≥ pool, balance > 0  | allowed     | enabled (**warned** — Amendment §D)    | 1 credit / Lin-eq min |
| `ci_credits_exhausted` | consumption ≥ pool, balance ≤ 0  | **refused** | **PAUSED** (Amendment §A)              | in-flight only        |
| _(bypassed)_           | `isMeta`, or `MOTIR_CLOUD=false` | allowed     | untouched — no call is made            | nothing               |

#### Amendment 2026-07-30 (MOTIR-1906) — the refusal is ENFORCED AT THE COMPUTE, not only at dispatch

**Status:** accepted · **Date:** 2026-07-30 · **Card:** MOTIR-1906 · **Evidence pinned at:**
`motir-core` `origin/main` @ `02e7ba96` · **GitHub REST permission table, budgets docs and
Actions-settings docs re-read 2026-07-30** (sources in §I)

**What this amendment changes, in one line.** §6.2 rejected _"run it and go negative"_ as a
policy and §6.3 then put the gate on the **dispatch** path — but dispatch is not the path
that spends the minutes. **GitHub bills on any push or PR to a Motir-owned repository.** So
the shipped answer to _"what happens when the CI time is over the limit"_ was: the org keeps
burning Motir's money, indefinitely — the outcome this record's own §6.2 rejected. This
amendment adds the enforcement that makes the refusal true, supersedes §6.3's
dispatch-only enforcement in place, corrects §6.4's overshoot bound, and rewrites §7.3
item 5. It does **not** re-open §1–§5: the numbers, the rate, the normalization, the pool
and the attribution are unchanged. The planning defect is logged as MOTIR-1909.

##### §A — The enforcement point: pause Actions PER REPOSITORY

**`PUT /repos/{owner}/{repo}/actions/permissions` with `{ "enabled": false }` → `204`**, over
the org's Motir-owned repository rows (§C's fan-out). Re-enable is the same call with
`{ "enabled": true }`. GitHub's repository Actions-settings page states the effect plainly:
_"When you disable GitHub Actions, no workflows run in your repository."_

**It needs no new App permission and no user consent — verified, not assumed.** GitHub's
permissions-required-for-GitHub-Apps reference lists the endpoint under **Repository
permissions for `"Administration"`**, `write`, available to an **installation access token
(IAT)**. That is the _same_ repository permission the provisioning App (MOTIR-1779) already
holds on Motir's org for `POST /orgs/{org}/repos` (repo creation) and
`PUT /repos/{owner}/{repo}/collaborators/{username}` (MOTIR-1900's invite), which the same
table lists under the same heading. **No registration change, no two-sided re-consent, no
funnel cost** — and that is the load-bearing check, because `notes.html` #180 is exactly the
lesson of deciding a mechanism without pricing the permission it commits everyone to.

**The four candidates, and why the other three lose:**

| Candidate                                                                | Verdict                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-repository `PUT /repos/{o}/{r}/actions/permissions`**              | **CHOSEN.** No new permission; per-tenant by construction; N is 1–4 per project, so the fan-out is cheap and §5.8's rate limits are a non-issue.                                                                                                                                                                                                                        |
| `PUT /orgs/{org}/actions/permissions` + `enabled_repositories: selected` | **Rejected on two independent grounds.** (1) The same reference lists it under **Organization permissions for `"Administration"`** — a **different** permission the provisioning App does not carry, so it would be a registration change to buy nothing. (2) It is ONE shared mutable list across every tenant: a write-contention point and an org-wide blast radius. |
| Revoke the collaborator's push access                                    | **Rejected.** Reaches only path 1 of four, and it removes the access MOTIR-1900 exists to grant. Motir would take away a user's access to their own code to save $0.006/minute.                                                                                                                                                                                         |
| A GitHub **budget** with _stop usage when budget limit is reached_       | **Rejected as the tenant gate** — see §E. Budgets can be scoped to a single repository, so this is technically reachable, but it is denominated in **GitHub dollars over GitHub's billing period** and cannot be moved by a Motir top-up. Wrong control loop, and it would put the reset outside Motir's hands.                                                         |
| Do nothing at the repo; keep only the dispatch gate                      | **Rejected — it is the status quo, i.e. the outcome §6.2 already rejected.**                                                                                                                                                                                                                                                                                            |

**BOTH gates stay.** The dispatch refusal (§6.2–6.3) keeps its real virtue — the user finds
out _before_ waiting on a run — and it is the only gate that can raise a typed,
renderable `CiCreditsExhaustedError`. The repo pause is what makes that refusal true.

**The four non-dispatch spend paths, each closed by name:**

| Path                                                                              | What the pause does to it                                                                                                                                            |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 · The admin collaborator's own push** (MOTIR-1900)                            | The push still lands — access is untouched, which is the point — but **no workflow runs**. Motir stops the compute without touching the user's access to their code. |
| **2 · Fix-up commits on an already-dispatched branch**                            | Same. The claim gate is consulted once; the repo gate is consulted by GitHub on every trigger.                                                                       |
| **3 · `implementationSource: manual`** (MOTIR-1775 correction #2)                 | Hand-executed work never claims, so the dispatch gate never sees it. The repo gate is the only one it meets — and it meets it.                                       |
| **4 · Repo-resident triggers** — `push: main`, schedules, Dependabot, a UI re-run | All are workflow triggers on the repository, and all are covered by _"no workflows run in your repository."_                                                         |

**The grace-window argument, answered rather than dismissed.** Pausing a repository IS a
heavier act than refusing a queue, and a user mid-debug losing CI is a real cost. But a
grace window of extra funded minutes is **"run it and go negative", time-boxed** — the thing
§6.2 rejected — and it would be reinvented under a friendlier name. **Decision: no grace
minutes; the warning moves EARLIER instead.** `drawing_on_credits` (§6.1) already exists,
already means "you are now paying per minute", and is already visible on the panel — that is
where the §D surface appears **before** the damage, and no fourth state is introduced to
carry it. A user who reaches balance ≤ 0 has passed a state that told them, on the surface
they pay from, that they were spending.

##### §B — The RESUME trigger, and its stated latency

- **Primary — an event.** The credit ledger's transition to `balance > 0` (a top-up, or a
  plan renewal crediting the allotment) enqueues a resume. Same posture as the pause (§F):
  after the local commit, degrading gracefully.
- **Secondary — the calendar-month reset.** At the §4.5 boundary the pool refills, so every
  org paused for pool-exhaustion-with-no-balance resumes.
- **Backstop — the same convergent sweep that re-asserts the pause** (§F) also re-asserts
  the resume, on a schedule. **Interval: 15 minutes.**
- **Worst case, stated: 15 minutes from payment to CI working**, and typically under one
  (the event path). **This number goes in the copy, not in the implementer's head** — §D
  requires the Add-credits option to say it.
- **Read-time repair is rejected.** The paused state is the state a user pays money to
  leave; a repair that only runs when somebody happens to load a page leaves it stuck for
  exactly the user who paid and then closed the tab.

##### §C — WHICH repositories are paused

**Exhaustion is an ORG fact (§4.1: one pool, one balance, per org), so the pause fans out
across the org** — every Motir-owned repository row of every project in every workspace of
that organization. **Not** only the repos that consumed: the balance is shared, so a
per-project scope would let a second project go on spending the balance the first one
exhausted.

**The selector is the repository's OWNER LOGIN — `owner == GITHUB_FALLBACK_ORG` — read the
same way §5.1 gates the meter, never `Project.repoSetOwnership`.** §5.1's reasoning applies
unchanged: the column is SET-level so it cannot express a mixed set, and it drifts on any
path that moves a repo, while the owner login is the billing fact itself. Using the same
predicate for the meter and the pause also means the set Motir pauses is exactly the set
Motir pays for — the two can never disagree.

**A `connect-existing` row is OUT of the pause's scope, always, and for three reasons that
each suffice.** (1) The user owns it and GitHub bills them, so §5.4 already excludes it from
metering — pausing a repo Motir never paid for would punish a user for a bill they are
already covering. (2) It is outside what the ownership decision grants: MOTIR-1893 makes
Motir-owned a hosting arrangement, not authority over the user's own account. (3) It would
not work anyway — the provisioning App's `Administration: write` is on **Motir's org**, so
the call has no permission against a repository in the user's account.

##### §D — What the user sees (the shape is Yue's, 2026-07-30; the details are decided here)

> **"The UI should show the user the options to add credits or take over the repo if the
> user is an admin; show an alert message to a non-admin user."**

**Where it appears — ONE decision surface, N pointers.** The full two-option state renders
in exactly one place: the **billing panel's "Motir CI" line** (§7.1). The establish surface's
repo rows and any refused dispatch show a **short paused state plus a link to that line** —
never a second copy of the decision. A decision screen duplicated across three surfaces is
three surfaces to keep in sync and three chances to diverge; the shipped AI paywall already
works this way.

**Admin (`AiAccessDTO.canManageBilling === true`) — two options, equal weight, no default.**
Neither renders as the `primary` variant; both are peers, each with its consequence stated
under it, because one keeps the hosted arrangement and one ends it and dressing either as
_the_ answer is Motir's thumb on the scale.

| Option                                       | What it says                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add credits**                              | The shipped top-up path. The copy **states §B's latency explicitly** — CI resumes within a minute of the payment landing, at most 15 — rather than implying it is instant.                                                                                                                                                                                                                                             |
| **Move the repositories to your own GitHub** | MOTIR-711, framed honestly as _GitHub bills you for Actions directly from then on, and Motir stops charging CI credits_ — the standing ownership promise being exercised, not a punishment. The copy states its **real costs**: a GitHub account you own, an **asynchronous transfer you must accept on GitHub**, and a **re-install of the Motir App** on the new owner so dispatch keeps working. Never "one click". |

**⚠️ "An admin with no GitHub identity" is the DEFAULT case, not a degradation — the card's
premise is corrected here.** Verified against shipped code: motir-core's only social provider
is **Google** (`lib/auth/index.ts` `socialProviders`), and no table links a **user** to a
GitHub account — the only GitHub identity anywhere is the workspace-level
`GithubInstallation` (`accountLogin` / `accountType`), which exists only for
connect-existing. So **no admin has a stored GitHub identity today.** Consequences, binding
on MOTIR-1902/1903 and MOTIR-711:

- The takeover option is **never hidden, never disabled, and never gated on a stored
  identity** — gating it on one would hide it from every user.
- **MOTIR-711 owns collecting the destination** inside its own flow (which account or org
  receives the transfer, and the GitHub-side acceptance). The billing panel's job is to
  offer the choice and state its costs, not to resolve an identity it does not have.

**Member (`canManageBilling === false`) — an alert, never a dead control.** It mirrors the
shipped AI-paywall member variant in shape and register (`messages/en.json` →
`"askOwner": "Ask an owner to upgrade"`): what happened, that CI is paused, and **who can
fix it**.

- **It routes; it does not name.** Decided: the alert says "an organization owner", not a
  list of people. Naming owners leaks org membership to a member who may not be entitled to
  see it, and the shipped paywall already routes without naming — consistency beats the
  marginal convenience of a name.
- **Never render a disabled "Add credits" button.** A control a user cannot use is worse
  than a sentence explaining why.

**Two binding constraints on the cards this gates:**

- **MOTIR-1902 — it is a DECISION screen, so it is measured against real laptop viewports**:
  both options and both consequence lines visible **without scrolling**, not just "designed".
- **MOTIR-1903 — every new string is a new `en.json` key with a matching `zh.json` key**, or
  the i18n-catalog parity gate fails the PR.

##### §E — Motir's OWN org-level budget: a tripwire, never a valve

**Verified from GitHub's budgets documentation, 2026-07-30:** a budget can be scoped to _"the
whole organization or a single repository within the organization"_; GitHub notifies at
_"75%, 90%, or 100% of a defined budget"_; and _stop usage when budget limit is reached_ is
an **option** — without it, _"you will be notified by email if you exceed your budget, but
usage **will not** be stopped."_ Separately, GitHub emails _"when your included GitHub
Actions usage reaches 90% and 100% during a billing period."_

**The decision: ONE org-wide Actions budget on `motir-projects`, with `stop usage` OFF.**

- **`stop usage` must stay OFF, and this is the load-bearing part.** Turning it on would make
  **GitHub** perform precisely the org-wide, cross-tenant shutdown that must never be the
  tenant gate: every customer's CI dies at once because one org overspent. Worse, it is
  **invisible to the meter** — MOTIR-1896 accumulates from `workflow_run` **completions**, so
  a run GitHub never starts emits nothing, consumption reads as zero, and the billing panel
  goes on saying everything is fine. The tenant gate is §A/§C. **The budget is a tripwire,
  not a valve.**
- **The number: $500 / month, initially.** Sized from this ADR's own model rather than
  guessed: an org at full drain costs `max(members × 300, 1000) × $0.006`, i.e. **$6.00** for
  a solo org at the floor and **$10.80** for a 6-seat org. $500 is ~83,000 Linux-equivalent
  minutes — roughly **46 fully-drained 6-seat orgs**, or ~2,100 merged dispatches at
  §Context's ~39 minutes. At present scale (the dogfood org) that is ~50× headroom, so it
  cannot bind in normal operation, while still capping a runaway at a survivable number.
- **Alerts at 75% / 90% / 100%**, to a **monitored address**. MOTIR-1908 records the actual
  recipients as **named individuals** — an alert going to an unread address is not an alert.
- **Revisit trigger, named so it is recognisable:** monthly org spend crossing **40% of the
  budget in two consecutive months** → raise it, in the same pass that re-derives §1's 300
  from the meter's first real numbers (§1.4).
- **The org-wide limit may NEVER be used as the per-tenant gate**, for the shared-fate reason
  above. Recorded here so it cannot be reintroduced as a shortcut.

**What the product does if it binds anyway.** Nothing automatic, deliberately. Binding
requires ignoring three escalating alerts against a limit sized ~50× over current exposure,
so it is an **ops event, not a product state** — and building a product state for it would
mean inventing a UI for a condition that has never occurred. **A polling alarm on
`GET /organizations/{org}/settings/billing/usage` (§5.8) is therefore a decided NO, not a
deferral**, on the same reasoning §"deliberately NOT decided" gives for a dispatch rate
limiter: no observed problem, no consumer. MOTIR-1908 records the manual read path so
headroom is checkable without waiting for an alert, and confirms **from observation** what
binding actually does.

##### §F — Idempotency and failure posture of the pause

- **The paused state is STORED per row, not re-derived.** The pause is a fact about a
  **remote** system; deriving it from the balance would let the DB believe "should be paused"
  while GitHub still has Actions enabled, with nothing reconciling the two. Store the
  intent; converge to it. (MOTIR-1907 picks the column shape.)
- **A convergent sweep re-asserts intent** — the same 15-minute sweep as §B. N repositories
  means N independent calls with **no transaction over them**, so partial failure is the
  normal case, not the exception: a run where half the calls fail must leave the intent
  recorded and let the next sweep finish the job.
- **Idempotent in both directions.** `PUT …/actions/permissions` is a set-state call
  returning `204`, so re-pausing a paused repo and re-enabling an enabled one are **no-ops,
  not errors**.
- **It runs AFTER the local commit and degrades gracefully** (log + enqueue a retry) — the
  shipped side-effects-outside-tx rule this record already states in §8.6. A GitHub outage
  **never** rolls back the metering write and **never** fails the request.
- **`isMeta` and `MOTIR_CLOUD=false` bypass it entirely — no call is made**, exactly as §4.4
  and §8.5 bypass the meter and the pool. moooon B.V. pays its own GitHub bill; a self-hoster
  has no Motir-owned repositories at all.
- **One honest unknown, named rather than assumed.** GitHub documents that _"no workflows
  run in your repository"_ after a disable, but does **not** document what happens to a run
  already **queued or in progress** at that moment. **MOTIR-1907 must measure it and record
  the answer**; §H's bound is stated the conservative way so that it holds either way.

##### §G — A repo transferred while the org is exhausted

**Rule: the transfer RESUMES Actions on the repository, unconditionally — even while the org
is still exhausted.** Once GitHub bills the user, Motir has no reason to hold their CI off,
and §5.4 already stops metering at the transfer. A repo arriving at its new owner with
Actions dead would be the worst possible first impression of _"it's yours"_.

**Ordering is part of the rule, because getting it backwards is a latent bug: re-enable
BEFORE the transfer.** While the repository is still in Motir's org the provisioning App
holds `Administration: write` on it; after the transfer it sits in the user's account and
that credential no longer reaches it. Binding on MOTIR-711.

**And the corollary falls out of §C for free:** a transferred repo's owner login is no longer
`GITHUB_FALLBACK_ORG`, so it leaves the pause fan-out automatically — the same property that
makes §5.5's metering stop at the transfer.

##### §H — §6.4's overshoot bound, corrected

The old bound — _"the cost of runs already in flight (~39 minutes each)"_ — held only under
the dispatch-only gate's own false premise. **With a dispatch-only gate the overshoot is not
bounded at all**, because paths 1–4 keep billing after the refusal. **The corrected bound,
stated against the pause:**

```
overshoot  ≤  (runs triggered between balance ≤ 0 and the pause converging on that repo)
            + (runs already in flight when the pause lands)
```

- The **first term** is bounded by §B's convergence: sub-minute on the event path, **≤ 15
  minutes** if the event is dropped and the sweep is what catches it.
- The **second term** is bounded by concurrent in-flight runs at ~39 Linux-equivalent
  minutes each — and is stated **conservatively**, assuming a disable does **not** cancel an
  in-progress run, because §F records that GitHub does not document either way. If
  MOTIR-1907's measurement shows queued runs are cancelled, the real bound is smaller than
  this one; it will never be larger.

Unchanged from §6.4: the invariant is a **refusal**, not a non-negative balance, and the
overshoot is recorded honestly in the ledger rather than clamped at zero.

##### §I — Sources for this amendment (read 2026-07-30)

- **Permissions required for GitHub Apps** — the table that pins every endpoint below to a
  permission and to installation-token availability:
  <https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps>
  - `PUT /repos/{owner}/{repo}/actions/permissions` → **Repository permissions for
    `"Administration"`**, `write`, UAT + **IAT**.
  - `GET /repos/{owner}/{repo}/actions/permissions` → same heading, `read`, UAT + IAT.
  - `PUT /orgs/{org}/actions/permissions` → **Organization permissions for
    `"Administration"`**, `write` — the different permission §A rejects.
  - `POST /orgs/{org}/repos` and `PUT /repos/{owner}/{repo}/collaborators/{username}` →
    **Repository permissions for `"Administration"`**, `write` — the grant MOTIR-1779 already
    provisions, which is why §A costs nothing.
- **Actions permissions endpoints** (body fields `enabled` / `allowed_actions` /
  `sha_pinning_required`; `204 No Content`): <https://docs.github.com/en/rest/actions/permissions>
- **Managing GitHub Actions settings for a repository** — _"When you disable GitHub Actions,
  no workflows run in your repository."_:
  <https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository>
- **GitHub budgets** — scope (_"the whole organization or a single repository within the
  organization"_), the 75/90/100% alerts, and _"you will be notified by email if you exceed
  your budget, but usage will not be stopped"_ without _stop usage_:
  <https://docs.github.com/en/billing/tutorials/set-up-budgets>
- **GitHub Actions billing** — _"If your account does not have a valid payment method on
  file, usage is blocked once you use up your quota"_, plus the 90%/100% included-usage
  emails: <https://docs.github.com/en/billing/concepts/product-billing/github-actions>
- **GitLab compute quota** — the mirror that also gates the compute:
  <https://docs.gitlab.com/ci/pipelines/compute_minutes/>
- **Shipped motir-core, read at `02e7ba96`:** `lib/dto/aiAccess.ts` (`canManageBilling`),
  `lib/services/billingService.ts` (`isOrgOwnerRole`), `messages/en.json`
  (`"askOwner": "Ask an owner to upgrade"` — the member variant §D mirrors),
  `lib/auth/index.ts` (`socialProviders` — **Google only**, the fact behind §D's correction),
  `lib/github/appAuth.ts` (`mintInstallationToken`), `design/billing/design-notes.md`.

### §7 — The user sees a THIRD line on the billing panel: "Motir CI"

**7.1 · A third line, not a second usage kind on the Motir AI line.** The panel's grammar
is one line per billed product (`billing-tiering.md` §1: ① Motir, ② Motir AI). CI is a
third billed dimension with its **own unit** (minutes, not credits), its **own period**
(calendar month, not the Stripe period — §4.5), and its **own exhaustion state**. Folding
it into the AI line would put two units and two reset dates on one row.

**7.2 · It cross-links to the AI line for the balance; it never restates it.** The overage
draws from the one AI credit balance, so the CI line reports **minutes** and the **credits
this period's overage drew**, and links to the AI line rather than re-rendering a balance.
This is the non-duplication rule `design/billing/design-notes.md` already sets between the
`billing` panel and the `ai-usage` dashboard.

**7.3 · What the line states — the spec MOTIR-1902 draws and MOTIR-1903 builds:**

1. **Used vs included this period** — "1,240 of 1,800 minutes", with a meter/progress
   affordance.
2. **How the pool was derived, in words** — "300 min × 6 seats", or "1,000 minute minimum"
   when the floor binds (§1.2). A pool the user cannot explain reads as arbitrary.
3. **The reset date** — "Resets 1 Aug", the calendar-month boundary, formatted in UTC the
   way `formatRenewal` already formats the seat renewal (deterministic across
   server/client — the finding-#89 hydration rule). **§4.5's cost is paid here:** this date
   differs from the seat line's renewal date and the panel must not imply they coincide.
4. **`drawing_on_credits`** — "420 minutes over your included minutes · 420 credits drawn
   this period", linking to the AI balance.
5. **`ci_credits_exhausted`** — ~~"Dispatch paused — out of credits", using the owner/member
   split the shipped AI paywall already uses (`AiAccessDTO.canManageBilling`: an owner gets
   "Top up"; a member gets the routed-to-an-owner variant).~~ **SUPERSEDED 2026-07-30
   (MOTIR-1906).** The old line is wrong on two counts: it names the wrong effect (what is
   paused is **CI**, not only dispatch — §6.5), and it offers the admin **one** option where
   Yue's directive fixes **two**. **Rewritten:**

   **The state is "CI is paused", and it is a two-option DECISION for whoever can act and an
   ALERT for whoever cannot.** The full specification — the two admin options with their real
   costs, the §B resume latency the copy must state, the member alert that routes without
   naming, why no "Add credits" button is ever rendered disabled, why the takeover is never
   gated on a stored GitHub identity (no admin has one today), the one-decision-surface /
   N-pointers rule, and the viewport + i18n constraints on MOTIR-1902 / MOTIR-1903 — is
   **§D of the 2026-07-30 amendment above**, which MOTIR-1902 draws and MOTIR-1903 builds
   from. It keeps the shipped owner/member split (`AiAccessDTO.canManageBilling`) the old
   line already named.

6. **The zero-consumption case is not an empty state** — an org whose repos are all
   user-owned (§Context) has a pool it will never draw on. The line says so plainly rather
   than showing "0 of 1,000" as if something were wrong.
7. **META and self-host** — the meta org stays bypassed (§4.4: no pool, no charge, no
   refusal) but draws a minutes-only **internal** CI line beside the "Internal billing"
   treatment: the measured minutes its own fleet runner used this month (MOTIR-8886),
   with no allowance, meter, credits or buy control. Before MOTIR-8886 this item said "no
   CI line", which hid real fleet cost from the one org that pays it. Off-cloud the page
   does not render at all (`isCloudBilling()` → `notFound()`).

### §8 — `motir-core` owns the meter AND the entitlement; `motir-ai` gains exactly one debit kind

**8.1 · The split.**

| Repo         | Owns                                                                                                            | Card       |
| ------------ | --------------------------------------------------------------------------------------------------------------- | ---------- |
| `motir-core` | the meter (webhook → normalize → attribute → per-period store) and the **entitlement** (pool, overage, refusal) | 1896, 1901 |
| `motir-ai`   | **only** accepting a CI-overage debit on the credit ledger, with its own idempotency key                        | 1899       |

**8.2 · Why the entitlement is in `motir-core`.** Its only input that is not already local
is nothing: **the seat count IS org membership** (§4.2), which lives only in motir-core;
the meter's inputs (`GithubRepo`, `ProjectRepo`, `Project.repoSetOwnership`, `Workspace`)
are all motir-core; and putting the pool in motir-ai would require propagating a live
membership count across the boundary on every check — a new sync with exactly the staleness
§4.2 rejected. Keeping entitlement next to its meter also keeps the read-derived decision
(read consumption → read balance → decide → debit) inside **one** transaction boundary,
which §Consequences requires to be lock-guarded.

**8.3 · The argument against, answered.** Every other allotment
(`PlanTier.monthlyCreditAllotment`) lives in motir-ai, so this does split the entitlement
model across two repos. That cost is real and is accepted, because:

- **The precedent already exists in motir-core.** `lib/billing/entitlements.ts` holds the
  §4 PM-core caps — a commercial, cloud-only entitlement policy — in the open repo behind
  `MOTIR_CLOUD`. The CI pool is the same shape, so this is a second instance of a settled
  pattern, not a new straddle.
- **The split is along the right seam.** motir-ai's allotments are all **credit-denominated
  and tier-derived**; the CI pool is **minute-denominated and seat-derived**. They are not
  the same kind of object, and co-locating them would put a membership count in the AI
  service.
- **motir-ai's ledger stays a pure credit store**, gaining one new debit kind — which is
  what keeps MOTIR-1899 a 3-point card rather than an entitlement port.

**8.4 · The CI pool is NOT added to `PM_ENTITLEMENTS`.** That map is tier → caps; this is
seat-derived and tier-independent (§1.4). It gets its own policy module alongside it,
mirroring its shape (pure config + a resolver, no DB, no Stripe, no cloud check).

**8.5 · Self-host is inert.** Under `MOTIR_CLOUD=false` there is no meter, no pool, no
overage and no refusal — a self-hoster's Actions bill is their own, and Motir never hosts
their repos. Same gate as `billing-tiering.md` §6.

**8.6 · The debit is a cross-boundary side effect** and therefore runs **after** the local
commit, degrading gracefully on failure (log + retry/enqueue) — it never rolls back the
metering write and never fails the request. This is the shipped side-effects-outside-tx
rule, and it is why the meter must be durable on its own.

### §9 — Sources

Vendor prices were read from each vendor's own pricing page on **2026-07-30**, not from a
secondary catalog or a paraphrase (`notes.html` #88 — the DeepSeek/OpenRouter lesson):

- **GitHub Actions** — per-minute rates (Linux x64 $0.006, Linux arm64 $0.005, Windows x64
  $0.010, macOS $0.062) and included private-repo minutes (Free 2,000, Team 3,000,
  Enterprise Cloud 50,000):
  <https://docs.github.com/en/billing/concepts/product-billing/github-actions>. The
  2026-01-01 repricing cut Linux 2-core from $0.008 to $0.006 and folded a $0.002/min
  platform charge into the meter rates:
  <https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/>
- **GitLab** — included compute minutes (Free 400, Premium 10,000, Ultimate 50,000) and
  extra compute at $10 per 1,000 minutes: <https://about.gitlab.com/pricing/>
- **Motir** — `lib/billing/catalog.ts` (`BILLING_CATALOG`): the $5/$40 seat plan, the AI
  ladder, and the 1,000-credits-for-$10 top-up that fixes a credit at ~$0.01.

**API sources for §5.8 (the meter's read):**

- **`/timing` is closing down** — _"This endpoint is in the process of closing down"_:
  <https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28#get-workflow-run-usage>
  · the notice:
  <https://github.blog/changelog/2025-02-02-actions-get-workflow-usage-and-get-workflow-run-usage-endpoints-closing-down/>
- **Product-specific billing APIs are closing down** (including
  `/orgs/{org}/settings/billing/actions`):
  <https://github.blog/changelog/2025-09-26-product-specific-billing-apis-are-closing-down/>
- **The enhanced-billing usage endpoint** (`usageItems[]` with `sku`, `quantity`,
  `unitType`, `repositoryName`): <https://docs.github.com/en/rest/billing/usage> ·
  <https://docs.github.com/en/billing/tutorials/automate-usage-reporting>
- **Workflow jobs** (`started_at` / `completed_at` / `labels` / `run_attempt`, not
  deprecated): <https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28>
- **GitLab, for the §5.6 "if that ever changes" case only** — compute usage is tracked
  monthly per namespace and per project (`ci_namespace_monthly_usages` /
  `ci_project_monthly_usages`, surfaced on the group usage-quotas page and in GraphQL);
  per-job `duration` is on the jobs API and the pipeline webhook:
  <https://docs.gitlab.com/ci/pipelines/compute_minutes/>

**Prices and endpoints drift.** Every number above is dated, the multipliers of §3 are
effective-dated in storage so a repricing is a new row rather than a code change plus a
backfill, and §5.8 records which endpoints are sunsetting so the meter is not built on one.

### Amendment 2026-07-31 (Yue · MOTIR-1915) — project CI runs on MOTIR'S OWN RUNNER FLEET

**Status:** accepted · **Date:** 2026-07-31 · **Card:** MOTIR-1915 · **Evidence pinned at:**
`motir-core` `origin/main` @ `2fde16c5` (includes MOTIR-1901's shipped allowance),
`nextjs-prisma-vercel-starter` + `nextjs-prisma-vercel-starter-with-design`
`.github/workflows/**` · **GitHub contexts / expressions / self-hosted-label docs read
2026-07-31** (sources in §R). Lettering continues the 2026-07-30 amendment's §A–§I.

**The directive (Yue, 2026-07-30):** _"we drop the github CI minutes, we use our own CI
minutes and charge the user for that."_ Project CI stops running on GitHub-hosted runners
and runs on **Motir-operated ephemeral self-hosted runners**.

**What this amendment changes, in one line.** The **substrate** under the metered minute —
and almost nothing else. This record priced, metered and enforced a minute without ever
asking who owns the compute that produces it; the answer turns out to be _"Motir does"_,
which changes Motir's cost basis by roughly an order of magnitude and changes the
customer-facing model **not at all**. **§1–§4 are UNCHANGED** — the allowance, the rate, the
cost-ratio normalization method and the pool are all denominated in _Linux-equivalent
minutes_, a unit deliberately defined against a price ratio rather than against a machine, so
none of them has a dependency on who owns the runner. §5 is unchanged **except §5.8's
reconciliation source** (§Q). §6–§8 are unchanged. What the amendment adds is a runner
family, a portability seam, and a second meter. The planning defect — that the compute itself
was an unowned deliverable through four decision cards — is logged as **MOTIR-1917**.

**Everything recorded here is BUILT by MOTIR-1916.** This is a `decision` card: it fixes the
shapes, it ships no behaviour. It also **does not re-scope MOTIR-1779**, whose permission set
stays exactly as registered (§O).

#### §J — SCOPE: the fleet serves `motir-projects`. Motir's OWN repos keep GitHub-hosted runners

**Every repository in `moooon-B-V` — `motir-core`, `motir-ai`, `motir-gateway`, `motir-meta`,
the two starters — keeps `runs-on: ubuntu-latest` and keeps billing to Motir's own GitHub
plan.** This is a deliberate exclusion, not an oversight, and it is the one place where _not_
dogfooding is the correct call. Three independent reasons, each sufficient:

1. **Do not put your own release path on infrastructure you are still building.** If the
   fleet degrades while `motir-core`'s CI depends on it, Motir loses the ability to ship the
   fix _for the fleet_. Product outages and development capacity must not share a failure
   domain.
2. **`motir-core` is the heaviest CI Motir has, and is representative of no customer
   project.** Measured at `origin/main` @ `2fde16c5`: **31 jobs / 141.6 job-minutes** per run
   — eight `runs-on` sites in `.github/workflows/ci.yml` expanded by a 3-shard Vitest matrix,
   an 11-leg Playwright `include:` matrix and a 9-job sandbox-image matrix. The metered
   customer workload this ADR is written against is the **starter's** ~39 minutes (§Context).
   Self-operating the 141-minute one while the fleet is new inverts the risk.
3. **The two orgs need OPPOSITE settings, and a spending limit is per-org.**
   `motir-projects` gets a **$0** limit so a GitHub-hosted run there fails loudly as a
   misconfiguration (MOTIR-1908); `moooon-B-V` needs a **real, non-zero** limit because
   GitHub-hosted _is_ its intended substrate. One account cannot hold both — an independent,
   concrete reason the project repos must not live in `moooon-B-V`, on top of the ones
   `project-repository-set.md` already gives.

##### §J.4 — RE-TESTED 2026-08-19 (MOTIR-3149) and UPHELD, against a live starvation incident

§J was written as a forward-looking exclusion. On 2026-08-19 it was tested by the case most
likely to overturn it — **`motir-core`'s own CI was measurably starved** — and it holds on every
axis. Recorded here because the next person to hit a slow lane will have the same idea, and
the honest answer is that the idea was tried with numbers.

**What was measured.** At 17:28Z the `moooon-B-V` GitHub plan was `free`: **20 jobs running, 90
queued**, the ceiling pinned exactly at 20 while one `ci.yml` run wants 37 jobs. Push-to-`main`
runs waited **35 and 58 minutes** for their first job, and `deploy` sits behind every gate, so a
starved run is an unshipped merge. Two changes landed instead of a substrate change:

|                                  | ceiling     | jobs / run          | main lag to first job       | jobs queued                                                   |
| -------------------------------- | ----------- | ------------------- | --------------------------- | ------------------------------------------------------------- |
| before                           | 20 (`free`) | 37                  | 1 · 5 · **35** · **58** min | **90**                                                        |
| after MOTIR-3147 (plan → `team`) | 60          | 37                  | 4 · 10 min                  | draining                                                      |
| after MOTIR-3148 (fan-out cut)   | 60          | ~19 on a typical PR | **2 min**                   | **0**, on three samples ~15 min apart at 33 / 34 / 45 running |

**So the starvation is gone without touching the substrate**, and the two levers that removed it
cost **$4/month** and one workflow diff. That is the decision: **option (a), nothing further.**

**And the fleet is rejected on §J's own three reasons, not merely on cost** — each still
sufficient, none weakened by the incident:

1. **The failure-domain argument is the one the incident STRENGTHENS.** The lever that fixed
   this was a GitHub plan tier. Had `motir-core` been on the fleet, the same saturation would
   have been the fleet's admission gate (§6 is explicit that Motir's own cap, not GitHub, is the
   binding constraint), and the fix would have required shipping a change to the fleet — through
   the CI that was blocked.
2. **The weight argument got heavier, then lighter, and is unchanged in kind.** 37 jobs / 179
   job-minutes measured at run 32294917081, against the starter's ~39 minutes §J compares it to.
3. **The per-org spending-limit argument is untouched** — `moooon-B-V` still needs a real limit
   and `motir-projects` still needs $0.

**A fourth reason, new, and it corrects `ci-runner-fleet.md` §8.** §8 prices the parity runner
off _"GitHub's `ubuntu-latest` on a **private** repository … because every Motir-created
repository is private."_ True of a Motir-created repo — and **false of `motir-core`**, which is
`public`. So for the one repository anybody is ever tempted to move, the fleet's cost basis is
understated: matching a public repo's larger hosted runner is roughly **2× $0.00195/min**. The
same fact removes the benefit entirely, because **public-repo GitHub-hosted minutes are free** —
moving `motir-core` converts **$0** into real Fly spend that §9 can neither cap nor alert on.

**And §O already forbade the mechanism.** Routing `motir-core` to the fleet means setting
`MOTIR_RUNNER` in `moooon-B-V` — the seam §N.1 relies on being _unset_ — so that its jobs carry
the label §O binds the provisioning listener to. §O names that outcome exactly: pulling Motir's
own matrix onto the fleet is _"the precise outcome §J exists to prevent, arriving through the
back door."_ Option (b) is not a §J amendment; it is a dismantling of the guard built to stop it.

**Not owed, with their triggers, so this is a decision and not a shrug:** a deploy-only `main`
run and a merge queue were both weighed and are **not taken** — they address release LATENCY,
and the measured complaint was contention, which is now zero. Re-open either if `main`'s
created→deployed time becomes the binding problem; neither needs this section changed.
**⚠️ That trigger FIRED on 2026-08-28 and both were re-opened — see §J.5, which
re-measured them and rejected each for a reason this paragraph did not have.**

> **⚠️ One criterion this pass could not satisfy as written, recorded rather than quietly
> dropped.** MOTIR-3149 asked for the created→first-job delay across _"at least 5 push-to-`main`
> runs."_ Only 3 post-change samples exist, and the shortfall is structural, not impatience:
> **most push-to-`main` runs never start a job at all.** MOTIR-3106 deliberately keeps one
> _pending_ run per concurrency group, so a merge landing during another merge's run cancels the
> older pending one with **zero jobs** — 10 of the 20 most recent `main` runs. "Lag to first job"
> is undefined for those, so the sample can never be filled on demand. **The queue-depth
> measurement is the sound one** and it answers the question more directly: nothing waiting for a
> runner means no run can be starved of one, which is a statement about the mechanism rather
> than a sample of the symptom.

##### §J.5 — THE TRIGGER FIRED, 2026-08-30 (MOTIR-3760). Both options RE-OPENED, RE-MEASURED, and neither TAKEN — for reasons that are not §J.4's

§J.4 closed by naming the condition that would re-open a deploy-only `main` run
and a merge queue: _"if `main`'s created→deployed time becomes the binding
problem."_ On 2026-08-28 it did. `6dafd2ee8` — the story retiring the Inngest
engine — merged at 07:44:30Z; the last Fly release was 08:47:04Z, reusing an
image built at 07:51; and at 11:00Z the running `/app/worker/worker.mjs` still
contained 278 references to an engine that no longer exists anywhere in
`origin/main`. `system.daily-health-check` dead-lettered at 09:04:46Z against
that code. This section is the re-open, and it records a different verdict on
each option than §J.4 reached, arrived at from measurement rather than from the
same reasoning repeated.

**FIRST, THE NUMBER, because the one the card was filed on is already stale.**
Nine consecutive successful push-to-`main` runs, 2026-08-29/30, created →
`Deploy to Fly` complete:

| run         | merge → released |
| ----------- | ---------------- |
| 33307649462 | 21.2 min         |
| 33270573757 | 22.1 min         |
| 33285015926 | 23.0 min         |
| 33271383815 | 27.1 min         |
| 33250609131 | 34.0 min         |
| 33282807240 | 34.1 min         |
| 33248423068 | 34.4 min         |
| 33272081857 | 42.4 min         |
| 33285023182 | 45.2 min         |

Median ~34, worst 45.2 — against the 35-to-79 the workflow header quoted from
2026-08-19. On the fastest run the gate took 14.5 minutes and the release itself
6.75; the binding chain is the 12 Vitest legs (12.9 min) then `coverage`
(1.4 min), with the at-scale legs 13 seconds behind them. MOTIR-3902 / 3912 /
3913 / 3928 / 3950 — all merged in the 24 hours before this measurement — are
what moved it, and none of them was about deploy latency.

**§J.4's (c), a deploy-only `main` run: REJECTED, and on evidence the card that
proposed it did not have.** The premise is that `deploy`'s
`needs: [lint, typecheck, build, test, coverage, e2e, e2e-at-scale]` re-runs on
the merge commit what the pull request already ran. Read the workflow: it does
not.

1. **`e2e-at-scale` never ran on the pull request.** Its `if:` is
   `needs.changes.outputs.app == 'true' && (github.event_name == 'push' ||
contains(github.event.pull_request.labels.*.name, 'e2e-at-scale'))`, shipped by
   MOTIR-3148 so that the four at-scale legs bill to `main` rather than to every
   pull request. For an unlabelled pull request — the overwhelming majority — the
   push-to-`main` run is the **first and only** execution of `board-at-scale`,
   `collab-at-scale`, `reporting-at-scale` and `billing-cloud`. Dropping it from
   `needs` removes a check rather than a repetition, and MOTIR-3692 and MOTIR-3929
   are two occasions when that check caught something.
2. **`strict_required_status_checks_policy` is `false`** (ruleset 17227448, since
   2026-08-07), so a pull request merges while BEHIND `main` and its green
   describes a merge base that has moved. The push-to-`main` run is this
   repository's **only** verification of the merged SUM, which is the whole
   `both-green-main-red` defence MOTIR-2003 was filed about and MOTIR-3106 nearly
   lost.

So the duplication is real for `lint` / `typecheck` / `build` / `test` /
`coverage` / `e2e` and is NOT the whole of the release path. Narrowing `needs`
buys at most the 1.4 minutes `coverage` adds after `test`, unless it also drops
`e2e-at-scale` — at which point it is trading the trunk's only at-scale run and
its only check of the sum for roughly fourteen minutes. Recorded as REJECTED, not
as unexamined.

**§J.4's (d), a merge queue: REJECTED for latency, and the reason INVERTS the
usual framing.** A merge queue is the industry-standard answer to _"should the
release re-verify what the merge gate verified?"_ and it is the correct answer to
the correctness half — it tests the exact commit that will become `main`, which is
precisely what point 2 above says nothing does today. But on this repository's
numbers it does not reduce merge→deployed time; it **increases** it. The queue's
run happens BEFORE the merge, so the wall clock from _"merge when ready"_ to
_deployed_ becomes queue-run + release ≈ 20 + 7 minutes, against 14.5 + 6.75
today. And the pull-request lane stays, so every change pays for a second full
run rather than replacing one. A merge queue is a **correctness** improvement
here, and should be re-opened as one — under the both-green-main-red heading,
sized against the second run per change — never as a latency fix.

**WHAT WAS TAKEN: §J.4's third option, with the detector that made it defensible.**
The release keeps every gate, and the wait stops being invisible.
`.github/workflows/deploy-freshness.yml` compares the commit the deployment
reports (`GET /api/health/release`) against `main`'s head every thirty minutes,
from OUTSIDE the deployment, and is red once the oldest undeployed commit passes
90 minutes — twice the worst healthy run above, so an ordinary busy morning does
not train anybody to ignore it.

**The externality is the design, not a deployment detail.** A deployment cannot be
the thing that reports it is behind: the state being reported on is the state of
the reporter, so a release that never happened and a machine still serving an old
image both answer _"fine"_. The deployment states ONE fact about itself and the
comparison happens elsewhere — the same split, for the same reason, as the
queue-depth reading in MOTIR-3764, where a wedged worker was taking down an alarm
that was itself a job.

**One thing the incident could not have reported even if somebody had looked.**
`MOTIR_RELEASE` reached only the `builder` stage of the `Dockerfile`; a Docker
`ENV` is scoped to its stage, and the runner stage copies artifacts rather than
inheriting an environment. So `process.env.MOTIR_RELEASE` in the running server
was `undefined` and the deployment had no way to name its own commit at all. The
Sentry release assertion in the deploy job proves the BUILD was named, which is a
different claim from the one anybody needed. Fixed here.

**§J itself is untouched.** Nothing above routes a job anywhere, sets
`MOTIR_RUNNER`, or changes what `motir-core` runs on — §J.4's three reasons and
§O's guard are exactly as they were.

##### §J.6 — ⛔ §J.5's MERGE-QUEUE REJECTION IS SUPERSEDED (MOTIR-4050, 2026-09-02)

**Only the merge queue moves. §J.5's other verdict — the deploy-only `main` run
rejected as (c) — is not re-opened by this, it is DELIVERED by it**, as a
consequence of the queue rather than on its own terms, and both of the reasons
(c) was refused are retired: `e2e-at-scale` now runs on `merge_group`, and the
merged SUM is verified by the queue BEFORE the merge instead of by the push
after it.

§J.5 rejected a merge queue as a latency fix and was RIGHT to: measured again on
2026-09-02, click-to-deployed is a wash (~22–26 min against 21 fastest / ~34
median). It then named the heading under which the answer would differ — _"a
**correctness** improvement … re-opened under the both-green-main-red heading,
sized against the second run per change"_ — and MOTIR-4050 is that card.

**The one thing §J.5 got wrong is the sizing, and it is what inverts the
verdict.** _"Every change pays for a second full run rather than replacing
one"_ measures against a baseline where `main` runs nothing. `main` was in fact
running the full matrix on every merge, so the second full run was **already
being paid**; the queue relocates it from after the merge to before it. Per
merged change: **353 runner-minutes before, 370 unbatched (+5%), 232 batched
three to a group (−34%)**.

The decision, the ejection cost it adds, the ruleset parameters and the
measurement still owed are `docs/decisions/merge-queue.md`. **§J itself is
untouched** — nothing there routes a job anywhere or changes what `motir-core`
runs on.

#### §K — What SURVIVES the substrate change — verified against shipped code, not assumed

The change is far narrower than it looks, because the shipped meter is already
runner-agnostic. Verified at `origin/main` @ `2fde16c5`:

| Survives                       | Why, with the evidence                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The meter (MOTIR-1896)**     | `lib/services/ciMinutesMeterService.ts:253` reads the run's jobs through `provider.fetchWorkflowRunJobs`, which `lib/git/providers/github.ts:331` implements as the attempt-scoped `GET /repos/{o}/{r}/actions/runs/{id}/attempts/{n}/jobs`. **Self-hosted jobs are reported by that same endpoint**, with real `started_at` / `completed_at` / `labels` — so fleet runs are metered the day the fleet exists. **MOTIR-1896 needs NO change.** |
| **The rate table (§3.3)**      | `lib/ciMetering/runnerRates.ts:65` is already the effective-dated `(family, effectiveFrom)` table §3.3 specified, and each metered row stores raw wall clock + label + applied multiplier. A new runner family is **a new row, never a backfill** — which is exactly the shape this amendment needs.                                                                                                                                           |
| **The dispatch gate (§6.3)**   | `lib/services/ciAllowanceService.ts` shipped `getEntitlementState` + the zero-balance refusal (MOTIR-1901, merged 2026-07-30). The refusal is about a balance, not about a machine.                                                                                                                                                                                                                                                            |
| **Pool, attribution, panel**   | §4, §5 and §7 are denominated in Linux-equivalent minutes and keyed on the repository OWNER. Neither quantity mentions a runner.                                                                                                                                                                                                                                                                                                               |
| **The `isMeta` bypass (§4.4)** | The meta org skips the meter and the pool, and so skips this decision too — see §O for the axis trap this creates.                                                                                                                                                                                                                                                                                                                             |

This is why §1–§4 are marked UNCHANGED rather than re-derived: nothing in them referenced the
substrate in the first place.

#### §L — Question 1: does the customer-facing price change? **NO. Nothing in §1 or §2 is re-opened.**

The allowance (**300 Linux-equivalent min/seat/month**, 1,000-minute per-org floor) and the
rate (**1 credit = 1 Linux-equivalent minute**) were derived from GitHub's `$0.006`/min
Linux 2-core numéraire. Motir's own fleet cost is roughly **$0.0005–0.001/min** on spot
compute — a **6–12× lower cost basis for the identical workload**.

**Decision: keep the customer-facing numbers exactly as shipped; re-derive nothing.** Three
reasons:

- **The allowance was set against the value a seat gets, not against Motir's margin.** §1's
  load-bearing argument is the AI-plan denominator — how many dispatches a funded plan
  implies — and that argument does not move when Motir's cost per minute does.
- **§1's numbers shipped days ago and are a user-visible commitment.** Re-pricing them on the
  same week is churn against a promise, in exchange for nothing the user asked for.
- **The improved margin is what funds the fleet's own operating cost**, which §P makes a real,
  metered line rather than an assumption.

**Recorded as a MARGIN note, not as a rate change:** at the shipped §2 rate a
Linux-equivalent minute retails at ~$0.01 and now costs Motir ~$0.0005–0.001 instead of
$0.006 — the §2.2 "40% gross margin" figure holds only for the GitHub-hosted remainder, and
overage on fleet-run CI is materially better than that. **If a future decision wants to pass
the saving on, it re-opens §1 with its OWN card** — not this one, and not silently. Note the
precondition: MOTIR-1924 is what makes the real margin _measurable_, so any such re-opening
should wait on it rather than on the estimate above.

> **⛔ CORRECTED 2026-08-01 (MOTIR-1918) — the `~$0.0005–0.001/min` figure above is wrong for
> the provider actually chosen.** It was a category estimate ("spot compute is cheap"), and
> the fleet does not run on spot compute: it runs on **Fly Machines**. The real basis for a
> Linux-2-core-equivalent runner is **~$0.00195/min** (`performance-2x` + 4 GB extra RAM,
> computed from Fly's published table) — **2–4× this estimate**, so the improvement over
> GitHub-hosted is **~3.1×, not 6–12×**, and the fleet's gross margin is **~80.5%**, not
> ~90–95%. **The DECISION above is unchanged**: the customer-facing numbers still do not
> re-open, re-opening §1 still needs its own card, and it should still wait on MOTIR-1924
> making the margin a measurement. Only the figure moves. Derivation and sources:
> `docs/decisions/ci-runner-fleet.md` §8.

#### §M — Question 2: the Motir fleet family meters at **×1.00 — a PRODUCT decision, deliberately NOT a cost ratio**

§3.1 defines the multiplier as a **price ratio against the Linux 2-core numéraire**, and its
purpose is to make heterogeneous runners comparable **to the customer**. Pricing the fleet at
its true cost ratio (~×0.1) would silently hand every org ~10× more effective CI — which is
decision §L by the back door, made in a rate table instead of in the open.

**Decision: the fleet's runner spec is fixed to be LINUX-2-CORE-EQUIVALENT, and the family
meters at ×1.00 — parity with what the user was already promised.** So §3's table now carries
one row whose multiplier is a _product_ decision while every other row remains a cost ratio,
and **the ADR says so explicitly**, because an undocumented ×1.00 reads to the next reader as
a missing row rather than a decided one.

**⚠️ The fleet's `runs-on` LABEL is load-bearing, and the shipped classifier is why.**
`classifyRunner` (`lib/ciMetering/runnerRates.ts:116`) walks a job's labels and returns on the
**first substring match**, in this order: a larger-runner pattern (`N-core` / `large` /
`xlarge`) → `unknown`; then `macos`/`osx`, `windows`, `arm`, and finally
`ubuntu`|`linux` → `linux_x64`. Two failure modes fall straight out of that, and both are
silent:

- **A label containing `linux` classifies as the GitHub `linux_x64` family** — a _priced_ row
  — so the fleet would meter at ×1.00 while being **indistinguishable from GitHub-hosted
  Linux** in `runnerBreakdown`, and MOTIR-1923's row would never be exercised. The numbers
  would be right and the attribution would be wrong, which is the worst kind of correct.
- **A label containing `2-core` / `large` classifies as `unknown`** — the §3.4 fallback —
  which meters at the same ×1.00 but **logs a warning on every single fleet run forever**,
  drowning the one signal §3.4 exists to give.

**Binding on MOTIR-1916's cards:**

1. **Register fleet runners with `--no-default-labels`** and exactly one distinctive custom
   label (GitHub otherwise auto-assigns `self-hosted` + the OS + the architecture — see §R).
2. **The label must contain none of** `ubuntu`, `linux`, `arm`, `windows`, `macos`, `osx`,
   and must not match `N-core` / `large` / `xlarge`. A name like **`motir-runner`** satisfies
   both; `motir-linux-2core` fails both.
3. **MOTIR-1923 adds a `motir_fleet` family** to `RunnerFamily`, a `classifyRunner` rule that
   matches that exact label **before** the OS matches, and an effective-dated
   `multiplier: 1.0` row carrying the §L rationale — so a fleet job is priced, attributed to
   its own family, and does **not** trip §3.4's warning.
4. **`usdPerMinute` on that row records MOTIR'S OWN cost, not GitHub's**, and is therefore
   the one place where the row's price and its multiplier are deliberately not a ratio of
   each other. Say so in the row's comment, or the next reader will "fix" it.

**An honest unknown, named rather than assumed** (following §F's precedent): GitHub's REST
reference for workflow jobs lists `labels` in the response schema without defining whether it
reports the labels **requested** by `runs-on` or the labels the **runner** carries. The rules
above are written to hold **either way** — a `--no-default-labels` runner with one custom
label produces the same single-element set under both readings. **MOTIR-1920 must record which
it is** from the first real fleet run, and MOTIR-1923's classification rule is then confirmed
rather than assumed.

#### §N — Question 3: a handed-over repo — the runner-selection seam, verified against GitHub's expression semantics

This is the one question with a **user-visible failure mode**. MOTIR-711 transfers a
Motir-owned repo to the user's own GitHub. If the starter's workflows hardcode
`runs-on: [self-hosted, motir]`, a transferred repo has **zero runners**: its CI queues
silently, and GitHub drops the queued jobs after 24 hours. The user's takeaway would be
_"Motir handed me a repo whose CI is broken"_ — at the exact moment the product is trying to
prove the opposite.

**Decision: the workflow selects its runner through a configuration VARIABLE with a
GitHub-hosted default.**

```yaml
runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}
```

`MOTIR_RUNNER` is set at the **org level on `motir-projects`** while Motir owns the repo, and
is simply absent in the user's account after the transfer. The repo is then **portable by
construction**: it runs on Motir's fleet for free while Motir hosts it, and on the new
owner's own GitHub minutes the moment they own it — **with no edit to the workflow file, and
nothing for MOTIR-711 to remember to do.**

**Verified against GitHub's own docs, not assumed** (the card required this; sources in §R):

- **`vars` is available in `runs-on`.** The contexts reference's availability table lists
  `jobs.<job_id>.runs-on` with the contexts _"github, needs, strategy, matrix, vars,
  inputs"_. This is the load-bearing check — a context not on that row would make the whole
  expression a non-starter.
- **An unset variable is an empty string.** _"If a configuration variable has not been set,
  the return value of a context referencing the variable will be an empty string"_, and _"if
  you attempt to dereference a nonexistent property, it will evaluate to an empty string"_.
- **An empty string is falsy.** The expressions reference: _"in conditionals, falsy values
  (`false`, `0`, `-0`, `""`, `''`, `null`) are coerced to `false`"_. So the `||` fallback
  resolves to `ubuntu-latest` when the variable is absent — the explicit
  `${{ vars.MOTIR_RUNNER != '' && … }}` form the card offered as a hedge is **not needed**.
- **A single custom label is a valid `runs-on`.** A job is queued on a runner carrying **all**
  the labels listed, so one distinctive label selects the fleet — which is also what §M
  requires for classification.

**Consequences, each owned:**

- **MOTIR-1925 / MOTIR-1926** apply the seam to the two starters — **5 job sites** in
  `nextjs-prisma-vercel-starter` (4 in `ci.yml` + 1 in `cleanup-preview-deployments.yml`) and
  **6** in `nextjs-prisma-vercel-starter-with-design` (5 + 1), counted at `origin/main` on
  2026-07-31. **Every** site, or a transferred repo half-works, which is worse than not
  working.
- **MOTIR-711 (the takeover) gains no new step from this**, and that is the point: the
  fallback is what makes the handoff safe, instead of a "remember to rewrite the workflows"
  item that will eventually be forgotten. It should still **assert** the transferred repo's
  first run picks `ubuntu-latest`, because the failure is silent and a queued job looks like
  a slow job.
- **§J's exclusion is expressed by the same seam:** `moooon-B-V` simply never sets
  `MOTIR_RUNNER`, so Motir's own repos take the `ubuntu-latest` default with no per-repo
  configuration and no divergent workflow files.
- **MOTIR-1908's $0 limit is the fail-fast for this path.** If `MOTIR_RUNNER` is
  mis-set or unset on `motir-projects`, jobs fall back to GitHub-hosted and the $0 spending
  limit turns a silent cost into a loud failure.

#### §N.1 — The WRITER: org scope confirmed, `visibility: private`, and why the handover needs no unset (MOTIR-2015, 2026-08-02)

**§N said the variable "is set at the org level" and no card ever set it.** The reader shipped
(MOTIR-1925, 5 job sites) and the writer was nobody's deliverable, so
`GET /orgs/motir-projects/actions/variables` was **empty**: `runs-on` always resolved to
`ubuntu-latest`, no queued job's requested labels ever carried the fleet label, and
`isMotirFleetJob()` refused **every** job that would ever exist. MOTIR-2015 ships the writer
and settles the three things §N left implicit.

**1 · The level is ORGANIZATION. Confirmed, not re-opened — and now also forced by the
grant.** §7.3 of `ci-runner-fleet.md` already treats org-level as the baseline and names the
**repository** level as a _reserved lever_ ("the fallback, if a group ceiling binds"), which
per-project runner groups holding empirically (MOTIR-1928, 2026-08-02) means is not needed.
Spending that lever as the default would leave nothing in reserve for the case it exists for.
Independently: MOTIR-2016 granted `motir-studio` **`organization_actions_variables: write`**
and _not_ the repository-level `variables` permission, so the org path is the only one the
credential reaches. **A repo-level default is therefore both unnecessary and, today,
impossible** — and the code says so structurally: `lib/github/actionsVariables.ts` ships
**no repository-scoped writer at all**.

**2 · The handover needs NO unset, and the mechanism is the scope itself.** An organization
variable is a property of the **org**, not of the repository. MOTIR-711 transfers the
repository OUT of `motir-projects`, so it stops resolving `motir-projects`' variables the
instant the move lands — `vars.MOTIR_RUNNER` is empty in the new owner's account, `runs-on`
falls back to `ubuntu-latest`, and there is no call to make, no ordering to get right, and
nothing to retry. This is what §N's "nothing for MOTIR-711 to remember to do" was always
resting on; it is now stated as the load-bearing property it is.

> ⚠️ **The repo-level alternative would have inverted this.** Repository variables take
> **precedence** over organization ones and travel **with** the repository, so a handed-over
> repo would keep asking for `motir-runner` in an account where no runner will ever register —
> and a job nobody can serve does not fail, it **queues until GitHub expires it at 24 hours**.
> The `|| 'ubuntu-latest'` fallback only rescues a repo whose variable is _absent_. So the
> unset would have had to live in the takeover saga, ordered **before** the transfer for the
> same reason §G orders the Actions re-enable before it: afterwards the provisioning App no
> longer reaches the repository, making a missed unset permanent. **If §7.3's per-project-label
> fallback is ever taken, the unset ships in the same diff as the repo-scoped write** —
> `projectRepoTakeoverService`'s header carries this note at the site that would own it.

**3 · `visibility: private`, not `all`.** The variable is scoped to the org's **private**
repositories — exactly the set Motir provisions (both creation paths pass `private: true`).
The fleet's runner groups carry `allows_public_repositories: false` (§7, a fork's PR can
execute arbitrary code on a self-hosted runner), so a **public** repo in Motir's org that
resolved this variable would request a runner the group may never give it, and queue for 24
hours rather than fail. Scoping to private makes that repo fall back to GitHub-hosted instead:
**the one visibility the fleet refuses to serve is the one that never sees the variable.**

**Where it is written, and what it costs.** `fleetRunnerVariableService.ensureQuietly()` runs
in `projectRepoProvisioningService.establishSet`, immediately after the runner-group sync and
**before any repository exists** — the same race the group's ordering closes, since an
initialised row's CI-stub commit is a push that queues a job seconds after the repo appears.
It is org-wide, so it is one conditional `GET` per establish **run** (not per row) and no write
once the value is right; re-running it is also the **self-healing** path for a variable an
operator deletes or edits by hand. Quiet by the same contract as the group (ADR §4.2): a
repository whose variable could not be written is a working repository whose CI runs
GitHub-hosted — which is precisely what the fallback is for — never a failed establishment.

**The value comes from `MOTIR_RUNNER_LABEL`, imported.** Never a second literal: §M's
constraints and MOTIR-1964 already record what one duplicated `'motir-runner'` cost, and a
literal _here_ would be worse than that one, because this is the value GitHub actually serves
to workflows. Edit it alone and every job requests a label the gate no longer recognises — the
fleet stops booting while every workflow still reports green. A test fails if the literal
reappears at the write site.

#### §O — Label-scope the `workflow_job` listener; `isMeta` and `moooon-B-V` are DIFFERENT AXES

**The `workflow_job` `queued` event fires for GitHub-hosted jobs too** — including every one
of `motir-core`'s 31 jobs, which land in the same App installation. A provisioning listener
that reacts to _"we received a queued event"_ would silently pull Motir's own 141-job-minute
matrix onto the fleet — the precise outcome §J exists to prevent, arriving through the back
door.

**Binding on MOTIR-1920: provision ONLY for jobs whose requested labels name the Motir
runner.** Scope by **label**, not by receipt of an event, and not by repository owner alone —
label is the only signal that survives a repo being added to the org later. (There is no
`workflow_job` handler in the repo today — verified by grep at `2fde16c5` — so this is a
constraint on new code, not a correction to shipped code.)

**And the axis trap, stated because the two coincide today and will not always:**

| Axis                             | What it is                              | Where it is known                                                       |
| -------------------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `Organization.isMeta`            | a **Motir tenant** flag (§4.4)          | after `resolveTenantOrg` — i.e. after a repo→project→workspace→org join |
| `moooon-B-V` vs `motir-projects` | a **GitHub org** the repository sits in | on the webhook payload itself                                           |

They point at the same set of repositories **right now**, which is exactly what makes the
confusion cheap to make and expensive to find. **The fleet exclusion must be enforced on the
GitHub-org/label axis**, because the `workflow_job` listener decides whether to provision
**before** it has any tenant context — and a tenant lookup is not available at that moment
for a repo that has no project row at all.

#### §P — The customer-facing MINUTE and MOTIR'S COST are now two quantities with two meters

Before the fleet, these were the same number seen from two sides: GitHub billed Motir for the
minute it also charged the user for. **They are now independent.**

| Quantity                         | Unit                     | Measured by                                                              | Owner                |
| -------------------------------- | ------------------------ | ------------------------------------------------------------------------ | -------------------- |
| **What the customer is charged** | Linux-equivalent minutes | `ciMinutesMeterService` — Actions job wall-clock × multiplier (§3, §5.8) | shipped (MOTIR-1896) |
| **What the fleet costs Motir**   | container-seconds → USD  | **nothing today** — the cloud account running the runners                | **MOTIR-1924**       |

Neither existing meter observes the second one: the 9.0 gateway meters **tokens**, and
`ciMinutesMeterService` meters **Actions job wall-clock**. A container that boots, idles
waiting for a job, runs for four minutes and is torn down costs real money in a dimension
nothing in Motir currently reads. **MOTIR-1924 owns that meter**, attributed to the org so
the two numbers are comparable per tenant — which is what makes the §L margin a measurement
rather than an estimate, and therefore the precondition for ever re-opening §1.

#### §Q — §5.8's reconciliation, corrected: **GitHub-billed rows only**

§5.8 pairs the operational meter (webhook + jobs) with a monthly **audit** against the
enhanced-billing usage endpoint (`GET /organizations/{org}/settings/billing/usage`,
`product: Actions`), reconciled per repo via `repositoryName`.

**That endpoint reports what GitHub BILLED. Post-migration it reports ~0 for a fleet-run
repo** while the meter keeps counting a full month of minutes — so the audit would flag
**every repo, every month, at ~100% drift**, and a signal that always fires is not a signal.
The shipped `ciMinutesReconciliationService` compares metered totals against report lines it
selects with `isActionsComputeLine` (`lib/services/ciMinutesReconciliationService.ts:69`) and
warns past a tolerance — correct code, now pointed at a population that no longer matches.

**Corrected scope, in text; the code change is MOTIR-1924's:**

1. **The GitHub-billing audit covers GitHub-BILLED runs only** — the reconciliation compares
   the metered subset whose runner family is GitHub-hosted against the usage report, and
   **excludes fleet-run minutes from both sides**. §3.3's stored runner label per row is what
   makes that split possible after the fact, with no schema change.
2. **The fleet's own audit source is the cloud provider's usage/billing export** for the
   runner account, reconciled against §P's container-seconds meter. Two substrates, two
   reports, two reconciliations — never one report asked to explain both.
3. **A repo that MIGRATES mid-month is reconciled per source, not per repo-month.** Because
   each metered row already stores its runner label, a month containing both is split by the
   same predicate, and no row needs re-writing.
4. **Zero GitHub-billed minutes on a repo is a valid, expected state** — it must not be
   reported as 100% drift. It is the success condition of this amendment.

#### §R — Sources for this amendment (read 2026-07-31)

**Vendor documentation:**

- **Contexts reference** — the context-availability table (`jobs.<job_id>.runs-on` →
  _"github, needs, strategy, matrix, vars, inputs"_), _"if a configuration variable has not
  been set, the return value of a context referencing the variable will be an empty string"_,
  and _"if you attempt to dereference a nonexistent property, it will evaluate to an empty
  string"_: <https://docs.github.com/en/actions/reference/workflows-and-actions/contexts>
- **Expressions reference** — _"in conditionals, falsy values (`false`, `0`, `-0`, `""`,
  `''`, `null`) are coerced to `false`"_, the basis for the `||` fallback:
  <https://docs.github.com/en/actions/reference/workflows-and-actions/expressions>
- **Variables reference** — configuration-variable precedence (environment > repository >
  organization), which is why `MOTIR_RUNNER` is set at the ORG level and can still be
  overridden per repo:
  <https://docs.github.com/en/actions/reference/workflows-and-actions/variables>
- **Using labels with self-hosted runners** — a self-hosted runner is automatically assigned
  `self-hosted`, an OS label (`linux` / `windows` / `macOS`) and an architecture label
  (`x64` / `ARM` / `ARM64`); `--no-default-labels` suppresses them; custom labels may be used
  alone:
  <https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-labels>
- **Using self-hosted runners in a workflow** — a job is queued on a runner carrying **all**
  the labels listed in `runs-on`:
  <https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow>
- **Workflow jobs REST reference** — the jobs endpoint the meter reads; note its schema lists
  `labels` **without** defining requested-vs-runner semantics, which is the §M honest unknown:
  <https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28>
- **Self-hosted runner registration token** —
  `POST /orgs/{org}/actions/runners/registration-token`, listed under **Organization
  permissions for `"Self-hosted runners"`**, `write` — a **different** section from the
  repository permissions MOTIR-1779 registers (§O's consequence for MOTIR-1916):
  <https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps>

**Shipped `motir-core`, read at `origin/main` @ `2fde16c5`:**

- `lib/services/ciMinutesMeterService.ts:253` — the jobs-API read that makes §K's
  "MOTIR-1896 needs no change" true.
- `lib/git/providers/github.ts:331` — the attempt-scoped
  `/runs/{id}/attempts/{n}/jobs` call behind it.
- `lib/ciMetering/runnerRates.ts:65,116` — the effective-dated rate table and
  `classifyRunner`'s ordered substring matching, the basis for §M's label constraints.
- `lib/services/ciMinutesReconciliationService.ts:69` — `isActionsComputeLine`, the audit
  filter §Q re-scopes.
- `lib/services/ciAllowanceService.ts` — MOTIR-1901's shipped entitlement + refusal.
- `.github/workflows/ci.yml` — the eight `runs-on` sites and three matrices behind §J's
  31-job figure; also the `docs/`-prefix branch gate this amendment's own PR rides.
- `nextjs-prisma-vercel-starter` (5 job sites) and
  `nextjs-prisma-vercel-starter-with-design` (6), counted for §N.

### Amendment 2026-10-29 (MOTIR-5777) — preview usage is counted in the pool

**Status:** accepted · **Date:** 2026-10-29 · **Card:** MOTIR-5777 (Story MOTIR-5766) ·
**Decided by:**
[Decision — hosting Motir repositories](https://app.motir.co/pages/cmvrcywwc00jkhpr1zvvnike8)
(MOTIR-5769, §9 "Preview cost through the CI allowance"). That page is a published Motir page,
not a file in this repository; this amendment is its in-repo pointer, and the page is the
authority for every figure below.

**What changes.** Every pull request on a Motir-hosted web repository gets a live preview on
Motir's own Fly or serverless account and a Neon branch (Story MOTIR-5766). That usage is
charged through this allowance rather than a second bill:

- It is converted to **Linux-equivalent minutes** at the factors below and counted in the
  **same per-seat pool** (§1). `ciMinutesMeterService.getOrgPeriodConsumption`, the one read
  the entitlement measures against, returns CI minutes plus preview minutes, with a `bySource`
  breakdown. `CiEntitlementStateDTO.consumedBySource` carries that breakdown to a usage
  surface.
- Past the pool, overage is charged by the **shipped charge**
  (`ciAllowanceService.chargeForMeteredRun`) as the existing **`ci_overage`** ledger kind at
  §2's 1 credit per minute. **No ledger kind is added**, and motir-ai's `src/creditKinds.ts`
  is not widened.
- **Motir's own cost** is recorded on every slice beside the minutes (`preview_usage.motir_cost_usd`),
  at the same list prices, as §P keeps the customer's minute and Motir's cost as two
  quantities.

**The factors**, as the decision page states them, against GitHub's Linux 2-core rate of
**$0.006 a minute** (unchanged; [GitHub](https://docs.github.com/en/billing/reference/actions-runner-pricing)):

| Usage                    | Source price                                            | Read                                   | Linux-equivalent minutes      |
| ------------------------ | ------------------------------------------------------- | -------------------------------------- | ----------------------------- |
| Fly Machine running time | `shared-cpu-1x` 512 MB **$3.69/month** (≈ $0.0000014/s) | 2026-10-28 (2026-09-19: $0.00000128/s) | **0.0140 per running minute** |
| Neon compute             | Launch **$0.106 per CU-hour**                           | 2026-10-28 (unchanged)                 | **17.7 per CU-hour**          |
| Lambda compute           | x86 **$0.0000166667 per GB-second**                     | 2026-10-28                             | **0.167 per GB-minute**       |
| Lambda requests          | **$0.20 per million requests**                          | 2026-10-28                             | **33.3 per million requests** |
| AWS previews             | the tenant's own account cost                           | —                                      | **not converted**             |

**How it is metered.** `preview_usage` holds one row per accrual slice, keyed
`(preview, kind, slice end)`. An hourly job (`system.preview-usage-accrual`) records each live
preview's usage since its last slice, so a preview that lives for weeks is charged in the
month it ran. The final slice is written when the preview's app or branch is destroyed: the
composition root (`lib/orchestrator/index.ts`) observes the deploy and database ports'
destroys, so the preview lifecycle itself calls no billing code. The figures live in
`lib/ciMetering/previewRates.ts`; a price change on the decision page is a change there and a
new dated line here.

**What this does not decide.** Whether an exhausted organisation's previews stop is the
decision page's call, and it has not made it; nothing here refuses a preview. Production
metering of a hosted app is
the "running a live app" story's (MOTIR-9799).

## Consequences

**The four gated cards, and what each takes from here** — the test of this ADR is that
none of them needs a further question:

- **MOTIR-1896 (motir-core, the meter).** Read per §5.8 — **not** `/timing` and **not** the
  product-specific billing API, both of which are closing down: accumulate from the
  `workflow_run` completion webhook plus that run's **jobs**, summing `ceil()` per job, and
  reconcile monthly against the enhanced-billing usage endpoint. Normalize by §3's
  cost-proportional multipliers, storing raw wall clock + runner label + multiplier applied.
  Key per-period rows by **calendar month UTC** (§4.5) — a pure function of the run
  timestamp, so the meter reads no billing state. Gate on **the run's own repository owner**
  being Motir's org (§5.1, §5.5), not on a project column; the edge cases in §5.4 are each a
  decided behaviour. Idempotent on **`(run_id, run_attempt)`**. The table is
  workspace-scoped (`workspace_id` + RLS) per the shipped contract.
- **MOTIR-1901 (motir-core, the allowance + overage).** Pool = `max(members × 300, 1000)`,
  recomputed from membership at read (§4.2, §4.6), with the no-subscription case (§4.3) and
  the `isMeta` bypass (§4.4). Charge **incrementally, at the metering event, against the
  pool as it stood then** — never by re-summing the period, so §4.6's seat-removal case
  cannot back-bill. Rate 1 credit per Linux-equivalent minute (§2). Refuse at dispatch on
  balance ≤ 0 with `CiCreditsExhaustedError` (§6.2–6.3), accepting the bounded in-flight
  overshoot (§6.4). The read-derived write is **contended** — lock the row and re-read
  inside the transaction, and ship the real-concurrency test; the debit is a cross-boundary
  side effect that runs after the local commit (§8.6).
- **MOTIR-1899 (motir-ai, the ledger).** One new debit kind for CI overage with its own
  idempotency key. Today `CreditTransaction.planningTurnId @unique` is the only idempotency
  hook and it is AI-turn-shaped, so a CI debit needs its own — keyed on the metering event,
  not a planning turn. Nothing else about the ledger changes.
- **MOTIR-1902 → MOTIR-1903 (the billing panel).** A third line, "Motir CI" (§7.1), with
  the seven items of §7.3 — including the two states named in §6 and the deliberate
  reset-date mismatch §4.5 creates. **Item 5 is the amendment's §D**, not §7.3's original
  line: a two-option decision for an admin, an alert for a member, measured against a real
  laptop viewport, with `zh.json` parity on every new string.
- **MOTIR-1907 (motir-core, the repo-side pause) — added by the 2026-07-30 amendment.**
  `PUT /repos/{o}/{r}/actions/permissions` over the org's Motir-owned rows only (§A, §C),
  authenticated with the provisioning App's existing `Administration: write` and adding **no
  new permission**. Store the intent per row and re-assert it with a 15-minute convergent
  sweep; resume on the ledger's balance-positive event with that sweep as the backstop (§B).
  After the local commit, degrading gracefully; idempotent both ways; `isMeta` and
  `MOTIR_CLOUD=false` bypassed (§F). It must also **measure** what a disable does to a run
  already queued or in progress and record it (§F).
- **MOTIR-1908 (manual, the org budget) — added by the 2026-07-30 amendment.** One org-wide
  Actions budget on `motir-projects` at **$500/month with `stop usage` OFF**, alerts at
  **75 / 90 / 100%** to named recipients (§E). Record the value, the date, the recipients, and
  what binding does from observation — and that this limit is **never** the per-tenant gate.
- **MOTIR-711 (the takeover) — constrained by the amendment.** Re-enable Actions on each
  repository **before** the transfer, while the provisioning credential still reaches it
  (§G), and own the collection of the transfer destination, since motir-core stores no
  per-user GitHub identity (§D). **Added by the 2026-07-31 amendment:** it gains no new
  workflow-rewriting step — §N's `vars.MOTIR_RUNNER` fallback makes the repo portable by
  construction — but it should **assert** the transferred repo's first run lands on
  `ubuntu-latest`, because the alternative failure is a silently queued job, not an error.

**The fleet cards, added by the 2026-07-31 amendment (MOTIR-1915) — all under Story
MOTIR-1916**, which builds everything that amendment records:

- **MOTIR-1918 (decision, what runs the runners).** Reuse Epic 9's container-per-run
  orchestrator (MOTIR-685), a managed runner provider, or ARC — and the interface that lets it
  be swapped. The fleet's spec is constrained by **§M**: Linux-2-core-**equivalent**, because
  the ×1.00 row is a parity promise, not a measurement of whatever hardware is convenient.
- **MOTIR-1920 (motir-core, the `workflow_job` queued handler).** **LABEL-SCOPED** (§O):
  provision only for jobs whose requested labels name the Motir runner — never on "an event
  arrived", which would pull `motir-core`'s own 31-job matrix onto the fleet. It must also
  **record** whether the jobs API's `labels` reports requested or runner-side labels (§M's
  honest unknown), which confirms MOTIR-1923's classification rule.
- **MOTIR-1923 (motir-core, price the fleet family).** A `motir_fleet` `RunnerFamily`, a
  `classifyRunner` rule matching the fleet label **before** the OS matches, and an
  effective-dated **×1.00** row whose comment carries §L/§M's rationale — a **product** rate,
  not a cost ratio, and not §3.4's unpriced fallback. Its `usdPerMinute` records Motir's own
  cost, so that row alone is deliberately not a ratio of its own price.
- **MOTIR-1924 (motir-core, meter what the fleet COSTS + re-scope the reconciliation).**
  Persist per-runner container-seconds and cost attributed to the org (§P — the second meter,
  since neither the gateway nor `ciMinutesMeterService` observes it), and re-scope §5.8's
  audit to **GitHub-billed rows only**, with the cloud provider's usage export as the fleet's
  own audit source (§Q). Zero GitHub-billed minutes on a repo is the SUCCESS state, not 100%
  drift.
- **MOTIR-1925 / MOTIR-1926 (the two starters, the runner-selection seam).**
  `runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}` at **every** job site — 5 in
  `nextjs-prisma-vercel-starter`, 6 in `nextjs-prisma-vercel-starter-with-design` — verified
  against GitHub's contexts/expressions semantics in §N. Half-applied is worse than not
  applied.
- **MOTIR-1908 (manual) — re-pointed, not re-scoped.** The `motir-projects` spending limit
  becomes the **fail-fast for the `ubuntu-latest` fallback path** (§J.3, §N): $0 there, a real
  non-zero limit on `moooon-B-V`, which one account cannot express.
- **MOTIR-1896 needs NO change, and MOTIR-1779 is NOT modified.** §K records why the meter
  survives verbatim (the jobs endpoint reports self-hosted jobs), so no later card re-opens
  it. MOTIR-1779's permission set stays exactly as registered; the **`Self-hosted runners`
  ORGANIZATION permission** the registration-token endpoint needs is a different section of
  the permissions page and belongs to MOTIR-1916 as its only consumer (§O, §R).

**Two corrections this ADR makes to its own card, recorded so they are not re-derived:**

1. **`Windows ×2 / macOS ×10` is the wrong basis.** Those are included-minutes drain
   multipliers, not price ratios; the real ratios are ×1.67 and ×10.33 (§3.2).
2. **~20 minutes per dispatch undercounts by roughly half.** The starter's CI runs on
   `pull_request` **and** `push: main`, so a merged dispatch bills the suite twice —
   ~39 minutes, and that is a floor (§Context).

**And one correction this ADR makes to ITSELF, kept visible rather than quietly edited
out.** A draft of this record claimed the exposure was narrower than the card said — that
§3.1/§3.3 of the repo-set ADR put repos in the user's account whenever a GitHub identity
was connected, so only some projects cost Motir anything. **That was wrong**: it was read
against a `main` that predated the **2026-07-30 MOTIR-1893 amendment**, which removed the
branch and made every created repo Motir-owned. The card's original framing was right. The
number and the floor are unchanged — they never rested on that claim, since §1.1's
load-bearing argument is the AI-plan denominator, not a smaller metered population — but
the margin of safety is thinner than the draft implied, which is why **§1.5 now states the
risk explicitly** instead of discounting it. (Method note for the next reader: this ADR's
Status line pins the exact `origin/main` SHA it was written against, and the amendment
landed between the initial read and the write. Re-fetch before trusting a §-reference.)

**What is deliberately NOT decided here**, so nobody reads silence as an answer:

- **The real per-dispatch minute figure.** §Context's ~39 is derived from the workflow's
  shape, not measured. MOTIR-1896's meter produces the measurement, and §1.4 names the
  trigger for revisiting the 300.
- **Whether CI minutes are purchasable directly.** Overage draws from the existing credit
  balance; there is no separate CI minutes SKU and no new Stripe Price. If one is ever
  wanted, it is a new card and an amendment here — not a gap to fill quietly.
- **Rate-limiting or concurrency caps on dispatch.** The pool bounds spend; it does not
  bound burst. Nothing today needs it, and inventing a limiter with no observed problem
  would be work with no consumer. _(2026-07-31: the fleet DOES need an in-flight cap, but
  that is a capacity limit on Motir's own machines, not a customer entitlement — it belongs to
  MOTIR-1916, not here.)_
- **Whether the §1 allowance is re-derived from the fleet's cheaper cost basis.** §L says
  explicitly **not now**, and records the new basis as a margin note. Passing the saving on is
  a re-opening of §1 with its own card, and it should wait on MOTIR-1924 making the margin a
  measurement rather than an estimate.
- **Which orchestrator runs the fleet.** §M fixes what the runner must be _equivalent to_;
  MOTIR-1918 decides what actually runs it. **DECIDED 2026-08-01 —
  `docs/decisions/ci-runner-fleet.md`:** Motir-operated **Fly Machines**, in a **separate Fly
  organization**, behind a `ContainerOrchestrator` port. That record also **corrects §L's
  margin note** (see the ⛔ block there), supplies MOTIR-1923's `usdPerMinute`, and answers
  the fleet's spend-ceiling question — **Fly offers neither a cap nor an alert**, so the
  binding ceiling is product-side, in MOTIR-1922's gate.

**Related planning bugs.** MOTIR-1904 records that this card's earlier revision promised its
implementers "no further questions" while its "what the user sees" answer had no owning
surface — the gap MOTIR-1902/1903 now close, and which §7 is written to specification level
because of. **MOTIR-1909** records the larger one the 2026-07-30 amendment corrects: this
record REJECTED "run it and go negative" in §6.2 and then placed the refusal on the
**dispatch** path, which is not the path that spends the money — a mechanism the reasoning
assumed existed rather than a hole in the reasoning. **MOTIR-1917** records the third and
largest: this record priced the minute (§1–§3), metered it (§5) and enforced it (§6 + the
2026-07-30 amendment) across four decision cards **without ever asking who owns the compute**
— so the compute itself was an unowned deliverable, and the answer, once asked, changed
Motir's cost basis by an order of magnitude while changing the customer model not at all
(2026-07-31 amendment).
