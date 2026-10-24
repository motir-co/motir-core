import type { Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { agentSession } from './_helpers/agent-authored-plan-seed';
import {
  addPlanProgressStory,
  backdatePlanActivity,
  makePlanProgressPublic,
  nudgePlan,
  seedPlanProgress,
  PLAN_PROGRESS_PASSWORD,
} from './_helpers/plan-progress-seed';
import {
  AUTHORED_LEAF,
  arrivals,
  mcpAdd,
  mcpCreatePlan,
  mcpStep,
  node,
  openPlanningTab,
  patternOf,
  openRow,
  planRow,
  planPolled,
  ref,
  showCanvas,
  tool,
  workspace,
  type Steps,
} from './_helpers/plan-progress-harness';
import { ADD_PLAN_ITEMS_TOOL_NAME, UPDATE_PLAN_ITEM_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { POLL_MS } from '@/lib/hooks/useGeneratingPlanPoll';
import { PLAN_STALLED_AFTER_MS } from '@/lib/plans/planProgress';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import en from '@/messages/en.json';

// MOTIR-8597 — the follow-the-planner E2E + ACCEPTANCE VIDEO for MOTIR-8590.
//
// The story's claim, in a real browser: a person opens a plan WHILE it is being
// written and the planning canvas follows the planner level by level — holding
// on the first of several drafts rather than hopping between them — until the
// person moves it; then it stays where they put it and offers *Follow the
// planner*, which hands it back. A proposal's quick view, opened on a card that
// has no description yet, types the description in as it arrives; anything
// already written, or opened again, shows at once. Reduced motion holds still,
// and when the plan is proposed the control goes. The plan page never drives.
//
// ── Why this cannot be a lower tier ─────────────────────────────────────────
// The integration gate (MOTIR-8596) proves the seams — snapshot → driven step →
// follow request → canvas level, and snapshot → typed field — against Postgres
// with the poll on a faked clock. What only a browser shows is a person WATCHING
// it: a canvas moving under the real 2.5 s poll, a real click taking it over, a
// character-by-character reveal in a real `requestAnimationFrame` loop, and the
// `prefers-reduced-motion` media query.
//
// ── What is real, and what is not ───────────────────────────────────────────
// The planner is PLAYED through ONE door, the MCP planner, as `prompts/plan.py`
// plays it: the real MCP SDK against this lane's `/api/mcp`, with a minted token
// carrying `ai:view_plan` — `create_plan`, `add_plan_items`, `update_plan_item`
// and `report_plan_step`. Following reads only the one poll, which is
// door-agnostic, and the two doors' parity on that poll is the plan-progress
// gate's (MOTIR-7820), so the hosted door adds nothing here.
//
// THE LIVE READS ARE NEVER INTERCEPTED — the canvas, the quick view and the
// progress line read the real `GET /api/plans/[id]` poll — with ONE exception:
// chapter 5 ABORTS that poll with `page.route` for two cycles, as fault
// injection, to show a failing read holds the canvas still. It is the only
// `page.route` in this file, and it is removed inside the chapter.
//
// The plan page (chapter 10) is read as a VISITOR to the project made public:
// a member's `/plans/<id>` for an undecided plan replace-redirects to the
// overlay (MOTIR-7886), so the Visitor's page is the one place a person reads a
// GENERATING plan on `PlanDetail`. Its poll is the same `GET /api/plans/[id]`.
//
// ── Determinism, and the pace ───────────────────────────────────────────────
// After every planner call the spec waits for the next `GET /api/plans/[id]`
// response whose BODY carries the change (armed before the call), and only then
// asserts the DOM. A HOLD — "the canvas stays here" — is asserted after EACH of
// several consecutive responses that carry the steps, never after a sleep. The
// typewriter is observed by an in-page MutationObserver that records every
// length the typing copy ever held, installed before the value arrives, so
// "it typed" and "it did not" are records, never a lucky screenshot. Nothing
// sleeps to wait for state; the receipt's holds (`beat()`, `chapter()`'s own)
// are pacing for a viewer only — remove every one and every assertion is
// unchanged (`acceptance-video.ts` § Pacing).
//
// EVERY ASSERTED WORDING is read from `messages/en.json` — the follow control's
// `planningWorkspace.follow.*`, the canvas slot's `planningWorkspace.arrival.*`
// and the canvas's own `roadmap.canvas.*` — never retyped.

const follow = en.planningWorkspace.follow;
const arrival = en.planningWorkspace.arrival;

// The plan's cards — every title distinct, none a substring of another.
const A1 = 'Draft the description as it arrives';
const A2 = 'Keep the written card still';
const T1 = 'Name the cue on the task level';
const B1 = 'Hand the canvas back on press';
const C1 = 'Visitor reads the page undriven';
const C2 = 'Visitor sees the cue elsewhere';
const S2_TITLE = 'Hand the canvas over';
const BODY =
  'The planner wrote this description while the reader watched it arrive, a character at a time, ' +
  'inside the quick view that was already open on the card.';
const BODY_REDUCED = 'Under reduced motion the arriving description is simply there, in full.';

let counter = 0;
const slug = () => `${Date.now()}-${++counter}`;

test.describe.configure({ timeout: 480_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The canvas's level, read from its breadcrumb ────────────────────────────

const crumbsIn = (scope: Locator) =>
  scope.getByRole('navigation', { name: en.roadmap.canvas.breadcrumb, exact: true });
const levelIn = (scope: Locator) => crumbsIn(scope).locator('[aria-current="page"]');
const expectLevel = (page: Page, title: string) =>
  expect(levelIn(workspace(page))).toContainText(title, { timeout: 4 * POLL_MS });
const followState = (page: Page) => workspace(page).getByTestId('canvas-follow-state');
const followButton = (page: Page) => workspace(page).getByTestId('canvas-follow-planner');
const peek = (page: Page) => page.getByRole('dialog').getByTestId('proposal-peek');
const typedField = (page: Page, field: string) =>
  peek(page).getByTestId(`quick-view-typein-${field}`);

const stepOf = (steps: Steps | undefined, sessionKey: string) =>
  (steps ?? []).find((s) => s.sessionKey === sessionKey);
const carries = (b: PlanReviewDto, ...sessionKeys: string[]) =>
  sessionKeys.every((k) => stepOf(b.inFlightSteps, k) !== undefined);
const itemOf = (b: PlanReviewDto, planItemId: string) =>
  b.items.find((i) => i.planItemId === planItemId);

// The pane polls with `?since=` (MOTIR-8127): while nothing it shows has moved,
// the answer is `{ unchanged: true }` and carries no review at all. Such an
// answer never satisfies a CHANGE (it has no steps, items or status to read, so
// a negative predicate would pass on it vacuously) — and it always satisfies a
// HOLD, because whatever held at the last full read still holds.
const isUnchanged = (b: unknown) => (b as { unchanged?: unknown }).unchanged === true;
/** The next poll whose FULL review satisfies `until`. Arm it before the door call. */
const polled = (page: Page, planId: string, until: (b: PlanReviewDto) => boolean) =>
  planPolled(page, planId, (b) => !isUnchanged(b) && until(b));
/** The next poll that still holds `still`: an unchanged answer, or a full review satisfying it. */
const held = (page: Page, planId: string, still: (b: PlanReviewDto) => boolean) =>
  planPolled(page, planId, (b) => isUnchanged(b) || still(b));

/**
 * Open a card's quick view through the canvas door. A card the planner is
 * drafting wears the at-work cue, whose grow animation runs for as long as the
 * draft does, so the card is never "stable" and an ordinary click waits
 * forever; the click is FORCED past that check (it still lands on the button).
 * The keyboard is no way round it: Enter on View bubbles to the card's own
 * Enter handler, which cancels the button's click.
 */
async function openQuickView(page: Page, title: string): Promise<void> {
  const card = node(page, title);
  await expect(card).toBeVisible({ timeout: 4 * POLL_MS });
  await card.press('Enter');
  await card.getByTestId('view-button').click({ force: true });
  await expect(peek(page)).toBeVisible();
}

async function closeQuickView(page: Page): Promise<void> {
  await peek(page).getByRole('button', { name: en.common.close }).first().click();
  await expect(peek(page)).toHaveCount(0);
}

// ── The in-page recorders ───────────────────────────────────────────────────

interface TypingRecord {
  /** Every length each field's typing copy held, in order. */
  lens: Record<string, number[]>;
  /** Fields seen in the `typing` phase. */
  typed: string[];
  /** Every text any `aria-live` region held. */
  live: string[];
}

/** Record, from now on, everything the quick view's typewriter draws. */
async function recordTyping(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __typing: { lens: Record<string, number[]>; typed: string[]; live: string[] };
      __typingObs?: MutationObserver;
    };
    w.__typingObs?.disconnect();
    w.__typing = { lens: {}, typed: [], live: [] };
    const read = () => {
      document.querySelectorAll('[data-testid^="quick-view-typein-"]').forEach((box) => {
        const field = box.getAttribute('data-testid')!.slice('quick-view-typein-'.length);
        if (box.getAttribute('data-typewriter') === 'typing') w.__typing.typed.push(field);
        const copy = box.querySelector('[data-typewriter-copy]');
        if (copy) (w.__typing.lens[field] ??= []).push((copy.textContent ?? '').length);
      });
      document.querySelectorAll('[aria-live]').forEach((region) => {
        const text = region.textContent ?? '';
        if (text) w.__typing.live.push(text);
      });
    };
    read();
    w.__typingObs = new MutationObserver(read);
    w.__typingObs.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-typewriter'],
    });
  });
}

