import {
  plannerFindingsErrorResponse,
  plannerFindingsJson,
} from '@/lib/plannerFindings/routeErrors';
import { requirePlatformStaffForPlannerFindings } from '@/lib/platform/plannerFindingsGate';
import {
  PLANNER_FINDING_RECORDS_LEVEL,
  plannerFindingRecordsService,
} from '@/lib/services/plannerFindingsService';

// One planner finding, with the `recordId` of the record it belongs to (Story
// MOTIR-11455 · MOTIR-11458) — so the `motir check planner finding <id>` skill
// can take a child finding's id and reach its record. Reached with a staff
// personal access token or the console session (`docs/decisions/platform-staff-auth.md`
// §2, the 2026-11-16 amendment). Transport only: gate FIRST, one service call,
// map errors.

type Ctx = { params: Promise<{ findingId: string }> };

/** One finding. Operator. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const actor = await requirePlatformStaffForPlannerFindings(req, PLANNER_FINDING_RECORDS_LEVEL);
    const { findingId } = await params;
    return plannerFindingsJson(await plannerFindingRecordsService.getFinding(actor, findingId));
  } catch (err) {
    return plannerFindingsErrorResponse(err);
  }
}
