// E2E: the top bar's CONTROL BUDGET below `md` (MOTIR-2373 · design/shell
// design-notes.md § *The top bar's control budget*, drawn by MOTIR-2374).
//
// ── THE DEFECT THIS OWNS ────────────────────────────────────────────────────
// The right cluster grew to eight controls, two of them labelled, and could not
// shrink — so it starved the `min-w-0` left cluster to ZERO width and painted
// over the hamburger. The hamburger stayed perfectly VISIBLE the whole time; it
// was simply not the element under the tap. That is why the assertion here is a
// HIT-TEST (`document.elementFromPoint` at the button's centre) and not a
// `toBeVisible()` — a screenshot review cannot catch this, and neither can any
// visibility assertion. It is the wrong thing being ON TOP that breaks it.
//
// ── WHY TWO VIEWPORTS ───────────────────────────────────────────────────────
// The worst band is `sm`–`md` (640–767px), NOT `< md`. At 640px every label used
// to switch on at once and the cluster jumped 350 → 656px inside a 640px
// viewport, while the hamburger was still mounted (it is `md:hidden`, so it
// lives to 767px). A fix scoped to 375px leaves a 128px-wide band broken in
// exactly the same way, and a hit-test asserted only at 375×812 passes while it
// is. So both widths are driven, and 700px is the one that fails if the label
// breakpoint is left at `sm`.
//
// ── WHY THE TWO EXISTING NARROW-WIDTH SPECS DID NOT CATCH IT ────────────────
// `shell-flows` ("mobile drawer opens…") and `settings-area` ("the settings nav
// collapses into the mobile drawer at narrow width") both drive 375px and both
// pass, because the tenants they seed have a QUIET right cluster: no public
// project, and a bell with nothing in it. The bar breaks only in the states real
// usage produces and fixtures do not. So this file seeds the CROWDED one.
//
// ── WHAT THIS FILE CANNOT SEED, AND WHERE THAT LEG IS PROVEN ────────────────
// `showPlanWithAi` is `isMotirAiConfigured() && activeProject` — a process-wide
// SERVER read of MOTIR_AI_URL + MOTIR_AI_SERVICE_TOKEN with no per-test override
// and no client seam a `page.route` could reach, and this lane deliberately
// leaves that pair UNSET (a standing decision `tests/e2e/ai-callout-gate.spec.ts`
// documents and guards — setting it here mounts the shell's AI affordances across
// every authed spec, and has already broken the mobile settings drawer once).
// The pill's leg is therefore proven in `tests/components/top-nav-control-budget
// .test.tsx`, which renders the bar from PROPS with every optional slot live and
// pins the pill to `hidden md:inline-flex` — i.e. `display: none` below `md`, so
// it contributes zero width to the geometry measured here. Between the two files
// the crowded state is covered in full; neither covers it alone.
//
// ⚠️ STALE SINCE THE MOVE BELOW, and kept as the record of why that component
// file exists (MOTIR-4897): this file now runs in the CLOUD lane, whose webServer
// DOES set MOTIR_AI_URL + MOTIR_AI_SERVICE_TOKEN — so the pill mounts here, and
// the `xl` describe at the bottom asserts it is visible before measuring. The
// below-`md` tests are unaffected: the pill is `display: none` there either way.
//
// Per the E2E discipline (CLAUDE.md), nothing here waits on a timeout: the
// hit-test runs only after the shell is proven rendered, and the drawer legs
// wait on the dialog's own role state.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { pinContextCookies } from './_helpers/billing';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { setProjectAccess } from '@/tests/helpers/projectAccess';

