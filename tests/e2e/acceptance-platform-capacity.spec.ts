import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { adminDb, resetDatabase, truncateJobTables } from './_helpers/db-reset';
import { addOrgMember, resetBillingFixture, seedBillingOwner } from './_helpers/billing';
import {
  patchCapacityEntry,
  readCapacityFake,
  seedCapacityFake,
  setCapacityMode,
} from './_helpers/capacity-fake';
import { saveAccountLanguageInSettings } from './_helpers/i18n-walk';
import { SHELL_PASSWORD, signIn } from './_helpers/shell-session';
import type { PlatformRole } from '@/generated/prisma/client';
import { CAPACITY_LIMIT_UNITS } from '@/lib/capacity/alertKeys';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// PLATFORM ADMINS SEE PROVIDER CAPACITY (Story MOTIR-9539 · MOTIR-9616) — the
// story's acceptance receipt. An operator opens Provider capacity from the
// console rail, watches usage move on Refresh, edits a limit and a tier note, is
// refused a negative limit, pushes a concurrency limit under its usage and sees
// the alert raised once and then cleared, raises the alert share so an 85 % limit
// reads Near limit, and reads the screen in 中文. Separate tests, outside the
// clip: the counter store down, the gateway unreachable, the support view, the
// tenant refusal, and the minutely job raising an alert with no page open.
//
// ── WHAT STANDS IN FOR WHAT ───────────────────────────────────────────────────
// The lane has no gateway. Its capacity fake (`lib/gateway/capacityFakeState.ts`,
// MOTIR-9617) keeps the limits, lane usage and mode in ONE file that the web
// server, the job worker and this runner all read on every call, so the spec
// "sends traffic" by patching lane usage in that file. Recipe step 5's alert to
// platform admins is a Sentry event the browser cannot see: this tier observes
// the Raised-alerts banner and the stored `capacity_raised_alert` row, and the
// exactly-one-event count is the story integration gate's
// (`tests/integration/capacity/capacityScreenStoryGate.test.ts`).
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every press arms its response first: the Server Action POST for a save, the
// `GET /api/platform/capacity` 200 for a Refresh or the screen's re-read after a
// save. What persisted is then read from the state file, the database or a
// `page.reload()`. `chapter()` and `beat()` are pacing, never synchronisation.
//
// ── THE MINUTELY JOB IS NOT HELD ──────────────────────────────────────────────
// It reads the same file as the page, and raise and clear are exactly-once in the
// store, so a pass reaching a decision first changes nothing asserted here: the
// de-duplication checks count stored rows, which are the same whoever raised.

test.describe.configure({ timeout: 300_000 });

const copy = en.platformAdmin.capacity;
const shell = en.platformAdmin.shell;
const zhCopy = zh.platformAdmin.capacity;
const PAGE = '/admin/capacity';
const ROUTE = '/api/platform/capacity';

const QWEN = 'qwen-example-1';
const DEEPSEEK = 'deepseek-example-1';
const OPERATOR = 'acceptance-capacity-operator@example.com';

const fill = (message: string, values: Record<string, string | number>): string =>
  message.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
const n = (value: number) => value.toLocaleString('en-US');
const lanesText = (planning: number, agent: number) =>
  fill(copy.lanes, { planning: n(planning), agent: n(agent) });
const percent = (value: number) => fill(copy.percent, { value });

const main = (page: Page): Locator => page.getByRole('main');
const entryCard = (page: Page, provider: string, model: string) =>
  main(page).getByTestId(`capacity-entry-${provider}-${model}`);
const limitRow = (page: Page, provider: string, model: string, unit: string) =>
  entryCard(page, provider, model).getByTestId(`capacity-row-${unit}`);
const banner = (page: Page) => main(page).getByTestId('capacity-raised-alerts');
const alertShareCard = (page: Page) => main(page).getByTestId('capacity-alert-share');

/** Arm the poll's 200 BEFORE the press that causes it. */
const pollResponse = (page: Page): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === ROUTE &&
      res.request().method() === 'GET' &&
      res.status() === 200,
    { timeout: 30_000 },
  );

/** Arm a Server Action's answer on this page BEFORE the press that sends it. */
const actionResponse = (page: Page): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' &&
      res.request().headers()['next-action'] !== undefined &&
      new URL(res.url()).pathname === PAGE,
    { timeout: 30_000 },
  );

