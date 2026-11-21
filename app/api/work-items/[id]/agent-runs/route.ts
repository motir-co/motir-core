import { NextResponse } from 'next/server';
import { isAgentRunCommand, type AgentRunCommand } from '@/lib/agentInstances/runCommand';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { CiCreditsExhaustedError } from '@/lib/ciMetering/errors';
import { HostedRunRepositoryNotWritableError } from '@/lib/hostedRuns/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { agentInstanceRunService } from '@/lib/services/agentInstanceRunService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// POST /api/work-items/[id]/agent-runs (Story MOTIR-6864 · MOTIR-7026,
// `docs/decisions/agent-instance-run.md` §4) — START a card's run in one of the
// caller's own agents: `{ agentInstanceId, idempotencyKey?, command? }` →
// `201 { dispatchRunId, created, woke }` (200 for a repeated key).
//
// Thin HTTP layer (CLAUDE.md 4-layer): the compliant-session gate, the body, ONE
// service call, and the error → status map. Every refusal is answered with
// nothing opened, claimed or minted; every one before the wake also starts no
// machine, and the wake's own refusals pass through with their statuses
// (`mapAgentInstanceError`: 402 credits, 503 credits unknown, 429 fleet busy).
//
// ⚠️ THE SEGMENT IS `[id]`, THE VALUE IS A KEY — the sibling routes' constraint.

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

function problem(code: string, error: string, status: number, extra: object = {}): Response {
  return NextResponse.json({ code, error, ...extra }, { status, headers: NO_STORE });
}

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
    command?: unknown;
  } | null;
  const agentInstanceId =
    typeof body?.agentInstanceId === 'string' ? body.agentInstanceId.trim() : '';
  if (!agentInstanceId) {
    return problem('BAD_REQUEST', '`agentInstanceId` must name one of your agents.', 400);
  }
  const idempotencyKey =
    typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : undefined;
  // MOTIR-9045: what the run is for — `run` (the default), `fix` or `continue`. A
  // `review` (MOTIR-11945) is refused by the service here: only the review door names
  // what it reviews.
  if (body?.command !== undefined && !isAgentRunCommand(body.command)) {
    return problem('BAD_REQUEST', '`command` must be one of run, fix, continue or review.', 400);
  }
  const command = body?.command as AgentRunCommand | undefined;

  try {
    const started = await agentInstanceRunService.start(
      { workItemKey: key, agentInstanceId, idempotencyKey, command },
      gate.ctx,
    );
    return NextResponse.json(started, {
      status: started.created ? 201 : 200,
      headers: NO_STORE,
    });
  } catch (err) {
    // A browse denial is indistinguishable from a missing card (no existence leak).
    if (err instanceof ProjectAccessDeniedError && err.kind === 'browse') {
      return problem('WORK_ITEM_NOT_FOUND', 'Not found.', 404);
    }
    if (err instanceof WorkItemNotFoundError) return problem(err.code, err.message, 404);
    if (err instanceof HostedRunRepositoryNotWritableError) {
      return problem(err.code, err.message, 409, {
        repositories: err.refusals,
        totalRepositories: err.totalRepositories,
      });
    }
    if (err instanceof CiCreditsExhaustedError) return problem(err.code, err.message, 402);
    const mapped = mapAgentInstanceError(err);
    if (mapped) return mapped;
    throw err;
  }
}
