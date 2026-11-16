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

// Unlink one work-item key from a planner finding record (Story MOTIR-11455 ·
// MOTIR-11504), with one `planner_finding.unlink` audit row when the set
// changed. A key the record no longer carries answers it as it stands. Transport
// only; ADR §2, the 2026-11-16 amendment, and §7.

/** Unlink a key; answers `{ record, changed }`, `changed: false` for a no-op. Operator. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePlatformStaffForPlannerFindings(req, PLANNER_FINDING_RECORDS_LEVEL);
    const { id } = await params;
    const body = await parsePlannerFindingsBody(req, plannerFindingRecordLinkBodySchema);
    return plannerFindingsJson(await plannerFindingRecordsService.unlinkKey(actor, id, body));
  } catch (err) {
    return plannerFindingsErrorResponse(err);
  }
}
