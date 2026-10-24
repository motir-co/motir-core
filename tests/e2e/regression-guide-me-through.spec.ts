import { readFileSync, writeFileSync } from 'node:fs';
import type { Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAiAugmentReplan,
  markProjectOnboarded,
  type AiAugmentReplanSeed,
} from './_helpers/ai-augment-replan-seed';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import type { AiJobsFixture, GuideJobOutcome } from '@/lib/test-ai-jobs-mock';

// ACCEPTANCE — Guide me through a manual work item (Story MOTIR-7459 ·
// MOTIR-7469). The receipt a person watches to accept the story, walking its
// Verification recipe:
//
//   THE RECORDED WALK (cases 1–5, paced for a person). A manual card with four
//   steps shows Guide me through where a code card shows Run. Pressing it opens
//   the overlay in guide mode with step 1 current; "done" ticks it; the overlay
//   closes and reopens where it left off; the person ticks step 2 themselves;
//   Motir AI corrects step 3 and the card's description when told; the last two
//   steps tick and the card closes to Done with a summary comment.
//
//   THE REST (cases 6–8, unrecorded). A card with no list gets one proposed and
//   saved; another is walked without saving and starts over; a code card keeps
//   its Run section; an out-of-credits door ticks nothing.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// motir-ai is mocked UNDER the routes by `lib/test-ai-jobs-mock.ts` (the lane's
// `E2E_TEST_AI_JOBS=1` undici intercept), so the real guide door → stream →
// settle → landing → Postgres chain runs. The fixture's `guide` queue is what
// each `guide_work_item` job answers, one entry per submit, queued just before
// the action that submits it.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on the AUTHORITATIVE signal (CLAUDE.md): the door's 200, the
// settle whose BODY says `guided` (armed before the action that causes it), and
// for a tick or a close the persisted row read back from Postgres. The canvas
// and the rail are asserted only after the landing they render has returned.

test.describe.configure({ timeout: 180_000 });

const JOBS_FIXTURE =
  process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ?? '/tmp/motir-acceptance-ai-jobs-fixture.json';

function readJobsFixture(): AiJobsFixture {
  try {
    return JSON.parse(readFileSync(JOBS_FIXTURE, 'utf8')) as AiJobsFixture;
  } catch {
    return {};
  }
}

/**
 * APPEND the next guide job's answer, keeping what the mock has recorded. ⚠️
 * `submitted` must survive: the mock indexes the queue by how many guide jobs it
 * has seen, so dropping it would hand the next job the first job's answer.
 */
function queueGuide(outcome: GuideJobOutcome): void {
  const f = readJobsFixture();
  f.guide = [...(f.guide ?? []), outcome];
  writeFileSync(JOBS_FIXTURE, JSON.stringify(f, null, 2));
}
const queueTurn = (messageMd: string, actions: unknown[]) =>
  queueGuide({ guideTurn: { messageMd, actions } });

const guideSubmits = () =>
  (readJobsFixture().submitted ?? []).filter((s) => s.kind === 'guide_work_item');

// ── Locators ────────────────────────────────────────────────────────────────

// Every locator is a role, or scoped to a live landmark (the overlay's dialog, the
// rail): a page-rooted strict locator can match the outgoing streamed subtree.
const door = (page: Page) => page.getByRole('button', { name: /Guide me through/ });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const overlay = (page: Page) => page.getByRole('dialog');
const canvas = (page: Page) => overlay(page).getByTestId('guide-canvas');
const rows = (page: Page) => canvas(page).getByTestId('guide-row');
/** A PROPOSED list is the shipped read face (`TodoRowReadOnly`), not guide rows. */
const proposedRows = (page: Page) => canvas(page).getByTestId('guide-list').getByRole('listitem');
const composer = (page: Page) => rail(page).getByPlaceholder('Tell Motir AI how the step went…');

// ── Authoritative signals ───────────────────────────────────────────────────

/** The guide DOOR's own POST — an open, a reply or a retry. */
const guideDoor = (page: Page) =>
  page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/guide' && r.request().method() === 'POST',
  );

/**
 * The settle that LANDS a guide turn. Resolving on any answer rather than only
 * on `guided` makes a broken landing fail HERE, naming the server's reason,
 * instead of hanging to the test timeout.
 */
const guideSettled = (page: Page) =>
  page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/guide/settle' && r.request().method() === 'POST',
  );

async function landed(res: Promise<Response>): Promise<void> {
  const r = await res;
  const body = (await r.json()) as { outcome?: string };
  expect(r.status(), JSON.stringify(body)).toBe(200);
  expect(body.outcome, JSON.stringify(body)).toBe('guided');
}

