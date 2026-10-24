import { readFileSync, writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { paidOrgState, resetBillingFixture, setOrgBillingState } from './_helpers/billing';
import { signIn } from './_helpers/shell-session';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { linkPr } from './_helpers/pr-link';
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

// A STORY RUN'S ACCEPTANCE, APPROVED FROM THE FULL-SCREEN OVERLAY (Story MOTIR-4949 ·
// Bug MOTIR-6079).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// `regression-gate.spec.ts` walks the one press from the story's ITEM PAGE. Most approvals
// are made from To approve, whose row opens the approval OVERLAY — and there the press
// approved the acceptance and merged the story's code while the pull-request rows beneath
// the video did not change: no *Merged*, no *Queued to merge*. The overlay never handed the
// frame the merge gate's version, so the frame counted no members and had no row to land
// an outcome on. This walks the same press from the overlay, and asserts what the reviewer
// sees there: the pull requests the press will merge named BEFORE it, and each row's
// outcome AFTER it — still there once the overlay has re-read its rows.
//
// ── THE SEAMS THIS LANE USES ────────────────────────────────────────────────
//
// `regression-gate.spec.ts`'s, unchanged: GitHub's merge through `E2E_TEST_GITHUB_MERGE`
// (the journal proves the press reached it), signed webhooks for the pull requests and
// their checks, the real link door, and the receipt through the seed's shipped predicate.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's response, the server action's response, the
// overlay's own re-read response, or a role. No timed wait.
//
// ⚠️ THE 20xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 300_000 });

const PRS = { web: { number: 20101 }, api: { number: 20102 } } as const;
const MEMBERS = [
  [WEB_REPO, PRS.web.number],
  [API_REPO, PRS.api.number],
] as const;

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;

const acc = en.approvalGate.acceptanceResult;
const pra = en.approvalGate.pullRequestApproval;

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
const prName = (repo: SeedRepo, number: number) => `${repo.owner}/${repo.name} · #${number}`;
const prKey = (repo: SeedRepo, number: number) => `${repo.owner}/${repo.name}#${number}`;
const headRefFor = (card: SeededCard, number: number) =>
  `accovl/${card.identifier.toLowerCase()}-${number}`;
/** The pair as the one-press copy lists it — sorted, as the set version is. */
const PAIR = fill(pra.list.pair, {
  a: prName(API_REPO, PRS.api.number),
  b: prName(WEB_REPO, PRS.web.number),
});

function mergedThroughTheSeam(): string[] {
  try {
    return readFileSync(JOURNAL_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GithubMergeCall)
      .filter((call) => call.method === 'PUT')
      .flatMap((call) => (call.pullRequest === null ? [] : [call.pullRequest]));
  } catch {
    return [];
  }
}

/** The acceptance overlay, by its SETTLED accessible name — the read's own answer. */
const overlayFor = (page: Page, story: SeededCard): Locator =>
  page.getByRole('dialog', {
    name: fill(en.approvalOverlay.dialogTitle, {
      kind: en.workbench.approvals.kind.acceptance_result,
      key: story.identifier,
    }),
    exact: true,
  });

/** One pull-request row INSIDE the overlay, by its `owner/name · #n` meta line. */
const overlayRow = (dialog: Locator, repo: SeedRepo, number: number): Locator =>
  dialog.locator('li').filter({ hasText: prName(repo, number) });

/** Arm a wait for the next server action's response — a POST carrying `Next-Action`. */
const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

test.describe('a story run approved from the approval overlay', () => {
  let seed: AcceptanceGateSeed;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    resetBillingFixture();
    seed = await seedAcceptanceGate(`ovl${Date.now().toString(36)}`);
    setOrgBillingState(seed.organizationId, paidOrgState());
    writeFileSync(JOURNAL_PATH, '');
    const control: GithubMergeControl = {
      repositories: [`${WEB_REPO.owner}/${WEB_REPO.name}`, `${API_REPO.owner}/${API_REPO.name}`],
    };
    writeFileSync(CONTROL_PATH, JSON.stringify(control));

    await signIn(page, seed.ownerEmail, seed.password);

    // THE RUN'S OWN ORDER: the story's pull requests open, link and go green, then the
    // recording is published — which finds BOTH questions owed.
    const story = seed.storyRun.story;
    for (const [repo, number] of MEMBERS) {
      const headRef = headRefFor(story, number);
      const opened = await postSignedWebhook(
        page.request,
        'pull_request',
        pullRequestPayload({
          action: 'opened',
          number,
          title: `${story.title} — ${repo.name}`,
          headRef,
          state: 'open',
          merged: false,
          repo,
        }),
      );
      expect(opened.status(), `open ${prKey(repo, number)}`).toBe(200);
      await linkPr(page, { workItemId: story.id, repo, number, headRef });
    }
    for (const [repo, number] of MEMBERS) {
      const green = await postSignedWebhook(
        page.request,
        'check_suite',
        checkSuitePayload({
          conclusion: 'success',
          headSha: headShaFor(number),
          prNumber: number,
          headBranch: headRefFor(story, number),
          repo,
        }),
      );
      expect(green.status(), `green ${prKey(repo, number)}`).toBe(200);
    }
    await publishReceipt({
      workspaceId: seed.workspaceId,
      uploaderUserId: seed.ownerUserId,
      story,
      producedByKey: seed.storyRun.e2e.identifier,
      commitSha: headShaFor(PRS.web.number),
    });
  });

  test('one press in the overlay accepts the story, and each pull-request row says what happened to it', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-4949');
    const story = seed.storyRun.story;

    await chapter('Open the recording from To approve', async () => {
      await page.goto('/workbench?tab=approvals');
      const row = page
        .getByRole('table', { name: en.workbench.tabs.toApprove })
        .getByTestId(/^approval-row-/)
        .filter({ hasText: story.identifier });
      await expect(row).toHaveCount(1, { timeout: 60_000 });
      await row.getByRole('button', { name: en.workbench.approvals.review, exact: true }).click();
      const dialog = overlayFor(page, story);
      await expect(dialog).toHaveCount(1, { timeout: 60_000 });
      await expect(dialog.getByTestId('acceptance-development-slot')).toHaveCount(1);
      for (const [repo, number] of MEMBERS) {
        await expect(overlayRow(dialog, repo, number)).toHaveCount(1);
      }
      // BEFORE the press the frame names what it merges — both pull requests, not none.
      await expect(
        dialog.getByText(fill(acc.consequenceMerges, { key: story.identifier, prs: PAIR }), {
          exact: true,
        }),
      ).toBeVisible();
    });
    await beat();

    await chapter('Approve and merge: each row says it merged', async () => {
      const dialog = overlayFor(page, story);
      await dialog.getByRole('button', { name: pra.verb.approveAndMerge, exact: true }).click();
      await expect(dialog.getByText(acc.confirm.records, { exact: true })).toBeVisible();

      const action = serverAction(page);
      // The overlay re-reads its rows once the press lands — through the MERGE gate's read.
      const reread = page.waitForResponse(
        (res) =>
          res.url().includes('/api/work-items/approval-gate?') &&
          res.url().includes('kind=pull_request_approval'),
      );
      await dialog
        .getByRole('button', {
          name: fill(en.approvalGate.confirm.proceed, { verb: pra.verb.approveAndMerge }),
          exact: true,
        })
        .click();
      expect((await action).status()).toBe(200);
      expect((await reread).status()).toBe(200);

      // The press reached the merge seam for both pull requests …
      expect(mergedThroughTheSeam()).toEqual(
        expect.arrayContaining([prKey(WEB_REPO, PRS.web.number), prKey(API_REPO, PRS.api.number)]),
      );
      // … and every row in the overlay says so, after the re-read as well as before it.
      await expect(dialog.getByText(en.approvalGate.state.approved).first()).toBeVisible();
      for (const [repo, number] of MEMBERS) {
        await expect(
          overlayRow(dialog, repo, number).getByText(pra.outcome.merged, { exact: true }),
        ).toBeVisible();
      }
    });
    await beat();
  });
});
