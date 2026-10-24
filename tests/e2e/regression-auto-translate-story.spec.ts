// ACCEPTANCE: auto-translate a project (Story MOTIR-7738 · MOTIR-8836).
//
// The story's thirteen Verification steps as people meet them in a browser,
// recorded as the story's receipt — one `chapter()` per step:
//
//   1.  organisation LANG, four English work items, and its people: Olivia (owner,
//       English), Minji and Joon (한국어), Greta (Deutsch); Minji reads the setting
//       OFF with no switch to press, and the Translation figure is zero;
//   2.  Olivia turns it on; the read-back names her, off → on and when; Minji,
//       reloading, reads it on — still without a switch;
//   3.  Minji opens an English work item and presses nothing: no Translate button,
//       every field marked translating over its English, then all five field kinds
//       in 한국어, each marked as translated from English, a link and a chip intact;
//   4.  Show original returns the English as stored, Show translation the 한국어;
//   5.  Minji's board: held titles show their translating state over the English
//       and a card does not change height when its title lands; the job carries
//       title refs only; the backlog and the list read 한국어 with no new job; the
//       surface's Show original switch returns its titles to English;
//   6.  Greta, in a second simultaneous browser, reads the same item in Deutsch
//       from one `de` job while Minji's open view stays 한국어;
//   7.  Settings → Organization → Usage & cost shows the Translation line for the
//       three jobs;
//   8.  Joon, a second 한국어 reader, gets the item and the board at once, free;
//   9.  Olivia, reading English, sees no translation and spends nothing;
//   10. Minji opens the description to edit: the editor holds the English original
//       and names its language; after her saved edit only the description is
//       translated again, once;
//   11. an agent's MCP `get_work_item` reads the stored English, edit included;
//   12. an organisation with no credit: English text, one notice per surface, a way
//       to add credit for the owner and none for a member, no job at all;
//   13. Olivia turns it off; Minji reads English with a Translate button, and
//       pressing it shows the kept 한국어 with no new job and no new charge.
//
// Each group is its own short test so each clip stays inside the lane's budget
// (`playwright.acceptance.config.ts`); the tests share one seed and run in order.
//
// ⚠️ ONE RECORDED PAGE PER TEST. A recording is one test directory's `video.webm`,
// so the readers take turns on the test's own `page`, each signed in through the
// real auth route on a cleared cookie jar. Step 6's SECOND browser is a
// `browser.newContext()`, which the lane does not record (the pattern
// `regression-eleven-languages.spec.ts` uses): it proves Greta's German, and the
// recorded page proves Minji's view did not move.
//
// ⚠️ ONLY motir-ai IS REPLACED, by the lane's two in-repo boundary mocks
// (`lib/test-ai-jobs-mock.ts`, `lib/test-billing-mock.ts`). A job is HELD by
// declaring its outcome `running` and released by switching that ordinal to
// `succeeded` with the scripted text — the mock re-reads its fixture on every
// request — so each translating mark and each unchanged card size is asserted while
// it is certainly on screen. Each reader's job settles before the next reader
// opens a page, so the ordinals are deterministic.
//
// Counts and figures are literals from the case (`TRANSLATION_CREDITS_PER_JOB × n`
// succeeded jobs), never read off the page and echoed back. This spec proves the
// browser path and how many jobs core sends; it does not restate the 1.5× rate.
// The holds inside `chapter()` / `beat()` are pacing for the viewer, never a wait.

