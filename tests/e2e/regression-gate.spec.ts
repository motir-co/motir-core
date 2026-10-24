import { readFileSync, writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { paidOrgState, resetBillingFixture, setOrgBillingState } from './_helpers/billing';
import { signIn } from './_helpers/shell-session';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { linkPr } from './_helpers/pr-link';
import { approvalSentence } from './_helpers/approval-sentence';
import { closeOverlay, openDevelopmentOverlay } from './_helpers/development-decide';
import {
  API_REPO,
  WEB_REPO,
  headShaFor,
  publishReceipt,
  seedAcceptanceGate,
  type AcceptanceGateSeed,
  type SeedRepo,
  type SeededCard,
} from './_helpers/acceptance-gate-seed';
import type { GithubMergeCall, GithubMergeControl } from '@/lib/test-github-merge-mock';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// THE ACCEPTANCE-VIDEO GATE — a story's receipt becomes a DECISION ON THE STORY, and on a
// story run one press also merges its code (Story MOTIR-4949 · Subtask MOTIR-5792).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A run records a story working and publishes the recording. The question that raises is
// the same shape as every other decision in Motir — it waits on To approve, in the one
// approve language — and it lands on the STORY, whatever card the run was launched
// against. When the story was run AS A WHOLE, its pull requests are its own, so the
// recording LEADS its Development block with the pull requests and How to test beneath it,
// and ONE press accepts the story and merges its code. The video is never merged: it is
// evidence, and it is frozen the moment it is accepted. Then the two answers a demo would
// hide, both the requester's MOTIR-5903 ruling (*"acceptance video gate is story gate"*):
// on a SINGLE-CARD run the run's own card shows no recording, and the story asks nothing
// until the E2E subtask has merged — then it asks with no further publish; and a story run
// whose checks have not passed asks nothing at all until they do, when it asks ONCE.
//
// ── THE SEAMS THIS LANE USES ────────────────────────────────────────────────
//
//   * GitHub's merge — `E2E_TEST_GITHUB_MERGE` (`lib/test-github-merge-mock.ts`), selected
//     in `playwright.acceptance.config.ts`. The spec READS the journal to prove a press
//     (and an unpressed green) reached that seam.
//   * The pull requests, their green checks and their merges — SIGNED deliveries to the
//     real `/api/github/webhook` route; the links — the real link door.
//   * The receipts — rows plus the shipped predicate (`acceptance-gate-seed.ts` says why).
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's own response, the server action's response, a
// role, or a committed read after a reload. No timed wait anywhere in this file; the holds
// are `chapter()` / `beat()`'s, taken after the assertion.
//
// ⚠️ THE 17xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`). It
// was 16xxx until the merge with `main`, which brought `regression-decision-gate.spec.ts`
// holding that block already — two specs on one block is the collision that guard exists
// to end, and the numbers here moved rather than its.

test.describe.configure({ timeout: 480_000 });

const PRS = {
  storyRun: { web: { number: 17101 }, api: { number: 17102 } },
  singleCard: { web: { number: 17201 }, api: { number: 17202 } },
  held: { web: { number: 17301 }, api: { number: 17302 } },
  zh: { web: { number: 17401 }, api: { number: 17402 } },
} as const;

type Scenario = keyof typeof PRS;
type Messages = typeof en;
const ZH = zh as unknown as Messages;

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

/** A pull request as every surface names it: `owner/name · #n`. */
const prName = (repo: SeedRepo, number: number) => `${repo.owner}/${repo.name} · #${number}`;
const prKey = (repo: SeedRepo, number: number) => `${repo.owner}/${repo.name}#${number}`;
const headRefFor = (card: SeededCard, number: number) =>
  `accgate/${card.identifier.toLowerCase()}-${number}`;

/** Both members of a scenario's delivery set, in the seed's order. */
const membersOf = (scenario: Scenario) =>
  [
    [WEB_REPO, PRS[scenario].web.number],
    [API_REPO, PRS[scenario].api.number],
  ] as const;

/** The two pull requests as the one-press copy lists them — sorted, as the set version is. */
const pairFor = (scenario: Scenario, m: Messages = en) =>
  fill(m.approvalGate.pullRequestApproval.list.pair, {
    a: prName(API_REPO, PRS[scenario].api.number),
    b: prName(WEB_REPO, PRS[scenario].web.number),
  });

function journal(): GithubMergeCall[] {
  try {
    return readFileSync(JOURNAL_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GithubMergeCall);
  } catch {
    return [];
  }
}

/** Every pull request the merge seam was asked to merge, as `owner/name#n`. */
const mergedThroughTheSeam = (): string[] =>
  journal()
    .filter((call) => call.method === 'PUT')
    .flatMap((call) => (call.pullRequest === null ? [] : [call.pullRequest]));

/** The item page's Development card — the section card headed by its title. */
const developmentCard = (page: Page, m: Messages = en): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: m.github.development.title }) });

