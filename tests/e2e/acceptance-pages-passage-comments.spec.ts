// Acceptance E2E — comment on a passage (Story MOTIR-10867 · MOTIR-10905). The
// story's verification recipe in a real browser against the SERVED app: the
// Comment action beside a selection and none for whitespace, a thread whose
// passage is highlighted and quoted, the highlight surviving another member's
// edit across a reload and moving live under the reader's own, focus both ways,
// the thread link, resolve and reopen, a deleted passage falling back to
// page-level and coming back on restore, and the permission cases — a viewer and
// an archived page reading the highlights with no action, and a comment-only
// reader commenting from the read-only body. One test, one chapter per step.
//
// ── THE ACTORS ──────────────────────────────────────────────────────────────
// Members A (Ada) and B (Ben), viewer V (Vic), comment-only C (Cleo, a workspace
// custom role holding `comment:add` and no `page:edit`) and manager M (Mia, the
// project's creator), seeded through the real services. Every actor signs in on
// the ONE recorded page, as `acceptance-pages-discussion.spec.ts` does: the lane
// publishes one video per test, so a second browser context would be missing
// from the receipt. For the same reason the "fresh tab" of the thread link is a
// fresh DOCUMENT load of the address on that page — a new navigation holds no
// client state, which is what a new tab proves.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// A highlight is waited on through the editor's own decoration attributes
// (`data-wash-ids`, `data-wash-state`), a thread through `data-thread-anchor` /
// `data-thread-arrived` and the gone note's test id. Every write arms
// `waitForResponse` before the click that sends it; every body edit waits on
// its `POST …/updates` and then on the save indicator reading `saved`. A
// negative check (no Comment action) is taken after two animation frames, the
// editor's selection effect being frame-coalesced. There is no sleep; the only
// holds are the recording's `chapter()` and `beat()` pacing.
//
// ── THE SELECTIONS ──────────────────────────────────────────────────────────
// A selection is set on the live body's DOM by text, not dragged: the editor
// reads the WINDOW's selection (it has to, for the read-only body), so a range
// set in the document is exactly what a reader's drag leaves, and it lands on
// the same characters on every machine. A highlight splits the body's text
// nodes, so the text is located across nodes, never inside one.
//
// ── THE STRINGS ─────────────────────────────────────────────────────────────
// Every label matched is read from `messages/en.json`, never retyped.
//
// This repository's acceptance lane publishes the receipt on a green run; no MCP
// publish is made. CI is this spec's first run: the lane's `next build` cannot
// run in the cloud thread that wrote it.

import { execFileSync } from 'node:child_process';
import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { markProjectOnboarded } from './_helpers/ai-augment-replan-seed';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { PageCommentThreadDto } from '@/lib/pages';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 600_000 });

const PASSWORD = 'passage-comments-e2e-pass-123';
const ADA = { email: 'passage-ada@example.com', name: 'Ada Lovell' };
const BEN = { email: 'passage-ben@example.com', name: 'Ben Okafor' };
const VIC = { email: 'passage-vic@example.com', name: 'Vic Viewer' };
const CLEO = { email: 'passage-cleo@example.com', name: 'Cleo Commenter' };
const MIA = { email: 'passage-mia@example.com', name: 'Mia Manager' };
type Actor = typeof ADA;

const TITLE = 'Rollout plan';
const BODY = [
  '## Rollout',
  '',
  'The rollout starts on Monday with the internal workspace.',
  '',
  'Customers follow a week later, once the dashboards are green.',
].join('\n');

// The passages, as the journey changes them.
const PASSAGE = 'starts on Monday';
const AFTER_BEN = 'starts from Monday';
const AFTER_ADA = 'starts early from Monday';
const SECOND = 'the dashboards are green';
const BEN_SENTENCE = 'Plans are final. ';

const FIRST_COMMENT = 'Monday is a public holiday in two regions.';
const SECOND_COMMENT = 'Which dashboards, exactly?';
const PAGE_COMMENT = 'Looks good overall.';
const CLEO_COMMENT = 'Can the internal workspace go a day earlier?';

