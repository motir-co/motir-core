import { NextResponse } from 'next/server';
import {
  ApplicationNotFoundError,
  ApplicationNotStoppableError,
  ApplicationStopFailedError,
} from '@/lib/hosting/errors';
import { OrgForbiddenError } from '@/lib/organizations/errors';

/**
 * The Stop now route's typed-error → HTTP mapping (Story MOTIR-9800 ·
 * MOTIR-12135). Returns null for an error the route should rethrow — an
 * unmapped error is a 500.
 *
 *   ApplicationNotFoundError → 404 (no such application, another
 *     organisation's, or an organisation the caller is not in —
 *     indistinguishable on purpose)
 *   OrgForbiddenError → 403 (a member who is not an admin)
 *   ApplicationNotStoppableError → 409 (neither in its grace window nor
 *     handed over; nothing was called)
 *   ApplicationStopFailedError → 502 (a step failed; still in its grace
 *     window, and Stop now or the next sweep continues it)
 */
export function mapStopError(err: unknown): NextResponse | null {
  if (err instanceof ApplicationNotFoundError) return reply(err.code, err.message, 404);
  if (err instanceof OrgForbiddenError) return reply(err.code, 'Organisation admins only.', 403);
  if (err instanceof ApplicationNotStoppableError) return reply(err.code, err.message, 409);
  if (err instanceof ApplicationStopFailedError) return reply(err.code, err.message, 502);
  return null;
}

function reply(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
}
