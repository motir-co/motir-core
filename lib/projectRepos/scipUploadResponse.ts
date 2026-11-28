import { NextResponse } from 'next/server';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';

// The SCIP upload-credential routes' refusal shape (MOTIR-12339): the room's own
// `{ code, error }`, plus `retryable` on EVERY refusal so the room reads one shape —
// true only where a retry can change the answer (`codegraph_unavailable`, and a
// GitHub delete that failed during a revoke), false everywhere else.

/** The mapped refusal with `retryable` on it, or null for an error to rethrow. */
export async function scipUploadRefusal(err: unknown): Promise<NextResponse | null> {
  const mapped = mapProjectRepoError(err);
  if (!mapped) return null;
  const body = (await mapped.clone().json()) as Record<string, unknown>;
  if (typeof body['retryable'] === 'boolean') return mapped;
  return NextResponse.json({ ...body, retryable: false }, { status: mapped.status });
}
