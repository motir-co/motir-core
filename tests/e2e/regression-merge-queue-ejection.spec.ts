import { readFileSync, writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { linkPr } from './_helpers/pr-link';
import { closeOverlay, openDevelopmentOverlay } from './_helpers/development-decide';
import {
  WEB_REPO,
  headShaFor,
  seedApproveAndMerge,
  type ApproveAndMergeSeed,
  type SeededCard,
} from './_helpers/approve-and-merge-seed';
import { adminDb } from '@/tests/helpers/adminDb';
import type { GithubMergeCall, GithubMergeControl } from '@/lib/test-github-merge-mock';
import en from '@/messages/en.json';

// A PULL REQUEST THE MERGE QUEUE EJECTS — THE ACCEPTANCE RECEIPT (Story MOTIR-5461 ·
// Subtask MOTIR-5637; `design/github/approve-and-merge--ejected.mock.html`).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A person approves a green pull request and it joins its merge queue: ONE question is
// asked over the set, one press answers it, the row reads *Queued to merge*, and the card
// is Approved.
//
// ⚠️ THE EJECTION HALF OF THIS RECEIPT WAS RETIRED (Story MOTIR-5799 · MOTIR-5808), and
// the retirement note sits where its five chapters were, below. The FOURTH AMENDMENT makes
// every one of them false: a press that does not land SPENDS the approval, so the card
// returns to **In Review** and is asked again rather than sitting at Implemented under a
// still-standing yes. The frozen receipt is untouched — it records what was watched and
// approved in September — and the ejection now has its OWN receipt,
// `acceptance-merge-unlanded-classes.spec.ts`, which walks all three reason classes.
//
// ── THE SEAMS ─────────────────────────────────────────────────────────────────
//
//   * GitHub's enqueue — `E2E_TEST_GITHUB_MERGE` (`lib/test-github-merge-mock.ts`), whose
//     control marks the repository as requiring a merge queue, so every press ENQUEUES.
//
// ⚠️ A WEBHOOK REACHES THE ITEM PAGE ON THE NEXT RENDER. The page has no live channel, so
// after each delivery the spec RELOADS, exactly as `acceptance-approve-and-merge.spec.ts`
// does after its merge webhooks. (The card asked for "without a manual reload"; that needs
// a live channel no card in this story ships — recorded on MOTIR-5637.) A press on the page
// itself repaints in place, and that is asserted without a reload.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's own response, the server action's response, or
// the rail's or row's text. The holds are `chapter()` / `beat()`'s, taken after assertions.
//
// ⚠️ THE 13xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 480_000 });

const PRS = {
  ejected: { number: 13101 },
  rearmed: { number: 13201 },
  neutral: { number: 13301 },
} as const;
type Scenario = keyof typeof PRS;

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;
const WEB = `${WEB_REPO.owner}/${WEB_REPO.name}`;
const pra = en.approvalGate.pullRequestApproval;

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
const prName = (number: number) => `${WEB} · #${number}`;
const headRefFor = (card: SeededCard, number: number) =>
  `ejected/${card.identifier.toLowerCase()}-${number}`;

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

// ── The page ────────────────────────────────────────────────────────────────

const developmentCard = (page: Page, title = en.github.development.title): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });

const prRow = (page: Page, number: number, title?: string): Locator =>
  developmentCard(page, title)
    .locator('li')
    .filter({ hasText: prName(number) });

const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

/** The authoritative read-back: how many questions the card holds right now. */
async function awaitingGates(card: SeededCard): Promise<number> {
  return adminDb.approvalGate.count({
    where: { workItemId: card.id, kind: 'pull_request_approval', state: 'awaiting' },
  });
}

async function atMostOneQuestion(card: SeededCard): Promise<void> {
  expect(
    await awaitingGates(card),
    `${card.identifier} holds at most one question`,
  ).toBeLessThanOrEqual(1);
}

/** Bring an element to the middle of the viewport, so the video shows what was asserted. The
 *  Development block sits below the fold of the recorded viewport; the rail sits above it. */
async function show(target: Locator): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
}

async function open(page: Page, card: SeededCard): Promise<void> {
  await page.goto(`/items/${card.identifier}`);
  await expect(developmentCard(page)).toHaveCount(1, { timeout: 60_000 });
}

// ── The deliveries ──────────────────────────────────────────────────────────

async function deliver(page: Page, event: string, payload: unknown, what: string): Promise<void> {
  const res = await postSignedWebhook(page.request, event, payload);
  expect(res.status(), `${what} → ${(await res.text()).slice(0, 300)}`).toBe(200);
}

/** Open one pull request, link it, and turn it green. */
async function deliverGreen(page: Page, card: SeededCard, scenario: Scenario): Promise<void> {
  const { number } = PRS[scenario];
  const headRef = headRefFor(card, number);
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
  await deliver(
    page,
    'check_suite',
    checkSuitePayload({
      conclusion: 'success',
      headSha: headShaFor(number),
      prNumber: number,
      headBranch: headRef,
      repo: WEB_REPO,
    }),
    `green #${number}`,
  );
}

