import { readFileSync, writeFileSync } from 'node:fs';
import type { APIRequestContext, Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { createTestPerson } from './_helpers/testPerson';
import { actionWrite } from './_helpers/authoritative-signal';
import { appendEvents, ingestContext, openRun } from './_helpers/agent-run-seed';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { GuideJobOutcome } from '@/lib/test-ai-jobs-mock';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// ACCEPTANCE — a run hands manual work to a person (Story MOTIR-7460 · Subtask
// MOTIR-7480; `docs/decisions/manual-work-gate.md`). The receipt a person watches to
// accept the story, walking its Verification recipe:
//
//   THE RECORDED WALK (cases 1–4, paced for a person). A parent run claims a story
//   with a code subtask and a manual one. It cannot do the manual one, so it hands it
//   over: the run's canvas says *waiting on you*, and the Workbench lands on the tab
//   **Waiting on you** with the row "<card> is waiting on you" at 0/3. *Guide me
//   through* from the row walks the three steps and closes the card on the person's
//   yes — and the row is gone. A second story's manual card is cleared the other way,
//   with the row's **Mark done**.
//
//   THE REST (case 5, unrecorded). The tab reads 等你处理 in zh. Case 6 — a plan held
//   while it is rewritten says it stays in Waiting on you — was RETIRED by Bug
//   MOTIR-7988, which reversed that claim: a plan being rewritten is being planned
//   again, so it LEAVES Waiting on you for Planning. The hold stays covered by
//   `cloud-plan-approval-gate.spec.ts` (its hold chapter) and by
//   `tests/integration/workbench/revision-hold-listing.test.ts`.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// The RUN is driven through the lane's run fixture (`agent-run-seed.ts`): the same
// PAT-authenticated `/api/v1/dispatch-runs` ingest the CLI posts, so the gate is
// raised by the shipped open path (`dispatchRunService`, a `skipped` / `needs_human`
// leg) — never seeded. motir-ai is mocked UNDER the routes by
// `lib/test-ai-jobs-mock.ts` (the lane's `E2E_TEST_AI_JOBS=1` intercept): each
// `guide_work_item` job answers the next entry of the fixture's `guide` queue, queued
// just before the action that submits it — the same seam
// `regression-guide-me-through.spec.ts` drives.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on the AUTHORITATIVE signal (the coding convention § E2E): the ingest's own
// committed response, the guide door's 200 and the settle whose BODY says `guided`
// (armed before the action), the Mark done server action's response, and Postgres
// read back for a tick, a close and a decision. A row is asserted MOUNTED — by the
// gate id Postgres holds for the `manual_work` kind — before anything inside it.
// `beat()` and the chapter hold are pacing only, each after the assertion that proved
// the state.

test.describe.configure({ timeout: 240_000 });

const PASSWORD = 'manual-work-gate-e2e-pass-7';
const JOBS_FIXTURE =
  process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ?? '/tmp/motir-acceptance-ai-jobs-fixture.json';

const tabs = en.workbench.tabs;
const approvals = en.workbench.approvals;

// ── Seed ─────────────────────────────────────────────────────────────────────

interface Tenant {
  email: string;
  userId: string;
  ctx: ServiceContext;
  projectId: string;
  projectKey: string;
  token: string;
}

async function seedTenant(email: string, identifier: string): Promise<Tenant> {
  const owner = await createTestPerson({ email, password: PASSWORD, name: 'Mina Manual' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Manual work',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Launch',
    identifier,
  });
  // The active-project pin and the onboarding marker — neither has a service door the
  // seed can call (`scoped-run-seed.ts`, `regression-plan-hold.spec.ts`).
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  await adminDb.project.update({
    where: { id: project.id },
    data: { onboardingRanAt: new Date() },
  });
  // The bearer `motir run` presents — the two permissions the ingest doors assert.
  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'manual-work-gate-e2e',
    projectId: project.id,
    permissions: ['project:browse', 'work_item:edit'],
  });
  return {
    email,
    userId: owner.id,
    ctx: { userId: owner.id, workspaceId: workspace.id },
    projectId: project.id,
    projectKey: project.identifier,
    token: minted.token,
  };
}

interface Card {
  id: string;
  key: string;
  title: string;
}

interface StoryWithManualWork {
  story: Card;
  code: Card;
  manual: Card;
  steps: string[];
}

/**
 * A story with a CODE subtask and a MANUAL one (three to-dos), the manual card
 * assigned to the tenant's person — the shape the story's Verification names.
 */
