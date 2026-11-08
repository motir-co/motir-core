// Acceptance E2E — CONTEXTUAL planning from a work item (Subtask MOTIR-913,
// Story MOTIR-812).
//
// Runs under playwright.acceptance.config.ts (video: 'on') so the CI
// acceptance-video lane records a chaptered clip; `acceptanceStory()` pins every
// recording to Story MOTIR-812 regardless of the PR that triggered the run.
//
// The story's whole flow, from the user's seat: you are LOOKING AT a work item,
// you ask for a plan change from that item's own door, you review what came
// back, you confirm, and it lands UNDER that item.
//
//   1. The per-item Plan / Re-plan entrance (MOTIR-910) opens the universal
//      planning workspace ANCHORED at that item — a scoped conversation, not the
//      project-wide one.
//   2. A turn runs, narrates, and settles into REVIEW with the engine's real
//      proposals rendered. Not the `EMPTY` state — that is the regression
//      MOTIR-1746 fixed and this spec's standing guard (every motir-ai plan-edit
//      handler returns `planDelta: { operations: [] }`, so a delta-driven rail
//      could never leave `EMPTY`).
//   3. NOTHING IS WRITTEN until the confirm. This is the gate — the single most
//      important assertion here (Story MOTIR-812 / the MOTIR-911 persist gate).
//   4. Confirm → the items appear under the anchor and the Plan is `approved`.
//   5. The SIBLING-under-the-parent and PARENT-re-plan cases go through the same
//      confirm (test 2 / test 3): what may be PROPOSED is not scope-limited to
//      the anchor's own subtree, but everything WRITTEN still passes one gate.
//   6. Discard declines the Plan and leaves the tree untouched (test 4); a failed
//      run is recoverable in place (test 5).
//
// DETERMINISM (`notes.html` #37 · `motir-core/CLAUDE.md` § E2E waits on the
// authoritative signal). motir-ai has no presence in CI, so the browser→ai hop is
// stubbed via `page.route` — the only interceptable one (a server-side fetch out
// of a route handler is NOT reachable from `page.route`, mistakes #112 / #152).
// Everything on THIS side of that hop runs REAL:
//
//   • the item-anchored THREAD — the submit stub lets the REAL route run first,
//     which appends the user's turn to Postgres before it ever reaches motir-ai
//     (`contextualPlanningService.planFromWorkItem`: `appendTurn` precedes
//     `submit`), then re-reads the thread through the shipped resume GET. So the
//     turns the rail renders are genuinely persisted rows, never stub echoes;
//   • the PROPOSALS — a real `Plan`, seeded through the same
//     `createPlan → addProposals → markPlanned` calls the handler's own callbacks
//     make (MOTIR-1746), so the review is `planReviewService` reading Postgres;
//   • the review READ, the approve and the decline — `/api/plans/[id]`,
//     `…/approve` (→ `plansService.approvePlan` → `materialize`, behind the
//     MOTIR-911 gate) and `…/decline`, so every assertion lands on real DB state;
//   • the canvas levels — the shipped per-level roadmap endpoint.
//
// Only the job DISPATCH and the job's SSE are stubbed. The streaming state is
// observed by HOLDING the plan read until the assertion has run — an
// authoritative gate, never a timeout.

import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import type { Page, Route } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedAiAugmentReplan, markProjectOnboarded } from './_helpers/ai-augment-replan-seed';
import {
  childTitlesOf,
  seedContextualProposal,
  workItemIdByKey,
  CONTEXTUAL_JOB_ID,
} from './_helpers/contextual-plan-seed';

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

// ── What the runs propose ────────────────────────────────────────────────────