const typingRecord = (page: Page) =>
  page.evaluate(() => (window as unknown as { __typing: TypingRecord }).__typing);

/** How many times `text` occurs in `scope`'s ACCESSIBLE text (no `aria-hidden` subtree). */
const accessibleOccurrences = (scope: Locator, text: string) =>
  scope.evaluate((root, needle) => {
    let out = '';
    const walk = (n: Node) => {
      if (n instanceof Element && n.getAttribute('aria-hidden') === 'true') return;
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? '';
      n.childNodes.forEach(walk);
    };
    walk(root);
    return out.split(needle).length - 1;
  }, text);

/** Record every distinct text the canvas's polite follow region announces. */
async function recordAnnouncements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __said: string[] };
    w.__said = [];
    const region = document.querySelector('[data-testid="canvas-follow-live"]')!;
    new MutationObserver(() => {
      const text = region.textContent ?? '';
      if (text && w.__said.at(-1) !== text) w.__said.push(text);
    }).observe(region, { subtree: true, childList: true, characterData: true });
  });
}
const announcements = (page: Page) =>
  page.evaluate(() => (window as unknown as { __said: string[] }).__said);

/** The CSS transition the canvas level's wrapper carries (`none` under reduced motion). */
const levelTransition = (page: Page) =>
  workspace(page)
    .getByTestId('planning-canvas')
    .evaluate((el) => {
      const wrapper = el.closest('.transition-opacity') ?? el.parentElement!;
      return getComputedStyle(wrapper).transitionProperty;
    });

