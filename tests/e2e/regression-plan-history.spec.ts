import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanHistory, PLAN_HISTORY_PASSWORD } from './_helpers/plan-history-seed';

// A WORK ITEM SHOWS EVERY PLAN THAT SHAPED IT — THE ACCEPTANCE RECEIPT (Story
// MOTIR-5542 · Subtask MOTIR-5549). The story's verification recipe, performed
// in a real browser against plans seeded through the product's own decisions.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The question the story answers is "how did this card come to look like
// this?", so the clip reads the history in the order it happened: the plan
// that CREATED the story, the plan that CHANGED it, and a plan that proposed
// three work items under it and was DECLINED. That third row is the one to
// watch — it must read as a proposal that was not applied, never as a change,
// which is the defect the design's tense split exists to prevent.
//
// Then a row is opened (every row is a door to its plan), and Show more plans
// reaches the sixth plan — the design shows the oldest five first.
//
// ── WHAT IS NOT IN THE CLIP ─────────────────────────────────────────────────
//
// The no-section cases (a card no plan touched, a member without
// `ai:view_plan`) live in `item-plan-history.spec.ts`, a regression spec, so
// this recording stays about the one path a reviewer accepts the story from.

test('a story lists the plans that shaped it, oldest first, and each opens its plan', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-5542');

  await resetDatabase();
  const seed = await seedPlanHistory('acceptance');
  await signIn(page, seed.ownerEmail, PLAN_HISTORY_PASSWORD);

  const history = page.getByRole('list', { name: `Plans that shaped ${seed.story.identifier}` });
  const rows = history.getByRole('link');

  await chapter('The story lists the plans that shaped it, oldest first', async () => {
    await page.goto(`/items/${seed.story.identifier}`);
    await expect(history).toBeVisible();
    await history.scrollIntoViewIfNeeded();
    // The design's visible bound: the OLDEST five of six.
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toContainText(seed.plans.a.title);
    await expect(rows.nth(0)).toContainText('Created this item');
    await expect(rows.nth(1)).toContainText(seed.plans.b.title);
    await expect(rows.nth(1)).toContainText('Changed this item');
    await beat();
  });

  await chapter('A declined plan reads as a proposal — nothing was applied', async () => {
    await expect(rows.nth(2)).toContainText(seed.plans.c.title);
    // The EXACT sentence: a regression to a "changed" sentence fails here.
    await expect(rows.nth(2)).toContainText('Proposed 3 work items under this item — not added');
    await expect(rows.nth(2)).toContainText('Declined');
    await expect(rows.nth(3)).toContainText('Proposed changes to this item — not applied');
    await expect(rows.nth(4)).toContainText('Proposed to archive this item — not applied');
    await beat();
  });

  await chapter('Each row opens the plan that shaped the item', async () => {
    await rows.nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/plans/${seed.plans.b.id}`));
    await expect(
      page.getByRole('heading', { name: seed.plans.b.title, exact: true }).first(),
    ).toBeVisible();
    await beat();
  });

  await chapter('Back on the item, Show more plans reaches the rest', async () => {
    await page.goBack();
    await expect(history).toBeVisible();
    await history.scrollIntoViewIfNeeded();
    const showMore = page.getByRole('button', { name: 'Show more plans' });
    await expect(showMore).toBeVisible();
    await beat();

    // Wait on the page read itself before counting rows.
    const nextPage = page.waitForResponse(
      (response) =>
        /\/api\/work-items\/[^/]+\/plans\?/.test(response.url()) &&
        response.request().method() === 'GET',
    );
    await showMore.click();
    expect((await nextPage).status()).toBe(200);

    await expect(rows).toHaveCount(6);
    await expect(rows.nth(5)).toContainText(seed.plans.f.title);
    await expect(rows.nth(5)).toContainText('Proposes 1 work item under this item');
    await expect(showMore).toHaveCount(0);

    // No plan listed twice across the two pages.
    const hrefs = await rows.evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    expect(new Set(hrefs).size).toBe(6);
    await beat();
  });
});
