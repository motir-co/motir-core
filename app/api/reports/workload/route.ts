import { NextResponse } from 'next/server';
import { reportsService } from '@/lib/services/reportsService';
import { parseDaysBack, parseMeasure, parseReportScope } from '@/lib/reports/params';
import { reportConfigErrorResponse } from '@/lib/reports/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/reports/workload (Story 8.8 · Subtask 8.8.13) — open work per
// assignee behind the report page (8.8.7) and the `workload` dashboard widget.
// Scope = `?projectId=` XOR `?savedFilterId=`; config = `?measure=story_points
// |issue_count`, plus an optional window `?daysBack=` (absent → the open-now
// snapshot the gadget reads). Workload has no time buckets, so `?period=` is
// NOT parsed (MOTIR-10346): an old link that still carries one is tolerated —
// any value, never a 422 — and, as before, it alone still asks for the window.
// Returns the `ReportWidgetResultDto` envelope. Thin HTTP transport per CLAUDE.md.
export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { searchParams } = new URL(req.url);
  try {
    const scope = parseReportScope(searchParams);
    const measure = parseMeasure(searchParams.get('measure'));
    const windowed = searchParams.has('daysBack') || searchParams.has('period');
    const config = windowed
      ? { measure, window: { daysBack: parseDaysBack(searchParams.get('daysBack')) } }
      : { measure };
    const result = await reportsService.getWorkload(scope, config, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return reportConfigErrorResponse(err);
  }
}
