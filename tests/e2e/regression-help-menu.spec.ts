import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { createWorkspace, signUp, POST_AUTH_LANDING } from './_helpers/shell-session';
import { readDocsUrl, setDocsUrl } from './_helpers/docs-url';
import {
  E2E_LEGAL_BASE,
  E2E_LEGAL_DOCUMENTS,
  readLegalHealth,
  setLegalManifest,
} from './_helpers/legal-manifest';

// THE HELP MENU, END TO END — AND THE ACCEPTANCE RECEIPT FOR IT
// (Story MOTIR-4237 · Subtask MOTIR-4241).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// This story takes two doors OUT of the rail and builds the room they move to.
// The acceptance question is not "does a menu render" — a component test answers
// that. It is whether the doors are REACHABLE, at each width, in each state: the
// rail expanded, the rail collapsed to 56px, and the rail folded into the drawer
// where it has no footer at all. Those are three different mounts of one control,
// and only a browser can tell them apart.
//
// So the clip is a comparison across moments. The rail gets shorter; a control
// turns up at its foot; the same three rows are behind it however the shell is
// painted. That is what `explanationMd` says a reviewer needs to see, and it is
// why every chapter below holds after its assertions land.
//
// ── ⚠️ THE ARMS ARE PROPERTIES OF THE SERVER, AND BOTH ARE MOUNTED ──────────
//
// `MOTIR_DOCS_URL` and `MOTIR_LEGAL_DOCUMENTS` are process-wide, server-side
// reads resolved in `app/(authed)/layout.tsx` and handed to `HelpMenu` as props.
// There is no per-test override and no client seam a `page.route()` stub can
// reach, so the arm a spec runs against is a property of the SERVER — and a spec
// written in a lane that does not set them does not go red, it passes on unfixed
// code for ever. The failure mode is a green tick. So every arm below is MOUNTED
// and READ BACK through PRODUCTION code before anything is asserted about it:
//
//   * the DOCS arm — this lane sets `MOTIR_DOCS_URL` on its webServer (see
//     `playwright.acceptance.config.ts`, whose comment explains why: the legal
//     spec reads the Docs row as its CONTROL). Chapter 1 reads it back through
//     `docsIndexUrl()` and chapter 6 unsets it, both through
//     `/api/_test/docs-url`.
//   * the LEGAL arm — this lane sets NO `MOTIR_LEGAL_DOCUMENTS`, which is the
//     self-hoster's posture, so chapter 1 CONFIGURES the running server through
//     `/api/_test/legal-manifest` and reads the result back off the shipped
//     `/api/health/legal`.
//
// Neither door is a shortcut around a mock. Both write the operator's own
// configuration into the process the way `fly secrets set` plus a restart would,
// and both report through the shipped resolver rather than through what they
// just wrote — which is what makes the mount check worth making.
//
// ── WHAT THIS SPEC DELIBERATELY DOES NOT WALK ───────────────────────────────
//
// **The destinations.** Both urls are the operator's own, off this application
// (and `public.motir.e2e` resolves nowhere by design — see `legal-manifest.ts`).
// Every assertion here reads the `href`; none follows it.
//
// **The seams and the arm coverage.** `openShortcuts`, the resolvers, and the
// per-row arms are MOTIR-4240's vitest gate. This drives the browser.
//
// **The re-consent gate and sign-up.** `regression-legal-manifest.spec.ts` and
// `regression-legal-gone.spec.ts` own those, and this spec re-drives neither.

// A PACED recording, not a race. Seven chapters, each holding after its own
// assertions land; the lane's per-test default is not generous enough for a walk
// that signs up, stands up a second workspace and a project, and then crosses
// two width bands against a production build.
test.describe.configure({ timeout: 300_000 });

