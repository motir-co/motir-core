import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page, Route } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { agentSession } from './_helpers/agent-authored-plan-seed';
import {
  backdatePlanActivity,
  nudgePlan,
  seedPlanProgress,
  PLAN_PROGRESS_PASSWORD,
  type PlanProgressSeed,
} from './_helpers/plan-progress-seed';
import {
  arrival,
  arrivals,
  askFromCard,
  boxes,
  cuedNodes,
  expectSameBoxes,
  fill,
  hasStep,
  holdRunStream,
  hostedRunOf,
  hostedStep,
  liveState,
  mcpAdd,
  mcpCreatePlan,
  mcpStep,
  node,
  nodeLayer,
  openFromCard,
  openPlanningTab,
  openRow,
  planPolled,
  planReview,
  planRow,
  rail,
  ref,
  resetJobsFixture,
  showCanvas,
  stubAiAccess,
  tool,
  views,
  type HostedRun,
} from './_helpers/plan-progress-harness';
import { plansService } from '@/lib/services/plansService';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { ADD_PLAN_ITEMS_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { FAILING_AFTER, POLL_MS } from '@/lib/hooks/useGeneratingPlanPoll';
import { PLAN_STALLED_AFTER_MS } from '@/lib/plans/planProgress';
import type { PlanStepKindDto } from '@/lib/dto/plans';
import en from '@/messages/en.json';

// The wave-band path, read from `design/brand/wave-band-24.svg` (pinned to
// `WAVE_BAND_PATH` byte for byte by `tests/brand/waveBand.test.ts`):
// `@motir/brand` exports ESM only, which Playwright's CommonJS transform cannot
// `require`.
const WAVE_BAND_PATH = /\sd="([^"]+)"/.exec(
  readFileSync(join(process.cwd(), 'design', 'brand', 'wave-band-24.svg'), 'utf8'),
)![1]!;

// MOTIR-8419 — the E2E + ACCEPTANCE VIDEO for MOTIR-8413, *Motir at work*.
//
// The story's claim, in a real browser: while Motir writes a plan, the card it is
// writing turns warm orange and MOVES (it pops, then breathes) while its
// neighbours stay still, several cards move each on its own, the Motir mark beside
// the planner's notes moves (since MOTIR-9213 the working turn's avatar, flowing in
// colour) — and every one of them stops the
// moment the writing stops: when the plan is proposed, when it stalls, when the
// reads keep failing, and for a reader who asked for reduced motion. The design of
// record is `design/ai-chat/design-notes.md` § _Motir at work_ (MOTIR-8414,
// approved), and its States table is what each case below walks.
//
// ── THE ASSERTION IS THE MOTION, NEVER ITS MARKER ───────────────────────────
// `data-cue-motion` and `data-at-work` are the LOCATORS (the design's hooks).
// Whether something MOVES is read from the browser's own animation set —
// `el.getAnimations()`, filtered on `playState === 'running'` — on the rendered
// surface with the shipped stylesheet loaded. A marker says an element was GIVEN
// an animation; only that reading says one is running. The MARK is the one
// exception: since MOTIR-9213 it flows by a frame loop rewriting its path, which
// no animation set lists, so its reading is the path changing across two frames
// (`markFlows`). (The vitest tier loads no
// stylesheet, so this is the lowest tier where the reading means anything.)
//
// ── What is real ────────────────────────────────────────────────────────────
// Both planner DOORS are driven exactly as the shipped receipt drives them
// (`regression-plan-progress.spec.ts`, whose plumbing this spec shares through
// `./_helpers/plan-progress-harness.ts`): Motir AI's hosted planner through its
// job's step service method, and an MCP planner through the real MCP SDK against
// this lane's `/api/mcp`, on a plan `create_plan` wrote with no turns at all. The
// canvas and the rail read the real `GET /api/plans/[id]` poll. The ONE browser
// seam besides the hosted run's held job stream is the failing window: the plan's
// own review read is aborted with `page.route`, because the poll is a
// browser-initiated GET and its failing threshold (`FAILING_AFTER`) is a count of
// failed reads, not a time — so nothing waits out the poll's 15 s stall bound.
//
// ── Determinism ─────────────────────────────────────────────────────────────
// After a door call the spec waits for the next poll response whose BODY carries
// the change (armed before the call), then asserts the DOM. A finite animation
// (the pop, the ring's arrival, a card's entrance) is allowed to finish by
// polling the rendered reading (`expect.poll`), never by sleeping. The LEAVING
// form lasts a few hundred milliseconds, too short to sample from the runner, so
// an in-page recorder (`CUE_RECORDER`) writes down each node's `data-cue-motion`
// and the ring's running animations at the moment the attribute changes. The
// receipt's holds (`beat()`, `chapter()`'s own) are pacing for a viewer only.
//
// ── Two deliberate departures from the card's text, both from the design ───
// · STALLED HOLDS the last card's cue, STATIC. The card says a stalled plan shows
//   no cue; the approved design's States table (newer, approved) says the card
//   the snapshot's steps last named keeps the orange static cue at rest size — no
//   pop, no growth, no glow — so a person can still see which card was being
//   written. So the stalled case asserts the cue DRAWN and NOTHING RUNNING.
// · REDUCED MOTION draws the mark present and still. Since MOTIR-9213 the mark is
//   the working turn's avatar and its motion is a frame loop that never starts
//   under reduce, so the still inverted glyph is all a reader sees there
//   (`design-notes.md` § _The Motir mark at work_ › _Reduced motion_).
//
// EVERY ASSERTED WORDING is read from `messages/en.json`, never retyped.

