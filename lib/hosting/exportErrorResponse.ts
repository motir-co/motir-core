import { NextResponse } from 'next/server';
import {
  ExportFailedError,
  ExportNotAllowedError,
  ExportNotFoundError,
  ExportTargetUnsupportedError,
} from '@/lib/hosting/errors';
import { OrgForbiddenError } from '@/lib/organizations/errors';

/**
 * The database-export routes' typed-error → HTTP mapping (Story MOTIR-9800 ·
 * MOTIR-12134), in ONE place so the three routes cannot drift. Returns null for
 * an error the route should rethrow — an unmapped error is a 500.
 *
 *   ExportNotFoundError → 404 (no such application or export, another
 *     organisation's, an expired export, or an organisation the caller is not
 *     in — indistinguishable on purpose)
 *   OrgForbiddenError → 403 (a member who is not an admin)
 *   ExportNotAllowedError → 409 (the application is not in its grace window)
 *   ExportTargetUnsupportedError → 422 (an AWS application)
 *   ExportFailedError → 502
 */
export function mapExportError(err: unknown): NextResponse | null {
  if (err instanceof ExportNotFoundError) return reply(err.code, err.message, 404);
  if (err instanceof OrgForbiddenError) return reply(err.code, 'Organisation admins only.', 403);
  if (err instanceof ExportNotAllowedError) return reply(err.code, err.message, 409);
  if (err instanceof ExportTargetUnsupportedError) return reply(err.code, err.message, 422);
  if (err instanceof ExportFailedError) return reply(err.code, err.message, 502);
  return null;
}

function reply(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
}
