# ADR: Open-core tiering + pricing model (free PM-core ↔ paid AI; credit-metered; the cloud entitlement caps)

- **Status:** Accepted (2026-06-21, locked with Yue; **catalog provisioned in
  Stripe sandbox 2026-06-22** per the §3 + §6 reconciliations below). This is the
  rung-1 pricing decision Story 8.1 implements — no billing code ships until it
  is locked. **Amended 2026-06-23 + 2026-06-24 + 2026-09-04 + 2026-09-25 + 2026-09-26 + 2026-10-21 + 2026-10-23 — see below.**
- **Credit model:** the rates, the token→credit conversion and the ledger this ADR
  builds on are specified in `motir-ai/docs/credit-model.md`, owned by the closed
  side (where the ledger lives). Every citation of it below is repo-qualified for
  that reason — the file is not in this repository.
- **Amendment (2026-09-04, MOTIR-4331) — the two-lane credit margin is OWNED by
  MOTIR-4331, and the implementation is a `lane` dimension on `ModelCreditRate`.**
  §2's DECISION assigned both the implementation and the calibration to Epic 9
  (MOTIR-673) and named two implementations without choosing. MOTIR-4331 (a story of
  the AI-economics epic MOTIR-4329) takes the implementation; Epic 9 stays the lane's
  first CONSUMER. The chosen implementation is the use-case **dimension**, not the
  per-lane model key. See the amendment in §2.
- **Amendment (2026-06-24, 8.1.22 / MOTIR-1316) — every PAID AI plan BUNDLES 1 tracker seat.**
  A paid Motir AI plan (Standard / Pro / Max) now **includes 1 tracker seat → the
  org's §4 caps are lifted** (`scaled`). Why: the solo plan-with-AI journey was
  broken — a solo user buys AI to plan, the planner generates work items, and they
  hit the **250 free-tracker cap**, blocked from storing the plan they paid the AI
  to produce. **Seat accounting: the first seat is included** — billable
  scaled-tracker seats = `max(0, members − 1)`; a solo org pays only the AI fee
  (caps lifted, $0 seat), a team pays $5/seat beyond the first. The **Free one-time
  trial is NOT** included (stays bounded at 250). This **partially supersedes** the
  "FULLY independent" framing in §1 and the "an AI plan never lifts a cap" rule in
  §4 (both updated below). Implemented by 8.1.23 (MOTIR-1317, motir-ai propagation)
  and 8.1.24 (MOTIR-1318, motir-core entitlement + seat accounting); storefront copy
  by 8.1.17 (MOTIR-1304). AI fee unchanged (cap-lift COGS ≈ nil; a seat is cents).
- **Amendment (2026-06-23, 8.1.18 / MOTIR-1308) — the `starter` AI tier is REMOVED.**
  The AI ladder is now **Free (300, one-time) · Standard · Pro · Max · Enterprise**
  — four named paid plans plus the free trial (was five). Why: Starter (300 cr/mo @
  $5) bought only **~1 planning pass/mo** (a pass is ~150–250 cr) — a _paid trial_,
  redundant with the one-time 300-credit `free` grant — and the $5 fee structurally
  capped it at **~350 credits** before its $16.67/1k rung would invert the
  bulk-discount curve, so it could not be made usable without rescaling the whole
  ladder. **Standard ($25 / 2,000 cr ≈ ~10 passes/mo)** is now the entry paid AI
  plan. Implemented by **8.1.19 (MOTIR-1309** — motir-ai migration + seed drop the
  `starter` `PlanTier`) and **8.1.20 (MOTIR-1310** — archive the `starter_pool_*`
  Stripe Prices); the four-tier storefront by **8.1.21 (MOTIR-1311** design) →
  **8.1.17 (MOTIR-1304** UI). The sections below reflect the amended four-tier
  model; the historical "what shipped" bullets (§Consequences) note the original
  five-row provisioning since walked back.
- **Story / Subtask:** 8.1 (Stripe billing + open-core tiering) · Subtask 8.1.1 (MOTIR-1138)
- **Supersedes / superseded by:** none. **Relates to / absorbs** MOTIR-1106
  (8.6.2 "Decide pricing strategy: free PM-core ↔ paid AI boundary") — that card
  is the same decision in Epic 8.6 and should be closed as a duplicate of this ADR.
- **Builds on:** `organization-tier.md` (the `Organization` = billing entity +
  `Organization → N Workspace → Project` hierarchy + progressive disclosure +
  signup auto-provisioning). This ADR adds the **commercial layer** (tiers,
  prices, entitlement caps, lifecycle) ON TOP of that tenancy model — it changes
  no tenancy shape.
- **Consumed by:** 8.1.2 (MOTIR-1141, Stripe Products/Prices/webhook/Portal/tax
  — **DONE in sandbox 2026-06-22**), 8.1.3 (MOTIR-1142, billing/paywall design),
  8.1.4 (MOTIR-1145, motir-ai Stripe customer/subscription schema), 8.1.4b
  (MOTIR-1230, idempotent webhook → tier/credit state), 8.1.5 (MOTIR-1146,
  Checkout + Portal endpoints), 8.1.6 (MOTIR-1147, billing boundary service),
  8.1.7 (MOTIR-1148, billing settings + plan UI), 8.1.8 (MOTIR-1149,
  AI-boundary paywall), 8.1.9/8.1.10 (tests/E2E) — **and two NEW subtasks
  this ADR surfaces as planning gaps** (see Consequences): **8.1.11**
  (entitlement/cap enforcement) and **8.1.4c** (scaled-tracker subscription
  propagation motir-ai → motir-core, surfaced 2026-06-22 during MOTIR-1141
  dispatch).

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `organization-tier.md`): a decision record is a markdown file under
> `docs/decisions/`, structured **Status → Context → Decision → Consequences**,
> with the load-bearing facts pinned in explicit tables so downstream code has one
> authoritative source to implement against. **No application behaviour ships in
> this subtask** — the shapes it freezes are what make the rest of Story 8.1
> buildable.

---

## Context

