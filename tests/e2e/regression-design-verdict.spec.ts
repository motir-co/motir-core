import type { Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  openAgentSession,
  publishDesignResult,
  servePublishedMock,
} from './_helpers/design-approval-seed';
import {
  seedDesignVerdict,
  VERDICT_TITLES,
  type DesignVerdictSeed,
} from './_helpers/design-verdict-seed';
import { adminDb } from '@/tests/helpers/adminDb';
import en from '@/messages/en.json';

// A DESIGN SENT BACK IS A VERDICT — THE ACCEPTANCE RECEIPT (Story MOTIR-6070 · Subtask
// MOTIR-6429; `docs/decisions/design-refusal-verdict.md`; design MOTIR-6420
// `approval-control--design-verdict.mock.html`).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The story's `## Verification`, driven. A reviewer sends a design back and says what the
// "no" means. REVISE: the card is back at To do, its record quotes the reason with the
// verdict, nothing asks to re-plan — and the next run's prompt carries the reason under
// CHANGES REQUESTED. RE-PLAN: the card is back at To do too, and the band ASKS whether to
// re-plan the STORY with Motir AI. Not now opens nothing and leaves a Re-plan with AI
// door on the record; the door opens the planner on the story with the reason and both
// waiting cards written in the message box, unsent. Closing it leaves the item page
// where it was. Around the walk: a design with no result offers no Request changes, and
// a decide call that fails shows the band's error and moves nothing.
//
// ── WHAT IS REAL ────────────────────────────────────────────────────────────
//
// Both results are published by the REAL `publish_design_result` tool over `/api/mcp`
// (that is what raises each gate). The decisions are the overlay's real server action;
// the prompt is the real `GET /api/v1/work-items/{key}/dispatch-prompt` read with the
// run's own grant (`CLI_TOKEN_GRANT`) — the observable seam of verification step 2, since
// no agent run is driven. The one stub is the mock's bytes at the content route
// (`servePublishedMock` says why), plus ONE injected 500 on a decide call for the error
// state.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: the server action's response (armed before the press),
// the decided record's own elements, the seed read's response, the planning address and
// the composer's value. `chapter()` / `beat()` only HOLD a state already proven.

test.describe.configure({ timeout: 300_000 });

const r = en.approvalGate.reason;
const ask = en.approvalGate.replanAsk;
const door = en.approvalGate.replanDoor;

const REVISE_REASON = 'the empty state needs the illustration, not text';
const REPLAN_REASON = 'this layout changes the two list cards after it';

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Locators ─────────────────────────────────────────────────────────────────

const main = (page: Page) => page.getByRole('main');
const designSection = (page: Page) =>
  main(page)
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: en.designResult.title }) });
/** The detail rail's Status card — the pill beside the "Edit Status" chevron. */
const statusCard = (page: Page) =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });
const dialogFor = (page: Page, key: string) =>
  page.getByRole('dialog', { name: `${en.workbench.approvals.kind.design_result} for ${key}` });
const verdicts = (scope: Locator) => scope.getByRole('radiogroup', { name: r.verdict.legend });
const verdictRadio = (scope: Locator, label: string) =>
  verdicts(scope).getByRole('radio', { name: new RegExp(`^${escapeRe(label)}`) });
/** Pick a verdict the way a reader does — by pressing its TILE. The radio itself is
 *  `sr-only` inside the tile's `<label>`, which is what receives the pointer. */
async function pickVerdict(scope: Locator, verdict: 'revise' | 're_plan'): Promise<void> {
  const label = verdict === 'revise' ? r.verdict.revise.label : r.verdict.replan.label;
  await verdicts(scope).locator(`label[data-verdict="${verdict}"]`).click();
  await expect(verdictRadio(scope, label)).toBeChecked();
}
const askBand = (scope: Locator, key: string) =>
  scope.getByRole('group', { name: fill(ask.title, { key }), exact: true });
const replanDoor = (scope: Locator, key: string) =>
  scope.getByRole('link', { name: fill(door.aria, { item: key }), exact: true });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const transcript = (page: Page) => rail(page).getByRole('log');
// A user turn on the thread. The bubble carries no label (MOTIR-7497), so the
// turn is found by its own test id rather than a `turn 1` caption.
const USER_TURN = 'conversation-user-turn';

// ── Signals ──────────────────────────────────────────────────────────────────

