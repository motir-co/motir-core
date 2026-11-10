// Acceptance E2E — changing a plan is a CONVERSATION (Subtask MOTIR-1733,
// Story MOTIR-1726).
//
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + video: 'on') so the
// CI acceptance-video lane records a chaptered clip; `acceptanceStory()` pins the
// recording to Story MOTIR-1726 regardless of the PR that triggered the run.
//
// Drives the story's whole flow from the user's seat, on a project that ALREADY
// has an approved plan — the established-project case that used to dead-end:
//
//   1. "Plan with AI" OPENS the universal workspace (canvas left, chat right).
//      That alone is the regression this story exists to fix — the launcher used
//      to round-trip through `/onboarding` straight back to `/roadmap`.
//   2. A described change streams, and the proposal lands as a DIFF ON THE CANVAS.
//   3. A SECOND turn REFINES it and the diff updates — the assertion that carries
//      the product decision. A one-turn test would not prove the story: the point
//      is that a plan change is a dialogue, not a one-shot prompt.
//   4. Approve commits, and the tree reflects the change.
//   5. The retired one-shot "Augment from prompt" control is gone from `/backlog`
//      and `/items` (test 3).
//
// DETERMINISM (`notes.html` #37 · `motir-core/CLAUDE.md` § E2E waits on the
// authoritative signal). motir-ai has no presence in CI, so the browser→ai hop is
// stubbed via `page.route` — the same open-core seam the shipped
// `acceptance-augment-replan.spec.ts` uses, and the only interceptable one (a
// server-side fetch out of a route handler is NOT reachable from `page.route` —
// mistakes #112 / #152). Everything on THIS side of that hop runs REAL:
//
//   • the conversation thread — `GET /api/ai/plan-change/session` (resume),
//     `POST …/session` (a first turn starts it) and `…/session/turns` (append,
//     by `sessionId` — MOTIR-6023) are motir-core + Postgres, so the turns the
//     rail renders are genuinely persisted rows, not stub echoes. The submit stub
//     even re-reads the live session, so the thread is never faked;
//   • the PROPOSALS — the run's output is a real `Plan`, seeded through the same
//     `createPlan → addProposals → markPlanned` calls the handler's own callbacks
//     make (MOTIR-1746), so the review the rail renders is `planReviewService`
//     reading Postgres;
//   • the approve — `POST /api/plans/[id]/approve` runs through the shipped
//     `plansService.approvePlan → materialize`, so the spec asserts real DB state.
//
// Only TWO things are stubbed: the SUBMIT (which calls motir-ai) and the job's
// SSE. The streaming state is observed by HOLDING the plan-review read until the
// assertion has run — an authoritative gate, never a timeout.

import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import type { Page, Request, Route } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { persistAskTurn, readNamedSession } from './_helpers/plan-session-turn';
import {
  seedAiAugmentReplan,
  seedPlanChangeProposal,
  markProjectOnboarded,
  PLAN_CHANGE_JOB_ID,
  PLAN_CHANGE_REFINE_JOB_ID,
} from './_helpers/ai-augment-replan-seed';
import { jobStreamBody } from './_helpers/job-stream-frames';

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

test.describe.configure({ timeout: 120_000 });

// ── The proposals a run leaves behind, per turn ──────────────────────────────
//
// Turn 1 proposes one addition plus a rename of an existing (non-terminal) root
// item; turn 2 is the SAME intent refined — a second addition, so the counts move
// 1 → 2, which is what proves the canvas re-rendered the NEW proposal.

const ADDED_TITLE = 'Billing';
const REFINED_TITLE = 'Reporting';
const RENAMED_NOTIF = 'Notifications & alerts';

// ── Stubs for the browser→motir-ai boundary ──────────────────────────────────

const AI_ACCESS_NA = {
  applicable: false,
  organizationId: null,
  organizationName: null,
  canManageBilling: false,
  hasPaidAiPlan: false,
  balance: 0,
  tierName: null,
  tierAllotment: null,
  renewsAt: null,
};

async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AI_ACCESS_NA),
    });
  });
}

