import { plannerFindingBugKeyBodySchema } from '@/lib/plannerFindings/schemas';
import {
  parsePlannerFindingsBody,
  plannerFindingsErrorResponse,
  plannerFindingsJson,
} from '@/lib/plannerFindings/routeErrors';
import { requirePlatformStaffForPlannerFindings } from '@/lib/platform/plannerFindingsGate';
import {
  PLANNER_FINDING_RECORDS_LEVEL,
  plannerFindingRecordsService,
} from '@/lib/services/plannerFindingsService';

// CLEAR one planner finding's planning-bug key (Story MOTIR-11455 · MOTIR-11590):
// `{ key }` names the key the caller saw, so a stale tab cannot clear a newer one.
// Resolves nothing, so a key whose work item is gone can still be removed.
// Transport only: gate FIRST, parse, one service call, map errors.

type Ctx = { params: Promise<{ findingId: string }> };

/** Clear the finding's key; answers `{ record, finding }`. Operator. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const actor = await requirePlatformStaffForPlannerFindings(req, PLANNER_FINDING_RECORDS_LEVEL);
    const { findingId } = await params;
    const body = await parsePlannerFindingsBody(req, plannerFindingBugKeyBodySchema);
    return plannerFindingsJson(
      await plannerFindingRecordsService.clearFindingBugKey(actor, findingId, body),
    );
  } catch (err) {
    return plannerFindingsErrorResponse(err);
  }
}