async function refresh(page: Page): Promise<Response> {
  const polled = pollResponse(page);
  await main(page).getByRole('button', { name: copy.fresh.refresh, exact: true }).click();
  return polled;
}

const raisedRowsFor = (provider: string, model: string, limitUnit: string) =>
  adminDb.capacityRaisedAlert.findMany({ where: { provider, model, limitUnit } });

/** A signed-in tenant owner, lifted to `role` when given. */
async function signInStaff(page: Page, email: string, role: PlatformRole | null) {
  const seed = await seedBillingOwner(page, email);
  if (role) await adminDb.user.update({ where: { email }, data: { platformRole: role } });
  return seed;
}

async function openCapacity(page: Page): Promise<void> {
  const res = await page.goto(PAGE);
  expect(res?.status()).toBe(200);
  await expect(main(page).getByRole('heading', { name: copy.title, level: 1 })).toBeVisible();
  await expect(main(page).getByTestId('capacity-group-qwen')).toBeVisible();
}

test.beforeEach(async () => {
  await resetDatabase();
  resetBillingFixture();
  await adminDb.capacityRaisedAlert.deleteMany();
  await adminDb.capacityAlertSetting.deleteMany();
  seedCapacityFake();
});

test('a platform admin reads usage against limits, edits a limit and tier note, is refused a negative limit, sees an alert raised once and cleared, changes the alert share, and reads it in Chinese', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9539');
  await signInStaff(page, OPERATOR, 'operator');

  await chapter('An operator opens Provider capacity from the console rail', async () => {
    await page.goto('/admin');
    const rail = page.getByRole('navigation', { name: shell.area });
    await rail.getByRole('link', { name: shell.navCapacity, exact: true }).click();
    await page.waitForURL((url) => url.pathname === PAGE);
    await expect(main(page).getByRole('heading', { name: copy.title, level: 1 })).toBeVisible();

    for (const provider of ['claude', 'deepseek', 'qwen'] as const) {
      const group = main(page).getByTestId(`capacity-group-${provider}`);
      await expect(group.getByRole('heading', { name: copy.provider[provider] })).toBeVisible();
    }
    for (const entry of readCapacityFake().entries) {
      const card = entryCard(page, entry.provider, entry.model);
      await expect(card).toContainText(fill(copy.entry.tierNote, { note: entry.tierNote }));
      await expect(card).toContainText(
        fill(copy.entry.planningShare, { share: entry.planningSharePercent }),
      );
      const planning = entry.lanes.planning!;
      const agent = entry.lanes.agent!;
      const notEnforced = CAPACITY_LIMIT_UNITS.filter(
        (unit) => entry.limits[unit].status === 'not_applicable',
      );
      // The units this provider does not enforce sit in the closed fold.
      const fold = card.getByTestId('capacity-not-enforced');
      await expect(fold).toContainText(fill(copy.fold, { count: notEnforced.length }));
      await expect(fold).not.toHaveAttribute('open');
      for (const unit of notEnforced) {
        await expect(fold).toContainText(copy.unit[unit]);
        await expect(card.getByTestId(`capacity-row-${unit}`)).toHaveCount(0);
      }
      // The 429 row: per-lane minute and day counts, and no share bar.
      const r429 = card.getByTestId('capacity-row-429');
      await expect(r429).toContainText(
        lanesText(planning.rateLimited429.day, agent.rateLimited429.day),
      );
      await expect(r429.getByTestId('capacity-share-bar')).toHaveCount(0);
    }
    const rpm = limitRow(page, 'qwen', QWEN, 'rpm');
    await expect(rpm).toContainText(copy.unit.rpm);
    await expect(rpm).toContainText(`${n(70)} / ${n(600)}`);
    await expect(rpm).toContainText(lanesText(20, 50));
    await expect(rpm).toContainText(percent(12));
    await expect(rpm).toContainText(copy.state.normal);
    await expect(rpm.getByTestId('capacity-share-bar')).toHaveCount(1);
    await expect(limitRow(page, 'deepseek', DEEPSEEK, 'max_concurrency')).toContainText(
      `${n(7)} / ${n(500)}`,
    );
  });

  await chapter('Usage moves: the qwen lanes rise and Refresh shows the new read', async () => {
    patchCapacityEntry('qwen', QWEN, {
      lanes: { planning: { requestsPerMinute: 100 }, agent: { requestsPerMinute: 200 } },
    });
    const polled = await refresh(page);
    const body = (await polled.json()) as { capacity: { readAt: string } };
    const rpm = limitRow(page, 'qwen', QWEN, 'rpm');
    await expect(rpm).toContainText(`${n(300)} / ${n(600)}`);
    await expect(rpm).toContainText(lanesText(100, 200));
    await expect(rpm).toContainText(percent(50));
    await expect(main(page).getByTestId('capacity-freshness')).toContainText(
      fill(copy.fresh.readAt, { time: new Date(body.capacity.readAt).toISOString().slice(11, 19) }),
    );
  });

  const editDialog = page.getByRole('dialog', { name: fill(copy.edit.title, { model: QWEN }) });

  await chapter('Edit a limit and the tier note on the qwen entry', async () => {
    await entryCard(page, 'qwen', QWEN)
      .getByRole('button', { name: copy.entry.edit, exact: true })
      .click();
    await expect(editDialog).toBeVisible();
    await editDialog.getByLabel(copy.unit.tpm, { exact: true }).fill('900000');
    await beat();
    await editDialog
      .getByLabel(copy.edit.tierNote, { exact: true })
      .fill('Tier 4, read 2026-10-26');
    await beat();
    const saved = actionResponse(page);
    const reread = pollResponse(page);
    await editDialog.getByRole('button', { name: copy.edit.save, exact: true }).click();
    expect((await saved).status()).toBe(200);
    await reread;
    await expect(editDialog).toHaveCount(0);
    await expect(main(page)).toContainText(fill(copy.edit.saved, { model: QWEN }));
    const card = entryCard(page, 'qwen', QWEN);
    await expect(card).toContainText(
      fill(copy.entry.tierNote, { note: 'Tier 4, read 2026-10-26' }),
    );
    await expect(limitRow(page, 'qwen', QWEN, 'tpm')).toContainText(`/ ${n(900000)}`);

    await page.reload();
    await expect(card).toContainText(
      fill(copy.entry.tierNote, { note: 'Tier 4, read 2026-10-26' }),
    );
    await expect(limitRow(page, 'qwen', QWEN, 'tpm')).toContainText(`/ ${n(900000)}`);
    const stored = readCapacityFake().entries.find((e) => e.model === QWEN)!;
    expect(stored.limits.tpm).toEqual({ status: 'set', value: 900000 });
    expect(stored.tierNote).toBe('Tier 4, read 2026-10-26');
  });

  await chapter('A negative requests-per-minute limit is refused in plain words', async () => {
    await entryCard(page, 'qwen', QWEN)
      .getByRole('button', { name: copy.entry.edit, exact: true })
      .click();
    const rpmInput = editDialog.getByLabel(copy.unit.rpm, { exact: true });
    await rpmInput.fill('-1');
    await beat();
    await editDialog.getByRole('button', { name: copy.edit.save, exact: true }).click();
    await expect(
      editDialog.getByText(fill(copy.editError.wholeNumber, { limit: copy.unit.rpm })),
    ).toBeVisible();
    await expect(editDialog).toBeVisible();
    await expect(rpmInput).toHaveValue('-1');
    await expect(rpmInput).toBeFocused();
    const stored = readCapacityFake().entries.find((e) => e.model === QWEN)!;
    expect(stored.limits.rpm).toEqual({ status: 'set', value: 600 });
    await editDialog.getByRole('button', { name: copy.edit.cancel, exact: true }).click();
    await expect(editDialog).toHaveCount(0);
  });

  // ⚠️ The alert demo uses `max_concurrency`: a raised rpm / tpm alert clears only on a read at
  // second 30 or later of its minute, so a per-minute unit would make the clear chapter flake.
  const deepseekDialog = page.getByRole('dialog', {
    name: fill(copy.edit.title, { model: DEEPSEEK }),
  });
  async function saveConcurrency(limit: number): Promise<void> {
    await entryCard(page, 'deepseek', DEEPSEEK)
      .getByRole('button', { name: copy.entry.edit, exact: true })
      .click();
    await deepseekDialog.getByLabel(copy.unit.max_concurrency, { exact: true }).fill(String(limit));
    await beat();
    const saved = actionResponse(page);
    const reread = pollResponse(page);
    await deepseekDialog.getByRole('button', { name: copy.edit.save, exact: true }).click();
    expect((await saved).status()).toBe(200);
    await reread;
    await expect(deepseekDialog).toHaveCount(0);
  }
  const concurrencyLine = fill(copy.alerts.line, {
    provider: copy.provider.deepseek,
    model: DEEPSEEK,
    limit: copy.unit.max_concurrency,
    share: 140,
  });

  await chapter(
    'A concurrency limit under its usage reads over the alert share, with its banner',
    async () => {
      await saveConcurrency(5);
      const row = limitRow(page, 'deepseek', DEEPSEEK, 'max_concurrency');
      await expect(row).toContainText(copy.state.over);
      await expect(banner(page)).toContainText(concurrencyLine);
      await expect
        .poll(async () => (await raisedRowsFor('deepseek', DEEPSEEK, 'max_concurrency')).length)
        .toBe(1);

      const [first] = await raisedRowsFor('deepseek', DEEPSEEK, 'max_concurrency');
      for (let i = 0; i < 3; i++) {
        await refresh(page);
        await beat();
      }
      await expect(banner(page).getByRole('listitem')).toHaveCount(1);
      await expect(banner(page)).toContainText(concurrencyLine);
      const after = await raisedRowsFor('deepseek', DEEPSEEK, 'max_concurrency');
      expect(after).toHaveLength(1);
      expect(after[0]!.raisedAt).toEqual(first!.raisedAt);
    },
  );

  await chapter('The concurrency limit back above usage clears the alert', async () => {
    await saveConcurrency(500);
    const row = limitRow(page, 'deepseek', DEEPSEEK, 'max_concurrency');
    await expect(row).toContainText(copy.state.normal);
    await expect(row).not.toContainText(copy.state.over);
    await expect(banner(page)).toHaveCount(0);
    expect(await raisedRowsFor('deepseek', DEEPSEEK, 'max_concurrency')).toEqual([]);
  });

  await chapter(
    'The alert share raised from 80 % to 90 % turns an 85 % limit to Near limit',
    async () => {
      patchCapacityEntry('qwen', QWEN, {
        lanes: { planning: { requestsPerMinute: 110 }, agent: { requestsPerMinute: 400 } },
      });
      await refresh(page);
      const rpm = limitRow(page, 'qwen', QWEN, 'rpm');
      await expect(rpm).toContainText(percent(85));
      await expect(rpm).toContainText(copy.state.over);
      await beat();

      const card = alertShareCard(page);
      await expect(card.getByTestId('capacity-alert-share-value')).toHaveText(percent(80));
      await card.getByRole('button', { name: copy.alertShare.edit, exact: true }).click();
      await card.getByRole('textbox', { name: copy.alertShare.label }).fill('90');
      await beat();
      const saved = actionResponse(page);
      const reread = pollResponse(page);
      await card.getByRole('button', { name: copy.edit.save, exact: true }).click();
      expect((await saved).status()).toBe(200);
      await reread;
      await expect(card.getByTestId('capacity-alert-share-value')).toHaveText(percent(90));
      await expect(card).toContainText(fill(copy.alertShare.saved, { share: 90 }));
      await expect(rpm).toContainText(copy.state.near);
      const setting = await adminDb.capacityAlertSetting.findFirstOrThrow();
      expect(setting.alertSharePercent).toBe(90);
    },
  );

  await chapter('The screen in Chinese', async () => {
    await saveAccountLanguageInSettings(page, 'zh');
    await page.goto(PAGE);
    await expect(main(page).getByRole('heading', { name: zhCopy.title, level: 1 })).toBeVisible();
    const rail = page.getByRole('navigation', { name: zh.platformAdmin.shell.area });
    await expect(
      rail.getByRole('link', { name: zh.platformAdmin.shell.navCapacity, exact: true }),
    ).toBeVisible();
    const qwen = entryCard(page, 'qwen', QWEN);
    for (const unit of ['rpm', 'tpm'] as const) {
      await expect(qwen.getByTestId(`capacity-row-${unit}`)).toContainText(zhCopy.unit[unit]);
      await expect(qwen.getByTestId(`capacity-row-${unit}`)).not.toContainText(copy.unit[unit]);
    }
    await expect(main(page)).toContainText(zhCopy.alertShare.title);
    for (const english of [copy.title, copy.alertShare.title, copy.col.usage, copy.fresh.refresh]) {
      await expect(main(page)).not.toContainText(english);
    }
    await expect(rail).not.toContainText(shell.navCapacity);
  });
});