/**
 * Stub the SUBMIT — the one hop in the conversation that reaches motir-ai. Each
 * call hands back the next job id, so turn 2 settles on a different delta.
 *
 * The `session` it returns is the REAL one, re-read through the idempotent
 * open/resume endpoint: the rail replaces its session with this response, so
 * echoing a hand-built thread would erase the turns the app actually persisted
 * and the multi-turn assertion would be testing the stub. Only the motir-ai half
 * is faked.
 */
async function stubPlanChangeSubmit(
  page: Page,
  runs: readonly { jobId: string; planId: string }[],
): Promise<void> {
  let call = 0;
  // ⚠️ THE ASK DOOR, not `…/session/submit` (MOTIR-1343). Every project turn now
  // goes through `POST /api/ai/ask`, and a turn that is a plan change is
  // REDIRECTED — the door answers with `{ outcome: 'redirected', jobId, planId }`
  // and the rail runs the shipped plan-edit tail from there. So the stub answers
  // in that shape: what it fakes is the classification and the run, exactly as
  // before; the thread underneath is still written by the real route.
  // ⚠️ BOTH DOORS, and the second is not vestigial. A NEW turn goes through
  // `/api/ai/ask`; a RETRY of a redirected turn has no ask turn to name — the
  // door answered with a redirect, not a turn id — so it falls back to the
  // shipped `…/session/submit`, re-sending the accumulated intent. That is the
  // product's own behaviour, so the spec has to stub the path it really takes.
  await page.route('**/api/ai/plan-change/session/submit', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const run = runs[Math.min(call, runs.length - 1)]!;
    // The session the retry NAMED, re-read by id (MOTIR-6023).
    const live = await readNamedSession(route);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: run.jobId, planId: run.planId, session: await live.json() }),
    });
  });
  await page.route('**/api/ai/ask', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    // `planId` is the shipped contract (MOTIR-1745): submit OPENS the Plan the
    // run's proposals append into, and the rail reads + confirms THAT plan. A
    // stub that answered with only a jobId would leave the rail with nothing to
    // confirm — which is exactly the shape of the bug MOTIR-1746 fixed.
    const run = runs[Math.min(call, runs.length - 1)]!;
    call += 1;
    // Append the turn for real first, so the thread the rail reads back is the
    // persisted one — the door's own job, and the half this stub must not fake.
    // Through the real session doors — the held session, or a first turn that
    // starts one (MOTIR-6023).
    const appended = await persistAskTurn(route);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        outcome: 'redirected',
        jobId: run.jobId,
        planId: run.planId,
        session: await appended.json(),
      }),
    });
  });
}

/** The augment job's SSE, carrying the REAL frame vocabulary the rail narrates
 *  (`search` / `planned` / `done`) — structured progress, not assistant tokens —
 *  on motir-ai's wire: each progress frame inside its `{ jobId, seq, data }`
 *  envelope (MOTIR-10880). */
function progressSse(jobId: string, proposed: number): string {
  return jobStreamBody(jobId, [
    ['search', {}],
    ['planned', { proposed }],
    ['done', {}],
  ]);
}

async function stubStream(page: Page, jobId: string, body: string): Promise<void> {
  await page.route(`**/api/ai/augment/${jobId}/stream`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
}

/**
 * HOLD the settled read of one plan until the returned `release()` is called —
 * then let it through to the REAL route. That makes the STREAMING state
 * deterministically observable (the run cannot advance past a request the test is
 * holding), so the narration is asserted against an authoritative gate rather
 * than a timeout (`motir-core/CLAUDE.md` § E2E waits on the authoritative
 * signal). It delays the response; it never fakes one.
 */
async function gatePlanRead(page: Page, planId: string): Promise<() => void> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  await page.route(`**/api/plans/${planId}`, async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await gate;
    await route.continue();
  });
  return open;
}

// ── Locators ─────────────────────────────────────────────────────────────────

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
const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const confirmBar = (page: Page) => workspace(page).getByTestId('plan-change-confirm-bar');
const canvas = (page: Page) => workspace(page).getByTestId('roadmap-canvas');
/** A PROPOSED card, as the PLAN PAGE draws it.
 *
 *  ⚠️ `PlanItemNode`'s `data-op` (MOTIR-6155). Once a plan is proposed the left
 *  pane mounts the plan page's own List | Canvas component, so a proposal on this
 *  surface is the same node the plan page draws and wears the same vocabulary —
 *  `add` / `modify` / `remove`. It is the one proposal card: MOTIR-6299 deleted
 *  this surface's own diff frame, so with no plan (and, until MOTIR-6300, while
 *  one is being written) the pane is the plain roadmap with no proposal on it. */
