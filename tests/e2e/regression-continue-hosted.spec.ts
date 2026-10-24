import type { APIRequestContext, Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  appendEvents,
  closeRun,
  heartbeat,
  ingestContext,
  lapseRun,
  openRun,
} from './_helpers/agent-run-seed';
import {
  fakeContainerCount,
  readFakeContainers,
  resetHostedRunJournal,
  runTokenFor,
  writeHostedRunFixture,
} from './_helpers/hosted-run-boundary';
import {
  seedContinueHosted,
  seedInProgressCard,
  seedTwoRepoCard,
  type ContinueHostedSeed,
} from './_helpers/continue-hosted-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// A DEAD HOSTED RUN CONTINUES FROM THE BROWSER — THE ACCEPTANCE RECEIPT
// (Story MOTIR-6527 · Subtask MOTIR-6798).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A card runs hosted across two repositories. Its container checks out a branch in
// each, then stops reporting, and the watchdog ends it: the card is STILL In
// Progress and says its run died. Where the terminal command was, there is now a
// model picker and **Continue hosted**. One press, and the card says it is being
// continued by you in a hosted container; the run section shows the new run. That
// run finishes the work on the dead run's branches — one pull request per
// repository — and the card reads Implemented. Nobody opened a terminal.
//
// ── THE SEAMS THIS LANE USES ────────────────────────────────────────────────
//
//   * The gateway, motir-ai and GitHub — `lib/test-hosted-run-mock.ts`, exactly as
//     `regression-hosted-agent-run.spec.ts` uses it (the fixture it answers from,
//     rewritten mid-test for the refusal cases).
//   * The containers — the fake orchestrator. Its container side is PLAYED over the
//     real `/api/v1` ingest with each run's own `MOTIR_RUN_TOKEN`, read back from
//     the fake orchestrator's shared state — what a real container is booted with.
//   * The first run's death — the watchdog's stall, shortened by this lane
//     (`E2E_HOSTED_RUN_STALL_WINDOW_MS`). It is the real way a hosted run dies.
//   * The refusal cases' dead runs — LOCAL runs opened through the v1 ingest and
//     lapsed (`lapseRun`), the `regression-run-died-continue.spec.ts` shape: a
//     continue refuses the same way whoever's run died, and five minutes of
//     silence cannot be waited for.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: the start's own response, the part's
// `data-state`, the run section's phases, a v1 read. No timed wait anywhere; the
// holds are `chapter()` / `beat()`'s.

test.describe.configure({ timeout: 300_000 });

const DEFAULT_MODEL = 'e2e-hosted-default';
const ALT_MODEL = 'e2e-hosted-alt';
const h = en.github.development.continue.hosted;

type Messages = typeof en;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A rich message as the page renders it: tags keep their children, `{var}` its
 *  value, and `<when></when>` ANY relative time. */
function richPattern(template: string, vars: Record<string, string> = {}): RegExp {
  const parts = template.split(/<when><\/when>/);
  const literal = (s: string) =>
    escape(
      s
        .replace(/<\/?(b|mono|ref|link)>/g, '')
        .replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? ''),
    );
  return new RegExp(parts.map(literal).join('.+'));
}

const main = (page: Page) => page.getByRole('main');

/** The Development block's continue part — a labelled group. */
const continuePart = (page: Page, messages: Messages = en): Locator =>
  page.getByRole('group', { name: messages.github.development.continue.aria.part, exact: true });

/** The detail rail's Status field card. */
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

const phase = (page: Page, name: string): Locator => page.locator(`li[data-phase="${name}"]`);

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

function origin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('no Playwright baseURL — the ingest calls have nowhere to go');
  return baseURL;
}

function defaultFixture(): void {
  writeHostedRunFixture({
    models: { ids: [DEFAULT_MODEL, ALT_MODEL], default: DEFAULT_MODEL },
    mayRun: true,
  });
  resetHostedRunJournal();
}

/** The hosted run a start opened — off the run list the section refetches, never
 *  the 201's body (see `regression-hosted-agent-run.spec.ts`'s `startedRunId`). */
