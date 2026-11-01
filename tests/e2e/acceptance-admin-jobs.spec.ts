import { test, expect } from './_helpers/acceptance-video';
import { adminDb, resetDatabase, truncateJobTables } from './_helpers/db-reset';
import { signUpToOnboarding } from './_helpers/shell-session';
import { seedTenantOrg } from './_helpers/fleet-monitor-seed';
import enMessages from '@/messages/en.json';

/**
 * STORY MOTIR-9980 — platform staff work the whole job ledger at /admin/jobs,
 * walked as the story's acceptance receipt (MOTIR-9989).
 *
 * One signed-up account is walked up the platform ladder; the page gate reads a
 * fresh row per request, so no re-login is needed between chapters.
 *
 *  1. THE DENIED PATH FIRST — no platform role, the ordinary 404 and no page.
 *  2. SUPPORT — Operations → Jobs; the Runs tab with a workspace run and a
 *     workspace-less one, the status filter; the Dead letters tab with both kinds
 *     of row, the Function filter's counts, and 109 rate-limit-sweep rows older
 *     than the newest 250 of other functions all reachable once it is chosen. No
 *     replay control, only the Read-only notice.
 *  3. OPERATOR — one workspace-less row and one workspace row replayed, each
 *     waited on through the action's response; then Replay all for the function,
 *     with one row stamped replayed behind the page's back first.
 *  4. THE AUDIT LOG — one `jobs.dlq_replay` row per dead letter replayed through
 *     the page, naming the actor, and none for the row stamped behind its back.
 *
 * The service edge cases (refusals below operator, batch sizing, a row that
 * throws) are the integration gate's (`tests/integration/platformJobsLedger.test.ts`).
 * Every wait is a response or rendered text; there is no timer.
 *
 * ⚠️ THE LANE'S JOB WORKER RUNS THROUGHOUT, and this page shows EVERYTHING it
 * writes: the scheduler's catch-up runs land on the Runs tab, and the ones that
 * fail in CI (`system.daily-health-check`, `system.platform-meter-report`)
 * dead-letter while the spec runs. So no assertion counts the whole ledger: each
 * reads the seeded rows by a function id the worker never writes, or a count
 * narrowed to one such function. The replayed function is a REAL job,
 * `system.rate-limit-sweep`, because a replay enqueues a run the worker executes
 * at once: an unknown id would fail three times and dead-letter again mid-chapter,
 * and the sweep succeeds and touches only expired counters.
 */

const shell = enMessages.platformAdmin.shell;
const jm = enMessages.platformAdmin.jobs;
const audit = enMessages.platformAdmin.audit;

const STAFF = 'acceptance-jobs-staff@example.com';

/** The replayed function. A real, harmless job: see the header. */
const SWEEP = 'system.rate-limit-sweep';
const ROLLUP = 'system.e2e-usage-rollup';
const INDEX = 'workspace.e2e-search-index';
/** The two seeded runs, under ids the worker never runs. */
const RUN_TENANT = 'workspace.e2e-ledger-export';
const RUN_SYSTEM = 'system.e2e-ledger-report';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const WIDE = { width: 1440, height: 810 };

/** A message with `{name}` placeholders filled. */
const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));

