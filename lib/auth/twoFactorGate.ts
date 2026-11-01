import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { CURRENT_PATH_HEADER } from '@/proxy';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';
import { twoFactorPolicyService } from '@/lib/services/twoFactorPolicyService';

// The 2FA ENFORCEMENT GATE (Story MOTIR-1215 · Subtask MOTIR-3648).
//
// One helper, four call sites — `app/(authed)`, `app/(onboarding)`,
// and `app/(admin)`. (`app/(planning)` was a fourth until MOTIR-4732 retired the
// route group — the planning workspace is an overlay inside `(authed)` now, so it
// inherits that group's gate rather than running its own.) Copies of the same
// three lines are how
// one route group quietly stays open, so
// `tests/navigation/two-factor-gate-coverage.test.ts` enumerates the route-group
// layouts from the filesystem and fails when one neither calls this nor appears
// on its exemption list with a reason.
//
// ⚠️ IT RUNS AFTER `getSession()` AND BEFORE ANYTHING TENANT-SCOPED, and in the
// layouts' existing concurrent wave rather than as a fifth sequential round trip
// — this executes on every signed-in page load in the product, and the wave it
// joins is itself a documented performance fix (MOTIR-3433).

/**
 * Where a visitor lands when the `next` value cannot be trusted.
 *
 * ⚠️ IMPORTED, NEVER RE-TYPED. The signed-in landing is decided ONCE in
 * `lib/navigation/landing.ts` (`docs/decisions/home-scope.md` §2.3), and
 * `tests/navigation/landing.test.ts` fails on a literal — three separate
 * repairs (MOTIR-2921, MOTIR-3171, MOTIR-3173) each began as one.
 */
export const TWO_FACTOR_FALLBACK_DESTINATION = AUTHED_LANDING_PATH;

/** The screen a non-compliant visitor is held at. */
export const TWO_FACTOR_REQUIRED_PATH = '/two-factor-required';

/**
 * The ONE surface a held visitor may still reach inside `(authed)`.
 *
 * ⚠️ EXEMPT BY EXPLICIT PATH, NEVER BY WILDCARD. It is the account's own
 * Security pane — the other place a person can enrol — so gating it would hold
 * somebody out of the very surface that resolves the condition holding them out.
 * A wildcard over `/settings/account` would exempt the profile, the tokens and
 * the appearance panes too, none of which resolve anything.
 */
export const TWO_FACTOR_EXEMPT_PATHS = ['/settings/account/security'] as const;

/**
 * Validate a redirect target that arrived from a REQUEST HEADER.
 *
 * ⚠️ AN UNVALIDATED REDIRECT TARGET TAKEN FROM A HEADER IS AN OPEN REDIRECT, and
 * it is the one way this gate could ship a vulnerability. `x-current-path` is
 * documented at its source (`proxy.ts`) as advisory, absent off-matcher and
 * FORGEABLE; the proxy overwrites it on every path it covers, but a consumer may
 * not assume the proxy ran.
 *
 * Accepted: a same-origin relative path — a leading `/`, no scheme, no
 * protocol-relative `//`, no `..` segment. Everything else falls back.
 */
export function safeNextPath(candidate: string | null | undefined): string {
  if (!candidate) return TWO_FACTOR_FALLBACK_DESTINATION;
  if (!candidate.startsWith('/')) return TWO_FACTOR_FALLBACK_DESTINATION;
  // `//evil.example` is protocol-relative: the browser reads it as a HOST, and it
  // passes a naive "starts with /" check. This is the case the check exists for.
  if (candidate.startsWith('//')) return TWO_FACTOR_FALLBACK_DESTINATION;
  if (candidate.includes('\\')) return TWO_FACTOR_FALLBACK_DESTINATION;
  // A scheme anywhere — `/x?to=https://evil` is fine as a path, but
  // `/\thttps://` and friends are not worth the analysis. Reject the colon
  // before the first `?`, which is where a scheme could hide.
  const [pathPart] = candidate.split('?');
  if (pathPart!.includes(':')) return TWO_FACTOR_FALLBACK_DESTINATION;
  if (pathPart!.split('/').includes('..')) return TWO_FACTOR_FALLBACK_DESTINATION;
  return candidate;
}

/** True when this path is one the gate deliberately lets a held visitor reach. */
export function isTwoFactorExemptPath(path: string): boolean {
  return TWO_FACTOR_EXEMPT_PATHS.some((exempt) => path === exempt || path.startsWith(`${exempt}?`));
}

/**
 * Hold a non-compliant visitor at the enrolment screen.
 *
 * Returns nothing and throws Next's redirect sentinel when it acts, so a layout
 * awaits it as ONE ARM OF ITS EXISTING CONCURRENT WAVE and carries on: the
 * rejection propagates out of the `Promise.all` and the framework answers it.
 * That placement is the point — a fifth sequential round trip on every signed-in
 * page load is what this story is explicitly told not to add.
 *
 * `required && !compliant` is the only state that redirects: a compliant person
 * passes whether or not anything requires it, and so does anyone no tier is
 * asking.
 *
 * ⚠️ COMPLIANCE IS `methods.length > 0`, NOT `user.twoFactorEnabled` — the
 * contract `lib/dto/twoFactor.ts` states and `hasSecondFactor` implements. A
 * passkey counts even with that flag false, which is precisely the account a
 * naive check would lock out of the product.
 */
export async function assertTwoFactorCompliance(
  userId: string,
  /** Where enrolment returns to, for a page outside `proxy.ts`'s matcher (which
   *  is what stamps the current path): the preview gate's `/preview-access`
   *  door builds its own (MOTIR-5779). Defaults to the request's current path. */
  returnTo?: string,
): Promise<void> {
  const requirement = await twoFactorPolicyService.resolveRequirement(userId);
  if (!requirement.required || requirement.compliant) return;

  const current = returnTo ?? (await headers()).get(CURRENT_PATH_HEADER);
  // The exemption is read from the CURRENT path, so a held visitor can still
  // open their own Security pane and enrol.
  if (current && isTwoFactorExemptPath(current)) return;

  const next = safeNextPath(current);
  redirect(`${TWO_FACTOR_REQUIRED_PATH}?next=${encodeURIComponent(next)}`);
}
