import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import {
  DuplicatePlanTargetError,
  InvalidProposalError,
  NoPlanForJobError,
  PlanItemUnknownTargetRepoRoleError,
  PlanItemUnresolvableTargetRepoRoleError,
  PlanNotEditableError,
  PlanNotFoundError,
  PlanNotGeneratingError,
  PlanNotInExpectedStatusError,
  PlanPersistenceError,
  PlanGrammarError,
  PlanRefGraphError,
  UnresolvedPlanRefError,
} from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { ConflictingTargetRepoInputError } from '@/lib/workItems/errors';
import type { ProposalInput } from '@/lib/dto/plans';

// POST /api/internal/ai/plan-proposals (Subtask 7.4.4 · MOTIR-846) — the INTERNAL
// append seam motir-ai's `generate_tree` handler (7.4.2 · MOTIR-844) calls,
// REPLACING the whole-delta `plan-delta`. It appends a batch of `add` PlanItems to
// the job's `Plan` via the 7.21 `plansService.addProposals` (resolved from the
// job token's `sourceJobId`), as the token's user — creating NO WorkItem and
// setting no status (proposals are `PlanItem` rows). It returns the created
// PlanItem ids IN APPEND ORDER (the stable temp-ref keys the handler reuses for
// intra-plan parent/blocker refs). `final: true` marks the plan `planned` on
// frontier completion (a flag on this route, not a second endpoint).
//
// Service-to-service only (§4a service bearer + §4b job token, via
// authenticateJobRequest). Thin transport: authenticate, parse, ONE service call,
// map errors. Grammar/ref validation lives in the 7.21 service, not re-here.
//
// Typed errors → status:
//   JobAuthError                  → 401 (bad service bearer / missing-expired token)
//   NoPlanForJobError / PlanNotFoundError → 404 (no plan for this job in the
//                                          token's tenant — cross-tenant 404-not-403)
//   PlanNotGeneratingError /
//     PlanNotInExpectedStatusError → 409 (the plan already left `generating`)
//   DuplicatePlanTargetError      → 409 (this plan already proposes against that
//                                          work item — MOTIR-3194)
//   InvalidProposalError          → 422 (a proposal inconsistent with its op)
//   PlanPersistenceError          → 500 (an ORM failure inside the append,
//                                          CONTAINED — a typed code and a sentence
//                                          instead of Prisma's own prose)
//   PlanItemUnknownTargetRepoRoleError → 422 (a `targetRepoRole` outside the
//                                          shared role vocabulary — MOTIR-1912)
//   ConflictingTargetRepoInputError → 422 (an `add` naming more than one of
//                                          targetRepo / targetRepos /
//                                          targetRepositories — MOTIR-6215)
//   ProjectNotFoundError / PermissionDeniedError
//                                 → 404 / 403 naming the key — the plan gate
//                                   (`ai:view_plan`), mapped by
//                                   `aiPlanGateErrorResponse` exactly as the
//                                   human route maps it (MOTIR-6215)
//   ProjectAccessDeniedError      → 404 browse / 403 edit
// GET /api/internal/ai/plan-proposals?jobId=… (Story MOTIR-3595 · Subtask
// MOTIR-3598) — READ what the job's plan currently proposes.
//
// ⚠️ THE ONE READ IN THIS FAMILY THAT ANSWERS ABOUT PROPOSALS. Every other
// internal read (`plan-tree`, `get-item`, `get-subtree`, `search-work-items`)
// answers about the COMMITTED tree, and a proposal is not in it — which is
// exactly why a revising pass could not see the plan it was revising. Without
// this, motir-ai's in-flight registry starts empty and the handler proposes a
// plan from scratch: re-planning, not revising.
//
// Service-to-service only, resolved by `sourceJobId` like every seam beside it,
// so a job token cannot read another job's plan. Read-only. Beside `items` it
// answers the plan's `raisedGaps` (MOTIR-10176) and `authorRegistrations`
// (MOTIR-11085), which a resumed walk hands to its levels' amends.
// The longest plan title the append seam stores (MOTIR-8164). A longer one is
// CUT, not refused: a title is a label, and refusing the append over its length
// would throw away the proposals it carries.
const PLAN_TITLE_MAX = 200;

