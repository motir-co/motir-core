import { readFileSync, writeFileSync } from 'node:fs';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { ingestContext } from './_helpers/agent-run-seed';
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
import { REVIEW_REPO, type ReviewAgentCard } from './_helpers/review-agent-seed';
import {
  APP_GITHUB,
  OWNER_GITHUB,
  TEAMMATE_GITHUB,
  seedReviewCard,
  seedReviewPath,
} from './_helpers/review-path-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// EVERY CARD IN IN REVIEW HAS A PATH TO DONE — THE STORY'S ACCEPTANCE RECEIPT (Story
// MOTIR-10327 · Subtask MOTIR-10345; ADR `approval-gates.md` §12.11–§12.16; designs
// `design/projects/approvals--review-path.mock.html`, `design/boards/board--review-path…`,
// `design/github/approve-and-merge--review-path.mock.html`,
// `design/workbench/approvals-row--review-path.mock.html`).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// An admin turns the review agent on and chooses **Your own agent**: Merge automatically
// stays disabled under both sources. A card goes green and waits for the person's own review
// agent — on the board card, the List cell and the item header, with a copyable
// `motir review <KEY>` — and To approve lists it as a review to run, not an approval. The
// person's agent sends it back through the user-token door: the card is To fix, its status
// does not move, Motir's App bot asks for changes on the teammate's pull request and
// comments on its own. A fix and a pass show the Reviewed badge everywhere; a push takes it
// away again. With the gate off, a send-back is dismissed with a reason and the row comes
// back reading *Review dismissed*. A hosted review is *Agent reviewing*, then *Review could
// not run*. The author note appears only for a card whose every pull request the routed
// person opened. Each part of a story wears its own badge; the story none. Approve and merge
// finishes a card whose record
// names the review it stood on. Then the same surfaces in 中文, and a narrow board.
//
// ── THE FAKES — AND ONLY THESE ──────────────────────────────────────────────
//
//   * GITHUB — signed deliveries to the real `/api/github/webhook` route (open, green, push,
//     merged), and the merge seam (`lib/test-github-merge-mock.ts`), which also answers — and
//     JOURNALS — every review Motir's App bot posts or dismisses. The journal is the
//     authoritative signal for what the bot posted.
//   * THE HOSTED REVIEW RUN — the fake orchestrator, booted by the REAL job, and
//     `lib/test-hosted-run-mock.ts`'s fixture (`mayRun: false` is the could-not-run case).
//   * NOTHING ELSE. Every verdict goes through `POST /api/v1/work-items/{key}/review-verdict`
//     with the routed person's own token, as `motir review` submits it; never a database
//     write.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's or a door's own response and body, a PATCH's
// response, a server action's status, the merge seam's journal, or a committed read of the
// gate. No timed wait anywhere; the holds are `chapter()` / `beat()`'s, taken after the
// assertion.
//
// ⚠️ THE 27xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 900_000 });
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const DEFAULT_MODEL = 'e2e-hosted-default';
const HARNESS = 'Claude Code';
const OWN_MODEL = 'e2e-own-model';

/** Every pull request this spec opens, and who GitHub says opened it. */
const PRS = {
  mainTeammate: { number: 27101, author: TEAMMATE_GITHUB },
  mainApp: { number: 27102, author: APP_GITHUB },
  authored: { number: 27201, author: OWNER_GITHUB },
  partOne: { number: 27301, author: TEAMMATE_GITHUB },
  partTwo: { number: 27302, author: TEAMMATE_GITHUB },
  hostedReviewing: { number: 27401, author: TEAMMATE_GITHUB },
  hostedCouldNotRun: { number: 27501, author: TEAMMATE_GITHUB },
} as const;
type PrName = keyof typeof PRS;

const rp = en.approvalGate.reviewPath;
const zrp = zh.approvalGate.reviewPath;
const ar = en.approvalGate.agentReview;
const pra = en.approvalGate.pullRequestApproval;
const ra = en.approvals.reviewAgent;
const zra = zh.approvals.reviewAgent;

const SEND_BACK_FINDINGS = [
  'The export drops the header row.',
  '',
  '- `lib/export.ts:12` — `rows.slice(1)` skips the header. Keep row 0.',
].join('\n');
const DISMISS_REASON = 'The header row is out of scope for this work item.';

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
/** A rich message's plain words — its tags dropped, its placeholders filled. */
const plain = (text: string, vars: Record<string, string | number> = {}) => {
  let stripped = text;
  for (let prev = ''; prev !== stripped; ) {
    prev = stripped;
    stripped = stripped.replace(/<\/?\w+>/g, '');
  }
  return fill(stripped, vars);
};

const repoName = `${REVIEW_REPO.owner}/${REVIEW_REPO.name}`;
const prKey = (pr: PrName) => `${repoName}#${PRS[pr].number}`;
const headRefFor = (pr: PrName) => `review-path/${PRS[pr].number}`;
/** The delivery-set version over `members` at their heads — sorted, comma-joined. */
const versionOf = (members: Array<[PrName, string]>) =>
  members
    .map(([pr, sha]) => `${prKey(pr)}@${sha}`)
    .sort()
    .join(',');

const MERGE_CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const MERGE_JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;

// ── Locators ────────────────────────────────────────────────────────────────

const main = (page: Page) => page.getByRole('main');
const boardCard = (page: Page, card: ReviewAgentCard) =>
  main(page).getByTestId(`board-card-${card.identifier}`);
/**
 * The board card, scrolled into its column's window. A board column VIRTUALIZES its stack
 * (`useRowWindow`), so with seven cards in In review the later ones mount only once the
 * column scrolls — the way a person reaches them. Each column's own scroller is stepped
 * down until the card mounts, then the card is brought into view.
 */
async function revealBoardCard(page: Page, card: ReviewAgentCard): Promise<Locator> {
  const target = boardCard(page, card);
  await expect
    .poll(
      async () => {
        if ((await target.count()) > 0) return true;
        await main(page)
          .locator('[data-testid^="board-column-"] div.overflow-y-auto')
          .evaluateAll((els) => {
            for (const el of els) {
              el.scrollTop += el.clientHeight / 2;
              el.dispatchEvent(new Event('scroll'));
            }
          });
        return false;
      },
      { timeout: FIRST_PAINT_MS },
    )
    .toBe(true);
  await target.scrollIntoViewIfNeeded();
  return target;
}
/** The approval record's *reviewed* line, with the commits it names as a pattern: the
 *  repo and pull request are known, the merged head is whatever the lane's push left. */
function recordReviewed(copy: typeof rp, name: string, prNumber: number): RegExp {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [before, after] = fill(copy.record.reviewed, { name, commits: '\u0000' }).split('\u0000');
  return new RegExp(
    `^${escape(before!)}${escape(`${REVIEW_REPO.owner}/${REVIEW_REPO.name}`)}#${prNumber} @ [0-9a-f]{7}${escape(after!)}$`,
  );
}
const listRow = (page: Page, card: ReviewAgentCard) =>
  main(page).getByRole('row').filter({ hasText: card.identifier });
const toApprove = (page: Page, messages = en) =>
  main(page).getByRole('table', { name: messages.workbench.tabs.toApprove });
const toApproveRow = (page: Page, card: ReviewAgentCard, messages = en) =>
  toApprove(page, messages).getByRole('row').filter({ hasText: card.identifier });
const reviewAgentSwitch = (page: Page, name = ra.title) => main(page).getByRole('switch', { name });
const sourceRadio = (page: Page, label: string) =>
  main(page).getByRole('radio').filter({ hasText: label });
const autoMergeRadio = (page: Page) =>
  main(page).getByRole('radio').filter({ hasText: en.approvals.mergeMode.auto.label });
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

/** Arm a wait for the next server action's response — a POST carrying `Next-Action`. */
const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

// ── GitHub, through the real webhook route ──────────────────────────────────

function prPayload(card: ReviewAgentCard, pr: PrName, extra: Record<string, unknown> = {}) {
  const payload = pullRequestPayload({
    action: 'opened',
    number: PRS[pr].number,
    title: card.title,
    headRef: headRefFor(pr),
    state: 'open',
    merged: false,
    repo: REVIEW_REPO,
  }) as { pull_request: Record<string, unknown> } & Record<string, unknown>;
  // WHO OPENED IT — the author fact the note reads (the helper's default is one account).
  return {
    ...payload,
    pull_request: {
      ...payload.pull_request,
      user: { id: PRS[pr].author.id, login: PRS[pr].author.login },
      ...extra,
    },
  };
}

async function openPullRequest(page: Page, card: ReviewAgentCard, pr: PrName) {
  const res = await postSignedWebhook(page.request, 'pull_request', prPayload(card, pr));
  expect(res.status(), `open #${PRS[pr].number}`).toBe(200);
  await linkPr(page, {
    workItemId: card.id,
    repo: REVIEW_REPO,
    number: PRS[pr].number,
    headRef: headRefFor(pr),
  });
}

/** CI finished green at `sha` — a signed `check_suite` delivery. */
async function green(page: Page, pr: PrName, sha: string) {
  const res = await postSignedWebhook(
    page.request,
    'check_suite',
    checkSuitePayload({
      conclusion: 'success',
      headSha: sha,
      prNumber: PRS[pr].number,
      headBranch: headRefFor(pr),
      repo: REVIEW_REPO,
    }),
  );
  expect(res.status(), `green #${PRS[pr].number}@${sha}`).toBe(200);
}

/** A push moved the pull request's head — GitHub's `synchronize` delivery. */
async function push(page: Page, card: ReviewAgentCard, pr: PrName, sha: string) {
  const payload = prPayload(card, pr, { head: { ref: headRefFor(pr), sha } });
  const res = await postSignedWebhook(page.request, 'pull_request', {
    ...payload,
    action: 'synchronize',
  });
  expect(res.status(), `push #${PRS[pr].number}@${sha}`).toBe(200);
}

/** GitHub reports the merge; the webhook, and nothing else, finishes the card. */
async function merged(page: Page, card: ReviewAgentCard, pr: PrName) {
  const res = await postSignedWebhook(
    page.request,
    'pull_request',
    prPayload(card, pr, { state: 'closed', merged: true }),
  );
  expect(res.status(), `merged #${PRS[pr].number}`).toBe(200);
}

// ── Committed reads ─────────────────────────────────────────────────────────

/** The card's newest gate of `kind` in `state` — the committed read a wait polls. */
const gateOf = (card: ReviewAgentCard, kind: 'agent_review' | 'pull_request_approval') =>
  adminDb.approvalGate.findFirst({
    where: { workItemId: card.id, kind, state: 'awaiting' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, subjectVersion: true, reviewUnavailableReason: true },
  });

/** Wait until the card has an awaiting `kind` gate at exactly `version`. */
async function awaitGate(
  card: ReviewAgentCard,
  kind: 'agent_review' | 'pull_request_approval',
  version: string,
) {
  await expect
    .poll(async () => (await gateOf(card, kind))?.subjectVersion ?? null, {
      timeout: 60_000,
      message: `${card.identifier}: an awaiting ${kind} at ${version}`,
    })
    .toBe(version);
}

const statusOf = async (card: ReviewAgentCard) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id }, select: { status: true } }))
    .status;

