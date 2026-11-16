import {
  createPlannerFinding,
  createPlannerFindingRecord,
  getJob,
  getPlannerFinding,
  getPlannerFindingRecord,
  listPlannerFindingGroups,
  listPlannerFindingRecords,
  listPlannerFindings,
  submitPlannerFindingRecordVerdict,
  type CreatePlannerFindingRequest,
  type PlannerFindingListQuery,
  type PlannerFindingRecordContextRequest,
  type PlannerFindingRecordFindingRequest,
  type RawPlannerFinding,
  type RawPlannerFindingRecordPage,
  type RawPlannerFindingRecordWithFindings,
  type RawPlannerFindingVerdictResult,
} from '@/lib/ai/motirAiClient';
import { type Prisma } from '@/generated/prisma/client';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import {
  PLANNER_FINDING_ATTRIBUTION_VALUES,
  PLANNER_FINDING_OUTCOME_VALUES,
  PLANNER_FINDING_PLANNER_VALUES,
  PLANNER_FINDING_SOURCE_VALUES,
  PLANNER_FINDING_STATUS_VALUES,
  type PlannerFindingCostDTO,
  type PlannerFindingCostLineDTO,
  type PlannerFindingDetailDTO,
  type PlannerFindingGroupListDTO,
  type PlannerFindingGroupRowDTO,
  type PlannerFindingListDTO,
  type PlannerFindingListFilters,
  type RecordedPlannerFindingDTO,
} from '@/lib/dto/plannerFindings';
import {
  toPlannerFindingDetailDTO,
  toPlannerFindingGroupListDTO,
  toPlannerFindingGroupRowDTO,
  toPlannerFindingListDTO,
} from '@/lib/mappers/plannerFindingMappers';
import {
  platformRoleAtLeast,
  requirePlatformStaff,
  type PlatformPrincipal,
} from '@/lib/platform/auth';
import { withPlatformRead, withPlatformWrite } from '@/lib/platform/context';
import { NotPlatformStaffError, PlannerFindingInvalidError } from '@/lib/platform/errors';
import type { PlannerFindingActor } from '@/lib/plannerFindings/types';
import type {
  CreatePlannerFindingRecordBody,
  PlannerFindingRecordQuery,
  PlannerFindingRecordVerdictBody,
} from '@/lib/plannerFindings/schemas';
import {
  platformPlanRepository,
  type PlatformPlanRecordContext,
} from '@/lib/repositories/platformPlanRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The PLANNER-FINDINGS service (Story MOTIR-10354 · Subtask MOTIR-10386) — the
// one place that decides who may record a planner finding and which project it
// belongs to, and (Story MOTIR-10353 · MOTIR-10518) the platform console's READS
// of the findings store, described above `plannerFindingsService` below. The `record_planner_finding` MCP tool is a pass-through over it,
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

// ── The console reads (Story MOTIR-10353 · MOTIR-10518) ─────────────────────
//
// Shaped like `platformLessonsService`'s reads: no Prisma (the findings are
// motir-ai's), the staff gate first, the client call, the mapper. Three rules
// live here and nowhere else:
//
// ⚠️ THE GATE. Every read calls `requirePlatformStaff('support')` before any
// motir-ai call. The `principal` argument is accepted for signature parity with
// the page callers and never trusted — the gate is re-resolved.
//
// ⚠️ THE DEFAULT VIEW. No `status` sends `excludeStatus: 'dismissed'`, `'all'`
// sends neither, a member sends that status. ONE mapper serves the list, the
// grouped read and a group's findings, so a group's count is computed over the
// findings it opens.
//
// ⚠️ THE COST. A finding's cost is null unless its plan job's result carries a
// usable review or repair line. Lines are copied, never summed (a line's
// `costMicroUsd` is already null when any session on it was unpriced), and an
// absent figure is null, never zero. A failed job read hides the cost and keeps
// the finding.
//
// The reads write no audit row: the story audits only the triage writes, and an
// audited read takes the chain lock on every filter change and page turn.

/** Findings per page, as the console's pager states it. */
export const PLANNER_FINDINGS_PAGE_SIZE = 50;

/** A finding in full, with the display name of whoever last triaged it. */
export interface PlannerFindingDetailView {
  detail: PlannerFindingDetailDTO;
  triagedByName: string | null;
}

