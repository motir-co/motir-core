import type { Locator, Page, Response } from '@playwright/test';
import { expect, test } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import {
  freeOrgState,
  resetBillingFixture,
  seedBillingOwner,
  setOrgBillingState,
  type BillingSeed,
} from './_helpers/billing';
import { appendAuditChainLink, firstAuditChainBreak } from './_helpers/platform-audit-chain';
import { BILLING_CATALOG } from '@/lib/billing/catalog';
import type { BillingFixtureEntry } from '@/lib/test-billing-mock';
import enMessages from '@/messages/en.json';

/**
 * STORY MOTIR-9385 — Motir has no Enterprise tier: the leftover Contact-sales
 * Enterprise-requests feature is gone from the operator console, and Billing & plans
 * is unchanged (MOTIR-9392).
 *
 * The assembled `/admin` console and Billing & plans, served by the lane's real Next
 * server against the real test database. The parent story's verification recipe,
 * steps 1–4:
 *
 *  1. A support operator's rail, then a superadmin's, has no Enterprise requests row
 *     and no `/admin/enterprise-requests` link — each absence asserted only after a
 *     row that must be there has rendered.
 *  2. `/admin/enterprise-requests`, `/admin/enterprise-requests/<id>` and
 *     `POST /api/organizations/<orgId>/billing/enterprise-request` answer 404.
 *  3. A stored audit row whose action is the removed `enterprise_request.transition`,
 *     seeded as a real link of the hash chain, still lists, opens and shows its
 *     metadata, and the chain still verifies.
 *  4. The owner's Motir AI plan cards are the four ladder plans, with no Enterprise
 *     card and no Contact sales.
 *
 * Every wait is a rendered state or an awaited response, never a timeout.
 */

const shellLabels = enMessages.platformAdmin.shell;
const nav = enMessages.platformAdmin.nav;
const audit = enMessages.platformAdmin.audit;
const billing = enMessages.billing;

/**
 * The removed rail label. A literal, because its catalogue key
 * (`platformAdmin.shell.navEnterpriseRequests`) was deleted with the feature.
 */
const REMOVED_RAIL_LABEL = 'Enterprise requests';
const REMOVED_PAGE = '/admin/enterprise-requests';
/** Any well-formed cuid: the detail route is gone whatever the id. */
const REMOVED_REQUEST_ID = 'cmenterprisereq0000000001';

// The owner's address names the org and its workspace on every page, so it must
// not carry the word the billing chapter asserts is absent.
const OWNER = 'acceptance-tier-removal-owner@example.com';
const STALE_REASON = `Moved Enterprise request ${REMOVED_REQUEST_ID} from new to contacted.`;

/** The Motir AI ladder cards the plans screen offers: the catalog's ladder, less Free. */
const LADDER = BILLING_CATALOG.aiPlans.filter((p) => p.band === 'ladder' && p.key !== 'free');
const FREE = BILLING_CATALOG.aiPlans.find((p) => p.key === 'free')!;

/** The org on the one-time trial, as motir-ai reports it (as the ladder spec does). */
const trialState = (balance: number): BillingFixtureEntry => ({
  ...freeOrgState(balance),
  tier: { key: FREE.key, name: FREE.name, monthlyCreditAllotment: FREE.allotment!.credits },
});

/** Fill a catalogue message's simple `{name}` placeholders. */
function fill(message: string, values: Record<string, string | number>): string {
  return message.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}

/** Every link in the console's rail that would lead to the removed console. */
const removedLinks = (page: Page): Locator =>
  page
    .locator(`a[href^="${REMOVED_PAGE}"]`)
    .or(page.getByRole('link', { name: REMOVED_RAIL_LABEL }));

/** The billing panel's own read — the authoritative state the page renders. */
const billingRead = (page: Page, seed: BillingSeed): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname === `/api/organizations/${seed.organizationId}/billing`,
    { timeout: 45_000 },
  );

/** The plan cards' row and its card headers, as `regression-billing-plan-ladder.spec.ts` reads them. */
const cardRow = (page: Page): Locator => page.getByRole('main').locator('div.snap-x');
const cardNames = (page: Page): Locator =>
  cardRow(page).locator(':scope > div > div > span.font-semibold');

