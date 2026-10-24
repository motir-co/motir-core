import { readFileSync, writeFileSync } from 'node:fs';
import type { Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAiAugmentReplan,
  markProjectOnboarded,
  type AiAugmentReplanSeed,
} from './_helpers/ai-augment-replan-seed';
import { logBugAsAi } from './_helpers/log-bug-as-ai';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import type {
  AiJobsFixture,
  GuideJobOutcome,
  PlanJobOutcome,
  SubmittedJob,
} from '@/lib/test-ai-jobs-mock';
import en from '@/messages/en.json';

// ACCEPTANCE — a confirmed bug is filed the moment it is confirmed (Story
// MOTIR-7797 · MOTIR-7809). The receipt a person watches to accept the story:
//
//   1. In the PROJECT CONVERSATION (the planning rail), a planning run confirms a
//      defect and files it through the real log-bug route; the planner's turn
//      names the new key as a live chip, and the bug sits in `Bugs`.
//   2. A SUSPICION in the same conversation files nothing.
//   3. In GUIDE ME THROUGH, a turn files the confirmed defect as the person, and
//      the rail draws the drawn `file_bug` line naming the new key (design
//      MOTIR-7810); the turn's tick lands too.
//   4. A SUSPICION in the guide files nothing.
//   5. Each chip opens a real bug in `Bugs`.
//
// ── THE BOUNDARY, AND WHAT THIS RECEIPT DOES NOT CLAIM ──────────────────────
// motir-ai is mocked UNDER the routes by `lib/test-ai-jobs-mock.ts` (the lane's
// `E2E_TEST_AI_JOBS=1` intercept). The spec PLAYS motir-ai's two halves:
//   - the conversation's `log_bug` is made by this spec through the REAL
//     `POST /api/internal/ai/log-bug`, with the job token motir-core minted into
//     the submit's envelope (the mock records it) and that job's id — exactly as
//     motir-ai's `buildBugFilingSink` does. No bug row is seeded;
//   - the guide's `file_bug` action is the queued job result, which the REAL
//     `guideLandingService` validates and lands as the person.
// So this proves motir-core's side of each door, driven from the browser. That
// the conversation model calls `log_bug` ONLY on a confirmed defect, and that the
// guide's validator drops an unconsented or rootless filing, are motir-ai's own
// decisions, owned by its story gate — the mock stands in for both, and a "nothing
// filed" chapter here proves only that motir-core files nothing it was not asked
// to. Row-level properties (the cap, concurrency, cross-project, a done parent, a
// duplicate) are owned by the motir-core story integration gate.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on the AUTHORITATIVE signal (CLAUDE.md): the conversation
// submit's 200, the log-bug 201 and its body, the planner-turn record's 200 (HELD
// at the network until the filing has happened, so the turn the planner speaks
// is the one that names the key); for the guide, the door's 200 and the settle
// whose BODY says `guided`. Every "nothing filed" and "placed in Bugs" claim is
// read from Postgres. No fixed timeout anywhere.

test.describe.configure({ timeout: 240_000 });

const JOBS_FIXTURE =
  process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ?? '/tmp/motir-acceptance-ai-jobs-fixture.json';

function readJobsFixture(): AiJobsFixture {
  try {
    return JSON.parse(readFileSync(JOBS_FIXTURE, 'utf8')) as AiJobsFixture;
  } catch {
    return {};
  }
}

/** Write the fixture, keeping what the mock has RECORDED (`submitted`). */
function patchJobsFixture(patch: (f: AiJobsFixture) => void): void {
  const f = readJobsFixture();
  patch(f);
  writeFileSync(JOBS_FIXTURE, JSON.stringify(f, null, 2));
}

/** The planning runs the mock accepted, in order — what the queue indexes by. */
const planSubmits = (): SubmittedJob[] =>
  (readJobsFixture().submitted ?? []).filter((s) => s.kind === 'plan' && !s.refused);

/** Declare what the `n`-th planning run settles as (0-based), padding earlier ones. */
function declarePlanRun(n: number, outcome: PlanJobOutcome): void {
  patchJobsFixture((f) => {
    const queue = [...(f.plan ?? [])];
    while (queue.length < n) queue.push({});
    queue[n] = outcome;
    f.plan = queue;
  });
}

