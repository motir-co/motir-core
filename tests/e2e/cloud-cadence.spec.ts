// Acceptance E2E — Story 7.13 cadence: auto-planning + AI sprint planning
// (Subtask MOTIR-921).
//
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + video: 'on'), which
// discovers this file by its `acceptance*.spec.ts` name (MOTIR-1700) — the bulk
// shards `testIgnore` the same pattern, so this spec runs ONCE, in the lane that
// records. The recorded happy path declares Story MOTIR-813 via `acceptanceStory`
// (MOTIR-1684), so the clip publishes to 813 whichever PR triggered the run.
//
// It closes the story from the user's seat: a project manager turns the cadence
// settings on, runs AI sprint planning and approves the packing, watches an
// expansion fire on its own when ready work drains, finds auto-plan PAUSED while
// that expansion waits, and sees cadence resume once they decide.
//
// DETERMINISM — no live model, no wall-clock waits:
//   * The `plan_sprint` submit + SSE + review read are stubbed at the BROWSER
//     (`page.route`), the same open-core seam `acceptance-augment-replan.spec.ts`
//     uses. The recorded packing is resolved through the shipped repository +
//     mapper (`buildSprintPlanReview`), and the APPROVE is left entirely real —
//     `approveSprintPlan` re-validates the delta from the request body against
//     live rows and never calls motir-ai — so the sprints this spec asserts are
//     genuine Epic-4 state.
//   * The cron is TRIGGERED, never awaited: `runCadenceTick` drives the shipped
//     `runCadenceSweep` through its own `CadenceDeps.submitExpand` seam, so all
//     three gates run as shipped and `origin: 'cadence'` is the value the sweep
//     itself supplies.
// See `_helpers/ai-cadence-seed.ts` for why each stub sits where it does.
//
// WHICH TEST CARRIES THE CAMERA: only the first. The edge cases below it (the
// auto-plan-OFF tick, the user-clicked-origin variant) are asserted but
// deliberately not narrated into the video. The discard-writes-nothing check is
// the ONE the card listed as a sibling that is not one: it rides the recorded
// run's own `/backlog` render instead, because a sibling test would pay a second
// cold render of that page and this lane cannot currently afford it (see the
// comment at the assertion, and the run note in the PR).
//
// THIS RECORDING PUBLISHES WITHOUT ITS TRACE (MOTIR-1911). It is the lane's
// longest and heaviest journey, and `trace: 'on'` bundles a screenshot stream
// plus every network body — so while the clip itself is small (measured on run
// 30579274284: video.webm 6,340,169 B, comfortably inside the ADR's envelope),
// the trace came to 118,924,401 B, past the workspace's 104,857,600 B per-file
// cap. That used to fail the WHOLE publish, which is how MOTIR-813 ended up the
// one story of eight with no receipt at all. The uploader now measures both
// artifacts up front and DROPS an over-cap trace rather than the receipt, so
// this spec's video publishes and the trace is a best-effort extra. Nothing here
// needs to shrink: the trace is a debugging aid, and the fix for a long journey
// is a smaller STORY, never a faster or shorter recording (the watchability
// amendment in docs/decisions/acceptance-video.md).

import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import {
  aiPlanningPanel,
  clickAiPlanningSave,
  openAiPlanningSettings,
} from './_helpers/ai-planning-settings';
import {
  AUTO_PLAN_THRESHOLD,
  SPRINT_JOB_ID,
  SPRINT_LENGTH_DAYS,
  buildSprintPlanReview,
  drainReadySetBelow,
  proposedChildTitles,
  recordedSprintPacking,
  runCadenceTick,
  seedAiCadence,
  seedUserClickedProposal,
  waitForSeedJobsToSettle,
  type AiCadenceSeed,
} from './_helpers/ai-cadence-seed';
import { jobStreamBody } from './_helpers/job-stream-frames';

test.describe.configure({ timeout: 180_000 });

// ── Stub the browser→motir-ai sprint-planning boundary ───────────────────────

/** The two SSE frames the shipped `plan_sprint` handler emits, then `done` — on
 *  motir-ai's wire, each progress frame in its `{ jobId, seq, data }` envelope. */
function sprintPlanSse(itemCount: number, sprintCount: number): string {
  const packed = {
    sprintLengthDays: SPRINT_LENGTH_DAYS,
    capacityMinutes: SPRINT_LENGTH_DAYS * 240,
    sprints: sprintCount,
  };
  return jobStreamBody(SPRINT_JOB_ID, [
    ['read', { packing: itemCount }],
    ['packed', packed],
    ['done', {}],
  ]);
}