const cueCopy = en.planReview.cue;

// ── The at-work readings — the browser's own animation set ───────────────────

/** How many animations are RUNNING on `el` and everything inside it. */
const runningIn = (target: Locator) =>
  target.evaluate(
    (el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
  );

/** The INFINITE animations running on a card's box and ring, with when each began
 *  — the reading that says whether a card was restarted. */
const loopsOf = (target: Locator) =>
  target.evaluate((el) =>
    el
      .getAnimations({ subtree: true })
      .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity)
      .map((a) => ({
        name: (a as CSSAnimation).animationName,
        startTime: a.startTime === null ? null : Number(a.startTime),
      }))
      .sort((x, y) => x.name.localeCompare(y.name)),
  );

const ring = (page: Page, title: string) => node(page, title).locator('.canvas-cue-ring');
const chip = (page: Page, title: string) => node(page, title).getByTestId('canvas-cue-drafting');
const mark = (page: Page) => rail(page).getByTestId('plan-at-work-mark');

/**
 * Is the mark FLOWING (MOTIR-9213)? Its motion is a frame loop rewriting the
 * glyph's path, not a CSS animation, so `getAnimations()` cannot see it: the
 * reading is whether the path's `d` changes across two animation frames, in the
 * page, with the shipped component running.
 */
const markFlows = (page: Page) =>
  mark(page).evaluate(
    (el) =>
      new Promise<boolean>((resolve) => {
        const path = el.querySelector('path');
        const before = path?.getAttribute('d') ?? null;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(path?.getAttribute('d') !== before)),
        );
      }),
  );

/** The card MOVES: it is cued `at-work`, and its ring reports a running loop. */
async function expectMoving(page: Page, title: string): Promise<void> {
  await expect(node(page, title)).toHaveAttribute('data-cue', 'drafting');
  await expect(node(page, title)).toHaveAttribute('data-cue-motion', 'at-work');
  await expect
    .poll(() => runningIn(ring(page, title)), { timeout: 4 * POLL_MS })
    .toBeGreaterThan(0);
}

