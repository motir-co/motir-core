import type { Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAiAugmentReplan,
  markProjectOnboarded,
  type AiAugmentReplanSeed,
} from './_helpers/ai-augment-replan-seed';
import {
  appendAsAi,
  declareSeam,
  endRun,
  mailboxRows,
  planOfRun,
  planRun,
  postPause,
  proposalTitles,
  readGap,
  retitleAsAi,
  submitsOf,
  withdrawAsAi,
  type RunHandle,
} from './_helpers/mid-run-seam';
import { workItemsService } from '@/lib/services/workItemsService';
import { PAUSE_DECLINE_INSTRUCTION } from '@/lib/services/planChangeRunPauseService';
import en from '@/messages/en.json';

// ACCEPTANCE — talk to the planner while it plans (Story MOTIR-7990 · MOTIR-8004).
// The receipt a person watches to accept the story, as SIX short clips:
//
//   A. A question — "how far along is it?", "explain <key>" — is answered on the
//      side and nothing reaches the planner. An ambiguous "maybe a work item for
//      exports?" is offered for forwarding and, left unconfirmed, goes nowhere.
//   B. A change is forwarded and goes queued -> read, then lands on the canvas. One
//      sent as the walk finishes is applied as a revision on the plan's timeline.
//   C. A change that reverses the plan PAUSES the run and the planner offers START
//      OVER. Declined, the written work items are withdrawn, removed and re-scoped
//      on the canvas, with no reload.
//   D. The same offer, accepted: the shipped START OVER happens, and it is the very
//      entry a person-typed START OVER writes.
//   E. A vague change: the planner asks what it meant, the person answers in the
//      composer, and the answer goes queued -> read and lands on the canvas.
//   F. A change still queued when the person presses Stop is refused with a reason,
//      and the person's words are back in the composer.
//
// ── THE LANE, AND THE SEAM THE SPEC STANDS ON ───────────────────────────────
// `playwright.acceptance.config.ts` runs CLOUD-ON with `E2E_TEST_AI_JOBS=1` and
// `MOTIR_AI_JOBS_FIXTURE_PATH` set on the runner AND the webServer. So
// `lib/test-ai-jobs-mock.ts` answers motir-ai from INSIDE the Next server, under the
// routes: the ask submit, the settle's `getJob`, the pause service's `getJob` and
// the late revision's `submitRevise` are server-side fetches no `page.route` can
// reach, and none is stubbed in the browser. The real routes, services,
// repositories and Postgres all run.
//
// WHAT IS STUBBED, AND WHAT IS PLAYED
//   - The fixture declares the VERDICTS: what each ask settles as (an answer, an
//     offer, a change to forward), and that the planning run is HELD in progress
//     (`status: 'running'`) until the spec ends it.
//   - The spec PLAYS motir-ai's side of the run through the doors motir-ai calls,
//     with the service bearer and the run's job token (`_helpers/mid-run-seam.ts`):
//     the tool-call-gap read (`plan-change-mailbox`), the pause post
//     (`plan-change-run-pause`) and the proposal append / re-title / withdraw
//     (`plan-proposals`). No mailbox row, pause or proposal is written by hand.
//
// WHAT THIS RECEIPT DELIBERATELY DOES NOT ASSERT (the harness would be asserting
// itself): what motir-ai's classifier decides, what an answer says, whether a
// session rules a change a correction, a re-plan or unclear, that a real walk pauses
// or applies the decline or the answer, that the step-out files no planning bug, or
// what a real START OVER re-walk produces. Those are the motir-ai story gate's. The
// cannot-read-the-run reply needs the plan read to fail mid-run, which a browser
// cannot cause; the routing work item's integration test and the rail's component
// test cover it.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on an AUTHORITATIVE signal (CLAUDE.md): a response and its body
// (the ask settle, the pause GET, the mailbox poll, the plan read), a committed row
// read from Postgres, or the seam journal. No fixed timeout anywhere; `beat()` and
// the chapter hold are pacing, taken after the assertion that already proved the state.

test.describe.configure({ timeout: 240_000 });

const conv = en.planningWorkspace.conversation;
const mid = conv.midRun;
const pause = mid.pause;

// ── Locators ────────────────────────────────────────────────────────────────

const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const composer = (page: Page) => rail(page).getByRole('textbox');
const sendButton = (page: Page) => rail(page).getByRole('button', { name: 'Send', exact: true });
const stopButton = (page: Page) => rail(page).getByTestId('plan-change-stop');
const byId = (page: Page, id: string) => rail(page).getByTestId(id);
const userTurn = (page: Page, text: string) =>
  byId(page, 'conversation-user-turn').filter({ hasText: text });
/**
 * The work item whose children the canvas is showing. A run started from the anchor
 * story opens the overlay on the anchor's own level (the breadcrumb reads
 * Roadmap › Authentication), so a proposal the planner writes UNDER THE EPIC is drawn
 * there; one written under the anchor itself, or at the project root, would only be
 * counted in the arrivals offer ("1 new in …  Go there").
 */
