// Acceptance E2E — a live Motir-hosted app looked after from its Production panel (Story
// MOTIR-9799 · Subtask MOTIR-12112).
//
// THE RECORDED WALK (one test, chaptered): an administrator opens the Production room of a
// repository Motir hosts on Fly that has never released, and Logs, Health and Usage read their
// no-release states. Two merges go live. Logs lists the app's lines newest first; filtering by
// `checkout` leaves the line that carries it; a line carrying a production Environment secret
// shows it as `***`, and the raw value is in neither the page nor the route's answer. The target's
// log service refusing reads as its own named state. Health reads Healthy; the app's process exits
// and the prober turns it Crashed, with one crash event (reason, last masked lines) and a
// notification in the administrator's drawer that opens the event; Roll back from the event
// returns Health to Healthy on the earlier release. The When idle control switches Suspend when
// idle → Always on → back, each a redeploy of the same build; on an AWS container Suspend when idle
// is refused with its reason. Usage this period lists this app's own usage and credits. A member
// reads all of it with the control read-only and no Roll back, and the customer's repository
// shows none of it.
//
// THE RECEIPT IS CI's. This repository's acceptance lane carries
// `./.github/actions/upload-acceptance-video` (`.github/workflows/acceptance-tests.yml`), so a green
// pull-request run publishes this walk as MOTIR-9799's acceptance video; no MCP publish is made.
//
// ── What is real ────────────────────────────────────────────────────────────
// Everything from the routes down: the logs route and its secret masking, the health route, the
// health prober (the lane's job worker runs it every minute, `system.production-health-probe`),
// the crash events and their notification, the idle-policy route and its redeploy, the usage
// route. The deploy and database ports are their FAKES. The hosting fake is file-backed and shared
// by this runner, the webServer and the worker, so the spec arranges its log lines, its refusal
// and its exit through the fake's own controls (`production-runtime.ts`), never by mocking a route.
// The hourly accrual is run once here, on demand, through the service the job calls.
//
// DETERMINISM (the coding convention § E2E): every merge awaits the webhook's 200 and its release
// rows; every state the prober makes is awaited with `expect.poll` over the health, event and
// notification rows before the page is loaded to show it; the secret's config redeploy is awaited
// to its end before the first merge; every page load awaits its document; the
// logs filter, the rollback and each idle switch arm `page.waitForResponse` before the action and
// await its answer. `beat()` / `chapter()` are pacing only. No `waitForTimeout`, no resize.
import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  PRODUCTION_MANIFEST,
  commit,
  deliverMerge,
  releaseHosting,
  releasesOf,
  seedProductionRoom,
  type ProductionRepo,
  type ProductionSeed,
} from './_helpers/production-seed';
import {
  accrueUsage,
  alignHostingClock,
  appendLogLines,
  configRedeploySettled,
  crashApp,
  crashEventsOf,
  crashNotificationsFor,
  healthOf,
  idleModeOf,
  liveReleaseOf,
  releaseCausesOf,
  servingAtFake,
  setLogsUnavailable,
  setProductionSecret,
  usageCreditsOf,
} from './_helpers/production-runtime';
import en from '@/messages/en.json';

const t = en.settings.production;
const ROOM = '/settings/project/production';
const FIRST = commit(1);
const SECOND = commit(2);
const API_FIRST = commit(3);
const short = (sha: string) => sha.slice(0, 7);
const SECRET = 'sk_live_e2e_9799_do_not_show';
/** The prober runs every minute in the job worker; a state lands within two. */
const PROBE_WAIT = { timeout: 150_000, intervals: [2_000] };

// The walk waits on the job worker's one-minute prober three times; it runs several minutes.
test.describe.configure({ timeout: 720_000 });

let seed: ProductionSeed;

test.beforeEach(async () => {
  await resetDatabase();
  releaseHosting();
  alignHostingClock();
  seed = await seedProductionRoom(`${Date.now()}`, {
    // No database: the walk is about the running app, and a release without one
    // has nothing for the database port to meter.
    manifest: { ...PRODUCTION_MANIFEST, database: { kind: 'none' } },
    awsContainer: true,
  });
});

