import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './_helpers/promoted-regression';
import { adminDb, db, resetDatabase } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import enMessages from '@/messages/en.json';

/**
 * STORY MOTIR-7664 — platform staff review, edit and retire ideas by hand at
 * `/admin/ideas` (MOTIR-7683). The story's Verification recipe, walked in a
 * browser over the store the seed migration ships (today's 15 ideas).
 *
 * The recorded HAPPY PATH is the first four chapters, paced for a person:
 *  1. An operator opens the console and clicks Ideas in its rail — never a
 *     direct URL for this first step, which is what proves the access path.
 *  2. Filters by category and by text; a reload keeps both.
 *  3. Opens the idea, edits its pitch and adds an evidence row; the detail
 *     shows the change.
 *  4. Retires it with a reason, and finds it under Retired with that reason.
 * Then the edges: an invalid evidence link refused in place, the no-match
 * state, support staff seeing no write controls, and a superadmin's delete.
 *
 * Every wait is an authoritative signal — the URL a filter writes, the saved
 * line the action's own answer draws, the retired box the revalidated page
 * renders, a database read — never a timeout.
 */

const ideas = enMessages.platformAdmin.ideas;
const menu = enMessages.shell.userMenu;

const EMAIL = 'acceptance-ideas-operator@example.com';
const RETURNS = 'Stop returns before they happen';
const AI_SHOPPERS = 'Make a store visible to AI shoppers';
const DELETE_ME = 'e2e-acceptance-delete-me';

const SEED = path.join(process.cwd(), 'prisma/migrations/20261007100100_seed_ideas/migration.sql');

/** A message as a literal pattern. */
const literal = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** Read or write the RLS-forced idea store as platform staff, in one transaction. */
function asStaff<T>(
  body: (tx: Parameters<Parameters<typeof adminDb.$transaction>[0]>[0]) => Promise<T>,
) {
  return adminDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_staff', 'true', true)`;
    return body(tx);
  });
}

async function setRole(role: 'support' | 'operator' | 'superadmin') {
  // The gate reads a fresh row per request, so the next navigation sees it.
  await db.user.update({ where: { email: EMAIL }, data: { platformRole: role } });
}

test.describe.configure({ timeout: 300_000 });

test.afterAll(async () => {
  await db.$disconnect();
});

