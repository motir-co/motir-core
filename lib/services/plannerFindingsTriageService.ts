import 'server-only';

import {
  createLesson,
  getPlannerFinding,
  triagePlannerFinding,
  type RawPlannerFinding,
  type RawPlannerFindingAudit,
  type RawPlannerFindingTriageResult,
} from '@/lib/ai/motirAiClient';
import { MotirAiBadRequestError, MotirAiConflictError } from '@/lib/ai/errors';
import {
  PLANNER_FINDING_ATTRIBUTION_VALUES,
  type PlannerFindingAttributionValue,
  type PlannerFindingRowDTO,
  type PlannerFindingTriageInput,
} from '@/lib/dto/plannerFindings';
import {
  toPlannerFindingAuditMetadata,
  toPlannerFindingRowDTO,
  toPlannerFindingTriagePatch,
} from '@/lib/mappers/plannerFindingMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { type Prisma } from '@/generated/prisma/client';
import { withPlatformWrite } from '@/lib/platform/context';
import {
  PlannerFindingInvalidError,
  PlannerFindingLessonNotLinkedError,
  PlannerFindingUnchangedError,
} from '@/lib/platform/errors';

// The planner-findings TRIAGE service (Story MOTIR-10353 · MOTIR-10519) — the
// one place an admin's triage act becomes a motir-ai write and a
// `planner_finding.triage` row. No Prisma: the findings are motir-ai's, and
// core's part is the gate and the audit trail.
//
// ⚠️ THE GATE RUNS FIRST, AND ITS PRINCIPAL IS THE ACTOR. `operator` or above,
// as the lesson console's curating writes; the `principal` argument is never
// trusted — the one `requirePlatformStaff` answers is the actor id and the
// audit principal.
//
// ⚠️ ROW OR NOTHING. The remote write runs INSIDE `withPlatformWrite`, which
// takes the chain lock and rolls back unless a row is recorded. motir-ai's own
// audit record is the from → to, known only after the call, so the row is
// recorded after it; `audit: null` throws `PlannerFindingUnchangedError` inside
// the transaction and leaves no row.
//
// ⚠️ PROMOTE SPANS TWO SYSTEMS. Read the finding, create the lesson in the
// finding's OWN project (ids from the finding, never the caller), then record
// its id with the audited triage write. If that second step fails, the lesson
// exists: `PlannerFindingLessonNotLinkedError` carries both ids, nothing
// retries the create, nothing deletes the lesson.
//
// It creates no work item and files no bug: a bug key is a string an admin typed.

/** The promote form, as the triage controls submit it. */
export interface PlannerFindingPromoteForm {
  mistakeType: string;
  title: string;
  why: string;
  howToApply: string;
}

/** What every triage write answers: the finding as it now stands. */
export interface PlannerFindingTriageOutcome {
  finding: PlannerFindingRowDTO;
}

/** The attribution input `setAttribution` takes. */
export type PlannerFindingAttributionInput = Omit<
  Extract<PlannerFindingTriageInput, { kind: 'attribution' }>,
  'kind' | 'attribution'
> & { attribution: string };

/** A project key, a dash and digits — the design's own example is MOTIR-123. */
const BUG_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/** The reason each act records; the `inherited` policy needs one and no screen supplies it. */
const DEFAULT_REASON: Record<PlannerFindingTriageInput['kind'], string> = {
  attribution: 'Set the attribution of a planner finding from /admin/planner-findings.',
  promote: 'Promoted a planner finding to a lesson from /admin/planner-findings.',
  bug: 'Recorded the planning bug key of a planner finding from /admin/planner-findings.',
  dismiss: 'Dismissed a planner finding from /admin/planner-findings.',
  restore: 'Restored a dismissed planner finding from /admin/planner-findings.',
};

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

function required(value: string, field: string): string {
  const t = value.trim();
  if (!t) throw new PlannerFindingInvalidError(`${field} cannot be blank`, field);
  return t;
}