import type { Browser, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import {
  freeOrgState,
  paidOrgState,
  resetBillingFixture,
  setOrgBillingState,
} from './_helpers/billing';
import { mcp, openMcp } from './_helpers/content-language-seed';
import { msg } from './_helpers/i18n-walk';
import {
  EN_TITLES,
  KO_TITLES,
  cardHeight,
  itemTranslations,
  languageName,
  seedEnglishItem,
  seedPeople,
  storyTexts,
  turnOnAutoTranslate,
  type People,
  type SeededItem,
  type StoryTexts,
} from './_helpers/auto-translate-seed';
import {
  TRANSLATION_CREDITS_PER_JOB as K,
  mintToken,
  reportedTranslation,
  resetJobs,
  seedOrg,
  setNextTranslateOutcome,
  setTranslateOutcome,
  signInAs,
  translateSubmits,
  type OrgSeed,
} from './_helpers/translation-seed';

test.describe.configure({ mode: 'serial' });

interface Seed {
  org: OrgSeed;
  dry: OrgSeed;
  people: People;
  story: SeededItem;
  others: SeededItem[];
  dryItem: SeededItem;
  text: StoryTexts;
  agentToken: string;
}

let seed: Seed;

/** The AI planning credits LANG has already spent (Usage & cost draws only then). */
const AI_SPEND = 1_240;

test.beforeAll(async () => {
  await resetDatabase();
  resetBillingFixture();
  resetJobs();
  const people = await seedPeople();
  const org = await seedOrg(people.olivia, 'LANG', [people.minji, people.joon, people.greta]);
  const dry = await seedOrg(people.zara, 'ZWEI', [people.zeno]);
  // LANG names no `translation` block, so the billing mock derives it from the
  // succeeded jobs; ZWEI's is SCRIPTED because that derived figure is lane-global.
  setOrgBillingState(org.orgId, { ...paidOrgState(), totalSpend: AI_SPEND });
  setOrgBillingState(dry.orgId, {
    ...freeOrgState(0),
    translation: { totalSpend: 0, monthSpend: 0 },
  });
  const others = [];
  for (const title of EN_TITLES) others.push(await seedEnglishItem(org, { title }));
  const text = storyTexts(others[0]!.id, others[0]!.key);
  const story = await seedEnglishItem(org, text.en);
  const dryItem = await seedEnglishItem(dry, {
    title: EN_TITLES[2],
    description: 'Summarise it once a week.',
  });
  await turnOnAutoTranslate(dry);
  seed = {
    org,
    dry,
    people,
    story,
    others,
    dryItem,
    text,
    agentToken: await mintToken(org, people.olivia, 'auto-translate-story-agent'),
  };
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

// ── locators and signals ────────────────────────────────────────────────────

const main = (page: Page) => page.getByRole('main');
const titleOf = (page: Page) => main(page).getByRole('heading', { level: 1 });
const tr = (lang: string, key: string, args: Record<string, string> = {}) =>
  msg(lang, `itemTranslation.${key}`, args);
const descriptionOf = (page: Page, lang: string) =>
  main(page).getByLabel(msg(lang, 'issueViews.issueDescriptionAria'));
const control = (page: Page, lang: string, key: string) =>
  main(page).getByRole('button', { name: tr(lang, key), exact: true });
const spend = (credits: number) => ({ totalSpend: credits, monthSpend: credits });
const item = (page: Page, key: string) => page.goto(`/items/${key}`);

/** A field's mark by its text name: "{Field}: {mark}". */
function mark(page: Page, lang: string, field: string, text: string, args = {}) {
  const prefix = tr(lang, 'markPrefix', { field: tr(lang, field) });
  return main(page).getByText(`${prefix}${tr(lang, text, args)}`, { exact: true });
}

const isTranslatePost = (r: Response) =>
  r.request().method() === 'POST' && /\/api\/work-items\/[^/]+\/translate$/.test(r.url());
const isTitlesPost = (r: Response) =>
  r.request().method() === 'POST' && /\/api\/projects\/[^/]+\/translate-titles$/.test(r.url());

type Beat = () => Promise<void>;

// ── shared page drivers ─────────────────────────────────────────────────────

/** Open both to-dos' notes, so their text is on screen before and after. */
async function openNotes(page: Page, lang: string) {
  const show = main(page).getByRole('button', { name: msg(lang, 'workItemTodos.notesShow') });
  await expect(show).toHaveCount(2);
  await show.first().click();
  await expect(show).toHaveCount(1);
  await show.first().click();
  await expect(show).toHaveCount(0);
}

/** Every one of the story item's seven fields, in the given text. */
async function expectFields(page: Page, text: StoryTexts['en'] | StoryTexts['ko']) {
  await expect(titleOf(page)).toHaveText(text.title);
  await expect(main(page).getByText(text.explanation, { exact: true })).toBeVisible();
  for (const todo of text.todos) {
    await expect(main(page).getByText(todo.text, { exact: true })).toBeVisible();
    await expect(main(page).getByText(todo.notes, { exact: true })).toBeVisible();
  }
}

/** The description's link and work item chip still point where they did. */
async function expectLinkAndChip(page: Page, lang: string, linkName: string) {
  const body = descriptionOf(page, lang);
  await expect(body.getByRole('link', { name: linkName })).toHaveAttribute('href', seed.text.link);
  const chip = body.getByRole('link', { name: new RegExp(seed.others[0]!.key) });
  await expect(chip).toHaveAttribute('href', new RegExp(`/items/${seed.others[0]!.key}$`));
}

/** The story item's seven refs, as the item page's job carries them. */
function storyRefs(): string[] {
  return itemTranslations(seed.story, seed.text.ko).map((t) => t.fieldRef);
}

/**
 * A submit that is one related title, not one of the story's jobs. An item page
 * also submits the single `title:<id>` its description's work item chip shows,
 * before or after the item's own job — the order is the page's, not the spec's.
 */
function isChipTitle(s: ReturnType<typeof translateSubmits>[number]) {
  return s.translate?.fields.length === 1 && s.translate.fields[0]!.fieldRef.startsWith('title:');
}

/** The story's own jobs: every submit that is not a related chip's title. */
function jobSubmits() {
  return translateSubmits().filter((s) => !isChipTitle(s));
}

/** The index of the first story job at or after `ordinal`, or -1 while none has been sent. */
function jobIndexFrom(ordinal: number) {
  return translateSubmits().findIndex((s, i) => i >= ordinal && !isChipTitle(s));
}

/** How many submits after `ordinal` a step scripts: its own job and the chip title jobs around it. */
const HELD_WINDOW = 6;

/**
 * Hold the next story job `running` and return the ordinal the window starts at.
 * The whole window is held, because the related chip's title job (and any retry
 * of one) shares the page with the story's own job and may come before it —
 * `release` settles each submit once it is known which one is the story's. The
 * ordinal after the window is `failed`, which every later unscripted submit then
 * repeats, so a chip job neither bills nor stores nor changes what a step reads.
 * The submit count is read only once it has stopped moving, so a chip job still in
 * flight from the page before cannot take the ordinal this step scripted.
 */
async function holdNextJob(): Promise<number> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const now = translateSubmits().length;
        const settled = now === last;
        last = now;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return settled;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const ordinal = setNextTranslateOutcome({ status: 'running' });
  for (let i = 1; i < HELD_WINDOW; i++) setTranslateOutcome(ordinal + i, { status: 'running' });
  setTranslateOutcome(ordinal + HELD_WINDOW, { status: 'failed' });
  return ordinal;
}

/** Wait for the story job scripted from `ordinal` and return what it carried. */
async function submitAt(ordinal: number) {
  await expect.poll(() => jobIndexFrom(ordinal)).toBeGreaterThanOrEqual(0);
  const sent = translateSubmits()[jobIndexFrom(ordinal)]!.translate!;
  return { target: sent.targetLanguage, refs: sent.fields.map((f) => f.fieldRef) };
}

/** Settle the story job scripted from `ordinal` as `outcome`, and every chip title job around it as failed. */
function release(ordinal: number, outcome: Parameters<typeof setTranslateOutcome>[1]) {
  const job = jobIndexFrom(ordinal);
  for (let i = ordinal; i < ordinal + HELD_WINDOW; i++) {
    setTranslateOutcome(i, i === job ? outcome : { status: 'failed' });
  }
}

/** Open a browsing surface and wait for its batch request to answer 200. */
async function openSurface(page: Page, path: string) {
  const answered = page.waitForResponse(isTitlesPost);
  await page.goto(path);
  expect((await answered).status()).toBe(200);
}

const card = (page: Page, key: string) => page.getByRole('main').getByTestId(`board-card-${key}`);

// ── steps 1–2: the setting ──────────────────────────────────────────────────

async function step1(page: Page, baseURL: string, beat: Beat) {
  expect(reportedTranslation(seed.org.orgId)).toEqual(spend(0));
  expect(translateSubmits()).toHaveLength(0);
  await signInAs(page, baseURL, seed.people.minji);
  await page.goto('/settings/project/translation');
  const value = main(page).getByTestId('auto-translate-value');
  await expect(value).toContainText(msg('ko', 'settings.translation.value.off'), {
    timeout: FIRST_PAINT_MS,
  });
  await expect(main(page).getByRole('switch')).toHaveCount(0);
  await expect(main(page).getByTestId('auto-translate-readonly-note')).toHaveText(
    msg('ko', 'settings.translation.readOnlyNote'),
  );
  await beat();
}

async function step2(page: Page, baseURL: string, beat: Beat) {
  await signInAs(page, baseURL, seed.people.olivia);
  await page.goto('/settings/project/translation');
  const toggle = main(page).getByRole('switch', {
    name: msg('en', 'settings.translation.switch.label'),
  });
  await expect(toggle).not.toBeChecked({ timeout: FIRST_PAINT_MS });
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' && /\/api\/projects\/LANG\/auto-translate$/.test(r.url()),
  );
  await toggle.click();
  const res = await saved;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { autoTranslateWorkContent: boolean; totalChanges: number };
  expect([body.autoTranslateWorkContent, body.totalChanges]).toEqual([true, 1]);
  await expect(toggle).toBeChecked();
  const rows = main(page).getByTestId('auto-translate-history-list').getByRole('listitem');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Olivia Owner');
  await beat();

  await signInAs(page, baseURL, seed.people.minji);
  await page.goto('/settings/project/translation');
  await expect(main(page).getByTestId('auto-translate-value')).toContainText(
    msg('ko', 'settings.translation.value.on'),
    { timeout: FIRST_PAINT_MS },
  );
  await expect(main(page).getByRole('switch')).toHaveCount(0);
  await beat();
}

// ── steps 3–4: the item page ────────────────────────────────────────────────

/** The marks of the item's differing fields, while its job is held. */
async function expectTranslatingMarks(page: Page) {
  for (const field of ['fieldTitle', 'fieldDescription', 'fieldExplanation']) {
    await expect(mark(page, 'ko', field, 'markTranslating')).toBeVisible();
  }
  await expect(mark(page, 'ko', 'fieldTodo', 'markTranslating')).toHaveCount(2);
  await expect(mark(page, 'ko', 'fieldInstructions', 'markTranslating')).toHaveCount(2);
}

/** Each field's mark naming English as the original language. */
async function expectTranslatedMarks(page: Page) {
  const from = { language: languageName('en', 'ko') };
  for (const field of ['fieldTitle', 'fieldDescription', 'fieldExplanation']) {
    await expect(mark(page, 'ko', field, 'markTranslatedFrom', from)).toBeVisible();
  }
  await expect(mark(page, 'ko', 'fieldTodo', 'markTranslatedFrom', from)).toHaveCount(2);
  await expect(mark(page, 'ko', 'fieldInstructions', 'markTranslatedFrom', from)).toHaveCount(2);
}

async function step3(page: Page, baseURL: string, beat: Beat) {
  const ordinal = await holdNextJob();
  await signInAs(page, baseURL, seed.people.minji);
  await item(page, seed.story.key);
  await expect(titleOf(page)).toHaveText(seed.text.en.title, { timeout: FIRST_PAINT_MS });
  await expect(control(page, 'ko', 'translate')).toHaveCount(0);
  await openNotes(page, 'ko');
  await expectTranslatingMarks(page);
  await expectFields(page, seed.text.en);
  expect(await submitAt(ordinal)).toEqual({ target: 'ko', refs: storyRefs() });
  await beat();

  const korean = itemTranslations(seed.story, seed.text.ko);
  release(ordinal, { status: 'succeeded', translations: korean });
  await expectFields(page, seed.text.ko);
  await expect(descriptionOf(page, 'ko')).toContainText(seed.text.ko.lead);
  await expectTranslatedMarks(page);
  await expectLinkAndChip(page, 'ko', '내보내기 안내');
  expect(jobSubmits()).toHaveLength(ordinal + 1);
  await beat();
}

async function step4(page: Page, beat: Beat) {
  await control(page, 'ko', 'showOriginal').click();
  await expectFields(page, seed.text.en);
  await expect(descriptionOf(page, 'ko')).toContainText(seed.text.en.lead);
  await beat();
  await control(page, 'ko', 'showTranslation').click();
  await expectFields(page, seed.text.ko);
  expect(jobSubmits()).toHaveLength(1);
  await beat();
}

// ── step 5: the board, the backlog, the list ────────────────────────────────

const pendingMark = (page: Page, key: string) =>
  card(page, key).locator('[data-title-mark="pending"]');

/** The scripted 한국어 for the board's three titles, by the ref the batch sends. */
function boardTranslations() {
  return seed.others.map((o, i) => ({ fieldRef: `title:${o.id}`, text: KO_TITLES[i]! }));
}

/** What a board card is made of, in CSS pixels — what a height that moved is read from. */
async function cardAnatomy(page: Page, key: string) {
  return card(page, key).evaluate((el) => {
    const h = (node: Element | null) =>
      node ? Math.round(node.getBoundingClientRect().height * 100) / 100 : null;
    const mark = el.querySelector('[data-title-mark]');
    const title = mark?.parentElement?.parentElement ?? null;
    return {
      card: h(el),
      children: Array.from(el.children).map((c) => h(c)),
      title: h(title),
      titleLineHeight: title ? getComputedStyle(title).lineHeight : null,
      titleFont: title ? getComputedStyle(title).fontFamily : null,
      markWrapper: h(mark?.parentElement ?? null),
      mark: h(mark ?? null),
      titleHtml: title?.outerHTML.slice(0, 400) ?? null,
    };
  });
}

async function step5Board(page: Page, baseURL: string, beat: Beat) {
  const ordinal = await holdNextJob();
  await signInAs(page, baseURL, seed.people.minji);
  await page.goto('/boards');
  const heights: number[] = [];
  const anatomies: Awaited<ReturnType<typeof cardAnatomy>>[] = [];
  for (const [i, other] of seed.others.entries()) {
    await expect(card(page, other.key).getByText(EN_TITLES[i]!)).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(pendingMark(page, other.key)).toBeVisible();
    heights.push(await cardHeight(page, other.key));
    anatomies.push(await cardAnatomy(page, other.key));
  }
  const sent = await submitAt(ordinal);
  expect(sent.target).toBe('ko');
  expect([...sent.refs].sort()).toEqual(
    boardTranslations()
      .map((t) => t.fieldRef)
      .sort(),
  );
  expect(sent.refs.every((ref) => ref.startsWith('title:'))).toBe(true);
  await beat();

  release(ordinal, { status: 'succeeded', translations: boardTranslations() });
  for (const [i, other] of seed.others.entries()) {
    await expect(card(page, other.key).getByText(KO_TITLES[i]!)).toBeVisible();
    await expect(pendingMark(page, other.key)).toHaveCount(0);
    const settled = await cardHeight(page, other.key);
    expect(
      settled,
      `${other.key} was ${heights[i]}px while pending and is ${settled}px translated\nbefore: ${JSON.stringify(anatomies[i])}\nafter: ${JSON.stringify(await cardAnatomy(page, other.key))}`,
    ).toBe(heights[i]);
  }
  await beat();
}

async function step5Surfaces(page: Page, beat: Beat) {
  const before = jobSubmits().length;
  for (const path of ['/backlog', '/items']) {
    await openSurface(page, path);
    await expect(main(page).getByText(KO_TITLES[0]!).first()).toBeVisible();
    expect(jobSubmits()).toHaveLength(before);
    await beat();
  }
  const original = msg('ko', 'titleTranslation.showOriginal');
  await main(page).getByRole('button', { name: original, exact: true }).click();
  await expect(main(page).getByText(EN_TITLES[0]!).first()).toBeVisible();
  await expect(main(page).getByText(KO_TITLES[0]!)).toHaveCount(0);
  expect(jobSubmits()).toHaveLength(before);
  await beat();
}

// ── steps 6–7: a second language at once, and the charge ────────────────────

async function step6(page: Page, browser: Browser, baseURL: string, beat: Beat) {
  await signInAs(page, baseURL, seed.people.minji);
  await item(page, seed.story.key);
  await expect(titleOf(page)).toHaveText(seed.text.ko.title, { timeout: FIRST_PAINT_MS });
  await expect(mark(page, 'ko', 'fieldTitle', 'markTranslating')).toHaveCount(0);
  const ordinal = await holdNextJob();
  const german = await browser.newContext({ baseURL });
  try {
    const greta = await german.newPage();
    await signInAs(greta, baseURL, seed.people.greta);
    await item(greta, seed.story.key);
    await expect(titleOf(greta)).toHaveText(seed.text.en.title, { timeout: FIRST_PAINT_MS });
    await openNotes(greta, 'de');
    expect(await submitAt(ordinal)).toEqual({ target: 'de', refs: storyRefs() });
    await beat();

    const translations = itemTranslations(seed.story, seed.text.de);
    release(ordinal, { status: 'succeeded', translations });
    await expect(titleOf(greta)).toHaveText(seed.text.de.title);
    await expect(descriptionOf(greta, 'de')).toContainText(seed.text.de.lead);
    await expect(main(greta).getByText(seed.text.de.explanation, { exact: true })).toBeVisible();
  } finally {
    await german.close();
  }
  await expect(titleOf(page)).toHaveText(seed.text.ko.title);
  await expect(descriptionOf(page, 'ko')).toContainText(seed.text.ko.lead);
  expect(jobSubmits()).toHaveLength(3);
  await beat();
}

/** The Translation line on Usage & cost, read as the owner sees it. */
async function expectUsageLine(page: Page, credits: number) {
  await page.goto('/settings/organization/usage');
  const line = main(page)
    .locator('[data-usage-translation]')
    .filter({ hasText: msg('en', 'aiUsage.summary.translationThisMonth') });
  await expect(line).toHaveAttribute('data-usage-translation', 'spend', {
    timeout: FIRST_PAINT_MS,
  });
  await expect(line).toContainText(msg('en', 'aiUsage.summary.credits', { n: String(credits) }));
}

async function step7(page: Page, baseURL: string, beat: Beat) {
  await signInAs(page, baseURL, seed.people.olivia);
  expect(reportedTranslation(seed.org.orgId)).toEqual(spend(K * 3));
  await expectUsageLine(page, K * 3);
  await beat();
}

// ── steps 8–9: no double charge, and your own language ──────────────────────

async function step8(page: Page, baseURL: string, beat: Beat) {
  await signInAs(page, baseURL, seed.people.joon);
  const kept = page.waitForResponse(isTranslatePost);
  await item(page, seed.story.key);
  expect((await kept).status()).toBe(200);
  await expect(titleOf(page)).toHaveText(seed.text.ko.title, { timeout: FIRST_PAINT_MS });
  await expect(descriptionOf(page, 'ko')).toContainText(seed.text.ko.lead);
  expect(jobSubmits()).toHaveLength(3);
  await beat();

  await openSurface(page, '/boards');
  await expect(card(page, seed.others[0]!.key).getByText(KO_TITLES[0]!)).toBeVisible();
  expect(jobSubmits()).toHaveLength(3);
  expect(reportedTranslation(seed.org.orgId)).toEqual(spend(K * 3));
  await beat();
}

async function step9(page: Page, baseURL: string, beat: Beat) {
  await signInAs(page, baseURL, seed.people.olivia);
  await item(page, seed.story.key);
  await expect(titleOf(page)).toHaveText(seed.text.en.title, { timeout: FIRST_PAINT_MS });
  await expect(descriptionOf(page, 'en')).toContainText(seed.text.en.lead);
  await expect(main(page).getByText(/Translated from|Translating/)).toHaveCount(0);
  await beat();
  await page.goto('/boards');
  await expect(card(page, seed.others[0]!.key).getByText(EN_TITLES[0]!)).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.locator('[data-title-mark]')).toHaveCount(0);
  expect(jobSubmits()).toHaveLength(3);
  expect(reportedTranslation(seed.org.orgId)).toEqual(spend(K * 3));
  await beat();
}

