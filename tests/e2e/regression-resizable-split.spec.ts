// Acceptance E2E — the planning surface is a RESIZABLE SPLIT (Subtask MOTIR-6251,
// Story MOTIR-6248; built by MOTIR-6250 to MOTIR-6249's approved design result).
//
// Runs under `playwright.acceptance.config.ts` (MOTIR_CLOUD + `video: 'on'`) —
// the lane where the planning overlay mounts at all (`isMotirAiConfigured()`)
// and where the motir-ai JOBS boundary is mocked UNDER the routes, so the
// session and plan a turn starts are REAL rows in Postgres. `acceptanceStory()`
// pins the clip to the story.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The story's whole value is a FEEL: the conversation gets wider when you want
// it wider, stops where the design says it stops, and gets out of the way when
// there is a plan to read. So the clip shows the divider being MOVED, not
// teleported: every drag is a real `mouse.down` → many `mouse.move`s →
// `mouse.up`, cut into short segments with both panes measured after each one.
// Those measurements are what pace the drag, and they are also the proof that
// the two panes move TOGETHER throughout rather than only at the ends.
//
// ── WHERE EVERY NUMBER COMES FROM ───────────────────────────────────────────
//
// Nothing here types a width. The default share, the floor, the ceiling, the
// keyboard step and the breakpoint are all read from `lib/planning/railWidth.ts`,
// the module MOTIR-6250 transcribed MOTIR-6249's six decisions into, and every
// expected width is computed from the FRAME'S MEASURED WIDTH through that
// module's own closed forms (`defaultRailWidth`, `railBounds`). So the design's
// numbers are stated once, in the product, and this spec cannot disagree with
// the product about them without one of the two being wrong on purpose.
//
// ── THE PROPOSAL (case 7), and which half runs outside the browser ──────────
//
// The lane's motir-ai mock settles a plan job with nothing proposed, so a run is
// FINISHED by the shipped services the planner's handler calls (`addProposals` →
// `markPlanned`, via `finishSessionPlan`) — the same seam
// `acceptance-plan-approval-gate.spec.ts` uses. What is different here is WHEN:
// the reset fires on the workspace's own transition into "a plan is proposed",
// so the plan has to arrive while the surface is OPEN and WIDE, not on a later
// reload. The workspace learns what a settled run proposed by reading
// `GET /api/plans/{id}`; this spec routes that read at the browser layer,
// finishes the plan on the first one, and only then lets the request through.
// What stays real: the send, the job dispatch, the stream, the plan row, the
// read, the review state and the frame's reset. Only the handler's writes are
// played by the spec, exactly as a real run's handler would have made them
// before the job settled.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a landmark, a
// response the page issued, or a box measured from the elements. The one wait
// that is not a DOM change — "the pointer moved past the bound and NOTHING
// happened" — waits two animation frames in the page, which is exactly the
// window the frame coalesces a `pointermove` into (`PlanningResizableFrame`'s
// rAF); a clamped move re-renders nothing, so there is no DOM change to await.
// Widths are compared as numbers, never as screenshots. No fixed sleep stands in
// for state, including after the reset's animation — that is `expect.poll` on
// the box. `beat()` and the chapter hold are PACING only, each taken after the
// assertion that already proved the state.
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import { finishSessionPlan } from './_helpers/planChangeConversation';
import {
  defaultRailWidth,
  railBounds,
  RAIL_DEFAULT_CROSSOVER_PX,
  RAIL_DEFAULT_FRACTION,
  RAIL_KEYBOARD_STEP_PX,
  SPLIT_MIN_CONTAINER_PX,
} from '@/lib/planning/railWidth';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 240_000 });

/**
 * How far a measured width may sit from the width the design computes. One CSS
 * pixel: the frame paints a chosen width as a ROUNDED pixel value
 * (`${Math.round(width)}px`), and the pointer lands on the seam's half-pixel
 * centre, so an exact comparison would fail on rounding rather than on behaviour.
 */
