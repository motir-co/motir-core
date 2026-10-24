// ACCEPTANCE: pick your font per language (Story MOTIR-7736 · Subtask MOTIR-7901).
//
// The story's Verification, run in a real browser against a production build
// and recorded as its receipt:
//
//   1. a ja pick applies to the page with no reload, before its save returns;
//   2. a second browser paints the pick from the first byte;
//   3. a ko pick is independent of the ja one, and both survive a reload;
//   4. Editorial keeps its Latin faces under the ja pick;
//   5. Automatic clears the pick;
//   6. a fresh browser fetches only the faces the page needs (not filmed);
//   7. the personal-data export carries the picks (not filmed);
//   8. a signed-out page is unchanged;
//   9. a failed save is quiet and keeps the choice.
//
// ⚠️ THE DESIGN THIS PLAYS IS MOTIR-7895 REVISION 3, not the card's first text.
// There is no separate "Fonts by language" field with a row per language. The
// Typography axis IS the font choice, and its options follow the PAGE language:
// a ja page lists "Automatic (Noto Sans JP)", Noto Sans JP and M PLUS Rounded
// 1c; a ko page Automatic, Noto Sans KR and Nanum Gothic; a Latin page the six
// type pairings. Each language keeps its own pick (`fontPicks[locale]`). So the
// ko case switches the account language to Korean to pick, and Editorial can
// only be chosen on a Latin page.
//
// ⚠️ THE FILE IS NAMED `acceptance-*.spec.ts`: `playwright.acceptance.config.ts`
// matches `acceptance*.spec.ts`, and that lane records the video and publishes
// it to the story each filmed test declares. The two unfilmed tests (6, 7) take
// no `chapter`, so they write no `chapters.json` and the uploader skips them.
// A filmed test opens no context besides its own `page`: a recording is one
// test directory's video, and a second context would put a second `.webm` in it.
//
// ⚠️ EVERY FACE ASSERTION READS WHAT THE BROWSER DREW OR FETCHED
// (`_helpers/font-probe.ts`): `CSS.getPlatformFontsForNode` for a named node,
// or the font request log of a fresh context. A computed `font-family` is read
// only to FIND a node of a given role, never to judge it.
//
// Authoritative signals: every save waits on its `PATCH` response, armed before
// the click; server-applied state is read from the RAW document's `<html …>`
// opening tag; a language change waits on its server action and `<html lang>`.
// The holds in `chapter()` / `beat()` are pacing for the viewer, never a wait.

import type {
  Browser,
  BrowserContext,
  CDPSession,
  Locator,
  Page,
  Response,
} from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import {
  FONT_SET_REGISTRY,
  FONT_SET_ROLES,
  type FontSetMember,
} from '../../packages/design-system/src/theme/fontSets';
// ↑ The module's source, not the package: the package's `exports` offer only
// an ESM `import` condition, which Playwright's CommonJS loader cannot resolve.
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import {
  msg,
  saveAccountLanguageInSettings,
  seedOwnProject,
  signInHere,
  signUpHere,
  type Locale,
} from './_helpers/i18n-walk';
import {
  ALL_PAIRING_FACES,
  PAIRING_FACES,
  PAIRING_NAMES,
  attribute,
  cdpFor,
  expectDrawnIn,
  inject,
  platformFonts,
  registryFaces,
  isFace,
} from './_helpers/font-probe';
import { buildPersonalDataArchive } from '@/lib/export/personalDataArchive';

const EMAIL = 'e2e-font-picks@example.com';
const PASSWORD = 'font-picks-e2e-9';
const PANE = '/settings/account/appearance';

// ── The faces, from the registry ────────────────────────────────────────────

const { defaultFace, setFamilies } = registryFaces(FONT_SET_REGISTRY, FONT_SET_ROLES);

function member(setId: 'ja' | 'ko', id: string): FontSetMember {
  const found = (FONT_SET_REGISTRY[setId].roles.sans.members as readonly FontSetMember[]).find(
    (m) => m.id === id,
  );
  if (!found?.family) throw new Error(`the ${setId} sans role has no member ${id}`);
  return found;
}

