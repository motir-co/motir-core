// Acceptance E2E — a planning job that loses its machine resumes the same plan by itself (Story
// MOTIR-8301 · Subtask MOTIR-8311).
//
// THE RECORDED WALK (chapters 1–4) is one plan in one session. Its job is held running while a
// proposal is saved; the machine is then lost (motir-ai's reaper problem, `ai_job_abandoned`),
// and with nobody pressing anything the overlay's pane, its rail and the Workbench › Planning row
// read *Resuming*, then *Being written* once the new job writes — the saved proposal unchanged.
// Lost twice more, the bound (`AUTO_RESUMES_PER_SESSION = 2`) is spent: the plan waits in To
// resume with the shipped Resume, and pressing it continues the SAME plan without ever reading
// *Resuming*. The second test (case 5, unchaptered, so it publishes no receipt) is a job lost
// before anything was saved: it waits in To resume exactly as a judged failure does.
//
// ⚠️ EN ONLY. Every asserted wording is read from `messages/en.json`; the zh strings are asserted
// at the component tier (`tests/components/planProgressLine.resuming.test.tsx`).
//
// ── What is real, and the seams ─────────────────────────────────────────────
// Runs under playwright.acceptance.config.ts, where motir-ai's JOBS boundary is replaced UNDER
// the routes by `lib/test-ai-jobs-mock.ts`, so the submit → relay → settle → automatic resume →
// Postgres chain is real. The mock's `problemCode: 'ai_job_abandoned'` arm is what lets the lane
// reach a lost machine at all: without it every failure settles `ai_job_failed`, nothing is ever
// resumed, and every assertion below would pass on code that never resumes — which is why each
// chapter asserts the automatic SUBMIT (from the fixture) before anything on screen.
//
// The planner is PLAYED. Proposals go through the job-token door motir-ai uses
// (`POST /api/internal/ai/plan-proposals`, with the `readBackToken` the mock recorded), and steps
// through `aiGenerationService.recordPlanStepForJob`, the method `POST /api/internal/ai/plan-step`
// delegates to, called in the runner as `regression-plan-progress.spec.ts` does (that file's
// header says why it is not an HTTP call).
//
// ⚠️ THE RELAY STREAM IS NOT INTERCEPTED, unlike the progress spec's `holdRunStream`. The run is
// held by the fixture's `running` outcome instead, because the automatic resume is started by the
// relay's own terminal frame reaching `settleFailedJob`, and a browser-faked stream never reaches
// it. The same fact shapes the walk: the relay runs only while the overlay subscribes to the
// job, and a reopened overlay polls its plan without subscribing. So the overlay stays OPEN from
// the first send to the last loss, and the Workbench reads (the Planning row, To resume) are made
// in a second, unrecorded tab of the same person — leaving the overlay would close the relay that
// settles the next loss.
//
// The saved proposal's snapshot is `title`, `descriptionMd` and `createdAt`: `PlanItem` carries
// no `updatedAt`, and a re-authored proposal would be a new row with a new `createdAt`.
//
// DETERMINISM (the coding convention § E2E): every wait is a response, a landmark, a fixture read or a
// Postgres read-back. `beat()` / `chapter()` are PACING only, after the assertion that proved
// the state. The two absences are each tied to a later observed signal: no fourth automatic
// submit is read after the failure is recorded in Postgres AND the overlay has drawn the waiting
// state, across two later reads of the plan; and *Resuming* is checked absent on EVERY review
// poll response between the manual Resume press and the poll that carries the new job's step.
import { readFileSync, writeFileSync } from 'node:fs';
import type { Browser, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import { E2E_CORE_CALLBACK_SECRET } from './_helpers/log-bug-as-ai';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { POLL_MS } from '@/lib/hooks/useGeneratingPlanPoll';
import { readPlanProgress } from '@/lib/plans/planProgress';
import { workbenchTabHref } from '@/lib/workbench/tab';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { AiJobsFixture, PlanJobOutcome, SubmittedJob } from '@/lib/test-ai-jobs-mock';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 420_000 });