/**
 * Press Approve and merge, confirm, and wait for the action — in the approval overlay,
 * opened from the card's Development band, and then close it.
 *
 * ⚠️ AMENDED by MOTIR-6323: the verb moved OFF the item page (the Development section hands
 * the decision over like every other section). The press and its confirm are unchanged;
 * only the door moved. The queued outcome is read on the page after the close — a reload
 * knows it (`persistedRowOutcome`), so it is the server's read, not the press's memory.
 */
async function pressApproveAndMerge(page: Page): Promise<void> {
  const dev = await openDevelopmentOverlay(page);
  await dev.getByRole('button', { name: pra.verb.approveAndMerge, exact: true }).click();
  const action = serverAction(page);
  await dev
    .getByRole('button', {
      name: fill(en.approvalGate.confirm.proceed, { verb: pra.verb.approveAndMerge }),
      exact: true,
    })
    .click();
  expect((await action).status()).toBe(200);
  await closeOverlay(page);
}

test.describe('a pull request the merge queue ejects', () => {
  let seed: ApproveAndMergeSeed;
  let ejected: SeededCard;
  let rearmed: SeededCard;
  let neutral: SeededCard;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    seed = await seedApproveAndMerge(Date.now().toString(36));
    ejected = seed.merged;
    rearmed = seed.queued;
    neutral = seed.refused;
    writeFileSync(JOURNAL_PATH, '');
    // The repository requires a merge queue: every press ENQUEUES.
    const control: GithubMergeControl = { repositories: [WEB], mergeQueueRepositories: [WEB] };
    writeFileSync(CONTROL_PATH, JSON.stringify(control));

    await signIn(page, seed.ownerEmail, seed.password);
    await deliverGreen(page, ejected, 'ejected');
    await deliverGreen(page, rearmed, 'rearmed');
    await deliverGreen(page, neutral, 'neutral');
  });

  test('a green set asks ONE question, and the press puts it in the merge queue', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5461');
    const number = PRS.ejected.number;

    await chapter('A green pull request: the card asks one question', async () => {
      await open(page, ejected);
      // ⚠️ AMENDED by MOTIR-6323: the question is asked by the band's ONE control.
      await expect(
        developmentCard(page).getByRole('link', {
          name: en.approvalGate.statusHeld.reviewAndApprove,
          exact: true,
        }),
      ).toBeVisible();
      await expect(statusCard(page)).toContainText('In Review');
      expect(await awaitingGates(ejected)).toBe(1);
      await beat();
      await show(prRow(page, number));
    });
    await beat();

    await chapter(
      'Approve and merge: it joins the merge queue, and the card is Approved',
      async () => {
        await pressApproveAndMerge(page);
        expect(
          journal().some((c) => c.path === '/graphql' && c.pullRequest === `${WEB}#${number}`),
        ).toBe(true);
        await expect(
          prRow(page, number).getByText(pra.outcome.queued, { exact: true }),
        ).toBeVisible();
        await expect(statusCard(page)).toContainText(en.approvalGate.state.approved);
        await atMostOneQuestion(ejected);
        await beat();
        await show(statusCard(page));
      },
    );
    await beat();

    // ⚠️ FIVE CHAPTERS WERE RETIRED HERE (Story MOTIR-5799 · MOTIR-5808;
    // `docs/decisions/approval-gates.md` § 4 FOURTH AMENDMENT). They read:
    //
    //   · *The merge queue ejects it: a check failed* — the card at **Implemented**, the
    //     approval still standing, *your approval still covers these commits*;
    //   · *Queue again: back in the queue, Approved, and nobody is asked again*;
    //   · *New commits after an ejection: Motir asks again, once* — from Implemented;
    //   · *Someone took it out of the queue: the card stays Approved*;
    //   · *The same ejection, in Chinese* — the same Implemented-era sentences.
    //
    // Every one of them was true when MOTIR-5461 was accepted, and the amendment makes
    // every one of them false: a press that does not land SPENDS the approval, so a
    // retryable exit returns the card to **In Review** and asks once more, a neutral
    // removal does the same, and *Queue again* is the new approval rather than a second
    // act on the old one.
    //
    // They were DELETED rather than re-pointed at today's behaviour. A receipt's spec
    // records what a person watched and approved; rewriting its assertions to agree with
    // the present edits history (`docs/decisions/acceptance-receipt-lifecycle.md` § 3,
    // and `CLAUDE.md`'s *an `acceptance-*.spec.ts` is a RECEIPT*). The frozen receipt is
    // untouched. What they covered now lives in:
    //
    //   · `tests/e2e/acceptance-merge-unlanded-classes.spec.ts` — the ejection end to
    //     end, by class, with its own video (MOTIR-5808);
    //   · `tests/integration/mergeQueueEjectionStoryGate.test.ts` and
    //     `tests/github/mergeQueueExit.test.ts` — every reason class on real Postgres, in
    //     a lane that runs on EVERY pull request.
    //
    // What remains above is the half the amendment leaves standing, and it is this
    // story's own subject: a green set, ONE question, and the press that enqueues it.
  });
});
