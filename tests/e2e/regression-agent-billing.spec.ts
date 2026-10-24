import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { signIn } from './_helpers/shell-session';
import { seedMyAgents, type MyAgentsSeed } from './_helpers/my-agents-seed';
import { paidOrgState, patchOrgBillingState, setOrgBillingState, TIERS } from './_helpers/billing';
import { pushAiIncludedSeat } from './_helpers/billing-push';
import { adminDb } from './_helpers/db-reset';
import en from '@/messages/en.json';

// AGENTS ARE AN AI-PLAN FEATURE, AND THEIR DISKS ARE PAID IN CREDITS (Story
// MOTIR-6914 · MOTIR-6924) — the story's verification recipe in the browser, and,
// for the happy path, its acceptance receipt.
//
// ── THE SEAMS ─────────────────────────────────────────────────────────────────
// No machine boots: the fleet is the persistent fake, as the My agents walk
// (`regression-my-agents.spec.ts`) has it. motir-ai is the lane's mock, and its
// billing FIXTURE is the ledger: the app server's machine debit
// (`lib/test-hosted-run-mock.ts`) and storage debit (`lib/test-billing-mock.ts`)
// both write the org's `agents` figures there, and `/v1/usage` reads them back —
// so the Agents line shows what was actually charged. Two things this walk makes
// happen that the product makes happen on a clock or a webhook:
//
//   * a charged DAY — `POST /api/_test/agent-instances/storage-charge` runs the
//     real hourly pass once (the worker's scheduled pass may beat it to the day,
//     so the walk reads the day's charge rows rather than the pass's count);
//   * the PLAN ENDING and COMING BACK — the seat push motir-ai's Stripe webhook
//     makes (`pushAiIncludedSeat`, the real internal route and its bearer), with
//     the fixture's subscription flipped to match, as Stripe's would be.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every step waits on the write's own response, or on the billing panel's own
// read, before asserting what the page shows — never on a timer. The `beat()`s
// are the reviewer's pauses, not synchronisation.

test.describe.configure({ timeout: 150_000 });

const copy = en.myAgents;
const billing = en.billing;

const rowOf = (page: Page, name: string): Locator =>
  page.getByRole('table').getByTestId('agent-row').filter({ hasText: name });

const instancesResponse = (page: Page, method: string, suffix = '') =>
  page.waitForResponse(
    (res) =>
      res.request().method() === method &&
      new URL(res.url()).pathname.match(/\/api\/projects\/[^/]+\/instances/) !== null &&
      new URL(res.url()).pathname.endsWith(suffix),
    { timeout: 45_000 },
  );

const billingRead = (page: Page, organizationId: string) =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname === `/api/organizations/${organizationId}/billing`,
    { timeout: 45_000 },
  );

async function goToMyAgents(page: Page): Promise<void> {
  await page.goto('/my-agents');
  await expect(page.getByRole('heading', { name: copy.title })).toBeVisible();
}

async function openCreate(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: copy.newAgent }).first().click();
  const dialog = page.getByRole('dialog', { name: copy.create.title });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function createAgent(page: Page, name: string, codingAgent: string): Promise<void> {
  const dialog = await openCreate(page);
  await dialog.getByLabel(copy.create.name).fill(name);
  await dialog.getByRole('radio', { name: new RegExp(`^${codingAgent}`) }).check();
  const created = instancesResponse(page, 'POST', '/instances');
  await dialog.getByRole('button', { name: copy.create.submit }).click();
  expect((await created).status()).toBe(201);
  await expect(dialog).toBeHidden();
  await backToList(page, name);
  await expect(rowOf(page, name)).toHaveAttribute('data-state', 'running');
}

/**
 * Create now opens the new agent's panel (Story MOTIR-7393); this walk reads the
 * list's table, so it closes the panel and returns to it. Navigation only.
 */
async function backToList(page: Page, name: string): Promise<void> {
  await page
    .getByRole('main')
    .getByTestId('agent-panel')
    .getByRole('button', { name: `Close ${name}` })
    .click();
  await expect(page.getByRole('table')).toBeVisible();
}

async function openMenu(page: Page, name: string): Promise<Locator> {
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  return page.getByRole('menu', { name: `Actions for ${name}` });
}

