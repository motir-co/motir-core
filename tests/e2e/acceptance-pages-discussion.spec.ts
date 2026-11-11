// Acceptance E2E — discuss a page as a whole (Story MOTIR-10866 · MOTIR-10876).
// The story's verification recipe, steps 1 to 9, in a real browser against the
// SERVED app: the empty Discussion panel, a comment with its author and time, a
// reply that has no Reply of its own, a mention picked from the picker and drawn
// as a chip, an edit with its Edited marker that another member cannot touch,
// resolve and reopen across a fresh load, a viewer's read-only panel, a delete, and
// an archived page whose discussion is read-only until a manager deletes the
// page and its comments with it. One test, one chapter per recipe step, named
// `Step 1` to `Step 9`.
//
// ── THE ACTORS ──────────────────────────────────────────────────────────────
// Members A (Ada) and B (Ben), viewer V (Vic) and manager M (Mia, the project's
// creator, who holds `page:delete`), seeded through the real services. Every
// actor signs in on the ONE recorded page: the acceptance lane publishes one
// video per test (the uploader takes the first `.webm` of the test's output
// directory), so a step driven in a second browser context would be missing
// from the receipt a person watches. A switch drops the session
// (`startSignedOut`, inside `signIn`), signs the next actor in and loads the
// page from the server, so B sees A's writes only through the server, never
// through client state A left behind.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every write — post, reply, edit, delete, resolve, reopen, archive and the
// permanent delete — arms `waitForResponse` on its route path and method
// BEFORE the click that sends it, and its status and body are asserted before
// anything else is. Opening the panel arms the list read
// (`GET …/comments?status=open`), and the first look at Resolved in a mounted
// panel arms `status=resolved`: the panel reads each list once per mount and
// then keeps it in step from the writes' answers. There is no sleep; the only
// holds are the recording's `chapter()` and `beat()` pacing.
//
// ── THE STRINGS ─────────────────────────────────────────────────────────────
// Every label matched is read from `messages/en.json` (`pages.discussion`, the
// `comments` namespace the composers keep, and `pages.archive`), never retyped.
// Locators are by role and accessible name, scoped to the Discussion panel
// (`complementary`, named by its heading). A thread is found by the id its
// write answered, because two of A's threads share the accessible name
// "Thread started by Ada Lovell".
//
// This repository's acceptance lane publishes the receipt on a green run; no MCP
// publish is made. CI is this spec's first run: the lane's `next build` cannot
// run in the cloud thread that wrote it.

import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { markProjectOnboarded } from './_helpers/ai-augment-replan-seed';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { PageCommentDto, PageCommentThreadDto } from '@/lib/pages';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 420_000 });

const PASSWORD = 'pages-discussion-e2e-pass-123';
const ADA = { email: 'discussion-ada@example.com', name: 'Ada Lovell' };
const BEN = { email: 'discussion-ben@example.com', name: 'Ben Okafor' };
const VIC = { email: 'discussion-vic@example.com', name: 'Vic Viewer' };
const MIA = { email: 'discussion-mia@example.com', name: 'Mia Manager' };
type Actor = typeof ADA;

const TITLE = 'Release checklist';
const BODY = [
  '## First section',
  '',
  'Freeze the branch on Monday.',
  '',
  '## Second section',
  '',
  'Ship the notes on Thursday.',
].join('\n');

// The recipe's own text.
const QUESTION = 'Is the second section still current?';
const ANSWER = 'Yes, updated yesterday';
const EDITED = 'Is the second section still current after the launch?';
const MENTION_TAIL = 'can you confirm the dates?';

const D = en.pages.discussion;
const C = en.comments;
const AR = en.pages.archive;
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');
/** The `{count, plural, one {…} other {…}}` messages this spec reads, in English. */
const plural = (template: string, count: number) => {
  const m = /^\{count, plural, one \{([^}]*)\} other \{([^}]*)\}\}$/.exec(template);
  if (!m) throw new Error(`not a count plural: ${template}`);
  return (count === 1 ? m[1]! : m[2]!).replace('#', String(count));
};

