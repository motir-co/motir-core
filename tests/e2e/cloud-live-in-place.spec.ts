import type { Locator, Page, Response, TestInfo } from '@playwright/test';
import { test, expect } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  openAgentSession,
  publishDesignResult,
  servePublishedMock,
} from './_helpers/design-approval-seed';
import { seedApprovalsTab, type ApprovalsTabSeed } from './_helpers/approvals-tab-seed';
import {
  formatRefreshTable,
  installRefreshCounter,
  type RefreshCounter,
  type RefreshCountRow,
} from './_helpers/refresh-counter';
import { BURST_CARD_TITLE, driveWriteBurst, seedBurstCard } from './_helpers/write-burst';
import { agentSession } from './_helpers/agent-authored-plan-seed';
import {
  nudgePlan,
  seedPlanProgress,
  PLAN_PROGRESS_PASSWORD,
  type PlanProgressSeed,
} from './_helpers/plan-progress-seed';
import { mutationsOf, readPlace, recordMutations, stamped, stampNode } from './_helpers/placeProbe';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  HOLD_PLAN_REVISION_TOOL_NAME,
  UPDATE_PLAN_ITEM_TOOL_NAME,
  WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { WORKBENCH_TABS, workbenchTabHref, type WorkbenchTab } from '@/lib/workbench/tab';
import type { WorkbenchWindowDto } from '@/lib/dto/workbench';
import type { HomeTabCountsDto } from '@/lib/dto/home';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import { escapeRegExp } from '@/lib/utils/regexp';
import en from '@/messages/en.json';

// A READER STAYS WHERE THEY ARE WHILE SOMEBODY ELSE WORKS
// (Story MOTIR-8539 · Subtask MOTIR-8580 — the story E2E).
//
// A reader sits on a surface and does not touch it: an approval open over the
// Workbench or over an item page, a plan being written, a plan being revised, each
// of the Workbench's eight tabs. A SECOND ACTOR — an MCP session over the real
// `/api/mcp` door, running in the runner — makes at least fifty writes that move
// what the reader is looking at. The claim is the story's criteria 1, 2, 4 and 5:
//
//   · the page is never re-fetched and never reloaded — counted from the NETWORK
//     LOG by `_helpers/refresh-counter.ts` (the confirmation spec's counter,
//     imported, not copied), never from component state;
//   · the reader's place survives — scroll offsets, the focused control, its
//     half-typed text and the selection inside it, an open card, and the very DOM
//     nodes (a marker written onto the element survives only if React never
//     replaced it) — read by `_helpers/placeProbe.ts`;
//   · what moved is drawn: rows and proposals arrive and leave in place, and the
//     Workbench strip's count agrees with the rows drawn under it after every
//     update the page applied.
//
// ⚠️ EVERY ZERO HAS A CONTROL. A counter that cannot count proves nothing, so
// case 7 drives one refresh the READER asks for (pressing Approve, whose
// `router.refresh()` is on the architecture guard's allowlist) and asserts the
// same counter records it. And every quiet window measures a NON-ZERO signal
// next to its zero: the stream frames or the poll ticks that arrived during it.
//
// ⚠️ THE WAITS. A write's landing is the authoritative signal — the stream frame
// for a write made after the last one was acknowledged, or the plan poll whose
// BODY carries the last write — and the DOM is asserted after it. The only fixed
// durations are the QUIET windows, and there the claim IS a duration: "nothing
// re-fetched" and "nothing mutated" have no completion event, so the honest
// measure is a window long enough for the thing to have happened if it were
// going to (`motir-core/CLAUDE.md` § E2E waits on the authoritative signal).
//
// ── ONE RECORDED RUN (production build of the story branch, 2026-10-14) ───
//
// Every case green; cases 2-5 each 50 writes. The signal column is stream
// frames for the Workbench and approval cases and plan-poll ticks (named) for
// the plan cases. Case 5's eight tabs each re-read their window and agreed on
// every commit; its hover and focus are held on To do, the tab that lists the
// reader's two steady rows.
//
// | case                                | writes | signals | RSC refetches | document loads |
// | ----------------------------------- | ------ | ------- | ------------- | -------------- |
// | 1 approval over /workbench          | 50     | 5       | 0             | 0              |
// | 2 approval over an item page        | 50     | 5       | 0             | 0              |
// | 3 generating plan (poll ticks)      | 50     | 4       | 0             | 0              |
// | 4 planned plan, overlay (poll)      | 50     | 3       | 0             | 0              |
// | 4 planned plan, plan page (poll)    | 50     | 3       | 0             | 0              |
// | 5 each of the eight tabs            | 50     | 5-6     | 0             | 0              |
// | 6 Approve in the overlay            | 0      | 0       | 0             | 0              |
// | 7 control: the reader approves      | 50     | 5       | 1             | 0              |
//
// THE VIDEO. Cases 1, 3 and 6 are the clips, recorded with `video: 'on'` — the reader holding
// still through a burst, a plan written under an open card, and a real Approve.