const planReview = en.planReview;
const act = en.planningWorkspace.conversation.act;
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

const LOST: PlanJobOutcome = { status: 'failed', problemCode: 'ai_job_abandoned' };
const HELD: PlanJobOutcome = { status: 'running' };
const jobId = (n: number) => `e2e-plan-${n}`;

const planSubmits = (): SubmittedJob[] =>
  (readJobsFixture().submitted ?? []).filter((s) => s.kind === 'plan' && !s.refused);
const submitOf = (id: string) => planSubmits().find((s) => s.jobId === id);

/**
 * Lose job `n`'s machine with job `n + 1` queued HELD, read back the automatic submit, and wait
 * for the BIND to commit.
 *
 * The submit being recorded is not the resume being done: `planSessionResumeService` submits
 * FIRST and binds SECOND, so the mock records the submit before the bind transaction re-points
 * `plan.sourceJobId`, clears the session's failure and counts the auto-resume. A single read
 * straight after the submit can still see the old job (MOTIR-8409). The re-point commits in that
 * same transaction, so once it reads the new job every row the chapters read is settled.
 */
async function loseMachine(n: number, planId: string): Promise<void> {
  setPlanOutcome(n + 1, HELD);
  setPlanOutcome(n, LOST);
  await expect
    .poll(() => submitOf(jobId(n + 1))?.resume ?? null, { timeout: 8 * POLL_MS })
    .toEqual({ planId, fromJobId: jobId(n) });
  await expect
    .poll(async () => (await planRowOf(planId)).sourceJobId, { timeout: 8 * POLL_MS })
    .toBe(jobId(n + 1));
}

/** Append proposals to a job's plan through the door motir-ai uses. */
async function appendAsAi(page: Page, job: SubmittedJob, proposals: unknown[]): Promise<void> {
  const res = await page.request.post('/api/internal/ai/plan-proposals', {
    headers: {
      authorization: `Bearer ${E2E_CORE_CALLBACK_SECRET}`,
      'x-motir-job-token': job.readBackToken!,
    },
    data: { jobId: job.jobId, proposals, final: false },
  });
  if (res.status() !== 200) throw new Error(`plan-proposals ${res.status()}: ${await res.text()}`);
}

// Under the story the overlay is anchored on, so the canvas — scoped to that level — draws it.
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

// ── The hosted planner's step — the internal route's own service method ──────

interface Asker {
  userId: string;
  workspaceId: string;
  projectId: string;
}

async function hostedStep(asker: Asker, planId: string, job: string, sessionKey: string) {
  await aiGenerationService.recordPlanStepForJob(
    { jobId: job, planId, sessionKey, step: 'author', targetRef: null },
    { ctx: { userId: asker.userId, workspaceId: asker.workspaceId }, projectId: asker.projectId },
  );
}

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const liveState = (page: Page) => workspace(page).getByTestId('plan-live-state');
const paneProgress = (page: Page) => workspace(page).getByTestId('plan-progress');
const paneSteps = (page: Page) => paneProgress(page).getByTestId('plan-progress-steps');
const views = (page: Page) => workspace(page).getByTestId('plan-proposal-views');
const viewButton = (page: Page, name: string) =>
  workspace(page)
    .getByRole('group', { name: planReview.viewSwitchAria })
    .getByRole('button', { name, exact: true });
const node = (page: Page, title: string) =>
  workspace(page).getByTestId('canvas-world').locator('[data-node-id]').filter({ hasText: title });
const failedWaiting = (page: Page) => rail(page).getByTestId('planning-failed-waiting');
const resumeButton = (page: Page) => rail(page).getByTestId('planning-resume');
const resumedLine = (page: Page) => rail(page).getByTestId('plan-change-act-resumed');

const planningTable = (page: Page) => page.getByRole('table', { name: en.workbench.tabs.planning });
const planRow = (page: Page, text: string) =>
  planningTable(page).getByRole('row').filter({ hasText: text });
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

