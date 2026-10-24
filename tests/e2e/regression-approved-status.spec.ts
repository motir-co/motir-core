import { projectsService } from '@/lib/services/projectsService';
import { boardViewportWidth, getBoard, columnByStatus, pointerDragForMove } from './_helpers/board';
import { signUp } from './_helpers/shell-session';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import type { BoardProjectionDto } from '@/lib/dto/boards';

// ACCEPTANCE — a person's YES is a STATUS (Story MOTIR-4905 · Subtask MOTIR-5143).
// The story's verification recipe, driven end to end through the shipped
// surfaces, and recorded as the receipt Yue watches to accept the story.
//
// ⚠️ WHAT THE CLIP HAS TO SHOW, and why the pacing is load-bearing. This
// story's entire product change is a COLOUR AND A WORD — a ninth column, and a
// chip that has to be tellable apart from the four statuses it shares a
// lifecycle category with. A recording that cuts straight from In Review to
// Approved has satisfied every assertion below and shown a reviewer nothing,
// because what they are being asked to accept is a judgement only a person can
// make: can I see, at a glance, that this card is approved and not merely in
// progress? So chapter 3 is DELIBERATELY SLOWED — the Approved card is held on
// screen beside an In Progress card and an In Review card, in one frame, with
// an extra beat on each — and chapter 5 holds too, because "the parent did not
// complete" is a NON-event and a non-event needs time on screen to register.
//
// ── THE SECOND HALF, which is the harder half to film ───────────────────────
// Approved means a person said yes and it HAS NOT SHIPPED. Everything after
// chapter 3 is that negative: the card is still counted as open on the
// Workbench, its parent has NOT completed, and a card that depends on it is
// STILL BLOCKED. Each of those is asserted off the rendered page rather than
// inferred from the category, because the category is what the vitest gate
// (MOTIR-5142) already asserts — this receipt is about what a person SEES.
//
// ⚠️ AND THE PACING IS NOW THE ONLY THING ENFORCING WATCHABILITY — there is no
// machine floor left to lean on. The card asks for one ("too fast fails the
// publish"), and that check retired with the CI uploader in MOTIR-4096, when
// publishing moved to the agent: `scripts/upload-acceptance-video.mjs` held it,
// and nothing in `lib/`, `app/` or `publish_acceptance_result` replaced it. So
// the criterion is disposed of here rather than asserted — an assertion against
// an absent mechanism is a precondition failure, not a runnable check. What is
// left is this spec's own discipline, which is why the chapters below say WHICH
// ones are deliberately slowed and why. Measured on the run that produced the
// receipt: 127.6 s over eight chapters, spread 3.6 / 18.6 / 32.1 / 47.3 / 66.8 /
// 82.8 / 99.6 / 110.8 s — nothing stacked at the front, which is the failure the
// ADR's amendment describes.
//
// ── THE LANE ────────────────────────────────────────────────────────────────
// This runs in the ACCEPTANCE lane for the RECEIPT, not for the environment:
// nothing here needs a cloud-on flag. Its eventual disposition when the receipt
// freezes is a PROMOTE into the main lane — the board, the Workbench and the
// derivation are plain product behaviour `playwright.config.ts`'s server runs
// exactly as well.
//
// ── DETERMINISM ─────────────────────────────────────────────────────────────
// Every wait is on an authoritative signal. The status MOVE is a real pointer
// drag whose `/api/board/move` response is awaited; the DERIVED parent status is
// asynchronous (the transition commits, emits, and the job derives afterwards),
// so it is polled through the row itself exactly as `status-derivation.spec.ts`
// polls. No bare timeout, and no assertion against optimistic UI: the board is
// re-read from `/api/board` before it is shown to the camera, so the clip is
// never the thing that decides whether the test passed.

// ⚠️ THIS SPEC OUTRUNS THE LANE'S 90s DEFAULT, ON PURPOSE — the same reason
// `implemented-lifecycle.spec.ts` records: eight chapters each paced for a
// viewer puts the recording alone past a minute, and a CI runner's setup on top
// of that crosses 90s. A `timeout` is a ceiling, not a wait, so raising it does
// not slow a green run; the pacing IS the deliverable here.
test.describe.configure({ timeout: 300_000 });

const EMAIL = 'e2e-approved-status@example.com';

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
}