/** The ja sans default (Noto Sans JP) — what Automatic stands for on a ja page. */
const JA_DEFAULT = defaultFace('ja', 'sans');
/** The ja member this story picks. */
const JA_PICK = member('ja', 'm-plus-rounded-1c');
/** The ko member this story picks. */
const KO_PICK = member('ko', 'nanum-gothic');
const KO_DEFAULT = defaultFace('ko', 'sans');

// ── The pane ────────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The Typography axis, named in the page's language. */
function typography(page: Page, lang: Locale): Locator {
  return page
    .getByRole('main')
    .getByRole('radiogroup', { name: msg(lang, 'settings.appearance.type.name'), exact: true });
}

/**
 * One option of the Typography axis. A font chip's accessible name is its label
 * followed by its script sample (`M PLUS Rounded 1c ひらがなと漢字`), so it is
 * matched from the start; "Noto Sans JP" alone would also match the start of no
 * other chip, since Automatic's label opens with 自動.
 */
function option(page: Page, lang: Locale, label: string): Locator {
  return typography(page, lang).getByRole('radio', {
    name: new RegExp(`^${escapeRegExp(label)}`),
  });
}

function automaticLabel(lang: Locale, family: string): string {
  return msg(lang, 'settings.appearance.type.automatic', { font: family });
}

function isPatch(r: Response): boolean {
  return r.url().includes('/api/appearance-preference') && r.request().method() === 'PATCH';
}

interface PatchResult {
  status: number;
  sent: unknown;
  preference: { fontPicks?: Record<string, string>; typeId?: string } | null;
}

/** Click `target` with the save's response armed first, and return what it sent and got. */
async function pickAndSave(page: Page, target: Locator): Promise<PatchResult> {
  const saved = page.waitForResponse(isPatch);
  await target.click();
  const res = await saved;
  const body = res.ok()
    ? ((await res.json()) as { preference: PatchResult['preference'] })
    : { preference: null };
  return { status: res.status(), sent: res.request().postDataJSON(), preference: body.preference };
}

/** Save the account language in Settings, unless the page already renders it. */
async function setAccountLanguage(page: Page, locale: Locale): Promise<void> {
  await page.goto('/settings/account/language');
  if ((await page.locator('html').getAttribute('lang')) === locale) return;
  await saveAccountLanguageInSettings(page, locale);
}

/** Open the Appearance pane on a page in `lang`, and return its card heading (a sans node). */
async function openPane(page: Page, lang: Locale): Promise<Locator> {
  await page.goto(PANE);
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
  await expect(typography(page, lang)).toBeVisible({ timeout: FIRST_PAINT_MS });
  // The card's own title is set in the sans role (`font-sans`) and carries no
  // `lang` of its own, so it inherits <html>'s pick. The chips' samples do carry
  // `lang` and so preview each face whatever is picked; they are never measured.
  const heading = page
    .getByRole('main')
    .getByRole('heading', { name: msg(lang, 'settings.appearance.card.title'), exact: true });
  await expect(heading).toBeVisible();
  return heading;
}

/** The raw `<html …>` opening tag of a document response: what the SERVER sent. */
async function serverHtmlTag(response: Response | null): Promise<string> {
  expect(response, 'the document answered').not.toBeNull();
  const markup = await response!.text();
  const open = markup.indexOf('<html');
  expect(open, 'the document has an <html> tag').toBeGreaterThanOrEqual(0);
  return markup.slice(open, markup.indexOf('>', open) + 1);
}

// ── Finding a node of a role, by what it is, never by what it drew ──────────

type Role = 'sans' | 'serif' | 'mono';

/**
 * Mark up to `limit` rendered elements that hold Japanese text of their own, set
 * in `role`, and inherit <html>'s language (no `lang` of their own or on an
 * ancestor below <html>), and return them. The role is read by comparing the
 * element's computed `font-family` with a reference element set in
 * `var(--font-<role>)` — that only FINDS the node; the face it drew is CDP's.
 */
