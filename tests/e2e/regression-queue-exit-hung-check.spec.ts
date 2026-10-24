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
import { runReconcileTick } from './_helpers/reconcile-tick';
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

// A MERGE-QUEUE EXIT CAUSED BY A HUNG CHECK RE-ASKS — THE ACCEPTANCE RECEIPT (Story
// MOTIR-6843 · Subtask MOTIR-6851; `docs/decisions/approval-gates.md` § 4 SIXTH AMENDMENT;
// `design/github/approve-and-merge--queue-exit--check-cancelled.mock.html`, design § 32).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// An approved card's pull request joins its merge queue, and the queue throws it out
// because a check was CANCELLED — a job that hung, not code that failed. Before this story
// that read exactly like a failure: the card dropped to Implemented, the row said the check
// FAILED, and `motir fix` was the only way forward. Now the card comes back to In Review,
// the row names the check and says it was cancelled, *Queue again* is the approval, and
// pressing it merges. A genuine failure beside it is still held at Implemented. A card
// whose check result never reached Motir is put right by the reconcile tick. And the
// cancelled row reads in Chinese.
//
// ── THE SEAMS — shipped, plus the two this card adds ───────────────────────
//
//   * GitHub's enqueue — `E2E_TEST_GITHUB_MERGE`, the repository requiring a merge queue.
//   * The queue's deliveries — SIGNED `merge_group`, `pull_request` `dequeued` and
//     `check_run` bodies to the real webhook route, from the REAL deliveries MOTIR-5627
//     captured, with the `check_run`'s `conclusion` set to what the chapter needs.
//   * NEW: the merge seam answers a commit's check runs when its control file names that
//     commit (`commitCheckRuns`), and `runReconcileTick` runs the SHIPPED reconcile pass
//     in-process past its quiet window (`tests/e2e/_helpers/reconcile-tick.ts`).
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's response, a server action's response, the
// tick's own return, or a row's / rail's text. The page has no live channel, so after each
// delivery the spec RELOADS.
//
// ⚠️ THE 24xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 600_000 });

const PRS = {
  cancelled: { number: 24101 },
  genuine: { number: 24201 },
  lost: { number: 24301 },
  zh: { number: 24401 },
} as const;
type Scenario = keyof typeof PRS;

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;
const WEB = `${WEB_REPO.owner}/${WEB_REPO.name}`;
const CHECK_URL = 'https://github.com/motir-projects-e2e/amerge-web/actions/runs/24/job/1';
const pra = en.approvalGate.pullRequestApproval;
const fix = en.github.development.fix;

/** Each scenario's merge group gets a commit of its own — distinct from the pull request's
 *  head (`headShaFor` pads with `0`), so one check never names two. */
const groupShaFor = (number: number) => number.toString(16).padStart(8, 'a').repeat(5);