/** One person turn, sent from the composer, to its landing. */
async function say(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  const opened = guideDoor(page);
  const settled = guideSettled(page);
  await page.getByRole('button', { name: 'Send' }).click();
  expect((await opened).status()).toBe(200);
  await landed(settled);
}

/** One reply chip (`save`, `walk`, `closeYes`…), to its landing. */
async function reply(page: Page, chip: string): Promise<void> {
  const opened = guideDoor(page);
  const settled = guideSettled(page);
  await rail(page).getByTestId(`guide-reply-${chip}`).click();
  expect((await opened).status()).toBe(200);
  await landed(settled);
}

/** The overlay is in GUIDE mode — asserted before anything inside it. */
async function expectGuideMode(page: Page, key: string): Promise<void> {
  await page.waitForURL((url) => url.searchParams.get('plan') === 'guide');
  expect(new URL(page.url()).searchParams.get('planItem')).toBe(key);
  await expect(rail(page)).toBeVisible({ timeout: 60_000 });
  await expect(rail(page).getByTestId('planning-mode-chip')).toHaveText('guide');
  await expect(canvas(page)).toBeVisible();
}

/** The card's rows as Postgres has them — through the owner, so RLS cannot zero them. */
const storedRows = (workItemId: string) =>
  adminDb.workItemTodo.findMany({ where: { workItemId }, orderBy: { position: 'asc' } });
const doneFlags = async (workItemId: string) =>
  (await storedRows(workItemId)).map((r) => r.doneAt !== null);

async function openItemPage(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
}

async function manualCard(seed: AiAugmentReplanSeed, title: string, descriptionMd?: string) {
  return workItemsService.createWorkItem(
    {
      projectId: seed.projectId,
      kind: 'task',
      title,
      type: 'manual',
      executor: 'human',
      ...(descriptionMd ? { descriptionMd } : {}),
    },
    seed.ctx,
  );
}

async function addSteps(
  seed: AiAugmentReplanSeed,
  workItemId: string,
  steps: Array<{ text: string; commandText?: string }>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const step of steps) {
    ids.push((await workItemTodosService.addTodo(workItemId, step, seed.ctx)).todo.id);
  }
  return ids;
}

let seed: AiAugmentReplanSeed;