const EMAIL = 'acceptance-help-menu@example.com';
/**
 * A SECOND workspace, and it is load-bearing rather than scenery.
 *
 * The rail's bottom section is *Settings · Security · Job runs · Git*, and the
 * `Security` row is gated on the workspace tier being REVEALED — which
 * `isWorkspaceTierRevealed` puts at two org-scoped workspaces
 * (`lib/workspaces/tierDisclosure.ts`, MOTIR-3502). At one workspace the section
 * is three rows, and "the four remaining rows" could not be asserted at all.
 */
const SECOND_WORKSPACE = 'Acceptance workspace';

/**
 * ⚠️ AND ON THIS LANE THE SECOND WORKSPACE HAS TO BE PAID FOR — measured, not
 * assumed.
 *
 * `PM_ENTITLEMENTS.free.maxWorkspaces` is **1**, and `assertWithinWorkspaceCap`
 * enforces it only `if (isCloudBilling())` — which the MAIN Playwright lane is
 * not and this one IS (`playwright.acceptance.config.ts` sets `MOTIR_CLOUD` on
 * both the runner and the webServer, and its header says why). So
 * `createWorkspace` is a helper four other specs call happily and it is REFUSED
 * here, with `ENTITLEMENT_EXCEEDED {limit: 1, usage: 1}` on the server and an
 * unrevealed switcher in the browser. A sibling spec's use of a helper says
 * nothing about whether THIS lane can drive it; the lane's own config does.
 *
 * The honest mount is therefore the arm a deployment with two workspaces
 * actually has: an ACTIVE scaled-tracker subscription, which
 * `pmTierForOrg` reads as the `scaled` tier and `PM_ENTITLEMENTS.scaled` leaves
 * `maxWorkspaces: null`. Seeded exactly as `regression-public-address.spec.ts`
 * seeds it, one lane over, for the same reason: the cap is not what this
 * recording is about.
 */
async function payForTheSecondWorkspace(email: string): Promise<void> {
  const user = await adminDb.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const membership = await adminDb.workspaceMembership.findFirstOrThrow({
    where: { userId: user.id },
    select: { workspace: { select: { organizationId: true } } },
  });
  await adminDb.organization.update({
    where: { id: membership.workspace.organizationId },
    data: {
      scaledTrackerSubscription: {
        status: 'active',
        priceId: 'tracker_monthly',
        currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      } as never,
    },
  });
}

/**
 * The rail's surviving bottom rows, in order (`shell.nav.*`).
 *
 * ⚠️ RE-MEASURED by Story MOTIR-4843 · MOTIR-4849 — from four rows to two.
 * `Security` and `Job runs` left this section: they were workspace-tier panes
 * rendered in the PROJECT's rail, and they are now rows in the workspace area's
 * own rail above the reveal and folded into `/settings/organization` below it.
 *
 * ⚠️ AND THIS IS A RE-MEASUREMENT, NOT AN AMENDMENT TO THE RECEIPT'S CLAIM —
 * which matters, because `motir-core/CLAUDE.md` forbids the second thing:
 * "when an acceptance spec goes red on a PR that did not change its story, do
 * NOT update the assertion to match today." What this receipt CLAIMS is the two
 * `not.toContain` assertions below — Docs and Legal left the rail for the Help
 * menu — and they are untouched, still asserted over the whole rail, still true.
 * This constant is the VEHICLE: a positional list of the section those two rows
 * departed from, which a later story has legitimately changed underneath it.
 *
 * Leaving it stale was the other option and is the worse one: MOTIR-4239's
 * vitest gate carries the identical list and is re-measured in this same PR, so
 * a stale copy here would put the two homes in disagreement — which is
 * MOTIR-4130's finding exactly ("a count carried in two places is a count
 * nobody re-takes").
 */
// ⚠️ RE-MEASURED AGAIN (MOTIR-4643). `Git` left this section — the connection
// LIFECYCLE is an org-admin act at Settings → Organisation → Git, and a member's
// own account connect is at Settings → Account → Git, so both actions moved off
// a PROJECT rail rather than being removed. The list is down to the door alone.
//
// This is the second re-measure, by the rule the comment above states: the
// identical list lives in MOTIR-4239's vitest gate and is re-measured in the
// same commit, because a count carried in two places is a count nobody re-takes.
const BOTTOM_SECTION = ['Settings'];

