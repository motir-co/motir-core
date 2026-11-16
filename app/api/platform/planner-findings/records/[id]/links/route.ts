import { plannerFindingRecordLinkBodySchema } from '@/lib/plannerFindings/schemas';
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

// Link one work-item key to a planner finding record (Story MOTIR-11455 ·
// MOTIR-11504): a planning bug the record's check produced, resolved in the
// record's own project, with one `planner_finding.link` audit row. Transport
// only; ADR §2, the 2026-11-16 amendment, and §7.

/** Link a key to an attributed record; answers `{ record, changed }`. Operator. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePlatformStaffForPlannerFindings(req, PLANNER_FINDING_RECORDS_LEVEL);
    const { id } = await params;
    const body = await parsePlannerFindingsBody(req, plannerFindingRecordLinkBodySchema);
    return plannerFindingsJson(await plannerFindingRecordsService.linkKey(actor, id, body));
  } catch (err) {
    return plannerFindingsErrorResponse(err);
  }
}
