// Plans review E2E (Subtask 7.21.5 / MOTIR-1339) — the browser-level proof of
// the AI-plan review experience (Story 7.21): the left-nav entry → the plans
// list (status / count / when + a staleness indicator) → a plan's detail
// (proposed items on the canvas, status + history, per-item stale badges +
// reasons) → the stale-warning APPROVE-ANYWAY (materialize) and the DECLINE
// branch → the empty-state CTA.
//
// Drives the REAL stack (Next + Postgres) end to end. The fixture seeds three
// plans through the shipped services (plans-review-seed.ts): a STALE `planned`
// plan (parent_removed), a clean `planned` plan, and an
// already-`approved` plan. Waits on AUTHORITATIVE signals — the rendered rows
// and the persisted approve/decline POST 200 — never fixed sleeps (the E2E
// discipline in motir-core/CLAUDE.md; notes.html #37).
//
// ⚠️ AMENDED by MOTIR-3163 (bug MOTIR-3154) — the browser-level proof that a
// DECIDED plan still shows its cards. The defect was distributed across the
// whole stack (rows deleted in a service, the pane swapped on a page, the
// treatment missing from a component, the overlay cleared in a hook), so four
// green unit suites was exactly the state the product was in when the cards
// disappeared. Only this layer can answer what a person SEES after they click.
//
// The assertion worth protecting most is the one that stays NEGATIVE: retaining
// a declined plan's proposals must never put them in the tree. A change that
// made the cards visible by quietly materializing them would satisfy the report
// and destroy the feature, so the declined proposal's absence from the ready set
// is untouched and must stay that way.

import { expect, test } from '@playwright/test';

import { plansService } from '@/lib/services/plansService';

import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import {
  seedPlansReview,
  seedEmptyPlansProject,
  PLANS_SEED_PASSWORD,
  PLAN_SUMMARY_UNBREAKABLE_TOKEN,
} from './_helpers/plans-review-seed';

// Service-side seeding of a whole tenant + tree + three plans, plus the sign-in
// flow and the canvas render, comfortably exceeds the 30s default.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