/** The Help menu's rows, in the order `HelpMenu` renders them. */
const HELP_ROWS = ['Docs', 'Keyboard shortcuts', 'Legal documents'];

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

/**
 * Every rail row's accessible name, in DOM order.
 *
 * Read as `aria-label ?? textContent` because the rail paints a row TWO ways —
 * an icon-only `<a aria-label>` when collapsed, a labelled row when expanded
 * (`components/ui/Sidebar.tsx`) — and the collapsed-rail chapter needs the same
 * sentence to hold in both. Both forms compute to the same accessible name, so
 * this reads what a screen reader would announce rather than what is painted.
 */
async function railRowNames(rail: Locator): Promise<string[]> {
  return rail
    .getByRole('link')
    .evaluateAll((els) =>
      els.map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()),
    );
}

/**
 * The rail's bottom section IS its last rows, and neither departed row is
 * anywhere in it.
 *
 * The section is the LAST one `SidebarNav` pushes (`primary` then `bottom`), and
 * `Sidebar` renders sections as unlabelled sibling divs, so the honest locator
 * for "the bottom section" is the tail of the row list rather than a structural
 * selector that would break on the next section anyone adds. The absence
 * assertion is deliberately over the WHOLE rail, not only the tail: a `Docs` row
 * that had merely moved UP a section would satisfy a tail-scoped check.
 */
async function expectRailBottomSection(rail: Locator): Promise<void> {
  const names = await railRowNames(rail);
  // Sliced by the CONSTANT's own length, not a literal: the two drifted apart
  // once already (the list said four rows after MOTIR-4640 took `Git` out of the
  // design asset), and a hard-coded `-4` beside a two-row list fails describing
  // the wrong thing.
  expect(names.slice(-BOTTOM_SECTION.length), 'the rail’s bottom section').toEqual(BOTTOM_SECTION);
  expect(names, 'Docs left the rail for the Help menu').not.toContain('Docs');
  expect(names, 'Legal left the rail for the Help menu').not.toContain('Legal documents');
  expect(names, 'the pre-MOTIR-4239 label is gone too').not.toContain('Legal');
}

/**
 * Open a Help trigger and return the menu panel, waiting on the AUTHORITATIVE
 * signals both ends of the popover publish — the trigger's own
 * `aria-expanded` (Radix's disclosure state) and the panel's role and name.
 * Never a timeout: the coding convention § E2E discipline, and the E2E-authoritative-signal
 * lesson that rule comes from.
 */
async function openHelp(page: Page, trigger: Locator): Promise<Locator> {
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('dialog', { name: 'Help' });
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * Dismiss the menu, and WAIT for it to have gone — the trigger says so.
 *
 * ⚠️ `via` IS A MEASURED DIFFERENCE, NOT A STYLE CHOICE. In the rail's footer
 * `Escape` dismisses the popover and nothing else. In the DRAWER it dismisses
 * the popover AND THE DRAWER UNDER IT — measured, on the run before this line
 * existed: `Escape` inside the open menu left `getByRole('dialog', { name:
 * 'Navigation' }).getByRole('button', { name: 'Help' })` with no element at all.
 * `SidebarDrawer` is a Radix `Dialog` that ALSO registers its own
 * `useShortcut('esc', …)`, a plain document listener outside Radix's
 * dismissable-layer stack, so the layering that would peel one surface at a time
 * never sees the key. Filed as MOTIR-4326 (low: below `md` there is no `Escape` key).
 *
 * So the drawer chapter closes the menu the way that surface's own user can — by
 * tapping the trigger again, there being no Escape key at phone width — and then
 * ASSERTS the drawer survived, which is what makes the sentence above evidence
 * rather than a guess about why a locator went missing.
 */
async function closeHelp(
  page: Page,
  trigger: Locator,
  via: 'escape' | 'trigger' = 'escape',
): Promise<void> {
  if (via === 'escape') await page.keyboard.press('Escape');
  else await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('dialog', { name: 'Help' })).toHaveCount(0);
}

