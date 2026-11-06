// E2E: the Story-5.5 activity History + All journeys (Subtask 5.5.5) — the
// Story CLOSER, driving the real stack. Two passes:
//
//   1. @smoke journey — manufacture an issue history (rank-reorder noise, a
//      label, a select custom field, a sprint move and an attachment record
//      server-side through the shipped services; then a priority edit, a
//      workflow transition, a link add and a comment add+delete through the
//      browser UI) and read it back on the History tab: entries render as the
//      designed sentences (spot-asserts: the created anchor, the status
//      workflow-label Pill pair, the link identifier, the comment-deletion
//      entry with NO content), pure rank reorders never reach the feed or its
//      count (the noise policy — the trail keeps the rows), the All tab
//      interleaves the live comment (native grammar, actions intact) with the
//      quiet history rows, the ONE sort toggle flips every tab together, and
//      tab choice is URL-driven with Comments as the default.
//   2. At-scale (finding #57) — a 220-revision / 50-comment fixture: each tab
//      first-paints ONE page behind its "Show more" edge, extending appends a
//      cursor page, and no activity read ever exceeds the page size (the All
//      tab's composite cursor pages BOTH sources bounded; never load-all).
//
// The strict axe sweep over the populated History + All states extends
// shell-a11y.spec.ts (the 5.1.7 precedent). Selectors target the stable
// role/label hooks the 5.5.4 components expose (the "Activity filter" group,
// the "History" / "All activity" feeds, the "Show more changes/activity
// (N older)" edges, the sort toggle's aria-label) — never markup.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { seedCommentsFixture } from './_helpers/comments-seed';
import { manufactureServerSideHistory, seedScaleActivity } from './_helpers/activity-seed';
import { actionWrite as sharedActionWrite, pageRefresh } from './_helpers/authoritative-signal';

// Browser sign-up + the manufacture walk + several tab loads: comfortably
// more than the 30s default (the comments closer uses the same ceiling).
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** The History feed (ul[aria-label="History"]). */
function historyFeed(page: Page) {
  return page.getByRole('list', { name: 'History' });
}

/** The All feed (ul[aria-label="All activity"]). */
function allFeed(page: Page) {
  return page.getByRole('list', { name: 'All activity' });
}

/** Switch tabs through the section's Segmented filter. */
async function switchTab(page: Page, tab: 'All' | 'Comments' | 'History') {
  await page
    .getByRole('group', { name: 'Activity filter' })
    .getByRole('button', { name: tab, exact: true })
    .click();
}

/**
 * Click a feed's "Show more" edge and wait for the next-count edge to render.
 *
 * Retries the click: the detail page's relative-time stamps can mismatch
 * between SSR and client (finding #89 — the next-intl ENVIRONMENT_FALLBACK),
 * which hydration-fails the page and makes React REGENERATE the client tree;
 * a click dispatched into the pre-regeneration DOM is silently dropped (this
 * is exactly how the at-scale pass died in CI while green locally). The loop
 * re-clicks only while the old edge is still showing, so a click that DID
 * land (old edge gone, fetch in flight) is never doubled.
 */
async function extendFeed(page: Page, fromName: string, toName: string) {
  const from = page.getByRole('button', { name: fromName });
  const to = page.getByRole('button', { name: toName });
  await expect(async () => {
    if (await from.isVisible()) await from.click();
    await expect(to).toBeVisible({ timeout: 2_500 });
  }).toPass({ timeout: 20_000 });
}

// ── The authoritative signals this journey's writes commit through ─────────
// (MOTIR-3694 — the coding convention § *E2E tests wait on the AUTHORITATIVE signal*.)
//
// ⚠️ MOTIR-4399 LIFTED BOTH OF THESE into `_helpers/authoritative-signal.ts`,
// unchanged, so the next spec that needs them imports them instead of
// re-deriving them — which is exactly what 3694's file-bounded sweep left
// undone. The two local aliases below keep every call site in this file byte
// for byte what it was: the module's parameter is a PATHNAME rather than an
// identifier, and these bind it. Read the module for the contract — why the URL
// cannot be the predicate, why the status is deliberately not tested, and when
// a refresh wait is the WRONG remedy.
//
// ⚠️ THE URL CANNOT BE THE PREDICATE ON THIS PAGE. Every mutation here is a
// Server Action, and Next transports those as a POST to the CURRENT page URL
// carrying a `next-action` header — so the priority edit, the status
// transition, the link picker's candidate search, the link add, each comment
// add and the comment delete are ALL `POST /items/<key>`, indistinguishable by
// url + method. The discriminator has to be the request BODY, which encodes the
// action's own arguments. Observed, in order, on one run of this journey:
//
//   [{"id":…,"expectedUpdatedAt":…,"priority":"high"}]   updateIssueAction
//   [{"id":…,"toStatusKey":"in_progress"}]               changeStatusAction
//   [<currentItemId>,"blocked_by","Blocker"]             listLinkCandidatesAction
//   [{…,"targetId":<blocker id>,"relationship":"blocked_by"}]  createLinkAction
//
// Note the third and fourth both carry `"blocked_by"`: the RELATIONSHIP is not
// a discriminator, the blocker's own id is.

