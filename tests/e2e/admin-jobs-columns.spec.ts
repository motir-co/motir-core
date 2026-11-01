import { expect, test, type Locator, type Page } from '@playwright/test';
import { adminDb, db, resetDatabase, truncateJobTables } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { seedTenantOrg } from './_helpers/fleet-monitor-seed';
import enMessages from '@/messages/en.json';

/**
 * MOTIR-10055 — the /admin/jobs tables fit a laptop frame. At a 1280px viewport
 * with the admin sidebar open, the free-text column (Failure on Dead letters,
 * Event on Runs) gives up width and truncates, so each row's LAST column stays
 * inside the table's box: no Replay button cut to "Rep", no hidden sideways
 * scroll. Only a browser lays a table out, so this is an e2e spec and not a
 * render test.
 *
 * Every row is measured, the job worker's own rows included: they are narrower
 * than the seeded ones, so they can only pass.
 */

const jm = enMessages.platformAdmin.jobs;
const LAPTOP = { width: 1280, height: 800 };

/** A real-shaped Prisma failure — the long message that pushed Replay out. */
const LONG_FAILURE =
  'Invalid `prisma.workItem.findMany()` invocation in /app/lib/repositories/workItemRepository.ts:412:31 — ' +
  "Can't reach database server at `db.internal:5432`. Please make sure your database server is running.";
const LONG_FUNCTION = 'workspace.e2e-search-index-rebuild-after-bulk-import';

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobTables();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** The table's scroll container: TableShell's bordered `overflow-x-auto` box. */
function frameOf(page: Page): Locator {
  return page.getByRole('main').getByRole('table').locator('xpath=..');
}

async function expectInsideFrame(frame: Locator, target: Locator) {
  const box = await frame.boundingBox();
  const inner = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(inner).not.toBeNull();
  expect(inner!.x + inner!.width).toBeLessThanOrEqual(box!.x + box!.width);
}

async function expectNoSidewaysScroll(frame: Locator) {
  const { scroll, client } = await frame.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
}

test('at 1280px every Dead letters Replay button and every Runs row end inside the table', async ({
  page,
}) => {
  const email = 'e2e-admin-jobs-columns@example.com';
  await signUp(page, email);
  await db.user.update({ where: { email }, data: { platformRole: 'operator' } });

  const tenant = await seedTenantOrg('Northwind Labs', 'e2e-jobs-columns');
  const now = Date.now();
  await adminDb.jobRunDlq.createMany({
    data: Array.from({ length: 3 }, (_, i) => {
      const at = new Date(now - (i + 1) * 60_000);
      return {
        workspaceId: i === 0 ? null : tenant.workspaceId,
        functionId: LONG_FUNCTION,
        eventName: LONG_FUNCTION,
        eventData: { idempotencyKey: `e2e-columns-${i}` },
        failure: { message: `${LONG_FAILURE} (${i})` },
        attempts: 5,
        firstFailedAt: at,
        lastFailedAt: at,
      };
    }),
  });
  await adminDb.jobRun.create({
    data: {
      workspaceId: null,
      functionId: LONG_FUNCTION,
      eventName: `${LONG_FUNCTION}.requested-by-the-nightly-reindex-scheduler`,
      eventId: 'e2e-columns-run',
      lane: 'engine',
      attempt: 5,
      status: 'abandoned',
      startedAt: new Date(now - 10_000),
    },
  });

  await page.setViewportSize(LAPTOP);

  // ── Dead letters: the Failure text truncates, its full message in the title.
  expect((await page.goto('/admin/jobs?tab=dlq'))?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: jm.title, level: 1 })).toBeVisible();
  const replay = page
    .getByRole('main')
    .getByRole('button', { name: jm.replayAria.replace('{function}', LONG_FUNCTION) });
  await expect(replay).toHaveCount(3);
  await expect(page.getByRole('main').locator(`td[title="${LONG_FAILURE} (0)"]`)).toBeVisible();

  const dlqFrame = frameOf(page);
  await expectNoSidewaysScroll(dlqFrame);
  for (const button of await replay.all()) await expectInsideFrame(dlqFrame, button);

  // ── Runs: the same check on every row's last cell.
  expect((await page.goto('/admin/jobs'))?.status()).toBe(200);
  const runsFrame = frameOf(page);
  await expect(runsFrame.locator('tbody tr').filter({ hasText: LONG_FUNCTION })).toHaveCount(1);
  await expectNoSidewaysScroll(runsFrame);
  for (const lastCell of await runsFrame.locator('tbody tr td:last-child').all()) {
    await expectInsideFrame(runsFrame, lastCell);
  }
});
