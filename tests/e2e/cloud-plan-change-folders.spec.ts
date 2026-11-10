// FOLDERS ON THE PLAN-CHANGE OVERLAY — the assembled journey (Bug MOTIR-5782 ·
// MOTIR-5796; design `design/ai-planning/design-notes.md` Part XVIII). The code is
// MOTIR-5794's (`PlanChangeCanvas`), and its component tests prove the logic; this
// spec walks it in a real browser against a real server:
//
//   • the overlay canvas is MOUNTED — asserted first, so the spec cannot pass
//     vacuously on a lane that never renders it (the overlay is cloud-gated, which
//     is why this is a `cloud-*.spec.ts` under `playwright.cloud.config.ts`);
//   • THE ROOT (decision 1): folder cards, no filed committed item loose, the
//     unfiled proposal drawn, and "Archive" BADGED as holding a change (decision 3);
//   • A FOLDER (decision 2): its child folder, its filed items, and the proposal
//     filed into it — drawn there, not at the root;
//   • the folder crumb navigates back to the root (decision 5).
//
// WHAT IS STUBBED, and why only this. motir-ai has no presence in CI, so the
// browser→ai hop is stubbed via `page.route`, exactly as
// `cloud-plan-change-conversation.spec.ts` does: the ask door (which would call
// motir-ai; the TURN underneath is still appended for real) and the job's SSE.
// The PLAN the rail reads is real — seeded through the shipped
// `createPlan → addProposals → markPlanned` calls (`seedFolderPlan`), so the
// canvas decorates `planReviewService` reading Postgres. No planner turn: a
// folder-filed proposal is a plan fact, not a planner output.
//
// Every step waits on the level's roadmap GET (`folderId=`) or the rendered DOM,
// never a fixed sleep; every locator is scoped to the overlay's canvas.

import { expect, test, type Locator, type Page } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { persistAskTurn } from './_helpers/plan-session-turn';
import { markProjectOnboarded } from './_helpers/ai-augment-replan-seed';
import { seedFolderPlan, seedFolderRoadmap } from './_helpers/roadmap-seed';
import { jobStreamBody } from './_helpers/job-stream-frames';

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const JOB_ID = 'job_e2e_plan_change_folders';

// ── Stubs for the browser→motir-ai boundary (as cloud-plan-change-conversation) ─

async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', async (route) => {
    await route.fulfill({
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
    });
  });
}

/** The ask door answers `redirected` with the seeded plan; the turn itself is
 *  appended for real, so the thread the rail reads back is the persisted one. */
async function stubAsk(page: Page, planId: string): Promise<void> {
  await page.route('**/api/ai/ask', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    // Through the real session doors — the held session, or a first turn that
    // starts one (MOTIR-6023).
    const appended = await persistAskTurn(route);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        outcome: 'redirected',
        jobId: JOB_ID,
        planId,
        session: await appended.json(),
      }),
    });
  });
  await page.route(`**/api/ai/augment/${JOB_ID}/stream`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      // motir-ai's wire: each progress frame in its `{ jobId, seq, data }` envelope.
      body: jobStreamBody(JOB_ID, [
        ['search', {}],
        ['planned', { proposed: 2 }],
        ['done', {}],
      ]),
    });
  });
}

// The overlay is a modal dialog, so `main` leaves the accessibility tree while it
// is open — the DIALOG is the live subtree every locator is scoped to.
const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const canvasOf = (page: Page) => workspace(page).getByTestId('roadmap-canvas');
const folderCard = (canvas: Locator, folderId: string) =>
  canvas.locator(`[data-node-id="folder:${folderId}"]`);
const crumbs = (canvas: Locator) => canvas.getByRole('navigation', { name: 'Breadcrumb' });

const folderLoad = (page: Page, folderId: string) =>
  page.waitForResponse(
    (r) =>
      r.url().includes('/roadmap') &&
      r.url().includes(`folderId=${folderId}`) &&
      r.request().method() === 'GET' &&
      r.ok(),
  );