/** The deletion date as the page writes it: Billing & plans' format, in UTC. */
function asPageDate(iso: Date): string {
  return iso.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

test.describe('Agents are an AI-plan feature, paid in credits', () => {
  let seed: MyAgentsSeed;

  test('a Pro organization hosts two agents, sees their storage on Billing & plans, and a lapsed plan’s deletion dates clear when it re-subscribes', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6914');
    seed = await seedMyAgents(Date.now().toString(36));
    // A Pro plan, and an Agents ledger that starts at zero this month.
    setOrgBillingState(seed.organizationId, {
      ...paidOrgState({ tier: TIERS.pro, status: 'active' }),
      agents: { machine: 0, storage: 0 },
    });
    await signIn(page, seed.email, seed.password);

    await chapter(
      'My agents says what an agent costs: machine time while it runs, storage every day',
      async () => {
        await goToMyAgents(page);
        await expect(page.getByRole('main').getByText(copy.emptyBodyWithStorage)).toBeVisible();
        const dialog = await openCreate(page);
        await expect(dialog).toContainText('10 credits a day');
        await expect(dialog).toContainText('for its storage, running or hibernated');
        await beat();
        await dialog.getByRole('button', { name: copy.create.cancel }).click();
        await expect(dialog).toBeHidden();
      },
    );
    await beat();

    await chapter('Create two agents — a Claude Code and a Codex, both running', async () => {
      await createAgent(page, 'yue-claude', 'Claude Code');
      await createAgent(page, 'yue-codex', 'Codex');
      await expect(page.getByRole('table').getByTestId('agent-row')).toHaveCount(2);
    });
    await beat();

    await chapter(
      'Hibernate the Codex agent — its machine time is charged as it stops',
      async () => {
        const menu = await openMenu(page, 'yue-codex');
        const stopped = instancesResponse(page, 'POST', '/hibernate');
        await menu.getByRole('menuitem', { name: copy.menu.hibernate }).click();
        expect((await stopped).status()).toBe(200);
        await expect(rowOf(page, 'yue-codex')).toHaveAttribute('data-state', 'hibernated');
      },
    );
    await beat();

    await chapter('A day’s storage is charged — once per agent, running or asleep', async () => {
      const res = await page.request.post('/api/_test/agent-instances/storage-charge');
      expect(res.status()).toBe(200);
      // The DAY'S CHARGE ROWS are the authoritative state, not this pass's count
      // (MOTIR-7854). The lane's job worker runs the scheduler, and its own
      // `system.agent-instance-storage-charge` pass (cron :30, plus a catch-up
      // after every reset) can charge the day before this door does — charging is
      // idempotent per agent per day, so this pass then reports `charged: 0` for a
      // day that IS charged. Whichever pass wrote them, once this one has returned
      // every pending day is charged: two agents, one charged row each, today.
      const today = new Date(new Date().toISOString().slice(0, 10));
      const rows = await adminDb.agentInstanceStorageCharge.findMany({
        where: { organizationId: seed.organizationId, day: today },
        select: { agentInstanceId: true, chargeOutcome: true },
      });
      expect(rows.map((r) => r.chargeOutcome)).toEqual(['charged', 'charged']);
      expect(new Set(rows.map((r) => r.agentInstanceId)).size).toBe(2);
    });
    await beat();

    await chapter(
      'Billing & plans: the Agents line shows storage for two and machine time for the one that ran',
      async () => {
        const read = billingRead(page, seed.organizationId);
        await page.goto('/settings/organization/billing');
        const res = await read;
        expect(res.status()).toBe(200);
        const status = (await res.json()) as {
          agents: { spend: { machineMonthSpend: number; storageMonthSpend: number } | null };
        };
        const spend = status.agents.spend!;
        expect(spend.storageMonthSpend).toBe(20);
        expect(spend.machineMonthSpend).toBeGreaterThan(0);
        const line = page.getByRole('main').getByTestId('billing-agents-line');
        await line.scrollIntoViewIfNeeded();
        await expect(line).toContainText(billing.agents.name);
        await expect(line).toContainText(billing.agents.storageLabel);
        await expect(line).toContainText('20');
        await expect(line).toContainText(billing.agents.machineLabel);
        await expect(line).toContainText(String(spend.machineMonthSpend));
        await expect(line).toContainText(String(spend.machineMonthSpend + 20));
        await expect(line).toContainText(billing.agents.rate);
      },
    );
    await beat();

    await chapter(
      'The organization’s AI plan ends — every agent shows the date it will be deleted',
      async () => {
        patchOrgBillingState(seed.organizationId, {
          subscription: { ...paidOrgState({ tier: TIERS.pro }).subscription, status: 'canceled' },
        });
        await pushAiIncludedSeat(page, seed.organizationId, false);
        const org = await adminDb.organization.findUniqueOrThrow({
          where: { id: seed.organizationId },
        });
        expect(org.aiPlanLapsedAt).not.toBeNull();
        const lapse = org.aiPlanLapsedAt!;
        const deletesOn = new Date(
          Date.UTC(lapse.getUTCFullYear(), lapse.getUTCMonth(), lapse.getUTCDate() + 30),
        );
        const date = asPageDate(deletesOn);

        await goToMyAgents(page);
        const banner = page.getByRole('status').filter({ hasText: copy.lapse.bannerLead });
        await expect(banner).toContainText(
          `Your agents will be deleted on ${date} unless the plan is renewed.`,
        );
        await expect(banner.getByRole('link', { name: copy.lapse.renew })).toHaveAttribute(
          'href',
          '/settings/organization/billing',
        );
        for (const name of ['yue-claude', 'yue-codex']) {
          await expect(rowOf(page, name)).toContainText(`Will be deleted on ${date}`);
        }
        await beat();

        const menu = await openMenu(page, 'yue-codex');
        const wake = menu.getByRole('menuitem', { name: copy.menu.wake });
        await expect(wake).toHaveAttribute('aria-disabled', 'true');
        await expect(menu).toContainText('Agents need a paid AI plan');
        await expect(menu.getByRole('link', { name: 'Choose an AI plan' })).toBeVisible();
        await beat();
        await page.keyboard.press('Escape');
      },
    );
    await beat();

    await chapter('Re-subscribe before the date — the dates go, and Wake works again', async () => {
      patchOrgBillingState(seed.organizationId, {
        subscription: { ...paidOrgState({ tier: TIERS.pro }).subscription, status: 'active' },
      });
      await pushAiIncludedSeat(page, seed.organizationId, true);
      await goToMyAgents(page);
      await expect(page.getByRole('status').filter({ hasText: copy.lapse.bannerLead })).toHaveCount(
        0,
      );
      await expect(page.getByText(/Will be deleted on/)).toHaveCount(0);

      const menu = await openMenu(page, 'yue-codex');
      const woke = instancesResponse(page, 'POST', '/wake');
      await menu.getByRole('menuitem', { name: copy.menu.wake }).click();
      expect((await woke).status()).toBe(200);
      await expect(rowOf(page, 'yue-codex')).toHaveAttribute('data-state', 'running');
    });
  });

  test('a tracker-only organization’s member is told agents need an AI plan, with the way to get one', async ({
    page,
  }) => {
    seed = await seedMyAgents(Date.now().toString(36), { paidAiPlan: false });
    await signIn(page, seed.email, seed.password);
    await goToMyAgents(page);
    const dialog = await openCreate(page);
    await dialog.getByLabel(copy.create.name).fill('no-plan');
    const created = instancesResponse(page, 'POST', '/instances');
    await dialog.getByRole('button', { name: copy.create.submit }).click();
    const res = await created;
    expect(res.status()).toBe(402);
    expect(await res.json()).toMatchObject({ reason: 'ai_plan_required' });
    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText(copy.refusalTitle.aiPlanRequired);
    await expect(alert).toContainText('Agents need a paid AI plan.');
    await expect(alert.getByRole('link', { name: 'Choose an AI plan' })).toHaveAttribute(
      'href',
      '/settings/organization/billing',
    );
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('table').getByTestId('agent-row')).toHaveCount(0);
  });

  test('the Agents line while Billing & plans loads, and when its figures are unavailable', async ({
    page,
  }) => {
    seed = await seedMyAgents(Date.now().toString(36));
    // A paid org whose usage read carries NO agent blocks — the unavailable shape.
    setOrgBillingState(seed.organizationId, paidOrgState({ status: 'active' }));
    await signIn(page, seed.email, seed.password);

    // Hold the panel's own read, so its loading state is on screen, then let it go.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/organizations/${seed.organizationId}/billing`, async (route) => {
      await held;
      await route.continue();
    });
    const read = billingRead(page, seed.organizationId);
    await page.goto('/settings/organization/billing');
    await expect(page.getByRole('main').getByText(billing.states.loading)).toBeAttached();
    await expect(page.getByRole('main').getByTestId('billing-agents-line')).toHaveCount(0);
    release();
    expect((await read).status()).toBe(200);

    const line = page.getByRole('main').getByTestId('billing-agents-line');
    await expect(line).toContainText(billing.agents.unavailable);
    await expect(line.getByLabel(billing.agents.unavailableValue).first()).toBeVisible();
    await expect(line).not.toContainText(billing.agents.zero);
  });
});
