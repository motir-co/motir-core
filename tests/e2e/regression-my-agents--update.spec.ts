import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { signIn } from './_helpers/shell-session';
import {
  markVersionFailing,
  pinAgentToVersion,
  publishImage,
  readAgentHomeFile,
  recordRunInAgent,
  resetCatalog,
  seedMyAgents,
  setCatalogUnavailable,
  writeAgentHomeFile,
  type MyAgentsSeed,
} from './_helpers/my-agents-seed';
import en from '@/messages/en.json';

// UPDATE AN AGENT TO A NEWER SANDBOX IMAGE (Story MOTIR-6862 · MOTIR-6955) — the
// story's Verification in a browser on My agents and, for the happy path, its
// acceptance receipt.
//
// ── THE SEAMS ─────────────────────────────────────────────────────────────────
// No registry and no real machine: the catalog's newest version and its "could
// not check" answer live in `MOTIR_FAKE_IMAGE_CATALOG_PATH`, which the lane's
// webServer re-reads on every list (`lib/agentInstances/imageCatalog.ts`); the
// agent's image, the failing-liveness mark and the home's files live in the
// persistent fake fleet's shared state file. The update itself is the REAL route
// and the REAL lifecycle, moving the fake machine.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every step waits on the write's own response, then on what the page renders
// from its re-read of the list API (the row's `data-state`, its version) — never
// on a timer. The `beat()`s are the receipt's pacing, not synchronisation.

test.describe.configure({ timeout: 120_000 });

const copy = en.myAgents;
const HOME_FILE = 'workspace/notes.txt';

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

async function createAgent(page: Page, name: string): Promise<string> {
  await page.getByRole('button', { name: copy.newAgent }).first().click();
  const dialog = page.getByRole('dialog', { name: copy.create.title });
  await dialog.getByLabel(copy.create.name).fill(name);
  await dialog.getByRole('radio', { name: /^Claude Code/ }).check();
  const created = instancesResponse(page, 'POST', '/instances');
  await dialog.getByRole('button', { name: copy.create.submit }).click();
  const res = await created;
  expect(res.status()).toBe(201);
  await expect(dialog).toBeHidden();
  await backToList(page, name);
  // The boot now runs after the 201 (Story MOTIR-7393): wait for it to finish,
  // as the inline boot used to before Create answered.
  await expect(rowOf(page, name)).toHaveAttribute('data-state', 'running');
  return ((await res.json()) as { instance: { id: string } }).instance.id;
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

async function goToMyAgents(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'My agents' }).click();
  await expect(page.getByRole('heading', { name: copy.title })).toBeVisible();
}

/** Re-read the list the way a returning person does, waiting on its own response. */
async function reloadList(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByRole('heading', { name: copy.title })).toBeVisible();
}

