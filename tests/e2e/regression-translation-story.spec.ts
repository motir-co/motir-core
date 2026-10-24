// ACCEPTANCE: translate a work item on demand (Story MOTIR-7735 · MOTIR-8125).
//
// The story's ten Verification steps as people meet them in a browser, recorded
// as the story's receipt — one `chapter()` per step:
//
//   1.  an organisation with AI credit, a work item written in Chinese, and three
//       readers: A and B in Deutsch, C in 中文; the Translation figure before
//       anything is pressed;
//   2.  A presses Translate: every differing field is marked while its original
//       stays, then reads German — a link and a work item chip still pointing
//       where they did;
//   3.  Show original / Show translation ask for nothing;
//   4.  Settings → Organization → Usage & cost shows the one job's charge;
//   5.  B, in a fresh browser context, gets the kept German for free;
//   6.  an agent's MCP `get_work_item` reads the Chinese original;
//   7.  C, already in 中文, sees no Translate control;
//   8.  a colleague's edit reaches A's open translated view: only the description
//       is translated again, once; B then loads it fresh and it is already kept;
//   9.  an organisation with no credit: the original stays, the no-credit
//       message, a way to add credit for the owner and none for a member;
//   10. a failed job keeps the original with Retry, Retry then translates; a
//       held job ends in the timeout state with Retry, and nothing is charged.
//
// Each group is its own short test, so each clip stays inside the lane's budget
// (`playwright.acceptance.config.ts`); step 10's held job waits out the door's
// 45 s deadline (`TRANSLATE_DEADLINE_MS`), so it has a clip of its own. The tests
// share one seed and run in order.
//
// ⚠️ ONE RECORDED PAGE PER TEST. A recording is one test directory's
// `video.webm`, and a second browser context would put a second `.webm` beside it
// (`regression-font-picks.spec.ts`). So the readers take turns on the test's own
// page, each signed in through the real auth route on a cleared cookie jar. Step
// 5's "fresh browser context" is the second test's own context — B is the first
// and only person who ever uses it.
//
// ⚠️ ONLY motir-ai IS REPLACED, by the lane's two in-repo boundary mocks
// (`lib/test-ai-jobs-mock.ts`, `lib/test-billing-mock.ts`). A job is HELD by
// declaring its outcome `running`, and released by switching the same entry to
// `succeeded` — the mock re-reads its fixture on every request — so the in-progress
// marks are asserted while they are certainly on screen, never raced.
//
// ⚠️ THE COLLEAGUE'S EDIT reaches A's open page the way the shipped page sees one:
// the page re-reads itself when its tab is shown again (`LiveOfferRefresh`). The
// spec says the tab was shown again (`visibilitychange`) instead of waiting out
// the one-minute timer that also triggers it.
//
// Authoritative signals throughout (CLAUDE.md): every press waits on its
// `POST /api/work-items/[id]/translate` response (armed before the click), counts
// are the jobs mock's own submit record, figures the billing mock's own report.
// Counts and figures are literals from the case. The holds inside `chapter()` /
// `beat()` are pacing for the viewer, never a wait.

import type { Page, Response } from '@playwright/test';
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
  TRANSLATION_CREDITS_PER_JOB as K,
  createReader,
  mintToken,
  reportedTranslation,
  resetJobs,
  seedChineseItem,
  seedOrg,
  setNextTranslateOutcome,
  setTranslateOutcome,
  signInAs,
  storyText,
  translateSubmits,
  type OrgSeed,
  type Person,
  type StoryText,
} from './_helpers/translation-seed';

test.describe.configure({ mode: 'serial' });

const de = (key: string, args: Record<string, string> = {}) => msg('de', key, args);
const tr = (key: string, args: Record<string, string> = {}) => de(`itemTranslation.${key}`, args);

interface Seed {
  org: OrgSeed;
  dry: OrgSeed;
  a: Person;
  b: Person;
  c: Person;
  d: Person;
  e: Person;
  story: { id: string; key: string; todoIds: string[] };
  retryItem: { id: string; key: string; title: string };
  heldItem: { id: string; key: string; title: string };
  dryItem: { id: string; key: string; title: string };
  text: StoryText;
  agentToken: string;
  colleagueToken: string;
}

