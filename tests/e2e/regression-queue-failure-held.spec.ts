import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { E2E_INSTALLATION_ID } from './_helpers/github-const';
import { linkPr } from './_helpers/pr-link';
import { closeOverlay, openDevelopmentOverlay } from './_helpers/development-decide';
import {
  WEB_REPO,
  headShaFor,
  seedApproveAndMerge,
  type ApproveAndMergeSeed,
  type SeededCard,
} from './_helpers/approve-and-merge-seed';
import type { GithubMergeControl } from '@/lib/test-github-merge-mock';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// A MERGE-QUEUE FAILURE ASKS NOBODY TO APPROVE AGAIN — THE ACCEPTANCE RECEIPT (Story
// MOTIR-6587 · Subtask MOTIR-6598; `docs/decisions/approval-gates.md` § 4 FIFTH AMENDMENT;
// `design/github/approve-and-merge--queue-failure--held.mock.html`, design § 31).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// An approved card's pull request joins its merge queue, and the queue throws it out
// because a check FAILED. Before this story the card came straight back to To approve with
// *Queue again* as a second approval of the very commits that failed. Now it drops to
// Implemented, held at that head: the pull request's row names the failed check, `motir
// fix` is the way forward, there is no *Queue again* and no Approve anywhere, and To
// approve does not list it. A push whose checks go green brings back exactly ONE question,
// and approving it queues and merges. A deliberate MANUAL removal is unchanged — it still
// re-asks with *Queue again*. And the held card reads in Chinese.
//
// ── THE SEAMS — all shipped, all reused ─────────────────────────────────────
//
//   * GitHub's enqueue — `E2E_TEST_GITHUB_MERGE`, with the repository marked as requiring a
//     merge queue, so every press ENQUEUES.
//   * The queue's deliveries — SIGNED `merge_group`, `pull_request` `dequeued` and
//     `check_run` bodies to the real `/api/github/webhook` route, from the REAL deliveries
//     MOTIR-5627 captured (`tests/fixtures/github/merge-queue/`). The `MANUAL` body is the
//     captured failure body with `reason` set to `MANUAL`, the published enum's spelling.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's response, a server action's response, or a
// row's / rail's text. The page has no live channel, so after each webhook the spec RELOADS.
//
// ⚠️ THE 15xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 600_000 });

const PRS = {
  held: { number: 15101 },
  manual: { number: 15201 },
  zh: { number: 15301 },
} as const;
type Scenario = keyof typeof PRS;

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;
const WEB = `${WEB_REPO.owner}/${WEB_REPO.name}`;
const GROUP_SHA = '6e1ec7ed6e1ec7ed6e1ec7ed6e1ec7ed6e1ec7ed';
const CHECK_URL = 'https://github.com/motir-projects-e2e/amerge-web/actions/runs/16/job/1';
const pra = en.approvalGate.pullRequestApproval;
const fix = en.github.development.fix;

const RICH_TAGS = ['<b>', '</b>', '<code>', '</code>', '<prs></prs>'] as const;
const plain = (text: string, vars: Record<string, string> = {}) =>
  RICH_TAGS.reduce(
    (out, tag) => out.split(tag).join(''),
    text.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`),
  );

const prName = (number: number) => `${WEB} · #${number}`;
const headRefFor = (card: SeededCard, number: number) =>
  `held/${card.identifier.toLowerCase()}-${number}`;
const installation = { id: Number(E2E_INSTALLATION_ID) };
const repository = { id: Number(WEB_REPO.providerRepoId) };

function captured(name: string): Record<string, unknown> {
  const file = join(process.cwd(), 'tests/fixtures/github/merge-queue', `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')).payload as Record<string, unknown>;
}
/** The failed check's own name, as the captured delivery carries it. */
const FAILED_CHECK = (captured('check-run-failed-merge-group')['check_run'] as { name: string })
  .name;

// ── The page ────────────────────────────────────────────────────────────────

const developmentCard = (page: Page, title = en.github.development.title): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });

const prRow = (page: Page, number: number, title?: string): Locator =>
  developmentCard(page, title)
    .locator('li')
    .filter({ hasText: prName(number) });

const fixPart = (page: Page, label: string = fix.aria.part): Locator =>
  page.getByRole('group', { name: label });

const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

const approvalRows = (page: Page, card: SeededCard): Locator =>
  page
    .getByRole('table', { name: en.workbench.tabs.toApprove })
    .getByTestId(/^approval-row-/)
    .filter({ hasText: card.identifier });

const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

async function show(target: Locator): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
}

async function open(page: Page, card: SeededCard, title?: string): Promise<void> {
  await page.goto(`/items/${card.identifier}`);
  await expect(developmentCard(page, title)).toHaveCount(1, { timeout: 60_000 });
}

// ── The deliveries ──────────────────────────────────────────────────────────

async function deliver(page: Page, event: string, payload: unknown, what: string): Promise<void> {
  const res = await postSignedWebhook(page.request, event, payload);
  expect(res.status(), `${what} → ${(await res.text()).slice(0, 300)}`).toBe(200);
}

async function deliverGreen(
  page: Page,
  card: SeededCard,
  scenario: Scenario,
  headSha = headShaFor(PRS[scenario].number),
  link = true,
): Promise<void> {
  const { number } = PRS[scenario];
  const headRef = headRefFor(card, number);
  if (link) {
    await deliver(
      page,
      'pull_request',
      pullRequestPayload({
        action: 'opened',
        number,
        title: card.title,
        headRef,
        state: 'open',
        merged: false,
        repo: WEB_REPO,
      }),
      `open #${number}`,
    );
    await linkPr(page, { workItemId: card.id, repo: WEB_REPO, number, headRef });
  }
  await deliver(
    page,
    'check_suite',
    checkSuitePayload({
      conclusion: 'success',
      headSha,
      prNumber: number,
      headBranch: headRef,
      repo: WEB_REPO,
    }),
    `green #${number} at ${headSha.slice(0, 7)}`,
  );
}

