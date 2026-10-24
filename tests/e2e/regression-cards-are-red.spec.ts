import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { setReaderLanguage } from './_helpers/reader-language';
import { projectsService } from '@/lib/services/projectsService';
import {
  checkSuitePayload,
  postSignedWebhook,
  pullRequestPayload,
  seedGithubInstallation,
} from './_helpers/github-seed';
import { E2E_REPO, E2E_REPO_SECOND } from './_helpers/github-const';
import { linkPr } from './_helpers/pr-link';
import { gotoLoadedBoard, getBoard } from './_helpers/board';

// SEE WHICH CARDS ARE RED — the acceptance receipt for Story MOTIR-5469
// (Subtask MOTIR-5478).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The story is about SCANNING. A person opening Motir wants to know, without
// opening anything, which of their cards are red and which are still building —
// and then to list the red ones. So the clip is a walk across the three surfaces
// that carry the badge, then the filter that collects them, and finally the one
// beat that shows the system is live rather than seeded: a fix is pushed, the
// card turns from RED to RUNNING, the build goes green, and the card moves on to
// In Review with no badge at all.
//
// ⚠️ EVERY CI EVENT ARRIVES THROUGH THE REAL SIGNED WEBHOOK, and that is the
// point rather than a nicety. The spec NEVER writes `ciState`. Each state on
// screen is one `/api/github/webhook` delivery that ran the shipped recompute,
// so what the recording shows is the product reacting — not a fixture asserting
// itself. The helpers, named here because the card asks for them by name:
//
//   opening + linking a pull request  `linkPr` (tests/e2e/_helpers/pr-link.ts)
//                                     + `pullRequestPayload({ action: 'opened' })`
//   a RUNNING suite                   `checkSuitePayload({ status: 'in_progress',
//                                       conclusion: null })`   (MOTIR-3009)
//   a FAILED suite                    `checkSuitePayload({ conclusion: 'failure' })`
//   a SUCCESSFUL suite                `checkSuitePayload({ conclusion: 'success' })`
//
// all POSTed by `postSignedWebhook`, which signs the exact bytes the route
// verifies.
//
// ── ⚠️ THE ASSERTION THAT CARRIES THE STORY ─────────────────────────────────
//
// **The filter is RAW, and chapter 4 pins it.** `Checks is any of Failing`
// returns the DONE card too — a finished card whose last build was red. The
// BADGE suppresses that card, because an old red on finished work is not
// actionable; the FILTER does not, because a saved view that silently dropped
// done cards would be the worse failure. The two rules are deliberately
// different and this is the only place a reviewer can see both at once.
//
// ── THE LANE ────────────────────────────────────────────────────────────────
//
// The acceptance lane, for the RECEIPT rather than the environment: nothing here
// needs a cloud-on flag — the webhook route, the recompute, the board, `/items`
// and the Workbench are plain product behaviour. Its disposition when the
// receipt freezes is therefore a PROMOTE into the main lane
// (`docs/acceptance-lane-triage.md`), not a retire.

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
}

interface Card {
  id: string;
  identifier: string;
}

async function seedTenant(page: Page): Promise<Tenant> {
  const res = await page.request.get('/api/workspaces/current');
  expect(res.status(), 'the auto-created workspace resolves').toBe(200);
  const { workspace, membership } = (await res.json()) as {
    workspace: { id: string };
    membership: { userId: string };
  };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: membership.userId,
    name: 'Which cards are red',
    identifier: 'RED',
  });
  // PIN IT ACTIVE the way the product's own create door does — a default project
  // is seeded per workspace on the first authed request, so without this the
  // browser sits in a project this fixture never wrote to (MOTIR-4876).
  await projectsService.setActiveProject({
    userId: membership.userId,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return { userId: membership.userId, workspaceId: workspace.id, projectId: project.id };
}

/** A card the signed-in member OWNS — the Workbench reads assignee-or-reporter,
 *  so a card nobody owns is invisible on the surface chapter 5 is about. */
async function mkCard(page: Page, t: Tenant, title: string): Promise<Card> {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId: t.projectId, kind: 'task', title },
  });
  expect(res.status(), `create "${title}"`).toBe(201);
  const card = (await res.json()) as Card;
  await adminDb.workItem.update({
    where: { id: card.id },
    data: { assigneeId: t.userId, reporterId: t.userId },
  });
  return card;
}

