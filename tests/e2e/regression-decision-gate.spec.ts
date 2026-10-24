import { readFileSync, writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { closeOverlay, openDevelopmentOverlay } from './_helpers/development-decide';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { linkPr } from './_helpers/pr-link';
import { approvalSentence } from './_helpers/approval-sentence';
import {
  DECISION_REPO,
  decisionHeadSha,
  seedDecisionGate,
  type DecisionGateSeed,
  type SeededDecisionCard,
} from './_helpers/decision-gate-seed';
import type { GithubMergeCall, GithubMergeControl } from '@/lib/test-github-merge-mock';
import en from '@/messages/en.json';

// AN AGENT'S DECISION WAITS FOR A PERSON — THE ACCEPTANCE RECEIPT (Story MOTIR-4907 ·
// Subtask MOTIR-5681).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// An agent decided something and shipped it as ONE file under `docs/decisions/` in a pull
// request. The decision is waiting on To approve. The person opens it and READS THE
// DOCUMENT — the question — with the pull request beneath it as what accepting it merges.
// One press accepts the decision and merges the pull request; the merge webhook finishes
// the card. Then the two answers a demo would hide: an agent that forgot the document
// cannot be waved through — Approve is disabled and the frame says why — and a decision a
// PERSON owns never grows this gate at all.
//
// ── THE SEAMS THIS LANE USES ────────────────────────────────────────────────
//
//   * GitHub's file list, the document's contents and the merge — the GitHub MERGE seam
//     (`lib/test-github-merge-mock.ts`, `E2E_TEST_GITHUB_MERGE`), which this card taught the
//     head's files and a raw contents read. The spec WRITES what GitHub holds and READS the
//     journal to prove the press reached the merge.
//   * The pull requests and their green checks — SIGNED deliveries to the real webhook route.
//   * The links — the real link door, which CAPTURES the document off the head's files.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's own response, the server action's response, a
// role, or a committed read after a reload. No timed wait; the holds are `chapter()` /
// `beat()`'s, taken after the assertion.
//
// ⚠️ THE 16xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 480_000 });

const PRS = {
  accepted: { number: 16101 },
  missing: { number: 16201 },
  human: { number: 16301 },
} as const;
type Scenario = keyof typeof PRS;

const REPO = `${DECISION_REPO.owner}/${DECISION_REPO.name}`;
const DOC = 'docs/decisions/page-body.md';
const HEADING = 'ADR: How a page stores its body';
const DOCUMENT = [
  `# ${HEADING}`,
  '',
  '**Status:** Proposed',
  '',
  '## Context',
  '',
  'A page is edited by several people at once and read far more often than it is written.',
  '',
  '## Decision',
  '',
  'Store the body as a **Yjs document**, and derive Markdown and HTML from it on save.',
  '',
  '## Consequences',
  '',
  '- Concurrent edits merge without locking.',
  '- Every save writes three columns, and the derived two can be rebuilt.',
].join('\n');

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;

const dec = en.approvalGate.decision;
const pra = en.approvalGate.pullRequestApproval;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
/** The copy with its rich tags dropped — what a reader sees. */
const plain = (text: string) =>
  ['<b>', '</b>', '<mono>', '</mono>'].reduce((out, tag) => out.split(tag).join(''), text);

const prKey = (number: number) => `${REPO}#${number}`;
const prName = (number: number) => `${REPO} · #${number}`;
const headRefFor = (card: SeededDecisionCard, number: number) =>
  `decision/${card.identifier.toLowerCase()}-${number}`;

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

/** The item page's Development card — the section card headed by its title. */
const developmentCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: en.github.development.title }) });

/** The detail rail's Status field card. */
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

/** The To-approve table's row for a card. */
const rowFor = (page: Page, card: SeededDecisionCard): Locator =>
  page
    .getByRole('table', { name: en.workbench.tabs.toApprove })
    .getByTestId(/^approval-row-/)
    .filter({ hasText: card.identifier });

/** The decision overlay, by its SETTLED accessible name — the read's own answer. */
const overlayFor = (page: Page, card: SeededDecisionCard): Locator =>
  page.getByRole('dialog', {
    name: fill(en.approvalOverlay.dialogTitle, {
      kind: en.workbench.approvals.kind.decision_approval,
      key: card.identifier,
    }),
    exact: true,
  });

/** Arm a wait for the next server action's response — a POST carrying `Next-Action`. */
const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