/**
 * One triage write inside the audited transaction: the remote call, then its
 * row. Logs the residual case — motir-ai applied the change but core's row did
 * not commit — and rethrows.
 */
async function auditedTriage(
  principal: PlatformPrincipal,
  findingId: string,
  input: PlannerFindingTriageInput,
  reason: string,
): Promise<RawPlannerFindingTriageResult> {
  let applied: RawPlannerFindingTriageResult | null = null;
  try {
    return await withPlatformWrite(principal, async (_tx, record) => {
      const written = await triagePlannerFinding(
        findingId,
        toPlannerFindingTriagePatch(input),
        principal.userId,
      );
      if (!written.audit) throw new PlannerFindingUnchangedError(findingId);
      applied = written;
      await record({
        action: 'planner_finding.triage',
        targetKind: 'platform',
        targetId: findingId,
        targetLabel: written.finding.site,
        organizationId: written.finding.coreOrganizationId,
        reason,
        metadata: auditMetadata(written.audit),
      });
      return written;
    });
  } catch (err) {
    if (applied) {
      const { audit } = applied as RawPlannerFindingTriageResult;
      // A constant format string; the ids ride as data, never as a format.
      console.error(
        '[planner-findings] motir-ai applied a triage but the audit row did not commit: %s',
        JSON.stringify({
          action: 'planner_finding.triage',
          findingId,
          actor: principal.userId,
          before: audit?.before,
          after: audit?.after,
        }),
        err,
      );
    }
    throw err;
  }
}

async function plainWrite(
  principal: PlatformPrincipal,
  findingId: string,
  input: PlannerFindingTriageInput,
  reason: string = DEFAULT_REASON[input.kind],
): Promise<PlannerFindingTriageOutcome> {
  const { finding } = await auditedTriage(principal, findingId, input, reason);
  return { finding: toPlannerFindingRowDTO(finding) };
}

function lessonRequest(finding: RawPlannerFinding, form: PlannerFindingPromoteForm) {
  return {
    // The finding's own project, never the caller's: a promote cannot place a
    // lesson in another tenant.
    coreOrganizationId: finding.coreOrganizationId,
    coreWorkspaceId: finding.coreWorkspaceId,
    coreProjectId: finding.coreProjectId,
    mistakeType: form.mistakeType,
    title: form.title,
    // motir-ai requires a body and the form has no field for one.
    body: finding.whatHappened,
    why: form.why,
    howToApply: form.howToApply,
  };
}

/**
 * The audit row's metadata. The before/after sides are motir-ai's JSON as it
 * answered them, so they are JSON values; the DTO types them loosely because it
 * must stay importable from a client component (no Prisma type).
 */
function auditMetadata(audit: RawPlannerFindingAudit): Prisma.InputJsonObject {
  const { findingId, before, after } = toPlannerFindingAuditMetadata(audit);
  return {
    findingId,
    before: before as Prisma.InputJsonObject,
    after: after as Prisma.InputJsonObject,
  };
}