async function seedLedger(workspaceId: string) {
  const now = Date.now();
  await adminDb.jobRun.createMany({
    data: [
      {
        workspaceId,
        functionId: RUN_TENANT,
        eventName: RUN_TENANT,
        eventId: 'e2e-jobs-run-1',
        lane: 'engine',
        attempt: 1,
        status: 'succeeded',
        startedAt: new Date(now - 30 * MIN),
        finishedAt: new Date(now - 30 * MIN + 1200),
        durationMs: 1200,
      },
      {
        workspaceId: null,
        functionId: RUN_SYSTEM,
        eventName: RUN_SYSTEM,
        eventId: 'e2e-jobs-run-2',
        lane: 'engine',
        attempt: 5,
        status: 'failed',
        startedAt: new Date(now - 20 * MIN),
        finishedAt: new Date(now - 20 * MIN + 800),
        durationMs: 800,
        failure: { message: 'MOTIR_AI_UNAVAILABLE' },
      },
    ],
  });

  const dlq = (
    functionId: string,
    i: number,
    lastFailedAgoMs: number,
    rowWorkspace: string | null,
  ) => {
    const at = new Date(now - lastFailedAgoMs);
    return {
      workspaceId: rowWorkspace,
      functionId,
      eventName: functionId,
      eventData: { idempotencyKey: `e2e-${functionId}-${i}` },
      // Zero-padded, so no message is a substring of another: a row is found by its text.
      failure: { message: `boom ${String(i).padStart(3, '0')}` },
      attempts: 5,
      firstFailedAt: at,
      lastFailedAt: at,
    };
  };
  await adminDb.jobRunDlq.createMany({
    data: [
      // 109 sweeps, all OLDER than the 250 rows below: past the newest 200.
      ...Array.from({ length: 109 }, (_, i) =>
        dlq(SWEEP, i, 2 * DAY + i * MIN, i % 10 === 0 ? workspaceId : null),
      ),
      ...Array.from({ length: 150 }, (_, i) => dlq(INDEX, i, (i + 1) * MIN, workspaceId)),
      ...Array.from({ length: 100 }, (_, i) => dlq(ROLLUP, i, (i + 1) * MIN + 30_000, null)),
    ],
  });
}

test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobTables();
});

