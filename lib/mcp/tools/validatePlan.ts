import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { planValidityService } from '@/lib/services/planValidityService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { PlanValidityDto, ProposalRescopeWarningDto } from '@/lib/dto/plans';
import {
  advisoryBlockLines,
  crossLevelEdgeLines,
  invalidEdgeLines,
  sectionFindingLines,
} from '@/lib/mcp/tools/validateWorkItem';
import type { WorkItemProseShapeAdvisoryDto } from '@/lib/dto/workItems';
import type { ValidityCondition } from '@/lib/dto/sprints';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { conditionField } from './sprintRef';
import { requiredPlanIdField } from './planRef';

// `validate_plan` (Story MOTIR-3093 · Subtask MOTIR-3095) — is the WHOLE plan
// finishable once it materializes? The PAT-reachable twin of
// `POST /api/internal/ai/validate-plan-forest`, which `motir-ai`'s
// `generate_tree` runs as its PRE-COMMIT post-condition before closing a plan.
// The check, its rules and its tests all shipped with MOTIR-1550; what this adds
// is a door, so an agent authoring a plan over the MCP can run the same check
// its Motir-native counterpart already runs.
//
// ── Why this is its OWN tool and not a `planId` on `validate_work_item` ──────
// The forest verdict takes NO TARGET. Its containing set S is the entire
// projected forest, which is exactly what makes it the right question: a
// `blocked_by` edge that crosses two sibling roots (a story under proposed epic
// B gated by one under proposed epic A) is SATISFIED — both materialize
// together, so the gating node IS in S. Iterating the single-subtree check per
// root FALSE-POSITIVES every one of those edges, which is why
// `validate-plan-forest`'s own header calls a per-root walk "worse than no
// validation" for the multi-root forest a generation emits. Do not reimplement
// this as a loop over `validate_work_item`.
//
// A thin READ adapter over `planValidityService.validateProjectedPlan` — no
// business logic here. `project:browse` (`lib/mcp/toolPermissions.ts`), the key
// its own service asserts through `plansService.getPlan`, and NOT `ai:view_plan`
// (which gates the plan DECISIONS — approve / decline / addProposals). A
// projection decides nothing, writes nothing, persists nothing:
// `docs/decisions/agent-authored-plans.md` AMENDMENT 3, Q8.

export const VALIDATE_PLAN_TOOL_NAME = 'validate_plan';

const inputSchema = {
  planId: requiredPlanIdField,
  condition: conditionField,
};

interface ValidatePlanArgs {
  planId: string;
  condition?: ValidityCondition;
}

/**
 * Human-readable summary for the dual-content text block.
 *
 * ⚠️ IT RENDERS THE TWO FAILURE FAMILIES SEPARATELY, and that is the point rather
 * than presentation (MOTIR-3575). They need OPPOSITE repairs — an unfinishable
 * plan has a dependency reaching outside it, an unapprovable one is malformed —
 * and a caller that cannot tell them apart re-authors the wrong half. The VALID
 * arm no longer claims more than was checked: it used to promise finishability
 * only, in a sentence a reader takes as *this plan is sound*, which is what made
 * a plan the approve button then refused safe to close.
 */
