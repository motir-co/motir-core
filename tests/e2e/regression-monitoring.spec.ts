import type { Page, Route } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { pageRefresh } from './_helpers/authoritative-signal';
import { holdScheduledMonitorPoll } from './_helpers/monitor-poll-hold';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';

// THE MONITORING ROOM, WALKED IN A BROWSER (Story MOTIR-4928 · Subtask
// MOTIR-5264) — the story's acceptance receipt, paced for a person to watch:
// reach the room → a refused connect stores nothing → connect → choose projects
// → a degraded grant says why → re-check → disconnect.
//
// ── ⚠️ WHAT IS FAKE, AND WHAT IS NOT ───────────────────────────────────────
// Sentry is the only thing replaced, in two places, and every Motir layer
// between them is real:
//
//   · SERVER-SIDE, `playwright.acceptance.config.ts` sets
//     `MOTIR_MONITOR_FAKE_PROVIDER=1` on the spawned server, so the stored
//     `sentry` discriminator resolves to the fake provider (grant exchange,
//     project list, health). Before this card that switch was NOT set in the
//     lane: every exchange would have reached the real adapter and failed on
//     missing credentials, and no connected state was reachable at all.
//   · BROWSER-SIDE, Sentry's external-install page is a `.invalid` host
//     (`SENTRY_WEB_BASE_URL`) that this spec serves a stand-in for, with Approve
//     linking to Motir's REAL callback carrying the fake's grant code. The start
//     route, the state cookie, the callback, the grant exchange, the persist and
//     the return redirect all run for real.
//
// ⚠️ THE MOUNTING CHECK is chapter 3's first assertion: the connected grant names
// `fake-org`, the fake's organisation. The real adapter cannot produce that name
// and could not have exchanged a grant here at all, so a lane that lost the
// switch fails there rather than filming an error banner as if it were the walk.
//
// ⚠️ NO REQUEST REACHES sentry.io. Every browser request to it is recorded and
// aborted, and the final chapter asserts the record is empty.

const EMAIL = 'monitoring-acceptance@motir.test';
const PASSWORD = 'Sup3rSecret!Pass';
const ROOM = '/settings/project/monitoring';
const INSTALL_HOST = 'sentry-install.e2e.invalid';

let projectId = '';
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
  projectId = project.id;
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
});

/**
 * Stand in for Sentry's install-approval page.
 *
 * ⚠️ PLAYWRIGHT DOES NOT ROUTE A REQUEST REACHED BY A REDIRECT, so the `.invalid`
 * install host cannot be intercepted where the browser lands on it. Instead the
 * REAL start route is intercepted: its response is fetched unfollowed, the
 * redirect is asserted to point at the configured install host, its state
 * cookie is kept, and the approval page is served in the redirect's place.
 * Approve then returns to Motir's real callback with `code` and
 * `installationId`, as Sentry's redirect does, echoing the `state` the start
 * route minted. `code` decides the outcome: the fake exchanges `valid-code` and
 * refuses anything else in its own words.
 */
