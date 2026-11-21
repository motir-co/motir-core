import { expect, type Page } from '@playwright/test';
import { adminDb } from './db-reset';

// A PERSON ASKS FOR THE HOSTED REVIEW (Story MOTIR-11941 · MOTIR-11943). Nothing reviews by
// itself any more: a green set raises its `agent_review` gate and starts no run. A spec that
// goes on to exercise a hosted review run first proves the raise started nothing, then asks
// for the run the way a person does.
//
// THE DOOR is *Review with Motir agent* (MOTIR-11944): the routed person's press,
// `POST /api/work-items/<KEY>/review-with-motir-agent`, through the real route in the
// signed-in session. It starts the hosted review run synchronously, in the server, as Run
// hosted does — no job is involved. The session must be a person the review is routed to
// (the card's assignee, else reporter).

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

/**
 * Prove the raise started nothing, then press for the hosted review as the routed person.
 * `expected` is the press's answer: 201 for a started run, or a pre-flight refusal's status
 * (402 out of credits), which writes nothing onto the gate.
 */
export async function requestHostedReview(
  page: Page,
  workItemId: string,
  version: string,
  expected = 201,
) {
  const gate = await reviewRaisedAndWaiting(workItemId, version);
  const { identifier } = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
  const res = await page.request.post(`/api/work-items/${identifier}/review-with-motir-agent`, {
    data: {},
  });
  expect(res.status(), 'the press for a hosted review was answered').toBe(expected);
  return gate;
}
