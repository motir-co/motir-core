# Billing · pricing · paywall — design notes

Design reference for the **`billing`** UI area — the **commercial surfaces** that
gate Motir's two billed products. Story 8.1 (Stripe billing + open-core tiering),
subtask **8.1.3** (card **MOTIR-1142**). The asset is the source of truth for the
two motir-core UI code subtasks, both `blocked` behind this design gate
(Principle #13 + the design-reference rule; `notes.html` #31):

| Code subtask                                                         | What it builds from this asset                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **8.1.7 / MOTIR-1148** — billing settings panel + plan/pricing UI    | Panels **1–6, 8** (settings panel, states, storefront, seats subscription, empty/error) |
| **8.1.8 / MOTIR-1149** — paywall / upgrade prompt at the AI boundary | Panel **7** (out_of_credits 402 + tier-gate + member variant)                           |

These two cards are linked to MOTIR-1142 as `relates_to` (with the boundary
service **8.1.6 / MOTIR-1147**) — they SPECIFY the flow this design draws; the
design GROUNDS in them and does not invent it. Built FROM the real design system
(`app/globals.css` `--el-*` colour tokens + the `[data-display-style]` shape
tokens + the shipped `components/ui/*` primitives), so the code subtasks compose
the same primitives — no design→code gap.

> **Refined by 8.1.15 / MOTIR-1302 (2026-06-23)** against the SHIPPED storefront
> (`app/(authed)/settings/organization/billing/_components/BillingClient.tsx`, built
> by 8.1.7 / MOTIR-1148) — three changes, each grounded in that component +
> `billing-tiering.md`, NOT invented:
>
> 1. **Seat upgrade screen (panel 6a, shipped `SeatsView`) gains a Monthly/Annual
>    `Segmented`.** `SeatsView` hardcoded annual (`checkout(seat.annual…)`, all-annual
>    terms); the catalog already carries `seatPlan.prices.monthly` (`$5`) +
>    `.annual` (`$40`), so the toggle re-prices the seat total, terms & CTA exactly
>    like the AI storefront's `PlansView`.
> 2. **The on-page cloud-only note (shipped `CloudNote`) is dropped.** The page is
>    `notFound()` off-cloud (`isCloudBilling()`), so it ONLY renders on cloud — the
>    banner is redundant. Self-host behaviour stays documented here in prose (the
>    "Self-host" section below), never as an on-page banner.
> 3. **The Motir AI pricing blocks (panel 5, shipped `PlanCard`) are redesigned**
>    from short cards (name + price + one credits line) to the standard SaaS tier
>    pattern (Linear / Vercel / Stripe): tall, equal-height cards in ONE row, each
>    with a per-tier use-case line + a cumulative "Everything in {previous}, plus …"
>    feature list.
>
> Code follow-ups blocked on this asset: **8.1.16 / MOTIR-1303** (seat toggle +
> drop the note) and **8.1.17 / MOTIR-1304** (pricing blocks).

| Surface                                                     | Asset                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Billing settings · pricing storefront · AI paywall**      | **`billing.mock.html`** (HTML mockup)                              | The whole commercial surface, 8 panels: access path · billing settings panel (2 billed lines) · panel states (past_due / trialing / canceled) · role gating · Motir AI plans & subscription (AI-only screen, Monthly/Annual toggle) · Motir seats plan & upgrade screen · AI paywall (402 + tier-gate) · empty/loading/error. A `billing.png` full-page export sits beside it (the board-visible face).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Motir CI — the third billed line** (AMENDMENT)            | **`ci-line.mock.html`** (HTML mockup)                              | The CI-minutes line the allowance adds to the settings panel, 8 panels: the line in place at real width · its three non-paused states · `ci_credits_exhausted` for an admin (the two-option decision, measured in a 1280×800 viewport) and for a member (the routing alert) · what renders nothing · loading / balance-unreachable / error · the pointer form on other surfaces · the paused-state card ordering. Amends the row above; redraws none of it. `ci-line.png` beside it. See § "Amendment 2026-07-30 — the Motir CI line" at the end of this file.                                                                                                                                                                                                                                                                                                                  |
| **Motir Search — the FOURTH billed line** (AMENDMENT)       | **`search-line.mock.html`** (HTML mockup)                          | The web-search line the grounding channel adds to the settings panel, 6 panels: the line in place at real width beside ①②③ · its states (spend · nothing billed · the ABSENCE of a paused state, drawn) · the META org, which renders no line · loading / figures-UNAVAILABLE / page error · role gating · the access path, reproduced. Amends the two rows above; redraws neither. `search-line.png` beside it. See § "Amendment 2026-09-05 — the Motir Search line" at the end of this file.                                                                                                                                                                                                                                                                                                                                                                                  |
| **Contact sales — the Enterprise request form** (AMENDMENT) | **`billing--contact-sales.mock.html`** (HTML mockup)               | What the Enterprise card's Contact sales opens, 10 panels: access path · the control closed (manager / member disabled / Request sent) · the form empty and filled · validation · sending · sent · the open request read-only · refused (409 / 403) and network error · `zh` · narrow. Amends panel 5's Enterprise CTA only. See § "Amendment 2026-10-05 — Contact sales opens a request form" at the end of this file.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **The Calculator view** (AMENDMENT)                         | **`billing--calculator.mock.html`** (HTML mockup)                  | The fourth view of Billing & plans and the one link that opens it, 18 panels: S1 the link in the plans view's intro block · S2 initial · S3 ready · S4 asking · S5 categories loading · S6 categories unavailable · S7 a category with no live model · S8 populated (with Max ×2 on both cadences) · S9 above the largest pool · S10 top-up only · S11 the upgrade line and its two neighbours · S12 a retired model · S13 four inline refusals · S14 estimate unavailable · S15 request failed · S16 roles · `zh` · narrow. Amends panel 5's intro only (the link); a fourth view. **Dated note (2026-10-14, MOTIR-8636):** the AI ladder, its pools, the Enterprise card and the top-up rate are read from `lib/billing/catalog.ts` and supersede this file's figures. See § "Amendment 2026-10-14 — the Calculator view and the link that opens it" at the end of this file. |
| **The larger credit pool plan** (AMENDMENT)                 | **`billing--larger-pool.mock.html`** (HTML mockup)                 | One more card at the end of the plans row, offered only from an estimate, 12 panels (with a 2b neighbour): no estimate · offered (the arrival, annual) · upgrade · current · the ladder covers it (absent, no notice) · above the top band (absent, one notice) · read-only · cadence switched · purchase refused · loading · read fails · narrow + dark. Amends panel 5's plan row only. See § "Amendment 2026-10-21 — the larger credit pool plan" at the end of this file.                                                                                                                                                                                                                                                                                                                                                                                                   |
| **The Calculator — planned and run ranges** (AMENDMENT)     | **`billing--calculator--planned-and-run.mock.html`** (HTML mockup) | The Calculator's one items range becomes two (items planned in Motir · items run on Motir's runner, with the own-agent help), 3 panels: the inputs · the priced-range line in the answer · both ranges at 0 refused. Amends the Calculator view's inputs only. See § "Amendment 2026-10-21 — the Calculator's planned and run ranges" at the end of this file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **The Host plan** (AMENDMENT)                               | **`billing--host.mock.html`** (HTML mockup)                        | A fifth paid card after Max ×2 and every state it brings, 13 panels: the row monthly · annual · Choose Host redirecting · member disabled · org on Max ×2 · the upgrade to Host (ready, loading, error) · its success and Host Current · Host in the unfolded regular plans (and Pool 250,000 → Host) · org on Host · the downgrade from Host and its success · the pending downgrade from Host · `zh` · narrow. Amends panel 5's plan row and the larger-pool amendment's unfolded regular plans. See § "Amendment 2026-10-23 — the Host plan" at the end of this file.                                                                                                                                                                                                                                                                                                        |

## What this area is

The **org owner's home for money** — the surface that SELLS where the sibling
**`ai-usage`** dashboard only SHOWS. The two compose side by side in the
org-settings area and must not duplicate: **`ai-usage` = spend / balance / drill
/ run log; `billing` = plan / subscription / payment / checkout / paywall.** The
billing panel cross-links to Usage & cost (panel 2) rather than re-drawing the
balance dashboard.

### The locked model this draws (read at run time — do NOT invent)

> **Superseded figures (2026-10-14, MOTIR-8636):** the ladder figures below are NOT current and
> must not be built from. Superseded: **Standard 2,000 credits / mo** and **Pro 8,000 credits /
> mo**, the **Enterprise (custom)** card, and the **$10 / 1,000** credit top-up. The source is
> `lib/billing/catalog.ts` — pools **5,000 / 15,000 / 30,000**, **Max ×2** at **60,000** as a
> plan of its own on both cadences, **no Enterprise entry**, and a top-up of **$5 per 1,000** —
> and it wins wherever this file disagrees. See § "Amendment 2026-10-14 — the Calculator view and
> the link that opens it" at the end of this file.

Everything here is grounded in **`docs/decisions/billing-tiering.md`** (8.1.1 /
MOTIR-1138, **Accepted 2026-06-21**). The load-bearing facts:

> **Terminology (Yue, 2026-06-21): there is no "Tracker" customer-facing.** The
> two products' user-facing names are **"Motir"** (the PM tool — the seat plan)
> and **"Motir AI"** (the credit plan). "Tracker" survives ONLY as code
> identifiers — the `scaled-tracker` motir-core org flag and the
> `tracker_monthly` / `tracker_annual` Stripe price lookup keys — never as a UI
> label. This asset labels its two lines "Motir" and "Motir AI".

- **TWO billed products** (decision §1), largely independent with **ONE bundle: a
  paid AI plan includes 1 Motir seat** (8.1.22 / MOTIR-1316). Your bill = ① + ②:
  - **① Motir** (the PM tool) — **free** for any team within the caps,
    **$5 / seat / mo** ($40 / seat / yr — the annual default, ~33% off) only when
    the org crosses a cap. The scaled state is a **motir-core org subscription
    flag**, NOT the AI tier.
  - **② Motir AI** (planning + agents) — an **org-level monthly credit plan**, prices
    firm from the Stripe sandbox catalog (8.1.2 / MOTIR-1141; `starter` removed
    by the 2026-06-23 amendment, 8.1.18 / MOTIR-1308): **Free** (300
    credits, one-time trial, $0) /
    **Standard** ($25/mo · $200/yr, 2,000/mo) / **Pro** ($75/mo · $600/yr,
    8,000/mo — the **recommended anchor**, `pro_pool_annual` is the Stripe default
    Price) / **Max** ($150/mo · $1,200/yr, 30,000/mo) / **Enterprise** (custom).
    This is the motir-ai `PlanTier`. Any org — free- or scaled-Motir — can buy it.
    **Each PAID plan includes 1 Motir seat → the org's §4 caps are lifted** (the
    solo plan-with-AI case is never walled at 250 items; members beyond the first
    bill at $5/seat). The Free trial does NOT include a seat. Overage **credit
    top-up is $10 / 1,000** (one-time at Checkout).
- **Free-tier caps** (decision §4, drawn in the Motir line, panel 2): **≤ 250
  work items** (archived + active), **≤ 3 projects**, **1 workspace**, **10 MB /
  file**, **2 GB total**, **unlimited members**.
- **Subscription lifecycle** (decision §5) → the status `Pill`:
  `trialing` / `active` / `past_due` / `canceled`. `past_due` keeps access
  through the grace window with a warning banner; `canceled` drops to the free
  allotment, **data retained, never deleted**.
- **Credits are an internal ALLOTMENT, never a currency in-product.** The balance
  / allotment is labelled "credits" everywhere. The ONLY place a currency (`$`)
  appears is the **plan FEE** the org pays Stripe — the pricing storefront
  (panel 5) and the AI-plan fee line (panel 2). That is a price, not a credit
  count.
- **Permissions** (decision §7): billing **mutations are owner-only**; an **admin
  views** (read-only); a **member** is routed to an owner.
- **402 at the AI boundary.** motir-ai raises `out_of_credits` → **HTTP 402**
  (`OutOfCreditsError`, `src/problem.ts:16`), surfaced over the 7.1 boundary. The
  paywall (panel 7) handles it.

### Where it lives + the access path (panel 1)

- The billing surface lives in the **org-settings area**
  (`app/(authed)/settings/organization/…`), **org owner/admin gated** (a member
  gets the panel-4b routed-to-owner state, not a 404). It **REPLACES the passive
  `BillingPlaceholderCard`** (`_components/BillingPlaceholderCard.tsx`, the
  "Billing & usage — Coming soon" card) with the live surface.
- **Access path — drawn, not just named (mistake #31).** The shell TopNav **org
  menu** (the 6.10 org-admin menu holding Settings / Members / Usage & cost)
  carries a **"Billing & plans"** item — the row the `ai-usage` design left as a
  passive "Coming soon" now goes **active**. Selecting it opens the billing area;
  the settings stack shows the live **Billing card** (the door) where the
  placeholder used to sit. Panel 1 draws the TopNav, the open org menu with
  **"Billing & plans"** as the active row (`--el-tint-lavender`, the
  credit-card icon), and the destination settings stack — composing the shipped
  `Popover` + menu `opt` grammar, not a new control. Given the surface's size,
  8.1.7 MAY promote it to a dedicated `settings/organization/billing` route
  (sibling of `usage/`) — either way the access door is the org-menu row + the
  settings entry.
- **Data over the 7.1 boundary.** Subscription/tier figures are fetched
  client-side over the motir-core ↔ motir-ai boundary (the 8.1.6 billing service
  → 8.1.5 motir-ai endpoints): the loading skeleton (panel 8b) and the
  fetch-failed error (panel 8c) are real states. Numbers in the mock are
  illustrative.

### Self-host — these surfaces are CLOUD-ONLY

Billing **and** the §4 caps exist **only on cloud**, behind the **`MOTIR_CLOUD`**
flag (decision §6). On a self-hosted (GPL-3.0) build **none of these surfaces
render** — no Billing card, no paywall, no caps; Motir is unbounded and AI
is reached via the self-hoster's own connection. 8.1.7/8.1.8 MUST gate every
surface here behind `MOTIR_CLOUD` (a note states this on panel 7). This flag is
**distinct from** `isAiPlanningConfigured` (which gates whether AI is reachable).

> **No on-page "Cloud-only" banner (8.1.15 / MOTIR-1302).** Because the billing
> page already `notFound()`s off-cloud (`isCloudBilling()`), it ONLY ever renders
> on cloud — so a per-page "Cloud-only" banner (the old `CloudNote`) told the
> on-cloud reader something that is always true and never reaches the self-host
> reader at all. It is dropped from every panel. **This section is the canonical
> record of the self-host behaviour** — do not re-add an on-page banner.

---

## Panels (review EACH — mistake #31)

### Panel 1 — access path (the entry point)

The TopNav org menu OPEN with **"Billing & plans"** as the active row, and the
org-settings stack below with the live **Billing card** replacing the passive
placeholder. The card carries a one-line summary (`Motir · Free`, `Motir AI ·
Standard`, an `Active` status `Pill`) and an **Open** affordance. The door is
drawn; the room is panels 2–7.

### Panel 2 — billing settings panel (owner, populated & active — the PRIMARY view)

A `stack` of `Card`s under the `Organization · {org} · Billing & plans`
breadcrumb. The two billed lines + payment:

- **① Motir line (`Card`).** Head: a mint product glyph (`i-layers`), title
  **"Motir"**, a state `Pill` (**"Free"** neutral / **"Scaled"** when paid).
  Body on `free`: a one-line explainer, then a **caps grid** of three cells —
  **Work items** `182 / 250`, **Projects** `2 / 3`, **Storage** `0.4 / 2 GB` —
  each with a token-only `.meter`. Then a **seat preview** (`.seatcalc`): the
  member avatars + **"Scaling bills 1 seat per member — 6 today"** and the
  resolved total **"6 × $5 = $30 / mo"**, so the per-seat price is concrete before
  the user ever clicks. Action: **"Upgrade Motir"** + a **"Seats follow membership
  · prorated automatically"** caption. (On a `scaled` org the caps grid is replaced
  by the billed seat count + renewal and the action is "Manage seats" — panel 6b.)
- **② Motir AI line (`Card`).** Head: a lavender product glyph (`i-sparkle`),
  title **"Motir AI"**, the subscription status `Pill` (**Active**). Body: a tier
  `Pill` (**"Standard"**) + the subscription amount **"2,000 credits / mo"** +
  — **when the org holds purchased top-ups — an `--el-tint-sky` `pill-topup`
  beside it: `+3,000 top-up`** (the EXTRA credits, distinct from the recurring
  allotment) + the **plan fee "$25 / mo"** (right-aligned). Then the **allotment
  meter** with **"1,420 of 2,000 left"**, and a second `meterlbl` totalling the
  two pools: **"+3,000 top-up credits (extra · don't expire)"** | **"4,420 credits
  available"**. The `desc` notes **"monthly allotment resets; purchased top-up
  credits roll over"**. (No top-up held → the `pill-topup` + the total line are
  omitted; the meter reads the allotment alone.) Actions:
  **"Change plan"** (primary → panel 5), **"Manage plan & payment"** (secondary,
  `i-external` → Stripe Customer Portal), and the **"View Usage & cost"**
  cross-link (`i-coins`, to the `ai-usage` dashboard).
- **Payment & invoices (`Card`).** A payment-method row (card brand chip + `••••
4242` + expiry + an Update affordance) and a **"Stripe Customer Portal"**
  button (`i-external`) — the Portal owns invoices, VAT ID, payment-method change
  and cancellation. A dashed `note` states tax is applied automatically.

### Panel 3 — panel states (the non-happy subscription lifecycle, decision §5)

