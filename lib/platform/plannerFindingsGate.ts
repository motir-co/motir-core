import 'server-only';

import type { PlatformRole } from '@/generated/prisma/client';
import type { PlannerFindingActor } from '@/lib/plannerFindings/types';
import { requirePlatformStaff } from './auth';
import { bearerFromRequest, staffPrincipalFromBearer } from './staffTokenPrincipal';

/**
 * The PLANNER-FINDINGS gate — the second door where a platform-staff member's
 * personal access token stands in for their console session (Story MOTIR-11455 ·
 * MOTIR-11458; `docs/decisions/platform-staff-auth.md` §2, the 2026-11-16
 * amendment). The private `motir check plan` skill reads and writes finding
 * records through it as the staff member.
 *
 * ⚠️ IMPORTABLE FROM `app/api/platform/planner-findings/**` ONLY.
 * `tests/platform/platformTokenBoundary.test.ts` fails the build when any other
 * file imports it. Like the ideas gate it is a SEPARATE gate, not a flag on
 * `requirePlatformStaff`, so no other platform surface is one argument away
 * from accepting a token.
 *
 * Admits exactly two principals, on the ideas gate's terms:
 *  - NO bearer header → `requirePlatformStaff(minimum)`, the console session;
 *  - `Authorization: Bearer motir_pat_…` → the token's owner, through the token
 *    half both gates share (`./staffTokenPrincipal`): not a run token, the
 *    owner's CURRENT role at or above `minimum`, no grant consulted.
 *
 * Every refusal is the same `NotPlatformStaffError`, which the routes answer
 * with the same 404 as the ideas routes.
 */
export async function requirePlatformStaffForPlannerFindings(
  req: Request,
  minimum: PlatformRole,
): Promise<PlannerFindingActor> {
  const bearer = bearerFromRequest(req);
  if (bearer === undefined) {
    const principal = await requirePlatformStaff(minimum);
    return { ...principal, credential: { kind: 'session' } };
  }
  const { principal, apiTokenId, workspaceId } = await staffPrincipalFromBearer(bearer, minimum);
  return { ...principal, credential: { kind: 'token', apiTokenId, workspaceId } };
}
