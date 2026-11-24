// Acceptance E2E — a corrected decision moves the work planned against it to the
// To plan column (Story MOTIR-10139 · Subtask MOTIR-12179).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The board of a default-workflow project has a To plan column beside Planning, and the
// status picker offers To plan. An agent's decision D was published as a page, then its
// page was edited and published again — the first question superseded `republished`.
// The person presses Approve on D. On the board, the story S1 that waited on D and S1's
// child are now in To plan, and nothing else is. Each carries one comment that links D
// and names the approved version; S2, already In Progress behind S1, kept its status and
// got the comment only. A second decision D2, approved on the first question it raised,
// moved nothing. Last, the person moves S1 back to To Do by hand.
//
// ── WHAT IS NOT WALKED, AND WHY ─────────────────────────────────────────────
//
// Recipe step 5 (no run claims a To-plan card) is the status card's (MOTIR-12174) and the
// story integration gate's (`tests/approvalGates/toPlanStoryGate.test.ts`): a refusal by
// category has nothing to show in a browser. Step 7 (a planning conversation settles
// `author` and the plan's approve rests the card) ships in motir-ai / motir-meta, and the
// plan-target rest is shipped behaviour this story does not change; this receipt records
// the other way out of To plan instead, a person's hand move.
//
// ── THE SEED ────────────────────────────────────────────────────────────────
//
// Through the product's services, as `regression-decision-page.spec.ts` seeds: the project
// by `projectsService.createProject` (so it carries the default workflow and its To plan
// column), D's two publishes by `decisionPageService.publish` — the service the
// `publish_decision_page` MCP tool calls — and every status by `updateStatus`. The
// dependents are written BEFORE D's republish, the fixture shape the mark card
// (MOTIR-12175) hands on. The decided act is the person's and is NOT in the seed.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
//
// The Approve by its server action's response; D's Done by a reload; the board by its own
// projection read (`getFullBoard`) and then the rendered columns; the hand move by the
// status action's 200, armed before the option is pressed, then a reload. `chapter()` /
// `beat()` holds are pacing, taken only after the assertion that proved the state.

import type { Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { adminDb, db, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { actionWrite } from './_helpers/authoritative-signal';
import { columnByStatus, getFullBoard } from './_helpers/board';
import { closeOverlay, openDevelopmentOverlay } from './_helpers/development-decide';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { pagesService } from '@/lib/services/pagesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { decisionPageService } from '@/lib/services/decisionPageService';
import { composeMarkComment } from '@/lib/services/decisionCorrectionMarkService';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 300_000 });

const PASSWORD = 'acceptance-to-plan-pass-1';
const OWNER_EMAIL = 'acceptance-to-plan@example.com';

const PAGE_TITLE = 'Where exports are stored';
const PUBLISHED = `# ${PAGE_TITLE}\n\nKeep exports in Postgres.`;
const CORRECTED = `# ${PAGE_TITLE}\n\nMove exports to managed object storage.`;
const SECOND_TITLE = 'How exports are named';

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

interface Card {
  id: string;
  key: string;
  title: string;
}

interface Seed {
  d: Card;
  d2: Card;
  s1: Card;
  c1: Card;
  s2: Card;
  s3: Card;
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 25));

async function seed(): Promise<Seed> {
  const owner = await usersService.createUser({
    email: OWNER_EMAIL,
    password: PASSWORD,
    name: 'Robin Reviewer',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Exports',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Exports',
    identifier: 'EXP',
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };
  await projectsService.setActiveProject({ ...ctx, projectId: project.id });

  const create = async (
    title: string,
    extra: { kind?: 'task' | 'story'; parentId?: string; decision?: boolean } = {},
  ): Promise<Card> => {
    const item = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: extra.kind ?? 'task',
        title,
        ...(extra.decision ? {} : { descriptionMd: `${title}, planned on the first decision.` }),
        ...(extra.parentId ? { parentId: extra.parentId } : {}),
        ...(extra.decision ? { type: 'decision' as const, executor: 'coding_agent' as const } : {}),
      },
      ctx,
    );
    return { id: item.id, key: item.identifier, title };
  };
  const blockedBy = (from: Card, to: Card) =>
    workItemsService.linkWorkItems({ fromId: from.id, toId: to.id, kind: 'is_blocked_by' }, ctx);

  /** The agent's decision: assigned, In Progress, its page published (version 1). */
  const decide = async (title: string, pageTitle: string, markdown: string) => {
    const card = await create(title, { decision: true });
    await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: owner.id } });
    await workItemsService.updateStatus(card.id, 'in_progress', ctx);
    const page = await pagesService.createPageFromMarkdown(ctx, {
      projectId: project.id,
      title: pageTitle,
      markdown,
    });
    await decisionPageService.publish({ workItemId: card.id, pageId: page.id }, ctx);
    return { card, pageId: page.id };
  };

  const d = await decide('Decide where exports are stored', PAGE_TITLE, PUBLISHED);
  const d2 = await decide(
    'Decide how exports are named',
    SECOND_TITLE,
    `# ${SECOND_TITLE}\n\nName them by date.`,
  );

  // The work planned against D's first version — written BEFORE the correction.
  const s1 = await create('Write exports to the store', { kind: 'story' });
  const c1 = await create('Add the export writer', { parentId: s1.id });
  const s2 = await create('Read exports back');
  const s3 = await create('Name each export file');
  await blockedBy(s1, d.card);
  await blockedBy(s2, s1);
  await workItemsService.updateStatus(s2.id, 'in_progress', ctx);
  await blockedBy(s3, d2.card);
  await pause();

  // THE CORRECTION: D's page is edited and published again — the agent's republish, which
  // supersedes the awaiting question with cause `republished` and raises version 2's.
  const current = await pagesService.getPageMarkdown(ctx, {
    projectId: project.id,
    pageId: d.pageId,
  });
  await pagesService.savePageMarkdown(ctx, {
    projectId: project.id,
    pageId: d.pageId,
    markdown: CORRECTED,
    expectedRevision: current.revision,
  });
  await decisionPageService.publish({ workItemId: d.card.id, pageId: d.pageId }, ctx);
  const gates = await adminDb.approvalGate.findMany({
    where: { workItemId: d.card.id, kind: 'decision_approval' },
    orderBy: { createdAt: 'asc' },
  });
  expect(gates.map((g) => [g.state, g.supersededCause])).toEqual([
    ['superseded', 'republished'],
    ['awaiting', null],
  ]);

  return { d: d.card, d2: d2.card, s1, c1, s2, s3 };
}

