import { NextResponse } from 'next/server';
import { bearerFromHeader } from '@/lib/apiTokens/routeAuth';
import {
  ApiTokenExpiredError,
  ApiTokenRevokedError,
  InvalidApiTokenError,
} from '@/lib/apiTokens/errors';
import { OrganizationSuspendedError } from '@/lib/organizations/errors';
import { cliDeviceService } from '@/lib/services/cliDeviceService';

// GET /api/cli/token (MOTIR-10189) — what `motir auth status` asks about the token
// it holds: is it a CLI sign-in, and which keys of today's `CLI_TOKEN_GRANT` does it
// lack? A non-empty `missing` is the cue for the status line that suggests
// `motir auth refresh`.
//
// BEARER, and deliberately not a `/api/v1` operation: the comparison is against the
// CLI's own fixed set, which is the CLI-connect flow's business and not part of the
// public API (`/api/v1/me` already reports the grant itself). Any live token may
// ask about itself; no permission is required, because nothing beyond its own
// grant is disclosed.
//
//   200 { cliSignIn, missing }
//   401 no bearer, or an unknown, revoked or expired one
//   403 the token's organization is suspended
export async function GET(req: Request): Promise<Response> {
  const secret = bearerFromHeader(req.headers.get('authorization'));
  if (!secret) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  try {
    const status = await cliDeviceService.tokenStatus(secret);
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (
      err instanceof InvalidApiTokenError ||
      err instanceof ApiTokenRevokedError ||
      err instanceof ApiTokenExpiredError
    ) {
      return NextResponse.json({ code: 'API_TOKEN_INVALID' }, { status: 401 });
    }
    if (err instanceof OrganizationSuspendedError) {
      return NextResponse.json({ code: err.code }, { status: 403 });
    }
    throw err;
  }
}
