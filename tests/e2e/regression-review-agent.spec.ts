import { writeFileSync } from 'node:fs';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { closeRun, ingestContext } from './_helpers/agent-run-seed';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { linkPr } from './_helpers/pr-link';
import { headShaFor } from './_helpers/approve-and-merge-seed';
import { closeOverlay, developmentSection } from './_helpers/development-decide';
import {
  readFakeContainers,
  resetHostedRunJournal,
  writeHostedRunFixture,
} from './_helpers/hosted-run-boundary';
import type { ContinueHostedSeed } from './_helpers/continue-hosted-seed';
import { seedSentBackCard } from './_helpers/fix-hosted-seed';
import {
  REVIEW_REPO,
  seedDeliveringCard,
  seedReviewAgent,
  type ReviewAgentCard,
} from './_helpers/review-agent-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// THE REVIEW AGENT — THE STORY'S ACCEPTANCE RECEIPT (Story MOTIR-1626 · Subtask MOTIR-6827;
// ADR `approval-gates.md` §12 incl. §12.2a, `hosted-agent-run.md` §8; designs
// `design/projects/approvals--review-agent.mock.html`,
// `design/github/approve-and-merge--agent-review.mock.html`,
// `design/workbench/workbench--to-fix--review-agent.mock.html`).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// An admin switches the Review agent on in Settings → Approvals. A card's pull request goes
// green, and instead of a question on To approve the card reads *Reviewing*. The review
// passes: *Reviewed by the review agent · Passed* sits above the approve-and-merge gate, and
// Approve and merge takes the card to Done. A second card is SENT BACK: it is on the
// Workbench's To fix tab naming the review agent, with `motir fix <KEY>` and *Fix on the
// hosted agent*, and the card's banner says the same; a push and a new green head read
// *Reviewing* again. A third card's review COULD NOT RUN — the organisation is out of
// credits — and a person continues without it, with a reason, in the approval overlay: the
// record names them and the ordinary approve gate appears. While the agent is on, *Merge
// automatically* is disabled; switched off it is selectable, and a green card goes straight
// to the approve gate. Then the switch, the frame and the To fix row in Chinese.
//
// ── THE FAKES — AND ONLY THESE (the card's "fakes only at the container, credit and GitHub
//    edges") ─────────────────────────────────────────────────────────────────
//
//   * THE REVIEW RUN'S CONTAINER — the fake orchestrator (`MOTIR_FLEET_ORCHESTRATOR=fake`).
//     The REAL `agent-review/requested` job, run by the lane's job worker, starts the review
//     run; the spec then PLAYS the container: it reads the run's own `MOTIR_RUN_TOKEN` from
//     the fake orchestrator's record and posts the ONE verdict through the real
//     `POST /api/v1/work-items/{key}/agent-review`, then closes the run as the CLI does.
//   * CREDITS, MODELS AND THE REPOSITORY READ — `lib/test-hosted-run-mock.ts`'s fixture. The
//     could-not-run case is `mayRun: false`: the real pre-flight refuses, and the job
//     records the refusal's own code on the gate.
//   * GITHUB — signed deliveries to the real `/api/github/webhook` route (open, green, push,
//     merged) and the merge intercept (`E2E_TEST_GITHUB_MERGE`, `lib/test-github-merge-mock.ts`).
//   * The zh chapter's sent-back card is SEEDED (`fix-hosted-seed.ts`, MOTIR-6930's): the
//     English walk already raised one for real; the Chinese one only has to be read.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's own response, the fake orchestrator's record
// of the boot, the verdict's own 200 and body, the switch's PATCH response, the decision's
// server-action response, a committed read of the gate. No timed wait anywhere; the holds
// are `chapter()` / `beat()`'s, taken after the assertion.
//
// ⚠️ THE 25xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 300_000 });

const DEFAULT_MODEL = 'e2e-hosted-default';
const PRS = {
  passed: { number: 25101 },
  sentBack: { number: 25201 },
  couldNotRun: { number: 25301 },
  switchedOff: { number: 25401 },
} as const;
type Scenario = keyof typeof PRS;

const ar = en.approvalGate.agentReview;
const pra = en.approvalGate.pullRequestApproval;
const zar = zh.approvalGate.agentReview;
const OVERRIDE_NOTE = 'Credits run out until the 1st — I read the diff myself.';
const FINDINGS = [
  'A zero count renders blank.',
  '',
  '- `app/header.tsx:12` — `count || ""` blanks a zero. Change it to `count ?? 0`.',
].join('\n');

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
/** A rich message's plain words — its tags dropped, its placeholders filled. */
const plain = (text: string, vars: Record<string, string | number> = {}) => {
  // Repeated until nothing changes, so a tag one pass rebuilds is dropped too.
  let stripped = text;
  for (let prev = ''; prev !== stripped; ) {
    prev = stripped;
    stripped = stripped.replace(/<\/?\w+>/g, '');
  }
  return fill(stripped, vars);
};

const repoName = `${REVIEW_REPO.owner}/${REVIEW_REPO.name}`;
const headRefFor = (card: ReviewAgentCard) => `review/${card.identifier.toLowerCase()}`;
/** The delivery-set version a one-pull-request card is reviewed at. */
const versionOf = (scenario: Scenario, sha: string) => `${repoName}#${PRS[scenario].number}@${sha}`;

const MERGE_CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const MERGE_JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;

const main = (page: Page) => page.getByRole('main');
const reviewBand = (page: Page, messages: { github: { development: { title: string } } } = en) =>
  developmentSection(page, messages.github.development.title).getByTestId('agent-review-band');
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });
const reviewAgentSwitch = (page: Page, name = en.approvals.reviewAgent.title) =>
  main(page).getByRole('switch', { name });