export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  const jobId = new URL(req.url).searchParams.get('jobId');
  if (!jobId) {
    return NextResponse.json(
      { code: 'PROPOSALS_INVALID', error: '`jobId` is required.' },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await aiGenerationService.readPlanProposals(jobId, auth.ctx));
  } catch (err) {
    if (err instanceof NoPlanForJobError || err instanceof PlanNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
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

export async function POST(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'PROPOSALS_INVALID', error: 'request body must be valid JSON' },
      { status: 400 },
    );
  }

  const jobId = (body as { jobId?: unknown })?.jobId;
  if (typeof jobId !== 'string' || !jobId) {
    return NextResponse.json(
      { code: 'PROPOSALS_INVALID', error: '`jobId` is required.' },
      { status: 400 },
    );
  }
  const rawProposals = (body as { proposals?: unknown })?.proposals ?? [];
  if (!Array.isArray(rawProposals)) {
    return NextResponse.json(
      { code: 'PROPOSALS_INVALID', error: '`proposals` must be an array.' },
      { status: 400 },
    );
  }
  const final = (body as { final?: unknown })?.final === true;
  // The AI-suggested project name (MOTIR-1554/1551) rides ONLY the final append,
  // and only from the onboarding generation. Accept a string; anything else
  // (absent/null/non-string) is "no name" — the consumer keeps the placeholder.
  const rawProductName = (body as { productName?: unknown })?.productName;
  const productName = typeof rawProductName === 'string' ? rawProductName : null;
  // The planner's BRIEFING (Story MOTIR-8149 · Subtask MOTIR-8157) rides the
  // final append the same way: a string is the plan's `summary`, anything else
  // is "no summary" and the plan's summary is left exactly as it was. It is
  // passed on for EVERY final append — a generation's, and a revision's, which
  // closes the plan it re-opened through the same `markPlanned` (Bug MOTIR-8208)
  // and so writes the briefing for the change (Bug MOTIR-8230). A non-final
  // append carries it nowhere: nothing closes there.
  const rawSummary = (body as { summary?: unknown })?.summary;
  const summary = typeof rawSummary === 'string' ? rawSummary : null;
  // The plan's TITLE (Story MOTIR-8161 · Subtask MOTIR-8164) — the hosted planner
  // names its plan from the settled ask on its first append and may correct it
  // on the final one, ahead of the briefing. Unlike `summary` it rides ANY
  // append, not only the final one. A string is trimmed and cut to
  // PLAN_TITLE_MAX characters; anything else, or a blank string, is "no title"
  // and the plan keeps the title it has. The service ignores it on a revision
  // append and on a plan that has left `generating`.
  // The job's resolved PLANNING MODEL (Bug MOTIR-8420) — motir-ai's
  // `PlanningRun.model`, never anything the LLM says about itself. Like the
  // briefing it rides only the FINAL append, a generation's or a revision's:
  // the close records it on a NATIVE plan whose `authorModel` is still empty,
  // and ignores it otherwise. A string is the model; anything else is "none".
  // This seam is job-token-authed and so native by construction, which is why
  // it may carry the model when no caller-facing door does.
  const rawAuthorModel = (body as { authorModel?: unknown })?.authorModel;
  const authorModel = typeof rawAuthorModel === 'string' ? rawAuthorModel : null;
  const rawTitle = (body as { title?: unknown })?.title;
  const trimmedTitle = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  const title = trimmedTitle.length > 0 ? trimmedTitle.slice(0, PLAN_TITLE_MAX).trim() : null;
  // ── THE REVISION PASS (Story MOTIR-3595 · Subtask MOTIR-3598) ──────────────
  // `revision: true` says WHICH PASS this append belongs to, and it changes two
  // things and nothing else: the status gate becomes the editable pair rather
  // than `generating` alone (`agent-authored-plans.md` AMENDMENT 10 D1), and
  // `final` closes the plan the revision RE-OPENED and then releases the
  // revision lease (`plansService.closeRevision`, Bug MOTIR-8208). Absent, this
  // route is byte-identical to what it has always been, gate and all.
  //
  // The actor triple rides beside it so the `revision_ended` row names the
  // harness and model that performed the act, which is what lets a reviewer see
  // WHO changed the tree under them.
  const revision = (body as { revision?: unknown })?.revision === true;
  const rawActor = (body as { actor?: unknown })?.actor;
  const actor =
    typeof rawActor === 'object' && rawActor !== null
      ? {
          source: null,
          harness:
            typeof (rawActor as { harness?: unknown }).harness === 'string'
              ? ((rawActor as { harness: string }).harness ?? null)
              : null,
          model:
            typeof (rawActor as { model?: unknown }).model === 'string'
              ? ((rawActor as { model: string }).model ?? null)
              : null,
        }
      : undefined;

  try {
    const result = await aiGenerationService.appendProposals(
      jobId,
      // An `add`'s `proposedFields.sections` (Story MOTIR-9023 · MOTIR-9030) rides
      // through UNCHANGED: `plansService.addProposals` checks it, renders it into
      // `descriptionMd` and strips it before anything is stored.
      rawProposals as ProposalInput[],
      auth.ctx,
      {
        final,
        productName,
        revision,
        ...(title !== null ? { title } : {}),
        ...(final && summary !== null ? { summary } : {}),
        ...(final && authorModel !== null ? { authorModel } : {}),
        ...(actor ? { actor } : {}),
      },
    );
    return NextResponse.json(result);
  } catch (err) {
    // The plan gate's two refusals (MOTIR-6215, the append's twin of MOTIR-6153
    // on `[itemId]`). A job token acts as its user, so a VIEWER's token reaches
    // `plansService.addProposals`' `ai:view_plan` assertion and is refused there
    // — which this route answered with a 500 that motir-ai reads as a server
    // fault and retries. One helper, so this door and the human one cannot
    // disagree.
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof NoPlanForJobError || err instanceof PlanNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (
      err instanceof PlanNotGeneratingError ||
      err instanceof PlanNotInExpectedStatusError ||
      err instanceof PlanNotEditableError
    ) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    // A second `modify`/`remove` for a work item this plan already targets
    // (MOTIR-3194). 409 rather than 422: the batch is well-formed, and what it
    // conflicts with is the plan's existing CONTENT. `workItem` rides as data so
    // the generator can act on it without parsing the sentence.
    if (err instanceof DuplicatePlanTargetError) {
      return NextResponse.json(
        { code: err.code, workItem: err.workItemId, error: err.message },
        { status: 409 },
      );
    }
    if (
      err instanceof InvalidProposalError ||
      // A `planItem:` ref naming no EARLIER `add` of this plan — most often one
      // appended in the SAME batch (MOTIR-3539). The service refuses it at the
      // append; this door answered it as a 500 motir-ai reads as a server fault
      // and retries, where the correction route beside it and the MCP door answer
      // the typed 422. Found by the mark story's gate (MOTIR-6633), whose
      // `supersedes` carriers take `planItem:` refs like the blocker lists.
      err instanceof UnresolvedPlanRefError ||
      // More than one of `targetRepo` / `targetRepos` / `targetRepositories` on
      // one `add` (MOTIR-6215) — the service refuses rather than picking a
      // winner, and the refusal names the fields.
      err instanceof ConflictingTargetRepoInputError
    ) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    // A proposal set the plan gate refuses where it is written (MOTIR-5414) — an
    // unknown `folder:<id>` (`dangling`), another project's folder
    // (`illegal_parent`), a folder in a blocker list, and the self-consistency and
    // re-parent verdicts that already threw here. 422 with the SAME code the MCP
    // door returns, and `reason` as data, instead of an unmapped 500.
    if (err instanceof PlanRefGraphError || err instanceof PlanGrammarError) {
      return NextResponse.json(
        { code: err.code, reason: err.reason, error: err.message },
        { status: 422 },
      );
    }
    // A proposal pinning a repo ROLE outside the vocabulary the two repos share
    // (MOTIR-1912). Rejected at the APPEND rather than at approve, so the producer
    // learns while it is still writing the plan; `proposal` names which one.
    if (err instanceof PlanItemUnknownTargetRepoRoleError) {
      return NextResponse.json(
        { code: err.code, proposal: err.proposalLabel, role: err.role, error: err.message },
        { status: 422 },
      );
    }
    // A vocabulary role the project's set resolves to no single row (MOTIR-11039).
    // Refused before the append's transaction opens, so the batch stored nothing.
    if (err instanceof PlanItemUnresolvableTargetRepoRoleError) {
      return NextResponse.json(
        {
          code: err.code,
          proposal: err.proposalLabel,
          role: err.role,
          reason: err.reason,
          error: err.message,
        },
        { status: 422 },
      );
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    // An ORM failure inside the append, contained by the service (MOTIR-3194).
    // It IS a 500 — nothing about the request could have avoided it — but it is a
    // 500 with a stable code, so the generator's retry logic reads a contract
    // rather than a Prisma invocation trace. `ormCode` rides as data.
    if (err instanceof PlanPersistenceError) {
      return NextResponse.json(
        { code: err.code, ormCode: err.ormCode, error: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
}