// ⚠️ MOVED TO THE CLOUD LANE (Story MOTIR-3908 · MOTIR-4038). The CROWDED bar this file exists to measure is only producible on a cloud
// build: the "Building in public" indicator is the widest control in it (117px
// at 375px, per this file's own seed comment), and off-cloud that slot is
// EMPTY. Asserting the budget without it would measure a narrower bar and could
// not catch the defect the file was written for. The per-PR safety net for the
// crowded bar is `tests/components/top-nav-control-budget.test.tsx`, which
// renders it from PROPS with every optional slot live — the division of labour
// this file's own header already describes.
// With `MOTIR_CLOUD` unset the publish path is refused and the shell's
// build-in-public slot is not rendered, so this spec cannot reach the state it
// asserts on. The MAIN lane sets no `MOTIR_CLOUD` and deliberately does not
// (turning it on there activates the §4 entitlement caps and surfaces the
// billing row, breaking unrelated specs), so the spec runs in
// `playwright.cloud.config.ts`'s cloud-on lane — which is what the `cloud-`
// prefix selects.
//
// ⚠️ THE COST: that lane is the `billing-cloud` leg of `e2e-at-scale` — push, or
// a PR carrying the `e2e-at-scale` label. Recorded, not absorbed: MOTIR-4041.

const PASSWORD = 'top-bar-budget-e2e-pass-9';
const EMAIL = 'e2e-top-bar-budget@example.com';

/** The widest state this lane can produce: an active PUBLIC project (so the
 *  build-in-public slot renders its indicator — the control whose ungated label
 *  measured 117px at 375px and made the public bar the widest surface in the
 *  product) plus unread notifications (so the bell renders with its badge).
 *  Create + palette + report all mount off the active project. */
async function seedCrowdedShell(): Promise<void> {
  const owner = await usersService.createUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Zhu Yue',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Budget E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Budget',
    identifier: 'BDG',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // Public → the "Building in public" indicator arm of the stateful slot.
  await setProjectAccess(db, project.id, 'public');
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  await db.notification.createMany({
    data: [1, 2, 3].map((n) => ({
      workspaceId: workspace.id,
      recipientUserId: owner.id,
      type: 'work_item.mentioned',
      category: 'direct' as const,
      data: {},
      dedupeKey: `top-bar-budget-${n}`,
    })),
  });
}

/** What the browser says is at the CENTRE of the hamburger — the only question
 *  that distinguishes "visible" from "tappable". Returns the chain of tag +
 *  aria-label from the hit element upward, so a failure names the intruder
 *  instead of just saying `false`. */
async function hitTestHamburger(page: Page): Promise<{ hitsHamburger: boolean; chain: string }> {
  return page.evaluate(() => {
    const hamburger = document.querySelector('[aria-label="Open navigation"]');
    if (!hamburger) return { hitsHamburger: false, chain: 'hamburger not in the DOM' };
    const box = hamburger.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const chain: string[] = [];
    for (let el = hit; el && chain.length < 6; el = el.parentElement) {
      chain.push(
        `${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''}`,
      );
    }
    return {
      hitsHamburger: Boolean(hit && (hit === hamburger || hamburger.contains(hit))),
      chain: chain.join(' < ') || 'nothing at that point',
    };
  });
}

