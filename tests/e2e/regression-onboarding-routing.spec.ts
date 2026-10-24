// Acceptance E2E — WHERE THREE PROJECTS END UP (Subtask MOTIR-4762, Story
// MOTIR-4753).
//
// ⚠️ THE STORY'S DELIVERABLE IS A DIFFERENCE, so the recording has to show more
// than one journey. A clip of only the fast path is indistinguishable from a
// build that skips onboarding for everybody — which is precisely the outcome
// this story must not have shipped. All three destinations are in ONE recording,
// chaptered, and what a viewer must be able to tell apart is where each project
// ends up:
//
//   1 · a repository Motir can READ, and a backlog  → it PLANS. No onboarding.
//   2 · nothing at all                              → new-project onboarding.
//   3 · a repository that is not enough             → "I have a project", with a
//                                                     rail SHORTER than the full
//                                                     one.
//
// ── WHAT IS REAL AND WHAT IS MOCKED ────────────────────────────────────────
// The SUBSTRATE is real: a genuine grant-mirror row and a genuine succeeded
// `system.code-graph-index` ledger row, both written the way the product writes
// them, so `readOnboardingSubstrate` answers from committed state and the
// reading state names what it actually found. The VERDICT is `motir-ai`'s and is
// mocked at the open-core boundary — the only interceptable seam, and the same
// one every other cloud spec uses. The planner's judgement is the `motir-ai`
// gate's to prove (MOTIR-4760); from here it is exercised through the product,
// as a user meets it.
//
// ── THE LANE, VERIFIED BEFORE A LINE WAS WRITTEN (criterion 6) ──────────────
// Each seam these journeys cross, with the config line that installs it:
//
//   the plan window mounts at all      `MOTIR_CLOUD: '1'` — playwright.acceptance.config.ts
//                                      (the overlay is behind `isMotirAiConfigured()`)
//   the routing job + its settle       `E2E_TEST_AI_JOBS: '1'` + `MOTIR_AI_JOBS_FIXTURE_PATH`
//                                      — same file; `lib/test-ai-jobs-mock.ts` answers
//                                      `POST /v1/jobs` and `GET /v1/jobs/:id`
//   the connected repository           `lib/test-github-repos-mock.ts` is not needed —
//                                      the grant MIRROR is seeded directly, which is
//                                      what `resolveCodeContext` reads
//
// ⚠️ AND ONE OF THEM DID NOT EXIST. Until this card the jobs mock settled every
// `plan` job as a plain success, so a plan window asking for a verdict got none
// and all three journeys ended in the workspace. That is the failure mode
// criterion 6 is written against: a lane that cannot reach the asserted state
// does not go red, it goes GREEN on the unfixed code. `RoutingJobOutcome` and the
// `plan_routing` discrimination were added to the mock first, keyed on
// `context.routeOnboarding` — the product's own discriminator, not a second one.
//
// DETERMINISM (`motir-core/CLAUDE.md`): every wait is a role/text landmark, a
// `waitForURL`, or a response the page actually issued. No `waitForTimeout`.
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  declareRoutingVerdict,
  finishIndexFor,
  seedConnectedOnlyRepository,
  seedReadableRepository,
  seedRoutingJourney,
  ROUTING_JOURNEY_PASSWORD,
} from './_helpers/onboarding-routing-seed';

test.describe.configure({ timeout: 240_000 });

const workspace = (page: Page) => page.getByRole('dialog');
const readingState = (page: Page) => page.getByTestId('planning-reading-state');
const handOff = (page: Page) => page.getByTestId('planning-handoff');
const indexBanner = (page: Page) => page.getByTestId('planning-indexing-banner');
const indexTurn = (page: Page) => page.getByTestId('planning-indexing-turn');

/**
 * Open the plan window on the active project by writing the overlay's own
 * address — the same four parameters every door writes (MOTIR-4728).
 *
 * The AUTHORITATIVE SIGNAL that the routing run started is the dispatch's own
 * 200, armed BEFORE the navigation so it cannot be missed.
 */
async function openPlanWindow(page: Page): Promise<void> {
  const dispatched = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/ai/plan/route-onboarding' &&
      r.request().method() === 'POST',
  );
  await page.goto('/roadmap?plan=project&planFrom=project');
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  expect((await dispatched).status()).toBe(200);
}

