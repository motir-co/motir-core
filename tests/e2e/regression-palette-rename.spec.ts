import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { createFirstProject, signIn, signUp, SHELL_PASSWORD } from './_helpers/shell-session';

// MOTIR-6477 — the story E2E + acceptance receipt for MOTIR-6470, "Motir's look
// becomes the monochrome palette". It walks the story's `## Verification` in a real
// browser: a new visitor sees the monochrome Motir palette, the Appearance picker
// lists Motir first and Amethyst second with no Graphite, a warm choice survives
// on the account AND in a browser that stored it before the rename, the onboarding
// Design step still opens on Amethyst, and the tab icon is the new ink tile.
//
// Every wait is authoritative — the `data-palette` attribute the server or the
// init script stamps, a radio's checked state, a PATCH's own 200 — never a sleep.
// `chapter()` / `beat()` pace the recording for a human; they never synchronise.

test.describe.configure({ timeout: 300_000 });

const APPEARANCE_URL = '/settings/account/appearance';
const html = (page: Page): Locator => page.locator('html');
const palettePicker = (page: Page): Locator =>
  page.getByRole('radiogroup', { name: 'Palette', exact: true });

/** The `<html …>` opening tag of the RAW server document — what the first paint carries. */
async function serverHtmlTag(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.get(path);
  expect(res.ok()).toBe(true);
  const markup = await res.text();
  const open = markup.indexOf('<html');
  return markup.slice(open, markup.indexOf('>', open) + 1);
}

/** A tiers-complete, web pre-plan read, so the onboarding hub offers the Design step. */
async function stubCompletedPreplan(page: Page): Promise<void> {
  const ISO = '2026-09-26T00:00:00.000Z';
  const doc = (kind: string) => ({
    kind,
    currentBody: `# ${kind}\n\nReady.`,
    currentVersion: 1,
    summary: [],
    versions: [{ version: 1, changeReason: null, changeKind: null, diff: null, createdAt: ISO }],
  });
  await page.route('**/api/ai/pre-plan', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session: {
          classification: 'new_product',
          platform: 'web',
          designStarter: null,
          designChoice: null,
          validationTiming: null,
          docSkipSet: [],
          currentGate: null,
          status: 'tiers_complete',
          conversation: [],
          createdAt: ISO,
          updatedAt: ISO,
        },
        docs: ['discovery', 'vision', 'feasibility', 'validation'].map(doc),
        catalog: null,
      }),
    });
  });
}

