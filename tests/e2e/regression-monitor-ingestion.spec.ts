import type { APIResponse, Page, Route } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { actionWrite, pageRefresh } from './_helpers/authoritative-signal';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';

// PRODUCTION ERRORS ARRIVE AS BUGS, WALKED IN A BROWSER (Story MOTIR-4929 ·
// Subtask MOTIR-5584) — the story's acceptance receipt, paced for a person to
// watch: an error arrives and becomes ONE bug in the Bugs folder, a recurrence
// files nothing new, the minimum level filters and lowering it picks the skipped
// error up, and a failed check says so on the row.
//
// ── ⚠️ WHAT IS FAKE, AND WHAT IS NOT ───────────────────────────────────────
// Sentry is the only thing replaced. `playwright.acceptance.config.ts` sets
// `MOTIR_MONITOR_FAKE_PROVIDER=1` on the spawned server, so the stored `sentry`
// discriminator resolves to the fake provider — and the fake's STATE lives in the
// SERVER process, which this spec cannot reach. So one `_test` door,
// `POST /api/_test/monitors/poll`, seeds the fake's issues (and one listing
// failure) in that process and runs a poll synchronously. Every Motir layer the
// poll reaches is real: the credential service, the reconcile, the bug
// destination resolver, the work-item create, the room's read.
//
// The SCHEDULED path (the half-hourly tick through the engine) is the vitest
// gate's (MOTIR-5583); this walk shows what a person sees.
//
// ⚠️ THE MOUNTING CHECK comes first: the `_test` door answers (a 404 for a
// binding that is not this workspace's, never the production gate's refusal of
// the whole route), then the connected grant names `fake-org` — the fake's
// organisation, which the real adapter cannot produce — and a poll through the
// door comes back `ok`. A lane that gated the door off or lost the fake switch
// fails there, instead of filming an empty folder as if it were the walk.
//
// ⚠️ NO REQUEST REACHES sentry.io: every browser request to it is recorded and
// aborted, and the last chapter asserts the record is empty.

const EMAIL = `monitor-ingestion-${Date.now()}@motir.test`;
const PASSWORD = 'Sup3rSecret!Pass';
const ROOM = '/settings/project/monitoring';
const INSTALL_HOST = 'sentry-install.e2e.invalid';
const ERROR_TITLE = 'TypeError: Cannot read properties of undefined (reading "total")';
const WARNING_TITLE = 'Slow checkout: payment provider took 9.2s';
const PERMALINK = 'https://fake.invalid/issues/checkout-total/';

let bugsFolderId = '';
let connectionId = '';
const sentryRequests: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetDatabase();
  const owner = await usersService.createUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Zhu Yue',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Storefront',
    identifier: 'STORE',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const row = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });
  bugsFolderId = row.bugDestinationFolderId ?? '';
});

/** Sentry's install-approval page, stood in exactly as `acceptance-monitoring`
 *  does (MOTIR-5264's fixture): the REAL start route is intercepted, its
 *  redirect checked and its state cookie kept, and Approve returns to Motir's
 *  real callback with the fake's grant code. */
async function standInSentry(page: Page): Promise<void> {
  await page.route('**/api/monitors/sentry/oauth/start**', async (route: Route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = new URL(response.headers()['location'] ?? '');
    expect(location.host).toBe(INSTALL_HOST);
    const callback = new URL('/api/monitors/sentry/oauth/callback', route.request().url());
    callback.searchParams.set('code', 'valid-code');
    callback.searchParams.set('installationId', 'inst-ingestion-1');
    callback.searchParams.set('state', location.searchParams.get('state') ?? '');
    const setCookie = response
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value)
      .join('\n');
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'set-cookie': setCookie },
      body: `<!doctype html><html><head><title>Sentry — Install Motir</title></head>
        <body style="font-family:system-ui;max-width:32rem;margin:4rem auto">
          <h1>Install Motir on fake-org</h1>
          <a href="${callback.toString()}">Approve</a>
        </body></html>`,
    });
  });
}