/** Open the card's pull request, link it (the link CAPTURES the document), and turn it green. */
async function deliverGreen(page: Page, card: SeededDecisionCard, scenario: Scenario) {
  const { number } = PRS[scenario];
  const headRef = headRefFor(card, number);
  const opened = await postSignedWebhook(
    page.request,
    'pull_request',
    pullRequestPayload({
      action: 'opened',
      number,
      title: card.title,
      headRef,
      state: 'open',
      merged: false,
      repo: DECISION_REPO,
    }),
  );
  expect(opened.status(), `open ${prKey(number)}`).toBe(200);
  await linkPr(page, { workItemId: card.id, repo: DECISION_REPO, number, headRef });
  const green = await postSignedWebhook(
    page.request,
    'check_suite',
    checkSuitePayload({
      conclusion: 'success',
      headSha: decisionHeadSha(number),
      prNumber: number,
      headBranch: headRef,
      repo: DECISION_REPO,
    }),
  );
  expect(green.status(), `green ${prKey(number)}`).toBe(200);
}

test.describe('an agent’s decision waits for a person', () => {
  let seed: DecisionGateSeed;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    seed = await seedDecisionGate(Date.now().toString(36));
    writeFileSync(JOURNAL_PATH, '');
    // What GitHub holds: each pull request's head — the accepted card's writes the
    // document, the missing card's writes none, the human card's writes one too (which
    // must still raise nothing) — the document's text, and a merge for every press.
    writeControl({
      repositories: [REPO],
      pullRequests: Object.fromEntries(
        Object.values(PRS).map(({ number: n }) => [
          prKey(n),
          { outcome: 'merged' as const, headSha: decisionHeadSha(n) },
        ]),
      ),
      pullRequestFiles: {
        [prKey(PRS.accepted.number)]: [
          { path: DOC, sha: '3f9a2c1000000000000000000000000000000000' },
          { path: 'lib/pages/body.ts', sha: 'c0de000000000000000000000000000000000001' },
        ],
        [prKey(PRS.missing.number)]: [
          { path: 'lib/retention/window.ts', sha: 'c0de000000000000000000000000000000000002' },
        ],
        [prKey(PRS.human.number)]: [
          {
            path: 'docs/decisions/import-format.md',
            sha: 'abcd000000000000000000000000000000000003',
          },
        ],
      },
      fileContents: { [`${REPO}:${DOC}`]: DOCUMENT },
    });

    await signIn(page, seed.ownerEmail, seed.password);
    await deliverGreen(page, seed.accepted, 'accepted');
    await deliverGreen(page, seed.missing, 'missing');
    await deliverGreen(page, seed.human, 'human');
  });

  test('the document is the question: one press accepts it and merges; no document cannot pass; a person’s decision asks nothing', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-4907');

    await chapter('The agent’s decision is waiting on To approve', async () => {
      await page.goto('/workbench?tab=approvals');
      const rows = page
        .getByRole('table', { name: en.workbench.tabs.toApprove })
        .getByTestId(/^approval-row-/);
      // ONE row per card: the two decision cards by their decision gate (the merge gate
      // beside it is carried by the one press), the human card by its merge gate alone.
      await expect(rows).toHaveCount(3, { timeout: 60_000 });
      const accepted = rowFor(page, seed.accepted);
      // The row reads as a sentence about the work item (MOTIR-5999).
      await expect(
        accepted.getByText(approvalSentence(en, 'decision_approval', seed.accepted.title), {
          exact: true,
        }),
      ).toBeVisible();
      await expect(accepted.getByText(`Page body · ${DOC}`, { exact: true })).toBeVisible();
      // Why it cannot be approved, in words; the pull request moves to the title (MOTIR-5999).
      const none = rowFor(page, seed.missing).getByText(
        en.workbench.approvals.decisionSubject.none,
        {
          exact: true,
        },
      );
      await expect(none).toBeVisible();
      await expect(none).toHaveAttribute('title', prName(PRS.missing.number));
      // The person's decision is not a decision gate: its row is the pull request's.
      await expect(
        rowFor(page, seed.human).getByText(
          approvalSentence(en, 'decision_approval', seed.human.title),
          { exact: true },
        ),
      ).toHaveCount(0);
      await expect(
        rowFor(page, seed.human).getByText(
          approvalSentence(en, 'pull_request_approval', seed.human.title),
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByText(en.workbench.approvals.notBuiltYet)).toHaveCount(0);
    });
    await beat();

    await chapter('Open it: the DOCUMENT is the question, the pull request beneath', async () => {
      await rowFor(page, seed.accepted)
        .getByRole('button', { name: en.workbench.approvals.review, exact: true })
        .click();
      const dialog = overlayFor(page, seed.accepted);
      await expect(dialog).toHaveCount(1, { timeout: 60_000 });
      // ⚠️ THE DOCUMENT IS MOUNTED BEFORE ANYTHING IS PRESSED — its own heading, read off the
      // repository through the resolver. A spec that pressed Approve on an empty port would
      // pass forever while showing nothing.
      const slot = dialog.getByRole('group', { name: dec.portTitle, exact: true });
      await expect(slot.getByRole('heading', { name: HEADING })).toBeVisible({ timeout: 60_000 });
      await expect(slot.getByText(DOC, { exact: true })).toBeVisible();
      await expect(slot.getByRole('link', { name: dec.viewOnHost })).toBeVisible();
      // No How to test in a decision port — the document, then the pull request.
      await expect(dialog.getByRole('group', { name: 'How to test', exact: true })).toHaveCount(0);
      await expect(
        dialog
          .getByRole('group', { name: en.github.development.pullRequestsGroup })
          .getByText(prName(PRS.accepted.number)),
      ).toBeVisible();
      await expect(
        dialog.getByText(
          plain(
            fill(dec.consequence, {
              prs: prName(PRS.accepted.number),
              key: seed.accepted.identifier,
            }),
          ),
        ),
      ).toBeVisible();
    });
    await beat();

    await chapter('Approve: the decision is accepted and the pull request merges', async () => {
      const dialog = overlayFor(page, seed.accepted);
      await dialog.getByRole('button', { name: pra.verb.approveAndMerge, exact: true }).click();
      await expect(dialog.getByText(dec.confirm.records, { exact: true })).toBeVisible();
      const action = serverAction(page);
      await dialog
        .getByRole('button', {
          name: fill(en.approvalGate.confirm.proceed, { verb: pra.verb.approveAndMerge }),
          exact: true,
        })
        .click();
      expect((await action).status()).toBe(200);
      await expect(dialog.getByText(en.approvalGate.state.approved)).toBeVisible();
      // The press reached GitHub's merge for this pull request — and only this one.
      const merges = journal().filter((call) => call.method === 'PUT');
      expect(merges.map((call) => call.pullRequest)).toEqual([prKey(PRS.accepted.number)]);
    });
    await beat();

    await chapter('The merge webhook finishes the card', async () => {
      const merged = await postSignedWebhook(
        page.request,
        'pull_request',
        pullRequestPayload({
          action: 'closed',
          number: PRS.accepted.number,
          title: seed.accepted.title,
          headRef: headRefFor(seed.accepted, PRS.accepted.number),
          state: 'closed',
          merged: true,
          repo: DECISION_REPO,
        }),
      );
      expect(merged.status()).toBe(200);
      await page.goto(`/items/${seed.accepted.identifier}`);
      await expect(statusCard(page).getByText('Done', { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      // The record says what was accepted: the decision, by whom.
      await expect(developmentCard(page).getByText(/Decision accepted by/)).toBeVisible();
    });
    await beat();

    await chapter('No decision document: Approve is disabled, and says why', async () => {
      await page.goto(`/items/${seed.missing.identifier}`);
      const card = developmentCard(page);
      await expect(
        card.getByRole('group', { name: dec.portTitle, exact: true }).getByRole('status'),
      ).toContainText('This pull request adds no decision document.', { timeout: 60_000 });
      // ⚠️ AMENDED by MOTIR-6323: the verbs, and why Approve is disabled, are the approval
      // overlay's — the card hands the decision over through its band.
      const dev = await openDevelopmentOverlay(page);
      const slot = dev.getByRole('group', { name: dec.portTitle, exact: true });
      await expect(slot.getByRole('status')).toContainText(
        'This pull request adds no decision document.',
      );
      await expect(dev.getByText(dec.blocked, { exact: true })).toBeVisible();
      await expect(
        dev.getByRole('button', { name: pra.verb.approveAndMerge, exact: true }),
      ).toBeDisabled();
      // Request changes is exactly what this case needs — and it moves nothing.
      await dev
        .getByRole('button', { name: en.approvalGate.verb.requestChanges, exact: true })
        .click();
      // A refusal SAYS WHY (MOTIR-6075) — here, that there is no document to accept.
      await dev.getByLabel(en.approvalGate.reason.label).fill('There is no decision document.');
      const action = serverAction(page);
      await dev.getByRole('button', { name: en.approvalGate.reason.proceed, exact: true }).click();
      expect((await action).status()).toBe(200);
      await expect(dev.getByText(en.approvalGate.state.changesRequested)).toBeVisible();
      expect(journal().filter((call) => call.method === 'PUT')).toHaveLength(1);
      // MOTIR-6068 (MOTIR-6211): a Request changes on a decision now OFFERS the seeded
      // planner in the decided band; declining it keeps the overlay open, so answer it
      // before closing — that receipt is MOTIR-6068's, not this story's.
      await dev
        .getByRole('button', { name: en.planningWorkspace.handoff.notNow, exact: true })
        .click();
      await closeOverlay(page);
    });
    await beat();

    await chapter('A person’s decision: no decision gate anywhere', async () => {
      await page.goto(`/items/${seed.human.identifier}`);
      const dev = developmentCard(page);
      // ⚠️ AMENDED by MOTIR-6323: the pull requests' own question, asked by the band's door.
      await expect(
        dev.getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove, exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      // The frame is the pull requests' own; there is no decision document to accept.
      await expect(dev.getByRole('group', { name: dec.portTitle, exact: true })).toHaveCount(0);
      await expect(dev.getByText(dec.kindLabel, { exact: true })).toHaveCount(0);
    });
    await beat();
  });
});