/** All three rows, in order, each door pointing where the operator published. */
async function expectTheThreeRows(menu: Locator, docsUrl: string): Promise<void> {
  // `a, button` rather than two role locators OR-ed together: the rows are two
  // different elements by design (a door that leaves the app is an anchor; the
  // one that opens a dialog in place is a button), and only a CSS locator
  // guarantees they come back in DOM order — which is what makes this an
  // assertion about the menu's ORDER and not merely its membership.
  await expect(menu.locator('a, button'), 'the Help menu’s three rows').toHaveText(HELP_ROWS);

  const docs = menu.getByRole('link', { name: 'Docs', exact: true });
  await expect(docs).toBeVisible();
  await expect(docs).toHaveAttribute('href', docsUrl);

  const legal = menu.getByRole('link', { name: 'Legal documents', exact: true });
  await expect(legal).toBeVisible();
  await expect(legal).toHaveAttribute('href', E2E_LEGAL_BASE);
}

/**
 * The UNCONFIGURED arm: **Keyboard shortcuts alone**, with nothing marking the
 * two gaps.
 *
 * ⚠️ THE ABSENCE ASSERTIONS ARE THE POINT, and each names a specific way the
 * product could have got this wrong instead of right. A disabled row, a tooltip
 * on a gap, an empty-state line — "an entry point is a promise about a room, and
 * a disabled row is a promise the product then refuses" (`SidebarNav.tsx`). And
 * the menu must still OPEN: a build that renders no trigger at all would satisfy
 * every "row is absent" sentence written on its own.
 */