test('Plans: nav → list → stale detail → approve-anyway → decline', async ({ page }) => {
  const seed = await seedPlansReview('plans-review@example.com');
  await signIn(page, seed.email, PLANS_SEED_PASSWORD);

  // ── 1. The "Plans" left-nav entry → the list ──────────────────────────────
  const plansNav = page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Plans' });
  await expect(plansNav).toBeVisible();
  await plansNav.click();
  await page.waitForURL('**/plans');

  // `/plans` lists planning CONVERSATIONS since MOTIR-6025, every one under the
  // default `All` filter; each seeded plan rode `createPlan`, so each is its own
  // conversation, and a row's chip is its plan's link, named for its state.
  const list = page.getByRole('list', { name: 'Planning conversations' });
  await expect(list).toBeVisible();

  // ⚠️ The row no longer carries the "N may be out of date" advisory — the
  // session row names the conversation, not the plan's drift. The count is
  // asserted where it lives, on the rail's summary below (MOTIR-3777's TWO).
  //
  // ⚠️ RE-POINTED by Story MOTIR-7883 (MOTIR-7889), 2026-10-08: an UNDECIDED plan's
  // chip is an overlay door now — its href is the overlay address, never
  // `/plans/<id>` — so it is found by its row (titled by the plan, since its
  // conversation has no turns) and its accessible name, not by an `a[href]`.
  const staleRow = list
    .getByRole('listitem')
    .filter({ hasText: 'Q3 onboarding & settings' })
    .getByRole('link', { name: 'Open the plan — Waiting for approval' });
  await expect(staleRow).toBeVisible();

  // …and the approved plan's conversation sits in the same list, with its own
  // state. The `Approved` filter holds it too.
  //
  // ⚠️ AMENDED by Story MOTIR-6043 · MOTIR-6045 (design Part XXI § 21.5): a DECIDED
  // row's chip is a plain label, because the ROW itself now opens `/plans/<id>` and a
  // chip link would be a second door to the same place. So the `a[href]` below is the
  // row's own door, and what it is named is the conversation, not the chip's sentence.
  const approvedRow = page
    .getByRole('listitem')
    .filter({ has: page.locator(`a[href="/plans/${seed.approvedPlan.id}"]`) });
  await expect(approvedRow).toContainText('Approved');
  await expect(approvedRow.getByTestId('plan-destination')).toContainText('Opens the plan');
  await page.goto('/plans?planState=approved');
  await expect(page.locator(`a[href="/plans/${seed.approvedPlan.id}"]`)).toBeVisible();

  // ── 2. Enter the stale plan → the planning overlay ────────────────────────
  //
  // ⚠️ RE-POINTED by Story MOTIR-7883 (MOTIR-7889), 2026-10-08: the chip opens the
  // undecided plan in the planning overlay IN PLACE, over the Plans list — the URL
  // gains the overlay's session and the overlay's plan pane renders.
  await page.goto('/plans');
  await staleRow.click();
  await page.waitForURL((url) => url.pathname === '/plans' && url.searchParams.has('planSession'));
  const overlay = page.getByRole('dialog', { name: /plan/i });
  await expect(overlay.getByTestId('plan-proposal-views')).toBeVisible();

  // ⚠️ RETIRED 2026-10-08 by Story MOTIR-7883 (MOTIR-7889): the undecided rail's
  // `Ready to review` pill and its `Awaiting your review` row — the review rail is
  // drawn only on the plan PAGE, and an undecided plan opens in the overlay. The
  // decided rail's own timeline rows are read after the approve below; the undecided
  // pill and pending row are still covered by
  // tests/components/plan-review-rail-status-overline.test.tsx and
  // plan-review-rail-content-events.test.tsx.

  // ⚠️ THE CANVAS IS ASKED FOR, NOT ASSUMED (MOTIR-3262). The detail's default
  // body is DERIVED from the plan's shape: the LIST when its proposals sit under
  // more than one distinct container, because no single canvas level can show
  // such a plan. THIS plan is exactly that — its two adds hang under two
  // different committed parents — so it opens on the list, and every canvas
  // assertion below is about the canvas, so the spec switches to it. (The
  // overlay's view is local and never read off `?view=`.)
  await overlay
    .getByRole('group', { name: 'Plan view' })
    .getByRole('button', { name: 'Canvas', exact: true })
    .click();
  await expect(overlay.getByTestId('planning-canvas')).toBeVisible();

  // The proposed items render on the canvas (with a stale badge on the drifted
  // ones) — the canvas MOUNTS the proposed PlanItems, it doesn't redraw a tree.
  await expect(overlay.getByRole('application', { name: 'Plans Review plan' })).toBeVisible();
  await expect(overlay.getByTestId('plan-item-node').first()).toBeVisible();
  await expect(overlay.getByTestId('stale-badge').first()).toBeVisible();

  // ⚠️ RETIRED 2026-10-08 by Story MOTIR-7883 (MOTIR-7887): the per-plan staleness
  // summary — each drifted item with its own reason, and MOTIR-3777's guard that a
  // new sibling under a busy parent flags nothing — is the review rail's, which
  // draws it only on an UNDECIDED plan's page, and an undecided plan now opens in
  // the overlay. Still covered by tests/integration/plans/planStalenessService.test.ts
  // (the reasons, MOTIR-3777 included) and tests/components/plan-folder-placement.test.tsx
  // / plan-review-rail-fold.test.tsx (the summary's rendering).
  //
  // ⚠️ RETIRED 2026-10-08 by Story MOTIR-7883 (MOTIR-7887): the stale-warning
  // confirm ("Some items may be out of date" → "Approve anyway") belongs to the
  // plan page's own approve CTA; the overlay's Approve decides without it. Nothing
  // else covers that confirm in a browser.

  // ── 3. Approve, in the overlay's decision footer ──────────────────────────
  // Arm the response wait BEFORE the click so the persisted flip can't be missed.
  const approveResponse = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/plans/${seed.stalePlan.id}/approve`) &&
      r.request().method() === 'POST',
  );
  await overlay
    .getByTestId('plan-change-confirm-bar')
    .getByRole('button', { name: 'Approve', exact: true })
    .click();
  expect((await approveResponse).status()).toBe(200);

  // The plan is now DECIDED, and a decided plan's page is its record: everything
  // below reads that page, on the canvas the MOTIR-3161 assertions are about.
  await page.goto(`/plans/${seed.stalePlan.id}?view=canvas`); // decided: the plan page renders
  const main = page.getByRole('main');

  // The plan flips to approved (status pill + the materialize outcome).
  await expect(main.getByTestId('plan-status-pill')).toContainText('Approved');
  await expect(main.getByText(/Added .* to your backlog/)).toBeVisible();

  // The history timeline — read on the decided page since MOTIR-7883, where the
  // plan's record keeps every row it gathered while it waited.
  await expect(main.getByText('Generation started')).toBeVisible();
  await expect(main.getByText('Plan ready')).toBeVisible();

  // ⚠️ THE RAIL DOES NOT SCROLL SIDEWAYS (MOTIR-4578), and this is the ONLY lane
  // that can say so. The transcript's scroller stated one overflow axis, which
  // CSS Overflow 3 computes the other to `auto`, and the plan SUMMARY — an
  // agent-written planning turn — rendered with no wrap guard: one unbreakable
  // token wider than the 311px text column drew a scrollbar across the whole
  // 22rem rail. The unit guard
  // (`tests/components/plan-review-rail-overflow.test.tsx`) asserts the
  // MECHANISM, because happy-dom does no layout and `0 === 0` is green on the
  // broken component. The GEOMETRY is only measurable here, in a real browser at
  // the real track width, so this is where it is asserted.
  //
  // The seed's summary carries that token, so the numbers below are read on
  // content that WOULD overflow: equality is the fix working, not the fixture
  // being tame. (Read on the DECIDED page since MOTIR-7883: the summary is drawn
  // whatever the plan's state, so the geometry is the same rail's.)
  const transcript = main.getByTestId('plan-review-transcript');
  await expect(transcript).toContainText(PLAN_SUMMARY_UNBREAKABLE_TOKEN);
  const overflow = await transcript.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(overflow.scrollWidth).toBe(overflow.clientWidth);

  // ── MOTIR-3161 / MOTIR-3165 (bug MOTIR-3154) — an APPROVED plan still SHOWS
  //    what was approved, on the cards it became, and stops warning about it ──
  //
  // The whole of the reported defect, at the browser: the four cards the user
  // approved a second earlier used to be nowhere on this page. They are here,
  // marked accepted, ON the committed work items — and the page is quiet.
  const acceptedNodes = main.getByTestId('plan-item-node');
  await expect(acceptedNodes.first()).toBeVisible();
  // Queried by TEXT, so a colour-only treatment cannot pass.
  await expect(main.getByTestId('plan-item-outcome-tab').first()).toHaveText('accepted');

  // ONE node per approved `add`, carrying the REAL identifier its materialized
  // work item was given — which is what proves the node landed ON the committed
  // card rather than beside it as a second, keyless ghost.
  const materialized = await adminDb.workItem.findFirstOrThrow({
    where: { projectId: seed.projectId, title: seed.cleanProposalUnderBusyParent },
  });
  const acceptedCard = main
    .getByTestId('plan-item-node')
    .filter({ hasText: materialized.identifier });
  await expect(acceptedCard).toHaveCount(1);
  // The outcome hangs on the card's top edge, a sibling of the frame and so
  // outside `plan-item-node` (MOTIR-11545) — read from the card's wrapper.
  await expect(acceptedCard.locator('..').getByTestId('plan-item-outcome-tab')).toHaveText(
    'accepted',
  );

  // Guarded on ABSENCE (the coding convention § E2E): a DECIDED plan can never be decided
  // again, so every staleness warning on it is advice about a choice nobody can
  // make. Both surfaces must be quiet. (The warnings such a plan used to carry
  // were caused BY the approval, since the cards it created under one parent
  // counted as unexplained new siblings against each other — MOTIR-3777 retired
  // that rule, and MOTIR-3165's status guard, asserted here, is what still holds
  // the line for every reason that remains.)
  await expect(main.getByTestId('stale-summary')).toHaveCount(0);
  await expect(main.getByTestId('stale-badge')).toHaveCount(0);

  // The bundle became real, dispatchable work: the cleanly-materialized add
  // (under the still-living parent) appears in the ready set. That parent is a
  // story over subtasks, so /ready shows it as ONE collapsed container row
  // (MOTIR-6829) — expand it to reach the leaf.
  const busyParent = await adminDb.workItem.findUniqueOrThrow({
    where: { id: materialized.parentId! },
  });
  await page.goto('/ready');
  await page.getByRole('button', { name: `Expand ${busyParent.identifier}` }).click();
  await expect(
    page
      .getByRole('list', { name: 'Ready work items' })
      .getByText(seed.cleanProposalUnderBusyParent),
  ).toBeVisible();

  // ── 4. Decline branch on the clean plan ───────────────────────────────────
  //
  // The canvas is asked for even though this plan's proposals sit under ONE
  // container and the canvas is therefore already its default (MOTIR-3262): the
  // assertions below are about the canvas, and a spec that relies on a DERIVED
  // default is a spec that silently changes subject when the fixture changes
  // shape by one proposal.
  //
  // ⚠️ RE-POINTED by Story MOTIR-7883 (MOTIR-7887), 2026-10-08: the clean plan is
  // undecided, so it is declined where it is decided — the overlay's footer, whose
  // Decline confirms once with the same optional-reason band.
  const declineOverlay = await openUndecidedPlan(page, seed.declinePlan.id, { view: 'canvas' });

  const declineResponse = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/plans/${seed.declinePlan.id}/decline`) &&
      r.request().method() === 'POST',
  );
  await declineOverlay
    .getByTestId('plan-change-confirm-bar')
    .getByRole('button', { name: 'Decline', exact: true })
    .click();
  // An ASKED plan's Decline confirms once, with an OPTIONAL reason (MOTIR-6037).
  await declineOverlay
    .getByTestId('plan-decline-confirm')
    .getByRole('button', { name: 'Yes, decline' })
    .click();
  expect((await declineResponse).status()).toBe(200);

  // Decline DROPS every proposed item, but a DECIDED plan still shows its outcome
  // in the review rail — the declined-outcome rail, NOT the "no proposals" empty
  // state (MOTIR-1377: the empty guard used to shadow the rail's declined branch
  // for a zero-item declined plan).
  await page.goto(`/plans/${seed.declinePlan.id}?view=canvas`); // decided: the plan page renders
  await expect(main.getByTestId('plan-status-pill')).toContainText('Declined');
  await expect(main.getByText('Plan declined — your tree was left untouched')).toBeVisible();

  // ── MOTIR-3160 / MOTIR-3161 (bug MOTIR-3154) — …ALONGSIDE the cards ────────
  //
  // The comment above used to open "Decline DROPS every proposed item". It no
  // longer does: not writing to the tree is what declining MEANS, and erasing
  // the proposal was a separate act that destroyed the only record of what was
  // offered and refused. The MOTIR-1377 outcome assertion above is UNCHANGED in
  // meaning and still passes; what is new is that it now stands beside the cards
  // it decided about.
  const declinedCard = main.getByTestId('plan-item-node').filter({ hasText: seed.declineProposal });
  await expect(declinedCard).toHaveCount(1);
  // By TEXT, not by a class — a colour-only treatment must not pass here either.
  // The outcome hangs on the card's top edge, a sibling of the frame and so
  // outside `plan-item-node` (MOTIR-11545) — read from the card's wrapper.
  await expect(declinedCard.locator('..').getByTestId('plan-item-outcome-tab')).toHaveText(
    'declined',
  );
  // It never became anything, so it has no key to show and none is invented.
  await expect(declinedCard).toContainText('New');

  // The list also reflects the declined status on its chip — a plain label now, with
  // the row's own door going to the plan page (Story MOTIR-6043 · MOTIR-6045, § 21.5).
  await page.goto('/plans?planState=declined');
  const declinedRow = page
    .getByRole('listitem')
    .filter({ has: page.locator(`a[href="/plans/${seed.declinePlan.id}"]`) });
  await expect(declinedRow).toContainText('Declined');
  await expect(declinedRow.getByTestId('plan-destination')).toContainText('Opens the plan');

  // Declining a bundle of proposed adds leaves the tree untouched — the proposed
  // item was never materialized, so it's absent from the ready set.
  await page.goto('/ready');
  await expect(
    page.getByRole('list', { name: 'Ready work items' }).getByText(seed.declineProposal),
  ).toHaveCount(0);
});

