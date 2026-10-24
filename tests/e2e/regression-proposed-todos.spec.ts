import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanShapes, PLANS_SHAPES_PASSWORD, SIX_STEPS } from './_helpers/plans-shapes-seed';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';

// PLANNING A `manual` WORK ITEM AS A TO-DO LIST — THE ACCEPTANCE RECEIPT
// (Story MOTIR-3810 · Subtask MOTIR-4625). The story's `verification_recipe`,
// performed in a real browser.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The story's promise is that WHAT IS APPROVED AND WHAT ARRIVES CANNOT DIFFER.
// Before it, a `manual` card was approved as a paragraph and the twelve
// operations inside it were written — if at all — by whoever opened the card
// afterwards. So the clip's centre of gravity is the pair of states either side
// of Approve: the four steps read in the peek, and the same four steps found
// unticked on the created card. Everything else is there to make that pair
// legible.
//
// ── WHY A BROWSER, WHEN THE VITEST GATE ALREADY WALKS THIS ──────────────────
//
// MOTIR-4624 drives append → deepen → approve → list through the services and
// compares the review model to the created rows field for field. It cannot see
// the SECTION: whether the peek renders it, whether the copy control works,
// whether ticking a row moves the header. This walks the shipped path a person
// walks.
//
// ── THE SEED IS THE SHIPPED ONE ─────────────────────────────────────────────
//
// `seedPlanShapes` SHAPE SIX, added with this subtask: a `manual` `add` carrying
// the four row shapes and a stepless `add` beside it, in ONE plan, so the
// section and its ABSENCE are one navigation apart.
//
// ⚠️ FILENAME. The card names `plan-proposed-todos.spec.ts`; this is
// `regression-proposed-todos.spec.ts`, because the LANE IS SELECTED BY THE NAME:
// `playwright.acceptance.config.ts` matches `**/acceptance*.spec.ts` and
// `playwright.config.ts` `testIgnore`s exactly that pattern. Under the card's
// name this file would run in the main lane, where `acceptanceStory` does not
// exist and no clip is produced — which would satisfy AC 1 by making AC 5, the
// story's owed acceptance VIDEO, unreachable. The video is the deliverable; the
// filename is how the lane is chosen.

// The command row's copy control writes the real clipboard.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const COMMAND = SIX_STEPS[2]!.commandText!;

// The section as the LIST door renders it, read AS OPENED and compared against
// the canvas door's later. Captured before the instructions disclosure is
// touched: an expanded row is the reader's state, not the door's, and comparing
// across it would fail on `Show`/`Hide` rather than on the steps.
let fromTheList = '';

