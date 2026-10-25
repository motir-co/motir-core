import type { APIRequestContext, Cookie, Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { developmentSection, openDevelopmentOverlay } from './_helpers/development-decide';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { headShaFor, publishReceipt } from './_helpers/acceptance-gate-seed';
import {
  ACCEPTANCE_VERDICT_TITLES,
  VERDICT_REPO,
  seedAcceptanceVerdict,
  seedFinishedStory,
  type AcceptanceVerdictSeed,
  type VerdictStory,
} from './_helpers/acceptance-verdict-seed';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import en from '@/messages/en.json';

// AN ACCEPTANCE VIDEO SENT BACK IS A VERDICT — THE ACCEPTANCE RECEIPT (Story MOTIR-6071 ·
// Subtask MOTIR-6508; `docs/decisions/acceptance-refusal-verdict.md`; design MOTIR-6500
// `approval-control--acceptance-verdict.mock.html`). It mirrors MOTIR-6429's
// `regression-design-verdict.spec.ts`.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The story's verification recipe, driven. A reviewer sends a story's acceptance video
// back, on both run shapes:
//
//   · A STORY RUN asks for a reason AND a verdict. A send without a verdict is refused in
//     place — and by the decide door itself. RE-RUN: the status does not move, the merge
//     approval is withdrawn, and the Development block offers `motir fix <story>`; nothing
//     asks to re-plan. RE-PLAN: the status does not move, the merge approval is withdrawn,
//     and the band ASKS whether to re-plan the story with Motir AI. Not now opens nothing
//     and leaves the door; the door opens the planner on the STORY with the reason written
//     in the message box, unsent.
//   · A FINISHED story (every subtask merged) offers no verdict and says why, then asks to
//     plan a remedy; yes opens the planner on the story with the remedy turn, unsent.
//
// ── WHAT IS REAL ────────────────────────────────────────────────────────────
//
// The story runs' pull requests and their green checks are SIGNED deliveries to the real
// webhook route, linked through the real link door; the receipts are rows plus the
// shipped predicate (`acceptance-gate-seed.ts` § `publishReceipt` says why), which raises
// the acceptance question and its paired merge approval. Every decision is the overlay's
// real server action; the door's own refusal is the real `POST /api/approval-gates/{id}/
// decide`. The planner's model reply is NOT exercised: every seeded turn stays unsent,
// so no AI call is made. Running `motir fix` is not exercised — only that it is offered.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's own response, the server action's response
// (armed before the press), the decided record's own elements, the re-read Development
// block, the seed read's response, the planning address and the composer's value.
// `chapter()` / `beat()` only HOLD a state already proven.
//
// ⚠️ THE 21xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 300_000 });

const PRS = { rerun: { number: 21101 }, replan: { number: 21201 } } as const;

const RERUN_REASON = 'the empty board should say how to add the first card';
const REPLAN_REASON = 'importing needs a column-mapping step before any card is made';
const REMEDY_REASON = 'the tour skips the invite step it promised';

const acc = en.approvalGate.acceptanceResult;
const r = en.approvalGate.reason;
const ask = en.approvalGate.replanAsk;
const door = en.approvalGate.replanDoor;
const seedWords = en.planningWorkspace.refusalSeed;

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Locators ─────────────────────────────────────────────────────────────────

const toApproveRow = (page: Page, key: string): Locator =>
  page
    .getByRole('table', { name: en.workbench.tabs.toApprove })
    .getByTestId(/^approval-row-/)
    .filter({ hasText: key });
/** The detail rail's Status card — the pill beside the "Edit Status" chevron. */
const statusCard = (page: Page) =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });
/** The Status card's STATUS alone — its pill, without the held notice beneath it, whose
 *  words legitimately change when the merge approval is withdrawn. */
const statusLabel = (page: Page): Promise<string> =>
  statusCard(page).evaluate((card) => {
    const copy = card.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[role="status"], button').forEach((node) => node.remove());
    return (copy.textContent ?? '').replace(/^\s*Status/, '').trim();
  });
/** The overlay's exit row — the bar holding the card's title door and its status pill. */
const exitRow = (dialog: Locator, key: string) =>
  dialog.locator(`div:has(> a[aria-haspopup="dialog"][href="/items/${key}"])`);
