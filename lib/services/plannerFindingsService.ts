import { createPlannerFinding, type CreatePlannerFindingRequest } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import type { RecordedPlannerFindingDTO } from '@/lib/dto/plannerFindings';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The PLANNER-FINDINGS service (Story MOTIR-10354 · Subtask MOTIR-10386) — the
// one place that decides who may record a planner finding and which project it
// belongs to. The `record_planner_finding` MCP tool is a pass-through over it,
// and the wire call is `createPlannerFinding` in the motir-ai client leaf.
//
// Three guards, and a green happy-path test shows none of them:
//
// ⚠️ THE PERMISSION IS `ai:plan`, NOT A LESSON KEY. A finding only adds a row a
// platform admin later triages; it changes no standing instruction the planner
// is given. `lesson:manage` (add or retire a lesson) and `lesson:reinforce`
// would make a routine check run need rights over the lessons in order to
// report a defect. `ai:plan` is in the built-in member role, and the planning
// tools already file under it.
//
// ⚠️ THE GATE RUNS BEFORE ANY UPSTREAM WORK. Project resolution, then the gate,
// then the tenant organisation, then the one write — so a caller without the
// permission causes no work at all, not merely no row (as `addLesson`).
//
// ⚠️ THE WRITE NEITHER DEGRADES NOR RETRIES. Unlike `listLessons`, a write that
// failed must never read as recorded, so every upstream error propagates as the
// same instance. And the create route has no idempotency key, so a second
// attempt could store a second row: `createPlannerFinding` is called once.

/** The permission a caller must hold on the project to record a finding. */
export const RECORD_PLANNER_FINDING_PERMISSION = 'ai:plan' as const satisfies PermissionKey;

/**
 * The `planId` sent when the caller named no plan. motir-ai requires a non-empty
 * `planId`, and a check can run on a plan that is already decided or gone.
 *
 * ⚠️ TEXT, never a plan id and never a foreign key: nothing joins on it, and it
 * names no plan. It is exported so a reader of the store can recognise the row.
 */
export const PLANNER_FINDING_NO_PLAN_ID = '(no plan id given)';

/** The tool's single baseline argument: the branch and commit the code was read at. */
export interface PlannerFindingBaseline {
  branch?: string;
  commit?: string;
}

/**
 * One finding as a caller supplies it. No `source` (always `check_plan`), no
 * `status`, `fingerprint`, `jobId`, `lessonId`, `bugKey` or `aiProjectId`, and
 * no project identity: the project is the one `projectKey` resolves to. `rule`
 * is the planner rule or code site broken, the key motir-ai groups repeats on
 * (MOTIR-10468).
 */
export interface RecordPlannerFindingInput {
  planner: CreatePlannerFindingRequest['planner'];
  site: string;
  prediction: CreatePlannerFindingRequest['prediction'];
  whatHappened: string;
  evidence: string;
  outcome: CreatePlannerFindingRequest['outcome'];
  planId?: string;
  planTitle?: string;
  cardRef?: string;
  authorModel?: string;
  authorSessionKey?: string;
  baseline?: PlannerFindingBaseline;
  correction?: string;
  attribution?: CreatePlannerFindingRequest['attribution'];
  why?: string;
  hostedCell?: string;
  planpyCell?: string;
  fixDirection?: string;
  rule?: string;
}

/** The optional text members forwarded under their own name. */
const OPTIONAL_TEXT_FIELDS = [
  'planTitle',
  'cardRef',
  'authorModel',
  'authorSessionKey',
  'correction',
  'why',
  'hostedCell',
  'planpyCell',
  'fixDirection',
  'rule',
] as const satisfies readonly (keyof RecordPlannerFindingInput &
  keyof CreatePlannerFindingRequest)[];

type OptionalWireFields = Partial<
  Pick<
    CreatePlannerFindingRequest,
    (typeof OPTIONAL_TEXT_FIELDS)[number] | 'baselineBranch' | 'baselineCommit' | 'attribution'
  >
>;

/** Trimmed text, or `undefined` when absent or blank — a blank never reaches the wire. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionalWireFields(input: RecordPlannerFindingInput): OptionalWireFields {
  const out: OptionalWireFields = {};
  for (const key of OPTIONAL_TEXT_FIELDS) {
    const value = present(input[key]);
    if (value !== undefined) out[key] = value;
  }
  const baselineBranch = present(input.baseline?.branch);
  const baselineCommit = present(input.baseline?.commit);
  if (baselineBranch !== undefined) out.baselineBranch = baselineBranch;
  if (baselineCommit !== undefined) out.baselineCommit = baselineCommit;
  // A closed value, passed through unchanged; the tool's schema and motir-ai
  // both check it, so the service carries no copy of the enum.
  if (input.attribution) out.attribution = input.attribution;
  return out;
}

function buildRequest(
  identity: Pick<
    CreatePlannerFindingRequest,
    'coreOrganizationId' | 'coreWorkspaceId' | 'coreProjectId'
  >,
  input: RecordPlannerFindingInput,
): CreatePlannerFindingRequest {
  return {
    ...identity,
    // A supplied id is forwarded as given, with no lookup: the finding must
    // outlive its plan, and a check may run on a plan core never stored.
    planId: present(input.planId) ?? PLANNER_FINDING_NO_PLAN_ID,
    source: 'check_plan',
    planner: input.planner,
    // A whitespace-only required field is sent trimmed (so empty), and
    // motir-ai's refusal names the field.
    site: input.site.trim(),
    prediction: input.prediction,
    whatHappened: input.whatHappened.trim(),
    evidence: input.evidence.trim(),
    outcome: input.outcome,
    ...optionalWireFields(input),
  };
}

export const plannerFindingsService = {
  /**
   * Record ONE planner finding in motir-ai's findings store, against the project
   * `projectKey` names. Throws the not-found error `getByKey` raises for an
   * unknown or unbrowsable key, `PermissionDeniedError` without `ai:plan`, and
   * every `MotirAi*` error unchanged.
   */
  async recordFinding(
    projectKey: string,
    ctx: ServiceContext,
    input: RecordPlannerFindingInput,
  ): Promise<RecordedPlannerFindingDTO> {
    const project = await projectsService.getByKey(projectKey.trim().toUpperCase(), ctx);
    await projectAccessService.assertPermission(project.id, ctx, RECORD_PLANNER_FINDING_PERMISSION);

    // Resolved AFTER the gate: a caller without the permission causes no work.
    const { organizationId } = await resolveTenantOrg({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });

    const raw = await createPlannerFinding(
      buildRequest(
        {
          coreOrganizationId: organizationId,
          coreWorkspaceId: ctx.workspaceId,
          coreProjectId: project.id,
        },
        input,
      ),
    );
    return { id: raw.id, source: raw.source, fingerprint: raw.fingerprint, status: raw.status };
  },
};
