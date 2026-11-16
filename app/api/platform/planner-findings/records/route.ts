import {
  createPlannerFindingRecordBodySchema,
  plannerFindingRecordQuerySchema,
} from '@/lib/plannerFindings/schemas';
import {
  parsePlannerFindingsBody,
  parsePlannerFindingsQuery,
  plannerFindingsErrorResponse,
  plannerFindingsJson,
} from '@/lib/plannerFindings/routeErrors';
import { requirePlatformStaffForPlannerFindings } from '@/lib/platform/plannerFindingsGate';
import {
  PLANNER_FINDING_RECORDS_LEVEL,
  PLANNER_FINDING_RECORDS_READ_LEVEL,
  plannerFindingRecordsService,
} from '@/lib/services/plannerFindingsService';

// The planner finding RECORDS collection (Story MOTIR-11455 · MOTIR-11458) — the
// door the private `motir check plan` skill stores one plan check through, with
// a staff personal access token or the console session (ADR §2, the 2026-11-16
// amendment). Transport only: gate FIRST, parse, one service call, map errors.

/** One page of records, newest first; motir-ai's filters passed through. Support and above. */
export async function GET(req: Request) {
  try {
    const actor = await requirePlatformStaffForPlannerFindings(
      req,
      PLANNER_FINDING_RECORDS_READ_LEVEL,
    );
    const query = parsePlannerFindingsQuery(req, plannerFindingRecordQuerySchema);
    return plannerFindingsJson(await plannerFindingRecordsService.listRecords(actor, query));
  } catch (err) {
    return plannerFindingsErrorResponse(err);
  }
}

/** Store one plan check as a record with its 1–100 findings, all or none. Operator. */
export async function POST(req: Request) {
  try {
    const actor = await requirePlatformStaffForPlannerFindings(req, PLANNER_FINDING_RECORDS_LEVEL);
    const body = await parsePlannerFindingsBody(req, createPlannerFindingRecordBodySchema);
    return plannerFindingsJson(await plannerFindingRecordsService.createRecord(actor, body), 201);
  } catch (err) {
    return plannerFindingsErrorResponse(err);
  }
}
