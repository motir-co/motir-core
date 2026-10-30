import type { PlanItemPatch, ProposalRescopeWarningDto, RescopeField } from '@/lib/dto/plans';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import {
  readModifyStatus,
  rescopeOutcomesText,
  type PlanStatusContext,
} from '@/lib/plans/planStatusRow';
import { rescopingFields, type RescopeTarget } from '@/lib/plans/rescopeReset';

// ── THE RE-SCOPE WARNING (bug MOTIR-10106) — PURE ──────────────────────────────
//
// Approve moves a card that claims built work (`implemented`, `in_review`, …) off
// that status when a `modify` changes its title, its description or its
// repository (`patchRescopes`, MOTIR-5359 · MOTIR-10102). The reviewer is shown
// the move as a status row before pressing approve; the planner that wrote the
// patch was told nothing, so a correction of record on a built card ("match what
// shipped") read to it the same as a real re-scope. The hosted re-plan of
// MOTIR-5766 put two `implemented` cards on its rewrite list that way.
//
// The write doors now say so. The warning is asked through `readModifyStatus` —
// the ONE read the review's status row is built from — so the planner is warned
// exactly when the reviewer is shown `re-scoped while <status>`, never otherwise.

/** The reader's word for each re-scoping field. */
const FIELD_WORDS: Record<RescopeField, string> = {
  title: 'title',
  descriptionMd: 'description',
  repository: 'repository',
};

const AND_LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/**
 * The warning a `modify` earns when approve will send its target back from built
 * work, or `null` when it will not: the target does not claim built work, the
 * patch is mark-only, or it changes nothing `patchRescopes` counts.
 */
export function rescopeWarningOf(
  item: { planItemId: string; proposal: string },
  patch: PlanItemPatch,
  target: RescopeTarget & { id: string; identifier: string; status: string },
  statusByKey: ReadonlyMap<string, Pick<WorkflowStatusDto, 'key' | 'label' | 'category'>>,
  context: PlanStatusContext,
): ProposalRescopeWarningDto | null {
  const read = readModifyStatus(patch, target, statusByKey, context);
  if (!read || read.decision.kind !== 'rescope' || !read.prior) return null;
  const outcomes = rescopeOutcomesText(statusByKey);
  if (outcomes === null) return null;
  const fields = rescopingFields(patch, target);
  const changes = AND_LIST.format(fields.map((f) => FIELD_WORDS[f]));
  return {
    planItemId: item.planItemId,
    proposal: item.proposal,
    workItemId: target.id,
    identifier: target.identifier,
    status: read.priorStatus,
    statusLabel: read.prior.label,
    outcomes,
    fields,
    message:
      `approve will re-open ${target.identifier} (${read.prior.label} → ${outcomes}) because ` +
      `this patch changes its ${changes}. Keep it only if what the card delivers changes; a ` +
      'correction of record belongs in a new card, a mark once it is done, or the boundary of ' +
      'the card that consumes it.',
  };
}