async function seedStory(
  t: Tenant,
  titles: { story: string; code: string; manual: string; steps: string[] },
): Promise<StoryWithManualWork> {
  const make = async (
    title: string,
    over: { kind?: 'story' | 'subtask'; parentId?: string; manual?: boolean } = {},
  ): Promise<Card> => {
    const item = await workItemsService.createWorkItem(
      {
        projectId: t.projectId,
        kind: over.kind ?? 'subtask',
        title,
        ...(over.parentId ? { parentId: over.parentId } : {}),
        ...(over.manual ? { type: 'manual', executor: 'human', assigneeId: t.userId } : {}),
      },
      t.ctx,
    );
    return { id: item.id, key: item.identifier, title };
  };
  const story = await make(titles.story, { kind: 'story' });
  const code = await make(titles.code, { parentId: story.id });
  const manual = await make(titles.manual, { parentId: story.id, manual: true });
  const steps: string[] = [];
  for (const text of titles.steps) {
    steps.push((await workItemTodosService.addTodo(manual.id, { text }, t.ctx)).todo.id);
  }
  return { story, code, manual, steps };
}

/**
 * The PARENT RUN, through the fixture: `motir run <story>` claims the set, works the
 * code subtask and records the manual one as `skipped` / `needs_human` — which is what
 * raises the `manual_work` gate. Returns the gate id Postgres holds for it.
 */
async function runStory(api: APIRequestContext, t: Tenant, s: StoryWithManualWork) {
  const runId = await openRun(api, {
    projectKey: t.projectKey,
    command: 'run_scope',
    scopeKey: s.story.key,
    agent: 'claude',
    cards: [
      { key: s.code.key, disposition: 'queued' },
      { key: s.manual.key, disposition: 'skipped', skipReason: 'needs_human' },
    ],
  });
  await appendEvents(api, runId, [
    { kind: 'card_claimed', workItemKey: s.code.key, disposition: 'running' },
  ]);
  const gates = await adminDb.approvalGate.findMany({
    where: { workItemId: s.manual.id, kind: 'manual_work', state: 'awaiting' },
  });
  expect(gates, 'the run raised ONE manual_work gate on the manual card').toHaveLength(1);
  return gates[0]!.id;
}

const gateState = async (gateId: string) =>
  (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gateId } })).state;
const statusOf = async (workItemId: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
const doneFlags = async (workItemId: string) =>
  (
    await adminDb.workItemTodo.findMany({ where: { workItemId }, orderBy: { position: 'asc' } })
  ).map((r) => r.doneAt !== null);

// ── The motir-ai boundary ────────────────────────────────────────────────────

function resetJobsFixture(): void {
  writeFileSync(JOBS_FIXTURE, JSON.stringify({}, null, 2));
}

/**
 * APPEND the next guide job's answer, keeping what the mock has recorded — the mock
 * indexes the queue by how many guide jobs it has seen, so `submitted` must survive.
 */
function queueTurn(messageMd: string, actions: unknown[]): void {
  let f: { guide?: GuideJobOutcome[] } = {};
  try {
    f = JSON.parse(readFileSync(JOBS_FIXTURE, 'utf8')) as typeof f;
  } catch {
    f = {};
  }
  f.guide = [...(f.guide ?? []), { guideTurn: { messageMd, actions } }];
  writeFileSync(JOBS_FIXTURE, JSON.stringify(f, null, 2));
}

// ── Locators ─────────────────────────────────────────────────────────────────

// ROLE-ROOTED, NEVER PAGE-ROOTED (MOTIR-5386): the Workbench streams its tab behind an
// in-page `<Suspense>`, so a page-rooted text or test-id locator can match a hidden copy.

/** A tab of the strip — scoped to the strip's own landmark, since a row's door also
 *  names its sentence (*… is waiting on you*, *…等你处理*). */
const tabLink = (page: Page, name: RegExp, stripLabel = tabs.label) =>
  page.getByRole('navigation', { name: stripLabel }).getByRole('link', { name });
const queue = (page: Page) => page.getByRole('table', { name: tabs.toApprove });
/** THE row — by the gate id Postgres holds for the `manual_work` kind. */
const gateRow = (page: Page, gateId: string) => queue(page).getByTestId(`approval-row-${gateId}`);
const emptyHeading = (page: Page) =>
  page.getByRole('heading', { name: en.workbench.empty.approvals.title });

const overlay = (page: Page) => page.getByRole('dialog');
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const guideRows = (page: Page) =>
  overlay(page).getByTestId('guide-canvas').getByTestId('guide-row');
const composer = (page: Page) => rail(page).getByPlaceholder('Tell Motir AI how the step went…');

// ── Authoritative signals ────────────────────────────────────────────────────

const guideDoor = (page: Page) =>
  page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/guide' && r.request().method() === 'POST',
  );