const verdictGroup = (scope: Locator) => scope.getByTestId('refusal-verdict-group');
/** Pick a verdict the way a reader does — by pressing its TILE (the radio is `sr-only`). */
async function pickVerdict(scope: Locator, verdict: 'revise' | 're_plan'): Promise<void> {
  await verdictGroup(scope).locator(`label[data-verdict="${verdict}"]`).click();
  await expect(verdictGroup(scope).locator(`input[value="${verdict}"]`)).toBeChecked();
}
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

async function gateOf(
  storyId: string,
  kind: 'acceptance_result' | 'pull_request_approval',
): Promise<{ id: string; state: string }> {
  return adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId: storyId, kind },
    orderBy: { createdAt: 'desc' },
    select: { id: true, state: true },
  });
}

// ── The GitHub side of a story run ──────────────────────────────────────────

/** Open the story's pull request, LINK it, and turn it green — as the signed-in owner,
 *  through the real webhook route and link door. */
async function deliverGreen(
  api: APIRequestContext,
  card: VerdictStory['story'],
  number: number,
): Promise<void> {
  const headRef = `story/${card.identifier.toLowerCase()}-${number}`;
  const opened = await postSignedWebhook(
    api,
    'pull_request',
    pullRequestPayload({
      action: 'opened',
      number,
      title: card.title,
      headRef,
      state: 'open',
      merged: false,
      repo: VERDICT_REPO,
    }),
  );
  expect(opened.status()).toBe(200);
  const linked = await api.post('/api/_test/pull-request-links', {
    data: {
      workItemId: card.id,
      owner: VERDICT_REPO.owner,
      name: VERDICT_REPO.name,
      number,
      headRef,
      baseRef: VERDICT_REPO.defaultBranch,
      title: null,
    },
  });
  expect(linked.status(), (await linked.text()).slice(0, 300)).toBe(201);
  const green = await postSignedWebhook(
    api,
    'check_suite',
    checkSuitePayload({
      conclusion: 'success',
      headSha: headShaFor(number),
      prNumber: number,
      headBranch: headRef,
      repo: VERDICT_REPO,
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

test.describe('an acceptance video sent back is a verdict', () => {
  let seed: AcceptanceVerdictSeed;
  let finished: VerdictStory;
  let session: Cookie[];

  // Everything the database holds is written BEFORE the page exists, so the recording
  // starts on the product rather than on a blank page while rows are inserted.
  //
  // ⚠️ `beforeAll`, not `beforeEach`: the harness's AUTO fixtures (`contention`,
  // `clientDiagnostics`) take `page`, so a test's page — and its video — exists before any
  // `beforeEach` runs, and a seed there is ~30 s of white at the head of the clip that the
  // chapter markers (timed from the test body) do not account for. The describe holds ONE
  // test and the lane never retries, so a worker-scoped seed is the same seed.
  test.beforeAll(async ({ playwright }, workerInfo) => {
    const baseURL = workerInfo.project.use.baseURL;
    await resetDatabase();
    seed = await seedAcceptanceVerdict(`av${Date.now().toString(36)}`);

    // The owner signs in and the runs' pull requests arrive OFF CAMERA, in an API
    // context: the recording opens on the product, and the page borrows the session.
    const api = await playwright.request.newContext({
      baseURL: baseURL!,
      extraHTTPHeaders: { origin: baseURL! },
    });
    const signedIn = await api.post('/api/auth/sign-in/email', {
      data: { email: seed.ownerEmail, password: seed.password },
    });
    expect(signedIn.status(), (await signedIn.text()).slice(0, 300)).toBe(200);
    for (const [cards, pr] of [
      [seed.rerun, PRS.rerun],
      [seed.replan, PRS.replan],
    ] as const) {
      await deliverGreen(api, cards.story, pr.number);
      // The run's own order: the set is green, THEN the recording is published — so the
      // publish finds both questions owed, the video and the merge approval beside it.
      await publishReceipt({
        workspaceId: seed.workspaceId,
        uploaderUserId: seed.ownerUserId,
        story: cards.story,
        producedByKey: cards.e2e.identifier,
        commitSha: headShaFor(pr.number),
      });
      for (const kind of ['acceptance_result', 'pull_request_approval'] as const) {
        expect(
          (await gateOf(cards.story.id, kind)).state,
          `${cards.story.identifier} ${kind}`,
        ).toBe('awaiting');
      }
    }
    finished = await seedFinishedStory(seed);
    session = (await api.storageState()).cookies;
    await api.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await page.context().addCookies(session);
    await stubAiAccess(page);
  });

  test('a story run sent back is a Re-run (motir fix) or a Re-plan (asked); a finished story asks for a remedy — no status moves', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6071');
    const rerunKey = seed.rerun.story.identifier;
    const replanKey = seed.replan.story.identifier;
    const finishedKey = finished.story.identifier;
    const rerunMerge = await gateOf(seed.rerun.story.id, 'pull_request_approval');
    const rerunAcceptance = await gateOf(seed.rerun.story.id, 'acceptance_result');
    const rerunDialog = page.getByRole('dialog');
    let rerunStatus = '';

    await chapter('The story run’s video waits on To approve', async () => {
      await page.goto('/workbench?tab=approvals');
      await expect(toApproveRow(page, rerunKey)).toHaveCount(1, { timeout: FIRST_PAINT_MS });
      await expect(toApproveRow(page, replanKey)).toHaveCount(1);
      await expect(toApproveRow(page, finishedKey)).toHaveCount(1);
      await beat();
    });

    await chapter('Request changes asks why — and Re-run or Re-plan', async () => {
      await toApproveRow(page, rerunKey)
        .getByRole('button', { name: en.workbench.approvals.review, exact: true })
        .click();
      await expect(rerunDialog).toBeVisible({ timeout: FIRST_PAINT_MS });
      const pill = exitRow(rerunDialog, rerunKey);
      await expect(pill).toContainText('In Review');
      rerunStatus = ((await pill.textContent()) ?? '').trim();

      await rerunDialog
        .getByRole('button', { name: en.approvalGate.verb.requestChanges, exact: true })
        .click();
      await expect(rerunDialog.getByRole('radiogroup', { name: acc.verdict.legend })).toBeVisible();
      await rerunDialog.getByLabel(r.label).pressSequentially(RERUN_REASON, { delay: 20 });

      // Sent with a reason and NO verdict: refused in place, and nothing is recorded.
      await rerunDialog.getByRole('button', { name: r.proceed, exact: true }).click();
      await expect(verdictGroup(rerunDialog)).toHaveAttribute('aria-invalid', 'true');
      const refusedInPlace = rerunDialog.getByRole('alert').filter({
        hasText: acc.verdict.required,
      });
      await expect(refusedInPlace).toBeVisible();
      await refusedInPlace.scrollIntoViewIfNeeded();
      await expect(rerunDialog.getByTestId('refusal-verdict')).toHaveCount(0);
      expect((await gateOf(seed.rerun.story.id, 'acceptance_result')).state).toBe('awaiting');

      // …and the decide door refuses the same send on its own, typed (§10d): a story run's
      // acceptance sent back needs a verdict whoever calls it.
      const read = await approvalGatesService.getForWorkItem(
        { workItemId: seed.rerun.story.id, kind: 'acceptance_result' },
        { userId: seed.ownerUserId, workspaceId: seed.workspaceId },
      );
      const forced = await page.request.post(
        `/api/approval-gates/${encodeURIComponent(rerunAcceptance.id)}/decide`,
        {
          headers: { origin: baseURL! },
          data: { decision: 'request_changes', noteMd: RERUN_REASON, stamp: read.stamp },
        },
      );
      expect(forced.status(), (await forced.text()).slice(0, 300)).toBe(400);
      expect(await forced.json()).toMatchObject({ reason: 'refusal_verdict_required' });
      expect((await gateOf(seed.rerun.story.id, 'acceptance_result')).state).toBe('awaiting');
      await beat();
    });

    await chapter(
      'Re-run: nothing moves, the merge approval goes, and motir fix is offered',
      async () => {
        await pickVerdict(rerunDialog, 'revise');
        await expect(verdictGroup(rerunDialog)).not.toHaveAttribute('aria-invalid', 'true');
        const action = serverAction(page);
        await rerunDialog.getByRole('button', { name: r.proceed, exact: true }).click();
        expect((await action).status()).toBe(200);

        // The record quotes the reason with the verdict.
        await expect(rerunDialog.getByTestId('refusal-verdict')).toHaveText(r.record.verdict.rerun);
        await expect(rerunDialog.getByText(`“${RERUN_REASON}”`).first()).toBeVisible();
        // The Development block, re-read: `motir fix` offered on the sent-back class, and no
        // merge press left.
        const fix = rerunDialog.getByTestId('repair-fix-part');
        await expect(fix).toHaveAttribute('data-state', 'offer');
        await fix.scrollIntoViewIfNeeded();
        await expect(fix.getByTestId('repair-sent-back-line')).toBeVisible();
        await expect(fix.getByText(`motir fix ${rerunKey}`)).toBeVisible();
        await expect(
          rerunDialog.getByRole('button', {
            name: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
          }),
        ).toHaveCount(0);
        // Nothing asks to re-plan, and the status is the one it was.
        await expect(rerunDialog.getByTestId('refusal-replan-ask')).toHaveCount(0);
        await expect(exitRow(rerunDialog, rerunKey)).toHaveText(rerunStatus);
        await beat();

        // The merge approval is withdrawn: its row is gone from To approve, and the story's
        // one row is the decided acceptance — no Review left on it.
        await page.keyboard.press('Escape');
        await expect(rerunDialog).toHaveCount(0);
        await expect(page.getByTestId(`approval-row-${rerunMerge.id}`)).toHaveCount(0);
        await expect(toApproveRow(page, rerunKey)).toHaveCount(1);
        await expect(
          toApproveRow(page, rerunKey).getByText(en.approvalGate.state.changesRequested, {
            exact: true,
          }),
        ).toBeVisible();
        expect((await gateOf(seed.rerun.story.id, 'pull_request_approval')).state).toBe(
          'superseded',
        );
      },
    );

    const replanGate = await gateOf(seed.replan.story.id, 'acceptance_result');
    let replanStatus = '';

    await chapter(
      'Re-plan: nothing moves, the merge approval goes, and the band ASKS',
      async () => {
        await page.goto(`/items/${replanKey}`);
        await expect(
          page.getByRole('heading', { name: ACCEPTANCE_VERDICT_TITLES.replan }),
        ).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(statusCard(page)).toContainText('In Review');
        replanStatus = await statusLabel(page);
        const dialog = await openDevelopmentOverlay(page);
        await dialog
          .getByRole('button', { name: en.approvalGate.verb.requestChanges, exact: true })
          .click();
        await dialog.getByLabel(r.label).pressSequentially(REPLAN_REASON, { delay: 20 });
        await pickVerdict(dialog, 're_plan');
        await expect(dialog.getByText(acc.verdict.replan.consequence)).toBeVisible();
        const action = serverAction(page);
        await dialog.getByRole('button', { name: r.proceed, exact: true }).click();
        expect((await action).status()).toBe(200);

        await expect(dialog.getByTestId('refusal-verdict')).toHaveText(r.record.verdict.replan);
        const band = dialog.getByTestId('refusal-replan-ask');
        await expect(band).toHaveAttribute('data-mode', 'replan');
        await band.scrollIntoViewIfNeeded();
        await expect(band).toContainText(fill(ask.title, { key: replanKey }));
        // Nothing opened, no `motir fix`, no merge press — and the status is unchanged.
        await expect(rail(page)).toHaveCount(0);
        await expect(dialog.getByTestId('repair-fix-part')).toHaveCount(0);
        await expect(
          dialog.getByRole('button', {
            name: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
          }),
        ).toHaveCount(0);
        await expect(exitRow(dialog, replanKey)).toContainText('In Review');
        expect((await gateOf(seed.replan.story.id, 'pull_request_approval')).state).toBe(
          'superseded',
        );
        await beat();
      },
    );

    await chapter('Not now opens nothing and leaves the Re-plan with AI door', async () => {
      const dialog = page.getByRole('dialog');
      await dialog
        .getByTestId('refusal-replan-ask')
        .getByRole('button', { name: en.planningWorkspace.handoff.notNow, exact: true })
        .click();
      await expect(dialog.getByTestId('refusal-replan-ask')).toHaveCount(0);
      await expect(rail(page)).toHaveCount(0);
      expect(new URL(page.url()).searchParams.has('plan')).toBe(false);
      const entry = dialog.getByTestId('refusal-replan-door');
      await expect(entry).toHaveAttribute('data-mode', 'replan');
      await expect(entry).toHaveText(door.label);
      await entry.scrollIntoViewIfNeeded();

      // The item page, read again: the same status, the record's door, and no merge press.
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await page.reload();
      await expect(statusCard(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect.poll(() => statusLabel(page)).toBe(replanStatus);
      const section = developmentSection(page);
      await expect(section.getByText(`“${REPLAN_REASON}”`).first()).toBeVisible();
      await expect(replanDoor(section, replanKey)).toBeVisible();
      await expect(
        section.getByRole('button', {
          name: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
        }),
      ).toHaveCount(0);
      await beat();
    });

    await chapter(
      'The door opens the planner on the STORY — the reason written, unsent',
      async () => {
        const read = seedRead(page, replanGate.id);
        await replanDoor(developmentSection(page), replanKey).click();
        await page.waitForURL(plannerOpenFrom(replanGate.id));
        const seedRes = await read;
        expect(seedRes.status()).toBe(200);
        expect(((await seedRes.json()) as { seed: { anchorKey: string } }).seed.anchorKey).toBe(
          replanKey,
        );
        await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(composer(page)).toHaveValue(
          new RegExp(
            [
              escapeRe(`“${REPLAN_REASON}”`),
              escapeRe(fill(seedWords.askAcceptanceReplan, { key: replanKey })),
            ].join('[\\s\\S]*'),
          ),
        );
        await expect(composer(page)).toHaveValue(
          new RegExp(escapeRe(seedWords.verb.acceptanceReplan)),
        );
        // Nothing was sent: the transcript holds no turn and none of the reason.
        await expect(transcript(page).getByTestId(USER_TURN)).toHaveCount(0);
        await expect(transcript(page).getByText(REPLAN_REASON)).toHaveCount(0);
        await beat();
      },
    );

    const finishedGate = await gateOf(finished.story.id, 'acceptance_result');

    await chapter('A finished story: nothing to re-run, so it asks for a remedy', async () => {
      await page.goto('/workbench?tab=approvals');
      await toApproveRow(page, finishedKey)
        .getByRole('button', { name: en.workbench.approvals.review, exact: true })
        .click({ timeout: FIRST_PAINT_MS });
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible({ timeout: FIRST_PAINT_MS });
      const pill = exitRow(dialog, finishedKey);
      await expect(pill).toBeVisible();
      const status = ((await pill.textContent()) ?? '').trim();
      await dialog
        .getByRole('button', { name: en.approvalGate.verb.requestChanges, exact: true })
        .click();
      // No Re-run or Re-plan — and the one line that says why.
      await expect(dialog.getByTestId('refusal-no-rerun')).toHaveText(acc.refusal.noRerun);
      await dialog.getByTestId('refusal-no-rerun').scrollIntoViewIfNeeded();
      await expect(verdictGroup(dialog)).toHaveCount(0);
      await dialog.getByLabel(r.label).pressSequentially(REMEDY_REASON, { delay: 20 });
      const action = serverAction(page);
      await dialog.getByRole('button', { name: r.proceed, exact: true }).click();
      expect((await action).status()).toBe(200);

      await expect(dialog.getByTestId('refusal-verdict')).toHaveText(r.record.verdict.remedy);
      const band = dialog.getByTestId('refusal-replan-ask');
      await expect(band).toHaveAttribute('data-mode', 'remedy');
      await band.scrollIntoViewIfNeeded();
      await expect(band).toContainText(fill(acc.remedyAsk.title, { key: finishedKey }));
      await expect(rail(page)).toHaveCount(0);
      await expect(exitRow(dialog, finishedKey)).toHaveText(status);
      await beat();
    });

    await chapter('Yes opens the planner on the story with the remedy turn, unsent', async () => {
      const dialog = page.getByRole('dialog');
      const read = seedRead(page, finishedGate.id);
      await dialog
        .getByTestId('refusal-replan-ask')
        .getByRole('button', { name: acc.remedyAsk.yes, exact: true })
        .click();
      await page.waitForURL(plannerOpenFrom(finishedGate.id));
      const seedRes = await read;
      expect(seedRes.status()).toBe(200);
      expect(((await seedRes.json()) as { seed: { anchorKey: string } }).seed.anchorKey).toBe(
        finishedKey,
      );
      await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(composer(page)).toHaveValue(
        new RegExp(
          [
            escapeRe(`“${REMEDY_REASON}”`),
            escapeRe(fill(seedWords.askAcceptanceRemedy, { key: finishedKey })),
          ].join('[\\s\\S]*'),
        ),
      );
      await expect(transcript(page).getByTestId(USER_TURN)).toHaveCount(0);
      await expect(transcript(page).getByText(REMEDY_REASON)).toHaveCount(0);
      await beat();
    });
  });
});
