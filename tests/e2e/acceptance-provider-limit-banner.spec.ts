// Acceptance E2E — the plan overlay while the model provider is at its limit (Story MOTIR-9540 ·
// Subtask MOTIR-9625).
//
// THE RECORDED WALK (chapters 1–6) is two plans of one person. The first plan's planner reports a
// provider-retry wait: the rail draws the retrying banner, a reload draws it again with no
// interaction, and once the wait clears the banner goes and the plan ends as any plan ends. The
// second plan waits twice and is then refused for good (`walkStop.reasonCode: 'rate_limited'`):
// the session records `failureReason = 'rate_limited'`, the failed face says the provider is at
// its limit with the one Resume, To resume lists it, and Resume continues the SAME plan. Two
// further tests, unchaptered so they publish nothing, read the same banners under a zh reader and
// prove a non-rate failure draws no provider-limit element.
//
// THE RECEIPT IS CI's. This repository's acceptance lane carries
// `./.github/actions/upload-acceptance-video` (`.github/workflows/acceptance-tests.yml`), so a green
// pull-request run publishes this walk as MOTIR-9540's acceptance video; no MCP publish is made.
//
// ── What is real, and the seams ─────────────────────────────────────────────
// Runs under playwright.acceptance.config.ts, where motir-ai's JOBS boundary is replaced UNDER the
// routes by `lib/test-ai-jobs-mock.ts`. No motir-ai, gateway or provider runs, so a provider 429
// cannot be produced here: the retry loop, its attempts and its delays are motir-ai's and are
// asserted by its story test gate (MOTIR-9623). The planner is PLAYED, as
// `regression-plan-auto-resume.spec.ts` plays it:
//   · a run is held in progress by the fixture's `{ status: 'running' }` outcome;
//   · a step and the provider-retry reports go through `aiGenerationService.recordPlanStepForJob`,
//     the method `POST /api/internal/ai/plan-step` delegates to, called in the runner;
//   · proposals go through the job-token door (`POST /api/internal/ai/plan-proposals`);
//   · the exhausted failure is the fixture's `failed` outcome carrying `walkStop.reasonCode`, which
//     the relay settles through `settleFailedJob` on its terminal frame.
// That last relay runs only while the overlay subscribes to the job, so each failing plan's overlay
// stays OPEN from its send to its failure, and the Workbench read is made in a second, unrecorded
// tab of the same person. A REOPENED overlay polls without subscribing, which is why the reopen
// (from the Workbench › Planning row, the way a person comes back to a plan being written) happens
// on the plan that ends by its own `final` append rather than by a failure.
//
// DETERMINISM (the coding convention § E2E): every banner assertion follows the `GET
// /api/plans/[id]` poll response that carries (or stops carrying) the wait, read as the pane reads
// it (`readPlanProgress(…).providerWait`), or a Postgres read-back. `beat()` / `chapter()` are
// pacing only, after the assertion that proved the state. No `waitForTimeout`.
import { readFileSync, writeFileSync } from 'node:fs';
import type { Browser, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { setReaderLanguage } from './_helpers/reader-language';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import { E2E_CORE_CALLBACK_SECRET } from './_helpers/log-bug-as-ai';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { POLL_MS } from '@/lib/hooks/useGeneratingPlanPoll';
import { readPlanProgress } from '@/lib/plans/planProgress';
import { workbenchTabHref } from '@/lib/workbench/tab';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { AiJobsFixture, PlanJobOutcome, SubmittedJob } from '@/lib/test-ai-jobs-mock';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

test.describe.configure({ timeout: 420_000 });

const planReview = en.planReview;
const enLimit = en.planningWorkspace.providerLimit;
const zhLimit = zh.planningWorkspace.providerLimit;
const planningSession = en.workbench.planningSession;

const JOBS_FIXTURE =
  process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ?? '/tmp/motir-acceptance-ai-jobs-fixture.json';

// ── The motir-ai boundary ────────────────────────────────────────────────────

function readJobsFixture(): AiJobsFixture {
  try {
    return JSON.parse(readFileSync(JOBS_FIXTURE, 'utf8')) as AiJobsFixture;
  } catch {
    return {};
  }
}

/** Set plan run `index`'s outcome, keeping `submitted` (the mock indexes the queue by it). */
function setPlanOutcome(index: number, outcome: PlanJobOutcome): void {
  const f = readJobsFixture();
  const plan = [...(f.plan ?? [])];
  plan[index] = outcome;
  f.plan = plan;
  writeFileSync(JOBS_FIXTURE, JSON.stringify(f, null, 2));
}

const HELD: PlanJobOutcome = { status: 'running' };
const SUCCEEDED: PlanJobOutcome = { status: 'succeeded' };
/** A walk refused for good — motir-ai's `Problem.walkStop`, with the reason it stopped on. */
const stoppedOn = (reasonCode: string): PlanJobOutcome => ({
  status: 'failed',
  walkStop: { phase: 'author', target: null, targetTitle: null, depth: 1, reasonCode },
});
const jobId = (n: number) => `e2e-plan-${n}`;

const planSubmits = (): SubmittedJob[] =>
  (readJobsFixture().submitted ?? []).filter((s) => s.kind === 'plan' && !s.refused);
const submitOf = (id: string) => planSubmits().find((s) => s.jobId === id);

/** Append proposals to a job's plan through the door motir-ai uses. */
async function appendAsAi(
  page: Page,
  job: SubmittedJob,
  proposals: unknown[],
  final = false,
): Promise<void> {
  const res = await page.request.post('/api/internal/ai/plan-proposals', {
    headers: {
      authorization: `Bearer ${E2E_CORE_CALLBACK_SECRET}`,
      'x-motir-job-token': job.readBackToken!,
    },
    data: { jobId: job.jobId, proposals, final },
  });
  if (res.status() !== 200) throw new Error(`plan-proposals ${res.status()}: ${await res.text()}`);
}

const authoredAdd = (title: string, parentRef: string) => ({
  op: 'add',
  parentRef,
  proposedFields: {
    title,
    kind: 'task',
    descriptionMd: `What to build for ${title.toLowerCase()}, and where it stops.`,
    explanationMd: 'Why it matters to the person following the plan.',
    type: 'code',
    executor: 'coding_agent',
    storyPoints: 2,
    estimateMinutes: 30,
    difficulty: 'medium',
  },
});

// ── The hosted planner's reports — the internal route's own service method ───

interface Asker {
  userId: string;
  workspaceId: string;
  projectId: string;
}

type Report =
  | { step: 'author' }
  | {
      providerRetry:
        | { state: 'waiting'; attempt: number; maxAttempts: number; retryAt: string }
        | { state: 'cleared' };
    };

async function hostedReport(
  asker: Asker,
  planId: string,
  job: string,
  sessionKey: string,
  report: Report,
) {
  await aiGenerationService.recordPlanStepForJob(
    { jobId: job, planId, sessionKey, targetRef: null, ...report },
    { ctx: { userId: asker.userId, workspaceId: asker.workspaceId }, projectId: asker.projectId },
  );
}

/** Retry `attempt` of `maxAttempts`, due well inside the wait's grace for the whole chapter. */
const waiting = (attempt: number, maxAttempts = 2): Report => ({
  providerRetry: {
    state: 'waiting',
    attempt,
    maxAttempts,
    retryAt: new Date(Date.now() + 60_000).toISOString(),
  },
});
const CLEARED: Report = { providerRetry: { state: 'cleared' } };
const AUTHOR: Report = { step: 'author' };

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan|计划/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const liveState = (page: Page) => workspace(page).getByTestId('plan-live-state');
const retrying = (page: Page) => rail(page).getByTestId('provider-limit-retrying');
const stoppedBecause = (page: Page) => rail(page).getByTestId('provider-limit-because');
const stoppedKept = (page: Page) => rail(page).getByTestId('provider-limit-kept');
const failedWaiting = (page: Page) => rail(page).getByTestId('planning-failed-waiting');
const resumeButton = (page: Page) => rail(page).getByTestId('planning-resume');
const resumeEntry = (page: Page, sessionId: string) =>
  page.getByRole('main').getByTestId(`to-resume-session-${sessionId}`);

async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        applicable: false,
        organizationId: null,
        organizationName: null,
        canManageBilling: false,
        hasPaidAiPlan: false,
        balance: 0,
        tierName: null,
        tierAllotment: null,
        renewsAt: null,
      }),
    }),
  );
}

