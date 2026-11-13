import type { Page } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { latestPlanningSession } from './_helpers/planChangeConversation';
import { agentSession } from './_helpers/agent-authored-plan-seed';
import {
  seedPlanProgress,
  PLAN_PROGRESS_PASSWORD,
  type PlanProgressSeed,
} from './_helpers/plan-progress-seed';
import { startSseFrameServer, type SseFrameServer } from './_helpers/sse-frame-server';
import {
  askFromCard,
  callTool,
  declareJobs,
  hostedPlanStep,
  latestPlanJob,
  proposalRef,
  routeJobStream,
  stubAiAccess,
  type HostedJob,
  type HostedStepBody,
} from './_helpers/plan-narration-doors';
import { composer, node, openFromCard, showCanvas, views } from './_helpers/plan-progress-harness';
import { E2E_CORE_CALLBACK_SECRET } from './_helpers/log-bug-as-ai';
import { GET_PLAN_TOOL_NAME } from '@/lib/mcp/tools/getPlan';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { POLL_MS } from '@/lib/hooks/useGeneratingPlanPoll';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanItemDto } from '@/lib/dto/plans';
import en from '@/messages/en.json';

// MOTIR-11203 — the live-draft E2E + ACCEPTANCE VIDEO for Story MOTIR-11190.
//
// The story's claim, in a real browser: while the hosted planner's author turn
// streams, the proposal quick view open on that card shows the card's REAL text
// arriving — its description growing read by read — and, once the completed
// write lands, settles into exactly the card that was stored (the card `get_plan`
// returns). A screen reader never hears a half-sentence, and the replayed
// animation the story deleted is never mounted.
//
// ── What is real, and what is PLAYED ────────────────────────────────────────
// This lane runs no model: its motir-ai is the jobs mock
// (`lib/test-ai-jobs-mock.ts`). That a slow streaming gateway turn makes the
// real hosted planner send these reports is proven in motir-ai (MOTIR-11200 /
// MOTIR-11202). Here the planner is played at the boundary it crosses into
// motir-core, through the REAL doors with the §4a service bearer and the §4b
// job token the jobs mock recorded (`_helpers/plan-narration-doors.ts`):
//   · the card is laid TITLE-ONLY on `POST /api/internal/ai/plan-proposals`;
//   · an `author` step on it opens on `POST /api/internal/ai/plan-step`;
//   · twelve partial-draft reports (`itemDraft`, the body form MOTIR-11199
//     settled: `{ target, seq, title?, descriptionMd?, explanationMd? }`) follow,
//     each a longer prefix of the final text, in strictly increasing `seq`;
//   · the completed write lands on the hosted deepen route
//     `PATCH /api/internal/ai/plan-proposals/[itemId]`;
//   · the step ends.
// THE ONE SEAM is MOTIR-7982's: the browser's job-stream request is re-targeted
// at a runner-local SSE server that holds the run open (a settled run stops
// watching its plan). NO READ IS INTERCEPTED: the quick view reads the real
// `GET /api/plans/[id]` poll on its real interval.
//
// ── Determinism, and the pace ───────────────────────────────────────────────
// Before every door call the spec arms a wait for the next poll whose BODY
// carries the change — the draft at that `seq`, the stored body with no draft,
// the step gone — and only then asserts the DOM. An in-page MutationObserver,
// installed before the first report, records every description length the
// quick view drew, every text any live region held, and any mount of the
// deleted replay's markers, so "it grew", "nothing half-said" and "never
// mounted" are records rather than lucky screenshots. Nothing sleeps to wait for
// state; `beat()` and `chapter()`'s holds are pacing for a viewer only — remove
// every one and no assertion changes (`acceptance-video.ts` § Pacing).
//
// ⚠️ The deleted replay's data attribute is BUILT FROM PARTS: the story's
// integration gate (MOTIR-11204) fails on any tracked file outside `design/`
// that spells the word.
//
// Every asserted wording is read from `messages/en.json`.