const opNodes = (page: Page, op: 'add' | 'modify' | 'remove') =>
  workspace(page).locator(`[data-op="${op}"]`);

/** Type a turn and send it, waiting on the DOOR's 200 — the turn is a persisted
 *  row written by that call, so its write response is the authoritative "the
 *  thread advanced" signal.
 *
 *  ⚠️ THE DOOR MOVED (MOTIR-1343). The project thread used to append through
 *  `…/session/turns` and submit separately; it now posts to `/api/ai/ask`, which
 *  appends AND runs. Matched EXACTLY, because `/api/ai/ask/settle` shares the
 *  prefix and would resolve on the previous turn's filing. */
async function sendTurn(page: Page, text: string): Promise<void> {
  const appended = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/ask' && r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  expect((await appended).status()).toBe(200);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// The recorded happy path — it carries the chapter markers the acceptance
// video's timeline is built from.
test('plan change is a conversation — open, describe, refine, approve', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1726');
  const seed = await seedAiAugmentReplan(`plan-change-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);

  // The two runs' output, as REAL plans — what motir-ai's handler would have
  // appended before returning.
  const firstPlanId = await seedPlanChangeProposal(seed.ctx, seed.projectId, {
    jobId: PLAN_CHANGE_JOB_ID,
    title: 'Add billing',
    adds: [ADDED_TITLE],
    rename: { workItemId: seed.notifId, title: RENAMED_NOTIF },
  });
  const refinedPlanId = await seedPlanChangeProposal(seed.ctx, seed.projectId, {
    jobId: PLAN_CHANGE_REFINE_JOB_ID,
    title: 'Add billing and reporting',
    adds: [ADDED_TITLE, REFINED_TITLE],
    rename: { workItemId: seed.notifId, title: RENAMED_NOTIF },
  });

  await stubAiAccess(page);
  await stubPlanChangeSubmit(page, [
    { jobId: PLAN_CHANGE_JOB_ID, planId: firstPlanId },
    { jobId: PLAN_CHANGE_REFINE_JOB_ID, planId: refinedPlanId },
  ]);
  await stubStream(page, PLAN_CHANGE_JOB_ID, progressSse(PLAN_CHANGE_JOB_ID, 1));
  await stubStream(page, PLAN_CHANGE_REFINE_JOB_ID, progressSse(PLAN_CHANGE_REFINE_JOB_ID, 2));
  const releaseFirstResult = await gatePlanRead(page, firstPlanId);

  await signIn(page, seed.email, seed.password);

  await chapter('Plan with AI opens the workspace', async () => {
    // The REAL door: the header's hero launcher, present on every authed screen.
    // Before MOTIR-1729 this href dead-ended on an established project.
    await page.getByRole('link', { name: 'Plan with AI' }).first().click();
    await page.waitForURL((url) => url.searchParams.has('plan'));

    // Two panes: the project's existing plan on the canvas, the conversation on
    // the right. The EMPTY state — a thread with no turns yet — is not a blank
    // screen: the canvas already shows the plan, and the rail opens the topic.
    // ⚠️ THE FIRST LANDMARK AFTER LANDING ON `/planning` CARRIES THE FIRST-PAINT
    // BUDGET (MOTIR-2506). `waitForURL` resolves when the URL commits, which is
    // not when the workspace has rendered — and this lane stalls transiently,
    // so the default 20 s expect timeout has failed here on a runner where the
    // very same test passes in 26.9 s end to end. The rail below keeps the
    // default: once the canvas is up the page has rendered.
    await expect(canvas(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(rail(page)).toBeVisible();
    // The opener names BOTH capabilities since MOTIR-1343 — the surface answers
    // questions as well as changing plans, and saying only the second half
    // quietly discourages the first.
    await expect(
      rail(page).getByText('What should change — or what would you like to know?'),
    ).toBeVisible();
    await expect(rail(page).getByRole('button', { name: 'Add work to an epic' })).toBeVisible();
    await expect(confirmBar(page)).toHaveCount(0);
    // ON THE CANVAS — a proposal card would be drawn inside `roadmap-canvas`.
    await expect(canvas(page).getByTestId('plan-item-node')).toHaveCount(0);
    await beat();
  });

  await chapter('Describe the change — it lands on the canvas', async () => {
    await sendTurn(page, 'Add a billing epic and rename the notifications story.');

    // STREAMING: the plan read is held, so the run is parked mid-flight and the
    // rail's live region shows the narration built from the SSE's real frames.
    // IN THE RAIL — the live region is a bare `<div aria-live="polite">` in
    // `PlanChangeRail`; `aria-live` is not a role, so scoping is the remedy.
    await expect(rail(page).getByTestId('plan-change-progress')).toContainText(/proposed so far/);
    releaseFirstResult();

    // REVIEW: the proposal is on the CANVAS, not in a corner dock, and nothing is
    // saved until it is approved.
    await expect(confirmBar(page)).toContainText('1 added, 1 changed');
    await expect(confirmBar(page)).toContainText(
      // An ASKED plan's bar reads the gate's consequence line (MOTIR-6037).
      'Approving adds these to your backlog. Declining ends the plan and changes nothing.',
    );
    // ⭐ THE PANE HAS SWAPPED. A proposed plan is read through the plan page's own
    // List | Canvas component (MOTIR-6155), so what the reviewer sees here is what
    // `/plans/<id>` shows — the same `PlanReviewCanvas`, drawing the same cards.
    await expect(workspace(page).getByTestId('plan-proposal-views')).toBeVisible();
    await expect(canvas(page).getByText(ADDED_TITLE, { exact: true })).toBeVisible();
    await expect(opNodes(page, 'add')).toHaveCount(1);
    // The existing item the proposal renames wears the MODIFY treatment in place.
    await expect(opNodes(page, 'modify')).toHaveCount(1);
    await beat();
  });

  await chapter('Refine in a second turn — the diff updates', async () => {
    await sendTurn(page, 'Also add reporting, and keep both at story level.');

    // The thread is a conversation: both turns are still on it (they are
    // persisted rows, not UI state), each shown as just the message (MOTIR-7497).
    await expect(rail(page).getByTestId('conversation-user-turn')).toHaveCount(2);

    // The SECOND delta replaced the first on the canvas — the counts moved.
    await expect(confirmBar(page)).toContainText('2 added, 1 changed');
    await expect(canvas(page).getByText(REFINED_TITLE, { exact: true })).toBeVisible();
    await expect(opNodes(page, 'add')).toHaveCount(2);
    await beat();
  });

  await chapter('Approve — the plan changes', async () => {
    // The confirm goes through the PLANS approve — the same operation
    // `/plans/[id]` performs on the same plan. One gate, one write path.
    const approved = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/plans/${refinedPlanId}/approve`) && r.request().method() === 'POST',
    );
    // ⚠️ NO FULL DOCUMENT LOAD (bug MOTIR-6640). The approve's own refresh and
    // the live nudge for the same write used to overlap, and two overlapping
    // refreshes can make Next fall back to a full document load, which wipes the
    // decided plan asserted below. Counted from the click to the outcome, so the
    // spec pins the MECHANISM as well as the symptom: a reload stays a failure
    // even if a later change made the decided plan survive one.
    const documentLoads: string[] = [];
    const countDocumentLoads = (request: Request) => {
      if (request.resourceType() === 'document') documentLoads.push(request.url());
    };
    page.on('request', countDocumentLoads);
    await confirmBar(page).getByRole('button', { name: 'Approve', exact: true }).click();
    expect((await approved).status()).toBe(200);

    // The rail says what landed and KEEPS the thread — a plan change is rarely
    // one change, so the conversation stays open.
    await expect(rail(page).getByText(/Added 2 work items, changed 1/)).toBeVisible();
    await expect(composer(page)).toBeEnabled();

    // The GATE is gone; the overlay is not. It KEEPS the decided cards
    // (`design/ai-planning/design-notes.md` Part VI §3 / MOTIR-3162, via bug
    // MOTIR-3206) — three cards, the two adds and the modify, each now carrying
    // the accepted treatment instead of a pending one. The committed titles are
    // still asserted below, which is what proves the client island refetched (it
    // seeds its level once, so `router.refresh()` alone could not have reached
    // it) — that half of this block is unchanged and is the half this spec was
    // really pinning.
    //
    // A DECIDED plan keeps the plan page's component too, in the decided
    // treatment (MOTIR-6155's own criterion), so the nodes are read by that
    // component's testid rather than the diff frame's.
    await expect(confirmBar(page)).toHaveCount(0);
    await expect(canvas(page).getByTestId('plan-item-node')).toHaveCount(3);
    // The outcome is read as the WORD, so a colour-only treatment cannot pass.
    await expect(workspace(page).getByTestId('plan-item-outcome').first()).toHaveText('accepted');
    await expect(canvas(page).getByText(REFINED_TITLE, { exact: true })).toBeVisible();
    page.off('request', countDocumentLoads);
    expect(documentLoads, 'Approve must not reload the page').toEqual([]);

    // The real substrate: the tree reflects the change.
    const added = await db.workItem.findMany({
      where: { projectId: seed.projectId, title: { in: [ADDED_TITLE, REFINED_TITLE] } },
      orderBy: { title: 'asc' },
    });
    expect(added).toHaveLength(2);
    for (const item of added) {
      expect(item.kind).toBe('story');
      expect(item.parentId).toBeNull();
    }
    const renamed = await db.workItem.findFirst({
      where: { projectId: seed.projectId, identifier: seed.notifKey },
    });
    expect(renamed?.title).toBe(RENAMED_NOTIF);

    // The PLAN itself is decided — a rail approve leaves nothing orphaned at
    // `planned` for the plans list to show as still awaiting review.
    const plan = await db.plan.findUnique({ where: { id: refinedPlanId } });
    expect(plan?.status).toBe('approved');
  });
});