function checksRequested(number: number): Record<string, unknown> {
  const body = captured('merge-group-checks-requested');
  const group = body['merge_group'] as Record<string, unknown>;
  return {
    ...body,
    installation,
    repository,
    merge_group: {
      ...group,
      head_sha: GROUP_SHA,
      head_ref: `refs/heads/gh-readonly-queue/main/pr-${number}-${group['base_sha'] as string}`,
    },
  };
}

function dequeued(number: number, reason: string): Record<string, unknown> {
  const body = captured('dequeued-ci-failure');
  const pr = structuredClone(body['pull_request']) as Record<string, unknown>;
  return {
    ...body,
    reason,
    number,
    installation,
    repository,
    pull_request: {
      ...pr,
      number,
      head: { ...(pr['head'] as Record<string, unknown>), sha: headShaFor(number) },
    },
  };
}

function failedGroupCheck(): Record<string, unknown> {
  const body = captured('check-run-failed-merge-group');
  return {
    ...body,
    installation,
    repository,
    check_run: {
      ...(body['check_run'] as Record<string, unknown>),
      head_sha: GROUP_SHA,
      html_url: CHECK_URL,
    },
  };
}

/** The queue tests the group, removes the pull request for a FAILURE, and the check
 *  reports — in the order the capture shows them arriving. */
async function queueFails(page: Page, number: number): Promise<void> {
  await deliver(page, 'merge_group', checksRequested(number), 'the queue tests the group');
  await deliver(page, 'pull_request', dequeued(number, 'CI_FAILURE'), 'the queue removes it');
  await deliver(page, 'check_run', failedGroupCheck(), 'the failed check reports');
}

// Every approval is pressed in the APPROVAL OVERLAY, opened from the Development band
// (MOTIR-6323) — the section hands the decision over like every other section.
async function pressApproveAndMerge(page: Page): Promise<void> {
  const dev = await openDevelopmentOverlay(page);
  await dev.getByRole('button', { name: pra.verb.approveAndMerge, exact: true }).click();
  const action = serverAction(page);
  await dev
    .getByRole('button', {
      name: en.approvalGate.confirm.proceed.replace('{verb}', pra.verb.approveAndMerge),
      exact: true,
    })
    .click();
  expect((await action).status()).toBe(200);
  await closeOverlay(page);
}

async function approvedIntoTheQueue(page: Page, card: SeededCard, scenario: Scenario) {
  await open(page, card);
  await pressApproveAndMerge(page);
  await expect(
    prRow(page, PRS[scenario].number).getByText(pra.outcome.queued, { exact: true }),
  ).toBeVisible();
  await expect(statusCard(page)).toContainText(en.approvalGate.state.approved);
}

