// Acceptance E2E — mention a teammate in a page comment and notify them (Story
// MOTIR-10868 · MOTIR-10929). The story's nine-step verification recipe in a real
// browser against the SERVED app: the Comment action and a picker that offers
// only people who can enter the project; an inline mention reaching the drawer
// and the outbox; the row opening the page at that thread; the reply and the
// mention sentences, each chosen by who was named; an edit that adds a mention
// notifying only the person added; the email channel switched off; a gone
// passage opening page-level with its quote; and a deleted page taking its
// notifications with it. One test, one chapter per step, `Step 1` to `Step 9`.
//
// ── THE ACTORS ──────────────────────────────────────────────────────────────
// Members A (Ada), B (Ben) and C (Cleo); D (Dee), a workspace member with no role
// in the project; and M (Mia), the project's creator, who may delete the page.
// Seeded through the real services. Every actor signs in on the ONE recorded
// page, as `acceptance-pages-discussion.spec.ts` does: the lane publishes one
// video per test, so a second browser context would be missing from the receipt.
// The recipe's "open it" moments are fresh DOCUMENT loads of the address, which
// hold no client state.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Both channels are written by jobs, after the write that caused them. So every
// assertion after a write waits on an authoritative signal: a row counted through
// `adminDb` (exact, where a rendered list only suggests), the recipient's
// `/api/notifications/unread-count`, or the file outbox. A negative ("nothing
// reached C") is read only after a positive from the same event has landed, so it
// cannot pass merely because nothing has happened yet. Every write arms
// `waitForResponse` before the click that sends it. There is no sleep; the only
// holds are the recording's `chapter()` and `beat()` pacing.
//
// ── THE REPLY COMPOSER'S SEEDED MENTION ─────────────────────────────────────
// `PageCommentThread` opens the reply box with a mention of the thread's starter
// already in it, and one row per person per comment means a mention outranks a
// reply. So a step that wants the REPLY sentence clears that seed first, and a
// step that wants a mention clears it and picks the person through the picker.
// Each place says so where it happens.
//
// ── THE STRINGS ─────────────────────────────────────────────────────────────
// Every label and sentence matched is read from `messages/en.json`, never retyped.
//
// This repository's acceptance lane publishes the receipt on a green run; no MCP
// publish is made. CI is this spec's first run: the lane's `next build` cannot
// run in the cloud thread that wrote it.

import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { emailsTo, waitForEmail } from './_helpers/email-capture';
import { markProjectOnboarded } from './_helpers/ai-augment-replan-seed';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { PageCommentDto, PageCommentThreadDto } from '@/lib/pages';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 600_000 });

const PASSWORD = 'page-notify-e2e-pass-123';
const ADA = { email: 'pnotify-ada@example.com', name: 'Ada Lovell' };
const BEN = { email: 'pnotify-ben@example.com', name: 'Ben Okafor' };
const CLEO = { email: 'pnotify-cleo@example.com', name: 'Cleo Marsh' };
const DEE = { email: 'pnotify-dee@example.com', name: 'Dee Outsider' };
const MIA = { email: 'pnotify-mia@example.com', name: 'Mia Manager' };
type Actor = typeof ADA;

const TITLE = 'Release notes';
const PASSAGE = 'Freeze the branch on Monday.';
const BODY = ['## Launch', '', PASSAGE, '', 'Ship the notes on Thursday.'].join('\n');

// The recipe's own text.
const INLINE_TAIL = 'can you check the date?';
const PAGE_LEVEL = 'Overall this looks ready.';
const BEN_REPLY = 'The date is confirmed.';
const CLEO_TAIL = 'please sign off on the date.';
const WORD_EDIT = ' Thanks';
const STEP7_TAIL = 'the changelog is up.';
const STEP8_TAIL = 'the sentence moved to the summary.';

const D = en.pages.discussion;
const I = en.pages.discussion.inline;
const C = en.comments;
const AR = en.pages.archive;
const N = en.notifications;
const S = en.settings.account.notifications;
const E = en.email.pageCommentNotification;
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');
/** A rich drawer sentence as it reads: its `<s>` emphasis tags dropped. */
const sentence = (template: string, values: Record<string, string>) =>
  fill(template.replace(/<\/?s>/g, ''), values);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The bell's `{count, plural, =0 {…} other {…}}` name, in English. */