/** Open an agent's panel and press Update; the confirmation is returned. */
async function pressUpdate(page: Page, name: string): Promise<Locator> {
  await rowOf(page, name).click();
  const panel = page.getByRole('region', { name: copy.panel.label, exact: true });
  await panel.getByRole('button', { name: copy.update.action, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Two agents: `yue-claude` on 0.4.0 with a file in its home, `yue-current` on 0.5.0. */
async function twoAgents(page: Page): Promise<{ old: string; current: string }> {
  await signIn(page, seed.email, seed.password);
  await goToMyAgents(page);
  const old = await createAgent(page, 'yue-claude');
  const current = await createAgent(page, 'yue-current');
  await pinAgentToVersion(old, '0.4.0');
  await pinAgentToVersion(current, '0.5.0');
  publishImage('claude', '0.5.0');
  await reloadList(page);
  return { old, current };
}

let seed: MyAgentsSeed;
test.beforeEach(async () => {
  seed = await seedMyAgents(Date.now().toString(36));
  resetCatalog();
});
test.afterAll(() => {
  resetCatalog();
});

test.describe('Update an agent to a newer image', () => {
  test('an agent on 0.4.0 updates to 0.5.0 and keeps its home; one on 0.5.0 is left alone', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6862');
    let ids = { old: '', current: '' };

    await chapter('0.5.0 is published: the agent on 0.4.0 says Update available', async () => {
      ids = await twoAgents(page);
      const old = rowOf(page, 'yue-claude');
      await expect(old.getByTestId('agent-version')).toHaveText('0.4.0');
      await expect(old.getByTestId('agent-update-available')).toHaveText(
        'Update available → 0.5.0',
      );
      const current = rowOf(page, 'yue-current');
      await expect(current.getByTestId('agent-version')).toHaveText('0.5.0');
      await expect(current.getByTestId('agent-update-available')).toHaveCount(0);
    });
    await beat();

    await chapter('Before updating, the home holds a file the owner wrote', async () => {
      await writeAgentHomeFile(ids.old, HOME_FILE, 'notes from before the update');
      expect(await readAgentHomeFile(ids.old, HOME_FILE)).toBe('notes from before the update');
    });

    await chapter('Update: the confirmation names both versions and what is kept', async () => {
      const dialog = await pressUpdate(page, 'yue-claude');
      await expect(dialog).toContainText('Update yue-claude to 0.5.0?');
      await expect(dialog).toContainText('Claude Code 0.4.0 → 0.5.0');
      await expect(dialog).toContainText(copy.update.confirm.keep2);
      await beat();
      const updated = instancesResponse(page, 'POST', '/update');
      await dialog.getByRole('button', { name: copy.update.confirm.running }).click();
      expect((await updated).status()).toBe(200);
      await expect(dialog).toBeHidden();
    });

    await chapter('The agent is back, running on 0.5.0 — the marker is gone', async () => {
      const panel = page.getByRole('region', { name: copy.panel.label, exact: true });
      await expect(panel.getByTestId('agent-version')).toHaveText('0.5.0');
      await expect(panel.getByTestId('agent-update-available')).toHaveCount(0);
      await expect(
        panel.getByRole('button', { name: copy.update.action, exact: true }),
      ).toHaveCount(0);
    });
    await beat();

    await chapter('The home kept its file, and the other agent is untouched', async () => {
      expect(await readAgentHomeFile(ids.old, HOME_FILE)).toBe('notes from before the update');
      await page.getByRole('button', { name: `Close yue-claude` }).click();
      await expect(rowOf(page, 'yue-current').getByTestId('agent-version')).toHaveText('0.5.0');
      await expect(rowOf(page, 'yue-claude')).toHaveAttribute('data-state', 'running');
    });
    await beat();
  });

  test('a failing 0.6.0 rolls back to 0.5.0, says why, and still offers 0.6.0', async ({
    page,
  }) => {
    const ids = await twoAgents(page);
    // Bring yue-claude to 0.5.0 first, then publish a broken 0.6.0.
    await pinAgentToVersion(ids.old, '0.5.0');
    publishImage('claude', '0.6.0');
    markVersionFailing('claude', '0.6.0');
    await reloadList(page);

    const dialog = await pressUpdate(page, 'yue-claude');
    const updated = instancesResponse(page, 'POST', '/update');
    await dialog.getByRole('button', { name: copy.update.confirm.running }).click();
    expect((await updated).status()).toBe(200);
    await expect(dialog).toBeHidden();

    const panel = page.getByRole('region', { name: copy.panel.label, exact: true });
    await expect(panel.getByTestId('agent-version')).toHaveText('0.5.0');
    await expect(panel.getByTestId('agent-update-failed')).toContainText(
      'The update to 0.6.0 didn’t work: claude --version exited 127',
    );
    await expect(panel.getByTestId('agent-update-failed')).toContainText(
      'Your agent is back on 0.5.0.',
    );
    await expect(panel.getByTestId('agent-update-available')).toHaveText(
      'Update available → 0.6.0',
    );
  });

  test('Update during a run is refused, naming the run', async ({ page }) => {
    const ids = await twoAgents(page);
    const key = await recordRunInAgent(seed, ids.old);
    await reloadList(page);

    const dialog = await pressUpdate(page, 'yue-claude');
    const refused = instancesResponse(page, 'POST', '/update');
    await dialog.getByRole('button', { name: copy.update.confirm.running }).click();
    expect((await refused).status()).toBe(409);
    const alert = dialog.getByRole('alert');
    await expect(alert).toHaveText(
      `yue-claude is running ${key}. Cancel that run on the work item first, then update it.`,
    );
    await expect(alert.getByRole('link', { name: key })).toBeVisible();
  });

  test('a registry that cannot be read says could not check — never up to date', async ({
    page,
  }) => {
    await twoAgents(page);
    setCatalogUnavailable(true);
    await reloadList(page);
    for (const name of ['yue-claude', 'yue-current']) {
      await expect(rowOf(page, name).getByTestId('agent-update-unknown')).toHaveText(
        copy.update.unknown,
      );
    }
  });
});
