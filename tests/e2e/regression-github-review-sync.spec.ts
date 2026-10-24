import { readFileSync, writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  checkSuitePayload,
  postSignedWebhook,
  pullRequestPayload,
  pullRequestReviewPayload,
} from './_helpers/github-seed';
import { linkPr } from './_helpers/pr-link';
import {
  API_REPO,
  WEB_REPO,
  headShaFor,
  seedApproveAndMerge,
  type ApproveAndMergeSeed,
  type SeedRepo,
  type SeededCard,
} from './_helpers/approve-and-merge-seed';
import { adminDb } from '../helpers/adminDb';
import type { GithubMergeCall, GithubMergeControl } from '@/lib/test-github-merge-mock';
import en from '@/messages/en.json';

// A GITHUB APPROVAL SYNCS INTO MOTIR — THE ACCEPTANCE RECEIPT (Story MOTIR-4910 ·
// Subtask MOTIR-5601).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A team reviews on GitHub. Nobody opens Motir. The card's two pull requests are green and
// the card is waiting on somebody to press *Approve and merge* — and then the reviews arrive
// there instead. The first approval lands on its row and the card keeps waiting, because the
// question is about BOTH commits. The second lands, and the card is Approved and both pull
// requests merge, with nothing left on screen to press. The person who finished it has no
// Motir account, and the record says so in words rather than leaving a blank where a name
// should be.
//
// Then the three answers a demo would hide: a merge the host refuses leaves the approval
// standing and offers a retry on that row alone; changes requested on GitHub decides the
// question the other way and merges nothing; and a review that does not count — from someone
// who cannot write, or at a commit that has moved — leaves the card exactly where it was.
//
// ── THE SEAMS THIS LANE USES ────────────────────────────────────────────────
//
//   * The reviewer's PERMISSION and GitHub's merge — ONE seam, `E2E_TEST_GITHUB_MERGE`
//     (`lib/test-github-merge-mock.ts`), selected in `playwright.acceptance.config.ts`'s
//     `webServer.env` with its control and journal paths. The permission intercept is
//     MOTIR-5595's addition to that same seam, so this lane installs both with one flag.
//   * The reviews, the pull requests and their green checks — SIGNED deliveries to the real
//     `/api/github/webhook` route (`github-seed.ts`).
//
// ⚠️ THE INTERCEPTS ARE PROVEN ACTIVE AT THE EARLIEST MOMENT THEY ARE OBSERVABLE. A
// permission read is a server-side round trip, so nothing about it is visible until one has
// been made — but the seam JOURNALS each one, so the first review's own permission read is an
// entry this spec asserts on, and one journalled entry proves the whole MockAgent is
// INSTALLED rather than merely configured. It matters because an unreachable intercept
// answers `unknown`, which counts for nothing: every review below would be uncountable, and
// flow 4 — which asserts that NOTHING happens — would pass for exactly the wrong reason.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: each delivery's own JSON outcome, then the rendered state.
// No timed wait stands in for correctness; the `chapter()` / `beat()` holds are pacing, taken
// after the assertion they follow.
//
// ⚠️ THE 14xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 480_000 });

const PRS = {
  synced: { web: { number: 14101 }, api: { number: 14102 } },
  refused: { web: { number: 14201 }, api: { number: 14202 } },
  changes: { web: { number: 14301 }, api: { number: 14302 } },
  uncounted: { web: { number: 14401 }, api: { number: 14402 } },
} as const;

type Scenario = keyof typeof PRS;

/** A member of the workspace, bound to a GitHub identity — their approval names a person. */
const MEMBER_REVIEWER = { login: 'writer-member', id: 71001 } as const;
/** No Motir account at all — the case §6b's *Not a Motir member* line exists for. */
const OUTSIDER_REVIEWER = { login: 'outsider', id: 71002 } as const;
/** Can read the repository and nothing more: GitHub does not count their approval either. */
const READER_REVIEWER = { login: 'drive-by-reader', id: 71003 } as const;

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;