async function hostedRunIdFrom(runsRes: Response, command: 'run' | 'continue'): Promise<string> {
  const { runs } = (await runsRes.json()) as {
    runs: { id: string; origin: string; command: string }[];
  };
  const run = runs.find((r) => r.origin === 'hosted' && r.command === command);
  expect(run, `the run list carries the hosted ${command} run`).toBeTruthy();
  return run!.id;
}

/** The continue run the press booted — the fake orchestrator's own record. */
function continueRunId(): string {
  const machine = Object.values(readFakeContainers()).find(
    (m) => m.spec.env?.['MOTIR_RUN_MODE'] === 'continue',
  );
  const id = machine?.spec.env?.['MOTIR_DISPATCH_RUN_ID'];
  expect(id, 'a container booted in continue mode').toBeTruthy();
  return id!;
}

/** A LOCAL run on `key` that checked out `branch` (unless null) and went silent. */
async function deadLocalRun(
  api: APIRequestContext,
  projectKey: string,
  key: string,
  branch: string | null,
): Promise<string> {
  const runId = await openRun(api, {
    projectKey,
    command: 'run',
    agent: 'claude',
    cards: [{ key }],
  });
  if (branch) {
    await appendEvents(api, runId, [
      { kind: 'checkout_ready', workItemKey: key, data: { branch } },
    ]);
  }
  await heartbeat(api, runId);
  await lapseRun(runId, 6);
  return runId;
}

async function readCard(
  api: APIRequestContext,
  key: string,
): Promise<{ status: string; assigneeId: string | null }> {
  const res = await api.get(`/api/v1/work-items/${key}`);
  expect(res.status(), `read ${key}`).toBe(200);
  return (await res.json()) as { status: string; assigneeId: string | null };
}

/** Open a died card and wait for its door: models read, the part `died`. */
async function openDied(page: Page, key: string, messages: Messages = en): Promise<Locator> {
  const models = modelsResponse(page);
  await page.goto(`/items/${key}`);
  await models;
  const part = continuePart(page, messages);
  await expect(part).toHaveAttribute('data-state', 'died', { timeout: FIRST_PAINT_MS });
  await expect(part.getByTestId('continue-hosted-door')).toBeVisible();
  return part;
}

