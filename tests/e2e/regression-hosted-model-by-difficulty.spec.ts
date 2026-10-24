import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedHostedRun, type HostedRunSeed } from './_helpers/hosted-run-seed';
import { resetHostedRunJournal, writeHostedRunFixture } from './_helpers/hosted-run-boundary';
import { workItemsService } from '@/lib/services/workItemsService';

// A HOSTED RUN PICKS ITS MODEL FROM THE LEAF'S DIFFICULTY (Story MOTIR-6989 ·
// MOTIR-6998) — the story's acceptance receipt.
//
// The walk: the Hosted agent settings room shows the four levels on the platform
// default; Low is overridden and saved; Run hosted on a Low subtask preselects
// the override and says so; on a High subtask it preselects motir-ai's platform
// High model; Low is reset. It STOPS AT THE PICKER — no container is started
// (the start path is covered by its integration gate, MOTIR-6994).
//
// ── THE STUBBED SEAM ─────────────────────────────────────────────────────────
//
// The offered list, its single default and its per-level `defaultsByDifficulty`
// are motir-ai's (`GET /v1/agent-models`), answered in this lane by
// `lib/test-hosted-run-mock.ts` from the hosted-run fixture file. The first
// chapter asserts the settings read carries the fixture's own synthetic ids and
// per-level defaults before anything else, so a pass cannot be read against a
// real motir-ai or a vacuous answer.
//
// ── AUTHORITATIVE SIGNALS ────────────────────────────────────────────────────
//
// The room is a client island that reads on mount and applies its PATCH's
// response in place, so every assertion after a save or a load waits on that
// response (the PATCH's 200, the GET's 200) first; the picker's preselection is
// asserted only after the `/api/hosted-runs/models?workItem=<KEY>` read landed,
// and against that read's own `resolved` body.

const ROOM = '/settings/project/hosted-agent';

// The fixture's synthetic ids — never a real gateway model name.
const SWIFT = 'e2e-swift';
const BALANCED = 'e2e-balanced';
const DEEP = 'e2e-deep';
const CAREFUL = 'e2e-careful';

const LEVELS = ['Trivial', 'Low', 'Medium', 'High'] as const;

function fixture() {
  writeHostedRunFixture({
    models: {
      ids: [SWIFT, BALANCED, DEEP, CAREFUL],
      default: BALANCED,
      defaultsByDifficulty: { trivial: SWIFT, low: SWIFT, medium: BALANCED, high: DEEP },
    },
    mayRun: true,
  });
  resetHostedRunJournal();
}

/** One difficulty's row in the room, found by its own labelled select. */
const levelRow = (page: Page, level: (typeof LEVELS)[number]): Locator =>
  page
    .getByRole('main')
    .getByRole('listitem')
    .filter({ has: page.getByRole('combobox', { name: `Model for ${level}`, exact: true }) });

const levelSelect = (page: Page, level: (typeof LEVELS)[number]): Locator =>
  page.getByRole('main').getByRole('combobox', { name: `Model for ${level}`, exact: true });

const pickerTrigger = (page: Page): Locator =>
  page.getByRole('main').getByRole('combobox', { name: 'Model', exact: true });

