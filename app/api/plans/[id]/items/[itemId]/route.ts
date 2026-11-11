import { NextResponse } from 'next/server';

import { plansService } from '@/lib/services/plansService';
import {
  InvalidProposalError,
  PlanGrammarError,
  PlanItemNotFoundError,
  PlanNotEditableError,
  PlanNotFoundError,
  PlanNotInExpectedStatusError,
  PlanRefGraphError,
  UnresolvedPlanRefError,
  PlanItemUnresolvableTargetRepoRoleError,
} from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import type { UpdateProposalInput } from '@/lib/dto/plans';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// ⚠️ NO UI CALLS THIS ANY MORE (MOTIR-3084). MOTIR-1370's proposal edit modal —
// this route's only consumer — was REMOVED: manual editing of a proposal is not
// needed, because a proposal is READ (the canvas peek) and changed by
// re-planning. The route and `plansService.updateProposal` behind it are KEPT
// deliberately rather than left silently uncalled:
//
//   • it is an inventoried permission surface (`docs/decisions/permission-inventory.md`
//     row R11, `ai:view_plan`), so removing it is a permission-model change, not
//     a component deletion;
//   • `tests/integration/planning/contextualPlanningConfirmGate.test.ts` drives it
//     as the confirm gate's write;
//   • its generation-time twin `aiGenerationService.patchProposal` is a SEPARATE
//     method and is unaffected either way.
//
// Removing it is a defensible follow-up and a distinct change. If you are here
// because nothing calls it: that is expected, and this comment is the record.
//
// PATCH /api/plans/[id]/items/[itemId] — edit a proposed `add` of a `planned`
// plan (Subtask 7.21.6 / MOTIR-1370, calling the MOTIR-1336 substrate). Patches
// the add's proposed fields (title/kind/priority/type/description + leaf sizing
// storyPoints/estimateMinutes, MOTIR-1433) in place — NO WorkItem until approve.
// Only an `add` is editable; the plan must be `planned`.
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, parse the body, call ONE
// service method, map typed errors. `updateProposal` asserts `canEdit` (→ 403/404).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id, itemId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  // Pick ONLY the editable fields (the service merges sparsely; an absent key is
  // left untouched). Unknown keys are ignored, not an error. Leaf sizing
  // (MOTIR-1433): storyPoints/estimateMinutes are numbers — a present-but-
  // non-number value (other than the explicit clear) becomes `null`, and the
  // service re-validates the merged values (Fibonacci range / non-negative int).
  const input: UpdateProposalInput = {
    ...(typeof b.title === 'string' ? { title: b.title } : {}),
    ...(typeof b.kind === 'string' ? { kind: b.kind } : {}),
    ...('descriptionMd' in b
      ? { descriptionMd: typeof b.descriptionMd === 'string' ? b.descriptionMd : null }
      : {}),
    ...('type' in b ? { type: typeof b.type === 'string' ? b.type : null } : {}),
    ...('priority' in b ? { priority: typeof b.priority === 'string' ? b.priority : null } : {}),
    ...('storyPoints' in b
      ? { storyPoints: typeof b.storyPoints === 'number' ? b.storyPoints : null }
      : {}),
    ...('estimateMinutes' in b
      ? { estimateMinutes: typeof b.estimateMinutes === 'number' ? b.estimateMinutes : null }
      : {}),
    // A leaf's DIFFICULTY (MOTIR-6136), read by PRESENCE exactly as the internal
    // deepen route reads it: absent leaves it, `null` clears, a non-string
    // becomes `null`. Membership and the container refusal are the service's
    // (`validateProposedDifficulty`) — a typed `InvalidProposalError` → 422 below.
    ...('difficulty' in b
      ? {
          difficulty:
            typeof b.difficulty === 'string'
              ? (b.difficulty as UpdateProposalInput['difficulty'])
              : null,
        }
      : {}),
    // The card's ORDERED STEPS (MOTIR-4619 · AMENDMENT 14 D3), parsed exactly as
    // the internal deepen route parses it — the two edit paths accept the same
    // shape, which is what this route's shipped comment asks of them. Present
    // but not an array becomes `null` (this parser's convention for every
    // wrong-typed value above); the ROW shape is judged by the service, whose
    // typed `InvalidProposalError` the catch below already answers as a 422.
    ...('todos' in b
      ? { todos: Array.isArray(b.todos) ? (b.todos as UpdateProposalInput['todos']) : null }
      : {}),
  };

  // An `add`'s SUPERSEDES set (Story MOTIR-6577 · MOTIR-6631) — the older cards
  // the created card replaces. Read by PRESENCE like every key above: absent
  // leaves the set alone; an array REPLACES it (`[]` clears); a non-array is
  // ignored, as `correctionFrom` ignores one, rather than coerced into a clear
  // nobody asked for. It is STRUCTURAL, which the deepen substrate behind
  // `updateProposal` may not touch (AMENDMENT 3 D3), so a request carrying it
  // goes to `correctProposal` — the method that owns the ref passes and the
  // supersedes-cycle walk — flagged `byReviewer` so the status gate stays
  // `planned` and the trail records the person. Still ONE service call.
  //
  // This route edits `add`s only, so it takes no mark key: a `modify`'s mark
  // rides its patch, which the agent doors correct.
  const supersedesRefs = Array.isArray(b.supersedesRefs)
    ? b.supersedesRefs.filter((r): r is string => typeof r === 'string')
    : undefined;

  try {
    const plan =
      supersedesRefs !== undefined
        ? await plansService.correctProposal(id, itemId, { ...input, supersedesRefs }, ctx, {
            byReviewer: true,
          })
        : await plansService.updateProposal(id, itemId, input, ctx);
    return NextResponse.json(plan);
  } catch (err) {
    // MOTIR-2291 — the shared project gate's two refusals (404 for a non-browser,
    // 403 naming the key). Without this arm they fall through to a 500.
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof PlanNotFoundError || err instanceof PlanItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof PlanNotInExpectedStatusError || err instanceof PlanNotEditableError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    if (err instanceof InvalidProposalError || err instanceof UnresolvedPlanRefError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    // A correction re-pinning to a role the project's repository set resolves to no
    // single row (MOTIR-11039) — `correctProposal` raises it before its transaction.
    if (err instanceof PlanItemUnresolvableTargetRepoRoleError) {
      return NextResponse.json(
        { code: err.code, role: err.role, reason: err.reason, error: err.message },
        { status: 422 },
      );
    }
    // A `supersedesRefs` the ref passes refuse (MOTIR-6631) — dangling, a
    // duplicate, a folder, a cycle — with the same code and `reason` the agent
    // doors answer.
    if (err instanceof PlanRefGraphError || err instanceof PlanGrammarError) {
      return NextResponse.json(
        { code: err.code, reason: err.reason, error: err.message },
        { status: 422 },
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
