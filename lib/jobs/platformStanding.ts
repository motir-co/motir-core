import 'server-only';

import { type PlatformRole } from '@/generated/prisma/client';

// The platform job ledger's two staff levels, in ONE place (MOTIR-8197).
//
// Reading the cross-tenant ledger and replaying a dead letter used to be granted
// to whoever's email matched an environment variable — a stopgap until real
// platform-admin roles existed, removed with no fallback (MOTIR-8200). Those roles ship (`User.platformRole`,
// `docs/decisions/platform-staff-auth.md`), so the two levels /admin/jobs asks
// for are named here once and read from the account's standing.
//
// The request-scoped resolver that turned a tenant session into a role or null
// served only the tenant dashboard's System tab and its replay action, and was
// deleted with them (Story MOTIR-9982); /admin/jobs resolves its principal with
// `requirePlatformStaffPage` and `requirePlatformStaff` directly.

/** Reading the cross-tenant job ledger is a `support` read. */
export const JOBS_SYSTEM_READ_ROLE: PlatformRole = 'support';

/**
 * Replaying a dead letter — it runs under `withSystemContext`,
 * which bypasses tenant RLS, so it is an `operator` write.
 */
export const JOBS_SYSTEM_REPLAY_ROLE: PlatformRole = 'operator';
