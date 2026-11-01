// Typed errors for the public-address data layer — Story MOTIR-3878 · Subtask
// MOTIR-4209. The service and route layers above map each `code` to an HTTP
// status; nothing here knows about HTTP.
//
// This file exists at the REPOSITORY tier, which is unusual and deliberate: the
// hostname race is arbitrated by a database constraint, so the only place that
// can recognise it is the layer holding the Prisma call. Letting a raw `P2002`
// escape would make every caller re-implement the same string match against a
// Prisma error code — which is precisely the shape `CLAUDE.md`'s concurrency
// rule forbids ("translate raw DB races to typed errors ... so a raw DB error
// never escapes the service").

import type { LabelRefusal } from '@/lib/publicAddresses/reservedNames';
import { PRISMA_UNIQUE_VIOLATION, uniqueViolationConstraints } from '@/lib/prisma/uniqueViolation';

/**
 * Somebody else already holds this hostname.
 *
 * The `hostname` unique index is GLOBAL, so this is raised for situations that
 * are one situation to the database, and the caller must not assume which:
 *
 *   1. another workspace has claimed the label;
 *   2. another project has connected the domain;
 *   3. a legacy `workspace_subdomain_alias` row still holds the name, until the
 *      one-off alias cleanup (MOTIR-9520) turns it into an expiring hold.
 *
 * They are deliberately NOT distinguished. Telling a claimer *which* workspace
 * holds a name is an existence leak across the tenancy boundary for no gain —
 * the answer they need is the same in every case: pick another name. A name
 * held by a RESERVATION is the one exception, and it is a separate error
 * ({@link NameQuarantinedError}) because that hold ends on a date the claimer is
 * owed (§8 Amendment 3).
 *
 * The `IdentifierTakenError` precedent (`projectsService.changeKey`) is the same
 * shape one level down.
 */
export class HostnameTakenError extends Error {
  readonly code = 'HOSTNAME_TAKEN' as const;
  constructor(readonly hostname: string) {
    super(`The hostname ${hostname} is already in use.`);
    this.name = 'HostnameTakenError';
  }
}

/**
 * The requested subdomain label is refused by the ADR §8 grammar or reserved
 * set. Carries the discriminator so the surface can say WHICH rule refused it —
 * "reserved" and "too short" send a customer to different next actions.
 */
export class ReservedLabelError extends Error {
  readonly code = 'RESERVED_LABEL' as const;
  constructor(
    readonly label: string,
    readonly refusal: LabelRefusal,
  ) {
    super(`The subdomain ${label} is not available (${refusal}).`);
    this.name = 'ReservedLabelError';
  }
}

/**
 * Is this thrown error a unique-constraint violation on `public_address.hostname`?
 *
 * ⚠️ It checks the CONSTRAINT, not just the code. A `P2002` from this table could
 * only be the hostname index today — it is the only unique constraint on it —
 * but "today" is exactly the assumption that rots: adding a second unique index
 * later would silently start reporting its violations as HostnameTakenError, and
 * the customer would be told to pick another hostname for a collision that had
 * nothing to do with one.
 *
 * ⚠️ AND THE CONSTRAINT IS NOT IN `meta.target` UNDER THIS CLIENT (MOTIR-5273).
 * This used to read `meta.target` alone and claim that doing so "costs one
 * comparison and cannot age". It had already aged: measured on this table,
 * `meta.target` is ABSENT, so every violation fell through to the last arm and
 * the check above protected nothing. The name the database reported survives in
 * the driver's own error, and `uniqueViolationConstraints` reads it from there
 * (`public_address_hostname_key` contains `hostname`), so the check is live again.
 *
 * The last arm still falls back to TRUE for a `P2002` naming no constraint at
 * all: the narrower reading would be to rethrow, but that trades a
 * correct-in-every-observed-case answer for a raw error crossing the service
 * boundary, which is the thing the rule is about.
 *
 * It narrows structurally rather than casting to
 * `Prisma.PrismaClientKnownRequestError`, which keeps this module importable
 * without a Prisma runtime.
 */
export function isHostnameUniqueViolation(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code !== PRISMA_UNIQUE_VIOLATION) return false;
  const constraints = uniqueViolationConstraints(err);
  if (constraints === null) return true;
  return constraints.some((c) => c.includes('hostname'));
}

// ── The SERVICE tier's errors (MOTIR-4215) ─────────────────────────────────
//
// The route layer maps each `code` to a status. They are separate types rather
// than one error with a discriminator because the route's mapper is a series of
// `instanceof` branches, and a single type would make every branch a nested
// switch on a field.

/**
 * A rename was asked for on a workspace that has never claimed a subdomain.
 *
 * 409, not 404: the caller asked to CHANGE something, and the refusal is about
 * the state that request met. Compare {@link SubdomainNotFoundError}, which is
 * the same situation reached by a DELETE and answers 404 — see its comment for
 * why the two are separate types rather than one type mapped two ways.
 */
export class NoSubdomainClaimedError extends Error {
  readonly code = 'NO_SUBDOMAIN_CLAIMED' as const;
  constructor() {
    super('This workspace has not claimed a subdomain yet.');
    this.name = 'NoSubdomainClaimedError';
  }
}