test('the console has no Enterprise requests, its URLs 404, an old enterprise-request audit row still renders, and Billing & plans is unchanged', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9385');
  test.setTimeout(180_000);

  await resetDatabase();
  resetBillingFixture();
  const seed = await seedBillingOwner(page, OWNER);
  const main = page.getByRole('main');

  await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'support' } });

  await chapter('Support staff: the console rail has no Enterprise requests row', async () => {
    await page.goto('/admin');
    // The rail is up: its Monitoring row shows.
    await expect(page.getByRole('link', { name: nav.monitoring, exact: true })).toBeVisible();
    await expect(removedLinks(page)).toHaveCount(0);
    await beat();
  });

  await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'superadmin' } });

  await chapter('A superadmin: the full rail, and still no Enterprise requests row', async () => {
    await page.goto('/admin');
    // The superadmin-only rows are drawn, so the rail is the whole one.
    await expect(
      page.getByRole('link', { name: shellLabels.navFleetSettings, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: nav.auditLog, exact: true })).toBeVisible();
    await expect(removedLinks(page)).toHaveCount(0);
    await beat();
  });

  await chapter('The old console pages and the Contact-sales route answer 404', async () => {
    for (const url of [REMOVED_PAGE, `${REMOVED_PAGE}/${REMOVED_REQUEST_ID}`]) {
      const res = await page.goto(url);
      expect(res?.status(), url).toBe(404);
      await expect(page.getByRole('heading', { name: REMOVED_RAIL_LABEL })).toHaveCount(0);
    }
    const post = await page.request.post(
      `/api/organizations/${seed.organizationId}/billing/enterprise-request`,
      {
        data: {
          teamSize: '11-50',
          agentPath: 'hosted',
          autonomy: 'supervised',
          startWhen: 'this_quarter',
          message: 'We would like to talk about an Enterprise plan.',
        },
      },
    );
    expect(post.status()).toBe(404);
    await beat();
  });

  // The row the removed console wrote when an operator moved a request, as it wrote
  // it, appended as the next link of the chain the page above has been extending.
  const stale = await appendAuditChainLink({
    actorUserId: seed.ownerId,
    actorRole: 'superadmin',
    action: 'enterprise_request.transition',
    targetKind: 'organization',
    targetId: seed.organizationId,
    targetLabel: null,
    organizationId: seed.organizationId,
    reason: STALE_REASON,
    metadata: { requestId: REMOVED_REQUEST_ID, from: 'new', to: 'contacted' },
  });
  expect(await firstAuditChainBreak()).toBeNull();

  await chapter('An old enterprise-request audit row still lists and opens', async () => {
    await page.goto(`/admin/audit-log?q=${encodeURIComponent(REMOVED_REQUEST_ID)}`);
    await expect(page.getByRole('heading', { name: audit.title, level: 1 })).toBeVisible();
    // The page verified the chain on the way in, and it holds.
    await expect(main.getByTestId('audit-chain-ok')).toBeVisible();
    await expect(main.getByTestId('audit-chain-broken')).toHaveCount(0);

    const table = main.getByTestId('audit-table');
    const rows = table.locator('[data-testid^="audit-row-"]');
    await expect(rows).toHaveCount(1);
    const row = main.getByTestId(`audit-row-${stale.seq}`);
    await expect(row).toContainText('enterprise_request.transition');
    await expect(row).toContainText(OWNER);
    await expect(row).toContainText(STALE_REASON);
    await beat();

    await table
      .getByRole('button', { name: fill(audit.detail.toggle, { n: stale.seq }), exact: true })
      .click();
    const detail = main.getByTestId('audit-detail');
    await expect(detail).toContainText(`"requestId": "${REMOVED_REQUEST_ID}"`);
    await expect(detail).toContainText('"from": "new"');
    await expect(detail).toContainText('"to": "contacted"');
    await beat();
  });

  // The page's own reads appended more links; the whole chain still verifies.
  expect(await firstAuditChainBreak()).toBeNull();

  await chapter('Billing & plans → Motir AI: the four ladder plans, no Enterprise', async () => {
    setOrgBillingState(seed.organizationId, trialState(185));
    const read = billingRead(page, seed);
    await page.goto('/settings/organization/billing');
    expect((await read).status()).toBe(200);
    await expect(page.getByRole('heading', { name: billing.title })).toBeVisible();
    await page.getByRole('button', { name: billing.ai.choosePlan }).click();
    await expect(page.getByRole('heading', { name: billing.plans.title })).toBeVisible();

    expect(LADDER.map((p) => p.key)).toEqual(['standard', 'pro', 'max', 'max_x2']);
    await expect(cardNames(page)).toHaveText(LADDER.map((p) => p.name));
    await expect(main).not.toContainText(/enterprise/i);
    await expect(page.getByRole('button', { name: /contact sales/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /contact sales/i })).toHaveCount(0);
    await beat();
  });
});
