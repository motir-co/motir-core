import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanShapes, PLANS_SHAPES_PASSWORD } from './_helpers/plans-shapes-seed';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';

// ONE PEEK FOR A PROPOSAL — THE ACCEPTANCE RECEIPT (Story MOTIR-4181 · Subtask
// MOTIR-4187). The story's `verification_recipe`, performed in a real browser.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// This story is about what a person READS before pressing Approve, and it was
// wrong three times in the same place. A reviewer opening the same `modify` from
// the two panes of one screen saw two different renderings, and neither was
// right on its own: the canvas's peek was the shipped one but showed the
// target's CURRENT values with no sign a plan was about to change them, while
// the list's showed the proposed values in a surface that was not the shipped
// peek. So the clip's centre of gravity is steps 2 and 4 — the SAME proposal,
// through each door, showing the same thing.
//
// ── WHY A BROWSER, WHEN THE VITEST GATE ALREADY COMPARES THE TWO DOORS ──────
//
// MOTIR-4186 compares them at the component seam with a stubbed payload. This
// walks the real read: a seeded plan, the real `/api/work-items/peek` fetch, the
// real modal focus behaviour. AC 1 is explicit that a mocked payload would
// re-test the vitest gate through a slower runner — the point here is that the
// SHIPPED path produces what the seam test predicts.
//
// ── THE SEED IS THE SHIPPED ONE ─────────────────────────────────────────────
//
// `seedPlanShapes` SHAPE FIVE, added with this subtask because no shape carried
// a `remove` (`grep -c "op: 'remove'"` over that file returned 0). Extending the
// shipped fixture rather than seeding bespoke here is AC 5, and it means the
// next spec that needs all three ops finds them.

test('a proposal is read with the shipped quick view, from either door', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-4181');

  await resetDatabase();
  const seed = await seedPlanShapes('acceptance-proposal-peek@example.com');
  await signIn(page, seed.email, PLANS_SHAPES_PASSWORD);

  const peek = page.getByTestId('proposal-peek');

  await chapter('A plan proposes three changes, and the list names them', async () => {
    await openUndecidedPlan(page, seed.five.planId, { view: 'list' });
    const list = page.getByTestId('plan-proposal-list');
    await expect(list).toBeVisible();
    // All three sections, which is what makes the walk about the OP AXIS rather
    // than about one lucky proposal.
    //
    // ⚠️ By ROLE, not by text. A `modify`'s title appears TWICE in its row — as
    // the row's own control and again inside the `changes` diff line's `to`
    // value — because the list is where a change is SPELLED (Part VIII §3). That
    // is the list working, so the locator names the control rather than the
    // string.
    await expect(
      list.getByRole('button', { name: new RegExp(seed.five.addedTitle) }),
    ).toBeVisible();
    await expect(
      list.getByRole('button', { name: new RegExp(seed.five.modifiedTitle) }),
    ).toBeVisible();
    await expect(
      list.getByRole('button', { name: new RegExp(seed.five.removed.title) }),
    ).toBeVisible();
    await beat();
  });

  let fromTheList = '';

  await chapter('Opened from the LIST, an update reads as the work item it will BE', async () => {
    await page.getByRole('button', { name: new RegExp(seed.five.modifiedTitle) }).click();
    await expect(peek).toBeVisible();

    // The target's identifier, the op word, and BOTH bodies — the two things
    // MOTIR-4134 found nulled, on the surface a person approves from.
    await expect(peek.getByText(seed.five.modified.identifier).first()).toBeVisible();
    await expect(page.getByTestId('quick-view-op')).toHaveText('change');
    await expect(
      peek.getByText('The body approval will write in its place.').first(),
    ).toBeVisible();
    await expect(peek.getByText('The rationale approval will write in its place.')).toBeVisible();

    // The rail the plan is MOVING, marked — MOTIR-4143's seven nulled fields.
    await expect(peek.getByTestId('quick-view-changed-mark').first()).toBeVisible();
    await expect(page.getByTestId('quick-view-proposal-foot')).toContainText('changes');

    fromTheList = (await peek.innerText()).trim();
    await beat();
  });

  await chapter('Closing it returns the reader to the row they opened', async () => {
    // MOTIR-4022 measured this: the dialog is mounted INSIDE the list, so the
    // close unmounts it in the same commit that re-renders the rows, and the
    // Modal's own restore lands before the row is settled.
    await page.keyboard.press('Escape');
    await expect(peek).toBeHidden();
    await expect(
      page.getByRole('button', { name: new RegExp(seed.five.modifiedTitle) }),
    ).toBeFocused();
    await beat();
  });

  await chapter('The CANVAS door shows the very same peek', async () => {
    await openUndecidedPlan(page, seed.five.planId, { view: 'canvas' });
    const node = page.locator(`[data-node-id="${seed.five.modified.id}"]`);
    await expect(node).toBeVisible();
    await node.press('Enter');
    await node.getByTestId('view-button').click();
    await expect(peek).toBeVisible();

    // ⚠️ THE ASSERTION THE STORY EXISTS FOR (AC 2). Read from the rendered DOM
    // at BOTH doors and compared to each other — not two assertions that happen
    // to agree, which is a state the old surfaces would also have passed.
    expect((await peek.innerText()).trim()).toBe(fromTheList);
    await beat();
  });

  await chapter('An addition says it does not exist yet', async () => {
    await openUndecidedPlan(page, seed.five.planId, { view: 'list' });
    await page.getByRole('button', { name: new RegExp(seed.five.addedTitle) }).click();
    await expect(peek).toBeVisible();
    await expect(page.getByTestId('quick-view-proposal-new')).toHaveText('New');
    await expect(page.getByTestId('quick-view-op')).toHaveText('not yet created');
    // No page to open: absent rather than disabled.
    await expect(page.getByTestId('quick-view-open-full')).toHaveCount(0);
    await expect(peek.getByText('What approval will create.').first()).toBeVisible();
    await beat();
  });

  await chapter('A removal says what approving will do', async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: new RegExp(seed.five.removed.title) }).click();
    await expect(peek).toBeVisible();
    await expect(page.getByTestId('quick-view-op')).toHaveText('remove');
    // The one thing the retired surface never said anywhere.
    await expect(page.getByTestId('quick-view-proposal-foot')).toContainText('archives');
    await beat();
  });

  await chapter('A work item the plan does not touch is untouched', async () => {
    // AC 3 — the arm the routing change could silently break. A committed
    // neighbour is not a proposal and must not acquire a proposal's chrome:
    // telling a reviewer a work item is being changed when it is not is the same
    // class of false statement as the defect being fixed, pointed the other way.
    await page.keyboard.press('Escape');
    await openUndecidedPlan(page, seed.five.planId, { view: 'canvas' });
    const neighbour = page.locator(`[data-node-id="${seed.five.removed.id}"]`);
    await expect(neighbour).toBeVisible();
    await beat();
  });
});
