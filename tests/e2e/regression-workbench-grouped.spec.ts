import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { LANDED_WORKBENCH_URL } from './_helpers/workbench-landing';
import { workItemsService } from '@/lib/services/workItemsService';
import { watchersService } from '@/lib/services/watchersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// THE ACCEPTANCE RECEIPT FOR THE GROUPED WORKBENCH (Story MOTIR-8012 · MOTIR-8018;
// `design/workbench/workbench--grouped.mock.html`, design § 36).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A member opens their Workbench and their work is listed under the story, task or bug it
// belongs to, the way `/ready` lists it: In progress reads "Per-key API quotas — 3" and
// "Audit log export — 1" instead of four subtasks with nothing to say whose they are. They
// open a group, see its members one level in, and close it again. A container they do not
// hold reads *Not on this tab*; one they do is the group row itself, drawn once. A task
// under an epic stands alone. Recently finished leads with the group that finished
// something most recently. The pager turns a page without cutting a group in half, while
// the strip still counts work items. Watching and To fix look as they did. Then the same
// rows in Chinese.
//
// ── THE FIXTURE MAKES EVERY CLAIM FALSIFIABLE ───────────────────────────────
//
// - The containers belong to a SECOND person, so their heads read as context — a page
//   that drew every head as the reader's own would fail chapter 3.
// - Story G holds a task that has subtasks, so G is never a head; its grandchild groups
//   under the task.
// - Twenty-six one-member stories and one FIVE-member story fill To do past one page, the
//   big group placed so a cut by ROWS would split it at the boundary (its items are the
//   24th–28th) while a cut by GROUPS keeps it whole on page 1.
// - The strip's expected numbers are computed from the seed arrays, never read from the
//   page, so a strip that counted groups fails chapter 8.
//
// Seeded through the services and `adminDb`, never over HTTP — the reason the retired
// `acceptance-workbench-paging.spec.ts` gives (`signUp` resolved the wrong port in this
// lane). Statuses are written with `updateMany`, so no rollup moves a container.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a row's role or text, `aria-expanded`, the URL, or a
// stored column read back. There is no `waitForTimeout`.

const READER = 'accept-grouped@example.com';
const OTHER = 'accept-grouped-other@example.com';
const PASSWORD = 'workbench-grouped-acceptance-pass-123';

