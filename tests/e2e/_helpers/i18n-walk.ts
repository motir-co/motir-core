// Shared helpers for the eleven-languages story E2E (Story MOTIR-7730 ·
// MOTIR-7761): `regression-eleven-languages.spec.ts` (the receipt) and
// `i18n-locale-walk.spec.ts` (the nine-language walk).
//
// ⚠️ EVERY EXPECTED STRING IS READ FROM `messages/<locale>.json` AT RUN TIME.
// Nothing here types a translated sentence: a catalogue edit cannot turn these
// specs red, and a page rendered in the wrong language still does. The one
// exception is the eleven endonyms, which come from the app's own
// `localeLabel` map — they ARE what the story's criterion names.
//
// The browser's language is a context's Playwright `locale` option, which sets
// both `Accept-Language` and `navigator.language` — the real signal the request
// config reads. No header is injected by hand.

import fs from 'node:fs';
import path from 'node:path';
import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Response,
} from '@playwright/test';
import { localeLabel, locales, type Locale } from '@/lib/i18n/locales';
import { adminDb } from '@/tests/helpers/adminDb';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import { plansService } from '@/lib/services/plansService';
import type { PlanItemProposedFields } from '@/lib/dto/plans';
import { ONBOARDING_ENTRY_PATH } from '@/lib/navigation/landing';
import { isLandedWorkbenchUrl } from './workbench-landing';

export { localeLabel, locales, type Locale };

/** The nine languages the story turns on beyond English and Chinese. */
export const NEW_LOCALES = ['ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'] as const;

/** The fixed date the sprint and the work item are seeded with. */
export const SEEDED_DATE = new Date('2026-10-07T00:00:00.000Z');
/** The seeded sprint's end, in the same month so either end proves the month. */
export const SEEDED_SPRINT_END = new Date('2026-10-21T00:00:00.000Z');

// ── The catalogue, read at run time ─────────────────────────────────────────

type Catalogue = Map<string, string>;
const catalogues = new Map<string, Catalogue>();

function flatten(node: unknown, prefix: string, out: Catalogue): void {
  if (typeof node === 'string') {
    out.set(prefix, node);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
  }
}

/** `messages/<locale>.json`, flattened to leaf key paths. */
export function catalogue(locale: string): Catalogue {
  let flat = catalogues.get(locale);
  if (!flat) {
    const file = path.resolve(process.cwd(), 'messages', `${locale}.json`);
    flat = new Map();
    flatten(JSON.parse(fs.readFileSync(file, 'utf8')), '', flat);
    catalogues.set(locale, flat);
  }
  return flat;
}

/**
 * One message, as the locale's catalogue holds it, with simple `{name}`
 * arguments substituted. Falls back to English for a key the locale lacks —
 * which is what the app itself renders (`withEnglishFallback`).
 */
export function msg(locale: string, key: string, args: Record<string, string> = {}): string {
  const raw = catalogue(locale).get(key) ?? catalogue('en').get(key);
  if (raw === undefined) throw new Error(`messages/en.json has no key "${key}"`);
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => args[name] ?? whole);
}

/** The page's `<html lang>`, which is the language the request resolved to. */
export async function htmlLang(page: Page): Promise<string> {
  return (await page.locator('html').getAttribute('lang')) ?? '';
}

// ── The raw-key scan ────────────────────────────────────────────────────────

let rawKeys: Set<string> | null = null;

/** `en.json`'s leaf key paths with two or more segments. */
function englishKeyPaths(): Set<string> {
  if (!rawKeys) {
    rawKeys = new Set([...catalogue('en').keys()].filter((key) => key.includes('.')));
  }
  return rawKeys;
}

/**
 * The page shows no raw message key: `document.body.innerText` contains none of
 * `en.json`'s flattened key paths (two or more segments), matched as WHOLE
 * tokens — so `shell.nav.issues` fails and `example.com` does not.
 */
export async function assertNoRawKeys(page: Page, where: string): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText);
  const keys = englishKeyPaths();
  const tokens = text.match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/g) ?? [];
  const found = [...new Set(tokens.filter((token) => keys.has(token)))];
  expect(found, `raw message keys rendered on ${where}`).toEqual([]);
}

// ── Dates ───────────────────────────────────────────────────────────────────