// ── The user-token verdict door ─────────────────────────────────────────────

/** The routed person's own agent answers — `motir review`'s submit, with their token. */
async function submitVerdict(
  api: APIRequestContext,
  card: ReviewAgentCard,
  body: { verdict: 'approved' | 'changes_requested'; subjectVersion: string; findingsMd?: string },
) {
  const res = await api.post(`/api/v1/work-items/${card.identifier}/review-verdict`, {
    data: {
      summaryMd: body.verdict === 'approved' ? 'Meets every acceptance criterion.' : null,
      checklist: [],
      harness: HARNESS,
      model: OWN_MODEL,
      ...body,
    },
  });
  const text = await res.text();
  expect(res.status(), `verdict → ${text.slice(0, 400)}`).toBe(200);
  const json = JSON.parse(text) as { recordId: string; verdict: string; subjectVersion: string };
  expect(json).toMatchObject({
    key: card.identifier,
    verdict: body.verdict,
    subjectVersion: body.subjectVersion,
  });
  return json;
}

// ── The bot's posts, read from the merge seam's journal ─────────────────────

interface JournalCall {
  method: string;
  path: string;
  pullRequest?: string;
  body?: Record<string, unknown> | null;
}

function journalCalls(): JournalCall[] {
  return readFileSync(MERGE_JOURNAL_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalCall);
}

