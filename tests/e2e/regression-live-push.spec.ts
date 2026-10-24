import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  openAgentSession,
  publishDesignResult,
  servePublishedMock,
} from './_helpers/design-approval-seed';
import { seedApprovalsTab, type ApprovalsTabSeed } from './_helpers/approvals-tab-seed';
import {
  attachLiveNetworkLog,
  loadMarker,
  sawReconnecting,
  setLoadMarker,
  setVisibility,
  watchForReconnecting,
  type LiveNetworkLog,
  type LoggedRequest,
} from './_helpers/liveNetworkLog';
import { workItemsService } from '@/lib/services/workItemsService';
import { plansService } from '@/lib/services/plansService';
import {
  STREAM_STALE_MS,
  WORKBENCH_STREAM_HIDDEN_GRACE_MS,
} from '@/app/(authed)/workbench/_components/useWorkbenchLive';
import { POLL_MS } from '@/lib/hooks/useGeneratingPlanPoll';
import en from '@/messages/en.json';

// LIVE UPDATES REACH AN OPEN PAGE BY SERVER PUSH — THE ACCEPTANCE RECEIPT
// (Story MOTIR-8542 · Subtask MOTIR-8734). The story's verification recipe, in a
// real browser against a production build and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A person keeps the Workbench open and does nothing. The tab holds ONE
// connection and sends nothing on a clock; a card somebody else writes appears
// in To do by itself; the tab is backgrounded, goes quiet, and catches up the
// moment it is shown — without ever saying *Reconnecting…*; the network drops,
// the chip says so, and clears when it comes back. A plan being written is read
// off the SAME connection, only after something changed. Nothing in the walk is
// a page load or a refresh: the document is the one the reader opened.
//
// ── ⚠️ THE VISIBILITY STUB ──────────────────────────────────────────────────
//
// Playwright cannot background a tab — a page stays `visible` however the
// browser is driven. So `setVisibility` (`_helpers/liveNetworkLog.ts`) overrides
// `document.visibilityState` / `document.hidden` and dispatches a REAL
// `visibilitychange`. The product's own listener runs and reads the overridden
// state, which is all a backgrounded tab differs by from its point of view.
//
// ── ⚠️ THE CLOCK ────────────────────────────────────────────────────────────
//
// `page.clock.install()` before the first load, so time flows naturally and a
// window can be FAST-FORWARDED with `runFor`: every browser timer due in the
// window fires, which is what turns "no request on a timer" from a guess about
// how long to wait into a fact about the timers. Two bounds keep a window
// honest about the product's OWN deadlines:
//   · a quiet window stays under `STREAM_STALE_MS` minus a heartbeat (15s), or
//     the stream's silence watchdog would read the jump as a dead connection —
//     correctly, and the reconnect would then be a request the window caused;
//   · the hidden window is the grace period itself, imported, never retyped.
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// No `waitForTimeout`. A write is the service call itself — committed when it
// resolves — then the row in the reader's own table; a stream is its response
// with `content-type: text/event-stream`; a park is the stream request FAILING
// (aborted); a resume is the response of the reopen, armed before the show.
//
// ── OUT OF THE STORY: THE BELL ──────────────────────────────────────────────
//
// The notification bell polls its unread count once a minute
// (`NotificationBell.tsx`, the "no-realtime decision"). The story replaces the
// Workbench's watermark poll and the plan overlay's 2.5s poll, not the bell, so
// that one request is named and excluded from the "nothing leaves" sets. Every
// other request counts.

const OUT_OF_STORY = new Set(['/api/notifications/unread-count']);

/** A window short enough for the stream's watchdog, long enough for four poll ticks. */
const QUIET_WINDOW_MS = 4 * POLL_MS + 1;
// The route's `WORKBENCH_STREAM_HEARTBEAT_MS`, retyped: importing the route
// module would load its auth and session wiring into the runner.
const HEARTBEAT_MS = 15_000;
if (QUIET_WINDOW_MS + HEARTBEAT_MS >= STREAM_STALE_MS) {
  throw new Error('the quiet window would outlast the stream watchdog');
}

