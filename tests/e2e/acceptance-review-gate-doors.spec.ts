import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { APIRequestContext, Page, Response } from '@playwright/test';
import { fakePersistentOrchestrator } from '@motir/orchestrator';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { ingestContext } from './_helpers/agent-run-seed';
import { postSignedWebhook } from './_helpers/github-seed';
import { headShaFor } from './_helpers/approve-and-merge-seed';
import { developmentSection } from './_helpers/development-decide';
import {
  readFakeContainers,
  readHostedRunJournal,
  resetHostedRunJournal,
  runTokenFor,
  writeHostedRunFixture,
} from './_helpers/hosted-run-boundary';
import {
  createAgent,
  runsOf,
  signInCodingAgent,
  type RunInMyAgentSeed,
} from './_helpers/run-in-my-agent-seed';
import { runReleaseFile } from './_helpers/agent-terminal/paths';
import type { ContinueHostedSeed } from './_helpers/continue-hosted-seed';
import type { ReviewAgentCard } from './_helpers/review-agent-seed';
import {
  REVIEW_REPO_NAME,
  awaitReviewGate,
  awaitingReviewGate,
  openReviewPullRequest,
  revealReviewBoardCard,
  reviewChecksGreen,
  reviewDeliveryVersion,
  reviewPrPayload,
  submitOwnAgentVerdict,
  type ReviewPullRequest,
} from './_helpers/review-path-flow';
import { seedReviewCard, seedReviewPath, TEAMMATE_GITHUB } from './_helpers/review-path-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// REVIEW IS A GATE A PERSON STARTS — THE STORY'S ACCEPTANCE RECEIPT (Story MOTIR-11941 ·
// Subtask MOTIR-11951; ADR `approval-gates.md` §12.17–§12.18; design
// `design/github/review-path--person-starts.mock.html`, `design-notes.md` § 33).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Settings → Approvals reads *Review*, a gate on approve-and-merge, with no *Who reviews*
// choice; in a project that merges automatically it reads Unavailable. With it on, an item
// goes green and WAITS — on the board card, the List cell and the item header, with the
// copyable `motir review <KEY>`; To approve lists a review to run; one notification; and
// NOTHING STARTS: no hosted machine, no credits spent. The item offers three doors, and
// each is walked: *Review with Motir agent* with a picked model (Agent reviewing, then the
// pass, the approve-and-merge row and the Reviewed badge; and a run that could not review,
// which brings the doors back with no *Review again*), *Review in my agent* (the agent's
// own progress, its send-back with the person, harness and model, and *Dismiss the
// review*), and the command's door (a verdict with the person's token). A push takes the
// badge away and waits again with nothing started. With Review off the doors still review
// and the verdict holds nothing. A teammate outside the routed set sees no doors; a person
// with no agent of their own is pointed at My agents. Then the same surfaces in 中文.
//
// ── THE FAKES — AND ONLY THESE ──────────────────────────────────────────────
//
//   * GITHUB — signed deliveries to the real `/api/github/webhook` route (open, green,
//     push), built by the shared flow's `pullRequestPayload` / `checkSuitePayload`; and the
//     merge seam's journal, emptied per test.
//   * THE HOSTED REVIEW RUN — the fake orchestrator, booted by the REAL door, and
//     `lib/test-hosted-run-mock.ts`'s fixture (`mayRun: false` is the credit pre-flight's
//     refusal). The spec plays the container's verdict with the run's OWN token, read from
//     the launcher spec the fake orchestrator recorded; a run left silent past the lane's
//     stall window ends with no verdict, which is the real way a hosted review cannot run.
//   * THE PERSON'S OWN AGENT — the persistent fake fleet, the lane's terminal host running
//     the REAL `motir agent-terminal run`, and `_helpers/agent-terminal/motir-run.py`'s
//     `review` form as the CLI the run session re-enters: it adopts the server-opened run,
//     and submits the verdict the spec wrote to its release file through
//     `POST /api/v1/work-items/{key}/review-verdict` with the RUN's token.
//   * NOTHING ELSE. Every verdict goes through a verdict door with a real token; never a
//     database write.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's or a door's own response and body, a committed
// read polled with `expect.poll`, the fake orchestrator's containers, or the hosted mock's
// journal. No timed wait anywhere; the holds are `chapter()` / `beat()`'s, taken after the
// assertion. The page is never resized (MOTIR-11471).
//
// ⚠️ THE 33xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 900_000 });
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const DEFAULT_MODEL = 'e2e-hosted-default';
const PICKED_MODEL = 'e2e-hosted-picked';
const MODELS = { ids: [DEFAULT_MODEL, PICKED_MODEL], default: DEFAULT_MODEL };
/** The harness the stand-in names for a `claude` agent — its profile's label. */
const HARNESS = 'Claude Code';
const OWN_MODEL = 'e2e-own-model';
const AGENT_NAME = 'yue-claude';

/** Every pull request this spec opens — each item's one, opened by the teammate. */
const PRS = {
  hosted: { number: 33101, author: TEAMMATE_GITHUB },
  couldNotRun: { number: 33201, author: TEAMMATE_GITHUB },
  myAgent: { number: 33301, author: TEAMMATE_GITHUB },
  command: { number: 33401, author: TEAMMATE_GITHUB },
  reviewOff: { number: 33501, author: TEAMMATE_GITHUB },
} as const;
type PrName = keyof typeof PRS;

const rp = en.approvalGate.reviewPath;
const zrp = zh.approvalGate.reviewPath;
const ar = en.approvalGate.agentReview;
const zar = zh.approvalGate.agentReview;
const ra = en.approvals.reviewAgent;
const zra = zh.approvals.reviewAgent;

const SEND_BACK_FINDINGS = [
  'The limiter counts requests per process, not per key.',
  '',
  '- `lib/limit.ts:20` — the bucket map is module state. Key it by the API token.',
].join('\n');
const DISMISS_REASON = 'Per-process limits are this card’s scope; per-key is MOTIR-2.';

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
/** A rich message's plain words — its tags dropped, its placeholders filled. */
const plain = (text: string, vars: Record<string, string | number> = {}) => {
  let stripped = text;
  for (let prev = ''; prev !== stripped; ) {
    prev = stripped;
    stripped = stripped.replace(/<\/?\w+>/g, '');
  }
  return fill(stripped, vars);
};

const prOf = (pr: PrName): ReviewPullRequest => ({
  ...PRS[pr],
  headRef: `review-doors/${PRS[pr].number}`,
});
const versionAt = (pr: PrName, sha: string) => reviewDeliveryVersion([[PRS[pr], sha] as const]);
const firstSha = (pr: PrName) => headShaFor(PRS[pr].number);

// ── Locators ────────────────────────────────────────────────────────────────

const main = (page: Page) => page.getByRole('main');
const band = (page: Page) => developmentSection(page).getByTestId('agent-review-band');
const doors = (page: Page) => developmentSection(page).getByTestId('review-doors');
const headerMarker = (page: Page) => main(page).locator('[data-review-header-marker]');
const listRow = (page: Page, card: ReviewAgentCard) =>
  main(page).getByRole('row').filter({ hasText: card.identifier });
const toApproveRow = (page: Page, card: ReviewAgentCard) =>
  main(page)
    .getByRole('table', { name: en.workbench.tabs.toApprove })
    .getByRole('row')
    .filter({ hasText: card.identifier });
const reviewSwitch = (page: Page, name = ra.title) =>
  main(page).getByRole('switch', { name, exact: true });
const reviewCard = (page: Page) => main(page).locator('#review-agent');
const mergeRadio = (page: Page, label: string) =>
  main(page).getByRole('radio').filter({ hasText: label });
const modelCombobox = (page: Page) =>
  developmentSection(page).getByRole('combobox', { name: en.runs.hosted.picker.label });
// The picker is a popover in a portal, outside <main>: found by its dialog role and name.
const agentPicker = (page: Page) =>
  page.getByRole('dialog', { name: ar.doors.myAgent, exact: true });

// ── GitHub, through the real webhook route ──────────────────────────────────

const openPullRequest = (page: Page, card: ReviewAgentCard, pr: PrName) =>
  openReviewPullRequest(page, card, prOf(pr));
const green = (page: Page, pr: PrName, sha: string) => reviewChecksGreen(page, prOf(pr), sha);

/** A push moved the pull request's head — GitHub's `synchronize` delivery. */
async function push(page: Page, card: ReviewAgentCard, pr: PrName, sha: string) {
  const payload = reviewPrPayload(card, prOf(pr), { head: { ref: prOf(pr).headRef, sha } });
  const res = await postSignedWebhook(page.request, 'pull_request', {
    ...payload,
    action: 'synchronize',
  });
  expect(res.status(), `push #${PRS[pr].number}@${sha}`).toBe(200);
}

// ── Committed reads ─────────────────────────────────────────────────────────

const statusOf = async (card: ReviewAgentCard) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id }, select: { status: true } }))
    .status;