// ── steps 10–11: editing, and the agent ─────────────────────────────────────

/** Minji appends a sentence to the English description and saves, through the real path. */
async function editDescription(page: Page, baseURL: string, beat: Beat) {
  await signInAs(page, baseURL, seed.people.minji);
  await page.goto(`/items/${seed.story.key}/edit`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko', { timeout: FIRST_PAINT_MS });
  const editor = main(page).getByRole('textbox', { name: msg('ko', 'issueViews.description') });
  await expect(editor).toContainText(seed.text.en.lead);
  await expect(editor).not.toContainText(seed.text.ko.lead);
  const note = tr('ko', 'originalIn', { language: languageName('en', 'ko') });
  await expect(main(page).getByText(note).first()).toBeVisible();
  await beat();

  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(` ${seed.text.en.added}`);
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'POST' && 'next-action' in r.request().headers(),
  );
  await main(page)
    .getByRole('button', { name: msg('ko', 'common.save'), exact: true })
    .click();
  expect((await saved).status()).toBe(200);
  const done = msg('ko', 'issueViews.issueSaved', { identifier: seed.story.key });
  await expect(page.getByText(done, { exact: true }).first()).toBeVisible();
  await beat();
}

/** The page re-enters the translated view; only the description goes out again. */
async function retranslateEdit(page: Page, beat: Beat) {
  const ordinal = await holdNextJob();
  await item(page, seed.story.key);
  // The request carries every field and answers once, so while the description's
  // job is held the whole page waits on it: the pending mark is what shows, and
  // the stored 한국어 title returns with the answer, not before it.
  expect(await submitAt(ordinal)).toEqual({ target: 'ko', refs: ['description'] });
  await expect(mark(page, 'ko', 'fieldDescription', 'markTranslating')).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await beat();

  const edited = [{ fieldRef: 'description', text: seed.text.ko.edited }];
  release(ordinal, { status: 'succeeded', translations: edited });
  await expect(titleOf(page)).toHaveText(seed.text.ko.title, { timeout: FIRST_PAINT_MS });
  await expect(descriptionOf(page, 'ko')).toContainText(seed.text.ko.added);
  expect(jobSubmits()).toHaveLength(4);
  expect(reportedTranslation(seed.org.orgId)).toEqual(spend(K * 4));
  await beat();
}

