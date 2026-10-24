import type { SubmittedRequirement } from '@/lib/ai/types';
import type {
  SharpenedRequirementDto,
  SharpeningWriteBackInput,
  SharpeningWriteBackResult,
} from '@/lib/dto/plans';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { upsertSharpenedBlock } from '@/lib/sharpening/managedBlock';
import { SharpeningInputInvalidError, SharpeningPlanClosedError } from '@/lib/sharpening/errors';
import { plansService } from '@/lib/services/plansService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// The Sharpen WRITE-BACK (Task MOTIR-1101 · Subtask MOTIR-8175) — where the
// answers a person settled in a Sharpen session land, called by motir-ai's
// grilling session through `PUT /api/internal/ai/plan-sharpening`.
//
// Every call carries the CUMULATIVE state, and every write REPLACES rather than
// appends: the plan's `sharpenedRequirement` is stored whole, and a body edit
// only ever replaces the delimited block `managedBlock` owns. So a call after
// every answer and one call at stop leave the same result, and a person's
// hand-written text is never touched.
//
// It acts as the JOB TOKEN'S USER, never a system context, and lands on the
// PLAN only: `ai:view_plan` on the plan's project; legal while `generating`,
// `planned` or `stale`; the requirement and every `perItem` proposal edit in ONE
// transaction under the plan's row lock.
//
// ⚠️ NO WORK ITEM IS EDITED (Story MOTIR-9221 · MOTIR-9314). The work-item scope
// and the plan scope's anchor leg are retired: Motir AI does not edit a card as if
// it were the person, and a grilling can span several targets, so there is no one
// card to put its answers on. A change to a committed card reaches it through the
// plan the person approves.

/** The headings the two managed blocks live under. */
const ACCEPTANCE_HEADING = 'Acceptance criteria';
const ASSUMPTIONS_HEADING = 'Assumptions';

/** The five string requirement parts, in canonical order (`assumptions` is the
 *  sixth, a string or a list). */
const ACCEPTANCE_PARTS = [
  'outcome',
  'behaviour',
  'scopeEdge',
  'constraints',
  'acceptance',
] as const;

/** The plan statuses a write-back lands on: the editable pair every other plan
 *  edit uses, plus `stale`, which the Sharpen door opens on (design MOTIR-8173:
 *  "Sharpening still writes to it"). A decided plan is refused. */
const EDITABLE_PLAN_STATUSES = new Set(['generating', 'planned', 'stale']);

/** Write both blocks into a proposal body; a block with no content is not written (a
 *  cumulative call never removes what an earlier one settled). */
function sharpenBody(body: string, acceptance: string, assumptions: string): string {
  let next = body;
  if (acceptance) next = upsertSharpenedBlock(next, ACCEPTANCE_HEADING, acceptance);
  if (assumptions) next = upsertSharpenedBlock(next, ASSUMPTIONS_HEADING, assumptions);
  return next;
}

function bulletLines(lines: readonly string[]): string {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => `- ${l}`)
    .join('\n');
}

/** The plan's requirement and its `perItem` proposals, in one transaction. */
async function writeBackToPlan(
  planId: string,
  input: SharpeningWriteBackInput,
  ctx: ServiceContext,
): Promise<string> {
  const plan = await withWorkspaceContext(ctx, (tx) =>
    planRepository.findById(planId, ctx.workspaceId, tx),
  );
  if (!plan) throw new PlanNotFoundError(planId);
  // The project comes from the PLAN row. The plan gate — a person who may not
  // browse sees a 404. No `work_item:edit`: no work item is written.
  await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

  const settledAt = new Date().toISOString();
  await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
    async (tx) => {
      const locked = await planRepository.lockById(planId, tx);
      if (!locked) throw new PlanNotFoundError(planId);
      const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
      if (!fresh) throw new PlanNotFoundError(planId);
      if (!EDITABLE_PLAN_STATUSES.has(fresh.status)) {
        throw new SharpeningPlanClosedError(planId, fresh.status);
      }

      // Judge EVERY `perItem` before writing any of them, so a bad one refuses
      // the whole call rather than leaving half of it written (the transaction
      // would roll back anyway; this keeps the refusal typed and specific).
      const edits: Array<{ planItemId: string; descriptionMd: string }> = [];
      for (const entry of input.perItem ?? []) {
        const item = await planItemRepository.findById(entry.planItemId, tx);
        if (!item || item.planId !== planId) {
          throw new SharpeningInputInvalidError(
            `Proposal ${entry.planItemId} is not a proposal of plan ${planId}.`,
          );
        }
        if (item.op !== 'add') {
          throw new SharpeningInputInvalidError(
            `Proposal ${entry.planItemId} is a \`${item.op}\`; only an \`add\` proposal's body is written.`,
          );
        }
        const fields = (item.proposedFields ?? {}) as { descriptionMd?: string | null };
        const current = fields.descriptionMd ?? '';
        const next = sharpenBody(
          current,
          bulletLines(entry.acceptance),
          bulletLines(entry.assumptions),
        );
        if (next !== current) edits.push({ planItemId: item.id, descriptionMd: next });
      }
      for (const edit of edits) {
        await plansService.sharpenProposalBodyInTx(
          fresh,
          edit.planItemId,
          edit.descriptionMd,
          ctx,
          tx,
        );
      }

      const stored: SharpenedRequirementDto = {
        ...pickRequirement(input.requirement),
        plannerAssumptions: input.plannerAssumptions.map((a) => ({
          question: a.question,
          recommendation: a.recommendation,
        })),
        settledAt,
      };
      await planRepository.setSharpenedRequirement(planId, stored, tx);
    },
  );
  return settledAt;
}

/** Only the six requirement parts: the five that are strings, and `assumptions`
 *  as a string or a list of recommendations (MOTIR-9160). */
function pickRequirement(r: Partial<SubmittedRequirement>): Partial<SubmittedRequirement> {
  const out: Partial<SubmittedRequirement> = {};
  for (const part of ACCEPTANCE_PARTS) {
    const value = r[part];
    if (typeof value === 'string') out[part] = value;
  }
  if (typeof r.assumptions === 'string' || Array.isArray(r.assumptions)) {
    out.assumptions = r.assumptions;
  }
  return out;
}

export const planSharpeningService = {
  /**
   * Store what a Sharpen session has settled so far on its target. Idempotent
   * and cumulative: the same input twice leaves the same bytes; a superset
   * replaces the managed blocks rather than adding second ones.
   */
  async writeBack(
    input: SharpeningWriteBackInput,
    ctx: ServiceContext,
  ): Promise<SharpeningWriteBackResult> {
    const settledAt = await writeBackToPlan(input.scope.planId, input, ctx);
    return { scope: { planId: input.scope.planId }, settledAt };
  },
};