/** APPEND the next guide job's answer. */
function queueGuide(outcome: GuideJobOutcome): void {
  patchJobsFixture((f) => {
    f.guide = [...(f.guide ?? []), outcome];
  });
}
const queueGuideTurn = (messageMd: string, actions: unknown[]) =>
  queueGuide({ guideTurn: { messageMd, actions } });

// ── Locators ────────────────────────────────────────────────────────────────

const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const guideDoor = (page: Page) => page.getByRole('button', { name: /Guide me through/ });
const reports = (page: Page) => rail(page).getByTestId('plan-change-report');
const guideTurns = (page: Page) => rail(page).getByTestId('guide-turn');
const folderCrumbs = (page: Page) =>
  page.getByRole('navigation', { name: 'Folder and parent work items', exact: true });
const typeCard = (page: Page) =>
  page
    .getByRole('main')
    .locator('[data-surface="card"]')
    .filter({
      has: page.getByRole('button', { name: `Edit ${en.issueViews.type}`, exact: true }),
    });

// ── Authoritative signals ───────────────────────────────────────────────────

const isPost = (r: Response, pathname: string) =>
  new URL(r.url()).pathname === pathname && r.request().method() === 'POST';
const PLANNER_TURN = '/api/ai/plan-change/session/planner-turn';

const plannerTurnRecorded = (page: Page) => page.waitForResponse((r) => isPost(r, PLANNER_TURN));
const guideOpened = (page: Page) => page.waitForResponse((r) => isPost(r, '/api/ai/guide'));
const guideSettled = (page: Page) => page.waitForResponse((r) => isPost(r, '/api/ai/guide/settle'));

interface GuideSettle {
  outcome?: string;
  record?: { outcomes: Array<{ type: string; outcome: string; workItemKey?: string }> };
}

/** The settle's body, asserted `guided` — the turn landed. */
async function guided(res: Promise<Response>): Promise<GuideSettle> {
  const r = await res;
  const body = (await r.json()) as GuideSettle;
  expect(r.status(), JSON.stringify(body)).toBe(200);
  expect(body.outcome, JSON.stringify(body)).toBe('guided');
  return body;
}

/**
 * Hold the NEXT planner-turn record at the network until `release()`. The run's
 * stream closes at once under the mock, so without the hold the rail would read
 * the planner's turn before the spec — playing motir-ai — had filed the bug the
 * turn names. `times: 1` retires the handler after this one request.
 */