test.describe('the top bar’s four-slot budget below md', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('the hamburger is the element AT its own centre, at 375px AND at 700px', async ({
    page,
  }) => {
    await seedCrowdedShell();
    await signIn(page, EMAIL, PASSWORD);

    // The crowded state is real before anything is measured: an absence — or a
    // hit-test — on a shell that never rendered passes vacuously.
    await expect(page.getByRole('link', { name: 'Building in public — manage' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Notifications,/ })).toBeVisible();

    for (const width of [375, 700]) {
      await page.setViewportSize({ width, height: 812 });
      const hamburger = page.getByRole('button', { name: 'Open navigation' });
      await expect(hamburger, `hamburger mounted at ${width}px`).toBeVisible();

      const { hitsHamburger, chain } = await hitTestHamburger(page);
      expect(
        hitsHamburger,
        `at ${width}px the element at the hamburger’s centre is: ${chain}`,
      ).toBe(true);
    }
  });

  // MOTIR-2556 · design/shell/design-notes.md § *The measurement*.
  //
  // The budget above computes the four-slot ceiling from a 68px floor reserved
  // for the tier nav — and the design pass MEASURED that floor and found it
  // unreachable: `OrgControl` + `WorkspaceSwitcher` cannot compress below 112px
  // between them, because their avatar, chevron and padding are all
  // `flex-none`. So the bar that shipped after this file was written still
  // overflowed by 47px at 320px, the narrowest viewport the app supports —
  // visible to nobody, because a horizontal overflow scrolls rather than
  // repaints, and every element stays "visible" throughout.
  //
  // The context row closes it by carrying ONE tier below `md`. This asserts the
  // outcome rather than the mechanism, so it keeps holding whatever the path
  // does next: at 320px the bar must not overflow AT ALL.
  test('the bar does not overflow at 320px — the narrowest viewport we support', async ({
    page,
  }) => {
    await seedCrowdedShell();
    await signIn(page, EMAIL, PASSWORD);

    // the crowded state is real before anything is measured
    await expect(page.getByRole('link', { name: 'Building in public — manage' })).toBeVisible();

    await page.setViewportSize({ width: 320, height: 812 });

    const overflow = await page.evaluate(() => {
      const nav = document.querySelector('header nav[aria-label]');
      if (!nav) return { found: false, by: 0, content: '' };
      return {
        found: true,
        by: nav.scrollWidth - nav.clientWidth,
        content: (nav.textContent ?? '').trim().slice(0, 120),
      };
    });

    expect(overflow.found, 'the top bar’s nav landmark is in the DOM').toBe(true);
    expect(
      overflow.by,
      `at 320px the bar overflows by ${overflow.by}px; it carries: ${overflow.content}`,
    ).toBeLessThanOrEqual(0);

    // and the hamburger is still the thing at its own centre — an overflow that
    // is merely scrolled off-screen would satisfy the check above alone
    const { hitsHamburger, chain } = await hitTestHamburger(page);
    expect(hitsHamburger, `at 320px the element at the hamburger’s centre is: ${chain}`).toBe(true);
  });

  test('the bar carries FOUR slots below md and the displaced controls leave it', async ({
    page,
  }) => {
    await seedCrowdedShell();
    await signIn(page, EMAIL, PASSWORD);
    await page.setViewportSize({ width: 375, height: 812 });

    const bar = page.getByRole('navigation', { name: 'Global' });
    // The four that stay. Each is icon-only here, which is why each carries an
    // aria-label rather than relying on a now-`lg`-gated visible label.
    // `exact` because 'Shortcut' is a SUBSTRING of the untouched "Keyboard
    // shortcuts" cheatsheet copy and `name` matching is substring +
    // case-insensitive by default; it is ignored for the RegExp entry.
    for (const name of ['Shortcut', 'Create work item', /^Notifications,/, 'Account menu']) {
      await expect(bar.getByRole('button', { name, exact: true }), `slot: ${name}`).toBeVisible();
    }
    // The three that leave. `hidden` removes them from the a11y tree, so a role
    // query is the right instrument — and it is the same instrument that would
    // catch a control silently vanishing with nowhere to go.
    await expect(bar.getByRole('button', { name: 'Report' })).toBeHidden();
    await expect(bar.getByRole('button', { name: /^Theme:/ })).toBeHidden();
    await expect(bar.getByRole('link', { name: 'Building in public — manage' })).toBeHidden();

    // Above md the full set is back — the displacement is a budget, not a
    // deletion, and the 640–767px band is inside the range that used to break.
    await page.setViewportSize({ width: 1024, height: 812 });
    await expect(bar.getByRole('button', { name: 'Report' })).toBeVisible();
    await expect(bar.getByRole('button', { name: /^Theme:/ })).toBeVisible();
    await expect(bar.getByRole('link', { name: 'Building in public — manage' })).toBeVisible();
  });

  test('every displaced control is REACHABLE at phone width, in the drawer’s utility strip', async ({
    page,
  }) => {
    // "No control silently disappears" — and the test names WHERE. The door is
    // the hamburger the bar already carries; the room is the strip. (The fourth
    // displaced control, the Plan-with-AI pill, is DROPPED rather than re-homed,
    // because `PlanWithAIFab` already ships on every authed screen under the same
    // gate — that orb's own gate is owned by `ai-callout-gate.spec.ts` and
    // `acceptance-ai-callout.spec.ts`, in the lane where AI is configured.)
    await seedCrowdedShell();
    await signIn(page, EMAIL, PASSWORD);
    await page.setViewportSize({ width: 375, height: 812 });

    // Reaching the room requires the door to WORK — which is the bug, tested by
    // clicking rather than by hit-testing this time.
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();

    await expect(drawer.getByRole('button', { name: 'Report' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Building in public — manage' })).toBeVisible();

    // The theme toggle is not just present but FUNCTIONAL in its new home. The
    // control announces its own state, so the cycle is readable straight off it
    // — and asserting the NAME rather than `<html data-theme>` cannot pass
    // vacuously the way "system already resolved to light" would.
    const theme = drawer.getByRole('button', { name: /^Theme: System/ });
    await expect(theme).toBeVisible();
    await theme.click();
    await expect(drawer.getByRole('button', { name: /^Theme: Light/ })).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE `xl` BAND — the context path's truncation budget (MOTIR-4897 · design/shell
// design-notes.md § *The context path's truncation budget*).
//
// The describe above owns the budget BELOW `md`, where the thing covered was the
// hamburger. This is the same defect one band up, and it was invisible to every
// guard that existed: at `xl` (1280px is exactly Tailwind's `xl`) the path
// renders all THREE tiers, the right cluster is labelled and `flex-none`, and the
// ancestor tiers could not shrink below their names at all. With names of the
// length a new tenant is actually given, the row overflowed and the project tier
// — LAST in it — passed under the right cluster. Playwright saw a button that was
// "visible, enabled and stable" and retried a click 638 times: the intruder it
// named was the Plan-with-AI label.
//
// Three conditions at once, and this seed supplies all three:
//   1. LONG NAMES. A first workspace mints an org of the same name, and a seeded
//      default project is named after its workspace (MOTIR-4870) — so one string
//      is what a brand-new cloud tenant renders at every tier.
//   2. TWO WORKSPACES, so the workspace tier is live (`isWorkspaceTierRevealed`).
//   3. The WIDEST right cluster: this lane configures motir-ai (MOTIR_AI_URL +
//      MOTIR_AI_SERVICE_TOKEN), so the Plan-with-AI pill mounts, and a public
//      project fills the build-in-public slot with its labelled indicator.
//
// It asserts the OUTCOME — each tier is the element at its own centre, and ends
// before the right cluster begins — rather than the mechanism, so it keeps holding
// whichever way the path is laid out next.

const XL_EMAIL = 'e2e-top-bar-xl@example.com';
const LONG_NAME = 'Acceptance workspace';
const TIERS = ['Organization menu', 'Switch workspace', 'Switch project'] as const;
/** A truncated tier must still say something: below this a tier is a chevron in a
 *  box, which the context row's design rejected outright (§ *The ladder*). */
const LEGIBLE_LABEL_PX = 40;

async function seedLongContextPath(page: Page): Promise<void> {
  const owner = await usersService.createUser({
    email: XL_EMAIL,
    password: PASSWORD,
    name: 'Zhu Yue',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: LONG_NAME,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: LONG_NAME,
    identifier: 'ACC',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await setProjectAccess(adminDb, project.id, 'public');
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  // This lane is CLOUD-ON, and the free plan caps an organisation at ONE
  // workspace — the create below is REFUSED without this. Set on the org row, the
  // same remedy `regression-repository-tenancy.spec.ts` documents: a paid AI
  // plan bundles a seat, which resolves the tier to `scaled` (no workspace cap).
  await adminDb.organization.update({
    where: { id: workspace.organizationId },
    data: { aiIncludedSeat: true },
  });
  await workspacesService.createWorkspace({
    name: `Second ${LONG_NAME}`,
    ownerUserId: owner.id,
    organizationId: workspace.organizationId,
  });
  await adminDb.notification.createMany({
    data: [1, 2, 3].map((n) => ({
      workspaceId: workspace.id,
      recipientUserId: owner.id,
      type: 'work_item.mentioned',
      category: 'direct' as const,
      data: {},
      dedupeKey: `top-bar-xl-${n}`,
    })),
  });
  // Two workspaces means the landing has a choice to make; pin the one that
  // holds the project rather than depending on which it makes.
  await pinContextCookies(page, {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
  });
}

/** Per tier: is it the element at its own centre (and if not, WHAT is), does it
 *  end before the right cluster begins, and how much of its name is showing. */
async function measureContextPath(page: Page, tiers: readonly string[]) {
  return page.evaluate((names) => {
    const nav = document.querySelector('header nav[aria-label]');
    const rightCluster = nav?.children[1];
    const rightClusterLeft = rightCluster?.getBoundingClientRect().left ?? 0;
    return names.map((name) => {
      const button = nav?.querySelector<HTMLElement>(`button[aria-label="${name}"]`);
      if (!button)
        return { name, found: false, hitsSelf: false, intruder: '', overlap: 0, label: 0 };
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const intruder = hit
        ? `<${hit.tagName.toLowerCase()} class="${hit.getAttribute('class') ?? ''}">${(hit.textContent ?? '').trim().slice(0, 40)}`
        : 'nothing at that point';
      return {
        name,
        found: true,
        hitsSelf: Boolean(hit && (hit === button || button.contains(hit))),
        intruder,
        overlap: Math.round(box.right - rightClusterLeft),
        // The laid-out box, not `clientWidth`: an INLINE span reports 0 there
        // whatever it shows — which is also the tell that `truncate` is not
        // applying to it.
        label: Math.round(
          button.querySelector<HTMLElement>('span.truncate')?.getBoundingClientRect().width ?? 0,
        ),
      };
    });
  }, tiers);
}

test.describe('the context path’s truncation budget at xl', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('every tier is clickable at 1280px with long names, two workspaces and AI on', async ({
    page,
  }) => {
    await seedLongContextPath(page);
    await signIn(page, XL_EMAIL, PASSWORD);

    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 720 });

      // The crowded state is real before anything is measured — a hit-test on a
      // bar that never grew its widest controls passes vacuously.
      const bar = page.getByRole('navigation', { name: 'Global' });
      await expect(bar.getByText('Plan with AI', { exact: true })).toBeVisible();
      await expect(bar.getByRole('link', { name: 'Building in public — manage' })).toBeVisible();
      for (const name of TIERS) {
        await expect(bar.getByRole('button', { name }), `${name} at ${width}px`).toBeVisible();
      }
      await expect(bar.getByRole('button', { name: 'Switch project' })).toContainText('Acceptance');

      // One read, then the three claims in order of what they mean: CLICKABLE
      // first (the defect as reported), then CLEAR of the right cluster, then
      // LEGIBLE — so a failure names the worst thing that is wrong.
      const tiers = await measureContextPath(page, TIERS);
      // The widths ride on the report, so a red run — or a design pass re-taking
      // the budget — reads the numbers instead of re-deriving them.
      await test.info().attach(`context-path-${width}px`, {
        body: JSON.stringify(tiers, null, 2),
        contentType: 'application/json',
      });
      for (const tier of tiers) {
        expect(
          tier.hitsSelf,
          `at ${width}px the element at the centre of “${tier.name}” is: ${tier.intruder}`,
        ).toBe(true);
      }
      for (const tier of tiers) {
        expect(
          tier.overlap,
          `at ${width}px “${tier.name}” runs ${tier.overlap}px under the right cluster`,
        ).toBeLessThanOrEqual(0);
      }
      for (const tier of tiers) {
        expect(
          tier.label,
          `at ${width}px “${tier.name}” shows ${tier.label}px of its name`,
        ).toBeGreaterThanOrEqual(LEGIBLE_LABEL_PX);
      }
    }

    // And the defect as it was reported: the click lands. `aria-expanded` is the
    // trigger's own state, written by the popover it opened.
    const switcher = page.getByRole('button', { name: 'Switch project' });
    await switcher.click();
    await expect(switcher).toHaveAttribute('aria-expanded', 'true');
  });
});