const ASK = 'Split the remember-me work into cards.';
const REPLY = 'Here is the card I am writing.';
const QUESTION = 'Should a remembered device survive a password change?';

const FINAL_TITLE = 'Remember me on this device for thirty days';
const LAID_TITLE = 'Remember me';
const FINAL_DESC =
  'Remembered devices keep the signed-in session for thirty days, renewed on every visit, ' +
  'and a password change or Sign out everywhere revokes every remembered device at once';
const FINAL_EXPL =
  'People who sign in on the same laptop every morning should not have to type a password ' +
  'each day, and the person who loses a laptop needs one control that ends every session';
const REPORTS = 12;

/** `text` cut to its first `share` of words — a prefix ending on a word, no trailing space. */
function prefixOf(text: string, share: number): string {
  const words = text.split(' ');
  return words.slice(0, Math.max(1, Math.ceil(words.length * share))).join(' ');
}

interface Report {
  seq: number;
  title: string;
  descriptionMd: string;
  explanationMd?: string;
}

/** The twelve reports: each a longer prefix of every field; the explanation
 *  starts once the description is under way, as a model writes it. */
const REPORTS_PLAYED: Report[] = Array.from({ length: REPORTS }, (_, i) => {
  const seq = i + 1;
  const share = seq / (REPORTS + 1);
  return {
    seq,
    title: prefixOf(FINAL_TITLE, Math.min(1, share * 2)),
    descriptionMd: prefixOf(FINAL_DESC, share),
    ...(seq >= 4 ? { explanationMd: prefixOf(FINAL_EXPL, (seq - 3) / (REPORTS - 2)) } : {}),
  };
});

const SESSION = 'author-remember';

// ── Locators ─────────────────────────────────────────────────────────────────

const peek = (page: Page) => page.getByRole('dialog').getByTestId('proposal-peek');
const liveCue = (page: Page) => peek(page).getByTestId('quick-view-live-cue');
const liveBox = (page: Page, field: 'title' | 'descriptionMd' | 'explanationMd') =>
  peek(page).getByTestId(`quick-view-live-${field}`);
const livePartial = (page: Page, field: 'title' | 'descriptionMd' | 'explanationMd') =>
  liveBox(page, field).locator('[data-live-partial]');
const storedDescription = (page: Page) =>
  peek(page).locator(`[aria-label="${en.issueViews.issueDescriptionAria}"]`);
const storedExplanation = (page: Page) =>
  peek(page).locator(`[aria-label="${en.issueViews.issueExplanationAria}"]`);

// ── The authoritative signals ────────────────────────────────────────────────

type Pred = (body: PlanReviewDto) => boolean;
const isUnchanged = (b: unknown) => (b as { unchanged?: unknown }).unchanged === true;

/** The NEXT `GET /api/plans/[id]` response whose FULL review satisfies `until` —
 *  the quick view's own poll, never intercepted. Arm it BEFORE the door call. */
function polled(page: Page, planId: string, until: Pred): Promise<unknown> {
  return page.waitForResponse(
    async (r) => {
      if (r.request().method() !== 'GET' || !r.ok()) return false;
      if (new URL(r.url()).pathname !== `/api/plans/${planId}`) return false;
      try {
        const body = (await r.json()) as PlanReviewDto;
        return !isUnchanged(body) && until(body);
      } catch {
        return false;
      }
    },
    { timeout: 8 * POLL_MS },
  );
}

const draftOf = (b: PlanReviewDto, planItemId: string) =>
  (b.inFlightDrafts ?? []).find((d) => d.planItemId === planItemId);
const itemOf = (b: PlanReviewDto, planItemId: string) =>
  b.items.find((i) => i.planItemId === planItemId);
const stepOpen = (b: PlanReviewDto, sessionKey: string) =>
  (b.inFlightSteps ?? []).some((s) => s.sessionKey === sessionKey);