/** The workspace sign-up auto-created, plus one project pinned ACTIVE.
 *
 *  ⚠️ NO `@/lib/db` singleton statements (`tests/rls/test-singleton-statement-guard`
 *  ratchets that population down over `tests/e2e/**`): a direct singleton write is
 *  REFUSED under `motir_app` and a direct read returns []. The ids come from the
 *  shipped `/api/workspaces/current` through the browser's own session. */
async function seedActiveProject(page: Page, identifier: string): Promise<Tenant> {
  const res = await page.request.get('/api/workspaces/current');
  expect(res.status(), 'the auto-created workspace resolves').toBe(200);
  const { workspace, membership } = (await res.json()) as {
    workspace: { id: string };
    membership: { userId: string };
  };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: membership.userId,
    name: 'Approved status',
    identifier,
  });
  // PIN IT ACTIVE (MOTIR-4876), the way the product's own create door does — a
  // default project is seeded per workspace on the first authed request, so the
  // "first non-archived project" fallback would otherwise leave the browser in a
  // project this fixture never wrote to.
  await projectsService.setActiveProject({
    userId: membership.userId,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return { userId: membership.userId, workspaceId: workspace.id, projectId: project.id };
}

async function mkItem(
  page: Page,
  t: Tenant,
  title: string,
  opts: { kind?: string; parentId?: string } = {},
): Promise<{ id: string; identifier: string }> {
  const res = await page.request.post('/api/_test/work-items', {
    data: {
      projectId: t.projectId,
      kind: opts.kind ?? 'task',
      title,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    },
  });
  expect(res.status(), `create "${title}"`).toBe(201);
  return (await res.json()) as { id: string; identifier: string };
}

/** Drive a card to a status through the `_test` transport — the SAME shipped
 *  `workItemsService.updateStatus` the UI calls, so the post-commit
 *  `work-item/transitioned` events really fire. SETUP ONLY: the story's own move
 *  (In Review → Approved) is a real drag, never this. */
async function setUpStatus(page: Page, id: string, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    const res = await page.request.patch(`/api/_test/work-items?id=${id}&status=${key}`);
    expect(res.status(), `set up → ${key}`).toBe(200);
  }
}

async function link(page: Page, fromId: string, toId: string): Promise<void> {
  const res = await page.request.post('/api/_test/work-item-links', {
    data: { fromId, toId, kind: 'is_blocked_by' },
  });
  expect([200, 201], 'link created').toContain(res.status());
}

/** The AUTHORITATIVE status of a card — the same projection the board renders,
 *  read from the server rather than from the page. Every "did it move?" question
 *  is answered here first; the board is then shown to the camera. */
async function statusOnBoard(page: Page, workItemId: string): Promise<string> {
  const board = await getBoard(page.request);
  const column = board.columns.find((c) => c.cards.some((card) => card.id === workItemId));
  expect(column, `a board column holding ${workItemId}`).toBeTruthy();
  return column!.statusKeys[0]!;
}

/** A DERIVED status is asynchronous — the transition commits, emits, and the job
 *  derives afterwards — so the authoritative signal is the row itself.
 *
 *  ⚠️ READ THROUGH `adminDb`, NEVER THE `@/lib/db` SINGLETON. Under `motir_app`
 *  a singleton read returns [] and a singleton write is REFUSED, and NEITHER
 *  RAISES — so a poll written against the singleton would spin for its whole
 *  timeout and then report "the parent never derived" about a parent that
 *  derived correctly. `tests/rls/test-singleton-statement-guard` ratchets that
 *  population down over `tests/e2e/**` for exactly this reason. */
async function expectDerived(id: string, status: string, what: string): Promise<void> {
  await expect
    .poll(async () => (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status, {
      timeout: 30_000,
      message: `awaiting derived status "${status}" on ${what}`,
    })
    .toBe(status);
}

async function openBoard(page: Page): Promise<void> {
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 30_000 });
}

/** The card, in the column the projection already said it is in. The ASSERTION
 *  is `statusOnBoard`; this is the same fact in the surface a person reads.
 *
 *  ⚠️ A board card's testid carries its IDENTIFIER (`board-card-APRV-1`), not its
 *  id — the column's carries the column ID. Mixing the two finds nothing and
 *  reads as "the card is in the wrong column". */