let seed: Seed;

/** The AI planning credits the first organisation has already spent. */
const AI_SPEND = 1_240;

async function seedPeople() {
  const slug = Date.now().toString(36);
  const person = (who: string, name: string, locale: 'de' | 'zh') =>
    createReader(`tr-${who}-${slug}@example.com`, name, locale);
  return {
    a: await person('a', 'Anna Leser', 'de'),
    b: await person('b', 'Ben Leser', 'de'),
    c: await person('c', '陈读者', 'zh'),
    d: await person('d', 'Dora Inhaberin', 'de'),
    e: await person('e', 'Emil Mitglied', 'de'),
  };
}

async function seedItems(org: OrgSeed, dry: OrgSeed) {
  const retryTitle = '修复登录页面的布局';
  const retry = await seedChineseItem(org, { title: retryTitle, description: '按钮应该居中。' });
  const text = storyText(retry.id, retry.key);
  const story = await seedChineseItem(org, text.zh);
  const heldTitle = '更新帮助中心的截图';
  const held = await seedChineseItem(org, { title: heldTitle, description: '截图已经过时了。' });
  const dryTitle = '整理客户反馈';
  const dryItem = await seedChineseItem(dry, { title: dryTitle, description: '每周汇总一次。' });
  return {
    text,
    story,
    retryItem: { ...retry, title: retryTitle },
    heldItem: { ...held, title: heldTitle },
    dryItem: { ...dryItem, title: dryTitle },
  };
}

