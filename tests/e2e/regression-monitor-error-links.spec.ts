import type { APIResponse, Page, Route } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { actionWrite, pageRefresh } from './_helpers/authoritative-signal';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

// THE ERROR IS LEGIBLE ON THE CARD, WALKED IN A BROWSER (Story MOTIR-4932 ·
// Subtask MOTIR-5734) — the story's acceptance receipt, paced for a person to
// watch: a monitor-filed bug shows its error, a customer-reported card links the
// same fault by search and MOVE, a second error joins it, one is unlinked, a
// failing connection is named in the picker, and a reader without edit rights
// sees the rows and no doors.
//
// ── ⚠️ WHAT THIS LANE CAN OBSERVE ───────────────────────────────────────────
// Sentry is the only thing replaced, by the fake provider
// (`MOTIR_MONITOR_FAKE_PROVIDER=1`). The poll and every link action run in the
// SERVER process, whose fake this spec reaches through two `_test` doors:
// `monitors/poll` (seed + one poll) and `monitors/fake` (seed WITHOUT a poll, arm
// one project's search to fail, and read back every provider call). So "opening
// the page asked the monitor nothing" is a MEASUREMENT here: the call record is
// cleared, the page is opened, and the record is read back empty.
//
// ⚠️ NO REQUEST REACHES sentry.io: every browser request to it is recorded and
// aborted, and the last chapter asserts the record is empty.

const STAMP = Date.now();
const EMAIL = `monitor-links-${STAMP}@motir.test`;
const READER_EMAIL = `reader-${STAMP}@motir.test`;
const PASSWORD = 'Sup3rSecret!Pass';
const ROOM = '/settings/project/monitoring';
const INSTALL_HOST = 'sentry-install.e2e.invalid';
const FIRST = 'TypeError: Cannot read properties of undefined (reading "total")';
const SECOND = 'RangeError: Invalid time value in formatDate';

let webConnectionId = '';
let ordinary = { id: '', identifier: '' };
let reported = { id: '', identifier: '' };
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
  const ctx = { userId: owner.id, workspaceId: workspace.id };
  // An ordinary card no monitor touched, and the bug a CUSTOMER reported — the
  // card that already exists when the monitor catches the same fault.
  const task = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'Tidy the checkout copy' },
    ctx,
  );
  const bug = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'bug', title: 'Customer: checkout crashes on the total' },
    ctx,
  );
  ordinary = { id: task.id, identifier: task.identifier };
  reported = { id: bug.id, identifier: bug.identifier };

  // A reader who can SEE the card and cannot edit it — a CUSTOM role holding
  // item-read only, never a built-in one.
  const reader = await usersService.createUser({
    email: READER_EMAIL,
    password: PASSWORD,
    name: 'Grace Hopper',
  });
  await workspacesService.addMember({ userId: reader.id, workspaceId: workspace.id });
  // Roles live on the workspace since MOTIR-6168: the custom role is a
  // WORKSPACE custom role, held on the workspace membership at the member tier.
  const definition = await adminDb.workspaceRoleDefinition.create({
    data: {
      workspaceId: workspace.id,
      name: 'Reader',
      permissions: ['project:browse'],
    },
  });
  await adminDb.projectMembership.upsert({
    where: { userId_projectId: { userId: reader.id, projectId: project.id } },
    create: {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: reader.id,
    },
    update: {},
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: reader.id, workspaceId: workspace.id } },
    data: {
      activeProjectId: project.id,
      workspaceRole: 'member',
      roleDefinitionId: definition.id,
    },
  });
});