test('four projects, four destinations', async ({ page, chapter, beat, acceptanceStory }) => {
  acceptanceStory('MOTIR-4753');

  // ── 1 ────────────────────────────────────────────────────────────────────
  await chapter('A repository Motir can read — it plans, and asks', async () => {
    await resetDatabase();
    const seed = await seedRoutingJourney('routing-continue@e2e.motir.test', {
      items: 3,
      identifier: 'RONE',
    });
    await seedReadableRepository(seed.workspaceId);
    declareRoutingVerdict({
      outcome: 'continue',
      message: 'I can see acme-index-e2e and your 3 work items. What do you want to plan first?',
    });

    // The window says what it is READING, by name — the sentence the whole story
    // argues for, before any plan exists to judge.
    //
    // ⚠️ HELD BY A GATE, NOT BY A DELAY, AND REGISTERED BEFORE THE WINDOW OPENS
    // (MOTIR-4827). The reading state lives exactly as long as the verdict takes,
    // and against this lane's fixture mock that is close to instant — so two
    // sequential queries against it race, and CI proved it twice: VISIBLE at one
    // line, GONE at the next.
    //
    // The first repair delayed the job-status GET by three seconds and STILL
    // failed, because it was installed AFTER `openPlanWindow` returned — the
    // dispatch's 200 is not the poll, and the first poll had already been served
    // by the time the route existed. Two lessons, and the second is the one worth
    // keeping: a route must be armed BEFORE the traffic it means to catch (the
    // same rule as arming `waitForResponse` before its action), and a fixed delay
    // is a guess about how long an observation takes.
    //
    // So the poll is HELD on an explicit promise and released once the assertions
    // have run. No timing assumption survives: the verdict cannot land until this
    // chapter says so.
    let releasePoll: () => void = () => {};
    const pollHeld = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    await page.route(/\/api\/ai\/jobs\//, async (route) => {
      await pollHeld;
      await route.continue();
    });

    await signIn(page, 'routing-continue@e2e.motir.test', ROUTING_JOURNEY_PASSWORD);
    await openPlanWindow(page);

    await expect(readingState(page)).toBeVisible();
    await expect(readingState(page)).toContainText('work items');
    await beat();

    // ⚠️ RELEASED, NOT UNROUTED. `page.unroute` while a held route is still
    // pending throws *Route is already handled!* — the handler resumes into a
    // route the unroute has already torn down. After the release this handler is
    // a pass-through, so leaving it registered costs the later chapters nothing
    // and removes a teardown that has no safe moment to run.
    releasePoll();

    // …and then it is simply a workspace. NO onboarding, no hand-off: a regular
    // session waits to be told what to plan.
    await expect(handOff(page)).toHaveCount(0);
    await expect(readingState(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/roadmap\?/);
    await beat();
  });

  // ── 2 ────────────────────────────────────────────────────────────────────
  await chapter('Nothing to read — new-project onboarding', async () => {
    await resetDatabase();
    await seedRoutingJourney('routing-new@e2e.motir.test', { identifier: 'RTWO' });
    declareRoutingVerdict({
      outcome: 'onboard_new_project',
      message:
        "There's nothing here yet for me to plan from. A few short questions about what you're building and who it's for, and I'll have enough to write you a plan.",
    });

    await signIn(page, 'routing-new@e2e.motir.test', ROUTING_JOURNEY_PASSWORD);
    await openPlanWindow(page);

    // The THIN reading state — a sentence, never an empty list.
    await expect(readingState(page)).toContainText('no repository connected here yet');
    await beat();

    // The hand-off is SHOWN. Nothing has moved yet: the user presses the button.
    await expect(handOff(page)).toHaveAttribute('data-outcome', 'onboard_new_project');
    await expect(handOff(page)).toContainText("There's nothing here yet");
    await expect(page).toHaveURL(/\/roadmap\?/);
    await beat();

    await page.getByRole('button', { name: 'Set up my project' }).click();
    await page.waitForURL(/\/onboarding\?/);
    await beat();
  });

  // ── 3 ────────────────────────────────────────────────────────────────────
  await chapter('A repository that is not enough — and a SHORTER rail', async () => {
    await resetDatabase();
    const seed = await seedRoutingJourney('routing-existing@e2e.motir.test', {
      identifier: 'RTRE',
    });
    await seedConnectedOnlyRepository(seed.workspaceId);
    declareRoutingVerdict({
      outcome: 'onboard_existing_project',
      message: 'I read your repository. Two things I still need.',
      keptSteps: ['index', 'discovery'],
      missing: [
        'The repository is still mostly the starter template.',
        'Nothing says who this is for.',
      ],
    });

    await signIn(page, 'routing-existing@e2e.motir.test', ROUTING_JOURNEY_PASSWORD);
    await openPlanWindow(page);

    // The planner's own missing-list, rendered one row per entry — and the
    // kept-step strip, which is the apology this route owes.
    await expect(handOff(page)).toHaveAttribute('data-outcome', 'onboard_existing_project');
    await expect(handOff(page)).toContainText('still mostly the starter template');
    await expect(handOff(page)).not.toContainText('A few questions');
    await beat();

    // ⚠️ THE SET REACHES THE RUN ON *START*, not on arrival, and the rail is the
    // full one until it does. That is the product's own shape rather than a
    // detail of this spec: the kept set describes the verdict that OPENED the
    // run, so it is persisted where the run is created and never re-read from
    // whatever address the user happens to be on afterwards.
    //
    // With one project the wizard now starts that run ON ARRIVAL (MOTIR-8254,
    // the one-page migrate wizard), forwarding the same kept set the old Start
    // button did — so the POST is armed before the hand-off rather than before a
    // click. Edited in place with the owner's agreement (MOTIR-8238), the one
    // change to this receipt's spec.
    //
    // The authoritative signal is that POST's own 201.
    const started = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/onboarding/migrate' && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Fill in the gaps' }).click();
    await page.waitForURL(/\/onboarding\/migrate\?/);
    expect((await started).ok()).toBe(true);
    await beat();

    // THE RAIL IS SHORTER THAN THE FULL ONE, and what is not in it is drawn as
    // SATISFIED rather than absent — collapsed into one row that NAMES it.
    const collapsed = page.getByTestId('migrate-rail-collapsed');
    await expect(collapsed).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(collapsed).toContainText('Connect');
    await expect(collapsed).toContainText('Import work items');
    await beat();

    // ⚠️ AND NO ROW NAMES A DIRECTION TIER. `discovery` is the identifier; what a
    // user reads is what they are being asked (MOTIR-4757, MOTIR-4755 rev 2).
    //
    // EDITED IN PLACE (MOTIR-8772): the wizard no longer asks the questions step
    // at all. Mo's approved design (MOTIR-8767 revision A) ends onboarding at the
    // Import step with Enter Motir and drafts no plan, so the rail stopped
    // listing "A few questions". The assertion that no tier is named stands.
    const rail = page.getByRole('navigation', { name: /migration/i });
    await expect(rail).not.toContainText('A few questions');
    await expect(rail).not.toContainText(/discovery|vision|Pre-plan/i);
    await beat();
  });

  // ── FOUR · THE WAIT (MOTIR-4827) ──────────────────────────────────────────
  //
  // The journey a reviewer would most want to see, because it is the one that
  // used to be invisible: somebody connects a repository and opens the plan
  // window before the graph exists. Every code-graph tool then answers EMPTY —
  // indistinguishable from a repository with nothing in it — so the old shape
  // routed them into an interview about a codebase Motir was seconds from
  // reading. Nothing errored; they simply got the slow path.
  await chapter('A repository with no code graph yet — Motir waits, and says why', async () => {
    await resetDatabase();
    const seed = await seedRoutingJourney('routing-indexing@e2e.motir.test', {
      identifier: 'RTIX',
    });
    const ref = await seedConnectedOnlyRepository(seed.workspaceId);
    declareRoutingVerdict({
      outcome: 'wait_for_index',
      message:
        "You've connected " +
        ref +
        " but I haven't read it yet — I'm building its index now. I'd rather wait than plan " +
        'your project from a repository I cannot see. As soon as it is done we can start.',
    });

    await signIn(page, 'routing-indexing@e2e.motir.test', ROUTING_JOURNEY_PASSWORD);
    await openPlanWindow(page);

    // ⚠️ NOBODY IS ROUTED. This outcome has no destination, so the hand-off —
    // which exists to MOVE somebody — must not be what they meet, and the
    // address must not have changed under them.
    await expect(indexBanner(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(handOff(page)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/roadmap');
    await beat();

    // ⚠️ TWO ELEMENTS, AND THE RECORDING SHOWS THEM TOGETHER (Yue: *"with the
    // banner and say it"*). The BANNER carries the durable state and names the
    // repository; the TURN carries the planner's own reason. A build that
    // collapsed them would satisfy neither of these.
    await expect(indexBanner(page)).toContainText(ref);
    await expect(indexTurn(page)).toContainText("I'd rather wait than plan");
    await expect(indexTurn(page)).toContainText('As soon as it is done');
    await beat();

    // …and the EXIT is on screen, because they opened this window to plan and
    // are owed the fact that closing it does not cancel anything.
    await expect(page.getByTestId('planning-indexing-exit')).toContainText('come back');
    await beat();

    // ── THE WAIT ENDS ───────────────────────────────────────────────────────
    //
    // A REAL ledger write, the same fact the index job itself records — not a
    // network stub, which would have tested this spec's own harness. The window
    // polls, sees the graph, and ASKS AGAIN rather than deciding: whether the
    // substrate is now enough is still the planner's judgement.
    declareRoutingVerdict({
      outcome: 'continue',
      message: "I've read " + ref + ' now. What shall we plan first?',
    });
    const reasked = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/ai/plan/route-onboarding' &&
        r.request().method() === 'POST',
    );
    await finishIndexFor(seed.workspaceId, ref);
    expect((await reasked).status()).toBe(200);
    await beat();

    // The wait resolves rather than spinning: the banner comes down and the
    // workspace opens, which is what makes this a receipt of a wait that ENDS.
    await expect(indexBanner(page)).toHaveCount(0);
    await expect(workspace(page)).toBeVisible();
    await beat();
  });
});
