import { NextResponse } from 'next/server';
import { ReviewStartForbiddenError, ReviewStartNotOfferedError } from '@/lib/agentReview/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { hostedProblem, hostedStartRefusalResponse } from '@/lib/hostedRuns/startRefusalResponse';
import { agentReviewStartService } from '@/lib/services/agentReviewStartService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// POST /api/work-items/[id]/review-with-motir-agent (Story MOTIR-11941 · MOTIR-11944;
// `approval-gates.md` §12.18, `hosted-agent-run.md` §8.8) — *Review with Motir agent*: a
// person's press starts ONE hosted review run for the item at its version, with the model
// they picked, gate on or off. The segment is `[id]` and its value is the item KEY, as Run
// hosted's route one directory over has it.
//
// Body `{ model?, idempotencyKey? }`. `model` absent or blank takes the review's own model
// resolution; present, it is one Run hosted offers, checked by the same pre-flight.
//
// Answers: 201 `{ dispatchRunId, created: true, gateId }` — the run started; 200 with
// `created: false` — the press collapsed into a run already started for this attempt;
// 404 — no item the caller can see (never a 403 that leaks existence); 403
// `REVIEW_START_FORBIDDEN` — a member outside the routed set or without `work_item:edit`;
// 409 `REVIEW_START_NOT_OFFERED` with `reason` (`not_in_review` · `gate_not_awaiting` ·
// `no_pull_request` · `review_in_flight`); and Run hosted's own pre-flight refusals, by the
// same codes and statuses (`hostedStartRefusalResponse`).
//
// SESSION-AUTHED. Thin HTTP layer: session gate → ONE service call → map errors.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { id: key } = await params;

  // An empty body is a press with no choices; anything else must be a JSON object.
  const raw = await req.text();
  let body: unknown = {};
  if (raw.trim() !== '') {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return hostedProblem('BAD_REQUEST', 'The body must be a JSON object.', 400);
  }
  const { model, idempotencyKey } = body as { model?: unknown; idempotencyKey?: unknown };
  if (model !== undefined && model !== null && typeof model !== 'string') {
    return hostedProblem('BAD_REQUEST', '`model` must be a model id.', 400);
  }
  if (
    idempotencyKey !== undefined &&
    idempotencyKey !== null &&
    typeof idempotencyKey !== 'string'
  ) {
    return hostedProblem('BAD_REQUEST', '`idempotencyKey` must be a string.', 400);
  }

  try {
    const started = await agentReviewStartService.startRequested(
      {
        workItemKey: key,
        ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
        ...(typeof idempotencyKey === 'string' && idempotencyKey.trim()
          ? { idempotencyKey: idempotencyKey.trim() }
          : {}),
      },
      gate.ctx,
    );
    return NextResponse.json(started, {
      status: started.created ? 201 : 200,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return hostedProblem('WORK_ITEM_NOT_FOUND', 'Not found.', 404);
    }
    if (err instanceof ReviewStartForbiddenError) return hostedProblem(err.code, err.message, 403);
    if (err instanceof ReviewStartNotOfferedError) {
      return hostedProblem(err.code, err.message, 409, { reason: err.reason });
    }
    const refused = hostedStartRefusalResponse(err);
    if (refused) return refused;
    /* v8 ignore next -- an unexpected fault reaches the framework's 500 */
    throw err;
  }
}
