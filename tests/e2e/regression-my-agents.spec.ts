import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { signIn } from './_helpers/shell-session';
import {
  failNextProvision,
  seedAgents,
  seedMyAgents,
  setCredits,
  type MyAgentsSeed,
} from './_helpers/my-agents-seed';
import en from '@/messages/en.json';

// MY AGENTS (Story MOTIR-6860 · MOTIR-6877) — the story's browser walk and, for
// the happy path, its acceptance receipt.
//
// ── THE SEAMS ─────────────────────────────────────────────────────────────────
// No real machine boots: the fleet is the PERSISTENT fake
// (`MOTIR_FLEET_ORCHESTRATOR=fake`), shared with the runner through
// `MOTIR_FAKE_PERSISTENT_STATE_PATH`, which is how a test arms a provider failure
// the webServer then meets. motir-ai's credit pre-flight and machine debit are the
// lane's mock (`lib/test-hosted-run-mock.ts`). The 30-minute idle window is closed
// through `POST /api/_test/agent-instances/idle`, which runs the REAL idle check
// with the lifecycle clock moved forward — the decision itself is not faked.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every step waits on the write's own response, then on the row's `data-state`,
// which the page renders from its re-read of the list API — never on a timer.
//
// ── THE CARD'S "ORGANISATION CAP" REFUSAL IS GONE ────────────────────────────
// `agent-instances.md` AMENDMENT 2 removed the per-organisation cap (credits decide
// how many agents an organisation runs). The personal limit — 10 agents a person
// may keep — is the cap a person meets, and it is what this spec asserts instead.

test.describe.configure({ timeout: 120_000 });

const copy = en.myAgents;

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

async function createAgent(page: Page, name: string, codingAgent: string): Promise<string> {
  await page.getByRole('button', { name: copy.newAgent }).first().click();
  const dialog = page.getByRole('dialog', { name: copy.create.title });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(copy.create.name).fill(name);
  await dialog.getByRole('radio', { name: new RegExp(`^${codingAgent}`) }).check();
  const created = instancesResponse(page, 'POST', '/instances');
  await dialog.getByRole('button', { name: copy.create.submit }).click();
  const res = await created;
  expect(res.status()).toBe(201);
  const { instance } = (await res.json()) as { instance: { id: string } };
  await expect(dialog).toBeHidden();
  await backToList(page, name);
  return instance.id;
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

async function goToMyAgents(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'My agents' }).click();
  await expect(page.getByRole('heading', { name: copy.title })).toBeVisible();
}