const DIGEST = 'Email digest';
const TOASTS = 'In-app toasts';
const SIBLING = 'Session expiry banner';
const UNDER_PARENT = 'Account recovery';
const RENAMED_EPIC = 'Authentication & sessions';

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
 * Stub the item-anchored SUBMIT — `POST /api/work-items/[id]/ai/plan`, the one
 * hop of a contextual turn that reaches motir-ai. The anchored contract FUSES
 * appending the turn and submitting it (MOTIR-909 gates the anchor set once), so
 * a stub that simply answered would mean the user's turn was never persisted and
 * the rail would render a thread the app never wrote.
 *
 * So this does not fake the thread: it FIRES the real route, which appends the
 * turn to Postgres before it ever reaches motir-ai, and then re-reads the
 * resulting thread through the shipped resume `GET`. The stub contributes exactly
 * the two facts motir-ai would have: the `jobId` and — the shipped MOTIR-1745
 * contract — the `planId` of the Plan the run's proposals live in, which is what
 * the rail reads and confirms. A stub answering with only a `jobId` would leave
 * the rail with nothing to confirm, which is the shape of the bug MOTIR-1746
 * fixed.
 *
 * ⚠️ It does NOT await that real call. The append commits early; the request then
 * spends seconds failing to reach a motir-ai that CI does not run (an unresolvable
 * host), and waiting for that would put a multi-second stall inside every turn —
 * latency a loaded runner could stretch past the response timeout, for no signal.
 * So the append is observed DIRECTLY instead: poll the resume until the turn is
 * actually on the thread (`waitForAppendedTurn`). That is the authoritative
 * signal — the committed row — rather than the failure's arrival time.
 *
 * A RESUBMIT (the rail's Try again) rides the same route and deliberately appends
 * NOTHING, so the expected turn count does not move and the read settles at once.
 */
async function stubContextualSubmit(
  page: Page,
  anchorId: string,
  runs: readonly { jobId: string; planId: string }[],
): Promise<void> {
  let call = 0;
  // What the thread should hold once the current turn has landed. A submit adds
  // one user turn; a resubmit adds none.
  let expectedUserTurns = 0;
  await page.route(`**/api/work-items/${anchorId}/ai/plan`, async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') {
      await route.continue();
      return;
    }
    const run = runs[Math.min(call, runs.length - 1)]!;
    call += 1;
    const body = (request.postDataJSON() ?? {}) as { prompt?: string; resubmit?: boolean };
    if (body.resubmit !== true) expectedUserTurns += 1;

    // The real hop, fired and left to fail on its own time (see above).
    void route.fetch().catch(() => undefined);

    const resumeUrl = new URL(request.url());
    resumeUrl.search = '';
    const session = await waitForAppendedTurn(page, resumeUrl.toString(), expectedUserTurns);

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobId: run.jobId,
        planId: run.planId,
        sessionId: session?.id ?? null,
        session,
      }),
    });
  });
}

interface ThreadSession {
  id?: string;
  turns?: { role: string }[];
}

/**
 * Read the item's thread through the shipped resume `GET` until it carries
 * `expectedUserTurns` user turns — the authoritative "the append committed"
 * signal, polled rather than slept on. Returns the thread as the app holds it.
 *
 * It THROWS on expiry rather than returning a short thread: a silently-missing
 * turn would leave the rail rendering a conversation the app never wrote, which
 * is precisely what this helper exists to prevent.
 */
async function waitForAppendedTurn(
  page: Page,
  resumeUrl: string,
  expectedUserTurns: number,
): Promise<ThreadSession | null> {
  const deadline = Date.now() + 15_000;
  let session: ThreadSession | null = null;
  do {
    const res = await page.request.get(resumeUrl, { headers: { Accept: 'application/json' } });
    if (res.ok()) {
      session = ((await res.json()) as { session: ThreadSession | null }).session;
      const userTurns = (session?.turns ?? []).filter((turn) => turn.role === 'user').length;
      if (userTurns >= expectedUserTurns) return session;
    }
    // The POLL INTERVAL between authoritative reads — not a synchronisation
    // sleep. The condition below is the committed row; this only spaces the
    // reads that check for it (`waitForTimeout` is deliberately avoided so the
    // "fixed sleep as a wait" anti-pattern stays greppable in this repo).
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(
    `The contextual thread never reached ${expectedUserTurns} user turn(s) — the real route stopped appending before its motir-ai hop.`,
  );
}

/** The contextual job's SSE, carrying the REAL frame vocabulary the rail narrates
 *  (`search` / `planned` / `done`) — structured progress, not assistant tokens. */
function progressSse(proposed: number): string {
  return (
    `event: search\ndata: {}\n\n` +
    `event: planned\ndata: {"proposed":${proposed}}\n\n` +
    `event: done\ndata: {}\n\n`
  );
}

/** The anchored run's stream relay (`…/ai/plan/[jobId]/stream`). */
async function stubContextualStream(
  page: Page,
  anchorId: string,
  jobId: string,
  body: string | (() => string),
): Promise<void> {
  await page.route(`**/api/work-items/${anchorId}/ai/plan/${jobId}/stream`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: typeof body === 'function' ? body() : body,
    });
  });
}

/**
 * HOLD the settled read of one plan until the returned `release()` is called —
 * then let it through to the REAL route. That makes the STREAMING state
 * deterministically observable (the run cannot advance past a request the test is
 * holding), so the narration is asserted against an authoritative gate rather
 * than a timeout. It delays the response; it never fakes one.
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

/** The workspace itself — the shipped `Modal`, so a real `role=dialog`.
 *
 *  ⚠️ EVERY WORKSPACE-OWNED LOCATOR IN THIS FILE IS SCOPED TO IT (MOTIR-4725).
 *  The planning workspace was a ROUTE; it is an OVERLAY now, and this whole spec
 *  runs with it open OVER the item page it was launched from. So the host page is
 *  still mounted, and anything the two surfaces render alike resolves twice —
 *  which Playwright's strict mode refuses. It bit here the moment a proposal was
 *  CONFIRMED: the approve refreshes the page underneath, the item's Children
 *  panel gains a row for the new subtask, and `getByText('Email digest')` then
 *  matched both that row's link and the canvas node.
 *
 *  This is the locator hazard `motir-core/CLAUDE.md` records for a route-group
 *  boundary — "a boundary makes every unscoped locator a race", 30 assertions
 *  across 17 files — in the shape an overlay gives it, and the remedy is the
 *  same: `getByRole` is what disambiguates, so the scope is the DIALOG rather
 *  than a new testid. */
