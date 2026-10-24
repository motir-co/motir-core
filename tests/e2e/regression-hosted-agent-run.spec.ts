import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedHostedRun, seedReadyHostedCard } from './_helpers/hosted-run-seed';
import { appendEvents, closeRun, ingestContext } from './_helpers/agent-run-seed';
import {
  fakeContainerCount,
  fakeContainerSettled,
  readHostedRunJournal,
  resetHostedRunJournal,
  runTokenFor,
  writeHostedRunFixture,
} from './_helpers/hosted-run-boundary';
import { linkPr } from './_helpers/pr-link';
import { postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { E2E_REPO } from './_helpers/github-const';
import en from '@/messages/en.json';

// A CARD RUNS ON THE HOSTED AGENT (Story MOTIR-683 · MOTIR-6452) — the story's
// mandatory browser test and, for the happy path, its acceptance receipt.
//
// ── THE THREE STUBBED SEAMS ──────────────────────────────────────────────────
//
// `hostedRunService.start`/`endHostedRun` call three real services this lane
// cannot reach: the GATEWAY (mints/revokes the run's model key), motir-ai (the
// offered-model list, the credit pre-flight and the run's usage/machine-time
// charge) and GitHub (the repo-level installation read a writable repository
// needs). `lib/test-hosted-run-mock.ts` answers all three, behind
// `E2E_TEST_HOSTED_RUN=1` — set unconditionally by `playwright.acceptance.config.ts`
// for this lane, mirrored into the job worker for the stall/cancel end path's
// own gateway revoke + machine charge (`hostedRunSeamEnv`,
// `tests/e2e/_helpers/job-worker-process.ts`). EACH TEST asserts a stub answered
// before asserting anything else — reading the journal, or reading the exact
// model ids the picker shows — so a pass here cannot be read against a real
// outbound call or a vacuous one.
//
// ── PLAYING THE CONTAINER'S SIDE ─────────────────────────────────────────────
//
// No real container ever boots (`MOTIR_FLEET_ORCHESTRATOR=fake`). Once a run has
// booted, its own credential (`MOTIR_RUN_TOKEN`) is read back from the fake
// orchestrator's shared container-state file — exactly what a real container
// would have received in its environment — and the entrypoint's events are
// POSTed through the shared `/api/v1` ingest with it, the same shape
// `tests/e2e/_helpers/agent-run-seed.ts` already uses for a local run's PAT.
//
// ── PACING ────────────────────────────────────────────────────────────────
//
// Only the HAPPY PATH is the published receipt (`acceptanceStory('MOTIR-683')`,
// chaptered and paced). The other six cases assert the same recipe's other
// claims with the ordinary E2E discipline — authoritative waits, no timers —
// but carry no pacing holds of their own.

// 120 s — well above a passing run, and far enough under the acceptance leg's
// 40-minute job ceiling that a hang here fails THIS test and prints why, instead
// of cancelling the leg with no report (which is how the start-body wait below
// hid for two runs).
test.describe.configure({ timeout: 120_000 });

const DEFAULT_MODEL = 'e2e-hosted-default';
const ALT_MODEL = 'e2e-hosted-alt';

function origin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('no Playwright baseURL — the ingest calls have nowhere to go');
  return baseURL;
}

/** The detail rail's Status field card (the `regression-repair-fix.spec.ts` precedent). */
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

const modelCombobox = (page: Page): Locator => page.getByRole('combobox', { name: 'Model' });
const modelsResponse = (page: Page) =>
  page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/hosted-runs/models' && res.request().method() === 'GET',
    { timeout: 30_000 },
  );