const reviewPosts = (pr: PrName) =>
  journalCalls().filter(
    (c) =>
      c.method === 'POST' &&
      /\/reviews$/.test(c.path) &&
      c.pullRequest?.toLowerCase() === prKey(pr).toLowerCase(),
  );
const reviewEvents = (pr: PrName) => reviewPosts(pr).map((c) => String(c.body?.['event'] ?? ''));
const dismissals = (pr: PrName) =>
  journalCalls().filter(
    (c) =>
      c.method === 'PUT' &&
      /\/dismissals$/.test(c.path) &&
      c.pullRequest?.toLowerCase() === prKey(pr).toLowerCase(),
  );

// ── The hosted review run, booted by the real job ───────────────────────────

async function bootedReview(card: ReviewAgentCard, version: string) {
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
  return find()!.spec.env!;
}

const hostedRunsFor = (card: ReviewAgentCard) =>
  Object.values(readFakeContainers()).filter(
    (m) =>
      m.spec.env?.['MOTIR_RUN_MODE'] === 'review' &&
      m.spec.env?.['MOTIR_WORK_ITEM_KEY'] === card.identifier,
  );

// ── Settings ────────────────────────────────────────────────────────────────

const approvalSettingsSaved = (page: Page, projectKey: string) =>
  page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/projects/${projectKey}/approval-gates`) &&
      res.request().method() === 'PATCH',
  );

async function chooseSource(page: Page, projectKey: string, source: 'hosted' | 'own') {
  const saved = approvalSettingsSaved(page, projectKey);
  await sourceRadio(page, ra.source[source]).click();
  const res = await saved;
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ reviewAgentSource: source });
  await expect(sourceRadio(page, ra.source[source])).toHaveAttribute('aria-checked', 'true');
}

async function setReviewAgent(page: Page, projectKey: string, on: boolean) {
  const toggle = reviewAgentSwitch(page);
  await expect(toggle).toHaveAttribute('aria-checked', on ? 'false' : 'true', {
    timeout: FIRST_PAINT_MS,
  });
  const saved = approvalSettingsSaved(page, projectKey);
  await toggle.click();
  const res = await saved;
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ reviewAgentEnabled: on });
  await expect(toggle).toHaveAttribute('aria-checked', on ? 'true' : 'false');
}

/** The Merge automatically radio is disabled, with its explanation — under either source. */
async function autoMergeBlocked(page: Page) {
  await expect(autoMergeRadio(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(main(page)).toContainText(en.approvals.mergeMode.auto.blockedByReviewAgent);
}

// ── Approve and merge, in the overlay ───────────────────────────────────────

async function approveAndMerge(page: Page, card: ReviewAgentCard, prs: PrName[]) {
  await page.goto(`/items/${card.identifier}`);
  await developmentSection(page)
    .getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove, exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: FIRST_PAINT_MS });
  await dialog.getByRole('button', { name: pra.verb.approveAndMerge, exact: true }).click();
  const action = serverAction(page);
  await dialog
    .getByRole('button', {
      name: fill(en.approvalGate.confirm.proceed, { verb: pra.verb.approveAndMerge }),
      exact: true,
    })
    .click();
  expect((await action).status()).toBe(200);
  for (const pr of prs) {
    await expect(
      dialog
        .locator('li')
        .filter({ hasText: `${repoName} · #${PRS[pr].number}` })
        .getByText(pra.outcome.merged, { exact: true }),
    ).toBeVisible();
  }
  await closeOverlay(page);
  for (const pr of prs) await merged(page, card, pr);
  await page.reload();
  await expect(statusCard(page)).toContainText('Done', { timeout: FIRST_PAINT_MS });
}

/** No horizontal overflow inside `el` — a pill or chip pushed out reads as scrollWidth. */
async function fitsItsBox(el: Locator) {
  const { scroll, client } = await el.evaluate((node) => ({
    scroll: node.scrollWidth,
    client: node.clientWidth,
  }));
  expect(scroll, 'nothing overflows the box').toBeLessThanOrEqual(client + 1);
}