/** The reading the pane draws from a review body, on the server's own clock. */
const stateOf = (b: PlanReviewDto) =>
  b.progress ? readPlanProgress(b.progress, Date.parse(b.progress.observedAt)).state : null;
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

// ── Persisted state ──────────────────────────────────────────────────────────

const latestSession = () =>
  adminDb.planChangeSession.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
const planRowOf = (planId: string) => adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
const proposalsTitled = (planId: string, title: string) =>
  adminDb.planItem.findMany({
    where: { planId, proposedFields: { path: ['title'], equals: title } },
    select: { id: true, proposedFields: true, createdAt: true },
  });

/** The saved proposal as it stands: one row of that title, its text and its creation. */
async function savedProposal(planId: string, title: string) {
  const rows = await proposalsTitled(planId, title);
  expect(rows, `exactly one proposal titled ${title}`).toHaveLength(1);
  const fields = rows[0]!.proposedFields as { title?: string; descriptionMd?: string };
  return {
    id: rows[0]!.id,
    title: fields.title,
    descriptionMd: fields.descriptionMd,
    createdAt: rows[0]!.createdAt.toISOString(),
  };
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
async function sendFromCard(page: Page, text: string): Promise<void> {
  const sent = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await rail(page).getByRole('button', { name: 'Send' }).click();
  expect((await sent).status()).toBe(200);
}

/** A second tab of the SAME person, unrecorded, for the Workbench reads. */
async function secondTab(browser: Browser, baseURL: string, email: string) {
  const context = await browser.newContext({ baseURL });
  const tab = await context.newPage();
  await stubAiAccess(tab);
  await signIn(tab, email, PLANNING_ANCHOR_PASSWORD);
  return { tab, close: () => context.close() };
}

async function openWorkbench(tab: Page, which: 'planning' | 'to-resume'): Promise<void> {
  await tab.goto(workbenchTabHref(which));
  await expect(
    tab
      .getByRole('navigation', { name: en.workbench.tabs.label })
      .getByTestId(`workbench-tab-${which}`),
  ).toHaveAttribute('aria-current', 'page', { timeout: FIRST_PAINT_MS });
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

test('a plan whose machine is lost resumes by itself, reads resuming, keeps its saved card, and past the bound waits in To resume', async ({
  page,
  browser,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-8301');

  const email = `auto-resume-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);
  const { tab, close } = await secondTab(browser, baseURL!, email);

  // Every review poll the overlay makes, read as the pane reads it — the record the manual
  // Resume's "never read Resuming" is checked against.
  const polls: { at: number; state: string | null; steps: string[] }[] = [];
  let planId = '';
  page.on('response', async (r) => {
    if (!planId || r.request().method() !== 'GET' || !r.ok()) return;
    if (new URL(r.url()).pathname !== `/api/plans/${planId}`) return;
    try {
      const b = (await r.json()) as PlanReviewDto;
      polls.push({ at: Date.now(), state: stateOf(b), steps: stepKeys(b) });
    } catch {
      /* a body that cannot be read is no reading */
    }
  });

  const FIRST = 'Record the lost machine on the session';
  const SECOND = 'Start the resume as the session’s starter';
  const THIRD = 'Stop after the second automatic attempt';
  let asker!: Asker;
  let sessionId = '';
  let saved!: Awaited<ReturnType<typeof savedProposal>>;

  try {
    await chapter('The plan is being written — one card saved', async () => {
      setPlanOutcome(0, HELD);
      await openFromCard(page, seed.storyKey);
      await sendFromCard(page, 'Split this story into the cards that ship it.');
      const plan = await adminDb.plan.findFirstOrThrow({ where: { sourceJobId: jobId(0) } });
      planId = plan.id;
      const user = await adminDb.user.findUniqueOrThrow({ where: { email } });
      asker = { userId: user.id, workspaceId: plan.workspaceId, projectId: plan.projectId };
      sessionId = (await latestSession()).id;

      const authored = planPolled(page, planId, (b) => b.progress?.authored === 1);
      await appendAsAi(page, submitOf(jobId(0))!, [authoredAdd(FIRST, seed.storyId)]);
      await authored;
      await expect(liveState(page)).toHaveText(planReview.liveWriting);
      await expect(paneProgress(page)).toContainText(
        planReview.progress.authored.replace('{authored}', '1').replace('{proposed}', '1'),
      );
      saved = await savedProposal(planId, FIRST);
      await beat();
    });

    await chapter('The machine is lost — Motir resumes it, and it reads Resuming', async () => {
      const resuming = planPolled(
        page,
        planId,
        (b) => stateOf(b) === 'resuming' && b.progress?.autoResume?.count === 1,
      );
      // (a) the automatic resume's own submit, before anything on screen.
      await loseMachine(0, planId);
      // (b) the plan is the SAME plan, re-pointed, and the session carries no failure.
      const plan = await planRowOf(planId);
      expect(plan.sourceJobId).toBe(jobId(1));
      expect(plan.status).toBe('generating');
      const session = await adminDb.planChangeSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(session.failedAt).toBeNull();
      expect(session.autoResumeCount).toBe(1);
      // (c) the pane's one live region reads Resuming; the rail says why, and offers no Resume.
      await resuming;
      await expect(liveState(page)).toHaveText(planReview.liveResuming);
      // The marker IS the line's one live region (§26.1): the state word is said there.
      await expect(liveState(page)).toHaveAttribute('data-state', 'resuming');
      await expect(liveState(page)).toHaveAttribute('role', 'status');
      await expect(paneSteps(page)).toHaveCount(0);
      await expect(resumedLine(page)).toContainText(act.resumedLine);
      await expect(failedWaiting(page)).toHaveCount(0);
      await expect(resumeButton(page)).toHaveCount(0);

      // (d) the person's Workbench: the plan is still on Planning, reading Resuming, and is not
      // waiting in To resume.
      await openWorkbench(tab, 'planning');
      const row = planRow(tab, seed.storyTitle);
      await expect(row).toHaveCount(1, { timeout: FIRST_PAINT_MS });
      await expect(row.getByTestId('plan-progress-compact')).toHaveAttribute(
        'data-state',
        'resuming',
      );
      await expect(row.getByTestId('plan-progress-compact')).toContainText(planReview.liveResuming);
      await openWorkbench(tab, 'to-resume');
      await expect(resumeEntry(tab, sessionId)).toHaveCount(0);
      await beat();
    });

    await chapter('The new job writes — Being written, the saved card unchanged', async () => {
      const writing = planPolled(page, planId, (b) => stepKeys(b).includes('author-1'));
      await hostedStep(asker, planId, jobId(1), 'author-1');
      await writing;
      await expect(liveState(page)).toHaveText(planReview.liveWriting);
      await expect(paneSteps(page)).toBeVisible();
      expect(await savedProposal(planId, FIRST)).toEqual(saved);
      await expect(views(page)).toBeVisible();
      await viewButton(page, planReview.viewCanvas).click();
      await expect(workspace(page).getByTestId('planning-canvas')).toBeVisible();
      await expect(node(page, FIRST)).toHaveCount(1);
      await beat();
    });

    await chapter(
      'Lost again and again — it waits in To resume, and Resume continues it',
      async () => {
        // The second loss: resumed by itself once more, the second attempt said in words.
        await appendAsAi(page, submitOf(jobId(1))!, [authoredAdd(SECOND, seed.storyId)]);
        const second = planPolled(
          page,
          planId,
          (b) => stateOf(b) === 'resuming' && b.progress?.autoResume?.count === 2,
        );
        await loseMachine(1, planId);
        await second;
        await expect(liveState(page)).toHaveText(planReview.liveResuming);
        await expect(resumedLine(page)).toContainText(act.resumedLineSecond);
        const writing = planPolled(page, planId, (b) => stepKeys(b).includes('author-2'));
        await hostedStep(asker, planId, jobId(2), 'author-2');
        await writing;
        await expect(liveState(page)).toHaveText(planReview.liveWriting);
        await beat();

        // The third loss spends the bound: the failure is recorded and nothing is resubmitted.
        await appendAsAi(page, submitOf(jobId(2))!, [authoredAdd(THIRD, seed.storyId)]);
        setPlanOutcome(2, LOST);
        await expect
          .poll(
            async () =>
              (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } }))
                .failedAt,
            { timeout: 8 * POLL_MS },
          )
          .not.toBeNull();
        const session = await adminDb.planChangeSession.findUniqueOrThrow({
          where: { id: sessionId },
        });
        expect(session.autoResumeCount).toBe(2);
        await expect(failedWaiting(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(failedWaiting(page)).toContainText(planningSession.waitingToResume);
        await expect(resumeButton(page)).toBeVisible();
        for (let read = 0; read < 2; read += 1) {
          expect((await page.request.get(`/api/plans/${planId}`)).ok()).toBe(true);
        }
        expect(planSubmits().map((s) => s.jobId)).toEqual([jobId(0), jobId(1), jobId(2)]);

        await openWorkbench(tab, 'planning');
        await expect(planRow(tab, seed.storyTitle)).toHaveCount(0);
        await openWorkbench(tab, 'to-resume');
        await expect(resumeEntry(tab, sessionId)).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(resumeEntry(tab, sessionId)).toContainText(planningSession.waitingToResume);
        await beat();

        // Resume, pressed: the SAME plan continues, and it never reads Resuming on the way.
        setPlanOutcome(3, HELD);
        const pressedAt = Date.now();
        const resumed = page.waitForResponse(
          (r) => /\/resume$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
        );
        await resumeButton(page).click();
        expect((await resumed).status()).toBe(200);
        expect(submitOf(jobId(3))?.resume).toEqual({ planId, fromJobId: jobId(2) });
        const continued = planPolled(page, planId, (b) => stepKeys(b).includes('author-3'));
        await hostedStep(asker, planId, jobId(3), 'author-3');
        await continued;
        await expect(liveState(page)).toHaveText(planReview.liveWriting);
        await expect(failedWaiting(page)).toHaveCount(0);
        const between = polls.filter((p) => p.at >= pressedAt && !p.steps.includes('author-3'));
        expect(between.filter((p) => p.state === 'resuming')).toEqual([]);
        expect(await savedProposal(planId, FIRST)).toEqual(saved);
        expect(await proposalsTitled(planId, SECOND)).toHaveLength(1);
        expect(await proposalsTitled(planId, THIRD)).toHaveLength(1);
        await beat();
      },
    );
  } finally {
    await close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 5 — nothing saved (unchaptered: it publishes no receipt)
// ─────────────────────────────────────────────────────────────────────────────

test('a job lost before anything was saved waits in To resume, with the reason a failure reads today', async ({
  page,
}) => {
  const email = `auto-resume-empty-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  // A lost machine reads as the provider being unavailable, the reason an outage reads
  // (MOTIR-8304 keeps `model_unavailable`; the two codes' mapping is pinned in
  // `tests/integration/planning/lostMachineFact.test.ts`). A judged `ai_job_failed` reads
  // `job_failed` since MOTIR-8569.
  const reason = planningSession.reason.model_unavailable;

  setPlanOutcome(0, LOST);
  await openFromCard(page, seed.subtaskKey);
  await sendFromCard(page, 'Break this subtask down.');
  await expect(failedWaiting(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(failedWaiting(page)).toContainText(reason);
  await expect(resumeButton(page)).toBeVisible();

  const session = await latestSession();
  expect(session.failedAt).not.toBeNull();
  expect(session.autoResumeCount).toBe(0);
  expect(planSubmits().map((s) => s.jobId)).toEqual([jobId(0)]);

  await page.goto(workbenchTabHref('to-resume'));
  await expect(resumeEntry(page, session.id)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(resumeEntry(page, session.id)).toContainText(planningSession.waitingToResume);
  await expect(resumeEntry(page, session.id)).toContainText(reason);
  // Still nothing resubmitted once the person has read it.
  expect(planSubmits().map((s) => s.jobId)).toEqual([jobId(0)]);
});
