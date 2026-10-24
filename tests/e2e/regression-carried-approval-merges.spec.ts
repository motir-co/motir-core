import { readFileSync, writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { linkPr } from './_helpers/pr-link';
import { approvalSentence } from './_helpers/approval-sentence';
import {
  openAgentSession,
  publishDesignResult,
  servePublishedMock,
} from './_helpers/design-approval-seed';
import {
  CARRY_API_REPO,
  CARRY_WEB_REPO,
  carryHeadSha,
  seedCarriedApproval,
  type CarriedApprovalSeed,
  type CarryRepo,
} from './_helpers/carried-approval-seed';
import type { GithubMergeCall, GithubMergeControl } from '@/lib/test-github-merge-mock';
import en from '@/messages/en.json';

// AN APPROVAL PRESSED BEFORE THE CHECKS PASS IS CARRIED TO THE NEXT GREEN — AND MERGES
// (Bug MOTIR-5986; `design-result.md` AMENDMENT 6 Q4, shipped by Story MOTIR-5652).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A run publishes a design onto a card whose pull requests are still running their
// checks. The reviewer approves the design straight away. Nothing merges — nothing is
// green. Then the checks pass, and the pull requests merge ON THEIR OWN: no second
// question, no second press. If that ever broke, the only symptom would be a green pull
// request that never merges, which is why this spec watches the merge land.
//
// ── WHERE THE MERGE HAPPENS, AND WHY THAT IS THE POINT ──────────────────────
//
// The press merges nothing. The green `check_suite` delivery reaches the CI promotion,
// whose `settleGreenVerdict` finds the design approval standing (`primaryApprovalCarries`)
// and dispatches `pull-request/auto-merge.requested` — a JOB. So the merge is made by the
// lane's JOB WORKER, not by the server the browser talks to. Until MOTIR-5837 that
// process had no GitHub seam and this path could not be reached from a spec at all; now
// it installs the merge seam and shares this runner's control and journal files
// (`githubMergeSeamEnv` in `_helpers/job-worker-process.ts`).
//
// ── THE SEAMS THIS LANE USES ────────────────────────────────────────────────
//
//   * GitHub's merge — `E2E_TEST_GITHUB_MERGE` (`lib/test-github-merge-mock.ts`), in the
//     server AND the worker. The spec WRITES which repositories merge and READS the journal.
//   * The pull requests and their green checks — SIGNED deliveries to the real webhook
//     route; the links — the real link door.
//   * The design result — the REAL `publish_design_result` tool over `/api/mcp`.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's own response, the server action's response,
// a role, a committed read, or `expect.poll` over the merge journal and the job ledger —
// the two records the worker writes. No timed wait anywhere in this file; the holds are
// `chapter()` / `beat()`'s, taken after the assertion.
//
// ⚠️ THE 18xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 300_000 });

const PRS = {
  web: { repo: CARRY_WEB_REPO, number: 18101 },
  api: { repo: CARRY_API_REPO, number: 18102 },
} as const;
const MEMBERS = [PRS.web, PRS.api] as const;

const AUTO_MERGE_JOB = 'pull-request/auto-merge.requested';

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

const prKey = (repo: CarryRepo, number: number) => `${repo.owner}/${repo.name}#${number}`;
const prName = (repo: CarryRepo, number: number) => `${repo.owner}/${repo.name} · #${number}`;
const headRefFor = (seed: CarriedApprovalSeed, number: number) =>
  `design/${seed.design.identifier.toLowerCase()}-${number}`;

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

/** Every pull request the merge seam was asked to MERGE, as `owner/name#n`, sorted. */
const mergePuts = (): string[] =>
  journal()
    .filter((call) => call.method === 'PUT')
    .flatMap((call) => (call.pullRequest === null ? [] : [call.pullRequest]))
    .sort();

/** The mirrored pull-request row for one member. */
const pullRequestRow = (repo: CarryRepo, number: number) =>
  adminDb.githubPullRequest.findFirstOrThrow({
    where: { number, repo: { repoId: repo.providerRepoId } },
  });

/** This workspace's runs of the auto-merge job, as `<idempotencyKey> → <status>`, sorted. */
async function autoMergeRuns(workspaceId: string): Promise<string[]> {
  const runs = await adminDb.jobRun.findMany({
    where: { functionId: AUTO_MERGE_JOB, workspaceId },
  });
  return runs.map((run) => `${run.idempotencyKey} → ${run.status}`).sort();
}

/** The item page's Development card — the section card headed by its title. */
const developmentCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: en.github.development.title }) });

/** The To-approve table's row for the design card. */
const approvalRow = (page: Page, seed: CarriedApprovalSeed): Locator =>
  page
    .getByRole('table', { name: en.workbench.tabs.toApprove })
    .getByTestId(/^approval-row-/)
    .filter({ hasText: seed.design.identifier });

