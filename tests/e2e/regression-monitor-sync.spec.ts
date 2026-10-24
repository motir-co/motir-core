import type { APIResponse, Page, Route } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { actionWrite, pageRefresh } from './_helpers/authoritative-signal';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';

// FIXING THE BUG CLOSES THE ERROR, WALKED IN A BROWSER (Story MOTIR-4931 ·
// Subtask MOTIR-5709) — the story's acceptance receipt, paced for a person to
// watch: completing a monitor-filed bug resolves its issue, the next check changes
// nothing, turning the switch off stops the next resolve, an assignment made in
// the monitor arrives on the bug, and a failed resolve is named on the row.
//
// ── ⚠️ WHAT THIS LANE CAN AND CANNOT OBSERVE ───────────────────────────────
// Sentry is the only thing replaced, by the fake provider
// (`MOTIR_MONITOR_FAKE_PROVIDER=1`). The POLL runs in the SERVER process through
// the `_test/monitors/poll` door, and the fake it reads is seeded there. The
// RESOLVE-BACK is a JOB, so it runs in the lane's WORKER — a third process, with
// its OWN fake instance, which this spec cannot reach. So this walk:
//   · does NOT count provider calls, and does NOT drive the failure mechanism —
//     both are the vitest gate's (MOTIR-5708), which asserts them exactly;
//   · DOES assert what the job leaves behind (each link's resolve state, read
//     through `_test/monitors/resolve-state`), and waits on the job's OWN run
//     reaching a terminal state (`_test/monitors/resolve-run`) — never a sleep.
//
// ⚠️ THE WORKER-PROCESS PREMISE is checked in the first completion chapter: the
// worker must have REGISTERED `monitor-issue-resolve` and must resolve against the
// FAKE. `playwright.acceptance.config.ts` mirrors the fake switch and the token
// key into the worker (`monitorFakeEnv` in `_helpers/job-worker-process.ts`);
// without them the run dead-letters and the link never reads `resolved`.
//
// ⚠️ NO REQUEST REACHES sentry.io: every browser request to it is recorded and
// aborted, and the last chapter asserts the record is empty.

const STAMP = Date.now();
const EMAIL = `monitor-sync-${STAMP}@motir.test`;
const MEMBER_EMAIL = `ada-${STAMP}@motir.test`;
const MEMBER_NAME = 'Ada Lovelace';
const PASSWORD = 'Sup3rSecret!Pass';
const ROOM = '/settings/project/monitoring';
const INSTALL_HOST = 'sentry-install.e2e.invalid';
const RESOLVE = 'Resolve in Sentry when the bug is done';
const FIRST = 'TypeError: Cannot read properties of undefined (reading "total")';
const SECOND = 'RangeError: Invalid time value in formatDate';
const THIRD = 'Error: Payment intent already confirmed';

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
  // The person Sentry will name as the assignee — a member here, by email.
  const member = await usersService.createUser({
    email: MEMBER_EMAIL,
    password: PASSWORD,
    name: MEMBER_NAME,
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
  const row = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });
  bugsFolderId = row.bugDestinationFolderId ?? '';
});