// ── Seed ────────────────────────────────────────────────────────────────────

interface Seed {
  pageId: string;
  benId: string;
}

async function seed(): Promise<Seed> {
  const mia = await usersService.createUser({ ...MIA, password: PASSWORD });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Discussion Workspace',
    ownerUserId: mia.id,
  });
  const ctx = { userId: mia.id, workspaceId: workspace.id };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: mia.id,
    name: 'Release train',
    identifier: 'PDS',
  });
  await markProjectOnboarded(project.id);
  await projectsService.setActiveProject({ ...ctx, projectId: project.id });

  const ids: Record<string, string> = {};
  for (const [actor, role] of [
    [ADA, 'member'],
    [BEN, 'member'],
    [VIC, 'viewer'],
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
    ids[actor.email] = user.id;
  }

  const page = await pagesService.createPageFromMarkdown(ctx, {
    projectId: project.id,
    title: TITLE,
    markdown: BODY,
  });
  return { pageId: page.id, benId: ids[BEN.email]! };
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

/** Await an armed write: assert its status, hand back its parsed body. */
async function answered<T>(pending: Promise<Response>, status: number): Promise<T> {
  const res = await pending;
  expect(res.status(), `${res.request().method()} ${new URL(res.url()).pathname}`).toBe(status);
  return (await res.json()) as T;
}

// ── Locators ────────────────────────────────────────────────────────────────

const control = (page: Page) => page.getByRole('button', { name: new RegExp(`^${D.open}(,|$)`) });
const panelOf = (page: Page) => page.getByRole('complementary', { name: D.title, exact: true });
const switchOf = (panel: Locator, label: string) =>
  panel
    .getByRole('group', { name: D.switchLabel, exact: true })
    .getByRole('button', { name: new RegExp(`^${label}`) });
const openList = (panel: Locator) =>
  panel.getByRole('list', { name: D.openThreadsLabel, exact: true });
/** A switch option reads its label, then its count. */
const counted = (label: string, count: number) => new RegExp(`^${label}\\s*${count}$`);
const resolvedList = (panel: Locator) =>
  panel.getByRole('list', { name: D.resolvedThreadsLabel, exact: true });
const threadOf = (scope: Locator, id: string) => scope.getByTestId(`page-thread-${id}`);
const commentOf = (scope: Locator, id: string) => scope.getByTestId(`page-comment-${id}`);
const action = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });

/** Sign `actor` in on the recorded page and open the page from the server. */
async function as(page: Page, actor: Actor, pageId: string) {
  await signIn(page, actor.email, PASSWORD);
  await page.goto(`/pages/${pageId}`);
  await expect(control(page)).toBeVisible();
}

/** Open the Discussion panel and wait for its open list's read. */
async function openPanel(page: Page, pageId: string): Promise<Locator> {
  const read = listRead(page, pageId, 'open');
  await control(page).click();
  await answered(read, 200);
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  return panel;
}

