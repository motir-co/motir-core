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
import { createTestPerson } from './_helpers/testPerson';
import { grantPaidAiPlanIfBilled } from './_helpers/billing';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../helpers/workspaceRoleFixtures';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { AiJobsFixture, GuideJobOutcome, PlanJobOutcome } from '@/lib/test-ai-jobs-mock';
import en from '@/messages/en.json';

// ACCEPTANCE — Guide me through offers a RE-PLAN when the manual work item itself is
// wrong (Story MOTIR-8684 · MOTIR-8696; decision MOTIR-8685). The receipt a person
// watches to accept the story, walking its Verification recipe in order:
//
//   THE RECORDED WALK (cases 1–6, paced for a person). The guide says the work item
//   is wrong and cannot guide further, and offers a re-plan of the card; asked to,
//   it retargets the offer to the parent story; Decline closes the offer with
//   nothing planned, and Guide me through resumes at the unticked step; a fresh
//   offer is Confirmed, which opens the planner on the story with the guide's
//   request already SENT and the card parked at Planning; the Plans row names the
//   guided card and reopens the same session, and so does the confirmed offer —
//   neither sends the request again.
//
//   THE REST (cases 7–8, unrecorded). A stale STEP is still corrected in place with
//   no offer; and a member who may not plan never reaches a Confirm.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// motir-ai is mocked UNDER the routes by `lib/test-ai-jobs-mock.ts` (the lane's
// `E2E_TEST_AI_JOBS=1` intercept), exactly as `regression-guide-me-through.spec.ts`
// does: the real guide door → stream → settle → landing → Postgres chain runs, and
// so do the decline door, the offer's seed read and the per-card plan route. The
// fixture's `guide` queue answers each `guide_work_item` job, one entry per submit,
// in the shape the motir-ai handler (MOTIR-8688) emits — `needs_replan` carrying
// `reason`, `requestMd` and `targetKey` together — and its `plan` queue answers the
// planning run Confirm starts. Nothing is stubbed with `page.route`. The org is given
// a paid AI plan through the lane's BILLING fixture (its own boundary mock), because
// on this cloud-on lane a free org reads out of credits and Confirm would be refused
// before it opens anything.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on the AUTHORITATIVE signal (CLAUDE.md): a route's response armed
// before the action that causes it (the guide door, the settle whose BODY says
// `guided`, the decline door, the seed read, the per-card plan route, the planner
// turn), then the Postgres row read back. Every "nothing happened" is a COUNT read
// from Postgres or the fixture at the moment it matters — never what the page shows.

test.describe.configure({ timeout: 300_000 });

const JOBS_FIXTURE =
  process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ?? '/tmp/motir-acceptance-ai-jobs-fixture.json';

const offerCopy = en.planningWorkspace.guide.offer;
const guideSeedCopy = en.planningWorkspace.guideSeed;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

function readJobsFixture(): AiJobsFixture {
  try {
    return JSON.parse(readFileSync(JOBS_FIXTURE, 'utf8')) as AiJobsFixture;
  } catch {
    return {};
  }
}

/**
 * APPEND the next guide job's answer, keeping what the mock has recorded. ⚠️
 * `submitted` must survive: the mock indexes each queue by how many jobs of that kind
 * it has seen, so dropping it would hand the next job the first job's answer.
 */
function queueGuide(outcome: GuideJobOutcome): void {
  const f = readJobsFixture();
  f.guide = [...(f.guide ?? []), outcome];
  writeFileSync(JOBS_FIXTURE, JSON.stringify(f, null, 2));
}
const queueTurn = (messageMd: string, actions: unknown[]) =>
  queueGuide({ guideTurn: { messageMd, actions } });

/** The planner's answer to the next `plan` run, appended the same way. */
function queuePlan(outcome: PlanJobOutcome): void {
  const f = readJobsFixture();
  f.plan = [...(f.plan ?? []), outcome];
  writeFileSync(JOBS_FIXTURE, JSON.stringify(f, null, 2));
}

const submitsOf = (kind: string) =>
  (readJobsFixture().submitted ?? []).filter((s) => s.kind === kind && !s.refused);
