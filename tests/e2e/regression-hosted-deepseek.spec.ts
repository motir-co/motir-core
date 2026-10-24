import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedHostedRun, type HostedRunSeed } from './_helpers/hosted-run-seed';
import {
  fakeContainerCount,
  fakeContainerForRun,
  readHostedRunJournal,
  resetHostedRunJournal,
  writeHostedRunFixture,
} from './_helpers/hosted-run-boundary';
import { workItemsService } from '@/lib/services/workItemsService';

// A HOSTED RUN CAN BE SERVED BY DEEPSEEK (Story MOTIR-7205 · MOTIR-7211) — the
// story's acceptance receipt.
//
// The walk: Run hosted on a card lists `deepseek-v4-pro` with `deepseek` beside
// it, next to the Claude rows with `anthropic`; the card opens on its Claude
// difficulty default, as before; choosing DeepSeek and pressing Run starts a run
// whose container is handed `MOTIR_MODEL=deepseek/deepseek-v4-pro` and whose key
// is minted for the BARE id. The other cases: the same press on Claude is
// unchanged; a project whose High override names DeepSeek (MOTIR-6989's
// per-project override — the re-plan after the MOTIR-3687 gate) opens on DeepSeek
// and runs on it; DeepSeek withdrawn under a selected picker is the existing
// *model not offered* refusal, with nothing booted.
//
// ── THE STUBBED SEAMS ─────────────────────────────────────────────────────────
//
// motir-ai's offered list (with each entry's PROVIDER), the credit pre-flight and
// the gateway's run-key mint are `lib/test-hosted-run-mock.ts`, answered from the
// hosted-run fixture file and journalled. The fleet is the fake orchestrator,
// whose shared container-state file carries the launcher env each run booted
// with. Every test reads the stub's own answer before asserting anything else, so
// a pass cannot be read against a real outbound call.
//
// ── AUTHORITATIVE SIGNALS ────────────────────────────────────────────────────
//
// The picker's preselection is asserted after `/api/hosted-runs/models?workItem=`
// landed and against its `resolved` body; a start against the POST's own status;
// the key and the env against the mint journal and the fake container's spec,
// read only after that response — never against the UI alone.

test.describe.configure({ timeout: 120_000 });

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const DEEPSEEK = 'deepseek-v4-pro';

function fixture(ids: string[] = [OPUS, SONNET, DEEPSEEK]): void {
  writeHostedRunFixture({
    models: {
      ids,
      default: OPUS,
      defaultsByDifficulty: { trivial: SONNET, low: SONNET, medium: OPUS, high: OPUS },
      providers: { [DEEPSEEK]: 'deepseek' },
    },
    mayRun: true,
  });
}

const modelCombobox = (page: Page): Locator =>
  page.getByRole('main').getByRole('combobox', { name: 'Model', exact: true });

function modelsRead(page: Page, itemKey: string): Promise<Response> {
  return page.waitForResponse(
    (res) =>
      res.url().includes('/api/hosted-runs/models') &&
      new URL(res.url()).searchParams.get('workItem') === itemKey &&
      res.request().method() === 'GET',
    { timeout: 30_000 },
  );
}