/** Write `text` into the page composer (opened from its rest invitation). */
async function typeComment(panel: Locator, text: string) {
  await action(panel, C.addPlaceholder).click();
  const box = panel.getByRole('textbox', { name: D.composerLabel, exact: true });
  await box.click();
  await box.pressSequentially(text);
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('Members discuss a page as a whole, a viewer reads it, and it goes with the page: the recipe, steps 1 to 9', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-10866');
  const s = await seed();
  const path = commentsPath(s.pageId);
  let rootId = '';
  let mentionId = '';

  await chapter('Step 1 · Ada opens the Discussion panel on a page with no comments', async () => {
    await as(page, ADA, s.pageId);
    await expect(control(page)).toHaveAccessibleName(D.open);
    await expect(page.getByTestId('page-discussion-count')).toHaveCount(0);
    const panel = await openPanel(page, s.pageId);
    await expect(panel.getByText(D.emptyTitle, { exact: true })).toBeVisible();
    await expect(panel.getByText(D.emptyBody, { exact: true })).toBeVisible();
    await expect(control(page)).toHaveAttribute('aria-expanded', 'true');
  });
  await beat();

  await chapter('Step 2 · Ada asks a question, which lists with her name and a time', async () => {
    const panel = panelOf(page);
    await typeComment(panel, QUESTION);
    const posted = respondsTo(page, path, 'POST');
    await action(panel, D.comment).click();
    const thread = await answered<PageCommentThreadDto>(posted, 201);
    expect(thread.bodyMd).toBe(QUESTION);
    rootId = thread.id;

    const row = threadOf(openList(panel), rootId);
    await expect(row).toHaveAccessibleName(fill(D.threadLabel, { name: ADA.name }));
    const root = commentOf(row, rootId);
    await expect(root).toContainText(ADA.name);
    await expect(root).toContainText(QUESTION);
    await expect(root.locator('time')).toHaveAttribute('datetime', thread.createdAt);
    await expect(control(page)).toHaveAccessibleName(`${D.open}, ${plural(D.openCount, 1)}`);
    await expect(switchOf(panel, D.listOpen)).toHaveText(counted(D.listOpen, 1));
  });
  await beat();

  await chapter('Step 3 · Ben replies, and the reply has no Reply of its own', async () => {
    await as(page, BEN, s.pageId);
    const panel = await openPanel(page, s.pageId);
    const row = threadOf(openList(panel), rootId);
    await action(commentOf(row, rootId), C.reply).click();
    // The reply composer opens with Ada pre-mentioned; Ben's words follow it.
    const box = row.getByRole('textbox', { name: C.replyLabel, exact: true });
    await box.click();
    await page.keyboard.press('End');
    await box.pressSequentially(ANSWER);
    await beat();

    const replied = respondsTo(page, `${path}/${rootId}/replies`, 'POST');
    // Two buttons read "Reply" while composing: the root's action, then the
    // composer's submit at the foot of the rail.
    await action(row, C.reply).last().click();
    const reply = await answered<PageCommentDto>(replied, 201);
    expect(reply.parentCommentId).toBe(rootId);
    expect(reply.bodyMd).toContain(ANSWER);

    const replies = row.getByRole('list', { name: C.repliesAria, exact: true });
    const item = commentOf(replies, reply.id);
    await expect(item).toContainText(BEN.name);
    await expect(item).toContainText(ANSWER);
    await expect(action(replies, C.reply)).toHaveCount(0);
    await expect(action(commentOf(row, rootId), C.reply)).toBeVisible();
  });
  await beat();

  await chapter(
    'Step 4 · Ada mentions Ben from the picker, and the mention is a chip',
    async () => {
      await as(page, ADA, s.pageId);
      const panel = await openPanel(page, s.pageId);
      await typeComment(panel, '@Ben');
      const picker = page.getByRole('listbox', { name: /^Mention a/ });
      await expect(picker).toBeVisible();
      await picker.getByRole('option', { name: new RegExp(BEN.name) }).click();
      await page.keyboard.type(MENTION_TAIL);
      await beat();

      const posted = respondsTo(page, path, 'POST');
      await action(panel, D.comment).click();
      const res = await posted;
      expect(res.status()).toBe(201);
      const token = `[@${BEN.name}](mention:${s.benId})`;
      const sent = res.request().postDataJSON() as { bodyMd: string };
      expect(sent.bodyMd).toContain(token);
      const thread = (await res.json()) as PageCommentThreadDto;
      expect(thread.bodyMd).toContain(token);
      mentionId = thread.id;

      const row = threadOf(openList(panel), mentionId);
      await expect(row.locator('.mention-chip', { hasText: `@${BEN.name}` })).toBeVisible();
      await expect(row).toContainText(MENTION_TAIL);
      await expect(control(page)).toHaveAccessibleName(`${D.open}, ${plural(D.openCount, 2)}`);
    },
  );
  await beat();

  await chapter('Step 5 · Ada edits her question; Ben cannot edit or delete it', async () => {
    const panel = panelOf(page);
    const root = commentOf(threadOf(openList(panel), rootId), rootId);
    await action(root, C.edit).click();
    const box = root.getByRole('textbox', { name: C.editLabel, exact: true });
    await box.click();
    await page.keyboard.press('ControlOrMeta+A');
    await box.pressSequentially(EDITED);
    const edited = respondsTo(page, `${path}/${rootId}`, 'PATCH');
    await action(root, C.save).click();
    const comment = await answered<PageCommentDto>(edited, 200);
    expect(comment.bodyMd).toBe(EDITED);
    expect(comment.editedAt).not.toBeNull();
    await expect(root).toContainText(EDITED);
    await expect(root.getByText(C.edited, { exact: true })).toBeVisible();
    await beat();

    await as(page, BEN, s.pageId);
    const bens = await openPanel(page, s.pageId);
    const seen = commentOf(threadOf(openList(bens), rootId), rootId);
    await expect(seen).toContainText(EDITED);
    await expect(seen.getByText(C.edited, { exact: true })).toBeVisible();
    await expect(action(seen, C.reply)).toBeVisible();
    await expect(action(seen, C.edit)).toHaveCount(0);
    await expect(action(seen, C.delete)).toHaveCount(0);
  });
  await beat();

  await chapter(
    'Step 6 · Ben resolves the thread, it stays resolved, and he reopens it',
    async () => {
      let panel = panelOf(page);
      const resolvedPrefix = fill(D.resolvedBy, { name: BEN.name, time: '' }).trim();
      const resolving = respondsTo(page, `${path}/${rootId}/resolution`, 'POST');
      await action(threadOf(openList(panel), rootId), D.resolve).click();
      const resolved = await answered<PageCommentThreadDto>(resolving, 200);
      expect(resolved.resolvedBy?.name).toBe(BEN.name);
      expect(resolved.resolvedAt).not.toBeNull();
      await expect(threadOf(openList(panel), rootId)).toHaveCount(0);
      await expect(control(page)).toHaveAccessibleName(`${D.open}, ${plural(D.openCount, 1)}`);
      await expect(switchOf(panel, D.listOpen)).toHaveText(counted(D.listOpen, 1));

      let read = listRead(page, s.pageId, 'resolved');
      await switchOf(panel, D.listResolved).click();
      await answered(read, 200);
      let row = threadOf(resolvedList(panel), rootId);
      await expect(row).toContainText(resolvedPrefix);
      await expect(switchOf(panel, D.listResolved)).toHaveText(counted(D.listResolved, 1));
      await beat();

      // A fresh load reads both lists from the server again. The page's bare
      // address, not a reload: focusing a thread names it in the address
      // (`?thread=`, MOTIR-10902), and loading that link opens the panel at it.
      await page.goto(`/pages/${s.pageId}`);
      await expect(control(page)).toBeVisible();
      panel = await openPanel(page, s.pageId);
      await expect(threadOf(openList(panel), rootId)).toHaveCount(0);
      read = listRead(page, s.pageId, 'resolved');
      await switchOf(panel, D.listResolved).click();
      const after = await answered<{ threads: PageCommentThreadDto[] }>(read, 200);
      expect(after.threads.map((t) => t.id)).toEqual([rootId]);
      row = threadOf(resolvedList(panel), rootId);
      await expect(row).toContainText(resolvedPrefix);
      await expect(row.locator('span[title]').first()).toBeVisible();
      await beat();

      const reopening = respondsTo(page, `${path}/${rootId}/resolution`, 'DELETE');
      await action(row, D.reopen).click();
      const reopened = await answered<PageCommentThreadDto>(reopening, 200);
      expect(reopened.resolvedAt).toBeNull();
      expect(reopened.resolvedBy).toBeNull();
      await expect(threadOf(resolvedList(panel), rootId)).toHaveCount(0);
      await expect(panel.getByText(D.emptyResolvedTitle, { exact: true })).toBeVisible();
      await expect(switchOf(panel, D.listResolved)).toHaveText(counted(D.listResolved, 0));
      await switchOf(panel, D.listOpen).click();
      await expect(threadOf(openList(panel), rootId)).toBeVisible();
      await expect(switchOf(panel, D.listOpen)).toHaveText(counted(D.listOpen, 2));
      await expect(control(page)).toHaveAccessibleName(`${D.open}, ${plural(D.openCount, 2)}`);
    },
  );
  await beat();

  await chapter('Step 7 · Vic, a viewer, reads every thread and can write nothing', async () => {
    await as(page, VIC, s.pageId);
    const panel = await openPanel(page, s.pageId);
    await expect(panel.getByText(D.readOnlyViewer, { exact: true })).toBeVisible();
    await expect(threadOf(openList(panel), rootId)).toContainText(EDITED);
    await expect(threadOf(openList(panel), mentionId)).toContainText(MENTION_TAIL);
    await expect(openList(panel)).toContainText(ANSWER);
    const writes = [C.addPlaceholder, C.reply, C.edit, C.delete, D.resolve, D.reopen];
    for (const name of writes) await expect(action(panel, name)).toHaveCount(0);
    await expect(panel.getByRole('textbox')).toHaveCount(0);
    await beat();

    const read = listRead(page, s.pageId, 'resolved');
    await switchOf(panel, D.listResolved).click();
    await answered(read, 200);
    await expect(panel.getByText(D.emptyResolvedTitle, { exact: true })).toBeVisible();
    for (const name of writes) await expect(action(panel, name)).toHaveCount(0);
  });
  await beat();

  await chapter('Step 8 · Ada deletes her mention, and it stays deleted', async () => {
    await as(page, ADA, s.pageId);
    let panel = await openPanel(page, s.pageId);
    const comment = commentOf(threadOf(openList(panel), mentionId), mentionId);
    await action(comment, C.delete).click();
    const confirm = page.getByRole('dialog').filter({ hasText: C.deleteConfirm });
    await expect(confirm).toBeVisible();
    await beat();
    const deleting = respondsTo(page, `${path}/${mentionId}`, 'DELETE');
    await action(confirm, C.delete).click();
    await answered(deleting, 200);
    await expect(threadOf(openList(panel), mentionId)).toHaveCount(0);
    await expect(control(page)).toHaveAccessibleName(`${D.open}, ${plural(D.openCount, 1)}`);

    // The bare address, for the reason Step 6 gives.
    await page.goto(`/pages/${s.pageId}`);
    await expect(control(page)).toBeVisible();
    panel = await openPanel(page, s.pageId);
    await expect(threadOf(openList(panel), rootId)).toBeVisible();
    await expect(threadOf(openList(panel), mentionId)).toHaveCount(0);
  });
  await beat();

  await chapter(
    'Step 9 · Mia archives the page, its discussion turns read-only, and deleting the page takes its comments',
    async () => {
      await signIn(page, MIA.email, PASSWORD);
      await page.goto('/pages');
      await page
        .getByRole('button', { name: fill(AR.pageActions, { title: TITLE }), exact: true })
        .click();
      // A page with no sub-pages archives at once, with no confirm.
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

      const panel = await openPanel(page, s.pageId);
      await expect(panel.getByText(D.readOnlyArchived, { exact: true })).toBeVisible();
      await expect(threadOf(openList(panel), rootId)).toContainText(EDITED);
      await expect(openList(panel)).toContainText(ANSWER);
      for (const name of [C.addPlaceholder, C.reply, C.edit, C.delete, D.resolve, D.reopen]) {
        await expect(action(panel, name)).toHaveCount(0);
      }
      await beat();

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

      await page.getByRole('link', { name: AR.list.link, exact: true }).click();
      await page.waitForURL((u) => u.pathname === '/pages/archived');
      await expect(page.getByRole('heading', { name: AR.list.empty.title })).toBeVisible();
      const res = await page.goto(`/pages/${s.pageId}`);
      expect(res?.status()).toBe(404);
      expect(await adminDb.pageComment.count({ where: { pageId: s.pageId } })).toBe(0);
    },
  );
  await beat();
});
