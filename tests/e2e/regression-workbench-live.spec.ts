import type { Locator, Page } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  openAgentSession,
  publishDesignResult,
  servePublishedMock,
} from './_helpers/design-approval-seed';
import { plantFillerGates, STORY_TITLE_EXPORT } from './_helpers/approvals-tab-seed';
import { seedWorkbenchLive, type WorkbenchLiveSeed } from './_helpers/workbench-live-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// THE WORKBENCH IS LIVE, END TO END — AND THE ACCEPTANCE RECEIPT FOR IT
// (Story MOTIR-5238 · Subtask MOTIR-5245).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A person sits still and their screen keeps itself current. A row arrives and
// the tab's number goes up while the cursor does not move; the approval they are
// reading tells them the thing they are looking at has changed; the lift goes
// down and comes back and the surface catches up by itself. The clip's whole
// argument is that NOBODY TOUCHED ANYTHING — so the first thing this spec
// installs is a navigation counter, and every phase asserts it did not move.
//
// ── WHAT ONLY AN E2E CAN PROVE ──────────────────────────────────────────────
//
// Every other tier has to HAND the code a frame. Only a browser can hold a real
// render open across a real mutation made in somebody else's session and show
// the screen change on its own — which is both the property and the evidence.
// The reader not being disturbed (scroll, the pager's page, the active tab) is a
// property of a real layout, and a dropped connection is timing: a unit test
// asserts the code path, a browser asserts the experience.
//
// ── WHERE THE CHANGES COME FROM ─────────────────────────────────────────────
//
// An MCP session over `/api/mcp` with a `CLI_TOKEN_GRANT` bearer — a real agent,
// through the real doors (`publish_design_result`, `update_work_item`). It runs
// in NODE, not in the page, which is what makes phase 5 possible at all: the
// browser can be taken offline while the agent keeps working. A spec that
// mutated through the page it is asserting against would have re-rendered the
// thing it claims updated itself.
//
// ── ⚠️ PHASE 2 EDITS THE CRITERIA; IT DOES NOT REPUBLISH ────────────────────
//
// MOTIR-5245's recipe says *republish it*, and a republish CANNOT carry phases 2
// and 3 together. Republishing SUPERSEDES the awaiting gate and raises a new one
// (`designEvidenceService`), so the press in phase 3 is refused by the state
// guard — `ApprovalGateSupersededError`, *this question was withdrawn* — which
// `approvalGatesService` checks BEFORE the stamp, deliberately and in that order
// ("a withdrawn question must be reported as withdrawn, never as stale"). The
// card's phase 3 asks for the STAMP's refusal, and the stamp's other component
// is the card's own body: an acceptance-criteria edit leaves the gate `awaiting`
// and moves `criteria`, so the notice and the refusal both fire and — the seam
// this story exists for — NAME THE SAME THING. The deviation and its reason are
// recorded on MOTIR-5245.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE — a row's own text, the badge's value, the
// named dialog, the notice, the refusal, the reconnecting chip. There is no
// `waitForTimeout` and no fixed sleep anywhere in this file, and this is the
// spec where that discipline is hardest to keep: every phase is *wait for
// something to happen by itself*. A sleep would leave the clip looking exactly
// right and the assertion underneath it meaning nothing.

test.describe.configure({ timeout: 420_000 });

/** The queue's rows, scoped to the TABLE rather than rooted at the page —
 *  `tests/e2e-page-rooted-locators.test.ts` admits no new page-rooted test-id
 *  locator, and the table is the live subtree the rows belong to. */
const queue = (page: Page, tab: string) => page.getByRole('table', { name: tab });
const rowsIn = (page: Page, tab: string) => queue(page, tab).getByTestId(/^approval-row-/);

/** The strip's badge for a tab, as a number — a SUPPRESSED zero is zero
 *  (`design/workbench/design-notes.md`: "a `0` beside a tab is noise"). */
async function badgeCount(page: Page, tab: string): Promise<number> {
  const text = (await page.getByRole('link', { name: new RegExp(tab) }).textContent()) ?? '';
  const digits = text.replace(/[^0-9]/g, '');
  return digits === '' ? 0 : Number(digits);
}

/** A row's whole-row door. Clicked at its left edge: its centre sits under the
 *  work-item link, which is the one control above it on purpose. */