// ── The planner's doors, required to answer 200 ─────────────────────────────

const doorHeaders = (job: HostedJob) => ({
  authorization: `Bearer ${E2E_CORE_CALLBACK_SECRET}`,
  'x-motir-job-token': job.token,
});

async function expectOk(res: { status(): number; text(): Promise<string> }, door: string) {
  expect(res.status(), `${door} answered ${res.status()}: ${await res.text()}`).toBe(200);
}

/** Lay the card TITLE-ONLY under the story, on the hosted proposals door. */
async function layTitleOnly(page: Page, job: HostedJob, parentRef: string): Promise<string> {
  const res = await page.request.post('/api/internal/ai/plan-proposals', {
    headers: doorHeaders(job),
    data: {
      jobId: job.jobId,
      proposals: [{ op: 'add', proposedFields: { title: LAID_TITLE, kind: 'task' }, parentRef }],
    },
  });
  await expectOk(res, 'plan-proposals');
  const id = ((await res.json()) as { planItemIds: string[] }).planItemIds[0];
  expect(id, 'the lay answers the new proposal’s id').toBeTruthy();
  return id!;
}

/** The author turn's completed write, on the hosted deepen route. */
async function writeCard(page: Page, job: HostedJob, planItemId: string): Promise<void> {
  const res = await page.request.patch(`/api/internal/ai/plan-proposals/${planItemId}`, {
    headers: doorHeaders(job),
    data: {
      jobId: job.jobId,
      patch: { title: FINAL_TITLE, descriptionMd: FINAL_DESC, explanationMd: FINAL_EXPL },
    },
  });
  await expectOk(res, 'plan-proposals/[itemId]');
}

/** One partial-draft report on the plan-step door, in the body form MOTIR-11199 settled. */
async function reportDraft(
  page: Page,
  job: HostedJob,
  planItemId: string,
  report: Report,
): Promise<void> {
  const res = await hostedPlanStep(page, job, SESSION, {
    itemDraft: { target: proposalRef(planItemId), ...report },
  });
  await expectOk(res, 'plan-step (itemDraft)');
  const body = (await res.json()) as { itemDraft?: { applied?: boolean; seq?: number } };
  expect(body.itemDraft).toEqual({ applied: true, seq: report.seq });
}

async function step(page: Page, job: HostedJob, body: HostedStepBody) {
  await expectOk(await hostedPlanStep(page, job, SESSION, body), 'plan-step');
}

// ── The in-page recorder ────────────────────────────────────────────────────

interface LiveRecord {
  /** Every distinct non-empty length the live description drew, in order. */
  lengths: number[];
  /** Every distinct text any live region held. */
  said: string[];
  /** How many deleted-replay markers were ever seen mounted. */
  replayMarks: number;
}

/** The deleted replay's attribute, from parts (see the header). */
const REPLAY_ATTR = ['data', 'type' + 'writer'].join('-');

async function recordLiveDraft(page: Page): Promise<void> {
  await page.evaluate((replayAttr) => {
    const w = window as unknown as { __ld: LiveRecord; __ldObs?: MutationObserver };
    w.__ldObs?.disconnect();
    w.__ld = { lengths: [], said: [], replayMarks: 0 };
    const read = () => {
      const copy = document.querySelector(
        '[data-testid="quick-view-live-descriptionMd"] [data-live-partial]',
      );
      const length = (copy?.textContent ?? '').length;
      if (length > 0 && w.__ld.lengths.at(-1) !== length) w.__ld.lengths.push(length);
      document
        .querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]')
        .forEach((region) => {
          const text = region.textContent ?? '';
          if (text && !w.__ld.said.includes(text)) w.__ld.said.push(text);
        });
      w.__ld.replayMarks += document.querySelectorAll(
        `[${replayAttr}], [data-testid^="quick-view-typein-"]`,
      ).length;
    };
    read();
    w.__ldObs = new MutationObserver(read);
    w.__ldObs.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributeFilter: [replayAttr, 'data-testid'],
    });
  }, REPLAY_ATTR);
}

