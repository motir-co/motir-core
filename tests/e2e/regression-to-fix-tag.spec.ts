import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { E2E_INSTALLATION_ID } from './_helpers/github-const';
import { linkPr } from './_helpers/pr-link';
import { closeOverlay, openDevelopmentOverlay } from './_helpers/development-decide';
import { gotoLoadedBoard } from './_helpers/board';
import {
  WEB_REPO,
  headShaFor,
  seedApproveAndMerge,
  type ApproveAndMergeSeed,
  type SeededCard,
} from './_helpers/approve-and-merge-seed';
import { workItemsService } from '@/lib/services/workItemsService';
import type { GithubMergeControl } from '@/lib/test-github-merge-mock';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// A STUCK WORK ITEM LOOKS STUCK WHEREVER IT IS LISTED — THE ACCEPTANCE RECEIPT (Story
// MOTIR-6589 · Subtask MOTIR-6613; `design/work-items/to-fix--tag-and-banner.mock.html`,
// design § *The TO FIX tag and banner (MOTIR-6608)*).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Any member browsing the project — not only the card's owner — sees at a glance which cards
// are stuck until something is repaired. Two cards are stuck: one FAILED IN THE MERGE QUEUE,
// and one CONFLICTS WITH main while its checks are GREEN (the case the CI badge alone reads as
// healthy). Both wear the red To fix tag on the /items List and Tree, on the board and in the
// quick view; the item page explains the reason in a sentence and hands over `motir fix <KEY>`
// with a link down to the pull requests; the Advanced filter lists exactly the stuck cards and
// narrows them by reason. Then a push goes green on the queue card: after a reload its tag and
// banner are gone everywhere, while the conflicting card still wears its tag. All of it reads
// in Chinese.
//
// ── EVERY REASON ARRIVES THROUGH A REAL SEAM ────────────────────────────────
//
// Nothing here writes `fixReason`. Each is the shipped recompute answering a real event:
//
//   Failed in the queue  a signed `pull_request` `dequeued` with reason `CI_FAILURE`, at the
//                        pull request's head (the captured MOTIR-5627 body)
//   Conflicts with main  the approve-and-merge PRESS, which reads the host's mergeability (the
//                        merge seam, answering `dirty`), stores it and withdraws the question
//
// and the repair is a signed green `check_suite` at a NEW head — a push whose build passed.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's response, a server action's response, a row's
// text or attribute, or a read of the stored column. There is no `waitForTimeout`.
//
// ⚠️ THE 23xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).
//
// ── THE LANE ────────────────────────────────────────────────────────────────
//
// The acceptance lane, for the RECEIPT and for the merge seam the conflict needs (the lane
// wires `E2E_TEST_GITHUB_MERGE`'s control file).

test.describe.configure({ timeout: 600_000 });

const PRS = {
  queue: { number: 23001 },
  conflict: { number: 23002 },
} as const;
type Scenario = keyof typeof PRS;

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;
const WEB = `${WEB_REPO.owner}/${WEB_REPO.name}`;

const installation = { id: Number(E2E_INSTALLATION_ID) };
const repository = { id: Number(WEB_REPO.providerRepoId) };
const headRefFor = (card: SeededCard, scenario: Scenario) =>
  `fix/${card.identifier.toLowerCase()}-${PRS[scenario].number}`;
/** A second head for the same pull request — what a push produces. */
const pushedHead = (scenario: Scenario) => 'f00d' + headShaFor(PRS[scenario].number).slice(4);

/** Strip the catalogue's rich tags and fill its placeholders — the text a reader sees. */
const plain = (text: string, vars: Record<string, string> = {}) => {
  let stripped = text;
  for (let previous = ''; previous !== stripped; ) {
    previous = stripped;
    stripped = stripped.replace(/<\/?[a-z]+>/g, '');
  }
  return stripped.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
};