async function japaneseNodes(page: Page, role: Role, limit: number): Promise<Locator[]> {
  const tag = `jp-${role}-${Date.now()}`;
  const count = await page.evaluate(
    ({ role: wanted, tag: mark, limit: max }) => {
      const probe = document.createElement('span');
      probe.style.cssText = `position:absolute;visibility:hidden;font-family:var(--font-${wanted})`;
      document.body.append(probe);
      const family = getComputedStyle(probe).fontFamily;
      probe.remove();
      const jp = /[぀-ヿ㐀-鿿]/;
      let n = 0;
      for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
        if (n >= max) break;
        if (el.closest('[lang]') !== document.documentElement) continue;
        if (el.closest('[aria-hidden="true"], [data-injected]')) continue;
        const own = [...el.childNodes]
          .filter((c) => c.nodeType === Node.TEXT_NODE)
          .map((c) => c.textContent ?? '')
          .join('');
        if (!jp.test(own) || el.getClientRects().length === 0) continue;
        if (getComputedStyle(el).fontFamily !== family) continue;
        el.setAttribute('data-jp-node', `${mark}-${n++}`);
      }
      return n;
    },
    { role, tag, limit },
  );
  return Array.from({ length: count }, (_, i) => page.locator(`[data-jp-node="${tag}-${i}"]`));
}

// ── Reading what a fresh browser fetched ────────────────────────────────────

/** A fresh context (no font cache) carrying `cookies`, recording every font file it fetches. */
async function freshContext(
  browser: Browser,
  cookies: Awaited<ReturnType<BrowserContext['cookies']>>,
  locale?: string,
): Promise<{ context: BrowserContext; page: Page; files: string[] }> {
  const context = await browser.newContext({
    storageState: { cookies, origins: [] },
    ...(locale ? { locale } : {}),
  });
  const page = await context.newPage();
  const files: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'font') files.push(r.url());
  });
  return { context, page, files };
}

/** Sign in once in a throwaway context and return the session's cookies. */
async function signedInCookies(
  browser: Browser,
): Promise<Awaited<ReturnType<BrowserContext['cookies']>>> {
  const context = await browser.newContext({ locale: 'en-US' });
  try {
    await signInHere(await context.newPage(), EMAIL, PASSWORD);
    return await context.cookies();
  } finally {
    await context.close();
  }
}

// ── The account ─────────────────────────────────────────────────────────────

let userId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await resetDatabase();
  const context = await browser.newContext({ locale: 'en-US' });
  await signUpHere(await context.newPage(), EMAIL, PASSWORD);
  await context.close();
  // The dashboard needs an active project to render.
  await seedOwnProject(EMAIL);
  userId = (await adminDb.user.findUniqueOrThrow({ where: { email: EMAIL } })).id;
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

// ── 1 ───────────────────────────────────────────────────────────────────────

test.describe('signed in, in Japanese', () => {
  test.use({ locale: 'en-US' });

  test('1 · a ja pick applies to the page with no reload, before its save returns', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7736');
    test.setTimeout(150_000);
    const cdp = await cdpFor(page);
    let heading!: Locator;

    await chapter('Signed in, the account language set to Japanese', async () => {
      await signInHere(page, EMAIL, PASSWORD);
      await setAccountLanguage(page, 'ja');
      heading = await openPane(page, 'ja');
      await expect(option(page, 'ja', automaticLabel('ja', JA_DEFAULT))).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(page.locator('html')).not.toHaveAttribute('data-font-set-sans', /.*/);
      await expectDrawnIn(cdp, heading, { in: [JA_DEFAULT], only: ALL_PAIRING_FACES });
      await beat();
    });

    await chapter(`Typography → ${JA_PICK.family}: the page redraws in place`, async () => {
      // When did <html> take the attribute, against when the save even started?
      await page.evaluate(() => {
        const w = window as unknown as { __pickAppliedAt: number | null };
        w.__pickAppliedAt = null;
        new MutationObserver(() => {
          if (document.documentElement.hasAttribute('data-font-set-sans'))
            w.__pickAppliedAt ??= performance.now();
        }).observe(document.documentElement, { attributeFilter: ['data-font-set-sans'] });
      });
      let navigations = 0;
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });

      const saved = await pickAndSave(page, option(page, 'ja', JA_PICK.family!));
      expect(saved.status).toBe(200);
      expect(saved.sent).toEqual({ fontPicks: { ja: JA_PICK.id } });
      expect(saved.preference?.fontPicks?.ja).toBe(JA_PICK.id);
      await expect(page.locator('html')).toHaveAttribute('data-font-set-sans', JA_PICK.id);

      // Applied BEFORE the request was sent, so necessarily before it returned.
      const timing = await page.evaluate(() => {
        const save = performance
          .getEntriesByType('resource')
          .filter((e) => e.name.includes('/api/appearance-preference'))
          .at(-1);
        return {
          appliedAt: (window as unknown as { __pickAppliedAt: number | null }).__pickAppliedAt,
          saveStartedAt: save?.startTime ?? null,
        };
      });
      expect(timing.appliedAt, '<html> took the pick').not.toBeNull();
      expect(timing.saveStartedAt, 'the save is in the resource timeline').not.toBeNull();
      expect(timing.appliedAt!, 'applied before the save was sent').toBeLessThan(
        timing.saveStartedAt!,
      );

      await expect(option(page, 'ja', JA_PICK.family!)).toHaveAttribute('aria-checked', 'true');
      await expectDrawnIn(cdp, heading, {
        in: [JA_PICK.family!],
        only: ALL_PAIRING_FACES,
        never: [JA_DEFAULT],
      });
      expect(navigations, 'the page did not navigate').toBe(0);
      await beat();
    });
  });
});