test.describe('Motir wears the monochrome palette; Amethyst stays for those who chose it', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('new look by default, the warm choice kept on the account and in the browser, the new tab icon', async ({
    page,
    browser,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6470');
    const email = `palette-rename-${Date.now().toString(36)}@example.com`;

    await chapter('A new visitor sees Motir in monochrome, with the new tab icon', async () => {
      await page.goto('/sign-in');
      await expect(html(page)).toHaveAttribute('data-palette', 'motir');
      const icon = await page.request.get('/icon.svg');
      expect(icon.ok()).toBe(true);
      const svg = await icon.text();
      expect(svg).toContain('fill="#1a1d21"');
      expect(svg).toContain('prefers-color-scheme: dark');
      expect(svg).not.toContain('#5645d4');
    });
    await beat();

    await chapter('Signed in with no saved palette, the app is monochrome', async () => {
      await signUp(page, email);
      await page.goto('/workbench');
      await expect(html(page)).toHaveAttribute('data-palette', 'motir');
    });
    await beat();

    await chapter(
      'Settings › Appearance lists Motir first and Amethyst second — no Graphite',
      async () => {
        await page.goto(APPEARANCE_URL);
        await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
        const radios = palettePicker(page).getByRole('radio');
        await expect(radios.nth(0)).toHaveAccessibleName('Motir');
        await expect(radios.nth(1)).toHaveAccessibleName('Amethyst');
        await expect(palettePicker(page).getByRole('radio', { name: 'Graphite' })).toHaveCount(0);
        await expect(
          palettePicker(page).getByRole('radio', { name: 'Motir', exact: true }),
        ).toBeChecked();
      },
    );
    await beat();

    await chapter('Pick Amethyst: the app turns warm, and stays warm after a reload', async () => {
      const patch = page.waitForResponse(
        (r) => r.url().includes('/api/appearance-preference') && r.request().method() === 'PATCH',
      );
      await palettePicker(page).getByRole('radio', { name: 'Amethyst', exact: true }).click();
      const res = await patch;
      expect(res.status()).toBe(200);
      expect(
        ((await res.json()) as { preference: { paletteId: string } }).preference.paletteId,
      ).toBe('amethyst');
      await expect(html(page)).toHaveAttribute('data-palette', 'amethyst');
      await beat();
      await page.reload();
      await expect(html(page)).toHaveAttribute('data-palette', 'amethyst');
      await expect(
        palettePicker(page).getByRole('radio', { name: 'Amethyst', exact: true }),
      ).toBeChecked();
    });
    await beat();

    await chapter(
      'On a fresh device the account’s Amethyst arrives on the first paint',
      async () => {
        const device = await browser.newContext();
        const fresh = await device.newPage();
        await signIn(fresh, email, SHELL_PASSWORD);
        expect(await serverHtmlTag(device.request, '/workbench')).toContain(
          'data-palette="amethyst"',
        );
        await expect(html(fresh)).toHaveAttribute('data-palette', 'amethyst');
        await device.close();
      },
    );
    await beat();

    await chapter(
      'A browser that chose the old warm palette before the rename keeps it, as Amethyst',
      async () => {
        const device = await browser.newContext();
        const visitor = await device.newPage();
        await visitor.goto('/sign-in');
        // What a browser stored before MOTIR-6471: the warm palette's OLD id, no marker.
        await visitor.evaluate(() => {
          localStorage.setItem('motir.theme.palette', 'motir');
          localStorage.removeItem('motir.theme.paletteIds');
        });
        await visitor.reload();
        await expect(html(visitor)).toHaveAttribute('data-palette', 'amethyst');
        expect(await visitor.evaluate(() => localStorage.getItem('motir.theme.paletteIds'))).toBe(
          '2',
        );
        await beat();
        // A second load does not migrate again.
        await visitor.reload();
        await expect(html(visitor)).toHaveAttribute('data-palette', 'amethyst');
        await device.close();
      },
    );
    await beat();

    await chapter(
      'An unknown stored palette falls back to Motir, without a console error',
      async () => {
        const device = await browser.newContext();
        const visitor = await device.newPage();
        const errors: string[] = [];
        visitor.on('console', (msg) => {
          // A resource that fails to load is the lane's own stubbed external hosts
          // (they never resolve here), not the palette — the check is for a SCRIPT
          // error from reading an unknown stored id.
          if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource'))
            errors.push(msg.text());
        });
        await visitor.goto('/sign-in');
        await visitor.evaluate(() => {
          localStorage.setItem('motir.theme.palette', 'nope');
          localStorage.setItem('motir.theme.paletteIds', '2');
        });
        await visitor.reload();
        await expect(html(visitor)).toHaveAttribute('data-palette', 'motir');
        expect(errors).toEqual([]);
        await device.close();
      },
    );
    await beat();

    await chapter('A new project’s Design step opens on Amethyst', async () => {
      await createFirstProject(page, 'Palette tour');
      await stubCompletedPreplan(page);
      await page.goto('/onboarding/discovery');
      await page.getByRole('button', { name: 'Design your look' }).last().click();
      // The step's root is a labelled <section> — a `region` — so it is reached by
      // role, which the accessibility tree scopes to the live copy.
      const designPage = page.getByRole('region', { name: "Design your project's look" });
      await expect(designPage).toHaveAttribute('data-palette', 'amethyst');
      await expect(
        palettePicker(page).getByRole('radio', { name: 'Amethyst', exact: true }),
      ).toBeChecked();
    });
    await beat();
  });
});
