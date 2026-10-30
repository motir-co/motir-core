import { NextResponse } from 'next/server';

import { EntitlementExceededError } from '@/lib/billing/errors';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  AddressNotFoundError,
  InvalidHostnameError,
  NotACustomerDomainError,
} from '@/lib/publicAddresses/errors';
import {
  CertificateProviderNotConfiguredError,
  CertificateProviderUnavailableError,
} from '@/lib/publicAddresses/certificateProvider';

import {
  HostnameTakenError,
  NameQuarantinedError,
  NoSubdomainClaimedError,
  PublicAddressesUnavailableError,
  ReservedLabelError,
  SubdomainForbiddenError,
  SubdomainChangeLimitError,
  SubdomainNotFoundError,
  WorkspaceNotVisibleError,
} from '@/lib/publicAddresses/errors';
import { TenantDomainNotConfiguredError } from '@/lib/publicAddresses/tenantDomain';

// Typed-error → HTTP-status mapper for the public-address routes.
// Story MOTIR-3878 · Subtask MOTIR-4215. Mirrors `lib/billing/errorResponse.ts`:
// the route layer is HTTP-only, so it calls one service method and hands
// whatever throws to this. Returns `null` for an unknown error so the route
// rethrows and the platform logs a genuine 500.
//
// ── The status choices, each of which is a decision ────────────────────────
//
//   404 for OFF-CLOUD and for a NON-MEMBER — the same code for two reasons, and
//       that is the point: both mean "there is nothing here for you", and giving
//       them different codes would let a caller tell a self-hosted build from a
//       workspace they cannot see.
//   403 for a MEMBER who is not an admin — they can see the workspace, so
//       telling them the control is admin-only leaks nothing and is the answer
//       they need.
//   409 for a TAKEN hostname — a conflict with state, not a bad request. It is
//       also the answer for "you already have one" on claim, because from the
//       caller's side both mean the name they asked for is not available.
//   409 for a QUARANTINED name and for a change inside the 30-day LIMIT (§8
//       Amendment 3) — both are conflicts with state that END on a known date,
//       so each body carries that date as ISO 8601 (`returnsAt`,
//       `nextAllowedAt`) and the pane can say when rather than just no.
//   422 for a REFUSED LABEL — a well-formed request that fails a domain rule,
//       which is exactly what 422 is for.
//   404 for a RELEASE of a workspace with no subdomain (§8 Amendment 2) — a
//       DELETE names a resource, and the honest answer for one that is not there
//       is that it is not there. It is deliberately a DIFFERENT typed error from
//       the rename's 409 rather than the same error mapped twice; the reasoning
//       is on `SubdomainNotFoundError`.
//   503 for an unconfigured base domain — an OPERATOR problem, never the
//       caller's, and the one case here where retrying later may work.
export function mapPublicAddressError(err: unknown): NextResponse | null {
  if (err instanceof PublicAddressesUnavailableError || err instanceof WorkspaceNotVisibleError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof SubdomainForbiddenError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof HostnameTakenError) {
    return NextResponse.json(
      { code: err.code, error: err.message, hostname: err.hostname },
      { status: 409 },
    );
  }
  if (err instanceof ReservedLabelError) {
    // The refusal DISCRIMINATOR travels with it — `reserved` and `too_short`
    // send a customer to different next actions, and a single message would
    // make the pane parse prose to tell them apart.
    return NextResponse.json(
      { code: err.code, error: err.message, refusal: err.refusal },
      { status: 422 },
    );
  }
  if (err instanceof NameQuarantinedError) {
    return NextResponse.json(
      {
        code: err.code,
        error: err.message,
        hostname: err.hostname,
        returnsAt: err.returnsAt.toISOString(),
      },
      { status: 409 },
    );
  }
  if (err instanceof SubdomainChangeLimitError) {
    return NextResponse.json(
      { code: err.code, error: err.message, nextAllowedAt: err.nextAllowedAt.toISOString() },
      { status: 409 },
    );
  }
  if (err instanceof NoSubdomainClaimedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof SubdomainNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof TenantDomainNotConfiguredError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 503 });
  }
  return null;
}

// ── The customer-domain lifecycle's mappings (MOTIR-4216) ──────────────────

/**
 * The lifecycle routes' mapper. Falls through to {@link mapPublicAddressError}
 * for everything the subdomain routes already map, so the two surfaces cannot
 * answer the same typed error two different ways.
 */
export function mapCustomDomainError(err: unknown): NextResponse | null {
  // ⚠️ THE TWO THE GATE ITSELF RAISES, AND THEY WERE MISSING.
  // `customDomainService` calls `projectAccessService.assertPermission`, which
  // refuses with `PermissionDeniedError` — an error this mapper did not know, so
  // every refusal on these four routes fell through to a **500** instead of a
  // 403. Nothing in the service tests could see it: they exercise the SERVICE,
  // and only the route knows the mapper. `tests/permissions/storyGate.test.ts`
  // guard 3 exists for exactly this gap and is what caught it.
  //
  // 404 first, and it is the same reasoning the subdomain mapper records:
  // `assertPermission` raises `ProjectNotFoundError` for a project the actor
  // cannot see, and that must stay indistinguishable from one that does not
  // exist. The 403 below is only ever a project the actor CAN see.
  if (err instanceof ProjectNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, permission: err.permission },
      { status: 403 },
    );
  }
  if (err instanceof AddressNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof InvalidHostnameError || err instanceof NotACustomerDomainError) {
    // 422 — well-formed request, refused by a domain rule. The two carry
    // different codes so the pane can say *you already have this address*
    // rather than *that is not a hostname*.
    return NextResponse.json(
      { code: err.code, error: err.message, hostname: err.hostname },
      { status: 422 },
    );
  }
  if (err instanceof EntitlementExceededError) {
    // ⚠️ THE BILLING SURFACE'S OWN SHAPE, deliberately — 402 with `entitlement`
    // and `detail`. The pane's upgrade prompt keys off that field, so answering
    // a cap here in a different shape would mean the same refusal renders one
    // way from billing and another from this surface.
    return NextResponse.json(
      { code: err.code, error: err.message, entitlement: err.entitlement, detail: err.detail },
      { status: 402 },
    );
  }
  if (err instanceof CertificateProviderUnavailableError) {
    // 503 — ours to retry, never the caller's to fix.
    return NextResponse.json({ code: err.code, error: err.message }, { status: 503 });
  }
  if (err instanceof CertificateProviderNotConfiguredError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 503 });
  }
  return mapPublicAddressError(err);
}