const anchorId = async () =>
  (await adminDb.workItem.findFirstOrThrow({ where: { identifier: seed.authEpicKey } })).id;
/** A proposal card on the canvas, by the title it shows. */
const node = (page: Page, title: string) =>
  workspace(page).getByTestId('plan-item-node').filter({ hasText: title });
const opNodes = (page: Page, op: 'add' | 'modify' | 'remove') =>
  workspace(page).locator(`[data-op="${op}"]`);
const pausedBar = (page: Page) => byId(page, 'plan-change-running-bar');

// ── Authoritative signals ───────────────────────────────────────────────────

const path = (r: Response) => new URL(r.url()).pathname;
const isPost = (r: Response, pathname: string) =>
  path(r) === pathname && r.request().method() === 'POST';
const isGet = (r: Response, pathname: string) =>
  path(r) === pathname && r.request().method() === 'GET';

const ASK = '/api/ai/ask';
const SETTLE = '/api/ai/ask/settle';
const RUN_PAUSE = '/api/ai/plan-change/session/run-pause';
const MAILBOX = '/api/ai/plan-change/session/mailbox';
const LATE_CHANGES = '/api/ai/plan-change/session/late-changes';

interface ReviewItem {
  title: string;
  op: string;
  removeReason?: string | null;
}

/** The next READ of a plan whose items satisfy `carries` — armed BEFORE the write. */
function planReadCarrying(
  page: Page,
  planId: string,
  carries: (items: ReviewItem[]) => boolean,
): Promise<Response> {
  return page.waitForResponse(async (r) => {
    if (!isGet(r, `/api/plans/${planId}`) || r.status() !== 200) return false;
    try {
      return carries(((await r.json()) as { items?: ReviewItem[] }).items ?? []);
    } catch {
      return false;
    }
  });
}

/** The next mailbox POLL that no longer lists `entryId` — the rail's evidence it was read. */
function mailboxReportsRead(page: Page, entryId: string): Promise<Response> {
  return page.waitForResponse(async (r) => {
    if (!isGet(r, MAILBOX) || r.status() !== 200) return false;
    try {
      const body = (await r.json()) as { turns: Array<{ id: string }> };
      return !body.turns.some((t) => t.id === entryId);
    } catch {
      return false;
    }
  });
}