async function holdNextPlannerTurn(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(
    `**${PLANNER_TURN}`,
    async (route) => {
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  return release;
}

/** Send a conversation turn from the card; its 200 is the submit accepted. */
async function sendConversationTurn(page: Page, text: string): Promise<void> {
  const sent = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await rail(page).getByRole('textbox').fill(text);
  await rail(page).getByRole('button', { name: 'Send' }).click();
  expect((await sent).status()).toBe(200);
}

async function sendGuideTurn(page: Page, text: string): Promise<GuideSettle> {
  const opened = guideOpened(page);
  const settled = guideSettled(page);
  await rail(page).getByPlaceholder('Tell Motir AI how the step went…').fill(text);
  await rail(page).getByRole('button', { name: 'Send' }).click();
  expect((await opened).status()).toBe(200);
  return guided(settled);
}

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

// ── Persisted state ─────────────────────────────────────────────────────────

const bugCount = (projectId: string) =>
  adminDb.workItem.count({ where: { projectId, kind: 'bug' } });
const bugByKey = (identifier: string) =>
  adminDb.workItem.findFirstOrThrow({ where: { identifier } });
async function bugsFolderId(projectId: string): Promise<string> {
  const project = await adminDb.project.findUniqueOrThrow({ where: { id: projectId } });
  expect(project.bugDestinationFolderId).not.toBeNull();
  return project.bugDestinationFolderId!;
}

/** Follow a chip's link to the bug's item page, and prove it is a bug in `Bugs`. */
async function followChipToBug(page: Page, chip: ReturnType<Page['locator']>, key: string) {
  const href = await chip.getAttribute('href');
  expect(href).toBe(`/items/${key}`);
  await page.goto(href!);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(typeCard(page)).toContainText('Bug');
  await expect(folderCrumbs(page)).toContainText('Bugs');
}

let seed: AiAugmentReplanSeed;

test.beforeEach(async () => {
  await resetDatabase();
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ submitted: [] }, null, 2));
  seed = await seedAiAugmentReplan(`confirmed-bug-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('a confirmed defect is filed and named back in the conversation and in the guide; a suspicion files nothing', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7797');
  await stubAiAccess(page);

  // The guided card: a manual task with a to-do list.
  const guideCard = await workItemsService.createWorkItem(
    {
      projectId: seed.projectId,
      kind: 'task',
      title: 'Rotate the webhook signing secret',
      type: 'manual',
      executor: 'human',
    },
    seed.ctx,
  );
  const [s1, s2] = [
    (await workItemTodosService.addTodo(guideCard.id, { text: 'Save the new secret' }, seed.ctx))
      .todo.id,
    (await workItemTodosService.addTodo(guideCard.id, { text: 'Send a test event' }, seed.ctx)).todo
      .id,
  ];
  const bugsFolder = await bugsFolderId(seed.projectId);

  await signIn(page, seed.email, seed.password);

  let conversationBug = '';
  let conversationChipHref = '';

  await chapter(
    'In the conversation, a confirmed defect is filed and its key named back',
    async () => {
      await page.goto(`/items/${seed.loginKey}`);
      await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await entrance(page).click();
      await page.waitForURL((url) => url.searchParams.has('plan'));
      await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

      const before = await bugCount(seed.projectId);
      const release = await holdNextPlannerTurn(page);
      const recorded = plannerTurnRecorded(page);
      await sendConversationTurn(
        page,
        'Login fails with a 500 when the email has a plus sign. Plan the fix.',
      );

      // The run motir-core submitted, with the job token it minted for it.
      const job = planSubmits().at(-1)!;
      expect(job.jobId).toBeTruthy();
      expect(job.readBackToken).toBeTruthy();
      // Its plan is open, bound to the job — what the route counts the filing on.
      const plan = await adminDb.plan.findFirstOrThrow({ where: { sourceJobId: job.jobId! } });

      // motir-ai's `log_bug`, through the REAL route, as that job.
      conversationBug = await logBugAsAi(page, {
        readBackToken: job.readBackToken!,
        jobId: job.jobId!,
        title: 'Login returns HTTP 500 for an email with a plus sign',
        descriptionMd: [
          `**Found while:** planning ${seed.loginKey}`,
          '',
          '## Root cause',
          'The login handler URL-decodes the email, turning `+` into a space.',
        ].join('\n'),
      });

      // The planner's turn names the key it filed; then the held record goes on.
      declarePlanRun(planSubmits().length - 1, {
        turn: {
          message: `I reproduced it and traced it to the login handler, so I filed ${conversationBug} for the fix before planning around it.`,
        },
      });
      release();
      expect((await recorded).status()).toBe(200);

      const chip = reports(page).last().locator('a.wi-chip').filter({ hasText: conversationBug });
      await expect(chip).toBeVisible();
      conversationChipHref = (await chip.getAttribute('href')) ?? '';

      // PERSISTED: one bug, in the project's Bugs folder, on the job's plan trail.
      expect(await bugCount(seed.projectId)).toBe(before + 1);
      const bug = await bugByKey(conversationBug);
      expect(bug.kind).toBe('bug');
      expect(bug.folderId).toBe(bugsFolder);
      expect(bug.parentId).toBeNull();
      expect(
        await adminDb.planRevision.count({ where: { planId: plan.id, changeKind: 'bug_filed' } }),
      ).toBe(1);
      await beat();
    },
  );

  await chapter('In the conversation, a suspicion files nothing', async () => {
    const before = await bugCount(seed.projectId);
    const SUSPECTED =
      'Sessions may be expiring early on Safari, but I have not reproduced it or found a cause in the code, so I have filed nothing.';
    declarePlanRun(planSubmits().length, { turn: { message: SUSPECTED } });
    const recorded = plannerTurnRecorded(page);
    await sendConversationTurn(page, 'Also, people say they get logged out on Safari.');
    expect((await recorded).status()).toBe(200);

    const report = reports(page).last();
    await expect(report).toContainText('I have not reproduced it');
    await expect(report.locator('.wi-chip')).toHaveCount(0);
    expect(await bugCount(seed.projectId)).toBe(before);
    await beat();
  });

  await chapter('The conversation’s chip opens a bug in Bugs', async () => {
    expect(conversationChipHref).toBe(`/items/${conversationBug}`);
    await page.goto(conversationChipHref);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Login returns HTTP 500 for an email with a plus sign',
      { timeout: FIRST_PAINT_MS },
    );
    await expect(typeCard(page)).toContainText('Bug');
    await expect(folderCrumbs(page)).toContainText('Bugs');
    await beat();
  });

  let guideBug = '';

  await chapter(
    'In Guide me through, a confirmed defect is filed and drawn as a line',
    async () => {
      await page.goto(`/items/${guideCard.identifier}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      queueGuideTurn('Step 1: save the new secret in the console.', [
        { type: 'current_step', rowId: s1 },
      ]);
      const opened = guideOpened(page);
      const settled = guideSettled(page);
      await guideDoor(page).click();
      expect((await opened).status()).toBe(200);
      await guided(settled);
      await page.waitForURL((url) => url.searchParams.get('plan') === 'guide');
      await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

      const before = await bugCount(seed.projectId);
      queueGuideTurn(
        'That is a defect in the console, not a step you missed: the save handler still reads the old secret. I filed it, and ticked the step since the secret is saved by the CLI.',
        [
          {
            type: 'file_bug',
            title: 'Saving a rotated signing secret returns HTTP 500',
            descriptionMd: [
              'Saving a new webhook signing secret in the console answers HTTP 500.',
              '',
              '## Root cause',
              'The save handler reads the previous secret id after the rotation.',
            ].join('\n'),
            blocksGuidedCard: false,
          },
          { type: 'tick', rowId: s1 },
        ],
      );
      const settle = await sendGuideTurn(
        page,
        'Saving the new secret in the console gives a 500 every time — please file it. I saved it with the CLI instead.',
      );
      const filed = settle.record!.outcomes[0]!;
      expect(filed).toMatchObject({ type: 'file_bug', outcome: 'landed' });
      guideBug = filed.workItemKey!;
      expect(settle.record!.outcomes[1]).toMatchObject({ type: 'tick', outcome: 'landed' });

      // The drawn line names the NEW key through its chip; the tick's line is beside it.
      const turn = guideTurns(page).last();
      const line = turn.locator('[data-testid="guide-outcome"][data-outcome="filed"]');
      await expect(line).toContainText('Filed');
      await expect(line.locator('a.wi-chip')).toContainText(guideBug);
      await expect(turn.locator('[data-outcome="ticked"]')).toBeVisible();
      // Named ONCE: the body's note is not drawn beside the line (decision (a)).
      await expect(turn).not.toContainText('Filed a bug:');

      // PERSISTED: one bug, in Bugs, related to the guided card; the tick landed.
      expect(await bugCount(seed.projectId)).toBe(before + 1);
      const bug = await bugByKey(guideBug);
      expect(bug.kind).toBe('bug');
      expect(bug.folderId).toBe(bugsFolder);
      expect(bug.descriptionMd!.split('\n')[0]).toContain(
        `**Found while:** guiding [${guideCard.identifier}]`,
      );
      const link = await adminDb.workItemLink.findFirst({
        where: { fromId: bug.id, toId: guideCard.id, kind: 'relates_to' },
      });
      expect(link).not.toBeNull();
      const done = await adminDb.workItemTodo.findUniqueOrThrow({ where: { id: s1 } });
      expect(done.doneAt).not.toBeNull();
      await beat();
    },
  );

  await chapter('In Guide me through, a suspicion files nothing', async () => {
    const before = await bugCount(seed.projectId);
    queueGuideTurn(
      'The test event may be arriving late, but I have not seen it fail and cannot point to a cause, so I have filed nothing. Step 2: send a test event.',
      [{ type: 'current_step', rowId: s2 }],
    );
    const settle = await sendGuideTurn(page, 'The test event seemed slow to show up.');
    expect(settle.record!.outcomes.some((o) => o.type === 'file_bug')).toBe(false);

    const turn = guideTurns(page).last();
    await expect(turn).toContainText('I have filed nothing');
    await expect(turn.locator('[data-outcome="filed"]')).toHaveCount(0);
    expect(await bugCount(seed.projectId)).toBe(before);
    await beat();
  });

  await chapter('The guide’s chip opens a bug in Bugs, found while guiding', async () => {
    const chip = guideTurns(page)
      .nth(1)
      .locator('[data-outcome="filed"] a.wi-chip')
      .filter({ hasText: guideBug });
    await followChipToBug(page, chip, guideBug);
    await expect(page.getByRole('main')).toContainText('Found while:');
    await expect(page.getByRole('main')).toContainText(guideCard.identifier);
    await beat();
  });
});
