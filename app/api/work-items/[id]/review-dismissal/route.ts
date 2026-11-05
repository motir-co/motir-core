import { NextResponse } from 'next/server';
import {
  ReviewDismissalForbiddenError,
  ReviewDismissalReasonRequiredError,
  ReviewDismissalStaleError,
  ReviewSendBackAlreadyDismissedError,
  ReviewSendBackNotStandingError,
} from '@/lib/agentReview/errors';
import {
  presentReviewDismissalResult,
  reviewDismissalBodySchema,
  toDismissReviewInput,
} from '@/lib/api/v1/workLoop/reviewDismissal';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { normalizeWorkItemKey, projectKeyOfWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { projectsService } from '@/lib/services/projectsService';
import { reviewDismissalService } from '@/lib/services/reviewDismissalService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// POST /api/work-items/[id]/review-dismissal — `[id]` is the card's KEY here (the segment
// keeps the name its siblings use, which Next requires) (Story MOTIR-10327 · MOTIR-10342) — the
// SESSION door to Dismiss the review, for the dialog the Development frame draws
// (`design/github/design-notes.md` § 32.6). The same ONE service as the bearer door
// `POST /api/v1/work-items/{key}/review-dismissal` (MOTIR-10334), which a browser cannot
// call: a person's press carries a session, not a token.
//
// Body `{ subjectVersion, reason }`, parsed and presented by the bearer door's own schema and
// presenter so the two answer alike. Answers 200 with the result; 404 for a card
// the caller cannot see (no existence leak); 403 `REVIEW_DISMISSAL_FORBIDDEN` or
// `PERMISSION_DENIED`; 409 `NO_STANDING_REVIEW_SENDBACK` · `REVIEW_SENDBACK_ALREADY_DISMISSED`
// · `REVIEW_DISMISSAL_STALE`; 422 `INVALID_BODY` · `REASON_REQUIRED`.
//
// Thin HTTP layer (CLAUDE.md § 4-layer): session gate → ONE service call → map errors.

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function json(status: number, body: Record<string, unknown>): Response {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;

  const parsed = reviewDismissalBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(422, { code: 'INVALID_BODY', error: 'subjectVersion and reason are required.' });
  }

  const { id } = await params;
  const identifier = normalizeWorkItemKey(id);
  try {
    const project = await projectsService.getByKey(projectKeyOfWorkItemKey(identifier), gate.ctx);
    const result = await reviewDismissalService.dismiss(
      project.id,
      identifier,
      toDismissReviewInput(parsed.data),
      gate.ctx,
    );
    return json(200, { ...presentReviewDismissalResult(result) });
  } catch (err) {
    if (
      err instanceof ProjectNotFoundError ||
      err instanceof WorkItemNotFoundError ||
      (err instanceof ProjectAccessDeniedError && err.kind === 'browse')
    ) {
      return json(404, { code: 'WORK_ITEM_NOT_FOUND', error: 'Not found.' });
    }
    if (err instanceof ReviewDismissalForbiddenError) {
      return json(403, { code: err.code, error: err.message });
    }
    if (err instanceof PermissionDeniedError || err instanceof ProjectAccessDeniedError) {
      return json(403, { code: 'PERMISSION_DENIED', error: 'You cannot dismiss this review.' });
    }
    if (err instanceof ReviewDismissalReasonRequiredError) {
      return json(422, { code: err.code, error: err.message });
    }
    if (
      err instanceof ReviewSendBackNotStandingError ||
      err instanceof ReviewSendBackAlreadyDismissedError ||
      err instanceof ReviewDismissalStaleError
    ) {
      return json(409, { code: err.code, error: err.message });
    }
    throw err;
  }
}