/** The next pause READ of `kind` — the rail's poll finding the planner's pause. */
function pauseReadOf(page: Page, kind: 'replan' | 'unclear'): Promise<Response> {
  return page.waitForResponse(async (r) => {
    if (!isGet(r, RUN_PAUSE) || r.status() !== 200) return false;
    try {
      return ((await r.json()) as { kind?: string } | null)?.kind === kind;
    } catch {
      return false;
    }
  });
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

// ── Steps ───────────────────────────────────────────────────────────────────

interface Started {
  run: RunHandle;
  planId: string;
  sessionId: string;
  /** Which `plan` submit this run is — its index into the fixture's `plan` queue. */
  index: number;
}

/**
 * Open the planning workspace from a card and START a run: the first turn of an
 * anchored conversation goes straight to the planning submit. The fixture holds the
 * run in progress, so the rail is streaming and Stop is on offer.
 */
async function startRun(page: Page, key: string, firstTurn: string): Promise<Started> {
  const index = submitsOf('plan').length;
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL((url) => url.searchParams.has('plan'));
  await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

  const submitted = page.waitForResponse(
    (r) => /\/api\/work-items\/[^/]+\/ai\/plan$/.test(path(r)) && r.request().method() === 'POST',
  );
  await composer(page).fill(firstTurn);
  await sendButton(page).click();
  expect((await submitted).status()).toBe(200);
  await expect(stopButton(page)).toBeVisible();

  const run = planRun(index);
  const plan = await planOfRun(run.jobId);
  expect(plan.sessionId).toBeTruthy();
  return { run, planId: plan.id, sessionId: plan.sessionId!, index };
}

interface Settled {
  outcome: string;
}

/**
 * Type a turn INTO the running run and send it. Resolves with the settle's body once
 * the ask has been answered: the submit's 200 and the settle's 200 are the signals
 * that the thread advanced and the verdict landed.
 */
async function typeIntoRun(page: Page, text: string): Promise<Settled> {
  const submitted = page.waitForResponse((r) => isPost(r, ASK));
  const settled = page.waitForResponse((r) => isPost(r, SETTLE));
  await composer(page).fill(text);
  await sendButton(page).click();
  expect((await submitted).status()).toBe(200);
  const res = await settled;
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Settled;
}

/** The mailbox's `turn` rows of a run, in order. */
async function turnRows(jobId: string) {
  return (await mailboxRows(jobId)).filter((r) => r.kind === 'turn');
}

/** Every `ask_project` submit the server made — and the plan each carried. */
const askSubmits = () => submitsOf('ask_project');

let seed: AiAugmentReplanSeed;

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  seed = await seedAiAugmentReplan(`mid-run-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  await stubAiAccess(page);
  await signIn(page, seed.email, seed.password);
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ A. Questions and the offer never reach the planner ═════════════════════

test('A. a question is answered on the side and an unconfirmed offer goes nowhere', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7990');
  const committed = await adminDb.workItem.findFirstOrThrow({
    where: { identifier: seed.loginKey },
  });
  const STEP_ANSWER = 'It is laying the notifications step now. One work item is written so far.';
  const EXPLAIN_ANSWER = `[${seed.loginKey}](motir:${committed.id}) is the sign-in screen. This run plans around it and does not change it.`;
  const OFFER_TEXT = 'maybe a work item for exports?';
  const OFFER_ANSWER = 'Do you want a work item for exports added to the plan?';
  const FOLLOW_UP = 'what is in the plan so far?';
  const FOLLOW_UP_ANSWER = 'It holds one work item so far: Notifications digest.';
  declareSeam({
    ask: [
      { intent: 'ask', answer: STEP_ANSWER },
      { intent: 'ask', answer: EXPLAIN_ANSWER, citations: [seed.loginKey] },
      { intent: 'ask', answer: OFFER_ANSWER, offerForward: { text: OFFER_TEXT } },
      { intent: 'ask', answer: FOLLOW_UP_ANSWER },
    ],
  });

  let started!: Started;
  const nodes = () => opNodes(page, 'add');

  await chapter('A run is working and the composer stays live', async () => {
    started = await startRun(page, seed.loginKey, 'Plan the notifications digest.');
    // The planner has written one work item; it is on the canvas through the
    // product's own poll of the plan it is writing.
    const read = planReadCarrying(page, started.planId, (items) =>
      items.some((i) => i.title === 'Notifications digest'),
    );
    await appendAsAi(page, started.run, [
      { op: 'add', title: 'Notifications digest', parentRef: await anchorId() },
    ]);
    await read;
    await expect(node(page, 'Notifications digest').first()).toBeVisible();
    await expect(nodes()).toHaveCount(1);
    await expect(composer(page)).toBeEnabled();
    await expect(stopButton(page)).toBeVisible();
    await beat();
  });

  /** After a turn: nothing reached the run, and the canvas is as it was. */
  async function expectNothingForwarded(text: string) {
    const { run, planId } = started;
    await expect(userTurn(page, text)).toHaveCount(1);
    // The question carries NO queued label and no forwarded mark.
    await expect(userTurn(page, text)).not.toContainText(conv.queuedLabel);
    await expect(byId(page, 'plan-change-forwarded')).toHaveCount(0);
    await expect(byId(page, 'plan-change-forwarded-queued')).toHaveCount(0);
    // The run's mailbox holds nothing (read from Postgres).
    expect(await mailboxRows(run.jobId)).toHaveLength(0);
    // The ask submit carried the run snapshot, naming THIS run's plan.
    expect(askSubmits().at(-1)?.runPlanId).toBe(planId);
    // The canvas proposal count is unchanged.
    await expect(nodes()).toHaveCount(1);
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(1);
  }

  await chapter('"How far along is it?" is answered, not sent', async () => {
    const settled = await typeIntoRun(page, 'how far along is it?');
    expect(settled.outcome).toBe('answered');
    await expect(byId(page, 'plan-change-report').filter({ hasText: STEP_ANSWER })).toHaveCount(1);
    await expect(byId(page, 'plan-change-answered-aside')).toHaveCount(1);
    await expectNothingForwarded('how far along is it?');
    await beat();
  });

  await chapter('"Explain <key>" cites the work item', async () => {
    const settled = await typeIntoRun(page, `explain ${seed.loginKey}`);
    expect(settled.outcome).toBe('answered');
    const answer = byId(page, 'plan-change-report').filter({ hasText: 'sign-in screen' });
    await expect(answer).toHaveCount(1);
    await expect(answer.locator('a.wi-chip').filter({ hasText: seed.loginKey })).toBeVisible();
    await expect(answer.getByTestId('plan-change-citation-count')).toBeVisible();
    await expectNothingForwarded(`explain ${seed.loginKey}`);
    await beat();
  });

  await chapter('An ambiguous turn is offered, and not confirmed', async () => {
    const settled = await typeIntoRun(page, OFFER_TEXT);
    expect(settled.outcome).toBe('answered');
    const answer = byId(page, 'plan-change-report').filter({ hasText: OFFER_ANSWER });
    await expect(answer).toHaveCount(1);
    // The decision's chosen form: the next turn confirms it, with no button.
    await expect(answer.getByTestId('plan-change-forward-offer')).toContainText(mid.forwardOffer);
    await expect(answer.getByRole('button')).toHaveCount(0);
    await expectNothingForwarded(OFFER_TEXT);
    await beat();

    // The person does NOT confirm: they ask something else, and the offer goes stale.
    const next = await typeIntoRun(page, FOLLOW_UP);
    expect(next.outcome).toBe('answered');
    await expect(byId(page, 'plan-change-forward-stale')).toContainText(mid.forwardStale);
    await expectNothingForwarded(FOLLOW_UP);
    // Nothing carrying the exports text reached the mailbox or the plan.
    const rows = await mailboxRows(started.run.jobId);
    expect(rows.some((r) => /exports/i.test(r.body ?? ''))).toBe(false);
    const titles = await proposalTitles(started.planId);
    expect(titles.some((t) => /exports/i.test(t))).toBe(false);
    await beat();
  });
});

// ═══ B. A change goes queued -> read and lands; a late change is a revision ═

test('B. a change is forwarded, read and lands on the canvas; a late one becomes a revision', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7990');
  const CHANGE = 'also add a work item for Billing exports';
  const LATE = 'also add a work item for Usage reports';
  declareSeam({
    ask: [
      { intent: 'plan_change', forward: { text: CHANGE } },
      { intent: 'plan_change', forward: { text: LATE } },
    ],
  });
  let started!: Started;
  let entryId = '';

  await chapter('The change is forwarded and queued', async () => {
    started = await startRun(page, seed.loginKey, 'Plan the notifications digest.');
    const settled = await typeIntoRun(page, CHANGE);
    expect(settled.outcome).toBe('forwarded');

    // Exactly ONE `fold` entry, carrying the typed text verbatim.
    const rows = await turnRows(started.run.jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ disposition: 'fold', body: CHANGE });
    entryId = rows[0]!.id;

    // The turn renders ONCE, queued, with the acknowledgement.
    await expect(userTurn(page, CHANGE)).toHaveCount(1);
    await expect(userTurn(page, CHANGE)).toContainText(conv.queuedLabel);
    await expect(byId(page, 'plan-change-forwarded')).toContainText(mid.forwardedAck);
    await expect(byId(page, 'plan-change-forwarded-queued')).toBeVisible();
    await expect(byId(page, 'plan-change-queued')).toHaveCount(0);
    await beat();
  });

  await chapter('The planner reads it at its next step', async () => {
    const polled = mailboxReportsRead(page, entryId);
    const gap = await readGap(page, started.run);
    expect(gap.turns.map((t) => t.id)).toEqual([entryId]);
    expect((await mailboxRows(started.run.jobId))[0]?.consumedAt).not.toBeNull();
    await polled;

    await expect(byId(page, 'plan-change-forwarded-read')).toContainText(mid.readMarker);
    await expect(byId(page, 'plan-change-forwarded-queued')).toHaveCount(0);
    // A correction: no START OVER offer, no planner question.
    await expect(byId(page, 'planner-start-over-turn')).toHaveCount(0);
    await expect(byId(page, 'plan-change-question')).toHaveCount(0);
    await beat();
  });

  await chapter('The new work item lands on the canvas', async () => {
    const read = planReadCarrying(page, started.planId, (items) =>
      items.some((i) => i.title === 'Billing exports'),
    );
    await appendAsAi(page, started.run, [
      { op: 'add', title: 'Billing exports', parentRef: await anchorId() },
    ]);
    await read;
    await expect(node(page, 'Billing exports').first()).toBeVisible();
    await beat();
  });

  await chapter('A change sent as the walk finishes becomes a revision', async () => {
    const plansBefore = submitsOf('plan').length;
    const settled = await typeIntoRun(page, LATE);
    expect(settled.outcome).toBe('forwarded');
    await expect(byId(page, 'plan-change-forwarded-queued')).toBeVisible();

    // The walk closes its plan and ends WITHOUT reading the mailbox again: the
    // fixture flips the held run to succeeded and its stream reports the end.
    await appendAsAi(page, started.run, [], { final: true });
    const claimed = page.waitForResponse((r) => isPost(r, LATE_CHANGES));
    endRun(started.index);
    const res = await claimed;
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe('revised');

    // ONE further `plan` submit, a revision of THIS run's plan.
    const plans = submitsOf('plan');
    expect(plans).toHaveLength(plansBefore + 1);
    expect(plans.at(-1)?.planId).toBe(started.planId);
    // Nothing stranded: every entry of this run was claimed.
    const rows = await mailboxRows(started.run.jobId);
    expect(rows.every((r) => r.consumedAt !== null)).toBe(true);

    await expect(byId(page, 'plan-change-revision')).toContainText(mid.revisedNote);
    await beat();

    // …and the revision is on the plan's timeline.
    await byId(page, 'plan-change-revision-link').click();
    await page.waitForURL(new RegExp(`/plans/${started.planId}`));
    // The plan is still undecided: its timeline rows are drawn once it is decided
    // (MOTIR-7883), so the revision is read from the plan's own revision rows.
    expect(
      await adminDb.planRevision.count({
        where: { planId: started.planId, changeKind: 'revision_started' },
      }),
    ).toBeGreaterThanOrEqual(1);
    await beat();
  });
});

// ═══ C. A re-plan: the person declines START OVER ═══════════════════════════

test('C. a re-plan pauses the run; declined, the written work items are removed and re-scoped', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7990');
  const dashboard = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'story', title: 'Web dashboard' },
    seed.ctx,
  );
  const CHANGE = 'actually, drop the web UI entirely — make it a CLI';
  const REASON = 'This changes what most of the plan is for.';
  const REMOVE_REASON = 'the plan is now a CLI';
  declareSeam({ ask: [{ intent: 'plan_change', forward: { text: CHANGE } }] });
  let started!: Started;
  let entryId = '';
  let ids: string[] = [];
  let pauseId = '';

  await chapter('The run has written two work items; the person reverses the plan', async () => {
    started = await startRun(page, dashboard.identifier, 'Plan the web dashboard.');
    const read = planReadCarrying(
      page,
      started.planId,
      (items) =>
        items.some((i) => i.title === 'Web settings page') &&
        items.some((i) => i.title === 'Notifications panel'),
    );
    ids = await appendAsAi(page, started.run, [
      { op: 'add', title: 'Web settings page' },
      { op: 'add', title: 'Notifications panel' },
    ]);
    await read;
    await expect(node(page, 'Web settings page').first()).toBeVisible();
    await expect(node(page, 'Notifications panel').first()).toBeVisible();

    const settled = await typeIntoRun(page, CHANGE);
    expect(settled.outcome).toBe('forwarded');
    const rows = await turnRows(started.run.jobId);
    expect(rows).toHaveLength(1);
    entryId = rows[0]!.id;
    await expect(byId(page, 'plan-change-forwarded-queued')).toBeVisible();

    const polled = mailboxReportsRead(page, entryId);
    await readGap(page, started.run);
    await polled;
    await expect(byId(page, 'plan-change-forwarded-read')).toBeVisible();
    await beat();
  });

  await chapter('The run pauses and the planner offers START OVER', async () => {
    const found = pauseReadOf(page, 'replan');
    const recorded = await postPause(page, started.run, {
      kind: 'replan',
      changeTurnIds: [entryId],
      reason: REASON,
    });
    expect(recorded.outcome).toBe('recorded');
    pauseId = recorded.pause.id;
    await found;

    const offer = byId(page, 'planner-start-over-turn');
    await expect(offer).toContainText(REASON);
    // Exactly the two controls.
    const controls = byId(page, 'planner-start-over-offer').getByRole('button');
    await expect(controls).toHaveCount(2);
    await expect(controls.nth(0)).toHaveText(pause.startOver);
    await expect(controls.nth(1)).toHaveText(pause.keepGoing);
    // The run is paused, not stalled: the indicator is drawn and Stop stays.
    await expect(pausedBar(page)).toHaveAttribute('data-paused', 'true');
    await expect(byId(page, 'plan-change-paused-word')).toHaveText(pause.pausedWord);
    await expect(stopButton(page)).toBeVisible();
    // Neither is an alert: nothing failed, the planner is waiting.
    await expect(offer.locator('[role="alert"]')).toHaveCount(0);
    await expect(pausedBar(page).locator('[role="alert"]')).toHaveCount(0);
    await beat();
  });

  await chapter('Keep going and apply it', async () => {
    const plansBefore = submitsOf('plan').length;
    const answered = page.waitForResponse((r) => isPost(r, RUN_PAUSE));
    await byId(page, 'planner-start-over-keep').click();
    const res = await answered;
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe('answered');

    // The offer collapses to its record: no controls.
    await expect(byId(page, 'planner-start-over-record')).toContainText(pause.chosenKeepGoing);
    await expect(byId(page, 'planner-start-over-applying')).toContainText(pause.applying);
    await expect(byId(page, 'planner-start-over-offer')).toHaveCount(0);

    // ONE new `fold` entry, declining THIS pause, with the fixed instruction first.
    const rows = await turnRows(started.run.jobId);
    expect(rows).toHaveLength(2);
    const decline = rows[1]!;
    expect(decline).toMatchObject({ disposition: 'fold', declinesPauseId: pauseId });
    expect(decline.body).toBe(`${PAUSE_DECLINE_INSTRUCTION}\n\n${CHANGE}`);
    expect(rows.some((r) => r.disposition === 'restart')).toBe(false);
    // No new run: the same one is still working, on the same plan.
    expect(submitsOf('plan')).toHaveLength(plansBefore);
    expect(await adminDb.plan.count({ where: { sessionId: started.sessionId } })).toBe(1);
    await beat();
  });

  await chapter('The planner applies it: withdrawn, removed, re-scoped', async () => {
    await readGap(page, started.run);
    const read = planReadCarrying(
      page,
      started.planId,
      (items) =>
        !items.some((i) => i.title === 'Web settings page') &&
        items.some((i) => i.title === 'CLI notifications') &&
        items.some((i) => i.op === 'remove' && i.removeReason === REMOVE_REASON),
    );
    await withdrawAsAi(page, started.run, ids[0]!);
    await appendAsAi(page, started.run, [
      { op: 'remove', workItemId: dashboard.id, reason: REMOVE_REASON },
    ]);
    await retitleAsAi(page, started.run, ids[1]!, 'CLI notifications');
    await read;

    // All three changes are on the canvas, with no reload.
    await expect(node(page, 'Web settings page')).toHaveCount(0);
    const removed = opNodes(page, 'remove').filter({ hasText: 'Web dashboard' });
    await expect(removed.first()).toBeVisible();
    await expect(removed.first().getByTestId('remove-reason')).toContainText(REMOVE_REASON);
    await expect(node(page, 'CLI notifications').first()).toBeVisible();
    await beat();
  });

  await chapter('After a reload the offer is still a record', async () => {
    await page.reload();
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(byId(page, 'planner-start-over-record')).toContainText(pause.chosenKeepGoing, {
      timeout: FIRST_PAINT_MS,
    });
    await expect(byId(page, 'planner-start-over-offer')).toHaveCount(0);
    await beat();
  });
});

// ═══ D. The person accepts START OVER ═══════════════════════════════════════

test('D. accepting the offer writes the shipped START OVER', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7990');
  const CHANGE = 'start this over as a mobile app';
  const TYPED_RESTART = 'start over, plan it as a mobile app';
  declareSeam({
    ask: [{ intent: 'plan_change', forward: { text: CHANGE } }],
    plan: [{ status: 'running' }, { status: 'running' }, {}],
  });

  let reference!: Started;
  await chapter('For comparison: a START OVER the person types', async () => {
    // A second conversation, on its own card: the entry the SHIPPED mailbox route
    // writes for a person-typed START OVER, which the planner's offer must equal.
    reference = await startRun(page, seed.notifKey, 'Plan the notifications.');
    const res = await page.request.post(MAILBOX, {
      data: {
        jobId: reference.run.jobId,
        sessionId: reference.sessionId,
        body: TYPED_RESTART,
        disposition: 'restart',
        idempotencyKey: `typed-restart:${reference.run.jobId}`,
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    const rows = await turnRows(reference.run.jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ disposition: 'restart', restartTarget: null });
    await beat();
  });

  let started!: Started;
  let entryId = '';
  let pauseId = '';

  await chapter('A change reverses the plan and the planner offers START OVER', async () => {
    started = await startRun(page, seed.loginKey, 'Plan the login screen.');
    const settled = await typeIntoRun(page, CHANGE);
    expect(settled.outcome).toBe('forwarded');
    const rows = await turnRows(started.run.jobId);
    expect(rows).toHaveLength(1);
    entryId = rows[0]!.id;
    const polled = mailboxReportsRead(page, entryId);
    await readGap(page, started.run);
    await polled;

    const found = pauseReadOf(page, 'replan');
    const recorded = await postPause(page, started.run, {
      kind: 'replan',
      changeTurnIds: [entryId],
      reason: 'This changes what most of the plan is for.',
    });
    pauseId = recorded.pause.id;
    await found;
    await expect(byId(page, 'planner-start-over-offer')).toBeVisible();
    await expect(pausedBar(page)).toHaveAttribute('data-paused', 'true');
    await beat();
  });

  await chapter('Start over', async () => {
    const plansBefore = submitsOf('plan').length;
    const answered = page.waitForResponse((r) => isPost(r, RUN_PAUSE));
    await byId(page, 'planner-start-over-yes').click();
    const res = await answered;
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe('answered');

    await expect(byId(page, 'planner-start-over-record')).toContainText(pause.chosenStartOver);
    await expect(byId(page, 'planner-start-over-offer')).toHaveCount(0);

    // ONE new entry: a `restart` of the run's own target, carrying the change.
    const rows = await turnRows(started.run.jobId);
    expect(rows).toHaveLength(2);
    const restart = rows[1]!;
    expect(restart).toMatchObject({
      disposition: 'restart',
      restartTarget: null,
      body: CHANGE,
      declinesPauseId: null,
      answersPauseId: null,
    });
    // The shipped START OVER rendering: the standalone queued turn, until the walk reads it.
    await expect(byId(page, 'plan-change-queued')).toHaveCount(1);
    // No new run and no second plan: the walk does the restart, not core.
    expect(submitsOf('plan')).toHaveLength(plansBefore);
    expect(await adminDb.plan.count({ where: { sessionId: started.sessionId } })).toBe(1);

    // A replayed answer writes nothing more.
    const replay = await page.request.post(RUN_PAUSE, {
      data: {
        sessionId: started.sessionId,
        jobId: started.run.jobId,
        pauseId,
        choice: 'start_over',
      },
    });
    expect([200, 409]).toContain(replay.status());
    expect(
      (await turnRows(started.run.jobId)).filter((r) => r.disposition === 'restart'),
    ).toHaveLength(1);
    await beat();
  });

  await chapter('It is the same entry the person-typed START OVER writes', async () => {
    // Through the door the walk reads, the planner's START OVER and the typed one
    // have the SAME shape: same disposition, same target, same delivery keys, and
    // neither marks itself as a decline or an answer.
    const theirs = (await readGap(page, started.run)).turns.find((t) => t.id !== entryId);
    const ours = (await readGap(page, reference.run)).turns[0];
    expect(theirs).toBeTruthy();
    expect(ours).toBeTruthy();
    expect(theirs!.disposition).toBe('restart');
    expect(theirs!.target).toBeNull();
    expect(theirs).not.toHaveProperty('declinesPause');
    expect(theirs).not.toHaveProperty('answersQuestion');
    expect(Object.keys(theirs!).sort()).toEqual(Object.keys(ours!).sort());
    expect(theirs!.disposition).toBe(ours!.disposition);
    expect(theirs!.target).toBe(ours!.target);
    await beat();
  });
});

// ═══ E. A vague change: the planner asks what it meant ══════════════════════

test('E. a vague change is asked about, answered in the composer, and the answer lands', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7990');
  const VAGUE = 'make it better';
  const QUESTION =
    'Which part should change — the work item list, the order, or what a work item covers?';
  const REPLY = 'split the settings work item into profile and billing';
  declareSeam({ ask: [{ intent: 'plan_change', forward: { text: VAGUE } }] });
  let started!: Started;
  let entryId = '';
  let pauseId = '';
  let ids: string[] = [];

  await chapter('A vague change is forwarded and read; the canvas is unchanged', async () => {
    started = await startRun(page, seed.loginKey, 'Plan the settings.');
    const read = planReadCarrying(page, started.planId, (items) =>
      items.some((i) => i.title === 'Settings'),
    );
    ids = await appendAsAi(page, started.run, [
      { op: 'add', title: 'Settings', parentRef: await anchorId() },
    ]);
    await read;
    await expect(node(page, 'Settings').first()).toBeVisible();

    const settled = await typeIntoRun(page, VAGUE);
    expect(settled.outcome).toBe('forwarded');
    const rows = await turnRows(started.run.jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.disposition).toBe('fold');
    entryId = rows[0]!.id;
    await expect(byId(page, 'plan-change-forwarded-queued')).toBeVisible();

    const polled = mailboxReportsRead(page, entryId);
    await readGap(page, started.run);
    await polled;
    await expect(byId(page, 'plan-change-forwarded-read')).toBeVisible();
    await expect(opNodes(page, 'add')).toHaveCount(1);
    await beat();
  });

  await chapter('The planner steps out to ask what it meant', async () => {
    const found = pauseReadOf(page, 'unclear');
    const recorded = await postPause(page, started.run, {
      kind: 'unclear',
      changeTurnIds: [entryId],
      question: QUESTION,
    });
    expect(recorded.outcome).toBe('recorded');
    pauseId = recorded.pause.id;
    await found;

    // The question sits directly under the vague turn, as plain text, with NO button.
    const question = byId(page, 'plan-change-question');
    await expect(question).toContainText(QUESTION);
    await expect(question).toContainText(pause.unclearNote);
    await expect(question.getByRole('button')).toHaveCount(0);
    await expect(
      userTurn(page, VAGUE)
        .locator('xpath=following::*[@data-testid="plan-change-question"]')
        .first(),
    ).toBeVisible();
    // Paused, waiting on THEIR answer; Stop stays; nothing is an alert.
    await expect(pausedBar(page)).toHaveAttribute('data-paused', 'true');
    await expect(byId(page, 'plan-change-paused-line')).toHaveText(conv.awaitingAnswer);
    await expect(stopButton(page)).toBeVisible();
    await expect(question.locator('[role="alert"]')).toHaveCount(0);
    await expect(pausedBar(page).locator('[role="alert"]')).toHaveCount(0);
    // It is not the end-of-job question: no answer bar, and the canvas is untouched.
    await expect(byId(page, 'plan-change-awaiting')).toHaveCount(0);
    await expect(node(page, 'Settings').first()).toBeVisible();
    await beat();
  });

  await chapter('The person answers in the composer', async () => {
    const asksBefore = askSubmits().length;
    const plansBefore = submitsOf('plan').length;
    const answered = page.waitForResponse((r) => isPost(r, RUN_PAUSE));
    await composer(page).fill(REPLY);
    await sendButton(page).click();
    const res = await answered;
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { outcome: string; pause: { answer: string } };
    expect(body.outcome).toBe('answered');
    expect(body.pause.answer).toBe('replied');

    // The answer went to the pause door, never to the mid-run ask or a second run.
    expect(askSubmits()).toHaveLength(asksBefore);
    expect(submitsOf('plan')).toHaveLength(plansBefore);
    // ONE new `fold` entry, answering THIS pause, with the reply verbatim.
    const rows = await turnRows(started.run.jobId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ disposition: 'fold', answersPauseId: pauseId, body: REPLY });

    // The reply renders ONCE, under the question, queued — no acknowledgement, no offer.
    const reply = byId(page, 'planner-pause-reply');
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText(REPLY);
    await expect(reply).toContainText(conv.queuedLabel);
    await expect(userTurn(page, REPLY)).toHaveCount(0);
    await expect(byId(page, 'plan-change-queued')).toHaveCount(0);
    await expect(byId(page, 'plan-change-forwarded')).toHaveCount(1);
    await expect(byId(page, 'plan-change-forward-offer')).toHaveCount(0);
    expect(await adminDb.plan.count({ where: { sessionId: started.sessionId } })).toBe(1);
    await beat();
  });

  await chapter('The planner reads the answer and planning resumes', async () => {
    const replyId = (await turnRows(started.run.jobId))[1]!.id;
    const polled = mailboxReportsRead(page, replyId);
    await readGap(page, started.run);
    await polled;

    expect((await mailboxRows(started.run.jobId))[1]?.consumedAt).not.toBeNull();
    await expect(
      byId(page, 'planner-pause-reply').getByTestId('plan-change-forwarded-read'),
    ).toBeVisible();
    await expect(pausedBar(page)).not.toHaveAttribute('data-paused', 'true');
    await expect(pausedBar(page)).toBeVisible();
    await expect(byId(page, 'planner-question-record')).toContainText(conv.answeredMarker);
    await beat();
  });

  await chapter('The answer lands on the canvas', async () => {
    const read = planReadCarrying(
      page,
      started.planId,
      (items) =>
        items.some((i) => i.title === 'Profile settings') &&
        items.some((i) => i.title === 'Billing settings'),
    );
    await retitleAsAi(page, started.run, ids[0]!, 'Profile settings');
    await appendAsAi(page, started.run, [
      { op: 'add', title: 'Billing settings', parentRef: await anchorId() },
    ]);
    await read;
    await expect(node(page, 'Profile settings').first()).toBeVisible();
    await expect(node(page, 'Billing settings').first()).toBeVisible();

    // Reload: the question is still an answered record and nothing invites another answer.
    await page.reload();
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(byId(page, 'planner-question-record')).toContainText(conv.answeredMarker, {
      timeout: FIRST_PAINT_MS,
    });
    await expect(
      byId(page, 'planner-pause-reply').getByTestId('plan-change-forwarded-read'),
    ).toBeVisible();
    await expect(byId(page, 'plan-change-awaiting')).toHaveCount(0);
    await beat();
  });
});

// ═══ F. The run-ended refusal keeps the text ════════════════════════════════

test('F. a change still queued when the run is stopped is refused, and the words come back', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7990');
  const CHANGE = 'rename Notifications to Alerts';
  declareSeam({ ask: [{ intent: 'plan_change', forward: { text: CHANGE } }] });
  let started!: Started;

  await chapter('A change is queued and the person presses Stop', async () => {
    started = await startRun(page, seed.loginKey, 'Plan the notifications digest.');
    const settled = await typeIntoRun(page, CHANGE);
    expect(settled.outcome).toBe('forwarded');
    await expect(byId(page, 'plan-change-forwarded-queued')).toBeVisible();

    const stopped = page.waitForResponse((r) => isPost(r, `${MAILBOX}/stop`));
    await stopButton(page).click();
    expect((await stopped).status()).toBe(200);
    await expect(rail(page).getByText(conv.stopping)).toBeVisible();
    await beat();
  });

  await chapter('The run ends and the refusal hands the words back', async () => {
    const plansBefore = submitsOf('plan').length;
    // The walk reads the stop, closes its plan and ends — without reading the change.
    await appendAsAi(page, started.run, [{ op: 'add', title: 'Notifications digest' }], {
      final: true,
    });
    const claimed = page.waitForResponse((r) => isPost(r, LATE_CHANGES));
    endRun(started.index);
    const res = await claimed;
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { outcome: string; code: string; texts: string[] };
    expect(body).toMatchObject({
      outcome: 'refused',
      code: 'PLAN_CHANGE_RUN_STOPPED',
      texts: [CHANGE],
    });

    const refusal: Locator = byId(page, 'plan-change-forward-refusal');
    await expect(refusal).toHaveAttribute('data-code', 'PLAN_CHANGE_RUN_STOPPED');
    await expect(refusal).toContainText(mid.refusal.stopped);
    await expect(refusal.locator('[role="alert"]')).toHaveCount(0);
    await expect(rail(page).getByRole('alert')).toHaveCount(0);
    // The person's words are back in the box.
    await expect(composer(page)).toHaveValue(CHANGE);
    // Nothing was revised from them, and the plan holds nothing from that text.
    expect(submitsOf('plan')).toHaveLength(plansBefore);
    const titles = await proposalTitles(started.planId);
    expect(titles.some((t) => /alerts/i.test(t))).toBe(false);
    await beat();
  });
});