async function openRow(row: Locator): Promise<void> {
  await row.getByRole('link', { name: /^(Review|查看) / }).click({ position: { x: 8, y: 22 } });
}

/**
 * *Reconnecting…* — the chip beside the strip.
 *
 * ⚠️ FILTERED BY TEXT, NEVER NAMED. `status` is a live-region role, and the
 * accname spec does not let one take its name from its contents — so
 * `getByRole('status', { name })` matches nothing however the chip is written.
 * The role narrows the live regions; the text picks this one out of them.
 */
const reconnecting = (page: Page, label: string) =>
  page.getByRole('status').filter({ hasText: label });

/**
 * ⚠️ THE CLIP'S WHOLE CLAIM, AS A FACT ABOUT THE DOCUMENT.
 *
 * Stamp the window, then read the stamp back: it survives a `router.refresh()`,
 * which re-renders the page IN PLACE, and it does not survive a reload or a new
 * document. So an intact stamp is the assertion *this is still the page you were
 * looking at* — which, with the URL and the active tab beside it, is the whole of
 * what "nobody touched anything" can mean.
 *
 * ⚠️ IT REPLACES A NAVIGATION COUNT, and the reason is worth keeping: Playwright
 * fires `framenavigated` for Next's client-side re-render too, so a COUNT cannot
 * tell a re-read from a load — it reported one extra "navigation" for precisely
 * the refresh this story exists to cause. Measured on this spec's first green
 * walk; do not put the counter back.
 */
async function stampDocument(page: Page, value: string): Promise<void> {
  await page.evaluate((v) => {
    (window as unknown as Record<string, unknown>)['__liveWalk'] = v;
  }, value);
}

function documentStamp(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as unknown as Record<string, unknown>)['__liveWalk'] ?? null);
}

/**
 * WHERE the subject is drawn — its top-left corner, in the viewport.
 *
 * ⚠️ POSITION, NOT THE WHOLE BOX, and the difference is the point. Band 2 is the
 * frame's flex owner, so a notice drawn BELOW it takes its height out of the
 * port — which is exactly what *the design does not move* costs, and pinning the
 * height here would be asserting that the notice occupies nothing. What the
 * design forbids is the reader's eye having to find the design again: the corner
 * it is anchored at.
 */
async function portPosition(port: Locator): Promise<{ x: number; y: number }> {
  const box = await port.boundingBox();
  expect(box, 'the subject port has no box — it is not on screen').not.toBeNull();
  return { x: box!.x, y: box!.y };
}

/** How far the element that scrolls the list has been scrolled. */
function listScroll(row: Locator): Promise<number> {
  return row.evaluate((el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const overflowY = getComputedStyle(n).overflowY;
      if (/(auto|scroll)/.test(overflowY) && n.scrollHeight > n.clientHeight) return n.scrollTop;
    }
    return document.scrollingElement?.scrollTop ?? 0;
  });
}

/**
 * Edit the card's body through the agent's own door — which moves the stamp's
 * `criteria` component without touching the gate.
 *
 * ⚠️ THE RESULT IS CHECKED, and it has to be. An MCP tool reports a refusal as a
 * RESULT (`isError`), not as a rejected promise, so an unchecked call resolves
 * happily having changed nothing — and every assertion after it would then be
 * waiting for a consequence of something that never happened, failing sixty
 * seconds later and pointing at the wrong thing.
 */
async function editCriteria(client: Client, key: string, criterion: string): Promise<void> {
  const result = (await client.callTool({
    name: 'update_work_item',
    arguments: {
      key,
      descriptionMd: ['## Acceptance criteria', '', `- ${criterion}`].join('\n'),
    },
  })) as CallToolResult;
  expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
}

