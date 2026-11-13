// Product analytics — the ONE place the analytics script's source is read
// (MOTIR-1163; `docs/decisions/production-service-stack.md` §5).
//
// The vendor is Plausible: cookieless, EU-hosted, and it sets no cookies and
// stores no personal data. §5 chose it for a property this module is the whole
// implementation of — **it needs no build-time public value.** The tag is
// rendered by the SERVER from an ordinary runtime environment variable, so
// nothing about analytics reaches `next build`.
//
// ⚠️ `PLAUSIBLE_SCRIPT_SRC` MUST NEVER BECOME A `NEXT_PUBLIC_*` VARIABLE.
// A `NEXT_PUBLIC_*` value is inlined into the client bundle when `next build`
// runs, which would manufacture the Docker build-argument dependency §5 picked
// Plausible to avoid — and would then need a build arg wired through
// the deploy's image build, which is MOTIR-1162's seam and not this card's.
// `tests/analytics.test.ts` asserts the name never acquires that prefix and
// never appears as a build argument.
//
// THE VALUE IS A PER-SITE SCRIPT URL, not a domain and not a key. Plausible's
// modern Script embed carries no `data-domain` attribute at all: the site is
// identified by a hashed per-site script URL
// (`https://plausible.io/js/pa-<hash>.js`, provisioned by MOTIR-1161 and staged
// as a Fly runtime secret). §5's own text still describes the NPM route's
// `data-domain`, which is why this card amends it.
//
// ⚠️ AND THE SEAM IS THE DELIVERABLE, NOT A CONSENT GATE. Loading a cookieless
// script that stores no personal data is not the terminal-equipment access that
// requires prior consent, and Story 8.4 has no cookie-banner card — there is no
// consent state to read and none is invented here. What §5 requires is that the
// load stay behind ONE accessor, so that a consent gate can be added later
// without touching the surface that renders the tag. That accessor is this
// module, and `components/analytics/AnalyticsScript.tsx` is its only caller.
//
// UNSET MEANS NO ANALYTICS AT ALL — the self-hoster's guarantee falling out of
// the mechanism rather than needing a flag to enforce it. A self-hosted install
// that sets nothing ships an app that phones nowhere; a self-hoster pointing
// this at their own Plausible instance is the same one variable.
//
// THE EVENT SET IS PLAUSIBLE'S DEFAULT, AND NO PII CROSSES THIS SEAM. The tag
// is loaded with no custom-event calls and no identifiers of any kind: the
// script reports page views, and the vendor stores no personal data and sets no
// cookies (that is what made the consent question moot above). Nothing in the
// product passes a user id, an email, a work-item title or a URL fragment to
// it. A later card that wants conversions adds them THROUGH this module, so the
// question "what do we send?" keeps one answer and one place to read it.
//
// An EMPTY or whitespace-only value counts as unset, the same rule
// `lib/baseUrl.ts` applies for the same reason: a secret cleared to `''` is a
// misconfiguration, and rendering `<script src="">` would ask the browser to
// re-fetch the current page as a script rather than disable analytics.

/** The env var carrying the per-site script URL. Named once, read once. */
const SCRIPT_SRC_VAR = 'PLAUSIBLE_SCRIPT_SRC';

/**
 * The analytics script URL to render, or `null` when analytics is disabled.
 *
 * This is the ONE read of the variable in the product. Nothing else may reach
 * for `process.env` to answer the same question — a second reader is a second
 * answer, and it is also the second place a future consent gate would have to
 * be added.
 */
export function analyticsScriptSrc(): string | null {
  const configured = process.env[SCRIPT_SRC_VAR]?.trim();
  return configured ? configured : null;
}

/**
 * Whether product analytics is enabled for this deployment.
 *
 * Derived from the same read, so the question "is analytics on?" and the
 * question "what do we load?" can never disagree. This is the seam a consent
 * gate attaches to if Story 8.4 ever adds a cookie-setting vendor or a banner.
 */
export function analyticsEnabled(): boolean {
  return analyticsScriptSrc() !== null;
}