const bellName = (count: number) => {
  const m = /^\{count, plural, =0 \{([^}]*)\} other \{([^}]*)\}\}$/.exec(N.bellAria);
  if (!m) throw new Error(`not the bell's plural: ${N.bellAria}`);
  return count === 0 ? m[1]! : m[2]!.replace('#', String(count));
};
const mentionSentence = (actor: Actor) =>
  sentence(N.summary.pageMentioned, { actor: actor.name, page: TITLE });
const replySentence = (actor: Actor) =>
  sentence(N.summary.pageReplied, { actor: actor.name, page: TITLE });

// ── Seed ────────────────────────────────────────────────────────────────────

interface Seed {
  pageId: string;
  projectId: string;
  ids: Record<string, string>;
}

async function seed(): Promise<Seed> {
  const mia = await usersService.createUser({ ...MIA, password: PASSWORD });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Notify Workspace',
    ownerUserId: mia.id,
  });
  const ctx = { userId: mia.id, workspaceId: workspace.id };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: mia.id,
    name: 'Release train',
    identifier: 'PNT',
  });
  await markProjectOnboarded(project.id);
  await projectsService.setActiveProject({ ...ctx, projectId: project.id });

  const ids: Record<string, string> = { [MIA.email]: mia.id };
  for (const actor of [ADA, BEN, CLEO]) {
    const user = await usersService.createUser({ ...actor, password: PASSWORD });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await addToProjectAs({
      key: project.identifier,
      actorUserId: mia.id,
      ctx,
      targetUserId: user.id,
      role: 'member',
    });
    await projectsService.setActiveProject({
      userId: user.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });
    ids[actor.email] = user.id;
  }

  // D: in the workspace, never added to the project, and limited to the projects
  // they are added to — so D cannot enter this one.
  const dee = await usersService.createUser({ ...DEE, password: PASSWORD });
  await workspacesService.addMember({ userId: dee.id, workspaceId: workspace.id });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: dee.id, workspaceId: workspace.id } },
    data: { accessScope: 'limited' },
  });
  ids[DEE.email] = dee.id;

  const page = await pagesService.createPageFromMarkdown(ctx, {
    projectId: project.id,
    title: TITLE,
    markdown: BODY,
  });
  return { pageId: page.id, projectId: project.id, ids };
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
const listRead = (page: Page, pageId: string) =>
  respondsTo(page, commentsPath(pageId), 'GET', (q) => q.get('status') === 'open');
const markRead = (page: Page) =>
  page.waitForResponse(
    (r) => /\/api\/notifications\/[^/]+\/read$/.test(r.url()) && r.request().method() === 'PATCH',
  );

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

/** Rows one comment left for one person, counted in the table itself. */
const rowsFor = (recipientUserId: string, commentId: string) =>
  adminDb.notification.count({ where: { recipientUserId, dedupeKey: { contains: commentId } } });

/** The data kind of a person's one row for one comment. */
async function kindFor(recipientUserId: string, commentId: string): Promise<string> {
  const row = await adminDb.notification.findFirstOrThrow({
    where: { recipientUserId, dedupeKey: { contains: commentId } },
  });
  return (row.data as { kind: string }).kind;
}

/** Wait until the fan-in has written `n` rows of one comment for one person. */
async function waitRows(recipientUserId: string, commentId: string, n: number) {
  await expect
    .poll(() => rowsFor(recipientUserId, commentId), {
      timeout: 30_000,
      message: `rows of ${commentId} for ${recipientUserId} → ${n}`,
    })
    .toBe(n);
}

async function unreadCount(page: Page): Promise<number> {
  const res = await page.request.get('/api/notifications/unread-count');
  if (!res.ok()) return -1;
  return ((await res.json()) as { unreadCount: number }).unreadCount;
}

async function waitUnread(page: Page, expected: number) {
  await expect
    .poll(() => unreadCount(page), { timeout: 30_000, message: `unread count → ${expected}` })
    .toBe(expected);
}

/** Emails to `to` whose plain text carries `text`. */
const emailsWith = async (to: string, text: string) =>
  (await emailsTo(to)).filter((e) => e.text.includes(text));

