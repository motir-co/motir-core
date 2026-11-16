import 'server-only';

import type { PlatformRole } from '@/generated/prisma/client';
import type { IdeaActor } from '@/lib/ideas/types';
import { requirePlatformStaff } from './auth';
import { bearerFromRequest, staffPrincipalFromBearer } from './staffTokenPrincipal';

/**
 * The IDEAS gate — the one door where a platform-staff member's personal access
 * token stands in for their console session (Story MOTIR-7662 · MOTIR-7673;
 * `docs/decisions/platform-staff-auth.md` §2, the 2026-10-07 amendment).
 *
 * ⚠️ IMPORTABLE FROM `app/api/platform/ideas/**` ONLY.
 * `tests/platform/platformTokenBoundary.test.ts` fails the build when any other
 * file under `app/` or `lib/` imports this module. That is what keeps the
 * exception one door wide: it is a SEPARATE gate, not a flag on
 * `requirePlatformStaff`, so no other platform surface is ever one argument away
 * from accepting a token.
 *
 * Admits exactly two principals:
 *  - a request with NO bearer header → `requirePlatformStaff(minimum)`, the
 *    console session exactly as every other platform surface reads it;
 *  - a request carrying `Authorization: Bearer motir_pat_…` → the token's OWNER,
 *    when the token is not a run token and the owner's CURRENT platform role
 *    (read fresh, so a demotion bites on the next call) is at or above
 *    `minimum`. No grant is consulted — the amendment's "no new scope".
 *
 * Every refusal — anonymous, non-staff, below the level, unknown / revoked /
 * expired token, a suspended org's token, a run token — is the same
 * `NotPlatformStaffError`, which the routes answer with the same 404.
 *
 * A bearer header that does not carry a `motir_pat_` token is REFUSED, never
 * quietly downgraded to the session path: a caller who sent a credential gets
 * an answer about that credential.
 */
export async function requirePlatformStaffForIdeas(
  req: Request,
  minimum: PlatformRole,
): Promise<IdeaActor> {
  const bearer = bearerFromRequest(req);
  if (bearer === undefined) {
    const principal = await requirePlatformStaff(minimum);
    return { ...principal, credential: { kind: 'session' } };
  }
  // The token half is shared with the planner-findings gate
  // (`./staffTokenPrincipal`), so the two cannot drift.
  const { principal, apiTokenId } = await staffPrincipalFromBearer(bearer, minimum);
  return { ...principal, credential: { kind: 'token', apiTokenId } };
}
