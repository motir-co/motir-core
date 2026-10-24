// ACCEPTANCE: every organisation has a content language (Story MOTIR-7731 ·
// MOTIR-8100).
//
// The story's Verification steps 1–9 as a person meets them in a browser,
// recorded as the story's receipt:
//
//   1–3. registration picks the organisation's content language from the
//        browser — 中文 for a Chinese browser (email and Google sign-up alike),
//        English for any other, while the app itself follows the browser;
//   4.   an organisation that existed before the change reads English;
//   5.   a plain member reads it, read-only, on their own Language pane — no
//        control, and the change route refuses them (403);
//   6.   the owner changes it to 日本語 through a confirm that says existing work
//        keeps its text and language — Cancel and Escape send nothing;
//   7.   work written before the change keeps its language (`en`), and work
//        that never recorded one reads `null`, never `en`;
//   8.   new work, from the app and from the MCP, records 日本語;
//   9.   a language the writer names wins for that field alone.
//
// Each group is its own short test, so each clip stays inside the lane's budget
// (`playwright.acceptance.config.ts`).
//
// ⚠️ THE FILE NAME. The card names `tests/e2e/content-language.spec.ts`, and asks
// for the spec to run under the acceptance config — whose `testMatch` is
// `**/acceptance*.spec.ts`. The second requirement decides the name.
//
// ⚠️ THE BROWSER'S LANGUAGE IS A CONTEXT'S `locale` (`test.use`), which sets the
// real `Accept-Language` the sign-up hook reads. No header is injected by hand.
//
// Authoritative signals throughout (CLAUDE.md): the change waits on the
// content-language PATCH response (armed before the click) and then on a
// reloaded read; created work is read back through `get_work_item` /
// `list_work_item_todos` over `/api/mcp`. The holds inside `chapter()` /
// `beat()` are pacing for the viewer, never a wait.

import { writeFile } from 'node:fs/promises';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Page, Request } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { isLandedWorkbenchUrl } from './_helpers/workbench-landing';
import { msg, signInHere, signUpHere } from './_helpers/i18n-walk';
import {
  CONTENT_LANGUAGE_PASSWORD,
  OLD_RECORDED_TITLE,
  languagesOf,
  mcp,
  openMcp,
  seedContentLanguageOrg,
  type ContentLanguageSeed,
} from './_helpers/content-language-seed';

const PASSWORD = 'content-language-e2e-9';
const ORG_SETTINGS = '/settings/organization';
const ACCOUNT_LANGUAGE = '/settings/account/language';

test.afterAll(async () => {
  await adminDb.$disconnect();
});

/** The General card's Content language Combobox, named in the page's language. */
function contentLanguageControl(page: Page, lang: string) {
  return page
    .getByRole('main')
    .getByRole('combobox', { name: msg(lang, 'orgAdmin.settings.contentLanguageLabel') });
}

/** The organisation a freshly signed-up person owns. */
async function ownedOrgLanguage(email: string): Promise<string> {
  const membership = await adminDb.organizationMembership.findFirstOrThrow({
    where: { user: { email } },
    include: { organization: true },
  });
  return membership.organization.contentLanguage;
}

const isContentLanguagePatch = (orgId: string) => (req: Request) =>
  req.method() === 'PATCH' && req.url().endsWith(`/api/organizations/${orgId}/content-language`);

// ── 1 ───────────────────────────────────────────────────────────────────────

