import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { HostedContinueRefusedError, HostedFixRefusedError } from '@/lib/hostedRuns/errors';
import { hostedStartRefusalResponse } from '@/lib/hostedRuns/startRefusalResponse';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// POST /api/work-items/[id]/hosted-runs (Story MOTIR-683 · MOTIR-690) — START a
// hosted run on a card: `{ model?, idempotencyKey?, mode? }` → `201 { dispatchRunId }`.
// Without `model` the server runs the card on the model its difficulty resolves
// to (Story MOTIR-6989 · MOTIR-6994); with one, the person's pick wins.
// `mode: 'continue'` (Story MOTIR-6527 · MOTIR-6792) resumes a card whose last run
// died — Continue hosted — and adds the continue claim's refusals, each a 409
// `hosted_continue_*` (`taken` naming its holder). `mode: 'fix'` (Story MOTIR-1626 ·
// MOTIR-6928) repairs a card a review sent back — Fix on the hosted agent — and adds the
// repair claim's refusals, each a 409 `hosted_fix_*` (`taken` naming its holder,
// `not_repairable` the claim's own reason).
// A model with no agent-run capacity right now (Story MOTIR-9541 · MOTIR-9628) is a
// 409 `hosted_run_no_capacity` carrying only `model` and `reason`, on every mode —
// refused in the pre-flight, so nothing was opened and nothing is queued.
// The route MOTIR-691's Run hosted control calls; `hostedRunService.start` is the
// whole behaviour.
//
// Thin HTTP layer (CLAUDE.md 4-layer): the compliant-session gate, the body, ONE
// service call, and the error → status map. Every refusal the service names is
// answered BEFORE anything was opened, minted or booted — except
// `hosted_run_boot_failed`, whose run was opened and already ended as failed, and
// which therefore names it.
//
// ⚠️ THE SEGMENT IS `[id]`, THE VALUE IS A KEY — the sibling routes' constraint:
// Next.js allows one slug name per dynamic position, and `app/api/work-items`
// resolves its child as `[id]` across every route under it.

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
    model?: unknown;
    idempotencyKey?: unknown;
    mode?: unknown;
  } | null;
  if (body === null || typeof body !== 'object') {
    return problem('BAD_REQUEST', 'The body must be a JSON object.', 400);
  }
  // `model` is OPTIONAL (MOTIR-6994): absent or blank, the server resolves it
  // from the card's difficulty. Present, it must be a string — and it wins.
  if (body?.model !== undefined && body.model !== null && typeof body.model !== 'string') {
    return problem('BAD_REQUEST', '`model` must be a model id.', 400);
  }
  const model = typeof body?.model === 'string' ? body.model.trim() : '';
  const mode = body?.mode ?? 'run';
  if (mode !== 'run' && mode !== 'continue' && mode !== 'fix') {
    return problem('BAD_REQUEST', '`mode` must be "run", "continue" or "fix".', 400);
  }
  const idempotencyKey =
    typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : randomUUID();

  try {
    const started = await hostedRunService.start(
      { workItemKey: key, ...(model ? { model } : {}), idempotencyKey, mode },
      gate.ctx,
    );
    return NextResponse.json(
      { dispatchRunId: started.dispatchRunId, created: started.created },
      { status: started.created ? 201 : 200, headers: NO_STORE },
    );
  } catch (err) {
    // The pre-flight refusals every hosted start answers alike — the `hosted_runs`
    // kill-switch (MOTIR-750) and a suspended org among them — shared with *Review with
    // Motir agent* (MOTIR-11944) so both buttons tell a person the same thing.
    const refused = hostedStartRefusalResponse(err);
    if (refused) return refused;
    if (err instanceof HostedContinueRefusedError) {
      return problem(err.code, err.message, 409, {
        ...(err.holder ? { holder: err.holder, startedAt: err.startedAt } : {}),
        ...(err.parentKey ? { parentKey: err.parentKey } : {}),
      });
    }
    if (err instanceof HostedFixRefusedError) {
      return problem(err.code, err.message, 409, {
        ...(err.holder ? { holder: err.holder, startedAt: err.startedAt } : {}),
        ...(err.repairRefusal ? { repairRefusal: err.repairRefusal } : {}),
        ...(err.repairClass ? { repairClass: err.repairClass } : {}),
        ...(err.runTargetKey ? { runTargetKey: err.runTargetKey } : {}),
      });
    }
    if (err instanceof WorkItemNotFoundError || err instanceof ProjectNotFoundError) {
      return problem(err.code, err.message, 404);
    }
    if (err instanceof ProjectAccessDeniedError) {
      // A browse denial is indistinguishable from a missing card (no existence leak).
      return err.kind === 'browse'
        ? problem('WORK_ITEM_NOT_FOUND', 'Not found.', 404)
        : problem(err.code, err.message, 403);
    }
    throw err;
  }
}
