// Acceptance E2E — the planning overlay's HISTORY (Subtask MOTIR-9310, Story
// MOTIR-9218; design `design/ai-chat/planning-workspace--history.mock.html`).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A member opens the planning overlay and finds a History section under the rail
// head, collapsed, that has asked the server for nothing. Expanded, it lists that
// member's own conversations in this project, newest activity first: a question
// that never became a plan and an ended conversation anchored on a story are both
// there, and a colleague's conversation and the member's own Guide me through
// session are not. A row opens its conversation inside the overlay: the question
// continues as a normal open conversation, the ended one shows read-only, and
// Start a new session carries it into a new conversation, which the list then
// marks as the one on screen. A member with 25 conversations sees ten, then ten
// more and five more as the list is scrolled, and an end-of-list marker. A member
// with none sees the empty state. The same walk then runs in Chinese.
//
// The unrecorded test covers the Visitor: the overlay is a member's, so a Visitor
// on the public project sees no History and the read is never asked.
//
// ── THE SEAMS (read from `playwright.acceptance.config.ts`) ─────────────────
//
// The overlay mounts only with `MOTIR_AI_URL` set, which is why this spec is in
// the acceptance lane (`docs/acceptance-lane-triage.md`: neither the main nor the
// cloud-on lane wires it). No planner runs: every conversation is seeded as rows,
// and the one write the walk makes — the carry — is the shipped copy start, which
// sends no turn. `MOTIR_AI_JOBS_FIXTURE_PATH` is still declared empty, so a stray
// submit would settle rather than hang.
//
// ── SEEDING ─────────────────────────────────────────────────────────────────
//
// Conversations are written as `plan_change_sessions` + `plan_change_turns` rows
// with FIXED last-activity instants, so the order the list shows is decided by
// the seed. Members are added through the shipped membership services.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a landmark, a
// `waitForURL`, or the response of a request armed before the action that sends
// it; a held page is held by a route the test releases. `beat()` and the chapter
// hold are PACING only, each taken after the assertion that already proved the
// state.
import { writeFileSync } from 'node:fs';
import type { Locator, Page, Request, Route } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedPlanningAnchorTree,
  PLANNING_ANCHOR_PASSWORD,
  type PlanningAnchorSeed,
} from './_helpers/planning-anchor-seed';
import { createTestPerson } from './_helpers/testPerson';
import { buildScope, PROJECT_SCOPE } from '@/lib/planChange/scope';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

test.describe.configure({ timeout: 360_000 });

const HISTORY_PATH = '/api/ai/plan-change/sessions/history';
const ended = en.planningWorkspace.session;

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan|的计划/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const section = (page: Page) => rail(page).getByTestId('planning-history');
const toggle = (page: Page) => rail(page).getByTestId('planning-history-toggle');
const list = (page: Page) => rail(page).getByTestId('planning-history-list');
const rows = (page: Page) => rail(page).getByTestId('planning-history-row');
const rowOf = (page: Page, id: string) =>
  rail(page).locator(`[data-testid="planning-history-row"][data-session-id="${id}"]`);
const endOfList = (page: Page) => rail(page).getByTestId('planning-history-end');
const loadingMore = (page: Page) => rail(page).getByTestId('planning-history-loading-more');
const empty = (page: Page) => rail(page).getByTestId('planning-history-empty');
const endMarker = (page: Page) => rail(page).getByTestId('planning-session-end');
const startSlot = (page: Page) => rail(page).getByTestId('planning-session-ended');
const copiedDivider = (page: Page) => rail(page).getByTestId('planning-copied-divider');

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const onSession = (id: string) => (url: URL) => url.searchParams.get('planSession') === id;

const isHistory = (r: { url: () => string }) => new URL(r.url()).pathname === HISTORY_PATH;
const isNextPage = (r: { url: () => string }) =>
  isHistory(r) && new URL(r.url()).searchParams.has('cursor');

// ── The motir-ai boundary ────────────────────────────────────────────────────

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

function declareNoJobs(): void {
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ ask: [], plan: [], submitted: [] }, null, 2));
}

async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        applicable: false,
        organizationId: null,
        organizationName: null,
        canManageBilling: false,
        hasPaidAiPlan: false,
        balance: 0,
        tierName: null,
        tierAllotment: null,
        renewsAt: null,
      }),
    }),
  );
}