test.describe.configure({ timeout: 420_000 });
// Every case records; 1, 3 and 6 are the acceptance clips (`video` cannot be set
// per describe group — it forces a new worker).
test.use({ video: 'on' });

/** Writes per case — the story's burst size. */
const BURST = 50;
/** The stream polls every 1s and a refresh would follow its nudge; see the
 *  confirmation spec's `QUIET_MS`, which this is. */
const QUIET_MS = 5_000;
/** A server render or a first read on the cloud lane's production build. */
const FIRST_PAINT_MS = 60_000;
/** Eight unchanged re-reads of the plan — the card's "one full read" of quiet. */
const PLAN_QUIET_READS = 8;

const rows: RefreshCountRow[] = [];

test.afterAll(async ({}, testInfo) => {
  const table = formatRefreshTable(rows);
  // eslint-disable-next-line no-console -- the counts table is the run's own output.
  console.log(`\nLive in place (MOTIR-8580)\n${table}\n`);
  await testInfo.attach('live-in-place.md', { body: table, contentType: 'text/markdown' });
});

async function record(
  info: TestInfo,
  name: string,
  writes: number,
  counter: RefreshCounter,
  signals?: number,
) {
  const counts = await counter.read();
  const row: RefreshCountRow = {
    case: name,
    writes,
    ...counts,
    ...(signals === undefined ? {} : { streamNudges: signals }),
  };
  rows.push(row);
  await info.attach(`${name}.json`, {
    body: JSON.stringify(row, null, 2),
    contentType: 'application/json',
  });
  return counts;
}

/** An MCP tool call whose refusal fails the case — a refusal is a RESULT, not a throw. */
async function tool<T = unknown>(
  agent: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const r = (await agent.callTool({ name, arguments: args })) as CallToolResult;
  expect(r.isError ?? false, `${name}: ${JSON.stringify(r.content)}`).toBe(false);
  return r.structuredContent as unknown as T;
}

// ── The Workbench: its strip, and what each tab's read answers ───────────────

const tabStrip = (page: Page) => page.getByRole('navigation', { name: en.workbench.tabs.label });
const tabLink = (page: Page, tab: WorkbenchTab) =>
  tabStrip(page).getByTestId(`workbench-tab-${tab}`);

const COUNT_OF: Record<WorkbenchTab, keyof HomeTabCountsDto> = {
  todo: 'toDo',
  'in-progress': 'inProgress',
  'to-fix': 'toFix',
  'to-resume': 'toResume',
  finished: 'recentlyFinished',
  approvals: 'approvals',
  watching: 'watching',
  planning: 'planning',
};

/** What one Workbench read answered for `tab`: its count, and the rows' names. */
interface Answer {
  at: number;
  count: number;
  names: string[];
}

function answerOf(tab: WorkbenchTab, body: WorkbenchWindowDto, at: number): Answer {
  const w = body.window;
  const names =
    w.kind === 'workItems'
      ? w.page.items.map((i) => i.title)
      : w.kind === 'approvals'
        ? w.queue.items.flatMap((i) => (i.workItem ? [i.workItem.title] : []))
        : w.page.items.flatMap((i) => (i.title ? [i.title] : []));
  return { at, count: body.counts[COUNT_OF[tab]] as number, names };
}

/** The server's answer NOW, read beside the page (its cookies, not its requests). */
async function serverAnswer(page: Page, tab: WorkbenchTab): Promise<Answer> {
  const res = await page.request.get(`/api/workbench/window?tab=${tab}`);
  expect(res.ok()).toBe(true);
  return answerOf(tab, (await res.json()) as WorkbenchWindowDto, Date.now());
}

/** The strip's count for `tab` as drawn — its chip, absent when zero. */
async function chipOf(page: Page, tab: WorkbenchTab): Promise<number> {
  const text = (await tabLink(page, tab).innerText()).trim();
  const m = /(\d+)\s*$/.exec(text);
  return m ? Number(m[1]) : 0;
}

/** The strip and the rows under it agree with the server's answer of NOW. */
async function expectAgreesWithServer(page: Page, tab: WorkbenchTab): Promise<void> {
  const answer = await serverAnswer(page, tab);
  await expect.poll(() => chipOf(page, tab), { timeout: FIRST_PAINT_MS }).toBe(answer.count);
  for (const name of answer.names) {
    await expect(page.getByRole('main').getByText(name, { exact: true }).first()).toBeVisible();
  }
}

/**
 * Record, IN THE PAGE, the strip chip and the main region's text after every
 * DOM change — one snapshot per mutation batch, which is one per React commit.
 * Read back with {@link snapshotsOf}. This is how "after every applied update"
 * is measured: not by sampling, but on every commit the page made.
 */
