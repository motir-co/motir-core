import type {
  PlannerFindingTriagePatch,
  RawPlannerFinding,
  RawPlannerFindingAudit,
  RawPlannerFindingGroup,
  RawPlannerFindingGroupPage,
  RawPlannerFindingPage,
  RawPlannerFindingRetention,
} from '@/lib/ai/motirAiClient';
import type {
  PlannerFindingAuditMetadata,
  PlannerFindingCostDTO,
  PlannerFindingDetailDTO,
  PlannerFindingGroupListDTO,
  PlannerFindingGroupRowDTO,
  PlannerFindingListDTO,
  PlannerFindingRetentionDTO,
  PlannerFindingRowDTO,
  PlannerFindingTriageInput,
} from '@/lib/dto/plannerFindings';

// Pure maps from motir-ai's raw finding shapes to the console's DTOs (Story
// MOTIR-10353 · MOTIR-10517). The wire strings pass through as they came; the
// one translation is a NULL attribution, which reads `unattributed`.

export function toPlannerFindingRowDTO(raw: RawPlannerFinding): PlannerFindingRowDTO {
  return {
    id: raw.id,
    source: raw.source,
    planner: raw.planner,
    attribution: raw.attribution ?? 'unattributed',
    outcome: raw.outcome,
    prediction: raw.prediction,
    site: raw.site,
    planId: raw.planId,
    planTitle: raw.planTitle,
    status: raw.status,
    fingerprint: raw.fingerprint,
    lessonId: raw.lessonId,
    bugKey: raw.bugKey,
    createdAt: raw.createdAt,
  };
}

/** `cost` is the read service's decision, passed through exactly — null stays null. */
export function toPlannerFindingDetailDTO(
  raw: RawPlannerFinding,
  cost: PlannerFindingCostDTO | null,
): PlannerFindingDetailDTO {
  return {
    ...toPlannerFindingRowDTO(raw),
    whatHappened: raw.whatHappened,
    evidence: raw.evidence,
    correction: raw.correction,
    rule: raw.rule,
    why: raw.why,
    hostedCell: raw.hostedCell,
    planpyCell: raw.planpyCell,
    fixDirection: raw.fixDirection,
    cardRef: raw.cardRef,
    coreProjectId: raw.coreProjectId,
    authorModel: raw.authorModel,
    baselineBranch: raw.baselineBranch,
    baselineCommit: raw.baselineCommit,
    triageNote: raw.triageNote,
    triagedBy: raw.triagedBy,
    triagedAt: raw.triagedAt,
    cost,
  };
}

export function toPlannerFindingGroupRowDTO(
  raw: RawPlannerFindingGroup,
): PlannerFindingGroupRowDTO {
  return {
    fingerprint: raw.fingerprint,
    findingCount: raw.count,
    planCount: new Set(raw.planIds).size,
    latest: toPlannerFindingRowDTO(raw.latest),
  };
}

function toRetentionDTO(raw: RawPlannerFindingRetention): PlannerFindingRetentionDTO {
  return { days: raw.days, cutoff: raw.cutoff };
}

export function toPlannerFindingListDTO(raw: RawPlannerFindingPage): PlannerFindingListDTO {
  return {
    findings: raw.findings.map(toPlannerFindingRowDTO),
    nextCursor: raw.nextCursor,
    retention: toRetentionDTO(raw.retention),
  };
}

export function toPlannerFindingGroupListDTO(
  raw: RawPlannerFindingGroupPage,
): PlannerFindingGroupListDTO {
  return {
    groups: raw.groups.map(toPlannerFindingGroupRowDTO),
    nextCursor: raw.nextCursor,
    retention: toRetentionDTO(raw.retention),
  };
}

/** Copies only the text fields that carry a value — an absent optional is omitted, never `''`. */
function presentText<K extends string>(
  fields: Partial<Record<K, string | undefined>>,
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const [key, value] of Object.entries(fields) as [K, string | undefined][]) {
    if (value !== undefined && value.trim() !== '') out[key] = value;
  }
  return out;
}

/**
 * The PATCH body for one triage act. A status carries exactly the id it owns
 * (motir-ai pairs `lessonId` with `promoted_to_lesson`, `bugKey` with
 * `filed_as_bug`, `note` with `dismissed`) and nothing else, so the triage
 * service cannot build a patch motir-ai would refuse from this input.
 */
export function toPlannerFindingTriagePatch(
  input: PlannerFindingTriageInput,
): PlannerFindingTriagePatch {
  switch (input.kind) {
    case 'attribution':
      return {
        attribution: input.attribution,
        ...presentText({
          why: input.why,
          hostedCell: input.hostedCell,
          planpyCell: input.planpyCell,
          fixDirection: input.fixDirection,
        }),
      };
    case 'promote':
      return { status: 'promoted_to_lesson', lessonId: input.lessonId };
    case 'bug':
      return { status: 'filed_as_bug', bugKey: input.bugKey };
    case 'dismiss':
      return { status: 'dismissed', ...presentText({ note: input.note }) };
    case 'restore':
      return { status: 'new' };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The audit row's metadata, from the record motir-ai answered. */
export function toPlannerFindingAuditMetadata(
  audit: RawPlannerFindingAudit,
): PlannerFindingAuditMetadata {
  return {
    findingId: audit.findingId,
    before: asRecord(audit.before),
    after: asRecord(audit.after),
  };
}