async function step11(baseURL: string, beat: Beat) {
  const stored = await adminDb.workItem.findFirstOrThrow({ where: { identifier: seed.story.key } });
  expect(stored.descriptionMd).toContain(seed.text.en.added);
  const client = await openMcp(seed.agentToken, baseURL);
  try {
    const read = await mcp<{
      item: { title: string; descriptionMd: string; explanationMd: string };
    }>(client, 'get_work_item', { key: seed.story.key });
    expect(read.item.title).toBe(seed.text.en.title);
    expect(read.item.descriptionMd).toBe(stored.descriptionMd);
    expect(read.item.explanationMd).toBe(seed.text.en.explanation);
  } finally {
    await client.close();
  }
  await beat();
}

// ── step 12: no credit ──────────────────────────────────────────────────────

const noCreditBar = (page: Page) => main(page).getByRole('group', { name: tr('ko', 'groupLabel') });

async function noCreditItem(page: Page, owner: boolean) {
  await item(page, seed.dryItem.key);
  await expect(titleOf(page)).toHaveText(seed.dryItem.title, { timeout: FIRST_PAINT_MS });
  await expect(noCreditBar(page).getByText(tr('ko', 'noCredits'))).toHaveCount(1);
  const add = main(page).getByRole('link', { name: tr('ko', 'addCredits') });
  if (owner) await expect(add).toHaveAttribute('href', '/settings/organization/billing');
  else await expect(noCreditBar(page).getByText(tr('ko', 'noCreditsMember'))).toBeVisible();
  if (!owner) await expect(add).toHaveCount(0);
}