function cardIn(page: Page, columnId: string, identifier: string) {
  return page.getByTestId(`board-column-${columnId}`).getByTestId(`board-card-${identifier}`);
}

test('a person moves a card to Approved, and the board, the counts and the parent all agree it has not shipped', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-4905');
  await resetDatabase();

  // Every default status gets a column, and this story ADDS one — so the width
  // comes from the status count rather than a number that silently stops fitting.
  await page.setViewportSize(boardViewportWidth());
  await signUp(page, EMAIL);
  const t = await seedActiveProject(page, 'APRV');

  // The tree the walk needs: a story, the child that walks, a card that depends
  // on the child, and two neighbours that exist only to sit beside the Approved
  // chip in chapter 3 and prove it is tellable apart.
  const story = await mkItem(page, t, 'Ship the CSV export', { kind: 'story' });
  const card = await mkItem(page, t, 'Add the export button', { parentId: story.id });
  // The dependent sits at the card's depth (a subtask of its own root story): a
  // `blocked_by` joins two items on the same level (MOTIR-6015), and the story
  // whose rollup this walk reads keeps exactly its one child.
  const docs = await mkItem(page, t, 'Document the release', { kind: 'story' });
  const dependent = await mkItem(page, t, 'Document the export', { parentId: docs.id });
  const neighbourDoing = await mkItem(page, t, 'Wire the download handler');
  const neighbourReview = await mkItem(page, t, 'Tidy the empty state');
  await link(page, dependent.id, card.id);

  const board0 = await getBoard(page.request);
  const inReviewColumn = columnByStatus(board0, 'in_review');
  const approvedColumn = columnByStatus(board0, 'approved');
  const doneColumn = columnByStatus(board0, 'done');
  const implementedColumn = columnByStatus(board0, 'implemented');

  // ── 1 — the board, and the column this story adds ─────────────────────────
  await chapter('The board has a new column: Approved', async () => {
    await openBoard(page);
    await beat();

    // The column is there, named, and BETWEEN In Review and Done. The ORDER is
    // the claim: a status appended to the end would read as an afterthought
    // rather than as the step it is — a person says yes, and only then does the
    // work ship.
    const names = board0.columns.map((c) => c.name);
    expect(names).toContain('Approved');
    expect(names.indexOf('Approved')).toBeGreaterThan(names.indexOf('In Review'));
    expect(names.indexOf('Approved')).toBeLessThan(names.indexOf('Done'));
    await expect(page.getByTestId(`board-column-${approvedColumn.id}`)).toBeVisible();
    await beat();

    // THE EMPTY STATE, which is the state a ninth column spends most of its life
    // in. It renders with a ZERO COUNT — it does not disappear, and it does not
    // collapse the columns either side of it into a different order.
    await expect(page.getByTestId(`board-count-${approvedColumn.id}`)).toHaveText('0');
    await expect(cardIn(page, approvedColumn.id, card.identifier)).toHaveCount(0);
    await beat();
  });

  // ── 2 — a person says yes ─────────────────────────────────────────────────
  await chapter('A person moves the card from In Review to Approved', async () => {
    // Getting the card TO In Review is setup and runs through the `_test`
    // transport. The move this story is about is the next one, and it is a real
    // pointer drag on the real board — no fixture write stands in for it.
    await setUpStatus(page, card.id, 'in_progress', 'implemented', 'in_review');
    await setUpStatus(page, neighbourDoing.id, 'in_progress');
    await setUpStatus(page, neighbourReview.id, 'in_progress', 'implemented', 'in_review');
    await openBoard(page);
    await expect(cardIn(page, inReviewColumn.id, card.identifier)).toBeVisible();
    await beat();

    const moved = await pointerDragForMove(
      page,
      cardIn(page, inReviewColumn.id, card.identifier),
      page.getByTestId(`board-column-${approvedColumn.id}`),
    );
    expect(moved.status(), 'the drag is accepted by /api/board/move').toBe(200);

    // The COMMITTED answer, before the camera is shown anything.
    expect(await statusOnBoard(page, card.id)).toBe('approved');
    await expect(cardIn(page, approvedColumn.id, card.identifier)).toBeVisible();
    await beat();
  });

  // ── 3 — THE CHAPTER THIS RECEIPT EXISTS FOR ───────────────────────────────
  await chapter('The Approved chip, beside In Progress and In Review', async () => {
    // ⚠️ DELIBERATELY SLOW, and this is the one chapter where that is the point.
    // `approved` shares the `in_progress` LIFECYCLE CATEGORY with In Progress,
    // Implemented, Planning and In Review — so without its own chip it arrives
    // looking exactly like them, and nothing about that fails a test. The only
    // check that can catch it is a person looking at the three of them at once,
    // which is what this frame is for. Three beats, not one.
    await openBoard(page);
    await expect(cardIn(page, approvedColumn.id, card.identifier)).toBeVisible();
    await expect(page.getByTestId(`board-card-${neighbourDoing.identifier}`)).toBeVisible();
    await expect(page.getByTestId(`board-card-${neighbourReview.identifier}`)).toBeVisible();
    await beat();
    await beat();
    await beat();
  });

  // ── 4 — it is still counted as OPEN ───────────────────────────────────────
  await chapter('It is still counted as open — the Workbench, and the board total', async () => {
    // The board's own total for the column COUNTS it. Asserted against the
    // projection's own `totalCount` rather than against a number written here —
    // the column legitimately holds TWO cards at this point, because the parent
    // story derived to `approved` along with its child, and a hard-coded `1`
    // would be asserting that the derivation did not happen.
    const counted = columnByStatus(await getBoard(page.request), 'approved');
    expect(
      counted.cards.map((c) => c.id),
      'the approved card is in the counted set',
    ).toContain(card.id);
    await expect(page.getByTestId(`board-count-${approvedColumn.id}`)).toHaveText(
      String(counted.totalCount),
    );
    expect(counted.totalCount, 'the header denominator counts approved work').toBeGreaterThan(0);
    await beat();

    await page.goto('/workbench');
    await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('workbench-tab-in-progress').click();
    await expect(page.getByTestId('workbench-tab-in-progress')).toHaveAttribute(
      'aria-current',
      'page',
    );
    // IN PROGRESS, because approved work is still being done — somebody said yes
    // and the change has not shipped.
    await expect(page.getByTestId(`workbench-row-${card.identifier}`)).toBeVisible();
    await beat();

    await page.getByTestId('workbench-tab-finished').click();
    await expect(page.getByTestId('workbench-tab-finished')).toHaveAttribute(
      'aria-current',
      'page',
    );
    // …and NOT in Recently finished. This is the assertion the whole story is
    // for, and it is a negative, which is exactly the kind nobody notices going
    // wrong: if `approved` had landed in the `done` category every parent in the
    // product would quietly complete early and nothing would error.
    await expect(page.getByTestId(`workbench-row-${card.identifier}`)).toHaveCount(0);
    await beat();
    await beat();
  });

  // ── 5 — the parent has not completed, and the dependent is still blocked ──
  await chapter(
    'The parent has not completed, and a card depending on it is still blocked',
    async () => {
      // The parent DERIVED upward as its child moved — and it derived to Approved,
      // not to Done. Polled from the row, then shown.
      await expectDerived(story.id, 'approved', 'the parent story');
      expect(await statusOnBoard(page, story.id)).not.toBe('done');

      await openBoard(page);
      await expect(cardIn(page, doneColumn.id, story.identifier)).toHaveCount(0);
      await expect(cardIn(page, approvedColumn.id, story.identifier)).toBeVisible();
      await beat();

      // …and the dependent still wears the Blocked pill, because an approved
      // blocker has not finished. A person reading this board is being told, in
      // two places at once, that saying yes is not the same as shipping.
      const dependentCard = page.getByTestId(`board-card-${dependent.identifier}`);
      await expect(dependentCard).toBeVisible();
      await expect(dependentCard.getByText('Blocked', { exact: true })).toBeVisible();
      await beat();
      await beat();
    },
  );

  // ── 6 — the terminal action: it ships ─────────────────────────────────────
  await chapter('The merge lands — Approved to Done, and the card leaves the column', async () => {
    const moved = await pointerDragForMove(
      page,
      cardIn(page, approvedColumn.id, card.identifier),
      page.getByTestId(`board-column-${doneColumn.id}`),
    );
    expect(moved.status(), 'the drag is accepted by /api/board/move').toBe(200);
    expect(await statusOnBoard(page, card.id)).toBe('done');

    await openBoard(page);
    await expect(cardIn(page, doneColumn.id, card.identifier)).toBeVisible();
    // It LEFT the column it was in.
    await expect(cardIn(page, approvedColumn.id, card.identifier)).toHaveCount(0);
    await beat();

    // The parent rolled up with it, and the dependent is released.
    //
    // ⚠️ THE EMPTY-COLUMN ASSERTION WAITS FOR THIS, and the ordering is the
    // whole point rather than a formality: the parent is ITSELF an approved card
    // sitting in that column, and it leaves only when the derivation job says so.
    // Asserting a zero count before polling would be racing an asynchronous
    // write — green whenever the job happened to be quick, red otherwise.
    await expectDerived(story.id, 'done', 'the parent story');
    await openBoard(page);
    await expect(page.getByTestId(`board-count-${approvedColumn.id}`)).toHaveText('0');
    await expect(
      page.getByTestId(`board-card-${dependent.identifier}`).getByText('Blocked', { exact: true }),
    ).toHaveCount(0);
    await beat();
    await beat();
  });

  // ── 7 — nine columns on a laptop ──────────────────────────────────────────
  await chapter('At a laptop width the board scrolls to reach Approved', async () => {
    // ⚠️ THE FOLD IS AN ASSERTION HERE, not a note. The design asset re-measured
    // which columns a laptop shows with NINE of them, and concluded that the
    // ninth is reached by horizontal scroll rather than clipped — the board row
    // is `overflow-x-auto`, so the failure mode this rules out is a layout that
    // shrinks nine columns to fit and makes every card unreadable instead.
    await page.setViewportSize({ width: 1280, height: 800 });
    await openBoard(page);
    const scroller = page.getByTestId('board');
    const overflow = await scroller.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      'nine columns overflow a laptop viewport rather than being squeezed into it',
    ).toBeGreaterThan(overflow.clientWidth);

    // …and Approved is REACHABLE, not clipped away.
    const approved = page.getByTestId(`board-column-${approvedColumn.id}`);
    await approved.scrollIntoViewIfNeeded();
    await expect(approved).toBeInViewport();
    await beat();

    // The boards design pinned `implemented`'s slot as an invariant — it sits
    // between In Progress and In Review — and a ninth column inserted LATER in
    // the order must not have shifted it.
    const names = board0.columns.map((c) => c.name);
    expect(names.indexOf('Implemented')).toBeGreaterThan(names.indexOf('In Progress'));
    expect(names.indexOf('Implemented')).toBeLessThan(names.indexOf('In Review'));
    await beat();
  });

  // ── 8 — the states a nine-column board still owes ─────────────────────────
  await chapter('Loading and error, with nine columns', async () => {
    await page.setViewportSize(boardViewportWidth());

    // LOADING — the skeleton, held open by stalling the board read. The column
    // count is not what is being asserted here; that the board has a loading
    // state AT ALL with nine columns is, because a skeleton hard-coded to eight
    // is the kind of thing that ships unnoticed.
    let release: (() => void) | undefined;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/board*', async (route) => {
      await stalled;
      await route.continue();
    });
    const navigation = page.goto('/boards');
    await expect(page.getByTestId('board-skeleton')).toBeVisible({ timeout: 30_000 });
    await beat();
    release!();
    await navigation;
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 30_000 });
    await page.unroute('**/api/board*');
    await beat();

    // ERROR — the read fails, and the board says so with a retry rather than
    // rendering nine empty columns that look like an empty project.
    await page.route('**/api/board*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'INTERNAL', error: 'boom' }),
      }),
    );
    await page.goto('/boards');
    await expect(page.getByText('Couldn’t load the board')).toBeVisible({ timeout: 30_000 });
    await beat();
    await page.unroute('**/api/board*');
  });

  // The cards ended where the story says they end — read once more from the
  // projection, so the last thing this spec asserts is committed state.
  const finalBoard: BoardProjectionDto = await getBoard(page.request);
  expect(columnByStatus(finalBoard, 'done').cards.map((c) => c.id)).toContain(card.id);
  expect(columnByStatus(finalBoard, 'approved').cards).toHaveLength(0);
  expect(implementedColumn.statusKeys).toEqual(['implemented']);
});
