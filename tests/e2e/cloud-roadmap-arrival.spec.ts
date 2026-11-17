// ACCEPTANCE — the roadmap you come back to (Story MOTIR-3833 · Subtask
// MOTIR-3841). The story's `verification_recipe`, driven the way a person drives
// it, and recorded as the receipt Yue watches to accept the story.
//
// ⚠️ WHY THE WALK IS THE ONLY INSTRUMENT THAT CAN SEE THIS STORY. Three of its
// four refinements are invisible to every check that does not open a browser: a
// reload that lands on the wrong level, a canvas that stops an inch short of the
// window, and a legend that forgets it was dismissed all type-check, all build,
// and all pass component tests rendered into happy-dom — which has no viewport,
// no history stack and no layout at all. The claims under test are about a real
// page being driven, so this is a real page being driven.
//
// ⚠️ AND WHAT THE CLIP HAS TO SHOW. The product change is that the roadmap
// REMEMBERS — so the reviewer has to see the reload land back inside the story,
// not be told that it did. The reload and the Back chapters therefore get their
// own beats, with the breadcrumb on screen, before anything moves again. A
// recording that races from "drilled" to "reloaded" satisfies every acceptance
// criterion and shows none of the story.
//
// AUTHORITATIVE SIGNALS ONLY — no fixed-duration sleep is used for
// synchronisation anywhere in this file. Every level change is a roadmap GET and
// every step awaits the response of the level it lands ON, or a rendered
// assertion. The `chapter()` / `beat()` holds are the harness's VIDEO PACING,
// taken only AFTER an assertion above them has already proven the state (see
// CHAPTER_HOLD_MS in `_helpers/acceptance-video.ts`) — never synchronisation.

import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedWideRoadmap, type WideRoadmapSeed } from './_helpers/roadmap-seed';

test.describe.configure({ timeout: 240_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const roadmapNav = (page: Page) =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Roadmap' });
const breadcrumb = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });
const scopeToggle = (page: Page) => page.getByRole('group', { name: 'Roadmap scope' });
// ── MOTIR-5116: the canvas hooks, addressed by ROLE where there is one and
// SCOPED to the live route subtree where there is not. A page-rooted read of any
// of these resolves React's streamed `<div hidden id="S:0">` copy and the
// outgoing subtree a client-side navigation leaves mounted (`CLAUDE.md` § *a
// boundary makes every unscoped locator a race*); a role, or a scope that is
// itself a role, is what excludes both.
/** `ProjectRoadmapCanvas`'s outer wrapper. A bare `<div>` around the
 *  `role="application"` viewport, and the box the geometry assertions measure —
 *  so it keeps its id and takes `main` as its scope. `main` IS in the
 *  accessibility tree on this route: `/roadmap` is a page, not an overlay. */
const canvasFrame = (page: Page) => page.getByRole('main').getByTestId('roadmap-canvas');
/** The `PlanningCanvas` viewport. It DOES carry `role="application"`, but NOT a
 *  fixed name: `ProjectRoadmapCanvas` renders `ariaLabel ?? t('ariaDefault')`,
 *  and the roadmap route passes its own — the failure artifact's ARIA snapshot
 *  reads `application "Wide Roadmap roadmap"`, i.e. the SEED's project name.
 *  `'Project roadmap'` is the fallback this route never reaches, so addressing
 *  it by that name matched nothing and took the `billing-cloud` leg red. Binding
 *  the locator to the seed's project name instead would just move the coupling,
 *  so the id stays and takes the canvas frame as its scope. */
const canvasApp = (page: Page) => canvasFrame(page).getByTestId('planning-canvas');
/** The dependency legend panel, and its collapse control. The control is a real
 *  `<button>`, but its accessible name FLIPS with the state these assertions are
 *  measuring ('Hide…' / 'Show…'), so addressing it by name would make the
 *  locator track the very thing under test. It keeps its id, scoped to the panel. */
const edgeLegend = (page: Page) => canvasFrame(page).getByTestId('edge-legend');
const edgeLegendToggle = (page: Page) => edgeLegend(page).getByTestId('edge-legend-toggle');

const isRoadmapGet = (url: string) => url.includes('/api/projects/') && url.includes('/roadmap');
const levelLoad = (page: Page, pred: (url: string) => boolean) =>
  page.waitForResponse(
    (r) => isRoadmapGet(r.url()) && pred(r.url()) && r.request().method() === 'GET' && r.ok(),
  );