test('a failed run is recoverable in place — the thread and the retry survive', async ({
  page,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1726');
  const seed = await seedAiAugmentReplan(`plan-change-error-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);

  // One job (and one plan) for both attempts; the STREAM fails first and succeeds
  // on retry — the retry re-sends the accumulated intent to the same run.
  const planId = await seedPlanChangeProposal(seed.ctx, seed.projectId, {
    jobId: PLAN_CHANGE_JOB_ID,
    title: 'Split settings',
    adds: [ADDED_TITLE],
    rename: { workItemId: seed.notifId, title: RENAMED_NOTIF },
  });
  let failing = true;
  await stubAiAccess(page);
  await stubPlanChangeSubmit(page, [{ jobId: PLAN_CHANGE_JOB_ID, planId }]);
  await page.route(`**/api/ai/augment/${PLAN_CHANGE_JOB_ID}/stream`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: failing
        ? `event: error\ndata: {"code":"FAILED"}\n\n`
        : progressSse(PLAN_CHANGE_JOB_ID, 1),
    });
  });

  await signIn(page, seed.email, seed.password);
  await page.goto('/roadmap?plan=replan&planFrom=project');
  await expect(rail(page)).toBeVisible();

  await sendTurn(page, 'Split the settings epic into smaller stories.');

  // The failure is stated, and it is RECOVERABLE: the turn is still on the thread
  // and "Try again" re-sends the accumulated intent rather than restarting.
  await expect(rail(page).getByRole('alert')).toContainText(/didn't go through/);
  await expect(rail(page).getByTestId('conversation-user-turn').first()).toBeVisible();
  await expect(confirmBar(page)).toHaveCount(0);

  failing = false;
  await rail(page).getByRole('button', { name: 'Try again' }).click();

  // Same conversation, now settled: the proposal is on the canvas.
  await expect(confirmBar(page)).toContainText('1 added, 1 changed');
  await expect(rail(page).getByRole('alert')).toHaveCount(0);
});

test('the one-shot "Augment from prompt" door is gone from /backlog and /items', async ({
  page,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1726');
  const seed = await seedAiAugmentReplan(`plan-change-retired-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);

  await signIn(page, seed.email, seed.password);

  // Each page is asserted LOADED first — an absence assertion on a page that
  // never rendered would pass vacuously.
  await page.goto('/backlog');
  await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Augment from prompt/i })).toHaveCount(0);

  await page.goto('/items');
  await expect(page.getByRole('heading', { name: 'Work Items' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Augment from prompt/i })).toHaveCount(0);

  // The conversational door is what replaced it — present on both surfaces.
  await expect(page.getByRole('link', { name: 'Plan with AI' }).first()).toBeVisible();
});