test('platform staff find, edit and retire an idea at /admin/ideas; support reads only; a superadmin deletes', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7664');

  await resetDatabase();
  // `idea` carries FORCED row-level security whose policies read the
  // platform-staff context, so every fixture read and write binds it.
  await asStaff(async (tx) => {
    await tx.$executeRawUnsafe(readFileSync(SEED, 'utf8'));
    await tx.idea.create({
      data: {
        slug: DELETE_ME,
        kind: 'direction',
        category: 'family_care',
        title: 'An idea added by mistake',
        pitch: 'A test idea a superadmin removes.',
        capabilities: ['Nothing'],
      },
    });
  });
  await signUp(page, EMAIL);
  await setRole('operator');

  const main = page.getByRole('main');

  await chapter('The operator opens Ideas from the console rail', async () => {
    // A fresh load, so the account menu is rendered for the staff role just set.
    await page.goto('/workbench');
    await page.getByRole('button', { name: menu.account }).click();
    await page.getByRole('link', { name: literal(menu.platformAdmin) }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page
      .getByRole('link', { name: enMessages.platformAdmin.shell.navIdeas, exact: true })
      .click();
    await expect(page).toHaveURL(/\/admin\/ideas$/);
    await expect(main.getByRole('heading', { name: ideas.title, level: 1 })).toBeVisible();
    // The 15 seeded ideas plus the fixture the superadmin deletes later.
    await expect(main.getByText('Newest first. 16 shown.', { exact: true })).toBeVisible();
    await expect(main.getByRole('link', { name: RETURNS })).toBeVisible();
    await beat();
  });

  await chapter('Filter by category and by text; a reload keeps both', async () => {
    await main.getByRole('combobox', { name: 'Category' }).click();
    await page.getByRole('option', { name: 'E-commerce' }).click();
    await expect(page).toHaveURL(/\/admin\/ideas\?category=ecommerce$/);
    await expect(main.getByText('Newest first. 2 shown.', { exact: true })).toBeVisible();
    await beat();

    const search = main.getByRole('textbox', { name: ideas.search.label });
    await search.fill('returns');
    await search.press('Enter');
    await expect(page).toHaveURL(/\/admin\/ideas\?q=returns&category=ecommerce$/);
    await expect(main.getByText('Newest first. 1 shown.', { exact: true })).toBeVisible();
    await expect(main.getByRole('link', { name: AI_SHOPPERS })).toHaveCount(0);
    await beat();

    await page.reload();
    await expect(page).toHaveURL(/\/admin\/ideas\?q=returns&category=ecommerce$/);
    await expect(main.getByRole('textbox', { name: ideas.search.label })).toHaveValue('returns');
    await expect(main.getByText('Newest first. 1 shown.', { exact: true })).toBeVisible();
    await expect(main.getByRole('link', { name: RETURNS })).toBeVisible();
    await beat();
  });

  await chapter('Edit the pitch and add an evidence row', async () => {
    await main.getByRole('link', { name: RETURNS }).click();
    await expect(page).toHaveURL(/\/admin\/ideas\/stop-returns-before-they-happen$/);
    await expect(main.getByRole('heading', { name: RETURNS, level: 1 })).toBeVisible();
    await main.getByRole('button', { name: ideas.action.edit }).click();

    await main
      .getByRole('textbox', { name: ideas.edit.field.pitch })
      .fill('Predict which orders will come back, and fix the listing before they ship.');
    await main.getByRole('button', { name: ideas.edit.evidence.add }).click();
    await main
      .getByRole('textbox', { name: ideas.edit.evidence.claim })
      .last()
      .fill('Online returns cost retailers about a fifth of sales.');
    await main
      .getByRole('textbox', { name: ideas.edit.evidence.source, exact: true })
      .last()
      .fill('A retail survey, 2026');
    await main
      .getByRole('textbox', { name: ideas.edit.evidence.link })
      .last()
      .fill('https://example.com/returns-survey');
    await beat();

    await main.getByRole('button', { name: ideas.edit.save }).click();
    // The saved line is drawn from the action's own answer — the write's signal.
    await expect(main.getByRole('status').filter({ hasText: ideas.edit.saved })).toBeVisible();
    await expect(
      main.getByText('Predict which orders will come back, and fix the listing before they ship.'),
    ).toBeVisible();
    await expect(
      main.getByText('Online returns cost retailers about a fifth of sales.'),
    ).toBeVisible();
    await beat();
  });

  await chapter('Retire it with a reason, and find it under Retired', async () => {
    await main.getByRole('button', { name: ideas.action.retire }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog
      .getByRole('textbox', { name: literal(ideas.retire.reason) })
      .fill('A large marketplace now ships this to every seller.');
    await beat();
    await dialog.getByRole('button', { name: ideas.retire.confirm }).click();
    // The revalidated page draws the Retired box from the stored row.
    await expect(main.getByTestId('idea-retired-box')).toContainText(
      'A large marketplace now ships this to every seller.',
    );
    await expect(main.getByRole('button', { name: ideas.action.retire })).toHaveCount(0);
    await beat();

    await page
      .getByRole('link', { name: enMessages.platformAdmin.shell.navIdeas, exact: true })
      .click();
    await expect(page).toHaveURL(/\/admin\/ideas$/);
    await expect(main.getByRole('link', { name: RETURNS })).toHaveCount(0);
    await main
      .getByRole('group', { name: ideas.filter.status })
      .getByRole('button', { name: 'Retired' })
      .click();
    await expect(page).toHaveURL(/\/admin\/ideas\?status=retired$/);
    await expect(main.getByRole('link', { name: RETURNS })).toBeVisible();
    // The table row, not the narrow list the same page renders for small screens.
    await expect(
      main
        .getByTestId('idea-row-stop-returns-before-they-happen')
        .getByText(/“A large marketplace now ships this to every seller\.”/),
    ).toBeVisible();
    await beat();
  });

  await chapter('An evidence row with a plain-http link is refused in place', async () => {
    await page.goto('/admin/ideas/make-a-store-visible-to-ai-shoppers');
    await expect(main.getByRole('heading', { name: AI_SHOPPERS, level: 1 })).toBeVisible();
    await main.getByRole('button', { name: ideas.action.edit }).click();
    await main.getByRole('button', { name: ideas.edit.evidence.add }).click();
    await main.getByRole('textbox', { name: ideas.edit.evidence.claim }).last().fill('A claim.');
    await main
      .getByRole('textbox', { name: ideas.edit.evidence.source, exact: true })
      .last()
      .fill('A source');
    const link = main.getByRole('textbox', { name: ideas.edit.evidence.link }).last();
    await link.fill('http://plain.example');
    await main.getByRole('button', { name: ideas.edit.save }).click();
    await expect(main.getByRole('alert').filter({ hasText: /Not saved/ })).toBeVisible();
    await expect(link).toHaveAttribute('aria-invalid', 'true');
    // Nothing was written: the store still holds the seeded rows only.
    const stored = await asStaff((tx) =>
      tx.idea.findUniqueOrThrow({
        where: { slug: 'make-a-store-visible-to-ai-shoppers' },
        include: { evidence: true },
      }),
    );
    expect(stored.evidence.some((e) => e.url === 'http://plain.example')).toBe(false);
    await main.getByRole('button', { name: ideas.edit.cancel }).click();
  });

  await chapter('A text filter that matches nothing shows the no-match state', async () => {
    await page.goto('/admin/ideas');
    const search = main.getByRole('textbox', { name: ideas.search.label });
    await search.fill('zebra-crossing-for-submarines');
    await search.press('Enter');
    await expect(page).toHaveURL(/q=zebra-crossing-for-submarines/);
    await expect(main.getByRole('heading', { name: ideas.emptyFilter.title })).toBeVisible();
    await expect(main.getByRole('link', { name: ideas.emptyFilter.action })).toBeVisible();
  });

  await chapter('Support staff read the idea with no write controls', async () => {
    await setRole('support');
    await page.goto('/admin/ideas/make-a-store-visible-to-ai-shoppers');
    await expect(main.getByRole('heading', { name: AI_SHOPPERS, level: 1 })).toBeVisible();
    await expect(main.getByText(ideas.readOnly)).toBeVisible();
    for (const name of [ideas.action.edit, ideas.action.retire, ideas.action.delete]) {
      await expect(main.getByRole('button', { name })).toHaveCount(0);
    }
  });

  await chapter('A superadmin deletes a test idea after confirming', async () => {
    await setRole('superadmin');
    await page.goto(`/admin/ideas/${DELETE_ME}`);
    await main.getByRole('button', { name: ideas.action.delete }).click();
    const dialog = page.getByRole('alertdialog');
    const confirm = dialog.getByRole('button', { name: ideas.delete.confirm });
    await dialog
      .getByRole('textbox', { name: literal(ideas.delete.reason) })
      .fill('Added by mistake during testing.');
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('textbox', { name: literal(DELETE_ME) }).fill(DELETE_ME);
    await confirm.click();
    await expect(page).toHaveURL(/\/admin\/ideas$/);
    await expect(main.getByRole('link', { name: 'An idea added by mistake' })).toHaveCount(0);
    expect(await asStaff((tx) => tx.idea.findUnique({ where: { slug: DELETE_ME } }))).toBeNull();
  });
});