test.beforeEach(async () => {
  await resetDatabase();
  // A fresh fixture per run: nothing queued, nothing recorded.
  writeFileSync(JOBS_FIXTURE, JSON.stringify({}, null, 2));
  seed = await seedAiAugmentReplan(`guide-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
});

test.afterAll(async () => {
  await db.$disconnect();
});

const STEPS = [
  { text: 'Sign in to the email provider' },
  { text: 'Create the sending domain', commandText: 'motir mail domain add acme.dev' },
  { text: 'Add the A record at the registrar' },
  { text: 'Send a test email' },
];

test('Guide me through — a four-step manual card walked to Done', async ({
  page,
  context,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7459');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  const card = await manualCard(
    seed,
    'Set up transactional email',
    'Send the product’s receipts through SendGrid.',
  );
  const [s1, s2, s3, s4] = await addSteps(seed, card.id, STEPS);

  await signIn(page, seed.email, seed.password);

  await chapter('A manual work item offers Guide me through', async () => {
    await openItemPage(page, card.identifier);
    await expect(door(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Run', exact: true })).toHaveCount(0);
    await beat();
  });

  await chapter('Step 1, ticked when it is done', async () => {
    queueTurn('Start with step 1: sign in to the email provider. Tell me when you are in.', [
      { type: 'current_step', rowId: s1 },
    ]);
    const opened = guideDoor(page);
    const settled = guideSettled(page);
    await door(page).click();
    expect((await opened).status()).toBe(200);
    await landed(settled);
    await expectGuideMode(page, card.identifier);
    await expect(rows(page)).toHaveCount(4);
    await expect(rows(page).nth(0)).toHaveAttribute('data-current', 'true');
    await beat();

    queueTurn('Step 1 is done. Next, create the sending domain — the command is on the step.', [
      { type: 'tick', rowId: s1 },
      { type: 'current_step', rowId: s2 },
    ]);
    await say(page, 'Done, I am signed in.');
    await expect.poll(() => doneFlags(card.id)).toEqual([true, false, false, false]);
    await expect(rows(page).nth(0)).toHaveAttribute('data-todo-done', 'true');
    await expect(rows(page).nth(1)).toHaveAttribute('data-current', 'true');

    await rows(page).nth(1).getByRole('button', { name: 'Copy command' }).click();
    await expect(rows(page).nth(1).getByRole('button', { name: 'Copy command' })).toHaveText(
      'Command copied',
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'motir mail domain add acme.dev',
    );
    await beat();
  });

  await chapter('Close, come back, and tick a step yourself', async () => {
    await page.keyboard.press('Escape');
    await page.waitForURL((url) => !url.searchParams.has('plan'));
    await expect(door(page)).toBeVisible();

    // The door RESUMES the conversation: no new job, and step 2 is still current.
    const before = guideSubmits().length;
    const reopened = guideDoor(page);
    await door(page).click();
    expect((await reopened).status()).toBe(200);
    await expectGuideMode(page, card.identifier);
    await expect(rows(page).nth(1)).toHaveAttribute('data-current', 'true');
    expect(guideSubmits()).toHaveLength(before);

    // The person ticks step 2 on the canvas — the shipped to-do write, no turn.
    await rows(page).nth(1).getByRole('checkbox').click();
    await expect.poll(() => doneFlags(card.id)).toEqual([true, true, false, false]);
    await expect(rail(page).getByTestId('guide-person-marker')).toContainText('You ticked step 2');
    await beat();

    queueTurn('Step 2 is ticked. Step 3: add the A record at the registrar.', [
      { type: 'current_step', rowId: s3 },
    ]);
    await say(page, 'I ticked step 2. What is next?');
    await expect(rows(page).nth(2)).toHaveAttribute('data-current', 'true');
  });

  await chapter('Motir AI corrects the step and the work item', async () => {
    queueTurn('You are right — the provider wants a CNAME. I changed step 3.', [
      {
        type: 'revise_step',
        rowId: s3,
        reason: 'The provider verifies the domain with a CNAME record.',
        text: 'Add the CNAME record at the registrar',
      },
      { type: 'current_step', rowId: s3 },
    ]);
    await say(page, 'Step 3 is wrong, the provider asks for a CNAME, not an A record.');
    await expect(rows(page).nth(2)).toContainText('Add the CNAME record at the registrar');
    await expect
      .poll(async () => (await storedRows(card.id))[2]?.text)
      .toBe('Add the CNAME record at the registrar');
    await beat();

    queueTurn('Noted. I updated the card’s description to say Postmark.', [
      {
        type: 'edit_item',
        reason: 'The team sends through Postmark.',
        descriptionMd: 'Send the product’s receipts through Postmark.',
        previous: { descriptionMd: 'Send the product’s receipts through SendGrid.' },
      },
    ]);
    await say(page, 'We use Postmark, not SendGrid.');
    await expect(rail(page).getByTestId('guide-outcome').last()).toContainText(
      `Edited the description of`,
    );
    await expect
      .poll(
        async () =>
          (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).descriptionMd,
      )
      .toContain('Postmark');
    await beat();
  });

  await chapter('Finish, and close the work item', async () => {
    queueTurn('Steps 3 and 4 are done — every step is. Close the work item?', [
      { type: 'tick', rowId: s3 },
      { type: 'tick', rowId: s4 },
      { type: 'offer_close' },
    ]);
    await say(page, 'The record is in and the test email arrived.');
    await expect.poll(() => doneFlags(card.id)).toEqual([true, true, true, true]);
    await expect(rail(page).getByTestId('guide-reply-closeYes')).toBeVisible();
    await beat();

    queueTurn('All four steps are done; closing it with a summary.', [{ type: 'close' }]);
    await reply(page, 'closeYes');
    await expect
      .poll(
        async () => (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status,
      )
      .toBe('done');
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(1);

    // The item page reads Done, its four rows ticked, the corrections kept.
    await page.keyboard.press('Escape');
    await page.waitForURL((url) => !url.searchParams.has('plan'));
    await openItemPage(page, card.identifier);
    await expect(page.getByText('Add the CNAME record at the registrar').first()).toBeVisible();
    await expect(
      page.getByText('Send the product’s receipts through Postmark.').first(),
    ).toBeVisible();
    await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(4);
    await expect(door(page)).toHaveCount(0);
    await beat();
  });
});

test('a card with no list, a walk that is not saved, a code card, and no credits', async ({
  page,
}) => {
  const proposal = (ids: string[]) => ({
    type: 'propose_todos',
    rows: [
      { id: ids[0], text: 'Open the DNS console' },
      { id: ids[1], text: 'Add the TXT record' },
    ],
  });
  await signIn(page, seed.email, seed.password);

  // ── 6. No rows: steps are proposed; saving writes them to the card ────────
  const listless = await manualCard(seed, 'Verify the domain');
  await openItemPage(page, listless.identifier);
  queueTurn('This card has no steps yet. Here are two. A walk without saving cannot be resumed.', [
    proposal(['tmp-1', 'tmp-2']),
  ]);
  let opened = guideDoor(page);
  let settled = guideSettled(page);
  await door(page).click();
  expect((await opened).status()).toBe(200);
  await landed(settled);
  await expectGuideMode(page, listless.identifier);
  await expect(canvas(page)).toHaveAttribute('data-guide-list', 'proposed');
  await expect(proposedRows(page)).toHaveCount(2);
  expect(await storedRows(listless.id)).toHaveLength(0);

  queueTurn('Saved both steps to the work item.', [
    {
      type: 'write_todos',
      rows: [
        { fromId: 'tmp-1', text: 'Open the DNS console', done: false },
        { fromId: 'tmp-2', text: 'Add the TXT record', done: false },
      ],
    },
  ]);
  await reply(page, 'save');
  await expect
    .poll(async () => (await storedRows(listless.id)).map((r) => r.text))
    .toEqual(['Open the DNS console', 'Add the TXT record']);
  await expect(canvas(page)).toHaveAttribute('data-guide-list', 'saved');
  await page.keyboard.press('Escape');
  await page.waitForURL((url) => !url.searchParams.has('plan'));
  await openItemPage(page, listless.identifier);
  await expect(page.getByText('Add the TXT record').first()).toBeVisible();

  // ── 6b. Walked without saving: a tick is the walk's, and the door starts over ─
  const temporary = await manualCard(seed, 'Rotate the webhook secret');
  await openItemPage(page, temporary.identifier);
  queueTurn('No steps yet. Here are two.', [proposal(['tmp-1', 'tmp-2'])]);
  opened = guideDoor(page);
  settled = guideSettled(page);
  await door(page).click();
  expect((await opened).status()).toBe(200);
  await landed(settled);
  await expectGuideMode(page, temporary.identifier);

  queueTurn('Walking it without saving. Start with step 1.', [
    { type: 'current_step', rowId: 'tmp-1' },
  ]);
  await reply(page, 'walk');
  await expect(canvas(page)).toHaveAttribute('data-guide-list', 'temporary');
  queueTurn('Step 1 is done on this walk.', [{ type: 'tick', rowId: 'tmp-1' }]);
  await say(page, 'Done with step 1.');
  await expect(rows(page).nth(0)).toHaveAttribute('data-todo-done', 'true');
  await expect(rows(page).nth(0).getByTestId('guide-tag-notSaved')).toBeVisible();
  expect(await storedRows(temporary.id)).toHaveLength(0);

  await page.keyboard.press('Escape');
  await page.waitForURL((url) => !url.searchParams.has('plan'));
  queueTurn('No steps yet. Here are two.', [proposal(['tmp-1', 'tmp-2'])]);
  const submitsBefore = guideSubmits().length;
  opened = guideDoor(page);
  settled = guideSettled(page);
  await door(page).click();
  expect((await opened).status()).toBe(200);
  await landed(settled);
  await expectGuideMode(page, temporary.identifier);
  // It STARTED OVER: a new job, the list proposed afresh, nothing ticked.
  expect(guideSubmits()).toHaveLength(submitsBefore + 1);
  await expect(canvas(page)).toHaveAttribute('data-guide-list', 'proposed');
  await expect(proposedRows(page)).toHaveCount(2);
  await expect(canvas(page).getByTestId('guide-tag-notSaved')).toHaveCount(0);
  expect(await storedRows(temporary.id)).toHaveLength(0);
  await page.keyboard.press('Escape');
  await page.waitForURL((url) => !url.searchParams.has('plan'));

  // ── 7. A code card: the Run section, and no door ──────────────────────────
  const code = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title: 'Fix the CSV export', type: 'code' },
    seed.ctx,
  );
  await openItemPage(page, code.identifier);
  await expect(page.getByRole('heading', { name: 'Run', exact: true })).toBeVisible();
  await expect(door(page)).toHaveCount(0);

  // ── 8. Out of credits: the shipped paywall, and no tick ───────────────────
  const unpaid = await manualCard(seed, 'Renew the TLS certificate');
  await addSteps(seed, unpaid.id, [{ text: 'Request the certificate' }]);
  await openItemPage(page, unpaid.identifier);
  queueGuide({ submit: 'out_of_credits' });
  opened = guideDoor(page);
  await door(page).click();
  expect((await opened).status()).toBe(402);
  await expectGuideMode(page, unpaid.identifier);
  await expect(
    rail(page).getByRole('heading', {
      name: /out of credits|AI planning is a paid feature/,
    }),
  ).toBeVisible();
  expect(await doneFlags(unpaid.id)).toEqual([false]);
  expect(guideSubmits().at(-1)).toMatchObject({ refused: true });
});
