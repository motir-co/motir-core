// Acceptance E2E — when the read finds a defect, Motir AI names its cause and offers
// to log it (Story MOTIR-9220 · MOTIR-9328). The receipt a person watches to accept
// the story, walking its Verification recipe in order. It replaces the retired walk
// of the same name (MOTIR-7042), which queued a `debug_bug` job that no longer exists.
//
//   THE RECORDED WALK (recipe steps 1–9, one chapter each). A described defect is
//   answered with ONE log-a-bug offer naming its write; Decline writes nothing and the
//   conversation carries on; a typed "yes, log it" files one new bug, outside Triage;
//   an offer naming a card that already covers it notes the diagnosis there; a card
//   edited in another tab after the offer is refused; the report widget's Debug with
//   Motir AI opens the conversation anchored on the bug just filed and its Confirm
//   adds the diagnosis below the person's own text; the orb's row pre-fills and sends
//   nothing; an answer whose code could not be read offers nothing; an offer survives
//   closing and reopening the overlay.
//
//   THE REST. Recipe step 10, a member who may ask but not edit, and step 11, the
//   offer in Chinese, each signed in as their own reader.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// Runs under playwright.acceptance.config.ts, where motir-ai is mocked UNDER the
// routes by `lib/test-ai-jobs-mock.ts`. The fixture writes what each answer DECIDED —
// its `offer` and a typed reply's `offerReply` — so nothing here tests motir-ai's
// judgement (the motir-ai story gate, MOTIR-9326, owns that). The real ask door,
// settle, offer doors, landing and Postgres all run; nothing is stubbed with
// `page.route`. The writes and refusals are proven at the service boundary by the
// core story gate (MOTIR-9327); this walk watches them happen.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on an AUTHORITATIVE signal: a response armed before the action that
// causes it (the intake, the ask door, the settle, the confirm and decline doors), or
// a Postgres row read back. Every "nothing was written" is a COUNT read at the moment
// it matters. `beat()` and the chapter hold are pacing, taken after the assertion
// that proved the step.
import type { Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAiAugmentReplan,
  markProjectOnboarded,
  type AiAugmentReplanSeed,
} from './_helpers/ai-augment-replan-seed';
import { declareSeam, queueAsk, readFixture, submitsOf } from './_helpers/mid-run-seam';
import { grantPaidAiPlanIfBilled } from './_helpers/billing';
import { setReaderLanguage } from './_helpers/reader-language';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../helpers/workspaceRoleFixtures';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import type { AskJobOutcome, AskLogBugOfferFixture } from '@/lib/test-ai-jobs-mock';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

test.describe.configure({ timeout: 300_000 });

const copy = en.planningWorkspace.logBugOffer;
const offerCopy = en.planningWorkspace.planOffer;
const zcopy = zh.planningWorkspace.logBugOffer;
const zOfferCopy = zh.planningWorkspace.planOffer;

/** The reply the retired debug landing gave an ungrounded report. It must never
 *  come back: an answer that cannot ground a defect simply offers nothing. */
const RETIRED_UNGROUNDED_REPLY = "I could not ground this report in the project's code";

// ── What motir-ai's answering session drafts ────────────────────────────────

const CSV_REF = 'lib/export/csv.ts';
const CSV_TITLE = 'CSV export drops the last row';
const CSV_DRAFT = {
  descriptionMd: [
    'The CSV export writes every row but the last.',
    '',
    '## Acceptance criteria',
    '',
    '- An export of N work items has N data rows.',
    '',
    '## Candidate mechanisms',
    '',
    'None of these is established.',
    '',
    '- The row loop stops at `length - 1`.',
    '- The stream is closed before the final chunk flushes.',
    '',
    '## Context refs',
    '',
    `- \`${CSV_REF}\``,
  ].join('\n'),
  explanationMd: 'People reconcile exports against the plan; a missing row reads as lost work.',
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 2,
  estimateMinutes: 60,
  difficulty: 'medium',
  contextRefs: [CSV_REF],
  candidateMechanisms: [
    'The row loop stops at `length - 1`.',
    'The stream is closed before the final chunk flushes.',
  ],
  grounded: true,
  groundingReason: 'indexed',
};