/** The seeded date's month, as `Intl` names it in `locale` (runner side). */
export function seededMonth(locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(SEEDED_DATE);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The English short month never appears as a whole word. */
export async function assertNoEnglishMonth(page: Page, where: string): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText);
  const english = seededMonthEnglish();
  expect(
    new RegExp(`\\b${escapeRegExp(english)}\\b`).test(text),
    `the English month "${english}" appears on ${where}`,
  ).toBe(false);
}

function seededMonthEnglish(): string {
  return seededMonth('en');
}

/**
 * The seeded date (the 7th) renders with the month as `Intl` names it in
 * `locale` — day before or after the month, whichever order the language uses
 * — and the English `Oct` does not appear as a whole word.
 */
export async function assertSeededDateLocal(
  page: Page,
  locale: string,
  where: string,
): Promise<void> {
  const month = escapeRegExp(seededMonth(locale));
  const day = SEEDED_DATE.getUTCDate();
  // Digit lookarounds rather than `\b`: the page's text runs a label straight
  // into its value ("Termin7 paź 2026"), and a letter before the day is no word
  // boundary.
  const dated = new RegExp(
    `(?<!\\d)${day}(?!\\d)\\D{0,6}${month}|${month}\\D{0,3}(?<!\\d)${day}(?!\\d)`,
  );
  await expect(page.locator('body'), `the seeded date in ${locale} on ${where}`).toContainText(
    dated,
  );
  await assertNoEnglishMonth(page, where);
}

// ── Contexts and the credential forms, in whatever language they render ─────

/** A fresh browser — no cookies — whose language is `tag` (e.g. `ja-JP`). */
export async function newLocaleContext(browser: Browser, tag: string): Promise<BrowserContext> {
  const context = await browser.newContext({ locale: tag });
  expect(await context.cookies(), 'a fresh context carries no cookie').toEqual([]);
  return context;
}

/** A Better-Auth session cookie (the library prefixes every one of them). */
export function isSessionCookie(name: string): boolean {
  return name.includes('better-auth');
}

/** Drop the session cookie alone; `NEXT_LOCALE` and the device cookies stay. */
export async function dropSessionCookie(context: BrowserContext): Promise<void> {
  const keep = (await context.cookies()).filter((c) => !isSessionCookie(c.name));
  await context.clearCookies();
  if (keep.length) await context.addCookies(keep);
}

/** The value of this browser's `NEXT_LOCALE` cookie, if it has one. */
export async function localeCookie(context: BrowserContext): Promise<string | undefined> {
  return (await context.cookies()).find((c) => c.name === 'NEXT_LOCALE')?.value;
}

/**
 * Sign up through the real sign-up card, read in the language the page renders
 * in, and stop on the onboarding entrance where a registration lands.
 */
export async function signUpHere(page: Page, email: string, password: string): Promise<void> {
  if (!new URL(page.url()).pathname.startsWith('/sign-up')) await page.goto('/sign-up');
  const lang = await htmlLang(page);
  const main = page.getByRole('main');
  await main.getByPlaceholder(msg(lang, 'auth.emailAddress'), { exact: true }).fill(email);
  await main.getByRole('button', { name: msg(lang, 'auth.continue'), exact: true }).click();
  await main.getByPlaceholder(msg(lang, 'auth.createPassword'), { exact: true }).fill(password);
  await main
    .getByRole('button', {
      name: new RegExp(
        `^(${escapeRegExp(msg(lang, 'auth.createAccount'))}|${escapeRegExp(msg(lang, 'auth.creatingAccount'))})$`,
      ),
    })
    .click();
  await page.waitForURL(`**${ONBOARDING_ENTRY_PATH}`, { timeout: 30_000 });
}

/**
 * Sign in through the real sign-in card, read in the language the page renders
 * in, and return on the RENDERED landing (never on a URL that merely reads
 * right — `shell-session.ts` records why).
 */