// ── 2 ───────────────────────────────────────────────────────────────────────

test.describe('a second browser', () => {
  test.use({ locale: 'en-US' });

  test('2 · paints the pick from the first byte', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7736');
    test.setTimeout(120_000);
    const cdp = await cdpFor(page);

    await chapter('A second browser signs in as the same person', async () => {
      await signInHere(page, EMAIL, PASSWORD);
      await beat();
    });

    await chapter(`/dashboard arrives already in ${JA_PICK.family}`, async () => {
      // Record every change to <html data-font-set-sans>, from the first script on.
      // The client re-applies the same pick on mount; a write that leaves the
      // value as it was is not a change, so only old !== new is recorded.
      await page.addInitScript(() => {
        const w = window as unknown as { __fontSetChanges: (string | null)[] };
        w.__fontSetChanges = [];
        // `document`, not `<html>`: an init script runs before `<html>` exists.
        new MutationObserver((records) => {
          for (const r of records) {
            if (r.target !== document.documentElement) continue;
            const now = document.documentElement.getAttribute('data-font-set-sans');
            if (r.oldValue !== now) w.__fontSetChanges.push(now);
          }
        }).observe(document, {
          attributes: true,
          attributeOldValue: true,
          subtree: true,
          attributeFilter: ['data-font-set-sans'],
        });
      });
      const response = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      const tag = await serverHtmlTag(response);
      expect(tag, 'the server sent the page in Japanese').toMatch(/\slang="ja"/);
      expect(tag, 'the server sent the pick on the first byte').toContain(
        `data-font-set-sans="${JA_PICK.id}"`,
      );

      await expect(page.getByRole('main').getByTestId('dashboard-page')).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await beat();
      const [first] = await japaneseNodes(page, 'sans', 1);
      expect(first, 'the dashboard renders Japanese text in the sans role').toBeDefined();
      await expectDrawnIn(cdp, first!, {
        in: [JA_PICK.family!],
        only: ALL_PAIRING_FACES,
        never: [JA_DEFAULT],
      });
      // The attribute was in the parsed document and nothing ever changed it,
      // so no frame could have drawn the sans role in the default face.
      expect(
        await page.evaluate(
          () => (window as unknown as { __fontSetChanges: string[] }).__fontSetChanges,
        ),
        'the pick never changed after the server rendered it',
      ).toEqual([]);
      await beat();
    });
  });
});

// ── 3 · 4 · 5 · 9 ───────────────────────────────────────────────────────────