test.beforeAll(async () => {
  await resetDatabase();
  resetBillingFixture();
  resetJobs();
  const people = await seedPeople();
  const org = await seedOrg(people.a, 'LANG', [people.b, people.c]);
  const dry = await seedOrg(people.d, 'ZWEI', [people.e]);
  // The first organisation's entry names no `translation` block, so the billing
  // mock derives it from the succeeded jobs; the second's is SCRIPTED, because
  // that derived figure is lane-global, not org-keyed. The first organisation
  // has planned with AI before (`totalSpend`): Usage & cost draws its figures —
  // the Translation line among them — only for an organisation with AI usage
  // (`OrgUsageDTO.hasUsage`, which translation spend alone does not set).
  setOrgBillingState(org.orgId, { ...paidOrgState(), totalSpend: AI_SPEND });
  setOrgBillingState(dry.orgId, {
    ...freeOrgState(0),
    translation: { totalSpend: 0, monthSpend: 0 },
  });
  seed = {
    ...people,
    org,
    dry,
    ...(await seedItems(org, dry)),
    agentToken: await mintToken(org, people.a, 'translation-story-agent'),
    colleagueToken: await mintToken(org, people.b, 'translation-story-colleague'),
  };
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

// ── locators and signals ────────────────────────────────────────────────────

const main = (page: Page) => page.getByRole('main');
const titleOf = (page: Page) => main(page).getByRole('heading', { level: 1 });
const descriptionOf = (page: Page, lang = 'de') =>
  main(page).getByLabel(msg(lang, 'issueViews.issueDescriptionAria'));
/** The translation bar under the title — the one control and its message. */
const bar = (page: Page) => main(page).getByRole('group', { name: tr('groupLabel') });
const control = (page: Page, key: string) =>
  main(page).getByRole('button', { name: tr(key), exact: true });
/** A field's mark, by its text name: "{Field}: {mark}". */
const mark = (page: Page, field: string, text: string) =>
  main(page).getByText(`${tr('markPrefix', { field: tr(field) })}${tr(text)}`, { exact: true });

const isTranslatePost = (r: Response) =>
  r.request().method() === 'POST' && /\/api\/work-items\/[^/]+\/translate$/.test(r.url());

async function openItem(page: Page, key: string, title: string) {
  await page.goto(`/items/${key}`);
  await expect(titleOf(page)).toHaveText(title, { timeout: FIRST_PAINT_MS });
}

/** Press a control and wait for the translate POST it sends to answer 200. */
async function pressAndSettle(page: Page, key: string, timeout?: number) {
  const answered = page.waitForResponse(isTranslatePost, { timeout });
  await control(page, key).click();
  const res = await answered;
  expect(res.status()).toBe(200);
  return (await res.json()) as { fields: { fieldRef: string; status: string }[] };
}

/** Open both to-dos' notes, so their text is on screen before and after. */
async function openNotes(page: Page) {
  const show = main(page).getByRole('button', { name: de('workItemTodos.notesShow') });
  await expect(show).toHaveCount(2);
  await show.first().click();
  await expect(show).toHaveCount(1);
  await show.first().click();
  await expect(show).toHaveCount(0);
}

/** The German the mock answers for the story item: one entry per fieldRef. */
function germanTranslations() {
  const { de: g } = seed.text;
  const [one, two] = seed.story.todoIds as [string, string];
  return [
    { fieldRef: 'title', text: g.title },
    { fieldRef: 'description', text: g.description },
    { fieldRef: 'explanation', text: g.explanation },
    { fieldRef: `todo:${one}:text`, text: g.todos[0]!.text },
    { fieldRef: `todo:${one}:notes`, text: g.todos[0]!.notes },
    { fieldRef: `todo:${two}:text`, text: g.todos[1]!.text },
    { fieldRef: `todo:${two}:notes`, text: g.todos[1]!.notes },
  ];
}

/** Every one of the story item's seven fields, read in `lang`'s text. */
async function expectStoryFields(page: Page, text: StoryText['zh'] | StoryText['de']) {
  await expect(titleOf(page)).toHaveText(text.title);
  await expect(descriptionOf(page)).toContainText(text.lead);
  await expect(main(page).getByText(text.explanation, { exact: true })).toBeVisible();
  for (const todo of text.todos) {
    await expect(main(page).getByText(todo.text, { exact: true })).toBeVisible();
    await expect(main(page).getByText(todo.notes, { exact: true })).toBeVisible();
  }
}

/** The description's link and work item chip still point where they did. */
async function expectLinkAndChip(page: Page, linkName: string) {
  const body = descriptionOf(page);
  await expect(body.getByRole('link', { name: linkName })).toHaveAttribute('href', seed.text.link);
  const chip = body.getByRole('link', { name: new RegExp(seed.retryItem.key) });
  await expect(chip).toHaveAttribute('href', new RegExp(`/items/${seed.retryItem.key}$`));
}

/** The Translation line on Usage & cost, read as the owner sees it. */
async function expectUsageLine(page: Page, credits: number) {
  await page.goto('/settings/organization/usage');
  const card = main(page)
    .locator('[data-usage-translation]')
    .filter({ hasText: de('aiUsage.summary.translationThisMonth') });
  await expect(card).toHaveAttribute('data-usage-translation', 'spend', {
    timeout: FIRST_PAINT_MS,
  });
  await expect(card).toContainText(de('aiUsage.summary.credits', { n: String(credits) }));
  await expect(card).toContainText(
    de('aiUsage.summary.translationAllTime', { n: String(credits) }),
  );
}

const spend = (credits: number) => ({ totalSpend: credits, monthSpend: credits });

type Beat = () => Promise<void>;

// ── the steps, one function per chapter body ────────────────────────────────

async function step1(page: Page, baseURL: string, beat: Beat) {
  expect(reportedTranslation(seed.org.orgId)).toEqual(spend(0));
  expect(translateSubmits()).toHaveLength(0);
  await signInAs(page, baseURL, seed.a);
  await openItem(page, seed.story.key, seed.text.zh.title);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await openNotes(page);
  await expectStoryFields(page, seed.text.zh);
  await expect(main(page).getByRole('button', { name: tr('translate'), exact: true })).toHaveCount(
    1,
  );
  await beat();
}

async function step2(page: Page, beat: Beat) {
  setTranslateOutcome(0, { status: 'running' });
  const answered = page.waitForResponse(isTranslatePost);
  await control(page, 'translate').click();
  await expect(control(page, 'translating')).toHaveAttribute('aria-busy', 'true');
  for (const field of ['fieldTitle', 'fieldDescription', 'fieldExplanation']) {
    await expect(mark(page, field, 'markTranslating')).toBeVisible();
  }
  await expect(mark(page, 'fieldTodo', 'markTranslating')).toHaveCount(2);
  await expect(mark(page, 'fieldInstructions', 'markTranslating')).toHaveCount(2);
  await expectStoryFields(page, seed.text.zh);
  await expect.poll(() => translateSubmits().length).toBe(1);
  await beat();

  setTranslateOutcome(0, { status: 'succeeded', translations: germanTranslations() });
  expect((await answered).status()).toBe(200);
  await expectStoryFields(page, seed.text.de);
  await expect(mark(page, 'fieldTitle', 'markTranslating')).toHaveCount(0);
  await expectLinkAndChip(page, 'Exportleitfaden');
  await beat();
}

async function step3(page: Page, beat: Beat) {
  await control(page, 'showOriginal').click();
  await expectStoryFields(page, seed.text.zh);
  await expectLinkAndChip(page, '导出指南');
  await beat();
  await control(page, 'showTranslation').click();
  await expectStoryFields(page, seed.text.de);
  await expect(main(page).getByText(tr('markTranslating'))).toHaveCount(0);
  expect(translateSubmits()).toHaveLength(1);
  expect(translateSubmits()[0]!.refused).toBeUndefined();
  await beat();
}

async function step5(page: Page, baseURL: string, beat: Beat) {
  expect(await page.context().cookies()).toEqual([]);
  await signInAs(page, baseURL, seed.b);
  await openItem(page, seed.story.key, seed.text.zh.title);
  await openNotes(page);
  await pressAndSettle(page, 'translate');
  await expectStoryFields(page, seed.text.de);
  expect(translateSubmits()).toHaveLength(1);
  expect(reportedTranslation(seed.org.orgId)).toEqual(spend(K * 1));
  await beat();
}

async function step6(baseURL: string, beat: Beat) {
  const client = await openMcp(seed.agentToken, baseURL);
  try {
    const read = await mcp<{
      item: { title: string; descriptionMd: string; explanationMd: string };
    }>(client, 'get_work_item', { key: seed.story.key });
    expect(read.item.title).toBe(seed.text.zh.title);
    expect(read.item.descriptionMd).toBe(seed.text.zh.description);
    expect(read.item.explanationMd).toBe(seed.text.zh.explanation);
  } finally {
    await client.close();
  }
  await beat();
}

async function step7(page: Page, baseURL: string, beat: Beat) {
  await signInAs(page, baseURL, seed.c);
  await openItem(page, seed.story.key, seed.text.zh.title);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
  await expect(descriptionOf(page, 'zh')).toContainText(seed.text.zh.lead);
  const zhBar = main(page).getByRole('group', { name: msg('zh', 'itemTranslation.groupLabel') });
  await expect(zhBar).toHaveCount(0);
  await expect(
    main(page).getByRole('button', { name: msg('zh', 'itemTranslation.translate'), exact: true }),
  ).toHaveCount(0);
  await beat();
}

/** The colleague's edit to the description, through `update_work_item`. */
async function colleagueEditsDescription(baseURL: string) {
  const colleague = await openMcp(seed.colleagueToken, baseURL);
  try {
    await mcp(colleague, 'update_work_item', {
      key: seed.story.key,
      descriptionMd: seed.text.zh.edited,
      languages: { description: 'zh' },
    });
  } finally {
    await colleague.close();
  }
}

/** Step 8, Anna's half: her open translated view re-marks and re-translates. */
async function step8OpenView(page: Page, baseURL: string, beat: Beat) {
  await signInAs(page, baseURL, seed.a);
  await openItem(page, seed.story.key, seed.text.zh.title);
  await pressAndSettle(page, 'translate');
  await expect(titleOf(page)).toHaveText(seed.text.de.title);
  expect(translateSubmits()).toHaveLength(1);
  await beat();

  const ordinal = setNextTranslateOutcome({ status: 'running' });
  await colleagueEditsDescription(baseURL);
  const answered = page.waitForResponse(isTranslatePost);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(mark(page, 'fieldDescription', 'markEdited')).toBeVisible();
  await expect(descriptionOf(page)).toContainText(seed.text.zh.editedLead);
  await expect(titleOf(page)).toHaveText(seed.text.de.title);
  await expect.poll(() => translateSubmits().length).toBe(ordinal + 1);
  const resent = translateSubmits()[ordinal]!.translate!.fields.map((f) => f.fieldRef);
  expect(resent).toEqual(['description']);
  await beat();

  const edited = [{ fieldRef: 'description', text: seed.text.de.edited }];
  setTranslateOutcome(ordinal, { status: 'succeeded', translations: edited });
  expect((await answered).status()).toBe(200);
  await expect(descriptionOf(page)).toContainText(seed.text.de.editedLead);
  await expect(mark(page, 'fieldDescription', 'markEdited')).toHaveCount(0);
  await expect(titleOf(page)).toHaveText(seed.text.de.title);
  expect(translateSubmits()).toHaveLength(2);
  expect(reportedTranslation(seed.org.orgId)).toEqual(spend(K * 2));
  await beat();
}

/** Step 8, Ben's half: a fresh load shows the edited original, already kept. */
async function step8FreshLoad(page: Page, baseURL: string, beat: Beat) {
  await signInAs(page, baseURL, seed.b);
  await openItem(page, seed.story.key, seed.text.zh.title);
  await expect(descriptionOf(page)).toContainText(seed.text.zh.editedLead);
  await expect(control(page, 'translate')).toBeVisible();
  await pressAndSettle(page, 'translate');
  await expect(descriptionOf(page)).toContainText(seed.text.de.editedLead);
  expect(translateSubmits()).toHaveLength(2);
  expect(reportedTranslation(seed.org.orgId)).toEqual(spend(K * 2));
  await beat();
}

// ── steps 1–4 ───────────────────────────────────────────────────────────────

test('a German reader translates a Chinese work item, toggles, and the charge shows', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7735');
  await chapter('1 · A Chinese work item, three readers, and the figure before any press', () =>
    step1(page, baseURL!, beat),
  );
  await chapter('2 · Anna presses Translate: each field is marked, then reads German', () =>
    step2(page, beat),
  );
  await chapter('3 · Show original and Show translation ask for nothing', () => step3(page, beat));
  await chapter('4 · Usage & cost: the Translation line shows the one job', async () => {
    expect(reportedTranslation(seed.org.orgId)).toEqual(spend(K * 1));
    await expectUsageLine(page, K * 1);
    await beat();
  });
});

// ── steps 5–7 ───────────────────────────────────────────────────────────────

test('a second reader is free, an agent reads the original, a Chinese reader sees no control', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7735');
  await chapter('5 · Ben, in a fresh browser, gets the German at once and free', () =>
    step5(page, baseURL!, beat),
  );
  await chapter('6 · An agent reads the work item over MCP: the Chinese original', () =>
    step6(baseURL!, beat),
  );
  await chapter('7 · Chen, reading in 中文, sees no Translate control and no placeholder', () =>
    step7(page, baseURL!, beat),
  );
});

