import { expect, test } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { seedBillingOwner } from './_helpers/billing';

// Story MOTIR-10363 · MOTIR-10372 — the Fleet page WITHOUT THE FLEET METER. The
// story's acceptance walk (`acceptance-org-fleet.spec.ts`) runs in the cloud-on
// acceptance lane, which cannot boot a server without the meter; this spec runs
// in the MAIN (off-cloud) lane, which IS that build — the self-host arm, as
// `billing-selfhost.spec.ts` is for Billing & plans. The owner, who could read
// the page on cloud, finds no Fleet row in the rail, and both the page and its
// read answer 404.

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('@smoke self-host: no Fleet rail row, and the Fleet page and its read 404', async ({
  page,
}) => {
  const seed = await seedBillingOwner(page, 'e2e-org-fleet-selfhost@example.com');

  await page.goto('/settings/organization');
  await expect(page.locator('a[href="/settings/organization/members"]').first()).toBeVisible();
  await expect(page.locator('a[href="/settings/organization/fleet"]')).toHaveCount(0);

  expect((await page.goto('/settings/organization/fleet'))?.status()).toBe(404);
  const read = await page.request.get(`/api/organizations/${seed.organizationId}/fleet`);
  expect(read.status()).toBe(404);
});