test.describe('the Workbench keeps itself current while you are looking at it', () => {
  let seed: WorkbenchLiveSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedWorkbenchLive(`wl${Date.now().toString(36)}`);
  });

  test('sit still and watch it arrive, learn that what you are reading moved, and survive the lift going down', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5238');
    await servePublishedMock(page);

    const client = await openAgentSession(seed.token, baseURL!);
    const toApprove = en.workbench.tabs.toApprove;
    const rows = (p: Page) => rowsIn(p, toApprove);
    const designRow = () => rows(page).filter({ hasText: seed.designTitle });
    const secondRow = () => rows(page).filter({ hasText: seed.secondDesignTitle });
    const dialog = page.getByRole('dialog', {
      name: `${en.workbench.approvals.kind.design_result} for ${seed.designKey}`,
    });

    await chapter('Nothing is waiting, and the reviewer settles in', async () => {
      await signIn(page, seed.reviewerEmail, seed.password);
      await page.goto('/workbench?tab=approvals');
      await expect(
        page.getByRole('heading', { name: en.workbench.empty.approvals.title }),
      ).toBeVisible();
      expect(await badgeCount(page, toApprove)).toBe(0);
    });
    await beat();

    // ⚠️ FROM HERE TO THE END OF PHASE 1 NOBODY TOUCHES THE PAGE. No click, no
    // key, no `goto`, no `reload` — the only call is the agent's.
    await stampDocument(page, 'phase-1');
    await chapter(
      'Somebody else publishes a design, and the screen catches up on its own',
      async () => {
        const published = await publishDesignResult(client, seed.designKey);
        expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);

        // AUTHORITATIVE: the row's own text, rendered from the server read the
        // nudge triggered. The 60s budget is the stream's poll plus a stalled
        // runner's headroom, never a stopwatch on the feature.
        // ⚠️ THE ROW **AND** ITS CHIP IN ONE WAIT, never two. `New` marks a row
        // that arrived since the reader's PREVIOUS set, so the next re-read
        // clears it — correctly. Asserting the row first and the chip afterwards
        // would leave a window in which a second frame lands between the two and
        // fails an assertion about something that was true.
        await expect(designRow().filter({ hasText: en.workbench.approvals.live.new })).toHaveCount(
          1,
          { timeout: 60_000 },
        );
        // …and the strip agrees IN THE SAME PAGE STATE. One `Promise.all` renders
        // both, so a count and a list that disagree is a state this cannot reach.
        expect(await badgeCount(page, toApprove)).toBe(await rows(page).count());
        expect(await badgeCount(page, toApprove)).toBe(1);

        // THE CLAIM: the SAME document, at the same address, on the same tab —
        // the page caught up without ever being loaded again.
        expect(await documentStamp(page)).toBe('phase-1');
        await expect(page).toHaveURL((url) => url.search === '?tab=approvals');
        await expect(page.getByRole('link', { name: new RegExp(toApprove) })).toHaveAttribute(
          'aria-current',
          'page',
        );
      },
    );
    await beat();

    const port = dialog.getByRole('group', { name: en.approvalGate.port.label });
    let portAt: { x: number; y: number } | null = null;

    await chapter('Reading it full screen, and somebody edits what it is about', async () => {
      await openRow(designRow());
      await expect(dialog).toBeVisible();
      await expect(port).toBeVisible({ timeout: 60_000 });
      portAt = await portPosition(port);

      await stampDocument(page, 'phase-2');
      await editCriteria(client, seed.designKey, 'The row keeps its place while you read it.');

      // AUTHORITATIVE: the notice, which the SERVER's own stamp comparison
      // produced — nothing here parses a frame or guesses what moved.
      const notice = dialog
        .getByRole('status')
        .filter({ hasText: en.approvalGate.refusal.stale.noun.criteria });
      await expect(notice).toBeVisible({ timeout: 60_000 });
      await expect(notice).toContainText(en.approvalOverlay.moved.next);

      // ⚠️ THE ONE OUTCOME THE DESIGN FORBIDS OUTRIGHT: the design coming off the
      // reader's screen, or moving under them. Same element, same box.
      await expect(port).toBeVisible();
      expect(await portPosition(port)).toEqual(portAt);
      expect(await documentStamp(page)).toBe('phase-2');
    });
    await beat();

    await chapter(
      'Approving anyway is refused — the notice was the courtesy, the stamp is the guarantee',
      async () => {
        await dialog
          .getByRole('button', { name: en.approvalGate.verb.approve, exact: true })
          .click();
        await expect(dialog.getByText(en.approvalGate.confirm.title)).toBeVisible();
        await dialog
          .getByRole('button', {
            name: en.approvalGate.confirm.proceed.replace('{verb}', en.approvalGate.verb.approve),
          })
          .click();

        // AUTHORITATIVE: the refusal band the decide door RETURNED — and it names
        // the same thing the notice did, which is the property two notions of
        // "moved" could not keep.
        // ⚠️ FILTERED, NOT JUST THE ROLE: a frame can hold a second alert (state
        // `X`'s port-failed band), and an unfiltered `getByRole('alert')` would die
        // on strict mode rather than on anything this phase is about.
        const refusal = dialog
          .getByRole('alert')
          .filter({ hasText: en.approvalGate.refusal.stale.criteria });
        await expect(refusal).toBeVisible({ timeout: 60_000 });
        await expect(refusal).toContainText(en.approvalGate.refusal.stale.next);
      },
    );
    await beat();

    await chapter('Looking again, deciding, and the row settles where it was', async () => {
      // The refusal's one control — the re-read that brings the frame and its
      // stamp back TOGETHER, which is what makes the next press valid.
      await dialog
        .getByRole('button', { name: en.approvalGate.refusal.stale.control })
        .first()
        .click();
      await expect(port).toBeVisible({ timeout: 60_000 });

      await dialog.getByRole('button', { name: en.approvalGate.verb.approve, exact: true }).click();
      await expect(dialog.getByText(en.approvalGate.confirm.title)).toBeVisible();
      await dialog
        .getByRole('button', {
          name: en.approvalGate.confirm.proceed.replace('{verb}', en.approvalGate.verb.approve),
        })
        .click();
      // Drawn from the gate row the action RETURNED — the decision is recorded.
      await expect(dialog.getByText(en.approvalGate.state.approved, { exact: true })).toBeVisible({
        timeout: 60_000,
      });

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(queue(page, toApprove)).toBeVisible();

      // ⚠️ § 20's RULE, SURVIVING LIVE-NESS (§ 26): the row the reader just
      // decided STAYS where it was, carrying its own state — it does not vanish
      // from under the cursor because a re-read stopped returning it.
      await expect(designRow()).toHaveCount(1);
      await expect(designRow().getByText(en.approvalGate.state.approved)).toBeVisible();
      // …and the COUNT goes down with it, because § 20's number is about what is
      // AWAITING and a held row is a receipt, not a member.
      await expect.poll(() => badgeCount(page, toApprove), { timeout: 30_000 }).toBe(0);
    });
    await beat();

    await chapter('The connection drops, says so, and catches up when it comes back', async () => {
      await page.context().setOffline(true);
      // AUTHORITATIVE: the chip the hook renders when it starts backing off.
      await expect(reconnecting(page, en.workbench.live.reconnecting)).toBeVisible({
        timeout: 60_000,
      });
      // Nothing else is dimmed, greyed or pulsed: what is on screen is real and
      // may be a few seconds old (§ 26 Panel 2). The settled row keeps its ink.
      await expect(designRow().getByText(en.approvalGate.state.approved)).toBeVisible();

      // The world moves while the reader's connection is down — in NODE, which
      // `setOffline` does not reach.
      const second = await publishDesignResult(client, seed.secondDesignKey);
      expect(second.isError ?? false, JSON.stringify(second.content)).toBe(false);

      await stampDocument(page, 'phase-5');
      await page.context().setOffline(false);

      // It resumes FROM THE WATERMARK: neither a replay nor a gap.
      await expect(secondRow()).toHaveCount(1, { timeout: 120_000 });
      await expect(reconnecting(page, en.workbench.live.reconnecting)).toBeHidden();
      // NO DUPLICATE, and the settled row is still there — a frame adds and
      // updates; it never removes.
      await expect(designRow()).toHaveCount(1);
      await expect(rows(page)).toHaveCount(2);
      // And it came back WITHOUT A RELOAD — the same document throughout.
      expect(await documentStamp(page)).toBe('phase-5');
    });

    await client.close();
  });

  test('the reader is not disturbed — the page of the list, the scroll and the tab all survive an update nobody asked for', async ({
    page,
    baseURL,
  }) => {
    const client = await openAgentSession(seed.token, baseURL!);
    const toApprove = en.workbench.tabs.toApprove;
    const rows = (p: Page) => rowsIn(p, toApprove);

    // 26 filler gates make the list taller than the fold — what a "you were not
    // disturbed" claim needs. Nothing is ever asserted about a filler
    // individually (`approvals-tab-seed.ts` states that trade).
    //
    // ⚠️ AMENDED by MOTIR-5998 (Story MOTIR-5996), which REMOVED the tab's pager:
    // the queue is one unpaged list now, so all 26 render, and the walk's former
    // last step — "the pager's page survives an update too" — exercised a control
    // that no longer exists and was removed rather than rewritten. Every other
    // assertion in this test is unchanged.
    await plantFillerGates(seed, STORY_TITLE_EXPORT, 26);

    await signIn(page, seed.reviewerEmail, seed.password);
    await page.goto('/workbench?tab=approvals');
    await expect(rows(page)).toHaveCount(26);

    const last = rows(page).last();
    await last.scrollIntoViewIfNeeded();
    const scrolledTo = await listScroll(last);
    expect(scrolledTo).toBeGreaterThan(0);

    await stampDocument(page, 'undisturbed');
    expect((await publishDesignResult(client, seed.designKey)).isError ?? false).toBe(false);
    // AUTHORITATIVE: the badge rising is the update landing.
    await expect.poll(() => badgeCount(page, toApprove), { timeout: 60_000 }).toBe(27);

    // …and the reader is exactly where they were.
    expect(await listScroll(last)).toBe(scrolledTo);
    await expect(page).toHaveURL((url) => url.search === '?tab=approvals');
    await expect(page.getByRole('link', { name: new RegExp(toApprove) })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await documentStamp(page)).toBe('undisturbed');

    await client.close();
  });

  test('the same walk in zh — it arrives, it says what moved, and the press is refused', async ({
    page,
    baseURL,
  }) => {
    await servePublishedMock(page);
    const client = await openAgentSession(seed.token, baseURL!);
    const toApprove = zh.workbench.tabs.toApprove;
    const rows = (p: Page) => rowsIn(p, toApprove);
    const designRow = () => rows(page).filter({ hasText: seed.designTitle });

    await signIn(page, seed.reviewerEmail, seed.password);
    // The suite's own locale switch (`workbench.spec.ts`).
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: page.url() }]);
    await page.goto('/workbench?tab=approvals');
    await expect(
      page.getByRole('heading', { name: zh.workbench.empty.approvals.title }),
    ).toBeVisible();

    await stampDocument(page, 'zh');
    expect((await publishDesignResult(client, seed.designKey)).isError ?? false).toBe(false);
    await expect(designRow().filter({ hasText: zh.workbench.approvals.live.new })).toHaveCount(1, {
      timeout: 60_000,
    });
    expect(await badgeCount(page, toApprove)).toBe(1);
    expect(await documentStamp(page)).toBe('zh');
    // Negatively too: the English chip must not be reachable on a `zh` page.
    await expect(page.getByText(en.workbench.approvals.live.new)).toHaveCount(0);

    const dialog = page.getByRole('dialog', {
      name: `${seed.designKey} 的${zh.workbench.approvals.kind.design_result}`,
    });
    await openRow(designRow());
    await expect(dialog).toBeVisible();
    const port = dialog.getByRole('group', { name: zh.approvalGate.port.label });
    await expect(port).toBeVisible({ timeout: 60_000 });
    const portAt = await portPosition(port);

    await editCriteria(client, seed.designKey, '中文走查：读者的屏幕不会被挪动。');
    const notice = dialog
      .getByRole('status')
      .filter({ hasText: zh.approvalGate.refusal.stale.noun.criteria });
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await expect(notice).toContainText(zh.approvalOverlay.moved.next);
    expect(await portPosition(port)).toEqual(portAt);

    await dialog.getByRole('button', { name: zh.approvalGate.verb.approve, exact: true }).click();
    await expect(dialog.getByText(zh.approvalGate.confirm.title)).toBeVisible();
    await dialog
      .getByRole('button', {
        name: zh.approvalGate.confirm.proceed.replace('{verb}', zh.approvalGate.verb.approve),
      })
      .click();
    const refusal = dialog
      .getByRole('alert')
      .filter({ hasText: zh.approvalGate.refusal.stale.criteria });
    await expect(refusal).toBeVisible({ timeout: 60_000 });
    await expect(refusal).toContainText(zh.approvalGate.refusal.stale.next);

    // AND THE DROPPED CONNECTION, in `zh` too — the chip is the one new element.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.context().setOffline(true);
    await expect(reconnecting(page, zh.workbench.live.reconnecting)).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(en.workbench.live.reconnecting)).toHaveCount(0);
    await page.context().setOffline(false);
    await expect(reconnecting(page, zh.workbench.live.reconnecting)).toBeHidden({
      timeout: 120_000,
    });

    await client.close();
  });
});