/** Arm a wait for the next server action's response — a POST carrying `Next-Action`. */
const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

/** Arm a wait for the refusal seed read of ONE gate. */
const seedRead = (page: Page, gateId: string): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname ===
        `/api/approval-gates/${encodeURIComponent(gateId)}/planning-seed` &&
      res.request().method() === 'GET',
  );

const plannerOpenFrom = (gateId: string) => (url: URL) =>
  url.searchParams.get('planFrom') === 'refused-gate' &&
  url.searchParams.get('planGate') === gateId;

async function designGateId(identifier: string): Promise<string> {
  const item = await adminDb.workItem.findFirstOrThrow({
    where: { identifier },
    select: { id: true },
  });
  const gate = await adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId: item.id, kind: 'design_result' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return gate.id;
}

/** Open the card, check it is In Review with its question open, and open the overlay from
 *  the Design result section's one door (the status control carries a second of the same
 *  name, so the door is scoped to the section). */
async function openDesignApproval(page: Page, key: string, title: string): Promise<Locator> {
  await page.goto(`/items/${key}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(statusCard(page).getByText('In Review', { exact: true })).toBeVisible();
  await designSection(page)
    .getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove, exact: true })
    .click();
  const dialog = dialogFor(page, key);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('group', { name: en.approvalGate.port.label })).toBeVisible();
  return dialog;
}

test.describe('a design sent back is a verdict', () => {
  let seed: DesignVerdictSeed;

  test.beforeEach(async ({ baseURL }) => {
    await resetDatabase();
    seed = await seedDesignVerdict(`dv${Date.now().toString(36)}`);
    // The agent publishes both designs OFF CAMERA — publishing is what raises each gate.
    const client = await openAgentSession(seed.token, baseURL!);
    for (const key of [seed.reviseKey, seed.replanKey]) {
      const published = await publishDesignResult(client, key);
      expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
    }
    await client.close();
  });

  // The decided record mounts a fresh sandboxed mock frame at the end of the walk, and
  // `servePublishedMock`'s `route.fetch` for it can outlive the page — a harness race
  // (`approval-gate-repaint.spec.ts` records it). Unrouting asserts and waits on nothing.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('Revise sends a design to To do with its reason for the next run; Re-plan asks, then opens the seeded planner on the story', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6070');
    await servePublishedMock(page);
    await signIn(page, seed.reviewerEmail, seed.password);

    await chapter('A design with nothing published offers nothing to send back', async () => {
      await page.goto(`/items/${seed.emptyKey}`);
      await expect(page.getByRole('heading', { name: VERDICT_TITLES.empty })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(designSection(page).getByText(en.designResult.empty.title)).toBeVisible();
      await expect(
        main(page).getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: en.approvalGate.verb.requestChanges }),
      ).toHaveCount(0);
      await beat();
    });

    const reviseDialog = dialogFor(page, seed.reviseKey);

    await chapter('Request changes asks for a reason AND a verdict', async () => {
      await openDesignApproval(page, seed.reviseKey, VERDICT_TITLES.revise);
      await reviseDialog
        .getByRole('button', { name: en.approvalGate.verb.requestChanges, exact: true })
        .click();
      await expect(verdicts(reviseDialog)).toBeVisible();

      // Sent EMPTY: refused in place — the reason and the verdict both asked for.
      await reviseDialog.getByRole('button', { name: r.proceed, exact: true }).click();
      await expect(reviseDialog.getByText(r.required)).toBeVisible();
      await expect(reviseDialog.getByText(r.verdict.required)).toBeVisible();
      await beat();

      // A reason, still no verdict: refused in place, and the card has not moved.
      await reviseDialog.getByLabel(r.label).pressSequentially(REVISE_REASON, { delay: 20 });
      await reviseDialog.getByRole('button', { name: r.proceed, exact: true }).click();
      await expect(reviseDialog.getByText(r.verdict.required)).toBeVisible();
      await expect(reviseDialog.getByText(r.required)).toHaveCount(0);
      await expect(
        reviseDialog.getByText(en.approvalGate.state.awaitingYou, { exact: true }),
      ).toBeVisible();
      await beat();
    });

    await chapter('A send that fails shows the error and moves nothing', async () => {
      await pickVerdict(reviseDialog, 'revise');
      await expect(
        reviseDialog.getByText(
          fill(r.verdict.revise.consequence, { key: seed.reviseKey, status: 'To Do' }),
        ),
      ).toBeVisible();
      let failed = false;
      await page.route(`**/items/${seed.reviseKey}**`, async (route) => {
        const req = route.request();
        if (!failed && req.method() === 'POST' && req.headers()['next-action']) {
          failed = true;
          await route.fulfill({ status: 500, body: 'injected failure' });
          return;
        }
        await route.fallback();
      });
      const action = serverAction(page);
      await reviseDialog.getByRole('button', { name: r.proceed, exact: true }).click();
      expect((await action).status()).toBe(500);
      await expect(reviseDialog.getByText(en.approvalGate.refusal.unexpected.title)).toBeVisible();
      await page.unroute(`**/items/${seed.reviseKey}**`);
      // Nothing moved: the card still reads In Review, and nothing was recorded.
      await expect(reviseDialog.getByText('In Review', { exact: true })).toBeVisible();
      await expect(reviseDialog.getByTestId('refusal-verdict')).toHaveCount(0);
      expect(
        (
          await adminDb.approvalGate.findUniqueOrThrow({
            where: { id: await designGateId(seed.reviseKey) },
            select: { state: true },
          })
        ).state,
      ).toBe('awaiting');
      await beat();
    });

    await chapter('Revise: the card goes back to To do, and nothing asks to re-plan', async () => {
      await reviseDialog
        .getByRole('button', { name: en.approvalGate.verb.requestChanges, exact: true })
        .click();
      await expect(reviseDialog.getByLabel(r.label)).toHaveValue(REVISE_REASON);
      await pickVerdict(reviseDialog, 'revise');
      const action = serverAction(page);
      await reviseDialog.getByRole('button', { name: r.proceed, exact: true }).click();
      expect((await action).status()).toBe(200);

      await expect(
        reviseDialog.getByText(en.approvalGate.state.changesRequested, { exact: true }),
      ).toBeVisible();
      await expect(reviseDialog.getByText(`“${REVISE_REASON}”`)).toBeVisible();
      await expect(reviseDialog.getByTestId('refusal-verdict')).toHaveText(r.record.verdict.revise);
      await expect(reviseDialog.getByText('To Do', { exact: true })).toBeVisible();
      // No ask, and no door: a Revise is answered by the next run, not the planner.
      await expect(askBand(reviseDialog, seed.storyKey)).toHaveCount(0);
      await expect(replanDoor(reviseDialog, seed.storyKey)).toHaveCount(0);
      await expect(rail(page)).toHaveCount(0);
      await beat();

      await page.keyboard.press('Escape');
      await expect(reviseDialog).toBeHidden();
      await expect(statusCard(page).getByText('To Do', { exact: true })).toBeVisible();
      await expect(designSection(page).getByText(`“${REVISE_REASON}”`)).toBeVisible();
      await expect(replanDoor(main(page), seed.storyKey)).toHaveCount(0);
      await beat();
    });

    await chapter('The next run is handed the reason — CHANGES REQUESTED', async () => {
      const res = await page.request.get(`/api/v1/work-items/${seed.reviseKey}/dispatch-prompt`, {
        headers: { Authorization: `Bearer ${seed.token}` },
      });
      expect(res.status()).toBe(200);
      const prompt = ((await res.json()) as { prompt: string }).prompt;
      const banner = 'CHANGES REQUESTED — the last attempt was sent back, and why';
      expect(prompt).toContain(banner);
      const section = prompt.slice(prompt.indexOf(banner));
      expect(section).toContain(`${seed.reviseKey} — its design_result gate was refused`);
      expect(section).toContain('by Robin Vale');
      expect(section).toContain('verdict: Revise');
      expect(section).toContain(REVISE_REASON);

      // Show the section the agent receives, so the receipt shows it too.
      await page.setContent(
        `<pre style="font:15px/1.5 ui-monospace,monospace;white-space:pre-wrap;padding:32px">${section
          .slice(0, 1400)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')}</pre>`,
      );
      // Scoped to the one block `setContent` just rendered (MOTIR-5037's page-rooted rule).
      await expect(page.locator('pre').getByText(banner)).toBeVisible();
      await beat();
    });

    const replanDialog = dialogFor(page, seed.replanKey);
    const replanGateId = await designGateId(seed.replanKey);

    await chapter('Re-plan: the card goes back to To do, and the band ASKS', async () => {
      await openDesignApproval(page, seed.replanKey, VERDICT_TITLES.replan);
      await replanDialog
        .getByRole('button', { name: en.approvalGate.verb.requestChanges, exact: true })
        .click();
      await replanDialog.getByLabel(r.label).pressSequentially(REPLAN_REASON, { delay: 20 });
      await pickVerdict(replanDialog, 're_plan');
      await expect(
        replanDialog.getByText(
          fill(r.verdict.replan.consequence, {
            key: seed.replanKey,
            status: 'To Do',
            parent: seed.storyKey,
          }),
        ),
      ).toBeVisible();
      const action = serverAction(page);
      await replanDialog.getByRole('button', { name: r.proceed, exact: true }).click();
      expect((await action).status()).toBe(200);

      await expect(replanDialog.getByTestId('refusal-verdict')).toHaveText(r.record.verdict.replan);
      await expect(replanDialog.getByText('To Do', { exact: true })).toBeVisible();
      // THE ASK names the STORY — and nothing has opened.
      const band = askBand(replanDialog, seed.storyKey);
      await expect(band).toBeVisible();
      await expect(band.getByText(fill(ask.opens, { key: seed.storyKey }))).toBeVisible();
      await expect(rail(page)).toHaveCount(0);
      expect(new URL(page.url()).searchParams.has('plan')).toBe(false);
      await beat();
    });

    await chapter('Not now opens nothing, and leaves the Re-plan with AI door', async () => {
      await askBand(replanDialog, seed.storyKey)
        .getByRole('button', { name: en.planningWorkspace.handoff.notNow, exact: true })
        .click();
      await expect(askBand(replanDialog, seed.storyKey)).toHaveCount(0);
      await expect(replanDialog).toBeVisible();
      await expect(rail(page)).toHaveCount(0);
      expect(new URL(page.url()).searchParams.has('plan')).toBe(false);
      await expect(replanDoor(replanDialog, seed.storyKey)).toHaveText(door.label);
      await beat();

      // The item page's own record carries the same door once the overlay is closed.
      await page.keyboard.press('Escape');
      await expect(replanDialog).toBeHidden();
      await expect(statusCard(page).getByText('To Do', { exact: true })).toBeVisible();
      await expect(designSection(page).getByText(`“${REPLAN_REASON}”`)).toBeVisible();
      await expect(replanDoor(designSection(page), seed.storyKey)).toBeVisible();
      await beat();
    });

    await chapter(
      'The door opens the planner on the story — the reason and both waiting cards, unsent',
      async () => {
        const read = seedRead(page, replanGateId);
        await replanDoor(designSection(page), seed.storyKey).click();
        await page.waitForURL(plannerOpenFrom(replanGateId));
        const seedRes = await read;
        expect(seedRes.status()).toBe(200);
        // The seed anchors on the design card's PARENT — the story (§10h).
        const body = (await seedRes.json()) as { seed: { anchorKey: string } };
        expect(body.seed.anchorKey).toBe(seed.storyKey);

        await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(composer(page)).toHaveValue(
          new RegExp(
            [
              escapeRe(seed.replanKey),
              `“${escapeRe(REPLAN_REASON)}”`,
              escapeRe(seed.waitingKeys[0]),
              escapeRe(seed.waitingKeys[1]),
              escapeRe(seed.storyKey),
            ].join('[\\s\\S]*'),
          ),
        );
        // Nothing was sent: the transcript holds no turn and none of the reason.
        await expect(transcript(page).getByTestId(USER_TURN)).toHaveCount(0);
        await expect(transcript(page).getByText(REPLAN_REASON)).toHaveCount(0);
        await beat();
      },
    );

    await chapter('Close it — the item page is where it was', async () => {
      await page.keyboard.press('Escape');
      await page.waitForURL((url) => !url.searchParams.has('plan'));
      await expect(rail(page)).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe(`/items/${seed.replanKey}`);
      await expect(page.getByRole('heading', { name: VERDICT_TITLES.replan })).toBeVisible();
      await expect(statusCard(page).getByText('To Do', { exact: true })).toBeVisible();
      await expect(replanDoor(designSection(page), seed.storyKey)).toBeVisible();
      await beat();
    });
  });
});