function captured(name: string): Record<string, unknown> {
  const file = join(process.cwd(), 'tests/fixtures/github/merge-queue', `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')).payload as Record<string, unknown>;
}

// ── The page ────────────────────────────────────────────────────────────────

/** One `/items` row — found the way a reader finds it, by the item key it displays. */
const itemRow = (page: Page, card: SeededCard) =>
  page.getByRole('row').filter({ hasText: card.identifier });
/** The glyph form of the tag inside a row. */
const rowTag = (page: Page, card: SeededCard) => itemRow(page, card).locator('[data-to-fix]');
/** A board card is one `<button>` named by its key. */
const boardCard = (page: Page, card: SeededCard) =>
  page.getByRole('button', { name: new RegExp(card.identifier) });
/** The item page's To fix banner, scoped to the LIVE page (`main`): a page-rooted test
 *  id can match the copy React keeps mounted while the next page streams in. */
const banner = (page: Page) => page.getByRole('main').getByTestId('to-fix-banner');

const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

async function fixReasonOf(card: SeededCard): Promise<string | null> {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
  return row.fixReason;
}

async function ciStateOf(card: SeededCard): Promise<string | null> {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
  return row.ciState;
}

// ── The deliveries ──────────────────────────────────────────────────────────

async function deliver(page: Page, event: string, payload: unknown, what: string): Promise<void> {
  const res = await postSignedWebhook(page.request, event, payload);
  expect(res.status(), `${what} → ${(await res.text()).slice(0, 300)}`).toBe(200);
}

/** Open and LINK the card's pull request, through the real delivery and the link door. */
async function openPr(page: Page, card: SeededCard, scenario: Scenario): Promise<void> {
  const { number } = PRS[scenario];
  const headRef = headRefFor(card, scenario);
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

/** One signed `check_suite` for the card's pull request at `headSha`. */
async function checks(
  page: Page,
  card: SeededCard,
  scenario: Scenario,
  conclusion: 'success' | 'failure' | null,
  headSha: string = headShaFor(PRS[scenario].number),
): Promise<void> {
  const { number } = PRS[scenario];
  await deliver(
    page,
    'check_suite',
    checkSuitePayload({
      conclusion,
      status: conclusion === null ? 'in_progress' : 'completed',
      headSha,
      prNumber: number,
      headBranch: headRefFor(card, scenario),
      repo: WEB_REPO,
    }),
    `${conclusion ?? 'running'} #${number} at ${headSha.slice(0, 7)}`,
  );
}

/** The queue removes the pull request for a FAILURE, at its current head. */
async function queueFails(page: Page, scenario: Scenario): Promise<void> {
  const { number } = PRS[scenario];
  const body = captured('dequeued-ci-failure');
  const pr = structuredClone(body['pull_request']) as Record<string, unknown>;
  await deliver(
    page,
    'pull_request',
    {
      ...body,
      reason: 'CI_FAILURE',
      number,
      installation,
      repository,
      pull_request: {
        ...pr,
        number,
        head: { ...(pr['head'] as Record<string, unknown>), sha: headShaFor(number) },
      },
    },
    `the queue removes #${number}`,
  );
}