// ── Locators ────────────────────────────────────────────────────────────────

const control = (page: Page) => page.getByRole('button', { name: new RegExp(`^${D.open}(,|$)`) });
const panelOf = (page: Page) => page.getByRole('complementary', { name: D.title, exact: true });
const openList = (panel: Locator) =>
  panel.getByRole('list', { name: D.openThreadsLabel, exact: true });
const threadOf = (scope: Locator, id: string) => scope.getByTestId(`page-thread-${id}`);
const commentOf = (scope: Locator, id: string) => scope.getByTestId(`page-comment-${id}`);
const action = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });
const picker = (page: Page) => page.getByRole('listbox', { name: /^Mention a/ });

const LIVE_BODY = `[aria-label="${en.pages.editor.bodyLabel}"]`;
const liveBody = (page: Page) => page.locator(LIVE_BODY).first();
const commentAction = (page: Page) =>
  page.getByRole('button', { name: I.actionLabel, exact: true });
const composerOf = (page: Page) => page.getByRole('group', { name: I.editorLabel, exact: true });
const washOf = (page: Page, id: string) => page.locator(`[data-wash-ids~="${id}"]`);
const saveIndicator = (page: Page) => page.locator('[role="status"][data-status]').first();

const bell = (page: Page) => page.getByRole('button', { name: new RegExp(`^${N.title},`) });
const drawerOf = (page: Page) => page.getByRole('dialog', { name: N.title, exact: true });
/** The drawer's link rows that point at `pageId`. */
const pageRows = (drawer: Locator, pageId: string) => drawer.locator(`a[href^="/pages/${pageId}"]`);

// ── Selections on the live body ─────────────────────────────────────────────

interface Span {
  readonly start: string;
  readonly startAt?: number;
  readonly end?: string;
  readonly endAt?: number;
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
      const endText = s.end ?? s.start;
      const endFrom = s.end === undefined ? from : full.indexOf(endText);
      if (endFrom < 0) throw new Error(`the body holds no "${endText}"`);
      const range = document.createRange();
      range.setStart(...at(from + (s.startAt ?? 0), false));
      range.setEnd(...at(endFrom + (s.endAt ?? endText.length), true));
      if (root.isContentEditable) root.focus();
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    },
    [LIVE_BODY, span] as const,
  );
}

// ── Actions ─────────────────────────────────────────────────────────────────

/** Sign `actor` in on the recorded page and open the page's bare address. */
async function as(page: Page, actor: Actor, pageId: string) {
  await signIn(page, actor.email, PASSWORD);
  await page.goto(`/pages/${pageId}`);
  await expect(control(page)).toBeVisible();
  await expect(liveBody(page)).toBeVisible();
}

async function openPanel(page: Page, pageId: string): Promise<Locator> {
  const read = listRead(page, pageId);
  await control(page).click();
  await answered(read, 200);
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  return panel;
}

/** Type `@<first name>` at the caret and pick `actor` from the picker. */
async function mention(page: Page, actor: Actor) {
  await page.keyboard.type(`@${actor.name.split(' ')[0]}`);
  await expect(picker(page)).toBeVisible();
  await picker(page)
    .getByRole('option', { name: new RegExp(escape(actor.name)) })
    .click();
  await expect(picker(page)).toHaveCount(0);
}

/** Reply to a thread; the composer's seeded mention of the starter is cleared first. */
async function reply(
  page: Page,
  pageId: string,
  rootId: string,
  write: () => Promise<void>,
): Promise<PageCommentDto> {
  const row = threadOf(openList(panelOf(page)), rootId);
  await action(commentOf(row, rootId), C.reply).click();
  const box = row.getByRole('textbox', { name: C.replyLabel, exact: true });
  await box.click();
  // The reply box opens with the starter already mentioned (see the header);
  // every reply here says exactly whom it names, so the seed goes first.
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await write();
  const replied = respondsTo(page, `${commentsPath(pageId)}/${rootId}/replies`, 'POST');
  // Two buttons read "Reply" while composing: the root's, then the composer's submit.
  await action(row, C.reply).last().click();
  const posted = await answered<PageCommentDto>(replied, 201);
  expect(posted.parentCommentId).toBe(rootId);
  return posted;
}

