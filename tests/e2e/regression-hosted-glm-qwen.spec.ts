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

// A HOSTED RUN CAN BE SERVED BY GLM AND QWEN (Story MOTIR-4332 · MOTIR-7246) — the
// story's acceptance receipt.
//
// The walk: Run hosted on a card lists `glm-4.6` with `z-ai` and `qwen-plus` with
// `qwen` beside it, next to the Claude rows (`anthropic`) and DeepSeek; the card
// opens on its Claude difficulty default, as before, and neither new model is ever
// preselected; choosing GLM and pressing Run starts a run whose container is handed
// `MOTIR_MODEL=z-ai/glm-4.6` and whose key is minted for the BARE id. The other
// cases: the same press on Qwen (`qwen/qwen-plus`); GLM withdrawn under a selected
// picker is the existing *model not offered* refusal, with nothing booted.
//
// `z-ai` and `qwen` are the CATALOG's provider ids, not OpenCode's own bundled
// `zai` / `zhipuai` / `alibaba` (which point at the vendors' hosts) — the egress
// contract §2 as amended by MOTIR-7243 enables exactly these two.
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
const GLM = 'glm-4.6';
const QWEN = 'qwen-plus';
const ALL = [OPUS, SONNET, DEEPSEEK, GLM, QWEN];

function fixture(ids: string[] = ALL): void {
  writeHostedRunFixture({
    models: {
      ids,
      default: OPUS,
      defaultsByDifficulty: { trivial: SONNET, low: SONNET, medium: OPUS, high: OPUS },
      providers: { [DEEPSEEK]: 'deepseek', [GLM]: 'z-ai', [QWEN]: 'qwen' },
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

test('Run hosted lists GLM and Qwen with their providers and starts a run on z-ai/glm-4.6', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-4332');

  const seed = await seedHostedRun('hosted-glm-qwen@example.com', `HGQ${Date.now().toString(36)}`);
  const leaf = await card(seed, 'Summarise the support backlog');
  await signIn(page, seed.email, seed.password);

  await chapter('Run hosted lists GLM and Qwen beside Claude and DeepSeek', async () => {
    const body = await openCard(page, leaf.identifier);
    // The stub answered: all four providers, each entry carrying its own.
    expect(body.models).toEqual([
      { id: OPUS, provider: 'anthropic' },
      { id: SONNET, provider: 'anthropic' },
      { id: DEEPSEEK, provider: 'deepseek' },
      { id: GLM, provider: 'z-ai' },
      { id: QWEN, provider: 'qwen' },
    ]);

    await modelCombobox(page).click();
    await expect(page.getByRole('option').filter({ hasText: GLM })).toContainText('z-ai');
    await beat();
    await expect(page.getByRole('option').filter({ hasText: QWEN })).toContainText('qwen');
    await beat();
    await expect(page.getByRole('option').filter({ hasText: DEEPSEEK })).toContainText('deepseek');
    await expect(page.getByRole('option').filter({ hasText: OPUS })).toContainText('anthropic');
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

  await chapter('Choose GLM and press Run: the fleet is handed z-ai/glm-4.6', async () => {
    await modelCombobox(page).click();
    await page.getByRole('option').filter({ hasText: GLM }).click();
    await expect(modelCombobox(page)).toContainText(GLM);
    await beat();

    const { mint, env } = await pressRun(page, leaf.identifier);
    expect(mint.models).toEqual([GLM]);
    expect(env['MOTIR_MODEL']).toBe(`z-ai/${GLM}`);
    await expect(page.getByRole('main').getByTestId('hosted-run')).toContainText(GLM);
  });
});

test('the same press on Qwen hands the fleet qwen/qwen-plus, the key bare', async ({ page }) => {
  const seed = await seedHostedRun('hosted-qwen@example.com', `HQW${Date.now().toString(36)}`);
  const leaf = await card(seed, 'Draft the release notes');
  await signIn(page, seed.email, seed.password);

  await openCard(page, leaf.identifier);
  await modelCombobox(page).click();
  await page.getByRole('option').filter({ hasText: QWEN }).click();
  await expect(modelCombobox(page)).toContainText(QWEN);

  const { mint, env } = await pressRun(page, leaf.identifier);
  expect(mint.models).toEqual([QWEN]);
  expect(env['MOTIR_MODEL']).toBe(`qwen/${QWEN}`);
  await expect(page.getByRole('main').getByTestId('hosted-run')).toContainText(QWEN);
});

test('neither GLM nor Qwen is preselected: a High card opens on Claude and runs on it', async ({
  page,
}) => {
  const seed = await seedHostedRun('hosted-gq-claude@example.com', `HGC${Date.now().toString(36)}`);
  const leaf = await card(seed, 'Tidy the ledger export', 'high');
  await signIn(page, seed.email, seed.password);

  const body = await openCard(page, leaf.identifier);
  expect(body.resolved).toMatchObject({ model: OPUS, source: 'platform_level' });
  await expect(modelCombobox(page)).toContainText(OPUS);

  const { mint, env } = await pressRun(page, leaf.identifier);
  expect(mint.models).toEqual([OPUS]);
  expect(env['MOTIR_MODEL']).toBe(`anthropic/${OPUS}`);
});

test('GLM withdrawn under a selected picker is the model-not-offered refusal, nothing booted', async ({
  page,
}) => {
  const seed = await seedHostedRun(
    'hosted-glm-withdrawn@example.com',
    `HGW${Date.now().toString(36)}`,
  );
  const leaf = await card(seed, 'Rename the currency label');
  await signIn(page, seed.email, seed.password);

  await openCard(page, leaf.identifier);
  await modelCombobox(page).click();
  await page.getByRole('option').filter({ hasText: GLM }).click();
  await expect(modelCombobox(page)).toContainText(GLM);

  const before = fakeContainerCount();
  fixture([OPUS, SONNET, DEEPSEEK, QWEN]);
  const started = startPost(page, leaf.identifier);
  await page.getByRole('main').getByTestId('run-hosted').click();
  expect((await started).status()).toBe(422);

  await expect(page.getByRole('main').getByTestId('hosted-refused-modelNotOffered')).toContainText(
    GLM,
  );
  expect(fakeContainerCount()).toBe(before);
  expect(readHostedRunJournal().some((e) => e.type === 'gateway_mint')).toBe(false);
});