async function openItem(page: Page, card: SeededCard): Promise<void> {
  await page.goto(`/items/${card.identifier}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(card.title, {
    timeout: 60_000,
  });
}

async function openList(page: Page, query = ''): Promise<void> {
  await page.goto(`/items?view=list${query}`);
  await expect(page.getByRole('table', { name: 'Work Items' })).toBeVisible({ timeout: 60_000 });
}

// ── The walk ────────────────────────────────────────────────────────────────

test.describe('A stuck work item looks stuck wherever it is listed', () => {
  let seed: ApproveAndMergeSeed;
  let queue: SeededCard;
  let conflict: SeededCard;
  let healthy: SeededCard;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedApproveAndMerge(Date.now().toString(36));
    queue = seed.queued;
    conflict = seed.refused;
    healthy = seed.zh;
    writeFileSync(JOURNAL_PATH, '');
    // The merge seam answers for the web repository; the CONFLICT card's pull request reads
    // `dirty` at its head, so the press stores the conflict and asks nothing.
    const control: GithubMergeControl = {
      repositories: [WEB],
      pullRequests: {
        [`${WEB}#${PRS.conflict.number}`]: {
          outcome: 'refused',
          refusal: 'conflict',
          mergeableState: 'dirty',
          mergeable: false,
          headSha: headShaFor(PRS.conflict.number),
        },
      },
    };
    writeFileSync(CONTROL_PATH, JSON.stringify(control));
  });

  test('marks the stuck cards on every surface, explains them, finds them, and clears on a fix', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6589');
    const owner = await adminDb.user.findUniqueOrThrow({ where: { email: seed.ownerEmail } });
    const ctx = { userId: owner.id, workspaceId: seed.workspaceId };

    await signIn(page, seed.ownerEmail, seed.password);

    // ── Seeding, through the real seams ──
    // The queued card is where a run leaves it: Implemented, pull request open, its build
    // still running when the merge queue throws it out.
    await workItemsService.updateStatus(queue.id, 'implemented', ctx);
    await openPr(page, queue, 'queue');
    await checks(page, queue, 'queue', null);
    await queueFails(page, 'queue');

    // The conflicted card went GREEN, which raised an approve-to-merge question. Pressing
    // Approve and merge reads the host first, finds it `dirty`, and withdraws the question.
    await openPr(page, conflict, 'conflict');
    await checks(page, conflict, 'conflict', 'success');
    await openItem(page, conflict);
    const pressDialog = await openDevelopmentOverlay(page);
    await pressDialog
      .getByRole('button', {
        name: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
        exact: true,
      })
      .click();
    const press = serverAction(page);
    await pressDialog
      .getByRole('button', {
        name: en.approvalGate.confirm.proceed.replace(
          '{verb}',
          en.approvalGate.pullRequestApproval.verb.approveAndMerge,
        ),
        exact: true,
      })
      .click();
    expect((await press).status()).toBe(200);
    await expect.poll(() => fixReasonOf(conflict), { timeout: 60_000 }).toBe('conflicted');
    await closeOverlay(page);

    // The server's own answer, before the camera is asked to show any of it.
    expect(await fixReasonOf(queue)).toBe('queue_failed');
    expect(await fixReasonOf(conflict)).toBe('conflicted');
    expect(await ciStateOf(conflict), 'the conflicting card’s checks are GREEN').toBe('passing');
    expect(await fixReasonOf(healthy)).toBeNull();

    const names = en.toFix.tagName;

    await chapter('The /items List marks both stuck cards — and only them', async () => {
      await openList(page);
      await expect(rowTag(page, queue)).toHaveAttribute('aria-label', names.queue_failed);
      await expect(rowTag(page, conflict)).toHaveAttribute('aria-label', names.conflicted);
      await expect(itemRow(page, healthy).locator('[data-to-fix]')).toHaveCount(0);
      // The conflicting card's checks are GREEN, so the CI badge draws nothing — and the
      // tag is still there. The two are independent signals.
      await expect(itemRow(page, conflict).locator('[data-ci-state]')).toHaveCount(0);
      await rowTag(page, conflict).hover();
      await beat();
    });

    await chapter('The Tree draws the same tag', async () => {
      await page.goto('/items?view=tree');
      await expect(rowTag(page, queue)).toHaveAttribute('aria-label', names.queue_failed, {
        timeout: 60_000,
      });
      await expect(rowTag(page, conflict)).toHaveAttribute('aria-label', names.conflicted);
      // The Status column sits past a 1280px viewport's edge — bring the tag into frame.
      await rowTag(page, conflict).scrollIntoViewIfNeeded();
      await beat();
    });

    await chapter('The board wears it too', async () => {
      await gotoLoadedBoard(page, 60_000);
      await expect(boardCard(page, queue).locator('[data-to-fix]')).toHaveText(names.queue_failed);
      await expect(boardCard(page, conflict).locator('[data-to-fix]')).toHaveText(names.conflicted);
      await expect(boardCard(page, healthy).locator('[data-to-fix]')).toHaveCount(0);
      // The stuck cards sit in the Implemented column, off the first screen of the board.
      await boardCard(page, conflict).locator('[data-to-fix]').scrollIntoViewIfNeeded();
      await beat();
    });

    await chapter('A quick view carries it in its header', async () => {
      await openList(page);
      // A plain click on the row's link opens the quick-view peek over the list (MOTIR-1306).
      // The link is stretched over the whole row, so its CENTRE is the Reporter cell's
      // content; the click is placed in the row's left padding, where only the link is.
      await page
        .getByRole('link', { name: `${conflict.identifier} ${conflict.title}`, exact: true })
        .click({ position: { x: 6, y: 22 } });
      await expect(page).toHaveURL(new RegExp(`[?&]peek=${conflict.identifier}`));
      const peek = page.getByRole('dialog');
      await expect(peek.locator('[data-to-fix]')).toHaveText(names.conflicted, {
        timeout: 60_000,
      });
      await beat();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    await chapter(
      'The item page says why, and hands over the command that repairs it',
      async () => {
        await openItem(page, queue);
        await expect(banner(page)).toContainText(
          plain(en.toFix.banner.queueFailedReason, {
            reason: en.workbench.toFix.queueReason.CI_FAILURE,
          }),
        );
        await expect(banner(page).locator('pre')).toHaveText(`motir fix ${queue.identifier}`);
        await beat();

        await openItem(page, conflict);
        await expect(banner(page)).toContainText(
          plain(en.toFix.banner.conflicted, { base: 'main' }),
        );
        await expect(banner(page).locator('pre')).toHaveText(`motir fix ${conflict.identifier}`);
        await beat();

        // The link lands on the Development block, where the pull requests are.
        await banner(page).getByRole('link', { name: en.toFix.banner.toDevelopment }).click();
        await expect(page.getByRole('main').locator('#development')).toBeFocused({
          timeout: 60_000,
        });
        await beat();
      },
    );

    await chapter(
      'The To fix filter lists exactly the stuck cards, and narrows by reason',
      async () => {
        await openList(page);
        await page.getByRole('button', { name: /^Advanced/ }).click();
        await page.getByRole('button', { name: 'Add condition' }).click();
        const row = page.getByRole('group', { name: 'Condition 1' });
        await row.getByRole('combobox', { name: 'Field' }).click();
        await page
          .getByRole('option', { name: en.issueViews.advancedFieldToFix, exact: true })
          .click();
        await row.getByRole('combobox', { name: 'Operator' }).click();
        await page
          .getByRole('option', { name: en.issueViews.advancedOpToFixIsNotEmpty, exact: true })
          .click();
        // The builder applies LIVE and writes the AST into the URL — the authoritative signal.
        await page.waitForURL(/[?&]filter=/);
        await expect(itemRow(page, queue)).toBeVisible({ timeout: 60_000 });
        await expect(itemRow(page, conflict)).toBeVisible();
        await expect(itemRow(page, healthy)).toHaveCount(0);
        await expect(page.getByRole('table', { name: 'Work Items' }).getByRole('row')).toHaveCount(
          3,
        ); // 2 + header
        await beat();

        // To fix is any of Conflicts — one.
        const before = page.url();
        await row.getByRole('combobox', { name: 'Operator' }).click();
        await page
          .getByRole('option', { name: en.issueViews.advancedOpIsAnyOf, exact: true })
          .click();
        await row
          .getByRole('combobox', { name: `${en.issueViews.advancedFieldToFix} values` })
          .click();
        await page
          .getByRole('option', { name: en.workbench.toFix.reason.conflictedNoBase, exact: true })
          .click();
        await page.waitForURL(
          (url) => url.toString() !== before && /[?&]filter=/.test(url.toString()),
        );
        await expect(itemRow(page, conflict)).toBeVisible({ timeout: 60_000 });
        await expect(itemRow(page, queue)).toHaveCount(0);
        await beat();
      },
    );

    await chapter('A push goes green — after a reload the tag and banner are gone', async () => {
      // A push whose build passed — delivered from outside the page. A new head leaves the
      // queue exit behind.
      await checks(page, queue, 'queue', 'success', pushedHead('queue'));
      expect(await fixReasonOf(queue)).toBeNull();

      await openList(page);
      await expect(itemRow(page, queue)).toBeVisible();
      await expect(rowTag(page, queue)).toHaveCount(0);
      // The conflicting card is still stuck, and still says so.
      await expect(rowTag(page, conflict)).toHaveAttribute('aria-label', names.conflicted);
      await beat();

      await gotoLoadedBoard(page, 60_000);
      await expect(boardCard(page, queue).locator('[data-to-fix]')).toHaveCount(0);
      await expect(boardCard(page, conflict).locator('[data-to-fix]')).toHaveCount(1);

      await openItem(page, queue);
      await expect(banner(page)).toHaveCount(0);
      await beat();
    });

    await chapter('In 简体中文 — the tag and the banner', async () => {
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      await page.goto('/items?view=list');
      await expect(rowTag(page, conflict)).toHaveAttribute(
        'aria-label',
        zh.toFix.tagName.conflicted,
        {
          timeout: 60_000,
        },
      );
      await gotoLoadedBoard(page, 60_000);
      await expect(boardCard(page, conflict).locator('[data-to-fix]')).toHaveText(
        zh.toFix.tagName.conflicted,
      );
      await openItem(page, conflict);
      await expect(banner(page)).toContainText(plain(zh.toFix.banner.conflicted, { base: 'main' }));
      // The command is a command — it stays untranslated.
      await expect(banner(page).locator('pre')).toHaveText(`motir fix ${conflict.identifier}`);
      await beat();
    });
  });
});