const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });

const rail = (page: Page) => workspace(page).getByRole('complementary', { name: 'Motir AI' });
/** The composer's message field. Its accessible name TRACKS the placeholder
 *  (MOTIR-910: a re-plan asks for the reason), so it is addressed by ROLE — the
 *  way the shipped composer documents its only textbox. */
const composer = (page: Page) => rail(page).getByRole('textbox');
const confirmBar = (page: Page) => workspace(page).getByTestId('plan-change-confirm-bar');
const railReview = (page: Page) => workspace(page).getByTestId('plan-change-review');
/** The item page's live route subtree, underneath any overlay. */
const itemPage = (page: Page) => page.getByRole('main');
/** The door lives on the ITEM PAGE, which is what opens the overlay — and the
 *  last chapter reads it with the workspace closed. So it is scoped to `main`
 *  rather than to `workspace()` (MOTIR-5116): `main` is the item page's own live
 *  subtree, so the locator says which surface the door is on and still resolves
 *  with the overlay open. It keeps its id rather than taking its `link` role,
 *  because its accessible name is what two of the assertions below MEASURE. */
const entrance = (page: Page) => itemPage(page).getByTestId('work-item-plan-entrance');
/** A PROPOSED `add`, as the PLAN PAGE draws it.
 *
 *  ⚠️ `PlanItemNode`'s `data-op` (MOTIR-6155). Once a plan is proposed the left
 *  pane mounts the plan page's own List | Canvas component, so a proposal here is
 *  the same node `/plans/<id>` draws — the one proposal card, since MOTIR-6299
 *  deleted this surface's own diff frame. With no plan the pane is the plain
 *  roadmap, and no proposal card is on it — asserted as an absence at the empty
 *  state below. */
const addFrames = (page: Page) => workspace(page).locator('[data-op="add"]');
/** The shipped List | Canvas switch, inside the overlay (MOTIR-6155).
 *
 *  ⚠️ IT IS PRESSED BEFORE THE CANVAS IS READ AT ALL on a plan that opens on the
 *  LIST — not merely before it is clicked. The canvas stays MOUNTED across a
 *  switch, in a keep-alive wrapper that is `inert`, `visibility: hidden` AND
 *  `aria-hidden`. The first two only block interaction; the third takes the whole
 *  subtree out of the accessibility tree, so every `getByRole` inside it matches
 *  ZERO and a crumb read fails with `element(s) not found`. Measured, not
 *  reasoned: an earlier revision of this file asserted the crumb before the
 *  switch on the strength of "hidden still answers an attribute read", and the
 *  `billing-cloud` leg went red on exactly that line. */
const viewButton = (page: Page, name: 'List' | 'Canvas') =>
  workspace(page).getByRole('button', { name, exact: true });
/** A BREADCRUMB crumb on the overlay's canvas, by its `KEY · Title` label. The
 *  bar renders only once the canvas is drilled, which — since MOTIR-6154 — it is
 *  from the moment the surface opens inside its target. */
const crumb = (page: Page, label: string) =>
  workspace(page)
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('button', { name: label });
/** A committed or proposed CARD on the canvas, by its title. */
const canvasTitle = (page: Page, title: string) =>
  workspace(page).getByText(title, { exact: true });

/** A roadmap LEVEL fetch for one parent — the canvas's authoritative "this
 *  level's committed children" read (armed BEFORE the drill that triggers it). */
const levelLoad = (page: Page, parentId: string) =>
  page.waitForResponse(
    (r) =>
      r.url().includes('/roadmap') &&
      r.url().includes(`parentId=${parentId}`) &&
      r.request().method() === 'GET' &&
      r.ok(),
  );

/** Open a work item's planning door and land in the anchored workspace. */
async function openWorkspaceFromItem(page: Page, itemKey: string, mode: 'plan' | 'replan') {
  await page.goto(`/items/${itemKey}`);
  await expect(entrance(page)).toBeVisible();
  await expect(entrance(page)).toHaveAttribute('data-mode', mode);
  await entrance(page).click();
  await page.waitForURL((url) => url.searchParams.has('plan'));
  // ⚠️ THE FIRST LANDMARK AFTER LANDING ON `/planning` CARRIES THE FIRST-PAINT
  // BUDGET (MOTIR-2506) — see the constant's own note. Every test in this file
  // reaches the workspace through this helper, so the budget belongs here rather
  // than at one call site: the stall lands on whichever test happens to be
  // running, which is exactly how it was found.
  await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  // The thread is scoped to the ITEM, and the rail says so: the card's Plan /
  // Re-plan button opens on the START PROMPT, which names the card (MOTIR-10624).
  await expect(
    rail(page).getByRole('region', {
      name: `${mode === 'replan' ? 'Start re-planning' : 'Start planning'} ${itemKey}`,
    }),
  ).toBeVisible();
}

/**
 * Type a turn and send it, waiting on the SUBMIT's 200 — the authoritative "the
 * turn went out" signal. The status is part of the predicate so the stub's own
 * inner call to the real route can never be mistaken for it.
 */