/** The card is STILL: nothing on it or inside it is running. */
async function expectStill(page: Page, title: string): Promise<void> {
  await expect.poll(() => runningIn(node(page, title)), { timeout: 4 * POLL_MS }).toBe(0);
}

/** Nothing on the canvas is running, and the mark does not flow. */
async function expectNothingAnimates(page: Page): Promise<void> {
  await expect.poll(() => runningIn(nodeLayer(page)), { timeout: 4 * POLL_MS }).toBe(0);
  await expect.poll(() => runningIn(mark(page)), { timeout: 4 * POLL_MS }).toBe(0);
  await expect.poll(() => markFlows(page), { timeout: 4 * POLL_MS }).toBe(false);
}

/** The mark is AT WORK: its at-work form, and its glyph flows. */
async function expectMarkAtWork(page: Page): Promise<void> {
  await expect(mark(page)).toHaveAttribute('data-at-work', 'true', { timeout: 4 * POLL_MS });
  await expect.poll(() => markFlows(page), { timeout: 4 * POLL_MS }).toBe(true);
}

/** The mark is STATIC: drawn, its at-work form gone, and its glyph back at rest. */
async function expectMarkStatic(page: Page): Promise<void> {
  await expect(mark(page)).toBeVisible();
  await expect(mark(page)).toHaveAttribute('data-at-work', 'false', { timeout: 4 * POLL_MS });
  await expect.poll(() => markFlows(page), { timeout: 4 * POLL_MS }).toBe(false);
  await expect(mark(page).locator('path')).toHaveAttribute('d', WAVE_BAND_PATH);
}

// ── The cue record — the leaving form is RECORDED, not polled for ────────────

interface CueEvent {
  /** A node's `data-cue-motion`, or the marker's `data-state` (`kind: 'state'`). */
  kind: 'cue' | 'state';
  value: string;
  text: string;
  /** The ring's running animations at that moment (cue events only). */
  running: string[];
}

/**
 * Write down every `data-cue-motion` a node box takes and every `data-state` the
 * live marker takes — at insertion and on change — with the cue ring's running
 * animations read at that same moment (`getAnimations()` flushes style, so it
 * sees the rule the new attribute selects).
 */
const CUE_RECORDER = () => {
  const w = window as unknown as { __cue: CueEvent[] };
  w.__cue = [];
  const note = (el: Element) => {
    if (el.hasAttribute('data-node-id')) {
      const value = el.getAttribute('data-cue-motion');
      if (!value) return;
      const r = el.querySelector(':scope > .canvas-cue-ring');
      const running = r
        ? r
            .getAnimations()
            .filter((a) => a.playState === 'running')
            .map((a) => (a as CSSAnimation).animationName)
        : [];
      w.__cue.push({ kind: 'cue', value, text: (el.textContent ?? '').slice(0, 200), running });
    } else if (el.getAttribute('data-testid') === 'plan-live-state') {
      const value = el.getAttribute('data-state');
      if (value) w.__cue.push({ kind: 'state', value, text: '', running: [] });
    }
  };
  const scan = (root: Node) => {
    if (!(root instanceof Element)) return;
    note(root);
    root.querySelectorAll('[data-cue-motion], [data-testid="plan-live-state"]').forEach(note);
  };
  const start = () =>
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') note(r.target as Element);
        else r.addedNodes.forEach(scan);
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-cue-motion', 'data-state'],
    });
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
};

const cueLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { __cue?: CueEvent[] }).__cue ?? []);

const cueEvents = async (page: Page, value: string, title: string) =>
  (await cueLog(page)).filter(
    (e) => e.kind === 'cue' && e.value === value && e.text.includes(title),
  );

const statesSeen = async (page: Page) =>
  (await cueLog(page)).filter((e) => e.kind === 'state').map((e) => e.value);

// ── The plan's own review read, and the failing window ───────────────────────

const isReviewRead = (planId: string) => (url: URL) => url.pathname === `/api/plans/${planId}`;

