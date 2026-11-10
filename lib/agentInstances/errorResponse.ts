import { orgFeatureDisabledResponse } from '@/lib/featureFlags/errorResponse';
import { NextResponse } from 'next/server';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { DispatchRunAgentBusyError } from '@/lib/dispatchRuns/errors';
import {
  AgentInstanceNameInvalidError,
  AgentInstanceNameTakenError,
  AgentInstanceLaneMissingError,
  AgentInstanceNoTerminalServerError,
  AgentInstanceNotFoundError,
  AgentInstanceNotRunningError,
  AgentInstanceStartRefusedError,
  AgentInstanceStateConflictError,
  AgentInstancesUnavailableError,
  AgentProfileNotOfferedError,
  AgentTerminalNotOwnerError,
  AgentInstanceImageTooOldError,
  AgentInstanceWrongProjectError,
  AgentNotSignedInError,
  AgentProfileCannotRunError,
  AgentRunCardNotReadyError,
  AgentInstanceRunActiveError,
  AgentInstanceUpToDateError,
  AgentImageCatalogUnavailableError,
  AgentRunAlreadyEndedError,
  AgentRunCommandInvalidError,
  AgentRunCommandMismatchError,
  AgentRunRepairRefusedError,
  AgentRunCancelForbiddenError,
  AgentRunNotFoundError,
} from './errors';

// The agent-instance routes' ONE error mapper (Story MOTIR-6860 · MOTIR-6872).
// Every refusal the lifecycle service raises is a typed error carrying the words
// the Instances page shows, and each becomes a status here — never a 500.
//
// ⚠️ THE ACCESS ARMS COME FIRST, for `lib/monitors/errorResponse.ts`'s reason:
// every operation reaches `projectAccessService.assertPermission('instance:use')`,
// and a mapper that does not know `PermissionDeniedError` turns the refusal into
// a 500 (`tests/permissions/storyGate.test.ts` guard 3 refuses exactly that).

export function mapAgentInstanceError(err: unknown): NextResponse | null {
  // The `hosted_runs` kill-switch (MOTIR-750), or a suspended org.
  const switchedOff = orgFeatureDisabledResponse(err);
  if (switchedOff) return switchedOff;
  if (err instanceof ProjectNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, permission: err.permission },
      { status: 403 },
    );
  }
  if (err instanceof ProjectAccessDeniedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof AgentTerminalNotOwnerError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof AgentRunCancelForbiddenError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof AgentInstanceNotFoundError || err instanceof AgentRunNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof AgentInstanceNameInvalidError || err instanceof AgentProfileNotOfferedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  if (
    err instanceof AgentInstanceNameTakenError ||
    err instanceof AgentInstanceStateConflictError ||
    err instanceof AgentInstanceNotRunningError ||
    err instanceof AgentInstanceNoTerminalServerError ||
    // A row on a host this deployment no longer runs (MOTIR-10809): the agent's
    // state, not the deployment's, so a 409 and never the lane-wide 503.
    err instanceof AgentInstanceLaneMissingError ||
    // The start's own refusals (MOTIR-7026, `agent-instance-run.md` §4) — each a
    // 409 carrying its words, raised before anything was opened or woken.
    err instanceof AgentInstanceWrongProjectError ||
    err instanceof AgentInstanceImageTooOldError ||
    err instanceof AgentProfileCannotRunError ||
    err instanceof AgentNotSignedInError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof DispatchRunAgentBusyError) {
    // One running run per agent (MOTIR-7023, `agent-instance-run.md` §5) — the
    // refusal names the run holding the agent so the page can link it.
    return NextResponse.json(
      { code: err.code, error: err.message, runId: err.runId, workItemKey: err.workItemKey },
      { status: 409 },
    );
  }
  if (err instanceof AgentInstanceRunActiveError) {
    // Hibernate / Delete under a live run (MOTIR-7027, §6) — refused, naming the
    // run the way the start's busy refusal does, so the page links it the same way.
    return NextResponse.json(
      { code: err.code, error: err.message, runId: err.runId, workItemKey: err.workItemKey },
      { status: 409 },
    );
  }
  if (err instanceof AgentRunCommandInvalidError) {
    return NextResponse.json({ code: 'BAD_REQUEST', error: err.message }, { status: 400 });
  }
  if (err instanceof AgentRunCommandMismatchError) {
    // An idempotency key reused for another command (MOTIR-9045) — names the run.
    return NextResponse.json(
      {
        code: err.code,
        error: err.message,
        runId: err.runId,
        command: err.startedCommand,
      },
      { status: 409 },
    );
  }
  if (err instanceof AgentRunAlreadyEndedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, status: err.status },
      { status: 409 },
    );
  }
  if (err instanceof AgentRunRepairRefusedError) {
    // A fix press the repair claim did not open a run for (MOTIR-9049): the claim's own
    // answer — `taken` with its holder and start, or the predicate's reason.
    return NextResponse.json(
      { code: err.code, error: err.message, claim: err.claim },
      { status: 409 },
    );
  }
  if (err instanceof AgentRunCardNotReadyError) {
    return NextResponse.json(
      { code: err.code, error: err.message, detail: err.detail },
      { status: 409 },
    );
  }
  if (err instanceof AgentInstanceStartRefusedError) {
    // 402 for money (no paid AI plan, or no credits — as Motir Studio's establish
    // answers `ai_plan_required`), 503 for an answer that could not be read, 429
    // for a cap: a client can tell "pay" from "try again" from "wait or free one"
    // by status alone, and `reason` names the exact rule.
    const status =
      err.reason === 'credits' || err.reason === 'ai_plan_required'
        ? 402
        : err.reason === 'credits_unknown' ||
            err.reason === 'ai_plan_unknown' ||
            err.reason === 'plan_unknown'
          ? 503
          : 429;
    return NextResponse.json(
      {
        code: err.code,
        error: err.message,
        reason: err.reason,
        ...(err.limit !== undefined ? { limit: err.limit } : {}),
        ...(err.planName !== undefined ? { planName: err.planName } : {}),
      },
      { status },
    );
  }
  if (err instanceof AgentInstanceUpToDateError) {
    // Update on an agent already on the newest image (`agent-image-update.md` Q8).
    return NextResponse.json(
      { code: err.code, error: err.message, version: err.version },
      { status: 409 },
    );
  }
  if (err instanceof AgentImageCatalogUnavailableError) {
    // The registry could not be asked: a wait, never "up to date" (Q8).
    return NextResponse.json({ code: err.code, error: err.message }, { status: 503 });
  }
  if (err instanceof AgentInstancesUnavailableError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 503 });
  }
  return null;
}
