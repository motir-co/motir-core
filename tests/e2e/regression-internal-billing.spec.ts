import { expect, test } from './_helpers/promoted-regression';
import { db, resetDatabase } from './_helpers/db-reset';
import {
  paidOrgState,
  resetBillingFixture,
  seedBillingOwner,
  setOrgBillingState,
  TIERS,
} from './_helpers/billing';
import type { BillingFixtureEntry } from '@/lib/test-billing-mock';
import enMessages from '@/messages/en.json';

// AN INTERNAL ORG BILLS LIKE A CUSTOMER — THE ACCEPTANCE RECEIPT
// (Story MOTIR-4337 · Subtask MOTIR-4575). The story's `verification_recipe`,
// performed in a browser.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// This story's deliverable is not a mechanism, it is a VIEW: the ability to sit
// in Motir's own organization and see the billing experience a customer gets.
// That makes this clip unusually literal — the receipt and the feature are the
// same footage. Two of its seconds carry most of the value, and they are the two
// an automated suite is worst at showing:
//
//   · Panel 7b RENDERING. An out-of-credits screen has existed in this codebase
//     for months and nobody at Motir has ever seen it outside a fixture, because
//     the one organization using Motir hardest was the one org whose balance was
//     a WORD. Chapter 4 is that screen, for that org.
//   · The org CARRYING ON immediately afterwards. Asserted apart, those two facts
//     are much weaker than shown together: a screen that says you are out of
//     credits while you are demonstrably not blocked is the shape of the design,
//     and it is what a reviewer needs in order to believe the offset is real
//     rather than a suppression wearing new clothes.
//
// ── PACING IS DELIBERATE (AC 7) ─────────────────────────────────────────────
//
// Each `beat` is a thing a person can actually see happen, and the chapters are
// ordered as one walk: the operator classifies, the customer's screens fill in,
// the two thresholds arrive, the org keeps working, the operator unclassifies.
// Nothing navigates that does not show something new. Do NOT "optimise" the
// holds out — the clip IS the deliverable here, more literally than usual.
//
// MEASURED at 54.5s, inside the ADR's ~60s guidance and far clear of the publish
// lane's 15s floor. Chapter starts: 1.0 / 7.8 / 18.6 / 25.2 / 32.1 / 47.5s, so
// the longest single phase is 15.4s and no stretch runs long enough to lose a
// viewer. Nine beats — the first cut had sixteen and timed out with the walk
// complete and its last beat unheld, which is why the two cheapest holds were
// given back to the chapters' own (see the dashboard and the closing move).
//
// ── ⚠️ AC 3 IS AMENDED, AND THE AMENDMENT IS THE HONEST HALF OF THE CLIP ────
//
// The card asks this spec to *"perform an action that a genuinely out-of-credits
// org would be refused, and watch it succeed."* It cannot, and staging it would
// be a lie told in the one artifact a human accepts the story from.
//
// The only balance-keyed refusal the product has is the AI paywall
// (`billingService.getAiAccess` → `balance <= 0`), and this story deliberately
// leaves it on `isMeta` — MOTIR-4573's own AC 5 FORBIDS `internalBilling` from
// appearing in `aiEntitlement.ts`, and `internal-billing-classification.md` §
// *"It lifts no cap and grants no entitlement"* says why: the classification
// decides what an org is CHARGED, never what it is ALLOWED. So an org that has
// genuinely reached zero is genuinely out of credits, and refusing it is
// correct.
//
// What makes *the org is never blocked* true is STRUCTURAL, not defended: the
// offset lands in the SAME transaction as the debit (MOTIR-4570), so a classified
// org's balance never falls in the first place. A browser cannot stage a state
// the ledger prevents. What it CAN show — and what chapter 5 shows — is that
// reaching that state gates nothing here: every control that was live at a
// healthy balance is still live at zero, asserted as a DIFFERENCE between the two
// renders rather than as a list that stops covering the page the day somebody
// adds a control, and the org performs a real product action while the paused
// banner is on screen.

const sum = enMessages.aiUsage.summary;
const low = enMessages.aiUsage.lowBalance;
const outOf = enMessages.aiUsage.outOfCredits;
const bill = enMessages.billing;
const admin = enMessages.platformAdmin.orgs;
const tenants = enMessages.platformAdmin.tenants;

// ── ⚠️ AND THE CLIP RUNS IN ONE SESSION, ON PURPOSE (measured, not preferred) ─
//
// The first cut used a separate operator account and signed in and out three
// times; it timed out at 90s with the walk complete but the last beat unheld.
// Every one of those auth flows costs ~11s of a clip whose whole budget is ~85s,
// and none of them shows anything. So ONE person holds both roles here, and the
// platform gate is exercised by REMOVING their standing in the database rather
// than by re-authenticating as somebody else — the gate reads a fresh row per
// request, so the very next navigation sees it. That makes chapter 3 stronger
// rather than weaker: the same person, on the organization they OWN, gets the
// ordinary 404 the moment the standing goes.

const OWNER = 'acceptance-internal-billing@example.com';