/** The routed person's *review to run* notifications for `card`. */
const reviewNotifications = (recipientUserId: string, card: ReviewAgentCard) =>
  adminDb.notification.count({
    where: { recipientUserId, type: 'review_to_run', workItemId: card.id },
  });

/** Every review run Motir opened for `card`, hosted or in an agent. */
const reviewRunsOf = (card: ReviewAgentCard) =>
  adminDb.dispatchRun.findMany({
    where: { command: 'review', cards: { some: { workItemId: card.id } } },
    select: { id: true, origin: true, model: true, status: true },
  });

/** The hosted review machines the fake orchestrator booted for `card`. */
const hostedMachinesFor = (card: ReviewAgentCard) =>
  Object.values(readFakeContainers()).filter(
    (m) =>
      m.spec.env?.['MOTIR_RUN_MODE'] === 'review' &&
      m.spec.env?.['MOTIR_WORK_ITEM_KEY'] === card.identifier,
  );

/** What reached the credit ledger — a machine debit or a gateway key minted for a run. */
const creditMovements = () =>
  readHostedRunJournal().filter((e) => e.type === 'machine_debit' || e.type === 'gateway_mint');

const verdictRecordsOf = (card: ReviewAgentCard) =>
  adminDb.reviewVerdictRecord.findMany({
    where: { workItemId: card.id },
    orderBy: { createdAt: 'asc' },
    select: {
      gateId: true,
      verdict: true,
      subjectVersion: true,
      submittedById: true,
      harness: true,
      model: true,
    },
  });

