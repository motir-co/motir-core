import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import {
  presentReviewVerdictResult,
  reviewVerdictBodySchema,
  toSubmitReviewVerdictInput,
} from '@/lib/api/v1/workLoop/reviewVerdict';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { reviewVerdictService } from '@/lib/services/reviewVerdictService';

// POST /api/v1/work-items/{key}/review-verdict (Story MOTIR-10327 · MOTIR-10333;
// `docs/decisions/approval-gates.md` §12.11–§12.14) — a person's OWN review agent submits
// its ONE verdict for a run-target card, with the person's own token. Gate on, it decides
// the awaiting `agent_review` gate; gate off, it is stored as the review record. A
// `changes_requested` withdraws an awaiting approve-and-merge gate (`agent_changes_requested`)
// and makes the card To fix; no status moves.
//
// Refusals, each typed by the service and mapped by code (`lib/api/v1/errors.ts`):
//   401 — no bearer;
//   403 — a run token (this door is a person's; a hosted run uses `…/agent-review`), or no
//         `work_item:edit` on the card;
//   404 — an unknown card, or `REVIEW_NOTHING_TO_REVIEW` (it delivers no pull request);
//   409 `REVIEW_VERDICT_LATE` / `REVIEW_VERDICT_SECOND` — stored with that outcome, nothing
//       decided;
//   422 `INVALID_BODY` — a missing field, findings missing on a send-back, a `met` row with
//       no evidence; `REVIEW_TARGET_NOT_RUN_TARGET` — names the run target to review.
//
// ⚠️ NO `acceptsRunToken`: the run token's door is `…/agent-review`, hosted only.
export const POST = withV1Route<{ key: string }>({ permission: 'work_item:edit' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, reviewVerdictBodySchema);
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const dto = await reviewVerdictService.submit(
    projectId,
    identifier,
    toSubmitReviewVerdictInput(body),
    ctx.service,
  );
  return NextResponse.json(presentReviewVerdictResult(dto));
});