/** This page's Server-Action write, by a marker in its arguments. */
function actionWrite(page: Page, identifier: string, marker: string) {
  return sharedActionWrite(page, `/items/${identifier}`, marker);
}

/**
 * Resolve when the detail page's own `router.refresh()` re-render lands.
 *
 * The 200 from a write is not the whole signal for anything this page renders
 * from the SERVER — the activity feed, the history, every count outside the
 * relationships panel. Those are repainted by THIS request, not by the action's
 * response. (Which is why the MOTIR-3694 error-context snapshot shows a CLOSED
 * dialog above an empty rail: that is what a completed write with an unlanded
 * refresh looked like.)
 *
 * ⚠️ MOTIR-4496 — the RELATIONSHIPS RAIL is no longer one of them, and this
 * helper is no longer the way to wait for it. `RelationshipsPanel` inserts and
 * removes its rows OPTIMISTICALLY and takes its readiness verdict from the
 * action's own response, so a link row is on screen before this GET is even
 * issued. The refresh still runs, still reconciles, and is still what this
 * helper waits for — it is simply no longer what paints the rail.
 */
function detailPageRefresh(page: Page, identifier: string) {
  return pageRefresh(page, `/items/${identifier}`);
}

/** Post a root comment through the real composer (the 5.1.5 surface). */
async function postComment(page: Page, identifier: string, text: string) {
  await page.getByRole('button', { name: 'Add a comment…' }).click();
  await expect(page.locator('.ProseMirror')).toBeVisible();
  await page.locator('.ProseMirror').click();
  await page.keyboard.type(text);
  // `bodyMd` carries the text verbatim, so it names THIS comment's write.
  const posted = actionWrite(page, identifier, text);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  expect((await posted).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Add a comment…' })).toBeVisible();
}

test('@smoke history journey: manufactured trail → designed sentences, noise policy, All interleave, cross-tab sort', async ({
  page,
}) => {
  const fx = await seedCommentsFixture(
    page,
    'e2e-activity-pm@example.com',
    'e2e-activity-bo@example.com',
  );
  // Server-side manufacture FIRST (rank noise → label → custom field →
  // sprint → attachment), so the UI actions below land newest in the trail.
  const made = await manufactureServerSideHistory(fx);

  // ── The browser half of the history: rail edits + link + comments ───────
  await page.goto(`/items/${fx.issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'Commented task', level: 1 })).toBeVisible();

  // The DEFAULT tab is Comments (the Jira default): the composer invitation
  // renders, no History feed, and no ?activity= in the URL.
  await expect(page.getByRole('button', { name: 'Add a comment…' })).toBeVisible();
  await expect(historyFeed(page)).toHaveCount(0);
  expect(page.url()).not.toContain('activity=');

  // Priority medium → high through the rail's field box. `expectedUpdatedAt`
  // is `updateIssueAction`'s concurrency check and no other action sends it.
  await page.getByRole('button', { name: 'Edit Priority' }).click();
  await page.getByRole('combobox', { name: 'Priority' }).click();
  const priorityWritten = actionWrite(page, fx.issue.identifier, 'expectedUpdatedAt');
  await page.getByRole('option', { name: 'High', exact: true }).click();
  expect((await priorityWritten).status()).toBe(200);
  await expect(page.getByText('High', { exact: true })).toBeVisible();

  // Workflow transition To Do → In Progress (`changeStatusAction`, the only
  // action carrying `toStatusKey`).
  await page.getByRole('button', { name: 'Edit Status' }).click();
  await page.getByRole('combobox', { name: 'Status' }).click();
  const statusWritten = actionWrite(page, fx.issue.identifier, 'toStatusKey');
  await page.getByRole('option', { name: 'In Progress' }).click();
  expect((await statusWritten).status()).toBe(200);
  // The rail's value — the header eyebrow names the status too (MOTIR-10534).
  await expect(
    page.getByRole('complementary').getByText('In Progress', { exact: true }),
  ).toBeVisible();

  // Link the blocker (the default Blocked-by relationship). The picker is
  // query-driven (Subtask 6.9.2 — closes finding #98): TYPE to load candidates,
  // it no longer prefetches a window.
  await page.getByRole('button', { name: 'Link work item' }).click();
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await page.getByRole('combobox', { name: /Search by identifier or title/ }).fill('Blocker');
  await page.getByRole('option', { name: /Blocker issue/ }).click();
  // The blocker's id rides ONLY on `createLinkAction`'s `targetId` — the
  // candidate search above carries `"blocked_by"` too, so the relationship
  // would match the wrong POST. And the rail below is painted by the refresh
  // that `submit()` fires AFTER the write, so both are awaited: the write's
  // 200, then the re-render that renders the row being asserted.
  const linkWritten = actionWrite(page, fx.issue.identifier, made.blocker.id);
  const railRepainted = detailPageRefresh(page, fx.issue.identifier);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  expect((await linkWritten).status()).toBe(200);
  expect((await railRepainted).status()).toBe(200);
  await expect(page.getByRole('link', { name: /Blocker issue/ })).toBeVisible();

  // Two comments; delete the second → a comment_deleted revision whose
  // CONTENT must never surface anywhere in the feeds.
  await postComment(page, fx.issue.identifier, 'First note stays live');
  await postComment(page, fx.issue.identifier, 'Second note gets deleted');
  const doomed = page
    .getByRole('list', { name: 'Comments' })
    .getByRole('listitem')
    .filter({ hasText: 'Second note gets deleted' });
  await doomed.getByRole('button', { name: 'Delete', exact: true }).first().click();
  // `deleteCommentAction` is the only write in this journey sending `commentId`.
  const deleted = actionWrite(page, fx.issue.identifier, 'commentId');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  expect((await deleted).status()).toBe(200);
  await expect(page.getByText('Second note gets deleted')).toHaveCount(0);

  // ── The History tab: every manufactured change as its designed sentence ──
  await page.goto(`/items/${fx.issue.identifier}?activity=history`);
  const feed = historyFeed(page);
  await expect(feed).toBeVisible();

  // The displayable set: created + label + custom field + sprint +
  // attachment + priority + status + link + comment-deleted = 9 entries.
  // The count gloss agrees — the suppressed rank writes are absent from
  // BOTH the feed and the count (the noise policy)…
  await expect(page.getByText('9 changes')).toBeVisible();
  await expect(feed.locator('> li')).toHaveCount(9);
  await expect(feed.getByText('backlogRank')).toHaveCount(0);
  // …while the append-only trail still holds every row (the DB keeps what
  // the feed hides — created + 9 displayable-1 + 2 issue-side rank writes).
  const raw = await db.workItemRevision.count({ where: { workItemId: fx.issue.id } });
  expect(raw).toBeGreaterThan(9);

  // Default sort is oldest-first: the created anchor leads the feed.
  await expect(feed.locator('> li').first()).toContainText('created the work item');

  // Spot-asserts, per change type (the 5.5.3 row grammar):
  // status — the workflow LABEL Pill pair, never raw keys.
  await expect(feed.getByText('To Do', { exact: true })).toBeVisible();
  await expect(feed.getByText('In Progress', { exact: true })).toBeVisible();
  // scalar — old value struck, new emphasised (stored forms).
  await expect(feed.getByText('medium', { exact: true })).toBeVisible();
  await expect(feed.getByText('high', { exact: true })).toBeVisible();
  // link — the mono identifier as a real link + the relationship kind.
  await expect(feed.getByRole('link', { name: made.blocker.identifier })).toBeVisible();
  await expect(feed.getByText('is blocked by')).toBeVisible();
  // label chip + the select custom field (stored key + option LABEL).
  await expect(feed.getByText(made.labelName, { exact: true })).toBeVisible();
  await expect(feed.getByText(made.fieldKey, { exact: true })).toBeVisible();
  await expect(feed.getByText(made.optionLabel, { exact: true })).toBeVisible();
  // the custom field's empty from-side renders the "None" form.
  await expect(feed.getByText('None', { exact: true }).first()).toBeVisible();
  // sprint move — the resolved NAME (its rank half stays suppressed). The
  // row carries the name twice by design (sentence + values line) — .first().
  await expect(feed.getByText(/moved this work item to/)).toBeVisible();
  await expect(feed.getByText(made.sprintName, { exact: true }).first()).toBeVisible();
  // attachment — the recorded filename.
  await expect(feed.getByText(made.attachmentName, { exact: true })).toBeVisible();
  // comment deletion — who/when + the gloss, NEVER the content; and history
  // carries no live comment bodies (adds stay under Comments/All).
  await expect(feed.getByText(/deleted a comment/)).toBeVisible();
  await expect(feed.getByText(/content not retained/)).toBeVisible();
  await expect(feed.getByText(/Second note gets deleted/)).toHaveCount(0);
  await expect(feed.getByText(/First note stays live/)).toHaveCount(0);
  // read-only: no entry carries any action affordance.
  await expect(feed.getByRole('button', { name: /Edit|Delete|Reply/ })).toHaveCount(0);

  // ── The ONE sort toggle flips the section, and it spans the tabs ─────────
  await page.getByRole('button', { name: 'Sort activity, oldest first' }).click();
  await expect(page.getByRole('button', { name: 'Sort activity, newest first' })).toBeVisible();
  await expect(feed.locator('> li').first()).toContainText('deleted a comment');
  await expect(feed.locator('> li').last()).toContainText('created the work item');

  // ── The All tab: true-order interleave, each entry in its native grammar ──
  await switchTab(page, 'All');
  await expect(page).toHaveURL(/activity=all/);
  const all = allFeed(page);
  await expect(all).toBeVisible();
  await expect(page.getByText('1 comment · 9 changes')).toBeVisible();

  // The flipped order PERSISTED across the tab switch (newest first): the
  // comment deletion — a history entry — leads; the created anchor closes.
  await expect(all.locator('> li').first()).toContainText('deleted a comment');
  await expect(all.locator('> li').last()).toContainText('created the work item');

  // The live comment interleaves in its NATIVE grammar — body + live action
  // row — among the quiet history rows; the deleted one appears exactly once
  // (as history), never as a comment.
  const commentRow = all.getByRole('listitem').filter({ hasText: 'First note stays live' });
  await expect(
    commentRow.getByRole('button', { name: 'Reply', exact: true }).first(),
  ).toBeVisible();
  await expect(all.getByText(/Second note gets deleted/)).toHaveCount(0);
  await expect(all.getByText(/deleted a comment/)).toHaveCount(1);
  // History rows in All stay read-only — the only action rows are the
  // comment's (Reply / Edit / Delete on the one live comment).
  await expect(all.getByText(made.attachmentName, { exact: true })).toBeVisible();

  // ── Back to Comments: the default tab clears the URL param ──────────────
  await switchTab(page, 'Comments');
  await expect(page.getByRole('list', { name: 'Comments' })).toBeVisible();
  await expect(page).not.toHaveURL(/activity=/);
  // The 5.1.5 surface is intact: the live comment renders with its actions.
  await expect(page.getByText('First note stays live')).toBeVisible();
});

test('at scale each tab stays cursor-paged: one page + "Show more", bounded reads on both sources (finding #57)', async ({
  page,
}) => {
  const fx = await seedCommentsFixture(
    page,
    'e2e-activity-scale@example.com',
    'e2e-activity-scale-bo@example.com',
  );
  await seedScaleActivity(fx, 220, 50);

  // Track every activity-API response; none may carry more than the page
  // size (the unbounded-read guard, both endpoints).
  const pageSizes: number[] = [];
  page.on('response', (res) => {
    if (!/\/api\/work-items\/[^/]+\/activity\/(history|all)/.test(res.url())) return;
    void res
      .json()
      .then((body: { entries?: unknown[] }) => {
        if (Array.isArray(body.entries)) pageSizes.push(body.entries.length);
      })
      .catch(() => {});
  });

  // ── History: 221 changes (220 + created), first paint ONE page ──────────
  await page.goto(`/items/${fx.issue.identifier}?activity=history`);
  const feed = historyFeed(page);
  await expect(feed).toBeVisible();
  await expect(page.getByText('221 changes')).toBeVisible();

  // The newest 20 (created + passes 202…220); older rows stay behind the
  // edge — never in the DOM.
  await expect(feed.getByText('pass 220', { exact: true })).toBeVisible();
  await expect(feed.getByText('pass 150', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show more changes (201 older)' })).toBeVisible();

  // Extend one cursor page backward (click-retried — finding #89).
  await extendFeed(page, 'Show more changes (201 older)', 'Show more changes (181 older)');
  await expect(feed.getByText('pass 182', { exact: true }).first()).toBeVisible();

  // ── All: both sources interleave on page ONE, paging the composite cursor ──
  await page.goto(`/items/${fx.issue.identifier}?activity=all`);
  const all = allFeed(page);
  await expect(all).toBeVisible();
  await expect(page.getByText('50 comments · 221 changes')).toBeVisible();

  // Above the fold: a history row AND a comment row (native grammar) — the
  // interleave is real, not segregated.
  await expect(all.getByText('pass 220', { exact: true })).toBeVisible();
  await expect(all.getByText('comment 50', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show more activity (251 older)' })).toBeVisible();

  // Extend the merged stream one composite-cursor page (click-retried —
  // finding #89: this exact click was hydration-swallowed in CI).
  await extendFeed(page, 'Show more activity (251 older)', 'Show more activity (231 older)');

  // Every network read stayed within the page size — the load-all read the
  // finding-#57 rule forbids never fired, on either endpoint.
  expect(pageSizes.length).toBeGreaterThan(0);
  expect(Math.max(...pageSizes)).toBeLessThanOrEqual(20);
});