function summarize(
  result: PlanValidityDto,
  advisories: readonly WorkItemProseShapeAdvisoryDto[],
  rescopeWarnings: readonly ProposalRescopeWarningDto[] = [],
): string {
  // The shape advisories over the plan's proposals (MOTIR-9007, widened to every
  // shape family by MOTIR-10087) ride beside the verdict and never change it —
  // and so do the `modify`s approve will send back from built work (MOTIR-10106).
  const linkLines = [
    ...advisoryBlockLines(
      advisories,
      `NOT a blocker — the plan is ${result.valid ? 'still VALID' : 'unaffected'} either way`,
    ),
    ...rescopeWarningLines(rescopeWarnings),
  ];
  if (result.valid) {
    return [
      `Plan ${result.planId} is VALID — it would be ACCEPTED by approve, and every item in ` +
        'the projected forest can be finished once it materializes. No work item was created: ' +
        'approving the plan in Motir is still the only path from a proposal to a work item.',
      ...sectionFindingLines(result.sectionFindings, 'valid'),
      ...linkLines,
    ].join('\n');
  }

  const lines: string[] = [`Plan ${result.planId} is INVALID.`];

  if (result.rejections.length > 0) {
    lines.push(
      '',
      'APPROVE WOULD REFUSE IT — the plan is malformed, so no amount of re-sequencing helps:',
      ...result.rejections.map(
        (r) => `  ${r.item}: ${r.code}${r.reason ? ` / ${r.reason}` : ''} — ${r.message}`,
      ),
      'Fix this BEFORE `final: true`: once the plan is `planned` its proposals are frozen, and ' +
        'the only repair left is to author a new plan and decline this one. Only ONE rejection ' +
        'is reported at a time — the check stops at the first — so re-run this after fixing it.',
    );
  }

  if (result.blockers.length > 0) {
    lines.push(
      '',
      `${result.blockers.length} item(s) in the projected forest are gated by work that is ` +
        'neither in the plan nor done:',
      ...result.blockers.map(
        (b) =>
          `  ${b.item} is blocked by ${b.blockedBy} (${b.blockerStatus}, ` +
          `${b.blockerSprintId ? `sprint ${b.blockerSprintId}` : 'backlog'})`,
      ),
      'Fix each edge before `final: true` — that is the only moment this check is cheap. An ' +
        'item named `planItem:<id>` is a proposal in THIS plan, not a work item.',
    );
  }

  lines.push(...invalidEdgeLines(result.invalidEdges));
  lines.push(...crossLevelEdgeLines(result.crossLevelEdges));
  lines.push(...sectionFindingLines(result.sectionFindings, 'invalid'));
  lines.push(...linkLines);

  return lines.join('\n');
}

/**
 * The `modify`s approve will send back from built work (MOTIR-10106), one line per
 * card — `[]` when there are none, so a plan without one reads as it always did.
 */
export function rescopeWarningLines(warnings: readonly ProposalRescopeWarningDto[]): string[] {
  if (warnings.length === 0) return [];
  return [
    '',
    `${warnings.length} \`modify\`(s) approve will send back from built work — NOT a blocker; ` +
      'keep each only if what the card delivers changes:',
    ...warnings.map((w) => `  planItem:${w.planItemId} (${w.identifier}): ${w.message}`),
  ];
}

