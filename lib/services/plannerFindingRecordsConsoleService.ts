import {
  PLANNER_FINDING_PLANNER_VALUES,
  PLANNER_FINDING_SOURCE_VALUES,
  PLANNER_FINDING_VERDICT_STATE_VALUES,
  type PlannerFindingRecordDetailDTO,
  type PlannerFindingRecordListDTO,
  type PlannerFindingRecordListFilters,
} from '@/lib/dto/plannerFindings';
import {
  toPlannerFindingRecordDetailDTO,
  toPlannerFindingRecordListDTO,
} from '@/lib/mappers/plannerFindingMappers';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import type { PlannerFindingActor } from '@/lib/plannerFindings/types';
import type { PlannerFindingRecordQuery } from '@/lib/plannerFindings/schemas';
import { userRepository } from '@/lib/repositories/userRepository';
import { plannerFindingRecordsService } from '@/lib/services/plannerFindingsService';

// The console's RECORDS read seam (Story MOTIR-11455 · MOTIR-11463): what the
// Records view of `/admin/planner-findings` and the record page at
// `/admin/planner-findings/records/[id]` read through. Page → this service →
// `plannerFindingRecordsService` (the platform door, which re-asserts its read
// level and audits the read) → the motir-ai client.
//
// It does three things and nothing else:
//  - composes the actor the platform service expects from the page's principal
//    and the console SESSION credential (a browser request carries no token);
//  - maps the URL's record filters to the platform query, dropping a value
//    outside its closed set rather than sending it;
//  - maps motir-ai's record shapes to the console DTOs.
//
// ⚠️ IT READS ONLY, and it translates nothing: the platform refusal
// (`NotPlatformStaffError`), the record-not-found error and every motir-ai error
// propagate untouched, so each page decides 404 versus unavailable itself.

/** One record in full, with the display name of whoever gave its verdict. */
export interface PlannerFindingRecordView {
  detail: PlannerFindingRecordDetailDTO;
  /** Null when the record has no verdict, or its giver is no longer a user. */
  verdictByName: string | null;
}

function sessionActor(principal: PlatformPrincipal): PlannerFindingActor {
  return { ...principal, credential: { kind: 'session' } };
}

function member<T extends string>(set: readonly T[], value: string | undefined): T | undefined {
  return value !== undefined && (set as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * The URL's record filters → the platform record query. Only the three record
 * keys and the cursor are read, so a finding filter the view switch carried over
 * can neither narrow the record read nor make it refuse.
 */
export function toRecordQuery(filters: PlannerFindingRecordListFilters): PlannerFindingRecordQuery {
  const verdictState = member(PLANNER_FINDING_VERDICT_STATE_VALUES, filters.verdict);
  const planner = member(PLANNER_FINDING_PLANNER_VALUES, filters.planner);
  const source = member(PLANNER_FINDING_SOURCE_VALUES, filters.source);
  const cursor = filters.cursor?.trim() ? filters.cursor.trim() : undefined;
  return {
    ...(verdictState ? { verdictState } : {}),
    ...(planner ? { planner } : {}),
    ...(source ? { source } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export const plannerFindingRecordsConsoleService = {
  /**
   * One page of records, newest first.
   *
   * @throws NotPlatformStaffError below the record read's level (the page 404s).
   * @throws MotirAiError when motir-ai cannot answer — never an empty page.
   */
  async list(
    principal: PlatformPrincipal,
    filters: PlannerFindingRecordListFilters,
  ): Promise<PlannerFindingRecordListDTO> {
    return toPlannerFindingRecordListDTO(
      await plannerFindingRecordsService.listRecords(
        sessionActor(principal),
        toRecordQuery(filters),
      ),
    );
  },

  /**
   * One record with every finding — the record page's ONE record read — and the
   * name of whoever gave its verdict (a user lookup in core, as the finding
   * detail names whoever triaged it; the record is never read twice).
   *
   * @throws NotPlatformStaffError below the record read's level (the page 404s).
   * @throws PlannerFindingRecordNotFoundError for an id the store does not hold (the page 404s).
   * @throws MotirAiError when motir-ai cannot answer (the unavailable state).
   */
  async get(principal: PlatformPrincipal, recordId: string): Promise<PlannerFindingRecordView> {
    const detail = toPlannerFindingRecordDetailDTO(
      await plannerFindingRecordsService.getRecord(sessionActor(principal), recordId),
    );
    const by = detail.record.verdictBy;
    const users = by ? await userRepository.findByIds([by]) : [];
    return { detail, verdictByName: users.find((u) => u.id === by)?.name ?? null };
  },
};