test('the plan-change overlay draws folders: the root, a folder, the filed proposal, and its crumb', async ({
  page,
}) => {
  const seed = await seedFolderRoadmap('plan-change-folders@example.com');
  await markProjectOnboarded(seed.projectId);
  const plan = await seedFolderPlan(seed, JOB_ID);

  await stubAiAccess(page);
  await stubAsk(page, plan.planId);
  await signIn(page, seed.email, seed.password);

  // ── 1. The overlay canvas is MOUNTED ────────────────────────────────────────
  await page.goto('/roadmap?plan=replan&planFrom=project');
  const canvas = canvasOf(page);
  // The first landmark after landing carries the first-paint budget (MOTIR-2506).
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  const archive = folderCard(canvas, seed.archiveId);
  await expect(archive).toBeVisible();

  // Send a turn; the stubbed run settles on the seeded plan. The door's 200 is
  // the "the thread advanced" signal, the confirm bar the "the plan settled" one.
  const asked = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/ask' && r.request().method() === 'POST',
  );
  await workspace(page)
    .getByRole('textbox', { name: /Reply, or refine/ })
    .fill('File the importer work into Archive.');
  await workspace(page).getByRole('button', { name: 'Send' }).click();
  expect((await asked).status()).toBe(200);
  await expect(workspace(page).getByTestId('plan-change-confirm-bar')).toContainText('2 added');

  // ── 1b. THE PANE SWAPPED, AND THE CANVAS ARRIVED ON THE FOLDER ──────────────
  // Two changes land on this one step, and they AGREE — which is why the step
  // reads the same after both.
  //
  //  • THE FOLLOW-MOVE (MOTIR-6154/6161). This surface opened from the PROJECT
  //    with no target, so it began at the root — and the moment the plan settled
  //    it moved inside the level the plan fills, which for a plan that files work
  //    into Archive is the Archive FOLDER.
  //  • THE PANE SWAP (MOTIR-6155). A proposed plan is read through the plan
  //    page's own List | Canvas component, and that component's `arrivalLevel`
  //    asks `fullestContainer` the same question the follow-move asks. It is
  //    folder-aware, and both proposals here are parentless, so the tie breaks on
  //    DEPTH and Archive wins over the root — the same folder, by the same rule.
  //
  // So the canvas is no longer where step 1 left it, and the root assertions
  // below are reached the way a person reaches them: through the crumb. That the
  // reviewer LANDS where the filed work is, without drilling for it, is the
  // behaviour this file most wants pinned.
  await expect(workspace(page).getByTestId('plan-proposal-views')).toBeVisible();
  await expect(crumbs(canvas).getByRole('button', { name: 'Folder: Archive' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(canvas.getByText(plan.filedTitle, { exact: true })).toBeVisible();

  // The ROOT read carries neither key — `folderLoad` above is the folder form.
  const backToRoot = page.waitForResponse(
    (r) =>
      r.url().includes('/roadmap') &&
      !r.url().includes('parentId=') &&
      !r.url().includes('folderId=') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );
  await crumbs(canvas).getByRole('button', { name: 'Roadmap' }).click();
  await backToRoot;

  // ── 2. THE ROOT: folder cards, nothing filed loose, the badge (decisions 1–3) ─
  // Reached by the ROOT CRUMB above, because the arrival is one level in.
  await expect(archive.getByTestId('folder-changes')).toHaveText('1 change');
  await expect(folderCard(canvas, seed.laterId)).toBeVisible();
  await expect(folderCard(canvas, seed.laterId).getByTestId('folder-changes')).toHaveCount(0);
  await expect(canvas.getByText(plan.rootTitle, { exact: true })).toBeVisible();
  for (const title of [...seed.archivedTitles, seed.deepBugTitle, plan.filedTitle]) {
    await expect(canvas.getByText(title, { exact: true })).toHaveCount(0);
  }

  // ── 3. DRILL THE FOLDER: its child folder, its items, the filed proposal ─────
  // ⚠️ THE WAIT IS BACK, AND MOTIR-6155 IS WHY. This step carried a note saying a
  // `folderLoad` wait here would hang for the full test budget, because the
  // follow-move had already read this level and `PlanChangeCanvas` serves a level
  // it has read from `cacheRef`. That was true of `PlanChangeCanvas` and is not
  // true of the pane any more: a PROPOSED plan is drawn by `PlanReviewCanvas`,
  // which keeps NO level cache — its `loadLevel` goes through `fetchRoadmapLevel`
  // every time, deliberately, so a drilled level can never be served stale. So the
  // GET does go out, and the repo's rule for a lazy-load applies again: await the
  // fetch rather than letting the DOM assertions race it.
  const archiveLevel = folderLoad(page, seed.archiveId);
  await archive.click();
  await canvas.getByTestId('drill-button').click();
  await archiveLevel;
  await expect(folderCard(canvas, seed.importsId)).toBeVisible();
  for (const title of seed.archivedTitles) {
    await expect(canvas.getByText(title, { exact: true })).toBeVisible();
  }
  await expect(canvas.getByText(plan.filedTitle, { exact: true })).toBeVisible();
  await expect(canvas.getByText(plan.rootTitle, { exact: true })).toHaveCount(0);

  // ── 4. ONE DEEPER; the FOLDER CRUMB navigates back, then the root (decision 5) ─
  const deeper = folderLoad(page, seed.importsId);
  await folderCard(canvas, seed.importsId).click();
  await canvas.getByTestId('drill-button').click();
  await deeper;
  await expect(canvas.getByText(seed.deepBugTitle, { exact: true })).toBeVisible();
  // The two crumb re-visits below each issue their own GET too (same reason: no
  // level cache behind a proposed plan). They keep the DOM as their signal rather
  // than arming a wait, because each pair asserts the arriving level's own node
  // visible BEFORE asserting the leaving level's node gone — so the assertion is
  // the wait, and a `folderLoad` in front of it buys nothing.
  await crumbs(canvas).getByRole('button', { name: 'Folder: Archive' }).click();
  await expect(canvas.getByText(plan.filedTitle, { exact: true })).toBeVisible();
  await expect(canvas.getByText(seed.deepBugTitle, { exact: true })).toHaveCount(0);
  await crumbs(canvas).getByRole('button', { name: 'Roadmap' }).click();
  await expect(canvas.getByText(plan.rootTitle, { exact: true })).toBeVisible();
  await expect(canvas.getByText(plan.filedTitle, { exact: true })).toHaveCount(0);
  await expect(archive.getByTestId('folder-changes')).toHaveText('1 change');
});
