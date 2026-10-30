// The DTOs the public-address surfaces return — Story MOTIR-3878 · MOTIR-4215.
// Services return these, never raw Prisma rows (`CLAUDE.md`'s 4-layer rule).

/**
 * A workspace's tenant subdomain, or the shape a workspace that has none reads
 * as (`null` from the service).
 *
 * One name and nothing else (§8 Amendment 3 rule 1): a workspace has no aliases,
 * and there is no rename cap to count down.
 */
export interface PublicSubdomainDto {
  /** The label alone, e.g. `acme` — what the settings field edits. */
  readonly label: string;
  /** The full hostname, e.g. `acme.motir.site`. */
  readonly hostname: string;
  /** The absolute URL a reader opens. */
  readonly url: string;
  readonly claimedAt: string;
  /**
   * When the workspace may next rename or release its subdomain (rule 4), or
   * `null` when it may do so now. Sent because a limit the customer cannot see
   * is a limit they meet as a refusal.
   */
  readonly nextChangeAllowedAt: string | null;
}

/**
 * What renaming or releasing the subdomain would do RIGHT NOW — the confirm
 * dialog's dated preview (rule 5). Computed by the same pure functions the write
 * applies, so the date the dialog shows is the date the write stores. Advice,
 * never authority: the write re-checks under the workspace lock.
 */
export interface SubdomainChangePreviewDto {
  /** The hostname that would stop being served. */
  readonly host: string;
  /** `return_now` frees the name at once; `quarantine` holds it until `returnsAt`. */
  readonly outcome: 'return_now' | 'quarantine';
  readonly returnsAt: string | null;
  /** Whether the 30-day limit allows a change now. */
  readonly changeAllowed: boolean;
  /** When a change is next allowed, or `null` when one is allowed now. */
  readonly nextChangeAllowedAt: string | null;
}

/** What a release returns: when the released name returns to the pool, or `null` if it already has. */
export interface SubdomainReleaseDto {
  readonly returnsAt: string | null;
}

// ── Host resolution (MOTIR-4217; Story MOTIR-4528 · MOTIR-9511) ─────────────
//
// What `GET /api/public/hosts/{host}` answers. A DISCRIMINATED UNION rather
// than one shape with nullable halves: the cases have nothing in common beyond
// the discriminator, and a router that has to check which fields are present is
// a router that will one day check the wrong one.
//
// There is NO redirect outcome. ADR §8 Amendment 3 rule 2: a renamed or released
// name stops answering at once, so a retired hostname is the same 404 as one
// that never existed. A workspace host no longer lists projects either — the
// address decision (MOTIR-9790) moves them to `motir.co/p/<identifier>` and
// gives the bare workspace host to the workspace's default application. No
// application record exists yet, so every live workspace host answers
// `no_application`; the `application` outcome is owed with that record.

/** A live workspace host with no application to serve yet. */
export interface PublicHostNoApplicationDto {
  readonly kind: 'no_application';
  readonly workspace: { readonly name: string };
}

/**
 * What a `Host` answers. The `project` outcome is retired (ADR MOTIR-9521 §1:
 * a customer domain serves an application, never a project).
 */
export type PublicHostResolutionDto = PublicHostNoApplicationDto;

/**
 * A project's addresses, as the renderer needs them (ADR §7).
 *
 * `primary` is the one canonical URL — what `<link rel="canonical">`, `og:url`,
 * the JSON-LD `@id`, the sitemap entry and the feed all name. `alternates` is
 * every OTHER live address for the same project, which the router 301s to the
 * primary.
 */
export interface PublicProjectAddressesDto {
  readonly primary: string;
  readonly alternates: readonly string[];
}

/** One DNS record a customer must create, as the pane renders it. */
export interface DnsInstructionDto {
  readonly type: 'A' | 'AAAA' | 'CNAME' | 'TXT';
  readonly name: string;
  readonly value: string;
}

/**
 * One customer domain, as the settings pane renders it (MOTIR-4216).
 *
 * `status` crosses the wire as the store's enum, TOTAL — the pane draws one row
 * per value (`design/projects/public-address.mock.html` panel 5), so a value
 * added here without a drawn meaning is a state a customer meets with no
 * explanation and no action.
 */
export interface PublicAddressDto {
  readonly id: string;
  readonly kind: 'workspace_subdomain' | 'workspace_subdomain_alias' | 'custom_domain';
  readonly hostname: string;
  readonly status:
    | 'active'
    | 'alias'
    | 'unverified'
    | 'verifying'
    | 'pending_certificate'
    | 'issued'
    | 'failed'
    | 'expired'
    | 'revoked';
  /** The application a customer domain serves; null when unbound (ADR MOTIR-9521 §1). */
  readonly applicationId: string | null;
  /** The ownership `TXT` — null once it no longer needs showing. */
  readonly verification: { readonly name: string; readonly value: string } | null;
  /** The records that point the hostname at us. */
  readonly dns: readonly DnsInstructionDto[];
  readonly lastCheckedAt: string | null;
  readonly issuedAt: string | null;
  /** Always set when `status` is `failed` — a failure with no reason is not actionable. */
  readonly failureReason: string | null;
}