// ── step 8 ──────────────────────────────────────────────────────────────────

test('a colleague’s edit is translated again in the open view, once', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7735');
  await chapter(
    '8 · A colleague edits the description while Anna reads the translation',
    async () => {
      await step8OpenView(page, baseURL!, beat);
      await step8FreshLoad(page, baseURL!, beat);
    },
  );
});

// ── step 9 ──────────────────────────────────────────────────────────────────

test('with no credit the original stays, and only an owner is offered a way to add it', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7735');

  await chapter(
    '9 · An organisation out of credit: the original stays, nothing is charged',
    async () => {
      const before = translateSubmits().length;
      setNextTranslateOutcome({ submit: 'out_of_credits' });
      const addCredits = () => main(page).getByRole('link', { name: tr('addCredits') });

      await signInAs(page, baseURL!, seed.d);
      await openItem(page, seed.dryItem.key, seed.dryItem.title);
      await pressAndSettle(page, 'translate');
      await expect(bar(page).getByText(tr('noCredits'))).toBeVisible();
      await expect(addCredits()).toHaveAttribute('href', '/settings/organization/billing');
      await expect(control(page, 'retry')).toHaveCount(0);
      await expect(control(page, 'translate')).toHaveCount(0);
      await expect(titleOf(page)).toHaveText(seed.dryItem.title);
      await beat();

      await signInAs(page, baseURL!, seed.e);
      await openItem(page, seed.dryItem.key, seed.dryItem.title);
      await beat();
      await pressAndSettle(page, 'translate');
      await expect(bar(page).getByText(tr('noCredits'))).toBeVisible();
      await expect(bar(page).getByText(tr('noCreditsMember'))).toBeVisible();
      await expect(addCredits()).toHaveCount(0);
      await expect(control(page, 'retry')).toHaveCount(0);
      await expect(titleOf(page)).toHaveText(seed.dryItem.title);

      const refused = translateSubmits().slice(before);
      expect(refused.map((s) => s.refused)).toEqual([true, true]);
      expect(reportedTranslation(seed.org.orgId)).toEqual(spend(K * 2));
      expect(reportedTranslation(seed.dry.orgId)).toEqual(spend(0));
      await beat();
    },
  );
});