const guideSettled = (page: Page) =>
  page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/guide/settle' && r.request().method() === 'POST',
  );

/** A guide turn LANDED — the settle answered 200 and its body says `guided`. */
async function landed(settled: Promise<Response>): Promise<void> {
  const r = await settled;
  const body = (await r.json()) as { outcome?: string };
  expect(r.status(), JSON.stringify(body)).toBe(200);
  expect(body.outcome, JSON.stringify(body)).toBe('guided');
}

/** One person turn, sent from the composer, to its landing. */
async function say(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  const opened = guideDoor(page);
  const settled = guideSettled(page);
  await rail(page).getByRole('button', { name: 'Send' }).click();
  expect((await opened).status()).toBe(200);
  await landed(settled);
}

/** The Workbench, landed on **Waiting on you** — the strip says so, on no other tab. */
async function expectOnWaitingOnYou(
  page: Page,
  label = tabs.toApprove,
  stripLabel = tabs.label,
): Promise<void> {
  await expect(page).toHaveURL(/\/workbench\?tab=approvals/);
  await expect(tabLink(page, new RegExp(label), stripLabel)).toHaveAttribute(
    'aria-current',
    'page',
    {
      timeout: FIRST_PAINT_MS,
    },
  );
}

/** The manual-work row is MOUNTED, and reads as the story says — asserted in that order. */
async function expectWaitingRow(page: Page, gateId: string, card: Card): Promise<Locator> {
  const row = gateRow(page, gateId);
  await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(row).toContainText(`${card.title} is waiting on you`);
  await expect(row).toContainText(card.key);
  return row;
}

