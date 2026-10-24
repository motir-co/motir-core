import type { APIRequestContext, Cookie, Locator, Page, Response } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { choiceBody, seedChoiceGate, type ChoiceGateSeed } from './_helpers/choice-gate-seed';
import { workItemsService } from '@/lib/services/workItemsService';
import en from '@/messages/en.json';

// A PICKED OPTION IS PLANNED — THE ACCEPTANCE RECEIPT (Story MOTIR-6069 · Subtask
// MOTIR-6438; `docs/decisions/picked-option-planning.md`,
// `docs/decisions/picked-option-planning-starts.md`; design MOTIR-6432, revision 3).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A person picks an option on a choice and confirms. The band then ASKS whether to plan
// the follow-up with Motir AI, and says the planner starts right away with nothing to
// send. On yes the planner opens on the choice's PARENT story — never the finished choice
// card — framed as the follow-up to that choice, and the choice is already SENT as the
// person's first message: nobody types and nobody presses Send. The Plans page names the
// conversation as the follow-up to the choice, and the chosen record's Plan with AI door
// returns to that conversation without sending anything a second time.
//
// ── THE SEAMS THIS LANE USES ────────────────────────────────────────────────
//
//   * The choices raise their gates on create, through the service (`seedChoiceGate`'s
//     arrangement), and the story is its parent.
//   * The planner's send reaches motir-ai through the lane's jobs mock — the route, the
//     session and its seed stamp are real. That mock settles a plan run with nothing
//     proposed; what this receipt is about is the turn that was SENT FOR the person.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: the server action's response (armed before the press),
// the seed read's response, the automatic send's own response, the planning address, the
// transcript's turn, the seeded session's row. `chapter()` / `beat()` only HOLD a state
// already proven.

// 240s, not the lane's 480s: the paced run takes about 40s, and a hang must fail INSIDE
// the shard's budget so its report and trace upload (a cancelled shard leaves none).
test.describe.configure({ timeout: 240_000 });

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

const planAsk = en.approvalGate.planAsk;
const planDoor = en.approvalGate.planDoor;
const replanAsk = en.approvalGate.replanAsk;
const ch = en.approvalGate.choice;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const OPTION = 'A managed bucket';
const BEST_FOR = 'faster to the goal';
const GATES = 'The report exports story — the storage adapter and the download page.';
const NONE_REASON = 'Neither option keeps the files in our own bucket, which legal requires.';

// ── Locators ─────────────────────────────────────────────────────────────────

const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const transcript = (page: Page) => rail(page).getByRole('log');
// A user turn on the thread. The bubble carries no label (MOTIR-7497), so the
// turn is found by its own test id rather than a `turn 1` caption.
const USER_TURN = 'conversation-user-turn';

const overlayFor = (page: Page, key: string) =>
  page.getByRole('dialog', {
    name: fill(en.approvalOverlay.dialogTitle, {
      kind: en.workbench.approvals.kind.decision_choice,
      key,
    }),
    exact: true,
  });
const pickAsk = (scope: Locator) => scope.getByTestId('pick-plan-ask');
const pickDoor = (scope: Locator | Page, key: string) =>
  scope.getByRole('link', { name: fill(planDoor.aria, { item: key }), exact: true });
const rowFor = (page: Page, key: string): Locator =>
  page
    .getByRole('table', { name: en.workbench.tabs.toApprove })
    .getByTestId(/^approval-row-/)
    .filter({ hasText: key });

// ── Signals ──────────────────────────────────────────────────────────────────

const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
    { timeout: FIRST_PAINT_MS },
  );
const seedRead = (page: Page, gateId: string): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname ===
        `/api/approval-gates/${encodeURIComponent(gateId)}/planning-seed` &&
      res.request().method() === 'GET',
    { timeout: FIRST_PAINT_MS },
  );
/** The AUTOMATIC send of a card-anchored first turn (the anchored plan route). */
const anchoredSend = (page: Page, cardId: string): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === `/api/work-items/${cardId}/ai/plan` &&
      res.request().method() === 'POST',
    { timeout: FIRST_PAINT_MS },
  );