async function recordStripSnapshots(page: Page, tab: WorkbenchTab): Promise<void> {
  await page.evaluate((testId) => {
    const w = window as unknown as {
      __strip?: { at: number; chip: string; main: string }[];
      __stripObserver?: MutationObserver;
    };
    w.__stripObserver?.disconnect();
    w.__strip = [];
    const snap = () => {
      const chip = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
      const main = document.querySelector('main') as HTMLElement | null;
      w.__strip!.push({
        at: Date.now(),
        chip: chip?.innerText ?? '',
        main: main?.innerText ?? '',
      });
    };
    w.__stripObserver = new MutationObserver(snap);
    w.__stripObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }, `workbench-tab-${tab}`);
}

async function snapshotsOf(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __strip?: { at: number; chip: string; main: string }[];
      __stripObserver?: MutationObserver;
    };
    w.__stripObserver?.disconnect();
    return (w.__strip ?? []).map((s) => {
      const m = /(\d+)\s*$/.exec(s.chip.trim());
      return { at: s.at, chip: m ? Number(m[1]) : 0, main: s.main };
    });
  });
}

// ── Group A: the approval and the Workbench (the approvals-tab tenant) ───────

test.describe('the Workbench and an open approval, under a second actor', () => {
  let seed: ApprovalsTabSeed;
  let burstKey: string;
  let burstId: string;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedApprovalsTab(`lip${Date.now().toString(36)}`);
    const burst = await seedBurstCard(seed);
    burstKey = burst.key;
    burstId = burst.id;
  });

  const dialogFor = (page: Page) =>
    page.getByRole('dialog', {
      name: `${en.workbench.approvals.kind.design_result} for ${seed.designKey}`,
    });
  const portOf = (dialog: Locator) =>
    dialog.getByRole('group', { name: en.approvalGate.port.label });

  /** Publish the gate the reviewer reads (the real door), and serve its mock. */
  async function publishGate(page: Page, baseURL: string): Promise<Client> {
    await servePublishedMock(page);
    const client = await openAgentSession(seed.token, baseURL);
    const published = await publishDesignResult(client, seed.designKey);
    expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
    return client;
  }

  /** Sign in and open `path`, arming the stream wait BEFORE the navigation. */
  async function openReader(page: Page, path: string): Promise<void> {
    await signIn(page, seed.reviewerEmail, seed.password);
    const streamOpened = page.waitForResponse(
      (r) => r.url().includes('/api/workbench/stream') && r.ok(),
    );
    await page.goto(path);
    await streamOpened;
  }

  /**
   * The burst LANDED when the stream carries a frame for a moment after the last
   * write was acknowledged. Then the quiet window, then any refetch in flight is
   * waited out so the count is final.
   */
  async function settle(page: Page, counter: RefreshCounter, lastWriteAt: number): Promise<void> {
    await expect
      .poll(async () => (await counter.frames()).some((f) => f.at >= lastWriteAt - 1_000), {
        timeout: 60_000,
      })
      .toBe(true);
    await page.waitForTimeout(QUIET_MS);
    await expect.poll(() => counter.inFlight(), { timeout: 60_000 }).toBe(0);
  }

  /**
   * Hold the approval the way a reader does: the port scrolled halfway, *Request
   * changes* pressed, half a sentence typed into its note and a word of it
   * selected. Every part of that is stamped so the burst can be judged by identity.
   */
  async function holdPlaceInApproval(page: Page, dialog: Locator) {
    const port = portOf(dialog);
    await expect(port).toBeVisible({ timeout: FIRST_PAINT_MS });
    await stampNode(port, 'port');
    await dialog
      .getByRole('button', { name: en.approvalGate.verb.requestChanges, exact: true })
      .click();
    const note = dialog.getByRole('textbox');
    await expect(note).toBeVisible();
    await stampNode(note, 'note');
    await note.click();
    await note.pressSequentially('The empty state should say who');
    await note.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(4, 9));
    // Halfway down the port, AFTER the band opened (it shares the panel's height).
    const offset = await port.evaluate((el) => {
      el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
      return el.scrollTop;
    });
    expect(offset, 'the port must scroll, or the scroll claim is about a zero').toBeGreaterThan(0);
    const place = await readPlace(page);
    expect(place.activeMark).toBe('note');
    expect(place.activeValue).toBe('The empty state should say who');
    expect(place.activeSelection).toEqual([4, 9]);
    return place;
  }

  async function expectPlaceHeld(page: Page, before: Awaited<ReturnType<typeof readPlace>>) {
    expect(await readPlace(page)).toEqual(before);
    await expect(stamped(page, 'port')).toHaveCount(1);
    await expect(stamped(page, 'note')).toHaveCount(1);
  }

  test('1 · an approval over /workbench holds still through 50 writes, then says its subject moved', async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const counter = await installRefreshCounter(page);
    const client = await publishGate(page, baseURL!);
    try {
      await openReader(
        page,
        `/workbench?tab=approvals&approval=${seed.designKey}&approvalKind=design_result`,
      );
      const dialog = dialogFor(page);
      await expect(dialog).toBeVisible({ timeout: FIRST_PAINT_MS });
      const before = await holdPlaceInApproval(page, dialog);

      await counter.reset();
      const { writes, lastWriteAt } = await driveWriteBurst(client, burstKey, BURST);
      await settle(page, counter, lastWriteAt);
      const counts = await record(testInfo, '1 approval over /workbench', writes, counter);

      expect(writes).toBeGreaterThanOrEqual(BURST);
      expect(counts.streamNudges, 'the burst reached the page').toBeGreaterThan(0);
      expect(counts.rscRefetches).toBe(0);
      expect(counts.documentLoads).toBe(0);
      await expectPlaceHeld(page, before);

      // THIS gate's subject moves: its card's acceptance criteria are rewritten.
      // The notice names it, and the port the reader is reading does not move.
      await tool(client, 'update_work_item', {
        key: seed.designKey,
        descriptionMd: '## Acceptance criteria\n\n- The empty state names who is waiting.',
      });
      await expect(dialog.getByTestId('approval-subject-moved')).toBeVisible({
        timeout: 60_000,
      });
      await expectPlaceHeld(page, before);
      expect((await counter.read()).rscRefetches).toBe(0);
      expect((await counter.read()).documentLoads).toBe(0);

      // Closed, the Workbench behind it agrees with the server.
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expectAgreesWithServer(page, 'approvals');
    } finally {
      await client.close();
    }
  });

  test('2 · an approval over an item page holds still through 50 writes', async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const counter = await installRefreshCounter(page);
    const client = await publishGate(page, baseURL!);
    try {
      await openReader(
        page,
        `/items/${seed.designKey}?approval=${seed.designKey}&approvalKind=design_result`,
      );
      const dialog = dialogFor(page);
      await expect(dialog).toBeVisible({ timeout: FIRST_PAINT_MS });
      const before = await holdPlaceInApproval(page, dialog);

      await counter.reset();
      const { writes, lastWriteAt } = await driveWriteBurst(client, burstKey, BURST);
      await settle(page, counter, lastWriteAt);
      const counts = await record(testInfo, '2 approval over an item page', writes, counter);

      expect(writes).toBeGreaterThanOrEqual(BURST);
      expect(counts.streamNudges, 'the burst reached the page').toBeGreaterThan(0);
      expect(counts.rscRefetches).toBe(0);
      expect(counts.documentLoads).toBe(0);
      await expectPlaceHeld(page, before);
    } finally {
      await client.close();
    }
  });

  test('5 · every Workbench tab applies 50 writes in place, and its strip agrees with its rows', async ({
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(900_000);
    // Two steady rows the reader can hover and focus, on every tab that lists
    // their own work. They are never written, so they must never move.
    const steady = ['Steady row to hover', 'Steady row to focus'];
    for (const title of steady) {
      const story = await workItemsService.createWorkItem(
        {
          projectId: seed.projectId,
          kind: 'task',
          title,
          type: 'code',
          assigneeId: seed.reviewerId,
        },
        { userId: seed.reviewerId, workspaceId: seed.workspaceId },
      );
      expect(story.identifier).toBeTruthy();
    }
    void burstId;
    const counter = await installRefreshCounter(page);
    const client = await publishGate(page, baseURL!);
    await signIn(page, seed.reviewerEmail, seed.password);

    // The second actor's burst, mixed so that rows ARRIVE and LEAVE: the burst
    // card cycles To do → In progress → Recently finished and back, the design
    // card under review is renamed, and the burst card is renamed in place.
    // A legal walk through the workflow (Done may only go back to In progress).
    const cycle = ['in_progress', 'done', 'in_progress', 'todo'] as const;
    let moves = 0;
    async function mixedBurst(round: number): Promise<{ writes: number; lastWriteAt: number }> {
      for (let n = 1; n <= BURST; n += 1) {
        const step = n % 5;
        if (step === 1 || step === 3 || step === 0) {
          await tool(client, 'transition_status', {
            key: burstKey,
            status: cycle[moves++ % cycle.length],
          });
        } else if (step === 2) {
          await tool(client, 'update_work_item', {
            key: seed.designKey,
            title: `${seed.designTitle} (round ${round}, write ${n})`,
          });
        } else {
          await tool(client, 'update_work_item', {
            key: burstKey,
            title: `${BURST_CARD_TITLE} (round ${round}, write ${n})`,
          });
        }
      }
      return { writes: BURST, lastWriteAt: Date.now() };
    }

    try {
      for (const [round, tab] of WORKBENCH_TABS.entries()) {
        await test.step(`tab ${tab}`, async () => {
          const streamOpened = page.waitForResponse(
            (r) => r.url().includes('/api/workbench/stream') && r.ok(),
          );
          await page.goto(workbenchTabHref(tab));
          await expect(tabLink(page, tab)).toHaveAttribute('aria-current', 'page', {
            timeout: FIRST_PAINT_MS,
          });
          await streamOpened;

          // The reader hovers one steady row and focuses another, where the tab lists them.
          const main = page.getByRole('main');
          // The row's own door — a stretched link over the whole row, so it is
          // what the pointer is over wherever it rests on the row.
          const hover = main.getByRole('link', { name: new RegExp(escapeRegExp(steady[0]!)) });
          const focus = main.getByRole('link', { name: new RegExp(escapeRegExp(steady[1]!)) });
          const holdsRows = (await hover.count()) > 0 && (await focus.count()) > 0;
          if (holdsRows) {
            await stampNode(hover.first(), `hover-${tab}`);
            await stampNode(focus.first(), `focus-${tab}`);
            await hover.first().hover();
            await focus.first().focus();
          }
          const before = await readPlace(page);

          // Every Workbench read the page makes for THIS tab, with what it answered.
          const answers: Answer[] = [await serverAnswer(page, tab)];
          const onResponse = async (r: Response) => {
            const url = new URL(r.url());
            if (url.pathname !== '/api/workbench/window' || url.searchParams.get('tab') !== tab) {
              return;
            }
            if (!r.ok()) return;
            const at = Date.now();
            try {
              answers.push(answerOf(tab, (await r.json()) as WorkbenchWindowDto, at));
            } catch {
              // a body the page itself could not read either
            }
          };
          page.on('response', onResponse);
          await recordStripSnapshots(page, tab);
          await counter.reset();

          const { writes, lastWriteAt } = await mixedBurst(round);
          await settle(page, counter, lastWriteAt);
          page.off('response', onResponse);
          const counts = await record(testInfo, `5 tab ${tab}`, writes, counter);

          expect(counts.streamNudges, `the burst reached ${tab}`).toBeGreaterThan(0);
          expect(counts.rscRefetches, `${tab}: no RSC refetch`).toBe(0);
          expect(counts.documentLoads, `${tab}: no document load`).toBe(0);

          // EVERY commit the page made agrees with SOME answer it had been given:
          // the chip is that answer's count, and that answer's rows are drawn.
          const snapshots = await snapshotsOf(page);
          // Not vacuous: the tab re-read its window, and the page committed it.
          expect(answers.length, `${tab}: the tab re-read its window`).toBeGreaterThan(1);
          expect(snapshots.length, `${tab}: the page drew an update`).toBeGreaterThan(0);
          for (const snap of snapshots) {
            const agrees = answers.some(
              (a) =>
                a.at <= snap.at + 250 &&
                a.count === snap.chip &&
                a.names.every((name) => snap.main.includes(name)),
            );
            expect(agrees, `${tab}: a commit drew ${snap.chip} with rows no read answered`).toBe(
              true,
            );
          }
          // …and it ends where the server is now.
          await expectAgreesWithServer(page, tab);

          if (holdsRows) {
            expect(await readPlace(page)).toEqual(before);
            await expect(stamped(page, `hover-${tab}`)).toHaveCount(1);
            await expect(stamped(page, `focus-${tab}`)).toHaveCount(1);
            expect(await hover.first().evaluate((el) => el.matches(':hover'))).toBe(true);
          }
        });
      }
    } finally {
      await client.close();
    }
  });

  test('7 · control — the counter records the one refresh the READER asks for', async ({
    page,
    baseURL,
  }, testInfo) => {
    const counter = await installRefreshCounter(page);
    const client = await publishGate(page, baseURL!);
    try {
      await openReader(
        page,
        `/workbench?tab=approvals&approval=${seed.designKey}&approvalKind=design_result`,
      );
      const dialog = dialogFor(page);
      await expect(portOf(dialog)).toBeVisible({ timeout: FIRST_PAINT_MS });

      await counter.reset();
      const { writes, lastWriteAt } = await driveWriteBurst(client, burstKey, BURST);
      await settle(page, counter, lastWriteAt);
      expect((await counter.read()).rscRefetches, 'the burst refreshed nothing').toBe(0);

      // The reader's own press: Approve's `onDecide` refreshes the route (the
      // guard's allowlisted case) — the counter must see it.
      await dialog.getByRole('button', { name: en.approvalGate.verb.approve, exact: true }).click();
      await dialog
        .getByRole('button', {
          name: en.approvalGate.confirm.proceed.replace('{verb}', en.approvalGate.verb.approve),
          exact: true,
        })
        .click();
      // The decision is recorded — the frame says so — and the refresh follows it.
      await expect(dialog.getByText(en.approvalGate.state.approved, { exact: true })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect.poll(async () => (await counter.read()).rscRefetches).toBeGreaterThan(0);
      await expect.poll(() => counter.inFlight(), { timeout: 60_000 }).toBe(0);
      const counts = await record(testInfo, '7 control: the reader approves', writes, counter);
      expect(counts.rscRefetches).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});

// ── Group B: plans (the plan-progress tenant) ────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
// ⚠️ THE VISIBLE COPY ONLY: a streamed or outgoing subtree is in the DOM but
// hidden, so filtering on visibility is what keeps this to the live list. It
// cannot go by role: with a card's peek open the list is hidden from the
// accessibility tree, and the overlay and the plan page both host it.
const proposalList = (page: Page) =>
  page.locator('[data-testid="plan-proposal-list"]').filter({ visible: true });
const listButton = (page: Page) =>
  workspace(page)
    .getByRole('group', { name: en.planReview.viewSwitchAria })
    .getByRole('button', { name: en.planReview.viewList, exact: true });
// ⚠️ BY ELEMENT, NOT BY ROLE: with a card's peek open the list behind it is
// hidden from the accessibility tree, and the rows are still the page's rows.
const proposalRow = (page: Page, title: string) =>
  proposalList(page).locator('li').filter({ hasText: title });
const overlayOpen = (url: URL) =>
  url.searchParams.has('planSession') || url.searchParams.has('plan');

const planningTable = (page: Page) => page.getByRole('table', { name: en.workbench.tabs.planning });
const planningRowDoor = (page: Page, title: string) =>
  planningTable(page)
    .getByRole('row')
    .filter({ hasText: title })
    .getByRole('link', { name: en.workbench.planning.rowAria.split('{sentence}')[0]! });
const approvalRows = (page: Page) =>
  page.getByRole('table', { name: en.workbench.tabs.toApprove }).getByTestId(/^approval-row-/);
const reviewPlanDoor = (page: Page, text: string) =>
  approvalRows(page)
    .filter({ hasText: text })
    .getByRole('button', { name: en.workbench.approvals.review, exact: true });

/** Every `GET /api/plans/<id>` the page makes — the plan surface's poll ticks. */
function countPlanPolls(page: Page, planId: string): () => number {
  let ticks = 0;
  page.on('response', (r) => {
    if (r.request().method() === 'GET' && new URL(r.url()).pathname === `/api/plans/${planId}`) {
      ticks += 1;
    }
  });
  return () => ticks;
}

/** The NEXT plan poll whose body satisfies `until`. Arm it BEFORE the writes land. */
function planPolled(page: Page, planId: string, until: (b: PlanReviewDto) => boolean) {
  return page.waitForResponse(
    async (r) => {
      if (r.request().method() !== 'GET' || !r.ok()) return false;
      if (new URL(r.url()).pathname !== `/api/plans/${planId}`) return false;
      try {
        return until((await r.json()) as PlanReviewDto);
      } catch {
        return false;
      }
    },
    { timeout: 120_000 },
  );
}

async function createPlan(agent: Client, seed: PlanProgressSeed, title: string): Promise<string> {
  const created = await tool<{ id: string }>(agent, CREATE_PLAN_TOOL_NAME, {
    projectKey: seed.projectKey,
    title,
    summary: title,
    plannedWithHarness: 'Claude Code',
  });
  return created.id;
}

async function addProposals(
  agent: Client,
  planId: string,
  seed: PlanProgressSeed,
  titles: readonly string[],
  opts: { final?: boolean } = {},
): Promise<string[]> {
  const r = await tool<{ planItemIds: string[] }>(agent, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    ...(opts.final ? { final: true } : {}),
    proposals: titles.map((title) => ({
      op: 'add',
      proposedFields: { title, kind: 'subtask' },
      parentRef: seed.storyKey,
    })),
  });
  return r.planItemIds;
}

async function openPlanReader(page: Page, seed: PlanProgressSeed): Promise<void> {
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
}

async function showList(page: Page): Promise<void> {
  await expect(listButton(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await listButton(page).click();
  await expect(proposalList(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

test.describe('plans, under a second actor', () => {
  let seed: PlanProgressSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedPlanProgress(`lip${Date.now().toString(36)}`);
  });

  test('3 · a plan being written takes 50 proposals in place, then holds still for 8 polls', async ({
    page,
    baseURL,
  }, testInfo) => {
    const agent = await agentSession(seed.token, baseURL!);
    try {
      const title = 'A plan written while it is read';
      const planId = await createPlan(agent, seed, title);
      const first = ['Opening proposal one', 'Opening proposal two', 'Opening proposal three'];
      await addProposals(agent, planId, seed, first);

      const counter = await installRefreshCounter(page);
      const ticks = countPlanPolls(page, planId);
      await openPlanReader(page, seed);
      await page.goto(workbenchTabHref('planning'));
      await planningRowDoor(page, title).click();
      await page.waitForURL(overlayOpen);
      await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await showList(page);
      await expect(proposalRow(page, first[2]!)).toBeVisible({ timeout: FIRST_PAINT_MS });

      // The reader's place: a comment half-typed in the rail, and one card opened.
      await stampNode(proposalList(page), 'plan-list');
      await stampNode(composer(page), 'composer');
      await composer(page).fill('Keep the retry budget small, and');
      await stampNode(proposalRow(page, first[0]!), 'opened-row');
      await proposalList(page)
        .getByRole('button', { name: new RegExp(`${escapeRegExp(first[0]!)}$`) })
        .click();
      const peek = page.getByRole('dialog').filter({ hasText: first[0]! }).last();
      await expect(peek).toBeVisible();
      await stampNode(peek, 'opened-card');
      const before = await readPlace(page);

      await counter.reset();
      const startTicks = ticks();
      const added = Array.from(
        { length: BURST },
        (_, i) => `Proposal written live ${String(i + 1).padStart(2, '0')}`,
      );
      const allIn = planPolled(page, planId, (b) => b.items.length === first.length + BURST);
      for (const proposal of added) await addProposals(agent, planId, seed, [proposal]);
      await allIn;
      for (const proposal of added) {
        await expect(proposalRow(page, proposal)).toHaveCount(1);
      }
      await page.waitForTimeout(QUIET_MS);
      await expect.poll(() => counter.inFlight(), { timeout: 60_000 }).toBe(0);
      const counts = await record(
        testInfo,
        '3 generating plan (poll ticks)',
        BURST,
        counter,
        ticks() - startTicks,
      );
      expect(counts.rscRefetches).toBe(0);
      expect(counts.documentLoads).toBe(0);
      expect(await readPlace(page)).toEqual(before);
      await expect(stamped(page, 'composer')).toHaveValue('Keep the retry budget small, and');
      for (const mark of ['plan-list', 'composer', 'opened-row', 'opened-card']) {
        await expect(stamped(page, mark), `${mark} is the same node`).toHaveCount(1);
      }
      await expect(peek).toBeVisible();

      // Eight quiet re-reads of a plan still being written: zero DOM mutations. Under push
      // (MOTIR-8542) the surface reads only when the plan's row changes, so each read is
      // driven by a no-op touch of the plan and awaited, not left to a timer.
      await recordMutations(proposalList(page), 'plan-tree');
      const quietFrom = ticks();
      for (let i = 0; i < PLAN_QUIET_READS; i += 1) {
        const read = planPolled(page, planId, () => true);
        await nudgePlan(planId);
        await read;
      }
      expect(ticks() - quietFrom, 'the plan kept reading through the quiet').toBeGreaterThanOrEqual(
        PLAN_QUIET_READS,
      );
      expect(await mutationsOf(page, 'plan-tree')).toBe(0);
      expect((await counter.read()).rscRefetches).toBe(0);
      expect((await counter.read()).documentLoads).toBe(0);
    } finally {
      await agent.close();
    }
  });

  test('6 · Approve keeps the decided plan on screen, and the Workbench behind it is current', async ({
    page,
    baseURL,
  }, testInfo) => {
    const agent = await agentSession(seed.token, baseURL!);
    try {
      const title = 'A plan approved where it is read';
      const planId = await createPlan(agent, seed, title);
      const proposals = ['Approved proposal one', 'Approved proposal two'];
      await addProposals(agent, planId, seed, proposals, { final: true });

      const counter = await installRefreshCounter(page);
      await openPlanReader(page, seed);
      await page.goto(workbenchTabHref('approvals'));
      await reviewPlanDoor(page, title).click();
      await page.waitForURL(overlayOpen);
      const bar = workspace(page).getByTestId('plan-change-confirm-bar');
      await expect(bar).toBeVisible({ timeout: FIRST_PAINT_MS });

      await counter.reset();
      const approved = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === `/api/plans/${planId}/approve` &&
          r.request().method() === 'POST',
      );
      await bar
        .getByRole('button', { name: en.approvalGate.planApproval.surface.approve, exact: true })
        .click();
      expect((await approved).status()).toBe(200);

      // The decided plan stays, each card carrying its outcome AS A WORD.
      await expect(bar).toHaveCount(0);
      const outcomes = workspace(page).getByTestId('plan-item-outcome-tab');
      await expect(outcomes).toHaveCount(proposals.length, { timeout: FIRST_PAINT_MS });
      for (const outcome of await outcomes.all()) await expect(outcome).toHaveText('accepted');
      await expect.poll(() => counter.inFlight(), { timeout: 60_000 }).toBe(0);
      const counts = await record(testInfo, '6 Approve in the overlay', 0, counter);
      expect(counts.documentLoads, 'Approve must not reload the page (MOTIR-6640)').toBe(0);

      // Closed, the Workbench's counts are the server's.
      await workspace(page)
        .getByRole('button', { name: new RegExp(`^${escapeRegExp(en.planningWorkspace.close)}`) })
        .click();
      await page.waitForURL((url) => !overlayOpen(url));
      for (const tab of ['approvals', 'planning', 'todo'] as const) {
        const answer = await serverAnswer(page, tab);
        await expect.poll(() => chipOf(page, tab), { timeout: FIRST_PAINT_MS }).toBe(answer.count);
      }
      expect((await counter.read()).documentLoads).toBe(0);
    } finally {
      await agent.close();
    }
  });

  test('4 · a planned plan revised 50 times updates in place, in the overlay and on the plan page', async ({
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(600_000);
    const agent = await agentSession(seed.token, baseURL!);
    try {
      const title = 'A planned plan revised while it is read';
      const planId = await createPlan(agent, seed, title);
      const titles = [
        'Revised in the overlay',
        'Withdrawn in the overlay',
        'Sibling in the overlay',
        'Revised on the plan page',
        'Withdrawn on the plan page',
        'Sibling on the plan page',
      ];
      const ids = await addProposals(agent, planId, seed, titles, { final: true });
      const idOf = (t: string) => ids[titles.indexOf(t)]!;

      const counter = await installRefreshCounter(page);
      const ticks = countPlanPolls(page, planId);
      await openPlanReader(page, seed);

      async function reviseUnderReader(
        host: string,
        open: () => Promise<void>,
        revised: string,
        withdrawn: string,
        sibling: string,
      ) {
        // The planner is already revising when the reader arrives — the lease is
        // what a revising planner holds, and what keeps the surface reading.
        await tool(agent, HOLD_PLAN_REVISION_TOOL_NAME, {
          planId,
          action: 'start',
          harness: 'Claude Code',
        });
        await open();
        await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
        await showList(page);
        await expect(proposalRow(page, sibling)).toBeVisible({ timeout: FIRST_PAINT_MS });
        await stampNode(proposalRow(page, sibling), `sibling-${host}`);
        await stampNode(proposalList(page), `list-${host}`);
        await counter.reset();
        const startTicks = ticks();

        const last = `${revised} (edit ${BURST - 1})`;
        const landed = planPolled(
          page,
          planId,
          (b) =>
            b.items.some((i) => i.planItemId === idOf(revised) && i.title === last) &&
            !b.items.some((i) => i.planItemId === idOf(withdrawn)),
        );
        for (let n = 1; n < BURST; n += 1) {
          await tool(agent, UPDATE_PLAN_ITEM_TOOL_NAME, {
            planId,
            planItemId: idOf(revised),
            title: `${revised} (edit ${n})`,
            revision: true,
          });
        }
        await tool(agent, WITHDRAW_PLAN_PROPOSAL_TOOL_NAME, {
          planId,
          planItemId: idOf(withdrawn),
        });
        await landed;
        await expect(proposalRow(page, last)).toHaveCount(1);
        await expect(proposalRow(page, withdrawn)).toHaveCount(0);
        await expect(stamped(page, `sibling-${host}`), 'the sibling was not remounted').toHaveCount(
          1,
        );
        await expect(stamped(page, `list-${host}`)).toHaveCount(1);
        await page.waitForTimeout(QUIET_MS);
        await expect.poll(() => counter.inFlight(), { timeout: 60_000 }).toBe(0);
        await tool(agent, HOLD_PLAN_REVISION_TOOL_NAME, { planId, action: 'end' });
        const counts = await record(
          testInfo,
          `4 planned plan, ${host} (poll ticks)`,
          BURST,
          counter,
          ticks() - startTicks,
        );
        expect(counts.rscRefetches, `${host}: no RSC refetch`).toBe(0);
        expect(counts.documentLoads, `${host}: no document load`).toBe(0);
      }

      // Host 1 — the planning overlay, opened from the Workbench's Planning tab,
      // where a plan being revised waits (it leaves Waiting on you while held).
      await reviseUnderReader(
        'overlay',
        async () => {
          await page.goto(workbenchTabHref('planning'));
          await planningRowDoor(page, title).click();
          await page.waitForURL(overlayOpen);
        },
        'Revised in the overlay',
        'Withdrawn in the overlay',
        'Sibling in the overlay',
      );

      // Host 2 — the plan's own address, `/plans/<id>`.
      await reviseUnderReader(
        'plan page',
        async () => {
          await page.goto(`/plans/${planId}`);
        },
        'Revised on the plan page',
        'Withdrawn on the plan page',
        'Sibling on the plan page',
      );
    } finally {
      await agent.close();
    }
  });
});