/**
 * THE NEGATIVE, AFTER ITS SIGNALS: the gate committed at `version` and the routed person's
 * notification present are what would have preceded a start — only then is "nothing
 * started" read off the fake orchestrator, the review runs and the credit ledger.
 */
async function waitingWithNothingStarted(
  card: ReviewAgentCard,
  version: string,
  routedUserId: string,
  ledgerBefore?: number,
) {
  await awaitReviewGate(card, 'agent_review', version);
  await expect
    .poll(() => reviewNotifications(routedUserId, card), {
      timeout: 60_000,
      message: `${card.identifier}: the routed person was told once`,
    })
    .toBe(1);
  expect(hostedMachinesFor(card), 'no hosted review machine booted').toEqual([]);
  expect(await reviewRunsOf(card), 'no review run opened').toEqual([]);
  // The ledger is read where no other run of the test can have moved it since `ledgerBefore`.
  if (ledgerBefore !== undefined) {
    expect(creditMovements(), 'nothing reached the credit ledger').toHaveLength(ledgerBefore);
  }
}

// ── Settings ────────────────────────────────────────────────────────────────

const settingsSaved = (page: Page, projectKey: string, path: string) =>
  page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/projects/${projectKey}/${path}`) &&
      res.request().method() === 'PATCH',
  );

async function setReview(page: Page, projectKey: string, on: boolean) {
  const toggle = reviewSwitch(page);
  await expect(toggle).toHaveAttribute('aria-checked', on ? 'false' : 'true', {
    timeout: FIRST_PAINT_MS,
  });
  const saved = settingsSaved(page, projectKey, 'approval-gates');
  await toggle.click();
  const res = await saved;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ reviewAgentEnabled: on });
  // The source is retired (MOTIR-11943): the settings answer names none.
  expect(body).not.toHaveProperty('reviewAgentSource');
  await expect(toggle).toHaveAttribute('aria-checked', on ? 'true' : 'false');
}

async function setMergeMode(page: Page, projectKey: string, label: string) {
  const saved = settingsSaved(page, projectKey, 'pr-merge-mode');
  await mergeRadio(page, label).click();
  expect((await saved).status()).toBe(200);
  await expect(mergeRadio(page, label)).toHaveAttribute('aria-checked', 'true');
}

// ── The doors ───────────────────────────────────────────────────────────────

async function openItem(page: Page, card: ReviewAgentCard) {
  await page.goto(`/items/${card.identifier}`);
  await expect(developmentSection(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

const doorPost = (page: Page, card: ReviewAgentCard, door: string): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/work-items/${card.identifier}/${door}`) &&
      res.request().method() === 'POST',
    { timeout: 60_000 },
  );

/** Pick `model` in the hosted door's picker and press *Review with Motir agent*. */
async function pressMotirAgent(page: Page, card: ReviewAgentCard, model: string) {
  const combobox = modelCombobox(page);
  await expect(combobox).toBeVisible({ timeout: FIRST_PAINT_MS });
  if (!(await combobox.textContent())?.includes(model)) {
    await combobox.click();
    await page.getByRole('option').filter({ hasText: model }).click();
  }
  await expect(combobox).toContainText(model);
  const answered = doorPost(page, card, 'review-with-motir-agent');
  await developmentSection(page).getByTestId('review-with-motir-agent').click();
  const res = await answered;
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

/** The hosted run's container, playing its side with the run's own token. */
async function asHostedRun(baseURL: string, runId: string): Promise<APIRequestContext> {
  return ingestContext(runTokenFor(runId), baseURL);
}

async function heartbeat(run: APIRequestContext, runId: string) {
  const res = await run.post(`/api/v1/dispatch-runs/${runId}/heartbeat`);
  expect(res.status(), `heartbeat ${runId}`).toBeLessThan(300);
}

/** The review-path workspace as My agents' seed shape — what `createAgent` names. */
async function agentSeedOf(seed: ContinueHostedSeed): Promise<RunInMyAgentSeed> {
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: seed.hosted.workspaceId },
    select: { organizationId: true },
  });
  return {
    email: seed.owner.email,
    viewerEmail: seed.ben.email,
    password: seed.hosted.password,
    userId: seed.owner.id,
    workspaceId: seed.hosted.workspaceId,
    organizationId,
    projectId: seed.hosted.projectId,
    projectIdentifier: seed.hosted.projectKey,
    repository: REVIEW_REPO_NAME,
  };
}