function startPost(page: Page, itemKey: string): Promise<Response> {
  return page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/work-items/${itemKey}/hosted-runs`) &&
      res.request().method() === 'POST',
    { timeout: 30_000 },
  );
}

interface ModelsBody {
  models: { id: string; provider: string }[];
  resolved: { model: string; source: string; difficulty: string | null } | null;
}

/** A ready leaf at a difficulty — the project's created repository is its fallback pin. */
async function card(seed: HostedRunSeed, title: string, difficulty: 'low' | 'high' = 'low') {
  const dto = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title, difficulty },
    { userId: seed.userId, workspaceId: seed.workspaceId },
  );
  return { id: dto.id, identifier: dto.identifier };
}

/** Open the card and answer its picker read. */
async function openCard(page: Page, itemKey: string): Promise<ModelsBody> {
  const read = modelsRead(page, itemKey);
  await page.goto(`/items/${itemKey}`);
  const res = await read;
  expect(res.status()).toBe(200);
  await expect(page.getByRole('main').getByTestId('run-hosted-door')).toBeVisible();
  return (await res.json()) as ModelsBody;
}

/** Press Run; answer the run the boot recorded — its env, and the key minted for it. */
async function pressRun(page: Page, itemKey: string) {
  const mintsBefore = readHostedRunJournal().filter((e) => e.type === 'gateway_mint').length;
  const started = startPost(page, itemKey);
  await page.getByRole('main').getByTestId('run-hosted').click();
  expect((await started).status()).toBe(201);
  const mints = readHostedRunJournal().filter(
    (e): e is Extract<typeof e, { type: 'gateway_mint' }> => e.type === 'gateway_mint',
  );
  expect(mints.length).toBe(mintsBefore + 1);
  const mint = mints.at(-1)!;
  const container = fakeContainerForRun(mint.runRef);
  expect(container, 'the run booted one container').toBeTruthy();
  return { mint, env: container!.spec.env ?? {} };
}

test.beforeEach(async () => {
  await resetDatabase();
  fixture();
  resetHostedRunJournal();
});

test('Run hosted lists DeepSeek with its provider and starts a run on deepseek/deepseek-v4-pro', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7205');

  const seed = await seedHostedRun('hosted-deepseek@example.com', `HDS${Date.now().toString(36)}`);
  const leaf = await card(seed, 'Translate the checkout receipts');
  await signIn(page, seed.email, seed.password);

  await chapter('Run hosted lists DeepSeek beside Claude, each with its provider', async () => {
    const body = await openCard(page, leaf.identifier);
    // The stub answered: the mixed list, each entry carrying its own provider.
    expect(body.models).toEqual([
      { id: OPUS, provider: 'anthropic' },
      { id: SONNET, provider: 'anthropic' },
      { id: DEEPSEEK, provider: 'deepseek' },
    ]);

    await modelCombobox(page).click();
    await expect(page.getByRole('option').filter({ hasText: DEEPSEEK })).toContainText('deepseek');
    await expect(page.getByRole('option').filter({ hasText: SONNET })).toContainText('anthropic');
    await page.keyboard.press('Escape');
  });
  await beat();

  await chapter('The card still opens on its Claude difficulty default', async () => {
    const body = await openCard(page, leaf.identifier);
    expect(body.resolved).toMatchObject({
      model: SONNET,
      source: 'platform_level',
      difficulty: 'low',
    });
    await expect(modelCombobox(page)).toContainText(SONNET);
    await expect(modelCombobox(page)).toHaveAccessibleDescription('From difficulty: Low');
  });
  await beat();

  await chapter('Choose DeepSeek and press Run: the fleet is handed deepseek/<id>', async () => {
    await modelCombobox(page).click();
    await page.getByRole('option').filter({ hasText: DEEPSEEK }).click();
    await expect(modelCombobox(page)).toContainText(DEEPSEEK);

    const { mint, env } = await pressRun(page, leaf.identifier);
    expect(mint.models).toEqual([DEEPSEEK]);
    expect(env['MOTIR_MODEL']).toBe(`deepseek/${DEEPSEEK}`);
    await expect(page.getByRole('main').getByTestId('hosted-run')).toContainText(DEEPSEEK);
  });
});

test('the same press on Claude is unchanged: anthropic/<id>, the key bare', async ({ page }) => {
  const seed = await seedHostedRun('hosted-ds-claude@example.com', `HDC${Date.now().toString(36)}`);
  const leaf = await card(seed, 'Tidy the ledger export', 'high');
  await signIn(page, seed.email, seed.password);

  const body = await openCard(page, leaf.identifier);
  expect(body.resolved).toMatchObject({ model: OPUS, source: 'platform_level' });
  await expect(modelCombobox(page)).toContainText(OPUS);

  const { mint, env } = await pressRun(page, leaf.identifier);
  expect(mint.models).toEqual([OPUS]);
  expect(env['MOTIR_MODEL']).toBe(`anthropic/${OPUS}`);
});

test('a project whose High override names DeepSeek opens a High card on it and runs on it', async ({
  page,
}) => {
  const seed = await seedHostedRun(
    'hosted-ds-override@example.com',
    `HDO${Date.now().toString(36)}`,
  );
  const leaf = await card(seed, 'Reconcile rounding across ledgers', 'high');
  await signIn(page, seed.email, seed.password);

  // The override through the settings room's own route (the room itself is
  // MOTIR-6989's receipt).
  const saved = await page.request.patch(`/api/projects/${seed.projectKey}/hosted-agent-settings`, {
    data: { high: DEEPSEEK },
  });
  expect(saved.status()).toBe(200);

  const body = await openCard(page, leaf.identifier);
  expect(body.resolved).toMatchObject({ model: DEEPSEEK, source: 'override', difficulty: 'high' });
  await expect(modelCombobox(page)).toContainText(DEEPSEEK);
  await expect(modelCombobox(page)).toHaveAccessibleDescription('Project override for High');

  const { mint, env } = await pressRun(page, leaf.identifier);
  expect(mint.models).toEqual([DEEPSEEK]);
  expect(env['MOTIR_MODEL']).toBe(`deepseek/${DEEPSEEK}`);
});

test('DeepSeek withdrawn under a selected picker is the model-not-offered refusal, nothing booted', async ({
  page,
}) => {
  const seed = await seedHostedRun(
    'hosted-ds-withdrawn@example.com',
    `HDW${Date.now().toString(36)}`,
  );
  const leaf = await card(seed, 'Rename the currency label');
  await signIn(page, seed.email, seed.password);

  await openCard(page, leaf.identifier);
  await modelCombobox(page).click();
  await page.getByRole('option').filter({ hasText: DEEPSEEK }).click();
  await expect(modelCombobox(page)).toContainText(DEEPSEEK);

  const before = fakeContainerCount();
  fixture([OPUS, SONNET]);
  const started = startPost(page, leaf.identifier);
  await page.getByRole('main').getByTestId('run-hosted').click();
  expect((await started).status()).toBe(422);

  await expect(page.getByRole('main').getByTestId('hosted-refused-modelNotOffered')).toContainText(
    DEEPSEEK,
  );
  expect(fakeContainerCount()).toBe(before);
  expect(readHostedRunJournal().some((e) => e.type === 'gateway_mint')).toBe(false);
});