async function noCreditBoard(page: Page, owner: boolean) {
  await page.goto('/boards');
  await expect(card(page, seed.dryItem.key).getByText(seed.dryItem.title)).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  const notice = main(page).getByText(msg('ko', 'titleTranslation.noCredit'));
  await expect(notice).toHaveCount(1);
  const add = main(page).getByRole('link', { name: msg('ko', 'titleTranslation.addCredit') });
  await expect(add).toHaveCount(owner ? 1 : 0);
}

async function step12(page: Page, baseURL: string, beat: Beat) {
  const before = jobSubmits().length;
  await signInAs(page, baseURL, seed.people.zara);
  await noCreditItem(page, true);
  await beat();
  await noCreditBoard(page, true);
  await beat();
  await signInAs(page, baseURL, seed.people.zeno);
  await noCreditItem(page, false);
  await noCreditBoard(page, false);
  expect(jobSubmits()).toHaveLength(before);
  expect(reportedTranslation(seed.dry.orgId)).toEqual(spend(0));
  expect(reportedTranslation(seed.org.orgId)).toEqual(spend(K * 4));
  await beat();
}

// ── step 13: turning it off ─────────────────────────────────────────────────

async function turnOff(page: Page, baseURL: string, beat: Beat) {
  await signInAs(page, baseURL, seed.people.olivia);
  await page.goto('/settings/project/translation');
  const toggle = main(page).getByRole('switch', {
    name: msg('en', 'settings.translation.switch.label'),
  });
  await expect(toggle).toBeChecked({ timeout: FIRST_PAINT_MS });
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' && /\/api\/projects\/LANG\/auto-translate$/.test(r.url()),
  );
  await toggle.click();
  expect((await saved).status()).toBe(200);
  await expect(toggle).not.toBeChecked();
  const rows = main(page).getByTestId('auto-translate-history-list').getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await beat();
}

