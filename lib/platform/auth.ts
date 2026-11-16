import 'server-only';

import { cache } from 'react';
import { type PlatformRole } from '@/generated/prisma/client';
import { getSession, readOperatorSession } from '@/lib/auth';
import { readStaffSessionToken } from './staffSession';
import { platformStaffRepository } from '@/lib/repositories/platformStaffRepository';
import { NotPlatformStaffError } from './errors';

/**
 * The platform-staff gate — `docs/decisions/platform-staff-auth.md` §2.
 *
 * The ONE thing that grants the `/admin` area and every platform-scoped service
 * method. It answers a question no other guard in motir-core asks: not "does
 * this principal belong to this tenant?" but "is this principal US?".
 *
 * ⚠️ SERVER-SIDE ONLY, structurally. The `server-only` import above makes an
 * accidental client import a BUILD error rather than a review finding, and
 * nothing here reads a header, a cookie claim, a search param or a client prop
 * — the only input is `getSession()` plus a fresh database read. There is no
 * client-trusted path to platform standing, and there is deliberately no way to
 * add one without deleting that import.
 *
 * ⚠️ THE TOKEN EXCEPTIONS ARE NOT HERE. The 2026-10-07 and 2026-11-16
 * amendments to §2 let a staff member's personal access token reach
 * `/api/platform/ideas/**` and `/api/platform/planner-findings/**` — each
 * through its own SEPARATE gate (`lib/platform/ideasGate.ts`,
 * `lib/platform/plannerFindingsGate.ts`). `requirePlatformStaff` itself
 * still never reads a header, and `tests/platform/platformTokenBoundary.test.ts`
 * proves a bearer header alone never satisfies it.
 *
 * ⚠️ It lives in `lib/platform/`, NOT in `lib/auth/`. The card that ordered
 * this work said `lib/auth/`; the ADR that outranks it (its own `blocked_by`,
 * merged 2026-08-17 after the card was authored) places it here, because
 * `lib/auth/index.ts` is Better-Auth's adapter wiring — a framework boundary
 * `CLAUDE.md` names as not-to-refactor — and `lib/permissions/` is the TENANT
 * vocabulary this is separate from (§1). The card was amended on the record.
 */

/** The acting platform principal — what a gated surface is handed. */
export interface PlatformPrincipal {
  userId: string;
  email: string;
  role: PlatformRole;
}

/**
 * The ladder, low to high. `support` ⊂ `operator` ⊂ `superadmin` (ADR §1) —
 * each degree CONTAINS the one before it, so `minimum` is an index comparison
 * and not a set membership test.
 *
 * Exported so a consumer can assert the ordering rather than re-encoding it;
 * `tests/platform/platformStaffGate.test.ts` pins that this array and the Prisma
 * enum stay the same set, so adding a fourth degree without placing it on the
 * ladder fails a test instead of silently sorting as -1.
 */
export const PLATFORM_ROLE_LADDER = [
  'support',
  'operator',
  'superadmin',
] as const satisfies readonly PlatformRole[];

/** True when `role` is at or above `minimum` on the ladder. */
export function platformRoleAtLeast(role: PlatformRole, minimum: PlatformRole): boolean {
  return PLATFORM_ROLE_LADDER.indexOf(role) >= PLATFORM_ROLE_LADDER.indexOf(minimum);
}

/**
 * Resolve the acting platform principal, or throw `NotPlatformStaffError`.
 *
 * @param minimum the lowest degree that satisfies this call site. A read
 *   surface asks for `support` (the default); MOTIR-1167's two day-1 writes ask
 *   for `operator`; Story 10.3's governance asks for `superadmin`.
 *
 * @throws NotPlatformStaffError for an anonymous request, a signed-in tenant
 *   user (INCLUDING a workspace owner and an org owner — no tenant role at any
 *   tier produces platform standing), and a staff user below `minimum`. The
 *   three are indistinguishable by design; see `NotPlatformStaffError`.
 *
 * Wrapped in React `cache()` so a layout and the page beneath it resolve one
 * principal per request — the shape `getSession` itself uses. The cache is
 * per-REQUEST, so it never outlives a revocation.
 */
export const requirePlatformStaff = cache(async function requirePlatformStaff(
  minimum: PlatformRole = 'support',
): Promise<PlatformPrincipal> {
  const session = await getOperatorSession();
  if (!session) throw new NotPlatformStaffError();

  const standing = await platformStaffRepository.findStandingByUserId(session.user.id);
  if (!standing?.platformRole) throw new NotPlatformStaffError();
  if (!platformRoleAtLeast(standing.platformRole, minimum)) throw new NotPlatformStaffError();

  return { userId: standing.id, email: standing.email, role: standing.platformRole };
});

/**
 * The platform principal for a staff member named by EMAIL, or
 * `NotPlatformStaffError` — the same standing rule as {@link requirePlatformStaff},
 * read fresh, for a command run on a deployed machine (`fleet-admin`, Story
 * MOTIR-8953 · MOTIR-8967) where there is no web session to read.
 *
 * ⚠️ NEVER FROM A REQUEST. A web surface gates with `requirePlatformStaff`; an
 * email is not a credential. Its one caller is a command whose operator already
 * holds a shell on the production machine, which is the real gate.
 */
export async function platformPrincipalForStaffEmail(
  email: string,
  minimum: PlatformRole = 'support',
): Promise<PlatformPrincipal> {
  if (!email.trim()) throw new NotPlatformStaffError();
  const standing = await platformStaffRepository.findStandingByEmail(email);
  if (!standing?.platformRole) throw new NotPlatformStaffError();
  if (!platformRoleAtLeast(standing.platformRole, minimum)) throw new NotPlatformStaffError();
  return { userId: standing.id, email: standing.email, role: standing.platformRole };
}

/**
 * The OPERATOR's own session — never a staff "View as" identity (MOTIR-749).
 *
 * Inside a staff session `getSession()` answers as the customer being viewed
 * (`lib/platform/staffSession.ts`), and the console must not: its gate, its
 * audit rows and its own actions (starting another session, leaving one) belong
 * to the person at the keyboard. So when the staff-session cookie is present
 * this reads Better-Auth's session directly (`readOperatorSession`), bypassing
 * the staff-session layer — no tenant classification, no read-only refusal, no
 * view row. Without the cookie the two reads are the same thing, and this
 * defers to the request-memoised `getSession()`.
 *
 * Outside a request (a job, a test) there are no headers and no cookie, which is
 * the second arm.
 */
export const getOperatorSession = cache(async function getOperatorSession() {
  let requestHeaders: Headers | null = null;
  try {
    const { headers } = await import('next/headers');
    requestHeaders = await headers();
  } catch {
    requestHeaders = null;
  }
  if (requestHeaders && readStaffSessionToken(requestHeaders)) {
    return readOperatorSession(requestHeaders);
  }
  return getSession();
});