test('Plans: empty state shows the generate-your-first-plan CTA', async ({ page }) => {
  const empty = await seedEmptyPlansProject('plans-empty@example.com');
  await signIn(page, empty.email, PLANS_SEED_PASSWORD);

  await page.goto('/plans');
  await expect(
    page.getByRole('heading', { name: 'Nothing has reached planning yet' }),
  ).toBeVisible();
  await expect(
    page.getByRole('main').getByText('A conversation appears here once it reaches planning.'),
  ).toBeVisible();
});

// MOTIR-3073 — a project that ALREADY HAS CODE must land on its new items, not on
// the code-hosting step. The defect: `proposeRepositorySet`'s only gate asked "has
// this project's set been proposed before?", which is always false for a project
// that arrived through the migrate path (that path records its repository on the
// onboarding run and never writes the set table). So approval proposed a starter
// repo, the step took the canvas the approved plan's items belong on, and the row
// it created became the project's whole repo-pin domain.
//
// Guarded on ABSENCE (the coding convention § E2E): the assertion is that the hosting step's
// heading is NOT there. Asserting some other thing IS there would pass while the
// step rendered beside it.
test('Plans: approving on a project that already has code shows the items, not the hosting step', async ({
  page,
}) => {
  const seed = await seedPlansReview('plans-review-has-code@example.com');

  // The project ARRIVED with its code — the migrate path's record, which is the
  // project-scoped signal the proposer's gate reads.
  // `adminDb`: `migrate_onboarding` is RLS-bound to the active workspace GUC, which
  // a spec's own client does not set — seeding goes through the superuser client.
  await adminDb.migrateOnboarding.create({
    data: {
      workspaceId: seed.workspaceId,
      projectId: seed.projectId,
      step: 'done',
      status: 'completed',
      connectedRepoRef: 'acme/existing-app',
      codeGraphReady: true,
    },
  });

  await signIn(page, seed.email, PLANS_SEED_PASSWORD);
  // ⚠️ RE-POINTED by Story MOTIR-7883 (MOTIR-7887), 2026-10-08: the plan is
  // undecided, so it is approved in the overlay's footer — the same approve route,
  // and the same server-side `proposeRepositorySet` gate this test is about.
  const overlay = await openUndecidedPlan(page, seed.declinePlan.id);

  const approveResponse = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/plans/${seed.declinePlan.id}/approve`) &&
      r.request().method() === 'POST',
  );
  await overlay
    .getByTestId('plan-change-confirm-bar')
    .getByRole('button', { name: 'Approve', exact: true })
    .click();
  expect((await approveResponse).status()).toBe(200);

  // Approved — and the plan's page, which is where the hosting step's band is
  // drawn from the server's proposed set, is the surface under test. It no longer
  // follows the approve WITHOUT a navigation (the approve happens in the overlay),
  // so the band's absence is read on the decided page's fresh render.
  await page.goto(`/plans/${seed.declinePlan.id}`); // decided: the plan page renders
  const main = page.getByRole('main');
  await expect(main.getByTestId('plan-status-pill')).toContainText('Approved');

  // The hosting step is ABSENT …
  await expect(main.getByText('Motir will host your code')).toHaveCount(0);
  // … and the canvas is still showing the plan's own items.
  await expect(main.getByText(seed.declineProposal)).toBeVisible();

  // ⚠️ READ against Part VI §4 by MOTIR-3163, and UNCHANGED — deliberately.
  // Part VI re-decides what the pane holds when a set IS proposed: the step now
  // takes a BAND above the canvas instead of replacing it. This project arrives
  // with code, so `proposeRepositorySet`'s gate proposes NOTHING and there is no
  // band to draw — the absence assertion above is about a step that was never
  // summoned, not about a step that was replaced. Both assertions therefore mean
  // exactly what they meant before, and the count below still pins the durable
  // half. The BAND's own case is pinned by the `PlanDetail` component test.
  await expect(main.getByTestId('plan-detail-establish-band')).toHaveCount(0);

  // And nothing was provisioned: the visible half of this defect was a screen, the
  // durable half was a row that should never have existed.
  expect(await adminDb.projectRepo.count({ where: { projectId: seed.projectId } })).toBe(0);
});

// MOTIR-3074 — the rail's status tag COLLIDED with the plan title. Plan titles are
// GENERATED: long by default, and routinely carrying an unbreakable token (a
// SCREAMING_CASE constant, a cuid). The title and a `shrink-0` pill shared one
// `flex items-center` row, so the title wrapped to five lines while the one-line
// pill stayed centred against the block — the tag landed inside the title's text
// column — and the title's own min-content (its longest word) pushed the `<aside>`
// past its fixed 22rem track.
//
// This is the GEOMETRY half of the fix, and it lives here rather than in a
// component test on purpose: happy-dom reports all-zero geometry, so
// `tests/components/plan-review-rail-status-overline.test.tsx` can only pin the
// STRUCTURE. Measured at the SHIPPED rail width (the real 22rem column of the real
// page), not at a full-page viewport — a page-level `scrollWidth` check passes
// while the rail overflows inside its own scroll container.
test('Plans: a long unbreakable title never overflows the rail, and the status tag stays clear of it', async ({
  page,
}) => {
  const seed = await seedPlansReview('plans-review-long-title@example.com');

  // The reported title, both unbreakable tokens intact: a SCREAMING_CASE constant
  // and a 25-character cuid. `adminDb` — `plan` is RLS-bound to the active
  // workspace GUC, which a spec's own client does not set.
  const LONG_TITLE =
    'Mirror the sweep-is-not-its-grep-pattern limb into SHARED_PLANNING_RULES (motir-ai) — supersedes plan cmszanri500bfi3phws7wdiu8';
  await adminDb.plan.update({
    where: { id: seed.declinePlan.id },
    data: { title: LONG_TITLE },
  });

  // ⚠️ DECIDED FIRST (Story MOTIR-7883 · MOTIR-7887, 2026-10-08): an undecided plan
  // now opens in the planning overlay, which has no review rail. The rail — title,
  // status tag and all — is the same rail on a decided plan's page, so the geometry
  // is measured there.
  await plansService.declinePlan(seed.declinePlan.id, {
    userId: seed.userId,
    workspaceId: seed.workspaceId,
  });

  await signIn(page, seed.email, PLANS_SEED_PASSWORD);
  await page.goto(`/plans/${seed.declinePlan.id}`); // decided: the plan page renders

  const rail = page.getByRole('complementary', { name: 'Plan review' });
  await expect(rail).toBeVisible();
  const pill = rail.getByTestId('plan-status-pill');
  await expect(pill).toContainText('Declined');
  const heading = page.getByRole('heading', { level: 2, name: LONG_TITLE });
  await expect(heading).toBeVisible();

  const geometry = await rail.evaluate((el) => {
    const h2 = el.querySelector('h2') as HTMLElement;
    const tag = el.querySelector('[data-testid="plan-status-pill"]') as HTMLElement;
    const railBox = el.getBoundingClientRect();
    const titleBox = h2.getBoundingClientRect();
    const tagBox = tag.getBoundingClientRect();
    const padRight = parseFloat(getComputedStyle(el).paddingRight);
    return {
      railOverflow: el.scrollWidth - el.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // How far the title's box runs past the rail's padded content edge.
      titleOverhang: titleBox.right - (railBox.right - padRight),
      // The title genuinely WRAPS here — otherwise this asserts nothing. Counted
      // off the rendered line boxes rather than height/line-height, which returns
      // NaN whenever `line-height` computes to `normal`.
      titleLines: (() => {
        const range = document.createRange();
        range.selectNodeContents(h2);
        return range.getClientRects().length;
      })(),
      // The defect, stated as geometry: the tag's box inside the title's rows.
      tagOverlapsTitle: !(
        tagBox.bottom <= titleBox.top + 0.5 || tagBox.top >= titleBox.bottom - 0.5
      ),
    };
  });

  // No horizontal overflow — of the rail's own scroll container, or of the page.
  expect(geometry.railOverflow).toBeLessThanOrEqual(1);
  expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
  // The title stays inside the rail's content column …
  expect(geometry.titleOverhang).toBeLessThanOrEqual(1);
  // … while actually wrapping (a one-line title would make the rest vacuous) …
  expect(geometry.titleLines).toBeGreaterThan(1);
  // … and no text runs under the tag.
  expect(geometry.tagOverlapsTitle).toBe(false);
});