// ── The authoritative signals ────────────────────────────────────────────────

/** The wait the pane draws from a review body, on the server's own clock. */
const waitOf = (b: PlanReviewDto) =>
  b.progress ? readPlanProgress(b.progress, Date.parse(b.progress.observedAt)).providerWait : null;
const stepKeys = (b: PlanReviewDto) => (b.inFlightSteps ?? []).map((s) => s.sessionKey);

/** The NEXT `GET /api/plans/[id]` poll response whose body satisfies `until`. Arm it first. */
function planPolled(page: Page, planId: string, until: (b: PlanReviewDto) => boolean) {
  return page.waitForResponse(
    async (r) => {
      if (r.request().method() !== 'GET' || !r.ok()) return false;
      if (new URL(r.url()).pathname !== `/api/plans/${planId}`) return false;
      try {
        return until((await r.json()) as PlanReviewDto);
      } catch {
        return false;
      }
    },
    { timeout: 8 * POLL_MS },
  );
}

/** Every review poll the overlay makes, read for its wait — the non-rate case's record. */
function recordPolls(page: Page, planOf: () => string) {
  const polls: { wait: boolean }[] = [];
  page.on('response', async (r) => {
    const planId = planOf();
    if (!planId || r.request().method() !== 'GET' || !r.ok()) return;
    if (new URL(r.url()).pathname !== `/api/plans/${planId}`) return;
    try {
      polls.push({ wait: waitOf((await r.json()) as PlanReviewDto) !== null });
    } catch {
      /* a body that cannot be read is no reading */
    }
  });
  return polls;
}

