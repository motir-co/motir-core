import { randomUUID } from 'node:crypto';
import type { Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedHostedRun, seedReadyHostedCard, type HostedRunSeed } from './_helpers/hosted-run-seed';
import {
  fakeContainerCount,
  readHostedRunJournal,
  resetHostedRunJournal,
  writeHostedRunFixture,
} from './_helpers/hosted-run-boundary';
import { patchCapacityEntry, seedCapacityFake, setCapacityMode } from './_helpers/capacity-fake';
import {
  CAPACITY_LIMIT_UNITS,
  type CapacityLimitUnit,
  type CapacityProvider,
} from '@/lib/capacity/alertKeys';
import type { CapacityEntry, CapacityLimit, LaneUsage } from '@/lib/gateway/capacityClient';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// A MODEL WITH NO AGENT-RUN CAPACITY IS LABELLED IN THE PICKER AND REFUSED AT
// LAUNCH (Story MOTIR-9541 · MOTIR-9632) — the story's acceptance receipt. A
// tenant member opens a card's Run hosted picker while the gateway reports one
// model's agent share full: it is labelled and cannot be picked, and a direct
// start for it is refused with the reason the label stands for. The share frees
// and the label clears with no reload, and the model launches. A provider's 429s
// label a second model, and it clears once the 429 window passes. An unreachable
// gateway labels nothing and still launches. Last, the picker and a stale tab's
// refusal read in Chinese.
//
// Recipe step 4 (finish a run) is played by lowering the fake's agent usage —
// the same change a finished run makes, because the verdict reads only the
// gateway's counters.
//
// ── WHAT STANDS IN FOR WHAT ───────────────────────────────────────────────────
// The lane has no gateway. Its capacity fake (`lib/gateway/capacityFakeState.ts`,
// MOTIR-9617) is one file the web server re-reads on every call, so the spec
// changes what the gateway "says" by patching it (`_helpers/capacity-fake.ts`).
// motir-ai's offered models, the run-key mint and GitHub are
// `lib/test-hosted-run-mock.ts`. The lane shortens the verdict's cache to 1 s and
// its 429 window to 8 s (`playwright.acceptance.config.ts`).
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every press arms its own response first. A label change waits on the picker's
// quiet re-read (every 5 s while the page is visible) whose body already carries
// the expected verdict, or on an `expect.poll` of the option's `aria-disabled`.
// The verdict's cache and 429 stamp are per-process memory, and this production
// build may give each route bundle its own copy, so the picker and the start
// route are compared only on the share-full state, which both read from the file.
// `chapter()` and `beat()` are pacing, never synchronisation.

test.describe.configure({ timeout: 300_000 });

const OPEN = 'e2e-cap-open';
const FULL = 'e2e-cap-full';
const HOT = 'e2e-cap-429';
/** The offered model → its provider at motir-ai and at the gateway (the verdict's frozen map). */
const PROVIDERS = { [OPEN]: 'anthropic', [FULL]: 'anthropic', [HOT]: 'deepseek' } as const;
const GATEWAY_PROVIDER: Record<string, CapacityProvider> = {
  anthropic: 'claude',
  deepseek: 'deepseek',
};

/**
 * Distinctive figures that hold no verdict, so a leak into a payload is unmistakable.
 * Each agent figure sits under its agent share (the limit less the 25% planning share:
 * rpm 64,815, tpm 73,148), so only `max_concurrency` ever decides a verdict here.
 */
const SENTINELS = { rpm: 86_421, agentRpm: 46_813, tpm: 97_531, agentTokens: 35_319 };
/** The quiet re-read, the cache and the 429 window, with room to spare. */
const LABEL_CHANGE_MS = 30_000;

const picker = en.runs.hosted.picker;
const zhPicker = zh.runs.hosted.picker;
const zhRefused = zh.runs.hosted.refused.noCapacity;

const fill = (message: string, values: Record<string, string>): string =>
  message.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);

function lane(inFlight: number): LaneUsage {
  return {
    inFlight,
    requestsPerMinute: SENTINELS.agentRpm,
    tokensPerMinute: SENTINELS.agentTokens,
    tokensPerDay: SENTINELS.agentTokens,
    rateLimited429: { minute: 0, day: 0 },
  };
}