test('platform staff read the whole job ledger, and an operator replays one row, another, then a whole function', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9980');
  // Ten chapters, and Replay all writes one transaction and one audit row per
  // dead letter while the worker runs each replayed sweep: about two minutes
  // of the walk in CI, against the lane's 90s default.
  test.setTimeout(300_000);

  const tenant = await seedTenantOrg('Northwind Labs', 'e2e-jobs-northwind');
  await seedLedger(tenant.workspaceId);

  await page.setViewportSize(WIDE);
  await signUpToOnboarding(page, STAFF);

  const main = page.getByRole('main');
  const table = main.getByRole('table');
  const bodyRows = table.locator('tbody tr');
  const fnFilter = main.getByRole('combobox', { name: jm.fn.label });
  const waitingLine = (waiting: number, replayed: number) =>
    main.getByText(fill(jm.waitingLine, { waiting, replayed }), { exact: true });

  await chapter('The ledger does not exist for an account with no platform role', async () => {
    const res = await page.goto('/admin/jobs');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: jm.title, level: 1 })).toHaveCount(0);
    await beat();
  });

  await adminDb.user.update({ where: { email: STAFF }, data: { platformRole: 'support' } });

  await chapter(
    'Support opens Operations → Jobs: every run, in a workspace and in none',
    async () => {
      expect((await page.goto('/admin'))?.status()).toBe(200);
      // The worker's runs are newer than the seeded ones and the Runs tab pages
      // at 50, newest first: move the two seeded runs to now, so they lead the
      // page. Right before the click, and a second or two back at most: the
      // scheduler writes about six runs every ten seconds, so a minute's lead
      // (stamped before /admin loaded) was enough to push them off the page.
      for (const [eventId, agoMs] of [
        ['e2e-jobs-run-1', 2_000],
        ['e2e-jobs-run-2', 1_000],
      ] as const) {
        const startedAt = new Date(Date.now() - agoMs);
        await adminDb.jobRun.updateMany({
          where: { eventId },
          data: { startedAt, finishedAt: new Date(startedAt.getTime() + 1000) },
        });
      }
      const row = page.getByRole('link', { name: shell.navJobs, exact: true });
      await row.click();
      await expect(page).toHaveURL(/\/admin\/jobs$/);
      await expect(page.getByRole('heading', { name: jm.title, level: 1 })).toBeVisible();
      await expect(row).toHaveAttribute('aria-current', 'page');

      await expect(bodyRows.filter({ hasText: RUN_TENANT })).toContainText(tenant.workspaceId);
      await expect(bodyRows.filter({ hasText: RUN_SYSTEM })).toContainText(jm.noWorkspace);

      // The page view went through the console layout, which audits it.
      const staff = await adminDb.user.findUniqueOrThrow({ where: { email: STAFF } });
      expect(
        await adminDb.platformAuditLog.count({
          where: { action: 'console.open', actorUserId: staff.id },
        }),
      ).toBeGreaterThan(0);
      await beat();
    },
  );

  await chapter('The status filter narrows the runs', async () => {
    await main
      .getByRole('group', { name: jm.status.label })
      .getByRole('link', { name: jm.status.failed })
      .click();
    await expect(page).toHaveURL(/status=failed/);
    await expect(bodyRows.filter({ hasText: RUN_SYSTEM })).toHaveCount(1);
    await expect(bodyRows.filter({ hasText: RUN_TENANT })).toHaveCount(0);
    await beat();
  });

  await chapter('Dead letters: both kinds of row, read-only for support', async () => {
    await page.getByRole('tab', { name: new RegExp(`^${jm.tabs.dlq}`) }).click();
    await expect(page).toHaveURL(/tab=dlq/);
    await expect(main.getByRole('note')).toHaveText(jm.readOnly);
    // The newest 200 waiting rows: none of them a sweep, which are all older.
    await expect(bodyRows).toHaveCount(200);
    await expect(bodyRows.filter({ hasText: INDEX }).first()).toBeVisible();
    await expect(bodyRows.filter({ hasText: SWEEP })).toHaveCount(0);
    await expect(bodyRows.filter({ hasText: jm.noWorkspace }).first()).toBeVisible();
    await expect(bodyRows.filter({ hasText: tenant.workspaceId }).first()).toBeVisible();
    await expect(main.getByRole('button', { name: /^Replay/ })).toHaveCount(0);
    await beat();
  });

  await chapter(
    'The Function filter: only functions with dead letters waiting, with their counts',
    async () => {
      await fnFilter.click();
      const option = (fn: string) => page.getByRole('option').filter({ hasText: fn });
      await expect(page.getByRole('option').first()).toContainText(jm.fn.all);
      await expect(option(INDEX)).toContainText('150');
      await expect(option(SWEEP)).toContainText('109');
      await expect(option(ROLLUP)).toContainText('100');
      await beat();
      await option(SWEEP).click();
      await expect(page).toHaveURL((url) => url.searchParams.get('fn') === SWEEP);
      // All 109, though every one is older than the newest 200 overall.
      await expect(bodyRows).toHaveCount(109);
      await expect(waitingLine(109, 0)).toBeVisible();
      await expect(main.getByRole('button', { name: /^Replay/ })).toHaveCount(0);
      await expect(main.getByRole('note')).toHaveText(jm.readOnly);
      await beat();
    },
  );

  await adminDb.user.update({ where: { email: STAFF }, data: { platformRole: 'operator' } });

  const replayed: string[] = [];
  const replayRow = async (rowText: string) => {
    const row = bodyRows.filter({ hasText: rowText }).filter({
      has: page.getByRole('button', { name: fill(jm.replayAria, { function: SWEEP }) }),
    });
    const target = row.first();
    const failure = (await target.getByRole('cell').nth(2).innerText()).trim();
    const entry = await adminDb.jobRunDlq.findFirstOrThrow({
      where: { functionId: SWEEP, failure: { equals: { message: failure } } },
    });
    const response = page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().includes('/admin/jobs'),
    );
    await target.getByRole('button', { name: fill(jm.replayAria, { function: SWEEP }) }).click();
    expect((await response).status()).toBe(200);
    replayed.push(entry.id);
    return failure;
  };

  await chapter('The operator replays a workspace-less dead letter', async () => {
    await page.reload();
    await expect(main.getByRole('note')).toHaveCount(0);
    await expect(
      main.getByRole('button', { name: fill(jm.replayAll.button, { count: 109 }) }),
    ).toBeVisible();
    const failure = await replayRow(jm.noWorkspace);
    await expect(waitingLine(108, 1)).toBeVisible();
    const row = bodyRows.filter({ hasText: failure });
    await expect(row).toContainText(fill(jm.replayedAt, { time: '' }).trim());
    await beat();
  });

  await chapter('…and one that belongs to a workspace', async () => {
    const failure = await replayRow(tenant.workspaceId);
    await expect(waitingLine(107, 2)).toBeVisible();
    await expect(bodyRows.filter({ hasText: failure })).toContainText(
      fill(jm.replayedAt, { time: '' }).trim(),
    );
    await beat();
  });

  let stamped = '';
  await chapter('Replay all: the confirm names the count and the function', async () => {
    await main.getByRole('button', { name: fill(jm.replayAll.button, { count: 107 }) }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(
      dialog.getByText(fill(jm.replayAll.title, { count: 107, function: SWEEP })),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: jm.replayAll.cancel })).toBeFocused();
    // Someone else replays one of them while the confirm is open.
    const other = await adminDb.jobRunDlq.findFirstOrThrow({
      where: { functionId: SWEEP, replayedAt: null },
      orderBy: { lastFailedAt: 'asc' },
    });
    await adminDb.jobRunDlq.update({ where: { id: other.id }, data: { replayedAt: new Date() } });
    stamped = other.id;
    await beat();
  });

  await chapter('…runs, then reports what it replayed', async () => {
    const dialog = page.getByRole('alertdialog');
    const response = page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().includes('/admin/jobs'),
    );
    await dialog.getByRole('button', { name: fill(jm.replayAll.confirm, { count: 107 }) }).click();
    expect((await response).status()).toBe(200);
    await expect(dialog.getByText(jm.replayAll.doneTitle, { exact: true })).toBeVisible();
    // The stamped row is skipped: the action enumerates only what still waits.
    await expect(dialog.getByRole('listitem')).toHaveText([
      fill(jm.replayAll.replayed, { count: 106 }),
    ]);
    await beat();
    await dialog.getByRole('button', { name: jm.replayAll.close }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    // Nothing of the function waits, so it leaves the filter and the page is back
    // on All functions.
    await expect(fnFilter).toContainText(jm.fn.all);
    await fnFilter.click();
    await expect(page.getByRole('option').filter({ hasText: SWEEP })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await beat();
  });

  await adminDb.user.update({ where: { email: STAFF }, data: { platformRole: 'superadmin' } });

  await chapter(
    'The audit log holds one replay row per dead letter the page replayed',
    async () => {
      const staff = await adminDb.user.findUniqueOrThrow({ where: { email: STAFF } });
      const entries = await adminDb.platformAuditLog.findMany({
        where: { action: 'jobs.dlq_replay' },
        select: { actorUserId: true, targetId: true },
      });
      const bulk = await adminDb.jobRunDlq.findMany({
        where: { functionId: SWEEP, id: { notIn: [...replayed, stamped] } },
        select: { id: true },
      });
      expect(entries).toHaveLength(108);
      expect(entries.every((e) => e.actorUserId === staff.id)).toBe(true);
      expect(new Set(entries.map((e) => e.targetId))).toEqual(
        new Set([...replayed, ...bulk.map((b) => b.id)]),
      );
      expect(entries.some((e) => e.targetId === stamped)).toBe(false);

      await page.goto('/admin/audit-log?action=jobs.dlq_replay');
      await expect(page.getByRole('heading', { name: audit.title, level: 1 })).toBeVisible();
      const rows = main.getByTestId('audit-table').locator('[data-testid^="audit-row-"]');
      await expect(rows.first()).toContainText('jobs.dlq_replay');
      await expect(rows.first()).toContainText(STAFF);
      await expect(rows.first()).toContainText(SWEEP);
      await beat();
    },
  );
});