/**
 * Stub submit + stream + the review READ. The approve is untouched on purpose —
 * it is the one write in this flow and the whole point of the assertions that
 * follow it.
 */
async function stubSprintPlanJob(page: Page, seed: AiCadenceSeed): Promise<void> {
  const delta = recordedSprintPacking(seed);
  const review = await buildSprintPlanReview(seed.projectId, delta, seed.ctx.workspaceId);

  await page.route('**/api/ai/plan/sprint', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: SPRINT_JOB_ID }),
    });
  });
  await page.route(`**/api/ai/plan/sprint/${SPRINT_JOB_ID}/stream`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sprintPlanSse(delta.itemCount, delta.sprints.length),
    });
  });
  await page.route(`**/api/ai/plan/sprint/${SPRINT_JOB_ID}/review`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(review),
    });
  });
}

// ── Page helpers ─────────────────────────────────────────────────────────────

// Reaching the AI-planning settings page through its real door — the settings
// rail's Automation group, so the recording shows how a person gets there — is
// `_helpers/ai-planning-settings.ts`'s `openAiPlanningSettings`, imported above.
// It lived here in a copy of its own until MOTIR-3692, which is how one
// navigation race took the `billing-cloud` leg down four different ways.

const autoPlanSwitch = (page: Page) =>
  page.getByRole('switch', { name: 'Expand the plan automatically' });
const sprintPlanningSwitch = (page: Page) =>
  page.getByRole('switch', { name: 'Plan sprints with Motir' });

// ── The page-rooted ids this spec used to carry (MOTIR-5114) ────────────────
//
// This is the surface MOTIR-3692 and MOTIR-3929 both took `main` down on, and
// both threw on a `page.getByTestId`. Each binding below states which of the two
// remedies it took and why, because the choice is not uniform: a node with a
// role AND an accessible name CONVERTS, and a node with neither is SCOPED to a
// live subtree rather than given a role it does not have.

/** CONVERTED. `Stepper` renders `<input type="number" aria-label={…}>`, which is
 *  a `spinbutton` whose accessible name is the label the panel already sets. */
const thresholdField = (page: Page) =>
  page.getByRole('spinbutton', { name: 'Ready-work threshold' });
const sprintLengthField = (page: Page) => page.getByRole('spinbutton', { name: 'Sprint length' });

/** SCOPED to the panel. The paused banner is a `Callout` passed `role="status"`,
 *  but a `status` region takes its name from `aria-label` and this one has none
 *  — so `getByRole('status')` would be BROADER than the id it replaces (every
 *  open toast is one too). The panel is the honest container. */
const pausedBanner = (page: Page) => aiPlanningPanel(page).getByTestId('ai-planning-paused-banner');
/** CONVERTED. A `<Link>` whose visible text is its accessible name. */
const pausedLink = (page: Page) => page.getByRole('link', { name: 'Review the plan' });

/**
 * The paused link points at `planId` — in the planning OVERLAY over this settings
 * page, since the plan it names is undecided (Story MOTIR-7883 · MOTIR-7890).
 *
 * ⚠️ POLLED, because the door's href is `/plans/<id>` until its review read
 * settles and only then becomes the overlay address. And MATCHED, never composed:
 * the address has one author (`planRowDestination`), so the assertion reads its
 * `planSession` back and compares it to the plan's own session in the database —
 * which is what "it points at THIS plan" means for an overlay address.
 */
async function expectPausedLinkOpens(page: Page, planId: string): Promise<void> {
  const { sessionId } = await adminDb.plan.findUniqueOrThrow({
    where: { id: planId },
    select: { sessionId: true },
  });
  expect(sessionId, `plan ${planId} has a session to open`).not.toBeNull();
  const here = new URL(page.url()).pathname;
  await expect
    .poll(async () => {
      const href = await pausedLink(page).getAttribute('href');
      if (!href) return null;
      const url = new URL(href, page.url());
      return url.pathname === here ? url.searchParams.get('planSession') : null;
    })
    .toBe(sessionId);
}

/** SCOPED to `main`. `DockShell` is a `<section aria-labelledby>` — so it IS a
 *  named region — but the name is its own `<h2>`, which is one of THREE titles
 *  chosen by dock state (running / review / done). One assertion below is
 *  `toBeHidden`, where a state-narrowed name would pass for the wrong reason, so
 *  the container keeps the element set exactly as it was. */