const START_TITLE = 'Tidy the release checklist';
const ARRIVES_TITLE = 'Draft the incident review';
const HIDDEN_TITLES = [
  'Rotate the staging keys',
  'Archive the old dashboards',
  'Re-run the export',
];
const OFFLINE_TITLE = 'Answer the support escalation';
const PLAN_TITLE = 'Being written while you watch';
const PROPOSAL_TITLE = 'Add the retry banner';

const inStory = (r: LoggedRequest) => !OUT_OF_STORY.has(r.url.pathname);

/** The To do tab's own table — the live subtree the rows belong to. */
const toDo = (page: Page): Locator => page.getByRole('table', { name: en.workbench.tabs.toDo });
const rowOf = (page: Page, identifier: string): Locator =>
  toDo(page).getByTestId(`workbench-row-${identifier}`);

const reconnecting = (page: Page) =>
  page.getByRole('status').filter({ hasText: en.workbench.live.reconnecting });

/** Create a card assigned to the reader, as a writer OTHER than the page. */
async function writeAssigned(seed: ApprovalsTabSeed, title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title, assigneeId: seed.reviewerId },
    { userId: seed.reviewerId, workspaceId: seed.workspaceId },
  );
  // Committed once the call resolved; the read-back is the authoritative half.
  await expect
    .poll(async () => (await adminDb.workItem.findUnique({ where: { id: item.id } }))?.title, {
      message: `${title} committed`,
    })
    .toBe(title);
  return item.identifier;
}

/** CASE 7 — the document is the one opened at `mark`: no load, no RSC refresh of it. */
async function expectSameDocument(
  page: Page,
  log: LiveNetworkLog,
  mark: number,
  stamp: string,
): Promise<void> {
  const pathname = new URL(page.url()).pathname;
  expect(
    log.documentLoads(mark).map((r) => r.url.href),
    'document loads',
  ).toEqual([]);
  expect(
    log.rscRefreshes(pathname, mark).map((r) => r.url.href),
    'RSC refreshes',
  ).toEqual([]);
  expect(await loadMarker(page), 'the load marker survived').toBe(stamp);
}

test.describe.configure({ timeout: 300_000 });