test.describe('the review path', () => {
  let s: ContinueHostedSeed;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    writeHostedRunFixture({
      models: { ids: [DEFAULT_MODEL], default: DEFAULT_MODEL },
      mayRun: true,
    });
    resetHostedRunJournal();
    // GitHub's merge seam: every pull request of the review repository merges, and the App
    // opened the main card's second pull request — GitHub refuses its Request changes there.
    writeFileSync(MERGE_JOURNAL_PATH, '');
    writeFileSync(
      MERGE_CONTROL_PATH,
      JSON.stringify({ repositories: [repoName], ownAuthoredPullRequests: [prKey('mainApp')] }),
    );
    s = await seedReviewPath(Date.now().toString(36).slice(-5).toUpperCase());
    await signIn(page, s.owner.email, s.hosted.password);
  });

  test('a card in In review has a path to Done: own agent, send-back, pass, head move, Dismiss, hosted, author note, Done, zh', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-10327');
    if (!baseURL) throw new Error('no Playwright baseURL');
    const projectKey = s.hosted.projectKey;
    const api = await ingestContext(s.owner.token, baseURL);

    const mainCard = await seedReviewCard(s, 'Export invoices as CSV');
    const authored = await seedReviewCard(s, 'Name the reviewer on the card');
    const story = await seedReviewCard(s, 'Ship the invoice exports', { kind: 'story' });
    const partOne = await seedReviewCard(s, 'Export the header row', {
      kind: 'subtask',
      parentId: story.id,
    });
    const partTwo = await seedReviewCard(s, 'Export the totals row', {
      kind: 'subtask',
      parentId: story.id,
    });
    const reviewing = await seedReviewCard(s, 'Rate-limit the public API');
    const couldNotRun = await seedReviewCard(s, 'Cap webhook retries');
    for (const [card, pr] of [
      [mainCard, 'mainTeammate'],
      [mainCard, 'mainApp'],
      [authored, 'authored'],
      [partOne, 'partOne'],
      [partTwo, 'partTwo'],
      [reviewing, 'hostedReviewing'],
      [couldNotRun, 'hostedCouldNotRun'],
    ] as const) {
      await openPullRequest(page, card, pr);
    }

    // ── 1 · Settings: the source choice ─────────────────────────────────────
    await chapter(
      'Settings → Approvals: turn the review agent on, choose Your own agent',
      async () => {
        await page.goto('/settings/project/approvals');
        await setReviewAgent(page, projectKey, true);
        await main(page).locator('#review-agent').scrollIntoViewIfNeeded();
        // Motir's hosted agent is the default, with its billing note.
        await expect(sourceRadio(page, ra.source.hosted)).toHaveAttribute('aria-checked', 'true');
        await expect(main(page)).toContainText(ra.billingNote);
        await autoMergeBlocked(page);

        await chooseSource(page, projectKey, 'own');
        await expect(main(page)).toContainText(plain(ra.source.ownWhat));
        await expect(main(page)).not.toContainText(ra.billingNote);
        await autoMergeBlocked(page);
      },
    );
    await beat();

    await chapter('Hosted and back: Merge automatically stays disabled under both', async () => {
      await chooseSource(page, projectKey, 'hosted');
      await autoMergeBlocked(page);
      await chooseSource(page, projectKey, 'own');
      await autoMergeBlocked(page);
    });

    // ── 2 · Waiting for your review agent ───────────────────────────────────
    const shaOne = { mainTeammate: headShaFor(27101), mainApp: headShaFor(27102) };
    const mainV1 = versionOf([
      ['mainTeammate', shaOne.mainTeammate],
      ['mainApp', shaOne.mainApp],
    ]);
    await chapter('Green, and waiting for your review agent — on the board card', async () => {
      await green(page, 'mainTeammate', shaOne.mainTeammate);
      await green(page, 'mainApp', shaOne.mainApp);
      await awaitGate(mainCard, 'agent_review', mainV1);
      await page.goto('/boards');
      const marker = boardCard(page, mainCard).locator('[data-review-marker]');
      await expect(marker).toHaveAttribute('data-review-marker', 'waiting_for_own_agent', {
        timeout: FIRST_PAINT_MS,
      });
      await expect(marker).toContainText(rp.marker.waitingYours);
      // No hosted run starts for a project reviewing with its own agent.
      expect(hostedRunsFor(mainCard)).toEqual([]);
    });

    await chapter('…the List cell, and the item header with motir review', async () => {
      await page.goto('/items');
      await expect(listRow(page, mainCard).locator('[data-review-marker]')).toHaveAttribute(
        'data-review-marker',
        'waiting_for_own_agent',
        { timeout: FIRST_PAINT_MS },
      );
      await page.goto(`/items/${mainCard.identifier}`);
      const headerMarker = main(page).locator('[data-review-header-marker]');
      await expect(headerMarker).toContainText(rp.marker.waitingYours, { timeout: FIRST_PAINT_MS });
      const copy = main(page).getByTestId(`review-command-copy-${mainCard.identifier}`);
      await expect(copy).toBeVisible();
      await copy.click();
      await expect(main(page).getByText(rp.command.copied, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        `motir review ${mainCard.identifier}`,
      );
    });
    await beat();

    await chapter('To approve lists it as a review to run, not an approval', async () => {
      await page.goto('/workbench?tab=approvals');
      const row = main(page).locator('[data-review-to-run]').filter({
        hasText: mainCard.identifier,
      });
      await expect(row).toContainText(plain(rp.toRun.sentence, { name: mainCard.title }), {
        timeout: FIRST_PAINT_MS,
      });
      await expect(row).toContainText(rp.toRun.tag);
      await expect(row).toContainText(rp.toRun.details);
      await expect(row.getByTestId(`review-command-copy-${mainCard.identifier}`)).toBeVisible();
      // It decides nothing: no approve verb on it.
      await expect(row.getByRole('button', { name: /approve/i })).toHaveCount(0);
    });
    await beat();

    // ── 3 · A send-back through the real door ───────────────────────────────
    const statusBefore = await statusOf(mainCard);
    await chapter(
      'Your agent sends it back: To fix with the findings, status unchanged',
      async () => {
        await submitVerdict(api, mainCard, {
          verdict: 'changes_requested',
          subjectVersion: mainV1,
          findingsMd: SEND_BACK_FINDINGS,
        });
        expect(await statusOf(mainCard)).toBe(statusBefore);
        await page.goto(`/items/${mainCard.identifier}`);
        await expect(main(page).getByTestId('to-fix-banner')).toBeVisible({
          timeout: FIRST_PAINT_MS,
        });
        await expect(main(page)).toContainText('The export drops the header row.');
        await page.goto('/workbench?tab=approvals');
        await expect(main(page)).toBeVisible();
        await expect(
          main(page).locator('[role="row"]').filter({ hasText: mainCard.identifier }),
        ).toHaveCount(0, { timeout: FIRST_PAINT_MS });
      },
    );

    await chapter('The activity names the agent and the commits', async () => {
      await page.goto(`/items/${mainCard.identifier}?activity=history`);
      const entry = main(page).locator('[id^="agent-verdict-"]').first();
      await expect(entry).toContainText(
        plain(rp.activity.sentBack, {
          agent: fill(rp.activity.agentOwn, { name: s.owner.name, harness: HARNESS }),
          commits: '',
        }).trim(),
        { timeout: FIRST_PAINT_MS },
      );
      await entry.scrollIntoViewIfNeeded();
    });
    await beat();

    await chapter('Motir’s bot asked for changes on GitHub — and never approves', async () => {
      // The bot's posts are jobs: the journal is the authoritative record of what reached
      // GitHub. The teammate's pull request gets Request changes; GitHub refuses the App's
      // on its own pull request, and the bot comments instead.
      await expect
        .poll(() => reviewEvents('mainTeammate'), { timeout: 60_000 })
        .toEqual(['REQUEST_CHANGES']);
      await expect
        .poll(() => reviewEvents('mainApp').filter((e) => e === 'COMMENT'), { timeout: 60_000 })
        .toEqual(['COMMENT']);
      expect(journalCalls().filter((c) => c.body?.['event'] === 'APPROVE')).toEqual([]);
    });

    // ── 4 · A fix, and a pass ───────────────────────────────────────────────
    const shaTwo = 'a1'.repeat(20);
    const mainV2 = versionOf([
      ['mainTeammate', shaTwo],
      ['mainApp', shaOne.mainApp],
    ]);
    await chapter('A fix is pushed and your agent passes it: Reviewed', async () => {
      await push(page, mainCard, 'mainTeammate', shaTwo);
      await green(page, 'mainTeammate', shaTwo);
      await awaitGate(mainCard, 'agent_review', mainV2);
      await submitVerdict(api, mainCard, { verdict: 'approved', subjectVersion: mainV2 });
      await awaitGate(mainCard, 'pull_request_approval', mainV2);

      await page.goto('/boards');
      await expect(
        boardCard(page, mainCard).locator('[data-reviewed-badge="reviewed"]'),
      ).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(boardCard(page, mainCard).locator('[data-review-marker]')).toHaveCount(0);
      await page.goto('/items');
      await expect(listRow(page, mainCard).locator('[data-reviewed-badge="reviewed"]')).toBeVisible(
        { timeout: FIRST_PAINT_MS },
      );
    });

    await chapter('The badge’s card opens on keyboard focus: reviewer, time, commits', async () => {
      await page.goto(`/items/${mainCard.identifier}`);
      const badge = main(page).locator('[data-reviewed-badge="reviewed"]').first();
      await expect(badge).toBeVisible({ timeout: FIRST_PAINT_MS });
      await badge.focus();
      const card = main(page).getByTestId('reviewed-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText(fill(rp.badge.card.own, { name: s.owner.name }));
      await expect(card).toContainText(
        fill(rp.badge.card.harness, { harness: HARNESS, model: OWN_MODEL }),
      );
      await expect(card).toContainText(rp.badge.card.commits);
      await expect(card).toContainText(`#${PRS.mainTeammate.number}`);
      await page.keyboard.press('Escape');
      await expect(card).toBeHidden();
    });
    await beat();

    await chapter('To approve: Reviewed by agent, with the badge', async () => {
      await page.goto('/workbench?tab=approvals');
      const row = toApproveRow(page, mainCard);
      await expect(row.locator('[data-review-line]')).toHaveAttribute(
        'data-review-line',
        'reviewed_by_agent',
        { timeout: FIRST_PAINT_MS },
      );
      await expect(row).toContainText(
        plain(rp.line.reviewed, { who: '', when: '' }).split('·')[0]!.trim(),
      );
      await expect(row.locator('[data-reviewed-badge="reviewed"]')).toBeVisible();
      // On GitHub: the bot's earlier Request changes is dismissed, and the pass commented.
      await expect.poll(() => dismissals('mainTeammate').length, { timeout: 60_000 }).toBe(1);
      await expect
        .poll(() => reviewEvents('mainTeammate'), { timeout: 60_000 })
        .toEqual(['REQUEST_CHANGES', 'COMMENT']);
      expect(journalCalls().filter((c) => c.body?.['event'] === 'APPROVE')).toEqual([]);
    });
    await beat();

    // ── 5 · The gate off, and a head move ───────────────────────────────────
    await chapter('The review gate is switched off', async () => {
      await page.goto('/settings/project/approvals');
      await setReviewAgent(page, projectKey, false);
      await expect(autoMergeRadio(page)).toBeEnabled();
    });

    const shaThree = 'b2'.repeat(20);
    const mainV3 = versionOf([
      ['mainTeammate', shaThree],
      ['mainApp', shaOne.mainApp],
    ]);
    await chapter(
      'A push moves the head: the badge is gone, Not reviewed by an agent',
      async () => {
        await push(page, mainCard, 'mainTeammate', shaThree);
        await green(page, 'mainTeammate', shaThree);
        await awaitGate(mainCard, 'pull_request_approval', mainV3);
        // The other cards go green with the gate off: each is asked to approve and merge.
        await green(page, 'authored', headShaFor(PRS.authored.number));
        await green(page, 'partOne', headShaFor(PRS.partOne.number));
        await green(page, 'partTwo', headShaFor(PRS.partTwo.number));

        await page.goto('/boards');
        await expect(boardCard(page, mainCard)).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(boardCard(page, mainCard).locator('[data-reviewed-badge]')).toHaveCount(0);
        await page.goto('/items');
        await expect(listRow(page, mainCard)).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(listRow(page, mainCard).locator('[data-reviewed-badge]')).toHaveCount(0);
        await page.goto(`/items/${mainCard.identifier}`);
        await expect(statusCard(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(main(page).locator('[data-reviewed-badge]')).toHaveCount(0);

        await page.goto('/workbench?tab=approvals');
        const row = toApproveRow(page, mainCard);
        await expect(row.locator('[data-review-line]')).toHaveAttribute(
          'data-review-line',
          'not_reviewed',
          { timeout: FIRST_PAINT_MS },
        );
        await expect(row).toContainText(plain(rp.line.notReviewed));
        await expect(row.getByTestId(`review-command-copy-${mainCard.identifier}`)).toBeVisible();
      },
    );
    await beat();

    // ── 6 · Gate off: a send-back, and Dismiss the review ───────────────────
    await chapter(
      'Gate off, a send-back: the row leaves To approve, the card is To fix',
      async () => {
        await submitVerdict(api, mainCard, {
          verdict: 'changes_requested',
          subjectVersion: mainV3,
          findingsMd: SEND_BACK_FINDINGS,
        });
        await page.goto('/workbench?tab=approvals');
        await expect(toApproveRow(page, authored)).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(toApproveRow(page, mainCard)).toHaveCount(0);
        await page.goto(`/items/${mainCard.identifier}`);
        await expect(main(page).getByTestId('to-fix-banner')).toBeVisible({
          timeout: FIRST_PAINT_MS,
        });
      },
    );

    await chapter('Dismiss the review: the reason is required', async () => {
      const control = main(page).getByTestId('dismiss-review');
      await control.scrollIntoViewIfNeeded();
      await expect(control).toContainText(rp.dismiss.toFixNote);
      await control.getByRole('button', { name: rp.dismiss.button, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: rp.dismiss.title });
      await expect(dialog).toBeVisible();
      const confirm = dialog.getByRole('button', { name: rp.dismiss.confirm, exact: true });
      await expect(confirm).toBeDisabled();
      await dialog.getByRole('textbox').fill('   ');
      await expect(confirm).toBeDisabled();
      await dialog.getByRole('textbox').fill(DISMISS_REASON);
      await expect(confirm).toBeEnabled();
      await beat();
      const dismissed = page.waitForResponse(
        (res) =>
          res.url().endsWith(`/api/work-items/${mainCard.identifier}/review-dismissal`) &&
          res.request().method() === 'POST',
      );
      await confirm.click();
      expect((await dismissed).status()).toBe(200);
      // The record the door wrote, read from the database: the page refreshes on the
      // answer, so the response body is not read (Playwright can lose it to the refresh).
      expect(
        await adminDb.reviewDismissal.findFirst({
          where: { workItemId: mainCard.id },
          select: { subjectVersion: true, reasonMd: true, dismissedById: true },
        }),
      ).toEqual({ subjectVersion: mainV3, reasonMd: DISMISS_REASON, dismissedById: s.owner.id });
      await expect(dialog).toBeHidden();
      await expect(main(page).getByTestId('to-fix-banner')).toHaveCount(0, {
        timeout: FIRST_PAINT_MS,
      });
    });

    await chapter(
      'Back on To approve: Review dismissed by the person, with the reason',
      async () => {
        await awaitGate(mainCard, 'pull_request_approval', mainV3);
        await page.goto('/workbench?tab=approvals');
        const row = toApproveRow(page, mainCard);
        await expect(row.locator('[data-review-line]')).toHaveAttribute(
          'data-review-line',
          'review_dismissed',
          { timeout: FIRST_PAINT_MS },
        );
        await expect(row).toContainText(
          plain(rp.line.dismissed, { name: s.owner.name, reason: DISMISS_REASON }),
        );
        // The activity keeps every verdict: the first send-back, the pass, and the send-back
        // the dismissal answered.
        await page.goto(`/items/${mainCard.identifier}?activity=history`);
        await expect(main(page).locator('[id^="agent-verdict-"]')).toHaveCount(3, {
          timeout: FIRST_PAINT_MS,
        });
      },
    );
    await beat();

    // ── 7 · The author note ─────────────────────────────────────────────────
    await chapter('You opened every pull request: GitHub will not let you approve', async () => {
      await page.goto(`/items/${authored.identifier}`);
      const note = developmentSection(page).getByRole('note').filter({
        hasText: rp.authorNote.title,
      });
      await expect(note).toBeVisible({ timeout: FIRST_PAINT_MS });
      await note.scrollIntoViewIfNeeded();
      await expect(note).toContainText(rp.authorNote.body);
    });

    await chapter('A teammate opened one: no note', async () => {
      await page.goto(`/items/${mainCard.identifier}`);
      await expect(developmentSection(page).locator('[data-review-line]')).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(developmentSection(page).getByText(rp.authorNote.title)).toHaveCount(0);
    });
    await beat();

    // ── 8 · Each part wears its own badge; the story none ───────────────────
    const partOneV = versionOf([['partOne', headShaFor(PRS.partOne.number)]]);
    const partTwoV = versionOf([['partTwo', headShaFor(PRS.partTwo.number)]]);
    await chapter(
      'Both parts reviewed: each reads Reviewed, the story wears no badge',
      async () => {
        await awaitGate(partOne, 'pull_request_approval', partOneV);
        await submitVerdict(api, partOne, { verdict: 'approved', subjectVersion: partOneV });
        await awaitGate(partTwo, 'pull_request_approval', partTwoV);
        await submitVerdict(api, partTwo, { verdict: 'approved', subjectVersion: partTwoV });
        await page.goto(`/items/${partOne.identifier}`);
        await expect(main(page).locator('[data-reviewed-badge="reviewed"]').first()).toBeVisible({
          timeout: FIRST_PAINT_MS,
        });
        await page.goto(`/items/${story.identifier}`);
        await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible({
          timeout: FIRST_PAINT_MS,
        });
        await expect(main(page).locator('[data-reviewed-badge]')).toHaveCount(0);
      },
    );
    await beat();

    // ── 9 · Approve and merge to Done ───────────────────────────────────────
    await chapter('Approve and merge a reviewed part: Done, and no badge', async () => {
      await approveAndMerge(page, partOne, ['partOne']);
      await expect(main(page).locator('[data-reviewed-badge]')).toHaveCount(0);
    });

    await chapter('The record names the review it stood on', async () => {
      const line = main(page).getByTestId('approval-review-line');
      await expect(line).toHaveAttribute('data-review', 'reviewed', { timeout: FIRST_PAINT_MS });
      await expect(line).toHaveText(recordReviewed(rp, s.owner.name, PRS.partOne.number));
      await page.goto(`/items/${partOne.identifier}?activity=history`);
      await expect(main(page).locator('[id^="agent-verdict-"]').first()).toContainText(
        plain(rp.activity.passed, {
          agent: fill(rp.activity.agentOwn, { name: s.owner.name, harness: HARNESS }),
          commits: '',
        }).trim(),
        { timeout: FIRST_PAINT_MS },
      );
    });
    await beat();

    // ── 10 · Motir's hosted agent ───────────────────────────────────────────
    await chapter('Back on, with Motir’s hosted agent: Agent reviewing', async () => {
      await page.goto('/settings/project/approvals');
      await setReviewAgent(page, projectKey, true);
      await chooseSource(page, projectKey, 'hosted');
      const v = versionOf([['hostedReviewing', headShaFor(PRS.hostedReviewing.number)]]);
      await green(page, 'hostedReviewing', headShaFor(PRS.hostedReviewing.number));
      // The real job booted the hosted review run, and it is in flight.
      await bootedReview(reviewing, v);
      await page.goto('/boards');
      await expect(
        (await revealBoardCard(page, reviewing)).locator('[data-review-marker]'),
      ).toHaveAttribute('data-review-marker', 'agent_reviewing', { timeout: FIRST_PAINT_MS });
      await page.goto('/items');
      await expect(listRow(page, reviewing).locator('[data-review-marker]')).toHaveAttribute(
        'data-review-marker',
        'agent_reviewing',
        { timeout: FIRST_PAINT_MS },
      );
      await page.goto(`/items/${reviewing.identifier}`);
      await expect(main(page).locator('[data-review-header-marker]')).toContainText(
        rp.marker.reviewing,
        { timeout: FIRST_PAINT_MS },
      );
    });
    await beat();

    await chapter('A hosted review that could not run is aimed at you', async () => {
      writeHostedRunFixture({
        models: { ids: [DEFAULT_MODEL], default: DEFAULT_MODEL },
        mayRun: false,
      });
      await green(page, 'hostedCouldNotRun', headShaFor(PRS.hostedCouldNotRun.number));
      await expect
        .poll(
          async () => (await gateOf(couldNotRun, 'agent_review'))?.reviewUnavailableReason ?? null,
          {
            timeout: 60_000,
          },
        )
        .toBe('hosted_run_out_of_credits');
      await page.goto('/boards');
      const marker = (await revealBoardCard(page, couldNotRun)).locator('[data-review-marker]');
      await expect(marker).toHaveAttribute('data-review-marker', 'could_not_run', {
        timeout: FIRST_PAINT_MS,
      });
      await expect(marker).toHaveAttribute('data-review-loud', '');
      await expect(marker).toContainText(rp.marker.couldNotRun);
      await page.goto('/items');
      await expect(listRow(page, couldNotRun).locator('[data-review-marker]')).toHaveAttribute(
        'data-review-marker',
        'could_not_run',
        { timeout: FIRST_PAINT_MS },
      );
      await page.goto(`/items/${couldNotRun.identifier}`);
      await expect(main(page).locator('[data-review-header-marker]')).toContainText(
        rp.marker.couldNotRun,
        { timeout: FIRST_PAINT_MS },
      );
      await expect(
        developmentSection(page).getByRole('button', { name: ar.verb.reviewAgain }),
      ).toBeVisible();
      await expect(
        developmentSection(page).getByRole('button', {
          name: ar.verb.continueWithout,
          exact: true,
        }),
      ).toBeVisible();
      writeHostedRunFixture({
        models: { ids: [DEFAULT_MODEL], default: DEFAULT_MODEL },
        mayRun: true,
      });
    });
    await beat();

    await chapter(
      'Continue without the review, then approve: the record says skipped',
      async () => {
        await developmentSection(page)
          .getByRole('button', { name: ar.verb.continueWithout, exact: true })
          .click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: FIRST_PAINT_MS });
        await dialog.getByRole('button', { name: ar.verb.continueWithout, exact: true }).click();
        await dialog.getByLabel(ar.override.label).fill('Credits run out until the 1st.');
        const action = serverAction(page);
        await dialog.getByRole('button', { name: ar.override.proceed, exact: true }).click();
        expect((await action).status()).toBe(200);
        await closeOverlay(page);
        await approveAndMerge(page, couldNotRun, ['hostedCouldNotRun']);
        const line = main(page).getByTestId('approval-review-line');
        await expect(line).toHaveAttribute('data-review', 'skipped', { timeout: FIRST_PAINT_MS });
        await expect(line).toContainText(
          fill(rp.record.skipped, { name: s.owner.name, who: s.owner.name }),
        );
      },
    );
    await beat();

    // ── 11 · 中文 ────────────────────────────────────────────────────────────
    await page
      .context()
      .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', baseURL).href }]);

    await chapter('中文 — Settings and the markers', async () => {
      await page.goto('/settings/project/approvals');
      await expect(reviewAgentSwitch(page, zra.title)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await main(page).locator('#review-agent').scrollIntoViewIfNeeded();
      await expect(main(page)).toContainText(zra.source.label);
      await expect(sourceRadio(page, zra.source.hosted)).toHaveAttribute('aria-checked', 'true');
      await expect(main(page)).toContainText(zra.source.own);
      await expect(main(page)).not.toContainText('approvals.reviewAgent');

      // By now the hosted run on `reviewing` has ended with no verdict (the lane's run
      // seam answers none), so the card reads *Review could not run* — in Chinese.
      await expect
        .poll(
          async () => (await gateOf(reviewing, 'agent_review'))?.reviewUnavailableReason ?? null,
          {
            timeout: 60_000,
          },
        )
        .toBe('no_verdict');
      await page.goto('/boards');
      const marker = (await revealBoardCard(page, reviewing)).locator('[data-review-marker]');
      await expect(marker).toHaveAttribute('data-review-marker', 'could_not_run', {
        timeout: FIRST_PAINT_MS,
      });
      await expect(marker).toContainText(zrp.marker.couldNotRun);
      await expect(main(page)).not.toContainText(rp.marker.couldNotRun);
    });

    await chapter('中文 — the Reviewed badge and its card', async () => {
      await page.goto(`/items/${partTwo.identifier}`);
      const badge = main(page).locator('[data-reviewed-badge="reviewed"]').first();
      await expect(badge).toContainText(zrp.badge.reviewed, { timeout: FIRST_PAINT_MS });
      await badge.focus();
      await expect(main(page).getByTestId('reviewed-card')).toContainText(
        fill(zrp.badge.card.own, { name: s.owner.name }),
      );
      await page.keyboard.press('Escape');
      await expect(main(page)).not.toContainText('approvalGate.reviewPath');
    });

    await chapter('中文 — the review line, the activity and the record', async () => {
      await page.goto('/workbench?tab=approvals');
      const row = toApproveRow(page, mainCard, zh);
      await expect(row).toContainText(
        plain(zrp.line.dismissed, { name: s.owner.name, reason: DISMISS_REASON }),
        { timeout: FIRST_PAINT_MS },
      );
      await expect(row).not.toContainText('Review dismissed');
      await page.goto(`/items/${mainCard.identifier}?activity=history`);
      await expect(main(page).locator('[id^="agent-verdict-"]').first()).toContainText(
        fill(zrp.activity.agentOwn, { name: s.owner.name, harness: HARNESS }),
        { timeout: FIRST_PAINT_MS },
      );
      await page.goto(`/items/${partOne.identifier}`);
      await expect(main(page).getByTestId('approval-review-line')).toHaveText(
        recordReviewed(zrp, s.owner.name, PRS.partOne.number),
        { timeout: FIRST_PAINT_MS },
      );
    });
    await beat();

    await chapter('中文 — the author note and the Dismiss dialog', async () => {
      await page.goto(`/items/${authored.identifier}`);
      await expect(developmentSection(page, zh.github.development.title)).toContainText(
        zrp.authorNote.title,
        { timeout: FIRST_PAINT_MS },
      );
      // A gate-off send-back to read the dialog on: the switch's own door, then the verdict.
      const off = await page.request.patch(`/api/projects/${projectKey}/approval-gates`, {
        data: { reviewAgentEnabled: false },
      });
      expect(off.status()).toBe(200);
      const authoredV = versionOf([['authored', headShaFor(PRS.authored.number)]]);
      await submitVerdict(api, authored, {
        verdict: 'changes_requested',
        subjectVersion: authoredV,
        findingsMd: SEND_BACK_FINDINGS,
      });
      await page.reload();
      const control = main(page).getByTestId('dismiss-review');
      await expect(control).toBeVisible({ timeout: FIRST_PAINT_MS });
      await control.scrollIntoViewIfNeeded();
      await control.getByRole('button', { name: zrp.dismiss.button, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: zrp.dismiss.title });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(zrp.dismiss.reasonLabel);
      await expect(
        dialog.getByRole('button', { name: zrp.dismiss.confirm, exact: true }),
      ).toBeDisabled();
      await expect(dialog).not.toContainText('approvalGate.reviewPath');
      await beat();
      await dialog.getByRole('button', { name: zrp.dismiss.cancel, exact: true }).click();
      await expect(dialog).toBeHidden();
    });

    await chapter('中文 at phone width — the board card and the To approve row fit', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/boards');
      const card = await revealBoardCard(page, partTwo);
      await expect(card).toBeVisible({ timeout: FIRST_PAINT_MS });
      await card.scrollIntoViewIfNeeded();
      await fitsItsBox(card);
      await page.goto('/workbench?tab=approvals');
      const row = toApproveRow(page, mainCard, zh);
      await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
      await row.scrollIntoViewIfNeeded();
      await fitsItsBox(row);
    });
    await beat();

    await api.dispose();
  });
});
