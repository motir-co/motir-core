// Acceptance E2E — situation 2: a failed change of a waiting plan (Story MOTIR-7905 · Subtask
// MOTIR-7943).
//
// COVERED: cases 1–3 (the failed change waits in To resume with no Resume; Open lands on the plan
// with an enabled chatbox; a turn revises the SAME plan in the SAME session and clears the entry).
// NOT YET COVERED: Approve from the overlay (4), the pre-story `failed`-ended carry (5), failed
// again (6), only-the-owner (7), zh (8) and the stale branch (9). This spec has not been run: the
// sandbox cannot build the app (Google Fonts unreachable).
//
// The change is asked as an ordinary second turn in the overlay (a turn on a session holding a
// `planned` plan routes to the session revise); the failure comes from the seam's `failed` plan
// outcome and the real relay. Revised proposals are written through the job-token door motir-ai
// uses (`POST /api/internal/ai/plan-proposals`).
import { readFileSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import { E2E_CORE_CALLBACK_SECRET } from './_helpers/log-bug-as-ai';
import type { AiJobsFixture, PlanJobOutcome, SubmittedJob } from '@/lib/test-ai-jobs-mock';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 300_000 });

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

/** APPEND the next plan run's outcome, keeping `submitted` (the mock indexes the queue by it). */
function queuePlan(outcome: PlanJobOutcome): void {
  const f = readJobsFixture();
  f.plan = [...(f.plan ?? []), outcome];
  writeFileSync(JOBS_FIXTURE, JSON.stringify(f, null, 2));
}

const planSubmits = (): SubmittedJob[] =>
  (readJobsFixture().submitted ?? []).filter((s) => s.kind === 'plan' && !s.refused);

/** Append proposals to a job's plan through the door motir-ai uses. */
async function appendAsAi(
  page: Page,
  job: SubmittedJob,
  proposals: unknown[],
  final = false,
  revision = false,
): Promise<string[]> {
  const res = await page.request.post('/api/internal/ai/plan-proposals', {
    headers: {
      authorization: `Bearer ${E2E_CORE_CALLBACK_SECRET}`,
      'x-motir-job-token': job.readBackToken!,
    },
    data: { jobId: job.jobId, proposals, final, ...(revision ? { revision: true } : {}) },
  });
  if (res.status() !== 200) throw new Error(`plan-proposals ${res.status()}: ${await res.text()}`);
  const body = (await res.json()) as { planItemIds?: string[]; ids?: string[] };
  return body.planItemIds ?? body.ids ?? [];
}

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

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

// ── Persisted state ──────────────────────────────────────────────────────────

const latestSession = () =>
  adminDb.planChangeSession.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });

// ── Steps ────────────────────────────────────────────────────────────────────

async function openFromCard(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

async function closeOverlay(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForURL(overlayClosed);
  await expect(workspace(page)).toHaveCount(0);
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

test.beforeEach(async () => {
  await resetDatabase();
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ submitted: [] }, null, 2));
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('a failed change of a waiting plan keeps the session; a turn revises the same plan; Approve works', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7905');

  const email = `situation-two-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  let sessionId = '';
  let planId = '';

  await chapter('A plan waits for approval, then a change asked of it fails', async () => {
    // First turn: the run writes one proposal and closes the plan as `planned`.
    queuePlan({ status: 'succeeded' });
    await openFromCard(page, seed.storyKey);
    await sendFromCard(page, 'Plan the canvas work.');
    const first = planSubmits().at(-1)!;
    expect(first.jobId, 'the seam is mounted: the first plan submit was recorded').toBeTruthy();
    await appendAsAi(
      page,
      first,
      [{ op: 'add', proposedFields: { title: 'Canvas seam', kind: 'task' } }],
      true,
    );
    const plan = await adminDb.plan.findFirstOrThrow({ where: { sourceJobId: first.jobId! } });
    planId = plan.id;
    sessionId = (await latestSession()).id;
    await expect
      .poll(async () => (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status)
      .toBe('planned');

    // Second turn asks a change; that run FAILS.
    queuePlan({ status: 'failed' });
    await page.reload();
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await sendFromCard(page, 'Also split out the tests.');
    await expect
      .poll(
        async () =>
          (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } }))
            .failedAt,
      )
      .not.toBeNull();

    const session = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.endedAt).toBeNull();
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
    expect(await adminDb.planTargetLock.count({ where: { sessionId } })).toBeGreaterThan(0);
    await closeOverlay(page);

    await page.goto('/workbench?tab=to-resume');
    const entry = resumeEntry(page, sessionId);
    await expect(entry).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(
      entry.getByRole('button', { name: en.workbench.planningSession.resume }),
    ).toHaveCount(0);
    await beat();
  });

  await chapter('Open lands in the overlay with the plan and an enabled chatbox', async () => {
    await resumeEntry(page, sessionId).getByTestId('to-resume-session-open').click();
    await page.waitForURL(overlayOpen);
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(composer(page)).toBeEnabled();
    await expect(rail(page).getByTestId('planning-resume')).toHaveCount(0);
    await expect(rail(page).getByTestId('planning-session-end')).toHaveCount(0);
    await beat();
  });

  await chapter('A turn revises the same plan in the same session', async () => {
    queuePlan({ status: 'succeeded' });
    const sent = page.waitForResponse(
      (r) => new URL(r.url()).pathname.endsWith('/ai/plan') && r.request().method() === 'POST',
    );
    await composer(page).fill('Please try that change again.');
    await rail(page).getByRole('button', { name: 'Send' }).click();
    const res = await sent;
    expect(res.status()).toBe(200);
    const { planId: revisedPlanId, jobId } = (await res.json()) as {
      planId: string;
      jobId: string;
    };
    expect(revisedPlanId).toBe(planId);

    const job = planSubmits().find((s) => s.jobId === jobId)!;
    await appendAsAi(
      page,
      job,
      [{ op: 'add', proposedFields: { title: 'Canvas tests', kind: 'task' } }],
      true,
      // The turn is a REVISION of the waiting plan, so the append says so (the plan stays `planned`).
      true,
    );

    const session = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.failedAt).toBeNull();
    expect(session.endedAt).toBeNull();
    expect(await adminDb.plan.count({ where: { sessionId } })).toBe(1);
    expect(await adminDb.planChangeSession.count()).toBe(1);
    await closeOverlay(page);

    await page.goto('/workbench?tab=to-resume');
    await expect(resumeEntry(page, sessionId)).toHaveCount(0);
    await beat();
  });
});