const TOLERANCE_PX = 1;

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const frame = (page: Page) => workspace(page).getByTestId('resizable-split');
const divider = (page: Page) =>
  workspace(page).getByRole('separator', { name: en.planningWorkspace.dividerAria });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const send = (page: Page) => rail(page).getByRole('button', { name: 'Send' });
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const canvasViewport = (page: Page) => workspace(page).getByTestId('planning-canvas');
/** The canvas's WORLD layer — its inline `transform` IS the pan and zoom. */
const canvasWorld = (page: Page) => workspace(page).getByTestId('canvas-edges');
const confirmBar = (page: Page) => workspace(page).getByTestId('plan-change-confirm-bar');

const overlayOpen = (url: URL) => url.searchParams.has('plan');

// ── Measurement ──────────────────────────────────────────────────────────────

interface Split {
  /** The split container — what every design fraction is a fraction OF. */
  frame: number;
  right: number;
  canvas: number;
  chat: number;
  canvasBottom: number;
  chatTop: number;
}

/** Both panes' boxes, read from the elements in one pass so they are one frame's
 *  layout. The frame's first two children ARE the panes, in the order the
 *  workspace passes them (canvas, conversation); the divider is a third,
 *  absolutely positioned child that takes no track. */
async function measure(page: Page): Promise<Split> {
  return frame(page).evaluate((el) => {
    const f = el.getBoundingClientRect();
    const c = el.children[0]!.getBoundingClientRect();
    const r = el.children[1]!.getBoundingClientRect();
    return {
      frame: f.width,
      right: f.right,
      canvas: c.width,
      chat: r.width,
      canvasBottom: c.bottom,
      chatTop: r.top,
    };
  });
}

/** Wait until the conversation pane is `chatPx` wide (± tolerance), then prove the
 *  canvas took exactly the remainder and the frame itself did not move. */
async function expectSplit(page: Page, chatPx: number, framePx: number): Promise<Split> {
  await expect
    .poll(async () => Math.abs((await measure(page)).chat - chatPx), {
      message: `conversation pane settles at ${chatPx.toFixed(2)}px`,
    })
    .toBeLessThanOrEqual(TOLERANCE_PX);
  const split = await measure(page);
  expect(Math.abs(split.frame - framePx)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(split.canvas + split.chat - split.frame)).toBeLessThanOrEqual(TOLERANCE_PX);
  return split;
}

/** Two animation frames in the page — the window the divider coalesces a
 *  `pointermove` into. After it, any update a move would have caused is painted,
 *  so an unchanged box means the move was REFUSED, not still pending. */