const prName = (repo: SeedRepo, number: number) => `${repo.owner}/${repo.name} · #${number}`;
const prKey = (repo: SeedRepo, number: number) => `${repo.owner}/${repo.name}#${number}`;
const repoKey = (repo: SeedRepo) => `${repo.owner}/${repo.name}`;
const headRefFor = (card: SeededCard, number: number) =>
  `review/${card.identifier.toLowerCase()}-${number}`;

function writeControl(control: GithubMergeControl): void {
  writeFileSync(CONTROL_PATH, JSON.stringify(control));
}

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

/** The permission reads this seam has answered — the proof the intercept is installed. */
const permissionReads = (): string[] =>
  journal()
    .filter((c) => c.method === 'GET' && /\/collaborators\/[^/]+\/permission$/.test(c.path))
    .map((c) => c.path);

/** The merges this seam has been asked for, by pull request. */
const mergePresses = (): string[] =>
  journal()
    .filter((c) => c.method === 'PUT' && c.pullRequest !== null)
    .map((c) => c.pullRequest!);

/** The item page's Development card — the section card headed by its title. */
const developmentCard = (page: Page): Locator =>
  page.locator('[data-surface="card"]').filter({
    has: page.getByRole('heading', { level: 2, name: en.github.development.title, exact: true }),
  });

/** One pull-request row of the Development card, by its `owner/name · #n` meta line. */
const prRow = (page: Page, repo: SeedRepo, number: number): Locator =>
  developmentCard(page)
    .locator('li')
    .filter({ hasText: prName(repo, number) });

/** The detail rail's Status field card, which also carries the gate's state. */
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

let reviewSeq = 0;

/**
 * Deliver ONE review, and read the route's own JSON outcome.
 *
 * That outcome is the authoritative signal: it is written after the whole of the service
 * handling has finished — the permission read, the row, the evaluation and any merge — so a
 * spec waiting on it is never racing the work, unlike one waiting on a 200.
 */
async function deliverReview(
  page: Page,
  args: {
    repo: SeedRepo;
    number: number;
    reviewer: { login: string; id: number };
    state?: 'approved' | 'changes_requested';
    /** The commit the REVIEW names, when it is deliberately not the current head. */
    commitSha?: string;
  },
): Promise<string> {
  const res = await postSignedWebhook(
    page.request,
    'pull_request_review',
    pullRequestReviewPayload({
      number: args.number,
      headSha: headShaFor(args.number),
      commitSha: args.commitSha,
      reviewId: 990000 + ++reviewSeq,
      state: args.state ?? 'approved',
      reviewer: args.reviewer,
      repo: args.repo,
    }),
  );
  expect(
    res.status(),
    `review on ${prKey(args.repo, args.number)} → ${(await res.text()).slice(0, 300)}`,
  ).toBe(200);
  const body = (await res.json()) as { result?: { outcome?: string } };
  return body.result?.outcome ?? '';
}

/** Open both pull requests of a card, link them, and turn both green — the path a run and its
 *  CI walk, so the gate is raised by the REAL promotion rather than by a seeded row. */
async function deliverGreen(page: Page, card: SeededCard, scenario: Scenario): Promise<void> {
  for (const [repo, pr] of [
    [WEB_REPO, PRS[scenario].web],
    [API_REPO, PRS[scenario].api],
  ] as const) {
    const headRef = headRefFor(card, pr.number);
    const opened = await postSignedWebhook(
      page.request,
      'pull_request',
      pullRequestPayload({
        action: 'opened',
        number: pr.number,
        title: `${card.title} — ${repo.name}`,
        headRef,
        state: 'open',
        merged: false,
        repo,
      }),
    );
    expect(opened.status(), `open ${prKey(repo, pr.number)}`).toBe(200);
    await linkPr(page, { workItemId: card.id, repo, number: pr.number, headRef });
  }
  for (const [repo, pr] of [
    [WEB_REPO, PRS[scenario].web],
    [API_REPO, PRS[scenario].api],
  ] as const) {
    const green = await postSignedWebhook(
      page.request,
      'check_suite',
      checkSuitePayload({
        conclusion: 'success',
        headSha: headShaFor(pr.number),
        prNumber: pr.number,
        headBranch: headRefFor(card, pr.number),
        repo,
      }),
    );
    expect(green.status(), `green ${prKey(repo, pr.number)}`).toBe(200);
  }
}

