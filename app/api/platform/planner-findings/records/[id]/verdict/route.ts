import { plannerFindingRecordVerdictBodySchema } from '@/lib/plannerFindings/schemas';
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

// A planner finding record's VERDICT (Story MOTIR-11455 · MOTIR-11458): every
// finding of the record attributed in one motir-ai transaction, by the staff
// member the gate names, with one `planner_finding.verdict` audit row per finding
// it changed. Transport only; ADR §2, the 2026-11-16 amendment.

type Ctx = { params: Promise<{ id: string }> };

/** Give the record its verdict; `replace: true` overwrites an earlier one. Operator. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const actor = await requirePlatformStaffForPlannerFindings(req, PLANNER_FINDING_RECORDS_LEVEL);
    const { id } = await params;
    const body = await parsePlannerFindingsBody(req, plannerFindingRecordVerdictBodySchema);
    return plannerFindingsJson(await plannerFindingRecordsService.submitVerdict(actor, id, body));
  } catch (err) {
    return plannerFindingsErrorResponse(err);
  }
}