export async function signInHere(page: Page, email: string, password: string): Promise<void> {
  if (!new URL(page.url()).pathname.startsWith('/sign-in')) await page.goto('/sign-in');
  const lang = await htmlLang(page);
  const main = page.getByRole('main');
  await main.getByPlaceholder(msg(lang, 'auth.emailAddress'), { exact: true }).fill(email);
  await main.getByRole('button', { name: msg(lang, 'auth.continue'), exact: true }).click();
  await main.getByPlaceholder(msg(lang, 'auth.password'), { exact: true }).fill(password);
  await main.getByRole('button', { name: msg(lang, 'auth.continue'), exact: true }).click();
  await page.waitForURL(isLandedWorkbenchUrl, { timeout: 30_000 });
  await expect(page.getByRole('main').getByTestId('workbench-page')).toBeVisible({
    timeout: 30_000,
  });
}

/** True for the POST a `setLocale` server action makes. */
function isServerAction(response: Response): boolean {
  const request = response.request();
  return request.method() === 'POST' && 'next-action' in request.headers();
}

/**
 * Open a language Combobox, choose `locale` by its endonym, and wait for the
 * AUTHORITATIVE signals: the `setLocale` server-action response (armed before
 * the click) and the page re-rendered in that language (`<html lang>`).
 */
