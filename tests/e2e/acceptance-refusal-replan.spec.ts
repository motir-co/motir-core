import { writeFileSync } from 'node:fs';
import type { APIRequestContext, Cookie, Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { developmentSection, openDevelopmentOverlay } from './_helpers/development-decide';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import {
  DECISION_REPO,
  decisionHeadSha,
  seedDecisionGate,
  type DecisionGateSeed,
  type SeededDecisionCard,
} from './_helpers/decision-gate-seed';
import { decisionBody } from './_helpers/decision-confirm-gate-seed';
import { choiceBody, seedChoiceGate } from './_helpers/choice-gate-seed';
import { workItemsService } from '@/lib/services/workItemsService';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import type { GithubMergeControl } from '@/lib/test-github-merge-mock';
import en from '@/messages/en.json';

// A REFUSED DECISION OPENS THE PLANNER — THE ACCEPTANCE RECEIPT (Story MOTIR-6068 ·
// Subtask MOTIR-6213; ADR `approval-gates.md` §10f / §10h; design MOTIR-6206, amended
// 2026-09-25 so the planner is OFFERED, never opened on the press).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A person refuses a decision — Request changes on an agent's decision, an Overturn of a
// person's decision, None of these on a choice — and says why. The band then ASKS whether
// to re-plan the card with Motir AI; nothing opens until they say yes. Yes opens the
// planner anchored on that card with a first turn that quotes their words, UNSENT. The
// decided record keeps a Re-plan with AI door back to it; after a send, the door returns
// to the conversation, and the Plans page names the card it re-plans. A gate the reader
// cannot browse opens the planner unseeded, and none of its words reach the page.
//
// ── THE SEAMS THIS LANE USES ────────────────────────────────────────────────
//
//   * The agent's decision: its pull request and green checks are SIGNED deliveries to the
//     real webhook route, and the link CAPTURES the decision document through the GitHub
//     merge seam — `regression-decision-gate.spec.ts`'s arrangement, one card of it.
//   * The person's decision and the choice raise their gates on create, through the
//     service, into the SAME project, so one reader walks all three refusals.
//   * The planner's send reaches motir-ai through the lane's jobs mock
//     (`lib/test-ai-jobs-mock.ts`) — the route, the session and its seed stamp are real.
//     That mock settles a plan run with nothing proposed, so the planner's answer on the
//     rail is its "nothing came back to change" line; what this receipt is about is the
//     turn that was sent, and the conversation the door returns to.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: the server action's response (armed before the press),
// the seed read's response, the planning address, the composer's value, the transcript's
// turn, the record band's door. `chapter()` / `beat()` only HOLD a state already proven.
//
// ⚠️ THE 19xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 480_000 });

const PR = { number: 19101 } as const;
const REPO = `${DECISION_REPO.owner}/${DECISION_REPO.name}`;
const DOC = 'docs/decisions/page-body.md';
const DOCUMENT = [
  '# ADR: How a page stores its body',
  '',
  '## Decision',
  '',
  'Store the body per workspace, shared by every project in it.',
].join('\n');

const REQUEST_REASON = 'we agreed on per-project, not per-workspace';
const OVERTURN_NOTE = 'We said exports stay browsable for a year — that was the whole point.';
const NONE_REASON = 'Neither option keeps the files in our own bucket, which legal requires.';
const FOREIGN_REASON = 'Confidential: the Hamburg customer is leaving at renewal.';

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;
const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

const ask = en.approvalGate.replanAsk;
const door = en.approvalGate.replanDoor;
const dc = en.approvalGate.decisionConfirm;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Locators ─────────────────────────────────────────────────────────────────

const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const transcript = (page: Page) => rail(page).getByRole('log');
// A user turn on the thread. The bubble carries no label (MOTIR-7497), so the
// turn is found by its own test id rather than a `turn 1` caption.
const USER_TURN = 'conversation-user-turn';

const askBand = (scope: Locator, key: string) =>
  scope.getByRole('group', { name: fill(ask.title, { key }), exact: true });
const replanDoor = (scope: Locator, key: string) =>
  scope.getByRole('link', { name: fill(door.aria, { item: key }), exact: true });

const overlayFor = (page: Page, kind: keyof typeof en.workbench.approvals.kind, key: string) =>
  page.getByRole('dialog', {
    name: fill(en.approvalOverlay.dialogTitle, { kind: en.workbench.approvals.kind[kind], key }),
    exact: true,
  });

const rowFor = (page: Page, key: string): Locator =>
  page
    .getByRole('table', { name: en.workbench.tabs.toApprove })
    .getByTestId(/^approval-row-/)
    .filter({ hasText: key });

// ── Signals ──────────────────────────────────────────────────────────────────

/** Arm a wait for the next server action's response — a POST carrying `Next-Action`. */
const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

/** Arm a wait for the refusal seed read of ONE gate (MOTIR-6208's route). */
const seedRead = (page: Page, gateId: string): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname ===
        `/api/approval-gates/${encodeURIComponent(gateId)}/planning-seed` &&
      res.request().method() === 'GET',
  );

