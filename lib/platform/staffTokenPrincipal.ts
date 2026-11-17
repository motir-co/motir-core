import 'server-only';

import type { PlatformRole } from '@/generated/prisma/client';
import {
  ApiTokenExpiredError,
  ApiTokenRevokedError,
  InvalidApiTokenError,
} from '@/lib/apiTokens/errors';
import { TOKEN_PREFIX } from '@/lib/apiTokens/token';
import { OrganizationSuspendedError } from '@/lib/organizations/errors';
import { platformStaffRepository } from '@/lib/repositories/platformStaffRepository';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { platformRoleAtLeast, type PlatformPrincipal } from './auth';
import { NotPlatformStaffError } from './errors';

/**
 * The TOKEN HALF of the platform gates that accept a staff member's personal
 * access token (`docs/decisions/platform-staff-auth.md` §2, the 2026-10-07 and
 * 2026-11-16 amendments).
 *
 * ⚠️ IMPORTABLE FROM THE TWO TOKEN GATES ONLY — `lib/platform/ideasGate.ts` and
 * `lib/platform/plannerFindingsGate.ts`. `tests/platform/platformTokenBoundary.test.ts`
 * fails the build on any other importer. This module is what both gates share so
 * the token rules cannot drift between them; it is NOT a third door, and a new
 * platform route that wants a token is a new decision, not a new importer here.
 *
 * It admits a `motir_pat_` token's OWNER when the token verifies (not unknown,
 * revoked or expired, its organization not suspended), is not a RUN token, and
 * the owner's CURRENT platform role — read fresh, so a demotion bites on the next
 * call — is at or above `minimum`. No grant is consulted (the amendments' "no new
 * scope"). Every refusal is the same `NotPlatformStaffError`.
 */

/** A verified staff token: its owner as a platform principal, and the token itself. */
export interface StaffTokenPrincipal {
  principal: PlatformPrincipal;
  apiTokenId: string;
  /** The workspace the token was minted in — never a scope, only where it lives. */
  workspaceId: string;
}

/** The `Bearer` credential, or undefined when the header is absent or another scheme. */
export function bearerFromRequest(req: Request): string | undefined {
  const header = req.headers.get('authorization');
  if (!header) return undefined;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : undefined;
}

/**
 * The staff member a bearer credential names, at `minimum` or above.
 *
 * A bearer that is not a `motir_pat_` token is REFUSED, never quietly downgraded
 * to the session path: a caller who sent a credential gets an answer about it.
 */
export async function staffPrincipalFromBearer(
  bearer: string,
  minimum: PlatformRole,
): Promise<StaffTokenPrincipal> {
  if (!bearer.startsWith(TOKEN_PREFIX)) throw new NotPlatformStaffError();

  let verified: Awaited<ReturnType<typeof apiTokensService.verify>>;
  try {
    verified = await apiTokensService.verify(bearer);
  } catch (err) {
    if (
      err instanceof InvalidApiTokenError ||
      err instanceof ApiTokenRevokedError ||
      err instanceof ApiTokenExpiredError ||
      err instanceof OrganizationSuspendedError
    ) {
      throw new NotPlatformStaffError();
    }
    throw err;
  }
  if (verified.dispatchRunId !== null) throw new NotPlatformStaffError();

  const standing = await platformStaffRepository.findStandingByUserId(verified.user.id);
  if (!standing?.platformRole) throw new NotPlatformStaffError();
  if (!platformRoleAtLeast(standing.platformRole, minimum)) throw new NotPlatformStaffError();

  return {
    principal: { userId: standing.id, email: standing.email, role: standing.platformRole },
    apiTokenId: verified.tokenId,
    workspaceId: verified.workspaceId,
  };
}