const guideSubmits = () => submitsOf('guide_work_item');
const planSubmits = () => submitsOf('plan');

// ── What the guide emits ────────────────────────────────────────────────────

const WRONG_CARD =
  'This work item is wrong, and I can’t guide you any further: it moves the docs domain, but the team is retiring it.';
const RETIRING = 'we’re not moving this domain at all, we’re retiring it';
const PLANNER_ANSWER =
  'Understood — the domain is being retired, not moved. I’ll re-plan the story around retiring it.';

/** The request text in the handler's shape: the guide's words, then the code-built lines. */
function requestFor(target: { identifier: string }, card: { identifier: string; title: string }) {
  return [
    `**Re-plan ${target.identifier}.** ${card.identifier} — _${card.title}_ — moves the docs domain to a new host.`,
    '',
    '- What is wrong: the team is retiring the docs domain, so there is nothing to move.',
    `- What the person said: “${RETIRING}”.`,
    '',
    `Work item: ${card.identifier} — ${card.title}`,
    'Steps already ticked: 1',
  ].join('\n');
}

const replanTurn = (requestMd: string, targetKey: string, messageMd = WRONG_CARD) => ({
  messageMd,
  actions: [
    {
      type: 'needs_replan',
      reason: 'the docs domain is being retired, not moved',
      requestMd,
      targetKey,
    },
  ],
});

// ── Locators ────────────────────────────────────────────────────────────────

// Every locator is a role, or scoped to a live landmark (the overlay's dialog, the
// rail): a page-rooted strict locator can match the outgoing streamed subtree.
const door = (page: Page) => page.getByRole('button', { name: /Guide me through/ });
/** The guide rail and the planning rail share the landmark's name; one is mounted at a time. */
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const overlay = (page: Page) => page.getByRole('dialog');
const canvas = (page: Page) => overlay(page).getByTestId('guide-canvas');
const rows = (page: Page) => canvas(page).getByTestId('guide-row');
const currentRows = (page: Page) => canvas(page).locator('[data-testid="guide-row"][data-current]');
const composer = (page: Page) => rail(page).getByPlaceholder('Tell Motir AI how the step went…');
const guideTurns = (page: Page) => rail(page).getByTestId('guide-turn');

/** Every offer block in the rail, oldest first, and the one under the latest reply. */
const offers = (page: Page) => rail(page).getByTestId('guide-offer');
const latestOffer = (page: Page) => offers(page).last();
const confirmButton = (page: Page) =>
  page.getByRole('button', { name: offerCopy.confirm, exact: true });
const declineButton = (page: Page) =>
  page.getByRole('button', { name: offerCopy.decline, exact: true });

const userTurns = (page: Page) => rail(page).getByTestId('conversation-user-turn');
const sessionsList = (page: Page) => page.getByRole('list', { name: 'Planning conversations' });

// ── Authoritative signals ───────────────────────────────────────────────────

const posted = (page: Page, pathname: string) =>
  page.waitForResponse(
    (r) => new URL(r.url()).pathname === pathname && r.request().method() === 'POST',
  );
/** The guide DOOR's own POST — an open, a reply or a resume. */
const guideDoor = (page: Page) => posted(page, '/api/ai/guide');
/** The settle that LANDS a guide turn (resolving on any answer, so a broken landing
 *  fails HERE naming the server's reason rather than hanging to the timeout). */
const guideSettled = (page: Page) => posted(page, '/api/ai/guide/settle');
const declineDoor = (page: Page) => posted(page, '/api/ai/guide/offer/decline');
/** The per-card plan route the guide's request is SENT through. */
const planRoute = (page: Page, workItemId: string) =>
  posted(page, `/api/work-items/${workItemId}/ai/plan`);