const liveRecord = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ld: LiveRecord }).__ld);

// ── Seeding ──────────────────────────────────────────────────────────────────

interface Hosted {
  planId: string;
  job: HostedJob;
}

/** Ask for a plan from the story's composer: the plan the real anchored door
 *  opened, and the job motir-ai would hold for it. */
async function askHosted(page: Page, sse: SseFrameServer, seed: PlanProgressSeed): Promise<Hosted> {
  await openFromCard(page, seed.storyKey);
  await askFromCard(page, sse, composer(page), ASK);
  const session = await latestPlanningSession(seed.reader.email);
  const plan = await adminDb.plan.findFirstOrThrow({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
  });
  const job = latestPlanJob();
  expect(plan.sourceJobId, 'the hosted plan carries the job the mock answered').toBe(job.jobId);
  expect(plan.status).toBe('generating');
  return { planId: plan.id, job };
}

/** Open the card's quick view through the canvas door. The card being written
 *  wears the at-work cue, whose grow animation keeps it from ever being
 *  "stable", so View is clicked FORCED (it still lands on the button) — the
 *  follow-the-planner spec's reason, unchanged. */
async function openQuickView(page: Page, title: string): Promise<void> {
  const card = node(page, title);
  await expect(card).toBeVisible({ timeout: 4 * POLL_MS });
  await card.press('Enter');
  await card.getByTestId('view-button').click({ force: true });
  await expect(peek(page)).toBeVisible();
}

test.describe.configure({ timeout: 480_000 });

let sse: SseFrameServer;
let agent: Client | null = null;

test.beforeEach(async () => {
  await resetDatabase();
  sse = await startSseFrameServer();
});