const RICH_TAGS = ['<b>', '</b>', '<code>', '</code>', '<prs></prs>'] as const;
const plain = (text: string, vars: Record<string, string> = {}) =>
  RICH_TAGS.reduce(
    (out, tag) => out.split(tag).join(''),
    text.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`),
  );

const prName = (number: number) => `${WEB} · #${number}`;
const headRefFor = (card: SeededCard, number: number) =>
  `hung/${card.identifier.toLowerCase()}-${number}`;
const installation = { id: Number(E2E_INSTALLATION_ID) };
const repository = { id: Number(WEB_REPO.providerRepoId) };

function captured(name: string): Record<string, unknown> {
  const file = join(process.cwd(), 'tests/fixtures/github/merge-queue', `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')).payload as Record<string, unknown>;
}
/** The queue's check, by the name the captured delivery carries. */
const CHECK = (captured('check-run-failed-merge-group')['check_run'] as { name: string }).name;

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

const tabRows = (page: Page, tab: string, card: SeededCard): Locator =>
  page.getByRole('table', { name: tab }).getByRole('row').filter({ hasText: card.identifier });

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

function writeControl(extra: Partial<GithubMergeControl> = {}): void {
  const control: GithubMergeControl = {
    repositories: [WEB],
    mergeQueueRepositories: [WEB],
    ...extra,
  };
  writeFileSync(CONTROL_PATH, JSON.stringify(control));
}

// ── The deliveries ──────────────────────────────────────────────────────────

async function deliver(page: Page, event: string, payload: unknown, what: string): Promise<void> {
  const res = await postSignedWebhook(page.request, event, payload);
  expect(res.status(), `${what} → ${(await res.text()).slice(0, 300)}`).toBe(200);
}

async function deliverGreen(page: Page, card: SeededCard, scenario: Scenario): Promise<void> {
  const { number } = PRS[scenario];
  const headRef = headRefFor(card, number);
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
  await deliver(
    page,
    'check_suite',
    checkSuitePayload({
      conclusion: 'success',
      headSha: headShaFor(number),
      prNumber: number,
      headBranch: headRef,
      repo: WEB_REPO,
    }),
    `green #${number}`,
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
      head_sha: groupShaFor(number),
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

/** The group's check completing with GitHub's own `conclusion`. */
function groupCheck(number: number, conclusion: string): Record<string, unknown> {
  const body = captured('check-run-failed-merge-group');
  return {
    ...body,
    installation,
    repository,
    check_run: {
      ...(body['check_run'] as Record<string, unknown>),
      id: number,
      head_sha: groupShaFor(number),
      html_url: CHECK_URL,
      conclusion,
      pull_requests: [],
    },
  };
}

/** The queue tests the group, the check ends with `conclusion`, the queue removes it. */
async function queueEjects(page: Page, number: number, conclusion: string): Promise<void> {
  await deliver(page, 'merge_group', checksRequested(number), 'the queue tests the group');
  await deliver(page, 'check_run', groupCheck(number, conclusion), `the check ends ${conclusion}`);
  await deliver(page, 'pull_request', dequeued(number, 'CI_FAILURE'), 'the queue removes it');
}

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

/** The re-asked row's *Queue again*, inside the approval overlay. */
const queueAgainIn = (dev: Locator, number: number): Locator =>
  dev
    .locator('li')
    .filter({ hasText: prName(number) })
    .getByRole('button', { name: pra.outcome.queueAgain });

test.describe('a merge-queue exit caused by a hung check re-asks', () => {
  let seed: ApproveAndMergeSeed;
  let cancelled: SeededCard;
  let genuine: SeededCard;
  let lost: SeededCard;
  let inZh: SeededCard;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    seed = await seedApproveAndMerge(Date.now().toString(36));
    cancelled = seed.merged;
    genuine = seed.refused;
    lost = seed.queued;
    inZh = seed.zh;
    writeFileSync(JOURNAL_PATH, '');
    writeControl();

    await signIn(page, seed.ownerEmail, seed.password);
    await deliverGreen(page, cancelled, 'cancelled');
    await deliverGreen(page, genuine, 'genuine');
    await deliverGreen(page, lost, 'lost');
    await deliverGreen(page, inZh, 'zh');
  });

  test('a cancelled check re-asks with Queue again, a failure still holds, and the tick settles a lost result', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6843');
    const n = PRS.cancelled.number;
    const cancelledLine = plain(pra.exit.hung.cancelled, { pr: prName(n), check: CHECK });

    await chapter('Approved, and in the merge queue', async () => {
      await approvedIntoTheQueue(page, cancelled, 'cancelled');
      await show(prRow(page, n));
    });
    await beat();

    await chapter('The queue’s check is CANCELLED — the card is asked again', async () => {
      await queueEjects(page, n, 'cancelled');
      await page.reload();
      await expect(statusCard(page)).toContainText('In Review', { timeout: 60_000 });
      const row = prRow(page, n);
      await expect(row.getByText(pra.outcome.removedFromQueue, { exact: true })).toBeVisible();
      // No `motir fix`: nothing in the code needs repairing.
      await expect(fixPart(page)).toHaveCount(0);
      await show(row);
    });
    await beat();

    await chapter('The check is named as CANCELLED, and Queue again is the approval', async () => {
      const dev = await openDevelopmentOverlay(page);
      // The check is NAMED, it was cancelled, and nothing says it failed.
      await expect(dev).toContainText(cancelledLine, { timeout: 60_000 });
      await expect(dev).toContainText(plain(pra.exit.hung.reasked));
      await expect(dev).not.toContainText(
        plain(pra.exit.failed.checks, { pr: prName(n), check: CHECK }),
      );
      await expect(
        dev.getByRole('link', { name: plain(pra.exit.openStoppedCheck, { check: CHECK }) }),
      ).toBeVisible();
      await expect(queueAgainIn(dev, n)).toBeVisible();
      await beat();
      await closeOverlay(page);
      await page.goto('/workbench?tab=approvals');
      await expect(tabRows(page, en.workbench.tabs.toApprove, cancelled)).toHaveCount(1, {
        timeout: 60_000,
      });
      await show(tabRows(page, en.workbench.tabs.toApprove, cancelled));
    });
    await beat();

    await chapter('A check that genuinely FAILED is still held at Implemented', async () => {
      const g = PRS.genuine.number;
      await approvedIntoTheQueue(page, genuine, 'genuine');
      await queueEjects(page, g, 'failure');
      await page.reload();
      await expect(statusCard(page)).toContainText('Implemented', { timeout: 60_000 });
      await expect(prRow(page, g).getByText(pra.outcome.leftQueue, { exact: true })).toBeVisible();
      await expect(developmentCard(page)).toContainText(
        plain(pra.exit.failed.checks, { pr: prName(g), check: CHECK }),
      );
      await expect(fixPart(page)).toContainText(`motir fix ${genuine.identifier}`);
      await expect(page.getByRole('button', { name: pra.verb.approveAndMerge })).toHaveCount(0);
      await show(fixPart(page));
    });
    await beat();

    await chapter('To fix lists the failure — and not the cancelled card', async () => {
      await page.goto('/workbench?tab=to-fix');
      // The failed card's row is the authoritative sign the tab has loaded.
      await expect(tabRows(page, en.workbench.tabs.toFix, genuine)).toHaveCount(1, {
        timeout: 60_000,
      });
      await expect(tabRows(page, en.workbench.tabs.toFix, cancelled)).toHaveCount(0);
      await show(tabRows(page, en.workbench.tabs.toFix, genuine));
      await beat();
      await page.goto('/workbench?tab=approvals');
      await expect(tabRows(page, en.workbench.tabs.toApprove, cancelled)).toHaveCount(1, {
        timeout: 60_000,
      });
      await expect(tabRows(page, en.workbench.tabs.toApprove, genuine)).toHaveCount(0);
    });
    await beat();

    await chapter('Queue again — the queue passes it, and the merge lands', async () => {
      await open(page, cancelled);
      const dev = await openDevelopmentOverlay(page);
      // On the RE-ASKED gate the row press is an approval, so it confirms first.
      await queueAgainIn(dev, n).click();
      const action = serverAction(page);
      await dev
        .getByRole('button', {
          name: en.approvalGate.confirm.proceed.replace('{verb}', pra.outcome.queueAgain),
          exact: true,
        })
        .click();
      expect((await action).status()).toBe(200);
      await closeOverlay(page);
      await page.reload();
      await expect(prRow(page, n).getByText(pra.outcome.queued, { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await deliver(page, 'pull_request', dequeued(n, 'MERGE'), 'the queue passes it');
      await deliver(
        page,
        'pull_request',
        pullRequestPayload({
          action: 'closed',
          number: n,
          title: cancelled.title,
          headRef: headRefFor(cancelled, n),
          state: 'closed',
          merged: true,
          repo: WEB_REPO,
        }),
        `the queue merges #${n}`,
      );
      await page.reload();
      await expect(statusCard(page)).toContainText('Done', { timeout: 60_000 });
      await show(statusCard(page));
    });
    await beat();

    await chapter('A check result that never arrived is settled by the tick', async () => {
      const l = PRS.lost.number;
      await approvedIntoTheQueue(page, lost, 'lost');
      // The queue tests the group and removes the pull request — and the check's own
      // delivery never comes.
      await deliver(page, 'merge_group', checksRequested(l), 'the queue tests the group');
      await deliver(page, 'pull_request', dequeued(l, 'CI_FAILURE'), 'the queue removes it');
      await page.reload();
      await expect(statusCard(page)).toContainText('Implemented', { timeout: 60_000 });
      await show(prRow(page, l));
      await beat();

      // GitHub knows the check was cancelled; one reconcile pass asks it.
      writeControl({
        commitCheckRuns: {
          [`${WEB}@${groupShaFor(l)}`]: [{ name: CHECK, conclusion: 'cancelled' }],
        },
      });
      const summary = await runReconcileTick();
      expect(summary.queueExitsResolved).toBe(1);

      await page.reload();
      await expect(statusCard(page)).toContainText('In Review', { timeout: 60_000 });
      const dev = await openDevelopmentOverlay(page);
      await expect(dev).toContainText(
        plain(pra.exit.hung.cancelled, { pr: prName(l), check: CHECK }),
        { timeout: 60_000 },
      );
      await expect(queueAgainIn(dev, l)).toBeVisible();
      await beat();
      await closeOverlay(page);
    });
    await beat();

    await chapter('The cancelled check, in Chinese', async () => {
      const z = PRS.zh.number;
      await approvedIntoTheQueue(page, inZh, 'zh');
      await queueEjects(page, z, 'cancelled');
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      await open(page, inZh, zh.github.development.title);
      const zpra = zh.approvalGate.pullRequestApproval;
      const dev = await openDevelopmentOverlay(page, zh);
      await expect(dev).toContainText(
        plain(zpra.exit.hung.cancelled, { pr: prName(z), check: CHECK }),
        { timeout: 60_000 },
      );
      await expect(dev).toContainText(plain(zpra.exit.hung.reasked));
      await expect(
        dev
          .locator('li')
          .filter({ hasText: prName(z) })
          .getByRole('button', { name: zpra.outcome.queueAgain }),
      ).toBeVisible();
      await beat();
      await closeOverlay(page);
    });
    await beat();
  });
});