/** The stand-in's release file: what the person's agent concluded (`motir-run.py`). */
function agentConcludes(
  agentId: string,
  runId: string,
  verdict: { verdict: 'approved' | 'changes_requested'; findingsMd?: string; model: string },
) {
  const file = runReleaseFile(agentId, runId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(verdict));
}

test.describe('review is a gate a person starts', () => {
  let s: ContinueHostedSeed;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    fakePersistentOrchestrator.reset();
    writeHostedRunFixture({ models: MODELS, mayRun: true });
    resetHostedRunJournal();
    writeFileSync(process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!, '');
    writeFileSync(
      process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!,
      JSON.stringify({ repositories: [REVIEW_REPO_NAME], ownAuthoredPullRequests: [] }),
    );
    s = await seedReviewPath(Date.now().toString(36).slice(-5).toUpperCase());
    await signIn(page, s.owner.email, s.hosted.password);
  });

  test('Review waits for a person: nothing starts, and each of the three doors reviews it, gate on and off, refused states, zh', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-11941');
    if (!baseURL) throw new Error('no Playwright baseURL');
    const projectKey = s.hosted.projectKey;
    const personApi = await ingestContext(s.owner.token, baseURL);

    const hosted = await seedReviewCard(s, 'Export invoices as CSV');
    const couldNotRun = await seedReviewCard(s, 'Cap webhook retries');
    const myAgent = await seedReviewCard(s, 'Rate-limit the public API');
    const command = await seedReviewCard(s, 'Name the reviewer on the card');
    const reviewOff = await seedReviewCard(s, 'Archive invoices older than a year');
    for (const [card, pr] of [
      [hosted, 'hosted'],
      [couldNotRun, 'couldNotRun'],
      [myAgent, 'myAgent'],
      [command, 'command'],
      [reviewOff, 'reviewOff'],
    ] as const) {
      await openPullRequest(page, card, pr);
    }

    // ── 1 · Settings ────────────────────────────────────────────────────────
    await chapter('Settings → Approvals: the Review card, with no source to choose', async () => {
      await page.goto('/settings/project/approvals');
      await expect(reviewSwitch(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      const card = reviewCard(page);
      await card.scrollIntoViewIfNeeded();
      await expect(card.getByRole('heading', { name: ra.title, exact: true })).toBeVisible();
      // Its description says what it gates: approve-and-merge.
      await expect(card).toContainText(plain(ra.desc));
      // Nothing chooses who reviews, and no AI-credits note sits on the setting.
      await expect(card.getByRole('radiogroup')).toHaveCount(0);
      await expect(card.getByRole('radio')).toHaveCount(0);
      await expect(card).not.toContainText(ar.doors.creditsNote);
      // The bot-posting switch stays.
      await expect(reviewSwitch(page, ra.posting.title)).toBeVisible();
    });
    await beat();

    await chapter('A project that merges automatically: Review is unavailable', async () => {
      await setMergeMode(page, projectKey, en.approvals.mergeMode.auto.label);
      const card = reviewCard(page);
      await card.scrollIntoViewIfNeeded();
      await expect(card).toContainText(ra.unavailable);
      await expect(card).toContainText(plain(ra.unavailableWhat));
      await expect(reviewSwitch(page)).toBeDisabled();
      await expect(reviewSwitch(page)).toHaveAttribute('aria-checked', 'false');
      await beat();
      // Back to asking before merging: Review can be turned on again.
      await setMergeMode(page, projectKey, en.approvals.mergeMode.manual.label);
      await expect(reviewSwitch(page)).toBeEnabled();
    });

    await chapter('Turn Review on', async () => {
      await setReview(page, projectKey, true);
      await expect(mergeRadio(page, en.approvals.mergeMode.auto.label)).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
    await beat();

    // ── 2 · Green, waiting, and nothing started ─────────────────────────────
    const hostedV1 = versionAt('hosted', firstSha('hosted'));
    await chapter('Green, and waiting for a review — nothing started', async () => {
      const ledger = creditMovements().length;
      await green(page, 'hosted', firstSha('hosted'));
      await waitingWithNothingStarted(hosted, hostedV1, s.owner.id, ledger);
      // …and no approve-and-merge question until a review passes.
      expect(await awaitingReviewGate(hosted, 'pull_request_approval')).toBeNull();
      await page.goto('/boards');
      const marker = (await revealReviewBoardCard(page, hosted)).locator('[data-review-marker]');
      await expect(marker).toHaveAttribute('data-review-marker', 'waiting_for_review', {
        timeout: FIRST_PAINT_MS,
      });
      await expect(marker).toContainText(rp.marker.waiting);
    });

    await chapter('…in the List cell, and on the item header with motir review', async () => {
      await page.goto('/items');
      await expect(listRow(page, hosted).locator('[data-review-marker]')).toHaveAttribute(
        'data-review-marker',
        'waiting_for_review',
        { timeout: FIRST_PAINT_MS },
      );
      await openItem(page, hosted);
      await expect(headerMarker(page)).toContainText(rp.marker.waiting);
      const copy = main(page).getByTestId(`review-command-copy-${hosted.identifier}`).first();
      await expect(copy).toBeVisible();
      await copy.click();
      await expect(main(page).getByText(rp.command.copied, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        `motir review ${hosted.identifier}`,
      );
    });
    await beat();

    await chapter('To approve lists a review to run — not an approval', async () => {
      await page.goto('/workbench?tab=approvals');
      const row = main(page).locator('[data-review-to-run]').filter({ hasText: hosted.identifier });
      await expect(row).toContainText(plain(rp.toRun.sentence, { name: hosted.title }), {
        timeout: FIRST_PAINT_MS,
      });
      await expect(row).toContainText(rp.toRun.tag);
      await expect(row.getByTestId(`review-command-copy-${hosted.identifier}`)).toBeVisible();
      await expect(row.getByRole('button', { name: /approve/i })).toHaveCount(0);
      await expect(row.locator('[data-review-line]')).toHaveCount(0);
    });
    await beat();

    // ── 3 · The three doors, and a person with no agent of their own ────────
    await chapter('The item offers three doors: Motir agent, my agent, the command', async () => {
      await openItem(page, hosted);
      await expect(band(page)).toHaveAttribute('data-state', 'waiting');
      await expect(band(page)).toContainText(ar.doors.title);
      const offered = doors(page);
      await offered.scrollIntoViewIfNeeded();
      await expect(offered.getByTestId('review-hosted-door')).toBeVisible();
      await expect(modelCombobox(page)).toBeVisible();
      await expect(offered.getByTestId('review-with-motir-agent')).toHaveText(ar.doors.motirAgent);
      await expect(offered.getByTestId('review-in-my-agent')).toBeVisible();
      await expect(offered).toContainText(`motir review ${hosted.identifier}`);
      await expect(offered.getByTestId('review-credits-note')).toContainText(ar.doors.creditsNote);
    });

    await chapter('No agent of your own yet: Create one in My agents', async () => {
      await doors(page).getByTestId('review-in-my-agent').click();
      const empty = agentPicker(page).getByTestId('review-in-my-agent-empty');
      await expect(empty).toBeVisible();
      await expect(empty.getByTestId('review-in-my-agent-create')).toHaveText(
        en.runs.agent.empty.create,
      );
      await expect(empty.getByTestId('review-in-my-agent-create')).toHaveAttribute(
        'href',
        '/my-agents',
      );
      await beat();
      await page.keyboard.press('Escape');
      await expect(agentPicker(page)).toBeHidden();
    });

    // ── 4 · Review with Motir agent: a picked model, then a pass ────────────
    let hostedRunId = '';
    await chapter('Review with Motir agent, on a picked model: Agent reviewing', async () => {
      const started = await pressMotirAgent(page, hosted, PICKED_MODEL);
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      hostedRunId = String(started.body['dispatchRunId']);
      const container = await asHostedRun(baseURL, hostedRunId);
      // The container's first beat: it is alive while the reviewer watches.
      await heartbeat(container, hostedRunId);
      // Exactly ONE review run, for this item at this version, on the picked model.
      const machines = hostedMachinesFor(hosted);
      expect(machines).toHaveLength(1);
      expect(machines[0]!.spec.env?.['MOTIR_REVIEW_VERSION']).toBe(hostedV1);
      expect(await reviewRunsOf(hosted)).toEqual([
        expect.objectContaining({ id: hostedRunId, origin: 'hosted', model: PICKED_MODEL }),
      ]);
      await page.reload();
      await expect(band(page)).toHaveAttribute('data-state', 'reviewing', {
        timeout: FIRST_PAINT_MS,
      });
      await expect(headerMarker(page)).toContainText(rp.marker.reviewing);
      // The doors are hidden while the run reviews.
      await expect(doors(page)).toHaveCount(0);
      await heartbeat(container, hostedRunId);
      await container.dispose();
    });
    await beat();

    await chapter('The run passes: the approve-and-merge row and Reviewed', async () => {
      const container = await asHostedRun(baseURL, hostedRunId);
      const verdict = await container.post(`/api/v1/work-items/${hosted.identifier}/agent-review`, {
        data: {
          subjectVersion: hostedV1,
          verdict: 'pass',
          summaryMd: 'Meets every acceptance criterion.',
        },
      });
      expect(verdict.status(), await verdict.text()).toBe(200);
      await container.dispose();
      await awaitReviewGate(hosted, 'pull_request_approval', hostedV1);
      await openItem(page, hosted);
      await expect(band(page)).toHaveAttribute('data-state', 'passed');
      await expect(
        developmentSection(page).getByRole('link', {
          name: en.approvalGate.statusHeld.reviewAndApprove,
          exact: true,
        }),
      ).toBeVisible();
      await expect(main(page).locator('[data-reviewed-badge="reviewed"]').first()).toBeVisible();
      await page.goto('/workbench?tab=approvals');
      await expect(toApproveRow(page, hosted).locator('[data-review-line]')).toHaveAttribute(
        'data-review-line',
        'reviewed_by_agent',
        { timeout: FIRST_PAINT_MS },
      );
    });
    await beat();

    // ── 5 · A hosted review that could not run ──────────────────────────────
    const couldNotRunV = versionAt('couldNotRun', firstSha('couldNotRun'));
    await chapter('Out of AI credits: the press is refused and nothing starts', async () => {
      await green(page, 'couldNotRun', firstSha('couldNotRun'));
      await waitingWithNothingStarted(couldNotRun, couldNotRunV, s.owner.id);
      writeHostedRunFixture({ models: MODELS, mayRun: false });
      await openItem(page, couldNotRun);
      const refused = await pressMotirAgent(page, couldNotRun, DEFAULT_MODEL);
      expect(refused.status, JSON.stringify(refused.body)).toBe(402);
      await expect(doors(page).getByTestId('review-hosted-refused-outOfCredits')).toContainText(
        en.runs.hosted.refused.outOfCredits.title,
      );
      expect(hostedMachinesFor(couldNotRun)).toEqual([]);
      writeHostedRunFixture({ models: MODELS, mayRun: true });
    });

    await chapter('A review run that ends without a verdict: Review could not run', async () => {
      await openItem(page, couldNotRun);
      const started = await pressMotirAgent(page, couldNotRun, DEFAULT_MODEL);
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      expect(hostedMachinesFor(couldNotRun)).toHaveLength(1);
      // Nobody answers for the run: the lane's stall window ends it with no verdict, and the
      // gate records why.
      await expect
        .poll(
          async () =>
            (await awaitingReviewGate(couldNotRun, 'agent_review'))?.reviewUnavailableReason ??
            null,
          { timeout: 120_000, message: 'the gate records why the review could not run' },
        )
        .toBe('no_verdict');
      await openItem(page, couldNotRun);
      await expect(headerMarker(page)).toContainText(rp.marker.couldNotRun);
      await expect(band(page)).toHaveAttribute('data-state', 'could-not-run');
      // The three doors stand again, and nothing is called Review again (MOTIR-11948).
      await expect(doors(page).getByTestId('review-with-motir-agent')).toBeVisible();
      await expect(doors(page).getByTestId('review-in-my-agent')).toBeVisible();
      await expect(doors(page)).toContainText(`motir review ${couldNotRun.identifier}`);
      await expect(main(page).getByRole('button', { name: /review again/i })).toHaveCount(0);
    });
    await beat();

    // ── 6 · Review in my agent ──────────────────────────────────────────────
    const agentId = await createAgent(page, await agentSeedOf(s), AGENT_NAME);
    signInCodingAgent(agentId);
    const myAgentV = versionAt('myAgent', firstSha('myAgent'));
    let ownRunId = '';
    await chapter('Review in my agent: the agent’s progress on the item', async () => {
      await green(page, 'myAgent', firstSha('myAgent'));
      await waitingWithNothingStarted(myAgent, myAgentV, s.owner.id);
      await openItem(page, myAgent);
      await doors(page).getByTestId('review-in-my-agent').click();
      const row = agentPicker(page).locator(
        `[data-testid="send-to-agent-row"][data-agent="${AGENT_NAME}"]`,
      );
      await expect(row).toBeVisible();
      const answered = doorPost(page, myAgent, 'review-in-my-agent');
      await row.click();
      const res = await answered;
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status(), JSON.stringify(body)).toBe(201);
      ownRunId = String(body['dispatchRunId']);
      // The run is the agent's: no hosted machine, nothing on the credit ledger.
      expect(hostedMachinesFor(myAgent)).toEqual([]);
      await expect
        .poll(async () => (await runsOf(page, myAgent.identifier)).find((r) => r.id === ownRunId), {
          timeout: 90_000,
        })
        .toMatchObject({ status: 'running', origin: 'instance' });
      await page.reload();
      await expect(band(page)).toHaveAttribute('data-state', 'own-reviewing', {
        timeout: FIRST_PAINT_MS,
      });
      await expect(band(page)).toContainText(fill(ar.own.title, { agent: AGENT_NAME }));
      await expect(band(page)).toContainText(fill(ar.own.lineYou, { key: myAgent.identifier }));
      await expect(doors(page)).toHaveCount(0);
    });
    await beat();

    const statusBefore = await statusOf(myAgent);
    await chapter('Its verdict: a send-back, under your name, harness and model', async () => {
      agentConcludes(agentId, ownRunId, {
        verdict: 'changes_requested',
        findingsMd: SEND_BACK_FINDINGS,
        model: OWN_MODEL,
      });
      await expect
        .poll(async () => (await runsOf(page, myAgent.identifier)).find((r) => r.id === ownRunId), {
          timeout: 90_000,
        })
        .toMatchObject({ status: 'succeeded' });
      // Through the user-token door, on the run's token: the person, the harness, the model.
      expect(await verdictRecordsOf(myAgent)).toEqual([
        expect.objectContaining({
          verdict: 'changes_requested',
          subjectVersion: myAgentV,
          submittedById: s.owner.id,
          harness: HARNESS,
          model: OWN_MODEL,
        }),
      ]);
      // To fix, and the status did not move.
      expect(await statusOf(myAgent)).toBe(statusBefore);
      await openItem(page, myAgent);
      await expect(main(page).getByTestId('to-fix-banner')).toBeVisible();
      await expect(band(page)).toHaveAttribute('data-state', 'sent-back');
      await expect(band(page)).toContainText('The limiter counts requests per process');
      await page.goto(`/items/${myAgent.identifier}?activity=history`);
      await expect(main(page).locator('[id^="agent-verdict-"]').first()).toContainText(
        fill(rp.activity.agentOwn, { name: s.owner.name, harness: HARNESS }),
        { timeout: FIRST_PAINT_MS },
      );
    });
    await beat();

    await chapter('Dismiss the review: the approve-and-merge row comes back', async () => {
      await openItem(page, myAgent);
      const control = main(page).getByTestId('dismiss-review');
      await control.scrollIntoViewIfNeeded();
      await control.getByRole('button', { name: rp.dismiss.button, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: rp.dismiss.title });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('textbox').fill(DISMISS_REASON);
      const dismissed = doorPost(page, myAgent, 'review-dismissal');
      await dialog.getByRole('button', { name: rp.dismiss.confirm, exact: true }).click();
      expect((await dismissed).status()).toBe(200);
      await awaitReviewGate(myAgent, 'pull_request_approval', myAgentV);
      await page.goto('/workbench?tab=approvals');
      const row = toApproveRow(page, myAgent);
      await expect(row.locator('[data-review-line]')).toHaveAttribute(
        'data-review-line',
        'review_dismissed',
        { timeout: FIRST_PAINT_MS },
      );
      await expect(row).toContainText(
        plain(rp.line.dismissed, { name: s.owner.name, reason: DISMISS_REASON }),
      );
    });
    await beat();

    // ── 7 · The command's door ──────────────────────────────────────────────
    const commandV = versionAt('command', firstSha('command'));
    await chapter('motir review with your own token: a pass lands the same way', async () => {
      await green(page, 'command', firstSha('command'));
      await waitingWithNothingStarted(command, commandV, s.owner.id);
      await submitOwnAgentVerdict(
        personApi,
        command,
        { verdict: 'approved', subjectVersion: commandV },
        { harness: HARNESS, model: OWN_MODEL },
      );
      await awaitReviewGate(command, 'pull_request_approval', commandV);
      await openItem(page, command);
      await expect(
        developmentSection(page).getByRole('link', {
          name: en.approvalGate.statusHeld.reviewAndApprove,
          exact: true,
        }),
      ).toBeVisible();
      const badge = main(page).locator('[data-reviewed-badge="reviewed"]').first();
      await expect(badge).toBeVisible();
      await badge.focus();
      const card = page.getByTestId('reviewed-card').first();
      await expect(card).toContainText(fill(rp.badge.card.own, { name: s.owner.name }));
      await expect(card).toContainText(
        fill(rp.badge.card.harness, { harness: HARNESS, model: OWN_MODEL }),
      );
      await page.keyboard.press('Escape');
      await expect(card).toBeHidden();
    });
    await beat();

    // ── 8 · Review off ─────────────────────────────────────────────────────
    const reviewOffV = versionAt('reviewOff', firstSha('reviewOff'));
    await chapter('Review off: no gate, and the doors still review', async () => {
      await page.goto('/settings/project/approvals');
      await setReview(page, projectKey, false);
      await green(page, 'reviewOff', firstSha('reviewOff'));
      // Approve-and-merge is asked at once; no review gate is raised.
      await awaitReviewGate(reviewOff, 'pull_request_approval', reviewOffV);
      expect(
        await adminDb.approvalGate.count({
          where: { workItemId: reviewOff.id, kind: 'agent_review' },
        }),
      ).toBe(0);
      await openItem(page, reviewOff);
      await expect(band(page)).toHaveAttribute('data-state', 'review-off');
      await expect(band(page)).toContainText(ar.doors.leadOff);
      await expect(doors(page).getByTestId('review-with-motir-agent')).toBeVisible();
      await expect(doors(page).getByTestId('review-in-my-agent')).toBeVisible();
      await expect(doors(page)).toContainText(`motir review ${reviewOff.identifier}`);
    });

    await chapter('…and a verdict is recorded, holding nothing back', async () => {
      await submitOwnAgentVerdict(
        personApi,
        reviewOff,
        { verdict: 'approved', subjectVersion: reviewOffV },
        { harness: HARNESS, model: OWN_MODEL },
      );
      expect(await verdictRecordsOf(reviewOff)).toEqual([
        expect.objectContaining({ gateId: null, verdict: 'pass', subjectVersion: reviewOffV }),
      ]);
      await awaitReviewGate(reviewOff, 'pull_request_approval', reviewOffV);
      await page.goto('/workbench?tab=approvals');
      await expect(toApproveRow(page, reviewOff)).toBeVisible({ timeout: FIRST_PAINT_MS });
      // Back on: a head move waits for a review again.
      await page.goto('/settings/project/approvals');
      await setReview(page, projectKey, true);
    });
    await beat();

    // ── 9 · A head move ─────────────────────────────────────────────────────
    const movedSha = 'c3'.repeat(20);
    const hostedV2 = versionAt('hosted', movedSha);
    await chapter(
      'A push moves the head: the badge goes, waiting again, nothing started',
      async () => {
        await push(page, hosted, 'hosted', movedSha);
        await green(page, 'hosted', movedSha);
        await awaitReviewGate(hosted, 'agent_review', hostedV2);
        // Still the ONE review run from the press; nothing booted for the new version.
        expect(hostedMachinesFor(hosted)).toHaveLength(1);
        expect(await reviewRunsOf(hosted)).toHaveLength(1);
        await openItem(page, hosted);
        await expect(headerMarker(page)).toContainText(rp.marker.waiting);
        await expect(main(page).locator('[data-reviewed-badge]')).toHaveCount(0);
        await expect(band(page)).toHaveAttribute('data-state', 'waiting');
        await expect(doors(page)).toBeVisible();
      },
    );
    await beat();

    // ── 10 · A teammate outside the routed set ───────────────────────────────
    await chapter('A teammate the review is not routed to: no doors', async () => {
      await signIn(page, s.ben.email, s.hosted.password);
      await openItem(page, hosted);
      await expect(headerMarker(page)).toContainText(rp.marker.waiting);
      await expect(main(page).getByTestId('review-doors')).toHaveCount(0);
      await expect(main(page).getByTestId('review-with-motir-agent')).toHaveCount(0);
      await expect(main(page).getByTestId('review-in-my-agent')).toHaveCount(0);
    });
    await beat();
    await signIn(page, s.owner.email, s.hosted.password);

    // ── 11 · 中文 ────────────────────────────────────────────────────────────
    await page
      .context()
      .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', baseURL).href }]);

    await chapter('中文 — the Review card', async () => {
      await page.goto('/settings/project/approvals');
      await expect(reviewSwitch(page, zra.title)).toBeVisible({ timeout: FIRST_PAINT_MS });
      const card = reviewCard(page);
      await card.scrollIntoViewIfNeeded();
      await expect(card.getByRole('heading', { name: zra.title, exact: true })).toBeVisible();
      await expect(card).toContainText(plain(zra.desc));
      await expect(card).toContainText(zra.posting.title);
      await expect(card.getByRole('radio')).toHaveCount(0);
      await expect(card).not.toContainText(plain(ra.desc));
      await expect(card).not.toContainText(ra.posting.title);
      await expect(main(page)).not.toContainText('approvals.reviewAgent');
    });

    await chapter('中文 — the marker and the three doors', async () => {
      await openItem(page, hosted);
      await expect(headerMarker(page)).toContainText(zrp.marker.waiting, {
        timeout: FIRST_PAINT_MS,
      });
      await expect(band(page)).toContainText(zar.doors.title);
      await expect(doors(page).getByTestId('review-with-motir-agent')).toHaveText(
        zar.doors.motirAgent,
      );
      await expect(doors(page).getByTestId('review-in-my-agent')).toContainText(zar.doors.myAgent);
      await expect(doors(page)).toContainText(zar.doors.orRun);
      await expect(doors(page).getByTestId('review-credits-note')).toContainText(
        zar.doors.creditsNote,
      );
      for (const english of [
        rp.marker.waiting,
        ar.doors.title,
        ar.doors.motirAgent,
        ar.doors.myAgent,
        ar.doors.creditsNote,
      ]) {
        await expect(main(page)).not.toContainText(english);
      }
      await expect(main(page)).not.toContainText('approvalGate.agentReview');
    });
    await beat();

    await personApi.dispose();
  });
});