/** The item page's standalone Acceptance card — the section a single-card run keeps. */
const acceptanceCard = (page: Page, m: Messages = en): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: m.acceptance.title }) });

/** One pull-request row of the Development card, by its `owner/name · #n` meta line. */
const prRow = (page: Page, repo: SeedRepo, number: number, m: Messages = en): Locator =>
  developmentCard(page, m)
    .locator('li')
    .filter({ hasText: prName(repo, number) });

/** One pull-request row of the approval overlay's Development block. */
const overlayRow = (dialog: Locator, repo: SeedRepo, number: number): Locator =>
  dialog.locator('li').filter({ hasText: prName(repo, number) });

/** The detail rail's Status field card. */
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

/** Arm a wait for the next server action's response — a POST carrying `Next-Action`. */
const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

/** Open a card's pull requests and link them — the path a run walks. */
async function openAndLink(page: Page, card: SeededCard, scenario: Scenario): Promise<void> {
  for (const [repo, number] of membersOf(scenario)) {
    const headRef = headRefFor(card, number);
    const opened = await postSignedWebhook(
      page.request,
      'pull_request',
      pullRequestPayload({
        action: 'opened',
        number,
        title: `${card.title} — ${repo.name}`,
        headRef,
        state: 'open',
        merged: false,
        repo,
      }),
    );
    expect(opened.status(), `open ${prKey(repo, number)}`).toBe(200);
    await linkPr(page, { workItemId: card.id, repo, number, headRef });
  }
}

/** Turn a card's linked pull requests green — the verdict that raises the merge question. */
async function turnGreen(page: Page, card: SeededCard, scenario: Scenario): Promise<void> {
  for (const [repo, number] of membersOf(scenario)) {
    const green = await postSignedWebhook(
      page.request,
      'check_suite',
      checkSuitePayload({
        conclusion: 'success',
        headSha: headShaFor(number),
        prNumber: number,
        headBranch: headRefFor(card, number),
        repo,
      }),
    );
    expect(green.status(), `green ${prKey(repo, number)}`).toBe(200);
  }
}

/** The merge webhook for one pull request; asserts the sync answered. */
async function mergedWebhook(
  page: Page,
  card: SeededCard,
  repo: SeedRepo,
  number: number,
): Promise<void> {
  const res = await postSignedWebhook(
    page.request,
    'pull_request',
    pullRequestPayload({
      action: 'closed',
      number,
      title: `${card.title} — ${repo.name}`,
      headRef: headRefFor(card, number),
      state: 'closed',
      merged: true,
      repo,
    }),
  );
  expect(res.status(), `merge ${prKey(repo, number)} → ${(await res.text()).slice(0, 300)}`).toBe(
    200,
  );
}