/** Open the comment's editor, write at its end, save; the PATCH's answer. */
async function editAtEnd(
  page: Page,
  pageId: string,
  commentId: string,
  write: () => Promise<void>,
): Promise<PageCommentDto> {
  const comment = commentOf(panelOf(page), commentId);
  await action(comment, C.edit).click();
  const box = comment.getByRole('textbox', { name: C.editLabel, exact: true });
  await box.click();
  await page.keyboard.press('ControlOrMeta+End');
  await write();
  const edited = respondsTo(page, `${commentsPath(pageId)}/${commentId}`, 'PATCH');
  await action(comment, C.save).click();
  return answered<PageCommentDto>(edited, 200);
}

/** Post a page-level comment written by `write`; the thread the POST answered. */
async function pageComment(
  page: Page,
  pageId: string,
  write: () => Promise<void>,
): Promise<PageCommentThreadDto> {
  const panel = panelOf(page);
  await action(panel, C.addPlaceholder).click();
  await panel.getByRole('textbox', { name: D.composerLabel, exact: true }).click();
  await write();
  const posted = respondsTo(page, commentsPath(pageId), 'POST');
  await action(panel, D.comment).click();
  const thread = await answered<PageCommentThreadDto>(posted, 201);
  expect(thread.anchor).toBeNull();
  return thread;
}