test.describe('back in the pane', () => {
  test.use({ locale: 'en-US' });

  test('3 · 4 · 5 · 9 · ko is independent, Editorial keeps Latin, Automatic clears, a failed save is quiet', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7736');
    test.setTimeout(300_000);
    const cdp = await cdpFor(page);
    const html = page.locator('html');

    await chapter('Signed in, in Japanese', async () => {
      await signInHere(page, EMAIL, PASSWORD);
      await setAccountLanguage(page, 'ja');
    });

    // ── 3 ──
    await chapter(`Korean: Typography → ${KO_PICK.family}`, async () => {
      await saveAccountLanguageInSettings(page, 'ko');
      const heading = await openPane(page, 'ko');
      await expect(option(page, 'ko', automaticLabel('ko', KO_DEFAULT))).toHaveAttribute(
        'aria-checked',
        'true',
      );
      const saved = await pickAndSave(page, option(page, 'ko', KO_PICK.family!));
      expect(saved.status).toBe(200);
      expect(saved.sent).toEqual({ fontPicks: { ko: KO_PICK.id } });
      expect(saved.preference?.fontPicks).toMatchObject({ ja: JA_PICK.id, ko: KO_PICK.id });
      await expect(html).toHaveAttribute('data-font-set-sans', KO_PICK.id);
      await expectDrawnIn(cdp, heading, {
        in: [KO_PICK.family!],
        only: ALL_PAIRING_FACES,
        never: [KO_DEFAULT],
      });
      await beat();
    });

    await chapter(`Reloaded, Korean keeps ${KO_PICK.family}`, async () => {
      const response = await page.reload();
      expect(await serverHtmlTag(response)).toContain(`data-font-set-sans="${KO_PICK.id}"`);
      await expect(option(page, 'ko', KO_PICK.family!)).toHaveAttribute('aria-checked', 'true');
    });

    await chapter(`Back in Japanese, ${JA_PICK.family} is still picked and drawn`, async () => {
      await saveAccountLanguageInSettings(page, 'ja');
      const response = await page.goto(PANE);
      expect(await serverHtmlTag(response)).toContain(`data-font-set-sans="${JA_PICK.id}"`);
      const heading = await openPane(page, 'ja');
      await expect(html).toHaveAttribute('data-font-set-sans', JA_PICK.id);
      await expect(option(page, 'ja', JA_PICK.family!)).toHaveAttribute('aria-checked', 'true');
      await expectDrawnIn(cdp, heading, {
        in: [JA_PICK.family!],
        only: ALL_PAIRING_FACES,
        never: [JA_DEFAULT],
      });
      await beat();
    });

    // ── 4 ──
    await chapter('English: Typography → Editorial', async () => {
      await saveAccountLanguageInSettings(page, 'en');
      await openPane(page, 'en');
      const saved = await pickAndSave(
        page,
        typography(page, 'en').getByRole('radio', { name: PAIRING_NAMES.editorial, exact: true }),
      );
      expect(saved.status).toBe(200);
      expect(saved.preference?.typeId).toBe('editorial');
      await expect(html).toHaveAttribute('data-type', 'editorial');
      await expect(html).not.toHaveAttribute('data-font-set-sans', /.*/);
    });

    await chapter(
      `Japanese under Editorial: Latin in its faces, kana in ${JA_PICK.family}`,
      async () => {
        await saveAccountLanguageInSettings(page, 'ja');
        await openPane(page, 'ja');
        await expect(html).toHaveAttribute('data-type', 'editorial');
        await expect(html).toHaveAttribute('data-font-set-sans', JA_PICK.id);
        const faces = PAIRING_FACES.editorial!;
        const probe = await inject(
          page,
          (['sans', 'serif'] as const)
            .map(
              (role) =>
                `<div data-role="${role}" style="font-family:var(--font-${role});font-size:24px">` +
                `<span data-run="latin">${role} Hamburgefonstiv</span> ` +
                `<span data-run="ja">いろはにほへと</span></div>`,
            )
            .join(''),
        );
        const sans = probe.locator('[data-role="sans"]');
        const serif = probe.locator('[data-role="serif"]');
        await expectDrawnIn(cdp, sans.locator('[data-run="latin"]'), { in: [faces.sans] });
        await expectDrawnIn(cdp, sans.locator('[data-run="ja"]'), {
          in: [JA_PICK.family!],
          never: [JA_DEFAULT],
        });
        await expectDrawnIn(cdp, serif.locator('[data-run="latin"]'), { in: [faces.serif] });
        await expectDrawnIn(cdp, serif.locator('[data-run="ja"]'), {
          in: [defaultFace('ja', 'serif')],
        });
        await beat();
        await probe.evaluate((el) => el.remove());
      },
    );

    // ── 5 ──
    await chapter(`Typography → ${automaticLabel('ja', JA_DEFAULT)}`, async () => {
      const heading = await openPane(page, 'ja');
      const saved = await pickAndSave(page, option(page, 'ja', automaticLabel('ja', JA_DEFAULT)));
      expect(saved.status).toBe(200);
      expect(saved.sent).toEqual({ fontPicks: { ja: null } });
      expect(Object.keys(saved.preference?.fontPicks ?? {}), 'no ja pick stored').not.toContain(
        'ja',
      );
      await expect(html).not.toHaveAttribute('data-font-set-sans', /.*/);
      await expectDrawnIn(cdp, heading, {
        in: [JA_DEFAULT],
        only: ALL_PAIRING_FACES,
        never: [JA_PICK.family!],
      });
      await beat();

      // Picked again, for the fresh-browser and export checks that follow.
      const again = await pickAndSave(page, option(page, 'ja', JA_PICK.family!));
      expect(again.status).toBe(200);
      expect(again.preference?.fontPicks?.ja).toBe(JA_PICK.id);
      await expect(html).toHaveAttribute('data-font-set-sans', JA_PICK.id);
    });

    // ── 9 ──
    const errorText = msg('ja', 'settings.appearance.sync.error');
    const footer = page.getByRole('status').filter({ hasText: errorText });

    await chapter('The save fails: a quiet note, and the choice stays', async () => {
      await page.route('**/api/appearance-preference', (route) =>
        route.request().method() === 'PATCH'
          ? route.fulfill({ status: 500, body: '{}' })
          : route.continue(),
      );
      const first = await pickAndSave(page, option(page, 'ja', JA_DEFAULT));
      expect(first.status).toBe(500);
      const second = await pickAndSave(page, option(page, 'ja', automaticLabel('ja', JA_DEFAULT)));
      expect(second.status).toBe(500);

      await expect(footer).toHaveCount(1);
      await expect(footer).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      // A Radix toast is an <li data-swipe-direction> in the notifications viewport.
      await expect(page.locator('li[data-swipe-direction]')).toHaveCount(0);
      // The optimistic choice stands, and the page wears it.
      await expect(option(page, 'ja', automaticLabel('ja', JA_DEFAULT))).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(html).not.toHaveAttribute('data-font-set-sans', /.*/);
      await beat();
    });

    await chapter(`The next save succeeds and the note goes`, async () => {
      await page.unroute('**/api/appearance-preference');
      const saved = await pickAndSave(page, option(page, 'ja', JA_PICK.family!));
      expect(saved.status).toBe(200);
      expect(saved.preference?.fontPicks).toMatchObject({ ja: JA_PICK.id, ko: KO_PICK.id });
      await expect(footer).toHaveCount(0);
      await expect(html).toHaveAttribute('data-font-set-sans', JA_PICK.id);
      await beat();
    });
  });
});