const MENTION_REF = 'lib/services/commentsService.ts';
const MENTION_TITLE = 'Saving a comment drops the @mention';
const MENTION_DRAFT = {
  ...CSV_DRAFT,
  descriptionMd: [
    'Saving a comment strips every `@mention` before the body is stored.',
    '',
    '## Acceptance criteria',
    '',
    '- A saved comment keeps its mention chips.',
    '',
    '## Candidate mechanisms',
    '',
    'None of these is established.',
    '',
    '- The sanitizer drops the `mention:` scheme.',
    '- The save serializes the editor before its mention nodes resolve.',
    '',
    '## Context refs',
    '',
    `- \`${MENTION_REF}\``,
  ].join('\n'),
  explanationMd: 'Mentions pull people into a thread; losing them silences it.',
  contextRefs: [MENTION_REF],
  // Two or none: one mechanism is a diagnosis, and `parseAuthoredBug` refuses it.
  candidateMechanisms: [
    'The sanitizer drops the `mention:` scheme.',
    'The save serializes the editor before its mention nodes resolve.',
  ],
};

function bugOffer(
  target: AskLogBugOfferFixture['target'],
  which: 'csv' | 'mention' = 'mention',
): AskLogBugOfferFixture {
  const csv = which === 'csv';
  return {
    kind: 'log_bug',
    title: csv ? CSV_TITLE : MENTION_TITLE,
    acceptanceCriteria: [
      csv
        ? 'An export of N work items has N data rows.'
        : 'A saved comment keeps its mention chips.',
    ],
    draft: csv ? CSV_DRAFT : MENTION_DRAFT,
    target,
    contextRefs: [csv ? CSV_REF : MENTION_REF],
  };
}

const offering = (
  text: string,
  target: AskLogBugOfferFixture['target'],
  which?: 'csv' | 'mention',
): AskJobOutcome => ({
  intent: 'ask',
  answer: text,
  citations: [which === 'csv' ? CSV_REF : MENTION_REF],
  offer: bugOffer(target, which),
});
const plainAnswer = (text: string): AskJobOutcome => ({ intent: 'ask', answer: text });
const NEW = { kind: 'new', key: null } as const;

// ── Locators ────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan|规划/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const sendButton = (page: Page, name = en.planningWorkspace.conversation.send) =>
  rail(page).getByRole('button', { name, exact: true });
const orb = (page: Page) => page.getByRole('button', { name: 'Motir AI', exact: true });
const calloutPanel = (page: Page) => page.getByRole('dialog', { name: 'Motir AI' });
const byId = (page: Page, id: string) => rail(page).getByTestId(id);
const answer = (page: Page, text: string) =>
  byId(page, 'plan-change-report').filter({ hasText: text });
const offers = (page: Page) =>
  rail(page).locator('[data-testid="plan-offer"][data-offer-kind="log_bug"]');
const latestOffer = (page: Page) => offers(page).last();
const writeLine = (page: Page) => latestOffer(page).getByTestId('log-bug-offer-write');
const confirmButton = (page: Page) => byId(page, 'plan-offer-confirm');
const declineButton = (page: Page) => byId(page, 'plan-offer-decline');
const outcomeLines = (page: Page) => byId(page, 'plan-change-debug-outcome');

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

// ── Authoritative signals ───────────────────────────────────────────────────

const ASK = '/api/ai/ask';
const SETTLE = '/api/ai/ask/settle';
const CONFIRM = '/api/ai/plan-change/session/offer/confirm';
const DECLINE = '/api/ai/plan-change/session/offer/decline';
const pathOf = (r: Response) => new URL(r.url()).pathname;
const posted = (page: Page, pathname: string) =>
  page.waitForResponse((r) => pathOf(r) === pathname && r.request().method() === 'POST');

/** The ask submits the server made — the answering session's boundary, counted. */
const askEntries = () => submitsOf('ask_project');

// ── Persisted state (through the owner's client, so RLS cannot zero them) ───

/** Bugs Motir filed straight into the project — the bug destination, not Triage. */
const plannedBugs = (projectId: string) =>
  adminDb.workItem.findMany({
    where: { projectId, kind: 'bug', reporterId: motirId, triagedAt: null },
    orderBy: { createdAt: 'asc' },
  });
const commentsOn = (workItemId: string) => adminDb.comment.count({ where: { workItemId } });
const projectComments = (projectId: string) =>
  adminDb.comment.count({ where: { workItem: { projectId } } });