async function useLocale(page: Page, locale: 'zh' | 'en'): Promise<void> {
  await page
    .context()
    .addCookies([{ name: 'NEXT_LOCALE', value: locale, url: new URL('/', page.url()).href }]);
}

/** Every request this page sends to the History read, as they are sent. */
function historyRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (r) => {
    if (isHistory(r)) seen.push(r);
  });
  return seen;
}

// ── Seeding ──────────────────────────────────────────────────────────────────

/** Seconds before one instant taken at load: the list's order is the seed's, never
 *  the clock's. Recent on purpose: the lane's job worker runs the idle close every
 *  5 minutes, and it ends any open session idle past the 30-minute lease. */
const BASE = Date.now();
const at = (secondsBefore: number) => new Date(BASE - secondsBefore * 1_000);

interface Ctx {
  userId: string;
  workspaceId: string;
  projectId: string;
}

/** One conversation: its row, the person's question, and an answer when given. */
async function conversation(
  ctx: Ctx,
  opts: {
    ask: string;
    answer?: string;
    when: Date;
    targetKeys?: string[];
    origin?: 'conversation' | 'guide';
    endedIdle?: boolean;
  },
): Promise<string> {
  const targetKeys = opts.targetKeys ?? [];
  const s = await adminDb.planChangeSession.create({
    data: {
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      createdById: ctx.userId,
      scopeKey: targetKeys.length ? buildScope(targetKeys).scopeKey : PROJECT_SCOPE.scopeKey,
      targetKeys,
      turnCount: opts.answer ? 2 : 1,
      origin: opts.origin ?? 'conversation',
      lastActivityAt: opts.when,
      ...(opts.endedIdle ? { endedAt: opts.when, endReason: 'idle' as const } : {}),
    },
  });
  await adminDb.planChangeTurn.create({
    data: {
      workspaceId: ctx.workspaceId,
      sessionId: s.id,
      seq: 0,
      role: 'user',
      body: opts.ask,
      authorId: ctx.userId,
    },
  });
  if (opts.answer) {
    await adminDb.planChangeTurn.create({
      data: {
        workspaceId: ctx.workspaceId,
        sessionId: s.id,
        seq: 1,
        role: 'assistant',
        body: opts.answer,
      },
    });
  }
  return s.id;
}

async function ownerCtx(seed: PlanningAnchorSeed): Promise<Ctx> {
  const project = await adminDb.project.findFirstOrThrow({
    where: { identifier: seed.projectKey },
  });
  const owner = await adminDb.user.findFirstOrThrow({ where: { email: seed.email } });
  return { userId: owner.id, workspaceId: project.workspaceId, projectId: project.id };
}

/** A member of the seed's project, with it as their active project. */
async function addMember(seed: PlanningAnchorSeed, owner: Ctx, slug: string, name: string) {
  const email = `planning-history-${slug}-${Date.now()}@example.com`;
  const user = await usersService.createUser({
    email,
    password: PLANNING_ANCHOR_PASSWORD,
    name,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: owner.workspaceId });
  await addToProjectAs({
    key: seed.projectKey,
    actorUserId: owner.userId,
    ctx: { userId: owner.userId, workspaceId: owner.workspaceId },
    targetUserId: user.id,
    role: 'member',
  });
  await projectsService.setActiveProject({
    userId: user.id,
    workspaceId: owner.workspaceId,
    projectId: owner.projectId,
  });
  return { email, ctx: { ...owner, userId: user.id } };
}

const QUESTION = 'How does the import handle duplicate rows?';
const ANSWER = 'It keeps the first row and reports each duplicate it skipped.';
const ANCHORED = 'Which retries does the story’s webhook need?';
const ANCHORED_ANSWER = 'Three, with backoff, and a dead-letter after the last.';

/** 25 conversations, ten-a-page boundary tied: #10 and #11 share one instant. */
async function seedTwentyFive(ctx: Ctx): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < 25; i++) {
    const seconds = i < 10 ? i + 1 : i;
    ids.push(await conversation(ctx, { ask: `Question number ${i + 1}`, when: at(seconds) }));
  }
  return ids;
}

// ── Steps ────────────────────────────────────────────────────────────────────