/** Sentry's install-approval page, stood in exactly as the ingestion walk does. */
async function standInSentry(page: Page): Promise<void> {
  await page.route('**/api/monitors/sentry/oauth/start**', async (route: Route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = new URL(response.headers()['location'] ?? '');
    expect(location.host).toBe(INSTALL_HOST);
    const callback = new URL('/api/monitors/sentry/oauth/callback', route.request().url());
    callback.searchParams.set('code', 'valid-code');
    callback.searchParams.set('installationId', 'inst-links-1');
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

/** The two fake issues — one per monitored project. */
function issues() {
  const now = new Date().toISOString();
  return [
    {
      externalId: 'first',
      title: FIRST,
      level: 'error',
      eventCount: 40_112,
      culprit: 'app/checkout/page.tsx in render',
      firstSeenAt: new Date(STAMP).toISOString(),
      lastSeenAt: now,
      permalink: 'https://fake-org.sentry.invalid/issues/first/',
      environment: 'production',
      release: '2026.09.19-1',
      shortId: 'WEB-1A',
      externalProjectId: 'fake-web',
    },
    {
      externalId: 'second',
      title: SECOND,
      level: 'warning',
      eventCount: 4,
      culprit: 'lib/dates.ts in formatDate',
      firstSeenAt: new Date(STAMP).toISOString(),
      lastSeenAt: now,
      permalink: 'https://fake-org.sentry.invalid/issues/second/',
      environment: 'staging',
      release: '2026.09.18-3',
      shortId: 'WORKER-2B',
      externalProjectId: 'fake-worker',
    },
  ];
}

/** Seed the server's fake and/or open a fresh "no provider call" window. */
async function fake(page: Page, data: Record<string, unknown>): Promise<string[]> {
  const res: APIResponse = await page.request.post('/api/_test/monitors/fake', { data });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { calls: string[] }).calls;
}
async function fakeCalls(page: Page): Promise<string[]> {
  const res = await page.request.get('/api/_test/monitors/fake');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { calls: string[] }).calls;
}

const errorsHeading = (page: Page) => page.getByRole('heading', { name: 'Errors', exact: true });
// Scoped to the LIVE page, never page-rooted (MOTIR-5037's guard).
const rows = (page: Page) => page.getByRole('main').getByTestId('error-row');
const itemPath = (identifier: string) => `/items/${identifier}`;

/** The link id of one issue on one card, from the store. */
async function linkOf(externalIssueId: string) {
  return adminDb.monitorIssue.findFirst({ where: { externalIssueId } });
}

async function searchAndPick(page: Page, query: string, title: string) {
  const path = itemPath(reported.identifier);
  await page.getByRole('combobox', { name: 'Error to link' }).click();
  const searched = actionWrite(page, path, query);
  await page.getByRole('combobox', { name: /Search errors/ }).fill(query);
  await searched;
  await page.getByRole('option', { name: new RegExp(escape(title)) }).click();
}
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('a monitor-filed bug shows its error, a customer-reported card links the same fault by search and move, and unlinks it again', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-4932');
  test.setTimeout(300_000);

  await page.route(/https?:\/\/([a-z0-9-]+\.)*sentry\.io\//, async (route) => {
    sentryRequests.push(route.request().url());
    await route.abort();
  });

  let monitorBug = { id: '', identifier: '' };

  await chapter('Sentry is connected for two projects, and an error arrives as a bug', async () => {
    await signIn(page, EMAIL, PASSWORD);
    await standInSentry(page);
    await page.goto(ROOM);
    await page.getByRole('link', { name: 'Connect Sentry' }).click();
    await page.getByRole('link', { name: 'Approve' }).click();
    await page.waitForURL(`**${ROOM}?monitor=connected`);

    const listed = page.waitForResponse(
      (res) => res.url().endsWith('/monitors/available') && res.request().method() === 'GET',
    );
    await page.getByRole('button', { name: 'Choose Sentry projects' }).click();
    expect((await listed).status()).toBe(200);
    const dialog = page.getByRole('dialog', { name: 'Choose Sentry projects' });
    await dialog.getByRole('checkbox', { name: /^web,/ }).click();
    await dialog.getByRole('checkbox', { name: /^worker,/ }).click();
    const bound = page.waitForResponse(
      (res) => res.url().endsWith('/monitors') && res.request().method() === 'POST',
    );
    const refreshed = pageRefresh(page, ROOM);
    await dialog.getByRole('button', { name: 'Monitor 2 projects' }).click();
    await bound;
    await refreshed;
    webConnectionId = (
      await adminDb.monitorConnection.findFirstOrThrow({ where: { externalProjectId: 'fake-web' } })
    ).id;

    // ONE poll of the web project files the first issue as a bug. The second
    // issue is seeded in the fake but no poll files it — the customer-reported
    // card is where it will end up.
    const res = await page.request.post('/api/_test/monitors/poll', {
      data: { connectionId: webConnectionId, issues: [issues()[0]] },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', filed: 1 });
    await fake(page, { issues: issues() });
    const link = await linkOf('first');
    const bug = await adminDb.workItem.findUniqueOrThrow({ where: { id: link!.workItemId! } });
    monitorBug = { id: bug.id, identifier: bug.identifier };
    await beat();
  });

  await chapter(
    '1 · The error is legible on the monitor-filed bug — and the page asked Sentry nothing',
    async () => {
      expect(await fake(page, { clearCalls: true })).toEqual([]);
      await page.goto(itemPath(monitorBug.identifier));
      await expect(errorsHeading(page)).toBeVisible();
      await expect(rows(page)).toHaveCount(1);
      const row = rows(page).first();
      await expect(row.getByRole('link', { name: FIRST })).toHaveAttribute(
        'href',
        'https://fake-org.sentry.invalid/issues/first/',
      );
      await expect(row).toContainText('fake-org / web · production · 2026.09.19-1');
      await expect(row.getByTestId('error-level')).toHaveText('error');
      await expect(row.getByTestId('error-count')).toHaveText('40,112');
      await expect(row).toContainText('last seen');
      // A NEGATIVE needs a window, not a moment: read the record only once the page
      // has stopped making requests, so a debounced fetch cannot land after it.
      await page.waitForLoadState('networkidle');
      expect(await fakeCalls(page)).toEqual([]);
      await beat();
    },
  );

  await chapter('2 · A card no monitor touched is unchanged', async () => {
    await page.goto(itemPath(ordinary.identifier));
    await expect(page.getByRole('heading', { name: 'Development', exact: true })).toBeVisible();
    await expect(errorsHeading(page)).toHaveCount(0);
  });

  await chapter(
    '3 · The customer-reported bug links the second error from its ⋯ menu',
    async () => {
      await page.goto(itemPath(reported.identifier));
      await expect(page.getByRole('heading', { name: 'Development', exact: true })).toBeVisible();
      await expect(errorsHeading(page)).toHaveCount(0);
      await beat();

      await page.getByRole('button', { name: `Actions for ${reported.identifier}` }).click();
      await page.getByRole('menuitem', { name: 'Link an error' }).click();
      await expect(errorsHeading(page)).toBeVisible();
      await expect(
        page.getByRole('main').getByText('No errors linked to this work item yet.'),
      ).toBeVisible();
      await beat();

      await searchAndPick(page, 'formatDate', SECOND);
      await beat();
      const linked = actionWrite(page, itemPath(reported.identifier), 'second');
      const refreshed = pageRefresh(page, itemPath(reported.identifier));
      await page.getByRole('button', { name: 'Link', exact: true }).click();
      expect((await linked).status()).toBe(200);
      await refreshed;
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).first()).toContainText(SECOND);
      await expect(rows(page).first()).toContainText('fake-org / worker · staging');
      await beat();
    },
  );

  await chapter(
    '4 · The same fault the monitor filed: refused by name, then moved on purpose',
    async () => {
      await page.getByRole('button', { name: 'Link error' }).click();
      await searchAndPick(page, 'Cannot read', FIRST);
      await page.getByRole('button', { name: 'Link', exact: true }).click();
      const confirm = page.getByRole('dialog').getByTestId('move-confirm');
      await expect(confirm).toContainText(
        `Move this error's link from ${monitorBug.identifier} to this work item?`,
      );
      await expect(confirm.getByRole('link', { name: monitorBug.identifier })).toHaveAttribute(
        'href',
        itemPath(monitorBug.identifier),
      );
      await beat();

      // Cancel first — both cards are exactly as they were.
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(confirm).toHaveCount(0);
      expect((await linkOf('first'))?.workItemId).toBe(monitorBug.id);

      // Then move it, on purpose.
      await page.getByRole('button', { name: 'Link', exact: true }).click();
      await expect(confirm).toBeVisible();
      await beat();
      const moved = actionWrite(page, itemPath(reported.identifier), 'first');
      const refreshed = pageRefresh(page, itemPath(reported.identifier));
      await confirm.getByRole('button', { name: 'Move link' }).click();
      expect((await moved).status()).toBe(200);
      await refreshed;
      await expect(rows(page)).toHaveCount(2);
      expect((await linkOf('first'))?.workItemId).toBe(reported.id);
      await beat();
    },
  );

  await chapter('5 · Two errors on one card, the busier first by last seen', async () => {
    await expect(rows(page).nth(0)).toContainText(/TypeError|RangeError/);
    await expect(rows(page).filter({ hasText: FIRST }).getByTestId('error-count')).toHaveText(
      '40,112',
    );
    await expect(rows(page).filter({ hasText: SECOND }).getByTestId('error-count')).toHaveText('4');
    await beat();

    // The monitor-filed bug no longer holds it.
    await page.goto(itemPath(monitorBug.identifier));
    await expect(page.getByRole('heading', { name: 'Development', exact: true })).toBeVisible();
    await expect(errorsHeading(page)).toHaveCount(0);
    await page.goto(itemPath(reported.identifier));
    await expect(rows(page)).toHaveCount(2);
  });

  await chapter('6 · Unlinking says what happens next', async () => {
    await rows(page)
      .filter({ hasText: SECOND })
      .getByRole('button', { name: `Remove the link to ${SECOND}` })
      .click();
    await expect(
      page
        .getByRole('dialog')
        .getByText('If this error happens again, a new bug will be filed for it.', {
          exact: false,
        }),
    ).toBeVisible();
    await beat();
    const removed = actionWrite(page, itemPath(reported.identifier), (await linkOf('second'))!.id);
    const refreshed = pageRefresh(page, itemPath(reported.identifier));
    await page.getByRole('button', { name: 'Remove link' }).click();
    expect((await removed).status()).toBe(200);
    await refreshed;
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(FIRST);
    expect(await linkOf('second')).toBeNull();
    await beat();
  });

  await chapter('7 · A connection whose search fails is named in the picker', async () => {
    await fake(page, {
      failSearchForProject: {
        externalProjectId: 'fake-worker',
        status: 503,
        reason: 'Sentry is temporarily unavailable',
      },
    });
    await page.getByRole('button', { name: 'Link error' }).click();
    await page.getByRole('combobox', { name: 'Error to link' }).click();
    await expect(page.getByRole('note')).toHaveText(
      "Couldn't search fake-org / worker: Sentry is temporarily unavailable",
    );
    await expect(page.getByRole('option', { name: new RegExp(escape(FIRST)) })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await fake(page, { failSearchForProject: null });
  });

  await chapter('8 · A reader without edit rights sees the rows and no doors', async () => {
    await page.context().clearCookies();
    await signIn(page, READER_EMAIL, PASSWORD);
    await page.goto(itemPath(reported.identifier));
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Link error' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Remove the link to ${FIRST}` })).toHaveCount(0);
  });

  await chapter('Nothing reached sentry.io', async () => {
    expect(sentryRequests).toEqual([]);
  });
});