async function readEnglishAgain(page: Page, baseURL: string, beat: Beat) {
  await signInAs(page, baseURL, seed.people.minji);
  await item(page, seed.story.key);
  await expect(titleOf(page)).toHaveText(seed.text.en.title, { timeout: FIRST_PAINT_MS });
  await expect(control(page, 'ko', 'translate')).toBeVisible();
  await page.goto('/boards');
  await expect(card(page, seed.others[0]!.key).getByText(EN_TITLES[0]!)).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.locator('[data-title-mark]')).toHaveCount(0);
  await beat();

  await item(page, seed.story.key);
  await openNotes(page, 'ko');
  const answered = page.waitForResponse(isTranslatePost);
  await control(page, 'ko', 'translate').click();
  expect((await answered).status()).toBe(200);
  await expectFields(page, seed.text.ko);
  await expect(descriptionOf(page, 'ko')).toContainText(seed.text.ko.added);
  expect(jobSubmits()).toHaveLength(4);
  expect(reportedTranslation(seed.org.orgId)).toEqual(spend(K * 4));
  await beat();
}

// ── the tests: one short, serial test per group of steps ────────────────────

test('the setting is read-only for a member and an owner turns it on', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7738');
  await chapter('1 · Minji reads the project’s auto-translate setting: off, with no switch', () =>
    step1(page, baseURL!, beat),
  );
  await chapter('2 · Olivia turns it on: who, off → on; Minji reads it on, still read-only', () =>
    step2(page, baseURL!, beat),
  );
});