async function sendTurn(page: Page, text: string): Promise<void> {
  const submitted = page.waitForResponse(
    (r) => r.url().includes('/ai/plan') && r.request().method() === 'POST' && r.status() === 200,
  );
  await composer(page).fill(text);
  await rail(page).getByRole('button', { name: 'Send' }).click();
  await submitted;
}

// ⚠️ `drillInto` IS DELETED, and TWO stories independently made it wrong. It
// selected a node and pressed Open to reach the level a proposal sat on.
// MOTIR-6154 opens the surface INSIDE its target, and MOTIR-6155 mounts the plan
// page's component, whose `arrivalLevel` lands on the container the plan fills —
// so its one caller was drilling PAST its own subject either way. A breadcrumb
// assertion at the arrival replaces it.

/** Approve the pending proposal, waiting on the approve's 200 before any re-read
 *  (never on the optimistic UI — `motir-core/CLAUDE.md` § authoritative signal). */
async function approveProposal(page: Page, planId: string): Promise<void> {
  const approved = page.waitForResponse(
    (r) => r.url().includes(`/api/plans/${planId}/approve`) && r.request().method() === 'POST',
  );
  await confirmBar(page).getByRole('button', { name: 'Approve', exact: true }).click();
  expect((await approved).status()).toBe(200);
}

const planStatus = async (planId: string) =>
  (await db.plan.findUnique({ where: { id: planId } }))?.status;

/**
 * A DWELL between chapters of the recorded run — purely so the clip is watchable.
 *
 * The whole flow settles in about two seconds, which makes a technically correct
 * but useless video: five chapters flash past before a reviewer can read one. So
 * the recorded happy path pauses between chapters, exactly as the MOTIR-1627
 * acceptance-video dogfood (`acceptance-video.spec.ts`) does.
 *
 * This is NOT synchronisation and never stands in for one: every assertion in
 * this file still waits on its own authoritative signal, and these calls sit
 * BETWEEN chapters, never between an action and the assertion that proves it.
 * They only pace the recording, and only in the test that is recorded.
 */
const dwell = (page: Page) => page.waitForTimeout(1_800);

