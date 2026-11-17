import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAiAugmentReplan,
  seedPlanChangeProposal,
  markProjectOnboarded,
  PLAN_CHANGE_JOB_ID,
} from './_helpers/ai-augment-replan-seed';

// ⚠️ RE-POINTED FOR THE OVERLAY (MOTIR-4732, story MOTIR-4725). The planning
// workspace was a ROUTE at `/planning`; it is a full-screen OVERLAY on the page
// you are already on. So an address that used to BE the workspace is now a host
// page plus four namespaced parameters, and a `waitForURL` that matched the old
// path matches nothing. The assertions about what the workspace DOES are
// unchanged — only how it is reached and how its arrival is detected.
//
// (`/planning?…` still resolves: `app/(authed)/planning/page.tsx` forwards an old
// link to the host page it belonged to. Its own coverage is in
// `tests/integration/planning/planChangeSeams.test.ts`; these specs address the
// overlay directly, which is what a reader would write today.)

// ACCEPTANCE — ask about this project, then act on it, in ONE conversation
// (Story MOTIR-1343 · Subtask MOTIR-1823).
//
// ⚠️ WHAT THE CLIP HAS TO SHOW, and why step 6 is the whole point. Every other
// step here proves a feature works. Step 6 proves the SHAPE of the product: the
// callout's rows share one surface *because a person changes topic mid-sentence*,
// so a thread that could answer but not act would be the failure the design was
// built to prevent. A viewer has to watch somebody ask a question, get a cited
// answer, and then — with no control touched, no mode chosen, nothing closed —
// ask for a change and see the confirm chrome arrive. That absence of a gesture
// is the deliverable, which is exactly why it has to be filmed rather than
// asserted in a unit test.
//
// ── THE BOUNDARY, and why it is not a `page.route` ──────────────────────────
// The ask journey crosses motir-core → motir-ai three times and only the STREAM
// is a browser-visible relay; the submit and the settle happen inside the Next
// server. Stubbing the two core routes at the browser would mean faking the
// answer — and an answer the browser faked was never written, which is precisely
// what step 4's reload has to prove. So the seam is `lib/test-ai-jobs-mock.ts`,
// an undici intercept under the routes (`E2E_TEST_AI_JOBS=1`), and the real
// route → service → repository → Postgres chain runs for all seven steps.
//
// ── THE LANE ────────────────────────────────────────────────────────────────
// The ACCEPTANCE lane, and the reason is the environment as much as the receipt:
// the workspace only mounts with `MOTIR_AI_URL` set, and the jobs mock this spec
// declares its fixtures to is installed by that lane's config.

test.describe.configure({ timeout: 120_000 });

const JOBS_FIXTURE =
  process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ?? '/tmp/motir-acceptance-ai-jobs-fixture.json';

/** What the next ask job(s) settle as, consumed in order by the boundary mock. */
function declareAskOutcomes(
  outcomes: { intent: 'ask' | 'plan_change'; answer?: string | null; citations?: string[] }[],
): void {
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ ask: outcomes }, null, 2));
}

// ── Locators ─────────────────────────────────────────────────────────────────

