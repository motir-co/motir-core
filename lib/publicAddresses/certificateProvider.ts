// The CERTIFICATE PORT — Story MOTIR-3878 · Subtask MOTIR-4210.
//
// The lifecycle service (MOTIR-4216) and the status job (MOTIR-4219) depend on
// THIS file and never on the adapter beneath it. `docs/decisions/public-tenant-addresses.md`
// §6 decides that Fly issues and renews, per hostname, on the `motir-marketing`
// app — and a port is what keeps that a DECISION rather than an assumption
// welded through the service layer.
//
// The shape is `lib/orchestrator/`'s, deliberately: a port file with the
// interface and the typed errors, one adapter directory beneath it, and a
// dependency guard asserting the boundary in SOURCE rather than trusting a
// comment. That port's own record says the reversibility claim is "worth exactly
// as much as that boundary is real".

/** The DNS record a customer must create, as the provider reports it. */
export interface CertificateDnsRequirement {
  readonly type: 'A' | 'AAAA' | 'CNAME' | 'TXT';
  readonly name: string;
  readonly value: string;
}

/**
 * What the provider says about one hostname, normalised.
 *
 * ⚠️ `configured` and `issued` are TWO facts, not one, and collapsing them is
 * the mistake this shape exists to prevent. A hostname can be pointed correctly
 * and have no certificate yet (the ordinary case for the minute after a
 * customer creates their records), and it can have a certificate that has since
 * expired while the DNS still resolves. The settings pane draws different states
 * for those, so the port has to carry both.
 */
export interface CertificateState {
  readonly hostname: string;
  /** The customer's DNS points at us. */
  readonly configured: boolean;
  /** A live certificate exists for this hostname. */
  readonly issued: boolean;
  /** The records the customer still has to create, if any. */
  readonly dnsRequirements: readonly CertificateDnsRequirement[];
  /** When this reading was taken — the value MOTIR-4219 records as `lastCheckedAt`. */
  readonly checkedAt: Date;
  /**
   * When the hostname's certificate stops being valid, as the PLATFORM says
   * (MOTIR-9526) — `null` when the reading carries no date.
   *
   * ⚠️ READ, NEVER COMPUTED. `issuedAt` plus an assumed lifetime is a guess that
   * goes stale the day the platform's renewal policy changes, so a provider that
   * cannot read a date reports `null` and the pane draws no expiry line.
   */
  readonly expiresAt: Date | null;
}

/**
 * Ask a provider for, read, and withdraw a certificate for ONE customer
 * hostname.
 *
 * NOT the wildcard for the base domain. That is cut once, by a human running
 * `fly certs add` (MOTIR-4208), and it covers every tenant subdomain — so
 * claiming a subdomain issues nothing and never reaches this port.
 */
export interface CertificateProvider {
  /** Request a certificate. Idempotent at the provider: asking twice is safe. */
  request(hostname: string): Promise<CertificateState>;
  /** Read the current state, including what DNS the customer still owes. */
  check(hostname: string): Promise<CertificateState>;
  /** Withdraw it. Must not throw when the hostname is already gone. */
  remove(hostname: string): Promise<void>;
}

// ── Typed errors, one per outcome the service branches on ──────────────────

/**
 * Neither `FLY_CERTS_TOKEN` nor `FLY_CERTS_APP` is set.
 *
 * A FIRST-CLASS STATE, not a misconfiguration to crash on: a self-hosted build
 * has no public projects (ADR §11) and therefore no addresses, so it never
 * reaches this path and must not fail to boot because of it. That is why config
 * is read at CALL time — `appAuth.ts`'s contract, restated in `flyMachines.ts`.
 */
export class CertificateProviderNotConfiguredError extends Error {
  readonly code = 'CERTIFICATE_PROVIDER_NOT_CONFIGURED' as const;
  constructor(missing: string[]) {
    super(`The certificate provider is not configured: set ${missing.join(', ')}.`);
    this.name = 'CertificateProviderNotConfiguredError';
  }
}

/**
 * The provider REFUSED — a 4xx. The customer's problem, usually: a hostname that
 * is not pointed at us, one already claimed on another app, or a rate limit.
 *
 * Distinct from {@link CertificateProviderUnavailableError} because the
 * dispositions are opposite: a refusal is shown to the customer with its reason
 * and NOT retried, while an outage is retried and shown to nobody.
 */
export class CertificateProviderRefusedError extends Error {
  readonly code = 'CERTIFICATE_PROVIDER_REFUSED' as const;
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`The certificate provider refused (${status}): ${reason}`);
    this.name = 'CertificateProviderRefusedError';
  }
}

/** The provider could not be reached, or answered 5xx, or timed out. */
export class CertificateProviderUnavailableError extends Error {
  readonly code = 'CERTIFICATE_PROVIDER_UNAVAILABLE' as const;
  constructor(readonly detail: string) {
    super(`The certificate provider is unavailable: ${detail}`);
    this.name = 'CertificateProviderUnavailableError';
  }
}

/**
 * `remove` was asked about a hostname the provider does not hold.
 *
 * ⚠️ It exists so the adapter can DISTINGUISH the case, and the adapter then
 * SWALLOWS it — `remove` is documented as not throwing when the hostname is
 * already gone, because removal is what a retry of a half-finished removal does
 * and "already absent" is the outcome it wanted. The type is exported for the
 * one caller that may want to tell "I removed it" from "there was nothing to
 * remove"; nothing today does.
 */
export class CertificateHostnameUnknownError extends Error {
  readonly code = 'CERTIFICATE_HOSTNAME_UNKNOWN' as const;
  constructor(readonly hostname: string) {
    super(`The certificate provider does not hold ${hostname}.`);
    this.name = 'CertificateHostnameUnknownError';
  }
}

/**
 * How long a single provider call may take.
 *
 * Bounded for the reason `flyMachines.ts` gives at length: unbounded, a provider
 * that accepts the connection and never answers is waited on until the platform
 * kills the whole invocation. Here that would hold a request thread open behind
 * a customer pressing *Verify*.
 */
export const CERTIFICATE_REQUEST_TIMEOUT_MS = 15_000;
