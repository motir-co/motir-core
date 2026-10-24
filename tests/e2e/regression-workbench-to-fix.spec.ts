import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
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
import { workItemsService } from '@/lib/services/workItemsService';
import type { GithubMergeControl } from '@/lib/test-github-merge-mock';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// TO FIX ON THE WORKBENCH — THE ACCEPTANCE RECEIPT (Story MOTIR-6588 · Subtask MOTIR-6607;
// `design/workbench/workbench--to-fix.mock.html`, design § 30).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A member opens the Workbench to answer *"what of mine is broken and waiting on a
// repair?"*. Four of their cards are stuck, each for a different reason, and none is waiting
// on a decision — so a bare `/workbench` lands on **To fix**, whose count reads 4. Each row
// says WHY in words (the merge queue failed it · it conflicts with main · its CI failed · a
// reviewer sent it back) and WHAT REPAIRS IT (`motir fix <KEY>`, or — before §12.7 (MOTIR-6822) — `motir run <KEY>` for the
// card sent back). In progress holds none of the four. Then a fix lands on the red card: the
// count drops to 3 without a reload, the row stays where it was, marked Cleared, and the next
// load omits it. The whole tab reads in Chinese, down to its empty state.
//
// ── EVERY REASON ARRIVES THROUGH A REAL SEAM ────────────────────────────────
//
// Nothing here writes `fixReason`. Each is the shipped recompute answering a real event:
//
//   CI failed            a signed FAILED `check_suite` on the card's pull request
//   Failed in the queue  a signed `pull_request` `dequeued` with reason `CI_FAILURE`, at
//                        the pull request's head (the captured MOTIR-5627 body)
//   Conflicts with main  the approve-and-merge PRESS, which reads the host's mergeability
//                        (the merge seam, answering `dirty`), stores it, and withdraws
//                        the question — the card is held at Implemented (MOTIR-5913)
//   Changes requested    a person pressing Request changes on the approve-to-merge gate
//                        raised when the card's checks went green
//
// and every repair is a signed green `check_suite` at a NEW head — a push whose build passed.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's response, a server action's response, a row's
// or a badge's text, or a read of the stored column. There is no `waitForTimeout`.
//
// ⚠️ THE 22xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).
//
// ── THE LANE ────────────────────────────────────────────────────────────────
//
// The acceptance lane for the RECEIPT and for the merge seam the conflict needs (the lane
// wires `E2E_TEST_GITHUB_MERGE`'s control file); the tab itself is plain product behaviour.

test.describe.configure({ timeout: 600_000 });

const PRS = {
  red: { number: 22001 },
  queue: { number: 22002 },
  conflict: { number: 22003 },
  sentBack: { number: 22004 },
} as const;
type Scenario = keyof typeof PRS;

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;
const WEB = `${WEB_REPO.owner}/${WEB_REPO.name}`;
const REVIEW_NOTE = 'Rename the export button before this ships.';

const installation = { id: Number(E2E_INSTALLATION_ID) };
const repository = { id: Number(WEB_REPO.providerRepoId) };
const headRefFor = (card: SeededCard, scenario: Scenario) =>
  `fix/${card.identifier.toLowerCase()}-${PRS[scenario].number}`;
/** A second head for the same pull request — what a push produces. */
const pushedHead = (scenario: Scenario) => 'f00d' + headShaFor(PRS[scenario].number).slice(4);

/** Strip the catalogue's rich tags (to a fixed point, so no removal can leave a new
 *  tag behind) and fill its placeholders — the text a reader sees. */
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

const table = (page: Page, name: string): Locator => page.getByRole('table', { name });
const rowOf = (page: Page, tab: string, card: SeededCard): Locator =>
  table(page, tab).getByRole('row').filter({ hasText: card.identifier });

/** The strip's badge for a tab, as a number — a suppressed zero is zero. */
async function badgeCount(page: Page, tab: string): Promise<number> {
  const text =
    (await page
      .getByRole('link', { name: new RegExp(`^${tab}`) })
      .first()
      .textContent()) ?? '';
  const digits = text.replace(/[^0-9]/g, '');
  return digits === '' ? 0 : Number(digits);
}

