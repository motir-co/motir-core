import { NextResponse } from 'next/server';
import { ReviewStartForbiddenError, ReviewStartNotOfferedError } from '@/lib/agentReview/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { hostedStartRefusalResponse } from '@/lib/hostedRuns/startRefusalResponse';
import { agentReviewStartService } from '@/lib/services/agentReviewStartService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// POST /api/approval-gates/[id]/review-again (Story MOTIR-1626 · MOTIR-6820) — the shipped
// *Review again* button's route, RE-POINTED by Story MOTIR-11941 · MOTIR-11944 at
// *Review with Motir agent*'s press start (`approval-gates.md` §12.18): it reads the gate's
// item and starts the same press run, with no model and no client key, so the shipped
// button keeps working until the review doors UI card deletes this route together with its
// only caller (`components/github/reviewAgainRequest.ts`).
//
// Answers as before: 202 `{ gateId }` — the run started (or the press collapsed into one);
// 404 — no review the caller can see; 403 — outside the routed set; 409
// `REVIEW_START_NOT_OFFERED` with `reason`; and the hosted pre-flight refusals by Run hosted's
// codes.
//
// Thin HTTP layer: session gate → ONE service call → map errors.

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const gateId = id.trim();
  if (gateId === '') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'A gate id is required.' },
      { status: 400, headers: NO_STORE },
    );
  }
  const notFound = () =>
    NextResponse.json({ code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });

  try {
    await agentReviewStartService.startForGate(gateId, gate.ctx);
    return NextResponse.json({ gateId }, { status: 202, headers: NO_STORE });
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) return notFound();
    if (err instanceof ReviewStartForbiddenError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: 403, headers: NO_STORE },
      );
    }
    if (err instanceof ReviewStartNotOfferedError) {
      return NextResponse.json(
        { code: err.code, reason: err.reason, error: err.message },
        { status: 409, headers: NO_STORE },
      );
    }
    const refused = hostedStartRefusalResponse(err);
    if (refused) return refused;
    throw err;
  }
}