const startResponse = (page: Page, itemKey: string) =>
  page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/work-items/${itemKey}/hosted-runs`) &&
      res.request().method() === 'POST',
    { timeout: 30_000 },
  );
const runsListResponse = (page: Page, itemKey: string) =>
  page.waitForResponse(
    (res) =>
      res.url().includes(`/api/work-items/${itemKey}/dispatch-runs`) &&
      res.request().method() === 'GET',
    { timeout: 30_000 },
  );

function phase(page: Page, name: string): Locator {
  return page.locator(`li[data-phase="${name}"]`);
}

/** Two models, the first the default, mid-test mutable via a re-write. */
function defaultFixture() {
  writeHostedRunFixture({
    models: { ids: [DEFAULT_MODEL, ALT_MODEL], default: DEFAULT_MODEL },
    mayRun: true,
  });
  resetHostedRunJournal();
}

/**
 * The run a successful Run hosted opened — read off the run list the section
 * refetches right after, NOT the start response's body: Chrome never reports the
 * 201's chunked body finished once the page refreshes on it, so
 * `response.text()` on it never resolves (while the page itself read it fine).
 */
async function startedRunId(runsRes: Response): Promise<string> {
  const { runs } = (await runsRes.json()) as { runs: { id: string; origin: string }[] };
  const run = runs.find((r) => r.origin === 'hosted');
  expect(run, 'the run list carries the hosted run just started').toBeTruthy();
  return run!.id;
}

async function openAndStart(
  page: Page,
  card: { id: string; identifier: string },
  model: string,
): Promise<string> {
  const models = modelsResponse(page);
  await page.goto(`/items/${card.identifier}`);
  await models;
  await expect(page.getByRole('main').getByTestId('run-hosted-door')).toBeVisible();
  if (model !== DEFAULT_MODEL) {
    await modelCombobox(page).click();
    await page.getByRole('option').filter({ hasText: model }).click();
  }
  await expect(modelCombobox(page)).toContainText(model);
  const started = startResponse(page, card.identifier);
  const runs = runsListResponse(page, card.identifier);
  await page.getByRole('main').getByTestId('run-hosted').click();
  const startRes = await started;
  expect(startRes.status()).toBe(201);
  const dispatchRunId = await startedRunId(await runs);
  await expect(page.getByRole('main').getByTestId('hosted-run')).toBeVisible();
  return dispatchRunId;
}

test.describe('a card runs on the hosted agent', () => {
  test.beforeEach(async () => {
    await resetDatabase();
    defaultFixture();
  });

  test('picks a model, runs to a pull request and reads its cost', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-683');

    const seed = await seedHostedRun('hosted-happy@example.com', `HHP${Date.now().toString(36)}`);
    const card = await seedReadyHostedCard(seed, 'Ship the hosted-run banner');
    await signIn(page, seed.email, seed.password);

    let dispatchRunId = '';

    await chapter('Pick a non-default model and press Run hosted', async () => {
      const models = modelsResponse(page);
      await page.goto(`/items/${card.identifier}`);
      const modelsRes = await models;
      const modelsBody = (await modelsRes.json()) as { models: { id: string }[]; default: string };
      // The stub is ACTIVE before anything else is asserted: the picker can only
      // be showing these two synthetic ids because motir-ai's real list was never
      // reached.
      expect(modelsBody.models.map((m) => m.id).sort()).toEqual([ALT_MODEL, DEFAULT_MODEL].sort());
      expect(modelsBody.default).toBe(DEFAULT_MODEL);
      await expect(modelCombobox(page)).toContainText(DEFAULT_MODEL);

      await modelCombobox(page).click();
      await page.getByRole('option').filter({ hasText: ALT_MODEL }).click();
      await expect(modelCombobox(page)).toContainText(ALT_MODEL);

      const started = startResponse(page, card.identifier);
      const runs = runsListResponse(page, card.identifier);
      await page.getByRole('main').getByTestId('run-hosted').click();
      const startRes = await started;
      expect(startRes.status()).toBe(201);
      dispatchRunId = await startedRunId(await runs);

      // The gateway stub recorded the mint, with the BARE chosen model id —
      // proof the gateway seam is active, and AC2's "recorded in the mint".
      const mint = readHostedRunJournal().find(
        (e) => e.type === 'gateway_mint' && e.runRef === dispatchRunId,
      );
      expect(mint).toMatchObject({ type: 'gateway_mint', models: [ALT_MODEL] });
      // The card's repository is Motir-created (`state: created`), which
      // `motir-studio` always writes: the write check asks GitHub NOTHING for it
      // (MOTIR-6449), so no installation read is journalled.
      expect(readHostedRunJournal().some((e) => e.type === 'github_installation')).toBe(false);
    });
    await beat();

    await chapter('The run section shows it starting, with its model named', async () => {
      await expect(page.getByRole('main').getByTestId('hosted-run')).toBeVisible();
      await expect(page.getByRole('main').getByTestId('hosted-run')).toContainText(ALT_MODEL);
      await expect(phase(page, 'starting')).toHaveAttribute('data-state', 'now');
    });
    await beat();

    await chapter('The phases advance as the container reports in', async () => {
      const api = await ingestContext(runTokenFor(dispatchRunId), origin(baseURL));
      await appendEvents(api, dispatchRunId, [
        {
          kind: 'checkout_ready',
          workItemKey: card.identifier,
          data: { repositories: [`${E2E_REPO.owner}/${E2E_REPO.name}`] },
        },
      ]);
      await expect(phase(page, 'cloned')).toHaveAttribute('data-state', 'now');
      await beat();

      await appendEvents(api, dispatchRunId, [
        { kind: 'agent_started', workItemKey: card.identifier },
      ]);
      await expect(phase(page, 'running')).toHaveAttribute('data-state', 'now');
      await appendEvents(api, dispatchRunId, [
        { kind: 'log', workItemKey: card.identifier, body: 'opencode: implementing…' },
      ]);
      await expect(page.getByRole('main').getByTestId('hosted-run')).toContainText('opencode');
    });
    await beat();

    await chapter('It reaches a pull request; the card reads Implemented', async () => {
      const api = await ingestContext(runTokenFor(dispatchRunId), origin(baseURL));
      // Pull-request numbers: this spec owns the 22xxx block (MOTIR-3248's
      // one-thousand-block-per-spec rule; 21xxx is acceptance-verdict.spec.ts's).
      const headRef = `hosted/${card.identifier.toLowerCase()}-22101`;
      await linkPr(page, {
        workItemId: card.id,
        repo: E2E_REPO,
        number: 22101,
        headRef,
      });
      const opened = await postSignedWebhook(
        page.request,
        'pull_request',
        pullRequestPayload({
          action: 'opened',
          number: 22101,
          title: `${card.identifier} — hosted run`,
          headRef,
          state: 'open',
          merged: false,
        }),
      );
      expect(opened.status(), await opened.text()).toBe(200);

      await appendEvents(api, dispatchRunId, [
        { kind: 'agent_exited', workItemKey: card.identifier, exitCode: 0 },
        { kind: 'delivery_linked', workItemKey: card.identifier },
      ]);
      // The CLI in the container moves the card as a local run does
      // (`hosted-run-runs-the-cli-as-the-app.md` §3) — the server's end path
      // never writes a card status — so the stand-in container does too, with
      // the run's own credential.
      const moved = await api.post(`/api/v1/work-items/${card.identifier}/transitions`, {
        data: { status: 'implemented' },
      });
      expect(moved.status(), await moved.text()).toBe(200);
      await closeRun(api, dispatchRunId, 'drained');

      await expect(page.getByRole('main').getByTestId('hosted-end')).toHaveAttribute(
        'data-end',
        'succeeded',
        {
          timeout: 30_000,
        },
      );
      await expect(page.getByRole('main').getByTestId('hosted-end')).toContainText('#22101');
      await expect(statusCard(page)).toContainText('Implemented', { timeout: 30_000 });
      // The chosen model's provenance, stamped at start (MOTIR-690's step 5) —
      // visible on the run panel's own meta row.
      await expect(page.getByRole('main').getByTestId('hosted-run')).toContainText(ALT_MODEL);
    });
    await beat();

    await chapter("It reads the run's cost", async () => {
      await expect(page.getByRole('main').getByTestId('hosted-cost-tokens')).toBeVisible();
      await expect(page.getByRole('main').getByTestId('hosted-cost-tokens')).toContainText('in');
      await expect(page.getByRole('main').getByTestId('hosted-cost-tokens')).toContainText('out');
      await expect(page.getByRole('main').getByTestId('hosted-cost-credits')).toContainText(
        'credits',
      );
      await expect(page.getByRole('main').getByTestId('hosted-cost-machine')).toContainText(
        'Charged in credits',
      );
    });
    await beat();
  });

  test('a model withdrawn between page load and click is refused, and no container is provisioned', async ({
    page,
  }) => {
    const seed = await seedHostedRun(
      'hosted-withdrawn@example.com',
      `HWD${Date.now().toString(36)}`,
    );
    const card = await seedReadyHostedCard(seed, 'A card whose model gets withdrawn');
    await signIn(page, seed.email, seed.password);

    const before = fakeContainerCount();

    const models = modelsResponse(page);
    await page.goto(`/items/${card.identifier}`);
    await models;
    await modelCombobox(page).click();
    await page.getByRole('option').filter({ hasText: ALT_MODEL }).click();
    await expect(modelCombobox(page)).toContainText(ALT_MODEL);

    // Dropped between page load and the click — the picker never re-read it.
    writeHostedRunFixture({
      models: { ids: [DEFAULT_MODEL], default: DEFAULT_MODEL },
      mayRun: true,
    });

    const reload = modelsResponse(page);
    const started = startResponse(page, card.identifier);
    await page.getByRole('main').getByTestId('run-hosted').click();
    const startRes = await started;
    expect(startRes.status()).toBe(422);
    const reloadRes = await reload;
    const reloadBody = (await reloadRes.json()) as { models: { id: string }[] };
    expect(reloadBody.models.map((m) => m.id)).toEqual([DEFAULT_MODEL]);

    await expect(
      page.getByRole('main').getByTestId('hosted-refused-modelNotOffered'),
    ).toBeVisible();
    await expect(
      page.getByRole('main').getByTestId('hosted-refused-modelNotOffered'),
    ).toContainText(ALT_MODEL);
    await expect(modelCombobox(page)).not.toContainText(ALT_MODEL);

    expect(fakeContainerCount()).toBe(before);
    expect(readHostedRunJournal().some((e) => e.type === 'gateway_mint')).toBe(false);
  });

  test('the picker reads unavailable and Run hosted is disabled when the list errors', async ({
    page,
  }) => {
    writeHostedRunFixture({ models: { status: 503 }, mayRun: true });
    resetHostedRunJournal();

    const seed = await seedHostedRun(
      'hosted-unavailable@example.com',
      `HUN${Date.now().toString(36)}`,
    );
    const card = await seedReadyHostedCard(seed, 'A card whose model list errors');
    await signIn(page, seed.email, seed.password);

    const models = modelsResponse(page);
    await page.goto(`/items/${card.identifier}`);
    const modelsRes = await models;
    expect(modelsRes.status()).toBe(503);

    await expect(page.getByRole('main').getByTestId('hosted-models-unavailable')).toBeVisible();
    await expect(page.getByRole('main').getByTestId('run-hosted')).toBeDisabled();
  });

  test('out of credits refuses before any container, with zero provisions', async ({ page }) => {
    writeHostedRunFixture({
      models: { ids: [DEFAULT_MODEL], default: DEFAULT_MODEL },
      mayRun: false,
    });
    resetHostedRunJournal();

    const seed = await seedHostedRun('hosted-credits@example.com', `HOC${Date.now().toString(36)}`);
    const card = await seedReadyHostedCard(seed, 'A card its org cannot afford');
    await signIn(page, seed.email, seed.password);

    const before = fakeContainerCount();

    const models = modelsResponse(page);
    await page.goto(`/items/${card.identifier}`);
    await models;
    await expect(modelCombobox(page)).toContainText(DEFAULT_MODEL);

    const started = startResponse(page, card.identifier);
    await page.getByRole('main').getByTestId('run-hosted').click();
    const startRes = await started;
    expect(startRes.status()).toBe(402);

    await expect(page.getByRole('main').getByTestId('hosted-refused-outOfCredits')).toBeVisible();
    expect(fakeContainerCount()).toBe(before);
    expect(readHostedRunJournal().some((e) => e.type === 'gateway_mint')).toBe(false);
  });

  test('cancelling a run settles its machine and revokes the gateway key', async ({ page }) => {
    const seed = await seedHostedRun('hosted-cancel@example.com', `HCN${Date.now().toString(36)}`);
    const card = await seedReadyHostedCard(seed, 'A card whose run gets cancelled');
    await signIn(page, seed.email, seed.password);

    const dispatchRunId = await openAndStart(page, card, DEFAULT_MODEL);

    await page.getByRole('main').getByTestId('hosted-run-cancel').click();
    await expect(
      page.getByRole('alertdialog').getByTestId('hosted-run-cancel-confirm'),
    ).toBeVisible();
    const cancelled = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/dispatch-runs/${dispatchRunId}/cancel`) &&
        res.request().method() === 'POST',
    );
    await page.getByRole('alertdialog').getByTestId('hosted-run-cancel-confirm').click();
    const cancelRes = await cancelled;
    expect(cancelRes.status()).toBe(200);

    await expect(page.getByRole('main').getByTestId('hosted-end')).toHaveAttribute(
      'data-end',
      'cancelled',
      {
        timeout: 30_000,
      },
    );

    // The revoke the CANCEL press itself makes, in this (the webServer) process.
    await expect
      .poll(() => readHostedRunJournal().some((e) => e.type === 'gateway_revoke'), {
        timeout: 10_000,
      })
      .toBe(true);

    // The fake orchestrator's own record: the supervisor (the job worker) tears
    // the machine down at its next poll and settles it — an authoritative,
    // committed-state read, never a timeout.
    await expect.poll(() => fakeContainerSettled(dispatchRunId), { timeout: 60_000 }).toBe(true);
  });

  test('a stalled run ends timed out, with the stalled reason visible without a reload', async ({
    page,
  }) => {
    const seed = await seedHostedRun('hosted-stall@example.com', `HST${Date.now().toString(36)}`);
    const card = await seedReadyHostedCard(seed, 'A card whose run goes silent');
    await signIn(page, seed.email, seed.password);

    await openAndStart(page, card, DEFAULT_MODEL);

    // No further event is ever posted for this run: the watchdog's shortened
    // window (`E2E_HOSTED_RUN_STALL_WINDOW_MS`) is what ends it, not a timeout
    // this spec waits on — the assertion below polls the PANEL'S OWN state,
    // pushed by the same SSE connection the happy path relies on, with no
    // `page.reload()` anywhere in this test.
    await expect(page.getByRole('main').getByTestId('hosted-end')).toHaveAttribute(
      'data-end',
      'stalled',
      {
        timeout: 90_000,
      },
    );
    await expect(page.getByRole('main').getByTestId('hosted-reason')).toContainText('stalled', {
      timeout: 5_000,
    });
  });

  test('the door shows starting while the request is in flight, and the failed state when it errors', async ({
    page,
  }) => {
    // motir-ai cannot answer the credit pre-flight AT ALL — the start route's own
    // "could not ask" path, which the door reads as `unavailable` (never silently
    // "started"). The route is also delayed a beat, purely so the door's OWN
    // `starting` face (`door.starting`, a real component-state flip on the click,
    // never a guess) is observable before its response resolves.
    writeHostedRunFixture({
      models: { ids: [DEFAULT_MODEL], default: DEFAULT_MODEL },
      mayRun: 'unanswerable',
    });
    resetHostedRunJournal();

    const seed = await seedHostedRun('hosted-loading@example.com', `HLD${Date.now().toString(36)}`);
    const card = await seedReadyHostedCard(seed, 'A card exercising the loading and error states');
    await signIn(page, seed.email, seed.password);

    await page.route(`**/api/work-items/${card.identifier}/hosted-runs`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });

    const models = modelsResponse(page);
    await page.goto(`/items/${card.identifier}`);
    await models;
    await expect(modelCombobox(page)).toContainText(DEFAULT_MODEL);

    const started = startResponse(page, card.identifier);
    await page.getByRole('main').getByTestId('run-hosted').click();
    // LOADING: the request is still in flight (the route above is holding it).
    await expect(page.getByRole('main').getByTestId('run-hosted')).toHaveText(
      en.runs.hosted.door.starting,
    );

    const startRes = await started;
    expect(startRes.status()).toBe(503);
    // ERROR: the refused state, never a silently-started run.
    await expect(page.getByRole('main').getByTestId('hosted-refused-unavailable')).toBeVisible();
  });
});