/** The planner's utterance recorded on the planning session (the run's end). */
const plannerTurn = (page: Page) => posted(page, '/api/ai/plan-change/session/planner-turn');
/** The offer's seed read, addressed by its turn id. */
const seedRead = (page: Page, turnId: string) =>
  page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/ai/guide/offer/${turnId}/planning-seed` &&
      r.request().method() === 'GET',
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
  await rail(page).getByRole('button', { name: 'Send' }).click();
  expect((await opened).status()).toBe(200);
  await landed(settled);
}

/** Press Guide me through on the item page. `fresh` = a new conversation's first turn. */
async function pressGuide(page: Page, key: string, fresh: boolean): Promise<void> {
  const opened = guideDoor(page);
  const settled = fresh ? guideSettled(page) : null;
  await door(page).click();
  expect((await opened).status()).toBe(200);
  if (settled) await landed(settled);
  await expectGuideMode(page, key);
}

/** The overlay is in GUIDE mode — asserted before anything inside it. */
async function expectGuideMode(page: Page, key: string): Promise<void> {
  await page.waitForURL((url) => url.searchParams.get('plan') === 'guide');
  expect(new URL(page.url()).searchParams.get('planItem')).toBe(key);
  await expect(rail(page)).toBeVisible({ timeout: 60_000 });
  await expect(rail(page).getByTestId('planning-mode-chip')).toHaveText('guide');
  await expect(canvas(page)).toBeVisible();
}

async function closeOverlay(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForURL((url) => !url.searchParams.has('plan'));
  await expect(rail(page)).toHaveCount(0);
}

async function openItemPage(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
}

// ── Postgres read-backs (through the owner, so RLS cannot zero them) ────────

const storedRows = (workItemId: string) =>
  adminDb.workItemTodo.findMany({ where: { workItemId }, orderBy: { position: 'asc' } });
const commentsOn = (workItemId: string) =>
  adminDb.comment.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });
/** The project's PLANNING sessions — every session that is not a guide conversation. */
const planningSessions = (projectId: string) =>
  adminDb.planChangeSession.findMany({ where: { projectId, origin: { not: 'guide' } } });
const userTurnsOf = (sessionId: string) =>
  adminDb.planChangeTurn.findMany({ where: { sessionId, role: 'user' }, orderBy: { seq: 'asc' } });
async function cardState(id: string) {
  const w = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return {
    status: w.status,
    title: w.title,
    descriptionMd: w.descriptionMd,
    parentId: w.parentId,
    assigneeId: w.assigneeId,
    updatedAt: w.updatedAt.toISOString(),
  };
}
/** The latest guide REPLY on the card's guide conversation — the offer's turn. */
async function latestGuideReply(guidedKey: string) {
  const session = await adminDb.planChangeSession.findFirstOrThrow({
    where: { origin: 'guide', targetKeys: { has: guidedKey } },
    orderBy: { createdAt: 'desc' },
  });
  const turn = await adminDb.planChangeTurn.findFirstOrThrow({
    where: { sessionId: session.id, role: 'assistant' },
    orderBy: { seq: 'desc' },
  });
  return { sessionId: session.id, turnId: turn.id };
}

async function manualCard(
  seed: AiAugmentReplanSeed,
  title: string,
  extra: { parentId?: string; assigneeId?: string } = {},
) {
  return workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title, type: 'manual', executor: 'human', ...extra },
    seed.ctx,
  );
}

async function addSteps(seed: AiAugmentReplanSeed, workItemId: string, texts: string[]) {
  const ids: string[] = [];
  for (const text of texts) {
    ids.push((await workItemTodosService.addTodo(workItemId, { text }, seed.ctx)).todo.id);
  }
  return ids;
}

let seed: AiAugmentReplanSeed;

test.beforeEach(async () => {
  await resetDatabase();
  // A fresh fixture per run: nothing queued, nothing recorded.
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ submitted: [] }, null, 2));
  seed = await seedAiAugmentReplan(`guide-replan-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  const workspace = await adminDb.workspace.findUniqueOrThrow({
    where: { id: seed.ctx.workspaceId },
  });
  // Confirm SPENDS credits: on this cloud-on lane an org the billing fixture does not
  // name reads as free and out of credits, and the rail answers Confirm with the paywall.
  if (workspace.organizationId) grantPaidAiPlanIfBilled(workspace.organizationId);
});