test.describe('a Chinese browser signs up', () => {
  test.use({ locale: 'zh-CN' });
  const EMAIL = 'e2e-content-language-zh@example.com';

  test.beforeAll(async () => {
    await resetDatabase();
  });

  test('its new organisation writes in 中文', async ({ page, chapter, beat, acceptanceStory }) => {
    acceptanceStory('MOTIR-7731');

    await chapter('A Chinese browser signs up with email and password', async () => {
      await page.goto('/sign-up');
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh', {
        timeout: FIRST_PAINT_MS,
      });
      await signUpHere(page, EMAIL, PASSWORD);
      await beat();
    });

    await chapter('Settings → Organization → General: Content language is 中文', async () => {
      await page.goto(ORG_SETTINGS);
      await expect(contentLanguageControl(page, 'zh')).toContainText('中文', {
        timeout: FIRST_PAINT_MS,
      });
      expect(await ownedOrgLanguage(EMAIL)).toBe('zh');
      await beat();
    });
  });
});

// ── 2 ───────────────────────────────────────────────────────────────────────

test.describe('a Chinese browser signs up with Google', () => {
  test.use({ locale: 'zh-CN' });
  const EMAIL = 'e2e-content-language-google@example.com';
  const GOOGLE_IDENTITY_PATH =
    process.env['E2E_TEST_OAUTH_USER_PATH'] ?? '/tmp/motir-test-oauth-user.json';

  test.beforeAll(async () => {
    await resetDatabase();
  });

  test('its new organisation writes in 中文 too', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7731');

    // The `auth-google.spec.ts` seam: the hop to accounts.google.com is 302'd
    // straight back to Better-Auth's callback (state echoed), and the server's
    // token-exchange mock returns the identity written below.
    await page.route('**/accounts.google.com/**', async (route) => {
      const url = new URL(route.request().url());
      const callback = new URL(
        url.searchParams.get('redirect_uri') ??
          new URL('/api/auth/callback/google', baseURL).toString(),
      );
      callback.searchParams.set('code', `mock-auth-code-${Date.now()}`);
      callback.searchParams.set('state', url.searchParams.get('state') ?? '');
      callback.searchParams.set('scope', 'openid email profile');
      await route.fulfill({ status: 302, headers: { location: callback.toString() }, body: '' });
    });

    await chapter('A Chinese browser continues with Google', async () => {
      await writeFile(
        GOOGLE_IDENTITY_PATH,
        JSON.stringify({
          sub: `google-sub-8100-${Date.now()}`,
          email: EMAIL,
          name: 'Content Language',
          emailVerified: true,
        }),
        'utf8',
      );
      await page.goto('/sign-in');
      await page
        .getByRole('main')
        .getByRole('button', { name: msg('zh', 'auth.continueWithGoogle'), exact: true })
        .click({ timeout: FIRST_PAINT_MS });
      await page.waitForURL(isLandedWorkbenchUrl, { timeout: 30_000 });
      await beat();
    });

    await chapter('Its organisation’s Content language is 中文', async () => {
      await page.goto(ORG_SETTINGS);
      await expect(contentLanguageControl(page, 'zh')).toContainText('中文', {
        timeout: FIRST_PAINT_MS,
      });
      expect(await ownedOrgLanguage(EMAIL)).toBe('zh');
      await beat();
    });
  });
});

// ── 3 ───────────────────────────────────────────────────────────────────────

test.describe('a Japanese browser signs up', () => {
  test.use({ locale: 'ja-JP' });
  const EMAIL = 'e2e-content-language-ja@example.com';

  test.beforeAll(async () => {
    await resetDatabase();
  });

  test('the app is Japanese, and the content language English', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7731');

    await chapter('A Japanese browser signs up', async () => {
      await page.goto('/sign-up');
      await expect(page.locator('html')).toHaveAttribute('lang', 'ja', {
        timeout: FIRST_PAINT_MS,
      });
      await signUpHere(page, EMAIL, PASSWORD);
      await beat();
    });

    await chapter('The settings are in Japanese; the content language is English', async () => {
      await page.goto(ORG_SETTINGS);
      await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
      await expect(
        page.getByRole('heading', { name: msg('ja', 'orgAdmin.settings.general') }),
      ).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(contentLanguageControl(page, 'ja')).toContainText('English');
      expect(await ownedOrgLanguage(EMAIL)).toBe('en');
      await beat();
    });
  });
});