const orb = (page: Page) => page.getByRole('button', { name: 'Motir AI' });
const calloutPanel = (page: Page) => page.getByRole('dialog', { name: 'Motir AI' });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => page.getByRole('textbox', { name: /Reply, or refine/ });
// ⚠️ SCOPED TO THE DIALOG, not to `main` and not read off the page (MOTIR-5116).
// None of these nodes carries a role of its own — the confirm bar and the footer
// are bare `<div>`s in `PlanningWorkspaceHost`, and `roadmap-canvas` is
// `ProjectRoadmapCanvas`'s outer wrapper around the `role="application"`
// viewport — so a SCOPE is the remedy rather than a role.
//
// ⚠️ AND THE SCOPE IS THE DIALOG BECAUSE `main` FAILS CLOSED HERE. The planning
// workspace is a full-screen OVERLAY (see this file's own header), and Radix
// marks everything outside an open modal `aria-hidden` — so `<main>` leaves the
// accessibility tree entirely and `getByRole('main')` matches ZERO for as long
// as the workspace is open. Measured, not reasoned: scoping these to `main`
// took the `billing-cloud` leg red with `element(s) not found`, and the failure
// artifact's ARIA snapshot carries a `dialog` and no `main` at all.
//
// The dialog is the live subtree, and a portalled overlay is also somewhere a
// lingering route-level subtree cannot reach into (`_helpers/settle.ts`).
const live = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const confirmBar = (page: Page) => live(page).getByTestId('plan-change-confirm-bar');
/** The canvas foot. ⚠️ IT EXISTS ONLY WHEN THERE IS SOMETHING TO SAY (MOTIR-6155,
 *  `design/ai-planning/design-notes.md` § 21.8) — the resting copy it used to
 *  carry at rest is gone, because the planning status is already clear from the
 *  conversation panel beside it, so the foot HIDES rather than being emptied.
 *  Every assertion below reads it as an ABSENCE. */
const canvasFooter = (page: Page) => live(page).getByTestId('plan-change-canvas-footer');
const canvas = (page: Page) => live(page).getByTestId('roadmap-canvas');
/** A PROPOSED card, as the plan page draws it. ⚠️ `PlanItemNode`'s `data-op`
 *  (MOTIR-6155): once a plan is proposed the left pane mounts the plan page's own
 *  List | Canvas component, so the proposal wears the plan page's vocabulary —
 *  `add` / `modify` / `remove`. The surface has no diff frame of its own any more
 *  (MOTIR-6299): `PlanItemNode` is the one proposal card. */
const opNodes = (page: Page, op: 'add' | 'modify' | 'remove') =>
  live(page).locator(`[data-op="${op}"]`);
const answers = (page: Page) => rail(page).getByTestId('plan-change-report');

/**
 * Send a turn and wait on the ASK DOOR's own 200 — the authoritative signal that
 * the thread advanced, because the turn is a persisted row written by that call.
 * Never a timeout: the answer streams, which is the exact shape the repo's
 * flaky-spec rule exists for.
 */