test('the counter store down: limits and notes still shown, every usage reads Unavailable', async ({
  page,
}) => {
  await signInStaff(page, 'acceptance-capacity-store@example.com', 'operator');
  await openCapacity(page);
  setCapacityMode('unavailable');
  await refresh(page);
  await expect(main(page)).toContainText(copy.unavailable.notice);
  for (const entry of readCapacityFake().entries) {
    const card = entryCard(page, entry.provider, entry.model);
    await expect(card).toContainText(fill(copy.entry.tierNote, { note: entry.tierNote }));
    await expect(card).toContainText(
      fill(copy.entry.planningShare, { share: entry.planningSharePercent }),
    );
    for (const unit of CAPACITY_LIMIT_UNITS) {
      const limit = entry.limits[unit];
      if (limit.status === 'not_applicable') continue;
      const row = card.getByTestId(`capacity-row-${unit}`);
      await expect(row).toContainText(copy.state.unavailable);
      if (limit.status === 'set') await expect(row).toContainText(`/ ${n(limit.value)}`);
      await expect(row).not.toContainText('%');
    }
  }
  await expect(main(page).getByTestId('capacity-share-bar')).toHaveCount(0);
});

test('the gateway unreachable: the page error panel and no limit line, the alert share still shown', async ({
  page,
}) => {
  await signInStaff(page, 'acceptance-capacity-down@example.com', 'operator');
  await openCapacity(page);
  setCapacityMode('unreachable');
  await refresh(page);
  const panel = main(page).getByTestId('capacity-error-unreachable');
  await expect(panel).toContainText(copy.error.unreachable.title);
  await expect(main(page).locator('[data-testid^="capacity-entry-"]')).toHaveCount(0);
  await expect(main(page).locator('[data-testid^="capacity-row-"]')).toHaveCount(0);
  await expect(alertShareCard(page)).toContainText(copy.alertShare.title);
});