async function openDrawer(page: Page): Promise<Locator> {
  await bell(page).click();
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();
  return drawer;
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('A page comment that mentions a teammate, or replies in their thread, notifies them in-app and by email and opens the page at that thread: the recipe, steps 1 to 9', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-10868');
  const s = await seed();
  const id = (a: Actor) => s.ids[a.email]!;
  const threadAddress = (rootId: string) => `/pages/${s.pageId}?thread=${rootId}`;
  let rootId = '';
  let pageLevelId = '';

  await chapter(
    'Step 1 · Ada comments on a sentence mentioning Ben — the picker never offers Dee — and comments on the page',
    async () => {
      await as(page, ADA, s.pageId);
      // From the end of the heading to the start of the paragraph: only a break.
      await select(page, { start: 'Launch', startAt: 'Launch'.length, end: PASSAGE, endAt: 0 });
      await settled(page);
      await expect(commentAction(page)).toHaveCount(0);
      await beat();

      await select(page, { start: PASSAGE });
      await expect(commentAction(page)).toBeVisible();
      await commentAction(page).click();
      const composer = composerOf(page);
      await expect(composer).toBeVisible();
      await expect(
        composer.getByRole('textbox', { name: I.editorLabel, exact: true }),
      ).toBeFocused();

      // The picker opens and offers a member — so the absence below is its exclusion.
      await page.keyboard.type('@Ben');
      await expect(picker(page)).toBeVisible();
      await expect(
        picker(page).getByRole('option', { name: new RegExp(escape(BEN.name)) }),
      ).toBeVisible();
      for (let i = 0; i < '@Ben'.length; i += 1) await page.keyboard.press('Backspace');
      await page.keyboard.type('@Dee');
      await settled(page);
      await expect(page.getByRole('option', { name: new RegExp(escape(DEE.name)) })).toHaveCount(0);
      for (let i = 0; i < '@Dee'.length; i += 1) await page.keyboard.press('Backspace');
      await beat();

      await mention(page, BEN);
      await page.keyboard.type(INLINE_TAIL, { delay: 30 });
      const posted = respondsTo(page, commentsPath(s.pageId), 'POST');
      await action(composer, D.comment).click();
      const thread = await answered<PageCommentThreadDto>(posted, 201);
      expect(thread.anchor).not.toBeNull();
      expect(thread.bodyMd).toContain(`(mention:${id(BEN)})`);
      expect(thread.bodyMd).not.toContain(id(DEE));
      rootId = thread.id;
      await expect(washOf(page, rootId).first()).toBeVisible();
      await beat();

      await openPanel(page, s.pageId);
      const pageLevel = await pageComment(page, s.pageId, () =>
        page.keyboard.type(PAGE_LEVEL, { delay: 30 }),
      );
      pageLevelId = pageLevel.id;
      expect(await unreadCount(page)).toBe(0);
    },
  );
  await beat();

  await chapter(
    'Step 2 · Ben’s bell and inbox each hold one mention, with the sentence and the thread address',
    async () => {
      await as(page, BEN, s.pageId);
      await waitUnread(page, 1);
      // The positive landed; Ada, who wrote both comments, holds nothing.
      expect(await adminDb.notification.count({ where: { recipientUserId: id(ADA) } })).toBe(0);
      await expect(bell(page)).toHaveAccessibleName(bellName(1));

      const drawer = await openDrawer(page);
      const rows = drawer.getByRole('link');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toHaveAccessibleName(
        new RegExp(`^${escape(mentionSentence(ADA))}`),
      );
      await expect(rows.first()).toContainText(INLINE_TAIL);
      await expect(rows.first()).toHaveAttribute('href', threadAddress(rootId));
      await beat();

      const mail = await waitForEmail(BEN.email, { timeoutMs: 30_000 });
      expect(mail.subject).toBe(fill(E.subjectMention, { author: ADA.name, page: TITLE }));
      expect(mail.text).toContain(threadAddress(rootId));
      expect(await emailsTo(BEN.email)).toHaveLength(1);
    },
  );
  await beat();

  await chapter(
    'Step 3 · Ben opens the row: the page opens at the thread with the passage emphasised, and the row is read',
    async () => {
      const drawer = drawerOf(page);
      const row = drawer.getByRole('link').first();
      const read = markRead(page);
      const arrived = listRead(page, s.pageId);
      await row.click();
      expect((await read).status()).toBe(200);
      await answered(arrived, 200);
      await page.waitForURL((u) => `${u.pathname}${u.search}` === threadAddress(rootId));
      const panel = panelOf(page);
      await expect(threadOf(openList(panel), rootId)).toHaveAttribute(
        'data-thread-arrived',
        'true',
      );
      await expect(washOf(page, rootId).first()).toHaveAttribute('data-wash-state', 'emphasis');
      await expect(washOf(page, rootId).first()).toBeInViewport();
      await waitUnread(page, 0);
      await beat();

      // The same address in a fresh load lands the same way.
      const again = listRead(page, s.pageId);
      await page.goto(threadAddress(rootId));
      await answered(again, 200);
      await expect(threadOf(openList(panelOf(page)), rootId)).toHaveAttribute(
        'data-thread-arrived',
        'true',
      );
      await expect(washOf(page, rootId).first()).toHaveAttribute('data-wash-state', 'emphasis');
      await expect(washOf(page, rootId).first()).toBeInViewport();
    },
  );
  await beat();

  await chapter(
    'Step 4 · Ben replies naming nobody, and Ada gets the reply sentence — not a mention',
    async () => {
      const posted = await reply(page, s.pageId, rootId, () =>
        page.keyboard.type(BEN_REPLY, { delay: 30 }),
      );
      expect(posted.bodyMd).not.toContain('mention:');
      await waitRows(id(ADA), posted.id, 1);
      expect(await kindFor(id(ADA), posted.id)).toBe('page_replied');
      expect(await unreadCount(page)).toBe(0);
      await beat();

      await as(page, ADA, s.pageId);
      await waitUnread(page, 1);
      const drawer = await openDrawer(page);
      const row = drawer.getByRole('link').filter({ hasText: BEN_REPLY });
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAccessibleName(new RegExp(`^${escape(replySentence(BEN))}`));
      await expect(row).not.toHaveAccessibleName(new RegExp(`^${escape(mentionSentence(BEN))}`));
      await expect(row).not.toHaveAccessibleName(new RegExp(`^${escape(N.actorFallback)}`));
      await expect(row).toHaveAttribute('href', threadAddress(rootId));
    },
  );
  await beat();

  await chapter(
    'Step 5 · Cleo replies mentioning Ada: Ada gets a mention, Ben a reply, Cleo nothing',
    async () => {
      await as(page, CLEO, s.pageId);
      await openPanel(page, s.pageId);
      // The seed is cleared and Ada picked through the picker, so the mention is Cleo's.
      const posted = await reply(page, s.pageId, rootId, async () => {
        await mention(page, ADA);
        await page.keyboard.type(CLEO_TAIL, { delay: 30 });
      });
      expect(posted.bodyMd).toContain(`(mention:${id(ADA)})`);
      await waitRows(id(ADA), posted.id, 1);
      await waitRows(id(BEN), posted.id, 1);
      expect(await kindFor(id(ADA), posted.id)).toBe('page_mentioned');
      expect(await kindFor(id(BEN), posted.id)).toBe('page_replied');
      expect(await rowsFor(id(CLEO), posted.id)).toBe(0);
      await beat();

      await as(page, ADA, s.pageId);
      const drawer = await openDrawer(page);
      await expect(drawer.getByRole('link').filter({ hasText: CLEO_TAIL })).toHaveAccessibleName(
        new RegExp(`^${escape(mentionSentence(CLEO))}`),
      );
    },
  );
  await beat();

  let step6Counts: Record<string, number> = {};
  await chapter(
    'Step 6 · Ada edits her page comment to mention Cleo, then changes only a word',
    async () => {
      await page.goto(`/pages/${s.pageId}`);
      await openPanel(page, s.pageId);
      const before = await adminDb.notification.count({
        where: { dedupeKey: { contains: pageLevelId } },
      });
      expect(before).toBe(0);
      const first = await editAtEnd(page, s.pageId, pageLevelId, async () => {
        await page.keyboard.type(' ');
        await mention(page, CLEO);
      });
      expect(first.bodyMd).toContain(`(mention:${id(CLEO)})`);
      await waitRows(id(CLEO), pageLevelId, 1);
      expect(await kindFor(id(CLEO), pageLevelId)).toBe('page_mentioned');
      expect(
        await adminDb.notification.count({ where: { dedupeKey: { contains: pageLevelId } } }),
      ).toBe(1);
      await beat();

      await editAtEnd(page, s.pageId, pageLevelId, () =>
        page.keyboard.type(WORD_EDIT, { delay: 30 }),
      );
      step6Counts = Object.fromEntries(
        await Promise.all(
          [ADA, BEN, CLEO].map(async (a) => [a.email, await rowsFor(id(a), pageLevelId)] as const),
        ),
      );
      expect(step6Counts).toEqual({ [ADA.email]: 0, [BEN.email]: 0, [CLEO.email]: 1 });
    },
  );
  await beat();

  await chapter(
    'Step 7 · Ben switches off email for mentions; the next mention reaches his bell and not his inbox',
    async () => {
      await signIn(page, BEN.email, PASSWORD);
      await page.goto('/settings/account/notifications');
      await expect(page.getByRole('heading', { name: S.heading, exact: true })).toBeVisible();
      const email = page.getByRole('switch', {
        name: fill(S.cellAria, { channel: S.columns.email, event: S.events.mentioned.label }),
        exact: true,
      });
      await expect(email).toBeChecked();
      const saved = page.waitForResponse(
        (r) => r.url().includes('/api/notification-preferences') && r.request().method() === 'PUT',
      );
      await email.click();
      expect((await saved).status()).toBe(200);
      await expect(email).not.toBeChecked();
      await beat();

      // Cleo is named too: her email is the positive that the send job ran.
      await as(page, ADA, s.pageId);
      await openPanel(page, s.pageId);
      const thread = await pageComment(page, s.pageId, async () => {
        await mention(page, BEN);
        await page.keyboard.type(' ');
        await mention(page, CLEO);
        await page.keyboard.type(STEP7_TAIL, { delay: 30 });
      });
      await waitRows(id(BEN), thread.id, 1);
      await expect
        .poll(async () => (await emailsWith(CLEO.email, STEP7_TAIL)).length, { timeout: 30_000 })
        .toBe(1);
      expect(await emailsWith(BEN.email, STEP7_TAIL)).toHaveLength(0);
      // And Step 6's word-only edit left every count where it was, read after this
      // step's events had both been processed.
      for (const a of [ADA, BEN, CLEO]) {
        expect(await rowsFor(id(a), pageLevelId)).toBe(step6Counts[a.email]);
      }
    },
  );
  await beat();

  await chapter(
    'Step 8 · Ada deletes the commented sentence and replies mentioning Ben; his row opens a page-level thread with its quote',
    async () => {
      await page.goto(`/pages/${s.pageId}`);
      await expect(liveBody(page)).toBeVisible();
      await select(page, { start: PASSAGE });
      const savedBody = respondsTo(page, `/api/pages/${s.pageId}/updates`, 'POST');
      await page.keyboard.press('Backspace');
      expect((await savedBody).status()).toBe(200);
      await expect(saveIndicator(page)).toHaveAttribute('data-status', 'saved');
      await expect(washOf(page, rootId)).toHaveCount(0);

      const panel = await openPanel(page, s.pageId);
      await expect(threadOf(openList(panel), rootId)).toHaveAttribute('data-thread-anchor', 'gone');
      const posted = await reply(page, s.pageId, rootId, async () => {
        await mention(page, BEN);
        await page.keyboard.type(STEP8_TAIL, { delay: 30 });
      });
      await waitRows(id(BEN), posted.id, 1);
      expect(await kindFor(id(BEN), posted.id)).toBe('page_mentioned');
      await beat();

      await as(page, BEN, s.pageId);
      const drawer = await openDrawer(page);
      const row = drawer.getByRole('link').filter({ hasText: STEP8_TAIL });
      await expect(row).toHaveAccessibleName(new RegExp(`^${escape(mentionSentence(ADA))}`));
      await expect(row).toHaveAttribute('href', threadAddress(rootId));
      const arrived = listRead(page, s.pageId);
      await row.click();
      await answered(arrived, 200);
      await page.waitForURL((u) => `${u.pathname}${u.search}` === threadAddress(rootId));
      const thread = threadOf(openList(panelOf(page)), rootId);
      await expect(thread).toHaveAttribute('data-thread-arrived', 'true');
      await expect(thread).toHaveAttribute('data-thread-anchor', 'gone');
      await expect(thread.getByTestId('page-thread-gone-note')).toHaveText(I.gone);
      await expect(thread.getByTestId('page-thread-quote')).toHaveText(PASSAGE);
      await expect(page.locator('[data-wash-state="emphasis"]')).toHaveCount(0);
    },
  );
  await beat();

  await chapter(
    'Step 9 · Mia archives the page and deletes it; its notifications go with it',
    async () => {
      expect(await adminDb.notification.count({ where: { pageId: s.pageId } })).toBeGreaterThan(0);
      await signIn(page, MIA.email, PASSWORD);
      await page.goto('/pages');
      await page
        .getByRole('button', { name: fill(AR.pageActions, { title: TITLE }), exact: true })
        .click();
      const archiving = respondsTo(page, `/api/pages/${s.pageId}/archive`, 'POST');
      await page.getByRole('menuitem', { name: AR.menuItem, exact: true }).click();
      expect((await archiving).status()).toBe(200);
      await beat();

      await page.getByRole('link', { name: AR.list.link, exact: true }).click();
      await page.waitForURL((u) => u.pathname === '/pages/archived');
      await page
        .getByRole('table', { name: AR.list.title, exact: true })
        .getByRole('link', { name: TITLE, exact: true })
        .click();
      await page.waitForURL((u) => u.pathname === `/pages/${s.pageId}`);
      const banner = page.getByRole('status', { name: AR.banner.title, exact: true });
      await expect(banner).toBeVisible();
      await banner.getByRole('button', { name: AR.delete.menuItem, exact: true }).click();
      const dialog = page.getByRole('alertdialog', {
        name: fill(AR.delete.title, { title: TITLE }),
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await beat();
      const deleting = respondsTo(page, `/api/pages/${s.pageId}`, 'DELETE');
      await action(dialog, AR.delete.actionOne).click();
      expect((await deleting).status()).toBe(200);
      await page.waitForURL((u) => u.pathname === '/pages');
      expect(await adminDb.notification.count({ where: { pageId: s.pageId } })).toBe(0);
      await beat();

      await signIn(page, BEN.email, PASSWORD);
      await page.goto('/pages');
      const drawer = await openDrawer(page);
      await expect(pageRows(drawer, s.pageId)).toHaveCount(0);
      await expect(drawer.getByText(N.empty.title, { exact: true })).toBeVisible();
      const res = await page.goto(`/pages/${s.pageId}`);
      expect(res?.status()).toBe(404);
    },
  );
  await beat();
});