/** The AUTOMATIC send of a project-anchored first turn (the one door). */
const projectSend = (page: Page): Promise<Response> =>
  page.waitForResponse(
    (res) => new URL(res.url()).pathname === '/api/ai/ask' && res.request().method() === 'POST',
    { timeout: FIRST_PAINT_MS },
  );
const plannerOpenFrom = (gateId: string) => (url: URL) =>
  url.searchParams.get('planFrom') === 'refused-gate' &&
  url.searchParams.get('planGate') === gateId &&
  !url.searchParams.has('approval');
const plannerClosed = (url: URL) => !url.searchParams.has('plan');

async function gateOf(card: { id: string }): Promise<string> {
  const gate = await adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId: card.id, kind: 'decision_choice' },
    orderBy: { createdAt: 'desc' },
  });
  return gate.id;
}

/** How many USER turns the sessions this gate seeded hold — the send-once proof. */
async function seededUserTurns(gateId: string): Promise<number> {
  const sessions = await adminDb.planChangeSession.findMany({ where: { seedGateId: gateId } });
  return adminDb.planChangeTurn.count({
    where: { sessionId: { in: sessions.map((s) => s.id) }, role: 'user' },
  });
}

async function closePlanner(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForURL(plannerClosed, { timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toHaveCount(0);
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

/**
 * OPEN A PAGE SIGNED IN — clearing the RE-CONSENT HOLD the way a person does
 * (`shell-session.ts`'s `clearReconsentHold`, MOTIR-3713). A seeded person agreed to
 * the legal documents as they stood when they were created; a spec earlier in the
 * shard can change what is published, and the lane (`MOTIR_CLOUD=true`) then holds
 * them at `/re-consent`. Pressing the real Agree button keeps the gate exercised
 * rather than bypassed. Then it asserts the page landed where it was sent, naming
 * the URL, so a lost session fails here instead of hanging on the next click.
 */
async function openSignedIn(page: Page, path: string): Promise<void> {
  const destination = new URL(path, 'http://x').pathname;
  await page.goto(path);
  await page.waitForURL(
    (url) => url.pathname.startsWith('/re-consent') || url.pathname === destination,
    { timeout: FIRST_PAINT_MS },
  );
  if (new URL(page.url()).pathname.startsWith('/re-consent')) {
    await page
      .getByRole('button', { name: /^Agree (and|to both and|to all and) continue$/ })
      .click({ timeout: FIRST_PAINT_MS });
  }
  await expect(page, `landed on ${page.url()}`).toHaveURL(
    new RegExp(`${escapeRe(destination)}(\\?|$)`),
    { timeout: FIRST_PAINT_MS },
  );
}

/** Open the choice full screen from the To-approve list, pick OPTION and confirm. */
async function chooseOption(page: Page, key: string): Promise<Locator> {
  await openSignedIn(page, '/workbench?tab=approvals');
  await rowFor(page, key)
    .getByRole('button', { name: en.workbench.approvals.review, exact: true })
    .click({ timeout: FIRST_PAINT_MS });
  const dialog = overlayFor(page, key);
  await expect(dialog).toHaveCount(1, { timeout: FIRST_PAINT_MS });
  // The PORT is mounted before anything is asserted about it. The option's ROW is the
  // hit target, as for a person — the radio inside it is visually hidden — and the
  // checked radio is the committed signal.
  const row = dialog.locator('label[data-option-id]').filter({ hasText: OPTION });
  await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
  await row.click({ timeout: FIRST_PAINT_MS });
  await expect(dialog.getByRole('radio', { name: new RegExp(escapeRe(OPTION)) })).toBeChecked();
  await dialog
    .getByRole('button', { name: fill(ch.verb.choose, { label: OPTION }), exact: true })
    .click({ timeout: FIRST_PAINT_MS });
  const action = serverAction(page);
  await dialog
    .getByRole('button', { name: fill(ch.confirm.proceed, { label: OPTION }), exact: true })
    .click({ timeout: FIRST_PAINT_MS });
  expect((await action).status()).toBe(200);
  return dialog;
}

interface Card {
  id: string;
  identifier: string;
  title: string;
}

const CHOICE_BODY = choiceBody({
  question: 'Where do exported reports live once they are generated?',
  situation: 'two workflows',
  evidence: 'Exports average 40 MB once PDFs are attached.',
  options: [
    { label: 'Postgres', bestFor: 'less to operate', why: 'One store, already backed up.' },
    { label: OPTION, bestFor: BEST_FOR, why: 'Cheap storage, signed links for free.' },
  ],
  gates: GATES,
});

test.describe('a picked option is planned', () => {
  let seed: ChoiceGateSeed;
  let story: Card;
  let choice: Card;
  let second: Card;
  let rootChoice: Card;
  let session: Cookie[];
  let api: APIRequestContext;

  // Everything the database holds is written BEFORE the page exists, so the recording
  // starts on the product rather than on a blank page while rows are inserted.
  test.beforeEach(async ({ playwright, baseURL }) => {
    await resetDatabase();
    seed = await seedChoiceGate(Date.now().toString(36));
    // An ONBOARDED project, as every real project with choices is: with
    // `onboardingRanAt` null the planner opens on its onboarding routing first,
    // which waits on the lane's job worker and stalls behind its scheduled bursts —
    // the planning receipts all stamp it (`roadmap-seed.ts`, `live-drawing-seed.ts`).
    await adminDb.project.update({
      where: { id: seed.projectId },
      data: { onboardingRanAt: new Date() },
    });
    const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
    const s = await workItemsService.createWorkItem(
      { projectId: seed.projectId, kind: 'story', title: 'Report exports' },
      ctx,
    );
    story = { id: s.id, identifier: s.identifier, title: 'Report exports' };
    const child = async (title: string): Promise<Card> => {
      const c = await workItemsService.createWorkItem(
        {
          projectId: seed.projectId,
          kind: 'subtask',
          parentId: story.id,
          title,
          type: 'choice',
          executor: 'human',
          assigneeId: seed.ownerId,
          descriptionMd: CHOICE_BODY,
        },
        ctx,
      );
      return { id: c.id, identifier: c.identifier, title };
    };
    choice = await child('Choose where exported reports live');
    second = await child('Choose where the export archive lives');
    const r = await workItemsService.createWorkItem(
      {
        projectId: seed.projectId,
        kind: 'task',
        title: 'Choose where the audit log lives',
        type: 'choice',
        executor: 'human',
        assigneeId: seed.ownerId,
        descriptionMd: CHOICE_BODY,
      },
      ctx,
    );
    rootChoice = { id: r.id, identifier: r.identifier, title: 'Choose where the audit log lives' };

    // The planner's run settles through the lane's motir-ai mock.
    writeFileSync(
      JOBS_FIXTURE,
      JSON.stringify({ ask: [{ intent: 'ask', answer: 'Noted.', citations: [] }], submitted: [] }),
    );

    api = await playwright.request.newContext({
      baseURL: baseURL!,
      extraHTTPHeaders: { origin: baseURL! },
    });
    const signedIn = await api.post('/api/auth/sign-in/email', {
      data: { email: seed.ownerEmail, password: seed.password },
    });
    expect(signedIn.status(), (await signedIn.text()).slice(0, 300)).toBe(200);
    session = (await api.storageState()).cookies;
    await api.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await page.context().addCookies(session);
    await stubAiAccess(page);
  });

  // On a failure, say WHERE the page ended up: a lost session reads as the public site.
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('final-url', { body: page.url(), contentType: 'text/plain' });
      console.warn(`[picked-option] ${testInfo.title} ended on ${page.url()}`);
    }
  });

  test('pick an option, say yes — the planner starts on the story with the follow-up already sent', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6069');
    let gateId = '';

    await chapter('Choose an option — the band ASKS to plan the follow-up', async () => {
      const dialog = await chooseOption(page, choice.identifier);
      const band = pickAsk(dialog);
      await expect(band).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(band.getByText(planAsk.title, { exact: true })).toBeVisible();
      await expect(band.getByText(fill(planAsk.opens, { key: story.identifier }))).toBeVisible();
      await expect(band.getByText(planAsk.nothingToSend)).toBeVisible();
      await expect(band.getByRole('button', { name: planAsk.yes, exact: true })).toBeFocused();
      await expect(rail(page)).toHaveCount(0);
      await beat();

      gateId = await gateOf(choice);
      const read = seedRead(page, gateId);
      const sent = anchoredSend(page, story.id);
      await band
        .getByRole('button', { name: planAsk.yes, exact: true })
        .click({ timeout: FIRST_PAINT_MS });
      await page.waitForURL(plannerOpenFrom(gateId), { timeout: FIRST_PAINT_MS });
      expect((await read).status()).toBe(200);
      // THE AUTOMATIC SEND — on the STORY, not the choice card; nobody pressed Send.
      expect((await sent).status()).toBe(200);
    });

    await chapter(
      'The planner has started — the choice is the first message, sent for you',
      async () => {
        await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(rail(page).getByTestId('planning-mode-chip')).toHaveText(
          en.planningWorkspace.mode.followUp,
        );
        await expect(rail(page).getByTestId('pick-followup-card')).toContainText(choice.identifier);
        await expect(transcript(page).getByTestId(USER_TURN).first()).toBeVisible();
        await expect(transcript(page)).toContainText(`The option chosen: ${OPTION}`);
        await expect(transcript(page)).toContainText(`Best if you want: ${BEST_FOR}`);
        await expect(transcript(page)).toContainText(GATES);
        await expect(composer(page)).toHaveValue('');
        // The conversation is stamped with the pick, on the story's scope, with ONE turn.
        await expect.poll(async () => seededUserTurns(gateId)).toBe(1);
        const [stamped] = await adminDb.planChangeSession.findMany({
          where: { seedGateId: gateId },
        });
        expect(stamped!.targetKeys).toEqual([story.identifier]);
        await beat();
        await closePlanner(page);
      },
    );

    await chapter('Plans names the conversation as the follow-up to the choice', async () => {
      await page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: 'Plans' })
        .click({ timeout: FIRST_PAINT_MS });
      await page.waitForURL('**/plans', { timeout: FIRST_PAINT_MS });
      const seedLink = page
        .getByRole('list', { name: 'Planning conversations' })
        .getByTestId('plan-session-seed');
      await expect(seedLink).toHaveCount(1, { timeout: FIRST_PAINT_MS });
      await expect(seedLink).toHaveText(
        new RegExp(`Follow-up to ${escapeRe(choice.identifier)}\\s*·\\s*chose ${escapeRe(OPTION)}`),
      );
      await expect(seedLink).not.toContainText('Re-plan');
      await expect(seedLink).toHaveAttribute('href', `/items/${choice.identifier}`);
      await beat();
    });

    await chapter(
      'The chosen record’s door returns to the conversation — nothing is sent twice',
      async () => {
        await openSignedIn(page, `/items/${choice.identifier}`);
        const door = pickDoor(page, choice.identifier);
        await expect(door).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(door).toHaveText(planDoor.label);
        await expect(page.getByText(/planning owed/)).toHaveCount(0);
        await beat();
        const read = seedRead(page, gateId);
        await door.click({ timeout: FIRST_PAINT_MS });
        await page.waitForURL(plannerOpenFrom(gateId), { timeout: FIRST_PAINT_MS });
        expect((await read).status()).toBe(200);
        await expect(transcript(page)).toContainText(`The option chosen: ${OPTION}`, {
          timeout: FIRST_PAINT_MS,
        });
        await expect(composer(page)).toHaveValue('');
        // Still exactly one first turn: the reopen resumed, it did not send.
        expect(await seededUserTurns(gateId)).toBe(1);
        await beat();
      },
    );
  });

  test('Not now leaves the door, and the door starts the planning as yes does', async ({
    page,
  }) => {
    const dialog = await chooseOption(page, choice.identifier);
    const band = pickAsk(dialog);
    await expect(band).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.keyboard.press('Escape');
    await expect(band).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(rail(page)).toHaveCount(0);
    const door = pickDoor(dialog, choice.identifier);
    await expect(door).toBeFocused();

    const gateId = await gateOf(choice);
    const sent = anchoredSend(page, story.id);
    await door.click({ timeout: FIRST_PAINT_MS });
    await page.waitForURL(plannerOpenFrom(gateId), { timeout: FIRST_PAINT_MS });
    expect((await sent).status()).toBe(200);
    await expect(transcript(page)).toContainText(`The option chosen: ${OPTION}`, {
      timeout: FIRST_PAINT_MS,
    });
    await expect.poll(async () => seededUserTurns(gateId)).toBe(1);
  });

  test('a root choice starts the planning at the PROJECT, and the turn says why', async ({
    page,
  }) => {
    const dialog = await chooseOption(page, rootChoice.identifier);
    const band = pickAsk(dialog);
    await expect(band.getByText(planAsk.opensProject)).toBeVisible({ timeout: FIRST_PAINT_MS });
    const gateId = await gateOf(rootChoice);
    const sent = projectSend(page);
    await band
      .getByRole('button', { name: planAsk.yes, exact: true })
      .click({ timeout: FIRST_PAINT_MS });
    await page.waitForURL(plannerOpenFrom(gateId), { timeout: FIRST_PAINT_MS });
    expect((await sent).status()).toBe(200);
    await expect(transcript(page)).toContainText(
      en.planningWorkspace.refusalSeed.pick.noContainer,
      { timeout: FIRST_PAINT_MS },
    );
    await expect.poll(async () => seededUserTurns(gateId)).toBe(1);
    const [stamped] = await adminDb.planChangeSession.findMany({ where: { seedGateId: gateId } });
    expect(stamped!.targetKeys).toEqual([]);
  });

  test('None of these still asks to RE-PLAN, with the refusal turn pre-filled and unsent', async ({
    page,
  }) => {
    await openSignedIn(page, '/workbench?tab=approvals');
    await rowFor(page, second.identifier)
      .getByRole('button', { name: en.workbench.approvals.review, exact: true })
      .click({ timeout: FIRST_PAINT_MS });
    const dialog = overlayFor(page, second.identifier);
    await expect(dialog).toHaveCount(1, { timeout: FIRST_PAINT_MS });
    await dialog
      .getByRole('button', { name: ch.verb.noneOfThese, exact: true })
      .click({ timeout: FIRST_PAINT_MS });
    await dialog.getByLabel(en.approvalGate.reason.choice.label).fill(NONE_REASON);
    const action = serverAction(page);
    await dialog
      .getByRole('button', { name: en.approvalGate.reason.choice.proceed, exact: true })
      .click({ timeout: FIRST_PAINT_MS });
    expect((await action).status()).toBe(200);

    const band = dialog.getByRole('group', {
      name: fill(replanAsk.title, { key: second.identifier }),
      exact: true,
    });
    await expect(band).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(pickAsk(dialog)).toHaveCount(0);
    const gateId = await gateOf(second);
    await band
      .getByRole('button', { name: replanAsk.yes, exact: true })
      .click({ timeout: FIRST_PAINT_MS });
    await page.waitForURL(plannerOpenFrom(gateId), { timeout: FIRST_PAINT_MS });
    await expect(composer(page)).toHaveValue(new RegExp(`“${escapeRe(NONE_REASON)}”`), {
      timeout: FIRST_PAINT_MS,
    });
    await expect(transcript(page).getByTestId(USER_TURN)).toHaveCount(0);
    expect(await seededUserTurns(gateId)).toBe(0);
  });

  test('a reader who may not edit sees no door on the chosen record', async ({ browser, page }) => {
    // Chosen by the owner, off camera.
    await chooseOption(page, choice.identifier);
    const viewer = await adminDb.user.findUniqueOrThrow({ where: { email: seed.viewerEmail } });
    // Roles live on the WORKSPACE since MOTIR-6168 (`plan-history-seed.ts`).
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: viewer.id, workspaceId: seed.workspaceId } },
      data: { workspaceRole: 'viewer', roleDefinitionId: null },
    });
    const context = await browser.newContext({ baseURL: page.url().split('/workbench')[0] });
    const viewerPage = await context.newPage();
    await stubAiAccess(viewerPage);
    const signedIn = await viewerPage.request.post('/api/auth/sign-in/email', {
      data: { email: seed.viewerEmail, password: seed.password },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(signedIn.status()).toBe(200);
    await openSignedIn(viewerPage, `/items/${choice.identifier}`);
    await expect(viewerPage.getByText(`chose`, { exact: false }).first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(viewerPage.getByTestId('pick-plan-door')).toHaveCount(0);
    await context.close();
  });
});