/** Open *Plan with AI* from a card, and prove the overlay MOUNTED first. */
async function openFromCard(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

/** Expand History and wait for the first page the click asks for. */
async function expand(page: Page): Promise<void> {
  const first = page.waitForResponse((r) => isHistory(r) && !isNextPage(r));
  await toggle(page).click();
  expect((await first).status()).toBe(200);
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
}

/** Scroll the list itself to its bottom, so its sentinel meets its root. */
async function scrollToBottom(scope: Locator): Promise<void> {
  await scope.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

/** Scroll for the next page and wait on its response. */
async function scrollForMore(page: Page): Promise<void> {
  const next = page.waitForResponse(isNextPage);
  await scrollToBottom(list(page));
  expect((await next).status()).toBe(200);
}

async function rowIds(page: Page): Promise<string[]> {
  return rows(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')!));
}

/** The row on screen carries the current marker, and no other row does. */
async function expectCurrent(page: Page, id: string): Promise<void> {
  await expect(rowOf(page, id)).toHaveAttribute('aria-current', 'true');
  await expect(
    rail(page).locator('[data-testid="planning-history-row"][aria-current]'),
  ).toHaveCount(1);
}

test.beforeEach(async () => {
  await resetDatabase();
  declareNoJobs();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECORDED PATH
// ─────────────────────────────────────────────────────────────────────────────

test('History lists my own conversations, pages on scroll, opens a row in place and carries an ended one — in English and in Chinese', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9218');

  const email = `planning-history-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  const owner = await ownerCtx(seed);
  const colleague = await addMember(seed, owner, 'colleague', 'Bea Colleague');
  const reader = await addMember(seed, owner, 'reader', 'Pat Reader');
  const newcomer = await addMember(seed, owner, 'newcomer', 'Nia Newcomer');

  // A's own: a question-only conversation (open, no plan) and an ENDED one anchored
  // on the story. Not A's to list: the colleague's conversation (newer than both)
  // and A's own Guide me through session.
  const question = await conversation(owner, { ask: QUESTION, answer: ANSWER, when: at(2) });
  const anchored = await conversation(owner, {
    ask: ANCHORED,
    answer: ANCHORED_ANSWER,
    when: at(3),
    targetKeys: [seed.storyKey],
    endedIdle: true,
  });
  const theirs = await conversation(colleague.ctx, { ask: 'Not yours to see', when: at(1) });
  const guide = await conversation(owner, {
    ask: 'Guide me through it',
    when: at(0),
    origin: 'guide',
    targetKeys: [seed.subtaskKey],
  });
  const twentyFive = await seedTwentyFive(reader.ctx);

  await stubAiAccess(page);
  const asked = historyRequests(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  await chapter('History is collapsed and has asked for nothing', async () => {
    await openFromCard(page, seed.epicKey);
    await expect(toggle(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle(page)).toHaveText(en.planningWorkspace.history.header);
    await expect(rows(page)).toHaveCount(0);
    expect(asked).toHaveLength(0);
    await beat();
  });

  await chapter(
    'Expanded, it lists my two conversations — not a colleague’s, not a guide',
    async () => {
      await expand(page);
      // The response lands before React renders it: poll the rows, never read once.
      await expect.poll(() => rowIds(page)).toEqual([question, anchored]);
      await expect(rowOf(page, question)).toContainText(QUESTION);
      await expect(rowOf(page, anchored)).toContainText(ANCHORED);
      await expect(rowOf(page, anchored)).toHaveAttribute('data-ended', 'true');
      await expect(rowOf(page, theirs)).toHaveCount(0);
      await expect(rowOf(page, guide)).toHaveCount(0);
      await expect(endOfList(page)).toBeVisible();
      await beat();

      // The keyboard toggles it too, and the loaded rows are kept: no second read.
      await toggle(page).focus();
      await page.keyboard.press('Enter');
      await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(rows(page)).toHaveCount(0);
      await page.keyboard.press('Space');
      await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
      await expect(rows(page)).toHaveCount(2);
      expect(asked).toHaveLength(1);
      await beat();
    },
  );

  await chapter('A question opens in the overlay, and its row is marked', async () => {
    await rowOf(page, question).click();
    await page.waitForURL(onSession(question));
    const url = new URL(page.url());
    expect(url.searchParams.get('planFrom')).toBe('project');
    expect(url.searchParams.has('planItem')).toBe(false);
    expect(url.searchParams.has('planVia')).toBe(false);
    await expect(workspace(page)).toBeVisible();
    await expect(rail(page).getByText(ANSWER)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(endMarker(page)).toHaveCount(0);
    await expectCurrent(page, question);
    await beat();
  });

  let carried = '';
  await chapter('An ended conversation opens read-only, and carries into a new one', async () => {
    await rowOf(page, anchored).click();
    await page.waitForURL(onSession(anchored));
    const url = new URL(page.url());
    expect(url.searchParams.get('planFrom')).toBe('work-item');
    expect(url.searchParams.get('planItem')).toBe(seed.storyKey);
    expect(url.searchParams.has('planVia')).toBe(false);
    await expect(rail(page).getByText(ANCHORED_ANSWER)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(endMarker(page)).toHaveAttribute('data-end-reason', 'idle');
    await expectCurrent(page, anchored);
    expect(asked).toHaveLength(1);
    await beat();

    const copyStart = page.waitForRequest(
      (r) => new URL(r.url()).pathname === '/api/ai/plan-change/session' && r.method() === 'POST',
    );
    const relisted = page.waitForResponse((r) => isHistory(r) && !isNextPage(r));
    await startSlot(page).getByRole('button', { name: ended.newSession.start }).click();
    const sent = await copyStart;
    expect(sent.postDataJSON()).toMatchObject({ copyFrom: anchored });
    const started = (await (await sent.response())!.json()) as { id: string };
    carried = started.id;
    await expect(copiedDivider(page)).toBeVisible();
    await expect(rail(page).getByText(ANCHORED).first()).toBeVisible();
    await expect(endMarker(page)).toHaveCount(0);

    // The new conversation is fetched into the list's head and takes the marker.
    expect((await relisted).status()).toBe(200);
    await expect(rowOf(page, carried)).toBeVisible();
    await expect.poll(async () => (await rowIds(page))[0]).toBe(carried);
    await expectCurrent(page, carried);
    const copy = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: carried } });
    expect(copy.copiedFromSessionId).toBe(anchored);
    await beat();
  });

  await chapter('Twenty-five conversations: ten, then more on scroll, then the end', async () => {
    const readerAsked = historyRequests(page);
    await signIn(page, reader.email, PLANNING_ANCHOR_PASSWORD);
    await openFromCard(page, seed.epicKey);
    await expand(page);
    await expect(rows(page)).toHaveCount(10);
    await beat();

    await scrollForMore(page);
    await expect(rows(page)).toHaveCount(20);
    await scrollForMore(page);
    await expect(rows(page)).toHaveCount(25);
    await expect(endOfList(page)).toHaveText(en.planningWorkspace.history.end);

    const seen = await rowIds(page);
    expect(new Set(seen).size).toBe(25);
    expect([...seen].sort()).toEqual([...twentyFive].sort());
    // The two sharing one instant straddle the first page's end: both, once each,
    // the higher id first.
    const tied = [twentyFive[9]!, twentyFive[10]!].sort().reverse();
    expect(seen.slice(9, 11)).toEqual(tied);

    // The oldest is loaded: a further scroll asks for nothing.
    await scrollToBottom(list(page));
    await expect(endOfList(page)).toBeVisible();
    expect(readerAsked).toHaveLength(3);
    await beat();
  });

  await chapter('With no conversations yet, History says so', async () => {
    await signIn(page, newcomer.email, PLANNING_ANCHOR_PASSWORD);
    await openFromCard(page, seed.epicKey);
    await expand(page);
    await expect(empty(page)).toContainText(en.planningWorkspace.history.emptyTitle);
    await expect(empty(page)).toContainText(en.planningWorkspace.history.emptyBody);
    await expect(rows(page)).toHaveCount(0);
    await expect(endOfList(page)).toHaveCount(0);
    await beat();
  });

  await chapter('In Chinese: rows, loading more, the end and the empty state', async () => {
    const zhHistory = zh.planningWorkspace.history;
    const enHistory = en.planningWorkspace.history;
    const noEnglish = async () => {
      for (const text of [
        enHistory.header,
        enHistory.loadingMore,
        enHistory.end,
        enHistory.emptyTitle,
        enHistory.emptyBody,
        enHistory.status.open,
        enHistory.status.ended,
      ]) {
        await expect(section(page).getByText(text, { exact: true })).toHaveCount(0);
      }
    };

    await signIn(page, reader.email, PLANNING_ANCHOR_PASSWORD);
    await useLocale(page, 'zh');
    await openFromCard(page, seed.epicKey);
    await expect(toggle(page)).toHaveText(zhHistory.header);
    await expand(page);
    await expect(rows(page)).toHaveCount(10);
    await expect(rows(page).first().getByTestId('planning-history-row-status')).toHaveText(
      zhHistory.status.open,
    );
    await noEnglish();

    // The next page is HELD at the network, so the loading row stays on screen
    // until the test lets the page through.
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextPageUrl = (url: URL) =>
      url.pathname === HISTORY_PATH && url.searchParams.has('cursor');
    await page.route(nextPageUrl, async (route: Route) => {
      await held;
      await route.continue();
    });
    const next = page.waitForResponse(isNextPage);
    await scrollToBottom(list(page));
    await expect(loadingMore(page)).toHaveText(zhHistory.loadingMore);
    await noEnglish();
    await beat();
    release!();
    expect((await next).status()).toBe(200);
    await expect(rows(page)).toHaveCount(20);
    await scrollForMore(page);
    await expect(endOfList(page)).toHaveText(zhHistory.end);
    await noEnglish();
    await page.unroute(nextPageUrl);
    await beat();

    // The sign-in helper reads the English form, and the cookie would serve it in zh.
    await useLocale(page, 'en');
    await signIn(page, newcomer.email, PLANNING_ANCHOR_PASSWORD);
    await useLocale(page, 'zh');
    await openFromCard(page, seed.epicKey);
    await expand(page);
    await expect(empty(page)).toContainText(zhHistory.emptyTitle);
    await expect(empty(page)).toContainText(zhHistory.emptyBody);
    await noEnglish();
    await beat();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UNRECORDED
// ─────────────────────────────────────────────────────────────────────────────

test('a Visitor on the public project gets no History and the read is never asked', async ({
  page,
}) => {
  const email = `planning-history-visitor-owner-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  const owner = await ownerCtx(seed);
  await conversation(owner, { ask: QUESTION, answer: ANSWER, when: at(2) });
  await adminDb.project.update({
    where: { id: owner.projectId },
    data: projectAccessData('public'),
  });
  const outsider = await createTestPerson({
    email: `planning-history-visitor-${Date.now()}@example.com`,
    password: PLANNING_ANCHOR_PASSWORD,
    name: 'Olive Outsider',
  });
  const own = await workspacesService.createWorkspace({
    name: 'Olive Studio',
    ownerUserId: outsider.id,
  });
  const ownProject = await projectsService.createProject({
    workspaceId: own.workspace.id,
    actorUserId: outsider.id,
    name: 'Sketches',
    identifier: 'SKT',
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: outsider.id, workspaceId: own.workspace.id } },
    data: { activeProjectId: ownProject.id },
  });

  await stubAiAccess(page);
  const asked = historyRequests(page);
  await signIn(page, outsider.email, PLANNING_ANCHOR_PASSWORD);

  // The overlay's own address, on the Visitor's view of the project.
  const plansPath = `/p/${seed.projectKey}/plans`;
  const overlayQuery = 'plan=project&planFrom=project';
  await page.goto(`${plansPath}?${overlayQuery}`);
  await page.waitForURL((url) => url.pathname === `/p/${seed.projectKey}/consent`);
  const consent = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes(`/p/${seed.projectKey}/consent`),
  );
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect((await consent).status()).toBe(200);
  await page.waitForURL((url) => !url.pathname.endsWith('/consent'));
  await page.goto(`${plansPath}?${overlayQuery}`);
  await expect(page.getByRole('main')).toBeVisible({ timeout: FIRST_PAINT_MS });

  await expect(page.getByTestId('planning-history')).toHaveCount(0);
  await expect(page.getByTestId('planning-history-toggle')).toHaveCount(0);
  await expect(page.getByText(en.planningWorkspace.history.header, { exact: true })).toHaveCount(0);
  expect(asked).toHaveLength(0);
});