// ── Tests ────────────────────────────────────────────────────────────────────

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// The recorded happy path — it carries the chapter markers the acceptance
// video's timeline is built from.
test('planning in context — the item’s own door, reviewed, confirmed, landed under it', async ({
  page,
  chapter,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-812');
  const seed = await seedAiAugmentReplan(`contextual-plan-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);

  // The run's output as a REAL plan: two subtasks proposed UNDER the anchor —
  // "break this story into subtasks", the commonest contextual ask.
  const planId = await seedContextualProposal(seed.ctx, seed.projectId, {
    jobId: CONTEXTUAL_JOB_ID,
    title: 'Break Notifications into subtasks',
    adds: [
      {
        title: DIGEST,
        kind: 'subtask',
        parentWorkItemId: seed.notifId,
        type: 'code',
        storyPoints: 3,
        estimateMinutes: 45,
      },
      {
        title: TOASTS,
        kind: 'subtask',
        parentWorkItemId: seed.notifId,
        type: 'code',
        storyPoints: 2,
        estimateMinutes: 30,
      },
    ],
    // The conversation this turn belongs to — the same anchor the stub names.
    anchorWorkItemId: seed.notifId,
  });

  await stubAiAccess(page);
  await stubContextualSubmit(page, seed.notifId, [{ jobId: CONTEXTUAL_JOB_ID, planId }]);
  await stubContextualStream(page, seed.notifId, CONTEXTUAL_JOB_ID, progressSse(2));
  const releasePlanRead = await gatePlanRead(page, planId);

  await signIn(page, seed.email, seed.password);

  await chapter('The work item’s own planning door', async () => {
    await page.goto(`/items/${seed.notifKey}`);
    // Asserted LOADED before any absence assertion, which would otherwise pass
    // vacuously on a page that never rendered.
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    // The item starts childless — so the door reads PLAN, not Re-plan, and the
    // detail page has no child section at all (a leaf renders none).
    await expect(itemPage(page).getByText('Child work items')).toHaveCount(0);
    await expect(entrance(page)).toHaveAttribute('data-mode', 'plan');
    await expect(entrance(page)).toHaveAccessibleName(`Plan ${seed.notifKey}`);

    await entrance(page).click();
    await page.waitForURL((url) => url.searchParams.get('planItem') !== null);

    // The workspace opens ANCHORED at the item: the rail names it, and the mode
    // chip is the contextual one (not the project-wide plan change).
    await expect(rail(page)).toBeVisible();
    await expect(rail(page).getByText(`Opened in the context of ${seed.notifKey}.`)).toBeVisible();
    // IN THE RAIL — a `Pill` in `PlanChangeRail`, no role of its own.
    await expect(rail(page).getByTestId('planning-mode-chip')).toHaveText('in context');

    // The EMPTY state: a thread with no turns is not a blank screen — the canvas
    // already draws the plan, and there is nothing pending to confirm.
    // IN THE OVERLAY — `ProjectRoadmapCanvas`'s wrapper around the
    // `role="application"` viewport carries no role, so it is scoped to the
    // dialog, exactly as `confirmBar` and `railReview` above already are.
    await expect(workspace(page).getByTestId('roadmap-canvas')).toBeVisible();
    await expect(confirmBar(page)).toHaveCount(0);
    await expect(railReview(page)).toHaveCount(0);
    await expect(workspace(page).getByTestId('plan-item-node')).toHaveCount(0);
  });
  await dwell(page);

  await chapter('Ask Motir to break it down', async () => {
    await sendTurn(page, 'Break this story into subtasks: an email digest and in-app toasts.');

    // STREAMING: the plan read is held, so the run is parked mid-flight and the
    // rail's live region shows the narration built from the SSE's real frames.
    // IN THE RAIL — a bare `<div aria-live="polite">`; `aria-live` is not a role.
    await expect(rail(page).getByTestId('plan-change-progress')).toContainText(/proposed so far/);
    releasePlanRead();

    // REVIEW — with the engine's proposals, NOT the `EMPTY` state. The absence of
    // an alert is the MOTIR-1746 regression guard: a delta-driven rail always
    // landed on "Nothing came back to change".
    await expect(railReview(page)).toBeVisible();
    await expect(railReview(page)).toContainText('Nothing saved yet');
    await expect(rail(page).getByRole('alert')).toHaveCount(0);
    await expect(confirmBar(page)).toContainText('2 added');
    await expect(confirmBar(page)).toContainText(
      // An ASKED plan's bar reads the gate's consequence line (MOTIR-6037).
      'Approving adds these to your backlog. Declining ends the plan and changes nothing.',
    );

    // The turn is a PERSISTED row, appended by the real route — not a stub echo.
    await expect(rail(page).getByTestId('conversation-user-turn').first()).toBeVisible();
  });
  await dwell(page);

  await chapter('Nothing is written until you confirm', async () => {
    // The proposal is reviewable ON THE CANVAS with NO drill: MOTIR-6154 opens the
    // surface INSIDE the anchor, so the level the run proposed onto is the level
    // already on screen. The anchor was childless, which is why that level was
    // empty in the first chapter and carries the two proposals now.
    //
    // MOTIR-6155 lands on the same level from the other direction: the pane mounts
    // the plan page's component, and its `arrivalLevel` → `fullestContainer` is the
    // anchor too, because both subtasks are proposed under it. One container, so
    // the component also opens on CANVAS rather than the list.
    //
    // (Before MOTIR-6154 the canvas opened BESIDE the anchor and this step drilled
    // in by hand. Keeping the drill would hunt for a `Notifications` CARD that the
    // arrival has already left behind — the same reason the sibling test below
    // stopped drilling when MOTIR-2070 moved the arrival the first time.)
    await expect(crumb(page, `${seed.notifKey} · Notifications`)).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(addFrames(page)).toHaveCount(2);
    await expect(canvasTitle(page, DIGEST)).toBeVisible();
    await expect(canvasTitle(page, TOASTS)).toBeVisible();

    // THE GATE. Re-read the anchor authoritatively — through the shipped
    // per-level endpoint, from the signed-in browser — and nothing has been
    // written: the anchor still has no committed children.
    const projectKey = (await db.project.findUniqueOrThrow({ where: { id: seed.projectId } }))
      .identifier;
    const level = await page.request.get(
      `/api/projects/${projectKey}/roadmap?parentId=${seed.notifId}`,
      { headers: { Accept: 'application/json' } },
    );
    expect(level.ok()).toBe(true);
    expect(((await level.json()) as { nodes: unknown[] }).nodes).toEqual([]);

    // …and the substrate agrees: no rows, and the Plan is still undecided.
    expect(await childTitlesOf(seed.notifId)).toEqual([]);
    expect(await planStatus(planId)).toBe('planned');
  });
  await dwell(page);

  await chapter('Confirm — the subtasks land under the item', async () => {
    // The canvas island refetches the level it is showing once the tree changes,
    // so the committed children replace the proposed frames in place.
    const committed = levelLoad(page, seed.notifId);
    await approveProposal(page, planId);
    await committed;

    // The rail says what landed and KEEPS the thread — a plan change is rarely
    // one change, so the conversation stays open.
    await expect(rail(page).getByText(/Added 2 work items/)).toBeVisible();
    await expect(composer(page)).toBeEnabled();

    // The gate is gone — and the cards STAY, now wearing the decision
    // (`design/ai-planning/design-notes.md` Part VI §3 / MOTIR-3162, via bug
    // MOTIR-3206). This read `addFrames → 0`, which was right while a decision
    // ERASED the overlay: the pane held proposals, and a proposal is spent by
    // the decision that resolves it. It holds the RECORD of that decision now —
    // produced by it, not spent by it — so the frames are what a reader comes
    // back to for "what did I just say yes to".
    //
    // Asserted by the outcome WORD, not by the attribute alone, so a
    // colour-only treatment cannot pass this (Part VI §3's a11y rule: the word
    // in the chip carries the meaning, the spine is decoration).
    await expect(confirmBar(page)).toHaveCount(0);
    await expect(addFrames(page)).toHaveCount(2);
    await expect(addFrames(page).first()).toHaveAttribute('data-outcome', 'accepted');
    await expect(workspace(page).getByTestId('plan-item-outcome').first()).toHaveText('accepted');
    await expect(canvasTitle(page, DIGEST)).toBeVisible();

    // The real substrate: both landed UNDER the anchor, as subtasks, and the Plan
    // is decided — nothing left orphaned at `planned`.
    expect(await childTitlesOf(seed.notifId)).toEqual([DIGEST, TOASTS]);
    const children = await db.workItem.findMany({ where: { parentId: seed.notifId } });
    expect(children).toHaveLength(2);
    for (const child of children) expect(child.kind).toBe('subtask');
    expect(await planStatus(planId)).toBe('approved');
  });
  await dwell(page);

  await chapter('Back on the work item', async () => {
    // Where the user started — the children are now the item's own.
    await page.goto(`/items/${seed.notifKey}`);
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    // SCOPED TO THE ITEM PAGE — these are body copy and child-row links with no
    // role of their own, and the page streams its late stack behind an in-page
    // `<Suspense>`, so a page-rooted read can resolve React's hidden `S:0` copy.
    const childSection = itemPage(page).getByText('Child work items');
    await expect(childSection).toBeVisible();
    await expect(itemPage(page).getByText(DIGEST, { exact: true })).toBeVisible();
    await expect(itemPage(page).getByText(TOASTS, { exact: true })).toBeVisible();
    // The door now reads Re-plan: the item has children (MOTIR-910's two faces).
    await expect(entrance(page)).toHaveAttribute('data-mode', 'replan');
  });
});

test('a SIBLING under the anchor’s parent goes through the same confirm', async ({
  page,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-812');
  const seed = await seedAiAugmentReplan(`contextual-sibling-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  const loginId = await workItemIdByKey(seed.projectId, seed.loginKey);
  const authEpicId = await workItemIdByKey(seed.projectId, seed.authEpicKey);

  // Anchored at "Login UI", the run proposes a SIBLING — a story under the SAME
  // epic. What may be PROPOSED is not limited to the anchor's own subtree; what
  // gets WRITTEN still passes the one confirm.
  const planId = await seedContextualProposal(seed.ctx, seed.projectId, {
    jobId: CONTEXTUAL_JOB_ID,
    title: 'Add a session-expiry story beside Login UI',
    adds: [{ title: SIBLING, kind: 'story', parentWorkItemId: authEpicId }],
    // The conversation this turn belongs to — the same anchor the stub names.
    anchorWorkItemId: loginId,
  });

  await stubAiAccess(page);
  await stubContextualSubmit(page, loginId, [{ jobId: CONTEXTUAL_JOB_ID, planId }]);
  await stubContextualStream(page, loginId, CONTEXTUAL_JOB_ID, progressSse(1));

  await signIn(page, seed.email, seed.password);
  await openWorkspaceFromItem(page, seed.loginKey, 'plan');

  await sendTurn(page, 'We also need a session-expiry banner beside this — put it in the epic.');
  await expect(confirmBar(page)).toContainText('1 added');
  await expect(rail(page).getByRole('alert')).toHaveCount(0);

  // ⭐ IT IS REVIEWABLE ON THE PARENT'S LEVEL, WHERE THE PROPOSAL BELONGS — with
  // no drill and no crumb. This step is where the two merged stories DISAGREED,
  // and the disagreement resolved in favour of the reader.
  //
  // MOTIR-6154 opens the surface INSIDE its target, and the target here is the
  // story `Login UI`. The sibling is proposed under the EPIC, so under that story
  // alone the proposal was NOT on the arrival level: the canvas stood one level
  // below the thing it was meant to be showing, and reaching it took a crumb. That
  // is real, and MOTIR-6154 filed it rather than papering over it — MOTIR-6223.
  //
  // MOTIR-6155 removes the gap rather than routing around it. Once the plan is
  // PROPOSED the pane is the plan page's own component, and that component arrives
  // at `fullestContainer` — the container the plan most fills, which IS the epic.
  // So the arrival is the proposal's own level, the epic carries `aria-current`,
  // and the sibling is on screen from the first paint. `Login UI` is not a crumb
  // at all any more: the trail is the path to the epic.
  //
  // The breadcrumb is the authoritative arrival signal either way — the canvas
  // publishes a trail only for a level it has actually loaded.
  await expect(crumb(page, `${seed.authEpicKey} · Authentication`)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(addFrames(page)).toHaveCount(1);
  // ON THE CANVAS — the file's own helper, scoped to the overlay.
  await expect(canvasTitle(page, SIBLING)).toBeVisible();

  // Still nothing written before the confirm.
  expect(await childTitlesOf(authEpicId)).toEqual(['Login UI', 'Password Reset']);

  await approveProposal(page, planId);

  // It landed as a SIBLING: under the epic, not under the anchor.
  expect(await childTitlesOf(authEpicId)).toEqual(['Login UI', 'Password Reset', SIBLING]);
  expect(await childTitlesOf(loginId)).toEqual([]);
  expect(await planStatus(planId)).toBe('approved');
});

test('re-planning the PARENT goes through the same confirm', async ({ page, acceptanceStory }) => {
  acceptanceStory('MOTIR-812');
  const seed = await seedAiAugmentReplan(`contextual-parent-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  const authEpicId = await workItemIdByKey(seed.projectId, seed.authEpicKey);

  // The epic itself is the anchor — it HAS children, so this is a RE-plan: the
  // run renames it and adds work under it.
  const planId = await seedContextualProposal(seed.ctx, seed.projectId, {
    jobId: CONTEXTUAL_JOB_ID,
    title: 'Re-plan the Authentication epic',
    adds: [{ title: UNDER_PARENT, kind: 'story', parentWorkItemId: authEpicId }],
    modify: { workItemId: authEpicId, patch: { title: RENAMED_EPIC } },
    // The conversation this turn belongs to — the same anchor the stub names.
    anchorWorkItemId: authEpicId,
  });

  await stubAiAccess(page);
  await stubContextualSubmit(page, authEpicId, [{ jobId: CONTEXTUAL_JOB_ID, planId }]);
  await stubContextualStream(page, authEpicId, CONTEXTUAL_JOB_ID, progressSse(1));

  await signIn(page, seed.email, seed.password);
  await openWorkspaceFromItem(page, seed.authEpicKey, 'replan');

  // The RE-PLAN face opens by ASKING what's wrong (MOTIR-910): the first turn IS
  // the reason — there is no separate reason field. Since MOTIR-10624 the card's
  // button opens on the start prompt, so the reason is optional and the composer
  // says so; what is typed rides the start line as the reason.
  await expect(composer(page)).toHaveAccessibleName('What’s wrong? (optional)…');

  await sendTurn(page, 'This epic is too vague — rename it and add account recovery.');
  await expect(confirmBar(page)).toContainText('1 added, 1 changed');
  await expect(rail(page).getByRole('alert')).toHaveCount(0);

  // ⚠️ SINCE MOTIR-6154 THE ANCHOR IS THE LEVEL, NOT A CARD ON IT. The surface
  // opens INSIDE the epic, so what is on screen is the epic's children — the
  // proposed `Account recovery` among them — and no CARD carries the epic's own
  // change, because a level frames the nodes ON it and the anchor is the level
  // itself. MOTIR-6223 draws that change where the level is drawn: a second row of
  // the breadcrumb bar (design MOTIR-6241), carrying the op, the proposed title and
  // the changed fields. So the rename is REVIEWABLE from the level the surface
  // arrives on, and this test rules on that first; the root still draws the epic's
  // card frame, and the test climbs there second to hold that too.
  //
  // ⚠️ THE VIEW IS CHOSEN FIRST, BEFORE THE CANVAS IS READ AT ALL. This plan
  // STRADDLES two containers — the `add` under the epic, the `modify` on the epic
  // itself — so `defaultPlanView` opens it on the LIST (MOTIR-3262's Part IX §3
  // arm). That default is right, and while it holds the canvas sits in the
  // keep-alive wrapper carrying `aria-hidden`, which takes its breadcrumb OUT OF
  // THE ACCESSIBILITY TREE: every `getByRole` below it matches zero, so a crumb
  // assertion here fails with `element(s) not found` rather than a wrong value.
  // (Being `inert` and `visibility: hidden` would only have blocked a click; the
  // `aria-hidden` is what defeats a role-based read, and it is why this switch
  // cannot sit after the assertions it enables.)
  await viewButton(page, 'Canvas').click();

  await expect(crumb(page, `${seed.authEpicKey} · Authentication`)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(canvasTitle(page, UNDER_PARENT)).toBeVisible();

  // ⭐ THE RENAME, ON THE LEVEL YOU ARE STANDING IN (MOTIR-6223). The crumb keeps
  // the COMMITTED title; the band under it carries the proposed one.
  const levelBand = workspace(page).getByTestId('canvas-level-band');
  await expect(levelBand).toHaveAttribute('data-state', 'changed');
  await expect(levelBand).toContainText(`This level — title → ${RENAMED_EPIC}`);

  // The ROOT read is the one with NO `parentId` — a bare `/roadmap` predicate
  // would also match the level read the arrival itself issued.
  const rootLevel = page.waitForResponse(
    (r) =>
      r.url().includes('/roadmap') &&
      !r.url().includes('parentId=') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );
  await crumb(page, 'Roadmap').click();
  await rootLevel;
  // `PlanItemNode`'s `data-op` — see `addFrames` above. Scoped to the dialog like every other locator here.
  await expect(workspace(page).locator('[data-op="modify"]')).toHaveCount(1);

  // Nothing written yet — the rename has not touched the item.
  const before = await db.workItem.findUniqueOrThrow({ where: { id: authEpicId } });
  expect(before.title).toBe('Authentication');

  await approveProposal(page, planId);

  const after = await db.workItem.findUniqueOrThrow({ where: { id: authEpicId } });
  expect(after.title).toBe(RENAMED_EPIC);
  expect(await childTitlesOf(authEpicId)).toEqual([UNDER_PARENT, 'Login UI', 'Password Reset']);
  expect(await planStatus(planId)).toBe('approved');
});

test('Discard declines the plan and leaves the tree untouched', async ({
  page,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-812');
  const seed = await seedAiAugmentReplan(`contextual-discard-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);

  const planId = await seedContextualProposal(seed.ctx, seed.projectId, {
    jobId: CONTEXTUAL_JOB_ID,
    title: 'Break Notifications into subtasks',
    adds: [
      { title: DIGEST, kind: 'subtask', parentWorkItemId: seed.notifId },
      { title: TOASTS, kind: 'subtask', parentWorkItemId: seed.notifId },
    ],
    // The conversation this turn belongs to — the same anchor the stub names.
    anchorWorkItemId: seed.notifId,
  });

  await stubAiAccess(page);
  await stubContextualSubmit(page, seed.notifId, [{ jobId: CONTEXTUAL_JOB_ID, planId }]);
  await stubContextualStream(page, seed.notifId, CONTEXTUAL_JOB_ID, progressSse(2));

  await signIn(page, seed.email, seed.password);
  await openWorkspaceFromItem(page, seed.notifKey, 'plan');

  await sendTurn(page, 'Break this story into subtasks.');
  await expect(confirmBar(page)).toContainText('2 added');

  // The terminal action. It WRITES to the plan (so the run is decided rather than
  // left orphaned at `planned`) and never to the tree.
  const declined = page.waitForResponse(
    (r) => r.url().includes(`/api/plans/${planId}/decline`) && r.request().method() === 'POST',
  );
  // An ASKED plan's Discard is the gate's Decline, which confirms once in an inline
  // band with an OPTIONAL reason (MOTIR-6037; design Part XXII §22.4).
  await confirmBar(page).getByRole('button', { name: 'Decline', exact: true }).click();
  await page
    .getByTestId('plan-decline-confirm')
    .getByRole('button', { name: 'Yes, decline' })
    .click();
  expect((await declined).status()).toBe(200);

  // The gate is gone, the conversation stays, and the tree is exactly as it was.
  await expect(confirmBar(page)).toHaveCount(0);
  await expect(railReview(page)).toHaveCount(0);
  await expect(composer(page)).toBeEnabled();
  await expect(rail(page).getByTestId('conversation-user-turn').first()).toBeVisible();
  expect(await childTitlesOf(seed.notifId)).toEqual([]);
  expect(await planStatus(planId)).toBe('declined');
});

test('a failed run is recoverable in place — the thread survives, the tree is untouched', async ({
  page,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-812');
  const seed = await seedAiAugmentReplan(`contextual-error-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);

  const planId = await seedContextualProposal(seed.ctx, seed.projectId, {
    jobId: CONTEXTUAL_JOB_ID,
    title: 'Break Notifications into subtasks',
    adds: [
      { title: DIGEST, kind: 'subtask', parentWorkItemId: seed.notifId },
      { title: TOASTS, kind: 'subtask', parentWorkItemId: seed.notifId },
    ],
    // The conversation this turn belongs to — the same anchor the stub names.
    anchorWorkItemId: seed.notifId,
  });

  // One job (and one plan) for both attempts: the STREAM fails first and succeeds
  // on retry, which re-sends the accumulated intent to the same thread.
  let failing = true;
  await stubAiAccess(page);
  await stubContextualSubmit(page, seed.notifId, [{ jobId: CONTEXTUAL_JOB_ID, planId }]);
  await stubContextualStream(page, seed.notifId, CONTEXTUAL_JOB_ID, () =>
    failing ? `event: error\ndata: {"code":"FAILED"}\n\n` : progressSse(2),
  );

  await signIn(page, seed.email, seed.password);
  await openWorkspaceFromItem(page, seed.notifKey, 'plan');

  await sendTurn(page, 'Break this story into subtasks.');

  // The failure is STATED and recoverable: the turn is still on the thread, no
  // gate appeared, and nothing was written.
  await expect(rail(page).getByRole('alert')).toContainText(/didn't go through/);
  await expect(rail(page).getByTestId('conversation-user-turn').first()).toBeVisible();
  await expect(confirmBar(page)).toHaveCount(0);
  expect(await childTitlesOf(seed.notifId)).toEqual([]);
  expect(await planStatus(planId)).toBe('planned');

  // Try again continues the SAME conversation rather than restarting it.
  failing = false;
  await rail(page).getByRole('button', { name: 'Try again' }).click();

  await expect(confirmBar(page)).toContainText('2 added');
  await expect(rail(page).getByRole('alert')).toHaveCount(0);
  await expect(rail(page).getByTestId('conversation-user-turn').first()).toBeVisible();
});