const autoMergeRadio = (page: Page) =>
  main(page).getByRole('radio').filter({ hasText: en.approvals.mergeMode.auto.label });

/** Arm a wait for the next server action's response — a POST carrying `Next-Action`. */
const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

/** Open the card's pull request and link it — the path a run walks when it delivers. */
async function openPullRequest(page: Page, card: ReviewAgentCard, scenario: Scenario) {
  const number = PRS[scenario].number;
  const opened = await postSignedWebhook(
    page.request,
    'pull_request',
    pullRequestPayload({
      action: 'opened',
      number,
      title: card.title,
      headRef: headRefFor(card),
      state: 'open',
      merged: false,
      repo: REVIEW_REPO,
    }),
  );
  expect(opened.status(), `open #${number}`).toBe(200);
  await linkPr(page, { workItemId: card.id, repo: REVIEW_REPO, number, headRef: headRefFor(card) });
}

/** CI finished green at `sha` — a signed `check_suite` delivery; its own 200 is the signal. */
async function green(page: Page, card: ReviewAgentCard, scenario: Scenario, sha: string) {
  const res = await postSignedWebhook(
    page.request,
    'check_suite',
    checkSuitePayload({
      conclusion: 'success',
      headSha: sha,
      prNumber: PRS[scenario].number,
      headBranch: headRefFor(card),
      repo: REVIEW_REPO,
    }),
  );
  expect(res.status(), `green #${PRS[scenario].number}@${sha}`).toBe(200);
}

/** A push moved the pull request's head — GitHub's `synchronize` delivery. */
async function push(page: Page, card: ReviewAgentCard, scenario: Scenario, sha: string) {
  const payload = pullRequestPayload({
    action: 'opened',
    number: PRS[scenario].number,
    title: card.title,
    headRef: headRefFor(card),
    state: 'open',
    merged: false,
    repo: REVIEW_REPO,
  }) as { pull_request: Record<string, unknown> } & Record<string, unknown>;
  const res = await postSignedWebhook(page.request, 'pull_request', {
    ...payload,
    action: 'synchronize',
    pull_request: { ...payload.pull_request, head: { ref: headRefFor(card), sha } },
  });
  expect(res.status(), `push #${PRS[scenario].number}@${sha}`).toBe(200);
}

interface BootedReview {
  dispatchRunId: string;
  version: string;
  api: APIRequestContext;
}

/**
 * The review run the REAL job booted for `card` at `version` — read from the fake
 * orchestrator's own record of the boot (the authoritative signal that the job ran), with an
 * API context holding the run's own `MOTIR_RUN_TOKEN`, as the container is booted with.
 */
async function bootedReview(
  card: ReviewAgentCard,
  version: string,
  baseURL: string,
): Promise<BootedReview> {
  const find = () =>
    Object.values(readFakeContainers()).find(
      (m) =>
        m.spec.env?.['MOTIR_RUN_MODE'] === 'review' &&
        m.spec.env?.['MOTIR_WORK_ITEM_KEY'] === card.identifier &&
        m.spec.env?.['MOTIR_REVIEW_VERSION'] === version,
    );
  await expect
    .poll(() => find() !== undefined, {
      timeout: 60_000,
      message: `a review run booted for ${card.identifier} at ${version}`,
    })
    .toBe(true);
  const env = find()!.spec.env!;
  return {
    dispatchRunId: env['MOTIR_DISPATCH_RUN_ID']!,
    version,
    api: await ingestContext(env['MOTIR_RUN_TOKEN']!, baseURL),
  };
}

