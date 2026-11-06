import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanShapes, PLANS_SHAPES_PASSWORD } from './_helpers/plans-shapes-seed';
import { test, expect } from './_helpers/promoted-regression';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import { plansService } from '@/lib/services/plansService';
import type { Locator, Page } from '@playwright/test';

// ACCEPTANCE — the plan DETAIL, refined (Story MOTIR-4016 · Subtask MOTIR-4026).
// The story's `verification_recipe`, walked end to end and recorded as the
// receipt a person watches to accept it.
//
// ⚠️ IT SITS BESIDE `acceptance-plan-shapes.spec.ts`, and does not extend it.
// That spec is MOTIR-3232's proof of three plan SHAPES — where the canvas
// arrives, what Show changes marks, which body opens — and every assertion in it
// is still true and still wanted. This one is about what those surfaces SAY: the
// title a rename proposes, the room the pane takes, the state it arrives in, the
// words its search box uses, the door a list row is, and where the decision sits.
// Two clips, one per card, and the story is not accepted until both are on it.
//
// ── What "authoritative" means here ─────────────────────────────────────────
//
// Every assertion reads an accessible name, a `data-testid` or a SHIPPED class.
// Leg 2 owns a geometry check and says so at the assertion — its fold — because
// that deliverable IS geometry and nothing else can stand in for it. (Leg 8's
// decision was the second, and is retired below with the rail it measured.) Nothing else in this file reads a pixel, and nothing
// anywhere reads a computed opacity, which is a token the style axis may move.

test.describe.configure({ timeout: 900_000 });

/** The default walk. Wide enough for a level to lay out without stacking. */
const VIEWPORT = { width: 1440, height: 900 };
/** The floor this story is measured against — the tightest real laptop. */
const NARROW = { width: 1366, height: 768 };

const pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on('pageerror', (error) => pageErrors.push(`${error.message}\n${error.stack ?? ''}`));
});

test.afterEach(() => {
  expect(pageErrors, `uncaught client errors:\n${pageErrors.join('\n---\n')}`).toEqual([]);
});