const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

/** The check the stored detail names — what the red row must say, read from the column the
 *  recompute wrote rather than guessed from the payload builder. */
async function failingCheckOf(card: SeededCard): Promise<string> {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
  const check = (row.fixDetail as { check?: unknown } | null)?.check;
  expect(typeof check, 'the red card names its failing check').toBe('string');
  return check as string;
}

async function fixReasonOf(card: SeededCard): Promise<string | null> {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
  return row.fixReason;
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

/** A push moved the pull request's head — GitHub's `synchronize` delivery, which every real
 *  push sends. The conflict's repair needs it: the `dirty` reading is kept against the head
 *  Motir STORES (MOTIR-7005), and only a push delivery (or a fresh host read) moves that head;
 *  check rows at a new commit do not. */
async function push(page: Page, card: SeededCard, scenario: Scenario, sha: string): Promise<void> {
  const { number } = PRS[scenario];
  const payload = pullRequestPayload({
    action: 'opened',
    number,
    title: card.title,
    headRef: headRefFor(card, scenario),
    state: 'open',
    merged: false,
    repo: WEB_REPO,
  }) as { pull_request: Record<string, unknown> } & Record<string, unknown>;
  await deliver(
    page,
    'pull_request',
    {
      ...payload,
      action: 'synchronize',
      pull_request: { ...payload.pull_request, head: { ref: headRefFor(card, scenario), sha } },
    },
    `push #${number} to ${sha.slice(0, 7)}`,
  );
}

/** The queue removes the pull request for a FAILURE, at its current head — the captured
 *  `dequeued` body, re-addressed to this spec's installation, repository and number. */
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

// ── The walk ────────────────────────────────────────────────────────────────

test.describe('To fix on the Workbench', () => {
  let seed: ApproveAndMergeSeed;
  let red: SeededCard;
  let queue: SeededCard;
  let conflict: SeededCard;
  let sentBack: SeededCard;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedApproveAndMerge(Date.now().toString(36));
    red = seed.merged;
    queue = seed.queued;
    conflict = seed.refused;
    sentBack = seed.zh;
    writeFileSync(JOURNAL_PATH, '');
    // The merge seam answers for the web repository; the CONFLICT card's pull request
    // reads `dirty` at its head, so the press stores the conflict and asks nothing.
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

  test('lands on the stuck cards, says why each is stuck, and keeps up when one is fixed', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6588');
    const owner = await adminDb.user.findUniqueOrThrow({ where: { email: seed.ownerEmail } });
    const ctx = { userId: owner.id, workspaceId: seed.workspaceId };

    await signIn(page, seed.ownerEmail, seed.password);

    // ── Seeding, through the real seams ──
    // The red and queued cards are where a run leaves them: Implemented, pull request open.
    for (const card of [red, queue])
      await workItemsService.updateStatus(card.id, 'implemented', ctx);
    await openPr(page, red, 'red');
    await checks(page, red, 'red', 'failure');
    await openPr(page, queue, 'queue');
    // Its build is still running when the merge queue throws it out.
    await checks(page, queue, 'queue', null);
    await queueFails(page, 'queue');

    // The conflicted and sent-back cards went green, which raised an approve-to-merge
    // question on each (a `manual` project).
    await openPr(page, conflict, 'conflict');
    await checks(page, conflict, 'conflict', 'success');
    await openPr(page, sentBack, 'sentBack');
    await checks(page, sentBack, 'sentBack', 'success');

    // Pressing Approve and merge on the conflicted card: the press reads the host first,
    // finds it `dirty`, and withdraws the question — the card is held at Implemented.
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

    // A reviewer sends the other one back.
    await openItem(page, sentBack);
    const reviewDialog = await openDevelopmentOverlay(page);
    await reviewDialog
      .getByRole('button', { name: en.approvalGate.verb.requestChanges, exact: true })
      .click();
    await reviewDialog.getByLabel(en.approvalGate.reason.label).fill(REVIEW_NOTE);
    await reviewDialog
      .getByRole('button', { name: en.approvalGate.reason.proceed, exact: true })
      .click();
    await expect(reviewDialog.getByText('Changes requested', { exact: true })).toBeVisible();
    await closeOverlay(page);

    // The server's own answer, before the camera is asked to show any of it.
    expect(await fixReasonOf(red)).toBe('ci_failed');
    expect(await fixReasonOf(queue)).toBe('queue_failed');
    expect(await fixReasonOf(conflict)).toBe('conflicted');
    expect(await fixReasonOf(sentBack)).toBe('changes_requested');

    const toFix = en.workbench.tabs.toFix;
    const reasons = en.workbench.toFix.reason;

    await chapter(
      'Nothing to approve — the Workbench opens on To fix, and it reads 4',
      async () => {
        await page.goto('/workbench');
        await page.waitForURL(/[?&]tab=to-fix/);
        await expect(
          table(page, toFix)
            .getByRole('row')
            .filter({ hasText: /motir (fix|run)/ }),
        ).toHaveCount(4, {
          timeout: 60_000,
        });
        expect(await badgeCount(page, toFix)).toBe(4);
        expect(await badgeCount(page, en.workbench.tabs.toApprove)).toBe(0);
      },
    );
    await beat();

    await chapter('Each row says why it is stuck, and the command that repairs it', async () => {
      await expect(rowOf(page, toFix, queue)).toContainText(
        plain(reasons.queueFailed, { detail: en.workbench.toFix.queueReason.CI_FAILURE }),
      );
      await expect(rowOf(page, toFix, queue)).toContainText(`motir fix ${queue.identifier}`);
      await expect(rowOf(page, toFix, conflict)).toContainText(
        plain(reasons.conflicted, { base: 'main' }),
      );
      await expect(rowOf(page, toFix, conflict)).toContainText(`motir fix ${conflict.identifier}`);
      await expect(rowOf(page, toFix, red)).toContainText(
        plain(reasons.ciFailed, { check: await failingCheckOf(red) }),
      );
      await expect(rowOf(page, toFix, red)).toContainText(`motir fix ${red.identifier}`);
      // The reviewer is NAMED and the first line of their note QUOTED. Asserted as two
      // halves around the name, which is the stored `decidedByLabel`.
      await expect(rowOf(page, toFix, sentBack)).toContainText(
        `${plain(reasons.changesRequested, { name: seed.ownerName, note: '' }).split(' — ')[0]}`,
      );
      await expect(rowOf(page, toFix, sentBack)).toContainText(`“${REVIEW_NOTE}”`);
      // ⚠️ AMENDED BY A RECORDED DECISION, not edited to match today (MOTIR-1626 · MOTIR-6822,
      // `docs/decisions/approval-gates.md` §12.7): a card a person sent back was repaired by
      // `motir run`, which could never claim it — the card sits in the review band and `run`
      // claims only To do. §12.7 corrects the repair to `motir fix`; this receipt's video is
      // still the record of what MOTIR-6588 shipped.
      await expect(rowOf(page, toFix, sentBack)).toContainText(`motir fix ${sentBack.identifier}`);
    });
    await beat();

    await chapter('In progress holds none of them', async () => {
      await page
        .getByRole('link', { name: new RegExp(`^${en.workbench.tabs.inProgress}`) })
        .click();
      await page.waitForURL(/[?&]tab=in-progress/);
      const inProgress = en.workbench.tabs.inProgress;
      await expect(
        page
          .getByRole('main')
          .getByText(en.workbench.empty.inProgress.title)
          .or(table(page, inProgress)),
      ).toBeVisible({ timeout: 60_000 });
      for (const card of [red, queue, conflict, sentBack]) {
        await expect(page.getByRole('row').filter({ hasText: card.identifier })).toHaveCount(0);
      }
    });
    await beat();

    await chapter('A fix goes green — the count drops, and the row stays, Cleared', async () => {
      await page.getByRole('link', { name: new RegExp(`^${toFix}`) }).click();
      await page.waitForURL(/[?&]tab=to-fix/);
      await expect(rowOf(page, toFix, red)).toContainText(`motir fix ${red.identifier}`, {
        timeout: 60_000,
      });
      const url = page.url();

      // A push whose build passed — delivered from outside the page, which is never touched.
      await checks(page, red, 'red', 'success', pushedHead('red'));
      expect(await fixReasonOf(red)).toBeNull();

      await expect.poll(() => badgeCount(page, toFix), { timeout: 60_000 }).toBe(3);
      await expect(rowOf(page, toFix, red)).toContainText(en.workbench.live.cleared);
      await expect(rowOf(page, toFix, red)).not.toContainText(`motir fix ${red.identifier}`);
      expect(page.url(), 'nobody navigated').toBe(url);
      await beat();

      // The next load omits it.
      await page
        .getByRole('link', { name: new RegExp(`^${en.workbench.tabs.inProgress}`) })
        .click();
      await page.waitForURL(/[?&]tab=in-progress/);
      await page.getByRole('link', { name: new RegExp(`^${toFix}`) }).click();
      await page.waitForURL(/[?&]tab=to-fix/);
      await expect(
        table(page, toFix)
          .getByRole('row')
          .filter({ hasText: /motir (fix|run)/ }),
      ).toHaveCount(3, {
        timeout: 60_000,
      });
      await expect(rowOf(page, toFix, red)).toHaveCount(0);
    });
    await beat();

    await chapter('In 简体中文 — the tab and every reason', async () => {
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      await page.goto('/workbench?tab=to-fix');
      const zhToFix = zh.workbench.tabs.toFix;
      const zr = zh.workbench.toFix.reason;
      await expect(table(page, zhToFix)).toBeVisible({ timeout: 60_000 });
      expect(await badgeCount(page, zhToFix)).toBe(3);
      await expect(rowOf(page, zhToFix, queue)).toContainText(
        plain(zr.queueFailed, { detail: zh.workbench.toFix.queueReason.CI_FAILURE }),
      );
      await expect(rowOf(page, zhToFix, conflict)).toContainText(
        plain(zr.conflicted, { base: 'main' }),
      );
      await expect(rowOf(page, zhToFix, sentBack)).toContainText(seed.ownerName);
      await expect(rowOf(page, zhToFix, sentBack)).toContainText(
        plain(zr.changesRequested, { name: '', note: REVIEW_NOTE }).trim(),
      );
      // The commands are commands — they stay untranslated.
      // `motir fix` since §12.7 (MOTIR-6822) — see the English assertion above.
      await expect(rowOf(page, zhToFix, sentBack)).toContainText(
        `motir fix ${sentBack.identifier}`,
      );
    });
    await beat();

    await chapter('Every card repaired — the drawn empty state', async () => {
      // A push that goes green on each: a new head leaves the queue exit, the conflict and
      // the refusal all behind.
      await checks(page, queue, 'queue', 'success', pushedHead('queue'));
      // The host now reports the conflict card's NEW head, and it merges: a push is asked
      // about at its new head (MOTIR-7063), and a host still describing the old `dirty`
      // head would hand that head back.
      writeFileSync(
        CONTROL_PATH,
        JSON.stringify({
          repositories: [WEB],
          pullRequests: {
            [`${WEB}#${PRS.conflict.number}`]: {
              outcome: 'merged',
              mergeableState: 'clean',
              mergeable: true,
              headSha: pushedHead('conflict'),
            },
          },
        } satisfies GithubMergeControl),
      );
      await push(page, conflict, 'conflict', pushedHead('conflict'));
      await checks(page, conflict, 'conflict', 'success', pushedHead('conflict'));
      await checks(page, sentBack, 'sentBack', 'success', pushedHead('sentBack'));
      for (const card of [queue, conflict, sentBack]) expect(await fixReasonOf(card)).toBeNull();

      await page.goto('/workbench?tab=to-fix');
      await expect(
        page.getByRole('main').getByText(zh.workbench.empty.toFix.title, { exact: true }),
      ).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByRole('main').getByText(zh.workbench.empty.toFix.body)).toBeVisible();
    });
    await beat();
  });
});
