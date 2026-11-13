import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import {
  NoPlanForJobError,
  PlanItemNotFoundError,
  PlanNotEditableError,
  PlanNotFoundError,
  PlanProposalReferencedError,
} from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import {
  contentPatchFrom,
  correctionFrom,
  proposalEditErrorResponse,
} from '@/lib/ai/planProposalEditRequest';
import type { UpdateProposalInput } from '@/lib/dto/plans';

// PATCH /api/internal/ai/plan-proposals/[itemId] (Subtask 7.4.4a · MOTIR-1441) —
// the INTERNAL generation-time DEEPEN seam motir-ai's `generate_tree` handler
// (7.4.2 · MOTIR-844) calls in Phase 2 of the titles-first strategy: after the
// title+edge SKELETON is appended (POST .../plan-proposals), each `add`
// proposal's `descriptionMd` (+ finalised type/priority/storyPoints/
// estimateMinutes) is PATCHED one at a time WHILE the Plan is still
// `generating`. The Plan is resolved from the job token's `sourceJobId` (the
// `jobId` in the body), acting as the token's user. Creates NO WorkItem; the
// plan stays `generating` until a later `final:true` append marks it `planned`.
//
// This is the generation-time twin of the user-facing `PATCH /api/plans/[id]/
// items/[itemId]` (7.21.6 · MOTIR-1370): the public route edits a `planned`
// plan from a cookie session; THIS route deepens a `generating` plan from a job
// token. Same merge/validate substrate (`plansService` editAddProposal); the
// status gate (`generating`) and the auth surface (job token) are the only
// differences.
//
// Service-to-service only (§4a service bearer + §4b job token, via
// authenticateJobRequest). Thin transport: authenticate, parse, ONE service
// call, map errors. Merge/validation lives in the 7.21 service, not re-here.
//
// Typed errors → status:
//   JobAuthError                          → 401 (bad service bearer / missing-expired token)
//   NoPlanForJobError / PlanNotFoundError /
//     PlanItemNotFoundError               → 404 (no plan/item for this job in the token's tenant)
//   PlanNotInExpectedStatusError /
//     PlanNotGeneratingError              → 409 (the plan already left `generating`)
//   InvalidProposalError                  → 422 (empty title / editing a non-`add` / bad sizing /
//                                           a `priority` outside the enum, MOTIR-10656 / an
//                                           `executor` outside it, MOTIR-10678 — with
//                                           `planItemId` when the refusal names the proposal)
//   ProjectNotFoundError / PermissionDeniedError
//                                         → 404 / 403 naming the key — the plan
//                                           gate (`ai:view_plan`), mapped by
//                                           `aiPlanGateErrorResponse` exactly as
//                                           the human route maps it (MOTIR-6153)
//   ProjectAccessDeniedError              → 404 browse / 403 edit
//
// ── `mode: 'correct'` (Story MOTIR-3595 · Subtask MOTIR-3598) ────────────────
// The SECOND door onto `plansService.correctProposal`, which has had exactly one
// (`lib/mcp/tools/authorPlan.ts`) — so an external MCP agent could revise a
// landed plan and Motir's own planner could not. It carries the STRUCTURAL
// fields the deepen turn may not touch (`parentRef`, `blockedByRefs`,
// `supersedesRefs`, `targetRepo`, and a `modify`'s `patch` — sent as
// `modifyPatch`, which carries the obsolescence mark, its note and the four
// supersedes lists whole) and is legal on a `planned` plan as
// well as a `generating` one, exactly as the service is.
//
// ⚠️ THE MODE IS EXPLICIT, NEVER INFERRED FROM WHICH KEYS ARE PRESENT. Inferring
// it would make a deepen that happens to carry `parentRef` silently become a
// correction — a different act, on a different gate, recorded on the trail with
// a different meaning. Absent, `mode` is `deepen` and this route is byte-identical
// to what it has always been.
//
//   PlanNotEditableError                  → 409 (the plan is `approved`/`declined`)
//   UnresolvedPlanRefError                → 422 (a corrected ref names no proposal)
//   PlanItemUnknownTargetRepoError        → 422 (a repo outside the project's set)
//   PlanItemUnknownTargetRepoRoleError    → 422 (a role outside the shared vocabulary)
//   ConflictingTargetRepoInputError       → 422 (more than one repository field named)
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  const { itemId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'PROPOSALS_INVALID', error: 'request body must be valid JSON' },
      { status: 400 },
    );
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json(
      { code: 'PROPOSALS_INVALID', error: 'request body must be a JSON object' },
      { status: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  const jobId = b.jobId;
  if (typeof jobId !== 'string' || !jobId) {
    return NextResponse.json(
      { code: 'PROPOSALS_INVALID', error: '`jobId` is required.' },
      { status: 400 },
    );
  }

  const input: UpdateProposalInput = contentPatchFrom(b.patch);

  try {
    const result =
      b.mode === 'correct'
        ? await aiGenerationService.correctProposalForJob(
            jobId,
            itemId,
            correctionFrom(b, input),
            auth.ctx,
          )
        : await aiGenerationService.patchProposal(jobId, itemId, input, auth.ctx);
    return NextResponse.json(result);
  } catch (err) {
    const response = await proposalEditErrorResponse(err);
    if (response) return response;
    throw err;
  }
}

// DELETE /api/internal/ai/plan-proposals/[itemId] (Subtask MOTIR-3598) — the
// job-token door onto `plansService.withdrawProposal`: take one proposal OFF a
// `generating` or `planned` plan. Nothing reaches the tree either way.
//
// ⚠️ It is NOT `op: 'remove'`, which is a PROPOSAL to delete an existing work
// item at approve and requires a `workItemId`. And a withdraw whose target a
// sibling still references is REFUSED naming every referrer (409) rather than
// cascaded — the mirror of the append-time ref check, and this route does not
// soften it.
//
// The `jobId` rides a query parameter rather than a body, because a DELETE with
// a body is unreliable across the fetch stacks this seam is called from.
//
// Typed errors → status:
//   JobAuthError                          → 401
//   NoPlanForJobError / PlanNotFoundError /
//     PlanItemNotFoundError               → 404
//   PlanNotEditableError                  → 409 (`approved` / `declined`)
//   PlanProposalReferencedError           → 409 (a sibling still refs it)
//   ProjectNotFoundError / PermissionDeniedError
//                                         → 404 / 403 naming the key (the plan gate)
//   ProjectAccessDeniedError              → 404 browse / 403 edit
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  const { itemId } = await params;
  const jobId = new URL(req.url).searchParams.get('jobId');
  if (!jobId) {
    return NextResponse.json(
      { code: 'PROPOSALS_INVALID', error: '`jobId` is required.' },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      await aiGenerationService.withdrawProposalForJob(jobId, itemId, auth.ctx),
    );
  } catch (err) {
    // The plan gate, as on PATCH above (MOTIR-6153).
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    if (
      err instanceof NoPlanForJobError ||
      err instanceof PlanNotFoundError ||
      err instanceof PlanItemNotFoundError
    ) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof PlanNotEditableError || err instanceof PlanProposalReferencedError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    throw err;
  }
}