Epic 8 turns Motir into a commercial product. The open-core thesis (`_shared.md`,
`vision.html` Principle #19) is fixed: **`motir-core` (the PM tracker) is
free/open-source forever; the AI layers (`motir-ai` — Epic 7 planning + Epic 9
hosted coding) are the paid product**, metered/gated at the `motir-core ↔
motir-ai` boundary. This ADR locks how that thesis becomes Stripe Products,
PlanTiers, and enforcement.

Three things were already shipped or decided and this ADR must **reconcile
against them, not re-invent them**:

1. **The billing entity is the `Organization`** (`organization-tier.md` §3, locked
   with Yue; `prisma/schema.prisma` — the `Organization` model). Usage and billing
   roll up to the org; one account may belong to multiple orgs (N:N membership);
   signup auto-provisions exactly one org + one default workspace
   (`organization-tier.md` §6).

2. **The metered unit is the `credit`** — an internal usage unit, **never a
   currency** (`design/ai-usage/design-notes.md`). The AI side is already built in
   `motir-ai`:
   - `model PlanTier { key @unique, name, monthlyCreditAllotment }` — the tier
     row (`motir-ai/prisma/schema.prisma:302`).
   - `model AiOrganization { coreOrganizationId @unique, planTierId? }` — **ONE
     balance + ONE tier per org**; `planTierId` is nullable because the org is
     created before billing is provisioned (`motir-ai/prisma/schema.prisma:26`).
   - `creditService.ts`: `BASIC_TIER_KEY = 'basic'` is the **default tier
     auto-assigned at first ledger provisioning, with no Stripe involved**
     (`provisionLedger` → `setOrgTier(basic)`); `topUp()` is the purchased-credit
     path; `grantAllotment()` grants `tier.monthlyCreditAllotment` monthly.
   - The AI boundary already raises a typed **`out_of_credits` → HTTP 402**
     (`motir-ai/src/problem.ts:16`; `creditGate.test.ts`).
   - Per-model credit cost is **policy, not code** — `ModelCreditRate` is
     effective-dated seed/config (`motir-ai/prisma/schema.prisma:317`). The same
     stance applies to tier allotments and prices here: **the numbers below are
     v1 seed values, tunable without a code change**, not hard-coded constants.

   So billing **builds on** this ledger — the shipped auto-assigned `basic` tier
   **IS** the free tier (default, no payment). Stripe writes into this ledger; it
   does not re-implement metering (Story 7.2 owns usage; 8.1 owns money-in).

3. **Self-host is real and uncapped.** `motir-core` is GPL-3.0 and runs WITHOUT
   `motir-ai`/Stripe. Billing is **cloud-only** (`organization-tier.md` notes the
   self-host gate; the front-door already has `isAiPlanningConfigured`).

### What this ADR adds beyond the prior decisions (Yue, 2026-06-21)

The earlier framing ("PM-core is free, AI is paid") left the **free tier
unbounded** — unlimited members, workspaces, organizations, and work items. That
is not a durable commercial shape: a free account could farm unlimited free
tenants and run an unbounded project at zero cost, and there would be no growth
lever pulling a scaling team toward a paid plan. Yue's decision: **the cloud free
tier is bounded** — one organization, one (default) workspace, and a **cap on the
number of work items** (plus the secondary caps: a small project limit, a per-file
upload-size limit, and a per-org total-storage cap) — and **creating additional
organizations
requires a paid org**, precisely because the org is the charging entity (an
ungated free-org-create loophole would defeat every per-org cap). **All these
counts are measured at the `Organization`, the billing entity** (§4).

### The verified mirror (rung 1 — cited, not asserted)

How the two reference products bound their free tiers (June 2026):

- **Jira (Atlassian) — caps SEATS.** The Free plan is a hard **10-user** ceiling
  (no time limit), 2 GB storage; user 11 forces the whole team onto Standard
  ($8.15/user/mo).
  ([Atlassian — Explore Jira Cloud plans](https://support.atlassian.com/jira-cloud-administration/docs/explore-jira-cloud-plans/);
  [Atlassian — Jira pricing](https://www.atlassian.com/software/jira/pricing))
- **Linear — caps SCOPE, not seats.** The Free plan allows **unlimited members**
  but caps **work items** at **250 non-archived issues** (plus 2 teams / 10 MB
  uploads); the 250-issue cap is the real wall — new-issue creation is blocked
  once it is hit.
  ([Linear pricing 2026 — costbench](https://costbench.com/software/developer-tools/linear/free-plan/);
  [Linear pricing — Quackback](https://quackback.io/blog/linear-pricing))

**Motir mirrors Linear's scope cap, not Jira's seat cap (Yue, after reviewing
both).** For a PM tool the **work item is the unit of value**, so capping work
items is the better, less hostile growth lever than capping seats: a free team can
be any size (collaboration is the product's whole point), but a free _project_
stays small. This supersedes the earlier "no unlimited members" instinct — once
the work-item count is the binding cap, a separate seat cap is redundant friction.
Motir takes Linear's **scope cap** but counts it **more strictly: ALL work items
count — archived AND active** (Yue). Linear caps only _non-archived_ issues, which
lets a user archive old items to stay under the cap forever; Motir closes that
loophole by counting **every** work item in the org, so 250 is a real **total**
ceiling (stricter than Linear's 250-active — the number is tunable). Members stay
**unlimited** on free. (This is also GitLab/Plane-shaped: a real, permanent free plan capped by
scope, with the self-managed/self-host build uncapped — §6.)

---

## Decision

### 1. Two gating axes + two BILLED dimensions (seats and AI are decoupled)

Motir's free/paid line is gated on **two axes**, and what a paid org **pays for**
is **two decoupled dimensions**. Keeping them separate is the core of this model.

| Axis                                                                       | What it gates                                                                                                    | Mechanism                                                                                                        | Free                                                                                                                         | Paid                                                                                                 |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **A. AI usage** (planning + hosted coding)                                 | every call crossing the `motir-core → motir-ai` boundary                                                         | the shipped **credit** ledger (`monthlyCreditAllotment` + `topUp` overage); `out_of_credits` 402 at the boundary | a **one-time** trial grant (signup), **no top-ups**                                                                          | an **org-level** monthly credit pool **+ metered top-ups**                                           |
| **B. PM-core scale** (work items / projects / storage / workspaces / orgs) | per-**org** counts: work items (archived + active), projects, per-file + total storage, workspaces, org-creation | **entitlement caps** measured at the org; exceeding one starts the $5/seat scaled tracker                        | 1 org · 1 workspace · ≤ 3 projects · ≤ 250 work items (archived incl.) · ≤ 10 MB/file · ≤ 2 GB total · **unlimited members** | lifted (unlimited work items/projects, 100 MB/file, 100 GB total, multi-workspace, create more orgs) |

- **Axis A is the open-core thesis** — the AI layers are the paid product, metered
  by credits, gated at the boundary. Confirmed to map onto the **shipped
  `out_of_credits` (402)** enforcement.
- **Axis B is the cloud commercial layer** — caps that exist **only on cloud** to
  pull a growing team toward a paid plan. They are NOT in open-core; **self-host
  is uncapped** (§6).
- **The PM tracker itself stays free and fully-featured** — work items, boards,
  sprints, reports, search, MCP, custom fields, automation. The free tier is
  bounded by **scale** (how many work items / workspaces / orgs),
  never by **feature removal** or a seat cap inside the one workspace it gives
  you. (This preserves "the PM substrate is real, not a veneer", Principle #8,
  while still giving growth a price.)

**The two billed lines are largely independent, with ONE bundle — a paid AI plan
includes the first tracker seat (Yue, 2026-06-21; amended 2026-06-24):** Motir
bills **two separate products**, each with its **own free→paid line**. An org
subscribes to either, both, or neither — with one tie: **a PAID AI plan includes 1
tracker seat, which lifts the §4 caps** (so a solo user planning with AI is never
walled by the 250-item cap). AI is still buyable without a _paid_ tracker; the
bundle runs one way (AI → includes a seat), never the other (a paid tracker grants
no credits).

- **① The Tracker (the PM tool) — free for small use, paid only at SCALE.** The
  tracker is **free for any team within the caps** (≤ 250 work items, ≤ 3 projects,
  1 workspace, 1 org — **unlimited members**). You pay **$5 / seat / mo ONLY when
  the org exceeds a cap** (needs unlimited work items, more projects/workspaces, or
  another org). The seat fee is the price of **scale**, not of "being a customer" —
  **a solo user or a small team within the caps never pays a seat fee.** ($5 is
  ~60% of Jira's $8.15 / half of Linear's $10, so even scaled it undercuts them.)
- **② AI (planning + agents) — an independent purchase, available to ANY org.** A
  one-time **300-credit trial** for free; then an **org-level monthly credit plan**
  (Standard / Pro / Max) (_Superseded as current: see the 2026-10-21 amendment at the end of §2 — MOTIR-8994._) and/or metered top-ups. The AI plan is bought
  **separately** and does **NOT** require a paid tracker — **a free-tracker org can
  buy AI.** It is funded by a **flat per-ORG fee, never the seat fee** (the margin
  rule): credits cost real money, so the AI fee — not seats — covers them. AI is
  org-level (one flat `monthlyCreditAllotment` per org, not per seat —
  `motir-ai/docs/credit-model.md` §4). **A paid AI plan INCLUDES 1 tracker seat** (amended
  2026-06-24): the org's §4 caps are lifted and the first seat is free, so the solo
  plan-with-AI journey never hits the 250-item wall; members beyond the first bill
  at $5/seat (§4). The Free one-time trial does NOT include a seat.

**Your bill = ① + ②, with a paid AI plan's included seat folded into the tracker
line (the org goes `scaled`; the first seat is free, members beyond it bill $5):**

| Org                                  | Tracker                 | AI               | **Total / mo**                    |
| ------------------------------------ | ----------------------- | ---------------- | --------------------------------- |
| Solo, < 250 items, no AI             | free                    | 300 trial (once) | **$0**                            |
| **Solo, wants planning**             | **included w/ AI plan** | Standard $25     | **$25** ← caps lifted, seat incl. |
| 5-person team, everyday planning     | 4 paid seats (1 incl.)  | Standard $25     | **$45** ($25 + 4 × $5)            |
| 8-person team, scaled + coding       | 7 paid seats (1 incl.)  | Pro $75          | **$110** ($75 + 7 × $5)           |
| 20-person team, tracker-only (no AI) | $5 × 20 = $100          | none             | **$100**                          |

So the **seat fee appears ONLY when the org outgrows the free caps**; a small org
pays only for the AI it opts into. The named plans (**Standard → Pro → Max →
Enterprise**) are the **AI ladder**; the tracker is just **free ↔ $5/seat
when scaled**. (_Superseded as current: see the 2026-10-21 amendment at the end of §2 — MOTIR-8994._) The two map onto the two data models cleanly: the **AI plan is the
motir-ai `PlanTier`** (drives credits), the **scaled-tracker state is a separate
motir-core subscription** (drives the §4 caps) — see §3.

**AI model choice is the USER's — transparent, per-model-priced (no black box).**
Motir does **not** silently route AI work to a model of its own choosing. The user
**selects which model runs each kind of work** — planning, and each hosted-agent
task type (design, docs, coding, …) — **per project** (the model catalog + the
per-project model config live in the AI layers: Epic 7 planning, Epic 9 hosted
coding). Three billing consequences:

- **Each model carries its own cost-plus `ModelCreditRate`** (`motir-ai/docs/credit-model.md`
  §2), so the **credits a task burns reflect the chosen model's real cost** — a
  Claude turn burns ~3.9× (Opus) to ~7.7× (Fable) the credits of a DeepSeek turn
  for the same work. The user **sees** that and chooses with eyes open; the cost
  difference is **theirs**, paid in credits, surfaced transparently — never hidden
  in a blended bill.
- **Motir's margin per credit is therefore uniform across models** (no involuntary
  model-mix exposure): Motir isn't picking the model and isn't absorbing its cost,
  so a pricier model depletes the **user's** pool faster without thinning Motir's
  margin. A tier's pool COGS is a fixed dollar amount set by its credit count,
  model-independent. **The COGS / margin figures live only in the private
  `motir-meta/margin-analysis.md`, never in this open-source repo.**
- **Gate:** a model is **selectable only once its `ModelCreditRate` is seeded**
  (the §2 reconciliation rule) — an unpriced model can't meter (the shipped guard
  refuses it). The **default planner is DeepSeek** (cheapest); whether planning
  quality on the cheaper model matches Claude is a **product question to test**, and
  the per-project override lets a user pick a pricier model for planning if they
  want it.

### 2. The catalog — TWO independent menus (what 8.1.2 provisions, 8.1.4 stores)

Per §1 the bill is two separate products, so the catalog is **two menus**, not one
tier list.

**① Tracker (the PM tool) — free ↔ scaled:**

| State      | When                         | Price                                                  | Entitlement                                                                                            |
| ---------- | ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **Free**   | the org is within ALL caps   | **$0**                                                 | ≤ 250 work items · ≤ 3 projects · 1 workspace · 1 org · 10 MB/file · 2 GB · **unlimited members**      |
| **Scaled** | the org exceeds ANY free cap | **$5 / seat / mo** ($40/yr — annual default; ~33% off) | all caps lifted: unlimited work items/projects, multi-workspace, create more orgs, 100 MB/file, 100 GB |

The **scaled-tracker subscription** is what lifts the §4 caps — a **motir-core
subscription state**, NOT the AI `PlanTier`. A small org never enters it, so it
**never pays a seat fee.** When an org first crosses a cap, the paywall offers the
scaled tracker (start the $5/seat subscription); until then the create is blocked
(§4 non-destructive lock).

**② AI (planning + agents) — an independent monthly plan (the motir-ai `PlanTier`):**

| Plan           | `PlanTier.key` | Credits / mo (per org) | Per-org fee | Cadence               | Top-ups | For                                                  |
| -------------- | -------------- | ---------------------- | ----------- | --------------------- | ------- | ---------------------------------------------------- |
| **Free**       | `free`         | 300                    | $0          | **ONE-TIME** (signup) | ✗       | try AI once                                          |
| **Standard**   | `standard`     | 2,000                  | $25         | monthly ($200/yr)     | ✓       | the entry paid plan — everyday planning, one project |
| **Pro**        | `pro`          | 8,000                  | $75         | monthly ($600/yr)     | ✓       | planning + hosted coding                             |
| **Max**        | `max`          | 30,000                 | $150        | monthly ($1,200/yr)   | ✓       | planning + heavy agent (design, docs, coding)        |
| **Enterprise** | `enterprise`   | custom                 | custom      | monthly               | ✓       | custom (no Stripe object — platform staff sets tier) |

_This table, and its `enterprise` row, are the ladder as first provisioned; the ladder that ships is
stated in the 2026-10-21 amendment at the end of §2 (MOTIR-8994)._

**Any org — free-tracker or scaled — can hold an AI plan**; it does not require a
paid tracker. The plan's flat per-org fee funds its credit pool (the margin rule,
§1); illustrative `$` pending the Epic-8 credit→`$` peg. AI is org-level — the same
pool whatever the seat count.

**Reconciliation with shipped `motir-ai` (binding on 8.1.4 / MOTIR-1230).** The
shipped default tier is **`basic` ("Basic"), 1,000 credits/MONTHLY**, seeded in the
`credit_ledger` migration and auto-assigned by `creditService` (`BASIC_TIER_KEY =
'basic'`; `motir-ai/docs/credit-model.md` §4). Changes:

1. **Rename `basic` → `free`** and **make its grant ONE-TIME** — 300 credits at
   provisioning, never refreshed. Add a **cadence field** on `PlanTier`
   (`allotmentCadence: 'one_time' | 'monthly'`, default `monthly`).
2. **Add `standard` (2,000), `pro` (8,000), `max` (30,000), `enterprise` (custom)**
   rows, all `monthly`. (_History: the pools these rows carry now are stated in the 2026-10-21
   amendment at the end of §2 — MOTIR-8994._) (The original 8.1.4 migration also added a `starter` (300)
   row; the 2026-06-23 amendment removes it — see 8.1.19 / MOTIR-1309.)
3. The monthly scheduler (8.1.4b) grants only **`monthly` tiers with allotment > 0**
   — `free` (one-time) never refreshes; the paid plans do.

A one-row update + four inserts + a nullable column — NOT a user-data migration.
The pool stays the shipped **flat per-org `monthlyCreditAllotment`** (not × seats).

**AI pool sizing** (_the v1 sizing, kept as history; the pools that ship are in the 2026-10-21
amendment at the end of §2 — MOTIR-8994_) (off the shipped credit math — `motir-ai/docs/credit-model.md`; one onboarding
planning pass ≈ 150–250 credits):

- **Free = 300, ONE-TIME** — try planning once.
- **Standard = 2,000 / mo** — the entry paid plan; everyday planning for one project (~10 passes/mo).
- **Pro = 8,000 / mo** — planning + a run of hosted coding.
- **Max = 30,000 / mo** — heavy agent: design + docs + coding across epics.
- **Enterprise = custom.**

**Final prices (provisioned in Stripe sandbox 2026-06-22 — 8.1.2 / MOTIR-1141):**
tracker **$5/seat/mo · $40/seat/yr** (annual-default; ~33% off; charged only when
scaled); per-org AI fees **$25 / $75 / $150 monthly** and **$200 / $600 / $1,200
annually** (Standard/Pro/Max); **credit top-up $10 per
1,000 credits** (one-time, customer chooses quantity at Checkout; _superseded: the top-up ships
at 1,000 credits for $5 — see the 2026-10-21 amendment at the end of §2, MOTIR-8994_). All Prices in
**USD**, `pro_pool_annual` set as the **default Price** on the Motir AI Product
(the recommended/anchor tier). These numbers are v1 seed values per the
ModelCreditRate stance — tunable without code changes, immutable on the existing
Price objects (a re-tune archives + creates new Prices, lookup keys stable).

**Per-credit ladder (the bulk-discount curve that pulls customers to subscriptions
over top-ups):** Standard $12.50/1k, Pro $9.38/1k, Max $5.00/1k; top-up $10/1k
(sits between Standard and Pro — emergency-overflow valve, never cheaper than
committing to the next tier). Standard is the costliest-per-credit rung, so the
curve stays monotonic top-to-bottom. (_No longer current: the shipped rungs are flat at $5 per 1,000 credits a month — see the 2026-10-21 amendment at the end of §2, MOTIR-8994._)

> **COGS — resolved by construction (the margin rule, §1).** Each AI plan's credits
> are funded by its **per-org fee**, never the seat fee — so margin holds at **any**
> seat count, including a 1-seat org that pays **no** seat fee at all (it is within
> the free tracker caps and pays only the AI fee). When Epic 8 sets the credit→`$`
> peg, fix each per-org AI fee **≥ the pool's credit cost × margin**; never let the
> seat fee fund credits (`notes.html` #10). COGS/margin figures live only in the
> private `motir-meta/margin-analysis.md`.

**The CODING comp — Cursor (rung 1, the AI-ladder mirror; June 2026).** Jira /
Linear (the verified mirror above) bound the **PM** product; **Cursor** is the
reference for the **AI-coding** use-case Pro / Max sell into, and its shape is
near-identical to ours — a **dollar-denominated usage credit metered by model ×
context × output**, the same per-credit mechanic as `motir-ai/docs/credit-model.md` §2:

- **Hobby $0** (limited) · **Pro $20** (~$20 of model usage included, ≈ 500
  premium requests) · **Pro+ $60** (~$70 usage, ~3×) · **Ultra $200** (~$400
  usage, ~20×) · Teams $40/seat · Enterprise custom. (~20% off annual.)
  ([Cursor pricing](https://cursor.com/pricing), retrieved 2026-06-23.)

**What it tells the AI ladder.** Cursor's ladder runs to **$200 / 20×** _for the
agent alone_, passing model compute **near cost** — real agent burn is heavy and the
market prices it near-cost. At Motir's v1 credit markup a coding-heavy user gets far
less agent runway per dollar; the moat that justifies the gap is the **automatic
agent loop** (plan → execute autonomously), not price or model-choice (Cursor has a
model picker + transparent metering too — that "transparent model choice" win holds
only vs the PM tools above, not vs Cursor).

> **DECISION (Yue, 2026-06-23) — a two-lane credit margin (planning hi / agent
> near-cost).** The credit markup is split by **use-case lane**, not just by model:
>
> - **Planning lane** — keeps the high markup (the value is the planning
>   intelligence; compute is tiny; no price anchor).
> - **Agent lane** — the **hosted autonomous agent loop**, which is **not only
>   coding**: it runs **doc writing, design, manual-task assistance, and future task
>   types** too. This lane is metered at a **small margin (~20%, near-cost)** so
>   agent credits burn far slower and Motir stays **within Cursor's ballpark — never
>   ~10× pricier**. The ~20% (not 0%) must cover **provider tokens + agent HOSTING**
>   (sandbox/compute time), so it is sized over fully-loaded COGS, not tokens alone.
>
> This **supersedes** the earlier "defer a pool-resize" framing: the lever is the
> agent-lane **rate**, not (only) bigger pools (_that parenthetical is no longer current: a larger
> credit pool is now a product of its own — the 2026-10-21 amendment at the end of §2, MOTIR-8994;
> the lane decision's substance stands_). **No code ships in 8.1** — the rate
> is effective-dated config (`ModelCreditRate`, a per-row `marginMultiplier`), and
> nothing meters the agent loop until Epic 9 (MOTIR-673). **Epic 9 owns the
> implementation**: add a **use-case dimension to `ModelCreditRate`** (or meter the
> agent under a distinct model-key — zero-migration) and **calibrate the ~20%
> against measured token + hosting cost**; BYO-API-key is a secondary lever for the
> heaviest users. The §-COGS / compute-per-dollar math stays in the private
> `motir-meta/margin-analysis.md` (out of this open repo). The 8.1.21 / MOTIR-1311
> copy fix (promise _running_ the agent + top-ups, never "whole tasks") is the
> interim guard until the lane ships.

> **Amendment (2026-09-04, MOTIR-4331) — the OWNER moves, and the implementation is
> CHOSEN.** The decision above stands unchanged in substance; what changes is who
> builds it and which of its two offered implementations is built.
>
> - **Owner.** The two-lane margin is implemented by **MOTIR-4331**, a story of the
>   AI-economics epic **MOTIR-4329** — not by Epic 9 (MOTIR-673). Epic 9 remains the
>   lane's **first consumer**: it mints the run credentials that carry
>   `lane = agent`. The reason for the move is that a rate is an economics concern,
>   and this one stayed unbuilt for fifteen months precisely because it was filed
>   under the epic that consumes it.
> - **The implementation, chosen: a `lane` dimension on `ModelCreditRate`.** Lane
>   values are `planning` and `agent`; uniqueness widens from `(model, effectiveFrom)`
>   to `(model, lane, effectiveFrom)`; every pre-existing row is `planning`; and an
>   **unclassified turn is priced in the planning lane** — the expensive one, so a
>   missing classification can never silently under-charge. The rejected alternative
>   is the "distinct model-key per lane — zero-migration" option: it smuggles a
>   billing dimension into a column typed as a model **identifier**, which every
>   consumer of `model` — the planner's model list, the model catalog, and the
>   price-drift guard from MOTIR-4333 — would then have to know about.
> - **Why a dimension is the right shape (rung 1, the providers' own price sheets).**
>   Model providers already price a per-use-case rate as a **dimension of the same
>   model's row**, never as a second model: OpenAI prices one model at Standard /
>   Flex / Priority / Batch service tiers
>   ([pricing](https://developers.openai.com/api/docs/pricing),
>   [flex processing](https://developers.openai.com/api/docs/guides/flex-processing)),
>   and Anthropic's Message Batches price **every** model at half its standard rate
>   ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)). All three
>   retrieved 2026-09-04.
> - **What the lane's `marginMultiplier` is, and is not.** It is the credit-**count**
>   markup applied to a cost-calibrated base credit; the **dollar** margin is set
>   jointly with it by the credit→`$` peg. So the near-cost lane's multiplier is a
>   small fraction — it is emphatically **not** the stated percentage above
>   transcribed into the column, which would leave agent credits selling at a
>   multiple of token cost, the exact outcome this decision exists to prevent. The
>   arithmetic, the peg sensitivity and every COGS figure stay in the private
>   `motir-meta/margin-analysis.md`, per §1's rule; nothing numeric about margin
>   belongs in this repository.
> - **What still holds, unchanged.** The ~20% target over **fully-loaded** COGS
>   (provider tokens **+** agent hosting); the requirement to **calibrate** it against
>   measured token + hosting cost — now MOTIR-4483, gated on the hosting meter
>   MOTIR-4336, which replaces the provisional figure the story ships; and
>   BYO-API-key as the secondary lever for the heaviest users.
> - **The edge, deliberately deferred.** The epic-level `MOTIR-4329 blocks MOTIR-673`
>   relationship is wired **after this amendment merges**, by MOTIR-4482 — so the
>   dependency graph never asserts an ownership this record still denies. Merging
>   this amendment IS the ratification; declining it re-files MOTIR-4331 under
>   Epic 9 with nothing to unwind.

> **Amendment (2026-09-26, MOTIR-6514) — agent HOSTING leaves the agent-lane
> margin; it is CHARGED directly.** Per
> [`hosted-agent-machine-charge.md`](hosted-agent-machine-charge.md) (MOTIR-6512),
> a hosted run is charged for its container's machine time at CI's rate — 1 credit
> per Linux-equivalent minute, rounded up once per run — as its own ledger line.
> Pricing hosting into the per-token rate as well would bill it twice, so **the
> agent-lane margin above covers provider TOKENS ONLY**: read "~20% over provider
> tokens + agent HOSTING" as "~20% over provider tokens", and MOTIR-4483 calibrates
> the lane over token cost alone. The token half of the decision stands unchanged,
> and the hosting meter (MOTIR-4336) stays Motir's cost record — the charge is a
> separate reader of its seconds, never a price derived from its cost.

> **Amendment (2026-10-21, MOTIR-8994) — the ladder as it ships, and the ceiling is no longer the
> end.** Two jobs, kept attributed: (a) the ladder [MOTIR-7592] settled, which this file never
> absorbed; (b) the band above it, decided by MOTIR-8987 (the derivation rule for a larger pool and
> its price, and how Stripe carries it).
>
> **What it supersedes**, quoted from this file:
>
> - §1: "The named plans (**Standard → Pro → Max → Enterprise**) are the **AI ladder**", and
>   bullet ②'s "an **org-level monthly credit plan** (Standard / Pro / Max)".
> - §2's ladder table: "| **Enterprise** | `enterprise` | custom | custom | monthly | ✓ | custom
>   (no Stripe object — platform staff sets tier) |", and its Standard 2,000 / Pro 8,000 rows.
> - §2's "Final prices": "**credit top-up $10 per 1,000 credits** (one-time, customer chooses
>   quantity at Checkout)".
> - §2's "Per-credit ladder": "Standard $12.50/1k, Pro $9.38/1k, Max $5.00/1k; top-up $10/1k (sits
>   between Standard and Pro — emergency-overflow valve, never cheaper than committing to the next
>   tier)".
> - §2's lane decision: "the lever is the agent-lane **rate**, not (only) bigger pools", only as
>   far as the parenthetical.
>
> **(a) The ladder as settled (MOTIR-7592)**, read entry for entry from `lib/billing/catalog.ts`:
>
> | Plan     | Credits a month | Monthly | Annual | Per 1,000 credits a month |
> | -------- | --------------- | ------- | ------ | ------------------------- |
> | Free     | 300, one-time   | $0      | —      | —                         |
> | Standard | 5,000           | $25     | $200   | 25 ÷ 5 = $5               |
> | Pro      | 15,000          | $75     | $600   | 75 ÷ 15 = $5              |
> | Max      | 30,000          | $150    | $1,200 | 150 ÷ 30 = $5             |
> | Max ×2   | 60,000          | $300    | $2,400 | 300 ÷ 60 = $5             |
>
> The basis is flat, not a curve: every rung is $5 per 1,000 credits a month, and every annual price
> is exactly 8× its monthly. The top-up is 1,000 credits for $5, the same per-credit rate as any
> regular plan rather than a price between two rungs. Every paid plan includes one tracker seat
> (§4). `enterprise` is, in the catalog's own words, a tier "an org staff set to … keeps … in
> motir-ai; it just has nothing to buy here": it has no storefront card, no price, and nobody is
> sold it.
>
> **(b) What the ceiling means now.** The catalog's ceiling accessor (`maxMonthlyPlanCredits()`)
> names the top of the REGULAR ladder, never the largest pool on sale. Narrowing it to the ladder
> band is MOTIR-8990's (the larger plan joins the catalog and every allow-list), so read this as
> the contract that card establishes. Above the ceiling, the product answers an estimate with a
> **larger credit pool plan** derived from the estimate's high end, instead of stacked top-ups. It
> is a plan of its own, bought at quantity 1 on either cadence; an org holds one live AI plan, and
> an org that already holds one moves up through the shipped change-of-plan path. Its money
> resolves, as §3 already has it, through one ACTIVE `<tierKey>_pool_<cadence>` price, and its
> credits come from its `PlanTier` row.
>
> **Where the band's rule lives.** The step, the rounding, the rung table, the tier-key and
> lookup-key form and the Stripe carriage are recorded on MOTIR-8987's decision page and are
> deliberately not restated here, so this file stays right if that record changes.
>
> **What is overtaken, and what stands.** Overtaken: MOTIR-7592's "no larger plan beyond Max ×2,
> top-up only", and §2's "not (only) bigger pools" parenthetical. Unchanged: the four rungs' pools
> and prices, the top-up path and its price, the included seat, per-org pricing at quantity 1, no
> contact-sales path, and the two-lane margin decision's substance. No COGS or margin figure is
> added here; those stay in `motir-meta/margin-analysis.md`.
>
> **Left as history, not rewritten:** the Consequences bullet saying 8.1.4 "adds the `standard`
> (2,000), `pro` (8,000), `max` (30,000), `enterprise` (custom) rows" and the §2 narrative around
> it (the reconciliation list and the v1 "AI pool sizing") are the record of what was provisioned
> then, superseded by this amendment.

> **Amendment (2026-10-23, MOTIR-9364 / MOTIR-9398) — Host, a regular plan of 300,000 credits.**
> The catalog gains **Host** (`host`): 300,000 credits a month at **$1,500 a month or $12,000 a
> year**, under `host_pool_monthly` / `host_pool_annual`, bought at quantity 1 with one included
> tracker seat like every paid plan.
>
> - **Its price is the ladder's per-credit basis**, pool ÷ 1,000 × $5 a month and × $40 a year (so
>   annual is 8× monthly, as on the ladder), not the larger rungs' 10%-off monthly rule.
> - **It is sold from the plan row and through the change-of-plan path, and never recommended by
>   the calculator.** It sits in a `host` band of its own: the ladder ceiling
>   (`maxMonthlyPlanCredits()`, still Max ×2's 60,000) and the rung table never count it, and only
>   the checkout allow-list and the change-of-plan keys name it. Adding it as a `ladder` rung would
>   have lifted the ceiling to 300,000 and taken all six rungs off sale.
> - **What it brings beyond credits** (three AWS accounts of the org's own, and Max's limits on the
>   shared pools until they are live) is owned by the Host accounts story, MOTIR-9365, not by this
>   record. The six `pool_<n>k` rungs stay on sale between Max ×2 and Host until the larger-pool
>   story, MOTIR-9366, re-anchors them above it.

### 3. The Stripe Price catalog (binding on 8.1.2 / MOTIR-1141)

A paid org's subscription carries **two recurring items**: one **shared per-seat
tracker** price (`quantity` = seats) + one **flat per-org AI-pool** price for its
tier (`quantity` 1). Provision:

| Stripe Product                                | Prices                                                                                      | Billing model                                | Notes                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Motir** (seat; the project-management tool) | `tracker_monthly` ($5), `tracker_annual` ($40 — default)                                    | **recurring, per-seat** (`quantity` = seats) | present ONLY when the org is scaled; lifts the §4 caps. Customer-facing name is just "Motir" (not "Motir Tracker") — the tracker IS the namesake product                                                                                              |
| **Motir AI — Standard / Pro / Max**           | `standard_pool_*` ($25/$200), `pro_pool_*` ($75/$600 — default), `max_pool_*` ($150/$1,200) | **recurring, flat per-org** (`quantity` 1)   | the tier's monthly AI fee that **funds** its credit pool; an org has **exactly one**. `pro_pool_annual` is the Product's default Price (the recommended/anchor tier). (`starter_pool_*` archived per the 2026-06-23 amendment — 8.1.20 / MOTIR-1310.) |
| **Motir Credits** (top-up)                    | `credit_topup` ($10 unit price; customer chooses quantity at Checkout)                      | **one-time** (`mode: 'payment'` at Checkout) | pay-as-you-go overage beyond the pool; writes via `creditService.topUp(N × 1,000)`. Not metered — discrete purchase per click                                                                                                                         |
| — (Free)                                      | —                                                                                           | —                                            | **no Stripe object** — free = no subscription (the one-time 300 is granted at provisioning)                                                                                                                                                           |
| — (Enterprise)                                | —                                                                                           | —                                            | **no public Stripe object** — invoiced/custom; tier set by platform staff                                                                                                                                                                             |

_The AI row, the `credit_topup` row and the Enterprise row above are the catalog as first
provisioned. The ladder that ships (Max ×2 included, the top-up at $5 per 1,000, no Enterprise
card) and the larger pools above it are in the 2026-10-21 amendment at the end of §2 (MOTIR-8994)._

The two subscription items are **independent**. A **scaled** org carries `N × tracker_monthly` (seat item); an org with an **AI plan** carries `1 × <plan>_pool_monthly` (pool item). So a **small AI-only org has ONLY the pool item**
(no seat fee — it's within the free tracker caps); a **scaled tracker-only org has
ONLY the seat item**; a scaled org that also buys AI has **both**; a free org has
**neither**. The org's `PlanTier` is set by which `*_pool_*` price is present
(8.1.4b maps it → tier); the **scaled-tracker state is a separate motir-core flag**.
The **billing entity on every Stripe Customer is the `Organization`** (one Customer
↔ one core `Organization` ↔ one `AiOrganization`); the seat item's `quantity` syncs
to membership (Stripe proration, §5), the pool item stays `quantity` 1.

### 3.5 Stripe infrastructure (provisioned in sandbox 2026-06-22)

The shape locked above became, in practice:

- **Stripe account:** sandbox, legal entity **moooon B.V.** (NL), business type
  _vennootschap met rechtspersoonlijkheid_ (B.V.), MCC SaaS, public business name
  **Motir**, statement descriptor **MOTIR**, brand color **#1a1d21** and accent
  color **#155bc4** (the Motir palette's `--el-accent` ink and `--el-link` blue,
  `design/brand/design-notes.md` §10 — superseding the old purple `#5645d4`; the
  dashboard itself is set by the Stripe branding card, MOTIR-6479), business
  website `https://motir.co`. Logo
  deferred (no asset yet; placeholder-free is cleaner than throwaway-placeholder).
- **Catalog:** 3 Products / 11 Prices as originally provisioned per the §3 table
  (the 2026-06-23 amendment archives `starter_pool_{monthly,annual}` → **9 active**;
  8.1.20 / MOTIR-1310). _These counts are a dated snapshot, not a contract: the number of Prices
  follows the rungs the catalog lists, one ACTIVE price per rung per cadence (2026-10-21
  amendment, MOTIR-8994)._ All Prices USD. The
  per-Product _default_ Price is `tracker_annual` (Motir) and `pro_pool_annual`
  (Motir AI) — annual-first presentation, the larger headline number anchors
  better and the implied 33% discount feels like a deal. 8.1.7's billing settings
  UI should mirror this annual-first order.
- **Customer Portal:** ON for invoice history, payment-method updates, customer
  info edits, switch-plans (for **both** Motir and Motir AI Products; not Credits
  — Credits is one-time and not a switchable subscription), cancel-at-period-end
  (NOT immediate; matches §5). Upgrades prorate immediately; downgrades take
  effect at period end. Pause subscriptions OFF (no authorization in the ADR for
  paused-state semantics — keeps the state machine clean). VAT-ID collection
  deferred (gates on Stripe Tax being on; see §6). Return URL:
  `https://motir.co/settings/billing` (the canonical URL; 8.1.5 overrides per
  session with the customer's actual page URL). **Portal Custom Domain
  (`billing.motir.co`) deferred** to live-cutover (needs `motir.co` DNS first).
- **Webhook:** ONE destination at **`https://ai.motir.co/v1/stripe/webhook`** —
  custom subdomain on motir-ai (Fly-hosted), not the platform-coupled
  `motir-ai.fly.dev`. Subscribes to the **6 events** 8.1.4b consumes:
  `checkout.session.completed`, `customer.subscription.{created,updated,deleted}`,
  `invoice.paid`, `invoice.payment_failed`. (The card description said "the five
  event types"; reality is 6 because `subscription.{created,updated,deleted}` is
  three discrete events plus the three invoice/checkout ones — this ADR
  corrects the count.) Snapshot payload style, API version pinned to
  `2026-05-27.dahlia` (8.1.4b's SDK pins the same — same-version on both ends).
  Listens to "Your account" events only (not Connect — we explicitly opted out
  of Connect at signup). **`ai.motir.co` DNS delegation + Fly cert
  (`fly certs add ai.motir.co`) deferred** to live-cutover (same `motir.co`
  prerequisite).
- **Dunning policy** (per §5):
  - Smart Retries: **ON, Stripe default ~8 attempts over ~2 weeks** (within the
    §5 "2–3 wk grace" range — the ML-tuned schedule outperforms manual overrides;
    don't fight the default).
  - Subscription terminal action on retry exhaustion: **cancel the subscription**
    (NOT "mark as unpaid" — clean termination fires `subscription.deleted` →
    8.1.4b drops to free; `unpaid` is a Stripe-specific limbo state the handler
    would never resolve).
  - Invoice terminal action: **mark uncollectible** (accounting cleanliness; the
    invoice exits AR rather than haunting MRR reports as perpetual `open`).
  - Customer dunning emails: ON (card-failed, card-expiring, bank-debit-failed,
    invoice-overdue). Renewal-reminder emails OFF (self-cannibalizing in B2B SaaS
    — reminding passive customers triggers churn for no recovery upside; B2B is
    exempt from EU consumer-disclosure rules requiring them).
  - **3D Secure: ON** (PSD2 SCA compliance for EU customers — non-optional for an
    NL-based merchant; also shifts fraud chargeback liability to the bank when
    auth succeeds — Stripe data shows ~70% reduction in fraud chargeback rate).
    Off-session 3DS confirmation emails: ON (the only way to reach customers for
    SCA challenges on recurring renewals).
  - Dashboard billing mode: **Flexible** (the multi-item-per-subscription shape
    §3 requires; "hide classic" prevents accidental Classic subscription
    creation).
- **Stripe Tax: DEFERRED to live-cutover** (see §6) — the activation wizard
  requires `motir.co` to resolve. Today's 11 Prices ship with
  `tax_behavior: unspecified`; live-cutover flips them all to `exclusive` in
  one pass.
- **Live activation: DEFERRED** — same `motir.co` prerequisite (Stripe's
  live-activation review fetches the URL for verification). Sandbox is fully
  functional without it; 8.1.4 / 8.1.4b / 8.1.4c / 8.1.5 develop against
  sandbox; live-cutover bundles activation + Tax + VAT-ID + Custom Domain +
  `tax_behavior=exclusive×11` in one session, gated on Story 8.5 shipping
  `motir.co` with TOS / Privacy / Contact.
- **motir-ai env (Fly secrets set 2026-06-22):** `STRIPE_SECRET_KEY` (sandbox
  `sk_test_…`), `STRIPE_WEBHOOK_SECRET` (sandbox `whsec_…` for the
  destination above). **motir-ai is Fly-hosted, not Vercel** — the ADR's prior
  generic "Vercel/host secrets" wording is corrected to "Fly secrets" for
  motir-ai (motir-core remains Vercel; the split is real).

### 4. The entitlement caps + the org-creation gate (Yue, binding)

The caps from §2, stated as enforceable rules (the enforcement home is 8.1.11,
extended by 8.1.24 / MOTIR-1318 — see Consequences). **These caps are the Tracker's
free→paid line:** exceeding any one requires the org to start the **$5/seat
scaled-tracker subscription** (or the create is blocked). **A paid AI plan lifts the
caps via its included seat (amended 2026-06-24, 8.1.22 / MOTIR-1316):** an org with
an active paid AI plan (Standard / Pro / Max; _as of the 2026-10-21 amendment, every paid plan
including Max ×2 and a larger credit pool_) resolves to `scaled` — all §4 caps
lifted, the first seat included, members beyond the first billed at $5/seat. The
scaled tracker still grants no credits (the bundle is one-way: AI → seat, never
seat → credits), and the **Free trial does not lift any cap**.

> **All scale caps are counted at the `Organization`, not the workspace or
> project (binding).** The hierarchy is `Organization → Workspace → Project →
work item`; the **org is the billing entity**, so every entitlement is measured
> at that boundary. Counting at the org is also **ungameable** — a user can't
> split work across projects/workspaces to dodge a cap — and matches Linear, which
> counts at its workspace-root (= Motir's org). On `free` the question is moot
> anyway (one workspace), but the org-level definition is the one that stays
> coherent when a paid org has many workspaces. The entitlement helper resolves
> the org **up** from the entity being created (work item → its project → its
> workspace → its org) and counts there.

1. **Work items (the headline cap — Linear's scope idea, stricter).** `free` org:
   **≤ 250 work items across the whole org — archived AND active** (summed over
   every project in every workspace). Creating the 251st is blocked with an upgrade
   prompt. **Archived items still count — archiving does NOT free room** (this is a
   deliberate divergence from Linear's _non-archived_ cap; it closes the archive
   loophole, making 250 a true total ceiling — stricter than Linear's 250-active,
   and tunable). The **scaled tracker** lifts this (unlimited). Counted as **ALL
   work items in the org** (a plain row count, no archive filter) — simpler than a
   non-archived filter and ungameable. **Members are NOT seat-capped on free** — the work-item
   count is the binding lever, so a free team can be any size (collaboration is the
   point); they hit the wall on _project size_, not _headcount_. (Mirror: Linear's
   scope cap, chosen over Jira's seat cap — §Context.)
2. **Projects (the secondary Linear lever).** `free` org: **≤ 3 projects** across
   its org. A Motir `Project` (the issue container, under a workspace) is the
   analogue of a Linear **team**, and Linear's free plan caps **teams at 2**; Motir
   allows a slightly more generous 3 because it folds the extra workspace tier away
   on free. The 250-item cap is the real wall; this is the belt-and-suspenders
   Linear-parity lever. The **scaled tracker** lifts this (unlimited). Gate `createProject`.
3. **Uploads — TWO limits: per-file size AND total org storage.**
   - **Per-file size (tier the SHIPPED limit).** motir-core **already** enforces a
     global **`MAX_UPLOAD_BYTES = 10 MB`** (`lib/blob/allowlist.ts`, raising
     `FileTooLargeError`; checked in `attachmentsService` + `usersService`) — exactly
     Linear's free 10 MB. Make it **tracker-state-derived**: **free 10 MB / scaled 100 MB** (enterprise
     custom).
   - **Total storage per org (NEW — there is none today).** The shipped code caps
     only per-file; nothing sums usage, so free storage is currently unbounded (250
     × 10 MB ≈ 2.5 GB slips through). Add a **per-org total-storage cap**: **free 2 GB**
     (mirrors Jira) **/ scaled 100 GB** (enterprise custom).
     Computed as the **`SUM(Attachment.sizeBytes)` across the org's workspaces**
     (`Attachment.workspaceId → Workspace → Organization`; blobs live in Vercel
     Blob); checked at the upload path: reject when `currentOrgBytes + file.size`
     exceeds the tier limit. v1 computes the sum on upload (cheap at free scale,
     bounded by the item cap); a cached running counter is a later optimization. A
     single-file overage from a concurrent race is benign (storage, not money), so
     a strict `FOR UPDATE` is optional here.
   - All four numbers are tunable seed policy.
4. **Workspaces per org.** `free` org: **exactly 1** (the auto-provisioned default
   workspace; the "new workspace" affordance is gated). the **scaled tracker**: unlimited. (The data model already carries the tiers — `organization-tier.md` §6
   — so there is **never a migration** as a team grows; only the cap lifts.)
5. **Org creation.** A user may create their **first** org for free (it is
   auto-provisioned at signup — every account is an org-of-one from day one). To
   create **any additional** organization, the user MUST be **owner/admin of at
   least one organization with an active **scaled-tracker subscription\*\*. A
   free-tracker account cannot spin up a second org.
   - **Rationale.** The org is the charging entity. If free-org creation were
     ungated, a user could create N free orgs and dodge the per-org work-item cap
     (250 items × N orgs = an unbounded free workload). Gating new-org creation
     behind a scaled (paying) tracker closes the loophole **without** taxing onboarding (the
     first org is always free).
   - New orgs created by a paid account **start on `free`** (with caps) until
     individually upgraded — each org is its own billing entity.

**Downgrade is never destructive (binding on 8.1.11 / MOTIR-1230).** When an org
drops from paid to `free` (cancellation/non-payment, §5), over-cap data is
**locked, never deleted**:

- Work items beyond 250 → **all retained and readable; creating NEW items is
  blocked** until the org re-upgrades (or removes items to get back under 250 —
  **archiving does NOT help, archived items still count**). Nothing is deleted
  automatically.
- Projects beyond 3 / workspaces beyond the first → **read-only / locked**; the
  user picks which to keep active (or re-upgrades). No data is removed.
- All existing files stay; only NEW uploads are held to the free per-file (10 MB)
  and total-storage (2 GB) limits — an over-2 GB org cannot upload until it's
  back under (delete files) or re-upgrades. Nothing is deleted automatically.
- AI allotment → drops to the `free` allotment; top-ups disabled.

### 5. Trial, proration, dunning (subscription lifecycle → tier state)

- **Trial.** **No separate free trial in v1** — the **`free` tier is the perpetual
  trial** (the GitLab/Linear shape: a real, permanent free plan de-risks adoption
  without dunning complexity). An optional 14-day Pro trial via Stripe
  `trial_period_days` is a **non-blocking later** addition.
- **Proration.** Stripe **default mid-cycle proration**, applied independently to
  the two subscription items (§3). Starting the **scaled tracker**, an **AI-plan
  change** (Standard↔Pro↔Max — swap the `*_pool_*` price), and **seat
  add/remove** all prorate immediately; a downgrade (smaller pool, or dropping a
  line) takes effect at period end unless forced. The two lines move
  **independently**: dropping the **AI plan** shrinks/ends the credit pool but
  leaves the tracker untouched; dropping the **scaled tracker** re-applies the §4
  caps but leaves the AI plan untouched.
- **Dunning + grace (binding on 8.1.4b / MOTIR-1230 — applied idempotently from the
  webhook), PER subscription line.** Stripe Smart Retries + dunning emails. A lapse
  affects **only the line that lapsed**:

  | Stripe status (per line)                     | If the **AI-plan** line                                                                    | If the **scaled-tracker** line                              |
  | -------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
  | `active` / `trialing`                        | plan active                                                                                | caps lifted                                                 |
  | `past_due`                                   | **keep the pool through grace** (Smart Retries default: ~8 attempts over ~2 weeks); banner | **keep caps lifted through grace**; banner                  |
  | `canceled` / `unpaid` / `incomplete_expired` | AI plan → **`free`** (no monthly grant, top-ups off)                                       | tracker → **free: re-apply §4 caps** (non-destructive lock) |

  The AI-line lapse flips `AiOrganization.planTierId` via the shipped
  `creditService.setOrgTier()`; the tracker-line lapse flips the motir-core
  scaled-tracker flag. 8.1.4b only wires Stripe events to each, idempotently.

### 6. Tax + the cloud/self-host gate

- **Tax.** **Stripe Tax ON for v1** (`automatic_tax` on Checkout + subscriptions)
  — low effort, globally correct. Start registered in **NL/EU** (moooon B.V. is a
  Netherlands entity → EU VAT, reverse-charge for EU B2B via VAT-ID collection in
  the Customer Portal) and **US**; rely on Stripe Tax threshold monitoring and
  collect only where registered, expanding as thresholds are crossed.
  - **Implementation reality (2026-06-22):** Stripe Tax **activation requires the
    business website (`motir.co`) to be reachable** — checked by Stripe's
    activation wizard even in sandbox. Since `motir.co` does not yet resolve,
    Stripe Tax setup is **deferred to live-cutover** (bundled with motir.co launch
    - live activation). Concretely deferred: enabling Stripe Tax, setting every
      Price's `tax_behavior` to `exclusive` (the 11 Prices provisioned today are
      `tax_behavior: unspecified` — the field only appears once Tax is on), and
      turning on Customer-Portal VAT-ID collection. **Code-side (8.1.4 / 8.1.5 /
      8.1.4b) is NOT blocked** — Checkout/Portal endpoints + webhook handler
      consume the catalog regardless of Tax state; tax calculation is an automatic
      Stripe behavior at Checkout time. **Sandbox testing of tax-calculated
      flows is blocked**; 8.1.9 / 8.1.10 either stub tax in tests or wait for
      motir.co to resolve.
- **Self-host = cloud-only billing, uncapped.** Billing **and** the §4 caps exist
  **only on cloud**. A single explicit flag distinguishes the builds: **`MOTIR_CLOUD`
  env (default `false`)**.
  - `MOTIR_CLOUD=false` (self-host): no checkout UI, no paywall, the entitlement
    layer is inert, **all caps lifted** — full GPL-3.0 PM tracker, unbounded.
  - `MOTIR_CLOUD=true` (Motir cloud): billing + caps + paywall active.
  - Use an **explicit** flag (not inferred from the presence of `motir-ai`/Stripe
    config), so a self-hoster who DOES connect their own `motir-ai` is **not
    force-billed**. This is **distinct from** `isAiPlanningConfigured` (which gates
    whether AI is _reachable_); both are `false` on a bare self-host, but they
    answer different questions and must stay separate flags.

### 7. Permissions — who manages billing

Reuse `OrganizationRole` (`owner | admin | member`) and `resolveOrgAccess.isOrgAdmin`
(`organization-tier.md` §4 — owner is the sole billing/destructive authority):

| Action                                                        | owner | admin | member                             |
| ------------------------------------------------------------- | ----- | ----- | ---------------------------------- |
| Start checkout / change plan / change payment method / cancel | ✓     | ✗     | ✗                                  |
| View billing + usage / invoices                               | ✓     | ✓     | ✗                                  |
| Trigger an upgrade prompt (hit a cap / paywall)               | ✓     | ✓     | ✓ (prompt routes them to an owner) |

Billing **mutations are owner-only**; admins get **read** (view plan, usage,
invoices). The `isOrgAdmin` helper gates the read surface; an `isOrgOwner` check
gates the mutations. Self-host: N/A (no billing surface).

> **Amendment (2026-09-25, MOTIR-6305) — billing mutations are Owner AND Admin.**
> The role model (`role-model.md` §1, decided by MOTIR-6165) gives the Admins the
> org settings **"billing included"**, so the owner is no longer the single billing
> authority. The table's first row now reads ✓ for `admin` as well as `owner`:
> starting checkout, changing plan or payment method, cancelling and changing the
> seat quantity are all open to an Admin.
>
> - **Supersedes:** _"Billing **mutations are owner-only**; admins get **read**"_ and
>   _"an `isOrgOwner` check gates the mutations"_ above, and the parenthetical _"owner
>   is the sole billing/destructive authority"_ in this section's opening line (the
>   destructive half stands: deleting the organization is still the Owner's alone).
> - **The gate is now one capability, `manageBilling`**, read from
>   `lib/organizations/capabilities.ts` (`orgCan`) for both the read surface and
>   `billingService.assertBillingManagerForMutation` — no separate owner check.
> - **NOT changed:** a plain **member** still has **no billing view** (403, the
>   routed-to-owner state), and the third row stands — anyone may hit a cap and see
>   the upgrade prompt, which routes a member to the people who can act.

---

## Consequences

- **A larger credit pool is a plan of its own at quantity 1 (2026-10-21, MOTIR-8994).** It rides
  §5's status map with no new entitlement state, so no surface gains a new terminal state to draw.

- **8.1.2 (MOTIR-1141) — DONE in sandbox 2026-06-22.** Provisions exactly the §3
  catalog: Product **"Motir"** (`tracker_monthly` + `tracker_annual`, per-seat),
  Product "Motir AI" with the flat-per-org pool Prices
  (`standard_pool_*` / `pro_pool_*` / `max_pool_*`, all monthly + annual — the
  original provisioning also included `starter_pool_*`, **archived** by the
  2026-06-23 amendment / 8.1.20 / MOTIR-1310), Product "Motir Credits"
  (`credit_topup`, one-time), the
  webhook endpoint at `ai.motir.co/v1/stripe/webhook` (6 events), and the
  Customer Portal (switch-plans, cancel-at-period-end, payment-method updates).
  No Stripe object for `free`/`enterprise`. **Stripe Tax + live activation +
  Portal Custom Domain + `tax_behavior=exclusive` on all 11 Prices DEFERRED to
  live-cutover** (gated on `motir.co` resolving — see §3.5 / §6). Test-mode
  secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) set in motir-ai Fly env.
- **8.1.4 (MOTIR-1145)** stores the Stripe customer/subscription against the
  `AiOrganization` (one Customer ↔ one org), **renames `BASIC_TIER_KEY` `'basic'`
  → `'free'`**, **adds a `PlanTier.allotmentCadence` (`one_time` | `monthly`)
  column**, **converts the seeded tier to `free` (300, `one_time`)**, and **adds the
  `standard` (2,000), `pro` (8,000), `max` (30,000), `enterprise` (custom) rows**
  (all `monthly`) — a one-row update + four inserts + a nullable column, not a
  user-data migration. (The original 8.1.4 migration also added a `starter` (300)
  row; **removed** by the 2026-06-23 amendment / 8.1.19 / MOTIR-1309.) The
  **scaled-tracker subscription state is
  recorded separately on the motir-core `Organization`** (a subscription flag), NOT
  on `AiOrganization` — the two billed lines (§1) map to two different stores: the
  AI plan → `AiOrganization.planTierId`, the scaled tracker → the core org flag.
- **8.1.4b (MOTIR-1230)** wires Stripe webhook events to tier/credit state
  idempotently: maps the subscription's `*_pool_*` price → `PlanTier`, applies the
  §5 status→tier map via the existing `creditService.setOrgTier()`, and grants the
  monthly allotment for `monthly`-cadence tiers only (skips `free`/one-time). For
  the **tracker** line items (`tracker_*` price keys), dispatches via the new
  **8.1.4c** propagation client (motir-ai → motir-core) to flip the
  scaled-tracker flag — see next bullet.
- **⚠️ Planning gap surfaced during MOTIR-1141 dispatch (2026-06-22) → new
  subtask 8.1.4c.** A single Stripe Customer carries BOTH subscription items
  (per-seat `tracker_*` AND flat-per-org `*_pool_*`), so both arrive on the same
  webhook events — but no existing subtask owned the cross-service propagation
  from motir-ai (where the webhook lands) to motir-core (where the
  scaled-tracker flag lives, per §3). 8.1.4b's description only covered the
  AI-side dispatch; 8.1.6's was outbound-only (motir-core → motir-ai for
  checkout/portal); the symmetric inbound path was missing. This ADR adds
  **8.1.4c — "motir-ai → motir-core: scaled-tracker subscription propagation +
  Organization flag"**: a service-auth `POST /api/internal/billing/scaled-tracker-state`
  on motir-core (4-layer-clean, idempotent), an
  `Organization.scaledTrackerSubscription` JSON column (the flag 8.1.11's caps
  read), and a `motirCoreClient.tracker.setScaledState()` boundary client in
  motir-ai. **8.1.4b is `blocked_by` 8.1.4c** so its tracker-events dispatch
  has a target; **8.1.4c is `blocked_by` 8.1.4** (needs the StripeSubscription
  schema with priceId → tier link). Trust boundary: a shared
  `MOTIR_AI_TO_CORE_SERVICE_TOKEN` env var. Stripe SDK stays in motir-ai (the
  open-core invariant holds).
- **8.1.8 (MOTIR-1149)** is the **Axis-A** paywall — the `out_of_credits` 402 +
  tier gate at the AI boundary (upgrade prompt when allotment is exhausted and no
  top-up is allowed on `free`).
- **⚠️ Planning gap surfaced — Axis-B caps have no owner → new subtask 8.1.11.**
  None of the existing 8.1 subtasks enforces the §4 **PM-core scale caps** (the
  work-item / project / upload / workspace / org-creation gates + the
  paid-org-to-create-orgs rule + the non-destructive downgrade-lock). 8.1.6/8.1.7
  build the billing _boundary + settings_; 8.1.8 is the _AI_ paywall; none gates
  work-item creation, `createProject`, the attachment upload, `createWorkspace`, or
  `createOrganization` against the org's **scaled-tracker state**. This ADR adds
  **8.1.11 — "motir-core: PM-core entitlement/cap enforcement (work-item / project /
  upload / workspace / org gates by the org's SCALED-TRACKER subscription state,
  cloud-only)"**, `blocked_by` this decision, to own that contract (a single
  scaled-tracker-aware entitlement helper the work-item-create / project-create /
  workspace-create / org-create services + the attachment-upload path call, behind
  `MOTIR_CLOUD`. **Crossing any cap requires the scaled-tracker subscription (a
  motir-core org flag) to be active — the AI `PlanTier` is independent and never
  lifts a cap.** All caps measured at the `Organization`, the work-item count
  counts ALL work items in the org (a plain row count, no archive filter), the per-file gate turns the already-shipped
  `MAX_UPLOAD_BYTES` (`lib/blob/allowlist.ts`) into a tier-derived limit, and the
  **total-storage gate is net-new** — `SUM(Attachment.sizeBytes)` per org checked
  at upload, which nothing does today).
- **Self-host stays GPL-3.0 and uncapped** — the caps + billing live behind
  `MOTIR_CLOUD`; the open-core PM tracker a self-hoster runs is unbounded and
  shows no checkout. The cross-story audit stays clean: 8.1 takes no dependency on
  Epic 7 internals beyond the already-shipped credit ledger it builds on.
- **MOTIR-1106 (8.6.2)** is the same pricing-strategy decision in Epic 8.6 and is
  now redundant with this ADR — close it as a duplicate, pointing here.
- **⚠️ DECIDED — a two-lane credit margin; the AGENT lane runs near-cost (Yue,
  2026-06-23; §2).** The v1 pool sizes (Standard 2,000 / Pro 8,000 / Max 30,000) were
  sized off **planning** burn (a pass ≈ 150–250 credits); **agent** burn (coding +
  doc-writing + design + manual-task assist + future types) is far heavier, and at
  the v1 credit markup a user reads it against Cursor's near-cost compute and finds
  it ~8–10× pricier. **Decision:** keep the high **planning** margin; meter the
  **agent lane at ~20% (near-cost, over tokens + hosting)** so credits burn slowly
  and stay within Cursor's ballpark (never ~10× pricier) — the moat is the **automatic
  agent loop**, not price. **No code in 8.1** (the rate is effective-dated config;
  nothing meters the agent loop until Epic 9). **Owner and implementation: see the
  2026-09-04 amendment in §2** (MOTIR-4331 owns it, Epic 9 is the first consumer, and
  the implementation is the `lane` dimension on `ModelCreditRate`); pool-size growth
  and BYO-API-key are secondary levers if needed. The 8.1.21 / MOTIR-1311 copy
  fix (promise _running_ the agent + top-ups, never "whole tasks") is the interim
  guard. Detail in the private `motir-meta/margin-analysis.md` §9.
- **Out of scope (named so they land in their owning story):** the actual Stripe
  account creation (a `manual/human` prerequisite of 8.1.2); platform-staff
  manual tier flips for Enterprise (Epic 10); the org-scoped usage/credit _view_
  (Story 7.12.5); per-region tax registration ops (operational, not code).