const D = en.pages.discussion;
const I = en.pages.discussion.inline;
const C = en.comments;
const H = en.pages.history;
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');
const plural = (template: string, count: number) => {
  const m = /^\{count, plural, one \{([^}]*)\} other \{([^}]*)\}\}$/.exec(template);
  if (!m) throw new Error(`not a count plural: ${template}`);
  return (count === 1 ? m[1]! : m[2]!).replace('#', String(count));
};

// ── Seed ────────────────────────────────────────────────────────────────────

interface Seed {
  pageId: string;
  projectId: string;
  mia: { userId: string; workspaceId: string };
}

async function seed(): Promise<Seed> {
  const mia = await usersService.createUser({ ...MIA, password: PASSWORD });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Passage Workspace',
    ownerUserId: mia.id,
  });
  const ctx = { userId: mia.id, workspaceId: workspace.id };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: mia.id,
    name: 'Launch',
    identifier: 'PPC',
  });
  await markProjectOnboarded(project.id);
  await projectsService.setActiveProject({ ...ctx, projectId: project.id });

  // A reader who may comment and may not edit: no built-in role is that.
  const commentOnly = await adminDb.workspaceRoleDefinition.create({
    data: {
      workspaceId: workspace.id,
      name: 'Commenter',
      permissions: ['project:browse', 'page:view', 'comment:add'],
    },
  });

  for (const [actor, role] of [
    [ADA, 'member'],
    [BEN, 'member'],
    [VIC, 'viewer'],
    [CLEO, commentOnly.id],
  ] as const) {
    const user = await usersService.createUser({ ...actor, password: PASSWORD });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await addToProjectAs({
      key: project.identifier,
      actorUserId: mia.id,
      ctx,
      targetUserId: user.id,
      role,
    });
    await projectsService.setActiveProject({
      userId: user.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });
  }

  const page = await pagesService.createPageFromMarkdown(ctx, {
    projectId: project.id,
    title: TITLE,
    markdown: BODY,
  });
  return { pageId: page.id, projectId: project.id, mia: ctx };
}

// ── Waits ───────────────────────────────────────────────────────────────────

function respondsTo(
  page: Page,
  path: string,
  method: string,
  search?: (params: URLSearchParams) => boolean,
): Promise<Response> {
  return page.waitForResponse((r) => {
    const url = new URL(r.url());
    return (
      url.pathname === path &&
      r.request().method() === method &&
      (search === undefined || search(url.searchParams))
    );
  });
}

const commentsPath = (pageId: string) => `/api/pages/${pageId}/comments`;
const listRead = (page: Page, pageId: string, status: 'open' | 'resolved') =>
  respondsTo(page, commentsPath(pageId), 'GET', (q) => q.get('status') === status);

async function answered<T>(pending: Promise<Response>, status: number): Promise<T> {
  const res = await pending;
  expect(res.status(), `${res.request().method()} ${new URL(res.url()).pathname}`).toBe(status);
  return (await res.json()) as T;
}

/** Two frames: the editor's selection effect is coalesced onto one. */
const settled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );

// ── Locators ────────────────────────────────────────────────────────────────

const control = (page: Page) => page.getByRole('button', { name: new RegExp(`^${D.open}(,|$)`) });
const openCount = (n: number) => `${D.open}, ${plural(D.openCount, n)}`;
const panelOf = (page: Page) => page.getByRole('complementary', { name: D.title, exact: true });
const switchOf = (panel: Locator, label: string) =>
  panel
    .getByRole('group', { name: D.switchLabel, exact: true })
    .getByRole('button', { name: new RegExp(`^${label}`) });
const openList = (panel: Locator) =>
  panel.getByRole('list', { name: D.openThreadsLabel, exact: true });
const resolvedList = (panel: Locator) =>
  panel.getByRole('list', { name: D.resolvedThreadsLabel, exact: true });
const threadOf = (scope: Locator, id: string) => scope.getByTestId(`page-thread-${id}`);
const action = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });

const LIVE_BODY = `[aria-label="${en.pages.editor.bodyLabel}"]`;
const liveBody = (page: Page) => page.locator(LIVE_BODY).first();
const commentAction = (page: Page) =>
  page.getByRole('button', { name: I.actionLabel, exact: true });
const composerOf = (page: Page) => page.getByRole('group', { name: I.editorLabel, exact: true });
const washOf = (page: Page, id: string) => page.locator(`[data-wash-ids~="${id}"]`);
const saveIndicator = (page: Page) => page.locator('[role="status"][data-status]').first();

