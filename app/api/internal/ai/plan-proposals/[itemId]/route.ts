import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import {
  InvalidProposalError,
  NoPlanForJobError,
  PlanItemNotFoundError,
  PlanItemUnknownTargetRepoError,
  PlanItemUnknownTargetRepoRoleError,
  PlanNotEditableError,
  PlanNotFoundError,
  PlanNotGeneratingError,
  PlanNotInExpectedStatusError,
  PlanGrammarError,
  PlanProposalReferencedError,
  PlanRefGraphError,
  PlanTargetImmutableError,
  UnresolvedPlanRefError,
} from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { ConflictingTargetRepoInputError } from '@/lib/workItems/errors';
import type { CorrectProposalInput, PlanItemPatch, UpdateProposalInput } from '@/lib/dto/plans';

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
//   InvalidProposalError                  → 422 (empty title / editing a non-`add` / bad sizing)
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

  // The editable fields ride under `patch`. Pick ONLY the editable keys (sparse
  // merge in the service: an absent key is left untouched, an explicit `null` on
  // a nullable field clears it). This mirrors the public PATCH route's parsing
  // exactly, so both edit paths accept the same shape; a present-but-non-number
  // size (other than the explicit clear) becomes `null` and the service
  // re-validates the merged values.
  const patch = (typeof b.patch === 'object' && b.patch !== null ? b.patch : {}) as Record<
    string,
    unknown
  >;
  const input: UpdateProposalInput = {
    ...(typeof patch.title === 'string' ? { title: patch.title } : {}),
    ...(typeof patch.kind === 'string' ? { kind: patch.kind } : {}),
    ...('descriptionMd' in patch
      ? { descriptionMd: typeof patch.descriptionMd === 'string' ? patch.descriptionMd : null }
      : {}),
    // The card's SECTIONS INPUT (Story MOTIR-9023 · MOTIR-9030) — by PRESENCE and
    // forwarded AS SENT, like `languages` below: a wrong-typed value is not
    // coerced to "none", because dropping it would store the old body under a
    // write the planner meant as sections. The service refuses a non-object, a
    // missing / unknown / invalid section and the `descriptionMd` pairing
    // (`applySectionsInput`) → 422 `INVALID_PROPOSAL` by the catch below.
    ...('sections' in patch ? { sections: patch.sections as UpdateProposalInput['sections'] } : {}),
    ...('type' in patch ? { type: typeof patch.type === 'string' ? patch.type : null } : {}),
    ...('priority' in patch
      ? { priority: typeof patch.priority === 'string' ? patch.priority : null }
      : {}),
    ...('storyPoints' in patch
      ? { storyPoints: typeof patch.storyPoints === 'number' ? patch.storyPoints : null }
      : {}),
    ...('estimateMinutes' in patch
      ? {
          estimateMinutes: typeof patch.estimateMinutes === 'number' ? patch.estimateMinutes : null,
        }
      : {}),
    // A leaf's DIFFICULTY (MOTIR-6133) — by PRESENCE, like the sizes above it:
    // absent leaves it, `null` clears, a non-string becomes `null`. MEMBERSHIP
    // and the container refusal are the service's (`validateProposedDifficulty`),
    // answered as a typed `InvalidProposalError` → 422 by the catch below.
    ...('difficulty' in patch
      ? {
          difficulty:
            typeof patch.difficulty === 'string'
              ? (patch.difficulty as UpdateProposalInput['difficulty'])
              : null,
        }
      : {}),
    // ⚠️ `explanationMd` and `executor` (MOTIR-3865) — the two keys
    // `UpdateProposalInput` has DECLARED all along and this parser never read, so
    // the service accepted them and the transport never supplied them. The
    // request succeeded, the response was a `200`, and the proposal kept the WHY
    // it had — invisible from both ends, which is why it survived two doors.
    //
    // `explanationMd`: the runbook requires a re-scoped card's rationale to be
    // rewritten and a `mode: 'correct'` pass is the turn most likely to re-scope
    // one, so a correction that can change what a card SAYS and not why it EXISTS
    // is the one shape this route must not have. `lib/mcp/tools/authorPlan.ts` —
    // the door an EXTERNAL MCP agent uses — has parsed it since it shipped; this
    // is the same capability for Motir's own hosted planner.
    //
    // `executor`: AMENDMENT 4 D3a (MOTIR-3089) put it in the deepen set for a
    // reason that lands hardest HERE. This route IS the titles-first deepen seam,
    // where a skeleton proposal gains its `type`; `plansService.materialize`
    // writes `pf.executor ?? null` and never consults `defaultExecutorForType`,
    // so a proposal typed on this turn materialized UNASSIGNABLE and nothing on
    // the way there said so.
    //
    // Both read by PRESENCE, like every nullable key above them: absent leaves
    // the proposal's value alone, an explicit `null` clears it. A non-string
    // becomes `null`, which is the parser's shipped convention for `type` /
    // `priority` beside them — this is a thin transport, and the merged values
    // are re-validated by the service.
    ...('explanationMd' in patch
      ? { explanationMd: typeof patch.explanationMd === 'string' ? patch.explanationMd : null }
      : {}),
    ...('executor' in patch
      ? { executor: typeof patch.executor === 'string' ? patch.executor : null }
      : {}),
    // The card's ORDERED STEPS (MOTIR-4619 · AMENDMENT 14 D3). Read by PRESENCE
    // like the keys above it — absent leaves the proposal's list alone, an
    // explicit `null` clears it — with ONE difference that is a property of the
    // value rather than of this route: a list has no sparse edit, so a supplied
    // array REPLACES the set.
    //
    // A non-array becomes `null` rather than being forwarded, which is the
    // parser's shipped convention for every wrong-typed value here (`type`,
    // `priority`, the two sizes). The SHAPE of each row is not judged at this
    // layer at all: `validateProposedTodos` runs on the merged result inside the
    // service and answers a typed `InvalidProposalError`, which the catch below
    // already maps to 422 `PROPOSALS_INVALID` — so a malformed row is refused
    // with a message naming the row and the bar, rather than silently dropped by
    // a transport that knows less about the rules than the service does.
    ...('todos' in patch
      ? { todos: Array.isArray(patch.todos) ? (patch.todos as UpdateProposalInput['todos']) : null }
      : {}),
    // The LANGUAGE of each text field this edit writes (MOTIR-8743) — by
    // PRESENCE, and forwarded AS SENT: unlike the keys above, a wrong-typed value
    // is not coerced to "none", because dropping a bad language statement would
    // record the setting's language under text the planner said was written in
    // another. The service refuses it (`validateProposedLanguages` → 422).
    ...('languages' in patch
      ? { languages: patch.languages as UpdateProposalInput['languages'] }
      : {}),
  };

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
    // The plan gate's two refusals (MOTIR-6153). A job token acts as its user,
    // so a VIEWER's token reaches `plansService`'s `ai:view_plan` assertion and
    // is refused there — which this route answered with a 500 that motir-ai
    // reads as a server fault and retries. The human route has mapped the same
    // refusal since MOTIR-2291; one helper, so the two doors cannot disagree.
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    if (
      err instanceof NoPlanForJobError ||
      err instanceof PlanNotFoundError ||
      err instanceof PlanItemNotFoundError
    ) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (
      err instanceof PlanNotInExpectedStatusError ||
      err instanceof PlanNotGeneratingError ||
      err instanceof PlanNotEditableError
    ) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    if (
      err instanceof InvalidProposalError ||
      err instanceof UnresolvedPlanRefError ||
      err instanceof PlanItemUnknownTargetRepoError ||
      // The ROLE's refusal, beside the NAME's (MOTIR-3865) — the append route
      // has mapped it since MOTIR-1912 and this one had nothing to map, because
      // it carried no role. A correction that pins an unknown role must answer
      // the same typed 422 the append does, not a 500.
      err instanceof PlanItemUnknownTargetRepoRoleError ||
      // More than one of `targetRepo` / `targetRepos` / `targetRepositories` on
      // one correction (MOTIR-6153) — the service refuses rather than picking a
      // winner, and the refusal names the fields. The MCP door has always
      // answered it as a tool error; this door answered it as a 500.
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
    // A correction that puts a NON-mark key on a `modify` of a `done` /
    // `cancelled` card (Story MOTIR-6577 — a mark-only `modify` is legal there,
    // so the proposal exists, and the correction's approvability check re-runs
    // the persist gate over the replacement patch). 409 with `planItemId`, the
    // shape the approve route answers the same refusal with, instead of an
    // unmapped 500. Found by the story's gate (MOTIR-6633).
    if (err instanceof PlanTargetImmutableError) {
      return NextResponse.json(
        { code: err.code, planItemId: err.planItemId, error: err.message },
        { status: 409 },
      );
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

/**
 * The STRUCTURAL half of a correction, taken off the request beside the content
 * half the deepen parser already produced.
 *
 * Each key is read only when PRESENT — the service's patch is sparse, so an
 * absent key means *leave it alone* and an explicit `null` means *clear it*, and
 * collapsing the two here would make a correction that omits `targetRepo` unpin
 * the proposal. `blockedByRefs` is the exception the DTO documents: it is a LIST
 * and REPLACES the set, so `[]` clears it.
 */
function correctionFrom(
  b: Record<string, unknown>,
  content: UpdateProposalInput,
): CorrectProposalInput {
  return {
    ...content,
    ...('parentRef' in b
      ? { parentRef: typeof b.parentRef === 'string' ? b.parentRef : null }
      : {}),
    // An entry is a ref string or `{ ref, reason }` (MOTIR-9827), forwarded AS
    // SENT: the service splits the reasons off and refuses a malformed entry.
    ...(Array.isArray(b.blockedByRefs)
      ? {
          blockedByRefs: b.blockedByRefs.filter(
            (r) => typeof r === 'string' || (typeof r === 'object' && r !== null),
          ) as string[],
        }
      : {}),
    // An `add`'s SUPERSEDES set (Story MOTIR-6577 · MOTIR-6631) — a list, so it
    // REPLACES the set like `blockedByRefs` beside it and `[]` clears it. The refs
    // are ids, `planItem:` refs or `<PREFIX>-<n>` keys, which the service resolves
    // to ids exactly as for the blocker set (MOTIR-7983); the service's ref passes
    // and supersedes-cycle walk judge them,
    // and refuse it on a `modify`, which spells its edges on `modifyPatch`.
    ...(Array.isArray(b.supersedesRefs)
      ? { supersedesRefs: b.supersedesRefs.filter((r): r is string => typeof r === 'string') }
      : {}),
    ...('targetRepo' in b
      ? { targetRepo: typeof b.targetRepo === 'string' ? b.targetRepo : null }
      : {}),
    // The SET spellings of the same axis (bug MOTIR-4904). Read only when
    // PRESENT, like everything else here — and they are LISTS, so like
    // `blockedByRefs` above they replace rather than merge, and `[]` unpins.
    // A non-array under either key is ignored rather than coerced: an absent key
    // and a malformed one both mean the correction did not describe the axis, and
    // the alternative would be inventing an unpin nobody asked for.
    ...(Array.isArray(b.targetRepos)
      ? { targetRepos: b.targetRepos.filter((r): r is string => typeof r === 'string') }
      : {}),
    ...(Array.isArray(b.targetRepositories)
      ? {
          targetRepositories: b.targetRepositories.filter(
            (r): r is string => typeof r === 'string',
          ),
        }
      : {}),
    // The singular ROW-ID half of the pin (Story MOTIR-2732 · MOTIR-3045, surfaced
    // by MOTIR-4924), beside the SET forms above and the ROLE below. Sparse like
    // them: absent leaves the pin alone, an explicit `null` unpins. A non-string
    // is ignored rather than coerced, for the same reason a malformed set member
    // is — the correction did not describe the axis.
    ...('targetRepositoryRef' in b
      ? {
          targetRepositoryRef:
            typeof b.targetRepositoryRef === 'string' ? b.targetRepositoryRef : null,
        }
      : {}),
    // The ROLE half of the pin (MOTIR-3865) — structural, beside the name, and
    // the one a correction could not reach at all. It matters most exactly where
    // `targetRepo` cannot help: an ONBOARDING plan's repositories do not exist
    // when it is generated, so it pins a ROLE and nothing else — and a correction
    // that could re-pin only the NAME could not correct that plan's pin.
    //
    // Sparse like its neighbour: absent leaves the pin alone, an explicit `null`
    // unpins. The VALUE is narrowed by `plansService.correctProposal` against the
    // closed role vocabulary (the same `assertKnownRepoRole` the append and a
    // `modify`'s patch run), so an unrecognised role is a typed 422 rather than a
    // string smuggled into `proposedFields`.
    ...('targetRepoRole' in b
      ? {
          targetRepoRole: (typeof b.targetRepoRole === 'string'
            ? b.targetRepoRole
            : null) as CorrectProposalInput['targetRepoRole'],
        }
      : {}),
    // The SUBJECT coordinate (Story MOTIR-5062 · MOTIR-5065) — structural, and
    // correctable for the same reason the role is: it is settled at the `lay`,
    // so the deepen turn may not touch it and nothing else could fix a
    // mis-derived one short of a whole new plan.
    //
    // Sparse like its neighbours: absent leaves it alone, an explicit `null`
    // unpins. The VALUE is narrowed by `plansService.correctProposal` against
    // the same SHAPE and container checks the append runs — never against a
    // member list, which this repository deliberately does not hold.
    ...('subject' in b
      ? {
          subject: (typeof b.subject === 'string'
            ? b.subject
            : null) as CorrectProposalInput['subject'],
        }
      : {}),
    // ⚠️ `modifyPatch`, NOT `patch` — and the rename is the bug fix, not a
    // preference. On THIS route `patch` has meant the CONTENT bag since the
    // deepen seam shipped (`patch.title`, `patch.descriptionMd`, …), while a
    // `modify` proposal's `patch` is an entirely different object: the field
    // edits that will be applied to an existing work item at approve. Reading one
    // key as both makes every `add` correction that carries content fail with
    // *a `patch` belongs to a `modify` proposal* — which is the service refusing
    // correctly about a request nobody meant to send. Two things, two names.
    ...('modifyPatch' in b
      ? {
          patch: (typeof b.modifyPatch === 'object' && b.modifyPatch !== null
            ? b.modifyPatch
            : null) as PlanItemPatch | null,
        }
      : {}),
  };
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