async function sendTurn(page: Page, text: string): Promise<void> {
  const asked = page.waitForResponse(
    // The DOOR itself, not the settle — `/api/ai/ask/settle` shares the prefix,
    // and matching it here would resolve on the previous turn's filing.
    (r) => new URL(r.url()).pathname === '/api/ai/ask' && r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  expect((await asked).status()).toBe(200);
}

/** …and wait for the SETTLE, which is what files the answer on the thread. */
async function settled(page: Page): Promise<void> {
  await page.waitForResponse(
    (r) => r.url().includes('/api/ai/ask/settle') && r.request().method() === 'POST',
  );
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('ask about this project — a cited answer, then a plan change in the SAME thread', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1343');
  const seed = await seedAiAugmentReplan(`ask-project-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);

  // The plan the REDIRECTED turn produces — a real Plan, exactly as the shipped
  // plan-change path leaves one. Step 6 drives that path; it does not fake it.
  const planId = await seedPlanChangeProposal(seed.ctx, seed.projectId, {
    jobId: PLAN_CHANGE_JOB_ID,
    title: 'Split notifications',
    adds: ['Email notifications'],
    rename: { workItemId: seed.notifId, title: 'Notifications & alerts' },
  });

  // Turn 1 answers with a citation; turn 2 is the redirect that becomes a plan
  // change; turn 3 is the honest no-answer.
  declareAskOutcomes([
    {
      intent: 'ask',
      answer: `Two are waiting on work that has not started. [${seed.notifKey}](motir:${seed.notifId}) is the one to look at first.`,
      citations: [seed.notifKey],
    },
    { intent: 'plan_change' },
    {
      intent: 'ask',
      answer: "I can't answer that from this project. Nothing in the plan covers SSO pricing.",
      citations: [],
    },
  ]);

  // ⚠️ THE ONE THING THIS SPEC REDIRECTS RATHER THAN RUNS, and why.
  //
  // Step 6's turn takes the real redirect: the ask handler hands it back, and
  // motir-core dispatches the SHIPPED plan-change submit, which opens a Plan of
  // its own server-side. In production motir-ai then appends that run's
  // proposals into it; here nothing does, so the Plan the rail reads would be
  // empty and the gate would never appear — a false red about a path that works.
  //
  // So the plan READ is pointed at a SEEDED plan carrying the proposals such a
  // run would have left. It is a real Plan, read through the real route by the
  // real client: what is faked is WHICH plan, never what a plan is. The submit,
  // the redirect, the dispatch and the turn's recorded intent are all live.
  await page.route('**/api/plans/*', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.pathname === `/api/plans/${planId}`) {
      await route.continue();
      return;
    }
    await route.continue({ url: `${url.origin}/api/plans/${planId}` });
  });

  await signIn(page, seed.email, seed.password);

  await chapter('The Motir orb offers to answer questions about the project', async () => {
    // ⚠️ ADDRESSED BY ITS ACCESSIBLE NAME, never by its glyph. The orb renders an
    // `aria-hidden` <svg> now — the mark, not a letter — so a text handle would
    // both fail and quietly re-assert the placeholder this story retired.
    await expect(orb(page)).toBeVisible();
    await orb(page).click();

    const panel = calloutPanel(page);
    await expect(panel.getByRole('link', { name: /Ask about this project/ })).toBeVisible();
    await expect(
      panel.getByText('Answer questions about the plan, docs and work items'),
    ).toBeVisible();

    // ⭐ ONE HREF, asserted as EQUALITY. The row is a LABEL, not a route: it
    // advertises what the surface can do and narrows nothing. A second
    // destination here would be the "ask mode" the design deliberately does not
    // have, arriving through the door.
    const askHref = await panel
      .getByRole('link', { name: /Ask about this project/ })
      .getAttribute('href');
    const planHref = await panel.getByRole('link', { name: /Plan with AI/ }).getAttribute('href');
    expect(askHref).toBe(planHref);
    expect(askHref).not.toContain('mode=ask');
    await beat();
  });

  await chapter('It opens the one workspace — the same one Plan with AI opens', async () => {
    await calloutPanel(page)
      .getByRole('link', { name: /Ask about this project/ })
      .click();
    await page.waitForURL((url) => url.searchParams.has('plan'));

    await expect(canvas(page)).toBeVisible({ timeout: 30_000 });
    await expect(rail(page)).toBeVisible();
    // The opener names BOTH capabilities — the surface answers and it acts.
    await expect(
      rail(page).getByText('What should change — or what would you like to know?'),
    ).toBeVisible();
    await expect(
      rail(page).getByRole('button', { name: "What's blocked, and why?" }),
    ).toBeVisible();
    // Nothing is proposed, and the canvas foot is GONE rather than saying so.
    await expect(confirmBar(page)).toHaveCount(0);
    await expect(canvasFooter(page)).toHaveCount(0);
    await beat();
  });

  await chapter('Ask a question — the answer arrives with its sources', async () => {
    await sendTurn(page, 'Which stories are blocked, and why?');
    await settled(page);

    await expect(answers(page)).toContainText('Two are waiting on work that has not started');
    // The citation is the SHIPPED work-item chip, not a treatment invented here.
    await expect(answers(page).getByText(seed.notifKey, { exact: true })).toBeVisible();
    // In the RAIL — a `<p>` in `PlanChangeRail`, no role of its own.
    await expect(rail(page).getByTestId('plan-change-citation-count')).toContainText(
      'Answered from 1 work item',
    );
    await beat();
  });

  await chapter('An answer changed nothing — and the canvas says so', async () => {
    // The no-mutation claim, checked on the TREE rather than on the absence of a
    // bar: the roadmap still shows the project as saved, with no diff on it.
    await expect(confirmBar(page)).toHaveCount(0);
    // ON THE CANVAS — with NO plan the pane is still the plain roadmap (the
    // shared canvas in its "no plan" state), so no proposal card is drawn on it.
    await expect(canvas(page).getByTestId('plan-item-node')).toHaveCount(0);
    await expect(opNodes(page, 'add')).toHaveCount(0);
    await expect(canvasFooter(page)).toHaveCount(0);
    await beat();
  });

  await chapter('Click a source — it opens the work item it cited', async () => {
    await answers(page).getByText(seed.notifKey, { exact: true }).click();
    await page.waitForURL(new RegExp(`(items/${seed.notifKey}|peek=)`));
    await beat();
  });

  await chapter('Come back and reload — the answer is still on the thread', async () => {
    await page.goBack();
    await page.waitForURL((url) => url.searchParams.has('plan'));
    await page.reload();

    // The persistence claim, which only an E2E can really make: the answer is a
    // row, not client state, and its citation resolves again on a fresh read.
    await expect(answers(page)).toContainText('Two are waiting on work that has not started');
    await expect(answers(page).getByText(seed.notifKey, { exact: true })).toBeVisible();
    await beat();
  });

  await chapter('⭐ Ask for a CHANGE in the same thread — the chrome comes back', async () => {
    // Nothing is switched, closed or chosen. The next sentence is simply a
    // different kind of sentence, and the surface follows it.
    await sendTurn(page, 'Then split the notifications story into email and in-app.');

    await expect(confirmBar(page)).toContainText('1 added, 1 changed', { timeout: 30_000 });
    // The plan this turn wrote is ASKED — it waits in To approve — so the bar
    // states the decision's consequence rather than "Nothing is saved until you
    // approve." (Story MOTIR-6012 · MOTIR-6037; ADR `approval-gates.md` §11.5b).
    await expect(confirmBar(page)).toContainText(
      'Approving adds these to your backlog. Declining ends the plan and changes nothing.',
    );
    // ⭐ AND THE PANE HAS SWAPPED. A proposed plan is shown with the plan page's
    // own List | Canvas component (MOTIR-6155), so the added card is a
    // `PlanItemNode` on the plan review canvas rather than a diff frame painted
    // over the roadmap. The thread is untouched by that: the same conversation
    // that answered a question produced a plan, and the pane followed it.
    await expect(live(page).getByTestId('plan-proposal-views')).toBeVisible();
    await expect(opNodes(page, 'add')).toHaveCount(1);

    // BOTH turn kinds are on the one thread, in order — the answer above, the
    // proposal below it.
    await expect(rail(page).getByTestId('conversation-user-turn').first()).toBeVisible();
    await expect(answers(page).first()).toContainText('Two are waiting');
    await beat();
  });

  await chapter('And it can still answer — honestly, when it cannot', async () => {
    await sendTurn(page, 'What did we decide about SSO pricing?');
    await settled(page);

    // An empty answer is a real answer: an ordinary bubble that says what it
    // could not find, never an invented one and never an error.
    //
    // ⚠️ SCOPED TO THE RAIL, and not page-wide. Next renders its own
    // `__next-route-announcer__` with `role="alert"` on every page, so
    // `page.getByRole('alert')` matches one element always — an assertion that
    // would fail here for a reason that has nothing to do with this story.
    await expect(answers(page).last()).toContainText("I can't answer that from this project");
    await expect(rail(page).getByRole('alert')).toHaveCount(0);
    await beat();
  });

  // The proposal from step 6 is still pending — asking a question mid-review is
  // a LOOKUP, not an abandonment, so the gate is exactly where it was.
  await expect(confirmBar(page)).toBeVisible();
});