- **(a) `past_due` / dunning.** The status `Pill` is **"Past due"** (`pill-pastdue`);
  a **`--el-tint-yellow` warning banner** ("We couldn't charge your card… stays
  active while we retry over ~2 weeks") with an **"Update payment"** primary
  action; the allotment meter fills in `--el-warning`. Access is KEPT through
  grace.
- **(b) `trialing` / Free (one-time grant).** Status `Pill` **"Free trial"**
  (`pill-trial`, sky); the one-time **"185 of 300 credits left"** meter; copy
  that the grant doesn't refresh; a **"Choose an AI plan"** primary.
- **(c) `canceled` → free.** Status `Pill` **"Canceled"** (`pill-canceled`, rose);
  a **`--el-tint-rose` banner** stating the plan ended, the org is back on the
  free allotment, and **nothing was deleted** (plans / work items / history
  intact); a **"Resubscribe"** primary.

### Panel 4 — role gating (decision §7)

Two mini-surfaces side by side so the gate is visible:

- **(a) Org admin — view-only.** The same AI-plan card with a **"View only"**
  `Pill` (`i-eye`), the allotment meter, and **no** Change-plan / Portal buttons;
  a lock `note` explaining changing the plan / payment / cancelling is
  **owner-only**.
- **(b) Org member — no billing access.** An `EmptyState`-style gate (`i-lock`,
  `--el-tint-lavender` icon) — **"Billing is managed by your org owner"** — with
  a **"Contact an owner"** secondary, never a dead billing control.

### Panel 5 — Motir AI — plans & subscription (a SEPARATE, AI-ONLY screen)

> **Why its own screen (Yue, 2026-06-22).** The two products are **independent**
> (ADR §1 — "neither gates the other"), so the AI plan gets its **own screen**, not
> a shared "choose your plans" page bundling seats. A user who **already pays for
> seats** should not wade through the seat plan to change AI — and vice-versa. So:
> **Motir AI lives here (panel 5); Motir seats live on their own screen (panel 6);
> neither screen shows the other product.** The billing home (panel 2) is the hub
> with one line per product, each routing to its own screen: the Motir-AI line's
> **"Change plan"** → here; the Motir line's **"Upgrade Motir"** → panel 6.

Reached from the Motir-AI line's "Change plan" (panel 2) and the paywall (panel 7),
under the `… · Motir AI` breadcrumb. The screen is **pricing AND subscription**:

- **Current-subscription strip (`.curbar`).** At the top: the active AI plan — a
  **"Standard"** tier `Pill` + **"Active"** status `Pill` + "2,000 credits / mo ·
  1,420 left · renews 1 Jul 2026" + a **"Manage plan & payment"** (→ Portal)
  button. So a returning subscriber sees their state first, then the ladder to
  change it. (Omitted / replaced by a "no AI plan yet" line for a free-AI org.)
- **Monthly / Annual cadence toggle (the SaaS-standard pricing control).** A
  `Segmented` ("Monthly" | "Annual") sits **below the headline, above the cards** —
  the single highest-impact control on a pricing page. **Annual is the default**
  (the Stripe annual default; defaulting to annual lifts annual adoption ~25–35%)
  with a **"Save ~33%"** `seg-badge`; **Monthly is always available** (hiding it
  erodes trust). It re-prices the ladder (`setCadence()` flips
  `.store[data-cadence]`; CSS shows `.cad-a` / `.cad-m`). The pattern follows the
  verified SaaS convention (mirror below):

- **Annual selected (default):** each paid card shows the **per-month equivalent**
  (`$50 / mo`, not the yearly lump) with a `billed annually · $600 / yr` subline
  and a green **`Save $300/yr`** `save` pill — **dollar** savings, which beat a
  bare "%". (Per-month-equivalent + dollar-savings are the two display rules the
  mirror sources converge on.)
- **Monthly selected:** the card shows the monthly fee (`$75 / mo`) with a
  `$900 / yr · Save $300 with annual` nudge back toward annual.
- The `$0` Free cards and the **Enterprise** (Custom) card are cadence-inert.

The PNG captures the **Annual** default. 8.1.7 wires the toggle to the two
annual/monthly Stripe Prices (`*_annual` is the Product's default Price).

The cards (AI ladder only — the Motir seat plan is panel 6, never shown here):

- **The Motir AI ladder — the standard SaaS pricing-tier pattern** (rung 1 —
  Linear / Vercel / Stripe). **Five** `plan` cards — the **Free** trial + the four
  named paid tiers **Standard / Pro / Max / Enterprise** (`starter` removed by the
  2026-06-23 amendment, 8.1.18 / MOTIR-1311) — that are **TALL, equal-height, and laid
  out in ONE row** (the `.ai-grid` is a `display:flex` row, `align-items:stretch`
  equalising height so the CTAs sit on a common baseline; `flex:1 0 0` +
  `min-width:158px` per card; five cards fill the row more generously than the prior
  six). **Responsive rule (drawn):** below the row's natural
  width the container **scrolls horizontally** (`overflow-x:auto`, scroll-snap) —
  the five cards stay one comparable ladder, never wrapping to a second row or
  dropping tiers. Each card, top → bottom:
  1. **Tier name** (+ `i-zap` / `i-crown` accent glyph for Pro / Max, + the
     "Current" / "Recommended" `Pill`).
  2. **A per-tier USE-CASE line (`.use`, who it's for)** — the new top-of-card
     line, secondary colour, ~3-line `min-height` so the price rows align across
     cards. The ladder is **planning DEPTH then agent USAGE**: planning depth tops
     out at Standard (whole project, in detail); Pro and Max only scale agent work.
     **Free** "Trying Motir AI out." / **Standard** "Detailed planning, plus a taste
     of agent." / **Pro** "Detailed planning, plus real agent work." / **Max**
     "Detailed planning, plus heavy agent work." / **Enterprise** "Custom volume,
     plus org controls."
  3. **The cadence-aware price** (serif `.amt`) + the billed/save subline.
  4. **The credit allotment** (`.alot`, the load-bearing figure, bold) — the credit
     COUNT lives here, so the feature bullets stay capability-focused (no count
     duplication).
     4b. **The bundled Motir seat** (`.seat`, `i-users` glyph; 8.1.22 / MOTIR-1316) —
     every PAID plan includes 1 Motir seat, so the line reads **"+ 1 Motir seat ·
     work items uncapped"** (Standard / Pro / Max) — the value point that the AI plan
     lifts the §4 work-item caps for the solo case. **Enterprise** → "Motir seats
     included (custom)". **Free** uses the `.off` variant (`--el-text-faint`) — **"No
     Motir seat · 250-item cap"** — stating the absence so the contrast is the
     upgrade reason. Sits directly under `.alot`.
  5. **A CUMULATIVE `i-check` feature list** — the cumulative chain starts at the
     first PAID tier (**Standard**, now the entry rung), so each tier from Pro up
     opens with a flush-left `.flead` caption **"Everything in {previous tier}, plus"**
     (no glyph), then its incremental extras. The deltas map to the depth→usage ladder:
     **Standard** (base of the paid ladder, NO "Everything in" — Free is just a
     trial, not the rung below) → "Plan the whole project, in detail" · "Credits
     refresh monthly · metered top-ups" · "Room to try agent tasks"; **Pro**
     (everything in Standard, plus) → "Run the coding agent on real tasks" · "Top up
     anytime for heavier runs"; **Max** (everything in Pro, plus) → "Headroom for
     sustained agent work" · "Throughput for a busy team"; **Enterprise** (everything in
     Max, plus) → "Invoiced billing & SSO" · "Dedicated support". **Free** is a
     standalone trial (no "Everything in"): "A one-time taste of every agent" + an
     `off` (`i-x`, faint) "No monthly refresh · no top-ups".
  6. **A per-tier CTA → Checkout** (pinned to the bottom via `margin-top:auto`).

  Tiers: **Free** (`$0` once · 300 credits · one-time, "Trial used") / **Standard**
  (`$25` → `$16.67/mo`
  · $200/yr · save $100 · 2,000, marked **Current** — the entry paid tier) / **Pro** (`$75` → `$50/mo` ·
  $600/yr · save $300 · 8,000, `i-zap` accent, marked **Recommended** — the anchor
  tier) / **Max** (`$150` → `$100/mo` · $1,200/yr · save $600 · 30,000, `i-crown`
  accent) / **Enterprise** (Custom). The current plan is accent-bordered + disabled
  CTA; the recommended Pro card is accent-bordered (`feat rec`) with a "Recommended"
  `Pill`. A footer `note` states annual-is-shown / switch-to-monthly,
  tax-at-checkout, credits-vs-price, an **expectation-setter that agent / coding
  work burns more credits than planning and heavier models burn faster (top up
  anytime)**, and that **seats are billed separately — manage them on the Motir
  plan screen (panel 6)** (the only cross-product link).

  > **Copy honesty (Yue, 2026-06-23):** the per-tier feature bullets must NOT
  > promise a completeness the credit pool can't back. A coding-agent task burns
  > far more than a planning pass (a pass ≈ 150–250 credits; a whole coding task
  > can run 1,000s on a premium model), so Pro's 8,000/mo ≈ a few tasks, not
  > "cover whole tasks." Bullets are framed around _running_ the agent + top-ups,
  > NOT a task count — and the footer note sets the burn expectation. Matches the
  > ADR, which scopes Pro as "planning + **a run** of hosted coding." When Epic-9
  > coding has real telemetry, revisit whether the pool SIZES (not just the copy)
  > need tuning — the margin headroom allows more generous pools.

**Credit top-up (the one-time overage purchase — `creditService.topUp()`).** Below
the ladder, a **"Top up credits"** `Card`: the recurring plan covers the monthly
allotment, top-ups are the **pay-as-you-go overage** beyond it (ADR §2/§3,
`credit_topup` Stripe Price, `mode: 'payment'` one-time). It shows the current
**balance** + allotment-used line, a row of **bundle** options
(**1,000 · $10 / 5,000 · $50 / 10,000 · $100 / Custom × 1,000**, one selected with
the accent border), a **"Buy {n} credits — ${total}"** CTA, and the rate line
(**"$10 per 1,000 credits · one-time · tax at checkout"** — a price the org pays
Stripe, distinct from the in-product credit allotment). A `note` gates it:
**top-ups need a paid AI plan — the Free trial can't top up** (matching the §2
table: Free has no top-ups), **owner-only** (§7). The paywall's "Buy credit
top-up" (panel 7a) routes here. (`$` is legitimate here — it's a purchase price,
not the credit allotment, which is never shown as currency.)