export async function runValidatePlan(
  args: ValidatePlanArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    // The plan is read through `plansService.getPlan`, which resolves the
    // project AND asserts browse on it — so there is no project argument to
    // take and no second access check to add here.
    const [result, advisories, rescopeWarnings] = await Promise.all([
      planValidityService.validateProjectedPlan(args.planId, ctx, args.condition),
      planValidityService.projectedShapeAdvisories(args.planId, ctx),
      planValidityService.projectedRescopeWarnings(args.planId, ctx),
    ]);
    return toolOk(
      summarize(result, advisories, rescopeWarnings),
      exempt('validate_plan', {
        ...result,
        advisories,
        rescopeWarnings,
      } as unknown as Record<string, unknown>),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerValidatePlan(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    VALIDATE_PLAN_TOOL_NAME,
    {
      title: 'Validate a plan before anybody reviews it',
      description:
        'Check whether a PLAN you are authoring is SOUND — the pre-commit check to run BEFORE ' +
        '`add_plan_items` with `final: true`, which is the only moment it is cheap, because a ' +
        '`planned` plan’s proposals are frozen and the only repair left is a new plan. It ' +
        'answers TWO questions over the project’s live tree ⊕ this plan’s proposals, and ' +
        'VALID means BOTH pass. (1) APPROVABLE — would the approve button take it? A dangling ' +
        'ref, a duplicated blocker, a ref cycle, a blocked_by between two different LEVELS ' +
        '(two depths below their nearest common ancestor, or an epic and a non-epic — ' +
        '`cross_level`; an edge across parents on ONE level is fine), ' +
        'an illegal kind-parent placement, or a ' +
        '`modify`/`remove` of already-completed work each make it refuse; these arrive in ' +
        '`rejections`, at most one at a time because the check stops at the first, so re-run ' +
        'after fixing one. (2) FINISHABLE — every not-done item in the projected forest has ' +
        'each blocked_by dependency either inside the projection (it materializes with the ' +
        'plan) or already done; these arrive in `blockers`, each naming the gated item and the ' +
        'work gating it. The two need OPPOSITE repairs: a rejection means the plan is ' +
        'malformed, a blocker means it reaches outside itself. (3) COVERED — every same-level ' +
        'blocked_by between items under DIFFERENT parents that this plan introduces is carried ' +
        'by their parents too (the parents directly blocked_by each other); an uncovered one ' +
        'arrives in `invalidEdges` as `{ item, blockedBy, itemParent, blockerParent }` — a ' +
        'verdict only, the append and approve do not refuse it. (4) SAME-LEVEL — a COMMITTED ' +
        'blocked_by this plan introduces into its findings that joins two levels (the link door ' +
        'writes one; a PROPOSED one is a `cross_level` rejection) arrives in `crossLevelEdges` ' +
        'as `{ item, blockedBy, itemDepth, blockedByDepth, reason: "blocked_elsewhere", ' +
        'explanation }`. (3) and (4) report only the edges the PLAN introduces: an edge whose ' +
        'item or blocker, or an ancestor of either, the plan adds, re-parents, re-wires ' +
        '(`blockedByAdd` / `blockedByRemove`) or removes. An old bad edge the plan touches ' +
        'nothing of is not this plan’s finding — `validate_work_item` without a `planId` still ' +
        'reports it. Beside the verdict, never part of it, `advisories` lists every SHAPE ' +
        'advisory (`kind: "shape"`) on a card the plan PROPOSES (an `add`, keyed ' +
        '`planItem:<id>`, or a card a `modify` patches) — the same entries `validate_work_item` ' +
        'with this `planId` yields for that card: `likely-self-blocking-design` ' +
        '(`designCriterionIndex` + `surfaceCriterionIndex`: LIFT the design criterion into its ' +
        'own `type: design` card the rest is `blocked_by`), `likely-repo-straddle` and ' +
        '`likely-ordering-violation` (`criterionIndex`: cut or re-word there), ' +
        '`likely-over-gate-sizing`, `likely-post-merge-child-under-container`, ' +
        '`under-authored`, `likely-blocker-count-mismatch`, `body-edit-above-field-move`, and ' +
        '`likely-mislabelled-link` in a body the plan writes (a `[label](motir:<id>)` link ' +
        'whose label names a different key than the card the id opens, or whose id opens no ' +
        'card — `targetKey: null` — with the `field` it sits in). A runner STOPS on a ' +
        'two-index entry, so dispose of each before sealing: re-word the criterion, lift it, or ' +
        'record on the card why it is a false positive. Also beside the verdict, ' +
        '`rescopeWarnings` lists every `modify` approve will send back from built work — a ' +
        'patch changing the title, description or repository of a card at Implemented, In ' +
        'Review or Approved, which approve moves to To Do, Blocked or In Progress — naming the ' +
        'card, its status and the fields; keep each only if what the card delivers changes. ' +
        'Returns `{ planId, valid, rejections: [...], blockers: [...], invalidEdges: [...], ' +
        'crossLevelEdges: [...], sectionFindings: [...], advisories: [...], ' +
        'rescopeWarnings: [...] }`; an item named ' +
        '`planItem:<id>` is a PROPOSAL in this plan, not a work item. ' +
        '`condition` defaults to `loose` (a done dependency outside the plan counts as ' +
        'satisfied); `tight` requires every dependency to be IN the projection. This is the ' +
        'ADVISORY `sectionFindings` name each card the plan adds or modifies whose projected body, ' +
        'parsed against the section registry for its kind and type, misses a required section ' +
        '(`{ item, state, missing, invalid, otherHeadings, signals }`); they never change ' +
        '`valid`. An extra heading alone (an allowed `otherSections` entry, listed in ' +
        '`otherHeadings`) is not a finding. This is the ' +
        'WHOLE-plan verdict and takes no target — use `validate_work_item` with a `planId` for ' +
        'one subtree. Do NOT approximate it by looping that call per root: a blocked_by edge ' +
        'between two sibling roots is valid here and a false positive per-root, because both ' +
        'roots materialize together. Read-only: it creates nothing, mutates nothing and ' +
        'persists nothing, and approving the plan in Motir remains the only path from a ' +
        'proposal to a work item.',
      inputSchema,
    },
    async (args, extra) => runValidatePlan(args, resolveContext(extra)),
  );
}