function settingsRead(page: Page, projectKey: string, method: 'GET' | 'PATCH'): Promise<Response> {
  return page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/projects/${projectKey}/hosted-agent-settings`) &&
      res.request().method() === method,
    { timeout: 30_000 },
  );
}

function modelsRead(page: Page, itemKey: string): Promise<Response> {
  return page.waitForResponse(
    (res) =>
      res.url().includes('/api/hosted-runs/models') &&
      new URL(res.url()).searchParams.get('workItem') === itemKey &&
      res.request().method() === 'GET',
    { timeout: 30_000 },
  );
}

interface SettingsBody {
  offeredModels: string[];
  levels: { level: string; override: string | null; platformDefault: string | null }[];
}

interface ModelsBody {
  models: { id: string }[];
  resolved: { model: string; source: string; difficulty: string | null } | null;
}

async function seedLeaves(seed: HostedRunSeed) {
  const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };
  const story = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'story', title: 'Checkout speaks every currency' },
    ctx,
  );
  const leaf = async (title: string, difficulty: 'low' | 'high') => {
    const dto = await workItemsService.createWorkItem(
      { projectId: seed.projectId, kind: 'subtask', title, parentId: story.id, difficulty },
      ctx,
    );
    return { id: dto.id, identifier: dto.identifier };
  };
  return {
    low: await leaf('Rename the currency label', 'low'),
    high: await leaf('Reconcile rounding across ledgers', 'high'),
  };
}

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
  fixture();
});

test('a project overrides Low, Run hosted follows the difficulty, and Low is reset', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6989');

  const seed = await seedHostedRun(
    'hosted-difficulty@example.com',
    `HMD${Date.now().toString(36)}`,
  );
  const leaves = await seedLeaves(seed);
  await signIn(page, seed.email, seed.password);

  await chapter(
    'Project settings → Hosted agent: every level on the platform default',
    async () => {
      await page.goto('/settings/project');
      const read = settingsRead(page, seed.projectKey, 'GET');
      await page.getByRole('link', { name: 'Hosted agent', exact: true }).click();
      await page.waitForURL(`**${ROOM}`);
      const res = await read;
      expect(res.status()).toBe(200);
      const body = (await res.json()) as SettingsBody;
      // The stub answered: these ids and per-level defaults exist only in the fixture.
      expect(body.offeredModels).toEqual([SWIFT, BALANCED, DEEP, CAREFUL]);
      expect(body.levels.find((l) => l.level === 'low')?.platformDefault).toBe(SWIFT);
      expect(body.levels.find((l) => l.level === 'high')?.platformDefault).toBe(DEEP);
      expect(body.levels.every((l) => l.override === null)).toBe(true);

      await expect(page.getByRole('heading', { name: 'Hosted agent', level: 1 })).toBeVisible();
      for (const level of LEVELS) {
        await expect(levelRow(page, level)).toContainText('Platform default');
        await expect(levelRow(page, level)).not.toContainText('Override');
      }
      await expect(levelSelect(page, 'Low')).toContainText(SWIFT);
      await expect(levelSelect(page, 'High')).toContainText(DEEP);
    },
  );

  await chapter('Override Low, save, and see it persist across a reload', async () => {
    await levelSelect(page, 'Low').click();
    await page.getByRole('option').filter({ hasText: CAREFUL }).click();
    await expect(levelSelect(page, 'Low')).toContainText(CAREFUL);
    await beat();

    const saved = settingsRead(page, seed.projectKey, 'PATCH');
    await page.getByRole('main').getByRole('button', { name: 'Save changes' }).click();
    const res = await saved;
    expect(res.status()).toBe(200);
    const body = (await res.json()) as SettingsBody;
    expect(body.levels.find((l) => l.level === 'low')?.override).toBe(CAREFUL);
    await expect(levelRow(page, 'Low')).toContainText('Override');
    await beat();

    const reread = settingsRead(page, seed.projectKey, 'GET');
    await page.reload();
    expect((await reread).status()).toBe(200);
    await expect(levelSelect(page, 'Low')).toContainText(CAREFUL);
    await expect(levelRow(page, 'Low')).toContainText('Override');
    await expect(levelRow(page, 'High')).toContainText('Platform default');
  });

  await chapter('A Low subtask: Run hosted preselects the project override', async () => {
    const read = modelsRead(page, leaves.low.identifier);
    await page.goto(`/items/${leaves.low.identifier}`);
    const res = await read;
    expect(res.status()).toBe(200);
    const body = (await res.json()) as ModelsBody;
    expect(body.resolved).toMatchObject({ model: CAREFUL, source: 'override', difficulty: 'low' });

    await expect(pickerTrigger(page)).toContainText(CAREFUL);
    await expect(pickerTrigger(page)).toHaveAccessibleDescription('Project override for Low');
    await expect(
      page.getByRole('main').getByRole('button', { name: 'Run', exact: true }),
    ).toBeVisible();
  });

  await chapter('A High subtask: Run hosted preselects the platform High model', async () => {
    const read = modelsRead(page, leaves.high.identifier);
    await page.goto(`/items/${leaves.high.identifier}`);
    const res = await read;
    expect(res.status()).toBe(200);
    const body = (await res.json()) as ModelsBody;
    expect(body.resolved).toMatchObject({
      model: DEEP,
      source: 'platform_level',
      difficulty: 'high',
    });

    await expect(pickerTrigger(page)).toContainText(DEEP);
    await expect(pickerTrigger(page)).toHaveAccessibleDescription('From difficulty: High');
  });

  await chapter('Back in settings, reset Low to the platform default', async () => {
    const read = settingsRead(page, seed.projectKey, 'GET');
    await page.goto(ROOM);
    expect((await read).status()).toBe(200);
    await expect(levelRow(page, 'Low')).toContainText('Override');

    await levelRow(page, 'Low').getByRole('button', { name: 'Reset to default' }).click();
    await expect(levelSelect(page, 'Low')).toContainText(SWIFT);
    await beat();

    const saved = settingsRead(page, seed.projectKey, 'PATCH');
    await page.getByRole('main').getByRole('button', { name: 'Save changes' }).click();
    const res = await saved;
    expect(res.status()).toBe(200);
    const body = (await res.json()) as SettingsBody;
    expect(body.levels.find((l) => l.level === 'low')?.override).toBeNull();
    await expect(levelRow(page, 'Low')).toContainText('Platform default');
    await expect(levelRow(page, 'Low')).not.toContainText('Override');
  });
});