/** One model's row: `max_concurrency` 4 with a planning share of 25, so the agent's share is 3. */
function entry(model: keyof typeof PROVIDERS, agentInFlight: number): CapacityEntry {
  const limits = {} as Record<CapacityLimitUnit, CapacityLimit>;
  for (const unit of CAPACITY_LIMIT_UNITS) limits[unit] = { status: 'not_applicable' };
  limits.max_concurrency = { status: 'set', value: 4 };
  limits.rpm = { status: 'set', value: SENTINELS.rpm };
  limits.tpm = { status: 'set', value: SENTINELS.tpm };
  return {
    provider: GATEWAY_PROVIDER[PROVIDERS[model]]!,
    model,
    tierNote: 'E2E capacity tier',
    unknownNote: '',
    planningSharePercent: 25,
    limits,
    lanes: { planning: lane(0), agent: lane(agentInFlight) },
    providerHint: null,
  };
}

const setFullInFlight = (inFlight: number) =>
  patchCapacityEntry('claude', FULL, { lanes: { agent: { inFlight } } });
const set429 = (minute: number) =>
  patchCapacityEntry('deepseek', HOT, {
    lanes: { agent: { rateLimited429: { minute, day: minute } } },
  });

// ── the page ─────────────────────────────────────────────────────────────────

type Capacity = { verdict: 'available' } | { verdict: 'no_capacity'; reason: string };
interface ModelsBody {
  models: Array<{ id: string; provider: string; capacity: Capacity }>;
}

const main = (page: Page): Locator => page.getByRole('main');
/** The picker's trigger, by its label in either locale the walk reads. */
const modelCombobox = (page: Page): Locator =>
  main(page).getByRole('combobox', {
    name: new RegExp(`^(${picker.label}|${zhPicker.label})$`),
  });
const option = (page: Page, model: string): Locator =>
  page.getByRole('option').filter({ hasText: model });
const tagOf = (page: Page, model: string): Locator =>
  option(page, model).getByTestId('hosted-no-capacity-tag');

const capacityIn = (body: ModelsBody, model: string) =>
  body.models.find((m) => m.id === model)?.capacity;

/** The next picker read, once its body says what `expected` checks. Arm it BEFORE the change. */
function modelsRead(
  page: Page,
  expected: (body: ModelsBody) => boolean = () => true,
): Promise<Response> {
  return page.waitForResponse(
    async (res) => {
      if (new URL(res.url()).pathname !== '/api/hosted-runs/models') return false;
      if (res.request().method() !== 'GET' || res.status() !== 200) return false;
      return expected((await res.json()) as ModelsBody);
    },
    { timeout: LABEL_CHANGE_MS },
  );
}

const holds = (model: string, verdict: Capacity['verdict']) => (body: ModelsBody) =>
  capacityIn(body, model)?.verdict === verdict;