/**
 * A RELEASE was asked of a workspace that holds no subdomain (§8 Amendment 2,
 * MOTIR-4454). Answered **404**.
 *
 * ⚠️ A SEPARATE TYPE FROM {@link NoSubdomainClaimedError} ON PURPOSE, and the
 * alternative is what makes it worth a comment. The two describe the identical
 * database state and want different statuses — 409 for the rename, 404 for the
 * delete — because a `DELETE` names a RESOURCE and the honest answer for a
 * resource that is not there is that it is not there, while a `PUT` that renames
 * is a request whose premise the state refuses.
 *
 * The other way to express that is to keep one type and let the DELETE route map
 * it to a different status than the shared mapper does. That is exactly what
 * `errorResponse.ts`'s own header forbids — the mappers fall through to one
 * another *"so the two surfaces cannot answer the same typed error two different
 * ways"* — and a per-verb override is that hazard with a smaller radius, not a
 * different one. Two types, two codes, one mapping each.
 */
export class SubdomainNotFoundError extends Error {
  readonly code = 'SUBDOMAIN_NOT_FOUND' as const;
  constructor() {
    super('This workspace has no public subdomain to release.');
    this.name = 'SubdomainNotFoundError';
  }
}

/**
 * The workspace changed its subdomain less than 30 days ago (§8 Amendment 3
 * rule 4, Story MOTIR-4528). Answered **409** with the date the next change is
 * allowed.
 *
 * A rename and a release count alike, and there is no cap on how many changes a
 * workspace makes over time: the limit exists so a name cannot be cycled through
 * the pool faster than a quarantine can hold it, not to ration names. The date
 * travels with the refusal because "not yet" without "when" is a refusal the
 * customer can only retry blindly.
 */
export class SubdomainChangeLimitError extends Error {
  readonly code = 'SUBDOMAIN_CHANGE_LIMIT' as const;
  constructor(readonly nextAllowedAt: Date) {
    super(`This workspace can change its subdomain again on ${nextAllowedAt.toISOString()}.`);
    this.name = 'SubdomainChangeLimitError';
  }
}

/**
 * The hostname was released by a workspace and is quarantined until
 * `returnsAt` (§8 Amendment 3 rule 3). Answered **409** with that date.
 *
 * ⚠️ DELIBERATELY NOT {@link HostnameTakenError}. A name a LIVE row holds says
 * nothing about when it frees up, and must not say whose it is. A quarantined
 * name returns to the pool on a known date, and story rule 5 promises the
 * claimer that date: it tells them whether to wait or pick another name. The
 * date is all it carries. The reserving workspace stays unnamed, because the
 * reservation table stores a digest and the provenance column is never read
 * back to a claimer.
 */
export class NameQuarantinedError extends Error {
  readonly code = 'NAME_QUARANTINED' as const;
  constructor(
    readonly hostname: string,
    readonly returnsAt: Date,
  ) {
    super(`The hostname ${hostname} is held until ${returnsAt.toISOString()}.`);
    this.name = 'NameQuarantinedError';
  }
}

/**
 * The actor may see the workspace but may not change its address.
 *
 * DISTINCT from "not a member", which answers 404: a member can see that the
 * workspace exists, so telling them the address is admin-only leaks nothing and
 * is the answer they need. A non-member gets the no-existence-leak 404 the rest
 * of the tenancy boundary gives.
 */
export class SubdomainForbiddenError extends Error {
  readonly code = 'SUBDOMAIN_FORBIDDEN' as const;
  constructor() {
    super('Only a workspace owner or admin can change the public address.');
    this.name = 'SubdomainForbiddenError';
  }
}

/** The actor is not a member of this workspace — answered as a 404. */
export class WorkspaceNotVisibleError extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor() {
    super('Not found.');
    this.name = 'WorkspaceNotVisibleError';
  }
}

/**
 * Public addresses are a CLOUD capability (ADR §11).
 *
 * ABSENT, not hidden — the same posture `lib/publicProjects/cloudGate.ts` takes
 * and for the same reason: a 403 says *this exists and you may not see it*,
 * which is a false statement about a self-hosted build. There is no door.
 */
export class PublicAddressesUnavailableError extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor() {
    super('Not found.');
    this.name = 'PublicAddressesUnavailableError';
  }
}

// ── The CUSTOMER-DOMAIN lifecycle's errors (MOTIR-4216) ────────────────────

/** The hostname is not a hostname, or carries a scheme / port / path. */
export class InvalidHostnameError extends Error {
  readonly code = 'INVALID_HOSTNAME' as const;
  constructor(readonly hostname: string) {
    super(`${hostname} is not a valid hostname.`);
    this.name = 'InvalidHostnameError';
  }
}

/**
 * The hostname is one WE serve — the tenant base domain, anything under it, or
 * `motir.co` and its subdomains.
 *
 * Refused rather than allowed-and-ignored: a customer who "connects"
 * `acme.motir.site` would be adding a row for an address the wildcard already
 * serves, and the certificate request for it would either collide with the
 * wildcard or sit pending for ever. The refusal has its own code so the pane can
 * say *you already have this address* instead of *that name is taken*.
 */
export class NotACustomerDomainError extends Error {
  readonly code = 'NOT_A_CUSTOMER_DOMAIN' as const;
  constructor(readonly hostname: string) {
    super(`${hostname} is a Motir address, not a domain you own.`);
    this.name = 'NotACustomerDomainError';
  }
}

/** An operation legal only on an `issued` address was asked of another status. */
export class AddressNotIssuedError extends Error {
  readonly code = 'ADDRESS_NOT_ISSUED' as const;
  constructor(readonly status: string) {
    super(`This address is ${status}; only a live address can be made primary.`);
    this.name = 'AddressNotIssuedError';
  }
}

/** The address id does not name a row in this project. */
export class AddressNotFoundError extends Error {
  readonly code = 'ADDRESS_NOT_FOUND' as const;
  constructor() {
    super('Not found.');
    this.name = 'AddressNotFoundError';
  }
}