// ── 4–9 ─────────────────────────────────────────────────────────────────────

test.describe('an organisation that existed before', () => {
  test.use({ locale: 'en-US' });
  test.describe.configure({ mode: 'serial' });

  let seed: ContentLanguageSeed;
  let client: Client;

  test.beforeAll(async ({ baseURL }) => {
    await resetDatabase();
    seed = await seedContentLanguageOrg();
    client = await openMcp(seed.token, baseURL!);
  });

  test.afterAll(async () => {
    await client?.close();
  });

  test('a member reads it, and cannot change it', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7731');

    await chapter('A member opens Account settings → Language & region', async () => {
      await signInHere(page, seed.memberEmail, CONTENT_LANGUAGE_PASSWORD);
      await page.goto(ACCOUNT_LANGUAGE);
      const main = page.getByRole('main');
      const row = main.getByTestId('content-language-readonly');
      await expect(row).toContainText('Content language · Content Language E2E', {
        timeout: FIRST_PAINT_MS,
      });
      await expect(row.getByText('English', { exact: true })).toHaveAttribute('lang', 'en');
      // The one combobox on the pane is their own display language; this row has none.
      await expect(row.getByRole('combobox')).toHaveCount(0);
      await expect(main.getByRole('combobox')).toHaveCount(1);
      await expect(row.getByRole('link', { name: 'Change in Organization settings' })).toHaveCount(
        0,
      );
      await beat();
    });

    await chapter('A direct request to change it is refused', async () => {
      const res = await page.request.patch(`/api/organizations/${seed.orgId}/content-language`, {
        data: { language: 'ja' },
      });
      expect(res.status()).toBe(403);
      const org = await adminDb.organization.findUniqueOrThrow({ where: { id: seed.orgId } });
      expect(org.contentLanguage).toBe('en');
      await beat();
    });

    await chapter('Reloaded, the content language still reads English', async () => {
      await page.reload();
      const row = page.getByRole('main').getByTestId('content-language-readonly');
      await expect(row.getByText('English', { exact: true })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await beat();
    });
  });

  test('the owner changes it, through the confirm', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7731');
    const patches: string[] = [];
    page.on('request', (req) => {
      if (isContentLanguagePatch(seed.orgId)(req)) patches.push(req.url());
    });
    const card = () => page.getByRole('main');

    await chapter('The owner sees English on the General card', async () => {
      await signInHere(page, seed.ownerEmail, CONTENT_LANGUAGE_PASSWORD);
      await page.goto(ORG_SETTINGS);
      await expect(contentLanguageControl(page, 'en')).toContainText('English', {
        timeout: FIRST_PAINT_MS,
      });
      await beat();
    });

    const chooseJapaneseAndSave = async () => {
      await contentLanguageControl(page, 'en').click();
      await page.getByRole('option', { name: '日本語', exact: true }).click();
      await card().getByRole('button', { name: 'Save changes' }).click();
      return page.getByRole('dialog', { name: 'Change the content language?' });
    };

    await chapter('Save opens a confirm that names both languages', async () => {
      const dialog = await chooseJapaneseAndSave();
      await expect(dialog).toContainText('English');
      await expect(dialog).toContainText('日本語');
      await expect(dialog).toContainText(
        'Work that already exists keeps its text and its language. Nothing is translated or rewritten — only new writing changes.',
      );
      await beat();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      await expect(contentLanguageControl(page, 'en')).toContainText('English');
    });

    await chapter('Escape closes it too, and nothing was sent', async () => {
      const dialog = await chooseJapaneseAndSave();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(contentLanguageControl(page, 'en')).toContainText('English');
      expect(patches).toEqual([]);
      await beat();
    });

    await chapter('Confirm saves 日本語, and it survives a reload', async () => {
      const dialog = await chooseJapaneseAndSave();
      const saved = page.waitForResponse((res) =>
        isContentLanguagePatch(seed.orgId)(res.request()),
      );
      await dialog.getByRole('button', { name: 'Change to 日本語' }).click();
      expect((await saved).status()).toBe(200);
      await page.reload();
      await expect(contentLanguageControl(page, 'en')).toContainText('日本語', {
        timeout: FIRST_PAINT_MS,
      });
      await expect(card().getByText(/Changed from English by Olivia Owner on/)).toBeVisible();
      await beat();
    });
  });

  test('old work keeps its language, and new work records 日本語', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7731');

    await chapter('Work written before the change reads as before', async () => {
      await signInHere(page, seed.ownerEmail, CONTENT_LANGUAGE_PASSWORD);
      await page.goto(`/items/${seed.oldRecordedKey}`);
      await expect(page.getByRole('main').getByText(OLD_RECORDED_TITLE).first()).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      expect(await languagesOf(client, seed.oldRecordedKey)).toEqual({
        title: 'en',
        description: 'en',
        explanation: null,
      });
      // Written before content languages existed: no language, never `en`.
      expect(await languagesOf(client, seed.oldUnrecordedKey)).toEqual({
        title: null,
        description: null,
        explanation: null,
      });
      await beat();
    });

    let uiKey = '';
    await chapter('A work item and a step created in the app record 日本語', async () => {
      await page.goto('/items');
      await page.getByRole('button', { name: 'Create work item' }).click();
      await page.getByRole('textbox', { name: 'Title' }).fill('リリースノートを公開する');
      await page.getByRole('textbox', { name: 'Description' }).fill('今週の変更をまとめる。');
      await page.getByRole('button', { name: 'Create' }).click();
      const toast = page.getByText(/^\S+ created$/).first();
      await expect(toast).toBeVisible();
      uiKey = (await toast.textContent())!.replace(/ created$/, '');

      await page.goto(`/items/${uiKey}`);
      await page.getByRole('main').getByTestId('todo-add-input').fill('告知文を書く');
      await page.getByRole('button', { name: 'Add step' }).click();
      await expect(
        page.getByRole('main').getByTestId('todo-text').filter({ hasText: '告知文を書く' }),
      ).toBeVisible();
      await beat();

      expect(await languagesOf(client, uiKey)).toEqual({
        title: 'ja',
        description: 'ja',
        explanation: null,
      });
      const todos = await mcp<{ items: { textLanguage: string | null }[] }>(
        client,
        'list_work_item_todos',
        { key: uiKey },
      );
      expect(todos.items.map((t) => t.textLanguage)).toEqual(['ja']);
    });

    await chapter('An agent’s work through the MCP records 日本語 too', async () => {
      const { identifier } = await mcp<{ identifier: string }>(client, 'create_work_item', {
        projectKey: 'LANG',
        kind: 'task',
        title: '翻訳を確認する',
        descriptionMd: '用語集と照合する。',
      });
      await mcp(client, 'add_work_item_todo', { key: identifier, text: '差分を読む' });
      expect(await languagesOf(client, identifier)).toEqual({
        title: 'ja',
        description: 'ja',
        explanation: null,
      });
      const todos = await mcp<{ items: { textLanguage: string | null }[] }>(
        client,
        'list_work_item_todos',
        { key: identifier },
      );
      expect(todos.items.map((t) => t.textLanguage)).toEqual(['ja']);

      // Verification 9 — an explicit language wins for the field it names.
      await mcp(client, 'update_work_item', {
        key: identifier,
        explanationMd: '팀이 이 항목을 기다린다.',
        languages: { explanation: 'ko' },
      });
      expect(await languagesOf(client, identifier)).toEqual({
        title: 'ja',
        description: 'ja',
        explanation: 'ko',
      });

      await page.goto(`/items/${identifier}`);
      await expect(page.getByRole('main').getByText('翻訳を確認する').first()).toBeVisible();
      await beat();
    });
  });
});