test.describe('a merge-queue failure asks nobody to approve again', () => {
  let seed: ApproveAndMergeSeed;
  let held: SeededCard;
  let manual: SeededCard;
  let inZh: SeededCard;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    seed = await seedApproveAndMerge(Date.now().toString(36));
    held = seed.merged;
    manual = seed.refused;
    inZh = seed.queued;
    writeFileSync(JOURNAL_PATH, '');
    const control: GithubMergeControl = { repositories: [WEB], mergeQueueRepositories: [WEB] };
    writeFileSync(CONTROL_PATH, JSON.stringify(control));

    await signIn(page, seed.ownerEmail, seed.password);
    await deliverGreen(page, held, 'held');
    await deliverGreen(page, manual, 'manual');
    await deliverGreen(page, inZh, 'zh');
  });

  test('held at Implemented with motir fix, nothing to approve, and ONE question after a green push', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6587');
    const number = PRS.held.number;
    const heldLine = plain(pra.exit.failed.checks, { pr: prName(number), check: FAILED_CHECK });

    await chapter('Approved, and in the merge queue', async () => {
      await approvedIntoTheQueue(page, held, 'held');
      await show(prRow(page, number));
    });
    await beat();

    await chapter('The queue FAILS it — the card is held at Implemented', async () => {
      await queueFails(page, number);
      await page.reload();
      await expect(statusCard(page)).toContainText('Implemented', { timeout: 60_000 });
      const row = prRow(page, number);
      await expect(row.getByText(pra.outcome.leftQueue, { exact: true })).toBeVisible();
      // Nothing to press: no *Queue again*, no Approve.
      await expect(row.getByRole('button', { name: pra.outcome.queueAgain })).toHaveCount(0);
      await expect(page.getByRole('button', { name: pra.verb.approveAndMerge })).toHaveCount(0);
      // The failed check is NAMED, and why nobody is asked.
      await expect(developmentCard(page)).toContainText(heldLine);
      await expect(developmentCard(page)).toContainText(
        plain(pra.exit.failed.held, { key: held.identifier }),
      );
      await show(row);
    });
    await beat();

    await chapter('motir fix is the way forward', async () => {
      const part = fixPart(page);
      await expect(part).toContainText(`${prName(number)} left the merge queue.`);
      await expect(part).toContainText(`motir fix ${held.identifier}`);
      await expect(part.getByText(plain(fix.which.failed), { exact: true })).toBeVisible();
      await show(part);
    });
    await beat();

    await chapter('To approve holds nothing for it', async () => {
      await page.goto('/workbench?tab=approvals');
      // The table has loaded — the other cards' rows are in it — and this card is not.
      await expect(page.getByRole('table', { name: en.workbench.tabs.toApprove })).toBeVisible({
        timeout: 60_000,
      });
      await expect(approvalRows(page, held)).toHaveCount(0);
      await beat();
      // Opened from its deep link, the overlay shows the same: nothing to press.
      await page.goto(
        `/workbench?tab=approvals&approval=${held.identifier}&approvalKind=pull_request_approval`,
      );
      const dialog = page.getByRole('dialog', { name: `Pull requests for ${held.identifier}` });
      await expect(dialog).toBeVisible({ timeout: 60_000 });
      await expect(dialog).toContainText(heldLine);
      await expect(dialog.getByRole('button', { name: pra.outcome.queueAgain })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: pra.verb.approveAndMerge })).toHaveCount(0);
      await beat();
      await closeOverlay(page);
    });
    await beat();

    await chapter('A push goes green — ONE question comes back', async () => {
      const newHead = 'feed' + headShaFor(number).slice(4);
      await deliverGreen(page, held, 'held', newHead, false);
      await open(page, held);
      await expect(statusCard(page)).toContainText('In Review', { timeout: 60_000 });
      await page.goto('/workbench?tab=approvals');
      await expect(approvalRows(page, held)).toHaveCount(1, { timeout: 60_000 });
      await show(approvalRows(page, held));
    });
    await beat();

    await chapter('Approving it queues the new commits, and the merge lands', async () => {
      await open(page, held);
      await pressApproveAndMerge(page);
      await expect(
        prRow(page, number).getByText(pra.outcome.queued, { exact: true }),
      ).toBeVisible();
      await deliver(
        page,
        'pull_request',
        pullRequestPayload({
          action: 'closed',
          number,
          title: held.title,
          headRef: headRefFor(held, number),
          state: 'closed',
          merged: true,
          repo: WEB_REPO,
        }),
        `the queue merges #${number}`,
      );
      await page.reload();
      await expect(statusCard(page)).toContainText('Done', { timeout: 60_000 });
      await show(statusCard(page));
    });
    await beat();

    await chapter('A MANUAL removal is unchanged: In Review, with Queue again', async () => {
      const n = PRS.manual.number;
      await approvedIntoTheQueue(page, manual, 'manual');
      await deliver(page, 'pull_request', dequeued(n, 'MANUAL'), 'someone removes it');
      await page.reload();
      await expect(statusCard(page)).toContainText('In Review', { timeout: 60_000 });
      await expect(
        prRow(page, n).getByText(pra.outcome.removedFromQueue, { exact: true }),
      ).toBeVisible();
      const dev = await openDevelopmentOverlay(page);
      await expect(
        dev
          .locator('li')
          .filter({ hasText: prName(n) })
          .getByRole('button', {
            name: pra.outcome.queueAgain,
          }),
      ).toBeVisible();
      await beat();
      await closeOverlay(page);
    });
    await beat();

    await chapter('The held card, in Chinese', async () => {
      const n = PRS.zh.number;
      await approvedIntoTheQueue(page, inZh, 'zh');
      await queueFails(page, n);
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      await open(page, inZh, zh.github.development.title);
      const zpra = zh.approvalGate.pullRequestApproval;
      await expect(developmentCard(page, zh.github.development.title)).toContainText(
        plain(zpra.exit.failed.checks, { pr: prName(n), check: FAILED_CHECK }),
      );
      const part = fixPart(page, zh.github.development.fix.aria.part);
      await expect(part).toContainText(`motir fix ${inZh.identifier}`);
      await expect(
        part.getByText(plain(zh.github.development.fix.which.failed), { exact: true }),
      ).toBeVisible();
      await show(part);
    });
    await beat();
  });
});
