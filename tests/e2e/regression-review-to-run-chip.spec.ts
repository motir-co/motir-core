import { readFileSync, writeFileSync } from 'node:fs';
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

// THE REVIEW-TO-RUN ROW'S COMMAND FITS ITS DETAILS TRACK (Bug MOTIR-11982).
//
// To approve lists a card that waits for its review as a *Review to run* row whose DETAILS
// cell carries the copyable `motir review <KEY>`. That track is a FIXED 220px
// (`APPROVALS_GRID_TEMPLATE`; the full view's is 200px), and the chip used to be wider than
// it: first its copy button painted over WAITED, then — once the code truncated — the real
// command read `motir review MOTIR-119…`. jsdom has no layout, so a class-name test passes
// on both defects; this spec measures the real row in Chromium.
//
// The key is the worst real shape: a five-letter project key and a five-digit number
// (`XXXXX-11971`, as long as `MOTIR-11971`). Asserted, at the real 220px track and at the
// full view's 200px: the code is NOT truncated (`scrollWidth <= clientWidth`), the copy
// button stays inside the DETAILS cell, and both still hold once the press confirms.
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

/** The full view's grid template, read from its one source so the 200px case cannot drift. */
function fullViewGridTemplate(): string {
  const src = readFileSync('components/approvals/ApprovalRow.tsx', 'utf8');
  const m = src.match(/APPROVALS_FULL_VIEW_GRID_TEMPLATE = '([^']+)'/);
  if (!m) throw new Error('APPROVALS_FULL_VIEW_GRID_TEMPLATE not found in ApprovalRow.tsx');
  return m[1]!;
}

async function chipFitsItsCell(code: Locator, button: Locator, track: number): Promise<void> {
  const g = await code.evaluate(
    (node, btnSel) => {
      const cell = node.closest('[role="cell"]')!;
      const btn = cell.querySelector(btnSel)!;
      const c = cell.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      return {
        scroll: node.scrollWidth,
        client: node.clientWidth,
        cellWidth: c.width,
        cellLeft: c.left,
        cellRight: c.right,
        btnLeft: b.left,
        btnRight: b.right,
      };
    },
    `[data-testid="${await button.getAttribute('data-testid')}"]`,
  );
  expect(Math.round(g.cellWidth), 'the DETAILS cell is the track').toBe(track);
  expect(g.scroll, 'the whole command shows — nothing is truncated').toBeLessThanOrEqual(g.client);
  expect(g.btnLeft, 'the copy button starts inside DETAILS').toBeGreaterThanOrEqual(g.cellLeft);
  expect(g.btnRight, 'the copy button ends inside DETAILS, never over WAITED').toBeLessThanOrEqual(
    g.cellRight + 0.5,
  );
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

  test('motir review XXXXX-11971 fits the 220px and 200px DETAILS tracks whole', async ({
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
    const command = `motir review ${card.identifier}`;
    const code = row.locator('code', { hasText: command });
    const button = row.getByTestId(`review-command-copy-${card.identifier}`);
    await expect(code).toHaveAttribute('title', command);

    await test.step('at rest, in the real 220px track', async () => {
      await chipFitsItsCell(code, button, 220);
    });

    await test.step('after the press confirms, the command still fits', async () => {
      await button.click();
      await expect(row.getByRole('status')).toHaveText(/\S/);
      await chipFitsItsCell(code, button, 220);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
    });

    await test.step('in the full view’s 200px track', async () => {
      const template = fullViewGridTemplate();
      expect(template).toContain('200px');
      await row.evaluate((el, t) => {
        (el as HTMLElement).style.gridTemplateColumns = t;
      }, template);
      await chipFitsItsCell(code, button, 200);
    });
  });
});