/** The planning overlay's address, opened from a refused gate. */
const plannerOpenFrom = (gateId: string) => (url: URL) =>
  url.searchParams.get('planFrom') === 'refused-gate' &&
  url.searchParams.get('planGate') === gateId &&
  !url.searchParams.has('approval');
const plannerClosed = (url: URL) => !url.searchParams.has('plan');

async function gateOf(card: { id: string }, kind: string): Promise<string> {
  const gate = await adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId: card.id, kind: kind as never },
    orderBy: { createdAt: 'desc' },
  });
  return gate.id;
}

async function closePlanner(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForURL(plannerClosed);
  await expect(rail(page)).toHaveCount(0);
}

// ── The GitHub side of the agent's decision ─────────────────────────────────

function writeControl(control: GithubMergeControl): void {
  writeFileSync(CONTROL_PATH, JSON.stringify(control));
}

/** Open the card's pull request, LINK it (the link captures the decision document), and
 *  turn it green — as the signed-in owner, through the real webhook route and link door. */
async function deliverGreen(api: APIRequestContext, card: SeededDecisionCard): Promise<void> {
  const headRef = `decision/${card.identifier.toLowerCase()}-${PR.number}`;
  const opened = await postSignedWebhook(
    api,
    'pull_request',
    pullRequestPayload({
      action: 'opened',
      number: PR.number,
      title: card.title,
      headRef,
      state: 'open',
      merged: false,
      repo: DECISION_REPO,
    }),
  );
  expect(opened.status()).toBe(200);
  // `linkPr`'s door (`/api/_test/pull-request-links`), driven from the API context.
  const linked = await api.post('/api/_test/pull-request-links', {
    data: {
      workItemId: card.id,
      owner: DECISION_REPO.owner,
      name: DECISION_REPO.name,
      number: PR.number,
      headRef,
      baseRef: DECISION_REPO.defaultBranch,
      title: null,
    },
  });
  expect(linked.status(), (await linked.text()).slice(0, 300)).toBe(201);
  const green = await postSignedWebhook(
    api,
    'check_suite',
    checkSuitePayload({
      conclusion: 'success',
      headSha: decisionHeadSha(PR.number),
      prNumber: PR.number,
      headBranch: headRef,
      repo: DECISION_REPO,
    }),
  );
  expect(green.status()).toBe(200);
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

interface Card {
  id: string;
  identifier: string;
  title: string;
}

test.describe('a refused decision offers the seeded planner', () => {
  let seed: DecisionGateSeed;
  let epic: Card;
  let superseded: Card[];
  let overturned: Card;
  let choice: Card;
  let foreignGateId: string;
  let session: Cookie[];

  // Everything the database holds is written BEFORE the page exists, so the recording
  // starts on the product rather than on a blank page while rows are inserted.
  test.beforeEach(async ({ playwright, baseURL }) => {
    await resetDatabase();
    const slug = Date.now().toString(36);
    seed = await seedDecisionGate(slug);
    const ctx = { userId: (await ownerId(seed)).id, workspaceId: seed.workspaceId };

    // A PERSON's decision that superseded two approved stories (its gate is raised on
    // create), and a CHOICE (likewise) — in the same project, for the same reader.
    const e = await workItemsService.createWorkItem(
      { projectId: seed.projectId, kind: 'epic', title: 'Report exports' },
      ctx,
    );
    epic = { id: e.id, identifier: e.identifier, title: 'Report exports' };
    superseded = [];
    for (const title of ['Browse past exports', 'Re-download an export']) {
      const s = await workItemsService.createWorkItem(
        { projectId: seed.projectId, kind: 'story', parentId: epic.id, title },
        ctx,
      );
      superseded.push({ id: s.id, identifier: s.identifier, title });
    }
    const o = await workItemsService.createWorkItem(
      {
        projectId: seed.projectId,
        kind: 'task',
        parentId: epic.id,
        title: 'Drop the in-app export history',
        type: 'decision',
        executor: 'human',
        assigneeId: ctx.userId,
        descriptionMd: decisionBody({
          decision: 'The export history page is dropped; a customer re-runs an export instead.',
          change: 'less requirement',
          before: 'The approved plan kept a browsable history of every export.',
          supersedes: superseded.map((s) => s.identifier),
          direction: 'Exports are fire-and-forget; nothing lists past exports.',
        }),
      },
      ctx,
    );
    overturned = { id: o.id, identifier: o.identifier, title: 'Drop the in-app export history' };
    const c = await workItemsService.createWorkItem(
      {
        projectId: seed.projectId,
        kind: 'task',
        title: 'Choose where exported reports live',
        type: 'choice',
        executor: 'human',
        assigneeId: ctx.userId,
        descriptionMd: choiceBody({
          question: 'Where do exported reports live once they are generated?',
          situation: 'two workflows',
          evidence: 'Exports average 40 MB once PDFs are attached.',
          options: [
            {
              label: 'Postgres',
              bestFor: 'less to operate',
              why: 'One store, already backed up.',
            },
            {
              label: 'A managed bucket',
              bestFor: 'faster to the goal',
              why: 'Cheap storage, signed links for free.',
            },
          ],
          gates: 'The report exports story.',
        }),
      },
      ctx,
    );
    choice = { id: c.id, identifier: c.identifier, title: 'Choose where exported reports live' };

    // A REFUSED gate in ANOTHER workspace — one this reader cannot browse at all.
    const foreign = await seedChoiceGate(`${slug}x`);
    foreignGateId = await gateOf(foreign.none, 'decision_choice');
    await adminDb.approvalGate.update({
      where: { id: foreignGateId },
      data: {
        state: 'changes_requested',
        noteMd: FOREIGN_REASON,
        decidedAt: new Date(),
        decidedById: foreign.ownerId,
        decidedByLabel: 'Yue Owner',
        decisionSource: 'ui',
      },
    });

    writeFileSync(JOURNAL_PATH, '');
    writeControl({
      repositories: [REPO],
      pullRequests: {
        [`${REPO}#${PR.number}`]: { outcome: 'merged', headSha: decisionHeadSha(PR.number) },
      },
      pullRequestFiles: {
        [`${REPO}#${PR.number}`]: [
          { path: DOC, sha: '3f9a2c1000000000000000000000000000000000' },
          { path: 'lib/pages/body.ts', sha: 'c0de000000000000000000000000000000000001' },
        ],
      },
      fileContents: { [`${REPO}:${DOC}`]: DOCUMENT },
    });
    // The planner's run settles through the lane's motir-ai mock.
    writeFileSync(
      JOBS_FIXTURE,
      JSON.stringify({ ask: [{ intent: 'ask', answer: 'Noted.', citations: [] }], submitted: [] }),
    );

    // The owner signs in and the agent's pull request arrives OFF CAMERA, in an API
    // context: the recording opens on the card, and the page borrows the session cookie.
    const api = await playwright.request.newContext({
      baseURL: baseURL!,
      extraHTTPHeaders: { origin: baseURL! },
    });
    const signedIn = await api.post('/api/auth/sign-in/email', {
      data: { email: seed.ownerEmail, password: seed.password },
    });
    expect(signedIn.status(), (await signedIn.text()).slice(0, 300)).toBe(200);
    await deliverGreen(api, seed.accepted);
    session = (await api.storageState()).cookies;
    await api.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await page.context().addCookies(session);
    await stubAiAccess(page);
  });

  test('refuse, be asked, re-plan from the reason — and come back to the conversation', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6068');
    const card = seed.accepted;
    let requestGateId = '';

    await chapter('Request changes on an agent’s decision — the band ASKS first', async () => {
      await page.goto(`/items/${card.identifier}`);
      await expect(
        developmentSection(page).getByRole('link', {
          name: en.approvalGate.statusHeld.reviewAndApprove,
          exact: true,
        }),
      ).toBeVisible({ timeout: FIRST_PAINT_MS });
      const dev = await openDevelopmentOverlay(page);
      await expect(overlayFor(page, 'decision_approval', card.identifier)).toBeVisible();
      await dev
        .getByRole('button', { name: en.approvalGate.verb.requestChanges, exact: true })
        .click();
      await dev
        .getByLabel(en.approvalGate.reason.label)
        .pressSequentially(REQUEST_REASON, { delay: 25 });
      const action = serverAction(page);
      await dev.getByRole('button', { name: en.approvalGate.reason.proceed, exact: true }).click();
      expect((await action).status()).toBe(200);

      // THE ASK — and nothing has opened.
      const band = askBand(dev, card.identifier);
      await expect(band).toBeVisible();
      await expect(band.getByText(fill(ask.opens, { key: card.identifier }))).toBeVisible();
      await expect(band.getByText(ask.unsent)).toBeVisible();
      await expect(rail(page)).toHaveCount(0);
      expect(new URL(page.url()).searchParams.has('plan')).toBe(false);
      await beat();

      // Yes: the seeded planner opens over the page, anchored on the card.
      requestGateId = await gateOf(card, 'decision_approval');
      const read = seedRead(page, requestGateId);
      await band.getByRole('button', { name: ask.yes, exact: true }).click();
      await page.waitForURL(plannerOpenFrom(requestGateId));
      expect((await read).status()).toBe(200);
      await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(composer(page)).toHaveValue(
        new RegExp(`${escapeRe(card.identifier)}[\\s\\S]*“${escapeRe(REQUEST_REASON)}”`),
      );
      // Nothing was sent: the transcript holds the opener and no turn.
      await expect(transcript(page).getByTestId(USER_TURN)).toHaveCount(0);
      await expect(transcript(page).getByText(REQUEST_REASON)).toHaveCount(0);
      await beat();
    });

    // The address carries the gate's id and NONE of the reason (§10f).
    const address = decodeURIComponent(page.url());
    expect(new URL(page.url()).searchParams.get('planGate')).toBe(requestGateId);
    for (const word of REQUEST_REASON.split(/[\s,]+/).filter((w) => w.length >= 5)) {
      expect(address, `the address leaks "${word}"`).not.toContain(word);
    }

    await chapter(
      'Close without sending — the record’s door brings the same turn back',
      async () => {
        await closePlanner(page);
        const section = developmentSection(page);
        await expect(section.getByText(`“${REQUEST_REASON}”`)).toBeVisible({
          timeout: FIRST_PAINT_MS,
        });
        const entry = replanDoor(section, card.identifier);
        await expect(entry).toBeVisible();
        await expect(entry).toHaveText(door.label);
        await beat();
        const read = seedRead(page, requestGateId);
        await entry.click();
        await page.waitForURL(plannerOpenFrom(requestGateId));
        expect((await read).status()).toBe(200);
        await expect(composer(page)).toHaveValue(new RegExp(`“${escapeRe(REQUEST_REASON)}”`), {
          timeout: FIRST_PAINT_MS,
        });
        await expect(transcript(page).getByTestId(USER_TURN)).toHaveCount(0);
      },
    );

    await chapter(
      'Send it — then the door returns to the conversation, and Plans names the card',
      async () => {
        const sent = page.waitForResponse(
          (r) =>
            /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
            r.request().method() === 'POST',
        );
        await rail(page).getByRole('button', { name: 'Send' }).click();
        expect((await sent).status()).toBe(200);
        await expect(transcript(page).getByTestId(USER_TURN).first()).toBeVisible();
        await expect(transcript(page).getByText(REQUEST_REASON)).toBeVisible();
        // The mocked planner answers. The lane's jobs mock settles a plan run with nothing
        // proposed, so its answer is the rail's own "nothing came back" line.
        await expect(
          rail(page).getByText(en.planningWorkspace.conversation.error.empty),
        ).toBeVisible();
        // The conversation this send started REMEMBERS the refusal that seeded it.
        await expect
          .poll(
            async () =>
              (await adminDb.planChangeSession.findMany({ where: { seedGateId: requestGateId } }))
                .length,
          )
          .toBe(1);
        await beat();

        await closePlanner(page);
        const read = seedRead(page, requestGateId);
        await replanDoor(developmentSection(page), card.identifier).click();
        await page.waitForURL(plannerOpenFrom(requestGateId));
        expect((await read).status()).toBe(200);
        // Back to the SAME conversation: its turn is on the transcript, the composer empty.
        await expect(transcript(page).getByText(REQUEST_REASON)).toBeVisible({
          timeout: FIRST_PAINT_MS,
        });
        await expect(composer(page)).toHaveValue('');
        await beat();
        await closePlanner(page);

        await page
          .getByRole('navigation', { name: 'Primary' })
          .getByRole('link', { name: 'Plans' })
          .click();
        await page.waitForURL('**/plans');
        const seedLink = page
          .getByRole('list', { name: 'Planning conversations' })
          .getByTestId('plan-session-seed');
        await expect(seedLink).toHaveCount(1, { timeout: FIRST_PAINT_MS });
        await expect(seedLink).toHaveText(
          new RegExp(
            `Re-plan of ${escapeRe(card.identifier)}\\s*·\\s*${escapeRe(en.aiPlanning.sessions.seed.verb.decisionApproval)}`,
          ),
        );
        await expect(seedLink).toHaveAttribute('href', `/items/${card.identifier}`);
      },
    );

    await chapter(
      'Overturn a person’s decision — Not now keeps the overlay, the door takes focus',
      async () => {
        await page.goto('/workbench?tab=approvals');
        await rowFor(page, overturned.identifier)
          .getByRole('button', { name: en.workbench.approvals.review, exact: true })
          .click();
        const dialog = overlayFor(page, 'decision_confirmation', overturned.identifier);
        await expect(dialog).toHaveCount(1, { timeout: FIRST_PAINT_MS });
        await dialog.getByRole('button', { name: dc.verb.overturn, exact: true }).click();
        await dialog.getByLabel(dc.note.label).pressSequentially(OVERTURN_NOTE, { delay: 15 });
        const action = serverAction(page);
        await dialog.getByRole('button', { name: dc.overturnStep.proceed, exact: true }).click();
        expect((await action).status()).toBe(200);

        const band = askBand(dialog, overturned.identifier);
        await expect(band).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(rail(page)).toHaveCount(0);
        await band
          .getByRole('button', { name: en.planningWorkspace.handoff.notNow, exact: true })
          .click();

        // Nothing opened; the approval overlay is still up on the decided record.
        await expect(band).toHaveCount(0);
        await expect(dialog).toBeVisible();
        await expect(rail(page)).toHaveCount(0);
        expect(new URL(page.url()).searchParams.has('plan')).toBe(false);
        const entry = replanDoor(dialog, overturned.identifier);
        await expect(entry).toBeFocused();
        // The door REPLACES the overturned band's plain epic entrance.
        await expect(dialog.getByTestId('work-item-plan-entrance')).toHaveCount(0);
        await expect(dialog.getByText(dc.band.replanOwed, { exact: true })).toBeVisible();
        await beat();

        const gateId = await gateOf(overturned, 'decision_confirmation');
        const read = seedRead(page, gateId);
        await entry.click();
        await page.waitForURL(plannerOpenFrom(gateId));
        expect((await read).status()).toBe(200);
        await expect(dialog).toHaveCount(0);
        await expect(composer(page)).toHaveValue(new RegExp(`“${escapeRe(OVERTURN_NOTE)}”`), {
          timeout: FIRST_PAINT_MS,
        });
        for (const story of superseded) {
          await expect(composer(page)).toHaveValue(new RegExp(escapeRe(story.identifier)));
        }
        await expect(transcript(page).getByTestId(USER_TURN)).toHaveCount(0);
        await closePlanner(page);
      },
    );

    await chapter('None of these on a choice — the ask answered with Enter', async () => {
      await rowFor(page, choice.identifier)
        .getByRole('button', { name: en.workbench.approvals.review, exact: true })
        .click();
      const dialog = overlayFor(page, 'decision_choice', choice.identifier);
      await expect(dialog).toHaveCount(1, { timeout: FIRST_PAINT_MS });
      await dialog
        .getByRole('button', { name: en.approvalGate.choice.verb.noneOfThese, exact: true })
        .click();
      await dialog
        .getByLabel(en.approvalGate.reason.choice.label)
        .pressSequentially(NONE_REASON, { delay: 15 });
      const action = serverAction(page);
      await dialog
        .getByRole('button', { name: en.approvalGate.reason.choice.proceed, exact: true })
        .click();
      expect((await action).status()).toBe(200);

      const band = askBand(dialog, choice.identifier);
      await expect(band).toBeVisible({ timeout: FIRST_PAINT_MS });
      const yes = band.getByRole('button', { name: ask.yes, exact: true });
      await expect(yes).toBeFocused();
      await beat();

      const gateId = await gateOf(choice, 'decision_choice');
      const read = seedRead(page, gateId);
      await page.keyboard.press('Enter');
      await page.waitForURL(plannerOpenFrom(gateId));
      expect((await read).status()).toBe(200);
      await expect(composer(page)).toHaveValue(
        new RegExp(`${escapeRe(choice.identifier)}[\\s\\S]*“${escapeRe(NONE_REASON)}”`),
        { timeout: FIRST_PAINT_MS },
      );
      await expect(transcript(page).getByTestId(USER_TURN)).toHaveCount(0);
      await closePlanner(page);
    });

    await chapter('A gate this reader cannot browse opens the planner UNSEEDED', async () => {
      const read = seedRead(page, foreignGateId);
      await page.goto(
        withPlanningOverlay('/workbench', { kind: 'refused-gate', gateId: foreignGateId }),
      );
      expect((await read).status()).toBe(404);
      await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(composer(page)).toHaveValue('');
      await expect(rail(page).getByRole('alert')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(FOREIGN_REASON);
      await expect(page.locator('body')).not.toContainText('Hamburg');
    });
  });
});

async function ownerId(seed: DecisionGateSeed): Promise<{ id: string }> {
  return adminDb.user.findUniqueOrThrow({
    where: { email: seed.ownerEmail },
    select: { id: true },
  });
}