// ─────────────────────────────────────────────────────────────────────────────
// THE RECEIPT
// ─────────────────────────────────────────────────────────────────────────────

test('the canvas follows the planner while a plan is written, stops when the reader takes over, comes back on Follow the planner, and a quick view types in what arrives', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-8590');

  // The tree: the epic › the seed's story (with its task) and a second story.
  const s = slug();
  const seed = await seedPlanProgress(s);
  const visitor = await makePlanProgressPublic(seed, s);
  const s2 = await addPlanProgressStory(seed, S2_TITLE);
  const EPIC = 'AI planning';
  const S_TITLE = seed.storyTitle;
  const T_TITLE = seed.taskTitle;

  const agent = await agentSession(seed.token, baseURL!);
  try {
    const title = 'Agent plan — follow the planner';
    const planId = await mcpCreatePlan(agent, seed, title);
    const [a1, a2] = await mcpAdd(agent, planId, [A1, A2], seed.storyId);
    const [t1] = await mcpAdd(agent, planId, [T1], seed.taskId);
    const [b1] = await mcpAdd(agent, planId, [B1], s2.id);
    await tool(agent, UPDATE_PLAN_ITEM_TOOL_NAME, { planId, planItemId: a2, ...AUTHORED_LEAF });

    await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);

    await chapter('The canvas follows the planner, level by level', async () => {
      await openPlanningTab(page);
      const opened = polled(page, planId, (b) => b.status === 'generating');
      await openRow(page, planRow(page, title));
      await opened;
      await showCanvas(page);
      await expect(followState(page)).toBeVisible({ timeout: 4 * POLL_MS });
      await expect(followState(page)).toHaveText(follow.following);
      await expect(followButton(page)).toHaveCount(0);

      // The planner lays the story's children: the canvas goes to that level.
      let read = polled(page, planId, (b) => stepOf(b.inFlightSteps, 'walk')?.kind === 'lay');
      await mcpStep(agent, planId, 'walk', 'lay', seed.storyId);
      await read;
      await expectLevel(page, S_TITLE);
      await beat();

      // It drafts a card one level further down: the canvas follows it there.
      read = polled(page, planId, (b) => stepOf(b.inFlightSteps, 'walk')?.targetRef === ref(t1!));
      await mcpStep(agent, planId, 'walk', 'author', ref(t1!));
      await read;
      await expectLevel(page, T_TITLE);
      await beat();

      // It settles the brief, which names no level: the canvas stays where it is.
      for (let i = 0; i < 2; i += 1) {
        const settled = (b: PlanReviewDto) => stepOf(b.inFlightSteps, 'walk')?.kind === 'settle';
        read = i === 0 ? polled(page, planId, settled) : held(page, planId, settled);
        // The pane reads on a push, so the second read is caused by a quiet touch.
        await (i === 0 ? mcpStep(agent, planId, 'walk', 'settle') : nudgePlan(planId));
        await read;
        await expectLevel(page, T_TITLE);
      }
      await beat();
    });

    let laterSession = '';
    let laterLevel = '';
    await chapter('Two cards are drafted at once — the canvas holds on the first', async () => {
      await mcpStep(agent, planId, 'walk', 'end');
      // Both started INSIDE one poll lag, with no await between them.
      const both = polled(page, planId, (b) => carries(b, 'draft-s2', 'draft-s'));
      await Promise.all([
        mcpStep(agent, planId, 'draft-s2', 'author', ref(b1!)),
        mcpStep(agent, planId, 'draft-s', 'author', ref(a1!)),
      ]);
      const body = (await ((await both) as Response).json()) as PlanReviewDto;
      // Which one the server started first decides where the canvas holds.
      const s2Step = stepOf(body.inFlightSteps, 'draft-s2')!;
      const sStep = stepOf(body.inFlightSteps, 'draft-s')!;
      const s2First = Date.parse(s2Step.startedAt) <= Date.parse(sStep.startedAt);
      const [earlierSession, earlierLevel] = s2First
        ? ['draft-s2', S2_TITLE]
        : ['draft-s', S_TITLE];
      [laterSession, laterLevel] = s2First ? ['draft-s', S_TITLE] : ['draft-s2', S2_TITLE];
      await expectLevel(page, earlierLevel);

      // Three more responses, each still carrying both: the canvas does not hop.
      for (let i = 0; i < 3; i += 1) {
        const still = held(page, planId, (b) => carries(b, 'draft-s2', 'draft-s'));
        await nudgePlan(planId);
        await still;
        await expectLevel(page, earlierLevel);
      }
      await beat();

      // The first draft ends: the canvas moves on to the one still being written.
      const moved = polled(
        page,
        planId,
        (b) => !carries(b, earlierSession) && carries(b, laterSession),
      );
      await mcpStep(agent, planId, earlierSession, 'end');
      await moved;
      await expectLevel(page, laterLevel);
      await beat();
    });

    await chapter(
      'The reader takes over — the canvas stays, and offers Follow the planner',
      async () => {
        // Selecting a card and opening its quick view on the same level keep following on.
        const sameLevelCard = laterLevel === S_TITLE ? A2 : B1;
        await node(page, sameLevelCard).press('Enter'); // it may wear the at-work cue
        await openQuickView(page, sameLevelCard);
        await expect(followButton(page)).toHaveCount(0);
        await closeQuickView(page);
        await expect(followState(page)).toHaveText(follow.following);
        const ended = polled(page, planId, (b) => !carries(b, laterSession));
        await mcpStep(agent, planId, laterSession, 'end');
        await ended;

        // A crumb click is the reader moving the canvas.
        await crumbsIn(workspace(page))
          .getByRole('button', { name: new RegExp(EPIC) })
          .click();
        await expectLevel(page, EPIC);
        await expect(followButton(page)).toBeVisible();
        await expect(followButton(page)).toHaveAccessibleName(follow.resume);
        await beat();

        // New drafts on other levels arrive: the canvas stays where the reader put
        // it. The arrivals pill is HIDDEN by the trip rule (§28.3, row A4): its
        // *Go there* would land on the earliest draft's level, which is where
        // Follow the planner goes, and no row offers two controls to one place.
        let read = polled(page, planId, (b) => carries(b, 'over-t'));
        await mcpStep(agent, planId, 'over-t', 'author', ref(t1!));
        await read;
        await expectLevel(page, EPIC);
        await expect(followButton(page)).toBeVisible();
        await expect(arrivals(page)).toHaveCount(0);
        read = polled(page, planId, (b) => carries(b, 'over-t', 'over-s2'));
        await mcpStep(agent, planId, 'over-s2', 'author', ref(b1!));
        await read;
        await expectLevel(page, EPIC);
        await expect(followButton(page)).toBeVisible();
        await expect(arrivals(page)).toHaveCount(0);
        await beat();
      },
    );

    await chapter('Follow the planner — the canvas jumps back to the step in action', async () => {
      await recordAnnouncements(page);
      await followButton(page).click();
      // The earlier of the two live drafts is the task's.
      await expectLevel(page, T_TITLE);
      await expect(followButton(page)).toHaveCount(0);
      await expect(followState(page)).toHaveText(follow.following);
      await expect
        .poll(() => announcements(page), { timeout: 4 * POLL_MS })
        .toEqual([expect.stringMatching(new RegExp(patternOf(arrival.movedAnnouncement)))]);
      await beat();

      // …and it follows again: the task's draft ends, the other story's is next.
      const moved = polled(page, planId, (b) => !carries(b, 'over-t') && carries(b, 'over-s2'));
      await mcpStep(agent, planId, 'over-t', 'end');
      await moved;
      await expectLevel(page, S2_TITLE);
      await beat();
    });

    await chapter('A stalled plan, and a failing read, hold the canvas still', async () => {
      const at = await backdatePlanActivity(planId, PLAN_STALLED_AFTER_MS + 60_000);
      await polled(
        page,
        planId,
        (b) => b.lastActivityAt !== undefined && Date.parse(b.lastActivityAt) <= at.getTime(),
      );
      await expectLevel(page, S2_TITLE);
      await expect(followState(page)).toHaveAttribute('data-idle', 'true');
      await beat();

      // FAULT INJECTION — the header's one `page.route`: the poll fails for two cycles.
      let aborted = 0;
      let twice!: () => void;
      const failedTwice = new Promise<void>((resolve) => (twice = resolve));
      const isPoll = (url: URL) => url.pathname === `/api/plans/${planId}`;
      await page.route(isPoll, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        aborted += 1;
        if (aborted === 2) twice();
        return route.abort('failed');
      });
      await mcpStep(agent, planId, 'over-s2', 'end');
      await mcpStep(agent, planId, 'resume-s', 'author', ref(a1!));
      await failedTwice;
      await expectLevel(page, S2_TITLE);
      const recovered = polled(
        page,
        planId,
        (b) => !carries(b, 'over-s2') && carries(b, 'resume-s'),
      );
      await page.unroute(isPoll);
      await recovered;
      await expectLevel(page, S_TITLE);
      await beat();
    });

    await chapter(
      'A description that arrives while its quick view is open types itself in',
      async () => {
        await openQuickView(page, A1);
        await expect(typedField(page, 'descriptionMd')).toHaveAttribute(
          'data-typewriter',
          'waiting',
        );
        await recordTyping(page);
        const arrived = polled(page, planId, (b) => itemOf(b, a1!)?.descriptionMd === BODY);
        await tool(agent, UPDATE_PLAN_ITEM_TOOL_NAME, {
          planId,
          planItemId: a1,
          descriptionMd: BODY,
        });
        await arrived;
        await expect(typedField(page, 'descriptionMd')).toHaveAttribute('data-typewriter', 'final');
        await expect(typedField(page, 'descriptionMd')).toContainText(BODY);
        const record = await typingRecord(page);
        const lens = record.lens['descriptionMd'] ?? [];
        expect(
          lens.some((n) => n > 0 && n < BODY.length),
          'it typed',
        ).toBe(true);
        expect(Math.max(0, ...lens)).toBeLessThan(BODY.length);
        // A screen reader meets the final value once, and no live region a partial one.
        expect(await accessibleOccurrences(peek(page), BODY)).toBe(1);
        expect(record.live.filter((t) => BODY.startsWith(t) && t !== BODY)).toEqual([]);
        await beat();
      },
    );

    await chapter('Anything written, or opened again, shows at once', async () => {
      await closeQuickView(page);
      await recordTyping(page);
      await openQuickView(page, A1);
      await expect(peek(page)).toContainText(BODY);
      await closeQuickView(page);
      await openQuickView(page, A2);
      await expect(peek(page)).toContainText(AUTHORED_LEAF.descriptionMd);
      const record = await typingRecord(page);
      expect(record.typed).toEqual([]);
      expect(record.lens).toEqual({});
      await expect(peek(page).locator('[data-typewriter="typing"]')).toHaveCount(0);
      await closeQuickView(page);
      await beat();
    });

    await chapter(
      'Under reduced motion the canvas moves without a transition, and nothing types',
      async () => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const moved = polled(page, planId, (b) => !carries(b, 'resume-s') && carries(b, 'calm'));
        await mcpStep(agent, planId, 'resume-s', 'end');
        await mcpStep(agent, planId, 'calm', 'author', ref(b1!));
        await moved;
        await expectLevel(page, S2_TITLE);
        // The canvas is keyed per level and can remount once more after the crumb
        // settles; a read on the outgoing node sees no computed style at all.
        await expect.poll(() => levelTransition(page)).toBe('none');

        await openQuickView(page, B1);
        await recordTyping(page);
        const arrived = polled(page, planId, (b) => itemOf(b, b1!)?.descriptionMd === BODY_REDUCED);
        await tool(agent, UPDATE_PLAN_ITEM_TOOL_NAME, {
          planId,
          planItemId: b1,
          descriptionMd: BODY_REDUCED,
        });
        await arrived;
        await expect(peek(page)).toContainText(BODY_REDUCED);
        const record = await typingRecord(page);
        expect(record.typed).toEqual([]);
        expect(record.lens).toEqual({});
        await closeQuickView(page);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await beat();
      },
    );

    await chapter('The plan is proposed — the control goes, and the canvas stays put', async () => {
      const proposed = polled(page, planId, (b) => b.status !== 'generating');
      await tool(agent, ADD_PLAN_ITEMS_TOOL_NAME, { planId, proposals: [], final: true });
      const body = (await ((await proposed) as Response).json()) as PlanReviewDto;
      expect(body.status).toBe('planned');
      await expect(followState(page)).toHaveCount(0);
      await expect(followButton(page)).toHaveCount(0);
      await expect(workspace(page).getByTestId('canvas-follow-offer')).toHaveCount(0);
      await expectLevel(page, S2_TITLE);
      await beat();
    });

    await chapter('The plan page never drives — read as a Visitor', async () => {
      // A sibling plan, still being written, on the project made public. The
      // first plan still holds every card it planned until someone decides it,
      // so the sibling plans two stories of its own.
      const s3 = await addPlanProgressStory(seed, 'Plan page reading');
      const s4 = await addPlanProgressStory(seed, 'Plan page sharing');
      const siblingTitle = 'Agent plan — the page reads it';
      const siblingId = await mcpCreatePlan(agent, seed, siblingTitle);
      const [c1] = await mcpAdd(agent, siblingId, [C1], s3.id);
      const [c2] = await mcpAdd(agent, siblingId, [C2], s4.id);
      await mcpStep(agent, siblingId, 'page-1', 'author', ref(c1!));

      await signIn(page, visitor.email, PLAN_PROGRESS_PASSWORD);
      const planPath = `/p/${seed.projectKey}/plans/${siblingId}`;
      await page.goto(planPath);
      await page.waitForURL((url) => url.pathname === `/p/${seed.projectKey}/consent`);
      const consent = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().includes(`/p/${seed.projectKey}/consent`),
      );
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      expect((await consent).status()).toBe(200);
      await page.waitForURL((url) => !url.pathname.endsWith('/consent'));
      await page.goto(`${planPath}?view=canvas`);
      const views = page.getByRole('main').getByTestId('plan-proposal-views');
      await expect(views).toBeVisible({ timeout: FIRST_PAINT_MS });
      const levelBefore = (await crumbsIn(views).count())
        ? await levelIn(views).textContent()
        : null;

      for (const [session, target] of [
        ['page-2', c2!],
        ['page-3', c1!],
      ] as const) {
        const read = polled(page, siblingId, (b) => carries(b, session));
        await mcpStep(agent, siblingId, 'page-1', 'end');
        await mcpStep(agent, siblingId, session, 'author', ref(target));
        await read;
        await expect(views.getByTestId('canvas-follow-state')).toHaveCount(0);
        await expect(views.getByTestId('canvas-follow-planner')).toHaveCount(0);
        const levelNow = (await crumbsIn(views).count())
          ? await levelIn(views).textContent()
          : null;
        expect(levelNow).toBe(levelBefore);
      }
      await beat();
    });
  } finally {
    await agent.close();
  }
});