/** The next ANSWERED read of the plan's review — full or "unchanged since". */
function reviewAnswered(page: Page, planId: string): Promise<unknown> {
  return page.waitForResponse(
    (r) =>
      r.request().method() === 'GET' &&
      new URL(r.url()).pathname === `/api/plans/${planId}` &&
      r.status() < 400,
    { timeout: 8 * POLL_MS },
  );
}

/** Abort the plan's own review read — `count` times, or until `release()`. */
async function dropReviewReads(page: Page, planId: string, count = Infinity) {
  let dropped = 0;
  const matcher = isReviewRead(planId);
  const handler = async (route: Route) => {
    if (dropped < count) {
      dropped += 1;
      await route.abort('failed');
    } else {
      await route.continue();
    }
  };
  await page.route(matcher, handler);
  return {
    dropped: () => dropped,
    release: () => page.unroute(matcher, handler),
  };
}

// ── The two doors — the same steps, whichever planner wrote the plan ─────────

type DoorName = 'hosted' | 'mcp';
const DOORS: readonly DoorName[] = ['hosted', 'mcp'];

/** A plan being written, open on its canvas, and the one door its planner uses. */
interface Door {
  name: DoorName;
  planId: string;
  /** Propose cards under `parent` ('story' — the level on screen — or 'task',
   *  one level down); returns each card's plan-item id, in order. */
  lay(titles: readonly string[], parent: 'story' | 'task'): Promise<string[]>;
  step(sessionKey: string, step: PlanStepKindDto | 'end', targetRef?: string | null): Promise<void>;
  /** The walk closes: the plan leaves `generating`. */
  close(): Promise<void>;
  dispose(): Promise<void>;
}

/** Open a fresh `generating` plan through `name`'s door, on its canvas, with
 *  nothing proposed yet — the design's `starting`. */