test.describe('a dead hosted run continues from the browser', () => {
  let s: ContinueHostedSeed;
  let ownerApi: APIRequestContext;
  let benApi: APIRequestContext;

  test.beforeEach(async ({ page, baseURL }) => {
    await resetDatabase();
    defaultFixture();
    const slug = Date.now().toString(36);
    s = await seedContinueHosted(`continue-${slug}@example.com`, `CH${slug}`);
    ownerApi = await ingestContext(s.owner.token, origin(baseURL));
    benApi = await ingestContext(s.ben.token, origin(baseURL));
    await signIn(page, s.owner.email, s.hosted.password);
  });

  test.afterEach(async () => {
    await ownerApi.dispose();
    await benApi.dispose();
  });

  test('a hosted run dies, Continue hosted picks it up, and it ends in a pull request per repository', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6527');
    const card = await seedTwoRepoCard(s, 'Export invoices as CSV');
    const key = card.identifier;
    const branches = s.repos.map((r) => `motir/${key.toLowerCase()}-${r.name}`);
    let deadRunId = '';
    let continueId = '';

    await chapter('The card runs hosted, across two repositories', async () => {
      const models = modelsResponse(page);
      await page.goto(`/items/${key}`);
      await models;
      await expect(main(page).getByTestId('run-hosted-door')).toBeVisible();
      const started = startResponse(page, key);
      const runs = runsListResponse(page, key);
      await main(page).getByTestId('run-hosted').click();
      expect((await started).status()).toBe(201);
      deadRunId = await hostedRunIdFrom(await runs, 'run');

      // The container checks out a branch in EACH repository, starts the agent…
      const api = await ingestContext(runTokenFor(deadRunId), origin(baseURL));
      await appendEvents(api, deadRunId, [
        {
          kind: 'checkout_ready',
          workItemKey: key,
          data: {
            branches: s.repos.map((r, i) => ({
              repository: r.name,
              branch: branches[i],
              workBranch: branches[i],
            })),
          },
        },
        { kind: 'agent_started', workItemKey: key },
      ]);
      await expect(phase(page, 'running')).toHaveAttribute('data-state', 'now');
      await api.dispose();
    });
    await beat();

    await chapter('Then it stops reporting, and the run is ended as stalled', async () => {
      // No further event: the watchdog's shortened window ends it — the panel's own
      // state, pushed live, is the signal.
      await expect(main(page).getByTestId('hosted-end')).toHaveAttribute('data-end', 'stalled', {
        timeout: 90_000,
      });
      // Nothing moved: the card is In Progress, on the committed read.
      expect((await readCard(ownerApi, key)).status).toBe('in_progress');
    });
    await beat();

    await chapter('The card says its run died — and offers Continue hosted', async () => {
      const part = await openDied(page, key);
      await expect(part).toContainText(h.lead);
      // Every repository's branch is listed.
      const list = part.getByTestId('continue-branches');
      for (const [i, repo] of s.repos.entries()) {
        await expect(list).toContainText(`${repo.name} · ${branches[i]}`);
      }
      // The terminal path stays, one line down.
      await expect(part).toContainText(h.orTerminal);
      await expect(part.getByText(`motir continue ${key}`, { exact: true })).toBeVisible();
      // Run hosted is not offered on a died card: a continue is the way forward.
      await expect(main(page).getByTestId('run-hosted')).toHaveCount(0);
      await expect(statusCard(page)).toContainText('In Progress');
      await part.scrollIntoViewIfNeeded();
      await beat();
      await expect(part.getByRole('combobox', { name: 'Model' })).toContainText(DEFAULT_MODEL);
      await part.getByRole('combobox', { name: 'Model' }).click();
      await page.getByRole('option').filter({ hasText: ALT_MODEL }).click();
      await expect(part.getByRole('combobox', { name: 'Model' })).toContainText(ALT_MODEL);
    });
    await beat();

    await chapter('Continue hosted: the card is being continued by you', async () => {
      const before = fakeContainerCount();
      const started = startResponse(page, key);
      await main(page).getByTestId('continue-hosted').click();
      const res = await started;
      expect(res.status()).toBe(201);
      const body = JSON.parse(res.request().postData() ?? '{}') as Record<string, unknown>;
      expect(body).toMatchObject({ model: ALT_MODEL, mode: 'continue' });
      expect(fakeContainerCount()).toBe(before + 1);
      continueId = continueRunId();

      const part = continuePart(page);
      await expect(part).toHaveAttribute('data-state', 'continuing', { timeout: 30_000 });
      await expect(part).toContainText(richPattern(h.continuing.byYou));
      await expect(part).toContainText(h.continuing.watch);
      // The run section holds the new hosted run, starting.
      await expect(main(page).getByTestId('hosted-run')).toContainText(ALT_MODEL);
      await part.scrollIntoViewIfNeeded();
    });
    await beat();

    await chapter('The container carries on from both branches', async () => {
      const api = await ingestContext(runTokenFor(continueId), origin(baseURL));
      // What the container adopts: the dead run it continues, and every branch.
      const adopted = await api.get(`/api/v1/dispatch-runs/${continueId}`);
      expect(adopted.status()).toBe(200);
      const run = (await adopted.json()) as {
        continues: { fromRunId: string; branches: { repository: string; branch: string }[] };
      };
      expect(run.continues.fromRunId).toBe(deadRunId);
      expect(run.continues.branches.map((b) => b.branch)).toEqual(branches);

      await appendEvents(api, continueId, [
        {
          kind: 'checkout_ready',
          workItemKey: key,
          data: {
            branches: s.repos.map((r, i) => ({
              repository: r.name,
              branch: branches[i],
              workBranch: branches[i],
            })),
          },
        },
        { kind: 'agent_started', workItemKey: key },
      ]);
      await expect(phase(page, 'running')).toHaveAttribute('data-state', 'now');
      // The Cloned phase names BOTH repositories the container checked out.
      for (const repo of s.repos) {
        await expect(main(page).getByTestId('hosted-run')).toContainText(repo.name);
      }
      await api.dispose();
    });
    await beat();

    await chapter('One pull request per repository, and the card reads Implemented', async () => {
      const api = await ingestContext(runTokenFor(continueId), origin(baseURL));
      // Pull-request numbers: this spec owns the 24xxx block.
      for (const [i, repo] of s.repos.entries()) {
        const linked = await api.post(`/api/v1/work-items/${key}/pull-requests`, {
          data: {
            repository: `${repo.owner}/${repo.name}`,
            number: 24101 + i,
            headRef: branches[i],
            baseRef: 'main',
          },
        });
        expect(linked.status(), await linked.text()).toBe(200);
        await appendEvents(api, continueId, [
          {
            kind: 'delivery_linked',
            workItemKey: key,
            data: { repository: `${repo.owner}/${repo.name}` },
          },
        ]);
      }
      await appendEvents(api, continueId, [
        { kind: 'agent_exited', workItemKey: key, exitCode: 0 },
      ]);
      const moved = await api.post(`/api/v1/work-items/${key}/transitions`, {
        data: { status: 'implemented' },
      });
      expect(moved.status(), await moved.text()).toBe(200);
      await closeRun(api, continueId, 'drained');
      await api.dispose();

      await expect(main(page).getByTestId('hosted-end')).toHaveAttribute('data-end', 'succeeded', {
        timeout: 30_000,
      });
      await expect(statusCard(page)).toContainText('Implemented', { timeout: 30_000 });
      await page.reload();
      await expect(statusCard(page)).toContainText('Implemented', { timeout: FIRST_PAINT_MS });
      for (const [i, repo] of s.repos.entries()) {
        await expect(main(page)).toContainText(`${repo.owner}/${repo.name}`);
        await expect(main(page)).toContainText(`#${24101 + i}`);
      }
      // The card's run is no longer dead: there is nothing left to continue.
      await expect(continuePart(page)).toHaveCount(0);
      await main(page).getByText(`#${24101}`).first().scrollIntoViewIfNeeded();
    });
    await beat();
  });

  test('not offered while the run is alive, or when the dead run pushed nothing', async ({
    page,
  }) => {
    // ALIVE — a run still heartbeating: no continue part at all.
    const alive = await seedInProgressCard(s, 'A card whose run is alive');
    const aliveRun = await openRun(ownerApi, {
      projectKey: s.hosted.projectKey,
      command: 'run',
      agent: 'claude',
      cards: [{ key: alive.identifier }],
    });
    await appendEvents(ownerApi, aliveRun, [
      { kind: 'checkout_ready', workItemKey: alive.identifier, data: { branch: 'motir/alive' } },
    ]);
    await heartbeat(ownerApi, aliveRun);
    const models = modelsResponse(page);
    await page.goto(`/items/${alive.identifier}`);
    await models;
    // The page has painted its rail and its Development block before the absence is read.
    await expect(statusCard(page)).toContainText('In Progress', { timeout: FIRST_PAINT_MS });
    await expect(
      main(page).getByRole('heading', { name: en.github.development.title }),
    ).toBeVisible();
    await expect(continuePart(page)).toHaveCount(0);
    await expect(main(page).getByTestId('continue-hosted')).toHaveCount(0);

    // NOTHING PUSHED — D4's sentence, and no action.
    const noPush = await seedInProgressCard(s, 'A card whose run pushed nothing');
    await deadLocalRun(ownerApi, s.hosted.projectKey, noPush.identifier, null);
    await page.goto(`/items/${noPush.identifier}`);
    const part = continuePart(page);
    await expect(part).toHaveAttribute('data-state', 'no_branch', { timeout: FIRST_PAINT_MS });
    await expect(part).toContainText(en.github.development.continue.nothingPushed);
    await expect(part.getByTestId('continue-hosted')).toHaveCount(0);
    await expect(part.getByText(/motir continue/)).toHaveCount(0);
  });

  test('the refusals read in words: out of credits, a withdrawn model, and taken', async ({
    page,
  }) => {
    const r = en.runs.hosted.refused;

    // OUT OF CREDITS — nothing booted.
    const broke = await seedInProgressCard(s, 'A card its org cannot afford to continue');
    await deadLocalRun(ownerApi, s.hosted.projectKey, broke.identifier, 'motir/broke');
    writeHostedRunFixture({
      models: { ids: [DEFAULT_MODEL, ALT_MODEL], default: DEFAULT_MODEL },
      mayRun: false,
    });
    let before = fakeContainerCount();
    await openDied(page, broke.identifier);
    let started = startResponse(page, broke.identifier);
    await main(page).getByTestId('continue-hosted').click();
    expect((await started).status()).toBe(402);
    let notice = main(page).getByTestId('continue-hosted-refused-outOfCredits');
    await expect(notice).toContainText(r.outOfCredits.title);
    await expect(notice).toContainText(h.refused.outOfCredits.body);
    expect(fakeContainerCount()).toBe(before);
    // No lock taken: the card is still the owner's, and a terminal could continue it.
    expect((await readCard(ownerApi, broke.identifier)).assigneeId).toBe(s.owner.id);

    // A MODEL WITHDRAWN between page load and press — re-read in place.
    defaultFixture();
    const withdrawn = await seedInProgressCard(s, 'A card whose model is withdrawn');
    await deadLocalRun(ownerApi, s.hosted.projectKey, withdrawn.identifier, 'motir/withdrawn');
    const part = await openDied(page, withdrawn.identifier);
    await part.getByRole('combobox', { name: 'Model' }).click();
    await page.getByRole('option').filter({ hasText: ALT_MODEL }).click();
    writeHostedRunFixture({
      models: { ids: [DEFAULT_MODEL], default: DEFAULT_MODEL },
      mayRun: true,
    });
    before = fakeContainerCount();
    const reload = modelsResponse(page);
    started = startResponse(page, withdrawn.identifier);
    await main(page).getByTestId('continue-hosted').click();
    expect((await started).status()).toBe(422);
    await reload;
    notice = main(page).getByTestId('continue-hosted-refused-modelNotOffered');
    await expect(notice).toContainText(ALT_MODEL);
    await expect(part.getByRole('combobox', { name: 'Model' })).not.toContainText(ALT_MODEL);
    expect(fakeContainerCount()).toBe(before);

    // TAKEN — Ben's terminal continue got there first.
    const held = await seedInProgressCard(s, 'A card a terminal continue holds');
    await deadLocalRun(ownerApi, s.hosted.projectKey, held.identifier, 'motir/held');
    await openDied(page, held.identifier);
    const claim = await benApi.post(`/api/v1/work-items/${held.identifier}/continue`);
    expect(((await claim.json()) as { outcome: string }).outcome).toBe('claimed');
    started = startResponse(page, held.identifier);
    await main(page).getByTestId('continue-hosted').click();
    expect((await started).status()).toBe(409);
    notice = main(page).getByTestId('continue-hosted-refused-taken');
    await expect(notice).toContainText(richPattern(h.refused.taken, { name: s.ben.name }));
    // The page was stale: it re-reads, and now says Ben is continuing it.
    await expect(continuePart(page)).toHaveAttribute('data-state', 'continuing', {
      timeout: 30_000,
    });
    await expect(continuePart(page)).toContainText(s.ben.name);
  });

  test('in Chinese: the door and a refusal', async ({ page }) => {
    const z = zh.github.development.continue.hosted;
    const card = await seedInProgressCard(s, 'Show VAT on invoices');
    await deadLocalRun(ownerApi, s.hosted.projectKey, card.identifier, 'motir/vat');
    writeHostedRunFixture({
      models: { ids: [DEFAULT_MODEL], default: DEFAULT_MODEL },
      mayRun: false,
    });
    await page
      .context()
      .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
    const part = await openDied(page, card.identifier, zh as unknown as Messages);
    await expect(part).toContainText(z.lead);
    await expect(main(page).getByTestId('continue-hosted')).toHaveText(z.button);
    const started = startResponse(page, card.identifier);
    await main(page).getByTestId('continue-hosted').click();
    expect((await started).status()).toBe(402);
    await expect(main(page).getByTestId('continue-hosted-refused-outOfCredits')).toContainText(
      z.refused.outOfCredits.body,
    );
  });
});