test.describe('live updates reach an open page by server push', () => {
  let seed: ApprovalsTabSeed;
  let start: string;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedApprovalsTab(`lp${Date.now().toString(36)}`);
    start = await writeAssigned(seed, START_TITLE);
  });

  test('one stream, nothing on a clock, writes arrive in place, a hidden tab parks and resumes, a drop says Reconnecting and recovers', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-8542');
    await page.clock.install();
    await signIn(page, seed.reviewerEmail, seed.password);

    const log = attachLiveNetworkLog(page);
    await page.goto('/workbench?tab=todo');
    await expect(rowOf(page, start)).toBeVisible();
    // ⚠️ The sign-in landing (another Workbench tab) can open ITS stream while
    // this navigation is still pending, so the log may hold that one too. It
    // ends when the landing document goes; this page's stream is the one left
    // open, and every count below starts from it.
    await expect
      .poll(() => log.streams().filter((r) => r.ended === null).length, {
        message: 'only this page’s stream is left',
      })
      .toBe(1);
    await expect.poll(() => log.openStreams().length, { message: 'the stream opened' }).toBe(1);
    const first = log.openStreams()[0]!.seq;
    const opened = log.mark();
    await setLoadMarker(page, 'live-push');
    await watchForReconnecting(page);

    // ONE quiet window serves cases 1 and 2. Two back-to-back jumps would sum past
    // what the stream's silence watchdog allows between two heartbeats (two
    // windows plus a heartbeat interval reach `STREAM_STALE_MS`), and the
    // reconnect it then made would be a request the spec caused, not the page.
    let window = 0;
    await chapter('The Workbench holds one connection, and nothing repeats', async () => {
      // CASE 1 — fast-forward the window: every timer due in it fires.
      window = log.mark();
      await page.clock.runFor(QUIET_WINDOW_MS);
      expect(log.eventStreams(first).length, 'text/event-stream connections').toBe(1);
      expect(log.streams(window), 'no new stream request').toEqual([]);
      expect(log.repeated(window), 'requests seen twice in the window').toEqual([]);
      await expectSameDocument(page, log, opened, 'live-push');
    });
    await beat();

    await chapter('A quiet tab sends nothing at all', async () => {
      // CASE 2 — not a repeat, and not even a single request, in that same window.
      const sent = log.since(window).filter(inStory);
      expect(
        sent.map((r) => `${r.method} ${r.url.pathname}`),
        'requests in a quiet window',
      ).toEqual([]);
      expect(log.since(window).filter((r) => r.url.pathname.startsWith('/api/plans/'))).toEqual([]);
      await expectSameDocument(page, log, opened, 'live-push');
    });
    await beat();

    await chapter('Somebody else assigns a card, and it arrives in To do in place', async () => {
      // CASE 3.
      const arrived = await writeAssigned(seed, ARRIVES_TITLE);
      await expect(rowOf(page, arrived)).toBeVisible({ timeout: 30_000 });
      expect(log.eventStreams(first).length).toBe(1);
      await expectSameDocument(page, log, opened, 'live-push');
    });
    await beat();

    await chapter('The tab goes to the background, parks, and catches up when shown', async () => {
      // CASE 5.
      const [live] = log.openStreams();
      expect(live, 'one live stream before hiding').toBeDefined();
      await setVisibility(page, 'hidden');
      await page.clock.runFor(WORKBENCH_STREAM_HIDDEN_GRACE_MS);
      // AUTHORITATIVE: the connection request itself, aborted by the park.
      await expect.poll(() => live!.ended, { message: 'the stream was aborted' }).toBe('failed');
      expect(log.openStreams()).toEqual([]);

      const parked = log.mark();
      const written: string[] = [];
      for (const title of HIDDEN_TITLES) written.push(await writeAssigned(seed, title));
      // Every timer the hidden tab still holds gets its chance to fire.
      await page.clock.runFor(QUIET_WINDOW_MS);
      expect(
        log
          .since(parked)
          .filter(inStory)
          .map((r) => `${r.method} ${r.url.pathname}`),
        'requests while hidden',
      ).toEqual([]);

      const shown = log.mark();
      const reopen = page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/api/workbench/stream',
      );
      await setVisibility(page, 'visible');
      const response = await reopen;
      expect(
        new URL(response.url()).searchParams.get('since'),
        'resumes from the cursor',
      ).not.toBeNull();
      expect(response.headers()['content-type']).toContain('text/event-stream');

      for (const identifier of written) {
        await expect(rowOf(page, identifier)).toBeVisible({ timeout: 30_000 });
      }
      expect(log.streams(shown), 'exactly one reopen').toHaveLength(1);
      expect(await sawReconnecting(page), 'Reconnecting… was never shown').toBe(false);
      await expectSameDocument(page, log, opened, 'live-push');
    });
    await beat();

    await chapter('The network drops, says Reconnecting, and recovers in place', async () => {
      // CASE 6.
      await page.context().setOffline(true);
      await expect(reconnecting(page)).toBeVisible({ timeout: STREAM_STALE_MS + 5_000 });

      const identifier = await writeAssigned(seed, OFFLINE_TITLE);
      const back = log.mark();
      const reopen = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/workbench/stream' &&
          (r.headers()['content-type'] ?? '').startsWith('text/event-stream'),
        { timeout: 60_000 },
      );
      await page.context().setOffline(false);
      const response = await reopen;
      expect(new URL(response.url()).searchParams.has('since'), 'resumes from the cursor').toBe(
        true,
      );

      await expect(rowOf(page, identifier)).toBeVisible({ timeout: 30_000 });
      await expect(reconnecting(page)).toBeHidden();
      expect(log.eventStreams(back), 'one reopen after the drop').toHaveLength(1);
      expect(log.openStreams()).toHaveLength(1);
      await expectSameDocument(page, log, opened, 'live-push');
    });

    log.detach();
  });

  test('a generating plan and an open approval share the one stream, and the plan is read only after it changed', async ({
    page,
    baseURL,
  }) => {
    // CASE 4.
    await servePublishedMock(page);
    const client = await openAgentSession(seed.token, baseURL!);
    const published = await publishDesignResult(client, seed.designKey);
    expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
    const ctx = { userId: seed.reviewerId, workspaceId: seed.workspaceId };
    const plan = await plansService.createPlan(seed.projectId, { title: PLAN_TITLE }, ctx);

    await page.clock.install();
    await signIn(page, seed.reviewerEmail, seed.password);
    // A member's `/plans/<id>` for an undecided plan is REPLACED by the planning
    // overlay on the plan's session (MOTIR-7888), which drops the query. So the
    // overlay's own address is read from that redirect, and the approval overlay
    // (mounted once by the authed layout) is opened over it.
    await page.goto(`/plans/${plan.id}`);
    await page.waitForURL((u) => u.searchParams.has('planSession'));
    const overlay = new URL(page.url());
    overlay.searchParams.set('approval', seed.designKey);
    overlay.searchParams.set('approvalKind', 'design_result');
    // The log starts with the page the spec reads; the bounce's own stream is not it.
    const log = attachLiveNetworkLog(page);
    await page.goto(`${overlay.pathname}${overlay.search}`);
    // The planning overlay is MODAL, so the approval stacked over it sits outside
    // its accessibility tree; it is found with the hidden elements included and
    // then asserted on screen.
    const dialog = page.getByRole('dialog', {
      name: `${en.workbench.approvals.kind.design_result} for ${seed.designKey}`,
      includeHidden: true,
    });
    await expect(dialog).toBeVisible();
    // AUTHORITATIVE: the live connection is the one WATCHING the plan.
    await expect
      .poll(() => log.openStreams().map((r) => r.url.searchParams.getAll('watch').join(',')), {
        message: 'the one stream watches the plan',
        timeout: 30_000,
      })
      .toEqual([expect.stringContaining(plan.id)]);
    const opened = log.mark();
    await setLoadMarker(page, 'plan');

    // ONE connection at every moment: a change of the watched set closes before
    // it opens, so the tab never held two.
    expect(log.maxOpenStreams, 'connections open at once').toBe(1);
    expect(log.openStreams()).toHaveLength(1);

    const window = log.mark();
    await page.clock.runFor(QUIET_WINDOW_MS);
    expect(log.planReads(plan.id, window), 'plan reads on a timer').toEqual([]);
    expect(log.openStreams()).toHaveLength(1);

    // The write — armed first, so a read that happened BEFORE it could not be
    // mistaken for one that followed it.
    const beforeWrite = log.mark();
    const read = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        new URL(r.url()).pathname === `/api/plans/${encodeURIComponent(plan.id)}`,
      { timeout: 30_000 },
    );
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: PROPOSAL_TITLE, kind: 'task' } }],
      ctx,
    );
    expect((await read).status()).toBe(200);
    expect(log.planReads(plan.id, opened).every((r) => r.seq >= beforeWrite)).toBe(true);
    // The proposal is drawn by the planning overlay, which sits beneath the open
    // approval — present in the page, painted from the read that followed the write.
    await expect(page.getByText(PROPOSAL_TITLE).first()).toBeAttached({ timeout: 30_000 });

    expect(log.maxOpenStreams).toBe(1);
    expect(log.eventStreams(opened), 'no new connection for the plan').toEqual([]);
    await expectSameDocument(page, log, opened, 'plan');

    log.detach();
    await client.close();
  });
});