test.afterAll(async () => {
  await db.$disconnect();
});

const STEPS = [
  'Export the docs site’s DNS records',
  'Point docs.acme.dev at the new host',
  'Move the TLS certificate',
  'Redirect the old paths',
];

test('Guide me through offers a re-plan — decline, resume, confirm, and come back', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-8684');

  const story = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'story', title: 'Move the docs domain' },
    seed.ctx,
  );
  const card = await manualCard(seed, 'Move docs.acme.dev to the new host', {
    parentId: story.id,
  });
  const [s1, s2] = await addSteps(seed, card.id, STEPS);
  await workItemTodosService.setTodoDone(s1!, true, seed.ctx);

  const onCard = requestFor(card, card);
  const onStory = requestFor(story, card);

  await signIn(page, seed.email, seed.password);

  // ── 1 · THE OFFER ─────────────────────────────────────────────────────────
  await chapter('The guide says the work item is wrong, and offers a re-plan', async () => {
    await openItemPage(page, card.identifier);
    queueTurn('Step 1 is done. Next: point docs.acme.dev at the new host.', [
      { type: 'current_step', rowId: s2 },
    ]);
    await pressGuide(page, card.identifier, true);
    await expect(rows(page)).toHaveCount(4);
    await expect(rows(page).nth(1)).toHaveAttribute('data-current', 'true');

    queueTurn(WRONG_CARD, replanTurn(onCard, card.identifier).actions);
    await say(page, RETIRING);

    await expect(guideTurns(page).last()).toContainText('can’t guide you any further');
    // No step card follows it: no reply chips, and the canvas marks no current step.
    await expect(rail(page).getByTestId('guide-replies')).toHaveCount(0);
    await expect(currentRows(page)).toHaveCount(0);
    await expect(canvas(page)).toContainText(offerCopy.walkStopped);

    const offer = latestOffer(page);
    await expect(offer).toHaveAttribute('data-offer-state', 'undecided');
    await expect(offer.getByTestId('guide-offer-request')).toContainText('Steps already ticked: 1');
    await expect(offer.getByTestId('guide-offer-request')).toContainText(RETIRING);
    await expect(offer.getByTestId('guide-offer-target')).toContainText(card.identifier);
    await expect(offer.getByRole('button', { name: offerCopy.confirm, exact: true })).toBeVisible();
    await expect(offer.getByRole('button', { name: offerCopy.decline, exact: true })).toBeVisible();
    expect(await commentsOn(card.id)).toHaveLength(1);
    await beat();
  });

  // ── 2 · RETARGET TO THE PARENT ────────────────────────────────────────────
  await chapter('Asked to, it aims the re-plan at the parent story instead', async () => {
    queueTurn(
      `You’re right — the wrongness sits in ${story.identifier}. I aimed the re-plan there.`,
      replanTurn(onStory, story.identifier).actions,
    );
    await say(page, 'target the parent instead');

    await expect(offers(page)).toHaveCount(2);
    const earlier = offers(page).first();
    await expect(earlier).toHaveAttribute('data-offer-state', 'superseded');
    await expect(earlier).toHaveText(offerCopy.replaced);
    await expect(earlier.getByRole('button')).toHaveCount(0);

    const offer = latestOffer(page);
    await expect(offer).toHaveAttribute('data-offer-state', 'undecided');
    await expect(offer.getByTestId('guide-offer-target')).toContainText(story.identifier);
    await expect(offer).toContainText(fill(offerCopy.targetElsewhere, { key: story.identifier }));
    await expect(confirmButton(page)).toHaveCount(1);
    expect(await commentsOn(card.id)).toHaveLength(2);
    await beat();
  });

  // ── 3 · DECLINE ───────────────────────────────────────────────────────────
  await chapter('Decline closes the offer — nothing is planned', async () => {
    const before = await cardState(card.id);
    const storyBefore = await cardState(story.id);
    const declined = declineDoor(page);
    await declineButton(page).click();
    expect((await declined).status()).toBe(200);

    const offer = latestOffer(page);
    await expect(offer).toHaveAttribute('data-offer-state', 'declined');
    await expect(offer.getByTestId('guide-offer-declined')).toContainText(offerCopy.declined);
    await expect(offer.getByRole('button')).toHaveCount(0);
    await expect(offer.getByTestId('guide-offer-resume')).toHaveText(
      fill(offerCopy.resumeAt, { n: 2 }),
    );

    // NOTHING LEFT BEHIND — read from Postgres and the fixture, not the page.
    expect(await planningSessions(seed.projectId)).toHaveLength(0);
    expect(await cardState(card.id)).toEqual(before);
    expect(await cardState(story.id)).toEqual(storyBefore);
    expect(planSubmits()).toHaveLength(0);
    // What the guide found is on the card — one comment per landed offer.
    const comments = await commentsOn(card.id);
    expect(comments).toHaveLength(2);
    expect(comments[1]!.bodyMd).toContain('the docs domain is being retired, not moved');
    await beat();
  });

  // ── 4 · GUIDE ME THROUGH RESUMES ──────────────────────────────────────────
  await chapter('Guide me through picks up again at the unticked step', async () => {
    await closeOverlay(page);
    const submitsBefore = guideSubmits().length;
    await pressGuide(page, card.identifier, false);
    // The SAME conversation: no new job, the declined offer in its history…
    expect(guideSubmits()).toHaveLength(submitsBefore);
    await expect(offers(page)).toHaveCount(2);
    await expect(latestOffer(page)).toHaveAttribute('data-offer-state', 'declined');
    // …and the walk resumes at step 2, the first unticked row.
    await expect(currentRows(page)).toHaveCount(1);
    await expect(rows(page).nth(1)).toHaveAttribute('data-current', 'true');
    await beat();
  });

  // ── 5 · CONFIRM ───────────────────────────────────────────────────────────
  let offerTurnId = '';
  let planSessionId = '';
  await chapter('Confirm opens the planner with the guide’s request already sent', async () => {
    queueTurn(
      `This work item is still wrong, and I can’t guide you any further. The re-plan is aimed at ${story.identifier}.`,
      replanTurn(onStory, story.identifier).actions,
    );
    queuePlan({ status: 'succeeded', turn: { message: PLANNER_ANSWER } });
    await say(page, RETIRING);
    await expect(latestOffer(page)).toHaveAttribute('data-offer-state', 'undecided');
    expect(await commentsOn(card.id)).toHaveLength(3);
    offerTurnId = (await latestGuideReply(card.identifier)).turnId;

    const seeded = seedRead(page, offerTurnId);
    const sent = planRoute(page, story.id);
    const recorded = plannerTurn(page);
    await confirmButton(page).click();

    // The planning overlay is addressed by the OFFER — its turn id, and none of its text.
    await page.waitForURL(
      (url) =>
        url.searchParams.get('planFrom') === 'guide-offer' &&
        url.searchParams.get('planOffer') === offerTurnId,
    );
    const address = decodeURIComponent(page.url());
    for (let i = 0; i + 10 <= onStory.length; i += 1) {
      expect(address, `the URL carries "${onStory.slice(i, i + 10)}"`).not.toContain(
        onStory.slice(i, i + 10),
      );
    }
    expect((await seeded).status()).toBe(200);
    const sentRes = await sent;
    expect(sentRes.status(), (await sentRes.text()).slice(0, 300)).toBe(200);
    expect((await recorded).status()).toBe(200);

    // The planning rail: the guide framing, the request as the SENT first turn, the answer.
    await expect(rail(page).getByTestId('planning-mode-chip')).toHaveText(guideSeedCopy.chip);
    await expect(rail(page).getByTestId('guide-origin-card')).toContainText(card.identifier);
    await expect(userTurns(page)).toHaveCount(1);
    await expect(userTurns(page)).toContainText(RETIRING);
    await expect(rail(page).getByText(PLANNER_ANSWER)).toBeVisible();

    // Read back: ONE planning session, stamped with the offer, holding the request verbatim.
    const sessions = await planningSessions(seed.projectId);
    expect(sessions).toHaveLength(1);
    planSessionId = sessions[0]!.id;
    expect(sessions[0]!.seedGuideTurnId).toBe(offerTurnId);
    expect((await userTurnsOf(planSessionId)).map((t) => t.body)).toEqual([onStory]);
    expect(planSubmits()).toHaveLength(1);
    expect((await cardState(card.id)).status).toBe('planning');
    await beat();

    // The item page, reloaded, shows the card at Planning.
    await closeOverlay(page);
    await openItemPage(page, card.identifier);
    // The Status field reads Planning, held by the plan's card hold for this reader.
    await expect(
      page.getByRole('status').filter({ hasText: 'Being planned in a conversation' }),
    ).toContainText('You are planning it with Motir AI.');
    await expect(
      page
        .getByRole('complementary')
        .filter({ has: page.getByRole('button', { name: 'Edit Status' }) }),
    ).toContainText(/Status\s*Planning/);
  });

  // ── 6 · THE WAY BACK ──────────────────────────────────────────────────────
  await chapter('The Plans row and the confirmed offer both return to the session', async () => {
    await page.goto('/plans');
    await expect(sessionsList(page)).toBeVisible({ timeout: 60_000 });
    // Relative, so it can also scope the row it sits in (`has` resolves inside the row).
    const seedLinkIn = page.getByRole('link', {
      name: fill(en.aiPlanning.sessions.seed.guideAria, { key: card.identifier }),
      exact: true,
    });
    const seedLink = sessionsList(page).locator(seedLinkIn);
    await expect(seedLink).toHaveCount(1);
    await expect(seedLink).toHaveText(`From the guide on ${card.identifier}`);
    await expect(seedLink).toHaveAttribute('href', new RegExp(`/items/${card.identifier}$`));

    // Open the session from its row: the same thread, nothing sent.
    const row = sessionsList(page).getByRole('listitem').filter({ has: seedLinkIn });
    await row.getByRole('link').first().click();
    await page.waitForURL((url) => url.searchParams.get('planSession') === planSessionId);
    await expect(rail(page)).toBeVisible({ timeout: 60_000 });
    await expect(rail(page).getByText(PLANNER_ANSWER)).toBeVisible();
    await expect(userTurns(page)).toHaveCount(1);
    expect(await userTurnsOf(planSessionId)).toHaveLength(1);
    expect(planSubmits()).toHaveLength(1);
    await closeOverlay(page);

    // The confirmed offer, from the guide: Re-plan started, and its link back.
    await openItemPage(page, card.identifier);
    await pressGuide(page, card.identifier, false);
    const confirmed = offers(page).last();
    await expect(confirmed).toHaveAttribute('data-offer-state', 'confirmed');
    await expect(confirmed.getByTestId('guide-offer-confirmed')).toContainText(offerCopy.started);
    await expect(confirmButton(page)).toHaveCount(0);
    await beat();

    const back = seedRead(page, offerTurnId);
    await confirmed.getByRole('button', { name: offerCopy.openSession, exact: true }).click();
    const backRes = await back;
    expect(backRes.status()).toBe(200);
    expect(
      ((await backRes.json()) as { seed: { seededSessionId: string | null } }).seed.seededSessionId,
    ).toBe(planSessionId);
    await expect(rail(page).getByText(PLANNER_ANSWER)).toBeVisible({ timeout: 60_000 });
    await expect(userTurns(page)).toHaveCount(1);

    // NEVER TWICE: still one session, one user turn, one planning job.
    expect(await planningSessions(seed.projectId)).toHaveLength(1);
    expect(await userTurnsOf(planSessionId)).toHaveLength(1);
    expect(planSubmits()).toHaveLength(1);
    await beat();
  });
});