test.beforeEach(async () => {
  await resetDatabase();
  resetJobsFixture();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('a run hands manual work to you — guided through and closed, or marked done', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7460');

  const t = await seedTenant(`manual-work-${Date.now()}@example.com`, 'LAUNCH');
  const api = await ingestContext(t.token, baseURL!);
  const first = await seedStory(t, {
    story: 'Take payments in production',
    code: 'Wire the checkout to the live keys',
    manual: 'Create the production Stripe account',
    steps: [
      'Sign up at stripe.com with the company email',
      'Verify the business details',
      'Copy the live secret key into the vault',
    ],
  });
  const second = await seedStory(t, {
    story: 'Send receipts by email',
    code: 'Render the receipt template',
    manual: 'Verify the sending domain at the DNS host',
    steps: ['Open the DNS console', 'Add the TXT record', 'Press Verify'],
  });

  const firstGate = await runStory(api, t, first);
  await signIn(page, t.email, PASSWORD);

  await chapter('A run reaches the manual work item — and says it is waiting on you', async () => {
    await page.goto('/runs');
    await page.getByTestId('run-open').first().click();
    await expect(overlay(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    const set = page.getByRole('region', { name: 'The set' });
    await expect(set.getByText(first.manual.key, { exact: false }).first()).toBeVisible();
    await expect(set.getByText(en.runs.skipReason.waitingOnYou).first()).toBeVisible();
    await beat();
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toHaveCount(0);
  });

  await chapter('The Workbench opens on Waiting on you, with the work item at 0/3', async () => {
    await page.goto('/workbench');
    await expectOnWaitingOnYou(page);
    const row = await expectWaitingRow(page, firstGate, first.manual);
    await expect(row).toContainText(
      approvals.manualSteps.replace('{done}', '0').replace('{total}', '3'),
    );
    await expect(row.getByRole('button', { name: approvals.markDone })).toBeVisible();
    await beat();
  });

  await chapter('Guide me through walks the three steps, and closes it on your yes', async () => {
    const row = gateRow(page, firstGate);
    await expect(row).toBeVisible();
    const [s1, s2, s3] = first.steps;

    queueTurn('Start with step 1: sign up at stripe.com with the company email.', [
      { type: 'current_step', rowId: s1 },
    ]);
    const opened = guideDoor(page);
    const settled = guideSettled(page);
    await row.getByRole('link', { name: /Guide me through/ }).click();
    expect((await opened).status()).toBe(200);
    await landed(settled);
    // The guide opened OVER the Workbench, in guide mode, on this card.
    await page.waitForURL(
      (url) =>
        url.pathname === '/workbench' &&
        url.searchParams.get('plan') === 'guide' &&
        url.searchParams.get('planItem') === first.manual.key,
    );
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(guideRows(page)).toHaveCount(3);
    await expect(guideRows(page).nth(0)).toHaveAttribute('data-current', 'true');

    queueTurn('Step 1 is done. Step 2: verify the business details.', [
      { type: 'tick', rowId: s1 },
      { type: 'current_step', rowId: s2 },
    ]);
    await say(page, 'Signed up.');
    await expect.poll(() => doneFlags(first.manual.id)).toEqual([true, false, false]);
    await expect(guideRows(page).nth(1)).toHaveAttribute('data-current', 'true');

    queueTurn('Step 2 is done. Last one: copy the live secret key into the vault.', [
      { type: 'tick', rowId: s2 },
      { type: 'current_step', rowId: s3 },
    ]);
    await say(page, 'Business details verified.');
    await expect.poll(() => doneFlags(first.manual.id)).toEqual([true, true, false]);
    await expect(guideRows(page).nth(2)).toHaveAttribute('data-current', 'true');

    queueTurn('Every step is done. Close the work item?', [
      { type: 'tick', rowId: s3 },
      { type: 'offer_close' },
    ]);
    await say(page, 'The key is in the vault.');
    await expect.poll(() => doneFlags(first.manual.id)).toEqual([true, true, true]);
    await expect(rail(page).getByTestId('guide-reply-closeYes')).toBeVisible();
    await beat();

    queueTurn('All three steps are done; closing it.', [{ type: 'close' }]);
    const closeOpened = guideDoor(page);
    const closeSettled = guideSettled(page);
    await rail(page).getByTestId('guide-reply-closeYes').click();
    expect((await closeOpened).status()).toBe(200);
    await landed(closeSettled);
    // The close is the person's answer to the gate: the card is Done and the question
    // was decided — read back from Postgres, not inferred from the rail.
    await expect.poll(() => statusOf(first.manual.id)).toBe('done');
    await expect.poll(() => gateState(firstGate)).toBe('approved');
  });

  await chapter('Back on the Workbench, nothing is waiting on you', async () => {
    await page.keyboard.press('Escape');
    await page.waitForURL((url) => !url.searchParams.has('plan'));
    await page.goto('/workbench?tab=approvals');
    await expectOnWaitingOnYou(page);
    await expect(emptyHeading(page)).toBeVisible();
    await expect(gateRow(page, firstGate)).toHaveCount(0);
    await beat();
  });

  const secondGate = await runStory(api, t, second);

  await chapter('A second story — Mark done from the row, and it leaves the tab', async () => {
    await page.goto('/workbench');
    await expectOnWaitingOnYou(page);
    const row = await expectWaitingRow(page, secondGate, second.manual);

    const write = actionWrite(page, '/workbench', secondGate);
    await row.getByRole('button', { name: approvals.markDone }).click();
    expect((await write).status()).toBe(200);
    await expect.poll(() => gateState(secondGate)).toBe('approved');
    await expect.poll(() => statusOf(second.manual.id)).toBe('done');
    // The row settles in place from the write's own answer …
    await expect(row).toContainText(en.approvalGate.manualWork.state.markedDone);
    await expect(row.getByRole('button', { name: approvals.markDone })).toHaveCount(0);

    // … and is gone on the next load.
    await page.reload();
    await expectOnWaitingOnYou(page);
    await expect(emptyHeading(page)).toBeVisible();
    await expect(gateRow(page, secondGate)).toHaveCount(0);
    await beat();
  });
});

test('in zh the tab reads 等你处理', async ({ page, baseURL }) => {
  const t = await seedTenant(`manual-work-rest-${Date.now()}@example.com`, 'REST');
  const api = await ingestContext(t.token, baseURL!);
  const s = await seedStory(t, {
    story: 'Ship the mobile build',
    code: 'Bump the build number',
    manual: 'Upload the build to the store',
    steps: ['Open the store console', 'Upload the archive', 'Submit for review'],
  });
  const gateId = await runStory(api, t, s);

  // ── 5. zh: the tab, and the row, through the catalogue's own strings ──────────
  // Signed in first, in English — the sign-in helper reads the English form.
  await signIn(page, t.email, PASSWORD);
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: baseURL! }]);
  await page.goto('/workbench?tab=approvals');
  await expectOnWaitingOnYou(page, zh.workbench.tabs.toApprove, zh.workbench.tabs.label);
  expect(zh.workbench.tabs.toApprove).toBe('等你处理');
  const zhRow = page
    .getByRole('table', { name: zh.workbench.tabs.toApprove })
    .getByTestId(`approval-row-${gateId}`);
  await expect(zhRow).toBeVisible();
  await expect(zhRow).toContainText(`${s.manual.title}等你处理`);
  await expect(zhRow.getByRole('button', { name: zh.workbench.approvals.markDone })).toBeVisible();
  await expect(tabLink(page, new RegExp(tabs.toApprove), zh.workbench.tabs.label)).toHaveCount(0);
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL! }]);
});