export const plannerFindingsTriageService = {
  /** Set whose fault the finding was, with the optional why and planner cells. */
  async setAttribution(
    _principal: PlatformPrincipal,
    findingId: string,
    input: PlannerFindingAttributionInput,
  ): Promise<PlannerFindingTriageOutcome> {
    const actor = await requirePlatformStaff('operator');
    if (!(PLANNER_FINDING_ATTRIBUTION_VALUES as readonly string[]).includes(input.attribution)) {
      throw new PlannerFindingInvalidError('attribution is not a known value', 'attribution');
    }
    const why = trimmed(input.why);
    const hostedCell = trimmed(input.hostedCell);
    const planpyCell = trimmed(input.planpyCell);
    const fixDirection = trimmed(input.fixDirection);
    return plainWrite(actor, findingId, {
      kind: 'attribution',
      attribution: input.attribution as PlannerFindingAttributionValue,
      ...(why ? { why } : {}),
      ...(hostedCell ? { hostedCell } : {}),
      ...(planpyCell ? { planpyCell } : {}),
      ...(fixDirection ? { fixDirection } : {}),
    });
  },

  /** Record the key of the planning bug an admin filed by hand. Files nothing. */
  async recordBugKey(
    _principal: PlatformPrincipal,
    findingId: string,
    bugKey: string,
  ): Promise<PlannerFindingTriageOutcome> {
    const actor = await requirePlatformStaff('operator');
    const key = bugKey.trim().toUpperCase();
    if (!BUG_KEY.test(key)) {
      throw new PlannerFindingInvalidError('bugKey must look like MOTIR-123', 'bugKey');
    }
    return plainWrite(actor, findingId, { kind: 'bug', bugKey: key });
  },

  /** Hide the finding from the default list; the note, when given, is the reason. */
  async dismiss(
    _principal: PlatformPrincipal,
    findingId: string,
    note?: string,
  ): Promise<PlannerFindingTriageOutcome> {
    const actor = await requirePlatformStaff('operator');
    const text = trimmed(note);
    return plainWrite(
      actor,
      findingId,
      { kind: 'dismiss', ...(text ? { note: text } : {}) },
      text ?? DEFAULT_REASON.dismiss,
    );
  },

  /** Bring a dismissed finding back as new. */
  async restore(
    _principal: PlatformPrincipal,
    findingId: string,
  ): Promise<PlannerFindingTriageOutcome> {
    const actor = await requirePlatformStaff('operator');
    return plainWrite(actor, findingId, { kind: 'restore' });
  },

  /**
   * Create a tenant lesson in the finding's own project from the form, then
   * link it to the finding.
   *
   * @throws PlannerFindingNotFoundError when motir-ai has no such finding.
   * @throws PlannerFindingUnchangedError when the finding is already a lesson.
   * @throws PlannerFindingLessonNotLinkedError when the lesson was created but not linked.
   * @throws MotirAiConflictError when motir-ai refuses the lesson as a near-duplicate.
   * @throws MotirAiError from `createLesson` otherwise unchanged — nothing was written then.
   */
  async promoteToLesson(
    _principal: PlatformPrincipal,
    findingId: string,
    form: PlannerFindingPromoteForm,
  ): Promise<PlannerFindingTriageOutcome> {
    const actor = await requirePlatformStaff('operator');
    const clean: PlannerFindingPromoteForm = {
      mistakeType: required(form.mistakeType, 'mistakeType'),
      title: required(form.title, 'title'),
      why: required(form.why, 'why'),
      howToApply: required(form.howToApply, 'howToApply'),
    };

    const finding = await getPlannerFinding(findingId);
    if (finding.status === 'promoted_to_lesson' && finding.lessonId) {
      throw new PlannerFindingUnchangedError(findingId);
    }

    // Outside the audited transaction: the lesson is motir-ai's own write.
    const lesson = await createLesson(lessonRequest(finding, clean)).catch((err: unknown) => {
      // motir-ai's near-duplicate refusal is a 409 `conflict`, which the shared
      // problem mapping reads as a bad request. It is a STATE refusal naming the
      // existing lesson, so it travels as the conflict the controls show as such.
      if (err instanceof MotirAiBadRequestError && err.httpStatus === 409) {
        throw new MotirAiConflictError(err.detail);
      }
      throw err;
    });

    try {
      return await plainWrite(actor, findingId, { kind: 'promote', lessonId: lesson.id });
    } catch (err) {
      console.error(
        '[planner-findings] lesson created but not linked to its finding: %s',
        JSON.stringify({ findingId, lessonId: lesson.id, actor: actor.userId }),
        err,
      );
      throw new PlannerFindingLessonNotLinkedError(findingId, lesson.id, { cause: err });
    }
  },
};