// ── 6 (not filmed) ──────────────────────────────────────────────────────────

test('6 · a fresh browser fetches only the faces the page needs', async ({ browser }) => {
  test.setTimeout(120_000);
  const pref = await adminDb.userAppearancePreference.findUniqueOrThrow({ where: { userId } });
  expect(pref.fontPickJa, 'the ja pick is stored').toBe(JA_PICK.id);
  expect(pref.fontPickKo, 'a ko pick is stored too').toBe(KO_PICK.id);

  const { context, page, files } = await freshContext(browser, await signedInCookies(browser));
  try {
    const response = await page.goto('/dashboard');
    expect(await serverHtmlTag(response)).toContain(`data-font-set-sans="${JA_PICK.id}"`);
    await expect(page.getByRole('main').getByTestId('dashboard-page')).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await page.evaluate(() => document.fonts.ready);
    // The log is read BEFORE any probe runs: a probe asks the browser to load
    // the face of the node it measures, which would add files to the log.
    const fetched = await attribute(page, [...files]);
    test.info().annotations.push({ type: 'fetched', description: fetched.join(', ') });

    expect(fetched, `${JA_PICK.family} files were fetched`).toContain(JA_PICK.family!);
    const otherScripts = [...setFamilies('zh-Hans'), ...setFamilies('ko')];
    expect(
      fetched.filter((f) => otherScripts.includes(f)),
      'no zh or ko face, Nanum Gothic included',
    ).toEqual([]);

    const cdp = await cdpFor(page);
    for (const node of await japaneseNodes(page, 'sans', 8)) {
      await expectDrawnIn(cdp, node, {
        in: [JA_PICK.family!],
        only: 'any',
        never: [JA_DEFAULT],
      });
    }
    if (fetched.includes(JA_DEFAULT)) {
      // Allowed ONLY for the mono role, which still reads the ja sans default:
      // the pick is not a mono member. So a mono node with Japanese text must
      // be on the page, drawing it.
      const monoNodes = await japaneseNodes(page, 'mono', 4);
      const drawnInDefault: string[] = [];
      for (const node of monoNodes) {
        const fonts = await platformFonts(cdp, node);
        if (fonts.some((f) => isFace(f.familyName, JA_DEFAULT)))
          drawnInDefault.push(fonts.map((f) => f.familyName).join(', '));
      }
      expect(
        drawnInDefault.length,
        `${JA_DEFAULT} was fetched, so a Japanese mono node must draw it (found ${monoNodes.length} Japanese mono nodes)`,
      ).toBeGreaterThan(0);
    }
  } finally {
    await context.close();
  }
});

