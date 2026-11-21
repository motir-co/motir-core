import { NextResponse } from 'next/server';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { hostedStartRefusalResponse } from '@/lib/hostedRuns/startRefusalResponse';
import { reviewInMyAgentService } from '@/lib/services/reviewInMyAgentService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// /api/work-items/[id]/review-in-my-agent (Story MOTIR-11941 · MOTIR-11945;
// `approval-gates.md` §12.18) — *Review in my agent*, the Fix in my agent door's shape.
//
//   GET  — the door's state: `200 ReviewInMyAgentDoorDto`. Not offered is an ANSWER
//          (`offered: false` + a reason), never an error status.
//   POST — `{ agentInstanceId, idempotencyKey? }` starts ONE review run in that agent:
//          `201 { dispatchRunId, created, woke }`, 200 for a repeated key. A press the read
//          would not offer answers 409 `review_in_my_agent_not_offered` with the reason;
//          the agent's own refusals answer as the agent-runs route answers them.
//
// Both: a caller who may not browse the item gets 404 (no existence leak). The segment is
// `[id]` and its value is the item KEY. SESSION-AUTHED. Thin HTTP layer: session gate →
// ONE service call → map errors.

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

function problem(code: string, error: string, status: number): Response {
  return NextResponse.json({ code, error }, { status, headers: NO_STORE });
}

/** The answer for a refusal both methods share, or null. */
function refusalResponse(err: unknown): Response | null {
  // The service answers a caller who may not browse the item with the item's not-found.
  if (err instanceof WorkItemNotFoundError) {
    return problem('WORK_ITEM_NOT_FOUND', 'Not found.', 404);
  }
  return mapAgentInstanceError(err) ?? hostedStartRefusalResponse(err);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { id: key } = await params;
  try {
    const door = await reviewInMyAgentService.readDoor(key, gate.ctx);
    return NextResponse.json(door, { headers: NO_STORE });
  } catch (err) {
    const refused = refusalResponse(err);
    if (refused) return refused;
    /* v8 ignore next -- an unexpected fault reaches the framework's 500 */
    throw err;
  }
}

/** The longest request key a press may carry — it is part of the run's idempotency key. */
const MAX_IDEMPOTENCY_KEY = 200;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { id: key } = await params;

  const body = (await req.json().catch(() => null)) as {
    agentInstanceId?: unknown;
    idempotencyKey?: unknown;
  } | null;
  const agentInstanceId =
    typeof body?.agentInstanceId === 'string' ? body.agentInstanceId.trim() : '';
  if (!agentInstanceId) {
    return problem('BAD_REQUEST', '`agentInstanceId` must name one of your agents.', 400);
  }
  if (
    body?.idempotencyKey !== undefined &&
    body.idempotencyKey !== null &&
    (typeof body.idempotencyKey !== 'string' ||
      body.idempotencyKey.trim().length > MAX_IDEMPOTENCY_KEY)
  ) {
    return problem(
      'BAD_REQUEST',
      `\`idempotencyKey\` must be a string of at most ${MAX_IDEMPOTENCY_KEY} characters.`,
      400,
    );
  }
  const idempotencyKey =
    typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : undefined;

  try {
    const started = await reviewInMyAgentService.start(
      key,
      { agentInstanceId, idempotencyKey },
      gate.ctx,
    );
    return NextResponse.json(started, {
      status: started.created ? 201 : 200,
      headers: NO_STORE,
    });
  } catch (err) {
    const refused = refusalResponse(err);
    if (refused) return refused;
    /* v8 ignore next -- an unexpected fault reaches the framework's 500 */
    throw err;
  }
}