const planDock = (page: Page) => page.getByRole('main').getByTestId('sprint-plan-dock');
/** SCOPED to the dock. `ProposedSprintPanel` is a named `region`, but its name
 *  carries the AI-generated sprint NAME, which this spec cannot know — the id is
 *  the `tempId`, which it can. */
const proposedSprint = (page: Page, n: number) =>
  planDock(page).getByTestId(`proposed-sprint-sprint:${n}`);

/** Save the settings panel and wait on the PATCH's 200 — the authoritative
 *  signal. The panel is optimistic, so asserting the reload without this would
 *  race the in-flight write (the coding convention § E2E authoritative signal). */
async function saveAiSettings(page: Page, projectKey: string): Promise<void> {
  const saved = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/projects/${projectKey}/ai-settings`) &&
      r.request().method() === 'PATCH',
  );
  await clickAiPlanningSave(page);
  expect((await saved).status()).toBe(200);
}

/** Every non-archived work item in the project, by title — the "tree unchanged"
 *  witness. */
async function treeTitles(projectId: string): Promise<string[]> {
  const rows = await db.workItem.findMany({
    where: { projectId, archivedAt: null },
    select: { title: true },
    orderBy: { key: 'asc' },
  });
  return rows.map((r) => r.title);
}

async function plansOf(projectId: string) {
  return db.plan.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('cadence — settings on, sprints approved, expansion auto-fires, auto-plan pauses, then resumes', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-813');
  const seed = await seedAiCadence(`ai-cadence-${Date.now()}@example.com`);
  await stubSprintPlanJob(page, seed);
  await waitForSeedJobsToSettle();

  await signIn(page, seed.email, seed.password);

  // ── 1 ─────────────────────────────────────────────────────────────────────
  await chapter('Turn on auto-planning', async () => {
    await openAiPlanningSettings(page);
    await beat();

    await autoPlanSwitch(page).click();
    await beat();
    await thresholdField(page).fill(String(AUTO_PLAN_THRESHOLD));
    await beat();
    await sprintPlanningSwitch(page).click();
    await beat();
    await sprintLengthField(page).fill(String(SPRINT_LENGTH_DAYS));
    await beat();
    await saveAiSettings(page, seed.projectKey);
    await beat();

    // Every setting round-trips — read back from the server, not from the
    // optimistic panel.
    await page.reload();
    await expect(autoPlanSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect(thresholdField(page)).toHaveValue(String(AUTO_PLAN_THRESHOLD));
    await expect(sprintPlanningSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect(sprintLengthField(page)).toHaveValue(String(SPRINT_LENGTH_DAYS));
    await beat();
  });

  // ── 2 ─────────────────────────────────────────────────────────────────────
  await chapter('Approve the proposed sprints', async () => {
    await page.goto('/backlog');

    // The door is live only because sprint planning was switched on above.
    //
    // Modest headroom on THIS assertion alone. `/backlog` is the heaviest render
    // this spec touches and it used to 500 outright here — MOTIR-1753 (the libuv
    // threadpool starving Prisma's in-flight transactions) fixed that, and it now
    // renders in ~1-2s like every other lane. The extra margin is kept only for
    // the FIRST render under CI contention; it is headroom on the same signal,
    // not a sleep, and every later assertion keeps the lane's strict default.
    const planDoor = page.getByRole('button', { name: 'Plan sprints with Motir' });
    await expect(planDoor).toBeEnabled({ timeout: 30_000 });
    await beat();

    // DISCARD FIRST — approve is the only write, so a run that is thrown away
    // must leave nothing behind. The card words this inside step 3 ("a
    // generate-then-discard run persisted NO sprints"), and it lives here rather
    // than in a sibling test on purpose: a sibling would pay a SECOND cold
    // `/backlog` render, which this lane cannot currently afford (see the run
    // note in the PR — the shipped `backlog.spec.ts` is 10–20× slower here than
    // on the main lane and its SSR transaction can exceed Prisma's 5s
    // interactive budget). Asserting it on the render that already succeeded is
    // both cheaper and a truer narration: the reviewer sees that nothing is
    // created until they approve.
    await planDoor.click();
    await expect(proposedSprint(page, 1)).toBeVisible();
    await beat();
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(planDock(page)).toBeHidden();
    await beat();
    expect(await db.sprint.count({ where: { projectId: seed.projectId } })).toBe(0);
    expect(
      await db.workItem.count({ where: { projectId: seed.projectId, sprintId: { not: null } } }),
    ).toBe(0);

    // Now run it for real.
    await planDoor.click();

    // The proposed packing renders: two short sprints, sized to the cadence the
    // settings set, with the blocked item scheduled after its blocker.
    await expect(planDock(page)).toBeVisible();
    await expect(proposedSprint(page, 1)).toBeVisible();
    await expect(proposedSprint(page, 2)).toBeVisible();
    await expect(planDock(page)).toContainText(`${SPRINT_LENGTH_DAYS} days each`);
    await expect(proposedSprint(page, 1)).toContainText(seed.formKey);
    await expect(proposedSprint(page, 2)).toContainText(seed.apiKey);
    await beat();

    // Approve — the REAL persist (Epic-4 createSprint + bulkAssignToSprint).
    const approved = page.waitForResponse(
      (r) => r.url().includes('/api/ai/plan/sprint/approve') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /^Create \d+ sprints?$/ }).click();
    const approveRes = await approved;
    expect(approveRes.status()).toBe(200);
    const created = (await approveRes.json()) as {
      sprints: Array<{ name: string; assignedCount: number }>;
      assigned: number;
    };
    expect(created.sprints).toHaveLength(2);
    expect(created.assigned).toBe(4);

    // The sprints are real rows with the proposed members assigned…
    const sprints = await db.sprint.findMany({
      where: { projectId: seed.projectId },
      orderBy: { sequence: 'asc' },
    });
    expect(sprints).toHaveLength(2);
    const assigned = await db.workItem.findMany({
      where: { projectId: seed.projectId, sprintId: { not: null } },
      select: { identifier: true, sprintId: true },
    });
    expect(assigned.map((a) => a.identifier).sort()).toEqual(
      [seed.apiKey, seed.confirmKey, seed.formKey, seed.receiptKey].sort(),
    );
    // …and the blocked item landed in a LATER sprint than its blocker.
    const sprintIndex = new Map(sprints.map((s, i) => [s.id, i]));
    const at = (key: string) =>
      sprintIndex.get(assigned.find((a) => a.identifier === key)!.sprintId!)!;
    expect(at(seed.apiKey)).toBeGreaterThan(at(seed.formKey));

    // …and the board shows them.
    for (const sprint of created.sprints) {
      await expect(page.getByText(sprint.name, { exact: true }).first()).toBeVisible();
    }
    await beat();
  });

  // ── 3 ─────────────────────────────────────────────────────────────────────
  await chapter('Cadence fires on its own', async () => {
    await page.goto('/plans');
    expect(await plansOf(seed.projectId)).toHaveLength(0);
    await beat();

    // Drive the ready set under the threshold, then advance the cron. Nobody
    // clicks anything: the proposal has to appear on its own.
    const readyCount = await drainReadySetBelow(AUTO_PLAN_THRESHOLD, seed);
    expect(readyCount).toBeLessThan(AUTO_PLAN_THRESHOLD);
    const treeBefore = await treeTitles(seed.projectId);

    const tick = await runCadenceTick(1);
    expect(tick.summary.fired).toBe(1);
    expect(tick.origin).toBe('cadence');
    const fired = tick.summary.outcomes[0];
    expect(fired).toMatchObject({ status: 'fired', itemKey: seed.stubKey });

    // Flagged cadence-initiated, and awaiting a decision.
    const plans = await plansOf(seed.projectId);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.origin).toBe('cadence');
    expect(plans[0]!.status).toBe('planned');

    // It is a PROPOSAL: the proposed items exist only as PlanItem rows, and the
    // work-item tree is byte-identical to before the tick.
    const proposedItems = await db.planItem.findMany({ where: { planId: plans[0]!.id } });
    expect(proposedItems).toHaveLength(proposedChildTitles(1).length);
    for (const item of proposedItems) expect(item.workItemId).toBeNull();
    expect(await treeTitles(seed.projectId)).toEqual(treeBefore);

    // And it is on the review surface, without a click having produced it.
    await page.reload();
    await expect(page.getByText(`Expand ${seed.stubKey}`).first()).toBeVisible();
    await beat();
  });

  // ── 4 ─────────────────────────────────────────────────────────────────────
  await chapter('Auto-plan pauses for review', async () => {
    await openAiPlanningSettings(page);

    const banner = pausedBanner(page);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Auto-plan is paused');
    // The link is the point — it makes the silence actionable.
    const planId = (await plansOf(seed.projectId))[0]!.id;
    await expectPausedLinkOpens(page, planId);
    await beat();

    // The gate holds: a further tick creates nothing.
    const secondTick = await runCadenceTick(2);
    expect(secondTick.summary.fired).toBe(0);
    expect(secondTick.summary.outcomes[0]).toMatchObject({
      status: 'skipped',
      reason: 'pending_proposal',
    });
    expect(await plansOf(seed.projectId)).toHaveLength(1);
  });

  // ── 5 ─────────────────────────────────────────────────────────────────────
  await chapter('Decide, and cadence resumes', async () => {
    const planId = (await plansOf(seed.projectId))[0]!.id;
    // Still `planned`, so it is decided where it is decided — the planning
    // overlay's footer (Story MOTIR-7883 · MOTIR-7887).
    const overlay = await openUndecidedPlan(page, planId);
    await beat();

    const declined = page.waitForResponse(
      (r) => r.url().includes(`/api/plans/${planId}/decline`) && r.request().method() === 'POST',
    );
    await overlay
      .getByTestId('plan-change-confirm-bar')
      .getByRole('button', { name: 'Decline', exact: true })
      .click();
    // An ASKED plan's Decline confirms once, with an OPTIONAL reason (MOTIR-6037).
    await overlay
      .getByTestId('plan-decline-confirm')
      .first()
      .getByRole('button', { name: 'Yes, decline' })
      .click();
    expect((await declined).status()).toBe(200);
    await beat();

    // Cadence resumes — the next tick drafts a FRESH proposal.
    const thirdTick = await runCadenceTick(3);
    expect(thirdTick.summary.fired).toBe(1);
    const plans = await plansOf(seed.projectId);
    expect(plans).toHaveLength(2);
    expect(plans[1]!.status).toBe('planned');

    // …and while THAT one waits, the panel reads paused again — but for the new
    // plan, so the indicator tracks the live gate rather than a stale verdict.
    await openAiPlanningSettings(page);
    await expectPausedLinkOpens(page, plans[1]!.id);
    await beat();
  });
});

test('cadence off — the tick creates nothing', async ({ page }) => {
  const seed = await seedAiCadence(`ai-cadence-off-${Date.now()}@example.com`);
  await waitForSeedJobsToSettle();
  await signIn(page, seed.email, seed.password);

  // On, drained, and firing…
  await openAiPlanningSettings(page);
  await autoPlanSwitch(page).click();
  await thresholdField(page).fill(String(AUTO_PLAN_THRESHOLD));
  await saveAiSettings(page, seed.projectKey);
  await drainReadySetBelow(AUTO_PLAN_THRESHOLD, seed);
  expect((await runCadenceTick(1)).summary.fired).toBe(1);

  // …now switch it OFF and clear the pending proposal, so the ONLY thing left
  // that could suppress the next tick is the switch itself.
  await db.plan.updateMany({ where: { projectId: seed.projectId }, data: { status: 'declined' } });
  await page.reload();
  await autoPlanSwitch(page).click();
  await saveAiSettings(page, seed.projectKey);

  const plansBefore = await plansOf(seed.projectId);
  const tick = await runCadenceTick(2);
  // An opted-out project is not even scanned — there is nothing to skip.
  expect(tick.summary.scanned).toBe(0);
  expect(await plansOf(seed.projectId)).toHaveLength(plansBefore.length);
});

test('the pending-proposal gate is origin-independent — a user-clicked plan pauses cadence too', async ({
  page,
}) => {
  const seed = await seedAiCadence(`ai-cadence-user-${Date.now()}@example.com`);
  await waitForSeedJobsToSettle();
  await signIn(page, seed.email, seed.password);

  await openAiPlanningSettings(page);
  await autoPlanSwitch(page).click();
  await thresholdField(page).fill(String(AUTO_PLAN_THRESHOLD));
  await saveAiSettings(page, seed.projectKey);
  await drainReadySetBelow(AUTO_PLAN_THRESHOLD, seed);

  // A proposal the USER started — no cron involved.
  const userPlanId = await seedUserClickedProposal(seed, 1);
  expect((await db.plan.findUniqueOrThrow({ where: { id: userPlanId } })).origin).toBe('user');

  // The tick is suppressed identically…
  const tick = await runCadenceTick(1);
  expect(tick.summary.fired).toBe(0);
  expect(tick.summary.outcomes[0]).toMatchObject({
    status: 'skipped',
    reason: 'pending_proposal',
  });
  expect(await plansOf(seed.projectId)).toHaveLength(1);

  // …and the panel reads paused, pointing at the user's own plan.
  await openAiPlanningSettings(page);
  await expect(pausedBanner(page)).toBeVisible();
  await expectPausedLinkOpens(page, userPlanId);
});