// ── step 10 ─────────────────────────────────────────────────────────────────

test('a failed job keeps the original with Retry, and Retry translates', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7735');

  await chapter('10 · A failed translation: the original, nothing charged, and Retry', async () => {
    const ordinal = setNextTranslateOutcome({ status: 'failed' });
    await signInAs(page, baseURL!, seed.a);
    await openItem(page, seed.retryItem.key, seed.retryItem.title);
    await pressAndSettle(page, 'translate');
    await expect(bar(page).getByText(tr('failedItem'))).toBeVisible();
    await expect(control(page, 'retry')).toBeVisible();
    await expect(titleOf(page)).toHaveText(seed.retryItem.title);
    expect(translateSubmits()).toHaveLength(ordinal + 1);
    expect(reportedTranslation(seed.org.orgId)).toEqual(spend(K * 2));
    await beat();

    setTranslateOutcome(ordinal + 1, { status: 'succeeded' });
    await pressAndSettle(page, 'retry');
    // The mock's default success echoes each field as `[<language>] <text>`.
    await expect(titleOf(page)).toHaveText(`[de] ${seed.retryItem.title}`);
    await expect(bar(page).getByText(tr('failedItem'))).toHaveCount(0);
    expect(translateSubmits()).toHaveLength(ordinal + 2);
    expect(reportedTranslation(seed.org.orgId)).toEqual(spend(K * 3));
    await beat();
    await beat();
  });
});

test('a job that never settles ends in the timeout state, with Retry and no charge', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7735');

  await chapter(
    '10 · A translation that never comes back: timed out, Retry, nothing charged',
    async () => {
      const ordinal = setNextTranslateOutcome({ status: 'running' });
      await signInAs(page, baseURL!, seed.a);
      await openItem(page, seed.heldItem.key, seed.heldItem.title);
      // The door gives up at its 45 s deadline; the response is the signal.
      const body = await pressAndSettle(page, 'translate', 75_000);
      expect(body.fields.length).toBeGreaterThan(0);
      expect(new Set(body.fields.map((f) => f.status))).toEqual(new Set(['timeout']));
      await expect(bar(page).getByText(tr('failedItem'))).toBeVisible();
      await expect(control(page, 'retry')).toBeVisible();
      await expect(titleOf(page)).toHaveText(seed.heldItem.title);
      expect(translateSubmits()).toHaveLength(ordinal + 1);
      expect(reportedTranslation(seed.org.orgId)).toEqual(spend(K * 3));
      await beat();
    },
  );
});