export async function chooseLanguage(page: Page, trigger: Locator, locale: Locale): Promise<void> {
  await trigger.click();
  const option = page.getByRole('option', { name: localeLabel[locale], exact: true });
  await expect(option).toHaveAttribute('lang', locale);
  const saved = page.waitForResponse(isServerAction);
  await option.click();
  expect((await saved).status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('lang', locale, { timeout: 15_000 });
}

/** Settings → Account → Language's Combobox, named in the page's language. */
export function settingsLanguageControl(page: Page, lang: string): Locator {
  return page
    .getByRole('main')
    .getByRole('combobox', { name: msg(lang, 'settings.language.displayLanguage.label') });
}

/**
 * Save `locale` as the account language through the UI choice in Settings —
 * never a database write. A Combobox ignores a choice of the language already
 * shown, so when the page already renders `locale` (from the browser, say) the
 * person first picks English and then their language, which is what saves it.
 */
export async function saveAccountLanguageInSettings(page: Page, locale: Locale): Promise<void> {
  await page.goto('/settings/account/language');
  let lang = await htmlLang(page);
  if (lang === locale) {
    await chooseLanguage(page, settingsLanguageControl(page, lang), 'en');
    lang = 'en';
  }
  await chooseLanguage(page, settingsLanguageControl(page, lang), locale);
  await expect(settingsLanguageControl(page, locale)).toContainText(localeLabel[locale]);
}

// ── The walk's surfaces ─────────────────────────────────────────────────────

// What the seeds plant (`label-fit-seed.ts` and {@link seedOwnProject} alike).
// Work content is user data and is never checked for language.
export const SEEDED_TITLE = 'Draft the onboarding copy';
export const SEEDED_PLAN = 'Translate the settings';
export const SEEDED_PROPOSAL = 'Settings in eleven languages';

export interface Surface {
  name: string;
  /** The route — or, for a surface whose subject has to be SEEDED first (the
   *  decided plan page), a resolver that seeds it and returns the route. */
  path: string | (() => Promise<string>);
  /** A string on the page that equals its catalogue value in `locale`. */
  landmark: (page: Page, locale: string) => Promise<void>;
  /**
   * The surface's LOADED state — seeded content, or the late stack — so nothing
   * is scanned or measured on a skeleton (a board measured before its columns
   * arrive has a different toolbar from the one a person uses).
   */
  ready: (page: Page, locale: string) => Promise<void>;
  /** Does this surface render the seeded 2026-10-07? */
  showsSeededDate: boolean;
}

export function walkSurfaces(seed: { itemKey: string; planId: string }): Surface[] {
  const main = (page: Page) => page.getByRole('main');
  const shows = (text: string) => (page: Page) =>
    expect(main(page).getByText(text, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  return [
    {
      name: 'work item list',
      path: '/items',
      landmark: (page, l) =>
        expect(main(page).getByRole('heading', { level: 1 })).toHaveText(
          msg(l, 'issueViews.heading'),
        ),
      ready: shows(SEEDED_TITLE),
      showsSeededDate: false,
    },
    {
      name: 'work item page',
      path: `/items/${seed.itemKey}`,
      landmark: (page, l) =>
        expect(
          main(page).getByText(msg(l, 'issueViews.description'), { exact: true }).first(),
        ).toBeVisible(),
      ready: (page, l) =>
        expect(
          main(page).getByRole('button', { name: msg(l, 'github.development.linkPr') }),
        ).toBeVisible({ timeout: 15_000 }),
      showsSeededDate: true,
    },
    {
      name: 'board',
      path: '/boards',
      landmark: (page, l) =>
        expect(main(page).getByRole('heading', { level: 1 })).toHaveText(msg(l, 'boards.heading')),
      ready: shows(SEEDED_TITLE),
      showsSeededDate: false,
    },
    {
      name: 'backlog',
      path: '/backlog',
      landmark: (page, l) =>
        expect(main(page).getByRole('heading', { level: 1 })).toHaveText(msg(l, 'backlog.heading')),
      ready: shows(SEEDED_TITLE),
      showsSeededDate: true,
    },
    {
      name: 'plan review',
      // ⚠️ A DECIDED twin of the seeded plan, not the seeded plan itself (Story
      // MOTIR-7883 · MOTIR-7887): a member's `/plans/<id>` for an UNDECIDED plan
      // redirects into the planning overlay, so the plan PAGE — its header, its
      // back link, its labels — is now a decided plan's. The seeded plan stays
      // undecided: it is the approvals queue's waiting row below.
      path: () => decidedTwinOf(seed.planId).then((id) => `/plans/${id}`), // decided: the plan page renders
      landmark: (page, l) =>
        expect(
          main(page).getByRole('link', { name: msg(l, 'planReview.backToPlans') }),
        ).toBeVisible(),
      ready: shows(SEEDED_PROPOSAL),
      showsSeededDate: false,
    },
    {
      name: 'Settings → Account',
      path: '/settings/account/language',
      landmark: (page, l) =>
        expect(main(page).getByRole('heading', { level: 2 }).first()).toHaveText(
          msg(l, 'settings.language.heading'),
        ),
      ready: (page, l) =>
        expect(
          main(page).getByRole('combobox', {
            name: msg(l, 'settings.language.displayLanguage.label'),
          }),
        ).toBeVisible(),
      showsSeededDate: false,
    },
    {
      name: 'approvals queue',
      path: '/approvals',
      landmark: (page, l) =>
        expect(main(page).getByRole('heading', { level: 1 })).toHaveText(
          msg(l, 'approvalRecords.heading'),
        ),
      ready: shows(SEEDED_PLAN),
      showsSeededDate: false,
    },
  ];
}

/**
 * Open one surface and prove it is in `locale`: `<html lang>`, its catalogue
 * landmark, its loaded state, the raw-key scan, the seeded date in local form
 * (or at least no English `Oct`), "Motir" untranslated in the shell, and on the
 * backlog "Sprint" in Latin.
 */
export async function visitSurface(page: Page, surface: Surface, locale: string): Promise<void> {
  const where = `${surface.name} · ${locale}`;
  await page.goto(typeof surface.path === 'string' ? surface.path : await surface.path());
  await expect(page.locator('html'), where).toHaveAttribute('lang', locale);
  await expect(page.getByRole('main')).toBeVisible({ timeout: 15_000 });
  await surface.landmark(page, locale);
  await surface.ready(page, locale);

  await assertNoRawKeys(page, where);
  if (surface.showsSeededDate) await assertSeededDateLocal(page, locale, where);
  else await assertNoEnglishMonth(page, where);

  // "Motir" in Latin in the shell: the brand / back link keeps the name.
  await expect(page.getByRole('link', { name: /\bMotir\b/ }).first()).toBeVisible();
  if (surface.name === 'backlog') {
    const createSprint = msg(locale, 'backlog.createSprint');
    expect(createSprint, `"Sprint" stays Latin in ${locale}`).toMatch(/\bSprint/);
    await expect(
      page.getByRole('main').getByRole('button', { name: createSprint }).first(),
    ).toBeVisible();
  }
}

// ── Surfaces for a person who signed up through the UI ──────────────────────

export interface OwnProjectSeed {
  itemKey: string;
  planId: string;
}

/**
 * Seed the walk's surfaces into the project a SIGNED-UP person already has: a
 * sprint dated {@link SEEDED_DATE}, work items in it and in the backlog (one
 * with that due date), and a plan awaiting review — the same shipped services
 * `label-fit-seed.ts` composes, pointed at an existing account.
 */
export async function seedOwnProject(email: string): Promise<OwnProjectSeed> {
  const user = await adminDb.user.findUniqueOrThrow({ where: { email } });
  const membership = await adminDb.workspaceMembership.findFirstOrThrow({
    where: { userId: user.id },
  });
  const project = await adminDb.project.findFirstOrThrow({
    where: { workspaceId: membership.workspaceId },
    orderBy: { createdAt: 'asc' },
  });
  await adminDb.workspaceMembership.update({
    where: { id: membership.id },
    data: { activeProjectId: project.id },
  });
  const ctx = { userId: user.id, workspaceId: membership.workspaceId };

  const sprint = await sprintsService.createSprint(project.id, { name: 'Autumn push' }, ctx);
  const add = (title: string, inSprint: boolean) =>
    backlogService.createBacklogIssue(
      project.id,
      { kind: 'story', title, ...(inSprint ? { sprintId: sprint.id } : {}) },
      ctx,
    );
  const first = await add(SEEDED_TITLE, true);
  await add('Wire the language control', true);
  await add('Groom the backlog', false);
  // ⚠️ The end passed to `startSprint` is scaffolding only: the service rejects an end
  // before its start (= now), and the fixed SEEDED_SPRINT_END went into the past on
  // 2026-10-21 and failed every spec that seeds here. `pinSeededDates` then
  // overwrites both dates with the fixed pair the specs assert on.
  await sprintsService.startSprint(
    sprint.id,
    { endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString() },
    ctx,
  );
  await pinSeededDates(sprint.id, first.id);

  const plan = await plansService.createPlan(
    project.id,
    { title: SEEDED_PLAN, createdById: user.id },
    ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: SEEDED_PROPOSAL, kind: 'task' } }],
    ctx,
  );
  await plansService.markPlanned(plan.id, ctx);
  return { itemKey: first.identifier, planId: plan.id };
}