async function openDoor(
  name: DoorName,
  page: Page,
  baseURL: string,
  seed: PlanProgressSeed,
): Promise<Door> {
  if (name === 'hosted') {
    await stubAiAccess(page);
    const stream = await holdRunStream(page);
    await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
    await openFromCard(page, seed.storyKey);
    const planId = await askFromCard(page, seed.reader.email, 'Split the at-work work into cards.');
    const run: HostedRun = await hostedRunOf(planId, seed.reader.ctx);
    await expect(views(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await showCanvas(page);
    return {
      name,
      planId,
      async lay(titles, parent) {
        const laid = await plansService.addProposals(
          planId,
          titles.map((title) => ({
            op: 'add' as const,
            proposedFields: { title, kind: parent === 'story' ? 'task' : 'subtask' },
            parentRef: parent === 'story' ? seed.storyId : seed.taskId,
          })),
          seed.reader.ctx,
        );
        return laid.appendedItemIds;
      },
      step: (sessionKey, step, targetRef = null) => hostedStep(run, sessionKey, step, targetRef),
      async close() {
        await aiGenerationService.appendProposals(run.jobId, [], run.auth.ctx, { final: true });
      },
      async dispose() {
        stream.release();
      },
    };
  }

  const agent: Client = await agentSession(seed.token, baseURL);
  const title = `Agent plan — Motir at work ${slug()}`;
  // `create_plan` and nothing else: a plan with NO turns, the shape the story names.
  const planId = await mcpCreatePlan(agent, seed, title, { harness: 'acme-planning-harness' });
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
  await openPlanningTab(page);
  const opened = planPolled(page, planId, (b) => b.status === 'generating');
  await openRow(page, planRow(page, title));
  await opened;
  await showCanvas(page);
  return {
    name,
    planId,
    lay: (titles, parent) =>
      mcpAdd(agent, planId, titles, parent === 'story' ? seed.storyKey : seed.taskKey),
    step: (sessionKey, step, targetRef = null) =>
      mcpStep(agent, planId, sessionKey, step, targetRef ?? undefined),
    async close() {
      await tool(agent, ADD_PLAN_ITEMS_TOOL_NAME, { planId, proposals: [], final: true });
    },
    dispose: () => agent.close(),
  };
}

/** One step through the door, met on the poll whose body carries it. */
async function stepAndRead(
  page: Page,
  door: Door,
  sessionKey: string,
  step: PlanStepKindDto | 'end',
  targetRef: string | null,
  until: Parameters<typeof planPolled>[2],
): Promise<void> {
  const read = planPolled(page, door.planId, until);
  await door.step(sessionKey, step, targetRef);
  await read;
}

/** Lay `titles` on the level on screen and wait for every card to be drawn. */
async function layLevel(page: Page, door: Door, titles: readonly string[]): Promise<string[]> {
  const ids = await door.lay(titles, 'story');
  for (const t of titles) await expect(node(page, t)).toBeVisible({ timeout: 4 * POLL_MS });
  return ids;
}

// The cards — every title distinct, none a substring of another.
const W1 = 'Turn the drafted card warm orange';
const W2 = 'Let the second card breathe on its own';
const W3 = 'Keep the quiet neighbour still';
const W4 = 'Count the card drafted one level down';
const W5 = 'Settle the card the writing left';

let counter = 0;
const slug = () => `${Date.now()}-${++counter}`;

test.describe.configure({ timeout: 420_000 });

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  resetJobsFixture();
  await page.addInitScript(CUE_RECORDER);
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECEIPT
// ─────────────────────────────────────────────────────────────────────────────

test('while Motir writes a plan, the card it is writing and the Motir mark move, each card on its own, and everything settles when the writing stops', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-8413');

  // The chapter starts are measured here, as they were when this spec asserted
  // the receipt's watchability floor (see the end of the test).
  const t0 = Date.now();
  const starts: number[] = [];
  const timed = (label: string, body: () => Promise<void>) => {
    starts.push((Date.now() - t0) / 1000);
    return chapter(label, body);
  };

  const seed = await seedPlanProgress(slug());
  let door!: Door;
  const ids: Record<string, string> = {};
  let level: string[] = [];
  let before: Record<string, number[]> = {};

  try {
    await timed('Ask Motir AI for a plan — the mark is at work, and no card yet', async () => {
      door = await openDoor('hosted', page, baseURL!, seed);
      await expect(liveState(page)).toHaveText(planReview.liveStarting, { timeout: 4 * POLL_MS });
      await expectMarkAtWork(page);
      await expect(cuedNodes(page)).toHaveCount(0);
      await expect.poll(() => runningIn(nodeLayer(page)), { timeout: 4 * POLL_MS }).toBe(0);
      await beat();
    });

    await timed(
      'Motir writes one card — it turns orange and moves, its neighbours stay still',
      async () => {
        [ids[W1], ids[W2], ids[W3]] = (await layLevel(page, door, [W1, W2, W3])) as [
          string,
          string,
          string,
        ];
        [ids[W4]] = (await door.lay([W4], 'task')) as [string];
        level = [W1, W2, W3, seed.taskTitle];
        await expectNothingAnimatesOnCards(page, level);
        before = await boxes(page, level);

        await stepAndRead(page, door, 'author-1', 'author', ref(ids[W1]!), (b) =>
          hasStep(b.inFlightSteps, 'author-1', ref(ids[W1]!)),
        );
        await expectMoving(page, W1);
        await expect(chip(page, W1)).toContainText(cueCopy.drafting);
        for (const t of [W2, W3, seed.taskTitle]) await expectStill(page, t);
        await expectMarkAtWork(page);
        expectSameBoxes(before, await boxes(page, level));
        await beat();
      },
    );

    await timed('A second card is written — each card moves on its own', async () => {
      const first = await loopsOf(node(page, W1));
      expect(first.length, `${W1} runs its loops`).toBeGreaterThan(0);
      await stepAndRead(page, door, 'author-2', 'author', ref(ids[W2]!), (b) =>
        hasStep(b.inFlightSteps, 'author-2', ref(ids[W2]!)),
      );
      await expectMoving(page, W2);
      // Cueing the second card did not restart the first.
      expect(await loopsOf(node(page, W1))).toEqual(first);
      await expectStill(page, W3);
      expectSameBoxes(before, await boxes(page, level));
      await beat();
    });

    await timed('A card one level down is drafted — counted here, not followed', async () => {
      await stepAndRead(page, door, 'author-3', 'author', ref(ids[W4]!), (b) =>
        hasStep(b.inFlightSteps, 'author-3', ref(ids[W4]!)),
      );
      await expect(arrivals(page)).toContainText(
        fill(arrival.draftingIn, { count: 1, identifier: seed.taskKey }),
      );
      await expect(node(page, W4)).toHaveCount(0);
      expectSameBoxes(before, await boxes(page, level));
      await beat();
    });

    await timed('The writing stops — every card settles and the mark goes still', async () => {
      const closed = planPolled(page, door.planId, (b) => b.status !== 'generating');
      await door.close();
      await closed;
      await expect(cuedNodes(page)).toHaveCount(0, { timeout: 4 * POLL_MS });
      for (const t of [W1, W2]) {
        expect(
          (await cueEvents(page, 'leaving', t)).some((e) => e.running.includes('canvas-fade-out')),
          `${t}'s cue left through the leaving fade`,
        ).toBe(true);
      }
      await expectNothingAnimates(page);
      await expectMarkStatic(page);
      expectSameBoxes(before, await boxes(page, level));
      await beat();
    });
  } finally {
    await door?.dispose();
  }

  // No watchability floor here (MOTIR-9411): this spec ran in the recording
  // lane, where it asserted its clip was long enough to watch. The regression
  // lane records nothing and holds nothing, so that floor measured an apparatus
  // this lane does not have. The receipt it guarded is recorded.
});

/** Nothing running on these cards — the entrances have played out. */
async function expectNothingAnimatesOnCards(page: Page, titles: readonly string[]) {
  for (const t of titles) await expectStill(page, t);
}

// ─────────────────────────────────────────────────────────────────────────────
// FURTHER TESTS — not the receipt, no pacing holds. Each runs through BOTH doors.
// ─────────────────────────────────────────────────────────────────────────────

for (const doorName of DOORS) {
  test.describe(`through the ${doorName} planner's door`, () => {
    test('the card being written moves on its own while its neighbours hold still, the writing moving on leaves through the fade, and the close settles everything', async ({
      page,
      baseURL,
    }) => {
      const seed = await seedPlanProgress(slug());
      const door = await openDoor(doorName, page, baseURL!, seed);
      try {
        // starting — the mark moves and nothing is cued.
        await expectMarkAtWork(page);
        await expect(cuedNodes(page)).toHaveCount(0);

        const [w1, w2, w3] = await layLevel(page, door, [W1, W2, W5]);
        const [w4] = await door.lay([W4], 'task');
        const level = [W1, W2, W5, seed.taskTitle];
        await expectNothingAnimatesOnCards(page, level);
        const before = await boxes(page, level);

        // One live step names one card.
        await stepAndRead(page, door, 'author-1', 'author', ref(w1!), (b) =>
          hasStep(b.inFlightSteps, 'author-1', ref(w1!)),
        );
        await expectMoving(page, W1);
        for (const t of [W2, W5, seed.taskTitle]) await expectStill(page, t);
        expectSameBoxes(before, await boxes(page, level));

        // Two live steps — the second does not restart the first.
        const first = await loopsOf(node(page, W1));
        expect(first.length).toBeGreaterThan(0);
        expect(first.every((l) => l.startTime !== null)).toBe(true);
        await stepAndRead(page, door, 'author-2', 'author', ref(w2!), (b) =>
          hasStep(b.inFlightSteps, 'author-2', ref(w2!)),
        );
        await expectMoving(page, W2);
        expect(await loopsOf(node(page, W1))).toEqual(first);

        // A card drafted one level down — counted, not drawn, nothing moved.
        await stepAndRead(page, door, 'author-3', 'author', ref(w4!), (b) =>
          hasStep(b.inFlightSteps, 'author-3', ref(w4!)),
        );
        await expect(arrivals(page)).toContainText(
          fill(arrival.draftingIn, { count: 1, identifier: seed.taskKey }),
        );
        await expect(node(page, W4)).toHaveCount(0);
        expectSameBoxes(before, await boxes(page, level));

        // The writing moves on: author-1 leaves W1 for W5.
        const moved = planPolled(
          page,
          door.planId,
          (b) =>
            hasStep(b.inFlightSteps, 'author-1', ref(w3!)) &&
            !hasStep(b.inFlightSteps, 'author-1', ref(w1!)),
        );
        await door.step('author-1', 'end');
        await door.step('author-1', 'author', ref(w3!));
        await moved;
        await expectMoving(page, W5);
        await expect(node(page, W1)).not.toHaveAttribute('data-cue', { timeout: 4 * POLL_MS });
        const left = await cueEvents(page, 'leaving', W1);
        expect(left.length, `${W1} was retained as leaving`).toBeGreaterThan(0);
        expect(left.some((e) => e.running.includes('canvas-fade-out'))).toBe(true);
        await expectStill(page, W1);

        // The plan leaves `generating` — everything settles, nothing moved.
        const closed = planPolled(page, door.planId, (b) => b.status !== 'generating');
        await door.close();
        await closed;
        await expect(cuedNodes(page)).toHaveCount(0, { timeout: 4 * POLL_MS });
        await expect(node(page, W1).locator('.canvas-cue-ring')).toHaveCount(0);
        await expectNothingAnimates(page);
        await expectMarkStatic(page);
        expectSameBoxes(before, await boxes(page, level));
      } finally {
        await door.dispose();
      }
    });

    test('one dropped read changes nothing; reads that keep failing stop every animation while the cue stays drawn; the reads coming back restart it', async ({
      page,
      baseURL,
    }) => {
      const seed = await seedPlanProgress(slug());
      const door = await openDoor(doorName, page, baseURL!, seed);
      try {
        const [w1] = await layLevel(page, door, [W1, W3]);
        await stepAndRead(page, door, 'author-1', 'author', ref(w1!), (b) =>
          hasStep(b.inFlightSteps, 'author-1', ref(w1!)),
        );
        await expectMoving(page, W1);
        const loops = await loopsOf(node(page, W1));

        // ONE dropped read: the same animation runs on, and nothing reads reconnecting.
        const once = await dropReviewReads(page, door.planId, 1);
        // The pane reads on a push: a quiet touch of the plan causes the read to drop.
        await nudgePlan(door.planId);
        await expect.poll(() => once.dropped(), { timeout: 4 * POLL_MS }).toBe(1);
        await reviewAnswered(page, door.planId);
        await once.release();
        expect(await loopsOf(node(page, W1))).toEqual(loops);
        await expectMarkAtWork(page);
        expect(await statesSeen(page)).not.toContain('reconnecting');

        // Reads that KEEP failing: the marker reads reconnecting, and everything stops.
        const all = await dropReviewReads(page, door.planId);
        await nudgePlan(door.planId);
        await expect(liveState(page)).toHaveAttribute('data-state', 'reconnecting', {
          timeout: (FAILING_AFTER + 2) * POLL_MS,
        });
        expect(all.dropped()).toBeGreaterThanOrEqual(FAILING_AFTER);
        await expect(liveState(page)).toHaveText(planReview.liveReconnecting);
        // The last snapshot stands: the cue is still DRAWN, and still.
        await expect(node(page, W1)).toHaveAttribute('data-cue', 'drafting');
        await expect(ring(page, W1)).toHaveCount(1);
        await expect(node(page, W1)).not.toHaveAttribute('data-cue-motion');
        await expectNothingAnimates(page);
        await expectMarkStatic(page);

        // The reads come back: at work again on the next tick, with no reload.
        const back = planPolled(page, door.planId, (b) =>
          hasStep(b.inFlightSteps, 'author-1', ref(w1!)),
        );
        await all.release();
        await back;
        await expect(liveState(page)).not.toHaveAttribute('data-state', 'reconnecting');
        await expectMoving(page, W1);
        await expectMarkAtWork(page);
      } finally {
        await door.dispose();
      }
    });

    test('a plan quiet past the stalled threshold holds its last card still and the mark static, and nothing animates', async ({
      page,
      baseURL,
    }) => {
      const seed = await seedPlanProgress(slug());
      const door = await openDoor(doorName, page, baseURL!, seed);
      try {
        const [w1] = await layLevel(page, door, [W1, W3]);
        await stepAndRead(page, door, 'author-1', 'author', ref(w1!), (b) =>
          hasStep(b.inFlightSteps, 'author-1', ref(w1!)),
        );
        await expectMoving(page, W1);
        await expectMarkAtWork(page);

        const at = await backdatePlanActivity(door.planId, PLAN_STALLED_AFTER_MS + 60_000);
        await planPolled(
          page,
          door.planId,
          (b) => b.lastActivityAt !== undefined && Date.parse(b.lastActivityAt) <= at.getTime(),
        );
        await expect(liveState(page)).toHaveAttribute('data-state', 'stalled');
        await expect(liveState(page)).toHaveText(planReview.liveStalled);
        // The design's stalled HOLD: the card last written keeps its cue, static.
        await expect(node(page, W1)).toHaveAttribute('data-cue', 'drafting');
        await expect(chip(page, W1)).toContainText(cueCopy.drafting);
        await expect(node(page, W1)).not.toHaveAttribute('data-cue-motion');
        await expect(node(page, W3)).not.toHaveAttribute('data-cue');
        await expectNothingAnimates(page);
        await expectMarkStatic(page);
      } finally {
        await door.dispose();
      }
    });

    test('under reduced motion the cue and the mark are drawn and nothing animates, and a cue the writing leaves is gone at once', async ({
      page,
      baseURL,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const seed = await seedPlanProgress(slug());
      const door = await openDoor(doorName, page, baseURL!, seed);
      try {
        const [w1, w3] = await layLevel(page, door, [W1, W3]);
        await stepAndRead(page, door, 'author-1', 'author', ref(w1!), (b) =>
          hasStep(b.inFlightSteps, 'author-1', ref(w1!)),
        );
        await expect(node(page, W1)).toHaveAttribute('data-cue', 'drafting');
        await expect(ring(page, W1)).toBeVisible();
        await expect(chip(page, W1)).toBeVisible();
        await expect(chip(page, W1)).toContainText(cueCopy.drafting);
        await expect(chip(page, W1)).toHaveAccessibleName(cueCopy.draftingName);
        await expect(mark(page)).toBeVisible();
        await expectNothingAnimates(page);

        // The writing moves on: the cue is removed with nothing retained.
        const moved = planPolled(
          page,
          door.planId,
          (b) =>
            hasStep(b.inFlightSteps, 'author-1', ref(w3!)) &&
            !hasStep(b.inFlightSteps, 'author-1', ref(w1!)),
        );
        await door.step('author-1', 'end');
        await door.step('author-1', 'author', ref(w3!));
        await moved;
        await expect(node(page, W3)).toHaveAttribute('data-cue', 'drafting');
        await expect(node(page, W1)).not.toHaveAttribute('data-cue');
        expect(await cueEvents(page, 'leaving', W1)).toEqual([]);
        await expectNothingAnimates(page);
      } finally {
        await door.dispose();
      }
    });
  });
}