/** The comment the mark writes on `item`, in the wording the mark card settled. */
async function expectedComment(item: Card, d: Card, started: boolean) {
  const created = await adminDb.workItemRevision.findFirstOrThrow({
    where: { workItemId: item.id, changeKind: 'created' },
  });
  const full = composeMarkComment({
    decisionIdentifier: d.key,
    decisionId: d.id,
    versionLabel: `version 2 of ${PAGE_TITLE}`,
    descriptionWrittenAt: created.changedAt,
    started,
  });
  // The bold head renders around D's live reference chip; the rest is plain prose.
  const [head, rest] = full.split('.** ');
  return { head: head!.replace(/^\*\*| \[.*$/g, ''), rest: rest! };
}

// ── Locators ────────────────────────────────────────────────────────────────

const main = (page: Page) => page.getByRole('main');
const columns = (page: Page) => main(page).locator('[data-testid^="board-column-"]');
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });
const comments = (page: Page) => page.getByRole('list', { name: 'Comments' }).getByRole('listitem');

async function openBoard(page: Page): Promise<void> {
  await page.goto('/boards');
  await expect(main(page).getByTestId('board')).toBeVisible({ timeout: FIRST_PAINT_MS });
}

async function openItem(page: Page, card: Card): Promise<void> {
  await page.goto(`/items/${card.key}`);
  await expect(main(page).getByText(card.title).first()).toBeVisible({ timeout: FIRST_PAINT_MS });
}

async function openStatusPicker(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Edit Status' }).click();
  await page.getByRole('combobox', { name: 'Status' }).click();
}

/** Press Approve on the decision's question in the overlay, and see it land. */
async function approveInOverlay(page: Page, card: Card, version: number): Promise<void> {
  await openItem(page, card);
  const overlay = await openDevelopmentOverlay(page);
  await expect(overlay.getByTestId('decision-page-meta').first()).toContainText(
    `Version ${version}`,
  );
  await overlay.getByRole('button', { name: en.approvalGate.verb.approve, exact: true }).click();
  const action = page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );
  await overlay
    .getByRole('button', {
      name: fill(en.approvalGate.confirm.proceed, { verb: en.approvalGate.verb.approve }),
      exact: true,
    })
    .click();
  expect((await action).status()).toBe(200);
  await expect(overlay.getByText(en.approvalGate.state.approved, { exact: true })).toBeVisible();
  await closeOverlay(page);
  await page.reload();
  await expect(statusCard(page).getByText('Done', { exact: true })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
}

/** The one mark comment on `card`, linking D and naming its approved version. */
async function expectMarkComment(page: Page, card: Card, d: Card, started: boolean) {
  await openItem(page, card);
  const { head, rest } = await expectedComment(card, d, started);
  const marks = comments(page).filter({ hasText: head });
  await expect(marks).toHaveCount(1, { timeout: FIRST_PAINT_MS });
  await expect(marks.locator('.wi-chip .wi-key')).toHaveText(d.key);
  await expect(marks).toContainText(rest);
  await expect(comments(page)).toHaveCount(1);
}

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test.afterAll(async () => {
  await db.$disconnect();
});