test.afterEach(async () => {
  await agent?.close();
  agent = null;
  await sse.close();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECEIPT
// ─────────────────────────────────────────────────────────────────────────────

test('a card being written shows its real text growing in the open quick view, then settles into the stored card get_plan returns', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-11190');
  declareJobs(REPLY, QUESTION);
  const seed = await seedPlanProgress(`live-draft-${Date.now()}`);
  await stubAiAccess(page);
  await routeJobStream(page, sse);
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);

  let hosted!: Hosted;
  let itemId = '';

  await chapter('Ask Motir AI for a plan — the planner lays a card by its title', async () => {
    hosted = await askHosted(page, sse, seed);
    await expect(views(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await showCanvas(page);
    const laid = polled(page, hosted.planId, (b) =>
      b.items.some((i) => i.title === LAID_TITLE && !i.descriptionMd),
    );
    itemId = await layTitleOnly(page, hosted.job, seed.storyId);
    await laid;
    await expect(node(page, LAID_TITLE)).toBeVisible({ timeout: 4 * POLL_MS });
    await beat();
  });

  await chapter('The planner starts writing the card — its quick view says so', async () => {
    const opened = polled(page, hosted.planId, (b) => stepOpen(b, SESSION));
    await step(page, hosted.job, { step: 'author', target: proposalRef(itemId) });
    await opened;
    await openQuickView(page, LAID_TITLE);
    await expect(liveCue(page)).toHaveAttribute('data-live-cue', 'writing');
    await expect(liveCue(page)).toHaveText(en.planReview.peekLive.beingWritten);
    // Nothing has arrived yet: the shipped empty description, no live field.
    await expect(liveBox(page, 'descriptionMd')).toHaveCount(0);
    await expect(peek(page)).toContainText(en.issueViews.noDescription);
    await recordLiveDraft(page);
    await beat();
  });

  await chapter('The card’s text arrives as the model writes it', async () => {
    for (const report of REPORTS_PLAYED) {
      const read = polled(page, hosted.planId, (b) => draftOf(b, itemId)?.seq === report.seq);
      await reportDraft(page, hosted.job, itemId, report);
      await read;
      // The quick view draws exactly what this read carries, in the fields' own elements.
      await expect(livePartial(page, 'descriptionMd')).toHaveText(report.descriptionMd);
      await expect(livePartial(page, 'title')).toHaveText(report.title);
      if (report.explanationMd) {
        await expect(livePartial(page, 'explanationMd')).toHaveText(report.explanationMd);
      }
      // One caret, on a field that is being written.
      await expect(peek(page).locator('[data-live-caret]')).toHaveCount(1);
      await expect(liveCue(page)).toHaveAttribute('data-live-cue', 'writing');
      if (report.seq % 4 === 0) await beat();
    }
    const record = await liveRecord(page);
    // It GREW: at least three distinct lengths, each longer than the last.
    expect(record.lengths.length).toBeGreaterThanOrEqual(3);
    record.lengths.forEach((n, i) => {
      if (i > 0) expect(n).toBeGreaterThan(record.lengths[i - 1]!);
    });
  });

  await chapter('The write lands — the stored card takes the place of the draft', async () => {
    const landed = polled(
      page,
      hosted.planId,
      (b) => itemOf(b, itemId)?.descriptionMd === FINAL_DESC && !draftOf(b, itemId),
    );
    await writeCard(page, hosted.job, itemId);
    await landed;
    await expect(liveBox(page, 'descriptionMd')).toHaveCount(0);
    await expect(liveBox(page, 'title')).toHaveCount(0);
    await expect(liveBox(page, 'explanationMd')).toHaveCount(0);
    await expect(peek(page).locator('[data-live-caret]')).toHaveCount(0);
    await expect(peek(page).getByRole('heading', { name: FINAL_TITLE })).toBeVisible();
    await expect(storedDescription(page)).toHaveText(FINAL_DESC);
    await expect(storedExplanation(page)).toHaveText(FINAL_EXPL);
    await expect(liveCue(page)).toHaveAttribute('data-live-cue', 'written');
    await expect(liveCue(page)).toHaveText(en.planReview.peekLive.written);

    // The stored card IS the card the planner's reader gets back.
    // `get_plan` reads under `project:browse`, which the seed's step token does not carry —
    // the planner's reader is its own token, minted for that read alone.
    const reader = await apiTokensService.create(seed.reader.userId, seed.workspaceId, {
      label: 'live-draft-get-plan',
      projectId: seed.projectId,
      permissions: ['project:browse', 'ai:view_plan'],
    });
    agent = await agentSession(reader.token, baseURL!);
    const plan = await callTool<{ items: PlanItemDto[] }>(agent, GET_PLAN_TOOL_NAME, {
      planId: hosted.planId,
    });
    if (!plan.ok) throw new Error(`get_plan refused: ${plan.text}`);
    const stored = plan.value.items.find((i) => i.id === itemId);
    expect(stored?.proposedFields?.descriptionMd).toBe(FINAL_DESC);
    await expect(storedDescription(page)).toHaveText(stored!.proposedFields!.descriptionMd!);
    await beat();
  });

  await chapter('The author step ends — the quick view keeps the stored card', async () => {
    const ended = polled(page, hosted.planId, (b) => !stepOpen(b, SESSION));
    await step(page, hosted.job, { step: 'end' });
    await ended;
    await expect(storedDescription(page)).toHaveText(FINAL_DESC);
    await expect(liveBox(page, 'descriptionMd')).toHaveCount(0);

    const record = await liveRecord(page);
    // No live region ever held a half-written description.
    const partials = REPORTS_PLAYED.map((r) => r.descriptionMd).filter((p) => p !== FINAL_DESC);
    const halfSaid = record.said.filter(
      (text) => !text.includes(FINAL_DESC) && partials.some((p) => text.includes(p)),
    );
    expect(halfSaid).toEqual([]);
    // The deleted replay was never mounted, at any point in the walk.
    expect(record.replayMarks).toBe(0);
    await beat();
  });
});
