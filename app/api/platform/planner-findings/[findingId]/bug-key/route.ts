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

// SET one planner finding's planning-bug key (Story MOTIR-11455 · MOTIR-11590):
// `{ key }`, resolved as a work item in the finding's record's own project, with
// one `planner_finding.triage` audit row per change. Transport only: gate FIRST,
// parse, one service call, map errors (ADR §2, the 2026-11-16 amendment).

type Ctx = { params: Promise<{ findingId: string }> };

/** Set or replace the finding's key; answers `{ record, finding }`. Operator. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const actor = await requirePlatformStaffForPlannerFindings(req, PLANNER_FINDING_RECORDS_LEVEL);
    const { findingId } = await params;
    const body = await parsePlannerFindingsBody(req, plannerFindingBugKeyBodySchema);
    return plannerFindingsJson(
      await plannerFindingRecordsService.setFindingBugKey(actor, findingId, body),
    );
  } catch (err) {
    return plannerFindingsErrorResponse(err);
  }
}
