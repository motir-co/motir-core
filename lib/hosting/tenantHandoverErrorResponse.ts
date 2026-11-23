import { NextResponse } from 'next/server';
import {
  HandoverEmailCodeRefusedError,
  HandoverNothingToRetryError,
  HandoverStepNotWaitingError,
  TenantAccountNotReadyError,
  TenantHandoverAlreadyStartedError,
  TenantHandoverInputError,
  TenantHandoverNotAdminError,
  TenantHandoverNotFoundError,
} from '@/lib/hosting/tenantHandoverErrors';
import { GithubIdentityRequiredError } from '@/lib/projectRepos/errors';

/**
 * The takeover handover routes' typed-error → HTTP mapping (Story MOTIR-9800 ·
 * MOTIR-12131), kept in ONE place so the four routes cannot drift. Returns null
 * for an error the route should rethrow — an unmapped error is a 500.
 *
 *   TenantHandoverNotFoundError → 404 (no such account, another organisation's,
 *     or an organisation the caller is not in — indistinguishable on purpose)
 *   TenantHandoverNotAdminError → 403 (a member who is not an admin)
 *   TenantHandoverInputError → 400
 *   GithubIdentityRequiredError, TenantAccountNotReadyError,
 *     TenantHandoverAlreadyStartedError, HandoverStepNotWaitingError,
 *     HandoverNothingToRetryError → 409 (the handover is not where the call
 *     needs it)
 *   HandoverEmailCodeRefusedError → 422 (AWS refused the code)
 */
export function mapTenantHandoverError(err: unknown): NextResponse | null {
  if (err instanceof TenantHandoverNotFoundError) return reply(err, 404);
  if (err instanceof TenantHandoverNotAdminError) return reply(err, 403);
  if (err instanceof TenantHandoverInputError) return reply(err, 400);
  if (
    err instanceof GithubIdentityRequiredError ||
    err instanceof TenantAccountNotReadyError ||
    err instanceof TenantHandoverAlreadyStartedError ||
    err instanceof HandoverStepNotWaitingError ||
    err instanceof HandoverNothingToRetryError
  ) {
    return reply(err, 409);
  }
  if (err instanceof HandoverEmailCodeRefusedError) return reply(err, 422);
  return null;
}

function reply(err: Error & { code: string }, status: number): NextResponse {
  return NextResponse.json({ code: err.code, error: err.message }, { status });
}

/** A route's 400 for a body or query it cannot read. */
export function badHandoverRequest(error: string): NextResponse {
  return NextResponse.json({ code: 'BAD_REQUEST', error }, { status: 400 });
}

/** The JSON body as a record, or null when it is not one. */
export async function readHandoverBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