const startResponse = (page: Page, itemKey: string) =>
  page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/work-items/${itemKey}/hosted-runs`) &&
      res.request().method() === 'POST',
    { timeout: 60_000 },
  );

/** Open a card's page and wait for its first picker read; answers that read's body. */
async function openCard(page: Page, itemKey: string): Promise<{ body: ModelsBody; text: string }> {
  const read = modelsRead(page);
  await page.goto(`/items/${itemKey}`);
  const res = await read;
  await expect(main(page).getByTestId('run-hosted-door')).toBeVisible({ timeout: FIRST_PAINT_MS });
  const text = await res.text();
  return { body: JSON.parse(text) as ModelsBody, text };
}

async function openMenu(page: Page): Promise<void> {
  await modelCombobox(page).click();
  await expect(option(page, OPEN)).toBeVisible();
}

/** Pick `model` from the open menu and press Run; the start answers 201 and the run panel shows. */
async function launch(page: Page, itemKey: string, model: string): Promise<void> {
  await option(page, model).click();
  await expect(modelCombobox(page)).toContainText(model);
  const started = startResponse(page, itemKey);
  await main(page).getByTestId('run-hosted').click();
  expect((await started).status()).toBe(201);
  await expect(main(page).getByTestId('hosted-run')).toBeVisible();
}

/** No option carries the tag, and the door draws neither held line. */
async function expectNothingHeld(page: Page): Promise<void> {
  for (const model of [OPEN, FULL, HOT]) {
    await expect(option(page, model)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(tagOf(page, model)).toHaveCount(0);
  }
  await expect(main(page).getByTestId('hosted-held-line')).toHaveCount(0);
  await expect(main(page).getByTestId('hosted-models-all-held')).toHaveCount(0);
}

const gatewayMints = () => readHostedRunJournal().filter((e) => e.type === 'gateway_mint');

test.beforeEach(async () => {
  await resetDatabase();
  writeHostedRunFixture({
    models: { ids: [OPEN, FULL, HOT], default: OPEN, providers: PROVIDERS },
    mayRun: true,
  });
  resetHostedRunJournal();
  seedCapacityFake({
    mode: 'live',
    scope: 'shared',
    entries: [entry(OPEN, 0), entry(FULL, 3), entry(HOT, 0)],
  });
});

test.afterEach(async ({ page }) => {
  // Cancel what this walk left running, so no later spec's supervisor finds it.
  const running = await adminDb.dispatchRun.findMany({
    where: { origin: 'hosted', status: 'running' },
  });
  for (const run of running) await page.request.post(`/api/dispatch-runs/${run.id}/cancel`);
  seedCapacityFake();
});

test('a model with no agent-run capacity is labelled and refused, clears when capacity returns, a 429 model is labelled, an unreachable gateway labels nothing, and it reads in Chinese', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9541');

  const tag = Date.now().toString(36);
  const seed: HostedRunSeed = await seedHostedRun(`agent-capacity-${tag}@example.com`, `CAP${tag}`);
  const card1 = await seedReadyHostedCard(seed, 'Add the release notes page');
  const card2 = await seedReadyHostedCard(seed, 'Export invoices as CSV');
  const card3 = await seedReadyHostedCard(seed, 'Name the reviewer on the card');
  const card4 = await seedReadyHostedCard(seed, 'Show the changelog link');
  await signIn(page, seed.email, seed.password);

  let loads = 0;
  page.on('load', () => {
    loads += 1;
  });
  let firstRead: { body: ModelsBody; text: string } | null = null;

  await chapter('The full model is labelled and cannot be picked', async () => {
    firstRead = await openCard(page, card1.identifier);
    await expect(modelCombobox(page)).toContainText(OPEN);
    await openMenu(page);

    await expect(tagOf(page, FULL)).toHaveText(picker.noCapacityTag);
    await expect(option(page, FULL)).toContainText(picker.noCapacityReason);
    await expect(option(page, FULL)).toHaveAttribute('aria-disabled', 'true');
    for (const model of [OPEN, HOT]) await expect(tagOf(page, model)).toHaveCount(0);
    await beat();

    // Neither a click nor Enter moves the selection off the open model.
    await option(page, FULL).click({ force: true });
    await option(page, FULL).hover();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(modelCombobox(page)).toContainText(OPEN);
    await expect(modelCombobox(page)).not.toContainText(FULL);
  });

  await chapter('The picker read carries a verdict and nothing else', async () => {
    const { body, text } = firstRead!;
    for (const m of body.models) {
      expect(Object.keys(m).sort()).toEqual(['capacity', 'id', 'provider']);
      expect(Object.keys(m.capacity).sort()).toEqual(
        m.capacity.verdict === 'available' ? ['verdict'] : ['reason', 'verdict'],
      );
    }
    expect(capacityIn(body, FULL)).toEqual({
      verdict: 'no_capacity',
      reason: 'agent_share_exhausted',
    });
    for (const n of Object.values(SENTINELS)) expect(text).not.toContain(String(n));
    for (const key of [
      'inFlight',
      'in_flight',
      'planningSharePercent',
      'rateLimited429',
      'limits',
    ]) {
      expect(text).not.toContain(key);
    }
  });

  await chapter('A direct start for the full model is refused, and nothing starts', async () => {
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: card1.id } });
    const containers = fakeContainerCount();
    const res = await page.request.post(`/api/work-items/${card1.identifier}/hosted-runs`, {
      data: { mode: 'run', model: FULL, idempotencyKey: randomUUID() },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'error', 'model', 'reason']);
    expect(body).toMatchObject({ code: 'hosted_run_no_capacity', model: FULL });
    // The same reason the picker read gave the label.
    const label = capacityIn(firstRead!.body, FULL);
    expect(label?.verdict === 'no_capacity' && label.reason).toBe(body['reason']);

    expect(await adminDb.dispatchRunCard.count({ where: { workItemId: card1.id } })).toBe(0);
    expect(gatewayMints()).toEqual([]);
    expect(fakeContainerCount()).toBe(containers);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card1.id } });
    expect(after.status).toBe(before.status);
  });

  await chapter(
    'A run finishes: the label clears with no reload, and the model launches',
    async () => {
      const loadsBefore = loads;
      await openMenu(page);
      await expect(tagOf(page, FULL)).toBeVisible();

      const cleared = modelsRead(page, holds(FULL, 'available'));
      setFullInFlight(2);
      await cleared;
      await expect(tagOf(page, FULL)).toHaveCount(0);
      await expect(option(page, FULL)).not.toHaveAttribute('aria-disabled', 'true');
      expect(loads).toBe(loadsBefore);
      await beat();

      await launch(page, card1.identifier, FULL);
      expect(loads).toBe(loadsBefore);
    },
  );

  await chapter('The provider answers a model with 429s: it is labelled, then clears', async () => {
    await openCard(page, card2.identifier);
    const loadsBefore = loads;
    await openMenu(page);
    await expect(tagOf(page, HOT)).toHaveCount(0);

    const labelled = modelsRead(page, holds(HOT, 'no_capacity'));
    set429(3);
    await labelled;
    await expect(tagOf(page, HOT)).toHaveText(picker.noCapacityTag);
    await expect(option(page, HOT)).toHaveAttribute('aria-disabled', 'true');
    await beat();

    // The 429s stop; the label holds until the lane's 8 s window has passed.
    set429(0);
    await expect
      .poll(() => option(page, HOT).getAttribute('aria-disabled'), { timeout: LABEL_CHANGE_MS })
      .toBeNull();
    await expect(tagOf(page, HOT)).toHaveCount(0);
    expect(loads).toBe(loadsBefore);
    await page.keyboard.press('Escape');
  });

  await chapter(
    'The gateway cannot be reached: nothing is labelled, and the full model launches',
    async () => {
      setFullInFlight(3);
      setCapacityMode('unreachable');
      const { body } = await openCard(page, card3.identifier);
      expect(body.models.map((m) => m.capacity)).toEqual(
        body.models.map(() => ({ verdict: 'available' })),
      );
      await expect(modelCombobox(page)).toContainText(OPEN);
      await expect(main(page).getByTestId('run-hosted')).toBeEnabled();
      await openMenu(page);
      await expectNothingHeld(page);
      await beat();

      await launch(page, card3.identifier, FULL);
    },
  );

  await chapter('In Chinese: a stale tab is refused, and the picker labels the model', async () => {
    setCapacityMode('live');
    setFullInFlight(2);
    await page
      .context()
      .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
    const { text: stale } = await openCard(page, card4.identifier);
    await modelCombobox(page).click();
    await option(page, FULL).click();
    await expect(modelCombobox(page)).toContainText(FULL);

    // The tab goes stale: its re-reads keep the old answer while the share fills.
    await page.route('**/api/hosted-runs/models**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: stale }),
    );
    setFullInFlight(3);
    // The server's verdict is cached for the lane's window, so wait until the
    // server itself answers share full. `page.request` is not routed, so this
    // read reaches the server while the tab keeps its stale answer.
    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/hosted-runs/models');
          return capacityIn((await res.json()) as ModelsBody, FULL)?.verdict;
        },
        { timeout: LABEL_CHANGE_MS },
      )
      .toBe('no_capacity');
    const refused = startResponse(page, card4.identifier);
    await main(page).getByTestId('run-hosted').click();
    expect((await refused).status()).toBe(409);

    const notice = main(page).getByTestId('hosted-refused-noCapacity');
    await expect(notice).toContainText(fill(zhRefused.title, { model: FULL }));
    await expect(notice).toContainText(zhRefused.body);
    const sentence = (await notice.innerText()).replaceAll(FULL, '');
    expect(sentence).not.toMatch(/\d/);
    await beat();

    // The tab reads the gateway again: the model is labelled, in Chinese.
    const labelled = modelsRead(page, holds(FULL, 'no_capacity'));
    await page.unroute('**/api/hosted-runs/models**');
    await labelled;
    await openMenu(page);
    await expect(tagOf(page, FULL)).toHaveText(zhPicker.noCapacityTag);
    await expect(option(page, FULL)).toContainText(zhPicker.noCapacityReason);
    await expect(option(page, FULL)).toHaveAttribute('aria-disabled', 'true');
  });
});
