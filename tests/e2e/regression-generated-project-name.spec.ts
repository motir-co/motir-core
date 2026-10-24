import type { Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signUpToOnboarding } from './_helpers/shell-session';
import { htmlLang, msg, saveAccountLanguageInSettings } from './_helpers/i18n-walk';
import { deriveIdentifierBase, projectsService, slugify } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  PROJECT_NAME_ADJECTIVES,
  PROJECT_NAME_NOUNS,
  PROJECT_NAME_NUMBER_MAX,
  PROJECT_NAME_NUMBER_MIN,
} from '@/lib/projects/projectNameGenerator';
import { ONBOARDING_ENTRY_PATH } from '@/lib/navigation/landing';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { escapeRegExp } from '@/lib/utils/regexp';
import en from '@/messages/en.json';

// MOTIR-8531 — the story E2E + ACCEPTANCE RECEIPT for MOTIR-8239, "a new
// sign-up's first project gets a generated, random-looking name".
//
// The story's claim, in a real browser: a person who creates an account lands
// on the onboarding entrance inside a project that already exists, and that
// project is named `quiet-harbor-4821` — an adjective, a noun and a four-digit
// number, drawn from the curated lists — rather than a copy of the workspace's
// name. The entrance deliberately does NOT show it. Its key and slug come from
// the drawn name; work items are keyed from it; a second person gets a name of
// their own; renaming it on Settings › Project changes only the name; the name
// is the person's DATA, so switching the app language leaves it alone; and a
// project somebody names themselves keeps that name exactly.
//
// ── What is real ────────────────────────────────────────────────────────────
// Both sign-ups go through the real sign-up card (`signUpToOnboarding`), so the
// project is seeded by the shipped `ensureDefaultProject` path — nothing is
// planted. The rename goes through the Details card's real save bar (a server
// action), and the language through Settings › Language's real combobox
// (`saveAccountLanguageInSettings`). Only two things are done in the runner, and
// both through the shipped services: the one work item (`workItemsService`, as
// `project-details.spec.ts` seeds its issues) and the hand-named project
// (`projectsService.createProject`, the card's own instruction). Every read of
// the database is `adminDb`, the owner connection.
//
// ── Determinism, and the pace ───────────────────────────────────────────────
// Each database read follows the authoritative signal that the row exists —
// the entrance RENDERED (it redirects a reader with no active project away, so
// its heading is proof the seed committed), the save action's own 200, the
// language action's 200 inside `chooseLanguage`. Nothing sleeps to wait for
// state; `beat()` and `chapter()`'s holds pace the recording for a viewer only
// (`acceptance-video.ts` § Pacing).
//
// EVERY ASSERTED WORDING is read from `messages/<locale>.json` — the entrance's
// `onboarding.entrance.*`, the Details card's `settings.details.*`, the shell's
// `shell.projectSwitcher.*` — never retyped. The two values the spec CHOOSES
// (the rename and the hand-made project's name) are the only typed strings.

test.describe.configure({ timeout: 300_000 });

const freshEmail = (who: string) => `generated-name-${who}-${Date.now()}@example.com`;

/** The generated shape, exactly: lowercase words, hyphens, a 1000–9999 number. */
const GENERATED_SHAPE = /^[a-z]+-[a-z]+-[1-9][0-9]{3}$/;

/** What the person renames the seeded project to — chosen by this spec. */
const RENAMED = 'Launch Plan';
/** What the runner names a project it creates itself — chosen by this spec. */
const HAND_NAMED = 'Garden Planner Q4';

/** The language the person switches the app to. */
const OTHER_LOCALE = 'de' as const;

const details = en.settings.details;

/** Every whole word the English catalogue renders anywhere, lowercased. */
const CATALOGUE_WORDS: ReadonlySet<string> = (() => {
  const words = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const word of node.toLowerCase().match(/[a-z]+/g) ?? []) words.add(word);
    } else if (node && typeof node === 'object') {
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(en);
  return words;
})();

interface FirstRun {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  projects: { id: string; name: string; identifier: string; slug: string }[];
}

/** The account's one workspace and every project in it — one pass, `adminDb`. */
async function readFirstRun(email: string): Promise<FirstRun> {
  const user = await adminDb.user.findUniqueOrThrow({ where: { email } });
  const memberships = await adminDb.workspaceMembership.findMany({
    where: { userId: user.id },
    include: { workspace: true },
  });
  expect(memberships, 'a fresh account belongs to exactly one workspace').toHaveLength(1);
  const workspace = memberships[0]!.workspace;
  const projects = await adminDb.project.findMany({
    where: { workspaceId: workspace.id },
    select: { id: true, name: true, identifier: true, slug: true },
    orderBy: { createdAt: 'asc' },
  });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    projects,
  };
}