/** GitHub reports a merge — the single writer of `done`. */
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

test.describe('a GitHub approval syncs into Motir', () => {
  let seed: ApproveAndMergeSeed;
  const gate = en.approvalGate;
  const pra = en.approvalGate.pullRequestApproval;
  const github = en.approvalGate.pullRequestApproval.github;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    seed = await seedApproveAndMerge(Date.now().toString(36));
    writeFileSync(JOURNAL_PATH, '');

    // What the fake GitHub answers. Both repositories merge, except the refused card's api
    // pull request. The reviewers' permissions are this story's addition to the same control.
    writeControl({
      repositories: [repoKey(WEB_REPO), repoKey(API_REPO)],
      pullRequests: {
        // ⚠️ A conflict the MERGE meets after the decision (§ 28), not one the press
        // finds first: the host's read says `clean`, then the merge is refused
        // (MOTIR-5915 — a `dirty` read would refuse at the press instead, § 30 Panel 5a).
        [prKey(API_REPO, PRS.refused.api.number)]: {
          outcome: 'refused',
          refusal: 'conflict',
          mergeable: true,
          mergeableState: 'clean',
        },
      },
      reviewerPermissions: {
        [MEMBER_REVIEWER.login]: 'write',
        [OUTSIDER_REVIEWER.login]: 'write',
        // Can read and nothing more — the one permission that makes an approval uncountable
        // without anything at all having gone wrong.
        [READER_REVIEWER.login]: 'read',
      },
    });

    // ONE of the three reviewers has a Motir account, bound to their GitHub identity. The
    // other two deliberately do not: that is what makes the non-member wording reachable, and
    // it is the ordinary case — a repository's reviewers are not a Motir workspace.
    const owner = await adminDb.user.findFirstOrThrow({ where: { email: seed.ownerEmail } });
    await adminDb.githubIdentity.create({
      data: {
        userId: owner.id,
        githubUserId: String(MEMBER_REVIEWER.id),
        githubLogin: MEMBER_REVIEWER.login,
        accessTokenEncrypted: 'e2e-not-a-real-token',
      },
    });

    await signIn(page, seed.ownerEmail, seed.password);
    await deliverGreen(page, seed.merged, 'synced');
    await deliverGreen(page, seed.refused, 'refused');
    await deliverGreen(page, seed.queued, 'changes');
    await deliverGreen(page, seed.zh, 'uncounted');
  });

  test('reviews on GitHub decide the card and merge its pull requests', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-4910');
    const web = PRS.synced.web.number;
    const api = PRS.synced.api.number;

    await chapter('The card is waiting: two green pull requests, one question', async () => {
      await page.goto(`/items/${seed.merged.identifier}`);
      const dev = developmentCard(page);
      await expect(dev).toHaveCount(1, { timeout: 60_000 });
      await expect(prRow(page, WEB_REPO, web)).toHaveCount(1);
      await expect(prRow(page, API_REPO, api)).toHaveCount(1);
      // ONE gate over the whole set, and the person it waits on can still answer it in Motir
      // — which is what makes the next two chapters a SYNC rather than the only way through.
      // ⚠️ AMENDED by MOTIR-6323: answered through the band's ONE control into the approval
      // overlay; the item page carries no verb of its own.
      await expect(
        dev.getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove, exact: true }),
      ).toBeVisible();
    });
    await beat();

    await chapter('A teammate approves the first pull request on GitHub', async () => {
      const outcome = await deliverReview(page, {
        repo: WEB_REPO,
        number: web,
        reviewer: MEMBER_REVIEWER,
      });

      // ⚠️ THE INTERCEPTS ARE PROVEN HERE, AT THE FIRST MOMENT THEY ARE OBSERVABLE. The
      // permission read reached the seam rather than the real github.com, which is what this
      // whole lane rests on: had it fallen through, the answer would be `unknown`, nothing
      // below would count, and flow 4 would pass for the wrong reason. One journalled entry
      // proves the MockAgent is installed — the merge intercept along with it.
      expect(permissionReads(), 'the permission intercept must be active').toContain(
        `/repos/${repoKey(WEB_REPO)}/collaborators/${MEMBER_REVIEWER.login}/permission`,
      );

      // ⚠️ ONE APPROVAL DECIDES NOTHING. The question names BOTH commits, so a countable
      // approval on one member leaves the gate exactly where it was.
      expect(outcome).toBe('pending');

      await page.reload();
      await expect(prRow(page, WEB_REPO, web).getByText(github.chip.approved)).toBeVisible();
      // ⚠️ THE GATE'S STATE IS IN THE DEVELOPMENT CARD; THE STATUS CARD CARRIES THE WORK
      // ITEM'S. They are different facts and the story turns on the difference, so this
      // asserts both: the gate still Awaiting, the card still In Review.
      await expect(developmentCard(page)).toContainText(gate.state.awaiting);
      await expect(statusCard(page)).toContainText('In Review');
      // ⚠️ AMENDED by MOTIR-6323: still answerable — through the band's door.
      await expect(
        developmentCard(page).getByRole('link', {
          name: en.approvalGate.statusHeld.reviewAndApprove,
          exact: true,
        }),
      ).toBeVisible();
      expect(mergePresses(), 'nothing merges on a half-approved set').toEqual([]);
    });
    await beat();

    await chapter(
      'Someone with no Motir account approves the second — the card is Approved',
      async () => {
        const outcome = await deliverReview(page, {
          repo: API_REPO,
          number: api,
          reviewer: OUTSIDER_REVIEWER,
        });
        expect(outcome).toBe('decided_approved');

        await page.reload();
        await expect(statusCard(page)).toContainText(gate.state.approved);

        const dev = developmentCard(page);
        // The record names them, and says plainly what Motir does not know about them — never
        // a blank, and never a bare handle that reads as a missing name (§6b).
        await expect(dev).toContainText(`@${OUTSIDER_REVIEWER.login}`);
        await expect(dev).toContainText(github.record.notMember);
        // ⚠️ NO MERGE PRESS IS LEFT. The approval WAS the instruction to merge, so offering
        // one would describe a decision nobody still has to make.
        await expect(dev.getByRole('button', { name: pra.verb.approveAndMerge })).toHaveCount(0);
      },
    );
    await beat();

    await chapter('Both pull requests merge, and GitHub’s report finishes the card', async () => {
      // ⚠️ THE MERGES ARE READ FROM THE SEAM'S JOURNAL, NOT FROM A PILL. A member that
      // MERGED persists no outcome for the row to draw — there is nothing left to retry, and
      // the lasting fact is the pull request's own state, which arrives with GitHub's report.
      // So the press is proven where it happened, and the row is asserted after the report.
      expect(mergePresses().sort()).toEqual([prKey(API_REPO, api), prKey(WEB_REPO, web)].sort());

      await mergedWebhook(page, seed.merged, WEB_REPO, web);
      await mergedWebhook(page, seed.merged, API_REPO, api);
      await page.reload();
      await expect(
        prRow(page, WEB_REPO, web).getByText(en.github.development.prState.merged, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        prRow(page, API_REPO, api).getByText(en.github.development.prState.merged, {
          exact: true,
        }),
      ).toBeVisible();
      // The webhook, and nothing else, is what finishes the card.
      await expect(statusCard(page)).toContainText('Done', { timeout: 60_000 });
    });
    await beat();
  });

  // ⚠️ A TEST WAS REMOVED HERE, AND THE RECEIPT IT BELONGS TO IS UNTOUCHED (Story
  // MOTIR-5799 · MOTIR-5808; `docs/decisions/approval-gates.md` § 4 FOURTH AMENDMENT,
  // point 1). It read *a merge the host refuses leaves the approval standing, and retries
  // that row alone*, and that was true when MOTIR-4910 was accepted. It is not true now:
  // a press that does not land SPENDS the approval, so a refusal re-asks (a setting) or
  // drops the card to Implemented (a conflict), and *Retry merge* decides a FRESH gate
  // rather than riding the old one.
  //
  // It was DELETED rather than re-pointed at the new behaviour, because a receipt's spec
  // records what a person watched and approved — rewriting its assertions to agree with
  // today edits history (`docs/decisions/acceptance-receipt-lifecycle.md` § 3, and
  // `CLAUDE.md`'s *an `acceptance-*.spec.ts` is a RECEIPT*). The host-refusal behaviour is
  // covered where it now lives:
  //
  //   · `tests/e2e/acceptance-merge-unlanded-classes.spec.ts` — journey 3, the setting
  //     class end to end, with its own video;
  //   · `tests/integration/mergeStoryJourney.test.ts` journey 5 and
  //     `tests/github/mergeRefusalRecord.test.ts` — every refusal code, by class, on real
  //     Postgres, in a lane that runs on EVERY pull request.

  test('changes requested on GitHub decides the question the other way, and merges nothing', async ({
    page,
  }) => {
    const web = PRS.changes.web.number;
    const before = mergePresses().length;

    expect(
      await deliverReview(page, {
        repo: WEB_REPO,
        number: web,
        reviewer: MEMBER_REVIEWER,
        state: 'changes_requested',
      }),
    ).toBe('decided_changes_requested');

    await page.goto(`/items/${seed.queued.identifier}`);
    await expect(developmentCard(page)).toContainText(gate.state.changesRequested, {
      timeout: 60_000,
    });
    // ⚠️ A GATE'S STATE IS NOT A WORK ITEM'S STATUS. Sending the set back records a decision
    // and writes no status, so the card stays exactly where the run left it.
    await expect(statusCard(page)).toContainText('In Review');
    // ⚠️ ONE MEMBER IS ENOUGH TO SEND THE SET BACK, and the asymmetry with approval is the
    // point: approval is about every commit, refusal is about any one of them.
    await expect(developmentCard(page)).toContainText('Changes requested on GitHub by');
    await expect(prRow(page, WEB_REPO, web).getByText(github.chip.changesRequested)).toBeVisible();
    // Nothing merged — asserted at the seam rather than by the absence of a pill.
    expect(mergePresses().length).toBe(before);
  });

  test('a review that does not count leaves the card exactly where it was', async ({ page }) => {
    const web = PRS.uncounted.web.number;
    const api = PRS.uncounted.api.number;

    // (a) A reviewer who can only READ the repository. GitHub does not count their approval
    //     towards its own required reviews, and Motir must not count it towards a gate.
    expect(
      await deliverReview(page, { repo: WEB_REPO, number: web, reviewer: READER_REVIEWER }),
    ).toBe('pending');

    // (b) An approval given at a commit that is no longer the head — the reviewer approved
    //     work that has since been rewritten.
    expect(
      await deliverReview(page, {
        repo: API_REPO,
        number: api,
        reviewer: MEMBER_REVIEWER,
        commitSha: headShaFor(999999),
      }),
    ).toBe('pending');

    await page.goto(`/items/${seed.zh.identifier}`);
    const dev = developmentCard(page);
    await expect(dev).toHaveCount(1, { timeout: 60_000 });
    // The question is still open, still answerable by the person it waits on — through the
    // band's door (AMENDED by MOTIR-6323: the item page carries no verb of its own).
    await expect(
      dev.getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove, exact: true }),
    ).toBeVisible();
    // `state.awaitingYou` contains `state.awaiting`, so this one assertion covers the gate as
    // the decider sees it and as a bystander would.
    await expect(dev).toContainText(gate.state.awaiting);
    await expect(statusCard(page)).toContainText('In Review');

    // The reader's review draws NOTHING — an uncountable review is not a state, so the row
    // keeps the CI pill it had.
    await expect(prRow(page, WEB_REPO, web).getByText(github.chip.approved)).toHaveCount(0);
    await expect(prRow(page, WEB_REPO, web)).toContainText(en.github.development.ciState.passing);
    // ⚠️ THE STALE ONE IS DRAWN, SAID IN WORDS. It counts for nothing either way — but a
    // reader who could see that an approval exists and not that it is stale would conclude
    // Motir had lost it (design § 23, Panel G2).
    await expect(prRow(page, API_REPO, api).getByText(github.chip.earlierCommit)).toBeVisible();

    expect(mergePresses(), 'an uncountable review merges nothing').toEqual([]);
  });
});