async function transition(page: Page, id: string, statusKey: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}&status=${statusKey}`);
  expect(res.status(), `transition → ${statusKey}`).toBe(200);
}

/** Open a pull request for a card, through the link door and then the real
 *  delivery. Returns nothing — the card's verdict is read from the board. */
async function openPrFor(
  page: Page,
  card: Card,
  args: { number: number; repo?: typeof E2E_REPO | typeof E2E_REPO_SECOND },
): Promise<string> {
  const repo = args.repo ?? E2E_REPO;
  const headRef = `subtask/${card.identifier}-${args.number}`;
  await linkPr(page, { workItemId: card.id, repo, number: args.number, headRef });
  const res = await postSignedWebhook(
    page.request,
    'pull_request',
    pullRequestPayload({
      action: 'opened',
      number: args.number,
      title: `feat: ${card.identifier}`,
      headRef,
      state: 'open',
      merged: false,
      repo,
    }),
  );
  const body = await res.text();
  expect(res.status(), `pull_request opened → ${body.slice(0, 400)}`).toBe(200);
  return headRef;
}

/**
 * Deliver one signed `check_suite` and WAIT ON ITS RESPONSE.
 *
 * ⚠️ The response IS the authoritative signal, and nothing here reads the page
 * before it arrives: the route awaits the full service handling — the recompute
 * included — before it answers, so a 200 means the column is already written.
 * That is what lets every assertion below be a plain read rather than a poll,
 * and it is why no step in this file needs a `waitForTimeout`.
 */
async function deliverChecks(
  page: Page,
  args: {
    conclusion: 'success' | 'failure' | null;
    status?: 'in_progress' | 'completed';
    headSha: string;
    prNumber: number;
    headBranch: string;
    repo?: typeof E2E_REPO | typeof E2E_REPO_SECOND;
  },
): Promise<void> {
  const res = await postSignedWebhook(
    page.request,
    'check_suite',
    checkSuitePayload({
      conclusion: args.conclusion,
      status: args.status ?? 'completed',
      headSha: args.headSha,
      prNumber: args.prNumber,
      headBranch: args.headBranch,
      repo: args.repo,
    }),
  );
  const body = await res.text();
  expect(res.status(), `check_suite ${args.conclusion ?? 'running'} → ${body.slice(0, 400)}`).toBe(
    200,
  );
}

/** The card's stored verdict, read from the BOARD PROJECTION rather than the
 *  DOM — the same server answer the page renders, used to prove a state before
 *  the camera is asked to show it. */
async function verdictOnBoard(page: Page, cardId: string): Promise<string | null> {
  const board = await getBoard(page.request);
  const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === cardId);
  expect(card, 'the card is on the board').toBeTruthy();
  return card!.ciState ?? null;
}

async function statusOnBoard(page: Page, cardId: string): Promise<string> {
  const board = await getBoard(page.request);
  const column = board.columns.find((c) => c.cards.some((card) => card.id === cardId));
  expect(column, 'the card sits in a column').toBeTruthy();
  return column!.statusKeys[0]!;
}

// ⚠️ EVERY LOCATOR BELOW IS ROOTED AT `getByRole`, NEVER AT A TEST ID, and the
// guard that requires it is `tests/e2e-page-rooted-locators.test.ts` (MOTIR-5037).
// React keeps the PREVIOUS subtree mounted while the next one streams, and
// Playwright resolves locators BEFORE filtering on visibility — so a page-rooted
// strict `getByTestId` can match a node from the OUTGOING copy of the page, which
// passes in review, passes locally, and loses a merge-queue slot. The
// accessibility tree excludes both the streamed and the outgoing copy, so a role
// root cannot see them. This spec navigates eight times; it is exactly the shape
// the guard exists for.

/** One board card — the draggable button, whose accessible name is
 *  `boards.openIssueAria` ("Open {key}: {title}"). Matched on the KEY, so the
 *  same helper serves the `zh` chapter, where the surrounding words differ. */
function boardCard(page: Page, card: Card) {
  return page.getByRole('button', { name: new RegExp(card.identifier) });
}

/** The badge inside one board card, by state. */
function boardBadge(page: Page, card: Card, state: string) {
  return boardCard(page, card).locator(`[data-ci-state="${state}"]`);
}

/** One `/items` or Workbench row — both render `role="row"`, so a row is found
 *  the way a reader finds it: by the item key it displays. */
function itemRow(page: Page, card: Card) {
  return page.getByRole('row').filter({ hasText: card.identifier });
}

function rowBadge(page: Page, card: Card, state: string) {
  return itemRow(page, card).locator(`[data-ci-state="${state}"]`);
}

test.beforeEach(async () => {
  await resetDatabase();
});

test('a person scanning sees which cards are RED, lists them, and watches one go green', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-5469');

  const email = `red-cards-${Date.now()}@example.com`;
  await signUp(page, email);
  const tenant = await seedTenant(page);
  // BOTH repositories: the TWO card is delivered by a pull request in each, which
  // is the shape the fold exists for — one red delivery outranks a green one.
  await seedGithubInstallation(tenant.workspaceId, [E2E_REPO_SECOND]);

  const red = await mkCard(page, tenant, 'Export button throws on an empty range');
  const amber = await mkCard(page, tenant, 'Rebuild the export worker');
  const two = await mkCard(page, tenant, 'Export the same data through the API');
  const done = await mkCard(page, tenant, 'Retire the old export endpoint');

  await chapter('Four cards, each with a real build behind it', async () => {
    // Every card reaches `implemented` the way a run leaves it, and every verdict
    // below arrives through the signed webhook — nothing writes `ciState`.
    for (const card of [red, amber, two, done]) {
      await transition(page, card.id, 'in_progress');
      await transition(page, card.id, 'implemented');
    }

    // ⚠️ THIS SPEC OWNS THE 14xxx PULL-REQUEST BLOCK, and the block is not a
    // formality: `github_pull_request` is `@@unique([repoId, number])` and every
    // spec seeds the SAME mirrored repo, while the acceptance lane runs many spec
    // FILES against one database. Two specs sharing a number pass until an
    // unrelated file joins the lane and re-partitions the shards — then the second
    // spec's `opened` delivery resolves to the FIRST spec's change request and its
    // card never moves, reading as a flake in a file nobody touched (MOTIR-3248).
    // These were 71xx, which `tests/e2e/scoped-run.spec.ts` already owns.
    const redRef = await openPrFor(page, red, { number: 14001 });
    await deliverChecks(page, {
      conclusion: 'failure',
      headSha: 'sha-red-1',
      prNumber: 14001,
      headBranch: redRef,
    });

    const amberRef = await openPrFor(page, amber, { number: 14002 });
    await deliverChecks(page, {
      conclusion: null,
      status: 'in_progress',
      headSha: 'sha-amber-1',
      prNumber: 14002,
      headBranch: amberRef,
    });

    // TWO — one red delivery and one green, in two different repositories.
    const twoRefA = await openPrFor(page, two, { number: 14003 });
    const twoRefB = await openPrFor(page, two, { number: 14004, repo: E2E_REPO_SECOND });
    await deliverChecks(page, {
      conclusion: 'failure',
      headSha: 'sha-two-a',
      prNumber: 14003,
      headBranch: twoRefA,
    });
    await deliverChecks(page, {
      conclusion: 'success',
      headSha: 'sha-two-b',
      prNumber: 14004,
      headBranch: twoRefB,
      repo: E2E_REPO_SECOND,
    });

    const doneRef = await openPrFor(page, done, { number: 14005 });
    await deliverChecks(page, {
      conclusion: 'failure',
      headSha: 'sha-done-1',
      prNumber: 14005,
      headBranch: doneRef,
    });
    // ⚠️ DONE IS REACHED BY MERGING, NOT BY A STATUS WRITE, and the product
    // refused the shortcut rather than this being a preference. MOTIR-5478's seed
    // says "transitioned `implemented → done` through `workItemsService`"; that
    // call raises `ApprovalGatePendingError` — *RED-4 cannot be moved to "done"
    // directly: it has an open pull request, and merging it is what makes this
    // move*. The gate is correct and the recipe was not constructible, so the
    // fixture uses the door the product actually has. The merge keeps the card's
    // verdict: `listByWorkItemWithContext` selects a card's pull requests with NO
    // filter on state, so a merged one stays in the delivery set and the column
    // still reads `failing` — which is exactly the card this chapter needs, a
    // FINISHED card whose last build was red.
    await postSignedWebhook(
      page.request,
      'pull_request',
      pullRequestPayload({
        action: 'closed',
        number: 14005,
        title: `feat: ${done.identifier}`,
        headRef: doneRef,
        state: 'closed',
        merged: true,
      }),
    );
    expect(await statusOnBoard(page, done.id), 'DONE reached by the merge').toBe('done');

    // The server's own answer, before the camera is asked to show any of it.
    expect(await verdictOnBoard(page, red.id), 'RED').toBe('failing');
    expect(await verdictOnBoard(page, amber.id), 'AMBER').toBe('running');
    expect(await verdictOnBoard(page, two.id), 'TWO — the fold, not the last writer').toBe(
      'failing',
    );
    expect(await verdictOnBoard(page, done.id), 'DONE keeps its stored verdict').toBe('failing');
  });

  await chapter('The board says which cards are red without opening one', async () => {
    await gotoLoadedBoard(page);
    await expect(boardBadge(page, red, 'failing')).toBeVisible();
    await expect(boardBadge(page, two, 'failing')).toBeVisible();
    await expect(boardBadge(page, amber, 'running')).toBeVisible();
    // The labelled form on a card — the board has the width for the words.
    await expect(boardBadge(page, red, 'failing')).toContainText('Checks failing');
    await expect(boardBadge(page, amber, 'running')).toContainText('Checks running');
    // ⚠️ DONE draws NOTHING, though its column still reads `failing`. An old red
    // on finished work is not actionable, and this is the drawing rule the
    // filter deliberately does not share.
    await expect(boardCard(page, done).locator('[data-ci-state]')).toHaveCount(0);
    await beat();
  });

  await chapter('The same verdicts on the /items List, and again in the Tree', async () => {
    await page.goto('/items?view=list');
    await expect(page.getByRole('table', { name: 'Work Items' })).toBeVisible();
    // A ROW carries the GLYPH: at the row's width a labelled pill overlapped the
    // item key, so the string reaches assistive tech as the accessible name.
    await expect(rowBadge(page, red, 'failing')).toHaveAttribute('aria-label', 'Checks failing');
    await expect(rowBadge(page, amber, 'running')).toHaveAttribute('aria-label', 'Checks running');
    await expect(rowBadge(page, two, 'failing')).toBeVisible();
    await expect(itemRow(page, done).locator('[data-ci-state]')).toHaveCount(0);
    await beat();

    // The Tree renders through the SAME column builder, which is exactly why it
    // is worth showing: a change that drew the badge in one view's own cell
    // would pass every List assertion above.
    await page.goto('/items?view=tree');
    await expect(itemRow(page, red).locator('[data-ci-state="failing"]')).toHaveCount(1);
    await expect(itemRow(page, amber).locator('[data-ci-state]')).toHaveAttribute(
      'aria-label',
      'Checks running',
    );
    await beat();
  });

  await chapter(
    'Checks is any of Failing — and it is RAW, so the finished card is in',
    async () => {
      await page.goto('/items?view=list');
      await page.getByRole('button', { name: /^Advanced/ }).click();
      await page.getByRole('button', { name: 'Add condition' }).click();

      const row = page.getByRole('group', { name: 'Condition 1' });
      await row.getByRole('combobox', { name: 'Field' }).click();
      await page.getByRole('option', { name: 'Checks' }).click();
      await row.getByRole('combobox', { name: 'Checks values' }).click();
      await page.getByRole('option', { name: /Checks failing/ }).click();

      // The builder applies LIVE and writes the AST into the URL; that navigation
      // is the authoritative signal that the server has been asked the question.
      await page.waitForURL(/[?&]filter=/);

      // ⚠️ THE EXACT ROW SET, done card included. `toHaveCount` on its own would
      // pass on three wrong rows.
      await expect(itemRow(page, red)).toBeVisible();
      await expect(itemRow(page, two)).toBeVisible();
      await expect(itemRow(page, done)).toBeVisible();
      await expect(itemRow(page, amber)).toHaveCount(0);
      await expect(page.getByRole('table', { name: 'Work Items' }).getByRole('row')).toHaveCount(4); // 3 + header
      await beat();
    },
  );

  await chapter('And on the Workbench, where the day starts', async () => {
    // A red card is stuck until it is repaired, so since Story MOTIR-6588 the
    // Workbench lists it on To fix rather than In progress — with the same badge.
    await page.goto('/workbench?tab=to-fix');
    await expect(itemRow(page, red).locator('[data-ci-state="failing"]')).toHaveAttribute(
      'aria-label',
      'Checks failing',
    );
    await beat();
  });

  await chapter('A fix is pushed — the card goes from red to still building', async () => {
    // A NEW head commit, which is what a push is. The running suite carries no
    // conclusion, and that is the state the column could not hold before this
    // story: the card read `failing` while its fix was already building.
    await deliverChecks(page, {
      conclusion: null,
      status: 'in_progress',
      headSha: 'sha-red-2',
      prNumber: 14001,
      headBranch: `subtask/${red.identifier}-14001`,
    });
    expect(await verdictOnBoard(page, red.id), 'RED after the push').toBe('running');

    await gotoLoadedBoard(page);
    await expect(boardBadge(page, red, 'running')).toContainText('Checks running');
    await expect(boardBadge(page, red, 'failing')).toHaveCount(0);
    await beat();
  });

  await chapter('The build goes green — the card moves on, and the badge is gone', async () => {
    await deliverChecks(page, {
      conclusion: 'success',
      headSha: 'sha-red-2',
      prNumber: 14001,
      headBranch: `subtask/${red.identifier}-14001`,
    });
    expect(await verdictOnBoard(page, red.id), 'RED once green').toBe('passing');
    // Green CI is what calls a person, so the card is now In Review — and a green
    // badge would only restate the column it sits in.
    expect(await statusOnBoard(page, red.id)).toBe('in_review');

    await gotoLoadedBoard(page);
    await expect(boardCard(page, red).locator('[data-ci-state]')).toHaveCount(0);
    await beat();
  });

  await chapter('In 简体中文, through the catalogue’s own strings', async () => {
    // ⚠️ ASSERTED POSITIVELY, never by checking an English literal is absent —
    // that passes on a blank page.
    await setReaderLanguage(page, email, 'zh');
    await gotoLoadedBoard(page);
    await expect(boardBadge(page, two, 'failing')).toContainText('检查失败');
    await expect(boardBadge(page, amber, 'running')).toContainText('检查运行中');

    await page.goto('/items?view=list');
    await page.getByRole('button', { name: /^高级/ }).click();
    await page.getByRole('button', { name: '添加条件' }).click();
    // ⚠️ NAMED, not `.first()`. The builder renders TWO groups — the combinator
    // sentence (`匹配方式`) comes FIRST in the DOM and holds no combobox, so an
    // unnamed `getByRole('group').first()` waits ninety seconds for a control
    // that was never in it. Every locator in this chapter is a `zh` string,
    // which is also what makes the chapter a translation assertion rather than
    // an English page that happens to render.
    const row = page.getByRole('group', { name: '条件1' });
    await row.getByRole('combobox', { name: '字段' }).click();
    // The FIELD label in the catalogue the page is actually rendering.
    await expect(page.getByRole('option', { name: '检查' })).toBeVisible();
    await page.getByRole('option', { name: '检查' }).click();
    // …and its three values, in the same catalogue.
    await row.getByRole('combobox', { name: '检查的值' }).click();
    await expect(page.getByRole('option', { name: /检查失败/ })).toBeVisible();
    await beat();
  });
});