test('a corrected decision moves its not-started dependents to To plan, with a note on each', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-10139');

  await resetDatabase();
  const s = await seed();
  await signIn(page, OWNER_EMAIL, PASSWORD);

  // ── 1. The column and the picker ─────────────────────────────────────────
  await chapter('The board has a To plan column beside Planning', async () => {
    const board = await getFullBoard(page.request);
    const toPlan = columnByStatus(board, 'to_plan');
    expect(toPlan.cards).toEqual([]);
    await openBoard(page);
    // The projection's own order: To plan is the column straight after Planning.
    const order = board.columns.map((c) => c.id);
    expect(order.indexOf(toPlan.id)).toBe(order.indexOf(columnByStatus(board, 'planning').id) + 1);
    // …and the page draws it straight after Planning too (the column roots, by id).
    const testIds = new Set(order.map((id) => `board-column-${id}`));
    const drawn = (
      await columns(page).evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-testid') ?? ''),
      )
    ).filter((id, i, all) => testIds.has(id) && all.indexOf(id) === i);
    const planningDrawn = drawn.indexOf(`board-column-${columnByStatus(board, 'planning').id}`);
    expect(planningDrawn).toBeGreaterThan(-1);
    expect(drawn.indexOf(`board-column-${toPlan.id}`)).toBe(planningDrawn + 1);
    const column = main(page).getByTestId(`board-column-${toPlan.id}`);
    await column.scrollIntoViewIfNeeded();
    await expect(column).toBeVisible();
    await beat();
  });

  await chapter('The status picker offers To plan', async () => {
    await openItem(page, s.s1);
    await openStatusPicker(page);
    await expect(page.getByRole('option', { name: 'To plan', exact: true })).toBeVisible();
    await beat();
    await page.keyboard.press('Escape');
  });

  // ── 2. The person approves the corrected decision ────────────────────────
  await chapter('Approve the corrected decision — version 2 of its page', async () => {
    await approveInOverlay(page, s.d, 2);
    await beat();
  });

  // ── 3. The board: S1 and its child are in To plan, and nothing else ──────
  await chapter('S1 and its child are now in To plan', async () => {
    const board = await getFullBoard(page.request);
    const toPlan = columnByStatus(board, 'to_plan');
    expect(toPlan.cards.map((c) => c.identifier).sort()).toEqual([s.s1.key, s.c1.key].sort());
    expect(columnByStatus(board, 'in_progress').cards.map((c) => c.identifier)).toContain(s.s2.key);

    await openBoard(page);
    const column = main(page).getByTestId(`board-column-${toPlan.id}`);
    await column.scrollIntoViewIfNeeded();
    await expect(column.getByTestId(`board-card-${s.s1.key}`)).toBeVisible();
    await expect(column.getByTestId(`board-card-${s.c1.key}`)).toBeVisible();
    await expect(column.locator('[data-testid^="board-card-"]')).toHaveCount(2);
    await beat();
  });

  // ── 4. The note on each moved card, and on the started one ───────────────
  await chapter('Each moved card says why, linking the decision and its version', async () => {
    await expectMarkComment(page, s.s1, s.d, false);
    await expect(statusCard(page).getByText('To plan', { exact: true })).toBeVisible();
    await beat();
    await expectMarkComment(page, s.c1, s.d, false);
    await expect(statusCard(page).getByText('To plan', { exact: true })).toBeVisible();
    await beat();
  });

  await chapter('S2 was already In Progress — it keeps its status and gets the note', async () => {
    await expectMarkComment(page, s.s2, s.d, true);
    await expect(statusCard(page).getByText('In Progress', { exact: true })).toBeVisible();
    await beat();
  });

  // ── 5. A decision approved on its FIRST question moves nothing ───────────
  await chapter('A decision approved the first time moves nothing', async () => {
    await approveInOverlay(page, s.d2, 1);
    await beat();
    const board = await getFullBoard(page.request);
    expect(columnByStatus(board, 'todo').cards.map((c) => c.identifier)).toContain(s.s3.key);
    expect(columnByStatus(board, 'to_plan').cards.map((c) => c.identifier)).not.toContain(s.s3.key);
    await openItem(page, s.s3);
    await expect(statusCard(page).getByText('To Do', { exact: true })).toBeVisible();
    await expect(comments(page)).toHaveCount(0);
    await beat();
  });

  // ── 6. A person moves S1 back to To Do by hand ───────────────────────────
  await chapter('Move S1 from To plan back to To Do', async () => {
    await openItem(page, s.s1);
    await openStatusPicker(page);
    const written = actionWrite(page, `/items/${s.s1.key}`, 'toStatusKey');
    await page.getByRole('option', { name: 'To Do', exact: true }).click();
    expect((await written).status()).toBe(200);
    await beat();

    const board = await getFullBoard(page.request);
    const todo = columnByStatus(board, 'todo');
    expect(todo.cards.map((c) => c.identifier)).toContain(s.s1.key);
    await openBoard(page);
    await expect(
      main(page).getByTestId(`board-column-${todo.id}`).getByTestId(`board-card-${s.s1.key}`),
    ).toBeVisible();
    await beat();
  });
});