/** Every character a thread's highlight covers, across the spans it is drawn in. */
const washText = (page: Page, id: string) =>
  page.evaluate(
    ([selector, wanted]) =>
      Array.from(document.querySelector(selector)!.querySelectorAll('[data-wash-ids]'))
        .filter((el) => el.getAttribute('data-wash-ids')!.split(' ').includes(wanted))
        .map((el) => el.textContent ?? '')
        .join(''),
    [LIVE_BODY, id] as const,
  );

// ── Selections on the live body ─────────────────────────────────────────────

interface Span {
  /** Text the span starts in (the first occurrence in the body). */
  readonly start: string;
  /** Characters into `start` the span begins at. */
  readonly startAt?: number;
  /** Text the span ends in; defaults to `start`. */
  readonly end?: string;
  /** Characters into `end` the span ends at; defaults to the end of `end`. */
  readonly endAt?: number;
  /** Put the caret at the start and select nothing (to type there). */
  readonly caret?: boolean;
}

/** Set the window's selection on the live body, by text located across text nodes. */
async function select(page: Page, span: Span): Promise<void> {
  await page.evaluate(
    ([selector, s]) => {
      const root = document.querySelector<HTMLElement>(selector)!;
      const nodes: Text[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
      const full = nodes.map((n) => n.data).join('');
      // A boundary index belongs to the node BEFORE it for an end, AFTER it for a start.
      const at = (index: number, isEnd: boolean): [Text, number] => {
        let seen = 0;
        for (const node of nodes) {
          const len = node.data.length;
          if (isEnd ? index <= seen + len : index < seen + len) return [node, index - seen];
          seen += len;
        }
        const last = nodes[nodes.length - 1]!;
        return [last, last.data.length];
      };
      const from = full.indexOf(s.start);
      if (from < 0) throw new Error(`the body holds no "${s.start}"`);
      const startIndex = from + (s.startAt ?? 0);
      const endText = s.end ?? s.start;
      const endFrom = s.end === undefined ? from : full.indexOf(endText);
      if (endFrom < 0) throw new Error(`the body holds no "${endText}"`);
      const endIndex = s.caret ? startIndex : endFrom + (s.endAt ?? endText.length);
      const range = document.createRange();
      range.setStart(...at(startIndex, false));
      range.setEnd(...(s.caret ? at(startIndex, false) : at(endIndex, true)));
      if (root.isContentEditable) root.focus();
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    },
    [LIVE_BODY, span] as const,
  );
}

/** Type at a caret placed by text, and wait for the body to be saved. */
async function typeAt(page: Page, pageId: string, span: Span, text: string) {
  await select(page, { ...span, caret: true });
  const saved = respondsTo(page, `/api/pages/${pageId}/updates`, 'POST');
  await page.keyboard.type(text, { delay: 40 });
  expect((await saved).status()).toBe(200);
  await expect(saveIndicator(page)).toHaveAttribute('data-status', 'saved');
}

/** Select text and replace it (empty `text` deletes it), and wait for the save. */
async function replace(page: Page, pageId: string, span: Span, text: string) {
  await select(page, span);
  const saved = respondsTo(page, `/api/pages/${pageId}/updates`, 'POST');
  if (text) await page.keyboard.type(text, { delay: 40 });
  else await page.keyboard.press('Backspace');
  expect((await saved).status()).toBe(200);
  await expect(saveIndicator(page)).toHaveAttribute('data-status', 'saved');
}

/** Sign `actor` in on the recorded page and open `/pages/<id>` (with `search`). */
async function as(page: Page, actor: Actor, pageId: string, search = '') {
  await signIn(page, actor.email, PASSWORD);
  await page.goto(`/pages/${pageId}${search}`);
  await expect(control(page)).toBeVisible();
  await expect(liveBody(page)).toBeVisible();
}

async function openPanel(page: Page, pageId: string): Promise<Locator> {
  const read = listRead(page, pageId, 'open');
  await control(page).click();
  await answered(read, 200);
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  return panel;
}

/** Select `span`, choose the action, write `text`, post it; the posted thread. */
async function commentOn(
  page: Page,
  pageId: string,
  span: Span,
  text: string,
): Promise<PageCommentThreadDto> {
  await select(page, span);
  await expect(commentAction(page)).toBeVisible();
  await commentAction(page).click();
  const composer = composerOf(page);
  await expect(composer).toBeVisible();
  const box = composer.getByRole('textbox', { name: I.editorLabel, exact: true });
  await expect(box).toBeFocused();
  await box.pressSequentially(text, { delay: 30 });
  const posted = respondsTo(page, commentsPath(pageId), 'POST');
  await action(composer, D.comment).click();
  const thread = await answered<PageCommentThreadDto>(posted, 201);
  expect(thread.anchor).not.toBeNull();
  await expect(composer).toHaveCount(0);
  return thread;
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('Members comment on a passage, the highlight follows the text, and readers without edit rights see or add threads: the recipe', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-10867');
  const s = await seed();
  const path = commentsPath(s.pageId);
  let firstId = '';
  let secondId = '';
  let pageLevelId = '';

  await chapter(
    'Step 1 · Ada selects a sentence and the Comment action appears; whitespace shows none',
    async () => {
      await as(page, ADA, s.pageId);
      // From the end of the heading to the start of the paragraph: only a break.
      await select(page, {
        start: 'Rollout',
        startAt: 'Rollout'.length,
        end: 'The rollout',
        endAt: 0,
      });
      await settled(page);
      await expect(commentAction(page)).toHaveCount(0);
      await beat();

      await select(page, { start: PASSAGE });
      await expect(commentAction(page)).toBeVisible();
      await expect(commentAction(page)).toHaveText(I.action);
    },
  );
  await beat();

  await chapter(
    'Step 2 · Ada comments on it: the passage is highlighted and quoted, and the count rises',
    async () => {
      await expect(control(page)).toHaveAccessibleName(D.open);
      const thread = await commentOn(page, s.pageId, { start: PASSAGE }, FIRST_COMMENT);
      firstId = thread.id;
      expect(thread.anchor!.quote).toBe(PASSAGE);
      await expect(washOf(page, firstId).first()).toBeVisible();
      expect(await washText(page, firstId)).toBe(PASSAGE);
      await expect(control(page)).toHaveAccessibleName(openCount(1));

      const panel = await openPanel(page, s.pageId);
      const row = threadOf(openList(panel), firstId);
      await expect(row).toHaveAttribute('data-thread-anchor', 'inline');
      await expect(row.getByTestId('page-thread-quote')).toHaveText(PASSAGE);
      await expect(row).toContainText(FIRST_COMMENT);
      await beat();

      // A second passage, and a page-level thread, for the focus and link steps.
      const second = await commentOn(page, s.pageId, { start: SECOND }, SECOND_COMMENT);
      secondId = second.id;
      await expect(washOf(page, secondId).first()).toBeVisible();
      await action(panel, C.addPlaceholder).click();
      const box = panel.getByRole('textbox', { name: D.composerLabel, exact: true });
      await box.click();
      await box.pressSequentially(PAGE_COMMENT, { delay: 30 });
      const posted = respondsTo(page, path, 'POST');
      await action(panel, D.comment).click();
      const pageLevel = await answered<PageCommentThreadDto>(posted, 201);
      expect(pageLevel.anchor).toBeNull();
      pageLevelId = pageLevel.id;
      await expect(threadOf(openList(panel), pageLevelId)).toHaveAttribute(
        'data-thread-anchor',
        'page',
      );
      await expect(control(page)).toHaveAccessibleName(openCount(3));
    },
  );
  await beat();

  await chapter(
    'Step 3 · Ben adds a sentence before the passage and changes a word in it; Ada reloads',
    async () => {
      await as(page, BEN, s.pageId);
      await typeAt(page, s.pageId, { start: 'The rollout' }, BEN_SENTENCE);
      await replace(page, s.pageId, { start: 'on Monday', end: 'on Monday', endAt: 2 }, 'from');
      await expect(liveBody(page)).toContainText(`${BEN_SENTENCE}The rollout ${AFTER_BEN}`);
      await beat();

      await as(page, ADA, s.pageId);
      await expect(washOf(page, firstId).first()).toBeVisible();
      expect(await washText(page, firstId)).toBe(AFTER_BEN);
    },
  );
  await beat();

  await chapter(
    'Step 4 · Ada types before and inside the passage, and the highlight moves with it',
    async () => {
      const before = await washOf(page, firstId).first().boundingBox();
      await typeAt(page, s.pageId, { start: BEN_SENTENCE }, 'Update: ');
      await expect
        .poll(async () => (await washOf(page, firstId).first().boundingBox())?.x)
        .not.toBe(before?.x);
      expect(await washText(page, firstId)).toBe(AFTER_BEN);
      await typeAt(page, s.pageId, { start: AFTER_BEN, startAt: 'starts '.length }, 'early ');
      await expect.poll(() => washText(page, firstId)).toBe(AFTER_ADA);
    },
  );
  await beat();

  await chapter(
    'Step 5 · Ada clicks a highlight, then focuses the other thread in the panel',
    async () => {
      const read = listRead(page, s.pageId, 'open');
      await washOf(page, firstId).first().click();
      await answered(read, 200);
      const panel = panelOf(page);
      await expect(threadOf(openList(panel), firstId)).toHaveAttribute(
        'data-thread-arrived',
        'true',
      );
      await expect(page).toHaveURL(new RegExp(`[?&]thread=${firstId}`));
      await beat();

      await action(threadOf(openList(panel), secondId), C.reply).focus();
      await expect(washOf(page, secondId).first()).toHaveAttribute('data-wash-state', 'emphasis');
      await expect(washOf(page, secondId).first()).toBeInViewport();
      await expect(washOf(page, firstId).first()).toHaveAttribute('data-wash-state', 'rest');
      await expect(page).toHaveURL(new RegExp(`[?&]thread=${secondId}`));
    },
  );
  await beat();

  await chapter(
    'Step 6 · The thread link opens the panel at the thread, in a fresh load',
    async () => {
      let read = listRead(page, s.pageId, 'open');
      await page.goto(`/pages/${s.pageId}?thread=${secondId}`);
      await answered(read, 200);
      let panel = panelOf(page);
      await expect(threadOf(openList(panel), secondId)).toHaveAttribute(
        'data-thread-arrived',
        'true',
      );
      await expect(washOf(page, secondId).first()).toHaveAttribute('data-wash-state', 'emphasis');
      await expect(washOf(page, secondId).first()).toBeInViewport();
      await beat();

      read = listRead(page, s.pageId, 'open');
      await page.goto(`/pages/${s.pageId}?thread=${pageLevelId}`);
      await answered(read, 200);
      panel = panelOf(page);
      await expect(threadOf(openList(panel), pageLevelId)).toHaveAttribute(
        'data-thread-arrived',
        'true',
      );
      await expect(washOf(page, firstId).first()).toBeVisible();
      await expect(page.locator('[data-wash-state="emphasis"]')).toHaveCount(0);
    },
  );
  await beat();

  await chapter('Step 7 · Ada resolves the first thread and reopens it', async () => {
    const panel = panelOf(page);
    const resolving = respondsTo(page, `${path}/${firstId}/resolution`, 'POST');
    await action(threadOf(openList(panel), firstId), D.resolve).click();
    await answered(resolving, 200);
    await expect(washOf(page, firstId)).toHaveCount(0);
    await expect(threadOf(openList(panel), firstId)).toHaveCount(0);
    const read = listRead(page, s.pageId, 'resolved');
    await switchOf(panel, D.listResolved).click();
    await answered(read, 200);
    await expect(threadOf(resolvedList(panel), firstId)).toBeVisible();
    await beat();

    const reopening = respondsTo(page, `${path}/${firstId}/resolution`, 'DELETE');
    await action(threadOf(resolvedList(panel), firstId), D.reopen).click();
    await answered(reopening, 200);
    await expect(washOf(page, firstId).first()).toBeVisible();
    expect(await washText(page, firstId)).toBe(AFTER_ADA);
    await switchOf(panel, D.listOpen).click();
    await expect(threadOf(openList(panel), firstId)).toHaveAttribute(
      'data-thread-anchor',
      'inline',
    );
  });
  await beat();

  await chapter(
    'Step 8 · Ben deletes the passage; the thread falls back to page-level, and a restore brings it back',
    async () => {
      await as(page, BEN, s.pageId);
      await replace(page, s.pageId, { start: AFTER_ADA }, '');
      await expect(washOf(page, firstId)).toHaveCount(0);

      await as(page, ADA, s.pageId);
      await expect(washOf(page, secondId).first()).toBeVisible();
      await expect(washOf(page, firstId)).toHaveCount(0);
      const panel = await openPanel(page, s.pageId);
      const row = threadOf(openList(panel), firstId);
      await expect(row).toHaveAttribute('data-thread-anchor', 'gone');
      await expect(row.getByTestId('page-thread-gone-note')).toHaveText(I.gone);
      await expect(row.getByTestId('page-thread-quote')).toHaveText(PASSAGE);
      await beat();

      // History, newest first: Ben's delete (current), then Ada's edits — restore those.
      const listed = respondsTo(page, `/api/pages/${s.pageId}/versions`, 'GET');
      await page.getByRole('button', { name: H.open, exact: true }).click();
      expect((await listed).status()).toBe(200);
      const rows = page.getByRole('list', { name: H.listLabel, exact: true }).getByRole('button');
      await expect(rows.nth(0)).toContainText(BEN.name);
      const label = (await rows.nth(1).innerText()).match(/v(\d+)/);
      const n = Number(label![1]);
      const opened = respondsTo(page, `/api/pages/${s.pageId}/versions/${n}`, 'GET');
      await rows.nth(1).click();
      expect((await opened).status()).toBe(200);
      await page.getByRole('button', { name: H.restore, exact: true }).click();
      const dialog = page.getByRole('alertdialog', {
        name: fill(H.confirm.title, { number: String(n) }),
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await beat();
      const restored = respondsTo(page, `/api/pages/${s.pageId}/versions/${n}/restore`, 'POST');
      await action(dialog, fill(H.confirm.action, { number: String(n) })).click();
      expect((await restored).status()).toBe(200);
      await expect(liveBody(page)).toContainText(AFTER_ADA);
      await expect(washOf(page, firstId).first()).toBeVisible();
      expect(await washText(page, firstId)).toBe(AFTER_ADA);
    },
  );
  await beat();

  await chapter(
    'Step 9 · Vic, a viewer, sees the highlights and gets no Comment action',
    async () => {
      await as(page, VIC, s.pageId);
      await expect(washOf(page, firstId).first()).toBeVisible();
      await expect(washOf(page, secondId).first()).toBeVisible();
      await expect(liveBody(page)).not.toHaveAttribute('contenteditable', 'true');
      await select(page, { start: 'Customers follow' });
      await settled(page);
      await expect(commentAction(page)).toHaveCount(0);
      const panel = await openPanel(page, s.pageId);
      await expect(threadOf(openList(panel), firstId)).toBeVisible();
      await expect(panel.getByText(D.readOnlyViewer, { exact: true })).toBeVisible();
    },
  );
  await beat();

  await chapter(
    'Step 10 · Cleo may comment but not edit, and comments from the read-only body',
    async () => {
      await as(page, CLEO, s.pageId);
      await expect(liveBody(page)).not.toHaveAttribute('contenteditable', 'true');
      const thread = await commentOn(
        page,
        s.pageId,
        { start: 'the internal workspace' },
        CLEO_COMMENT,
      );
      expect(thread.anchor!.quote).toBe('the internal workspace');
      await expect(washOf(page, thread.id).first()).toBeVisible();
      await expect(control(page)).toHaveAccessibleName(openCount(4));
    },
  );
  await beat();

  await chapter(
    'Step 11 · The page is archived: highlights and threads read, and no Comment action',
    async () => {
      await pagesService.archivePage(s.mia, { projectId: s.projectId, pageId: s.pageId });
      await as(page, ADA, s.pageId);
      await expect(washOf(page, firstId).first()).toBeVisible();
      await select(page, { start: 'Customers follow' });
      await settled(page);
      await expect(commentAction(page)).toHaveCount(0);
      const panel = await openPanel(page, s.pageId);
      await expect(panel.getByText(D.readOnlyArchived, { exact: true })).toBeVisible();
      await expect(threadOf(openList(panel), firstId)).toHaveAttribute(
        'data-thread-anchor',
        'inline',
      );
    },
  );

  // Every locale carries every string the journey rendered.
  execFileSync('pnpm', ['i18n:status', '--check'], { stdio: 'pipe' });
});
