import { NextResponse } from 'next/server';
import { OrchestratorNotConfiguredError } from '@motir/orchestrator';
import { CiCreditsExhaustedError } from '@/lib/ciMetering/errors';
import { orgFeatureDisabledResponse } from '@/lib/featureFlags/errorResponse';
import {
  HostedModelNotOfferedError,
  HostedModelsUnavailableError,
  HostedNoModelOfferedError,
  HostedRunBootFailedError,
  HostedRunCardNotReadyError,
  HostedRunCreditsUnavailableError,
  HostedRunKeyNotMintedError,
  HostedRunNoCapacityError,
  HostedRunOutOfCreditsError,
  HostedRunRepositoryNotReadableError,
  HostedRunRepositoryNotWritableError,
  RunGitCredentialUnavailableError,
} from '@/lib/hostedRuns/errors';

// THE HOSTED START'S PRE-FLIGHT REFUSALS, as a session route answers them (Story MOTIR-683 ·
// MOTIR-690, shared by Story MOTIR-11941 · MOTIR-11944). Run hosted
// (`POST /api/work-items/[id]/hosted-runs`) and *Review with Motir agent*
// (`POST /api/work-items/[id]/review-with-motir-agent`) start through the same pre-flight —
// the lane switch, the model, the credits, the repositories, the fleet — so a person is told
// the same thing, by the same code and status, whichever button they pressed. Each route
// keeps its own refusals (a continue's claim, a review's authority) beside this map.

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/** The `{ code, error, …extra }` body every hosted start route answers a refusal with. */
export function hostedProblem(
  code: string,
  error: string,
  status: number,
  extra: object = {},
): Response {
  return NextResponse.json({ code, error, ...extra }, { status, headers: NO_STORE });
}

/** The response for a hosted start's pre-flight refusal, or null when `err` is not one. */
export function hostedStartRefusalResponse(err: unknown): Response | null {
  const switchedOff = orgFeatureDisabledResponse(err);
  if (switchedOff) return switchedOff;
  if (err instanceof HostedModelNotOfferedError) return hostedProblem(err.code, err.message, 422);
  if (err instanceof HostedNoModelOfferedError) return hostedProblem(err.code, err.message, 503);
  if (err instanceof HostedModelsUnavailableError) {
    return hostedProblem(err.code, err.message, 503);
  }
  if (err instanceof HostedRunNoCapacityError) {
    return hostedProblem(err.code, err.message, 409, { model: err.model, reason: err.reason });
  }
  if (err instanceof HostedRunOutOfCreditsError) {
    return hostedProblem(err.code, err.message, 402, { balanceCredits: err.balanceCredits });
  }
  if (err instanceof CiCreditsExhaustedError) return hostedProblem(err.code, err.message, 402);
  if (err instanceof HostedRunCreditsUnavailableError) {
    return hostedProblem(err.code, err.message, 503);
  }
  if (err instanceof HostedRunRepositoryNotWritableError) {
    return hostedProblem(err.code, err.message, 409, {
      repositories: err.refusals,
      totalRepositories: err.totalRepositories,
    });
  }
  if (err instanceof HostedRunRepositoryNotReadableError) {
    return hostedProblem(err.code, err.message, 409, { repositories: err.refusals });
  }
  if (err instanceof HostedRunCardNotReadyError) return hostedProblem(err.code, err.message, 409);
  if (err instanceof HostedRunBootFailedError) {
    return hostedProblem(err.code, err.message, 503, { dispatchRunId: err.dispatchRunId });
  }
  if (
    err instanceof RunGitCredentialUnavailableError ||
    err instanceof HostedRunKeyNotMintedError ||
    err instanceof OrchestratorNotConfiguredError
  ) {
    return hostedProblem(
      'hosted_run_unavailable',
      'Motir agent runs are not available right now. Try again shortly.',
      503,
    );
  }
  return null;
}