interface SeedIssue {
  externalId: string;
  title: string;
  level: string;
  eventCount: number;
  lastSeenAt: string;
  permalink?: string;
}

const issue = (
  externalId: string,
  title: string,
  level: string,
  eventCount: number,
  minutesFromNow: number,
  permalink?: string,
): SeedIssue => ({
  externalId,
  title,
  level,
  eventCount,
  lastSeenAt: new Date(Date.now() + minutesFromNow * 60_000).toISOString(),
  ...(permalink ? { permalink } : {}),
});

/** Seed the server-side fake and run ONE poll through the `_test` door. */
async function poll(
  page: Page,
  body: { issues?: SeedIssue[]; failNextListing?: { status: number; reason: string } } = {},
): Promise<{ status: string; filed: number; updated: number; skipped: number }> {
  const res: APIResponse = await page.request.post('/api/_test/monitors/poll', {
    data: {
      connectionId,
      ...body,
      issues: body.issues?.map((i) => ({
        ...i,
        culprit: 'app/checkout/page.tsx in render',
        firstSeenAt: new Date().toISOString(),
      })),
    },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as { status: string; filed: number; updated: number; skipped: number };
}

const tree = (page: Page) => page.getByRole('treegrid', { name: 'Work Items', exact: true });

/** Open /items and the Bugs folder, waiting on the expand's own write. */
async function openBugsFolder(page: Page) {
  await page.goto('/items');
  await expect(tree(page)).toBeVisible();
  const expand = actionWrite(page, '/items', bugsFolderId);
  await page.getByRole('button', { name: 'Expand folder Bugs', exact: true }).click();
  expect((await expand).status()).toBe(200);
}

/** The bug rows filed INSIDE the Bugs folder — level 2 under it. */
const bugRows = (page: Page) => tree(page).locator('[data-testid^="issue-row-"][aria-level="2"]');

/** The level control on the one monitored row, and a change through it. */
async function setLevel(page: Page, option: string) {
  await page.getByRole('combobox', { name: 'Minimum level' }).click();
  const written = page.waitForResponse(
    (res) => res.url().includes('/monitors/') && res.request().method() === 'PATCH',
  );
  const refreshed = pageRefresh(page, ROOM);
  await page.getByRole('option', { name: option, exact: true }).click();
  expect((await written).status()).toBe(200);
  await refreshed;
  await expect(page.getByRole('combobox', { name: 'Minimum level' })).toContainText(option);
}

test('a production error becomes ONE bug, recurrence files nothing, the level filters, and a failed check says so', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-4929');

  await page.route(/https?:\/\/([a-z0-9-]+\.)*sentry\.io\//, async (route) => {
    sentryRequests.push(route.request().url());
    await route.abort();
  });

  await chapter(
    'The Monitoring room, connected to Sentry, waiting for its first check',
    async () => {
      await signIn(page, EMAIL, PASSWORD);

      // ⚠️ THE MOUNTING CHECK, first: the door is MOUNTED — a binding that is not
      // this workspace's is its own 404 JSON, not the production gate's.
      const probe = await page.request.post('/api/_test/monitors/poll', {
        data: { connectionId: 'not-a-binding' },
      });
      expect(probe.status()).toBe(404);

      await standInSentry(page);
      await page.goto(ROOM);
      await page.getByRole('link', { name: 'Connect Sentry' }).click();
      await page.getByRole('link', { name: 'Approve' }).click();
      await page.waitForURL(`**${ROOM}?monitor=connected`);
      // The fake's organisation — the real adapter could not have produced it.
      await expect(page.getByRole('main')).toContainText('fake-org');

      const listed = page.waitForResponse(
        (res) => res.url().endsWith('/monitors/available') && res.request().method() === 'GET',
      );
      await page.getByRole('button', { name: 'Choose Sentry projects' }).click();
      expect((await listed).status()).toBe(200);
      const dialog = page.getByRole('dialog', { name: 'Choose Sentry projects' });
      await dialog.getByRole('checkbox', { name: /^web,/ }).click();
      const bound = page.waitForResponse(
        (res) => res.url().endsWith('/monitors') && res.request().method() === 'POST',
      );
      const refreshed = pageRefresh(page, ROOM);
      await dialog.getByRole('button', { name: 'Monitor 1 project' }).click();
      await bound;
      await refreshed;
      connectionId = (await adminDb.monitorConnection.findFirstOrThrow()).id;

      await expect(page.locator('[data-poll-state="waiting"]')).toHaveText(
        'Waiting for the first check',
      );
      // …and a poll through the door runs against the FAKE: `ok`, nothing yet.
      expect((await poll(page, { issues: [] })).status).toBe('ok');
      await beat();
    },
  );

  await chapter('An error arrives in Sentry, and ONE bug appears in the Bugs folder', async () => {
    const summary = await poll(page, {
      issues: [issue('checkout-total', ERROR_TITLE, 'error', 1, 1, PERMALINK)],
    });
    expect(summary).toMatchObject({ status: 'ok', filed: 1 });

    await openBugsFolder(page);
    await expect(bugRows(page)).toHaveCount(1);
    await expect(bugRows(page).first()).toContainText(ERROR_TITLE);
    await beat();

    // Open it: the thin body carries the link back to the issue.
    const bug = await adminDb.workItem.findFirstOrThrow({ where: { kind: 'bug' } });
    await page.goto(`/items/${bug.identifier}`);
    await expect(page.getByRole('link', { name: 'Open the issue' })).toHaveAttribute(
      'href',
      PERMALINK,
    );
    await beat();
  });

  await chapter('It happens again — the same bug, no second one', async () => {
    const summary = await poll(page, {
      issues: [issue('checkout-total', ERROR_TITLE, 'error', 14, 2, PERMALINK)],
    });
    expect(summary).toMatchObject({ status: 'ok', filed: 0, updated: 1 });

    await openBugsFolder(page);
    await expect(bugRows(page)).toHaveCount(1);
    await beat();

    await page.goto(ROOM);
    await expect(page.locator('[data-poll-state="ok"]')).toContainText('Checked for new errors');
    await beat();
  });

  await chapter('A minimum level of `error` keeps a warning off the board', async () => {
    await setLevel(page, 'error');
    await beat();
    const summary = await poll(page, {
      issues: [issue('checkout-slow', WARNING_TITLE, 'warning', 3, 3)],
    });
    expect(summary).toMatchObject({ status: 'ok', filed: 0, skipped: 1 });

    await openBugsFolder(page);
    await expect(bugRows(page)).toHaveCount(1);
    await expect(tree(page)).not.toContainText(WARNING_TITLE);
    await beat();
  });

  await chapter('Lowering it to every level picks the skipped warning up', async () => {
    await page.goto(ROOM);
    await setLevel(page, 'Every level');
    await beat();
    // The fake still holds the warning; the lowering rewound the watermark.
    const summary = await poll(page);
    expect(summary).toMatchObject({ status: 'ok', filed: 1 });

    await openBugsFolder(page);
    await expect(bugRows(page)).toHaveCount(2);
    await expect(tree(page)).toContainText(WARNING_TITLE);
    await beat();
  });

  await chapter('A check that fails says so on the row, in the provider’s words', async () => {
    const summary = await poll(page, {
      failNextListing: { status: 500, reason: 'Sentry returned 500: Internal Error.' },
    });
    expect(summary.status).toBe('failed');

    await page.goto(ROOM);
    const line = page.locator('[data-poll-state="failed"]');
    await expect(line).toContainText("Couldn't check for new errors:");
    await expect(line).toContainText('Sentry returned 500: Internal Error.');
    await beat();
  });

  await chapter('Nothing reached sentry.io', async () => {
    expect(sentryRequests).toEqual([]);
    await beat();
  });
});
