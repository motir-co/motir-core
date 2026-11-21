import { expect, type Page } from '@playwright/test';
import { adminDb } from './db-reset';

// A PERSON ASKS FOR THE HOSTED REVIEW (Story MOTIR-11941 · MOTIR-11943). Nothing reviews by
// itself any more: a green set raises its `agent_review` gate and starts no run. A spec that
// goes on to exercise a hosted review run first proves the raise started nothing, then asks
// for the run the way a person does.
//
// ⚠️ THE DOOR, UNTIL THE REVIEW DOORS LAND. The one shipped door that requests a hosted run
// is *Review again* — the routed person's press, offered on a review that could not run
// (`POST /api/approval-gates/[id]/review-again`). So the gate is marked as such through the
// owner client, and the press goes through the real route in the signed-in session: the
// SERVER emits `agent-review/requested`, and the lane's job worker runs the real job. The
// session must be the person the review is routed to (the card's assignee, else reporter).

/** The card's awaiting review gate, newest first — the committed read. */
const awaitingReview = (workItemId: string) =>
  adminDb.approvalGate.findFirst({
    where: { workItemId, kind: 'agent_review', state: 'awaiting' },
    orderBy: { createdAt: 'desc' },
  });

/**
 * THE RAISE STARTED NOTHING — the card's review awaits at `version`, and no review run exists
 * for that gate (no `review` dispatch run under its key). Returns the gate.
 */
export async function reviewRaisedAndWaiting(workItemId: string, version: string) {
  await expect
    .poll(async () => (await awaitingReview(workItemId))?.subjectVersion ?? null, {
      timeout: 60_000,
      message: `the review awaits at ${version}`,
    })
    .toBe(version);
  const gate = (await awaitingReview(workItemId))!;
  expect(
    await adminDb.dispatchRun.count({
      where: { command: 'review', idempotencyKey: { startsWith: `agent-review:${gate.id}:` } },
    }),
    'the raise started no review run',
  ).toBe(0);
  return gate;
}

/** Prove the raise started nothing, then ask for the hosted review as the routed person. */
export async function requestHostedReview(page: Page, workItemId: string, version: string) {
  const gate = await reviewRaisedAndWaiting(workItemId, version);
  await adminDb.approvalGate.update({
    where: { id: gate.id },
    data: { reviewUnavailableReason: 'e2e_person_starts_the_review' },
  });
  const res = await page.request.post(`/api/approval-gates/${gate.id}/review-again`);
  expect(res.status(), 'the request for a hosted review was taken').toBe(202);
  return gate;
}