/** Sentry's install-approval page, stood in exactly as the ingestion walk does. */
async function standInSentry(page: Page): Promise<void> {
  await page.route('**/api/monitors/sentry/oauth/start**', async (route: Route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = new URL(response.headers()['location'] ?? '');
    expect(location.host).toBe(INSTALL_HOST);
    const callback = new URL('/api/monitors/sentry/oauth/callback', route.request().url());
    callback.searchParams.set('code', 'valid-code');
    callback.searchParams.set('installationId', 'inst-sync-1');
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
  lastSeenAt: string;
  assignee?: { kind: 'user'; externalId: string; email: string; name: string };
}

/** Seed the server-side fake and run ONE poll through the `_test` door. */
async function poll(
  page: Page,
  issues: SeedIssue[],
): Promise<{ status: string; filed: number; updated: number; refiled: number }> {
  const res: APIResponse = await page.request.post('/api/_test/monitors/poll', {
    data: {
      connectionId,
      issues: issues.map((i) => ({
        ...i,
        level: 'error',
        eventCount: 1,
        culprit: 'app/checkout/page.tsx in render',
        firstSeenAt: new Date(STAMP).toISOString(),
      })),
    },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as { status: string; filed: number; updated: number; refiled: number };
}

/** What the resolve-back left on each link of one bug. */
async function resolveStates(page: Page, workItemId: string) {
  const res = await page.request.get(`/api/_test/monitors/resolve-state?workItemId=${workItemId}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as Array<{ externalIssueId: string; resolveState: string | null }>;
}

/** Where the resolve run for the bug's newest transition into `done` stands. */
async function resolveRun(page: Page, workItemId: string): Promise<string> {
  const res = await page.request.get(
    `/api/_test/monitors/resolve-run?workItemId=${workItemId}&toStatusKey=done`,
  );
  expect(res.status()).toBe(200);
  return ((await res.json()) as { state: string }).state;
}

const tree = (page: Page) => page.getByRole('treegrid', { name: 'Work Items', exact: true });
const bugRows = (page: Page) => tree(page).locator('[data-testid^="issue-row-"][aria-level="2"]');

async function openBugsFolder(page: Page) {
  await page.goto('/items');
  await expect(tree(page)).toBeVisible();
  const expand = actionWrite(page, '/items', bugsFolderId);
  await page.getByRole('button', { name: 'Expand folder Bugs', exact: true }).click();
  expect((await expand).status()).toBe(200);
}

/** The bug filed for one issue, read back from the store. */
async function bugFor(externalIssueId: string) {
  const link = await adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId } });
  return adminDb.workItem.findUniqueOrThrow({ where: { id: link.workItemId! } });
}

/** Complete a bug the way a person does: the status control on its own page.
 *  Each move waits on the COMMITTED status (the cascade spec's shape for the same
 *  control), never on the optimistic chip. */
async function completeInTheUi(page: Page, identifier: string) {
  await page.goto(`/items/${identifier}`);
  for (const [label, key] of [
    ['In Progress', 'in_progress'],
    ['Done', 'done'],
  ] as const) {
    await page.getByRole('button', { name: 'Edit Status' }).click();
    await page.getByRole('combobox', { name: 'Status' }).click();
    const option = page.getByRole('option', { name: label, exact: true });
    await expect(option).toBeVisible();
    await option.click();
    await expect
      .poll(
        async () => (await adminDb.workItem.findFirstOrThrow({ where: { identifier } })).status,
        { timeout: 30_000, message: `awaiting ${identifier} to commit as ${key}` },
      )
      .toBe(key);
    await page.reload();
  }
  await expect(page.getByText('Done', { exact: true }).first()).toBeVisible();
}

test('completing a monitor-filed bug resolves its issue, the next check changes nothing, the switch turns it off, an assignment arrives, and a failure is named', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-4931');
  // Seven paced chapters, two of which wait on a JOB in the worker process — over
  // the lane's 90 s default by construction, not by slowness.
  test.setTimeout(300_000);

  await page.route(/https?:\/\/([a-z0-9-]+\.)*sentry\.io\//, async (route) => {
    sentryRequests.push(route.request().url());
    await route.abort();
  });

  await chapter('Sentry is connected, and an error arrives as ONE bug', async () => {
    await signIn(page, EMAIL, PASSWORD);
    await standInSentry(page);
    await page.goto(ROOM);
    await page.getByRole('link', { name: 'Connect Sentry' }).click();
    await page.getByRole('link', { name: 'Approve' }).click();
    await page.waitForURL(`**${ROOM}?monitor=connected`);
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

    // Both switches ON by default — the story's shipped default.
    await expect(page.getByRole('switch', { name: RESOLVE })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await beat();

    const summary = await poll(page, [
      { externalId: 'first', title: FIRST, lastSeenAt: new Date().toISOString() },
    ]);
    expect(summary).toMatchObject({ status: 'ok', filed: 1 });
    await openBugsFolder(page);
    await expect(bugRows(page)).toHaveCount(1);
    await expect(bugRows(page).first()).toContainText(FIRST);
    await beat();
  });

  let firstSeen = '';
  await chapter('The bug is completed — and its Sentry issue is resolved', async () => {
    const bug = await bugFor('first');
    firstSeen = (
      await adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId: 'first' } })
    ).lastSeenAt.toISOString();
    await completeInTheUi(page, bug.identifier);
    await beat();

    // ⚠️ THE WORKER PREMISE: the resolve job ran in the worker, against the fake,
    // and recorded the resolve on the link. Waiting on the job's own run first,
    // then the link — never a sleep.
    await expect
      .poll(() => resolveRun(page, bug.id), {
        timeout: 60_000,
        message: 'awaiting the monitor-issue-resolve run for this completion',
      })
      .toBe('terminal');
    await expect
      .poll(async () => (await resolveStates(page, bug.id))[0]?.resolveState, { timeout: 10_000 })
      .toBe('resolved');
    await beat();
  });

  await chapter('The next check changes nothing — ONE bug, still done', async () => {
    // The fake still reports the issue UNRESOLVED, seen again between the first
    // check and Motir's resolve: the page a poll would have fetched before the
    // resolve landed. The loop guard reads it as already reconciled.
    const summary = await poll(page, [
      {
        externalId: 'first',
        title: FIRST,
        lastSeenAt: new Date(new Date(firstSeen).getTime() + 1_000).toISOString(),
      },
    ]);
    expect(summary).toMatchObject({ status: 'ok', filed: 0, refiled: 0 });

    await openBugsFolder(page);
    await expect(bugRows(page)).toHaveCount(1);
    const bug = await bugFor('first');
    expect(bug.status).toBe('done');
    await page.goto(`/items/${bug.identifier}`);
    await expect(page.getByText('Done', { exact: true }).first()).toBeVisible();
    await beat();
  });

  await chapter('Turning “Resolve in Sentry” off, on the Monitoring row', async () => {
    await page.goto(ROOM);
    const toggle = page.getByRole('switch', { name: RESOLVE });
    const written = page.waitForResponse(
      (res) => res.url().includes('/monitors/') && res.request().method() === 'PATCH',
    );
    await toggle.click();
    const res = await written;
    expect(res.status()).toBe(200);
    expect(JSON.parse(res.request().postData() ?? '{}')).toEqual({ resolveOnDone: false });
    await beat();

    await page.reload();
    await expect(page.getByRole('switch', { name: RESOLVE })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await beat();
  });

  await chapter('The next completion resolves nothing', async () => {
    const summary = await poll(page, [
      { externalId: 'second', title: SECOND, lastSeenAt: new Date().toISOString() },
    ]);
    expect(summary).toMatchObject({ status: 'ok', filed: 1 });
    const bug = await bugFor('second');
    await completeInTheUi(page, bug.identifier);
    await beat();

    // The run must be TERMINAL before the absence means anything.
    await expect
      .poll(() => resolveRun(page, bug.id), {
        timeout: 60_000,
        message: 'awaiting the monitor-issue-resolve run for the switched-off completion',
      })
      .toBe('terminal');
    expect((await resolveStates(page, bug.id))[0]?.resolveState).toBeNull();
    await beat();
  });

  await chapter('An assignment made in Sentry arrives on the bug', async () => {
    const summary = await poll(page, [
      {
        externalId: 'third',
        title: THIRD,
        lastSeenAt: new Date().toISOString(),
        assignee: {
          kind: 'user',
          externalId: 'sentry-user-7',
          email: MEMBER_EMAIL,
          name: MEMBER_NAME,
        },
      },
    ]);
    expect(summary).toMatchObject({ status: 'ok', filed: 1 });
    const bug = await bugFor('third');
    await page.goto(`/items/${bug.identifier}`);
    await expect(page.getByText(MEMBER_NAME).first()).toBeVisible();
    await expect(page.getByText('Unassigned')).toHaveCount(0);
    await beat();
  });

  await chapter('A failed resolve is named on the row, with a link to its bug', async () => {
    const failed = await bugFor('first');
    const reason = 'Sentry returned 403: You do not have permission to perform this action.';
    const res = await page.request.post('/api/_test/monitors/sync-failure', {
      data: { connectionId, reason, workItemIdentifier: failed.identifier },
    });
    expect(res.status()).toBe(200);

    await page.goto(ROOM);
    const line = page.getByRole('main').getByTestId('monitor-sync-failure');
    await expect(line).toContainText(`Couldn't resolve Sentry's issue for ${failed.identifier}:`);
    await expect(line).toContainText(reason);
    await beat();

    await line.getByRole('link', { name: failed.identifier }).click();
    await page.waitForURL(`**/items/${failed.identifier}`);
    await expect(page.getByRole('heading', { name: FIRST })).toBeVisible();
    await beat();
  });

  await chapter('Nothing reached sentry.io', async () => {
    expect(sentryRequests).toEqual([]);
    await beat();
  });
});
