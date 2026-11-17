import { writeFileSync } from 'node:fs';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { ingestContext } from './_helpers/agent-run-seed';
import { headShaFor } from './_helpers/approve-and-merge-seed';
import { resetHostedRunJournal, writeHostedRunFixture } from './_helpers/hosted-run-boundary';
import type { ContinueHostedSeed } from './_helpers/continue-hosted-seed';
import { TEAMMATE_GITHUB, seedReviewCard, seedReviewPath } from './_helpers/review-path-seed';
import {
  REVIEW_REPO_NAME,
  awaitReviewGate,
  fitsItsBox,
  openReviewPullRequest,
  revealReviewBoardCard,
  reviewChecksGreen,
  reviewDeliveryVersion,
  submitOwnAgentVerdict,
  type ReviewPullRequest,
} from './_helpers/review-path-flow';
import zh from '@/messages/zh.json';

// THE REVIEW PATH AT PHONE WIDTH (Story MOTIR-10327 · moved out of its receipt by MOTIR-11471).
//
// `acceptance-review-path.spec.ts` used to end on a chapter that shrank the recorded page to
// 390×844 and checked that, in 中文, the board card and the To approve row of a reviewed card
// still fit their boxes. A receipt records at the acceptance lane's ONE fixed frame and never
// resizes its page (the clip would be scaled into the frame mid-video), so the check lives
// here: the regression lane boots the acceptance lane's own server — the review agent, the
// GitHub merge seam, the hosted-run mock — without the recording, and this spec opens its page
// at phone width from the first frame.
//
// The state is the one the receipt's phone chapter read, reached through the same doors: a
// teammate's pull request goes green, the project reviews with the person's OWN agent, that
// agent passes it through the user-token verdict door, and the card waits for its approval
// wearing the Reviewed badge. Nothing is written to the database directly.
//
// ⚠️ THE 29xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 300_000 });
test.use({ viewport: { width: 390, height: 844 } });

const HARNESS = 'Claude Code';
const OWN_MODEL = 'e2e-own-model';
const PR: ReviewPullRequest = {
  number: 29101,
  author: TEAMMATE_GITHUB,
  headRef: 'review-path-phone/29101',
};
const MERGE_CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const MERGE_JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;

test.describe('the review path at phone width', () => {
  let s: ContinueHostedSeed;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    writeHostedRunFixture({
      models: { ids: ['e2e-hosted-default'], default: 'e2e-hosted-default' },
      mayRun: true,
    });
    resetHostedRunJournal();
    writeFileSync(MERGE_JOURNAL_PATH, '');
    writeFileSync(
      MERGE_CONTROL_PATH,
      JSON.stringify({ repositories: [REVIEW_REPO_NAME], ownAuthoredPullRequests: [] }),
    );
    s = await seedReviewPath(Date.now().toString(36).slice(-5).toUpperCase());
    await signIn(page, s.owner.email, s.hosted.password);
  });

  test('中文 at 390px: a reviewed card fits its board card and its To approve row', async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('no Playwright baseURL');
    const api = await ingestContext(s.owner.token, baseURL);
    const card = await seedReviewCard(s, 'Export the totals row');
    await openReviewPullRequest(page, card, PR);

    // The project reviews with the person's own agent — the settings door the UI saves through.
    const settings = await page.request.patch(
      `/api/projects/${s.hosted.projectKey}/approval-gates`,
      { data: { reviewAgentEnabled: true, reviewAgentSource: 'own' } },
    );
    expect(settings.status()).toBe(200);

    const sha = headShaFor(PR.number);
    const version = reviewDeliveryVersion([[PR, sha]]);
    await reviewChecksGreen(page, PR, sha);
    await awaitReviewGate(card, 'agent_review', version);
    await submitOwnAgentVerdict(
      api,
      card,
      { verdict: 'approved', subjectVersion: version },
      { harness: HARNESS, model: OWN_MODEL },
    );
    await awaitReviewGate(card, 'pull_request_approval', version);

    await page
      .context()
      .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', baseURL).href }]);

    await test.step('the board card fits, with its Reviewed badge', async () => {
      await page.goto('/boards');
      const tile = await revealReviewBoardCard(page, card);
      await expect(tile.locator('[data-reviewed-badge="reviewed"]')).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await fitsItsBox(tile);
    });

    await test.step('the To approve row fits, with its review line', async () => {
      await page.goto('/workbench?tab=approvals');
      const row = page
        .getByRole('main')
        .getByRole('table', { name: zh.workbench.tabs.toApprove })
        .getByRole('row')
        .filter({ hasText: card.identifier });
      await expect(row.locator('[data-review-line]')).toHaveAttribute(
        'data-review-line',
        'reviewed_by_agent',
        { timeout: FIRST_PAINT_MS },
      );
      await row.scrollIntoViewIfNeeded();
      await fitsItsBox(row);
    });

    await api.dispose();
  });
});