test.describe('the acceptance-video gate', () => {
  let seed: AcceptanceGateSeed;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    resetBillingFixture();
    seed = await seedAcceptanceGate(Date.now().toString(36));
    // The acceptance panel's State A needs a paid org — see the seed's header.
    setOrgBillingState(seed.organizationId, paidOrgState());
    writeFileSync(JOURNAL_PATH, '');
    // What GitHub answers: both repositories merge whatever they are handed.
    const control: GithubMergeControl = {
      repositories: [`${WEB_REPO.owner}/${WEB_REPO.name}`, `${API_REPO.owner}/${API_REPO.name}`],
    };
    writeFileSync(CONTROL_PATH, JSON.stringify(control));

    await signIn(page, seed.ownerEmail, seed.password);

    // THE RUN'S OWN ORDER: the pull requests open first, the recording is published at the
    // end of the run. For the story runs the whole set is green before the receipt lands,
    // so the publish is what finds BOTH questions owed.
    for (const [cards, scenario] of [
      [seed.storyRun, 'storyRun'],
      [seed.zh, 'zh'],
      [seed.held, 'held'],
    ] as const) {
      await openAndLink(page, cards.story, scenario);
      if (scenario !== 'held') await turnGreen(page, cards.story, scenario);
    }
    // The single-card run delivered from the E2E SUBTASK, so the pull requests are ITS.
    await openAndLink(page, seed.singleCard.e2e, 'singleCard');
    await turnGreen(page, seed.singleCard.e2e, 'singleCard');

    for (const cards of [seed.storyRun, seed.singleCard, seed.held, seed.zh]) {
      await publishReceipt({
        workspaceId: seed.workspaceId,
        uploaderUserId: seed.ownerUserId,
        story: cards.story,
        producedByKey: cards.e2e.identifier,
        commitSha: headShaFor(17101),
      });
    }
  });

  test('a recording becomes a decision on the story, and on a story run one press also merges', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-4949');
    const acc = en.approvalGate.acceptanceResult;
    const pra = en.approvalGate.pullRequestApproval;
    const web = PRS.storyRun.web.number;
    const api = PRS.storyRun.api.number;

    await chapter('The recording is a question, waiting on To approve', async () => {
      await page.goto('/workbench?tab=approvals');
      const rows = page
        .getByRole('table', { name: en.workbench.tabs.toApprove })
        .getByTestId(/^approval-row-/);
      // One row per card — and the story run's names the RECORDING, not its pull requests:
      // the acceptance question is the primary, so it is the one the queue asks.
      const row = rows.filter({ hasText: seed.storyRun.story.identifier });
      await expect(row).toHaveCount(1, { timeout: 60_000 });
      // The row reads as a sentence about the story (MOTIR-5999).
      await expect(
        row.getByText(approvalSentence(en, 'acceptance_result', seed.storyRun.story.title), {
          exact: true,
        }),
      ).toBeVisible();
      // The row names the RECORDING — how many chapters it walks and the commit it was
      // recorded at — which is what `acceptanceMeta` renders (`ApprovalRow.tsx`).
      await expect(row.getByText(/3 chapters · 000042cd/)).toBeVisible();
    });
    await beat();

    await chapter('The story run: the recording leads, its code beneath it', async () => {
      await page.goto(`/items/${seed.storyRun.story.identifier}`);
      const card = developmentCard(page);
      await expect(card).toHaveCount(1, { timeout: 60_000 });
      await expect(card.getByTestId('acceptance-development-slot')).toHaveCount(1);
      await expect(card.getByRole('button', { name: 'The basket still holds it' })).toBeVisible();
      await expect(prRow(page, WEB_REPO, web)).toHaveCount(1);
      await expect(prRow(page, API_REPO, api)).toHaveCount(1);
      // ⚠️ AMENDED by MOTIR-6323: the card hands the decision over — no verb on the page,
      // and the ONE frame, with the receipt as its subject, is the approval overlay's.
      await expect(
        card.getByRole('button', { name: pra.verb.approveAndMerge, exact: true }),
      ).toHaveCount(0);
      const dev = await openDevelopmentOverlay(page);
      const port = dev.getByRole('group', { name: en.approvalGate.port.label, exact: true });
      await expect(dev.getByTestId('acceptance-development-slot')).toHaveCount(1);
      await expect(
        port.getByRole('group', { name: en.github.development.howToTest.title }),
      ).toHaveCount(1);
      // ONE verb pair, and it says what it merges — and what it does not.
      await expect(
        dev.getByRole('button', { name: pra.verb.approveAndMerge, exact: true }),
      ).toHaveCount(1);
      await expect(
        dev.getByText(
          fill(acc.consequenceMerges, {
            key: seed.storyRun.story.identifier,
            prs: pairFor('storyRun'),
          }),
          { exact: true },
        ),
      ).toBeVisible();
      await closeOverlay(page);
      // The standalone Acceptance section is NOT drawn: one question, one place.
      await expect(acceptanceCard(page)).toHaveCount(0);
    });
    await beat();

    await chapter('One press: the story is accepted and its code merges', async () => {
      // ⚠️ AMENDED by MOTIR-6323: the same press, in the approval overlay.
      const dev = await openDevelopmentOverlay(page);
      await dev.getByRole('button', { name: pra.verb.approveAndMerge, exact: true }).click();
      // The confirm step names all three consequences, the video among them — as the thing
      // that is frozen, and the thing that is NOT merged.
      await expect(dev.getByText(acc.confirm.records, { exact: true })).toBeVisible();
      await expect(dev.getByText(acc.confirm.freezes, { exact: true })).toBeVisible();
      await expect(
        dev.getByText(fill(acc.confirm.merges, { prs: pairFor('storyRun') }), { exact: true }),
      ).toBeVisible();
      await beat();

      const action = serverAction(page);
      await dev
        .getByRole('button', {
          name: fill(en.approvalGate.confirm.proceed, { verb: pra.verb.approveAndMerge }),
          exact: true,
        })
        .click();
      expect((await action).status()).toBe(200);

      // The press reached the merge seam — and not the real host — for both pull requests.
      expect(mergedThroughTheSeam()).toEqual(
        expect.arrayContaining([prKey(WEB_REPO, web), prKey(API_REPO, api)]),
      );
      for (const [repo, number] of membersOf('storyRun')) {
        await expect(
          overlayRow(dev, repo, number).getByText(pra.outcome.merged, { exact: true }),
        ).toBeVisible();
      }
      await closeOverlay(page);
      await expect(statusCard(page)).toContainText(en.approvalGate.state.approved);
    });
    await beat();

    await chapter(
      'GitHub reports the merges: the story is done, the recording frozen',
      async () => {
        for (const [repo, number] of membersOf('storyRun')) {
          await mergedWebhook(page, seed.storyRun.story, repo, number);
        }
        await page.reload();
        await expect(statusCard(page)).toContainText('Done', { timeout: 60_000 });
        // A done story asks nothing more, and the recording it was accepted on stands —
        // said by the SHARED FRAME, whose port is now the recording itself (MOTIR-5792:
        // the panel drew this with a pill of its own, a second approve language).
        await expect(
          acceptanceCard(page).getByText(en.approvalGate.state.approved, { exact: true }),
        ).toBeVisible();
        await expect(acceptanceCard(page).getByText(seed.ownerName)).toBeVisible();
        await expect(
          acceptanceCard(page).getByRole('button', { name: en.approvalGate.verb.approve }),
        ).toHaveCount(0);
      },
    );
    await beat();

    await chapter('A single-card run: nothing to approve until the E2E subtask lands', async () => {
      // The run delivered from the E2E subtask, so the pull requests are ITS — and the
      // recording is not, because a receipt belongs to the story.
      await page.goto(`/items/${seed.singleCard.e2e.identifier}`);
      const dev = developmentCard(page);
      await expect(dev).toHaveCount(1, { timeout: 60_000 });
      await expect(prRow(page, WEB_REPO, PRS.singleCard.web.number)).toHaveCount(1);
      await expect(dev.getByTestId('acceptance-development-slot')).toHaveCount(0);
      await beat();

      // On the STORY the recording is there to watch, and there is NOTHING to approve yet:
      // the story cannot finish while the subtask that recorded it is unmerged (MOTIR-5903).
      await page.goto(`/items/${seed.singleCard.story.identifier}`);
      const acceptance = acceptanceCard(page);
      await expect(acceptance).toHaveCount(1, { timeout: 60_000 });
      await expect(
        acceptance.getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove }),
      ).toHaveCount(0);
      await beat();

      // The subtask's pull requests merge — and the story is asked, with no further publish.
      for (const [repo, number] of membersOf('singleCard')) {
        await mergedWebhook(page, seed.singleCard.e2e, repo, number);
      }
      await page.reload();
      await expect(
        acceptanceCard(page).getByRole('link', {
          name: en.approvalGate.statusHeld.reviewAndApprove,
        }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        developmentCard(page).getByRole('button', { name: pra.verb.approveAndMerge, exact: true }),
      ).toHaveCount(0);
    });
    await beat();

    await chapter('A story run that is not green yet asks nothing — green asks once', async () => {
      const story = seed.held.story;
      await page.goto(`/items/${story.identifier}`);
      await expect(developmentCard(page)).toHaveCount(1, { timeout: 60_000 });
      // The pull requests are open and NOT green: the recording is evidence waiting for the
      // one approve-to-merge question, so there is no question, no door and no verb
      // (MOTIR-5903 — before it, this story held an acceptance "To approve" row it could
      // not act on).
      await expect(
        acceptanceCard(page).getByRole('link', {
          name: en.approvalGate.statusHeld.reviewAndApprove,
        }),
      ).toHaveCount(0);
      await expect(
        developmentCard(page).getByRole('button', {
          name: pra.verb.approveAndMerge,
          exact: true,
        }),
      ).toHaveCount(0);
      await page.goto('/workbench?tab=approvals');
      await expect(
        page
          .getByRole('table', { name: en.workbench.tabs.toApprove })
          .getByTestId(/^approval-row-/)
          .filter({ hasText: story.identifier }),
      ).toHaveCount(0);
      await beat();

      // The set goes green: ONE question, the recording leading the pull requests.
      await turnGreen(page, story, 'held');
      await page.goto(`/items/${story.identifier}`);
      const dev = developmentCard(page);
      await expect(dev.getByTestId('acceptance-development-slot')).toHaveCount(1, {
        timeout: 60_000,
      });
      // ⚠️ AMENDED by MOTIR-6323: the one question is asked by the band's ONE control.
      await expect(
        dev.getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove, exact: true }),
      ).toHaveCount(1);
      await expect(acceptanceCard(page)).toHaveCount(0);
    });
    await beat();

    await chapter('The same walk in Chinese', async () => {
      const zacc = ZH.approvalGate.acceptanceResult;
      const zpra = ZH.approvalGate.pullRequestApproval;
      // Against the SITE ROOT, not `page.url()`: Playwright derives a cookie's path from
      // the url's directory, so a cookie set from `/items/<key>` never reaches `/workbench`.
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      await page.goto(`/items/${seed.zh.story.identifier}`);
      await expect(developmentCard(page, ZH)).toHaveCount(1, { timeout: 60_000 });
      // ⚠️ AMENDED by MOTIR-6323: the same walk, in the approval overlay.
      const dev = await openDevelopmentOverlay(page, ZH);
      await expect(dev.getByTestId('acceptance-development-slot')).toHaveCount(1);
      await expect(
        dev.getByText(
          fill(zacc.consequenceMerges, {
            key: seed.zh.story.identifier,
            prs: pairFor('zh', ZH),
          }),
          { exact: true },
        ),
      ).toBeVisible();
      await dev.getByRole('button', { name: zpra.verb.approveAndMerge, exact: true }).click();
      await expect(dev.getByText(zacc.confirm.freezes, { exact: true })).toBeVisible();
      const action = serverAction(page);
      await dev
        .getByRole('button', {
          name: fill(ZH.approvalGate.confirm.proceed, { verb: zpra.verb.approveAndMerge }),
          exact: true,
        })
        .click();
      expect((await action).status()).toBe(200);
      for (const [repo, number] of membersOf('zh')) {
        await expect(
          overlayRow(dev, repo, number).getByText(zpra.outcome.merged, { exact: true }),
        ).toBeVisible();
      }
      await closeOverlay(page);
    });
    await beat();
  });
});