const rootLoad = (page: Page) => levelLoad(page, (u) => !u.includes('parentId'));
const drillLoad = (page: Page) => levelLoad(page, (u) => u.includes('parentId'));

/** Pin the active WORKSPACE too — a `getWorkspaceContext`-gated request resolves
 *  from this cookie, not from the active project. */
async function pinWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page
    .context()
    .addCookies([{ name: 'workspace_id', value: workspaceId, domain: 'localhost', path: '/' }]);
}

/** Drill into a node by its title: select it, then press its "Open" affordance —
 *  the same two-step the shipped canvas requires (a click SELECTS, it does not
 *  drill). */
async function drillInto(page: Page, title: string): Promise<void> {
  await page.getByText(title, { exact: true }).first().click();
  const loaded = drillLoad(page);
  // BY ROLE — the drill affordance is a `<button>` with a stable `aria-label`.
  await page.getByRole('button', { name: "Open this item's children" }).click();
  await loaded;
}

/** The canvas's world transform, read off the shipped `canvas-world` element —
 *  the scale the level actually ARRIVED at, not one recomputed by the test. */
async function arrivalScale(page: Page): Promise<number> {
  const t = await canvasFrame(page)
    .getByTestId('canvas-world')
    .evaluate((el) => getComputedStyle(el).transform);
  // `matrix(a, b, c, d, tx, ty)` — a uniform scale, so `a` is it.
  const m = /matrix\(([-\d.]+)/.exec(t);
  if (!m) throw new Error(`canvas world has no matrix transform: ${t}`);
  return Number(m[1]);
}

/** The design's measured legibility FLOOR (`design/roadmap/design-notes.md` §2,
 *  and `ARRIVAL_MIN_SCALE` in `lib/planning/canvasGeometry.ts`). Duplicated as a
 *  literal ON PURPOSE: importing the constant would let a change to it silently
 *  redefine what this acceptance walk claims. */
const ARRIVAL_FLOOR = 0.8;

test('the roadmap remembers the level, fills the fold, and arrives readable', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-3833');

  const seed: WideRoadmapSeed = await seedWideRoadmap('roadmap-arrival@example.com');
  await signIn(page, seed.email, seed.password);
  await pinWorkspace(page, seed.workspaceId);
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── 1. Arrive ────────────────────────────────────────────────────────────
  await chapter('Open the roadmap', async () => {
    const nav = roadmapNav(page);
    await expect(nav).toBeVisible();
    const loaded = rootLoad(page);
    await nav.click();
    await page.waitForURL('**/roadmap');
    await loaded;
    await expect(canvasApp(page)).toBeVisible();
    await expect(page.getByText(seed.frontierEpicTitle, { exact: true }).first()).toBeVisible();
    // The canonical root URL carries no `item` param at all.
    expect(new URL(page.url()).searchParams.get('item')).toBeNull();
  });

  // ── 2. The root arrives READABLE ─────────────────────────────────────────
  await chapter('A big level arrives at a scale you can read', async () => {
    // Six full rows of the loose band cannot be fitted legibly, so the arrival is
    // the FLOOR — not the whole-level fit, which would be roughly 0.58. Polled for the
    // same reason as the drilled level below: the fit is a ResizeObserver
    // callback, not part of the level response.
    await expect.poll(() => arrivalScale(page)).toBeCloseTo(ARRIVAL_FLOOR, 2);
    // …and the frontier card — the work that is happening — is what you land on.
    // The level overflows the canvas on BOTH axes at the floor (the seed fills
    // `WIDE_ROADMAP_ROWS` full rows of the 5-column band), and the arrival
    // centres the frontier on every axis that overflows — so it is centred on
    // both. On an axis that FITS it would centre the level's bounds instead
    // (`arrivalView`, design-notes §2); the fixture is sized so neither fits.
    const here = page.locator('[data-node-state="here"]').first();
    await expect(here).toBeVisible();
    const frame = await canvasFrame(page).boundingBox();
    const card = await here.boundingBox();
    expect(frame && card).toBeTruthy();
    const cardCentreX = card!.x + card!.width / 2;
    const frameCentreX = frame!.x + frame!.width / 2;
    expect(Math.abs(cardCentreX - frameCentreX)).toBeLessThan(40);
    const cardCentreY = card!.y + card!.height / 2;
    const frameCentreY = frame!.y + frame!.height / 2;
    expect(Math.abs(cardCentreY - frameCentreY)).toBeLessThan(40);
    await beat();
  });

  // ── 3. Drill, and watch the address bar ──────────────────────────────────
  await chapter('Drill in — the address bar follows', async () => {
    await drillInto(page, seed.drillEpicTitle);
    await expect(page.getByText(seed.drillChildTitle, { exact: true }).first()).toBeVisible();
    await expect(breadcrumb(page)).toContainText(seed.drillEpicTitle);
    await page.waitForURL(`**/roadmap?item=${seed.drillEpicIdentifier}`);
    // A SMALL level is still fitted WHOLE — the change is a floor, not a fixed
    // zoom. One child fits far above it (`fitView` clamps at MAX_SCALE).
    //
    // ⚠️ POLLED, and that is not a courtesy: the engine REMOUNTS per level and
    // fits ONCE, from a ResizeObserver callback — so the level response landing
    // is not the fit landing, and reading the transform straight after it
    // returns the PREVIOUS level's scale. The first run of this spec read 0.8
    // here, which is the root's arrival, not this level's.
    await expect.poll(() => arrivalScale(page)).toBeGreaterThan(ARRIVAL_FLOOR);
    await beat();
  });

  // ── 4. Reload lands you INSIDE the level ─────────────────────────────────
  await chapter('Reload — you land back inside the level', async () => {
    const loaded = drillLoad(page);
    await page.reload();
    await loaded;
    await expect(page.getByText(seed.drillChildTitle, { exact: true }).first()).toBeVisible();
    await expect(breadcrumb(page)).toContainText(seed.drillEpicTitle);
    // NOT the project root: the sibling epics are not on this level.
    // SCOPED TO THE CANVAS: the claim is about what this LEVEL draws, and a
    // sibling epic's title is canvas node text with no role of its own.
    await expect(canvasFrame(page).getByText(seed.frontierEpicTitle, { exact: true })).toHaveCount(
      0,
    );
    await beat();
  });

  await chapter('The link works in a fresh tab', async () => {
    // The shared-link case: a context that has never seen this canvas.
    const fresh = await page.context().newPage();
    const loaded = drillLoad(fresh);
    await fresh.goto(`/roadmap?item=${seed.drillEpicIdentifier}`);
    await loaded;
    await expect(fresh.getByText(seed.drillChildTitle, { exact: true }).first()).toBeVisible();
    await expect(breadcrumb(fresh)).toContainText(seed.drillEpicTitle);
    await fresh.close();
  });

  // ── 5. Back and Forward ──────────────────────────────────────────────────
  await chapter('Back, and forward again', async () => {
    const back = rootLoad(page);
    await page.goBack();
    await back;
    // Asserted on the BREADCRUMB, not only the URL: the canvas really moved.
    await expect(breadcrumb(page)).toHaveCount(0);
    await expect(page.getByText(seed.frontierEpicTitle, { exact: true }).first()).toBeVisible();
    await beat();

    await page.goForward();
    await expect(breadcrumb(page)).toContainText(seed.drillEpicTitle);
    await expect(page.getByText(seed.drillChildTitle, { exact: true }).first()).toBeVisible();
    await beat();
  });

  // ── 6. The canvas reaches the bottom ─────────────────────────────────────
  await chapter('The canvas fills the fold', async () => {
    const viewport = page.viewportSize()!;
    const frame = (await canvasFrame(page).boundingBox())!;
    // Within the window, and hard against its bottom edge.
    expect(frame.y + frame.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(viewport.height - (frame.y + frame.height)).toBeLessThan(8);
    // The page does not scroll — the shell's one scroller stays at rest.
    const scrolls = await page.evaluate(() => {
      const main = document.querySelector('main');
      return main ? main.scrollHeight > main.clientHeight + 1 : false;
    });
    expect(scrolls).toBe(false);
    await beat();
  });

  await chapter('…and every control is inside it, clear of the orb', async () => {
    const frame = (await canvasFrame(page).boundingBox())!;
    // The floating Plan-with-AI orb, by its own stable hook (`data-depth="key"`
    // on a fixed bottom-right button, MOTIR-3522). Absent when AI planning is
    // unconfigured — in which case the shell reserves 1.5rem instead of 6rem and
    // there is nothing for a control to collide with.
    const orb = await page
      .locator('button[data-depth="key"]')
      .first()
      .boundingBox()
      .catch(() => null);
    for (const control of ['edge-legend', 'locate-button']) {
      const locator = canvasFrame(page).getByTestId(control);
      // ⚠️ COUNT first. `boundingBox()` WAITS for the element rather than
      // answering `null`, so a `if (!box) continue` on a control this level does
      // not render hangs until the test timeout — which is what the first run of
      // this spec did, for four minutes, on a level with no dependency edges.
      if ((await locator.count()) === 0) continue;
      const box = await locator.boundingBox();
      if (!box) continue;
      expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
      if (orb) {
        const overlaps =
          !(box.x + box.width < orb.x || box.x > orb.x + orb.width) &&
          !(box.y + box.height < orb.y || box.y > orb.y + orb.height);
        expect(overlaps, `${control} must not sit under the Plan-with-AI orb`).toBe(false);
      }
    }
  });

  // ── 7. Collapse the Dependencies panel, and reload ───────────────────────
  await chapter('Put the Dependencies panel away — and it stays away', async () => {
    // The seed puts a real `is_blocked_by` edge on this level precisely so the
    // legend renders here — a walk that skipped this chapter would record none of
    // the refinement it exists to show.
    const legend = edgeLegend(page);
    await expect(legend).toContainText('Dependencies');
    await edgeLegendToggle(page).click();
    await expect(edgeLegendToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(legend).toContainText('Dependencies');
    await beat();

    const loaded = drillLoad(page);
    await page.reload();
    await loaded;
    await expect(edgeLegendToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await beat();

    await edgeLegendToggle(page).click();
    await expect(edgeLegendToggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(legend).toContainText('blocks');
  });

  // ── 8. Compose with scope ────────────────────────────────────────────────
  await chapter('The scope toggle composes with the level', async () => {
    const sprintBtn = scopeToggle(page).getByRole('button', { name: 'Active sprint' });
    await sprintBtn.click();
    await expect(sprintBtn).toHaveAttribute('aria-pressed', 'true');
    const url = new URL(page.url());
    expect(url.searchParams.get('scope')).toBe('sprint');
    // The canvas remounts to the new scope's own root, so the level is dropped
    // rather than carried to a scope it may not exist in.
    expect(url.searchParams.get('item')).toBeNull();
    await beat();
  });
});

// The states the happy path skips, asserted separately and deliberately NOT
// narrated into the recording: a reviewer accepts this story by watching it work,
// not by watching the ways it can look different.
test('an ?item= that cannot resolve opens the ROOT level, with no error surface', async ({
  page,
}) => {
  const seed = await seedWideRoadmap('roadmap-arrival-fallback@example.com');
  await signIn(page, seed.email, seed.password);
  await pinWorkspace(page, seed.workspaceId);

  const loaded = rootLoad(page);
  await page.goto('/roadmap?item=WIDE-999999');
  await loaded;

  // The root level, silently: a stale link is not a failure, it is a level that
  // no longer exists.
  await expect(canvasApp(page)).toBeVisible();
  await expect(page.getByText(seed.frontierEpicTitle, { exact: true }).first()).toBeVisible();
  await expect(breadcrumb(page)).toHaveCount(0);

  // ⚠️ Scoped to the roadmap's own region, NOT `page.getByRole('alert')`. The
  // authed shell always carries one — the notification drawer's empty state is a
  // `role="alert"` — so a page-wide assertion is a claim about the shell, and it
  // fails for a reason that has nothing to do with this card. The first run of
  // this spec did exactly that.
  const roadmap = page.getByRole('main');
  await expect(roadmap.getByRole('alert')).toHaveCount(0);
  // …and nothing anywhere names the key that did not resolve.
  // NEITHER CONVERTED NOR SCOPED, deliberately (MOTIR-5116). The claim is that
  // NOTHING ANYWHERE names the key that did not resolve — breadcrumb, title,
  // toast, shell included — so scoping it to a subtree would narrow the very
  // thing asserted, and the text has no role in any of those places. It is also
  // structurally immune to the defect this sweep is about: `toHaveCount` retries
  // on the count and never trips strict mode (`_helpers/settle.ts`). Its
  // inventory row is KEPT.
  await expect(page.getByText('WIDE-999999')).toHaveCount(0);
});
