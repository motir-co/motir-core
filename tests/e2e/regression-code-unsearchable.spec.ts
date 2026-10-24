import { writeFileSync } from 'node:fs';
import type { Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import { seedAiAugmentReplan, markProjectOnboarded } from './_helpers/ai-augment-replan-seed';
import { declareSeam, mailboxRows, planRun, postPause, submitsOf } from './_helpers/mid-run-seam';
import en from '@/messages/en.json';

// Acceptance E2E — planning that cannot search a target repository's code STOPS, as a
// person sees it (Subtask MOTIR-9171, bug MOTIR-9165; the receipt attaches to Story MOTIR-7990, since a receipt needs a story).
//
// Runs under `playwright.acceptance.config.ts` (MOTIR_CLOUD + `video: 'on'`) — the lane
// where the planning overlay mounts at all. `acceptanceStory()` pins the clip to the story.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A. A change is asked for while the target repository has no code graph. The planner does
//    not guess: nothing is planned, the plan on the canvas is untouched, and the rail says
//    which repository, why, and where to go. There is no resume button, because no run
//    exists — the next message is the retry. Reload and the banner is still there.
// B. A run that is already planning meets the same wall mid-walk. It pauses; the proposals
//    written so far stay; the banner offers Go to Codebase and Check again and continue.
//    The link reaches the Codebase page. A re-check that is still blocked keeps the banner,
//    says which repository still can't be searched and what it now shows. The next check
//    finds the code searchable, the run goes on, and the banner is gone.
//
// ── HOW motir-ai IS STOOD IN FOR ────────────────────────────────────────────
//
// As `regression-mid-run-conversation.spec.ts` and `regression-code-unreadable.spec.ts`
// stand it in: at the JOB boundary (`lib/test-ai-jobs-mock.ts`). A is the plan job SETTLING
// with the blocked list (the pre-planning stop's envelope). B holds the run in progress and
// the spec plays the run's side of the pause through the door motir-ai calls
// (`plan-change-run-pause`, with the run's job token). The real routes, services,
// repositories and Postgres all run, which is what lets the reload beat prove persistence.
//
// WHAT THIS RECEIPT DELIBERATELY DOES NOT ASSERT: that motir-ai's gate decides the stop for a
// real index state — that is motir-ai's own gate (`tests/codeSearchGate.test.ts`) — and that
// the Codebase page can repair the index (its own stories).
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a response and its body, a
// committed row read from Postgres, or the rendered element itself; `beat()` / the chapter
// hold are PACING only, each after the assertion that proved the state.

test.describe.configure({ timeout: 240_000 });

const cu = en.planningWorkspace.codeUnsearchable;
const conv = en.planningWorkspace.conversation;

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const sendButton = (page: Page) => rail(page).getByRole('button', { name: 'Send', exact: true });
const banner = (page: Page) => rail(page).getByTestId('code-unsearchable-banner');
const resumeButton = (page: Page) => rail(page).getByTestId('code-unsearchable-resume');
const codebaseLink = (page: Page) => rail(page).getByTestId('code-unsearchable-codebase');
const canvasNodes = (page: Page) =>
  workspace(page).getByTestId('planning-canvas').locator('[data-node-id]');

const path = (r: Response) => new URL(r.url()).pathname;
const isPost = (r: Response, pathname: string) =>
  path(r) === pathname && r.request().method() === 'POST';
const isGet = (r: Response, pathname: string) =>
  path(r) === pathname && r.request().method() === 'GET';

const RUN_PAUSE = '/api/ai/plan-change/session/run-pause';
const BLOCKED = [{ repoRef: 'motir-co/motir-core', state: 'never_indexed' }];

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

/** The next pause READ of `kind` — the rail's poll finding the planner's pause. */
function pauseReadOf(page: Page, answer: string | null): Promise<Response> {
  return page.waitForResponse(async (r) => {
    if (!isGet(r, RUN_PAUSE) || r.status() !== 200) return false;
    try {
      const body = (await r.json()) as { kind?: string; answer?: string | null } | null;
      return body?.kind === 'code_unsearchable' && (body.answer ?? null) === answer;
    } catch {
      return false;
    }
  });
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ A. Stopped in the conversation ═════════════════════════════════════════

test('A. a change asked for over unsearchable code plans nothing and says which repository', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9165');
  writeFileSync(
    process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!,
    JSON.stringify(
      {
        ask: [{ intent: 'plan_change', answer: null, citations: [] }],
        plan: [{ codeUnsearchable: BLOCKED }],
        submitted: [],
      },
      null,
      2,
    ),
  );
  const email = `code-unsearchable-a-${Date.now()}@example.com`;
  await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  let before: string[] = [];
  const nodeIds = () =>
    canvasNodes(page).evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-node-id') ?? '').sort(),
    );

  await chapter('Ask for a change while the target repository has no code graph', async () => {
    await page.goto('/dashboard');
    const orb = page.getByRole('button', { name: 'Motir AI', exact: true });
    await expect(orb).toBeVisible({ timeout: FIRST_PAINT_MS });
    await orb.click();
    await page
      .getByRole('dialog', { name: 'Motir AI' })
      .getByRole('link', { name: /Ask about this project/ })
      .click();
    await page.waitForURL((url) => url.searchParams.has('plan'));
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(canvasNodes(page).first()).toBeVisible({ timeout: FIRST_PAINT_MS });
    before = await nodeIds();

    const filed = page.waitForResponse(
      (r) => isPost(r, '/api/ai/plan-change/session/planner-turn') && r.status() === 200,
    );
    await composer(page).fill('Add a story for exporting invoices.');
    await sendButton(page).click();
    await filed;

    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toHaveAttribute('data-where', 'conversation');
    await expect(banner(page)).toContainText(cu.title);
    await expect(banner(page)).toContainText(cu.introConversation);
    const row = banner(page).getByTestId('code-unsearchable-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('motir-co/motir-core');
    await expect(row).toContainText(cu.states.never_indexed.chip);
    await expect(row).toContainText(cu.states.never_indexed.line);
    // Information, not the failure treatment — and there is no run to resume.
    await expect(rail(page).getByRole('alert')).toHaveCount(0);
    await expect(resumeButton(page)).toHaveCount(0);
    await beat();
  });

  await chapter('Nothing was planned, and the plan on the canvas is untouched', async () => {
    // Polled, not read once (MOTIR-9411): the canvas re-renders after the turn
    // lands, and in the recording lane a 4 s beat always covered that window.
    // The claim is unchanged: the same nodes as before the turn.
    await expect.poll(nodeIds).toEqual(before);
    expect(await adminDb.planItem.count(), 'no proposal was written').toBe(0);
    await expect(codebaseLink(page)).toHaveAttribute('href', '/code');
    await expect(codebaseLink(page)).toHaveText('Go to Codebase');
    await beat();
  });

  await chapter('Reload: the banner is still on the turn that stopped', async () => {
    const stored = await adminDb.planChangeTurn.findMany({
      where: { role: 'assistant' },
      select: { codeUnsearchable: true },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.codeUnsearchable).toEqual(BLOCKED);
    await page.reload();
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(banner(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(banner(page).getByTestId('code-unsearchable-row')).toHaveCount(1);
    await beat();
  });
});

// ═══ B. Paused mid-walk ═════════════════════════════════════════════════════

test('B. a run that meets unsearchable code pauses, links to the Codebase page, and resumes on the check', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9165');
  const seed = await seedAiAugmentReplan(`code-unsearchable-b-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  await stubAiAccess(page);
  await signIn(page, seed.email, seed.password);
  declareSeam({});

  const run = async () => planRun(submitsOf('plan').length - 1);
  let handle!: Awaited<ReturnType<typeof run>>;
  let firstPauseId = '';

  await chapter('A run starts planning and is held in progress', async () => {
    await page.goto(`/items/${seed.loginKey}`);
    const entrance = page.getByRole('main').getByTestId('work-item-plan-entrance');
    await expect(entrance).toBeVisible({ timeout: FIRST_PAINT_MS });
    await entrance.click();
    await page.waitForURL((url) => url.searchParams.has('plan'));
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    const submitted = page.waitForResponse(
      (r) => /\/api\/work-items\/[^/]+\/ai\/plan$/.test(path(r)) && r.request().method() === 'POST',
    );
    await composer(page).fill('Plan the sign-in screen.');
    await sendButton(page).click();
    expect((await submitted).status()).toBe(200);
    await expect(rail(page).getByTestId('plan-change-stop')).toBeVisible();
    handle = await run();
    await beat();
  });

  await chapter('The run pauses: it cannot search the target repository', async () => {
    const found = pauseReadOf(page, null);
    const recorded = await postPause(page, handle, { kind: 'code_unsearchable', repos: BLOCKED });
    expect(recorded.outcome).toBe('recorded');
    expect(recorded.pause.kind).toBe('code_unsearchable');
    firstPauseId = recorded.pause.id;
    await found;

    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toHaveAttribute('data-where', 'walk');
    await expect(banner(page)).toContainText(cu.introWalk);
    await expect(banner(page).getByTestId('code-unsearchable-row')).toHaveCount(1);
    // Paused, waiting on THEM; Stop stays; it is not the re-plan pair or a question.
    await expect(rail(page).getByTestId('plan-change-running-bar')).toHaveAttribute(
      'data-paused',
      'true',
    );
    await expect(rail(page).getByTestId('plan-change-paused-line')).toHaveText(
      en.planningWorkspace.conversation.midRun.pause.waitingResume,
    );
    await expect(rail(page).getByTestId('plan-change-stop')).toBeVisible();
    await expect(rail(page).getByTestId('planner-start-over-offer')).toHaveCount(0);
    await expect(rail(page).getByRole('alert')).toHaveCount(0);
    await beat();
  });

  await chapter('The link reaches the Codebase page', async () => {
    await expect(codebaseLink(page)).toHaveAttribute('href', '/code');
    const opened = page.context().waitForEvent('page');
    await codebaseLink(page).click({ modifiers: ['ControlOrMeta'] });
    const codebase = await opened;
    await codebase.waitForURL((url) => url.pathname === '/code');
    await codebase.close();
    // The planning rail was left as it was.
    await expect(banner(page)).toBeVisible();
    await beat();
  });

  await chapter(
    'Check again: still blocked, so the banner stays and says what it now shows',
    async () => {
      const answered = page.waitForResponse((r) => isPost(r, RUN_PAUSE));
      await resumeButton(page).click();
      const res = await answered;
      expect(res.status(), await res.text()).toBe(200);
      const body = (await res.json()) as { outcome: string; pause: { answer: string } };
      expect(body.outcome).toBe('answered');
      expect(body.pause.answer).toBe('resumed');

      // ONE new entry, answering THIS pause — the run's word to check again.
      const rows = (await mailboxRows(handle.jobId)).filter((r) => r.kind === 'turn');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ disposition: 'fold', answersPauseId: firstPauseId });

      // The run re-checks and finds the repository still indexing: a NEW pause, new states.
      const found = pauseReadOf(page, null);
      const second = await postPause(page, handle, {
        kind: 'code_unsearchable',
        repos: [{ repoRef: 'motir-co/motir-core', state: 'indexing' }],
      });
      expect(second.outcome).toBe('recorded');
      expect(second.pause.id).not.toBe(firstPauseId);
      await found;

      await expect(banner(page)).toBeVisible();
      await expect(banner(page).getByTestId('code-unsearchable-row')).toContainText(
        cu.states.indexing.chip,
      );
      const status = banner(page).getByTestId('code-unsearchable-checked');
      await expect(status).toHaveAttribute('role', 'status');
      await expect(status).toContainText('motir-co/motir-core');
      await expect(status).toContainText(cu.states.indexing.chip);
      await beat();
    },
  );

  await chapter('Check again: the code can be searched, so planning goes on', async () => {
    const answered = page.waitForResponse((r) => isPost(r, RUN_PAUSE));
    await resumeButton(page).click();
    expect((await answered).status()).toBe(200);

    await expect(banner(page)).toHaveCount(0);
    await expect(rail(page).getByTestId('code-unsearchable-resumed')).toContainText(
      conv.answeredMarker,
    );
    await expect(rail(page).getByTestId('plan-change-running-bar')).not.toHaveAttribute(
      'data-paused',
      'true',
    );
    const rows = (await mailboxRows(handle.jobId)).filter((r) => r.kind === 'turn');
    expect(rows).toHaveLength(2);
    await beat();
  });
});