async function expectShortcutsAlone(menu: Locator): Promise<void> {
  await expect(menu.getByRole('button', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(menu.getByRole('link'), 'neither door is a link any more').toHaveCount(0);
  await expect(menu.getByRole('button'), 'Keyboard shortcuts alone').toHaveCount(1);
  await expect(menu.getByText(/Docs/i), 'no row marks the absent documentation').toHaveCount(0);
  await expect(menu.getByText(/Legal/i), 'no row marks the absent documents').toHaveCount(0);
  await expect(menu.locator('[aria-disabled]'), 'no disabled row').toHaveCount(0);
  await expect(menu.locator('[data-state="delayed-open"], [role="tooltip"]')).toHaveCount(0);
}

test('the rail is for daily work — Docs, Keyboard shortcuts and Legal documents live in the Help menu', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask — the publisher reads
  // this sidecar ahead of anything derived from the branch or the pull request.
  acceptanceStory('MOTIR-4237');

  // Read back in chapter 1 and used as the expected `href` everywhere below, so
  // the spec asserts against the url the SERVER resolved rather than a literal
  // that agrees with the lane's config file by coincidence.
  let docsUrl = '';

  const rail = page.getByRole('navigation', { name: 'Primary' });
  const railHelp = rail.getByRole('button', { name: 'Help' });

  await chapter('The operator has published documentation and legal documents', async () => {
    // ── MOUNT BOTH ARMS, AND READ EACH BACK THROUGH SHIPPED CODE ────────────
    // The docs url is the lane's; the manifest is not, so it is PUT here. Both
    // are then read back through the resolver / the health route, because "the
    // config file sets it" is a claim about a file and `configured` is an answer
    // from the server. Under `reuseExistingServer` a previous run can have left
    // either arm on the other side; this is what notices.
    const docs = await readDocsUrl(page);
    expect(docs.configured, 'this lane configures MOTIR_DOCS_URL').not.toBeNull();
    docsUrl = docs.configured!;

    const set = await setLegalManifest(page, E2E_LEGAL_DOCUMENTS);
    expect(set.status, 'the server accepted the manifest').toBe('configured');
    const health = await readLegalHealth(page);
    expect(health.status, 'the SERVER reports its legal documents').toBe('configured');
    expect(health.documentCount).toBe(E2E_LEGAL_DOCUMENTS.length);
    await beat();
  });

  await chapter('A signed-in rail carries daily work — and neither departed row', async () => {
    await signUp(page, EMAIL);
    await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 60_000 });

    // The second workspace reveals the tier (so `Security` renders), and the
    // project fills the rail's primary section — a reviewer watching this needs
    // to see a REAL rail lose two rows, not an empty one. The org is put on a
    // paid tier first because this lane enforces the free workspace cap — see
    // `payForTheSecondWorkspace`.
    await payForTheSecondWorkspace(EMAIL);
    await createWorkspace(page, SECOND_WORKSPACE);
    // Back to the landing surface explicitly, so the spec says where it is
    // rather than inheriting wherever the switch happens to land.
    //
    // ⚠️ NO `createFirstProject` HERE ANY MORE (MOTIR-4876). This used to read
    // "the switch lands the new (EMPTY) workspace … and `createFirstProject`
    // drives the no-project CTA": the new workspace had no project, so one had
    // to be made before the rail could show a primary section. A workspace
    // seeds its own project now (MOTIR-4870), so the rail is already REAL — the
    // condition this chapter needs — and the call had become a request for a
    // SECOND project, driving a CTA that no longer exists.
    await page.goto(POST_AUTH_LANDING);
    await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 60_000 });
    await expect(rail).toBeVisible();

    await expectRailBottomSection(rail);
    await beat();
  });

  await chapter(
    'The Help control sits at the foot of the rail, beside the collapse toggle',
    async () => {
      // The footer holds TWO controls now, and the pair is the thing this story
      // added — so both are asserted, together, in the region that survives a
      // collapse. `SidebarToggle`'s name is state-dependent, which is why the
      // expanded arm asks for `Collapse sidebar`.
      await expect(railHelp).toBeVisible();
      await expect(rail.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();

      const menu = await openHelp(page, railHelp);
      await expectTheThreeRows(menu, docsUrl);
      await beat();
      await closeHelp(page, railHelp);
    },
  );

  await chapter(
    'Keyboard shortcuts opens the cheatsheet, and closing it returns to the app',
    async () => {
      const menu = await openHelp(page, railHelp);
      await menu.getByRole('button', { name: 'Keyboard shortcuts' }).click();

      // The third door, and the one that had none before this story: until now the
      // only way to open `ShortcutsCheatsheet` was to press `?`, a key you find out
      // about by opening the cheatsheet.
      const cheatsheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
      await expect(cheatsheet).toBeVisible();
      // Opening the room CLOSES the menu — `openShortcutsAndClose`, asserted here
      // because a popover left open behind a modal is exactly what a browser
      // notices and a component test does not.
      await expect(page.getByRole('dialog', { name: 'Help' })).toHaveCount(0);
      await beat();

      await page.keyboard.press('Escape');
      await expect(cheatsheet).toHaveCount(0);
      // Back in the APP, not merely back to no-dialog: a closed modal that took the
      // shell with it would satisfy the assertion above on its own.
      await expect(page.getByTestId('workbench-page')).toBeVisible();
      await expect(railHelp).toBeVisible();
      await beat();
    },
  );

  await chapter('Collapsed to 56px, the footer still carries the door', async () => {
    // The footer is the one region that survives the collapse, and it now holds
    // two controls where it held one — so this is where a two-control footer
    // fails first, and it is why the story is worth a spec at all.
    await rail.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(rail).toHaveAttribute('data-collapsed', 'true');
    await expect(rail.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();

    // The section is still the same four rows, now icon-only — `railRowNames`
    // reads the accessible name, which is what makes one sentence hold in both
    // states.
    await expectRailBottomSection(rail);

    const menu = await openHelp(page, railHelp);
    await expectTheThreeRows(menu, docsUrl);
    await beat();
    await closeHelp(page, railHelp);

    await rail.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(rail).not.toHaveAttribute('data-collapsed', 'true');
  });

  await chapter(
    'Below `md` the rail folds into the drawer, and Help is in its utility strip',
    async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      // The rail is `hidden md:block` (`components/ui/AppLayout.tsx`), so it leaves
      // the accessibility tree entirely — which is what makes the drawer's own
      // `Primary` nav unambiguous below.
      await expect(rail).toHaveCount(0);

      await page.getByRole('button', { name: 'Open navigation' }).click();
      const drawer = page.getByRole('dialog', { name: 'Navigation' });
      await expect(drawer).toBeVisible();

      // The drawer's nav is a DIFFERENT mount of the same component, and the rows
      // have left it too.
      const drawerNav = drawer.getByRole('navigation', { name: 'Primary' });
      await expectRailBottomSection(drawerNav);

      // The drawer renders NO footer of its own (`SidebarNav` passes
      // `footer={isDrawer ? undefined : …}`), so the Help trigger is a genuinely
      // separate mount in the utility strip — beside the controls the below-`md`
      // bar's four-slot budget already displaced (MOTIR-2373).
      const drawerHelp = drawer.getByRole('button', { name: 'Help' });
      await expect(drawerHelp).toBeVisible();
      await expect(drawer.getByRole('button', { name: 'Report' })).toBeVisible();
      await expect(drawer.getByRole('button', { name: /^Theme:/ })).toBeVisible();

      // ⚠️ The panel is PORTALED to the document, not into the drawer — so it is
      // located on the page and never inside `drawer`. Scoping it to the drawer
      // would fail on a build where everything works.
      const menu = await openHelp(page, drawerHelp);
      await expectTheThreeRows(menu, docsUrl);
      await beat();

      // Tapping the trigger again closes the MENU and leaves the drawer standing
      // — the CONTROL for the `Escape` observation in `closeHelp`, and the reason
      // `via` exists. Without it, "the trigger was not found" has two readings.
      await closeHelp(page, drawerHelp, 'trigger');
      await expect(drawer, 'the drawer survived closing the menu').toBeVisible();
    },
  );

  await chapter(
    'A deployment that configured neither url offers Keyboard shortcuts alone',
    async () => {
      // ── MOVE BOTH ARMS, AND READ BOTH BACK ──────────────────────────────────
      const clearedDocs = await setDocsUrl(page, null);
      expect(clearedDocs.configured, 'the door unset the documentation url').toBeNull();
      const clearedLegal = await setLegalManifest(page, null);
      expect(clearedLegal.status, 'the door unset the manifest').toBe('unconfigured');
      expect((await readLegalHealth(page)).status).toBe('unconfigured');

      // Still below `md`, so the DRAWER is the first home asserted. A reload is
      // what re-runs the server layout that resolves both urls.
      await page.reload();
      await page.getByRole('button', { name: 'Open navigation' }).click();
      const drawer = page.getByRole('dialog', { name: 'Navigation' });
      await expect(drawer).toBeVisible();
      const drawerHelp = drawer.getByRole('button', { name: 'Help' });
      await expectShortcutsAlone(await openHelp(page, drawerHelp));
      await beat();
      await closeHelp(page, drawerHelp, 'trigger');
      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);

      // …and then the rail's footer, the second home. Same menu, same verdict.
      await page.setViewportSize({ width: 1280, height: 720 });
      await expect(rail).toBeVisible();
      await expectRailBottomSection(rail);
      await expectShortcutsAlone(await openHelp(page, railHelp));
      await beat();
      await closeHelp(page, railHelp);

      // ── LEAVE THE LANE AS IT WAS FOUND ──────────────────────────────────────
      // Both arms are PROCESS state on a server the whole lane shares, and this
      // spec sorts first alphabetically. `regression-legal-manifest.spec.ts` opens
      // by clearing the manifest itself, so it does not depend on this — but its
      // Docs CONTROL does depend on the docs url, and nothing there restores it.
      const restored = await setDocsUrl(page, docsUrl);
      expect(restored.configured, 'the lane’s docs url is back').toBe(docsUrl);
    },
  );
});
