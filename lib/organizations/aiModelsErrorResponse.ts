import { NextResponse } from 'next/server';
import {
  isMotirAiUnreadable,
  OrgModelChoiceNotQualifiedError,
  PlannerModelNotOfferedError,
  PlannerModelUnreachableError,
} from '@/lib/ai/errors';
import { HostedModelNotOfferedError, HostedModelsUnavailableError } from '@/lib/hostedRuns/errors';
import { mapOrgError } from '@/lib/organizations/errorResponse';

// Typed-error → HTTP mapper for the org AI models routes (MOTIR-10845, and the
// run-side route MOTIR-10850): the org family's own mapping first (404 non-member,
// 403 member, 409 closing), then the model refusals, which answer the SAME codes on
// both sides — the planning side's from motir-ai, the run side's from the run-model
// offer. Null for anything else, so the route rethrows a real 500.
export function mapOrgAiModelsError(err: unknown): NextResponse | null {
  const org = mapOrgError(err);
  if (org) return org;
  if (err instanceof OrgModelChoiceNotQualifiedError) {
    return NextResponse.json(
      { code: err.code, error: 'This organisation’s plan does not include its own model choices.' },
      { status: 403 },
    );
  }
  if (err instanceof PlannerModelNotOfferedError || err instanceof HostedModelNotOfferedError) {
    return NextResponse.json(
      { code: 'MODEL_NOT_OFFERED', model: err.model, error: err.message },
      { status: 422 },
    );
  }
  if (err instanceof PlannerModelUnreachableError) {
    return NextResponse.json(
      { code: 'MODEL_UNREACHABLE', model: err.model, reason: err.reason, error: err.message },
      { status: 422 },
    );
  }
  if (isMotirAiUnreadable(err) || err instanceof HostedModelsUnavailableError) {
    return NextResponse.json(
      { code: 'MODELS_UNREADABLE', error: 'The AI models could not be read right now.' },
      { status: 503 },
    );
  }
  return null;
}