test('a 한국어 member opens an English work item and reads it in 한국어 unprompted', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7738');
  await chapter('3 · Minji opens the item: marked translating, then 한국어, nothing pressed', () =>
    step3(page, baseURL!, beat),
  );
  await chapter('4 · Show original and Show translation ask for nothing', () => step4(page, beat));
});

test('the board, the backlog and the list read in 한국어 without a card resizing', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7738');
  await chapter(
    '5 · The board’s titles are marked, then 한국어; the backlog and list are free',
    async () => {
      await step5Board(page, baseURL!, beat);
      await step5Surfaces(page, beat);
    },
  );
});

test('a Deutsch reader at the same time, and the charge', async ({
  page,
  browser,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7738');
  await chapter('6 · Greta reads the same item in Deutsch while Minji’s view stays 한국어', () =>
    step6(page, browser, baseURL!, beat),
  );
  await chapter('7 · Usage & cost: the Translation line shows the three jobs', () =>
    step7(page, baseURL!, beat),
  );
});

test('a second 한국어 reader and the English owner spend nothing', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7738');
  await chapter('8 · Joon gets the item and the board in 한국어 at once, and free', () =>
    step8(page, baseURL!, beat),
  );
  await chapter('9 · Olivia reads English: no mark, no job, no charge', () =>
    step9(page, baseURL!, beat),
  );
});

test('editing opens the original, and an agent reads the original', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7738');
  await chapter(
    '10 · Minji edits the English description: only it is translated again, once',
    async () => {
      await editDescription(page, baseURL!, beat);
      await retranslateEdit(page, beat);
    },
  );
  await chapter('11 · An agent reads the work item over MCP: the English, edit included', () =>
    step11(baseURL!, beat),
  );
});

test('with no credit the English stays, with one notice, and nothing is spent', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7738');
  await chapter('12 · An organisation out of credit: English, one notice per surface, no job', () =>
    step12(page, baseURL!, beat),
  );
});

test('turning it off returns English, and Translate shows the kept 한국어 for free', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7738');
  await chapter('13 · Olivia turns it off; Minji reads English and Translate is free', async () => {
    await turnOff(page, baseURL!, beat);
    await readEnglishAgain(page, baseURL!, beat);
  });
});