async function framesSettled(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

// ── The drag ─────────────────────────────────────────────────────────────────

/** Press on the divider's seam and HOLD. Returns the row the drag travels along. */
async function grabDivider(page: Page): Promise<number> {
  const box = (await divider(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  return y;
}

/**
 * Move the HELD pointer to where the conversation would be `chatPx` wide — the
 * conversation is the RIGHT pane, so that is `chatPx` left of the frame's right
 * edge — through intermediate moves, never one jump. A one-step drag can pass
 * where a real one does not (the rAF guard MOTIR-6250 found latched is exactly
 * that shape).
 */
async function pointerTo(page: Page, split: Split, chatPx: number, y: number): Promise<void> {
  await page.mouse.move(split.right - chatPx, y, { steps: 12 });
}

/**
 * Drag in SEGMENTS toward `targetChatPx`, measuring both panes after each one:
 * the conversation lands where the pointer put it and the canvas gives up
 * exactly what it gained. The segments are what make the drag watchable.
 */
async function dragInSegments(
  page: Page,
  from: Split,
  targetChatPx: number,
  y: number,
  segments = 4,
): Promise<Split> {
  let last = from;
  const start = from.chat;
  for (let i = 1; i <= segments; i++) {
    const chatPx = start + ((targetChatPx - start) * i) / segments;
    await pointerTo(page, from, chatPx, y);
    last = await expectSplit(page, chatPx, from.frame);
  }
  return last;
}

// ── The motir-ai boundary ────────────────────────────────────────────────────

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

function resetJobsFixture(): void {
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ ask: [], submitted: [] }, null, 2));
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
 * Let the NEXT run's plan be proposed the moment the workspace reads it.
 *
 * The workspace reads `GET /api/plans/{id}` once the run's stream settles
 * (`readPendingProposal`), and the reset fires on that read's result arriving.
 * The first such request finishes the plan through the shipped services
 * (`finishSessionPlan`: `addProposals` → `markPlanned`); every such request waits
 * for that write before it is let through, so no read can observe the plan
 * half-written.
 */
async function proposeOnFirstRead(page: Page, proposalTitle: string): Promise<void> {
  let finished: Promise<string> | null = null;
  await page.route(
    (url) => /^\/api\/plans\/[^/]+$/.test(url.pathname),
    async (route) => {
      if (route.request().method() === 'GET' && finished === null) {
        const planId = decodeURIComponent(
          new URL(route.request().url()).pathname.split('/').pop()!,
        );
        const plan = await adminDb.plan.findUniqueOrThrow({
          where: { id: planId },
          select: { sessionId: true },
        });
        finished = finishSessionPlan(plan.sessionId!, proposalTitle);
      }
      if (finished !== null) await finished;
      await route.continue();
    },
  );
}

test.beforeEach(async () => {
  await resetDatabase();
  resetJobsFixture();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('the planning split opens at a third, drags within its bounds, takes the keyboard, and gives the canvas back when a plan is proposed', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6248');

  const email = `resizable-split-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);
  const laneViewport = page.viewportSize()!;

  const DRAFT = 'Split this story so the canvas seam can ship on its own.';
  const PROPOSAL = 'Ship the canvas seam first';
  /** The split container's width, measured once the workspace is open. */
  let framePx = 0;

  // ── 1 · the opening third ────────────────────────────────────────────────
  await chapter('Open Plan with AI — the conversation takes a third of the frame', async () => {
    await page.goto(`/items/${seed.storyKey}`);
    await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await entrance(page).click();
    await page.waitForURL(overlayOpen);
    await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(rail(page)).toBeVisible();
    // The divider renders only once the frame has MEASURED its container, so its
    // presence is the signal that the split is live rather than still painting
    // the CSS default alone.
    await expect(divider(page)).toBeVisible();

    framePx = (await measure(page)).frame;
    // The lane's viewport is wide enough that a third is NOT floored — otherwise
    // "a third" would be the 352px floor and this chapter would prove the floor.
    expect(framePx, 'the frame is past the crossover, so the default IS a third').toBeGreaterThan(
      RAIL_DEFAULT_CROSSOVER_PX,
    );
    const opened = await expectSplit(page, defaultRailWidth(framePx), framePx);
    expect(Math.abs(opened.chat / opened.frame - RAIL_DEFAULT_FRACTION)).toBeLessThanOrEqual(
      TOLERANCE_PX / framePx,
    );
    await beat();
  });

  const { min, max } = railBounds(framePx);

  // ── 2 · a drag moves both panes together ─────────────────────────────────
  await chapter(
    'Drag the divider left — the conversation widens as the canvas narrows',
    async () => {
      const before = await measure(page);
      const y = await grabDivider(page);
      // Halfway from the default to the ceiling: far enough to see, short of the bound.
      const target = before.chat + (max - before.chat) / 2;
      const during = await dragInSegments(page, before, target, y);
      await page.mouse.up();

      // Released: the width STAYS where it was let go.
      const after = await expectSplit(page, during.chat, framePx);
      expect(Math.abs(after.chat - during.chat)).toBeLessThanOrEqual(TOLERANCE_PX);
      await expect(divider(page)).toHaveAttribute('aria-valuenow', String(Math.round(after.chat)));
      await beat();
    },
  );

  // ── 3 · the conversation's maximum ───────────────────────────────────────
  await chapter('Keep dragging — the divider stops at the conversation’s maximum', async () => {
    const before = await measure(page);
    const y = await grabDivider(page);
    const atMax = await dragInSegments(page, before, max, y, 3);

    // Past the bound: the pointer keeps travelling, the panes do not.
    await pointerTo(page, before, max + 80, y);
    await framesSettled(page);
    await pointerTo(page, before, max + 160, y);
    await framesSettled(page);
    const pushed = await measure(page);
    expect(Math.abs(pushed.chat - atMax.chat)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(pushed.canvas - atMax.canvas)).toBeLessThanOrEqual(0.5);

    // Released OUTSIDE the bounds: the bound is committed, not the pointer.
    await page.mouse.up();
    await expectSplit(page, max, framePx);
    await expect(divider(page)).toHaveAttribute('aria-valuenow', String(Math.round(max)));
    await beat();
  });

  // ── 4 · the conversation's minimum ───────────────────────────────────────
  await chapter(
    'Drag the other way — it stops at the minimum, and the composer still works',
    async () => {
      const before = await measure(page);
      const y = await grabDivider(page);
      const atMin = await dragInSegments(page, before, min, y, 5);

      await pointerTo(page, before, min - 80, y);
      await framesSettled(page);
      await pointerTo(page, before, min - 160, y);
      await framesSettled(page);
      const pushed = await measure(page);
      expect(Math.abs(pushed.chat - atMin.chat)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(pushed.canvas - atMin.canvas)).toBeLessThanOrEqual(0.5);

      await page.mouse.up();
      await expectSplit(page, min, framePx);
      await expect(divider(page)).toHaveAttribute('aria-valuenow', String(Math.round(min)));

      // The design's reason for this floor: at it, the composer, the target tray
      // and Send are all still usable. The draft typed here is also the one the
      // no-re-mount chapter later proves survives a drag, and the request the
      // proposal chapter sends.
      await expect(rail(page).getByTestId('planning-target-tray')).toBeVisible();
      await expect(rail(page).getByTestId('planning-target-trigger')).toBeEnabled();
      await expect(composer(page)).toBeEnabled();
      await composer(page).fill(DRAFT);
      await expect(composer(page)).toHaveValue(DRAFT);
      await expect(send(page)).toBeVisible();
      await expect(send(page)).toBeEnabled();
      await beat();
    },
  );

  // ── 5 · the keyboard path ────────────────────────────────────────────────
  await chapter('Tab to the divider — the arrow keys, Home and End move it', async () => {
    // Tab from the last control in the conversation: the divider is the next
    // stop, rendered after both panes. A bounded walk rather than a fixed count,
    // so a new focusable inside the rail changes nothing here.
    await send(page).focus();
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      if (await divider(page).evaluate((el) => el === document.activeElement)) break;
    }
    await expect(divider(page)).toBeFocused();
    await expect(divider(page)).toHaveAttribute('role', 'separator');
    await expect(divider(page)).toHaveAttribute('aria-valuemin', String(Math.round(min)));
    await expect(divider(page)).toHaveAttribute('aria-valuemax', String(Math.round(max)));
    await expect(divider(page)).toHaveAttribute('aria-valuenow', String(Math.round(min)));
    await beat();

    // ← moves the DIVIDER left, which widens the conversation by one step.
    const PRESSES = 3;
    for (let k = 1; k <= PRESSES; k++) {
      await page.keyboard.press('ArrowLeft');
      const expected = min + k * RAIL_KEYBOARD_STEP_PX;
      await expect(divider(page)).toHaveAttribute('aria-valuenow', String(Math.round(expected)));
      await expectSplit(page, expected, framePx);
    }
    await beat();

    await page.keyboard.press('Home');
    await expect(divider(page)).toHaveAttribute('aria-valuenow', String(Math.round(min)));
    await expectSplit(page, min, framePx);

    await page.keyboard.press('End');
    await expect(divider(page)).toHaveAttribute('aria-valuenow', String(Math.round(max)));
    await expectSplit(page, max, framePx);
    await expect(divider(page)).toBeFocused();
    await beat();
  });

  // ── 6 · neither pane re-mounts ───────────────────────────────────────────
  await chapter(
    'Pan the canvas, then drag — the canvas view and the draft both survive',
    async () => {
      // PAN the canvas from the keyboard — deterministic, and it can never land on
      // a node the way a pointer pan might. Its world transform IS the view.
      const transformBefore = await canvasWorld(page).evaluate((el) => el.style.transform);
      await canvasViewport(page).focus();
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
      for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight');
      await expect
        .poll(() => canvasWorld(page).evaluate((el) => el.style.transform))
        .not.toBe(transformBefore);
      const panned = await canvasWorld(page).evaluate((el) => el.style.transform);
      await expect(composer(page)).toHaveValue(DRAFT);

      // Tag both panes' live DOM nodes. A re-mount replaces the node, and a new node
      // carries no tag — a stronger check than any value, which a re-mount seeded
      // from the same props could reproduce.
      await canvasViewport(page).evaluate((el) => {
        (el as HTMLElement & { __splitProbe?: boolean }).__splitProbe = true;
      });
      await composer(page).evaluate((el) => {
        (el as HTMLElement & { __splitProbe?: boolean }).__splitProbe = true;
      });
      await beat();

      // From the maximum back toward the middle — and it stays WIDE, past the
      // default, because the next chapter needs a wide conversation to reset.
      const before = await measure(page);
      const y = await grabDivider(page);
      const target = max - (max - defaultRailWidth(framePx)) / 3;
      await dragInSegments(page, before, target, y, 3);
      await page.mouse.up();
      await expectSplit(page, target, framePx);

      const probe = (el: Element) => (el as HTMLElement & { __splitProbe?: boolean }).__splitProbe;
      expect(await canvasViewport(page).evaluate(probe), 'the canvas was not re-mounted').toBe(
        true,
      );
      expect(await composer(page).evaluate(probe), 'the composer was not re-mounted').toBe(true);
      expect(await canvasWorld(page).evaluate((el) => el.style.transform)).toBe(panned);
      await expect(composer(page)).toHaveValue(DRAFT);
      await beat();
    },
  );

  // ── 7 · a proposed plan gives the canvas back ────────────────────────────
  await chapter('Ask for a plan while it is wide — the canvas returns to two-thirds', async () => {
    const wide = await measure(page);
    expect(wide.chat, 'the conversation is wider than the default').toBeGreaterThan(
      defaultRailWidth(framePx) + TOLERANCE_PX,
    );

    await proposeOnFirstRead(page, PROPOSAL);
    // The anchored door APPENDS AND SUBMITS in one call (MOTIR-909); its 200 is
    // the authoritative "the run was started". Armed before the click.
    const sent = page.waitForResponse(
      (r) =>
        /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
        r.request().method() === 'POST',
    );
    await send(page).click();
    expect((await sent).status()).toBe(200);
    await expect(rail(page).getByText(DRAFT)).toBeVisible();

    // The plan is PROPOSED: the confirm bar is rendered from the review read.
    await expect(confirmBar(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(confirmBar(page)).toContainText('1 added');

    // The reset animates, so the box is POLLED to its settled width — never a
    // sleep sized to the animation.
    const settled = await expectSplit(page, defaultRailWidth(framePx), framePx);
    expect(
      Math.abs(settled.canvas / settled.frame - (1 - RAIL_DEFAULT_FRACTION)),
      'the canvas holds two-thirds of the frame',
    ).toBeLessThanOrEqual(TOLERANCE_PX / framePx);
    await beat();
  });

  // ── 8 · the narrow viewport ──────────────────────────────────────────────
  await chapter('Narrow the window past the breakpoint — the panes stack, no divider', async () => {
    // One pixel under the design's breakpoint: the first width at which the frame
    // is no longer a split.
    await page.setViewportSize({ width: SPLIT_MIN_CONTAINER_PX - 1, height: laneViewport.height });
    // Absent — not hidden, not disabled: there is no seam to drag.
    await expect(divider(page)).toHaveCount(0);
    await expect
      .poll(async () => {
        const s = await measure(page);
        return s.chatTop >= s.canvasBottom - TOLERANCE_PX;
      })
      .toBe(true);
    const stacked = await measure(page);
    expect(stacked.frame).toBeLessThan(SPLIT_MIN_CONTAINER_PX);
    expect(Math.abs(stacked.canvas - stacked.frame)).toBeLessThanOrEqual(TOLERANCE_PX);
    expect(Math.abs(stacked.chat - stacked.frame)).toBeLessThanOrEqual(TOLERANCE_PX);
    await beat();

    // Back to the lane's width: the split — and its divider — return.
    await page.setViewportSize(laneViewport);
    await expect(divider(page)).toBeVisible();
    const restored = await measure(page);
    expect(Math.abs(restored.canvas + restored.chat - restored.frame)).toBeLessThanOrEqual(
      TOLERANCE_PX,
    );
    await beat();
  });
});