// ── 7 (not filmed) ──────────────────────────────────────────────────────────

test('7 · the personal-data export lists the picks', async () => {
  // The archive the export build packages (`dataExportService.buildDataExport`
  // → `buildPersonalDataArchive`), opened from its bytes. The lane's worker
  // has no object store to upload to, so the archive is built here, through
  // the same function, rather than downloaded.
  const archive = await buildPersonalDataArchive(userId, new Date());
  const files = unzipSync(archive.bytes);
  const entry = files['user_appearance_preference.json'];
  expect(entry, 'the archive holds user_appearance_preference.json').toBeDefined();
  const doc = JSON.parse(strFromU8(entry!)) as { rows: Array<Record<string, unknown>> };
  expect(doc.rows).toHaveLength(1);
  expect(doc.rows[0]).toMatchObject({ fontPickJa: JA_PICK.id, fontPickKo: KO_PICK.id });
});

// ── 8 ───────────────────────────────────────────────────────────────────────

test.describe('a signed-out Japanese browser', () => {
  test.use({ locale: 'ja-JP' });

  test('8 · the sign-in page is unchanged', async ({ page, chapter, beat, acceptanceStory }) => {
    acceptanceStory('MOTIR-7736');
    const cdp: CDPSession = await cdpFor(page);
    const files: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'font') files.push(r.url());
    });

    await chapter('A signed-out Japanese browser opens the sign-in page', async () => {
      expect(await page.context().cookies(), 'nobody is signed in').toEqual([]);
      const response = await page.goto('/sign-in', { waitUntil: 'domcontentloaded' });
      const tag = await serverHtmlTag(response);
      expect(tag).toMatch(/\slang="ja"/);
      expect(tag, 'no font pick on a signed-out page').not.toContain('data-font-set-');
      const headline = page.getByRole('main').getByRole('heading', { level: 1 });
      await expect(headline).toHaveText(msg('ja', 'auth.welcomeBack'), { timeout: FIRST_PAINT_MS });
      // The headline is set in the serif role, so its default is the serif one.
      await expectDrawnIn(cdp, headline, {
        in: [defaultFace('ja', 'serif')],
        only: ALL_PAIRING_FACES,
      });
      await beat();
      // A second hold: the signed-out page is the whole of this receipt, and a
      // viewer needs the time to read it (the clip must clear the 15s floor).
      await beat();
    });

    await chapter(
      `The form reads in ${JA_DEFAULT}, and ${JA_PICK.family} never loads`,
      async () => {
        const button = page
          .getByRole('main')
          .getByRole('button', { name: msg('ja', 'auth.continue'), exact: true });
        await expect(button).toBeVisible();
        await expectDrawnIn(cdp, button, {
          in: [JA_DEFAULT],
          only: ALL_PAIRING_FACES,
          never: [JA_PICK.family!],
        });
        await page.evaluate(() => document.fonts.ready);
        const fetched = await attribute(page, [...files]);
        expect(fetched, `no ${JA_PICK.family} file`).not.toContain(JA_PICK.family!);
        await expect(page.locator('html')).not.toHaveAttribute('data-font-set-sans', /.*/);
        await beat();
      },
    );
  });
});