> **Mirror (rung 1 — cited).** The monthly/annual toggle is the SaaS-standard
> pricing control: place it below the headline above the cards, **default to
> annual** with a visible discount, show the **per-month equivalent** for annual
> ("$50/mo, billed annually" beats "$600/yr"), quote the **dollar** saving ("Save
> $300/yr" beats "20% off"), and **always keep monthly** available.
> ([InfluenceFlow — SaaS pricing best practices 2026](https://influenceflow.io/resources/saas-pricing-page-best-practices-a-complete-2026-guide/);
> [PipelineRoad — what converts in 2026](https://pipelineroad.com/agency/blog/saas-pricing-page-best-practices))

### Panel 6 — Motir (seats) plan & upgrade screen (the seat-only counterpart to panel 5)

This is the **Motir seat plan's own screen** — the parallel to the AI screen
(panel 5), kept separate for the same reason: it shows seats only, never the AI
plan. Reached from the Motir line's "Upgrade Motir" (panel 2). Seat = member,
billed per-seat:

Motir Scaled is billed **one seat per organization member** — the seat item's
Stripe `quantity` syncs to membership (ADR §3). So the design **shows the seat
count wherever the seat price appears**, never an abstract "$5/seat" alone. Two
sub-surfaces:

- **(a) BEFORE — upgrade review (before Checkout).** A width-constrained `Card`
  (a confirmation dialog) titled **"Scale up Motir"**. **A Monthly/Annual
  `Segmented` cadence toggle sits at the top of the body** (8.1.15 — the seat screen
  hardcoded annual before; this is the same control the AI storefront uses, labelled
  "Billing", **Annual default** with a "Save ~33%" `seg-badge`, **Monthly always
  available**). It re-prices everything below it (`setCadence()` flips
  `.store[data-cadence]`; the cadence-tagged `.cad-a` / `.cad-m` spans show/hide —
  the catalog carries `seatPlan.prices.monthly` `$5` + `.annual` `$40`). Then a
  `.seatcalc` (member **avatars** + **"6 members → 6 seats"** + the cadence-aware
  total — **"6 × $40/yr = $240 / yr"** annual / **"6 × $5/mo = $30 / mo"** monthly),
  then a **`.terms` key/value list that spells out what & when we charge** — the part
  a narrow note couldn't carry:
  - **Billing** — _annual:_ Annual, $240/yr ($20/mo equiv, the default), with a green
    **"Saves $120/yr vs monthly"** `save` badge; _monthly:_ Monthly, $30/mo ($360/yr
    — switch to annual to save $120).
  - **Due today** — _annual:_ $240, **prorated** to the renewal date (less for the
    days left this term); _monthly:_ $30, **prorated** to the renewal date.
  - **Add a member later** — a **prorated charge** for the new seat, for the rest of
    the term.
  - **Remove a member** — a **prorated credit** on the next invoice — **no mid-term
    refund**.

  Then a short `note` (seats follow membership automatically via Stripe proration;
  pick Monthly/Annual above before continuing — the old "switch at Checkout" line is
  obsolete now the toggle is in-page) and the **cadence-aware CTA** (**"Continue to
  Checkout — $240/yr"** annual / **"— $30/mo"** monthly) + Cancel. (Implementation
  note: a `.note` is `display:flex`; its text MUST be wrapped in ONE `<span>` — bare
  text + inline `<b>` become separate flex items and shred into narrow columns. The
  cadence variants use bare `.cad-a` / `.cad-m` hooks — the visibility rule keys on
  those classes, not on `.cad`, so they stay plain inline spans, no `.price`
  inline-flex.)

- **(b) AFTER — the live Motir seats subscription (full-width).** The **scaled
  counterpart to panel 2's free-Motir line** — same `Card` grammar as the Motir-AI
  line, so the paid Motir plan reads as a real subscription, not a fragment. Head:
  the `i-layers` glyph, **"Motir"** / "scaled seats subscription", an **"Active"**
  status `Pill`. Body: a `.row1` with a **"Scaled"** tier `Pill` + **"6 seats"** +
  the right-aligned **"Plan fee $240 / yr"** + an **"Annual · saves $120/yr"**
  `save` pill; a `.seatcalc` (avatars + **"6 seats billed · 1 per member"** + **"6 ×
  $40/yr = $240 / yr"**); a `desc` — **"Billed annually · $20/mo equiv · renews 1
  Jul 2026. All free-tier caps lifted … seats track membership: adding a member adds
  a prorated charge for the rest of the term; removing one applies a prorated credit
  to the next invoice (no mid-term refund)."**; actions **"Manage seats"** (`i-users`),
  **"Manage plan & payment"** (→ Portal), and a **"Switch to monthly billing"**
  cross-link. (This is the surface the user lands on after subscribing; panel 2
  shows the same org's Motir-AI line + the _free_ Motir line. The plan defaults to
  the **annual** rate — the Stripe annual default the storefront also defaults to.)

> **Mirror (rung 1 — cited).** Showing the billed seat count at upgrade is how
> both reference PM tools work. **Linear** bills for the number of **active
> (unsuspended) members** in any role, surfaces that count in Settings → Billing,
> and **prorates** mid-cycle changes by date. **Jira** bills per user and shows
> the **user tier** you occupy. Motir mirrors Linear's "seats = active members,
> prorated" model (the closer fit — Motir caps scope like Linear, not seats).
>
> **Mid-cycle changes on an ANNUAL seats plan — what & when (the panel-6 copy).**
> Both mirrors agree, and Motir (Stripe proration, ADR §5) follows them:
>
> - **Add a member mid-term → a prorated CHARGE for the new seat covering the rest
>   of the annual term**, at the annual per-seat rate. _Linear_ generates a
>   prorated charge for the remaining year, reconciled on a **monthly true-up**
>   invoice tied to the annual start date (charged automatically); _Jira_ charges
>   the added seat prorated through the remainder of the annual term. (Motir =
>   Stripe `create_prorations`; surface it as "a prorated charge for the rest of the
>   term".)
> - **Remove a member → a prorated CREDIT applied to future invoices, NOT a cash
>   refund; the annual total does not drop mid-term.** _Linear_ issues a credit on
>   suspension applied to future invoices; _Jira_ defers the reduction to the next
>   billing cycle. (Motir mirrors this: credit-to-next-invoice, no mid-term refund.)
>
> ([Linear — Billing & plans](https://linear.app/docs/billing-and-plans);
> [Atlassian — manage users & user tiers](https://support.atlassian.com/subscriptions-and-billing/docs/manage-users-and-user-tiers/))

> **Implementation owner (do NOT build it here).** The mechanism behind this
> proration — keeping the Stripe seat `quantity` in sync with org membership on
> invite/remove — is **8.1.12 / MOTIR-1256** (a motir-ai `seat-quantity` endpoint
>
> - a motir-core membership-change hook, behind `MOTIR_CLOUD`, surfaced as a
>   planning gap on 2026-06-22). It is NOT in 8.1.7/8.1.8: those render these states
>   (the panel-6 subscription card + the invite-time seat note); the seat-quantity
>   write itself is 8.1.12. Inviting a member **does not** pop a Checkout/pay-wall —
>   the seat count updates and Stripe accrues the prorated delta to the **next
>   invoice** (auto-charged on the card on file; a monthly true-up for annual).

### Panel 7 — paywall at the AI boundary (8.1.8)

The in-product upsell. **This ACTIVATES the passive "out of credits" slot the
`ai-usage` design drew** (its panel 7b `.passive-slot`, shipped as
`OrgUsageClient` `OutOfCreditsCard`) — that placeholder becomes a real Upgrade
CTA here.

- **(a) `out_of_credits` (402), owner — at the planner composer.** The AI entry
  (a faded compose bar + disabled **Plan** button) over a **blocked** `state`
  (`i-pause`, `--el-tint-yellow` icon): **"Planning is paused — you're out of
  credits"**, NAMING the limit ("all of this month's 2,000 Standard credits"),
  with an **active "Upgrade plan"** primary (`i-arrow-up`) + **"Buy credit
  top-up"** secondary. Existing plans stay editable.
- **(b) Tier-gate — free org that never bought AI.** A `gate` state (`i-sparkle`,
  `--el-tint-lavender`): **"AI planning is a paid feature"** with **"See AI
  plans"** primary + **"Maybe later"** ghost; mentions the 300 free trial
  credits.
- **(c) Member variant — can't buy.** A `gate` state (`i-lock`): **"AI is out of
  credits for this org"** with **"Ask an owner to upgrade"** — never a dead CTA
  (decision §7: a member's prompt routes to an owner).

### Panel 8 — empty / loading / error

- **(a) Empty / first-run** — no Stripe customer yet: a `state` (`i-card`),
  **"You're on the free plan"**, **"See plans"** CTA.
- **(b) Loading** — the panel `Skeleton` (`aria-busy`) while fetching status over
  7.1.
- **(c) Error** — the billing fetch failed (boundary/Stripe down): an error
  `state` (`i-alert`, `--el-tint-rose` icon), **"Couldn't load billing"**, "your
  subscription and credits are safe", a **Retry** secondary — not a
  broken-looking zero.
- A closing dashed `note` states the **cloud-only / `MOTIR_CLOUD`** gate
  (self-host hides everything here).

---

## Primitives composed (no hand-rolling)

Every surface composes a shipped `components/ui/*` primitive; the mock mirrors
the `ai-usage` mock's grammar so 8.1.7/8.1.8 reuse the same code. If they need a
genuinely new primitive, that is a **new `design/` subtask**, not a code
workaround.

- **`Popover` + menu rows (the access path, panel 1)** — the org menu's `opt`
  rows (the org-admin switcher grammar): rows at `--spacing-control-*` /
  `--radius-control`, the active **"Billing & plans"** row `--el-tint-lavender`.
- **`Card`** — every line (Motir / Motir AI / payment), the state cards, the
  plan cards, the loading skeleton wrapper (`--radius-card`, `--shadow-card`,
  `--spacing-card-padding`; head/body/foot split by `--el-border-soft`).
- **`Pill`** — the **subscription-status** chips (Active / Free trial / Past due /
  Canceled / View only), the **tier** chip, the **Motir-state** chip, the
  **Current** marker. `--radius-badge`, `--spacing-chip-*`; **hue in the tint
  BACKGROUND with `--el-text-strong` text (finding #35 — AA-safe), never a tinted
  page surface.**
- **`Button`** — primary (Upgrade / Change plan / Resubscribe), secondary (Manage
  plan / Portal / Retry / Contact owner), ghost (Maybe later / Update). Heights
  `--height-btn-md` / `--height-btn-sm`; padding `--spacing-btn-x[-sm]`.
- **`Segmented`** — the **Monthly / Annual** cadence toggle, now on **BOTH** the AI
  storefront (panel 5) **and the seat upgrade screen (panel 6a — 8.1.15)**: the
  shipped `components/ui/Segmented.tsx` grammar — an `--el-surface` track
  (`--radius-btn`, 2px inset), each option `calc(--radius-btn - 2px)` so it nests at
  any style, the active option `--el-page-bg` + `--shadow-subtle`. A `aria-pressed`
  group; the Annual option carries the `Save ~33%` badge. Reuse it — do not
  hand-roll. (Both screens hold a local `BillingCadence` state defaulting to
  `'annual'`; `SeatsView` gains it, mirroring `PlansView`.)
- **Plan-card use-case + cumulative-feature lines (panel 5 — token-only, NO new
  primitive)** — the per-tier `.use` line is `--el-text-secondary` at the card top
  (a `min-height` aligns the price rows); the cumulative `.flead` lead
  ("Everything in {prev}, plus") is a flush-left `--el-text-secondary` caption (its
  `i-check` glyph hidden) introducing the `i-check` (`--el-success`) incremental
  bullets. Both are plain styled text inside the existing `.plan` card — no new
  component.
- **`EmptyState` / `ErrorState` family** — the member gate (4b), the tier-gate +
  member paywall (6b/6c), empty/error (7a/7c).
- **`Skeleton`** — the loading panel (7b).
- **Meter / bar (token-only)** — the allotment meter + the free-cap meters are
  plain token-styled `div`s (radius + tint), no charting lib, no image — the same
  `.meter` pattern as `ai-usage`.
- **Avatar stack + seat calc (panel 6, panel 2 preview)** — the overlapping member
  **avatars** reuse the shipped member-avatar token grammar (`--radius-badge`,
  pastel `--el-tint-*` fills + `--el-text-strong`, a `--el-page-bg` ring); the
  `.seatcalc` row is a token-styled `Card`-like band (`--el-surface-soft`,
  `--radius-card`, `--el-border-soft`) — no new primitive. 8.1.7 sources the seat
  count from membership (the seat `quantity`), not a hand-typed number.

## Colour roles (`--el-*` — palette, not grey-only · finding #54)

| Element                                      | Token                                                             | Why                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Plan price / credit figures (serif)**      | `--el-text` · unit/`per` in `--el-text-muted`                     | The primary numbers; the unit/price-cadence reads quiet.                                         |
| **Tier chip (Standard / Pro / …)**           | `--el-tint-lavender` bg + `--el-text-strong`                      | The AI plan tier — brand-purple family, matches the org avatar.                                  |
| **Top-up chip (`+N top-up`)**                | `--el-tint-sky` bg + `--el-text-strong`                           | Purchased extra credits — a DISTINCT tint from the tier/allotment so the bonus pool reads apart. |
| **Status: Active**                           | `--el-tint-mint` bg + `--el-text-strong`, `i-check`               | Healthy / paid — success family.                                                                 |
| **Status: Free trial / trialing**            | `--el-tint-sky` bg + `--el-text-strong`, `i-sparkle`              | Informational, not yet paid — the info/try family.                                               |
| **Status: Past due (dunning)**               | `--el-tint-yellow` bg + `--el-text-strong`, icon `--el-warning`   | Warning, recoverable — keep-through-grace, not danger.                                           |
| **Status: Canceled**                         | `--el-tint-rose` bg + `--el-text-strong`, `i-x`                   | Ended / dropped — danger family (but data retained).                                             |
| **Motir-state: Free / View-only / readonly** | neutral `Pill` (`--el-surface` + `--el-text-secondary`)           | Genuinely neutral state metadata.                                                                |
| **Allotment meter fill (healthy)**           | `--el-accent`                                                     | Primary "credits remaining" share.                                                               |
| **Allotment meter fill (low / past_due)**    | `--el-warning`                                                    | Low-balance / dunning variant.                                                                   |
| **Free-cap meters**                          | `--el-accent`                                                     | Usage-against-cap share.                                                                         |
| **Dunning / warning banner**                 | `--el-tint-yellow` bg + `--el-text-strong`, icon `--el-warning`   | Warning hue in the BANNER tint, not the page (finding #35).                                      |
| **Canceled banner**                          | `--el-tint-rose` bg + `--el-text-strong`, icon `--el-danger-text` | Ended-plan notice — danger tint in the banner only.                                              |
| **Info / tax / cloud-only notes**            | `--el-surface-soft` dashed (`--el-border-strong`) · `i-info`      | Quiet, dashed advisory — the passive-affordance shape.                                           |
| **Out-of-credits / paused icon**             | `--el-tint-yellow` + `--el-warning`                               | The paused state — warning, not danger (nothing is broken).                                      |
| **Tier-gate / lock-gate icon**               | `--el-tint-lavender` / `--el-surface` + `--el-text-strong`        | "AI is paid" / "ask your owner" — gate, not error.                                               |
| **Error icon tint**                          | `--el-tint-rose` + `--el-danger-text`                             | Fetch-error state (panel 8c).                                                                    |
| **Feature-list check / off**                 | `i-check` `--el-success` · off `i-x` `--el-text-faint`            | Included vs not — palette green, not grey-only.                                                  |
| **Pro / Max accent glyph**                   | `--el-accent-on-surface` (`i-zap` / `i-crown`)                    | The heavier paid tiers carry an accent glyph (accent AS icon).                                   |
| **Current-plan card border**                 | `--el-accent`                                                     | Marks the org's current plan in the storefront.                                                  |
| **Primary CTAs / Upgrade**                   | `--el-accent` + `--el-accent-text`                                | Upgrade / Change-plan / Resubscribe — the conversion action.                                     |
| **Cross-link (View Usage & cost)**           | `--el-link`                                                       | Quiet inline navigation to the sibling dashboard.                                                |
| **Payment card-brand chip**                  | `--el-tint-sky` + `--el-text-strong`                              | The Stripe payment-method affordance.                                                            |
| Text / surfaces / borders                    | `--el-text*`, `--el-surface*`, `--el-border*`                     | Standard element tokens — never Tier-0 `--color-*`.                                              |

All shaped surfaces use the **`[data-display-style]` shape tokens**
(`--radius-{btn,card,input,control,badge}`, `--spacing-{btn,input,control,chip,
card-padding}`, `--height-{btn-*,input,control}`, `--shadow-*`) — never the inert
Tier-0 radius/spacing scale or a fixed raw utility. `rounded-full`
(`--radius-badge`, `9999px`) is used only for the round avatar / pill caps.
Toggling the mock's dark mode confirms token parity (every colour flips through
Tier-0 under `--el-*`) — verified.

## Copy strings (en — the `billing` i18n namespace 8.1.7 / 8.1.8 add)

- Shell / nav: org-menu item **"Billing & plans"**; breadcrumb **"Organization ·
  {org} · Billing & plans"**; settings card title **"Billing & plans"** /
  subtitle **"Your Motir plan, Motir AI plan, payment method and invoices."**
- Page: title **"Billing & plans"**; subtitle **"Your two Motir products are
  billed independently. Motir is free until your org outgrows the free caps;
  Motir AI is an org-level credit plan you buy separately."**
- Motir line: **"Motir"** / **"The project-management tool — free for your team,
  paid only at scale."**; state **"Free"** / **"Scaled"**; explainer **"You're on
  free Motir — unlimited members, within the free caps below. You'll only pay $5 /
  seat / mo if the org crosses a cap."**; caps **"Work items"** `{used} / 250`,
  **"Projects"** `{used} / 3`, **"Storage"** `{used} / 2 GB`; **"Upgrade
  Motir"** / **"$5/seat"**.
- Motir AI line: **"Motir AI"** / **"Planning & hosted agents — an org-level monthly
  credit pool."**; **"{n} credits / mo"**; **"Plan fee"** `${n} / mo`;
  **"Allotment this month"** / **"{left} of {total} credits left"**; **"Renews
  {date}"** + **"credits are a usage allotment, not a bill — one planning run
  debits the tokens it used."**; **"Change plan"** / **"Manage plan & payment"** /
  **"View Usage & cost"**.
- Payment: **"Payment & invoices"** / **"Stripe Customer Portal"**; **"expires {mm
  / yy}"** / **"Update"**; note **"Payment method, invoices, VAT ID and
  cancellation are managed in Stripe's secure Customer Portal. Tax is applied
  automatically at checkout."**
- States: past_due **"Past due"** / **"We couldn't charge your card. Your Motir AI
  plan stays active while we retry over the next ~2 weeks. Update your payment
  method to avoid dropping to the free allotment."** / **"Update payment"**; trial
  **"Free trial"** / **"One-time trial grant"** / **"Your 300 trial credits are
  granted once and don't refresh. Pick a monthly Motir AI plan to keep planning when
  they run out."** / **"Choose a Motir AI plan"**; canceled **"Canceled"** / **"Your
  {plan} plan ended on {date}. The org is back on the free allotment — monthly
  credits and top-ups are off. Nothing was deleted; your plans, work items and
  usage history are all intact."** / **"Resubscribe"**.
- Role gating: admin **"View only"** / lock note **"You can see the plan, usage
  and invoices. Changing the plan, payment method or cancelling is limited to the
  organization owner."**; member gate **"Billing is managed by your org owner"** /
  **"Plans and payment for the {org} organization are visible to owners and
  admins. Ask an organization owner to change the plan or buy AI credits."** /
  **"Contact an owner"**.
- AI screen (panel 5 — AI only): breadcrumb **"… · Motir AI"**; title **"Motir AI
  — plans & subscription"** / **"Manage your organization's AI plan — planning &
  hosted agents. Billed separately from your Motir seats, so this screen is AI
  only."**; current-subscription strip **"{tier}"** / **"Active"** / **"{n} credits
  / mo · {left} left · renews {date}"** / **"Manage plan & payment"**; cadence
  toggle **"Monthly"** / **"Annual"** + badge **"Save ~33%"**; menu **"Choose your
  plan"** / **"An org-level monthly credit pool, billed separately from seats. Any
  org can buy it — a paid Motir seat plan is not required. Pro is the recommended
  anchor."**; **"Current"** / **"Recommended"** (Pro) / **"Current plan"** / **"Trial
  used"**; per-tier CTAs **"Current plan"** (Standard) / **"Upgrade to Pro"** / **"Upgrade to
  Max"** / **"Contact sales"**; the annual per-card sublines **"billed annually ·
  ${yr} / yr"** + **"Save ${n}/yr"**, the monthly sublines **"${yr} / yr · Save ${n}
  with annual"**; footer **"Annual billing (the Stripe default) is shown — switch to
  Monthly above to compare. Tax is applied automatically at checkout. Credits are an
  internal usage allotment; the price shown is the AI plan fee, billed by Stripe to
  the {org} organization. Your Motir seats are billed separately — manage them on the
  Motir plan screen."**
- Top-up (panel 5): **"Top up credits"** / **"A one-time purchase on top of your
  plan — added to your balance right away, used after your monthly allotment."**;
  **"Balance {n} credits · {used} of this month's {allotment} allotment used"**;
  bundles **"{n} credits"** / **"${price}"** (1,000/$10 · 5,000/$50 · 10,000/$100 ·
  **"Custom"** / **"× 1,000"**); **"Buy {n} credits — ${total}"**; rate **"$10 per
  1,000 credits · one-time · tax at checkout. Credits are an allotment, not currency
  — this is the price you pay Stripe."**; gate **"Top-ups are available on a paid AI
  plan; the Free trial can't top up (choose a plan above first). Owner-only, like
  every billing action."**
- Seats (panel 6 + the panel-2 preview): **"Scaling bills 1 seat per member — {n}
  today"** / **"{n} × ${seat} = ${total} / mo"** / **"Seats follow membership ·
  prorated automatically"**; review **"Scale up Motir"** / **"One seat per
  organization member — like Jira & Linear."** / **"{n} members → {n} seats"** /
  **"Billed annually — ${aYear} / yr (${aMo} / mo equiv), the default. Charged now,
  prorated for the rest of this cycle. Seats follow your membership automatically —
  add or remove a member and your next invoice adjusts (Stripe proration). Prefer
  monthly? Switch at Checkout to pay ${mTotal} / mo."** / **"Continue to Checkout —
  ${aYear}/yr"** / **"Cancel"**; scaled state (annual default) **"Scaled"** / **"Plan
  fee ${aYear} / yr"** + **"Annual · saves ${save}/yr"** / **"{n} seats billed · 1
  per member"** / **"Billed annually · ${aMo}/mo equiv · renews {date}. … seats
  update automatically as members join or leave."** / **"Manage seats"** / **"Manage
  plan & payment"** / **"Switch to monthly billing"**.
- Paywall: out-of-credits **"Planning is paused — you're out of credits"** /
  **"The {org} organization has used all of this month's {n} {tier} credits, so
  new planning runs are paused. Existing plans stay fully editable."** /
  **"Upgrade plan"** / **"Buy credit top-up · $10/1k"** / **"Renews {date} · or
  upgrade now to keep planning."**; tier-gate **"AI planning is a paid feature"** /
  **"Generate and expand plans with AI by adding a Motir AI plan to the {org}
  organization. Start with 300 free trial credits."** / **"See Motir AI plans"** /
  **"Maybe later"**; member **"AI is out of credits for this org"** / **"Planning is
  paused until the {org} organization's plan is upgraded. Only an organization owner
  can change the plan or buy credits."** / **"Ask an owner to upgrade"**.
- Empty / error: **"You're on the free plan"** / **"The {org} organization has no
  paid subscription yet — Motir is free within its caps and Motir AI is on the
  one-time trial. Add a plan when you're ready to scale."** / **"See plans"**;
  error **"Couldn't load billing"** / **"Something went wrong fetching this
  organization's plan. Your subscription and credits are safe — this is only the
  view. Try again in a moment."** / **"Retry"**.
- Cloud-only note: **"Cloud-only. Every surface here is gated behind MOTIR_CLOUD.
  A self-hosted (GPL-3.0) build shows no billing, no paywall and no caps."**

The full string set is added to the app's locale files (en + zh, the shipped
locale set) by the 8.1.7 / 8.1.8 code subtasks under the new `billing` namespace.
en is the source; keep it byte-stable as other locales are added.

---

# Amendment 2026-07-30 — the Motir CI line (MOTIR-1902)

**Asset:** `ci-line.mock.html` + `ci-line.png` (this file is the third of the
three). **Base asset amended:** `billing.mock.html` + `billing.png` + everything
above in this file.

**What this amendment adds:** exactly one thing — a **third billed line, "Motir
CI"**, on the billing settings panel, in all the states it can hold.

**What it leaves UNTOUCHED — explicitly:**

- **① The Motir (seats) line and ② the Motir AI line.** Reproduced verbatim in
  panel 1 so the new line is reviewed in its real neighbourhood; not one token,
  string or control of either is changed.
- **The access path.** Organization settings → Billing & plans is shipped and
  already drawn (base panel 1). This amendment draws **no new door** — the CI line
  is new content inside a room the user can already reach.
- **The storefront (base panels 5–6), the paywall (7), the role gating (4), the
  subscription lifecycle states (3), and the payment card.** Untouched.
- **The base `<style>` block and the lucide sprite** are spliced into
  `ci-line.mock.html` **byte-identically** (asserted at build time), so the two
  assets cannot drift. New CSS is additive only and namespaced `.ci-*` where a
  collision was possible — see "Collisions found" below.

## Where each behaviour came from (nothing here is invented)

| Behaviour drawn                                                                                                                                                                      | Decided by                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| A **third line**, not a second usage kind on the AI line, not a breakdown                                                                                                            | `docs/decisions/ci-minutes-allowance.md` **§7.1** (MOTIR-1898)                    |
| The pool `max(members × 300, 1000)` and the "300 min × 6 seats" derivation                                                                                                           | **§1**, **§1.2** (the floor), **§7.3.2**                                          |
| "1 credit per minute" and the credits-drawn figure                                                                                                                                   | **§2**, **§7.3.4**                                                                |
| "Resets 1 Aug" + it deliberately differs from the seat renewal                                                                                                                       | **§4.5** (calendar month, UTC) — the panel must say so, not let the user assume   |
| An org with **no seat subscription still gets a full pool**                                                                                                                          | **§4.3**                                                                          |
| ~~META org → no CI line~~ → **SUPERSEDED by MOTIR-4337**: the CI line RENDERS, in whatever state `ciAllowanceService` returns (`bypassed` for a meta org); self-host → the page 404s | **§4.4**, **§8.5**, **§7.3.7** + the amendment at the end of this file            |
| `drawing_on_credits` is **visible**, not silent, and blocks nothing                                                                                                                  | **§6.1**, **§6.5**                                                                |
| Zero consumption is **not an empty state**                                                                                                                                           | **§7.3.6**                                                                        |
| The exhausted state is **"CI is paused"**, not "dispatch paused"                                                                                                                     | Amendment 2026-07-30 (MOTIR-1906) **§A**, **§6.5** — Actions are paused too       |
| **Two options for an admin, an alert for a member**                                                                                                                                  | Amendment **§D** (Yue's directive, 2026-07-30)                                    |
| "resumes within a minute, at most 15" in the Add-credits copy                                                                                                                        | Amendment **§B** (the resume latency, which §D requires the copy to state)        |
| The takeover's real costs; never gated on a stored GitHub identity                                                                                                                   | Amendment **§D** (motir-core's only social provider is Google — no admin has one) |
| The member alert routes to "an organization owner" **without naming**                                                                                                                | Amendment **§D** (naming leaks org membership; mirrors `en.json` `askOwner`)      |
| **One decision surface, N pointers**                                                                                                                                                 | Amendment **§D**                                                                  |
| A `connect-existing` repo is never paused                                                                                                                                            | Amendment **§C**                                                                  |
| Every FIGURE on the line                                                                                                                                                             | `lib/dto/ciAllowance.ts` — `CiEntitlementStateDTO` (MOTIR-1901)                   |

**Every number is traceable to a read.** `poolMinutes` · `consumedMinutes` ·
`remainingMinutes` · `overageMinutes` · `chargedCredits` · `memberCount` ·
`floorApplied` · `periodEnd` · `balance` · `state` · `applicable`. Nothing is
drawn that no read supplies; the admin/member split is the shipped
`AiAccessDTO.canManageBilling`.

## Primitives composed (no new primitive is introduced)

- **`Card`** — the CI line itself, same head/body grammar as ① and ②
  (`--radius-card`, `--shadow-card`, `--spacing-card-padding`).
- **`Meter` — the SHIPPED one**, `BillingClient.tsx`'s `Meter({ pct, low })`. It
  already carries the `low` → `--el-warning` variant this line needs, so the
  usage bar is a **reuse, not a new primitive**. The only addition is a 2px
  **pool-boundary tick** (`.meter.over .tick`, filled `--el-page-bg`) marking
  where the included pool ends inside a full bar.
- **`Pill`** — `Included` (mint), `Drawing on credits` (yellow), `CI paused`
  (yellow), `Nothing to bill` (neutral). Hue in the tint BACKGROUND with
  `--el-text-strong` text — AA-safe, finding #35.
- **`Button`** — `secondary` only, for both decision options (see below).
- **The `banner` / `note` / `state` / `Skeleton` family** — reused as-is from the
  base for the paused banner, the advisory notes, the error state and the loading
  row. The base `.sk` shimmer is reused verbatim, not redefined.

## Colour + shape roles (additions only — the base table above still governs)

| Element                                | Token                                              | Why                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Motir CI product glyph** (`i-zap`)   | `--el-tint-peach` bg + `--el-text-strong`          | The THIRD product hue. mint = Motir, lavender = Motir AI, so CI takes the unused peach slot — a different tint slot, never a new hue. |
| **`Included` pill**                    | `--el-tint-mint` + `--el-text-strong`, `i-check`   | Healthy, same family as the AI line's `Active`.                                                                                       |
| **`Drawing on credits` pill + banner** | `--el-tint-yellow` + `--el-text-strong`, `i-coins` | Warning family: you are now paying per minute — but nothing is blocked.                                                               |
| **`CI paused` pill + banner**          | `--el-tint-yellow` + `--el-text-strong`, `i-pause` | **Warning, NOT danger** — the base table already fixes this for the paused state ("nothing is broken").                               |
| **Meter fill, within allowance**       | `--el-accent`                                      | The shipped `Meter` default.                                                                                                          |
| **Meter fill, past the pool**          | `--el-warning`                                     | The shipped `Meter low` variant — same signal as the AI line's low-balance meter.                                                     |
| **Pool-boundary tick**                 | `--el-page-bg`                                     | A notch, not a colour — reads on any palette.                                                                                         |
| **Pool derivation line**               | `--el-text-muted`, figures `--el-text-secondary`   | Explains the number without competing with it.                                                                                        |
| **Decision option card**               | `--el-page-bg` on `--el-border`, `--radius-card`   | Two peers; neither is tinted, so neither reads as the recommended one.                                                                |
| **Cross-link to the AI balance**       | `--el-link`                                        | The §7.2 non-duplication rule: CI reports minutes and links for the balance.                                                          |

Shape: `--radius-card` (cards, banners, option cards), `--radius-badge` (pills,
meter), `--radius-control` (glyph, repo rows), `--spacing-card-padding`,
`--spacing-control-x/y`, `--height-btn-*`, `--shadow-card`. No Tier-0
`--color-*`, no raw `rounded-*`/`p-*`/`h-*`. Dark mode verified — every colour
flips through Tier 0 under `--el-*`.

## The exhausted state — the part MOTIR-1903 must get exactly right

**It is a DECISION, so it was MEASURED, not just drawn** (amendment §D). Rendered
in a real **1280 × 800** laptop viewport (≈700 px of usable page):

| Measurement                         | Result     |
| ----------------------------------- | ---------- |
| CI card top (paused state, hoisted) | **85 px**  |
| Both consequence lines end by       | **367 px** |
| Both option buttons end by          | **415 px** |
| Fold                                | 700 px     |

- **Neither option is `primary`.** Both are `secondary` peers. One keeps the
  hosted arrangement and one ends it; dressing either as _the_ answer is Motir's
  thumb on the scale.
- **Each option states its real cost under it.** Add credits → "CI resumes within
  a minute of the payment landing — at most 15" (§B's latency, in the copy, not in
  the implementer's head). Move the repositories → a GitHub account you own, a
  transfer you accept on GitHub, and an app re-install — **never "one click"**.
- **The member variant renders NO disabled control.** A control a user cannot use
  is worse than a sentence explaining why. It routes to "an organization owner"
  and names nobody.

### ⚠️ The one ordering rule this amendment adds (panel 8)

Measured on the real page: in the normal order the CI card is **third and starts
at 756 px** — below a 700 px fold. A paused admin would land _above_ the decision
and have to scroll to find it, which fails §D's constraint in practice even
though the block itself fits. **Rule: when `state === 'ci_credits_exhausted'`,
the Motir CI card renders FIRST in the stack; otherwise it keeps third
position.** This orders by urgency without adding a second decision surface,
without a page-level banner to keep in sync, and without changing the CONTENT of
① or ② — they are byte-identical, just below. **MOTIR-1903 must implement this
ordering**, not only the card.

## Two corrections to MOTIR-1902's own card, made against the record

1. **"An org with no seat subscription" is NOT a render-nothing case.** The card
   grouped it with self-host and the meta org under "not applicable"; ADR **§4.3**
   decides the opposite — the pool is `max(members × 300, 1000)` regardless of
   subscription, because a free-tracker org can hold a paid AI plan. It renders a
   **normal** line (panel 5, right). Drawing it as "nothing" would have shipped
   the wrong branch.
2. **A state the card did not list is required by the DTO: `balance: null`**
   (motir-ai unreachable). It is a real value, is **never** treated as exhaustion —
   refusing on a transport blip would fail closed on Motir's own outage — and must
   **not** render as a misleading zero. Drawn in panel 6: the minutes half renders
   from local data; only the credits half says it is unavailable.

## Collisions found while composing (recorded so MOTIR-1903 does not repeat them)

Composing INTO a shipped asset is not the same as drawing beside it. Three real
defects surfaced only by rendering, not by reading:

1. **`.opt` already exists in the base** as the org-menu row (`align-items:
center; cursor: pointer`). The new decision-option cards silently inherited it
   and rendered centre-aligned. Renamed to **`.ci-opt` / `.ci-opts`**.
2. **`.sk` already exists** as a gradient shimmer. A redefinition would have
   downgraded it to a flat fill — the base one is reused verbatim instead.
3. **`.desc` is scoped as `.line .desc`.** Used outside the base's
   `.line > .meta` wrapper it falls back to default body size. Every `.desc` in
   this asset sits inside that wrapper.

**The lesson for the code card:** the CI line is a new component in an existing
client component; reuse `Meter`, `StatusPill`'s grammar and the card shell rather
than introducing parallel ones.

## Copy strings (en — the `billing` namespace; MOTIR-1903 adds each with a `zh` twin)

Every string below needs a matching `zh.json` key or the i18n-catalog parity gate
fails the PR (amendment §D).

- Line: **"Motir CI"** / **"The CI minutes Motir pays for on the repositories it
  hosts for you."**
- States: **"Included"** · **"Drawing on credits"** · **"CI paused"** ·
  **"Nothing to bill"**.
- Usage: **"Minutes used this month"** / **"{used} of {pool} minutes"** /
  **"{left} minutes left"** / **"{over} minutes over"**.
- Derivation: **"Your included minutes: {perSeat} min × {n} seats"** /
  **"Your included minutes: 1,000 minute minimum"**.
- Reset: **"Resets {date} — CI minutes run on the calendar month, so this is not
  the same date as your Motir AI renewal."**
- Overage: **"You're past your included minutes — CI is now drawing credits."** /
  **"{over} minutes over · {credits} credits drawn this period, at 1 credit per
  minute. Nothing is blocked."**
- Zero consumption: **"All of this project's repositories are your own"**, so
  GitHub bills you for Actions directly and Motir isn't paying for any CI. Your
  **"{pool} included minutes"** are there if you ever ask Motir to host a
  repository.
- Paused (admin): **"CI is paused — your credits ran out."** + the usage sentence
  - **"no workflows run"** on the repositories Motir hosts for you, and new work
    can't be dispatched. **"Nothing has been deleted, and your code is untouched."**
- Option A: **"Add credits"** / **"Top up your Motir AI balance. CI keeps running
  on Motir's repositories and the overage keeps drawing 1 credit per minute."** /
  **"CI resumes within a minute of the payment landing — at most 15."**
- Option B: **"Move the repositories to your own GitHub"** / **"GitHub bills you
  for Actions directly from then on, and Motir stops charging CI credits. The code
  is yours either way — this changes who pays for the compute."** / **"Needs a
  GitHub account you own, a transfer you accept on GitHub (it isn't instant), and
  re-installing the Motir app so dispatch keeps working."**
- Paused (member): **"CI is paused — this organization is out of credits."** +
  **"…until an organization owner adds credits or moves the repositories to your
  own GitHub."** + the lock note **"Billing for this organization is managed by
  its owners. There is no action for you here — this line is informational."**
- Balance unreachable: **"Your credit balance is temporarily unavailable. Your
  minutes are accurate and nothing is paused — only the balance figure is
  missing."**
- Pointers: **"Can't start this work — CI is paused"** / **"Manage CI minutes"** /
  **"CI is paused on the repositories Motir hosts — your own repositories are
  untouched, because GitHub bills those to you."**

---

# Amendment 2026-09-05 — the Motir Search line (MOTIR-4551)

The asset is **`search-line.mock.html`** + **`search-line.png`**, a NEW three-file
member of this area, under story **MOTIR-4334**. Its consuming code card is
**MOTIR-4557**, `blocked_by` this design gate; the read that feeds it is
**MOTIR-4555**.

It follows the structural precedent the CI line set one amendment up: **a billed
line that arrives after the panel shipped gets its OWN asset**, never an
amendment that re-exports `billing.mock.html` or `ci-line.mock.html`. Both of
those are byte-unchanged by this card. An asset records what was decided on the
day it was decided; re-exporting a frozen mock buries a new surface inside an old
one and makes the diff unreadable.

## THE SURFACE DECISION — recorded on motir-core's own side

**Search spend is its OWN billed line. It is not folded into the Motir AI figure,
and it is not a second usage kind on that line.**

This is **not re-taken here** — it is TRANSCRIBED, because until now it existed
only in two other repositories and a motir-core reader had nowhere to find it:

- **`motir-gateway/docs/decisions/motir-search-channel.md` §4.4** — _"The customer
  sees a search charge on their credit ledger as its own `kind`, alongside AI turns
  and Motir CI. It is not merged into the AI line."_
- **`motir-ai/docs/credit-model.md` §4b** — the same sentence, followed by that
  record's own standing warning that motir-core does not yet RENDER the line.

**Why it is worth writing down HERE.** The decision binds a motir-core surface and
is stated in two repositories a motir-core reader has no reason to open. That is
exactly how the gap this story exists to close was created: the mechanism shipped
with its decision recorded beside the mechanism, and the surface shipped nothing
because the decision was not recorded beside the surface.

**What this decision does NOT settle**, stated so a later card does not read it as
covering more than it does:

- **It does not decide the run-level drill-down.** _Which run spent it_ is the
  **usage dashboard's** question and has its own asset (MOTIR-4554) and its own
  code card (MOTIR-4558). This line answers _what am I charged for_ and links
  across, exactly as ② and ③ do. The two surfaces must not duplicate — the
  standing `ai-usage` ⟷ `billing` split at the top of this file governs here
  unchanged.
- **It does not decide pricing.** The rate, the margin and the env fail-safe are
  the gateway's (`motir-search-channel.md` §4.2) and this asset moves none of them.

## Where each behaviour came from (nothing here is invented)

| Drawn                                 | Comes from                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A fourth billed line at all           | `motir-gateway/docs/decisions/motir-search-channel.md` §4.4 · `motir-ai/docs/credit-model.md` §4b                                                                     |
| Credits as the only unit              | §4.2 — the gateway prices a search and hands over whole credits; motir-core never learns what one costs                                                               |
| **NO meter**                          | §4.2 again, read for what it does NOT give: no pool, no allowance, no included quantity ⇒ **no denominator**                                                          |
| **NO paused / refused state**         | §5 — an out-of-credit org goes into overdraft and search refuses nothing                                                                                              |
| `Spent this month` / `Spent all time` | `BillingStatusDTO.search` = `{ totalSpend, monthSpend }` (MOTIR-4555)                                                                                                 |
| The UNAVAILABLE dash                  | `BillingStatusDTO.search` is `SearchSpendDTO \| null`; `null` = the boundary did not report the block                                                                 |
| ~~The META org rendering no line~~    | **SUPERSEDED by MOTIR-4337** — MOTIR-4572 deletes the `isMeta` branch; an internal org renders the ordinary customer lines. See the amendment at the end of this file |
| The access path                       | `billing.mock.html` panel 1, reproduced verbatim — no new door                                                                                                        |

## ⚠️ The two things this line does NOT have, and why each is a DECISION

**These are the parts a code card is most likely to add by analogy with ③ Motir
CI, so they are recorded as absences rather than left out.**

### 1. There is NO METER, because there is no denominator

② Motir AI meters its monthly allotment; ③ Motir CI meters its included pool. A
meter needs a number to divide by. Search has **no pool, no allowance and no
included quantity** — every search is charged, from the first one. A meter here
would have to invent the figure it fills against.

What replaces it is the **figure band** (`.figs` / `.fig`): two plain numbers,
_Spent this month_ and _Spent all time_, with the unit spelled `credits` and never
a currency (the area's standing rule).

### 2. There is NO PAUSED STATE, and it is a decision — `motir-search-channel.md` §5

**Every other billed line on this panel has an exhaustion story and this one does
not.** `motir-search-channel.md` §5 decides that an out-of-credit org is allowed
into **overdraft** and that **search refuses nothing**: a second refusal valve on
grounding would mean a balance state silently turns the planner code-blind at rung
1, and rung 1's failure is invisible by construction — the planner would not error,
it would go back to asserting from memory. Refusal stays at the planning-turn gate,
where it already is.

So panel 2c draws a balance at zero with **spend still accruing** and an
INFO banner saying so in words. It is `--el-tint-sky` / `--el-info`, deliberately
not the warning family: nothing is wrong and nothing is paused.

**For MOTIR-4557:** do not build a fourth pill tone, a pause banner, a hoisting
rule or a decision surface for search. ③ Motir CI's card-hoisting rule (this
file's earlier amendment, panel 8) is CI's alone and search does not join it —
there is no urgency for it to order by.

## ⚠️ UNAVAILABLE IS NOT ZERO — the one thing the code card must get exactly right

`BillingStatusDTO.search` is `SearchSpendDTO | null`, and `null` means **the
boundary did not report the block** — a rolling deploy where the motir-ai half has
not landed, not a customer who spent nothing.

**Drawn as an EM-DASH, never a `0`,** plus the dashed note _"Search figures aren't
available right now. Your searches are still being charged — this is the display,
not the billing."_

This is the same rule `ciFigures.ts` already ships as `balanceUnavailable` —
_"a real value, never exhaustion and never rendered as a misleading zero"_ — and
it matters more here, because search's honest zero is COMMON (an org whose runs
never search) while CI's is rare. A customer told they spent nothing on search
concludes they were not charged; there is no second surface that corrects them.

**And it is a PER-LINE treatment, never a page error.** Only this line's figures
are missing — ①②③ and the payment card are fed by other reads and are unaffected.
Panel 4c shows the page-level error state for contrast: that one is the SHIPPED
`ErrorState`, unchanged, and it takes all four lines with it.

## Primitives composed (no new primitive is introduced)

| Element                        | Primitive / shipped source                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| The line's container           | `Card` with a `header` — identical to `MotirCiLine`                                         |
| Product glyph badge            | the `.gico` badge `MotirCiLine` uses, `--radius-control`, `18px` lucide `search`            |
| `Per use` chip                 | `Pill` tone `neutral`                                                                       |
| The figure band                | NEW composition of plain elements — no primitive owns a two-figure band                     |
| `No searches billed` note      | the dashed `note` family (`EmptyState`'s inline sibling), as `MotirCiLine` uses             |
| The overdraft banner           | the `banner` family, INFO variant (`--el-tint-sky` / `--el-info`)                           |
| Unavailable note               | the same dashed `note`, with the `alert` glyph                                              |
| Loading                        | the panel's own `BillingSkeleton` (`components/ui` has `PageSkeleton` and nothing narrower) |
| Page error                     | the shipped `ErrorState` — unchanged                                                        |
| `See which runs spent it` link | the `.xlink` cross-link ② and ③ already use to reach Usage & cost                           |

## Colour + shape roles (additions only — the base table above still governs)

| Element                        | Token                                      | Why                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Product glyph background**   | **`--el-tint-sky`**                        | mint = Motir, lavender = Motir AI, peach = Motir CI. A fourth line takes the next SHIPPED tint slot, never a new hue. Sky is also the only remaining slot not already spent on a STATE — rose is danger and yellow is warning, and either would read as an alarm on a line that never alarms. |
| Product glyph ink              | `--el-text-strong`                         | hue in the tint background, AA ink on top — the area's standing chip rule                                                                                                                                                                                                                     |
| Figure VALUE                   | `--el-text`                                | the primary number                                                                                                                                                                                                                                                                            |
| Figure LABEL / secondary value | `--el-text-secondary`                      | 6.18–6.80:1 on every surface this band lands on, including the view-only note's                                                                                                                                                                                                               |
| The unavailable dash           | `--el-text-secondary`                      | quieter than a real figure, still AA — it is information, not a disabled control                                                                                                                                                                                                              |
| Overdraft banner               | `--el-tint-sky` + `--el-info`              | INFO, never warning: nothing is wrong                                                                                                                                                                                                                                                         |
| Card radius / padding          | `--radius-card` / `--spacing-card-padding` | unchanged from the base                                                                                                                                                                                                                                                                       |
| Glyph badge radius             | `--radius-control`                         | matches ①②③                                                                                                                                                                                                                                                                                   |

## ⚠️ TWO STALE RULES INHERITED FROM `ci-line.mock.html`, corrected here — and filed

This asset splices `ci-line.mock.html`'s token block verbatim, as that asset
splices `billing.mock.html`'s. **Two rules in that chain are STALE**: they were
copied before `billing.mock.html` corrected them, and they never fire in
`ci-line.mock.html` because it draws neither element.

| Rule            | `ci-line.mock.html` | `billing.mock.html` (corrected) | Measured                            |
| --------------- | ------------------- | ------------------------------- | ----------------------------------- |
| `.state .ico`   | `--el-text-muted`   | `--el-text-secondary`           | 4.17:1 on `--el-surface` — fails AA |
| `.menu .mlabel` | `--el-text-faint`   | `--el-text-secondary`           | 2.39:1 — clears AA on NO surface    |

This asset follows the CORRECTED base and says so at each rule. The guard lane
(`tests/design-ink-contrast.test.ts`) is what found them — it fired the moment
this asset drew a `.state` block and an org menu, which is the first time either
rule had a user.

**Filed as a bug** against `ci-line.mock.html`, because the latent copy is a trap
for the NEXT asset that splices from it — which is exactly how it reached this one.

### Corrected at source (MOTIR-4667) — and the drift was SIX rules, not two

The two rules above were the ones that had FIRED. A whole-block diff of the three
spliced copies against `billing.mock.html` found every drifted ink rule, and all
now follow the base's `--el-text-secondary`:

| Rule                   | Was (copied)      | `ci-line.mock.html` | `search-line.mock.html` |
| ---------------------- | ----------------- | ------------------- | ----------------------- |
| `.plan .seat.off`      | `--el-text-faint` | corrected           | corrected               |
| `.bundle .bpr`         | `--el-text-muted` | corrected           | corrected               |
| `.billed`              | `--el-text-muted` | corrected           | corrected               |
| `.state .ico`          | `--el-text-muted` | corrected           | already corrected here  |
| `.state .passive-note` | `--el-text-faint` | corrected           | corrected               |
| `.menu .mlabel`        | `--el-text-faint` | corrected           | already corrected here  |

After this, the three `<style>` token blocks differ from the base only by
deliberate, local additions. **One base rule is deliberately NOT spliced:**
`.pill-exempt` (MOTIR-4819) draws the EXEMPT org's states, which neither amendment
draws — copied in, it would be a dead declaration in each asset. **Note the splice
is NOT asserted at build time**, whatever the CI-line section above says: nothing
compares the copies, which is how six rules drifted unobserved.

## Copy strings (en — the `billing` namespace; MOTIR-4557 adds each with a `zh` twin)

- Name: **"Motir Search"**
- Tagline: **"The web searches your planning runs make to ground themselves in
  current sources."**
- Chip: **"Per use"**
- Figures: **"Spent this month"** / **"Spent all time"** / **"{credits} credits"**
- Rate line: **"Each web search draws 1 credit from your Motir AI balance. There
  is no included allowance and nothing to run out of — search is charged only when
  a run uses it."**
- Nothing billed: **"No searches billed this month."** / **"Search is charged only
  when a planning run uses it, so nothing here means nothing was used — not that
  anything is unavailable."**
- Overdraft: **"Search keeps working when your balance runs out."** / **"An
  out-of-credit org goes into overdraft and search refuses nothing. Refusal stays
  at the planning-turn gate, where it already is."**
- Unavailable: **"Search figures aren't available right now. Your searches are
  still being charged — this is the display, not the billing."**
- Cross-link: **"See which runs spent it"**

## GIVES / TAKES

**GIVES — MOTIR-4557** the whole element set: the card and its header, the glyph
and its tint, the `Per use` chip, the figure band and its two labels, the
nothing-billed note, the overdraft banner, the unavailable dash and its note, the
loading shape, the cross-link, and the two ABSENCES above (no meter, no paused
state) as build instructions rather than omissions.

**TAKES — nothing from any other card.** No sibling's scope is narrowed and no
card is amended by this one. The access path is REPRODUCED from
`billing.mock.html` panel 1 rather than taken from it: the door already exists and
this line joins a panel that already has one, which is precisely what drawing it
here proves.

Its neighbours for the record, neither of them amended: **MOTIR-4554** draws the
same spend on the usage dashboard (the run-level drill-down this line links to and
does not own), and **MOTIR-4555** carries the figures across the boundary that
feed both.

---

# AMENDMENT 2026-09-05 — an INTERNAL org renders exactly what a paying org renders

**Story MOTIR-4337 · swept by card MOTIR-4564.** This area's assets describe a META org as a
tenant that sees an "Internal plan" card and **no CI line**. After MOTIR-4337 that description is
not merely stale — it is the opposite of what the product does, and a design note nobody corrects
is the specification the next agent builds to.

**What changes, and what does not.**

- **`isMeta` keeps its shipped meaning** — Motir's own COGS: caps lifted, AI paywall off, excluded
  from revenue. It gains no new one
  (`docs/decisions/internal-billing-classification.md` §1).
- **A new, separate `Organization.internalBilling` flag** means _charged exactly like a customer,
  then made whole_: every debit lands and is paired, in the SAME transaction, with an
  `internal_offset` credit, so the balance nets to zero **while both entries stay visible** (§2–§3).
- **So every billed line, its states and its figures render for an internal org exactly as for a
  paying org** — including low-balance and out-of-credits, which are precisely the states the
  suppression made unreachable from the seat most likely to notice a bug in them. The `isMeta`
  branch in `BillingClient.tsx` is **deleted**, not duplicated for the new flag (MOTIR-4572).
- **The CI line RENDERS rather than being hidden**, in whatever state `ciAllowanceService`
  returns. For a meta org that state is `bypassed`, and showing it is the point: the bypass itself
  stays keyed on `isMeta` (`ci-minutes-allowance.md` §4.4 — _"moooon B.V. pays its own GitHub bill
  directly; metering it would bill the house to itself"_), and charging a CI minute Motir never
  paid for and then offsetting it would put an invented figure on the very screen this story
  exists to make honest.

**The drawn META panels in this area are a record of superseded behaviour.**
`ci-line.mock.html` panel 5 and `search-line.mock.html` panel 3 draw the meta variant as it ships
today; each is annotated in place. They are **not redrawn here** — MOTIR-4572 owns the change to
the customer surfaces, and this sweep owns the note that stops them being read as the internal
org's future experience.

---

# AMENDMENT 2026-09-07 — the 2026-09-05 clause was reasoned about an `internalBilling` org and applied to an `isMeta` one

**Card MOTIR-4819, filed from MOTIR-4818 (Yue's dogfooding report).** This amends
the 2026-09-05 entry above. Its **DECISION stands** — do not suppress the billed
lines from an internal org — and this card does not disturb it. What fails is its
**RANGE**.

## The clause whose range is wrong

> **every billed line, its states and its figures render for an internal org exactly as for a paying one**

That is TRUE of an **`internalBilling`** org and FALSE of an **`isMeta`** one, and
the two are opposites:

|                                                | `internalBilling`                                                                  | `isMeta`                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------- |
| charged?                                       | **yes** — every debit lands, then a paired `internal_offset` credit makes it whole | **never**                  |
| capped?                                        | **yes** — §4 applies normally                                                      | **no** — every cap lifted  |
| so "every line renders as for a paying org" is | **true**, and worth keeping                                                        | **false**, four times over |

## What `moooon` is shown today — RENDERED, not read

`BillingClient` was bundled (esbuild + the real `globals.css`/`theme.css` + a
`next-intl` provider) and screenshotted at the live shape: `isMeta: true`,
`internalBilling: false`, `motir.scaledTrackerSubscription: null`,
`motirAi.tier: null`, `ci.applicable: false`.

1. a **Free** chip on Motir, and _"You'll only pay $5 / seat / mo if the org crosses a cap"_ — it will never pay and cannot cross a cap.
2. the free caps as **filled meters** — Work items _Up to 250_ · Projects _Up to 3_ · Storage _Up to 2 GB_. `lib/services/entitlementsService.ts`'s header states the META org _"short-circuits to the internal `meta` tier (**every cap lifted**)"_. The meters draw consumption against ceilings that do not exist.
3. _"Scaling bills 1 seat per member — 3 today"_ and **3 × $5 = $15 / mo** — a price quote to the house.
4. **Upgrade Motir** — a Stripe checkout.
5. a **Free** chip on Motir AI and _"No paid AI plan — on the one-time free trial"_. It is EXEMPT, not trialing: `lib/services/billingService.ts:252` is `if (org?.isMeta) return notApplicableAiAccess();`.
6. **Choose a Motir AI plan** — a second checkout.

Correct on the same render and **not touched by this card**: no CI line
(`applicable: false`, `bypassed` — §4.4), and the Motir Search line with its real
figures. Those two are already true for this org.

## The decision — (c), a drawn EXEMPT variant of each line

- **(a) Restore an "Internal plan" card in place of the storefront.** REJECTED. It is what shipped before, and the 2026-09-05 amendment removed it for a reason that still holds: it hid every state from the seat most likely to notice a bug in them. It also over-corrects — the Search line and the balance ARE true here.
- **(b) Keep every line and suppress only the untrue parts.** REJECTED as an END STATE. It is the right subtraction and it leaves no positive statement: a reader sees a line with its price and caps removed and cannot tell whether that is a treatment or a loading failure.
- **(c) A drawn exempt variant of each line.** **CHOSEN.** It performs (b)'s subtraction AND says what the org's relationship to that product actually is — the same move MOTIR-4809 made for the usage dashboard's panel 7c, so the two settings pages read as one system.

## THE PREDICATE — in the terms the code reads

| org                                                                  | Motir line                                                        | Motir AI line                                         |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| paying, or free, or `internalBilling` (any org with `isMeta: false`) | **panel 2 ①, unchanged** — caps, seat calculator, `Upgrade Motir` | **panel 2 ②, unchanged** — tier, allotment, plan CTAs |
| `isMeta: true` (with or without `internalBilling`)                   | **panel 3 (d)**                                                   | **panel 3 (e)**                                       |

**It keys on `isMeta` and NEVER on `internalBilling`**, and getting that backwards
fails in the more expensive direction: it would hide a real price from an org that
really owes it. The CI line and the Search line branch on neither.

## Panel 3 (d) and (e) — the drawing

Drawn in `billing.mock.html` **panel 3**, beside the lifecycle states, because
that is the panel a reader opens to see what these two cards look like in a given
state. Panel 2's caption is scoped to a BILLED org and points here.

| element        | primitive / class        | token                                  | why                                                                                                                                                                                                                     |
| -------------- | ------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| card           | `.card` + `.card-head`   | unchanged                              | identical container to panel 2's lines; only the body differs                                                                                                                                                           |
| status pill    | **`.pill-exempt`** (new) | `--el-tint-peach` + `--el-text-strong` | ⚠️ deliberately **NOT** `--el-tint-sky`: that is `.pill-trial` on this same surface, and "exempt" reading as "on the free trial" is the exact confusion this state exists to end. Peach is this area's one unspent tint |
| body           | `.banner.banner-info`    | `--el-tint-sky` + `--el-info` glyph    | reused verbatim; informational, never a warning — nothing is wrong                                                                                                                                                      |
| (e) cross-link | `.xlink` + `i-coins`     | `--el-link`                            | **kept**: the usage figures are real, and they are why this org opens this page                                                                                                                                         |

**What each state REMOVES, and why each one goes** — recorded on the mock beside
the cards so the code card cannot drop one by accident:

- **(d)** the caps block (there are none), the seat calculator and its `N × $5` total (a price quote to the house), and `Upgrade Motir` (a checkout for an org that is never charged).
- **(e)** the `Free` chip and _"on the one-time free trial"_ (exempt, not trialing), and `Choose a Motir AI plan`.

## Copy — both catalogs, so the code card writes none

`messages/en.json` → `billing.exempt`:

```json
"exempt": {
  "pill": "Not billed",
  "motir": "This organization isn’t billed for Motir. Every plan cap is lifted for it, so there is nothing to outgrow and no seats to buy.",
  "ai": "This organization isn’t charged for Motir AI. Planning runs whatever the balance reads, and credits are recorded for internal cost visibility rather than billed."
}
```

`messages/zh.json` → `billing.exempt`:

```json
"exempt": {
  "pill": "不计费",
  "motir": "此组织不为 Motir 计费。所有套餐上限均已解除，因此没有需要突破的额度，也无需购买席位。",
  "ai": "此组织不为 Motir AI 计费。无论余额显示为多少，规划都会照常运行；额度仅用于记录内部成本，不产生账单。"
}
```

Every other `billing.*` key is unchanged — panel 2 keeps its words for every org
it still renders for.

## Scope

`ci-line.mock.html` and `search-line.mock.html` are **byte-unchanged**: both lines
are already correct for an exempt org, and their own META panels were
dispositioned by MOTIR-4564. Panels 1, 4–8 of `billing.mock.html` are untouched.

## Who consumes this

- **MOTIR-4818** — the code card. It implements the predicate table above and adds the two copy blocks.
- **MOTIR-4809** — the `design/ai-usage` half of the same re-take, and where the exempt grammar this borrows was set.

---

# Amendment 2026-10-05 — Contact sales opens a request form (MOTIR-7603)

**Asset:** `billing--contact-sales.mock.html` (HTML mock, a DELTA, 10 panels) · **Card:** MOTIR-7603
(design, Story MOTIR-7602) · **Builds it:** [the form's code](motir:cmuuwienn00johwoiyxicgk7u)
(MOTIR-7607), which is `blocked_by` this card. **Request contract drawn:**
[the request record](motir:cmuuwielk00jkhwoio44kne2b) (MOTIR-7605).

**Amends** § _Panels_ panel 5 of `billing.mock.html` — the Motir AI storefront's **Enterprise**
card, whose CTA ships as a secondary `Contact sales` `<a href="mailto:sales@motir.co">`
(`BillingClient.tsx` `PlanCard`, the `!plan.prices` branch). Nothing else in that mock, nor in
`ci-line.mock.html` / `search-line.mock.html`, is touched; `billing.mock.html` is a record and is
not edited.

**Design system** (read, not assumed): `package.json` depends on `@motir/design-system`
(`workspace:*`, `packages/design-system` **0.8.1**) AND `app/globals.css` imports
`@motir/design-system/theme.css` → **on Motir Design (branch a)**. The project's axes are applied
from the persisted appearance in `app/layout.tsx` (`data-style` / `data-palette` / `data-type`);
the mock renders the base axes, as every mock in this area does. The package exports
`@motir/design-system/mock` (`renderMock`) at 0.8.1, but it is NOT used: the delta copies
`billing.mock.html`'s token block and its card / pill / button / plan-card rules byte for byte so
it composes from exactly what the base already reviewed (the same choice
`design/auth/design-notes.md` § _OAuth consent — the pinned action bar_ records), plus the eight
`theme.css` tokens the base predates (`--el-overlay-scrim`, `--el-danger-surface`,
`--el-danger-surface-text`, `--el-input-border`, `--el-input-disabled-{bg,border,text}`, and
their `--color-hairline` source), declared at `theme.css`'s own values.

**⚠️ The plan-ladder delta is NOT on main.** The card description says to compose the Enterprise
card "as the plan-ladder delta mock (`billing--plan-delivery.mock.html` in this folder) leaves it". That file does not exist on
`origin/main` (checked at `047323b`), and its design card **MOTIR-7596** is `todo` — the story
(MOTIR-7594) is blocked behind the planner-cost measurement (MOTIR-7612). So the card is composed
against the approved base and the shipped `PlanCard`, reduced by MOTIR-7594's own acceptance
criterion (_"Enterprise shows no price and no estimate. Its Contact-sales control is still
present."_): **no price row is drawn**, and the use-case / pool / seat / feature lines are the
shipped `billing.plans.tiers.enterprise` copy. The Standard / Pro / Max cards are drawn as dashed
outlines labelled with MOTIR-7596, because their content is that delta's and this card draws no
price. When MOTIR-7596 lands, its card content wins; this delta owns only the control and what it
opens.

## What changes

1. **The control.** `Contact sales` stops being a `mailto:` link and becomes a `Button`
   (`variant="secondary" size="sm"`, `w-full`, `aria-haspopup="dialog"`) that opens a `Modal`.
   It is the only behaviour change on the card.
2. **The member variant** (no `manageBilling`, i.e. `data.access.canManageBilling === false`).
   Today the link is live for everyone; it becomes **disabled**, with the reason said under it
   (`Lock` glyph + `--el-text-secondary` 11.5px line, wired as the button's
   `aria-describedby`): _"Only owners and admins of {org} can contact sales."_ A disabled button
   cannot take focus, so the reason is visible text, not a tooltip. Same permission and the same
   "owners and admins" wording the billing screens use for every other mutation.
3. **The open-request variant.** While the org has a request in an OPEN state (`new`,
   `contacted`, `offer_sent`), the control is replaced by **`Request sent · {date}`** — the same
   button, on `--el-tint-mint` with `--el-text-strong` ink and a `Check` glyph — and pressing it
   opens that request read-only (panel 7). A member sees the same words as a non-interactive mint
   line (panel 2d): whether they may read the request is MOTIR-7605's read permission, and the
   line tells them what they need (someone already asked) without a door they may not open.
   `won` / `lost` are closed: the card returns to `Contact sales`.
4. **The form** (panels 3–5, 8): `Modal size="lg"` (32rem), title + description, `Modal.Body`
   scrolling under a pinned `Modal.Footer` (Cancel `ghost` · **Send request** `primary` with a
   `Send` icon).

## The form asks only what the person alone knows

**Read-only at the top** — a soft summary box titled _Sent with your request_; none of these is
an input, and none is sent from the client (the server reads them again; the box is there so the
person knows what accompanies the request):

| Shown                  | Where the product already has it                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Organization           | the active org — `organizationsService.resolveActiveOrganization` (the billing `page.tsx` already passes `orgName` to `BillingClient`)                                                     |
| Requested by           | the session user (`getSession()`), name; the email seeds the contact field below                                                                                                           |
| Current plan           | `BillingStatusDTO.motirAi.tier.name` — what the storefront's current-plan strip already shows                                                                                              |
| Repositories connected | a count of the org's `project_repository` rows (`ProjectRepo`, `projectRepoRepository`) across its workspaces — read server-side by the form's service; the client is never trusted for it |

**Inputs** — every one optional except the note, said once above them (_"Everything below is
optional except the note."_) rather than an "(optional)" tag on seven labels:

| Field (label)             | Primitive                                                                      | Contract field (MOTIR-7605)                                                    |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Work items a day, roughly | `FormField` + `Input type="number" inputMode="numeric"`, placeholder `e.g. 40` | `cardsPerDay` (int, optional)                                                  |
| Agents in parallel        | `FormField` + `Input type="number"`, placeholder `e.g. 8`                      | `parallelAgents` (int, optional)                                               |
| Which agents              | radio-card group (below), 3 options                                            | `agentPath`: `hosted` · `own` · `both`                                         |
| How should it run?        | radio-card group, 3 options                                                    | `autonomy`: `autonomous_lead` · `volume_only` · `unsure`                       |
| When would you start?     | `FormField` + `Combobox` (single, no search), placeholder `Choose…`            | `startWhen`: `now` · `within_month` · `within_quarter` · `exploring`           |
| Team size                 | `FormField` + `Combobox`, placeholder `Choose…`                                | `teamSize`: `size_1_10` · `size_11_50` · `size_51_200` · `size_201_plus`       |
| Best way to reach you     | `FormField` + `Input`, **prefilled** with the account email, helper text       | `contact` (string; the server defaults it to the requester's email when empty) |
| Note — `Required`         | `FormField` + `Textarea` (3 rows, auto-grow)                                   | `note` (required)                                                              |

The two numbers sit two-up, as do the two pick-lists; both pairs stack at the narrow width.

**The radio cards** are not a new primitive: they are the shipped
`components/approvals/RefusalReason.tsx` verdict grammar — `role="radiogroup"` labelled by its
legend, a visually-hidden `<input type="radio">`, a 16px dot, label + hint, `--radius-card`,
`--el-accent` border + `--el-surface-soft` fill when selected, `--el-surface` on hover. Laid out
one per row here (the hints are a sentence long). A radio group cannot be un-chosen, which is
right for optional single choices only because _Not sure yet_ exists on the one where "no answer"
is a real answer; `agentPath` stays unset until clicked.

## States (panel by panel)

| #   | State                 | What is drawn                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Access path           | Settings sidebar _Billing & plans_ → the Motir AI line's **Change plan** → the plans screen → the Enterprise card's **Contact sales**. Drawn as it ships; only the last step's behaviour is new. No price on the line (the fee is omitted in the drawing, not removed from the product).                                                                                                              |
| 2   | Closed control        | (a) manager, rest and hover/focus · (b) member: disabled + reason · (c) open request, manager: `Request sent · 5 Oct 2026` · (d) open request, member: the line.                                                                                                                                                                                                                                      |
| 3   | Open form             | Empty; and filled with the _When would you start?_ list open (Combobox popover, `--shadow-elevated`, selected row on `--el-surface` with a check).                                                                                                                                                                                                                                                    |
| 4   | Validation            | On Send with the note empty and `0` in _Work items a day_: the `Input` / `Textarea` borders turn `--el-danger`, each field says why under itself (`FormField error`), focus moves to the first invalid field, nothing is sent. Validation is client-side first and repeated by the server (MOTIR-7605's 400 maps to the same field messages).                                                         |
| 5   | Sending               | `Button loading` (Spinner + _Sending…_), every input `disabled` (the `--el-input-disabled-*` fill/ink), Cancel disabled, the corner × removed so the dialog cannot be dismissed mid-request.                                                                                                                                                                                                          |
| 6   | Sent                  | The form is replaced in place by a confirmation (mint check, _"Platform staff will reply to {contact}…"_) and one **Done**. On close the card shows `Request sent · {date}` (beside it). The board/list behind it is a client island: the code updates the card from the POST's own response, no refresh needed.                                                                                      |
| 7   | Already requested     | _Your Enterprise request_ — sent date and requester, the **state pill**, _What you told us_ (unset answers say _Not given_), the note quoted, and how staff reply. One **Close**. No form, no edit, no second request.                                                                                                                                                                                |
| 8   | Refused or error      | The form is kept; a `FormField errorVariant="box"` alert (`--el-danger-surface` / `--el-danger-surface-text`) sits above the footer. **409 `ENTERPRISE_REQUEST_OPEN`**: Send disabled, a _View the request_ link swaps the dialog to panel 7 and the card to `Request sent`. **403** (billing's own `manageBilling` refusal): Send disabled. **Network / 5xx**: Send stays enabled; nothing was sent. |
| 9   | `zh`                  | The card's three control states, the empty form, the read-only request (`沟通中`), the 409 alert and the sent confirmation, in `zh`. Chinese labels run longer only in the radio hints, which wrap.                                                                                                                                                                                                   |
| 10  | Narrow reflow (375px) | The plans row scrolls horizontally (shipped behaviour; the Enterprise card is reached by scrolling it). The dialog is `90vw`; the summary box goes to one column, the two-up rows and radio cards stack, the body scrolls under the pinned footer, Cancel / Send split the footer width. Shown at rest and sending.                                                                                   |

**The org-visible state** (panel 7's pill) maps the server's five states to three words, and
never shows the closed two:

| Server state  | The org sees                                   | Pill                                    |
| ------------- | ---------------------------------------------- | --------------------------------------- |
| `new`         | Received                                       | `--el-tint-yellow` / `--el-text-strong` |
| `contacted`   | In conversation                                | `--el-tint-sky` / `--el-text-strong`    |
| `offer_sent`  | Offer sent                                     | `--el-tint-mint` / `--el-text-strong`   |
| `won`, `lost` | — (closed: the card shows Contact sales again) | —                                       |

The three tints are deliberately not lavender, which this screen spends on `Current` /
`Recommended`. No price, figure or amount appears in any state — an offer's terms travel by
email, not on this card.

## Colour + shape roles (additions only — the base tables above still govern)

| Element                                 | Colour                                                                                                                  | Shape                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Dialog panel                            | `--el-page-bg`, `--el-border`, scrim `--el-overlay-scrim`                                                               | `--radius-modal`, `--shadow-modal`, `--spacing-card-padding`                       |
| Corner close ×                          | `--el-text-secondary`, hover `--el-surface` / `--el-text`                                                               | `--radius-control`, `--spacing-icon-btn`                                           |
| _Sent with your request_ box            | `--el-surface-soft` fill, `--el-border`; keys `--el-text-secondary`, values `--el-text`                                 | `--radius-card`                                                                    |
| Input / Combobox trigger / Textarea     | `--el-page-bg`, `--el-input-border`; placeholder `--el-text-muted` (white fill only); error border `--el-danger`        | `--radius-input`, `--height-input`, `--spacing-input-x/y`                          |
| Field error line                        | `--el-danger-on-surface` (not raw `--el-danger`, which is under AA on the dark page in base/cobalt/motir)               | —                                                                                  |
| Helper / optional note / `Required` tag | `--el-text-secondary`                                                                                                   | —                                                                                  |
| Radio card                              | `--el-page-bg` / `--el-border`; on: `--el-accent` border + `--el-surface-soft`; hover `--el-surface`; dot `--el-accent` | `--radius-card` (dot `rounded-full`)                                               |
| Combobox popover                        | `--el-page-bg`, `--el-border`, active row `--el-surface`                                                                | `--radius-card`, rows `--radius-control` / `--height-control`, `--shadow-elevated` |
| Refusal / error box                     | `--el-danger-surface` / `--el-danger-surface-text` (link the same ink, underlined)                                      | `--radius-control`, `--spacing-tooltip-x/y`                                        |
| Disabled (sending)                      | `--el-input-disabled-bg` / `-border` / `-text`                                                                          | —                                                                                  |
| `Request sent` control / line           | `--el-tint-mint` / `--el-text-strong`                                                                                   | `--radius-btn` (button) · `--radius-badge` (member line)                           |
| Member reason line                      | `--el-text-secondary`, `Lock` glyph                                                                                     | —                                                                                  |
| Sent check                              | `--el-tint-mint` / `--el-text-strong`                                                                                   | `rounded-full`                                                                     |

No `--el-text-faint` carries text; `--el-text-muted` appears only as placeholder ink on the white
input fill. Nothing names a hue.

## Primitives composed

- **Package (`@motir/design-system`):** `Modal` (+ `Modal.Body`, `Modal.Footer`), `FormField`
  (`error`, `errorVariant="box"`, `helperText`), `Input`, `Textarea`, `Combobox`, `Button`
  (`primary`, `secondary`, `ghost`, `loading`, `disabled`), `Pill`, `Spinner`. Nothing is missing;
  **nothing is proposed to the package.**
- **Product-local, shipped:** the radio-card group of `components/approvals/RefusalReason.tsx` —
  the code card should lift it into a small shared `RadioCardGroup` in `components/` rather than
  copy it a third time (`ConnectStep.tsx` has a similar one). **Product-local, new:** only the
  _Sent with your request_ summary box (a `<dl>` in a `--el-surface-soft` panel) and the
  read-only request view, both inside the new dialog component.
- **Icons (lucide):** `Send`, `Check`, `Lock`, `CircleAlert`, `WifiOff`, `Mail`, `X`, `ChevronDown`.

## Copy strings (both locales — the `billing.contactSales` namespace MOTIR-7607 adds)

The keys below are the mock's own names; the code card may rename them inside the namespace. The
dates, the org, the requester, the plan, the count and the email are interpolations
(`{date}`, `{org}`, `{name}`, `{contact}`), not literals. The note text is user content and has
no key.

| key             | en                                                                                                                                   | zh                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `contact`       | Contact sales                                                                                                                        | 联系销售                                                                                           |
| `sent_chip`     | Request sent · 5 Oct 2026                                                                                                            | 已发送请求 · 2026年10月5日                                                                         |
| `member_reason` | Only owners and admins of moooon can contact sales.                                                                                  | 只有 moooon 的所有者和管理员可以联系销售。                                                         |
| `ent`           | Enterprise                                                                                                                           | Enterprise                                                                                         |
| `ent_use`       | Custom volume, plus org controls.                                                                                                    | 定制用量，外加组织管控。                                                                           |
| `pool`          | Custom credit pool                                                                                                                   | 定制额度池                                                                                         |
| `seats`         | Motir seats included (custom)                                                                                                        | 包含 Motir 席位（定制）                                                                            |
| `every`         | Everything in Max, plus                                                                                                              | 包含 Max 的全部，另加                                                                              |
| `f1`            | Invoiced billing & SSO                                                                                                               | 开票计费与 SSO                                                                                     |
| `f2`            | Dedicated support                                                                                                                    | 专属支持                                                                                           |
| `title`         | Contact sales — Enterprise                                                                                                           | 联系销售 —— Enterprise                                                                             |
| `sub`           | Tell us what you want Motir to run. Platform staff read every request and reply to you directly.                                     | 告诉我们你希望 Motir 运行什么。平台团队会阅读每一条请求，并直接回复你。                            |
| `facts_h`       | Sent with your request                                                                                                               | 随请求一并发送                                                                                     |
| `k_org`         | Organization                                                                                                                         | 组织                                                                                               |
| `v_org`         | moooon                                                                                                                               | moooon                                                                                             |
| `k_req`         | Requested by                                                                                                                         | 发起人                                                                                             |
| `v_req`         | Sam Rivera                                                                                                                           | Sam Rivera                                                                                         |
| `k_plan`        | Current plan                                                                                                                         | 当前套餐                                                                                           |
| `v_plan`        | Max                                                                                                                                  | Max                                                                                                |
| `k_repo`        | Repositories connected                                                                                                               | 已连接的仓库                                                                                       |
| `v_repo`        | 4                                                                                                                                    | 4                                                                                                  |
| `optional_all`  | Everything below is optional except the note.                                                                                        | 除备注外，以下各项均为选填。                                                                       |
| `l_cards`       | Work items a day, roughly                                                                                                            | 每天大约多少个工作项                                                                               |
| `ph_cards`      | e.g. 40                                                                                                                              | 例如 40                                                                                            |
| `l_par`         | Agents in parallel                                                                                                                   | 并行智能体数量                                                                                     |
| `ph_par`        | e.g. 8                                                                                                                               | 例如 8                                                                                             |
| `l_which`       | Which agents                                                                                                                         | 使用哪些智能体                                                                                     |
| `w_hosted`      | Motir’s hosted agents                                                                                                                | Motir 托管的智能体                                                                                 |
| `w_hosted_h`    | Run on Motir’s models.                                                                                                               | 运行在 Motir 的模型上。                                                                            |
| `w_own`         | Our own agents                                                                                                                       | 我们自己的智能体                                                                                   |
| `w_own_h`       | Claude Code, Codex or another agent on our own credential, in Motir’s cloud.                                                         | Claude Code、Codex 或其他智能体，使用我们自己的凭据，运行在 Motir 云中。                           |
| `w_both`        | Both                                                                                                                                 | 两者都用                                                                                           |
| `w_both_h`      | Some of each.                                                                                                                        | 各用一部分。                                                                                       |
| `l_auto`        | How should it run?                                                                                                                   | 希望如何运行？                                                                                     |
| `a_lead`        | Around the clock, on its own                                                                                                         | 全天候自主运行                                                                                     |
| `a_lead_h`      | The autonomous lead: Motir plans, runs and repairs, and your team decides at approval gates.                                         | 自主负责人：Motir 负责规划、运行与修复，团队在审批关口做决定。                                     |
| `a_vol`         | A large volume of runs we start                                                                                                      | 由我们发起的大量运行                                                                               |
| `a_vol_h`       | Your team starts each run.                                                                                                           | 每次运行由团队发起。                                                                               |
| `a_unsure`      | Not sure yet                                                                                                                         | 还不确定                                                                                           |
| `a_unsure_h`    |                                                                                                                                      |                                                                                                    |
| `l_when`        | When would you start?                                                                                                                | 打算何时开始？                                                                                     |
| `choose`        | Choose…                                                                                                                              | 请选择…                                                                                            |
| `l_team`        | Team size                                                                                                                            | 团队规模                                                                                           |
| `l_reach`       | Best way to reach you                                                                                                                | 最佳联系方式                                                                                       |
| `v_reach`       | sam@moooon.example                                                                                                                   | sam@moooon.example                                                                                 |
| `h_reach`       | Your account email. Change it if someone else should get the reply.                                                                  | 你的账户邮箱。如需由他人接收回复，可修改。                                                         |
| `l_note`        | Note                                                                                                                                 | 备注                                                                                               |
| `req`           | Required                                                                                                                             | 必填                                                                                               |
| `ph_note`       | What should Motir do for your team? Anything we should know about your repositories, security or timing.                             | 你希望 Motir 为团队做什么？关于仓库、安全或时间安排，有什么需要我们了解的。                        |
| `v_note`        | We want Motir to run our three product repositories overnight. Security review needs SSO and an invoice before we start.             | 我们希望 Motir 在夜间运行三个产品仓库。安全评审要求开始前先有 SSO 和发票。                         |
| `cancel`        | Cancel                                                                                                                               | 取消                                                                                               |
| `send`          | Send request                                                                                                                         | 发送请求                                                                                           |
| `sending`       | Sending…                                                                                                                             | 正在发送…                                                                                          |
| `close`         | Close                                                                                                                                | 关闭                                                                                               |
| `done`          | Done                                                                                                                                 | 完成                                                                                               |
| `e_note`        | Add a note — tell us what you want Motir to do for your team.                                                                        | 请填写备注——告诉我们你希望 Motir 为团队做什么。                                                    |
| `e_num`         | Enter a whole number of at least 1.                                                                                                  | 请输入不小于 1 的整数。                                                                            |
| `r409_t`        | Your organization already has an open request.                                                                                       | 你的组织已有一条未关闭的请求。                                                                     |
| `r409_b`        | It was sent on 5 Oct 2026, from another tab or by another admin. Nothing new was sent.                                               | 它于 2026年10月5日 从另一个标签页或由另一位管理员发送。本次没有发送新的请求。                      |
| `r409_a`        | View the request                                                                                                                     | 查看该请求                                                                                         |
| `r403_t`        | You can’t contact sales for moooon.                                                                                                  | 你无法为 moooon 联系销售。                                                                         |
| `r403_b`        | Only owners and admins can. Your role may have changed since this page loaded — ask an organization admin.                           | 只有所有者和管理员可以。自本页加载后你的角色可能已变更——请联系组织管理员。                         |
| `rnet_t`        | Couldn’t reach Motir.                                                                                                                | 无法连接 Motir。                                                                                   |
| `rnet_b`        | Nothing was sent. Check your connection and send again — what you wrote is kept.                                                     | 没有发送任何内容。请检查网络后重新发送——你填写的内容已保留。                                       |
| `ok_t`          | Request sent                                                                                                                         | 请求已发送                                                                                         |
| `ok_b`          | Platform staff will reply to sam@moooon.example. Until the request is closed, the Enterprise card shows it instead of Contact sales. | 平台团队会回复至 sam@moooon.example。在请求关闭前，Enterprise 卡片会显示该请求，而不是“联系销售”。 |
| `ro_t`          | Your Enterprise request                                                                                                              | 你的 Enterprise 请求                                                                               |
| `ro_sub`        | Sent 5 Oct 2026 by Sam Rivera.                                                                                                       | Sam Rivera 于 2026年10月5日 发送。                                                                 |
| `ro_state`      | State                                                                                                                                | 状态                                                                                               |
| `st_new`        | Received                                                                                                                             | 已收到                                                                                             |
| `st_contacted`  | In conversation                                                                                                                      | 沟通中                                                                                             |
| `st_offer`      | Offer sent                                                                                                                           | 已发报价                                                                                           |
| `ro_reply`      | Platform staff reply to sam@moooon.example. To add something, answer their email.                                                    | 平台团队会回复至 sam@moooon.example。如需补充，请直接回复他们的邮件。                              |
| `ro_asked`      | What you told us                                                                                                                     | 你告诉我们的                                                                                       |
| `ro_unset`      | Not given                                                                                                                            | 未填写                                                                                             |
| `when_opts`     | Now · Within a month · Within a quarter · Just exploring                                                                             | 现在 · 一个月内 · 一个季度内 · 只是了解一下                                                        |
| `team_opts`     | 1–10 · 11–50 · 51–200 · 201+                                                                                                         | 1–10 · 11–50 · 51–200 · 201+                                                                       |

## Who consumes this

- **MOTIR-7607** — the form's code: the control's three variants on `PlanCard`, the dialog, the
  read-only view, and the refusal mapping above.
- **MOTIR-7605** — the request record and its routes: the contract this draws (fields, the five
  states and their org-visible three, `ENTERPRISE_REQUEST_OPEN`). If its field list changes, this
  delta is redrawn, not reinterpreted.
- **Out of scope:** the staff side (the /admin Enterprise requests page — [the console
  design](motir:cmuuwiekk00jihwoikmmc2wqk)), the card's content (MOTIR-7596), and any price.

# Amendment 2026-10-14 — the Calculator view and the link that opens it (MOTIR-8636)

**Asset:** `billing--calculator.mock.html` (HTML mock, a DELTA, 18 panels) · **Card:** MOTIR-8636
(design, Story MOTIR-8381). No `.png` is exported: the two-file rule (`CLAUDE.md`,
`docs/decisions/design-result.md` AMENDMENT 4) retired exports for new mocks, so the card's own
mention of `billing--calculator.png` is not followed. **Contract drawn:** motir-ai's calculator
engine — `src/services/calculatorService.ts` (`CalculatorEstimateDto`,
`CalculatorEmptyCategoryDto`, `CalculatorCategoriesDto`, the `calculator_unavailable:` answer) and
`src/calculatorRequest.ts` (the request bounds) — and `lib/billing/catalog.ts`.

## Scope

**Amends** § _Panels_ panel 5 of `billing.mock.html` in ONE place — the plans view's intro block
(`plans.chooseTitle` / `plans.chooseSub`) gains one link — and adds a **fourth view**, the
Calculator. Nothing else on the page changes; `billing.mock.html`, `ci-line.mock.html`,
`search-line.mock.html` and `billing--contact-sales.mock.html` are records and are not edited.
The file's own ladder figures are corrected by the dated note at the head of § _The locked model
this draws_ and in the surface-table row.

## The page grammar

- **A fourth view, not a new navigation.** `BillingClient` switches `home` / `plans` / `seats`
  from client state (`useState<View>`). The Calculator joins as `'calculator'`, with the same
  header every view carries: the `--el-link` back-to-home control (`ArrowLeft`), the muted
  breadcrumb `Organization · {org} · Billing & plans · Calculator`, the serif title and a subtitle.
- **One door.** The only way in is the plans view's link (S1), placed in the intro block **above**
  the cadence control and the plan-card row, so it is read before the ladder and sits above the
  fold at 1280×800. No second door on the home view.
- **No tab strip, no URL state.** The view and its inputs are client state, like the other three
  views; the page's only URL handling stays the one-time `?checkout=` marker it strips.
- **Inputs are never preselected**, and changing any input clears the shown estimate back to the
  not-yet-asked state (S2/S3) — no stale, labelled answer is kept.

## The shared cadence

`PlansView` owns `useState<BillingCadence>('annual')` today. It is **lifted to the page**
(`BillingClient`) and passed to both the plans view and the Calculator, so the two views can never
show different billing periods. The Calculator renders the same `Segmented` + `Save ~33%` pill in
its header row; it is the page's ONE value, drawn where the reader is, not a second control.
The estimate request carries it as `cadence`.

## The controls' composition

| Control              | Shipped primitive it reuses                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The link (S1)        | an inline `--el-link` button with a `Calculator` glyph — the back-link grammar of the views' headers                                                      |
| Cadence              | `Segmented` (the plans view's own control, `plans.cadenceLabel`) + the mint `Pill`                                                                        |
| Range (low, high)    | two `Input`s in a `FormField`, `--height-input` / `--radius-input` / `--spacing-input-x`; error border `--el-danger`, error line `--el-danger-on-surface` |
| Category (per lane)  | `Segmented`, single choice, options in the order `GET categories` returns them; an option whose `models` is empty is `disabled` with its reason           |
| Models (per lane)    | `TopupCard`'s `role="group"` of `aria-pressed` buttons — multi-select; `--radius-control`, selected = `--el-accent` border + `--el-surface` fill          |
| Ask / next step      | `Button` `primary` (`loading` while asking); next step leads to the plans view                                                                            |
| Loading              | skeleton bars (`--el-muted`, no text) — the area's loading grammar                                                                                        |
| Request failed (S15) | `ErrorState`                                                                                                                                              |
| Member gate (S16)    | the page's shipped `EmptyState` gate, unchanged                                                                                                           |

Two lanes, **planning** and **running**, each a `{ category, modelIds }` selection. The tab
computes no share between models — the engine performs the split.

## States

| Panel  | State                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| S1     | The link in the plans view, the page around it at real width                                                                            |
| S2     | Initial — range empty, no category, no model, ask disabled with a stated reason, a placeholder that promises no number                  |
| S3     | Ready — whole-number range, `low <= high`, ≥ 1 model per lane, ask enabled, no result                                                   |
| S4     | Asking — ask busy, inputs readable, result in its loading treatment with no prior answer                                                |
| S5     | Categories loading — both pickers skeleton, ask impossible                                                                              |
| S6     | Categories unavailable / failed — one dashed notice in the form + retry; the ask states why it cannot run                               |
| S7     | No live model in a category — (a) from `GET categories`, (b) from `kind: 'empty_category'` — one treatment, no number                   |
| S8     | Populated — credit range, recommended plan, top-up, seat line, next step; Max ×2 on annual and on monthly                               |
| S9     | `ceiling.exceeded` — the excess is met by top-up only; both cadences                                                                    |
| S10    | Top-up only (`planKey: null`) — plan block and seat line variants                                                                       |
| S11    | Upgrade line (above) · equal-or-lower (no line, no downgrade control) · no plan held (nothing)                                          |
| S12    | `droppedModelIds` — the model leaves the selection with a note; the range is the engine's for the models kept                           |
| S13    | Four inline refusals: range end missing / non-whole / negative · `low > high` · empty lane · over the per-lane cap (no count printed)   |
| S14    | `calculator_unavailable:` — "we can't estimate right now" + retry; peach notice; no number; the previous answer explicitly not retained |
| S15    | Transport failure / other non-2xx — `ErrorState`, worded apart from S14, retry                                                          |
| S16    | Roles — owner and admin: link, view, enabled next step; member: the shipped gate                                                        |
| `zh`   | S8 in Chinese                                                                                                                           |
| narrow | S8 at 375px, one column                                                                                                                 |

S6, S14 and S15 are three visibly different treatments (a dashed notice in the FORM; a peach notice
in the RESULT; an `ErrorState` card replacing the result) and none carries a number.

## The state → field map

| Panel / slot                    | Fed by                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Category options, model buttons | `GET categories` → `categories[].key`, `categories[].models[].id` / `.provider`; empty `models` → S7a                                                         |
| S5 / S6                         | that read in flight / answered `calculator_unavailable:` or failed                                                                                            |
| S13 refusals                    | `src/calculatorRequest.ts` bounds, checked client-side: whole numbers 0..1,000,000, `low <= high`, non-empty `modelIds`, at most `MAX_MODELS_PER_LANE` unique |
| Credit range                    | `credits.low` / `credits.high`                                                                                                                                |
| Per-item line                   | `perItemCredits.planning` / `.running`                                                                                                                        |
| Plan name + price               | `recommendation.planKey` → catalog entry `name` + `prices[cadence]` (key→catalog resolution, MOTIR-8640)                                                      |
| Top-up row                      | `topUp.low` / `topUp.high` → `units`, `credits`, `priceUsd`                                                                                                   |
| Seat line                       | catalog `includedTrackerSeats` + `seatPlan.prices[cadence]` — never × member count, never added to the plan price                                             |
| S9 ceiling statement            | `ceiling.exceeded`, `ceiling.credits`, `ceiling.excessCredits`                                                                                                |
| S10                             | `recommendation.planKey: null`                                                                                                                                |
| S11 line                        | recommended entry's pool > current plan's pool (catalog order — `PlansView`'s `currentPool` rule)                                                             |
| S12 note                        | `droppedModelIds[lane]`; the kept set is `models[lane]`                                                                                                       |
| S7b                             | `kind: 'empty_category'`, `lanes`                                                                                                                             |
| S14                             | `internal_error` whose detail starts `calculator_unavailable:`                                                                                                |
| S15                             | network error, or any non-2xx that is not S14                                                                                                                 |

## The roles fact

Owner and admin both hold `manageBilling` (`lib/organizations/capabilities.ts`), so both see the
link, the view and an enabled next step. A plain member is refused (403) by
`billingService.getBillingStatus` before any view renders, and `BillingClient` shows its shipped
gate (`member.gateTitle` / `member.gateDescription` / `member.contactOwner`). **There is no member
variant of the Calculator and no disabled-button variant of its next step** — no role can reach
one, and S16 draws that absence on purpose.

## Who builds what

| Card           | Builds                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-8637** | the motir-core server routes for `categories` and `estimate`, the engine's answers mapped (S6, S7b, S14, S15), and the client seam |
| **MOTIR-8638** | every word: the link, the view, its states, the seat rule — en and every locale the `billing` catalogue keeps                      |
| **MOTIR-8639** | the view itself, the link (S1), the lifted cadence, the controls, and every state panel's rendering                                |
| **MOTIR-8640** | integration: key→catalog resolution, the plan block (incl. Max ×2) and the seat line (S8–S11)                                      |
| **MOTIR-8641** | E2E: link → Calculator → an estimate and the seat rule → every refusal, with the paced acceptance video                            |
| **MOTIR-8643** | the pinned-vector rendering — the recorded range, plan and top-up rendered field for field                                         |

## Colour + shape roles (additions only — the base tables above still govern)

| Element                    | Colour                                                                                                   | Shape                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Calculator link            | `--el-link`                                                                                              | inline, no box                              |
| Lane box                   | `--el-page-bg`, `--el-border`; name `--el-text`, help `--el-text-secondary`                              | `--radius-card`                             |
| Model button               | `--el-border`; on: `--el-accent` border + `--el-surface`; id `--el-text`, provider `--el-text-secondary` | `--radius-control`, `--spacing-control-x/y` |
| Disabled category          | `--el-text-secondary` at 50% opacity, struck through, `disabled`                                         | inherits `Segmented`                        |
| Result placeholder         | dashed `--el-border`; text `--el-text-secondary`; glyph `--el-text-faint` (`aria-hidden`)                | `--radius-card`                             |
| Credit range figure        | `--el-text` (serif); unit `--el-text-secondary`                                                          | —                                           |
| Recommended plan block     | `--el-accent` border, `--el-page-bg`; tier `Pill` lavender                                               | `--radius-card`                             |
| Top-up-only pill           | `--el-tint-sky` + `--el-text-strong`                                                                     | `--radius-badge`                            |
| Ceiling statement (S9)     | `--el-tint-yellow` + `--el-text-strong`, glyph `--el-warning`                                            | `--radius-card`                             |
| Upgrade line (S11)         | `--el-tint-sky` + `--el-text-strong`                                                                     | `--radius-card`                             |
| Retired-model note (S12)   | `--el-tint-sky` + `--el-text-strong`                                                                     | `--radius-control`                          |
| Categories failed (S6)     | `--el-surface-soft`, dashed `--el-border-strong`; text `--el-text` / `--el-text-secondary`               | `--radius-card`                             |
| Estimate unavailable (S14) | `--el-tint-peach` + `--el-text-strong`                                                                   | `--radius-card`                             |
| Request failed (S15)       | `ErrorState`; glyph `--el-danger-on-surface`, description `--el-text-secondary`                          | `--radius-card`                             |
| Field error                | border `--el-danger`, line `--el-danger-on-surface`                                                      | —                                           |
| Source labels (board only) | `--el-text-secondary`, mono                                                                              | —                                           |

No `--el-text-faint` carries text; `--el-text-muted` appears only on the white page/card (the
breadcrumb, a card's sub-heading, the input placeholder). `--el-danger-text` is not used. Nothing
names a hue.

## Primitives composed

- **Package (`@motir/design-system`):** `Card`, `Segmented`, `Button` (`primary`, `secondary`,
  `loading`), `Pill`, `Input`, `FormField`, `ErrorState`, `EmptyState`. Nothing is proposed to the
  package.
- **Product-local, shipped:** `TopupCard`'s `aria-pressed` group grammar (reused, not imported —
  the view builds its own group the same way), the views' header grammar, the member gate.
- **Icons (lucide):** `ArrowLeft`, `ArrowRight`, `Calculator`, `Coins`, `Users`, `Sparkles`,
  `TrendingUp`, `CircleAlert`, `TriangleAlert`, `Clock`, `RotateCw`, `WifiOff`, `CircleMinus`,
  `Info`, `Lock`, `X`.

## Copy strings (representative — the final en and zh, and every other locale, are MOTIR-8638's)

| intent            | en                                                                             | zh                                                           |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| link              | Not sure which plan fits? Estimate it with the calculator                      | 不确定哪个套餐合适？用计算器估算一下                         |
| title             | Calculator                                                                     | 计算器                                                       |
| breadcrumb        | Organization · {org} · Billing & plans · Calculator                            | 组织 · {org} · 账单与套餐 · 计算器                           |
| range             | Items finished per month — From / To                                           | 每月完成的事项数 —— 从 / 到                                  |
| lanes             | Planning model · Running model                                                 | 规划模型 · 执行模型                                          |
| ask               | Estimate                                                                       | 估算                                                         |
| credits           | Your organization's credits per month                                          | 你的组织每月的额度                                           |
| one plan          | One plan for the whole organization — not per member.                          | 整个组织一个套餐 —— 不按成员计。                             |
| seat              | 1 Motir seat included with an AI plan · each further member {price}            | AI 套餐包含 1 个 Motir 席位 · 每增加一名成员 {price}         |
| seat, top-up only | No Motir seat is included without an AI plan — every seat is per user, {price} | 没有 AI 套餐时不含 Motir 席位 —— 每个席位按用户计费，{price} |
| upgrade           | A mid-period upgrade is priced for the days left in the period.                | 期中升级按本期剩余天数计价。                                 |
| ceiling           | The {excess} credits beyond it are met by top-up only.                         | 超出的 {excess} 额度仅能通过充值补足。                       |
| unavailable (S14) | We can't estimate right now                                                    | 暂时无法估算                                                 |
| failed (S15)      | Couldn't reach the calculator                                                  | 无法连接计算器                                               |
| cap refusal       | That's more models than one lane can take. Remove one to ask.                  | 一个通道无法容纳这么多模型。请移除一个再估算。               |

## The numbers are illustrative

Every figure in the mock — ranges, pools, prices, top-ups, the ceiling, model ids — is
illustrative and carries its source on the panel. The design fixes where each figure comes from,
never its value.

**Dated note (2026-10-15, MOTIR-8636):** this design was republished unchanged for a fresh review after the re-plan its first review asked for was declined.

# Amendment 2026-10-21 — the Calculator takes model CATEGORIES and offers a larger pool (MOTIR-8636)

**Amends** `## Amendment 2026-10-19 — the Calculator view…`'s states and `design/billing/billing--calculator.mock.html`.
That mock is a record of the moment it was drawn and is not edited; the panels this change alters are
redrawn in **`design/billing/billing--calculator--categories.mock.html`**, which holds only the
changed panels. Panels this amendment does not name (S1 the link, S4 asking, S15 unavailable, S16
failed, S17 roles) stand as drawn there. **Why:** the design was sent back on 2026-10-19
(`request changes`) with three points, each answered below.

## What changed, point by point

1. **No model is chosen.** The per-lane model multi-select is gone. Each category lists the models it
   serves as non-interactive **example text** (`categories[].models` of the categories answer); no
   control anywhere selects one. The notes of the earlier amendment that say a model is chosen, a
   per-lane cap refuses, a model is dropped (S12) or a lane is empty are superseded.
2. **One set of one to three categories, shared equally.** The input is ONE group of toggles in the
   `TopupCard` `role="group"` / `aria-pressed` grammar. The estimate is a **range**, shared equally
   across the chosen categories — one carries all of it, two share it 50 / 50, three share it a third
   each — and the answer prints the split (`split.count`, `split.categories[].key`, `.weight`); **the
   surface performs no share arithmetic** and the copy says the result is an estimate, not a quote.
   A fourth category is refused inline at the group, because the engine takes one to three.
3. **A larger pool is offered directly.** When the high end passes the largest REGULAR pool and the
   answer carries a plan row above it (`ceiling.outcome = larger_pool`), the panel shows that plan —
   its credit pool and its price for the selected cadence, as the row carries them — **instead of** a
   regular plan plus top-ups. The pool and price are **dynamic in the sense of the answer, not of the
   surface**: the design reads them from `recommendation.*` and never composes them. **Whether those
   plan rows are created on the fly in Stripe or predefined there is not a design decision and the design does not depend on it** —
   the surface is identical either way; it is the larger-pool plan story's (MOTIR-8986).

## States (panel by panel — the new mock)

| Panel  | State                                                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| S2     | Initial — nothing chosen, range empty, ask disabled with its reason                                                              |
| S3     | Ready — two categories chosen, ask enabled, models as examples only                                                              |
| S5     | Categories loading — skeleton group, ask impossible                                                                              |
| S6     | Categories unavailable or failed — dashed notice and retry, ask impossible                                                       |
| S7     | A category with no live model — (a) `categories[].models = []`, (b) `kind: empty_category`; the others stay usable; no number    |
| S8     | Populated, regular plan — one, two and three categories with the split printed; Max ×2 on annual and monthly                     |
| S9     | **Larger pool offered** — `ceiling.outcome = larger_pool`; pool and price as an estimate; both cadences; no stacked top-ups      |
| S10    | Above the top band, **no larger pool** — `ceiling.outcome = top_ups_only`; the regular top and the excess met by top-ups, warned |
| S11    | A single plan covers it / a top-up closes it — `within_ladder`; the top-up-only variant states the seat comes with an AI plan    |
| S12    | Already holding the largest regular pool and covered by it — its own plan, no larger plan, no mid-period-upgrade line            |
| S13    | The recommendation against the current plan — above (one line, no figure) · equal or below (none) · no plan held (none)          |
| S14    | Refused inline, no request sent — **no category chosen**, **a fourth category**; range refusals unchanged                        |
| `zh`   | S8 (two categories) in Chinese — the noun for the thing counted is 工作项 (work item)                                            |
| narrow | S9 at 375px, one column                                                                                                          |

S9 and S10 differ by wording **and** layout so a reader needs no arithmetic: S9 shows a dashed plan
block titled "a larger credit pool" and no top-ups; S10 shows the regular plan, a top-up line and a
yellow "above our largest plan" notice.

## The state → field map (engine contract version 2)

| Slot                                | Field                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| Category names and example models   | categories answer: `categories[].key`, `categories[].models` (empty → S7a)                     |
| The credit range                    | `credits.low` / `credits.high`; per-item figure `perItemCredits.planning` / `.running`         |
| The split printed                   | `split.count`, `split.categories[].key`, `.weight`, `.models`                                  |
| A regular plan                      | `recommendation.planKey` → catalog entry; `planName`; `monthlyPriceUsd`                        |
| The larger pool                     | `ceiling.outcome = larger_pool` with `recommendation.planKey` / `planName` / `monthlyPriceUsd` |
| Above the top band, no larger pool  | `ceiling.outcome = top_ups_only`, `ceiling.credits`, `ceiling.excessCredits`                   |
| Inside the ladder                   | `ceiling.outcome = within_ladder`                                                              |
| Top-up                              | `topUp.low` / `topUp.high` → `units`, `credits`, `priceUsd`                                    |
| A category with no live model (S7b) | `kind: empty_category` → `categories`                                                          |
| Seat lines                          | catalog `includedTrackerSeats` · `seatPlan.prices` — never from the engine                     |

## Who builds what (what this amendment GIVES and TAKES)

| Card                                    | Verdict | What                                                                                                                                                                               |
| --------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-9004 (the door takes categories)  | GIVES   | the category-set request and the answer fields S8–S12 read (`split`, `ceiling.outcome`)                                                                                            |
| MOTIR-8638 (words)                      | GIVES   | the category group's help, the split sentence, the estimate caveat and the S9 / S10 wording; TAKES `categoryHelp` and `categoryMissing` (they describe model choice and two lanes) |
| MOTIR-8639 (the view)                   | GIVES   | one category group (no model control), the split box, the larger-pool block; TAKES the per-lane multi-select, the split-by-model cases and the dropped-model note                  |
| MOTIR-8640 (integration)                | GIVES   | S8–S12's key → catalog resolution; a `larger_pool` plan key that the catalog does not sell is rendered from the answer, not resolved                                               |
| MOTIR-8641 (E2E)                        | TAKES   | the two-lane request body, "one category picked for each lane" and the retired-model case; GIVES S9 and S10 as the two states a walk must tell apart                               |
| MOTIR-8643 (the vector against the tab) | GIVES   | the recorded range, split and recommendation rendered against the category contract                                                                                                |

## Colour + shape roles (additions only — the base tables above still govern)

| Element                         | Role                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| Category toggle                 | `--radius-control`, `--spacing-control-x/y`; on: `--el-accent` border + `--el-surface` fill   |
| Example models (caption)        | `--el-text-secondary` (clears AA on every surface)                                            |
| Split box                       | `--el-surface-soft` fill, `--el-border`, `--radius-card`; chips `pill-neutral`                |
| Larger-pool block               | the recommended-plan block with a dashed `--el-accent` border; notice on `--el-tint-lavender` |
| "Above our largest plan" notice | `--el-tint-yellow` with `--el-warning` glyph, text `--el-text-strong`                         |

## The numbers are illustrative

Every figure in the new mock — ranges, pools, prices, shares, the ceiling — is illustrative and
carries its source on the panel. The design fixes where each figure comes from, never its value.
Pools and prices of the regular plans are read from `lib/billing/catalog.ts`, which supersedes the
2,000 / 8,000-credit ladder, the Enterprise card and the $10-per-1,000 top-up the file's opening
paragraph still carries.

## Amendment 2026-10-21 — the larger credit pool plan

Subtask MOTIR-8988, story MOTIR-8986. Mock: **`billing--larger-pool.mock.html`**. It amends
`billing.mock.html` panel 5 (the Motir AI plans view) and the answer of
`billing--calculator--categories.mock.html` (S9, the larger pool offered). Those mocks are records
and are not edited. The rungs, prices and keys come from MOTIR-8987's approved record (v2), carried
in `lib/billing/catalog.ts` as the `larger_pool` band (MOTIR-8990).

**Redrawn 2026-10-22 after Yue's review.** The first draft put the larger pool on the plans row as
a fifth card. Yue chose a different flow: the plans view shows the four regular plans and a way
into the Calculator, the Calculator offers the pool and sells it directly, and an org that holds a
pool sees that one plan with the regular plans folded away.

**Redrawn again 2026-10-22 after Yue's second review.** Two fixes: the Calculator asks which model
categories the runner uses (Economy, Balanced, Flagship, split evenly, specified in § "Amendment
2026-10-21 — the Calculator's planned and run ranges"), and an estimate above the largest pool is
offered that pool with top-ups for the rest instead of a notice with no offer. Both mocks are now
rendered with `renderMock` from the design system's own `Button`, `Card`, `Input`, `Pill` and
`Segmented`, composed as `BillingClient.tsx` and `CalculatorView.tsx` compose them; the mono lines
in them name each string's key and are board chrome, not product copy.

### The flow

1. **Plans view, no pool held (panel 1).** The row shows the four regular plans only, and the
   catalogue's Recommended stays on Pro. Below the row, ONE **Need more credits?** callout
   (`--el-tint-sky`) holds a primary **Open the Calculator** button. It opens the Calculator view,
   as the shipped `calculator.open` button does. A pool card is never drawn on this view for an
   org that does not hold one.
2. **Calculator, pool offered (panels 2–3 and 6–8).** The Calculator lays out in two columns at
   desktop width: the form on the left, the answer on the right. When `ceiling.outcome = larger_pool`, the answer on
   the right carries the offer card. The card shows the pool's name, the shipped `largerPlan`
   sentence, the price block on the page's cadence, the pool, the shipped `largerPlanEstimate`
   caveat, the seat line and the buy control. The buy control replaces the shipped "Go to this
   plan" for this arm:
   - With no live plan, **Choose Pool N** (`plans.ctaChoose`) starts Checkout from the answer at
     quantity 1.
   - With a smaller live plan, **Upgrade to Pool N** (`plans.ctaUpgrade`) opens the shipped
     `PlanChangeDialog`, followed by the shipped `upgradeNote`.
   - A read-only manager sees the control disabled and described by `plans.upgrade.disabledReason`.
3. **Calculator, above the largest pool (panel 4).** When the high end passes the top rung
   (250,000), the answer offers the top rung, **Pool 250,000**, in the same offer card, labelled
   **Largest credit pool**. Inside the card, a top-up box says how much is left over and that
   top-ups cover it: the excess is the high end minus 250,000, shown in 1,000-credit top-up units
   at the shipped top-up rate. The buy control is the same as panels 2–3. `plans.larger.aboveBand`
   is no longer drawn.
4. **Calculator, a regular plan covers it (panel 5).** The shipped regular arm and its "Go to
   this plan" are unchanged; no pool is offered.
5. **Refused (panel 8).** ONE notice inside the answer, above the offer, with the `refused.*`
   sentence the refusal code selects. The offer stays drawn. No toast.
6. **Plans view, pool held (panels 9–10).** The title reads **Your plan** and the row shows ONE
   card: the held pool, marked Current, with `captionCurrent`. A **See all regular plans** toggle
   (`aria-expanded`, `aria-controls`) unfolds the four regular plans below it, each with the
   shipped switch control, which moves down at period end. Opened, the toggle reads **Hide regular
   plans**. The Need more credits? callout stays, worded for a holder (`bodyHeld`).
7. **Narrow (panel 11).** The Calculator stacks to one column (form above answer, the category
   buttons one per row), and the offer and its button take the full width.

### Copy — new keys in the `billing` namespace (en)

| Key                                  | en                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plans.needMore.title`               | Need more credits?                                                                                                                                      |
| `plans.needMore.body`                | If your organization uses more than {plan}'s {credits} credits a month, estimate your usage and the Calculator offers a larger credit pool sized to it. |
| `plans.needMore.bodyHeld`            | If your organization outgrows its {credits} credits a month, estimate your usage and the Calculator offers a larger pool sized to it.                   |
| `plans.needMore.action`              | Open the Calculator                                                                                                                                     |
| `plans.yourPlanTitle`                | Your plan                                                                                                                                               |
| `plans.larger.showRegular`           | See all regular plans                                                                                                                                   |
| `plans.larger.hideRegular`           | Hide regular plans                                                                                                                                      |
| `calculator.result.largestPoolLabel` | Largest credit pool                                                                                                                                     |
| `calculator.result.largestPool`      | Your estimate is above our largest pool, so the answer is that pool — {plan} — with top-ups for the rest.                                               |
| `calculator.result.largestPoolTopUp` | The other {excess} credits or so a month are covered by top-ups: about {units} × 1,000 credits, {price} a month at $5 per 1,000.                        |

Every other string is shipped: `calculator.result.{largerPoolLabel, largerPlan, largerPlanEstimate,
upgradeNote, goToPlan}`, `plans.{ctaChoose, ctaUpgrade, ctaCurrent, upgrade.disabledReason}` and
`plans.larger.{captionCurrent, refused.*}` (MOTIR-8993). `plans.larger.aboveBand` is no longer
drawn, since above the band now offers the largest pool. The plans-row keys
`plans.larger.{caption, priceEstimate, basis.*}` are no longer drawn, because the row never offers a
pool. The new keys land in every locale with the UI card (MOTIR-8997).

### Colour + shape roles (additions only)

| Element                     | Role                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Need more credits? callout  | `--el-tint-sky` fill, `--el-border-soft`, `--radius-card`, `--spacing-card-padding`, text `--el-text-strong`                                        |
| Offer card in the answer    | `--el-surface`, `--el-accent` border, `--radius-card`, `--spacing-card-padding`, `--shadow-card`                                                    |
| Held pool card              | the shipped PlanCard, Current: `--el-accent` border                                                                                                 |
| See all regular plans       | text button, `--el-link`, `--radius-control`, `--spacing-control-x/y`                                                                               |
| Captions · seat line        | `--el-text-secondary`                                                                                                                               |
| Refused notice              | `--el-surface-soft`, dashed `--el-border-strong`, `--radius-card`, text `--el-text`                                                                 |
| Top-up box (above the band) | `--el-surface-soft`, `--el-border-soft`, `--radius-control`, `--spacing-control-x-12/y-8`, `Coins` glyph `--el-accent-on-surface`, text `--el-text` |

### The numbers are illustrative

The estimates (61,000–74,000; 230,000–290,000), the rungs drawn (Pool 80,000; Pool 250,000) and
their prices are illustrative. The
rungs and prices are read from `lib/billing/catalog.ts`.

## Amendment 2026-10-21 — the Calculator's planned and run ranges

Subtask MOTIR-9225, story MOTIR-8986. Mock: **`billing--calculator--planned-and-run.mock.html`**.
It amends § "Amendment 2026-10-14 — the Calculator view and the link that opens it" and its
category delta (`billing--calculator--categories.mock.html`, S2–S3 inputs and the head of the S8
answer); those mocks are records and are not edited. Rendered against what `main` ships:
`CalculatorView.tsx`'s one range fieldset (`calculator.inputs.rangeLabel`, Low / High `Input`s,
`rangeHelp`, a `role="alert"` error line).

### What changes

- **Two ranges replace the one.** The form card holds two labelled low/high ranges, stacked, each
  in the shipped fieldset shape: items planned in Motir a month, and items run on Motir's runner a
  month. The second carries the own-agent help: items run on your own agent through Motir's MCP or
  CLI use no credits here. An org that runs everything on its own agent enters 0–0 there and is
  quoted the planning lane only.
- **The answer states what was priced.** One line opens the shipped answer, filled from the
  ranges the answer echoes back (never from the inputs, which may have changed since).
- **Both ranges at 0 is refused before any request**, with one sentence under the ranges. One
  range at 0 alone is valid.

- **The categories are the runner's (redrawn 2026-10-22 after Yue's review).** The shipped
  category group stays (Economy, Balanced, Flagship, each with example models, one to three
  picked) and is relabelled **Models the runner uses**: it picks the models the run lane is
  priced on. The run is split evenly across what is picked, and each picked button shows its
  share: one picked takes 100%, two take 50% each, all three take 33% each (panels 1–3). The
  answer's split sentence and one pill per picked category repeat the split.
- The planning lane is priced on Motir's own planner and is not split by these categories. The
  engine (MOTIR-9223) applies categories to both lanes today, so pricing them to the run lane
  only is an engine change for the build cards to carry.

The credits figure, the plan block and every other part of the answer ship unchanged. Both mocks
are rendered with `renderMock` from the design system's own parts.

### Copy (en) — new keys in the `billing` namespace

| Key                                    | en                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calculator.inputs.plannedLabel`       | Items planned in Motir a month                                                                                                                                                                                |
| `calculator.inputs.runLabel`           | Items run on Motir's runner a month                                                                                                                                                                           |
| `calculator.inputs.runHelp`            | Items you run on your own agent — Claude Code, Codex — through Motir's MCP or CLI use no credits here. Count only the items Motir's runner builds; 0 is fine.                                                 |
| `calculator.result.priced`             | Priced for {plannedLow}–{plannedHigh} planned in Motir and {runLow}–{runHigh} run on Motir's runner a month.                                                                                                  |
| `calculator.errors.rangeBothZero`      | Enter at least one item a month — with both ranges at 0 there is nothing to price.                                                                                                                            |
| `calculator.inputs.runCategoriesLabel` | Models the runner uses                                                                                                                                                                                        |
| `calculator.inputs.runCategoriesHelp`  | Pick one to three. The run is split evenly across what you pick: one takes 100%, two take 50% each, all three take 33% each. You never choose a model — each category lists the models it serves as examples. |
| `calculator.inputs.categoryShare`      | {share} of the run                                                                                                                                                                                            |

Changed wording: `calculator.split.one` becomes "One category, so the whole run sits on
{category}." and `calculator.split.even` becomes "The run is split evenly across {categories} —
{shares} each." `calculator.inputs.categoriesLabel` and `categoriesHelp` are retired.

`calculator.inputs.rangeLabel` is retired; `rangeHelp`, `lowLabel`, `highLabel` and the other
range errors (`rangeEmpty`, `rangeInvalid`, `rangeOrder`) apply to each range as shipped. The
words are MOTIR-9224's to land in every locale.

### Colour + shape roles (additions only)

| Element           | Role                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| Range labels      | `--el-text`, the shipped legend weight                                                                  |
| Own-agent help    | `--el-text-secondary` (clears AA on every surface)                                                      |
| Low / High inputs | the shipped `Input`: `--radius-input`, `--spacing-input-x/y`, `--el-border`; invalid `--el-danger` edge |
| Both-zero refusal | `--el-danger-on-surface`, `role="alert"`, the shipped error line                                        |
| Priced-range line | `--el-surface-soft` fill, `--el-border-soft`, `--radius-control`, text `--el-text`                      |

### The answer offers the larger pool (panel 6, added 2026-10-22)

When both lanes together pass Max ×2, the answer on the right carries the larger-pool offer and its
buy control directly. That card and all its states are specified in § "Amendment 2026-10-21 — the
larger credit pool plan" and drawn in `billing--larger-pool.mock.html`.

### The numbers are illustrative

The ranges and credit figures drawn are illustrative.

## Amendment 2026-10-23 — the Host plan

Mock: **`billing--host.mock.html`**. It amends `billing.mock.html` panel 5 (the Motir AI plans
row) and § "Amendment 2026-10-21 — the larger credit pool plan" panels 9–10 (the regular plans an
org holding a pool unfolds). Those mocks are records and are not edited. It is rendered with
`renderMock` from the design system's own `Button`, `Card`, `Pill` and `Segmented`, composed as
`BillingClient.tsx` composes `PlanCard` and `PlanChangeDialog.tsx` composes its dialogs; the dialog
panel is drawn static with the shipped `Modal`'s classes. The mono lines are board chrome.

### What changes

**Revised 2026-10-23 after review: the price cards were too narrow, so the plans view now takes the
full page width (point 7).**

1. **The Host card (panels 1–2).** Host is a fifth paid card, last in the row after Max ×2, drawn by
   the shipped `PlanCard` with no new element. Its name, monthly and annual price, credit pool and
   included seat are the catalog entry's. Its ladder line is the shipped `plans.ladder.multiple`
   ("5× Max ×2's credits · same price per credit"). Recommended stays on Pro; Host is never
   Recommended and never carries the Calculator's mark. The Need more credits? callout is unchanged
   and still names Max ×2's pool.
2. **The Host entitlement lines (panels 1–2).** Under the shipped "Everything in Max ×2, plus",
   two feature lines say that Motir runs the project autonomously and that CI runners, agent runs,
   the indexer and hosted agents each get dedicated pools. (Revised after review: the line about
   Max's limits until the account quotas are granted is dropped, and the AWS-accounts line is
   shortened to the dedicated pools.)
3. **Choosing Host (panels 3–4).** Choose Host starts one quantity-1 Checkout on the page's
   cadence, with the shipped redirecting state. A member without billing rights sees Upgrade to Host
   disabled, described by the shipped `plans.upgrade.disabledReason`.
4. **The upgrade to Host (panels 5–7).** From Max ×2 (or any lower plan) the Host card says Upgrade
   to Host and opens the shipped upgrade dialog: ready, loading skeleton, preview error, success.
   The Host row then shows Host Current and Downgrade to … on every lower card.
5. **Host in the unfolded regular plans (panel 8).** An org holding a larger pool unfolds Standard …
   Max ×2 and Host; Host offers Upgrade to Host when it is above the held pool, through the same
   dialog.
6. **The downgrade from Host and the pending downgrade from Host (panels 9–11).** The shipped
   downgrade dialog at period end, nothing due, credits unchanged, and the shipped pending-change
   line on the Host card with the target card's disabled Scheduled for … control.
7. **The plans view takes the full page width (every desktop panel).** The billing page no longer
   caps the Motir AI plans view at `max-w-[64rem]`: it fills the width the app shell gives it, so
   five cards stay wide enough to read. The cards keep the shipped `grow basis-0`, so the row
   shares that width equally. The other billing views (the home panel, Motir seats, the
   Calculator) keep their shipped width. This is layout only: no new token.
8. **`zh` and narrow (panels 12–13).** No layout change: the row scrolls horizontally with snap at
   375px and Host is full and readable at its end; the dialogs are full-width sheets.

### Copy — new keys in the `billing` namespace (en)

| Key                         | en                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `plans.tiers.host.useCase`  | Motir at fleet scale, on AWS accounts of your own.                                                                     |
| `plans.tiers.host.prev`     | Max ×2                                                                                                                 |
| `plans.tiers.host.features` | 1. Motir runs your project autonomously · 2. Dedicated pools for CI runners, agent runs, the indexer and hosted agents |

Every other string is shipped: `plans.{ctaChoose, ctaUpgrade, ctaCurrent, everythingIn,
ladder.multiple, seatIncluded}`, and the `plans.upgrade.*` and `plans.downgrade.*` dialog keys (the pending
downgrade is `plans.downgrade.{pendingPill, scheduledButton}`). The new keys land in every locale; the `zh` panel shows the Chinese text.

### Where the figures come from

- The Host card's name, prices (monthly and annual), credit pool and included seat: the catalog
  entry in `lib/billing/catalog.ts`.
- Every figure and date in a dialog (amount due, credits and index allowance added, the period
  end): the plan-change preview response. The card prints none of its own.

### Colour + shape roles

No new colour or shape role. Every element is a shipped component in its shipped state, so the base
tables and the larger-pool amendment's roles govern.

### The numbers are illustrative

The period end (Nov 1, 2026), the days left, the amounts due ($580.65 from Max ×2; $166.94 from
Pool 250,000) and the credits and allowance added are illustrative.
