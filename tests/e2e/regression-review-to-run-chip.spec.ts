import { writeFileSync } from 'node:fs';
import type { Locator } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { headShaFor } from './_helpers/approve-and-merge-seed';
import { resetHostedRunJournal, writeHostedRunFixture } from './_helpers/hosted-run-boundary';
import type { ContinueHostedSeed } from './_helpers/continue-hosted-seed';
import { TEAMMATE_GITHUB, seedReviewCard, seedReviewPath } from './_helpers/review-path-seed';
import {
  REVIEW_REPO_NAME,
  awaitReviewGate,
  openReviewPullRequest,
  reviewChecksGreen,
  reviewDeliveryVersion,
  type ReviewPullRequest,
} from './_helpers/review-path-flow';

// THE REVIEW-TO-RUN ROW'S COMMAND SITS ON LINE 2, WHOLE (Bug MOTIR-11982; MOTIR-12032).
//
// Waiting on you lists a card that waits for its review as a *Review to run* row. Since
// MOTIR-12032 (`design/workbench/design-notes.md` § 45) the row is laid out like a To fix
// row: line 1 the work item on the approvals grid, with an EMPTY DETAILS cell, and line 2 the
// waiting sentence on the left and the copyable `motir review <KEY>` on the right. The chip
// used to sit in the fixed 220px DETAILS track, where it painted over WAITED and then
// truncated the real command (MOTIR-11982). jsdom has no layout, so a class-name test passes
// on every one of those defects; this spec measures the real row in Chromium.
//
// The key is the worst real shape: a five-letter project key and a five-digit number
// (`XXXXX-11971`, as long as `MOTIR-11971`). Asserted at desktop and at 390px: the command
// is the only one in the row and sits on line 2; DETAILS is empty; the code is NOT
// truncated (`scrollWidth <= clientWidth`); the chip and its copy button stay inside line 2
// and the row; and all of it still holds once the press confirms — which copies without
// opening the row's overlay.
//
// The state is reached through the same doors as `regression-review-path-phone.spec.ts`: a
// teammate's pull request goes green in a project that reviews with the person's own agent,
// and the card waits for that review. Nothing but the project's work-item counter is
// written to the database directly (so the card is numbered 11971).
//
// ⚠️ THE 34xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 300_000 });
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const PR: ReviewPullRequest = {
  number: 34101,
  author: TEAMMATE_GITHUB,
  headRef: 'review-to-run-chip/34101',
};
const MERGE_CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const MERGE_JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;

async function chipSitsOnLine2(row: Locator, code: Locator, button: Locator): Promise<void> {
  const g = await code.evaluate(
    (node, btnSel) => {
      const rowEl = node.closest('[role="row"]')!;
      const line = node.closest('[data-testid^="review-to-run-line-"]');
      const btn = rowEl.querySelector(btnSel)!;
      const l = (line ?? rowEl).getBoundingClientRect();
      const r = rowEl.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      return {
        onLine2: line !== null,
        codes: rowEl.querySelectorAll('code').length,
        scroll: node.scrollWidth,
        client: node.clientWidth,
        lineLeft: l.left,
        lineRight: l.right,
        rowRight: r.right,
        btnLeft: b.left,
        btnRight: b.right,
        pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    },
    `[data-testid="${await button.getAttribute('data-testid')}"]`,
  );
  expect(g.onLine2, 'the command is on line 2').toBe(true);
  expect(g.codes, 'the row renders the command once').toBe(1);
  expect(g.scroll, 'the whole command shows — nothing is truncated').toBeLessThanOrEqual(g.client);
  expect(g.btnLeft, 'the copy button starts inside line 2').toBeGreaterThanOrEqual(g.lineLeft);
  expect(g.btnRight, 'the copy button ends inside line 2').toBeLessThanOrEqual(g.lineRight + 0.5);
  expect(g.lineRight, 'line 2 stays inside the row').toBeLessThanOrEqual(g.rowRight + 0.5);
  expect(g.pageScroll, 'no horizontal page scroll').toBeLessThanOrEqual(0);
  const details = row.locator('[data-testid^="review-to-run-details-"]');
  await expect(details, 'DETAILS holds nothing').toBeEmpty();
}

test.describe('the review-to-run command chip', () => {
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
    // Three characters: the project key is `RA<slug>`, five letters like `MOTIR`.
    s = await seedReviewPath(Date.now().toString(36).slice(-3).toUpperCase());
    await signIn(page, s.owner.email, s.hosted.password);
  });

  test('motir review XXXXX-11971 sits whole on line 2, at desktop and at 390px', async ({
    page,
  }) => {
    await adminDb.project.update({
      where: { id: s.hosted.projectId },
      data: { lastWorkItemNumber: 11970 },
    });
    const card = await seedReviewCard(s, 'Export the totals row');
    expect(card.identifier).toMatch(/^[A-Z0-9]{5}-11971$/);
    await openReviewPullRequest(page, card, PR);

    const settings = await page.request.patch(
      `/api/projects/${s.hosted.projectKey}/approval-gates`,
      { data: { reviewAgentEnabled: true, reviewAgentSource: 'own' } },
    );
    expect(settings.status()).toBe(200);
    const sha = headShaFor(PR.number);
    await reviewChecksGreen(page, PR, sha);
    await awaitReviewGate(card, 'agent_review', reviewDeliveryVersion([[PR, sha]]));

    await page.goto('/workbench?tab=approvals');
    const row = page.locator('[data-review-to-run]').filter({ hasText: card.identifier });
    await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
    const line = row.getByTestId(`review-to-run-line-${card.identifier}`);
    const command = `motir review ${card.identifier}`;
    const code = line.locator('code', { hasText: command });
    const button = line.getByTestId(`review-command-copy-${card.identifier}`);
    await expect(code).toHaveAttribute('title', command);
    // The owner may run the card hosted, so door 1 leads the right group (§ 45.2).
    await expect(line.getByTestId('review-with-motir-agent')).toBeVisible();

    await test.step('at rest, at desktop', async () => {
      await chipSitsOnLine2(row, code, button);
    });

    await test.step('the press copies and confirms without opening the row', async () => {
      await button.click();
      await expect(row.getByRole('status')).toHaveText(/\S/);
      await chipSitsOnLine2(row, code, button);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    await test.step('at 390px', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(line).toBeVisible();
      await chipSitsOnLine2(row, code, button);
    });
  });
});