test.describe.configure({ timeout: 300_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

interface Card {
  id: string;
  identifier: string;
  title: string;
}

async function seed() {
  const reader = await usersService.createUser({
    email: READER,
    password: PASSWORD,
    name: 'Zhu Yue',
  });
  const other = await usersService.createUser({
    email: OTHER,
    password: PASSWORD,
    name: 'Mei Lin',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: reader.id,
  });
  const project = await projectsService.createProject({
    name: 'Motir',
    identifier: 'GRP',
    workspaceId: workspace.id,
    actorUserId: reader.id,
  });
  const ctx = { userId: reader.id, workspaceId: workspace.id };
  const all: Card[] = [];
  const make = async (
    kind: 'epic' | 'story' | 'task' | 'subtask',
    title: string,
    parent?: Card,
  ): Promise<Card> => {
    const created = await workItemsService.createWorkItem(
      { projectId: project.id, kind, title, ...(parent ? { parentId: parent.id } : {}) },
      ctx,
    );
    const card = { id: created.id, identifier: created.identifier, title };
    all.push(card);
    return card;
  };

  // In progress: S (3) and T (1). S also holds one To do subtask.
  const S = await make('story', 'Per-key API quotas');
  const sDoing = [
    await make('subtask', 'Quota table', S),
    await make('subtask', 'Enforce the quota', S),
    await make('subtask', 'Quota settings page', S),
  ];
  const sWaiting = await make('subtask', 'Quota docs', S);
  const T = await make('story', 'Audit log export');
  const tDoing = await make('subtask', 'CSV export', T);
  // To do: G holds a task with a subtask, so G never heads; the task does.
  const G = await make('story', 'Checklists');
  const Gt = await make('task', 'Checklist API', G);
  const Gg = await make('subtask', 'Checklist read endpoint', Gt);
  // The paging stock: 21 small groups, the big one on the boundary, 5 more.
  const small: Card[] = [];
  const stock = async (label: string) => {
    const story = await make('story', `Billing slice ${label}`);
    small.push(await make('subtask', `Billing slice ${label} — the change`, story));
  };
  for (let i = 1; i <= 21; i += 1) await stock(String(i));
  const B = await make('story', 'Invoice exports');
  const bMembers: Card[] = [];
  for (const part of ['schema', 'writer', 'reader', 'retry', 'docs']) {
    bMembers.push(await make('subtask', `Invoice export ${part}`, B));
  }
  for (let i = 22; i <= 26; i += 1) await stock(String(i));
  // A task directly under an epic — standalone.
  const E = await make('epic', 'Billing');
  const Et = await make('task', 'Retire the legacy invoice job', E);
  // Recently finished: two groups, F1 finished more recently than F2.
  const F1 = await make('story', 'Search relevance');
  const f1 = await make('subtask', 'Reindex the titles', F1);
  const F2 = await make('story', 'Notification digest');
  const f2 = await make('subtask', 'Digest template', F2);
  // To fix, and a watched card.
  const X = await make('task', 'Rate limiter flake');
  const W = await make('task', 'Follow the release');

  const containers = [
    S,
    T,
    G,
    Gt,
    B,
    E,
    F1,
    F2,
    W,
    ...all.filter((c) => c.title.startsWith('Billing slice') && !c.title.includes('—')),
  ];
  const doing = [...sDoing, tDoing];
  const toDo = [sWaiting, Gg, ...small, ...bMembers, Et];
  const finished = [f1, f2];

  // Ownership: the reader holds every leaf; the second person holds every container.
  await adminDb.workItem.updateMany({
    where: { id: { in: all.map((c) => c.id) } },
    data: { reporterId: reader.id, assigneeId: reader.id },
  });
  await adminDb.workItem.updateMany({
    where: { id: { in: containers.map((c) => c.id) } },
    data: { reporterId: other.id, assigneeId: other.id },
  });
  await adminDb.workItem.updateMany({
    where: { id: { in: [...doing, X].map((c) => c.id) } },
    data: { status: 'in_progress' },
  });
  await adminDb.workItem.update({
    where: { id: X.id },
    data: {
      fixReason: 'ci_failed',
      fixDetail: { repair: 'fix', check: 'vitest', affected: 1, total: 1 },
    },
  });
  const day = 24 * 60 * 60 * 1000;
  await adminDb.workItem.update({
    where: { id: f1.id },
    data: { status: 'done', completedAt: new Date(Date.now() - day) },
  });
  await adminDb.workItem.update({
    where: { id: f2.id },
    data: { status: 'done', completedAt: new Date(Date.now() - 3 * day) },
  });
  // Watching: only W. Creating a card watches its reporter, so clear that first.
  for (const card of all) await watchersService.unwatch(card.id, ctx);
  await watchersService.watch(W.id, ctx);

  await projectsService.setActiveProject({
    userId: reader.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return {
    reader,
    other,
    S,
    T,
    G,
    Gt,
    Gg,
    B,
    bMembers,
    E,
    Et,
    F1,
    F2,
    X,
    W,
    sDoing,
    doing,
    toDo,
    finished,
  };
}

// ── The page ────────────────────────────────────────────────────────────────

const table = (page: Page, name: string): Locator => page.getByRole('table', { name });
/** The live page body: the shell's one `<main>`, so a streamed copy is never matched. */
const main = (page: Page): Locator => page.getByRole('main');
const groupRow = (page: Page, card: Card) =>
  main(page).getByTestId(`workbench-group-${card.identifier}`);
const itemRow = (page: Page, card: Card) =>
  main(page).getByTestId(`workbench-row-${card.identifier}`);
const chevron = (page: Page, card: Card) =>
  main(page).getByTestId(`workbench-group-toggle-${card.identifier}`);
const countOf = (page: Page, card: Card) =>
  groupRow(page, card).getByTestId('workbench-group-count');

/** Fill a catalogue string's placeholders, the text a reader sees. */
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? `{${key}}`));

/** The strip's count for a tab, as a number. */
async function stripCount(page: Page, tab: string): Promise<number> {
  const text = (await main(page).getByTestId(`workbench-tab-${tab}`).textContent()) ?? '';
  const digits = text.replace(/[^0-9]/g, '');
  return digits === '' ? 0 : Number(digits);
}

/** Open every group on the page, then read every item row's identifier. */
async function itemsOnPage(page: Page): Promise<string[]> {
  const shut = page.locator('[data-testid^="workbench-group-toggle-"][aria-expanded="false"]');
  for (let n = await shut.count(); n > 0; n = await shut.count()) {
    // Pin the toggle by its id: `shut.first()` re-resolves to the NEXT closed group the moment
    // this one opens. A click that lands before the page hydrates is lost, so the click is
    // retried until the state it asks for is the state the page reports — and never repeated
    // once it has taken, which would close the group again.
    const testId = await shut.first().getAttribute('data-testid');
    const toggle = main(page).getByTestId(testId!);
    await expect(async () => {
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
  }
  return page
    .locator('[role="row"][data-testid^="workbench-row-"]')
    .evaluateAll((rows) =>
      rows.map((r) => r.getAttribute('data-testid')!.slice('workbench-row-'.length)),
    );
}

test('a person reads their Workbench grouped under the story each piece of work belongs to', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-8012');

  const seeded = await seed();
  const { S, T, Gt, Gg, G, B, bMembers, E, Et, F1, F2, X, W, sDoing } = seeded;
  const g = en.workbench.group;
  const inProgress = en.workbench.tabs.inProgress;

  await chapter('In progress lists S (3) and T (1), each a closed group', async () => {
    await signIn(page, READER, PASSWORD);
    await expect(page).toHaveURL(LANDED_WORKBENCH_URL);
    await page.goto('/workbench?tab=in-progress');
    await expect(table(page, inProgress)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[role="row"][data-testid^="workbench-group-"]')).toHaveCount(2);
    await expect(chevron(page, S)).toHaveAttribute('aria-expanded', 'false');
    await expect(chevron(page, T)).toHaveAttribute('aria-expanded', 'false');
    await expect(countOf(page, S)).toHaveText('3');
    await expect(countOf(page, T)).toHaveText('1');
    await expect(page.locator('[role="row"][data-testid^="workbench-row-"]')).toHaveCount(0);
    await beat();
  });

  await chapter('Open S: its three subtasks, one level in — and close it again', async () => {
    await chevron(page, S).click();
    await expect(chevron(page, S)).toHaveAttribute('aria-expanded', 'true');
    await expect(chevron(page, S)).toHaveAttribute(
      'aria-label',
      fill(g.collapse, { key: S.identifier }),
    );
    const members = page
      .getByRole('rowgroup', { name: fill(g.members, { key: S.identifier }) })
      .locator('[role="row"][data-testid^="workbench-row-"]');
    await expect(members).toHaveCount(3);
    for (const card of sDoing) {
      await expect(itemRow(page, card)).toBeVisible();
      // The shipped row, every cell — the Status cell included.
      await expect(itemRow(page, card).getByRole('cell')).toHaveCount(4);
    }
    await beat();
    await chevron(page, S).click();
    await expect(chevron(page, S)).toHaveAttribute('aria-expanded', 'false');
    await expect(members).toHaveCount(0);
    await beat();
  });

  await chapter('A container the reader does not hold reads “Not on this tab”', async () => {
    for (const head of [S, T]) {
      await expect(groupRow(page, head)).toHaveAttribute('data-group-head', 'context');
      await expect(groupRow(page, head)).toContainText(g.context);
    }
    await beat();
  });

  await chapter('Once S is the reader’s own and in progress, it IS the group row', async () => {
    await workItemsService.updateStatus(S.id, 'in_progress', {
      userId: seeded.reader.id,
      workspaceId: (await adminDb.workItem.findUniqueOrThrow({ where: { id: S.id } })).workspaceId,
    });
    await adminDb.workItem.update({
      where: { id: S.id },
      data: { assigneeId: seeded.reader.id, reporterId: seeded.reader.id },
    });
    await page.reload();
    await expect(groupRow(page, S)).toHaveAttribute('data-group-head', 'member');
    await expect(groupRow(page, S)).not.toContainText(g.context);
    await expect(page.locator(`[data-testid$="-${S.identifier}"][role="row"]`)).toHaveCount(1);
    await expect(countOf(page, S)).toHaveText('3');
    await beat();
    // Restore S for the walk that follows.
    await adminDb.workItem.update({
      where: { id: S.id },
      data: { status: 'todo', assigneeId: seeded.other.id, reporterId: seeded.other.id },
    });
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: S.id } })).status).toBe('todo');
  });

  await chapter('To do: a task under an epic stands alone, and no epic heads', async () => {
    await page.goto('/workbench?tab=todo');
    await expect(table(page, en.workbench.tabs.toDo)).toBeVisible();
    await expect(groupRow(page, E)).toHaveCount(0);
    await expect(groupRow(page, G)).toHaveCount(0);
    // G's grandchild groups under G's task, the runnable container.
    await expect(groupRow(page, Gt)).toBeVisible();
    await chevron(page, Gt).click();
    await expect(itemRow(page, Gg)).toBeVisible();
    // S's To do subtask sits under S's group.
    await expect(groupRow(page, S)).toBeVisible();
    await expect(countOf(page, S)).toHaveText('1');
    // The epic's task is a group of one that ranks by its own kind (task), after every
    // subtask-led group — so it is the last of the 30 and sits on page two.
    await page.goto('/workbench?tab=todo&page=2');
    await expect(table(page, en.workbench.tabs.toDo)).toBeVisible();
    await expect(itemRow(page, Et)).toBeVisible();
    await expect(itemRow(page, Et).getByRole('button')).toHaveCount(0);
    await expect(groupRow(page, E)).toHaveCount(0);
    await beat();
  });

  await chapter('Recently finished leads with the group that finished most recently', async () => {
    await page.goto('/workbench?tab=finished');
    const groups = page.locator('[role="row"][data-testid^="workbench-group-"]');
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0)).toHaveAttribute('data-testid', `workbench-group-${F1.identifier}`);
    await expect(groups.nth(1)).toHaveAttribute('data-testid', `workbench-group-${F2.identifier}`);
    await beat();
  });

  await chapter('The pager turns a page without cutting a group in half', async () => {
    const totalGroups = 2 + 21 + 1 + 5 + 1; // S, Gt, the small 21, B, the last 5, Et
    await page.goto('/workbench?tab=todo');
    const showing = (from: number, to: number) =>
      en.common.pager.showing
        .split(/<\/?[a-z]+>/)
        .join('')
        .replace('{from}', String(from))
        .replace('{to}', String(to))
        .replace('{total}', String(totalGroups));
    await expect(main(page).getByText(showing(1, 25))).toBeVisible();
    const pageOne = await itemsOnPage(page);
    await beat();
    await page.getByRole('button', { name: en.common.pager.nextPage }).click();
    await expect(page).toHaveURL(/\?tab=todo&page=2$/);
    await expect(main(page).getByText(showing(26, totalGroups))).toBeVisible();
    const pageTwo = await itemsOnPage(page);
    // Disjoint, and together exactly the reader's To do.
    expect(pageOne.filter((key) => pageTwo.includes(key))).toEqual([]);
    expect([...pageOne, ...pageTwo].sort()).toEqual(seeded.toDo.map((c) => c.identifier).sort());
    // The boundary group whole, on page one only.
    const big = bMembers.map((c) => c.identifier);
    expect(big.every((key) => pageOne.includes(key))).toBe(true);
    expect(big.some((key) => pageTwo.includes(key))).toBe(false);
    // …where a cut by ROWS at 25 would have split it.
    expect(pageOne.length).toBeGreaterThan(25);
    await expect(groupRow(page, B)).toHaveCount(0);
    await beat();
  });

  await chapter('The strip still counts work items, not groups', async () => {
    expect(await stripCount(page, 'todo')).toBe(seeded.toDo.length);
    expect(await stripCount(page, 'in-progress')).toBe(seeded.doing.length);
    expect(await stripCount(page, 'finished')).toBe(seeded.finished.length);
    await beat();
  });

  await chapter('Watching and To fix are as they were', async () => {
    await page.goto('/workbench?tab=watching');
    await expect(itemRow(page, W)).toBeVisible();
    await expect(page.locator('[data-testid^="workbench-group-toggle-"]')).toHaveCount(0);
    await page.goto('/workbench?tab=to-fix');
    await expect(itemRow(page, X)).toBeVisible();
    await expect(main(page).getByTestId(`workbench-fix-${X.identifier}`)).toContainText('vitest');
    await expect(page.locator('[data-testid^="workbench-group-toggle-"]')).toHaveCount(0);
    await beat();
  });

  await chapter('In 简体中文 — the count, the control and the marker', async () => {
    await page
      .context()
      .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
    await page.goto('/workbench?tab=in-progress');
    const zg = zh.workbench.group;
    await expect(table(page, zh.workbench.tabs.inProgress)).toBeVisible({ timeout: 60_000 });
    await expect(chevron(page, S)).toHaveAttribute(
      'aria-label',
      fill(zg.expand, { key: S.identifier }),
    );
    await expect(groupRow(page, S)).toContainText(zg.context);
    await expect(countOf(page, S)).toHaveAttribute(
      'aria-label',
      zg.count.replace(/\{count, plural, other \{(.*)\}\}/, '$1').replace('#', '3'),
    );
    await beat();
  });
});