/**
 * A DECLINED twin of `planId` — same project, same requester, the same `add`
 * proposals — for a walk that reads the plan PAGE (Story MOTIR-7883 ·
 * MOTIR-7887). A member's `/plans/<id>` for an undecided plan now opens the
 * planning overlay instead; a decided plan keeps its page, so this is the plan a
 * page walk visits, while `planId` itself stays undecided for the approvals
 * queue. Decided through the shipped service (`declinePlan` — through the door
 * when the plan was asked), never by writing a status.
 *
 * Idempotent: a walk that calls it per locale finds the twin it already made.
 */
export async function decidedTwinOf(planId: string): Promise<string> {
  const source = await adminDb.plan.findUniqueOrThrow({
    where: { id: planId },
    select: { workspaceId: true, projectId: true, createdById: true, title: true },
  });
  const title = `${source.title ?? 'Plan'} (decided)`;
  const existing = await adminDb.plan.findFirst({
    where: { projectId: source.projectId, title, status: 'declined' },
    select: { id: true },
  });
  if (existing) return existing.id;

  const createdById =
    source.createdById ??
    (
      await adminDb.workspaceMembership.findFirstOrThrow({
        where: { workspaceId: source.workspaceId },
        orderBy: { createdAt: 'asc' },
        select: { userId: true },
      })
    ).userId;
  const ctx = { userId: createdById, workspaceId: source.workspaceId };
  const adds = await adminDb.planItem.findMany({
    where: { planId, op: 'add' },
    orderBy: { createdAt: 'asc' },
    select: { proposedFields: true },
  });
  const twin = await plansService.createPlan(source.projectId, { title, createdById }, ctx);
  await plansService.addProposals(
    twin.id,
    adds.map((item) => ({
      op: 'add' as const,
      proposedFields: item.proposedFields as PlanItemProposedFields | null,
    })),
    ctx,
  );
  await plansService.markPlanned(twin.id, ctx);
  await plansService.declinePlan(twin.id, ctx);
  return twin.id;
}

/** Pin the sprint's dates and the work item's due date to the seeded date. */
export async function pinSeededDates(sprintId: string, workItemId: string): Promise<void> {
  await adminDb.sprint.update({
    where: { id: sprintId },
    data: { startDate: SEEDED_DATE, endDate: SEEDED_SPRINT_END },
  });
  await adminDb.workItem.update({ where: { id: workItemId }, data: { dueDate: SEEDED_DATE } });
}
