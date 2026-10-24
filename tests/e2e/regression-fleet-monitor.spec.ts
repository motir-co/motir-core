import { expect, test } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { paidOrgState, resetBillingFixture, setOrgBillingState } from './_helpers/billing';
import { signUpToOnboarding } from './_helpers/shell-session';
import {
  clearFleetRows,
  FLEET_WINDOW_MS,
  inFlightCi,
  seedAccrual,
  seedKill,
  seedRunningCi,
  seedTenantOrg,
} from './_helpers/fleet-monitor-seed';
import enMessages from '@/messages/en.json';

/**
 * STORY MOTIR-6905 — the fleet monitor, the debit-mismatch reading and the admin
 * fleet stop, walked as the story's acceptance receipt (MOTIR-7322).
 *
 * The verification recipe's browser half, over a seeded estate (the rows and the
 * seams each one goes through are documented in `_helpers/fleet-monitor-seed.ts`):
 *
 *  1. A superadmin opens `/admin/monitoring`. The Fleet section lists two orgs —
 *     Northwind, whose CI has run past the window with no accrual reaching it
 *     (*Running, not debited*), sorted FIRST although Halcyon runs more; and
 *     Halcyon, debited as it runs (*OK*). The reconciler's kills list shows a
 *     seeded kill with its reason in words.
 *  2. Northwind's link opens its org page. The Fleet card counts its container
 *     and carries the same verdict.
 *  3. **Stop containers** opens the confirmation with its counts; with no reason
 *     (or only spaces) the confirm stays refused; with one, the stop runs, the
 *     result is written on the card, the tiles read zero and the `fleet.stop` row
 *     is shown back with its reason.
 *  4. Back on the monitor, Halcyon still runs its two containers, OK — the stop
 *     touched no other organisation — and Northwind is gone from the list.
 *
 * The refusals (a tenant member at `/admin/monitoring`, an operator's disabled
 * Stop), the empty state and the disabled state are the regression specs'
 * (`cloud-admin-fleet.spec.ts`, `admin-fleet-selfhost.spec.ts`): asserted on every
 * PR, and not worth a reviewer's minute of video.
 *
 * Every wait is on an authoritative signal — a server-rendered row, chip or tile,
 * the stop's result rendered from the action's own response, and the database's
 * in-flight count — and every locator is a role or is scoped under `main`.
 */

const fm = enMessages.platformAdmin.monitoring.fleet;
const tf = enMessages.platformAdmin.tenant.fleet;

const STAFF = 'acceptance-fleet-staff@example.com';
const STOP_REASON = 'CI ran 30 min with no debit reaching Northwind — stopping until it is fixed';

const MIN = 60_000;
// The Fleet table is 64rem wide and scrolls inside its own box; at the lane's
// default 1280px, beside the 240px admin sidebar, its index, accrual,
// credits and verdict columns sat past the box's edge in the video.
const WIDE = { width: 1440, height: 810 };