test.describe('an approval carried to the next green verdict', () => {
  let seed: CarriedApprovalSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedCarriedApproval(Date.now().toString(36));
    writeFileSync(JOURNAL_PATH, '');
    // What GitHub answers: both repositories merge whatever they are handed.
    const control: GithubMergeControl = {
      repositories: MEMBERS.map(({ repo }) => `${repo.owner}/${repo.name}`),
    };
    writeFileSync(CONTROL_PATH, JSON.stringify(control));
  });

  test('a design approved before its checks pass merges when they do, with no second press', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5652');
    await servePublishedMock(page);
    await signIn(page, seed.ownerEmail, seed.password);

    await chapter('A design is published while its pull requests are still running', async () => {
      for (const { repo, number } of MEMBERS) {
        const headRef = headRefFor(seed, number);
        const opened = await postSignedWebhook(
          page.request,
          'pull_request',
          pullRequestPayload({
            action: 'opened',
            number,
            title: `${seed.design.title} — ${repo.name}`,
            headRef,
            state: 'open',
            merged: false,
            repo,
          }),
        );
        expect(opened.status(), `open ${prKey(repo, number)}`).toBe(200);
        await linkPr(page, { workItemId: seed.design.id, repo, number, headRef });
      }

      const client = await openAgentSession(seed.token, baseURL!);
      const published = await publishDesignResult(client, seed.design.identifier);
      await client.close();
      expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);

      await page.goto(`/items/${seed.design.identifier}`);
      const dev = developmentCard(page);
      await expect(dev).toHaveCount(1, { timeout: 60_000 });
      for (const { repo, number } of MEMBERS) {
        await expect(dev.locator('li').filter({ hasText: prName(repo, number) })).toHaveCount(1);
      }
    });
    await beat();

    await chapter('The reviewer approves the design before any check has passed', async () => {
      await page.goto('/workbench?tab=approvals');
      const row = approvalRow(page, seed);
      await expect(row).toHaveCount(1, { timeout: 60_000 });
      // The row reads as a sentence about the work item (MOTIR-5999).
      await expect(
        row.getByText(approvalSentence(en, 'design_result', seed.design.title), { exact: true }),
      ).toBeVisible();
      await row.getByRole('link', { name: /^Review / }).click({ position: { x: 8, y: 22 } });
      const dialog = page.getByRole('dialog', {
        name: `${en.workbench.approvals.kind.design_result} for ${seed.design.identifier}`,
      });
      await expect(dialog).toBeVisible();
      await beat();

      await dialog.getByRole('button', { name: en.approvalGate.verb.approve, exact: true }).click();
      await expect(dialog.getByText(en.approvalGate.confirm.title)).toBeVisible();
      const decided = page.waitForResponse(
        (res) =>
          res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
      );
      await dialog
        .getByRole('button', {
          name: fill(en.approvalGate.confirm.proceed, { verb: en.approvalGate.verb.approve }),
          exact: true,
        })
        .click();
      expect((await decided).status()).toBe(200);
      await expect(dialog.getByText(en.approvalGate.state.approved, { exact: true })).toBeVisible();

      // The press was answered and merged NOTHING — nothing is green. Read after the
      // action's own response, which is where a press-time merge would have happened.
      expect(mergePuts()).toEqual([]);
      expect(await autoMergeRuns(seed.workspaceId)).toEqual([]);
      for (const { repo, number } of MEMBERS) {
        const row = await pullRequestRow(repo, number);
        expect(row.mergeAuthority, prKey(repo, number)).toBeNull();
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
    await beat();

    await chapter('The checks pass, and the pull requests merge with no second press', async () => {
      const heads = new Map<number, string>();
      for (const { repo, number } of MEMBERS) {
        const green = await postSignedWebhook(
          page.request,
          'check_suite',
          checkSuitePayload({
            conclusion: 'success',
            headSha: carryHeadSha(number),
            prNumber: number,
            headBranch: headRefFor(seed, number),
            repo,
          }),
        );
        expect(green.status(), `green ${prKey(repo, number)}`).toBe(200);
        heads.set(number, carryHeadSha(number));
      }

      // THE AUTHORITATIVE SIGNAL: the merge seam's journal, written by whichever process
      // made the call — polled, never slept on.
      await expect
        .poll(mergePuts, { timeout: 90_000, message: 'the merge seam saw a PUT per member' })
        .toEqual(MEMBERS.map(({ repo, number }) => prKey(repo, number)).sort());

      // …and it was the WORKER's job that made them: one succeeded run of the auto-merge
      // job per member, keyed `(pull request, head)`, and each row recorded as an AUTO
      // merge (`pullRequestAutoMergeService.mergeOnGreen` is the only writer of it).
      const expectedRuns: string[] = [];
      for (const { repo, number } of MEMBERS) {
        const row = await pullRequestRow(repo, number);
        expectedRuns.push(`${row.id}:${heads.get(number)} → succeeded`);
      }
      await expect
        .poll(() => autoMergeRuns(seed.workspaceId), {
          timeout: 60_000,
          message: 'one succeeded auto-merge run each',
        })
        .toEqual(expectedRuns.sort());
      for (const { repo, number } of MEMBERS) {
        const row = await pullRequestRow(repo, number);
        expect(row.mergeAuthority, prKey(repo, number)).toBe('auto_mode');
        expect(row.mergeOutcomeRef, prKey(repo, number)).toBeTruthy();
      }

      // No second question was raised: nothing waits on To approve for this card.
      await page.goto('/workbench?tab=approvals');
      await expect(
        page.getByRole('main').getByText(en.workbench.empty.approvals.title, { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(approvalRow(page, seed)).toHaveCount(0);
    });
    await beat();
  });
});
