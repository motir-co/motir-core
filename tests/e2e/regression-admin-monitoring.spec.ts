import { expect, test } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { resetBillingFixture, seedBillingOwner } from './_helpers/billing';
import enMessages from '@/messages/en.json';

/**
 * STORY MOTIR-736 (10.2) — the system-health board, walked end to end (MOTIR-7333).
 *
 * The board's three new readings come from the story's three E2E fakes, armed in
 * this lane's `webServer.env` (`playwright.acceptance.config.ts`): Errors reads a
 * fixed 24-hour count, Hosting a healthy two-group fleet on one release, Gateway a
 * reachable gateway. CI never calls Sentry, Fly or the gateway, and the failure
 * arms are proved against the real datastore by the story's integration gate
 * (`tests/platform/monitoringStoryGate.test.tsx`). Without the flags these cards
 * read `notConfigured` / `notManaged`, and every populated assertion below fails,
 * so the walk cannot pass vacuously.
 *
 *  1. THE DENIED PATH FIRST — a tenant owner gets the ordinary 404, and no board.
 *  2. THE OPERATOR — opens the console, clicks Operations → Monitoring, and the
 *     board shows the three new cards populated beside the four shipped ones.
 *
 * Every wait is the rendered card's own text inside the page's `main` landmark,
 * never a timeout.
 */

const mon = enMessages.platformAdmin.monitoring;
const nav = enMessages.platformAdmin.nav;
const menu = enMessages.shell.userMenu;

const OWNER = 'acceptance-monitoring-owner@example.com';

/** A message as a literal pattern. */
const literal = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

test('platform staff read the system-health board with its Errors, Hosting and Gateway cards; a tenant owner is denied', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-736');

  await resetDatabase();
  resetBillingFixture();
  await seedBillingOwner(page, OWNER);

  await chapter('The board does not exist for a tenant owner', async () => {
    const res = await page.goto('/admin/monitoring');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: mon.title, level: 1 })).toHaveCount(0);
    await beat();
  });

  // The owner is made platform staff; the gate reads a fresh row per request.
  await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'superadmin' } });

  await chapter('The operator opens Operations → Monitoring from the console', async () => {
    await page.goto('/workbench');
    await page.getByRole('button', { name: menu.account }).click();
    await page.getByRole('link', { name: literal(menu.platformAdmin) }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.getByRole('link', { name: nav.monitoring, exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/monitoring$/);
    await expect(page.getByRole('heading', { name: mon.title, level: 1 })).toBeVisible();
    await beat();
  });

  const board = page.getByRole('main');

  await chapter(
    'Errors: the last 24 hours from Motir’s own Sentry, under its threshold',
    async () => {
      await expect(board.getByText('7 errors · 24h', { exact: true })).toBeVisible();
      await expect(board.getByText(/Under the 100-error threshold/)).toBeVisible();
      await beat();
    },
  );

  await chapter('Hosting: every machine started in each group, all on one release', async () => {
    await expect(board.getByText('app 2/2 · worker 1/1', { exact: true })).toBeVisible();
    await expect(board.getByText(/all on release deployment-e2e/)).toBeVisible();
    await beat();
  });

  await chapter('Gateway: reachable, with its latency and version', async () => {
    // Scoped to the Gateway card, never the whole board: the Database card renders
    // the same `Reachable · {ms} ms` message from a REAL ping against CI Postgres,
    // so on the run where that ping also measures 42 ms a board-wide `getByText`
    // matches both cards and fails strict mode (MOTIR-7557).
    // The card is found by text that STARTS with its title: the title span carries
    // no role to scope on, and a page-rooted `getByText` is refused by the guard.
    const gateway = board
      .locator('[data-surface="card"]')
      .filter({ hasText: new RegExp(`^${mon.signal.gateway.title}`) });
    await expect(gateway.getByText('Reachable · 42 ms', { exact: true })).toBeVisible();
    await expect(gateway.getByText(/motir-gateway v0\.0\.0-e2e/)).toBeVisible();
    await beat();
  });

  await chapter(
    'The shipped cards are still on the board, and nothing on it remediates',
    async () => {
      const ids = [
        'database',
        'hosting',
        'gateway',
        'schedules',
        'failedJobs',
        'errors',
        'lastHealthCheck',
      ] as const;
      for (const id of ids) {
        await expect(board.getByText(mon.signal[id].title, { exact: true }).first()).toBeVisible();
      }
      // Read and link, never remediate: no replay, redeploy, restart or cancel.
      await expect(
        board.getByRole('button', { name: /replay|redeploy|restart|cancel|retry/i }),
      ).toHaveCount(0);
      await beat();
    },
  );
});