/** The container's ONE verdict, then its close — `motir review`'s own last two calls. */
async function submitVerdict(
  card: ReviewAgentCard,
  run: BootedReview,
  body: { verdict: 'pass' | 'changes_requested'; summaryMd?: string; findingsMd?: string },
) {
  const res = await run.api.post(`/api/v1/work-items/${card.identifier}/agent-review`, {
    data: { subjectVersion: run.version, ...body },
  });
  const text = await res.text();
  expect(res.status(), `verdict → ${text.slice(0, 400)}`).toBe(200);
  expect(JSON.parse(text)).toMatchObject({
    key: card.identifier,
    state: body.verdict === 'pass' ? 'approved' : 'changes_requested',
    subjectVersion: run.version,
  });
  await closeRun(run.api, run.dispatchRunId, 'completed');
  await run.api.dispose();
}

/** The card's awaiting review, as the database holds it — the committed read. */
const awaitingReview = (card: ReviewAgentCard) =>
  adminDb.approvalGate.findFirst({
    where: { workItemId: card.id, kind: 'agent_review', state: 'awaiting' },
    orderBy: { createdAt: 'desc' },
  });

test.describe('the review agent', () => {
  let s: ContinueHostedSeed;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    // The hosted edges: a model to run the review on, and credits to pay for it.
    writeHostedRunFixture({
      models: { ids: [DEFAULT_MODEL], default: DEFAULT_MODEL },
      mayRun: true,
    });
    resetHostedRunJournal();
    // GitHub's merge: every pull request of the review repository merges.
    writeFileSync(MERGE_JOURNAL_PATH, '');
    writeFileSync(MERGE_CONTROL_PATH, JSON.stringify({ repositories: [repoName] }));
    s = await seedReviewAgent(Date.now().toString(36).slice(-5).toUpperCase());
    await signIn(page, s.owner.email, s.hosted.password);
  });

  test('switched on, a green card is reviewed before anyone is asked; passed, sent back, could not run, switched off, zh', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-1626');
    if (!baseURL) throw new Error('no Playwright baseURL');
    const projectKey = s.hosted.projectKey;
    const passed = await seedDeliveringCard(s, 'Show the widget count');
    const sentBack = await seedDeliveringCard(s, 'Export invoices as CSV');
    const couldNotRun = await seedDeliveringCard(s, 'Rate-limit the public API');
    const switchedOff = await seedDeliveringCard(s, 'Cap webhook retries');
    for (const [card, scenario] of [
      [passed, 'passed'],
      [sentBack, 'sentBack'],
      [couldNotRun, 'couldNotRun'],
      [switchedOff, 'switchedOff'],
    ] as const) {
      await openPullRequest(page, card, scenario);
    }

    // ── 1 ─────────────────────────────────────────────────────────────────────
    await chapter('An admin switches the review agent on in Settings → Approvals', async () => {
      await page.goto('/settings/project/approvals');
      const toggle = reviewAgentSwitch(page);
      await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: FIRST_PAINT_MS });
      await main(page).locator('#review-agent').scrollIntoViewIfNeeded();
      const saved = page.waitForResponse(
        (res) =>
          res.url().endsWith(`/api/projects/${projectKey}/approval-gates`) &&
          res.request().method() === 'PATCH',
      );
      await toggle.click();
      const res = await saved;
      expect(res.status()).toBe(200);
      expect(await res.json()).toMatchObject({ reviewAgentEnabled: true });
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(main(page)).toContainText(plain(en.approvals.reviewAgent.onWhat));
    });

    // ── 2 ─────────────────────────────────────────────────────────────────────
    const passedSha = headShaFor(PRS.passed.number);
    await chapter(
      'A green pull request: nothing on To approve — the card reads Reviewing',
      async () => {
        await green(page, passed, 'passed', passedSha);
        // The review is raised INSTEAD of the merge question: To approve stays empty.
        await page.goto('/workbench?tab=approvals');
        await expect(main(page).getByText(en.workbench.empty.approvals.title)).toBeVisible({
          timeout: FIRST_PAINT_MS,
        });
        // The real job booted the review run on the fake orchestrator.
        const run = await bootedReview(passed, versionOf('passed', passedSha), baseURL);
        await page.goto(`/items/${passed.identifier}`);
        await expect(reviewBand(page)).toHaveAttribute('data-state', 'reviewing', {
          timeout: FIRST_PAINT_MS,
        });
        // On camera: the band sits below the description — bring it into view.
        await reviewBand(page).scrollIntoViewIfNeeded();
        await expect(reviewBand(page)).toContainText(ar.reviewing.title);
        await expect(reviewBand(page).getByTestId('agent-review-run-link')).toBeVisible();

        // ── 3 (its verdict follows at once: the container answers while it is alive) ──
        await submitVerdict(passed, run, {
          verdict: 'pass',
          summaryMd: 'Meets the criterion.',
          findingsMd: 'Meets every acceptance criterion: a zero count renders `0`.',
        });
      },
    );

    await chapter('Review passed — the approve-and-merge gate is below it', async () => {
      await page.reload();
      await expect(reviewBand(page)).toHaveAttribute('data-state', 'passed', {
        timeout: FIRST_PAINT_MS,
      });
      // On camera: the band sits below the description — bring it into view.
      await reviewBand(page).scrollIntoViewIfNeeded();
      await expect(reviewBand(page)).toContainText(ar.passed.title);
      await expect(reviewBand(page)).toContainText(ar.passed.pill);
      await expect(reviewBand(page).getByTestId('agent-review-summary')).toContainText(
        'Meets every acceptance criterion',
      );
      await expect(
        developmentSection(page).getByRole('link', {
          name: en.approvalGate.statusHeld.reviewAndApprove,
          exact: true,
        }),
      ).toBeVisible();
    });
    await beat();

    await chapter('Approve and merge — GitHub merges, and the card is Done', async () => {
      await developmentSection(page)
        .getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove, exact: true })
        .click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible({ timeout: FIRST_PAINT_MS });
      // The pass stays above the gate in the overlay too.
      await expect(dialog.getByTestId('agent-review-band')).toHaveAttribute('data-state', 'passed');
      await expect(dialog.getByTestId('agent-review-band')).toContainText(ar.passed.title);
      await dialog.getByRole('button', { name: pra.verb.approveAndMerge, exact: true }).click();
      const action = serverAction(page);
      await dialog
        .getByRole('button', {
          name: fill(en.approvalGate.confirm.proceed, { verb: pra.verb.approveAndMerge }),
          exact: true,
        })
        .click();
      expect((await action).status()).toBe(200);
      await expect(
        dialog
          .locator('li')
          .filter({ hasText: `${repoName} · #${PRS.passed.number}` })
          .getByText(pra.outcome.merged, { exact: true }),
      ).toBeVisible();
      await closeOverlay(page);
      // GitHub reports the merge; the webhook, and nothing else, finishes the card.
      const merged = await postSignedWebhook(
        page.request,
        'pull_request',
        pullRequestPayload({
          action: 'closed',
          number: PRS.passed.number,
          title: passed.title,
          headRef: headRefFor(passed),
          state: 'closed',
          merged: true,
          repo: REVIEW_REPO,
        }),
      );
      expect(merged.status()).toBe(200);
      await page.reload();
      await expect(statusCard(page)).toContainText('Done', { timeout: FIRST_PAINT_MS });
    });

    // ── 4 ─────────────────────────────────────────────────────────────────────
    const sentBackSha = headShaFor(PRS.sentBack.number);
    await chapter('A second card is sent back — it is on To fix with motir fix', async () => {
      await green(page, sentBack, 'sentBack', sentBackSha);
      const run = await bootedReview(sentBack, versionOf('sentBack', sentBackSha), baseURL);
      await submitVerdict(sentBack, run, {
        verdict: 'changes_requested',
        summaryMd: 'A zero count renders blank.',
        findingsMd: FINDINGS,
      });
      await page.goto('/workbench?tab=to-fix');
      const row = main(page)
        .getByRole('table', { name: en.workbench.tabs.toFix })
        .getByRole('row')
        .filter({ hasText: sentBack.identifier });
      await expect(row).toContainText(plain(en.workbench.toFix.reason.sentBackByAgentNoNote), {
        timeout: FIRST_PAINT_MS,
      });
      await expect(row).toContainText('A zero count renders blank.');
      await expect(row).toContainText(`motir fix ${sentBack.identifier}`);
      await expect(row.getByTestId('fix-hosted-door')).toBeVisible();
    });
    await beat();

    await chapter('The card says the same: sent back, with the findings', async () => {
      await page.goto(`/items/${sentBack.identifier}`);
      await expect(main(page).getByTestId('to-fix-banner')).toContainText(
        plain(en.toFix.banner.sentBackByAgentNoNote).replace(/\.$/, ''),
        { timeout: FIRST_PAINT_MS },
      );
      await expect(reviewBand(page)).toHaveAttribute('data-state', 'sent-back');
      // On camera: the band sits below the description — bring it into view.
      await reviewBand(page).scrollIntoViewIfNeeded();
      await expect(reviewBand(page)).toContainText(ar.sentBack.title);
      await expect(reviewBand(page).getByTestId('agent-review-findings')).toContainText(
        'app/header.tsx:12',
      );
      await expect(main(page).getByTestId('repair-fix-part')).toContainText(
        `motir fix ${sentBack.identifier}`,
      );
    });

    // ── 5 ─────────────────────────────────────────────────────────────────────
    await chapter('The repair pushes; the new green head reads Reviewing again', async () => {
      const repaired = 'e'.repeat(40);
      await push(page, sentBack, 'sentBack', repaired);
      await green(page, sentBack, 'sentBack', repaired);
      // A NEW review, at the NEW version, and its run booted.
      const run = await bootedReview(sentBack, versionOf('sentBack', repaired), baseURL);
      await run.api.dispose();
      await page.reload();
      await expect(reviewBand(page)).toHaveAttribute('data-state', 'reviewing', {
        timeout: FIRST_PAINT_MS,
      });
      // On camera: the band sits below the description — bring it into view.
      await reviewBand(page).scrollIntoViewIfNeeded();
      await expect(main(page).getByTestId('to-fix-banner')).toHaveCount(0);
    });

    // ── 6 ─────────────────────────────────────────────────────────────────────
    const couldNotRunSha = headShaFor(PRS.couldNotRun.number);
    await chapter('Out of credits: Review could not run', async () => {
      // FAKE: the credit check answers `mayRun: false` — the organisation is out of credits.
      writeHostedRunFixture({
        models: { ids: [DEFAULT_MODEL], default: DEFAULT_MODEL },
        mayRun: false,
      });
      await green(page, couldNotRun, 'couldNotRun', couldNotRunSha);
      // The job ran and the pre-flight refused: the refusal's own code is on the gate.
      await expect
        .poll(async () => (await awaitingReview(couldNotRun))?.reviewUnavailableReason ?? null, {
          timeout: 60_000,
        })
        .toBe('hosted_run_out_of_credits');
      await page.goto(`/items/${couldNotRun.identifier}`);
      await expect(reviewBand(page)).toHaveAttribute('data-state', 'could-not-run', {
        timeout: FIRST_PAINT_MS,
      });
      // On camera: the band sits below the description — bring it into view.
      await reviewBand(page).scrollIntoViewIfNeeded();
      await expect(reviewBand(page)).toContainText(ar.couldNotRun.reason.no_credits);
      await expect(
        developmentSection(page).getByRole('button', { name: ar.verb.reviewAgain }),
      ).toBeVisible();
    });
    await beat();

    await chapter(
      'Continue without the review — with a reason, in the approval overlay',
      async () => {
        await developmentSection(page)
          .getByRole('button', { name: ar.verb.continueWithout, exact: true })
          .click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(dialog.getByTestId('agent-review-band')).toHaveAttribute(
          'data-state',
          'could-not-run',
        );
        await dialog.getByRole('button', { name: ar.verb.continueWithout, exact: true }).click();
        await expect(dialog.getByText(ar.override.records)).toBeVisible();
        await dialog.getByLabel(ar.override.label).fill(OVERRIDE_NOTE);
        const action = serverAction(page);
        await dialog.getByRole('button', { name: ar.override.proceed, exact: true }).click();
        expect((await action).status()).toBe(200);
        // The record names the person — never the review agent's pass.
        const band = dialog.getByTestId('agent-review-band');
        await expect(band).toHaveAttribute('data-state', 'override');
        await expect(band).toContainText(`Continued without the review by ${s.owner.name}`);
        await expect(band).toContainText(OVERRIDE_NOTE);
        await expect(band).not.toContainText(ar.passed.pill);
      },
    );
    await beat();

    await chapter('The ordinary approve gate appears, the record above it', async () => {
      await closeOverlay(page);
      await page.reload();
      await expect(reviewBand(page)).toHaveAttribute('data-state', 'override', {
        timeout: FIRST_PAINT_MS,
      });
      // On camera: the band sits below the description — bring it into view.
      await reviewBand(page).scrollIntoViewIfNeeded();
      await expect(reviewBand(page)).toContainText(s.owner.name);
      await expect(
        developmentSection(page).getByRole('link', {
          name: en.approvalGate.statusHeld.reviewAndApprove,
          exact: true,
        }),
      ).toBeVisible();
      writeHostedRunFixture({
        models: { ids: [DEFAULT_MODEL], default: DEFAULT_MODEL },
        mayRun: true,
      });
    });

    // ── 7 ─────────────────────────────────────────────────────────────────────
    await chapter('While the review agent is on, Merge automatically is disabled', async () => {
      await page.goto('/settings/project/approvals');
      await expect(reviewAgentSwitch(page)).toHaveAttribute('aria-checked', 'true', {
        timeout: FIRST_PAINT_MS,
      });
      await expect(autoMergeRadio(page)).toHaveAttribute('aria-disabled', 'true');
      await main(page).locator('#review-agent').scrollIntoViewIfNeeded();
      await expect(autoMergeRadio(page)).toBeDisabled();
      await expect(main(page)).toContainText(en.approvals.mergeMode.auto.blockedByReviewAgent);
    });
    await beat();

    await chapter('Switched off, Merge automatically is selectable again', async () => {
      const saved = page.waitForResponse(
        (res) =>
          res.url().endsWith(`/api/projects/${projectKey}/approval-gates`) &&
          res.request().method() === 'PATCH',
      );
      await reviewAgentSwitch(page).click();
      const res = await saved;
      expect(res.status()).toBe(200);
      expect(await res.json()).toMatchObject({ reviewAgentEnabled: false });
      await expect(reviewAgentSwitch(page)).toHaveAttribute('aria-checked', 'false');
      await expect(autoMergeRadio(page)).toBeEnabled();
      await expect(autoMergeRadio(page)).not.toHaveAttribute('aria-disabled', 'true');
      await expect(main(page)).not.toContainText(en.approvals.mergeMode.auto.blockedByReviewAgent);
    });

    // ── 8 ─────────────────────────────────────────────────────────────────────
    await chapter(
      'Switched off, nothing changes: a green card goes straight to the gate',
      async () => {
        await green(page, switchedOff, 'switchedOff', headShaFor(PRS.switchedOff.number));
        await page.goto(`/items/${switchedOff.identifier}`);
        await expect(
          developmentSection(page).getByRole('link', {
            name: en.approvalGate.statusHeld.reviewAndApprove,
            exact: true,
          }),
        ).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(reviewBand(page)).toHaveCount(0);
        expect(await awaitingReview(switchedOff)).toBeNull();
      },
    );
    await beat();

    // ── 9 ─────────────────────────────────────────────────────────────────────
    // A card the review agent sent back, for the Chinese read (seeded — see the header).
    const zhCard = await seedSentBackCard(s, 'Name the reviewer', 'agent_review');
    await chapter('中文 — the switch, the frame and the To fix row', async () => {
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', baseURL).href }]);
      await page.goto('/settings/project/approvals');
      await expect(reviewAgentSwitch(page, zh.approvals.reviewAgent.title)).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(main(page)).toContainText(plain(zh.approvals.reviewAgent.offWhat));
      await main(page).locator('#review-agent').scrollIntoViewIfNeeded();

      await page.goto(`/items/${zhCard.identifier}`);
      await expect(reviewBand(page, zh)).toHaveAttribute('data-state', 'sent-back', {
        timeout: FIRST_PAINT_MS,
      });
      // On camera: the band sits below the description — bring it into view.
      await reviewBand(page, zh).scrollIntoViewIfNeeded();
      await expect(reviewBand(page, zh)).toContainText(zar.sentBack.title);
      await expect(main(page).getByTestId('repair-fix-part')).toContainText(
        `motir fix ${zhCard.identifier}`,
      );

      await page.goto('/workbench?tab=to-fix');
      const row = main(page)
        .getByRole('table', { name: zh.workbench.tabs.toFix })
        .getByRole('row')
        .filter({ hasText: zhCard.identifier });
      await expect(row).toContainText(plain(zh.workbench.toFix.reason.sentBackByAgentNoNote), {
        timeout: FIRST_PAINT_MS,
      });
      await expect(row).toContainText(`motir fix ${zhCard.identifier}`);
      await expect(main(page)).not.toContainText('workbench.toFix');
    });
    await beat();
  });
});