test.beforeAll(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Locators ─────────────────────────────────────────────────────────────────
//
// Each takes a SCOPE (re-pointed by Story MOTIR-7883, 2026-10-08): an undecided
// plan is read in the planning overlay, so the legs that read one pass the
// overlay `openUndecidedPlan` returns; leg 2 reads a DECIDED plan's own page.
type Scope = Page | Locator;

const nodeBox = (scope: Scope, nodeId: string) =>
  scope.locator(`[data-node-id="${nodeId}"] > div`).first();
const showChanges = (scope: Scope) => scope.getByTestId('show-changes-toggle');
const locateButton = (scope: Scope) => scope.getByTestId('locate-button');
const proposalList = (scope: Scope) => scope.getByTestId('plan-proposal-list');
const searchBox = (scope: Scope) => scope.getByRole('searchbox');

test('the plan detail, refined — the story’s verification recipe', async ({
  page,
  chapter,
  acceptanceStory,
}) => {
  // WHICH STORY THIS CLIP BELONGS TO. Without it the recording can never be
  // published to the story, and `e2e-acceptance-lane-membership.test.ts` fails
  // the unit lane rather than letting a receipt go nowhere. It is a FIXTURE, not
  // a module import — the uploader reads the fixture, not the prose.
  acceptanceStory('MOTIR-4016');
  const seed = await seedPlanShapes('acceptance-plan-detail-refined@example.com');
  await page.setViewportSize(VIEWPORT);
  await signIn(page, seed.email, PLANS_SHAPES_PASSWORD);

  // ── LEG 1 · recipe step 1 — the PROPOSED title, in both bodies ─────────────
  await chapter('A plan that renames a card shows the name it is ASKING for', async () => {
    // An undecided plan is read in the planning overlay (Story MOTIR-7883).
    const canvasView = await openUndecidedPlan(page, seed.two.planId);

    // The canvas node's headline is the PROPOSED title, not the one the card is
    // about to stop being called. The node is a SIGNAL; the list SPELLS the
    // change, and both are asserted because the defect was that they disagreed.
    const modified = nodeBox(canvasView, seed.two.modified.id);
    await expect(modified).toContainText('Invoice templates + branding');

    const listView = await openUndecidedPlan(page, seed.two.planId, { view: 'list' });
    const row = proposalList(listView).getByRole('button', {
      name: `Open ${seed.two.modified.identifier} · Invoice templates + branding`,
    });
    await expect(row).toBeVisible();
    // …and the TITLE change line still spells old → new: the outgoing name
    // survives, on the one surface whose job it is.
    await expect(proposalList(listView)).toContainText('Invoice templates');
  });

  // ── LEG 2 · recipe step 2 — the pane FILLS THE FOLD ────────────────────────
  await chapter(
    'The pane reaches the bottom of the window, at 1440×900 and at 1366×768',
    async () => {
      // ⚠️ A DECIDED PLAN, and shape FIVE rather than two (re-pointed by Story
      // MOTIR-7883, 2026-10-08). The fold is the plan PAGE's geometry, and an
      // undecided plan's page now redirects into the overlay; a decided plan keeps
      // its page. Shape five is one container like shape two, so it arrives on the
      // canvas too — and declining it leaves shape two undecided for the legs below.
      const owner = await adminDb.user.findUniqueOrThrow({ where: { email: seed.email } });
      await plansService.declinePlan(seed.five.planId, {
        userId: owner.id,
        workspaceId: seed.workspaceId,
      });
      for (const viewport of [VIEWPORT, NARROW]) {
        await page.setViewportSize(viewport);
        await page.goto(`/plans/${seed.five.planId}`); // decided: the plan page renders
        await expect(nodeBox(page.getByRole('main'), seed.five.modified.id)).toBeVisible();

        // ⚠️ THIS FILE'S GEOMETRY CHECK, and it is here because the
        // deliverable IS geometry. The pane's bottom edge sits within the shell's
        // own clearance of the window bottom — no dead band — and the page does not
        // scroll. The shipped shape left 91–99px of empty page under the graph.
        const fold = await page.evaluate(() => {
          const box = document.querySelector('main div.overflow-hidden') as HTMLElement | null;
          const rect = box?.getBoundingClientRect();
          return {
            gap: rect ? Math.round(window.innerHeight - rect.bottom) : null,
            scrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
          };
        });
        expect(fold.scrolls, `the page scrolls at ${viewport.width}x${viewport.height}`).toBe(
          false,
        );
        // `--shell-bottom-clearance` is 6rem with the orb mounted and 1.5rem
        // without, so the band the pane may leave is at most the orb's.
        expect(fold.gap, `dead band at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(
          96,
        );
      }
      await page.setViewportSize(VIEWPORT);
    },
  );

  // ── LEG 3 · recipe step 3 — the changes are LIT ON ARRIVAL ─────────────────
  await chapter('The plan’s changes are already marked when the reader lands', async () => {
    const overlay = await openUndecidedPlan(page, seed.two.planId);
    await expect(nodeBox(overlay, seed.two.modified.id)).toBeVisible();

    // ARMED, with no interaction: this is the whole deliverable.
    await expect(showChanges(overlay)).toHaveAttribute('aria-pressed', 'true');
    for (const id of [...seed.two.addedNodeIds, seed.two.modified.id]) {
      await expect(nodeBox(overlay, id)).toHaveAttribute('data-emphasised', 'true');
    }
    // …and the COMPLEMENT, which is what makes the first assertion mean
    // something. On the shipped class, never a computed opacity.
    for (const untouched of seed.two.untouched) {
      await expect(nodeBox(overlay, untouched.id)).toHaveClass(/opacity-35/);
    }

    // The pressed control has a real, non-transparent fill — the defect was a
    // token that did not exist, so the control rendered with no background at
    // all while every other signal was green.
    const fill = await showChanges(overlay).evaluate(
      (el) => getComputedStyle(el as HTMLElement).backgroundColor,
    );
    expect(fill, 'the pressed control has no background').not.toBe('rgba(0, 0, 0, 0)');
    expect(fill).not.toBe('transparent');

    // A reader who did not arm it can still turn it off.
    await showChanges(overlay).click();
    await expect(showChanges(overlay)).toHaveAttribute('aria-pressed', 'false');
    for (const untouched of seed.two.untouched) {
      await expect(nodeBox(overlay, untouched.id)).not.toHaveClass(/opacity-35/);
    }
  });

  await chapter('A level that is entirely the plan’s arrives unlit, and says why', async () => {
    // Shape ONE hangs three subtasks off a PROPOSED story, and the canvas ARRIVES
    // on the level the plan most fills (Part IX §1) — which for this shape is the
    // proposed story's own children. That level has no committed neighbourhood at
    // all, so ringing every card would say nothing: it is the mirror of the level
    // the plan does not reach, and it takes the same disposition for the opposite
    // reason (Part XIII §3d, reversing Part IX §L6).
    //
    // ⚠️ THE CANVAS VIEW IS LOAD-BEARING, and it is a fact about this shape rather
    // than a convenience: shape ONE straddles two containers (the epic holds the
    // story, the story holds the subtasks), so the derived default correctly
    // opens it as a LIST — Part IX §3's arm, unchanged by this story. The
    // emphasis lives on the canvas, so the walk asks for it.
    const overlay = await openUndecidedPlan(page, seed.one.planId, { view: 'canvas' });
    await expect(
      overlay.getByTestId('roadmap-canvas').getByText(seed.one.subtaskTitles[0]!),
    ).toBeVisible();

    await expect(showChanges(overlay)).toBeDisabled();
    await expect(showChanges(overlay)).toHaveAttribute(
      'title',
      "Every item on this level is this plan's",
    );
    // The LOCATE control stays enabled: ringing everything says nothing, walking
    // everything says something. The two fail on opposite degeneracies.
    await expect(locateButton(overlay)).toBeEnabled();
  });

  // ── LEG 4 · recipe step 4 — the search box’s own words ─────────────────────
  await chapter(
    'The search box on a plan says “Search this plan”, and the roadmap keeps its own',
    async () => {
      const overlay = await openUndecidedPlan(page, seed.two.planId);
      await expect(searchBox(overlay)).toHaveAttribute('aria-label', 'Search this plan');
      await expect(searchBox(overlay)).toHaveAttribute('placeholder', 'Search this plan');

      // BOTH surfaces. "The roadmap keeps its sentence" is the half a sweep of this
      // shape is most likely to break.
      await page.goto('/roadmap');
      await expect(searchBox(page)).toHaveAttribute('aria-label', 'Search the roadmap');
    },
  );

  // ── LEG 5 · recipe step 5 — the LOCATE walk ───────────────────────────────
  await chapter('The locate control walks the plan’s own cards, and wraps', async () => {
    const overlay = await openUndecidedPlan(page, seed.two.planId);
    await expect(nodeBox(overlay, seed.two.modified.id)).toBeVisible();
    const hint = overlay.getByTestId('locate-hint');

    await expect(locateButton(overlay)).toBeEnabled();
    await locateButton(overlay).click();
    await expect(hint).toHaveText('1 / 3');
    await locateButton(overlay).click();
    await expect(hint).toHaveText('2 / 3');
    await locateButton(overlay).click();
    await expect(hint).toHaveText('3 / 3');
    // Past the last it wraps rather than stopping.
    await locateButton(overlay).click();
    await expect(hint).toHaveText('1 / 3');
  });

  // ── LEG 6 · recipe step 6 — a LIST ROW opens its proposal ──────────────────
  await chapter('A list row opens the same read view the canvas’s View pill opens', async () => {
    const overlay = await openUndecidedPlan(page, seed.two.planId, { view: 'list' });
    const row = proposalList(overlay).getByRole('button', { name: /^Open New · Usage metering/ });
    await expect(row).toBeVisible();

    // THE POINTER PATH.
    await row.click();
    // `proposal-peek`, not `proposal-quick-view`: MOTIR-4185 replaced the second
    // surface with ONE peek that both doors open, and this row is the LIST door.
    const peek = page.getByTestId('proposal-peek');
    await expect(peek).toBeVisible();
    // ONE close affordance. The shipped modal rendered two, 40px apart, with the
    // identical accessible name. The PEEK's dialog, not every dialog: the planning
    // overlay it opens over is a dialog with its own close (Story MOTIR-7883).
    await expect(
      page.getByRole('dialog').filter({ has: peek }).getByRole('button', { name: /close/i }),
    ).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(peek).toBeHidden();

    // THE KEYBOARD PATH, driven as a keyboard user drives it — the row is REACHED
    // with focus, opened with Enter, and closed with Escape, and focus comes back
    // to the row it left. (Opening by MOUSE and asserting focus return is a
    // different claim and not the one the a11y contract makes: the dialog returns
    // focus to whatever had it, which after a click is the pointer's business.)
    await row.focus();
    await expect(row).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('proposal-peek')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('proposal-peek')).toBeHidden();
    await expect(row).toBeFocused();
  });

  // ── LEG 7 · recipe step 7 — the LIST opens when the canvas cannot hold them ─
  await chapter('A plan buried in a crowded container opens as a LIST', async () => {
    // ONE container, so the shipped container-count rule says canvas; thirty-six
    // nodes, so the level cannot arrive legibly and the widened rule says list.
    // Indistinguishable from shape TWO to a reader who only counts containers.
    const overlay = await openUndecidedPlan(page, seed.four.planId);
    await expect(proposalList(overlay)).toBeVisible();
    // The URL stays CLEAN whatever the default resolves to — the overlay keeps its
    // view local and writes no `view` into the address underneath it.
    expect(new URL(page.url()).searchParams.get('view')).toBeNull();

    // The switcher still flips to the canvas and back.
    const switcher = overlay.getByRole('group', { name: 'Plan view' });
    await switcher.getByRole('button', { name: 'Canvas', exact: true }).click();
    await expect(overlay.getByTestId('roadmap-canvas')).toBeVisible();
    await switcher.getByRole('button', { name: 'List', exact: true }).click();
    await expect(proposalList(overlay)).toBeVisible();
  });

  // ── LEG 8 · recipe step 8 — the rail LANDS ON ITS DECISION ─────────────────
  // ⚠️ RETIRED 2026-10-08 by Story MOTIR-7883 (MOTIR-7887): this leg measured the
  // plan page's REVIEW RAIL holding Approve / Decline inside the fold on a long
  // undecided plan. A member's `/plans/<id>` for an undecided plan now lands in the
  // planning overlay, which decides in its own footer, and a decided plan's rail
  // carries an outcome rather than a decision — so the rail this leg measured is no
  // longer reachable. Its structure (the transcript scrolls, the footer does not,
  // Approve and Decline sit in the footer) is still covered by
  // `tests/components/plan-review-rail-fold.test.tsx`; the GEOMETRY is covered by
  // nothing now.
});