test.afterEach(async () => {
  releaseHosting();
  if (seed) await setLogsUnavailable(seed.web, null).catch(() => undefined);
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── The room ──────────────────────────────────────────────────────────────────

const panel = (page: Page): Locator => page.getByRole('main').getByTestId('production-panel');
const healthCard = (page: Page) => panel(page).getByTestId('production-health');
const logs = (page: Page) => panel(page).getByTestId('production-logs');
const events = (page: Page) => panel(page).getByTestId('production-crash-events');
const idleCard = (page: Page) => panel(page).getByTestId('production-idle-policy');
const usageCard = (page: Page) => panel(page).getByTestId('production-usage');
const idleOption = (page: Page, label: string) =>
  idleCard(page).getByRole('group', { name: t.idle.heading }).getByRole('button', { name: label });

const routeOf =
  (repo: ProductionRepo, leaf: string, method = 'GET') =>
  (res: Response) =>
    res.request().method() === method &&
    new URL(res.url()).pathname.endsWith(`/repositories/${repo.id}/production/${leaf}`);

/** Open the room on a repository, waiting for its document and its logs read. */
async function openRoom(page: Page, repo: ProductionRepo): Promise<Response | null> {
  const logsRead = page.waitForResponse(routeOf(repo, 'logs')).catch(() => null);
  const res = await page.goto(`${ROOM}?repository=${repo.id}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: t.title })).toBeVisible();
  await expect(panel(page)).toBeVisible();
  // A room with no release reads no logs; one with a release does, on mount.
  if ((await liveReleaseOf(repo)) === null) return null;
  return logsRead;
}

async function merge(page: Page, repo: ProductionRepo, sha: string): Promise<void> {
  expect(await deliverMerge(page.request, repo, sha)).toBe(200);
  await expect
    .poll(async () => (await releasesOf(repo)).find((r) => r.commit === sha)?.state ?? null, {
      timeout: 60_000,
    })
    .toBe('live');
}

/** Wait until the prober has stored `state` for the repository's live release. */
async function probedAs(repo: ProductionRepo, state: string): Promise<void> {
  await expect
    .poll(async () => {
      const [health, live] = await Promise.all([healthOf(repo), liveReleaseOf(repo)]);
      return health && live && health.probedReleaseId === live.id ? health.state : null;
    }, PROBE_WAIT)
    .toBe(state);
}

const healthPill = (page: Page) => healthCard(page).getByTestId('production-health-pill');
const logMessages = (page: Page) => logs(page).getByTestId('production-log-message');

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('a live app is looked after from its Production panel: logs, health and a crash rolled back, the idle policy, and this period’s usage', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9799');
  await setProductionSecret(seed, seed.web, 'STRIPE_SECRET_KEY', SECRET);
  // The save queues a config redeploy that runs once 30 s pass quietly. Let it
  // finish now, with nothing live, so it cannot redeploy the release the merges
  // below put live and leave an extra release for Roll back to land on.
  await expect
    .poll(() => configRedeploySettled(seed.web), { timeout: 150_000, intervals: [2_000] })
    .toBe(true);
  await signIn(page, seed.adminEmail, seed.password);

  await chapter(
    'A repository with no release yet: Logs, Health and Usage wait for one',
    async () => {
      await openRoom(page, seed.api);
      await expect(panel(page).getByTestId('production-empty-state')).toBeVisible();
      await expect(healthCard(page)).toHaveCount(0);
      await expect(logs(page)).toContainText(t.logs.noRelease);
      await expect(usageCard(page)).toContainText(t.usage.noRelease);
      await expect(idleCard(page)).toContainText(t.idle.default);
      await beat();
    },
  );

  await chapter('Merges go live; the app writes its lines', async () => {
    await merge(page, seed.api, API_FIRST);
    await merge(page, seed.web, FIRST);
    await merge(page, seed.web, SECOND);
    await appendLogLines(seed.web, [
      { secondsAgo: 50, message: 'GET /products 200 in 41ms' },
      { secondsAgo: 40, message: 'POST /checkout 201 in 212ms order=ord_1042' },
      { secondsAgo: 30, message: `payment client ready with key ${SECRET}` },
      { secondsAgo: 20, message: 'GET /cart 200 in 18ms' },
    ]);
    const read = await openRoom(page, seed.web);
    expect(read?.status()).toBe(200);
    await expect(logMessages(page)).toHaveText([
      'GET /cart 200 in 18ms',
      'payment client ready with key ***',
      'POST /checkout 201 in 212ms order=ord_1042',
      'GET /products 200 in 41ms',
    ]);
    await expect(logs(page).getByText(t.logs.order)).toBeVisible();
    await beat();
  });

  await chapter(
    'Filtering by a word leaves the line that carries it; the secret stays masked',
    async () => {
      // The panel sends its filter as `q` (`productionRuntimeClient.readLogs`, read by the
      // logs route), once typing pauses.
      const filtered = page.waitForResponse(
        (res) =>
          routeOf(seed.web, 'logs')(res) && new URL(res.url()).searchParams.get('q') === 'checkout',
      );
      await logs(page).getByTestId('production-logs-filter').fill('checkout');
      const answer = await filtered;
      expect(answer.status()).toBe(200);
      expect(await answer.text()).not.toContain(SECRET);
      await expect(logMessages(page)).toHaveText(['POST /checkout 201 in 212ms order=ord_1042']);
      await beat();

      const cleared = page.waitForResponse(
        (res) => routeOf(seed.web, 'logs')(res) && !new URL(res.url()).searchParams.has('q'),
      );
      await logs(page).getByTestId('production-logs-filter').fill('');
      const whole = await cleared;
      expect(whole.status()).toBe(200);
      expect(await whole.text()).not.toContain(SECRET);
      await expect(logMessages(page)).toHaveCount(4);
      const masked = logs(page).getByTestId('production-log-mask');
      await expect(masked).toHaveText(['***']);
      await expect(logs(page).getByTestId('production-logs-masked-note')).toHaveText(t.logs.masked);
      expect(await page.content()).not.toContain(SECRET);
      await beat();
    },
  );

  await chapter('The target’s log service refuses: a named state, not an error page', async () => {
    await setLogsUnavailable(seed.web, 'log drain offline');
    const read = await openRoom(page, seed.web);
    expect(read?.status()).toBe(200);
    expect(((await read!.json()) as { state: string }).state).toBe('unavailable');
    // The state box carries the message AND its own Try again button, so the message is
    // read from its paragraph and the button is checked on its own.
    const unavailable = logs(page).getByTestId('production-logs-unavailable');
    await expect(unavailable.locator('p')).toHaveText(
      t.logs.unavailable.replaceAll('{target}', 'Fly'),
    );
    await expect(unavailable.getByRole('button', { name: t.logs.retry })).toBeVisible();
    await beat();
    await setLogsUnavailable(seed.web, null);
  });

  await chapter('Health: the prober finds the app answering', async () => {
    await probedAs(seed.web, 'healthy');
    await openRoom(page, seed.web);
    await expect(healthPill(page)).toHaveAttribute('data-health-state', 'healthy');
    await expect(healthPill(page)).toHaveText(t.health.state.healthy);
    await expect(healthCard(page).getByTestId('production-health-since')).toBeVisible();
    await expect(events(page)).toContainText(t.events.empty);
    await beat();
  });

  await chapter('The app’s process exits: Crashed, with its event and a notification', async () => {
    await crashApp(seed.web, 1);
    await probedAs(seed.web, 'crashed');
    await expect
      .poll(async () => (await crashEventsOf(seed.web)).map((e) => [e.kind, e.exitCode]))
      .toEqual([['crashed', 1]]);
    await expect.poll(async () => (await crashNotificationsFor(seed.adminUserId)).length).toBe(1);
    await openRoom(page, seed.web);
    await expect(healthPill(page)).toHaveAttribute('data-health-state', 'crashed');
    await expect(healthPill(page)).toHaveText(t.health.state.crashed);
    const event = events(page).getByTestId('production-crash-event');
    await expect(event).toHaveCount(1);
    const reason = t.events.reason.exit.replace('{code}', '1');
    await expect(event.getByTestId('production-crash-reason')).toHaveText(reason);
    await expect(event.locator('time')).toHaveAttribute('datetime', /.+/);
    await expect(event).toContainText(short(SECOND));
    await event.getByRole('button', { name: /^Show the last/ }).click();
    await expect(event.getByTestId('production-log-mask').first()).toHaveText('***');
    expect(await page.content()).not.toContain(SECRET);
    await beat();

    const bell = page.getByRole('button', { name: /^Notifications,/ });
    await expect(bell).toHaveAccessibleName(/unread/);
    await bell.click();
    const drawer = page.getByRole('dialog', { name: 'Notifications' });
    const row = drawer.getByRole('link', {
      name: new RegExp(`${seed.web.name} crashed in production`),
    });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`${reason} · ${seed.projectKey}`);
    await beat();
    const [crash] = await crashEventsOf(seed.web);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`[?&]event=${crash!.id}`));
    await expect(panel(page)).toBeVisible();
    await expect(events(page).getByTestId('production-crash-event')).toHaveCount(1);
    await beat();
  });

  await chapter(
    'Roll back from the crash event: Healthy again on the earlier release',
    async () => {
      const event = events(page).getByTestId('production-crash-event');
      await event.getByTestId('production-crash-rollback').click();
      const dialog = page.getByRole('alertdialog', {
        name: t.dialog.title.replace('{repository}', seed.web.name),
      });
      await expect(dialog).toBeVisible();
      const rolledBack = page.waitForResponse(routeOf(seed.web, 'rollback', 'POST'));
      await dialog.getByRole('button', { name: t.dialog.confirm }).click();
      expect((await rolledBack).status()).toBe(200);
      await expect(dialog).toHaveCount(0);
      expect(await releasesOf(seed.web)).toEqual([
        { commit: SECOND, state: 'rolled_back' },
        { commit: FIRST, state: 'live' },
      ]);
      await beat();

      await probedAs(seed.web, 'healthy');
      await openRoom(page, seed.web);
      await expect(healthPill(page)).toHaveAttribute('data-health-state', 'healthy');
      await expect(panel(page).getByTestId('production-current-release')).toContainText(
        short(FIRST),
      );
      await expect(events(page).getByTestId('production-crash-rolled-back')).toHaveText(
        t.events.rolledBackSince,
      );
      await beat();
    },
  );

  await chapter(
    'When idle: Suspend when idle → Always on → back, the same build redeployed',
    async () => {
      expect(await idleModeOf(seed.web)).toBe('suspend');
      const suspend = idleOption(page, t.idle.option.suspend);
      const alwaysOn = idleOption(page, t.idle.option.alwaysOn);
      await expect(suspend).toHaveAttribute('aria-pressed', 'true');
      const before = await servingAtFake(seed.web);

      for (const [option, mode, help] of [
        [alwaysOn, 'always_on', t.idle.help.alwaysOn],
        [suspend, 'suspend', t.idle.help.suspend],
      ] as const) {
        const switched = page.waitForResponse(routeOf(seed.web, 'idle-policy', 'PUT'));
        await option.click();
        const answer = await switched;
        expect(answer.status()).toBe(200);
        expect(((await answer.json()) as { policy: { mode: string } }).policy.mode).toBe(mode);
        await expect(option).toHaveAttribute('aria-pressed', 'true');
        await expect(idleCard(page)).toContainText(help);
        expect(await idleModeOf(seed.web)).toBe(mode);
        await beat();
      }

      // Each switch redeployed the build that was serving — the same commit and
      // artifact, a new release at the fake running the same image — and nothing
      // was built: no merge, no new commit.
      const after = await servingAtFake(seed.web);
      expect(after?.image).toBe(before?.image);
      expect(after?.releaseId).not.toBe(before?.releaseId);
      const releases = await releaseCausesOf(seed.web);
      const restored = releases.find((r) => r.commit === FIRST && r.cause === 'merge');
      expect(releases.slice(0, 2)).toEqual([
        { commit: FIRST, cause: 'idle_policy', artifactRef: restored?.artifactRef, state: 'live' },
        {
          commit: FIRST,
          cause: 'idle_policy',
          artifactRef: restored?.artifactRef,
          state: 'replaced',
        },
      ]);
      expect(new Set(releases.map((r) => r.commit))).toEqual(new Set([FIRST, SECOND]));
    },
  );

  await chapter('On an AWS container, Suspend when idle is refused with its reason', async () => {
    const aws = seed.aws!;
    await openRoom(page, aws);
    await expect(idleOption(page, t.idle.option.alwaysOn)).toHaveAttribute('aria-pressed', 'true');
    await expect(idleOption(page, t.idle.option.suspend)).toBeDisabled();
    await expect(idleCard(page).getByTestId('production-idle-unsupported')).toHaveText(
      `${t.idle.refusal.unsupported
        .replace('{target}', 'AWS')
        .replace('{shape}', t.idle.shape.container)} ${t.idle.refusal.unsupportedKeeps}`,
    );
    expect(await idleModeOf(aws)).toBe('always_on');
    await beat();
  });

  await chapter('Usage this period: this app’s own usage and credits', async () => {
    alignHostingClock();
    await accrueUsage();
    const own = await usageCreditsOf(seed.web);
    const other = await usageCreditsOf(seed.api);
    expect(Object.keys(own).length).toBeGreaterThan(0);
    expect(Object.keys(other).length).toBeGreaterThan(0);

    await openRoom(page, seed.web);
    const rows = usageCard(page).getByTestId('production-usage-row');
    await expect(rows).toHaveCount(Object.keys(own).length);
    const credits = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
    for (const [unit, sum] of Object.entries(own)) {
      await expect(usageCard(page).locator(`[data-unit="${unit}"] td`).nth(2)).toHaveText(
        credits.format(sum),
      );
    }
    await expect(usageCard(page)).toContainText(t.usage.total);
    await expect(usageCard(page)).toContainText(t.usage.footnote);
    await beat();
  });

  await chapter('A member reads the same room: everything visible, nothing to change', async () => {
    await probedAs(seed.web, 'healthy');
    await signIn(page, seed.memberEmail, seed.password);
    await openRoom(page, seed.web);
    await expect(healthPill(page)).toHaveAttribute('data-health-state', 'healthy');
    await expect(events(page).getByTestId('production-crash-event')).toHaveCount(1);
    await expect(events(page).getByTestId('production-crash-rollback')).toHaveCount(0);
    await expect(
      panel(page).getByRole('button', { name: t.rollback.action, exact: true }),
    ).toHaveCount(0);
    await expect(logMessages(page)).toHaveCount(4);
    await expect(usageCard(page).getByTestId('production-usage-row')).not.toHaveCount(0);
    const readOnly = idleCard(page).getByTestId('production-idle-read-only');
    await expect(readOnly).toContainText(t.idle.option.suspend);
    await expect(readOnly).toContainText(t.idle.readOnly);
    await expect(idleCard(page).getByRole('group', { name: t.idle.heading })).toHaveCount(0);
    await beat();
  });

  await chapter('The customer’s repository has none of it', async () => {
    const res = await page.goto(`${ROOM}?repository=${seed.customer.id}`);
    expect(res?.status()).toBe(404);
    const main = page.getByRole('main');
    await expect(main.getByTestId('production-not-found')).toContainText(t.notFound.title);
    for (const id of [
      'production-panel',
      'production-health',
      'production-crash-events',
      'production-logs',
      'production-idle-policy',
      'production-usage',
    ]) {
      await expect(main.getByTestId(id)).toHaveCount(0);
    }
    await beat();
  });
});
