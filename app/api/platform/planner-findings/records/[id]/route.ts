import {
  plannerFindingsErrorResponse,
  plannerFindingsJson,
} from '@/lib/plannerFindings/routeErrors';
import { requirePlatformStaffForPlannerFindings } from '@/lib/platform/plannerFindingsGate';
import {
  PLANNER_FINDING_RECORDS_READ_LEVEL,
  plannerFindingRecordsService,
} from '@/lib/services/plannerFindingsService';

// One planner finding record with every finding (Story MOTIR-11455 · MOTIR-11458).
// Transport only; ADR §2, the 2026-11-16 amendment.

type Ctx = { params: Promise<{ id: string }> };

/** One record. Support and above. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const actor = await requirePlatformStaffForPlannerFindings(
      req,
      PLANNER_FINDING_RECORDS_READ_LEVEL,
    );
    const { id } = await params;
    return plannerFindingsJson(await plannerFindingRecordsService.getRecord(actor, id));
  } catch (err) {
    return plannerFindingsErrorResponse(err);
  }
}
