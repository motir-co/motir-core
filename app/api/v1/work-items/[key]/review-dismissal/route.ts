import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import {
  presentReviewDismissalResult,
  reviewDismissalBodySchema,
  toDismissReviewInput,
} from '@/lib/api/v1/workLoop/reviewDismissal';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { reviewDismissalService } from '@/lib/services/reviewDismissalService';

// POST /api/v1/work-items/{key}/review-dismissal (Story MOTIR-10327 · MOTIR-10334;
// `docs/decisions/approval-gates.md` §12.15) — the routed person DISMISSES the review
// agent's standing send-back at the card's current version, with a reason. The card stops
// being To fix for it and is asked to approve and merge again at the same version.
//
// Refusals, each typed by the service and mapped by code (`lib/api/v1/errors.ts`):
//   401 — no bearer;
//   403 — a run token, no `work_item:edit`, or `REVIEW_DISMISSAL_FORBIDDEN` (not the routed
//         person);
//   404 — an unknown card;
//   409 `NO_STANDING_REVIEW_SENDBACK`, `REVIEW_SENDBACK_ALREADY_DISMISSED`,
//       `REVIEW_DISMISSAL_STALE` (a push moved the version);
//   422 `INVALID_BODY` (a malformed body), `REASON_REQUIRED`.
export const POST = withV1Route<{ key: string }>({ permission: 'work_item:edit' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, reviewDismissalBodySchema);
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const dto = await reviewDismissalService.dismiss(
    projectId,
    identifier,
    toDismissReviewInput(body),
    ctx.service,
  );
  return NextResponse.json(presentReviewDismissalResult(dto));
});