// ── Persisted state ──────────────────────────────────────────────────────────

const latestSession = () =>
  adminDb.planChangeSession.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
const planRowOf = (planId: string) => adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
const sessionRowOf = (sessionId: string) =>
  adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });

/** The session's recorded failure reason, once the relay has settled it. */
async function failureRecorded(sessionId: string): Promise<string | null> {
  await expect
    .poll(async () => (await sessionRowOf(sessionId)).failedAt, { timeout: 8 * POLL_MS })
    .not.toBeNull();
  return (await sessionRowOf(sessionId)).failureReason;
}

// ── Steps ────────────────────────────────────────────────────────────────────

async function openFromCard(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL((url) => url.searchParams.has('plan'));
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

/** Send a turn from a CARD — the 200 of the plan route is the submit accepted. */
async function sendFromCard(page: Page, text: string, send: string): Promise<void> {
  const sent = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await rail(page).getByRole('button', { name: send }).click();
  expect((await sent).status()).toBe(200);
}

/** The plan job `n` writes into, and who asks on its behalf. */
async function planOfJob(n: number, email: string): Promise<{ planId: string; asker: Asker }> {
  const plan = await adminDb.plan.findFirstOrThrow({ where: { sourceJobId: jobId(n) } });
  const user = await adminDb.user.findUniqueOrThrow({ where: { email } });
  return {
    planId: plan.id,
    asker: { userId: user.id, workspaceId: plan.workspaceId, projectId: plan.projectId },
  };
}

/** A second tab of the SAME person, unrecorded, for the Workbench read. */
async function secondTab(browser: Browser, baseURL: string, email: string) {
  const context = await browser.newContext({ baseURL });
  const tab = await context.newPage();
  await stubAiAccess(tab);
  await signIn(tab, email, PLANNING_ANCHOR_PASSWORD);
  return { tab, close: () => context.close() };
}

test.beforeEach(async () => {
  await resetDatabase();
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ submitted: [] }, null, 2));
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECEIPT
// ─────────────────────────────────────────────────────────────────────────────