test('a plan proposes a manual card WITH its steps, and approving writes them', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-3810');

  await resetDatabase();
  const seed = await seedPlanShapes('acceptance-proposed-todos@example.com');
  await signIn(page, seed.email, PLANS_SHAPES_PASSWORD);

  const peek = page.getByTestId('proposal-peek');
  const section = page.getByTestId('proposal-todos');
  const proposedRows = page.getByTestId('proposal-todos-list').getByTestId('todo-row-readonly');

  await chapter('A plan proposes provisioning work, and it is a manual card', async () => {
    await openUndecidedPlan(page, seed.six.planId, { view: 'list' });
    const list = page.getByTestId('plan-proposal-list');
    await expect(list).toBeVisible();
    await expect(
      list.getByRole('button', { name: new RegExp(seed.six.withStepsTitle) }),
    ).toBeVisible();
    await beat();
  });

  await chapter('Opened from the LIST, it shows the steps approval will write', async () => {
    await page.getByRole('button', { name: new RegExp(seed.six.withStepsTitle) }).click();
    await expect(peek).toBeVisible();

    // ⚠️ THE ASSERTION THE STORY EXISTS FOR, first half. Four steps, in the
    // order they are performed, on the surface where Approve is pressed.
    await expect(section).toBeVisible();
    await expect(page.getByTestId('proposal-todos-progress')).toHaveText('0 of 4 done');
    await expect(proposedRows).toHaveCount(4);
    await expect(proposedRows.locator('[data-testid="todo-text"]')).toHaveText(
      SIX_STEPS.map((s) => s.text),
    );

    // The row that is the AGENT's, and only that one.
    await expect(proposedRows.nth(2).getByTestId('todo-executor-agent')).toBeVisible();
    await expect(proposedRows.nth(0).getByTestId('todo-executor-agent')).toHaveCount(0);

    // No write affordance: this is a preview of a list, not the list.
    await expect(section.getByRole('checkbox')).toHaveCount(0);
    await expect(section.getByRole('button', { name: /delete step|edit step/i })).toHaveCount(0);

    fromTheList = (await section.innerText()).trim();
    await beat();
  });

  await chapter('The instructions open in place, and the command copies', async () => {
    const notesRow = proposedRows.nth(1);
    await notesRow.getByRole('button', { name: /instructions/i }).click();
    await expect(notesRow.getByText(/Edit permissions/)).toBeVisible();
    await beat();

    const commandRow = proposedRows.nth(2);
    await expect(commandRow.getByTestId('todo-command')).toHaveText(COMMAND);
    await commandRow.getByRole('button', { name: /copy command/i }).click();
    // The clipboard, not a toast — copying is what the control promises.
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(COMMAND);
    await beat();
  });

  await chapter('The CANVAS door shows the very same steps', async () => {
    await openUndecidedPlan(page, seed.six.planId, { view: 'canvas' });
    const node = page.locator('[data-node-id]').filter({ hasText: seed.six.withStepsTitle });
    await expect(node.first()).toBeVisible();
    await node.first().press('Enter');
    await node.first().getByTestId('view-button').click();
    await expect(peek).toBeVisible();

    // Read from the rendered DOM at BOTH doors and compared to each other —
    // not two assertions that happen to agree.
    expect((await section.innerText()).trim()).toBe(fromTheList);
    await beat();
  });

  await chapter('A proposal with no steps shows no section at all', async () => {
    await openUndecidedPlan(page, seed.six.planId, { view: 'list' });
    await page.getByRole('button', { name: new RegExp(seed.six.steplessTitle) }).click();
    await expect(peek).toBeVisible();
    // ABSENT, not an empty `0 of 0`: a row's absence is a statement about the
    // SUBJECT, and an empty section would claim a planner considered the steps
    // and proposed none.
    await expect(section).toHaveCount(0);
    await page.keyboard.press('Escape');
    await beat();
  });

  await chapter('Approve — the plan becomes work items', async () => {
    // The plan is undecided, so it is approved where it is decided: the overlay's
    // own footer (Story MOTIR-7883).
    const overlay = await openUndecidedPlan(page, seed.six.planId);
    const approve = overlay
      .getByTestId('plan-change-confirm-bar')
      .getByRole('button', { name: 'Approve', exact: true });
    await expect(approve).toBeVisible();

    // Arm the response wait BEFORE the click so the persisted flip cannot be
    // missed — the shipped pattern in `agent-authored-plan.spec.ts`, and the
    // E2E discipline's own rule: an authoritative signal, never a sleep.
    const approved = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/plans/${seed.six.planId}/approve`) &&
        r.request().method() === 'POST',
    );
    await approve.click();
    expect((await approved).status()).toBe(200);

    // DECIDED now, so the plan's own page is its record — and it reads Approved.
    await page.goto(`/plans/${seed.six.planId}`); // decided: the plan page renders
    await expect(page.getByRole('main').getByTestId('plan-status-pill')).toContainText('Approved');
    await beat();
  });

  await chapter('The created card carries the same four steps, unticked', async () => {
    // `/items` renders LAZILY, one level at a time — the leaf is not in the DOM
    // until its parent row is expanded (the treegrid's ArrowRight).
    await page.goto('/items');
    await expect(page.getByRole('treegrid', { name: 'Work Items' })).toBeVisible();
    const epicRow = page.getByRole('row').filter({ hasText: seed.six.epic.title }).first();
    await expect(epicRow).toBeVisible();
    await epicRow.press('ArrowRight');

    // OPENED FROM THE KEYBOARD, and not for tidiness. The row's link is a
    // full-bleed `<a class="absolute inset-0 z-0">` UNDER the cells, so neither
    // pointer target is clickable: the title span hit-tests to the anchor, and
    // the anchor's own centre hit-tests to the assignee cell. `TreeTable` binds
    // `Enter` on the focused row to activate that very link (its `case 'Enter'`),
    // which is the affordance this tree actually ships — the same keyboard model
    // as the `ArrowRight` above.
    const cardRow = page.getByRole('row').filter({ hasText: seed.six.withStepsTitle }).first();
    await expect(cardRow).toBeVisible();
    await cardRow.press('Enter');

    // Activating a row opens the QUICK VIEW — the right door, the wrong surface:
    // the committed quick view carries no list BY DESIGN (this story's own
    // boundary; steps show on an un-materialized `add` only). Its "Open full
    // page" control is `target="_blank"`, so following it would put the card in
    // a SECOND tab and this clip would end at the peek. Take the key the peek
    // just put in the URL and walk to the page in the tab being recorded.
    await expect(page).toHaveURL(/[?&]peek=/);
    const createdKey = new URL(page.url()).searchParams.get('peek')!;
    await page.goto(`/items/${createdKey}`);

    // ⚠️ THE ASSERTION THE STORY EXISTS FOR, second half. The same four steps,
    // in the same order, on the card — so what was approved and what arrived
    // cannot differ.
    const rows = page.getByTestId('todo-row');
    await expect(page.getByTestId('todo-list')).toBeVisible();
    await expect(rows).toHaveCount(4);
    await expect(rows.locator('[data-testid="todo-text"]')).toHaveText(
      SIX_STEPS.map((s) => s.text),
    );
    await expect(page.getByTestId('todo-progress')).toHaveText('0 of 4 done');
    await expect(rows.nth(2).getByTestId('todo-executor-agent')).toBeVisible();
    await beat();
  });

  await chapter('Ticking one proves it is the real list', async () => {
    // A rendering of the proposal could show four rows. Only the real list
    // moves its own count.
    await page.getByTestId('todo-row').first().getByRole('checkbox').click();
    await expect(page.getByTestId('todo-progress')).toHaveText('1 of 4 done');
    await beat();
  });
});