async function standInSentry(page: Page, code: string): Promise<void> {
  await page.route('**/api/monitors/sentry/oauth/start**', async (route: Route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = new URL(response.headers()['location'] ?? '');
    expect(location.host).toBe(INSTALL_HOST);
    const callback = new URL('/api/monitors/sentry/oauth/callback', route.request().url());
    callback.searchParams.set('code', code);
    callback.searchParams.set('installationId', 'inst-e2e-1');
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
          <p>(An end-to-end stand-in for Sentry's approval page.)</p>
          <a href="${callback.toString()}">Approve</a>
        </body></html>`,
    });
  });
}

test('a project admin connects Sentry, chooses projects, sees a degraded grant, re-checks it and disconnects', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-4928');

  await page.route(/https?:\/\/([a-z0-9-]+\.)*sentry\.io\//, async (route) => {
    sentryRequests.push(route.request().url());
    await route.abort();
  });

  await chapter('The Monitoring room, reached from the settings rail', async () => {
    await signIn(page, EMAIL, PASSWORD);
    await page.goto('/settings/project');
    await page.getByRole('link', { name: 'Monitoring' }).click();
    await page.waitForURL(`**${ROOM}`);
    await expect(page.getByRole('heading', { name: 'Monitoring', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No error monitor connected' })).toBeVisible();
    await beat();
  });

  await chapter('A connect Sentry refuses stores nothing, and says what Sentry said', async () => {
    await standInSentry(page, 'refused-code');
    await page.getByRole('link', { name: 'Connect Sentry' }).click();
    await expect(page.getByRole('heading', { name: 'Install Motir on fake-org' })).toBeVisible();
    await beat();
    await page.getByRole('link', { name: 'Approve' }).click();
    await page.waitForURL(`**${ROOM}?monitor=error`);

    // Filtered: Next's route announcer is a second `alert` on every page.
    const banner = page.getByRole('alert').filter({ hasText: "Couldn't connect Sentry." });
    await expect(banner).toContainText("Couldn't connect Sentry.");
    // Sentry's OWN words, delivered by the server in a cookie — not the URL.
    await expect(banner).toContainText('Sentry says: Unknown grant code "refused-code".');
    await expect(page.getByRole('heading', { name: 'No error monitor connected' })).toBeVisible();
    expect(await adminDb.monitorInstallation.count()).toBe(0);
    expect(await adminDb.monitorConnection.count()).toBe(0);
    await beat();
    await page.unroute('**/api/monitors/sentry/oauth/start**');
  });

  await chapter(
    'Connecting Sentry lands on a connected grant with nothing monitored yet',
    async () => {
      await standInSentry(page, 'valid-code');
      await page.getByRole('link', { name: 'Connect Sentry' }).click();
      await expect(page.getByRole('heading', { name: 'Install Motir on fake-org' })).toBeVisible();
      await beat();
      await page.getByRole('link', { name: 'Approve' }).click();
      await page.waitForURL(`**${ROOM}?monitor=connected`);

      // ⚠️ THE MOUNTING CHECK: `fake-org` is the fake provider's organisation.
      await expect(
        page.getByRole('status').filter({ hasText: 'Sentry is connected.' }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'No Sentry projects monitored yet' }),
      ).toBeVisible();
      await expect(page.getByRole('main')).toContainText('fake-org');
      await beat();
    },
  );

  await chapter('Choosing which Sentry projects send issues to this board', async () => {
    const listed = page.waitForResponse(
      (res) => res.url().endsWith('/monitors/available') && res.request().method() === 'GET',
    );
    await page.getByRole('button', { name: 'Choose Sentry projects' }).click();
    expect((await listed).status()).toBe(200);
    const dialog = page.getByRole('dialog', { name: 'Choose Sentry projects' });
    await expect(dialog).toBeVisible();
    await beat();

    await dialog.getByRole('checkbox', { name: /^web,/ }).click();
    await dialog.getByRole('checkbox', { name: /^worker,/ }).click();
    await beat();

    const bound: Promise<unknown>[] = [0, 1].map(() =>
      page.waitForResponse(
        (res) => res.url().endsWith('/monitors') && res.request().method() === 'POST',
      ),
    );
    const refreshed = pageRefresh(page, ROOM);
    await dialog.getByRole('button', { name: 'Monitor 2 projects' }).click();
    await Promise.all(bound);
    await refreshed;

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Stop monitoring web' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop monitoring worker' })).toBeVisible();
    await beat();
  });

  await chapter('A grant whose credential Sentry revoked says so, in Sentry’s words', async () => {
    // ⚠️ The lane's worker polls the two bound projects every five minutes, and a
    // successful poll writes `connected` over this fixture. Hold it off first,
    // or a chapter that straddles a fire films the wrong state (MOTIR-7840).
    await holdScheduledMonitorPoll();
    // The credential-lifecycle card's writer, as it records a refused refresh.
    await adminDb.monitorInstallation.updateMany({
      data: {
        health: 'degraded',
        healthReason: 'The authorization has been revoked.',
        healthCheckedAt: new Date(),
      },
    });
    // Back to the room without the return status, so the only banner is the
    // grant's own.
    await page.goto(ROOM);

    await expect(page.getByRole('main')).toContainText('Degraded');
    const status = page.getByRole('status').filter({ hasText: 'Sentry says:' });
    await expect(status).toContainText('The authorization has been revoked.');
    await expect(status).toContainText('nothing new will reach the board in the meantime');
    await expect(page.getByRole('link', { name: 'Reconnect' })).toBeVisible();
    await beat();
  });

  await chapter('Re-check asks Sentry again, and the grant reads Connected', async () => {
    const refreshed = pageRefresh(page, ROOM);
    await page.getByRole('button', { name: 'Re-check' }).click();
    await refreshed;
    await expect(page.getByRole('link', { name: 'Reconnect' })).toBeHidden();
    await expect(page.getByRole('main')).toContainText('Connected');
    const row = await adminDb.monitorInstallation.findFirstOrThrow();
    expect(row.health).toBe('connected');
    await beat();
  });

  await chapter('Disconnecting, confirmed — one project, then the last', async () => {
    await page.getByRole('button', { name: 'Stop monitoring worker' }).click();
    const one = page.getByRole('alertdialog', { name: 'Stop monitoring worker?' });
    await expect(one).toContainText('web stays monitored');
    await beat();
    const removedOne = page.waitForResponse(
      (res) => /\/monitors\/[^/]+$/.test(res.url()) && res.request().method() === 'DELETE',
    );
    let refreshed = pageRefresh(page, ROOM);
    await one.getByRole('button', { name: 'Stop monitoring' }).click();
    expect((await removedOne).status()).toBe(200);
    await refreshed;
    await expect(page.getByRole('button', { name: 'Stop monitoring worker' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Stop monitoring web' })).toBeVisible();
    await beat();

    await page.getByRole('button', { name: 'Stop monitoring web' }).click();
    const last = page.getByRole('alertdialog', { name: 'Disconnect Sentry?' });
    await expect(last).toContainText("removes Motir's stored access to fake-org");
    await beat();
    const removedLast = page.waitForResponse(
      (res) => /\/monitors\/[^/]+$/.test(res.url()) && res.request().method() === 'DELETE',
    );
    refreshed = pageRefresh(page, ROOM);
    await last.getByRole('button', { name: 'Disconnect Sentry' }).click();
    expect((await removedLast).status()).toBe(200);
    await refreshed;

    await expect(page.getByRole('heading', { name: 'No error monitor connected' })).toBeVisible();
    expect(await adminDb.monitorConnection.count({ where: { projectId } })).toBe(0);
    expect(await adminDb.monitorInstallation.count()).toBe(0);
    expect(sentryRequests).toEqual([]);
    await beat();
  });
});