test('a plan waiting on the model provider says so and carries on; refused for good it stops rate-limited, waits in To resume, and Resume continues it', async ({
  page,
  browser,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9540');

  const email = `provider-limit-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);
  const { tab, close } = await secondTab(browser, baseURL!, email);
  const SEND = en.planningWorkspace.conversation.send;

  let first!: Awaited<ReturnType<typeof planOfJob>>;
  let second!: Awaited<ReturnType<typeof planOfJob>>;
  let sessionId = '';

  try {
    await chapter(
      'The model provider is busy — the plan says it will retry by itself',
      async () => {
        setPlanOutcome(0, HELD);
        await openFromCard(page, seed.storyKey);
        await sendFromCard(page, 'Split this story into the cards that ship it.', SEND);
        first = await planOfJob(0, email);

        const writing = planPolled(page, first.planId, (b) => stepKeys(b).includes('author-1'));
        await hostedReport(first.asker, first.planId, jobId(0), 'author-1', AUTHOR);
        await writing;
        await expect(liveState(page)).toHaveText(planReview.liveWriting);
        await expect(retrying(page)).toHaveCount(0);

        const waited = planPolled(page, first.planId, (b) => waitOf(b) !== null);
        await hostedReport(first.asker, first.planId, jobId(0), 'author-1', waiting(1));
        await waited;
        const banner = rail(page).getByRole('status', { name: enLimit.retryingTitle });
        await expect(banner).toBeVisible();
        await expect(retrying(page)).toContainText(enLimit.retryingTitle);
        await expect(retrying(page)).toContainText(enLimit.retryingBody);
        // A notice, not a control: no button, no countdown, no attempt number.
        await expect(retrying(page).getByRole('button')).toHaveCount(0);
        await expect(retrying(page)).not.toContainText(/\d/);
        await expect(resumeButton(page)).toHaveCount(0);
        await expect(failedWaiting(page)).toHaveCount(0);
        await beat();
      },
    );

    await chapter('Reopened mid-wait — the banner is there at once', async () => {
      await page.goto(workbenchTabHref('planning'));
      await expect(
        page
          .getByRole('navigation', { name: en.workbench.tabs.label })
          .getByTestId('workbench-tab-planning'),
      ).toHaveAttribute('aria-current', 'page', { timeout: FIRST_PAINT_MS });
      const row = page
        .getByRole('table', { name: en.workbench.tabs.planning })
        .getByRole('row')
        .filter({ hasText: seed.storyTitle });
      await expect(row).toHaveCount(1, { timeout: FIRST_PAINT_MS });
      const reread = planPolled(page, first.planId, (b) => waitOf(b) !== null);
      await row
        .getByRole('link', { name: en.workbench.planning.rowAria.split('{sentence}')[0]! })
        .click();
      await page.waitForURL(
        (url) => url.searchParams.has('planSession') || url.searchParams.has('plan'),
      );
      await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await reread;
      await expect(retrying(page)).toBeVisible();
      await expect(retrying(page)).toContainText(enLimit.retryingTitle);
      await beat();
    });

    await chapter('The provider answers — the banner goes and the plan ends as usual', async () => {
      const clear = planPolled(page, first.planId, (b) => waitOf(b) === null);
      await hostedReport(first.asker, first.planId, jobId(0), 'author-1', CLEARED);
      await clear;
      await expect(retrying(page)).toHaveCount(0);
      await expect(rail(page).getByRole('alert')).toHaveCount(0);

      const closed = planPolled(page, first.planId, (b) => b.status !== 'generating');
      await appendAsAi(
        page,
        submitOf(jobId(0))!,
        [authoredAdd('Ship CSV export first', seed.storyId)],
        true,
      );
      setPlanOutcome(0, SUCCEEDED);
      await closed;
      expect((await planRowOf(first.planId)).status).not.toBe('generating');
      const items = await adminDb.planItem.findMany({
        where: {
          planId: first.planId,
          proposedFields: { path: ['title'], equals: 'Ship CSV export first' },
        },
      });
      expect(items).toHaveLength(1);
      const session = await latestSession();
      expect(session.failedAt).toBeNull();
      expect(session.failureReason).toBeNull();
      await expect(retrying(page)).toHaveCount(0);
      await expect(failedWaiting(page)).toHaveCount(0);
      await beat();
    });

    await chapter(
      'Refused again and again — it stops at the provider’s limit, with one Resume',
      async () => {
        setPlanOutcome(1, HELD);
        await openFromCard(page, seed.subtaskKey);
        await sendFromCard(page, 'Break this subtask down.', SEND);
        second = await planOfJob(1, email);
        sessionId = (await latestSession()).id;

        const writing = planPolled(page, second.planId, (b) => stepKeys(b).includes('author-1'));
        await hostedReport(second.asker, second.planId, jobId(1), 'author-1', AUTHOR);
        await writing;
        await appendAsAi(page, submitOf(jobId(1))!, [
          authoredAdd('Break the export into steps', seed.storyId),
        ]);
        const waited = planPolled(page, second.planId, (b) => waitOf(b)?.attempt === 2);
        await hostedReport(second.asker, second.planId, jobId(1), 'author-1', waiting(1));
        await hostedReport(second.asker, second.planId, jobId(1), 'author-1', waiting(2));
        await waited;
        await expect(retrying(page)).toBeVisible();

        // Every retry refused: motir-ai's reporter clears the wait from its `finally` as the
        // exhausted 429 propagates (`src/llm/providerRetryReport.ts`), then the walk ends
        // `rate_limited` and the relay settles it.
        await hostedReport(second.asker, second.planId, jobId(1), 'author-1', CLEARED);
        setPlanOutcome(1, stoppedOn('rate_limited'));
        expect(await failureRecorded(sessionId)).toBe('rate_limited');
        await expect(failedWaiting(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(stoppedBecause(page)).toHaveText(enLimit.walkBecause);
        await expect(stoppedKept(page)).toHaveText(enLimit.walkKept);
        await expect(resumeButton(page)).toHaveCount(1);
        // The failure wins: no retrying banner beside the failed face.
        await expect(retrying(page)).toHaveCount(0);
        await beat();
      },
    );

    await chapter('The person’s To resume lists it, rate-limited', async () => {
      await tab.goto(workbenchTabHref('to-resume'));
      await expect(
        tab
          .getByRole('navigation', { name: en.workbench.tabs.label })
          .getByTestId('workbench-tab-to-resume'),
      ).toHaveAttribute('aria-current', 'page', { timeout: FIRST_PAINT_MS });
      await expect(resumeEntry(tab, sessionId)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(resumeEntry(tab, sessionId)).toContainText(planningSession.waitingToResume);
      await expect(resumeEntry(tab, sessionId)).toContainText(planningSession.reason.rate_limited);
      await beat();
    });

    await chapter('Resume — the same plan carries on', async () => {
      setPlanOutcome(2, HELD);
      const resumed = page.waitForResponse(
        (r) => /\/resume$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
      );
      await resumeButton(page).click();
      expect((await resumed).status()).toBe(200);
      expect(submitOf(jobId(2))?.resume).toEqual({ planId: second.planId, fromJobId: jobId(1) });
      await expect
        .poll(async () => (await planRowOf(second.planId)).sourceJobId, { timeout: 8 * POLL_MS })
        .toBe(jobId(2));

      const continued = planPolled(page, second.planId, (b) => stepKeys(b).includes('author-2'));
      await hostedReport(second.asker, second.planId, jobId(2), 'author-2', AUTHOR);
      await continued;
      await expect(liveState(page)).toHaveText(planReview.liveWriting);
      await expect(failedWaiting(page)).toHaveCount(0);
      await expect(stoppedBecause(page)).toHaveCount(0);
      await expect(retrying(page)).toHaveCount(0);
      expect((await sessionRowOf(sessionId)).failedAt).toBeNull();
      await beat();
    });
  } finally {
    await close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FURTHER TESTS — unchaptered, so they publish no receipt
// ─────────────────────────────────────────────────────────────────────────────

test('in Chinese, the retrying banner and the stopped wording render from the zh catalogue', async ({
  page,
}) => {
  const email = `provider-limit-zh-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);
  await setReaderLanguage(page, email, 'zh');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh', { timeout: FIRST_PAINT_MS });

  setPlanOutcome(0, HELD);
  await openFromCard(page, seed.subtaskKey);
  await sendFromCard(page, '把这个子任务拆开。', zh.planningWorkspace.conversation.send);
  const { planId, asker } = await planOfJob(0, email);
  const sessionId = (await latestSession()).id;

  const writing = planPolled(page, planId, (b) => stepKeys(b).includes('author-1'));
  await hostedReport(asker, planId, jobId(0), 'author-1', AUTHOR);
  await writing;
  const waited = planPolled(page, planId, (b) => waitOf(b) !== null);
  await hostedReport(asker, planId, jobId(0), 'author-1', waiting(1));
  await waited;
  await expect(rail(page).getByRole('status', { name: zhLimit.retryingTitle })).toBeVisible();
  await expect(retrying(page)).toContainText(zhLimit.retryingTitle);
  await expect(retrying(page)).toContainText(zhLimit.retryingBody);
  await expect(retrying(page)).not.toContainText(enLimit.retryingTitle);
  await expect(retrying(page)).not.toContainText(enLimit.retryingBody);

  // The wait is left STORED here (a job that died without its reporter's clear), so the stopped
  // face below also proves, in the browser, that a recorded failure wins over a wait.
  setPlanOutcome(0, stoppedOn('rate_limited'));
  expect(await failureRecorded(sessionId)).toBe('rate_limited');
  await expect(failedWaiting(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(stoppedBecause(page)).toHaveText(zhLimit.walkBecause);
  await expect(stoppedKept(page)).toHaveText(zhLimit.walkKept);
  await expect(failedWaiting(page)).not.toContainText(enLimit.walkBecause);
  await expect(failedWaiting(page)).not.toContainText(enLimit.walkKept);
  await expect(resumeButton(page)).toHaveCount(1);
  await expect(retrying(page)).toHaveCount(0);
});

test('a failure that is not the provider’s limit shows the usual failed face and no provider-limit element', async ({
  page,
}) => {
  const email = `provider-limit-500-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  let planId = '';
  const polls = recordPolls(page, () => planId);
  setPlanOutcome(0, HELD);
  await openFromCard(page, seed.subtaskKey);
  await sendFromCard(page, 'Break this subtask down.', en.planningWorkspace.conversation.send);
  const plan = await planOfJob(0, email);
  planId = plan.planId;
  const sessionId = (await latestSession()).id;

  // A step and a proposal, and never a provider-retry report.
  const writing = planPolled(page, planId, (b) => stepKeys(b).includes('author-1'));
  await hostedReport(plan.asker, planId, jobId(0), 'author-1', AUTHOR);
  await writing;
  await expect(retrying(page)).toHaveCount(0);

  // The shape a provider 500 ends in: a walk stopped `internal`.
  setPlanOutcome(0, stoppedOn('internal'));
  expect(await failureRecorded(sessionId)).toBe('internal');
  await expect(failedWaiting(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(failedWaiting(page)).toContainText(planningSession.reason.internal);
  await expect(resumeButton(page)).toHaveCount(1);
  // Two more reads of the plan after the failed face is drawn, so "never" spans the failure.
  for (let read = 0; read < 2; read += 1) {
    const res = await page.request.get(`/api/plans/${planId}`);
    expect(res.ok()).toBe(true);
    expect(waitOf((await res.json()) as PlanReviewDto)).toBeNull();
  }
  await expect(stoppedBecause(page)).toHaveCount(0);
  await expect(stoppedKept(page)).toHaveCount(0);
  await expect(retrying(page)).toHaveCount(0);
  await expect(failedWaiting(page)).not.toContainText(enLimit.walkBecause);
  expect(polls.length).toBeGreaterThan(0);
  expect(polls.filter((p) => p.wait)).toEqual([]);
});