test.describe('My agents', () => {
  let seed: MyAgentsSeed;
  test.beforeEach(async () => {
    seed = await seedMyAgents(Date.now().toString(36));
  });

  test('create two agents, watch them idle into hibernation, wake one and delete the other', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6860');
    await signIn(page, seed.email, seed.password);

    await chapter('My agents is in the sidebar, right after Runs, and starts empty', async () => {
      await goToMyAgents(page);
      await expect(page.getByRole('heading', { name: copy.emptyTitle })).toBeVisible();
    });
    await beat();

    let claudeId = '';
    let codexId = '';
    await chapter('Create a Claude Code agent — it boots and runs', async () => {
      claudeId = await createAgent(page, 'yue-claude', 'Claude Code');
      await expect(rowOf(page, 'yue-claude')).toHaveAttribute('data-state', 'running');
    });
    await beat();

    await chapter('Create a Codex agent — two rows, both running', async () => {
      codexId = await createAgent(page, 'yue-codex', 'Codex');
      await expect(rowOf(page, 'yue-codex')).toHaveAttribute('data-state', 'running');
      await expect(page.getByRole('table').getByTestId('agent-row')).toHaveCount(2);
    });
    await beat();

    await chapter('Thirty quiet minutes later, both hibernate on their own', async () => {
      const res = await page.request.post('/api/_test/agent-instances/idle', {
        data: { instanceIds: [claudeId, codexId], advanceMinutes: 31 },
      });
      expect(await res.json()).toEqual({ results: { [claudeId]: 'idle', [codexId]: 'idle' } });
      // The reload's server-rendered first read is the authoritative state — it
      // follows the idle door's own response, so it cannot race the stop.
      await page.reload();
      for (const name of ['yue-claude', 'yue-codex']) {
        await expect(rowOf(page, name)).toHaveAttribute('data-state', 'hibernated');
        await expect(rowOf(page, name)).toContainText(copy.stop.idle);
      }
    });
    await beat();

    await chapter('Wake the Claude Code agent — a fresh machine on its home', async () => {
      const menu = await openMenu(page, 'yue-claude');
      const woke = instancesResponse(page, 'POST', '/wake');
      await menu.getByRole('menuitem', { name: copy.menu.wake }).click();
      expect((await woke).status()).toBe(200);
      await expect(rowOf(page, 'yue-claude')).toHaveAttribute('data-state', 'running');
    });
    await beat();

    await chapter('Delete the Codex agent — the confirmation says what goes with it', async () => {
      const menu = await openMenu(page, 'yue-codex');
      await menu.getByRole('menuitem', { name: copy.menu.delete }).click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toContainText(copy.delete.lose3);
      await beat();
      const deleted = instancesResponse(page, 'DELETE');
      await confirm.getByRole('button', { name: copy.delete.confirm }).click();
      expect((await deleted).status()).toBe(204);
      await expect(rowOf(page, 'yue-codex')).toHaveCount(0);
      await expect(rowOf(page, 'yue-claude')).toHaveAttribute('data-state', 'running');
    });
  });

  test('no credits refuses create and wake, in words', async ({ page }) => {
    await signIn(page, seed.email, seed.password);
    await goToMyAgents(page);
    const id = await createAgent(page, 'yue-claude', 'Claude Code');
    // The boot runs after the 201 (Story MOTIR-7393): the idle check needs it running.
    await expect(rowOf(page, 'yue-claude')).toHaveAttribute('data-state', 'running');
    await page.request.post('/api/_test/agent-instances/idle', {
      data: { instanceIds: [id], advanceMinutes: 31 },
    });
    setCredits(false);

    // Wake: refused above the list.
    await page.reload();
    const menu = await openMenu(page, 'yue-claude');
    const woke = instancesResponse(page, 'POST', '/wake');
    await menu.getByRole('menuitem', { name: copy.menu.wake }).click();
    expect((await woke).status()).toBe(402);
    const refusal = page.getByRole('alert').filter({ hasText: 'credits' });
    await expect(refusal).toContainText('Your organization is out of credits.');
    await expect(refusal.getByRole('link', { name: 'Add credits' })).toHaveAttribute(
      'href',
      '/settings/organization/billing',
    );

    // Create: refused inside the dialog, which stays open.
    await page.getByRole('button', { name: copy.newAgent }).first().click();
    const dialog = page.getByRole('dialog', { name: copy.create.title });
    await dialog.getByLabel(copy.create.name).fill('another');
    const created = instancesResponse(page, 'POST', '/instances');
    await dialog.getByRole('button', { name: copy.create.submit }).click();
    expect((await created).status()).toBe(402);
    await expect(dialog.getByRole('alert')).toContainText('Your organization is out of credits.');
  });

  test('a viewer sees no door and the page refuses them', async ({ page }) => {
    await signIn(page, seed.viewerEmail, seed.password);
    await expect(page.getByRole('link', { name: 'Runs' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'My agents' })).toHaveCount(0);
    const res = await page.goto('/my-agents');
    expect(res?.status()).toBe(404);
  });

  test('the personal limit refuses the eleventh agent', async ({ page }) => {
    await seedAgents(seed, 10);
    await signIn(page, seed.email, seed.password);
    await goToMyAgents(page);
    await page.getByRole('button', { name: copy.newAgent }).first().click();
    const dialog = page.getByRole('dialog', { name: copy.create.title });
    await dialog.getByLabel(copy.create.name).fill('eleven');
    const created = instancesResponse(page, 'POST', '/instances');
    await dialog.getByRole('button', { name: copy.create.submit }).click();
    expect((await created).status()).toBe(429);
    await expect(dialog.getByRole('alert')).toContainText(
      // The seed's plan is Max ×2: 10 agents per person (MOTIR-9374 · MOTIR-9376).
      'Your organization’s Max ×2 plan allows 10 agents per person. Each one is charged for its storage every day, even asleep. Delete one to create another.',
    );
  });

  test('a provider failure shows the agent failed, with its reason and the way out', async ({
    page,
  }) => {
    await signIn(page, seed.email, seed.password);
    await goToMyAgents(page);
    failNextProvision('no capacity in the region');
    await createAgent(page, 'unlucky', 'Claude Code');
    const row = rowOf(page, 'unlucky');
    await expect(row).toHaveAttribute('data-state', 'failed');
    await expect(row).toContainText('no capacity in the region');
    await expect(row).toContainText(copy.failedWayOut);
  });
});