function member<T extends string>(set: readonly T[], value: string | undefined): T | undefined {
  return value !== undefined && (set as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * The console's filters as the client's query. A value outside its closed set
 * is dropped, never sent: a mistyped URL must not reach motir-ai as a 400, nor
 * read as a filter that was applied.
 */
function toListQuery(filters: PlannerFindingListFilters): PlannerFindingListQuery {
  const query: PlannerFindingListQuery = { limit: PLANNER_FINDINGS_PAGE_SIZE };
  const source = member(PLANNER_FINDING_SOURCE_VALUES, filters.source);
  const planner = member(PLANNER_FINDING_PLANNER_VALUES, filters.planner);
  const attribution = member(PLANNER_FINDING_ATTRIBUTION_VALUES, filters.attribution);
  const outcome = member(PLANNER_FINDING_OUTCOME_VALUES, filters.outcome);
  if (source) query.source = source;
  if (planner) query.planner = planner;
  if (attribution) query.attribution = attribution;
  if (outcome) query.outcome = outcome;
  if (filters.status === undefined) {
    query.excludeStatus = 'dismissed';
  } else if (filters.status !== 'all') {
    const status = member(PLANNER_FINDING_STATUS_VALUES, filters.status);
    if (status) query.status = status;
  }
  if (filters.fingerprint) query.fingerprint = filters.fingerprint;
  if (filters.cursor) query.cursor = filters.cursor;
  return query;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** One usage line, or null when it is not a review/repair line with numeric counts. */
function toCostLine(value: unknown): PlannerFindingCostLineDTO | null {
  const line = asRecord(value);
  if (!line) return null;
  const { stage, model, inputTokens, outputTokens, sessions, costMicroUsd } = line;
  if (stage !== 'review' && stage !== 'repair') return null;
  if (!isCount(inputTokens) || !isCount(outputTokens) || !isCount(sessions)) return null;
  return {
    stage,
    model: typeof model === 'string' ? model : null,
    inputTokens,
    outputTokens,
    sessions,
    costMicroUsd: isCount(costMicroUsd) ? costMicroUsd : null,
  };
}

/**
 * The cost block of a plan job's result, read loosely: an older motir-ai sends
 * no lines, and a malformed one must read as no cost rather than a wrong one.
 */
function costOf(result: unknown): PlannerFindingCostDTO | null {
  const envelope = asRecord(result);
  const usage = envelope?.['stageUsage'];
  if (!Array.isArray(usage)) return null;
  const lines = usage.map(toCostLine).filter((l): l is PlannerFindingCostLineDTO => l !== null);
  if (lines.length === 0) return null;
  const counts = asRecord(asRecord(envelope?.['dryRun'])?.['counts']);
  const made = counts?.['findingsAccepted'];
  const fixed = counts?.['fixed'];
  return {
    findingsMade: isCount(made) ? made : null,
    findingsFixed: isCount(fixed) ? fixed : null,
    lines,
  };
}

/** The finding's plan cost, or null — a failed job read never takes the finding down. */
async function readCost(finding: RawPlannerFinding): Promise<PlannerFindingCostDTO | null> {
  if (!finding.jobId) return null;
  try {
    const job = await getJob(finding.jobId, finding.coreProjectId);
    return costOf(job.result);
  } catch (err) {
    console.warn('[plannerFindingsService] plan job unreadable; cost hidden', {
      jobId: finding.jobId,
      error: err instanceof Error ? err.constructor.name : typeof err,
    });
    return null;
  }
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

  /**
   * One page of findings, newest first; dismissed ones hidden unless asked for.
   *
   * @throws NotPlatformStaffError for a non-staff caller (the page 404s).
   * @throws MotirAiError when motir-ai cannot answer — never an empty page.
   */
  async list(
    _principal: PlatformPrincipal,
    filters: PlannerFindingListFilters,
  ): Promise<PlannerFindingListDTO> {
    await requirePlatformStaff('support');
    return toPlannerFindingListDTO(await listPlannerFindings(toListQuery(filters)));
  },

  /** One page of defects — a row per fingerprint — under the same filters as `list`. */
  async listGroups(
    _principal: PlatformPrincipal,
    filters: PlannerFindingListFilters,
  ): Promise<PlannerFindingGroupListDTO> {
    await requirePlatformStaff('support');
    return toPlannerFindingGroupListDTO(await listPlannerFindingGroups(toListQuery(filters)));
  },

  /** One defect's row, for the group page's header; null when no finding matches. */
  async getGroup(
    _principal: PlatformPrincipal,
    fingerprint: string,
    filters: PlannerFindingListFilters,
  ): Promise<PlannerFindingGroupRowDTO | null> {
    await requirePlatformStaff('support');
    const page = await listPlannerFindingGroups(
      toListQuery({ ...filters, fingerprint, cursor: undefined }),
    );
    const group = page.groups.find((g) => g.fingerprint === fingerprint);
    return group ? toPlannerFindingGroupRowDTO(group) : null;
  },

  /** A defect's findings: the list filtered to one fingerprint, same default. */
  async listGroupFindings(
    _principal: PlatformPrincipal,
    fingerprint: string,
    filters: PlannerFindingListFilters,
  ): Promise<PlannerFindingListDTO> {
    await requirePlatformStaff('support');
    return toPlannerFindingListDTO(
      await listPlannerFindings(toListQuery({ ...filters, fingerprint })),
    );
  },

  /**
   * One finding in full, with its plan dry run's cost (null when unmetered or
   * unreadable) and the name of whoever last triaged it.
   *
   * @throws PlannerFindingNotFoundError for an unknown id (the page 404s).
   * @throws MotirAiError when motir-ai cannot answer the finding read.
   */
  async get(_principal: PlatformPrincipal, findingId: string): Promise<PlannerFindingDetailView> {
    await requirePlatformStaff('support');
    const raw = await getPlannerFinding(findingId);
    const [cost, triagers] = await Promise.all([
      readCost(raw),
      raw.triagedBy ? userRepository.findByIds([raw.triagedBy]) : Promise.resolve([]),
    ]);
    return {
      detail: toPlannerFindingDetailDTO(raw, cost),
      triagedByName: triagers.find((u) => u.id === raw.triagedBy)?.name ?? null,
    };
  },
};

// ── Finding RECORDS for platform staff (Story MOTIR-11455 · MOTIR-11458) ─────
//
// What `/api/platform/planner-findings/**` calls — the door the private
// `motir check plan` skill reads and writes records through with a staff
// member's personal access token, or the console session (ADR §2, the
// 2026-11-16 amendment). No Prisma of its own beyond the one plan read: the
// records are motir-ai's, and core's part is the gate, the tenant resolution and
// the audit trail.
//
// ⚠️ EVERY CALL IS AUDITED. Reads run inside `withPlatformRead` as `estate.read`
// (the record store is cross-tenant platform data), writes inside
// `withPlatformWrite` with their own rows. The motir-ai call runs INSIDE the
// transaction, so a motir-ai error rolls the row back: a refused write leaves no
// row, and a read that failed reads as not having happened.
//
// ⚠️ THE LEVEL IS RE-ASSERTED. The route's gate admits `operator` or above; each
// method checks the actor's role again, so a caller that skipped the gate cannot
// reach motir-ai with a lower one. The actor came from the gate, never a body.
//
// ⚠️ THE RECORD'S TENANT COMES FROM CORE, never the caller: a core plan id is
// resolved to its organisation, workspace, project, session and source job; only
// when no plan resolves does a `projectKey` name the project, resolved under the
// tenant rules `recordFinding` applies (membership and `ai:plan`).
//
// The answers are motir-ai's record shapes unchanged (`docs/contract.md`'s
// `/v1/admin/planner-finding-records` block): the skill reads the same fields
// motir-ai documents, and re-mapping them here would be a second copy to keep.

/** The level every records route asks for, as the ideas routes' HTTP door does. */
export const PLANNER_FINDING_RECORDS_LEVEL = 'operator' as const;

/** The reason each write records; the `inherited` policy needs one and the skill sends none. */
const RECORD_REASON = 'Recorded a plan check through /api/platform/planner-findings.';
const VERDICT_REASON =
  'Gave a planner finding record its verdict through /api/platform/planner-findings.';

function assertRecordsLevel(actor: PlannerFindingActor): void {
  if (!platformRoleAtLeast(actor.role, PLANNER_FINDING_RECORDS_LEVEL)) {
    throw new NotPlatformStaffError();
  }
}

/** The credential as an audit row names it — never the token's secret or its workspace. */
function credentialMetadata(actor: PlannerFindingActor): Prisma.InputJsonObject {
  return actor.credential.kind === 'token'
    ? { kind: 'token', apiTokenId: actor.credential.apiTokenId }
    : { kind: 'session' };
}

/** Drop `undefined` members, so the audit metadata and the wire carry only what was given. */
function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

async function readPlanContext(
  actor: PlannerFindingActor,
  planId: string,
): Promise<PlatformPlanRecordContext | null> {
  return withPlatformRead(
    actor,
    {
      action: 'estate.read',
      targetKind: 'platform',
      targetId: planId,
      metadata: { surface: 'planner_finding_record.plan', credential: credentialMetadata(actor) },
    },
    (tx) => platformPlanRepository.findRecordContext(planId, tx),
  );
}

/** Where a `projectKey` is resolved: the body's workspace, else the token's own. */
function projectKeyWorkspace(actor: PlannerFindingActor, body: CreatePlannerFindingRecordBody) {
  if (body.workspaceId) return body.workspaceId;
  if (actor.credential.kind === 'token') return actor.credential.workspaceId;
  throw new PlannerFindingInvalidError(
    'workspaceId is required with projectKey on a console session',
    'workspaceId',
  );
}

async function resolveRecordContext(
  actor: PlannerFindingActor,
  body: CreatePlannerFindingRecordBody,
): Promise<PlannerFindingRecordContextRequest> {
  const optional = {
    planTitle: body.planTitle,
    authorModel: body.authorModel,
    baselineBranch: body.baseline?.branch,
    baselineCommit: body.baseline?.commit,
  };
  const plan = body.planId ? await readPlanContext(actor, body.planId) : null;
  if (plan) {
    return {
      coreOrganizationId: plan.workspace.organizationId,
      coreWorkspaceId: plan.workspaceId,
      coreProjectId: plan.projectId,
      planId: plan.id,
      source: 'check_plan',
      planner: body.planner,
      ...defined({
        // The stored plan is the truth for what it holds; the body fills gaps.
        planSessionId: plan.sessionId ?? body.planSessionId,
        jobId: plan.sourceJobId ?? body.jobId,
        ...optional,
        planTitle: body.planTitle ?? plan.title ?? undefined,
        authorModel: body.authorModel ?? plan.authorModel ?? undefined,
      }),
    };
  }

  if (!body.projectKey) {
    throw new PlannerFindingInvalidError(
      body.planId
        ? `plan ${body.planId} is not stored; name projectKey to record against its project`
        : 'name planId (a core plan id) or projectKey',
      'projectKey',
    );
  }
  const ctx = { userId: actor.userId, workspaceId: projectKeyWorkspace(actor, body) };
  const project = await projectsService.getByKey(body.projectKey.trim().toUpperCase(), ctx);
  await projectAccessService.assertPermission(project.id, ctx, RECORD_PLANNER_FINDING_PERMISSION);
  const { organizationId } = await resolveTenantOrg(ctx);
  return {
    coreOrganizationId: organizationId,
    coreWorkspaceId: ctx.workspaceId,
    coreProjectId: project.id,
    // A plan that is gone is still named by the id the caller had.
    planId: body.planId ?? PLANNER_FINDING_NO_PLAN_ID,
    source: 'check_plan',
    planner: body.planner,
    ...defined({ planSessionId: body.planSessionId, jobId: body.jobId, ...optional }),
  };
}

export const plannerFindingRecordsService = {
  /**
   * One finding, with the `recordId` of the record it belongs to.
   *
   * @throws PlannerFindingNotFoundError for an unknown id.
   */
  async getFinding(actor: PlannerFindingActor, findingId: string): Promise<RawPlannerFinding> {
    assertRecordsLevel(actor);
    return withPlatformRead(
      actor,
      {
        action: 'estate.read',
        targetKind: 'platform',
        targetId: findingId,
        metadata: { surface: 'planner_finding', credential: credentialMetadata(actor) },
      },
      () => getPlannerFinding(findingId),
    );
  },

  /** One page of records, newest first; the query is motir-ai's own filters. */
  async listRecords(
    actor: PlannerFindingActor,
    query: PlannerFindingRecordQuery,
  ): Promise<RawPlannerFindingRecordPage> {
    assertRecordsLevel(actor);
    return withPlatformRead(
      actor,
      {
        action: 'estate.read',
        targetKind: 'platform',
        metadata: {
          surface: 'planner_finding_records',
          query: defined(query) as Prisma.InputJsonObject,
          credential: credentialMetadata(actor),
        },
      },
      () => listPlannerFindingRecords(query),
    );
  },

  /**
   * One record with every finding.
   *
   * @throws PlannerFindingRecordNotFoundError for an unknown id.
   */
  async getRecord(
    actor: PlannerFindingActor,
    recordId: string,
  ): Promise<RawPlannerFindingRecordWithFindings> {
    assertRecordsLevel(actor);
    return withPlatformRead(
      actor,
      {
        action: 'estate.read',
        targetKind: 'platform',
        targetId: recordId,
        metadata: { surface: 'planner_finding_record', credential: credentialMetadata(actor) },
      },
      () => getPlannerFindingRecord(recordId),
    );
  },

  /**
   * Store one plan check as a record with its findings, against the tenant a
   * core plan id resolves to (or `projectKey` when no plan is stored), and append
   * one `planner_finding.record` row.
   *
   * @throws PlannerFindingInvalidError when the body names neither a stored plan nor `projectKey`.
   * @throws ProjectNotFoundError / PermissionDeniedError for a `projectKey` the actor cannot record in.
   * @throws MotirAiError from the create unchanged — no row is written then.
   */
  async createRecord(
    actor: PlannerFindingActor,
    body: CreatePlannerFindingRecordBody,
  ): Promise<RawPlannerFindingRecordWithFindings> {
    assertRecordsLevel(actor);
    const context = await resolveRecordContext(actor, body);
    const findings = body.findings.map(
      (f) => defined(f) as unknown as PlannerFindingRecordFindingRequest,
    );
    return withPlatformWrite(actor, async (_tx, record) => {
      const created = await createPlannerFindingRecord({
        record: context,
        findings,
        actorCoreUserId: actor.userId,
      });
      await record({
        action: 'planner_finding.record',
        targetKind: 'platform',
        targetId: created.record.id,
        targetLabel: created.record.planTitle ?? created.record.planId,
        organizationId: created.record.coreOrganizationId,
        reason: RECORD_REASON,
        metadata: {
          recordId: created.record.id,
          planId: created.record.planId,
          findingCount: created.findings.length,
          verdictState: created.record.verdictState,
          credential: credentialMetadata(actor),
        },
      });
      return created;
    });
  },

  /**
   * Give a record its verdict: forward it to motir-ai, which attributes every
   * finding in one transaction, then append one `planner_finding.verdict` row per
   * finding it changed (one row on the record when it changed none).
   *
   * @throws PlannerFindingRecordNotFoundError for an unknown record.
   * @throws MotirAiConflictError when the record already has a verdict and `replace` is not set.
   * @throws MotirAiError from the verdict unchanged — no row is written then.
   */
  async submitVerdict(
    actor: PlannerFindingActor,
    recordId: string,
    body: PlannerFindingRecordVerdictBody,
  ): Promise<RawPlannerFindingVerdictResult> {
    assertRecordsLevel(actor);
    const request = {
      verdicts: body.verdicts.map((v) => defined(v) as typeof v),
      ...(body.replace === undefined ? {} : { replace: body.replace }),
    };
    return withPlatformWrite(actor, async (_tx, record) => {
      const result = await submitPlannerFindingRecordVerdict(recordId, request, actor.userId);
      const base = {
        action: 'planner_finding.verdict' as const,
        targetKind: 'platform' as const,
        organizationId: result.record.coreOrganizationId,
        reason: VERDICT_REASON,
      };
      if (result.audit.length === 0) {
        await record({
          ...base,
          targetId: result.record.id,
          targetLabel: result.record.planTitle ?? result.record.planId,
          metadata: {
            recordId: result.record.id,
            changedFindings: 0,
            credential: credentialMetadata(actor),
          },
        });
      }
      for (const entry of result.audit) {
        await record({
          ...base,
          targetId: entry.findingId,
          targetLabel: result.findings.find((f) => f.id === entry.findingId)?.site ?? null,
          metadata: {
            recordId: result.record.id,
            findingId: entry.findingId,
            before: entry.before as Prisma.InputJsonObject,
            after: entry.after as Prisma.InputJsonObject,
            credential: credentialMetadata(actor),
          },
        });
      }
      return result;
    });
  },
};
