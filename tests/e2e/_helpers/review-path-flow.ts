import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { adminDb } from './db-reset';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './github-seed';
import { linkPr } from './pr-link';
import { FIRST_PAINT_MS } from './acceptance-video';
import { REVIEW_REPO, type ReviewAgentCard } from './review-agent-seed';

// THE REVIEW-PATH FLOW — the GitHub deliveries, gate waits, verdict door and layout checks
// that Story MOTIR-10327's two specs drive (MOTIR-11471):
//
//   * `acceptance-review-path.spec.ts` — the story's receipt, recorded at the acceptance
//     lane's one fixed frame;
//   * `regression-review-path-phone.spec.ts` — the phone-width check that left the receipt,
//     because a receipt never resizes its page.
//
// Both drive the same product doors, so the doors live here once. Every function is a
// real door: a signed delivery to `/api/github/webhook`, the link door, the user-token
// verdict door, or a committed read of the gate. Nothing here writes product state
// directly. `FIRST_PAINT_MS` is a constant re-exported by both fixture modules, so
// importing it from `acceptance-video` records nothing.

/** A pull request a spec opens on the review repository, and who GitHub says opened it. */
export interface ReviewPullRequest {
  number: number;
  author: { id: number; login: string };
  headRef: string;
}

export const REVIEW_REPO_NAME = `${REVIEW_REPO.owner}/${REVIEW_REPO.name}`;

/** `owner/name#number` — how the merge seam's control file names a pull request. */
export const reviewPrKey = (pr: Pick<ReviewPullRequest, 'number'>) =>
  `${REVIEW_REPO_NAME}#${pr.number}`;

/** The delivery-set version over `members` at their heads — sorted, comma-joined. */
export function reviewDeliveryVersion(
  members: ReadonlyArray<readonly [Pick<ReviewPullRequest, 'number'>, string]>,
): string {
  return members
    .map(([pr, sha]) => `${reviewPrKey(pr)}@${sha}`)
    .sort()
    .join(',');
}

/** A `pull_request` delivery for `pr`, carrying its author — the fact the author note reads. */
export function reviewPrPayload(
  card: ReviewAgentCard,
  pr: ReviewPullRequest,
  extra: Record<string, unknown> = {},
) {
  const payload = pullRequestPayload({
    action: 'opened',
    number: pr.number,
    title: card.title,
    headRef: pr.headRef,
    state: 'open',
    merged: false,
    repo: REVIEW_REPO,
  }) as { pull_request: Record<string, unknown> } & Record<string, unknown>;
  return {
    ...payload,
    pull_request: {
      ...payload.pull_request,
      user: { id: pr.author.id, login: pr.author.login },
      ...extra,
    },
  };
}

/** GitHub says `pr` opened, and the card declares it delivers it. */
export async function openReviewPullRequest(
  page: Page,
  card: ReviewAgentCard,
  pr: ReviewPullRequest,
): Promise<void> {
  const res = await postSignedWebhook(page.request, 'pull_request', reviewPrPayload(card, pr));
  expect(res.status(), `open #${pr.number}`).toBe(200);
  await linkPr(page, {
    workItemId: card.id,
    repo: REVIEW_REPO,
    number: pr.number,
    headRef: pr.headRef,
  });
}

/** CI finished green on `pr` at `sha` — a signed `check_suite` delivery. */
export async function reviewChecksGreen(
  page: Page,
  pr: ReviewPullRequest,
  sha: string,
): Promise<void> {
  const res = await postSignedWebhook(
    page.request,
    'check_suite',
    checkSuitePayload({
      conclusion: 'success',
      headSha: sha,
      prNumber: pr.number,
      headBranch: pr.headRef,
      repo: REVIEW_REPO,
    }),
  );
  expect(res.status(), `green #${pr.number}@${sha}`).toBe(200);
}

export type ReviewGateKind = 'agent_review' | 'pull_request_approval';

/** The card's newest gate of `kind` still awaiting — the committed read a wait polls. */
export const awaitingReviewGate = (card: ReviewAgentCard, kind: ReviewGateKind) =>
  adminDb.approvalGate.findFirst({
    where: { workItemId: card.id, kind, state: 'awaiting' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, subjectVersion: true, reviewUnavailableReason: true },
  });

/** Wait until the card has an awaiting `kind` gate at exactly `version`. */
export async function awaitReviewGate(
  card: ReviewAgentCard,
  kind: ReviewGateKind,
  version: string,
): Promise<void> {
  await expect
    .poll(async () => (await awaitingReviewGate(card, kind))?.subjectVersion ?? null, {
      timeout: 60_000,
      message: `${card.identifier}: an awaiting ${kind} at ${version}`,
    })
    .toBe(version);
}

export interface OwnAgentVerdict {
  verdict: 'approved' | 'changes_requested';
  subjectVersion: string;
  findingsMd?: string;
}

/**
 * The routed person's own agent answers — `motir review`'s submit, through
 * `POST /api/v1/work-items/{key}/review-verdict` with their own token (`api`).
 */
export async function submitOwnAgentVerdict(
  api: APIRequestContext,
  card: ReviewAgentCard,
  body: OwnAgentVerdict,
  agent: { harness: string; model: string },
) {
  const res = await api.post(`/api/v1/work-items/${card.identifier}/review-verdict`, {
    data: {
      summaryMd: body.verdict === 'approved' ? 'Meets every acceptance criterion.' : null,
      checklist: [],
      harness: agent.harness,
      model: agent.model,
      ...body,
    },
  });
  const text = await res.text();
  expect(res.status(), `verdict → ${text.slice(0, 400)}`).toBe(200);
  const json = JSON.parse(text) as { recordId: string; verdict: string; subjectVersion: string };
  expect(json).toMatchObject({
    key: card.identifier,
    verdict: body.verdict,
    subjectVersion: body.subjectVersion,
  });
  return json;
}

/** The card's tile on `/boards`. */
export const reviewBoardCard = (page: Page, card: ReviewAgentCard) =>
  page.getByRole('main').getByTestId(`board-card-${card.identifier}`);

/**
 * The board card, scrolled into its column's window. A board column VIRTUALIZES its stack
 * (`useRowWindow`), so a card low in a busy column mounts only once the column scrolls —
 * the way a person reaches it. Each column's own scroller is stepped down until the card
 * mounts, then the card is brought into view.
 */
export async function revealReviewBoardCard(page: Page, card: ReviewAgentCard): Promise<Locator> {
  const target = reviewBoardCard(page, card);
  await expect
    .poll(
      async () => {
        if ((await target.count()) > 0) return true;
        await page
          .getByRole('main')
          .locator('[data-testid^="board-column-"] div.overflow-y-auto')
          .evaluateAll((els) => {
            for (const el of els) {
              el.scrollTop += el.clientHeight / 2;
              el.dispatchEvent(new Event('scroll'));
            }
          });
        return false;
      },
      { timeout: FIRST_PAINT_MS },
    )
    .toBe(true);
  await target.scrollIntoViewIfNeeded();
  return target;
}

/** No horizontal overflow inside `el` — a pill or chip pushed out reads as scrollWidth. */
export async function fitsItsBox(el: Locator): Promise<void> {
  const { scroll, client } = await el.evaluate((node) => ({
    scroll: node.scrollWidth,
    client: node.clientWidth,
  }));
  expect(scroll, 'nothing overflows the box').toBeLessThanOrEqual(client + 1);
}
