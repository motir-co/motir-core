import type { ProjectContext } from '@/lib/projects';
import type { PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { planReviewService } from '@/lib/services/planReviewService';
import type { PlanStepKindDto } from '@/lib/dto/plans';

// THE RUN SNAPSHOT an `ask_project` turn carries during a planning run (Story
// MOTIR-7990 · MOTIR-7996) — the `context.run` object motir-ai's answering session
// reads (`src/llm/runContext.ts` there; `docs/contract.md`'s ask_project run mode).
//
// WHY CORE BUILDS IT: core holds the plan, and the answering job cannot read
// another job's plan (a job token reaches only its own). The snapshot is built at
// TURN TIME, so an answer is "as of the moment you asked".
//
// ⚠️ IT NEVER THROWS. A plan that cannot be read (not found, access, network) is
// reported as `{ planId, readable: false, reason }`, and the answering session
// then says so honestly. A bad snapshot must cost the person an honest "I could
// not read the run", never a failed turn.
//
// ⚠️ NO `activity` KEY. The per-tool-call activity line is the planning job's
// `tool_call` stream frame, narrated in the browser; it is not held server-side.
// The contract makes `activity` optional, and the answering session answers from
// the steps and the proposals.
//
// 4-layer: a service reading through another service, opening no transaction.

/** Who is offering what: the turn the answering session last offered to forward. */
export interface PendingOfferInput {
  turnText: string;
}

export interface RunContextStep {
  /** The step's kind. motir-ai drops a kind it does not know rather than misread it. */
  step: PlanStepKindDto;
  target: string | null;
  title: string | null;
  startedAt: string;
}

export interface RunContextProposal {
  ref: string;
  op: string;
  kind: string | null;
  title: string | null;
  parentRef: string | null;
  blockedByRefs: string[];
  authored: boolean;
  descriptionMd: string | null;
  explanationMd: string | null;
}

export interface ReadableRunContext {
  planId: string;
  readable: true;
  planStatus: string;
  steps: RunContextStep[];
  proposals: RunContextProposal[];
  pendingOffer?: PendingOfferInput;
}

export interface UnreadableRunContext {
  planId: string;
  readable: false;
  reason: string;
  pendingOffer?: PendingOfferInput;
}

export type RunContext = ReadableRunContext | UnreadableRunContext;

/** The ref a node id carries on the wire: a proposal in this plan is
 *  `planItem:<id>`, anything else (a committed work item) is its identifier or id. */
function refOfNode(
  nodeId: string,
  planItemIds: ReadonlySet<string>,
  committedIdentifiers: ReadonlyMap<string, string>,
): string {
  if (planItemIds.has(nodeId)) return `${TEMP_REF_PREFIX}${nodeId}`;
  return committedIdentifiers.get(nodeId) ?? nodeId;
}

function toProposal(
  item: PlanReviewItemDto,
  planItemIds: ReadonlySet<string>,
  committedIdentifiers: ReadonlyMap<string, string>,
): RunContextProposal {
  return {
    ref: `${TEMP_REF_PREFIX}${item.planItemId}`,
    op: item.op,
    kind: item.kind ?? null,
    title: item.title ?? null,
    parentRef: item.parentNodeId
      ? refOfNode(item.parentNodeId, planItemIds, committedIdentifiers)
      : null,
    blockedByRefs: item.blockedByNodeIds.map((id) =>
      refOfNode(id, planItemIds, committedIdentifiers),
    ),
    // "Written": the stored `authorFinished` alone (MOTIR-10496) — the same
    // test the progress counter and `get_plan_authoring_state` apply, so the
    // answering session cannot call a card written the plan surface does not.
    authored: item.op === 'add' && item.authorFinished === true,
    descriptionMd: item.descriptionMd ?? null,
    explanationMd: item.explanationMd ?? null,
  };
}

function toRunContext(review: PlanReviewDto): ReadableRunContext {
  const planItemIds = new Set(review.items.map((i) => i.planItemId));
  const committedIdentifiers = new Map<string, string>();
  for (const item of review.items) {
    if (item.identifier) committedIdentifiers.set(item.nodeId, item.identifier);
    for (const stub of item.blockerStubs ?? []) {
      if (stub.identifier) committedIdentifiers.set(stub.nodeId, stub.identifier);
    }
  }
  return {
    planId: review.id,
    readable: true,
    planStatus: review.status,
    steps: (review.progress?.steps ?? []).map((s) => ({
      step: s.kind,
      target: s.targetRef,
      title: s.targetTitle,
      startedAt: s.startedAt,
    })),
    proposals: review.items.map((i) => toProposal(i, planItemIds, committedIdentifiers)),
  };
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return 'UNREADABLE';
}

export const planRunContextService = {
  /**
   * The `context.run` object for a mid-run turn. `planJobId` names the planning
   * job the turn is addressed at (the caller has already bound it to the session);
   * `planId` is the plan that job is writing. Never throws.
   */
  async buildRunContext(
    planJobId: string,
    planId: string,
    ctx: ProjectContext,
    pendingOffer: PendingOfferInput | null,
  ): Promise<RunContext> {
    // The job is the caller's binding, not a read key: a plan is addressed by id.
    void planJobId;
    const offer = pendingOffer ? { pendingOffer: { turnText: pendingOffer.turnText } } : {};
    try {
      const review = await planReviewService.getPlanReview(planId, ctx);
      // A plan of another project is "not found" from this conversation's side —
      // the same answer an unknown id gets, with no existence leak.
      if (review.projectId !== ctx.projectId) {
        return { planId, readable: false, reason: 'PLAN_NOT_FOUND', ...offer };
      }
      return { ...toRunContext(review), ...offer };
    } catch (err) {
      return { planId, readable: false, reason: errorCode(err), ...offer };
    }
  },
};