test('support staff read the screen with no edit control in the DOM', async ({ page }) => {
  await signInStaff(page, 'acceptance-capacity-support@example.com', 'support');
  await openCapacity(page);
  await expect(entryCard(page, 'qwen', QWEN)).toBeVisible();
  await expect(main(page).getByRole('button', { name: copy.entry.edit, exact: true })).toHaveCount(
    0,
  );
  await expect(
    alertShareCard(page).getByRole('button', { name: copy.alertShare.edit, exact: true }),
  ).toHaveCount(0);
  await expect(alertShareCard(page).getByRole('textbox')).toHaveCount(0);
});

test('a tenant user and a tenant workspace owner get the 404 from the page and the route', async ({
  page,
}) => {
  const seed = await signInStaff(page, 'acceptance-capacity-tenant-owner@example.com', null);
  const memberEmail = 'acceptance-capacity-tenant-member@example.com';
  await addOrgMember(seed, memberEmail);

  async function refused(): Promise<void> {
    const res = await page.goto(PAGE);
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: copy.title })).toHaveCount(0);
    await expect(page.locator('[data-testid^="capacity-"]')).toHaveCount(0);
    const api = await page.request.get(ROUTE);
    expect(api.status()).toBe(404);
    const body = (await api.json()) as Record<string, unknown>;
    for (const key of ['entries', 'alertShare', 'raised', 'capacity']) {
      expect(body).not.toHaveProperty(key);
    }
  }

  // The workspace owner first, then a plain member of the same organization.
  await refused();
  await page.context().clearCookies();
  await signIn(page, memberEmail, SHELL_PASSWORD);
  await refused();
});

test('the minutely job raises an alert with no page open', async () => {
  // Two fires at second 45, plus the worker's pick-up.
  test.setTimeout(150_000);
  await truncateJobTables();
  const since = new Date();
  patchCapacityEntry('deepseek', DEEPSEEK, {
    limits: { max_concurrency: { status: 'set', value: 5 } },
  });

  await expect
    .poll(async () => (await raisedRowsFor('deepseek', DEEPSEEK, 'max_concurrency')).length, {
      timeout: 140_000,
    })
    .toBe(1);
  await expect
    .poll(
      () =>
        adminDb.jobQueueRun.count({
          where: {
            jobId: 'system.capacity-alert-evaluation',
            state: 'succeeded',
            updatedAt: { gte: since },
          },
        }),
      { timeout: 140_000 },
    )
    .toBeGreaterThan(0);
});
