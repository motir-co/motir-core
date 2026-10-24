import { expect, test } from '@playwright/test';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { resetBillingFixture } from './_helpers/billing';
import { signUpToOnboarding } from './_helpers/shell-session';
import {
  clearFleetRows,
  inFlightCi,
  seedKill,
  seedRunningCi,
  seedTenantOrg,
} from './_helpers/fleet-monitor-seed';
import enMessages from '@/messages/en.json';

/**
 * THE FLEET MONITOR'S REFUSALS AND QUIET STATES (Story MOTIR-6905 · MOTIR-7322) —
 * the regression twin of `regression-fleet-monitor.spec.ts`, which films the
 * happy path (read → mismatch → stop → zero, the other org unchanged).
 *
 * ⚠️ IN THE CLOUD LANE ON PURPOSE. Off-cloud the Fleet section renders one
 * "Disabled on this deployment" card and the org page draws no Fleet card at all
 * (`admin-fleet-selfhost.spec.ts` asserts exactly that in the default lane), so
 * neither the empty state nor the operator's disabled control is reachable there.
 *
 * ⚠️ NOTHING HERE PRESSES STOP. This lane selects no fleet orchestrator, and a
 * read needs none: the census, the verdict and the card are database reads. The
 * stop is walked in the acceptance lane, which selects the fake.
 *
 *  1. A tenant member — the owner of an org, signed in — gets the ordinary 404 on
 *     `/admin/monitoring` and on the org page that lists its own containers.
 *  2. An `operator` reads the Fleet card and its count, and **Stop containers**
 *     is disabled, described by the reason: only a superadmin may stop. Its
 *     container is still in flight afterwards.
 *  3. With nothing running and no kill in the last 24 hours (one older kill is
 *     seeded to prove the window), both Fleet cards render their empty states —
 *     healthy readings in words, never a table of zeros.
 */

const fm = enMessages.platformAdmin.monitoring.fleet;
const tf = enMessages.platformAdmin.tenant.fleet;

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
  await clearFleetRows();
  resetBillingFixture();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

test('a tenant member is refused the fleet; an operator reads it but cannot stop', async ({
  page,
}) => {
  const email = 'e2e-fleet-tenant@example.com';
  await signUpToOnboarding(page, email);
  const user = await adminDb.user.findUniqueOrThrow({ where: { email } });
  const ownOrg = await adminDb.organization.findFirstOrThrow({
    where: { memberships: { some: { userId: user.id } } },
  });

  const juniper = await seedTenantOrg('Juniper Works', 'e2e-fleet-juniper');
  await seedRunningCi(juniper, 1, new Date(Date.now() - 60_000));

  // ── A tenant — the owner of an org, signed in — finds no console at all.
  expect((await page.goto('/admin/monitoring'))?.status()).toBe(404);
  expect((await page.goto(`/admin/tenants/${ownOrg.id}`))?.status()).toBe(404);
  expect((await page.goto(`/admin/tenants/${juniper.organizationId}`))?.status()).toBe(404);

  // ── The same person as an `operator`: the gate reads a fresh row per request.
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'operator' } });

  expect((await page.goto('/admin/monitoring'))?.status()).toBe(200);
  const main = page.getByRole('main');
  const fleetOrgs = main.getByTestId('fleet-orgs');
  await expect(main.getByRole('heading', { name: fm.orgs.title })).toBeVisible();
  await expect(fleetOrgs).toHaveAttribute('data-state', 'populated');
  await fleetOrgs
    .getByRole('row', { name: /Juniper Works/ })
    .getByRole('link', { name: 'Juniper Works' })
    .click();

  await expect(page).toHaveURL(new RegExp(`/admin/tenants/${juniper.organizationId}$`));
  const card = main.getByTestId('org-fleet-card');
  await expect(card.getByRole('heading', { name: tf.title })).toBeVisible();
  await expect(card.getByTestId('org-fleet-tile-ciRunner')).toContainText('1');

  const stop = card.getByRole('button', { name: tf.stop.button });
  await expect(stop).toBeDisabled();
  await expect(stop).toHaveAccessibleDescription(
    'Only a superadmin can stop an organization’s containers. You are signed in as operator.',
  );
  // The control is presentation; the authoritative fact is that nothing stopped.
  expect(await inFlightCi(juniper.organizationId)).toBe(1);
});

test('nothing running and no kill in 24 hours: both Fleet cards say so in words', async ({
  page,
}) => {
  const email = 'e2e-fleet-support@example.com';
  await signUpToOnboarding(page, email);
  await adminDb.user.update({ where: { email }, data: { platformRole: 'support' } });

  // A kill OUTSIDE the card's 24-hour window: still on record, not on the card.
  await seedKill({
    machineId: 'e2e-old-kill',
    reason: 'record_ended',
    decidedAgoMs: 30 * 60 * 60_000,
    ageSeconds: 600,
  });

  expect((await page.goto('/admin/monitoring'))?.status()).toBe(200);
  const main = page.getByRole('main');

  const fleetOrgs = main.getByTestId('fleet-orgs');
  await expect(fleetOrgs).toHaveAttribute('data-state', 'empty');
  await expect(fleetOrgs.getByRole('heading', { name: fm.orgs.empty.title })).toBeVisible();
  await expect(fleetOrgs.getByText(fm.orgs.noMismatch)).toBeVisible();
  await expect(fleetOrgs.getByRole('table')).toHaveCount(0);

  const kills = main.getByTestId('fleet-kills');
  await expect(kills).toHaveAttribute('data-state', 'empty');
  await expect(kills.getByRole('heading', { name: fm.kills.empty.title })).toBeVisible();
  await expect(kills.getByText(fm.kills.none)).toBeVisible();
  await expect(kills.getByRole('row', { name: /e2e-old-kill/ })).toHaveCount(0);

  // Neither is the off-cloud card.
  await expect(main.getByTestId('fleet-disabled')).toHaveCount(0);
});