const REASON = 'Motir dogfood org — charged like a customer, offset in the ledger (MOTIR-4337)';

/** The org's motir-ai state: a paid plan, real spend, a real breakdown. */
function withUsage(over: Partial<BillingFixtureEntry> = {}): BillingFixtureEntry {
  return {
    ...paidOrgState({ tier: TIERS.pro, balance: 4420 }),
    totalSpend: 147_520,
    monthSpend: 7_520,
    search: { totalSpend: 1204, monthSpend: 312 },
    perModel: [
      { model: 'claude-opus-4-8', inputTokens: 120_000, outputTokens: 40_000, credits: 6_100 },
      { model: 'claude-sonnet-4-5', inputTokens: 90_000, outputTokens: 30_000, credits: 1_420 },
    ],
    ...over,
  };
}

/**
 * Every control on the page, and whether it is turned off. Read from the DOM
 * rather than enumerated, so a control added later is covered without an edit —
 * which is what makes chapter 5's counterfactual survive the next story.
 */
async function liveControls(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('button, a, input, select'))
      .map(
        (el) =>
          `${el.tagName}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim()}:${
            el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'
          }`,
      )
      .sort(),
  );
}

test('an internal org is classified by staff, and then bills like a customer', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-4337');

  await resetDatabase();
  resetBillingFixture();

  // One org, one person, one session: the org's OWNER, who also holds platform
  // standing. `superadmin`, because a billing classification is what
  // `platform-staff-auth.md` §7 puts there — support and operator may READ this
  // page and not act on it.
  const seed = await seedBillingOwner(page, OWNER);
  setOrgBillingState(seed.organizationId, withUsage());
  await db.user.update({ where: { email: OWNER }, data: { platformRole: 'superadmin' } });

  const org = await db.organization.findUniqueOrThrow({ where: { id: seed.organizationId } });

  await chapter('An operator finds the organization', async () => {
    // Tenants is LIST-FIRST since MOTIR-7287 (design D10): every org's spend on
    // arrival, a name/slug filter in the toolbar. The filter narrows the list in
    // the URL, so a filtered list is linkable and survives a reload.
    await page.goto('/admin/tenants');
    await expect(page.getByRole('heading', { name: tenants.title })).toBeVisible();
    const filter = page.getByRole('search').getByRole('searchbox');
    await filter.fill(org.slug);
    await filter.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/admin/tenants\\?.*q=${org.slug}`));
    // A row needs spend in motir-ai's rollup to appear, which this story's fixture
    // does not produce — the list's own walk is MOTIR-735's. The org page is the
    // subject here, so open it by its id.
    await page.goto(`/admin/tenants/${seed.organizationId}`);

    await expect(page).toHaveURL(new RegExp(`/admin/tenants/${seed.organizationId}`));
    await expect(page.getByRole('heading', { name: org.name })).toBeVisible();
    // The READ is on the record before anything is changed, and the banner on
    // screen says so.
    await expect(page.getByText(/recorded in the audit log/).first()).toBeVisible();
    await beat();
  });

  await chapter('A reason is required, and then the classification lands', async () => {
    await page.getByRole('button', { name: admin.action.classify }).click();
    const confirm = page.getByRole('button', { name: admin.confirm.classify.confirm });
    // ⚠️ THE REFUSAL FIRST. The primary is disabled until a reason is typed —
    // an `org.internal_billing_set` row with no reason cannot answer *why is
    // this organization not being billed?* a year from now. Whitespace is blank.
    await expect(confirm).toBeDisabled();
    await page.getByRole('textbox', { name: admin.confirm.reasonLabel }).fill('   ');
    await expect(confirm).toBeDisabled();
    await page.getByRole('textbox', { name: admin.confirm.reasonLabel }).fill(REASON);
    await expect(confirm).toBeEnabled();
    await beat();

    await confirm.click();
    // Authoritative: the SERVER-rendered chip, after the action revalidated the
    // path — never the dialog's own disappearance.
    await expect(page.getByText(admin.chip.internalBilling, { exact: true }).first()).toBeVisible();
    // The write and its record are ONE surface: an operator can never perform an
    // action and wonder whether it was recorded.
    await expect(page.getByText(REASON).first()).toBeVisible();
    await beat();
  });

  await chapter('The console does not exist for anybody else', async () => {
    // The standing goes, and nothing else changes — no sign-out, no second
    // account. The gate reads a fresh row per request, so the next navigation
    // sees it, and this person still OWNS the organization they are looking at.
    await db.user.update({ where: { email: OWNER }, data: { platformRole: null } });

    // The ordinary app 404 — not a 403, not a redirect. No existence leak.
    const denied = await page.goto(`/admin/tenants/${seed.organizationId}`);
    expect(denied?.status()).toBe(404);
    await expect(page.getByText('403')).toHaveCount(0);
    await beat();
  });

  await chapter('The customer dashboard — a number where a word used to be', async () => {
    await page.goto('/settings/organization/usage');
    await expect(page.getByText(sum.balance)).toBeVisible();

    // ⚠️ THE FIGURE. `summary.unlimited` stood here behind an `isMeta` ternary
    // and is deleted with it. This is the second the story exists for.
    const hero = page.getByText(sum.balance).locator('xpath=..');
    await expect(hero).toContainText('4,420');
    await expect(page.getByText(sum.internalBilling, { exact: true }).first()).toBeVisible();

    // The allotment bar, which the same branch suppressed, and the whole
    // dashboard around it with real figures. ONE hold for the panel, not two:
    // the figures arrive together and a viewer reads them together.
    await expect(page.getByText(/of this month.s .* allotment remaining/).first()).toBeVisible();
    // MOTIR-7229 retired the per-model panel: the fixture still reports a
    // breakdown, and no model id reaches the page.
    await expect(page.getByText('claude-opus-4-8')).toHaveCount(0);
    await expect(page.getByText(sum.searchThisMonth).first()).toBeVisible();
    await beat();
  });

  // ⚠️ CAPTURED HERE, AT A HEALTHY BALANCE, and compared at zero below. Taking
  // the baseline from the page already on screen is what keeps the counterfactual
  // free — the first cut paid a whole extra reload for it and ran out of clip.
  const healthy = await liveControls(page);

  await chapter('The two states that were unreachable — and the org carries on', async () => {
    // Panel 7a — 400 of the Pro tier's 8,000-credit allotment is 5%, under the
    // 10% line and clear of it in both directions.
    setOrgBillingState(seed.organizationId, withUsage({ balance: 400 }));
    await page.reload();
    await expect(page.getByText(low.title).first()).toBeVisible();
    // The classification chip is right beside it: the internal org seeing a
    // warning it could never see before.
    await expect(page.getByText(sum.internalBilling, { exact: true }).first()).toBeVisible();
    await beat();

    // Panel 7b — the screen nobody at Motir has ever seen for this org. And the
    // two are EXCLUSIVE: "running low" beside "planning is paused" would
    // contradict it.
    setOrgBillingState(seed.organizationId, withUsage({ balance: 0 }));
    await page.reload();
    await expect(page.getByRole('heading', { name: outOf.title })).toBeVisible();
    await expect(page.getByText(low.title)).toHaveCount(0);

    // ⚠️ THE COUNTERFACTUAL, AS A DIFFERENCE. Every control on the page at a
    // zero balance against every control at a healthy one. This fails the day
    // somebody hangs a `disabled` off `outOfCredits` — which is exactly how the
    // "never blocked" clause would regress, and it would look correct in
    // isolation.
    expect(await liveControls(page)).toEqual(healthy);
    await beat();

    // …and the product itself, while the paused banner is up. Not a figure on a
    // billing page: a work item, created through the shipped UI, by the
    // organization the panel says is out of credits.
    await page.goto('/items');
    await page.getByRole('button', { name: 'Create work item' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill('Written while the balance reads zero');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(/^\S+ created$/).first()).toBeVisible();
    await beat();
  });

  await chapter('Billing as a customer sees it, and then the record survives', async () => {
    setOrgBillingState(seed.organizationId, withUsage());
    await page.goto('/settings/organization/billing');
    await expect(page.getByRole('heading', { name: 'Billing & plans' })).toBeVisible();

    // The storefront the read-only "Internal plan" card used to replace: both
    // billed lines, the CI line — and the CTAs, live. A LABEL sits beside them,
    // naming what the org is and changing no figure on the page.
    // `exact`, because Playwright's accessible-name match is a SUBSTRING one:
    // a bare "Motir" takes the AI, CI and Search lines with it.
    await expect(page.getByRole('heading', { name: 'Motir', exact: true, level: 2 })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Motir AI', exact: true, level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Motir CI', exact: true, level: 2 }),
    ).toBeVisible();
    await expect(page.getByText(bill.internalBilling.badge).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change plan' })).toBeEnabled();
    await beat();

    // The closing move takes the chapter's own hold rather than a beat of its
    // own — the clip's budget is ~85s and this is the cheapest 4s to give back.
    // And back on the operator side, the classification comes off again.
    await db.user.update({ where: { email: OWNER }, data: { platformRole: 'superadmin' } });
    await page.goto(`/admin/tenants/${seed.organizationId}`);
    await page.getByRole('button', { name: admin.action.unclassify }).click();
    await page
      .getByRole('textbox', { name: admin.confirm.reasonLabel })
      .fill('Moved to a paying plan');
    await page.getByRole('button', { name: admin.confirm.unclassify.confirm }).click();
    await expect(page.getByText(admin.chip.internalBilling, { exact: true })).toHaveCount(0);

    // ⚠️ AND BOTH WRITES ARE STILL THERE. Unclassifying changes what happens
    // NEXT; it does not edit what happened. The trail is the same trail, one row
    // longer — which is the whole reason the offset is a paired ROW rather than
    // a suppressed charge.
    await expect(page.getByText(REASON).first()).toBeVisible();
    await expect(page.getByText('Moved to a paying plan').first()).toBeVisible();
  });
});