/** Split a generated name into its three draws, asserting each one. */
function expectGeneratedName(name: string, workspaceName: string) {
  expect(name, 'the seeded name has the generated shape').toMatch(GENERATED_SHAPE);
  const [adjective, noun, digits] = name.split('-') as [string, string, string];
  expect(PROJECT_NAME_ADJECTIVES, 'the adjective is drawn from the curated list').toContain(
    adjective,
  );
  expect(PROJECT_NAME_NOUNS, 'the noun is drawn from the curated list').toContain(noun);
  const number = Number(digits);
  expect(number).toBeGreaterThanOrEqual(PROJECT_NAME_NUMBER_MIN);
  expect(number).toBeLessThanOrEqual(PROJECT_NAME_NUMBER_MAX);
  expect(name, 'not a copy of the workspace name').not.toBe(workspaceName);
  return { adjective, noun };
}

/** The entrance has settled: its own heading, from the catalogue. */
async function expectEntranceSettled(page: Page): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(ONBOARDING_ENTRY_PATH)}$`));
  await expect(
    page.getByRole('heading', { level: 1, name: en.onboarding.entrance.headingDefault }),
  ).toBeVisible({ timeout: FIRST_PAINT_MS });
}

/** True for the POST the Details card's save bar makes (a Server Action). */
function isSaveAction(response: Response): boolean {
  const request = response.request();
  return (
    request.method() === 'POST' &&
    'next-action' in request.headers() &&
    new URL(response.url()).pathname === '/settings/project'
  );
}

test.describe('the generated default-project name', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.afterAll(async () => {
    await db.$disconnect();
    await adminDb.$disconnect();
  });

  test('a new sign-up lands in a project with a generated name, keyed from it, and renamable', async ({
    page,
    browser,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-8239');

    const email = freshEmail('first');
    let run!: FirstRun;
    let seeded!: FirstRun['projects'][number];
    let itemKey = '';
    const itemTitle = 'Sketch the first screen';

    await chapter('A new person signs up and lands on the onboarding entrance', async () => {
      await signUpToOnboarding(page, email);
      await expectEntranceSettled(page);
      // No error surface: no alert inside the page's own content (scoped to
      // `main` — the toast provider keeps an empty live region mounted at the
      // page root), and not the no-project landing.
      await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
      expect(new URL(page.url()).pathname).not.toBe('/no-project');

      // The entrance rendered, which it only does for a reader with an active
      // project — so the seed has committed and this read is authoritative.
      run = await readFirstRun(email);
      expect(run.projects, 'the workspace holds exactly one project').toHaveLength(1);
      seeded = run.projects[0]!;
      await beat();
    });

    let adjective = '';
    let noun = '';
    await chapter('Its project carries a generated, random-looking name', async () => {
      ({ adjective, noun } = expectGeneratedName(seeded.name, run.workspaceName));
      // The key and the slug are derived from the drawn name, so all three agree.
      expect(seeded.identifier).toBe(deriveIdentifierBase(seeded.name));
      expect(seeded.slug).toBe(slugify(seeded.name));
      await beat();
    });

    await chapter('The entrance itself does not show the name', async () => {
      const text = await page.locator('body').innerText();
      expect(text, 'the full name is not on the entrance').not.toContain(seeded.name);
      expect(text, 'the adjective-noun pair is not on the entrance').not.toContain(
        `${adjective}-${noun}`,
      );
      // Each word on its own, as a whole word — but only where the product's own
      // copy could not legitimately contain it: a word the English catalogue
      // already renders somewhere ("bright", "early") could be copy, not the name.
      for (const word of [adjective, noun]) {
        if (CATALOGUE_WORDS.has(word)) continue;
        expect(text.toLowerCase(), `"${word}" is not on the entrance`).not.toMatch(
          new RegExp(`\\b${escapeRegExp(word)}\\b`),
        );
      }
      await beat();
    });

    const ctx = (): WorkspaceContext => ({ userId: run.userId, workspaceId: run.workspaceId });

    await chapter('A work item in that project is keyed from the generated name', async () => {
      // Created AFTER the entrance check on purpose: a project holding work
      // items is routed past the start-fresh entrance to the migrate wizard.
      const item = await workItemsService.createWorkItem(
        { projectId: seeded.id, kind: 'task', title: itemTitle },
        ctx(),
      );
      itemKey = item.identifier;
      expect(itemKey.startsWith(`${seeded.identifier}-`), itemKey).toBe(true);

      const opened = await page.goto(`/items/${itemKey}`);
      expect(opened?.status()).toBe(200);
      await expect(page.getByRole('heading', { name: itemTitle })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      expect(new URL(page.url()).pathname).toBe(`/items/${itemKey}`);
      await beat();
    });

    await chapter('A second person, in their own browser, gets a name of their own', async () => {
      // Not recorded — a context made by hand carries no video. What it proves
      // is in the database: a valid draw, and not the first person's.
      const other = await browser.newContext({ baseURL });
      try {
        const otherPage = await other.newPage();
        const otherEmail = freshEmail('second');
        await signUpToOnboarding(otherPage, otherEmail);
        await expectEntranceSettled(otherPage);
        const otherRun = await readFirstRun(otherEmail);
        expect(otherRun.projects).toHaveLength(1);
        const theirs = otherRun.projects[0]!;
        expectGeneratedName(theirs.name, otherRun.workspaceName);
        expect(theirs.name, 'two sign-ups, two different names').not.toBe(seeded.name);
        expect(otherRun.workspaceId).not.toBe(run.workspaceId);
      } finally {
        await other.close();
      }
    });

    const nameInput = (p: Page, lang: string) =>
      p
        .getByRole('main')
        .getByRole('textbox', { name: msg(lang, 'settings.details.fieldName'), exact: true });
    const switcher = (p: Page, lang: string) =>
      p.getByRole('button', { name: msg(lang, 'shell.projectSwitcher.switch'), exact: true });

    await chapter('They rename it on Settings › Project — only the name changes', async () => {
      await page.goto('/settings/project');
      const input = nameInput(page, 'en');
      await expect(input).toHaveValue(seeded.name, { timeout: FIRST_PAINT_MS });
      await expect(switcher(page, 'en')).toContainText(seeded.name);
      await beat();

      await input.fill(RENAMED);
      const save = page.getByRole('button', { name: details.saveButton, exact: true });
      await expect(save).toBeEnabled();
      const saved = page.waitForResponse(isSaveAction);
      await save.click();
      expect((await saved).status()).toBe(200);
      await expect(page.getByRole('status').filter({ hasText: details.saveSaved })).toBeVisible();

      // The write has committed (its own 200): the row, then a fresh read of
      // the page.
      const row = await adminDb.project.findUniqueOrThrow({ where: { id: seeded.id } });
      expect(row.name).toBe(RENAMED);
      expect(row.identifier, 'the key is a durable handle').toBe(seeded.identifier);
      expect(row.slug, 'the slug is a durable handle').toBe(seeded.slug);

      await page.reload();
      await expect(nameInput(page, 'en')).toHaveValue(RENAMED, { timeout: FIRST_PAINT_MS });
      await expect(switcher(page, 'en')).toContainText(RENAMED);
      await beat();

      const reopened = await page.goto(`/items/${itemKey}`);
      expect(reopened?.status()).toBe(200);
      await expect(page.getByRole('heading', { name: itemTitle })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      expect(new URL(page.url()).pathname, 'the item keeps its address').toBe(`/items/${itemKey}`);
    });

    let nameBeforeSwitch = '';
    await chapter('Switching the app language leaves the project name alone', async () => {
      await page.goto('/settings/project');
      await expect(nameInput(page, 'en')).toHaveValue(RENAMED, { timeout: FIRST_PAINT_MS });
      nameBeforeSwitch = await nameInput(page, 'en').inputValue();
      const rowBefore = await adminDb.project.findUniqueOrThrow({ where: { id: seeded.id } });
      expect(nameBeforeSwitch).toBe(rowBefore.name);

      await saveAccountLanguageInSettings(page, OTHER_LOCALE);
      await beat();

      await page.goto('/settings/project');
      expect(await htmlLang(page)).toBe(OTHER_LOCALE);
      await expect(nameInput(page, OTHER_LOCALE)).toHaveValue(nameBeforeSwitch, {
        timeout: FIRST_PAINT_MS,
      });
      await expect(switcher(page, OTHER_LOCALE)).toContainText(nameBeforeSwitch);
      const rowAfter = await adminDb.project.findUniqueOrThrow({ where: { id: seeded.id } });
      expect(rowAfter.name).toBe(nameBeforeSwitch);
      await beat();
    });

    await chapter('A project somebody names themselves keeps that name exactly', async () => {
      const made = await projectsService.createProject({
        workspaceId: run.workspaceId,
        actorUserId: run.userId,
        name: HAND_NAMED,
      });
      expect(made.name).toBe(HAND_NAMED);
      expect(made.name).not.toMatch(GENERATED_SHAPE);
      const row = await adminDb.project.findUniqueOrThrow({ where: { id: made.id } });
      expect(row.name).toBe(HAND_NAMED);

      await page.reload();
      const bar = switcher(page, OTHER_LOCALE);
      await expect(bar).toContainText(nameBeforeSwitch, { timeout: FIRST_PAINT_MS });
      await bar.click();
      await expect(page.getByRole('button', { name: HAND_NAMED, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: nameBeforeSwitch, exact: true })).toBeVisible();
      await beat();
      await page.keyboard.press('Escape');
    });
  });
});
