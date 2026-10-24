import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './_helpers/promoted-regression';
import { adminDb, db, resetDatabase } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { IDEA_CATEGORIES, IDEA_CATEGORY_LABELS } from '@/lib/ideas/categories';
import enMessages from '@/messages/en.json';

/**
 * STORY MOTIR-8273 — the idea store gains nine categories (MOTIR-8278). The
 * story's Verification recipe, walked in a browser at `/admin/ideas` over the
 * store the seed migration ships:
 *  1. The Category filter offers all 34 categories, the nine at their grouped
 *     positions with their exact labels.
 *  2. Filtering by Silver economy, which no seeded idea uses yet, shows the
 *     no-match state.
 *  3. An operator moves "Stop returns before they happen" into Silver economy
 *     from the edit form; the store holds the new category.
 *  4. The Silver economy filter now finds that one idea.
 *  5. No other idea moved category.
 *
 * Kept apart from `regression-admin-ideas.spec.ts` (Story MOTIR-7664) so the
 * lane publishes this clip to this story and leaves that story's receipt alone.
 *
 * Every wait is an authoritative signal — the URL a filter writes, the saved
 * line the action's own answer draws, a database read — never a timeout.
 */

const ideas = enMessages.platformAdmin.ideas;

const EMAIL = 'acceptance-idea-categories-operator@example.com';
const RETURNS = 'Stop returns before they happen';
const RETURNS_SLUG = 'stop-returns-before-they-happen';

const NINE = [
  'entertainment_media',
  'hospitality_travel',
  'mobility',
  'energy_climate',
  'manufacturing',
  'local_services',
  'social_community',
  'silver_economy',
  'independent_work',
] as const;

const SEED = path.join(process.cwd(), 'prisma/migrations/20261007100100_seed_ideas/migration.sql');

/** Read or write the RLS-forced idea store as platform staff, in one transaction. */
function asStaff<T>(
  body: (tx: Parameters<Parameters<typeof adminDb.$transaction>[0]>[0]) => Promise<T>,
) {
  return adminDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_staff', 'true', true)`;
    return body(tx);
  });
}

/** Every stored idea's category, by slug. */
async function categoriesBySlug(): Promise<Record<string, string>> {
  const rows = await asStaff((tx) => tx.idea.findMany({ select: { slug: true, category: true } }));
  return Object.fromEntries(rows.map((r) => [r.slug, r.category]));
}

test.describe.configure({ timeout: 300_000 });

test.afterAll(async () => {
  await db.$disconnect();
});

test('an operator files an idea under one of the nine new categories, and the filter finds it', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-8273');

  await resetDatabase();
  await asStaff(async (tx) => {
    await tx.$executeRawUnsafe(readFileSync(SEED, 'utf8'));
  });
  await signUp(page, EMAIL);
  await db.user.update({ where: { email: EMAIL }, data: { platformRole: 'operator' } });

  const before = await categoriesBySlug();
  expect(before[RETURNS_SLUG]).toBe('ecommerce');

  const main = page.getByRole('main');

  await chapter('The Category filter offers all 34 categories', async () => {
    await page.goto('/admin/ideas');
    await expect(main.getByRole('heading', { name: ideas.title, level: 1 })).toBeVisible();
    await main.getByRole('combobox', { name: ideas.filter.category }).click();
    const listbox = page.getByRole('listbox', { name: ideas.filter.category });
    const options = listbox.getByRole('option');
    await expect(options).toHaveCount(IDEA_CATEGORIES.length + 1);
    const texts = (await options.allTextContents()).map((t) => t.trim());
    expect(texts).toEqual([
      ideas.filter.anyCategory,
      ...IDEA_CATEGORIES.map((c) => IDEA_CATEGORY_LABELS[c]),
    ]);
    for (const slug of NINE) {
      await expect(listbox.getByRole('option', { name: IDEA_CATEGORY_LABELS[slug] })).toHaveCount(
        1,
      );
    }
    // Grouped: the new verticals follow Public sector; the new consumer
    // categories sit between Health & wellness and AI infrastructure.
    const at = (label: string) => texts.indexOf(label);
    expect(at('Entertainment & media')).toBe(at(IDEA_CATEGORY_LABELS.public_sector) + 1);
    expect(at('Social & community')).toBe(at(IDEA_CATEGORY_LABELS.health_wellness) + 1);
    expect(at(IDEA_CATEGORY_LABELS.ai_infrastructure)).toBe(at('Independent work') + 1);
    await beat();
  });

  await chapter('Silver economy has no ideas yet', async () => {
    await page.getByRole('option', { name: 'Silver economy' }).click();
    await expect(page).toHaveURL(/\/admin\/ideas\?category=silver_economy$/);
    await expect(main.getByRole('heading', { name: ideas.emptyFilter.title })).toBeVisible();
    await beat();
  });

  await chapter('Move an idea into Silver economy from its edit form', async () => {
    await page.goto(`/admin/ideas/${RETURNS_SLUG}`);
    await expect(main.getByRole('heading', { name: RETURNS, level: 1 })).toBeVisible();
    await main.getByRole('button', { name: ideas.action.edit }).click();

    await main.getByRole('combobox', { name: ideas.edit.field.category }).click();
    const listbox = page.getByRole('listbox', { name: ideas.edit.field.category });
    for (const slug of NINE) {
      await expect(listbox.getByRole('option', { name: IDEA_CATEGORY_LABELS[slug] })).toHaveCount(
        1,
      );
    }
    await page.getByRole('combobox', { name: 'Search…' }).fill('silver');
    await expect(listbox.getByRole('option')).toHaveCount(1);
    await beat();
    await listbox.getByRole('option', { name: 'Silver economy' }).click();
    await expect(main.getByRole('combobox', { name: ideas.edit.field.category })).toContainText(
      'Silver economy',
    );

    await main.getByRole('button', { name: ideas.edit.save }).click();
    // The saved line is drawn from the action's own answer — the write's signal.
    await expect(main.getByRole('status').filter({ hasText: ideas.edit.saved })).toBeVisible();
    await expect(main.getByText('Silver economy', { exact: true }).first()).toBeVisible();
    const stored = await asStaff((tx) =>
      tx.idea.findUniqueOrThrow({ where: { slug: RETURNS_SLUG }, select: { category: true } }),
    );
    expect(stored.category).toBe('silver_economy');
    await beat();
  });

  await chapter('The Silver economy filter now finds that one idea', async () => {
    await page.goto('/admin/ideas');
    await main.getByRole('combobox', { name: ideas.filter.category }).click();
    await page.getByRole('option', { name: 'Silver economy' }).click();
    await expect(page).toHaveURL(/\/admin\/ideas\?category=silver_economy$/);
    await expect(main.getByText('Newest first. 1 shown.', { exact: true })).toBeVisible();
    await expect(main.getByRole('link', { name: RETURNS })).toBeVisible();
    // The table row, not the narrow list the same page renders for small screens.
    await expect(main.getByTestId(`idea-row-${RETURNS_SLUG}`)).toContainText('Silver economy');
    await beat();
  });

  await chapter('No other idea moved category', async () => {
    const after = await categoriesBySlug();
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    const moved = Object.keys(after).filter((slug) => after[slug] !== before[slug]);
    expect(moved).toEqual([RETURNS_SLUG]);
    expect(after[RETURNS_SLUG]).toBe('silver_economy');
  });
});