test('a platform admin reads the fleet, stops one org’s containers, and the other org keeps running', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6905');

  await resetDatabase();
  await clearFleetRows();
  resetBillingFixture();

  // ── The estate. Two tenants with CI containers on the fake orchestrator, both
  //    on a paid plan so the zero stop's balance read answers.
  const now = Date.now();
  const northwind = await seedTenantOrg('Northwind Labs', 'e2e-fleet-northwind');
  const halcyon = await seedTenantOrg('Halcyon Studio', 'e2e-fleet-halcyon');
  setOrgBillingState(northwind.organizationId, paidOrgState({ balance: 2_400 }));
  setOrgBillingState(halcyon.organizationId, paidOrgState({ balance: 5_100 }));

  // Northwind: one CI job running for 30 minutes, the debit job's last tick 25
  // minutes ago — outside the two-period window, so running and debited disagree.
  const stale = await seedRunningCi(northwind, 1, new Date(now - 30 * MIN));
  await seedAccrual(northwind, stale, 25 * MIN, 60 * 60);
  expect(25 * MIN).toBeGreaterThan(FLEET_WINDOW_MS);

  // Halcyon: two CI jobs three minutes in, ticked a minute ago — healthy, and
  // running MORE than Northwind, so only the mismatch puts Northwind first.
  const fresh = await seedRunningCi(halcyon, 2, new Date(now - 3 * MIN));
  await seedAccrual(halcyon, fresh, 1 * MIN, 2 * 60);

  // The reconciler destroyed a machine nobody owned, twelve minutes ago.
  await seedKill({
    machineId: 'e2e-orphan-01',
    reason: 'no_record',
    decidedAgoMs: 12 * MIN,
    ageSeconds: 2 * 60 * 60 + 14 * 60,
  });

  // ── The operator: a signed-up account granted `superadmin`; the gate reads a
  //    fresh row per request.
  await page.setViewportSize(WIDE);
  await signUpToOnboarding(page, STAFF);
  await adminDb.user.update({ where: { email: STAFF }, data: { platformRole: 'superadmin' } });

  const main = page.getByRole('main');
  const fleetOrgs = main.getByTestId('fleet-orgs');
  const northwindRow = fleetOrgs.getByRole('row', { name: /Northwind Labs/ });
  const halcyonRow = fleetOrgs.getByRole('row', { name: /Halcyon Studio/ });

  await chapter(
    'Monitoring · Fleet: two organisations running, the mismatched one first',
    async () => {
      expect((await page.goto('/admin/monitoring'))?.status()).toBe(200);
      await expect(main.getByRole('heading', { name: fm.orgs.title })).toBeVisible();
      await fleetOrgs.scrollIntoViewIfNeeded();

      // Mismatched FIRST, although Halcyon runs two containers to its one.
      await expect(fleetOrgs.locator('tbody tr').first()).toHaveAttribute(
        'data-org',
        northwind.organizationId,
      );
      await expect(northwindRow).toHaveAttribute('data-mismatch', 'true');
      await expect(northwindRow.getByText(fm.verdict.running_not_debited)).toBeVisible();
      await expect(northwindRow.getByText(fm.orgs.accrued.none)).toBeVisible();
      await expect(halcyonRow.getByText(fm.verdict.ok)).toBeVisible();
      // Halcyon is on Standard (MOTIR-9377): its plan named, its CI against 5.
      await expect(halcyonRow.getByRole('cell').nth(1)).toContainText('Standard');
      await expect(halcyonRow.getByRole('cell').nth(2)).toHaveText('2 of 5');
      // Every column is ON SCREEN, not merely in the DOM: the No plan figure group
      // and the last column are inside the table's scroll box, not past its edge.
      const ownPool = fleetOrgs.getByRole('columnheader', { name: fm.orgs.group.uncapped });
      const verdictCol = fleetOrgs.getByRole('columnheader', { name: fm.orgs.col.verdict });
      await expect(ownPool).toBeInViewport({ ratio: 1 });
      await expect(verdictCol).toBeInViewport({ ratio: 1 });
      await expect(fleetOrgs.getByText('1 mismatched')).toBeVisible();
      await expect(fleetOrgs.getByText('2 orgs running')).toBeVisible();
      await beat();
    },
  );

  await chapter('The reconciler’s kills: a machine no record owned, in words', async () => {
    const kills = main.getByTestId('fleet-kills');
    await expect(kills.getByRole('heading', { name: fm.kills.title })).toBeVisible();
    await kills.scrollIntoViewIfNeeded();
    const kill = kills.getByRole('row', { name: /e2e-orphan-01/ });
    await expect(kill.getByText(fm.kills.reason.no_record, { exact: true })).toBeVisible();
    await expect(kill.getByText(fm.kills.reason.no_recordGloss)).toBeVisible();
    await expect(kill.getByText(fm.kills.action.destroyed)).toBeVisible();
    await expect(kill.getByText(fm.kills.noOrg)).toBeVisible();
    await beat();
  });

  const card = main.getByTestId('org-fleet-card');

  await chapter('Northwind’s org page: its Fleet card says the same', async () => {
    await fleetOrgs.scrollIntoViewIfNeeded();
    await northwindRow.getByRole('link', { name: 'Northwind Labs' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/tenants/${northwind.organizationId}$`));
    await expect(card.getByRole('heading', { name: tf.title })).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByTestId('org-fleet-tile-ciRunner')).toContainText('1');
    await expect(card.getByText(fm.verdict.running_not_debited)).toBeVisible();
    await beat();
  });

  await chapter(
    'Stop containers: the counts, a blank reason refused, then a reason given',
    async () => {
      await card.getByRole('button', { name: tf.stop.button }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Stop Northwind Labs’s containers?' });
      await expect(dialog).toBeVisible();
      // The preview's counts — read from the server, so this is the wait.
      const reason = dialog.getByRole('textbox', { name: tf.confirm.reasonLabel });
      await expect(reason).toBeVisible();
      await expect(dialog.getByTestId('stop-effect-ci')).toContainText('1 CI container destroyed');
      await expect(dialog.getByTestId('stop-effect-hosted')).toContainText('0');

      const confirm = dialog.getByRole('button', { name: tf.confirm.submit });
      // No reason — refused. Spaces are not a reason either.
      await expect(confirm).toBeDisabled();
      await reason.fill('   ');
      await expect(confirm).toBeDisabled();
      await beat();

      await reason.fill(STOP_REASON);
      await expect(confirm).toBeEnabled();
      await beat();
    },
  );

  await chapter(
    'Confirmed: the result on the card, the tiles at zero, the stop on record',
    async () => {
      const dialog = page.getByRole('alertdialog');
      await dialog.getByRole('button', { name: tf.confirm.submit }).click();

      // The result is rendered from the action's own response.
      const result = card.getByRole('status').filter({ hasText: tf.result.doneTitle });
      await expect(result).toBeVisible();
      await expect(result).toContainText('0 CI runs cancelled · 1 CI container destroyed');
      await expect(dialog).toHaveCount(0);

      // The re-read card: nothing running, and the stop shown back with its reason.
      await expect(card.getByText(tf.subtitleEmpty)).toBeVisible();
      await expect(card.getByTestId('org-fleet-tile-ciRunner')).toContainText('0');
      const last = card.getByTestId('org-fleet-last-stop');
      await expect(last).toContainText(STOP_REASON);
      await expect(last).toContainText(STAFF);
      await expect(card.getByRole('button', { name: tf.stop.button })).toBeDisabled();

      // Authoritative: no CI intent of Northwind's is still in flight.
      expect(await inFlightCi(northwind.organizationId)).toBe(0);
      await beat();
    },
  );

  await chapter('Back on the monitor: Halcyon untouched, still running and OK', async () => {
    await page.goto('/admin/monitoring');
    await expect(main.getByRole('heading', { name: fm.orgs.title })).toBeVisible();
    await fleetOrgs.scrollIntoViewIfNeeded();
    await expect(halcyonRow.getByText(fm.verdict.ok)).toBeVisible();
    await expect(halcyonRow.getByRole('cell').nth(2)).toHaveText('2 of 5');
    await expect(northwindRow).toHaveCount(0);
    await expect(fleetOrgs.getByText(fm.orgs.noMismatch)).toBeVisible();
    expect(await inFlightCi(halcyon.organizationId)).toBe(2);
    await beat();
  });
});