test('a stale step is still fixed in place, and a member who may not plan reaches no Confirm', async ({
  page,
  browser,
}) => {
  // ── 7 · A STALE STEP IS FIXED IN PLACE ────────────────────────────────────
  const card = await manualCard(seed, 'Rotate the docs deploy key');
  const [, r2] = await addSteps(seed, card.id, [
    'Generate a new deploy key',
    'Add the key to the CI secrets',
    'Revoke the old key',
  ]);
  await signIn(page, seed.email, seed.password);
  await openItemPage(page, card.identifier);
  queueTurn('Start with step 1: generate a new deploy key.', []);
  await pressGuide(page, card.identifier, true);

  queueTurn('You’re right — I changed step 2.', [
    {
      type: 'revise_step',
      rowId: r2,
      reason: 'The key goes into the deploy settings, not the CI secrets.',
      text: 'Add the key to the deploy settings',
    },
  ]);
  await say(page, 'step 2’s wording is wrong');
  await expect
    .poll(async () => (await storedRows(card.id))[1]?.text)
    .toBe('Add the key to the deploy settings');
  await expect(rows(page).nth(1)).toContainText('Add the key to the deploy settings');
  await expect(offers(page)).toHaveCount(0);
  await expect(confirmButton(page)).toHaveCount(0);
  const replanComments = (await commentsOn(card.id)).filter((c) => /re-plan/i.test(c.bodyMd));
  expect(replanComments).toHaveLength(0);
  expect(await planningSessions(seed.projectId)).toHaveLength(0);
  await closeOverlay(page);

  // ── 8 · CANNOT PLAN ───────────────────────────────────────────────────────
  // ⚠️ The card asks for this member to REACH an offer and see the cannot-plan line.
  // The shipped product does not let them: the item page draws Guide me through only
  // for a reader holding `ai:plan` (`app/(authed)/items/[key]/_view.tsx`, A2.7), and the
  // guide door asserts `ai:plan` before it answers (`requireGuidableCard`), so the
  // `no_permission` arm of the offer is unreachable — the motir-core integration gate
  // (`guideReplanOfferStoryGate.test.ts`, case 9) records the same. What the browser
  // CAN prove is the claim the case exists for: this member is never shown a Confirm.
  const ownerCtx = seed.ctx;
  const role = await createCustomRoleAs({
    projectId: seed.projectId,
    ctx: ownerCtx,
    name: 'Edits, does not plan',
    permissions: ['project:browse', 'work_item:edit'],
  });
  const email = `guide-replan-noplan-${Date.now()}@example.com`;
  const member = await createTestPerson({ email, password: seed.password, name: 'Nora No-plan' });
  await workspacesService.addMember({ userId: member.id, workspaceId: ownerCtx.workspaceId });
  const project = await adminDb.project.findUniqueOrThrow({ where: { id: seed.projectId } });
  const as = { key: project.identifier, actorUserId: ownerCtx.userId, ctx: ownerCtx };
  await addToProjectAs({ ...as, targetUserId: member.id, role: 'member' });
  await setProjectRoleAs({ ...as, targetUserId: member.id, role: role.id });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: member.id, workspaceId: ownerCtx.workspaceId } },
    data: { activeProjectId: seed.projectId },
  });
  const theirs = await manualCard(seed, 'Renew the docs TLS certificate', {
    assigneeId: member.id,
  });
  await addSteps(seed, theirs.id, ['Request the certificate', 'Install it']);

  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    await signIn(other, email, seed.password);
    await openItemPage(other, theirs.identifier);
    await expect(other.getByRole('heading', { level: 1 })).toContainText(theirs.title);
    await expect(door(other)).toHaveCount(0);
    // The door itself refuses them, so no guide turn — and so no offer — can exist.
    queueTurn(WRONG_CARD, replanTurn(requestFor(theirs, theirs), theirs.identifier).actions);
    const submitsBefore = guideSubmits().length;
    const refused = await other.request.post('/api/ai/guide', {
      data: { itemKey: theirs.identifier },
    });
    expect(refused.status()).toBe(403);
    expect(guideSubmits()).toHaveLength(submitsBefore);
    expect(
      await adminDb.planChangeSession.count({
        where: { origin: 'guide', targetKeys: { has: theirs.identifier } },
      }),
    ).toBe(0);
    await expect(other.getByTestId('guide-offer')).toHaveCount(0);
    await expect(confirmButton(other)).toHaveCount(0);
  } finally {
    await context.close();
  }
});