/** The latest answer turn on a person's open project conversation. */
async function latestAnswerRow(userId: string) {
  const session = await adminDb.planChangeSession.findFirstOrThrow({
    where: { createdById: userId, endedAt: null, origin: 'conversation' },
    orderBy: { createdAt: 'desc' },
  });
  return adminDb.planChangeTurn.findFirstOrThrow({
    where: { sessionId: session.id, role: 'assistant' },
    orderBy: { seq: 'desc' },
  });
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function openProjectThread(page: Page, askLink: RegExp = /Ask about this project/) {
  await expect(orb(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await orb(page).click();
  await calloutPanel(page).getByRole('link', { name: askLink }).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

async function closeOverlay(page: Page) {
  await page.keyboard.press('Escape');
  await page.waitForURL(overlayClosed);
  await expect(workspace(page)).toHaveCount(0);
}

/** Send a turn on the open thread: the ask door's 200, then the settle's body. */
async function ask(page: Page, text: string, send = en.planningWorkspace.conversation.send) {
  const asked = posted(page, ASK);
  const settled = posted(page, SETTLE);
  await composer(page).fill(text);
  await sendButton(page, send).click();
  const askRes = await asked;
  expect(askRes.status(), await askRes.text()).toBe(200);
  const res = await settled;
  expect(res.status(), await res.text()).toBe(200);
  await expect(rail(page).getByText(text).first()).toBeVisible();
  return (await res.json()) as { outcome?: string };
}

interface Landing {
  outcome: string;
  workItemKey: string | null;
  createdInTriage: boolean;
}

/** Press Confirm on the live offer; the door's response. */
async function pressConfirm(page: Page): Promise<Response> {
  const door = posted(page, CONFIRM);
  await confirmButton(page).click();
  return door;
}

async function confirmed(page: Page): Promise<Landing> {
  const res = await pressConfirm(page);
  const body = (await res.json()) as { kind?: string; landing?: Landing };
  expect(res.status(), JSON.stringify(body)).toBe(200);
  expect(body.kind).toBe('log_bug');
  return body.landing!;
}

/** The Motir system account, in its own tenant, as the seed provisions it. */
async function seedMotir(): Promise<string> {
  const metaOwner = await usersService.createUser({
    email: `meta-owner-${Date.now()}@example.com`,
    password: 'meta-owner-pass-1',
    name: 'Meta owner',
  });
  const { workspace: metaWs } = await workspacesService.createWorkspace({
    name: 'moooon',
    ownerUserId: metaOwner.id,
  });
  const metaProject = await projectsService.createProject({
    name: 'motir',
    identifier: 'MOTIR',
    workspaceId: metaWs.id,
    actorUserId: metaOwner.id,
  });
  const { userId } = await seedSystemPrincipal({
    workspaceId: metaWs.id,
    projectId: metaProject.id,
  });
  return userId;
}

let seed: AiAugmentReplanSeed;
let motirId: string;

test.beforeEach(async () => {
  await resetDatabase();
  declareSeam({ ask: [] });
  seed = await seedAiAugmentReplan(`log-bug-offer-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  const workspaceRow = await adminDb.workspace.findUniqueOrThrow({
    where: { id: seed.ctx.workspaceId },
  });
  if (workspaceRow.organizationId) grantPaidAiPlanIfBilled(workspaceRow.organizationId);
  motirId = await seedMotir();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('the log-a-bug offer — offer, Decline, a typed yes, a covering card, a stale card, both entrances, no code, reopen', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9220');
  const userId = seed.ctx.userId;
  const projectId = seed.projectId;
  const DEFECT = 'saving a comment drops the @mention I typed';
  const DEFECT_ANSWER = `The likely cause is the sanitizer in ${MENTION_REF}: it drops the mention scheme.`;
  // The cards that already cover a defect — planned work, not Triage.
  const covering = await workItemsService.createWorkItem(
    { projectId, kind: 'bug', title: 'Comment @mentions vanish on save' },
    seed.ctx,
  );
  const exportCard = await workItemsService.createWorkItem(
    { projectId, kind: 'task', title: 'CSV export of the backlog' },
    seed.ctx,
  );

  await signIn(page, seed.email, seed.password);

  // ── 1 · THE OFFER ─────────────────────────────────────────────────────────
  await chapter('A described defect is answered with one offer to log it', async () => {
    queueAsk(offering(DEFECT_ANSWER, NEW));
    await page.goto('/dashboard');
    await openProjectThread(page);
    expect((await ask(page, DEFECT)).outcome).toBe('answered');
    await expect(answer(page, DEFECT_ANSWER)).toHaveCount(1);
    await expect(offers(page)).toHaveCount(1);
    const offer = latestOffer(page);
    await expect(offer).toHaveAttribute('data-offer-state', 'undecided');
    await expect(offer).toContainText(copy.label);
    await expect(offer.getByTestId('plan-offer-request')).toContainText(MENTION_TITLE);
    await expect(writeLine(page)).toHaveAttribute('data-target', 'new');
    await expect(writeLine(page)).toHaveText(copy.writeNew);
    await expect(confirmButton(page)).toHaveText(offerCopy.confirm);
    await expect(declineButton(page)).toHaveText(offerCopy.decline);
    expect(await plannedBugs(projectId)).toHaveLength(0);
    await beat();
  });

  // ── 2 · DECLINE ───────────────────────────────────────────────────────────
  await chapter('Decline writes nothing, and the conversation carries on', async () => {
    const declined = posted(page, DECLINE);
    await declineButton(page).click();
    expect((await declined).status()).toBe(200);
    await expect(latestOffer(page)).toHaveAttribute('data-offer-state', 'declined');
    await expect(latestOffer(page).getByTestId('plan-offer-declined')).toContainText(copy.recorded);
    await expect(confirmButton(page)).toHaveCount(0);
    await expect(declineButton(page)).toHaveCount(0);

    // The project's work items, seen from a second page: nothing was added.
    const second = await page.context().newPage();
    await second.goto('/items');
    await expect(second.getByRole('treegrid', { name: 'Work Items', exact: true })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(second.getByText(MENTION_TITLE)).toHaveCount(0);
    await second.close();
    expect(await plannedBugs(projectId)).toHaveLength(0);

    const OTHER_ANSWER = 'Two cards are open: the digest and the billing page.';
    queueAsk(plainAnswer(OTHER_ANSWER));
    expect((await ask(page, 'what else is open on the board?')).outcome).toBe('answered');
    await expect(answer(page, OTHER_ANSWER)).toHaveCount(1);
    // The new answer carries no offer; the declined one stays as the record.
    await expect(offers(page)).toHaveCount(1);
    await expect(confirmButton(page)).toHaveCount(0);
    await beat();
  });

  // ── 3 · A TYPED YES ───────────────────────────────────────────────────────
  let filedKey = '';
  await chapter('The defect again, and a typed yes files one new bug', async () => {
    queueAsk(offering(DEFECT_ANSWER, NEW));
    await ask(page, `again: ${DEFECT}`);
    await expect(latestOffer(page)).toHaveAttribute('data-offer-state', 'undecided');
    const offerTurn = await latestAnswerRow(userId);

    queueAsk({
      intent: 'ask',
      answer: 'Logged it.',
      offerReply: { seq: offerTurn.seq, kind: 'log_bug', decision: 'agree' },
    });
    await ask(page, 'yes, log it');
    await expect.poll(async () => (await plannedBugs(projectId)).length).toBe(1);
    const [bug] = await plannedBugs(projectId);
    filedKey = bug!.identifier;
    expect(bug!.title).toBe(MENTION_TITLE);
    expect(bug!.reporterId).toBe(motirId);
    expect(bug!.descriptionMd).toContain(`\`${MENTION_REF}\``);

    const line = outcomeLines(page).last();
    await expect(line).toHaveAttribute('data-outcome', 'diagnose');
    await expect(line).toContainText(`Filed ${filedKey}`);
    await expect(latestOffer(page)).toHaveAttribute('data-offer-state', 'confirmed');
    await beat();

    // The bug carries the diagnosis and the files the read cited.
    await page.goto(`/items/${filedKey}`);
    await expect(page.getByRole('heading', { name: 'Candidate mechanisms' })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(page.getByText(MENTION_REF).first()).toBeVisible();
    expect(bug!.triagedAt).toBeNull();
    await beat();
  });

  // ── 4 · A CARD THAT ALREADY COVERS IT ─────────────────────────────────────
  await chapter('An offer naming a card that covers it notes the diagnosis there', async () => {
    await page.goto('/dashboard');
    await openProjectThread(page);
    queueAsk(
      offering(`${covering.identifier} already covers this.`, {
        kind: 'existing',
        key: covering.identifier,
      }),
    );
    await ask(page, 'mentions vanish when I save a comment');
    await expect(writeLine(page)).toHaveAttribute('data-target', 'existing');
    await expect(writeLine(page)).toContainText(covering.identifier);
    await expect(writeLine(page)).toContainText('which already covers this');
    const bugsBefore = (await plannedBugs(projectId)).length;
    await beat();

    const landing = await confirmed(page);
    expect(landing).toMatchObject({ outcome: 'enrich_existing', workItemKey: covering.identifier });
    expect(await commentsOn(covering.id)).toBe(1);
    expect(await plannedBugs(projectId)).toHaveLength(bugsBefore);
    const line = outcomeLines(page).last();
    await expect(line).toHaveAttribute('data-outcome', 'enrich_existing');
    await expect(line).toContainText(`Added the diagnosis to ${covering.identifier}`);
    await beat();
  });

  // ── 5 · A CARD EDITED AFTER THE OFFER ─────────────────────────────────────
  await chapter('A card edited in another tab after the offer is refused', async () => {
    queueAsk(
      offering(
        `${exportCard.identifier} covers the export.`,
        {
          kind: 'existing',
          key: exportCard.identifier,
        },
        'csv',
      ),
    );
    await ask(page, 'the CSV export drops the last row');
    await expect(writeLine(page)).toContainText(exportCard.identifier);

    // The second tab edits the card the offer names.
    const second = await page.context().newPage();
    await second.goto(`/items/${exportCard.identifier}`);
    await expect(second.getByText('CSV export of the backlog').first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await workItemsService.updateWorkItem(
      exportCard.id,
      { title: 'CSV export of the backlog (all rows)' },
      seed.ctx,
    );
    await second.reload();
    await expect(second.getByText('CSV export of the backlog (all rows)').first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await second.close();
    const commentsBefore = await projectComments(projectId);
    const bugsBefore = (await plannedBugs(projectId)).length;

    const res = await pressConfirm(page);
    expect(res.status()).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('DEBUG_TARGET_CHANGED');
    const refusal = latestOffer(page).getByTestId('plan-offer-cannot-start');
    await expect(refusal).toHaveAttribute('data-reason', 'DEBUG_TARGET_CHANGED');
    await expect(refusal).toContainText(`${exportCard.identifier} changed after this offer`);
    await expect(latestOffer(page)).not.toHaveAttribute('data-offer-state', 'confirmed');
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: exportCard.id } });
    expect(row.title).toBe('CSV export of the backlog (all rows)');
    expect(await projectComments(projectId)).toBe(commentsBefore);
    expect(await plannedBugs(projectId)).toHaveLength(bugsBefore);
    await beat();
    await closeOverlay(page);
  });

  // ── 6 · THE REPORT WIDGET ─────────────────────────────────────────────────
  await chapter('Report a bug, then Debug with Motir AI on the success panel', async () => {
    const REPORT_DESCRIPTION =
      'Export a list of 10 work items to CSV — the file only has 9 rows. Expected all 10.';
    await page.goto('/items');
    await expect(page.getByRole('treegrid', { name: 'Work Items', exact: true })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await page.getByRole('button', { name: 'Report' }).first().click();
    const modal = page.getByRole('dialog', { name: 'Report something' });
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Bug', exact: true }).click();
    await modal.getByLabel('Title').fill(CSV_TITLE);
    await modal.getByLabel(/What happened\?/).fill(REPORT_DESCRIPTION);
    const created = page.waitForResponse(
      (r) => r.url().includes('/triage/submissions') && r.request().method() === 'POST',
    );
    await modal.getByRole('button', { name: 'Submit' }).click();
    const createdRes = await created;
    expect(createdRes.status()).toBe(201);
    const { identifier } = (await createdRes.json()) as { identifier: string };
    const triaged = await adminDb.workItem.findFirstOrThrow({ where: { identifier } });
    const debugButton = modal.getByRole('button', { name: 'Debug with Motir AI' });
    await expect(debugButton).toBeVisible();
    await expect(modal.getByTestId('report-debug-offer')).toContainText(
      'Nothing is written until you confirm.',
    );
    await beat();

    // The first turn is an ordinary anchored ask; its answer offers the anchored write.
    queueAsk(
      offering(
        `The export loop stops one row short in ${CSV_REF}.`,
        {
          kind: 'anchored',
          key: triaged.identifier,
        },
        'csv',
      ),
    );
    const asksBefore = askEntries().length;
    const asked = posted(page, ASK);
    const settled = posted(page, SETTLE);
    await debugButton.click();
    const askRes = await asked;
    expect(askRes.status()).toBe(200);
    const sent = JSON.parse(askRes.request().postData() ?? '{}') as {
      body?: string;
      anchorKey?: string;
    };
    expect(sent.anchorKey).toBe(triaged.identifier);
    expect(sent.body).toContain(CSV_TITLE);
    expect((await settled).status()).toBe(200);
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    // Sent once, as an ask — no debug job.
    await expect.poll(() => askEntries().length).toBe(asksBefore + 1);
    expect(submitsOf('debug_bug')).toHaveLength(0);

    await expect(writeLine(page)).toHaveAttribute('data-target', 'anchored');
    await expect(writeLine(page)).toContainText(triaged.identifier);
    await beat();

    const bugsBefore = (await plannedBugs(projectId)).length;
    const landing = await confirmed(page);
    expect(landing).toMatchObject({ outcome: 'diagnose', workItemKey: triaged.identifier });
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: triaged.id } });
    expect(row.descriptionMd!.startsWith(REPORT_DESCRIPTION)).toBe(true);
    expect(row.descriptionMd).toContain(`\`${CSV_REF}\``);
    expect(row.triagedAt).not.toBeNull();
    expect(await plannedBugs(projectId)).toHaveLength(bugsBefore);
    const line = outcomeLines(page).last();
    await expect(line).toHaveAttribute('data-outcome', 'diagnose');
    await expect(line).toContainText(`Wrote the diagnosis onto ${triaged.identifier}`);
    await beat();
    await closeOverlay(page);
  });

  // ── 7 · THE ORB ───────────────────────────────────────────────────────────
  await chapter('The orb’s Debug with Motir AI pre-fills and sends nothing', async () => {
    const asksBefore = askEntries().length;
    let asked = 0;
    const count = (r: Response) => {
      if (pathOf(r) === ASK && r.request().method() === 'POST') asked += 1;
    };
    page.on('response', count);
    await orb(page).click();
    const debugRow = calloutPanel(page).getByRole('link', { name: /Debug with Motir AI/ });
    await expect(debugRow).toContainText(en.shell.aiCallout.actions.debug.description);
    await debugRow.click();
    await page.waitForURL(overlayOpen);
    await expect(composer(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(composer(page)).toHaveValue(/Something is broken\. What happens:/);
    await beat();
    page.off('response', count);
    expect(asked).toBe(0);
    expect(askEntries()).toHaveLength(asksBefore);
    await composer(page).fill('');
  });

  // ── 8 · NO CODE, NO OFFER ─────────────────────────────────────────────────
  await chapter('An answer whose code could not be read offers nothing', async () => {
    const before = await offers(page).count();
    const UNREAD = 'I could not read the code just now, so this answer is from the plan alone.';
    queueAsk({ intent: 'ask', answer: UNREAD, citations: [], codeUnreadable: 'hydrate_failed' });
    await ask(page, 'why does the export drop a row?');
    await expect(answer(page, UNREAD)).toHaveCount(1);
    await expect(byId(page, 'plan-change-code-unreadable-ask-notice').last()).toBeVisible();
    await expect(offers(page)).toHaveCount(before);
    await beat();
  });

  // ── 9 · THE OFFER SURVIVES A REOPEN ───────────────────────────────────────
  await chapter('An offer is still there after the overlay is reopened', async () => {
    queueAsk(offering(DEFECT_ANSWER, NEW));
    await ask(page, 'and replies drop mentions too');
    await expect(latestOffer(page)).toHaveAttribute('data-offer-state', 'undecided');
    const offerTurn = await latestAnswerRow(userId);
    await closeOverlay(page);

    await openProjectThread(page);
    await expect(latestOffer(page)).toHaveAttribute('data-offer-state', 'undecided', {
      timeout: FIRST_PAINT_MS,
    });
    await expect(writeLine(page)).toHaveText(copy.writeNew);
    expect((await latestAnswerRow(userId)).id).toBe(offerTurn.id);
    await beat();

    const bugsBefore = (await plannedBugs(projectId)).length;
    const landing = await confirmed(page);
    expect(landing.outcome).toBe('diagnose');
    expect(await plannedBugs(projectId)).toHaveLength(bugsBefore + 1);
    await expect(latestOffer(page)).toHaveAttribute('data-offer-state', 'confirmed');
    await beat();

    // The closing check: the retired debug path left nothing behind.
    await expect(page.getByText(RETIRED_UNGROUNDED_REPLY)).toHaveCount(0);
    expect(submitsOf('debug_bug')).toHaveLength(0);
    expect((readFixture() as Record<string, unknown>)['debugBug']).toBeUndefined();
  });
});

// ═══ A member who may ask but not edit ══════════════════════════════════════

test('a member with ai:plan and without work_item:edit logs a bug, written by Motir', async ({
  page,
  chapter,
  beat,
}) => {
  const PASSWORD = 'ask-only-member-pass-3';
  const member = await usersService.createUser({
    email: `ask-only-${Date.now()}@example.com`,
    password: PASSWORD,
    name: 'Ari Asker',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: seed.ctx.workspaceId });
  const project = await adminDb.project.findUniqueOrThrow({ where: { id: seed.projectId } });
  const ownerCtx = { userId: seed.ctx.userId, workspaceId: seed.ctx.workspaceId };
  await addToProjectAs({
    key: project.identifier,
    actorUserId: seed.ctx.userId,
    ctx: ownerCtx,
    targetUserId: member.id,
    role: 'member',
  });
  const role = await createCustomRoleAs({
    projectId: seed.projectId,
    ctx: ownerCtx,
    name: 'Asks, does not edit',
    permissions: ['project:browse', 'ai:plan'],
  });
  await setProjectRoleAs({
    key: project.identifier,
    actorUserId: seed.ctx.userId,
    ctx: ownerCtx,
    targetUserId: member.id,
    role: role.id,
  });
  await projectsService.setActiveProject({
    userId: member.id,
    workspaceId: seed.ctx.workspaceId,
    projectId: seed.projectId,
  });

  await signIn(page, member.email, PASSWORD);
  await chapter('A member who cannot edit is offered to log the bug', async () => {
    queueAsk(offering('The sanitizer drops the mention.', NEW));
    await page.goto('/dashboard');
    await openProjectThread(page);
    await ask(page, 'my @mentions disappear when I save');
    await expect(latestOffer(page)).toHaveAttribute('data-offer-state', 'undecided');
    await expect(confirmButton(page)).toBeEnabled();
    await beat();
  });
  // Two chapters, not one: a single one records under the 15 s watchable floor.
  await chapter('Confirm files it, written by Motir', async () => {
    const landing = await confirmed(page);
    const bug = await adminDb.workItem.findFirstOrThrow({
      where: { identifier: landing.workItemKey! },
    });
    expect(bug.projectId).toBe(seed.projectId);
    expect(bug.reporterId).toBe(motirId);
    expect(bug.submittedByUserId).toBeNull();
    expect(bug.triagedAt).toBeNull();
    await expect(outcomeLines(page).last()).toContainText(`Filed ${bug.identifier}`);
    await beat();
  });
});

// ═══ In Chinese ══════════════════════════════════════════════════════════════

test('in Chinese, the offer row, Confirm and Decline render from the zh catalogue', async ({
  page,
  chapter,
  beat,
}) => {
  await signIn(page, seed.email, seed.password);
  await setReaderLanguage(page, seed.email, 'zh');
  await chapter('The offer in Chinese', async () => {
    queueAsk({
      intent: 'ask',
      answer: '可能的原因是清理函数丢掉了提及。',
      citations: [MENTION_REF],
      offer: bugOffer(NEW),
    });
    await page.goto('/dashboard');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh', { timeout: FIRST_PAINT_MS });
    await openProjectThread(page, new RegExp(zh.shell.aiCallout.actions.ask.title));
    await ask(page, '保存评论时我输入的 @提及 消失了', zh.planningWorkspace.conversation.send);

    const offer = latestOffer(page);
    await expect(offer).toHaveAttribute('data-offer-state', 'undecided');
    await expect(offer).toContainText(zcopy.label);
    await expect(writeLine(page)).toHaveText(zcopy.writeNew);
    await beat();
  });
  // Paced as two chapters: one alone records under the 15 s watchable floor.
  await chapter('Confirm and Decline in Chinese, and no English left', async () => {
    const offer = latestOffer(page);
    await expect(confirmButton(page)).toHaveText(zOfferCopy.confirm);
    await expect(declineButton(page)).toHaveText(zOfferCopy.decline);
    for (const english of [copy.label, copy.writeNew, copy.confirmHelp, offerCopy.decline]) {
      await expect(offer).not.toContainText(english);
    }
    await beat();
  });
});
