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

// ── Host resolution (MOTIR-4217) ───────────────────────────────────────────
//
// What `GET /api/public/hosts/{host}` answers. A DISCRIMINATED UNION rather
// than one shape with nullable halves: the three cases have nothing in common
// beyond the discriminator, and a router that has to check which fields are
// present is a router that will one day check the wrong one.

/** A workspace subdomain — the host lists that workspace's public projects. */
export interface PublicHostWorkspaceDto {
  readonly kind: 'workspace';
  readonly workspace: { readonly name: string };
  /** Every public project under it, freshest first. May be empty. */
  readonly projects: ReadonlyArray<{ readonly identifier: string; readonly name: string }>;
}

/**
 * A RETIRED subdomain. The router 301s to `redirectTo` — this is the shape that
 * makes the ADR §8 never-released promise observable to a visitor rather than
 * merely true in the database.
 */
export interface PublicHostAliasDto {
  readonly kind: 'alias';
  /** The live hostname to redirect to. */
  readonly redirectTo: string;
}

/** A customer domain with an issued certificate — it serves ONE project at its root. */
export interface PublicHostProjectDto {
  readonly kind: 'project';
  readonly project: { readonly identifier: string; readonly name: string };
  /** Whether this address is the project's CANONICAL one (ADR §7). */
  readonly primary: boolean;
}

export type PublicHostResolutionDto =
  | PublicHostWorkspaceDto
  | PublicHostAliasDto
  | PublicHostProjectDto;

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
  readonly isPrimary: boolean;
  /** The ownership `TXT` — null once it no longer needs showing. */
  readonly verification: { readonly name: string; readonly value: string } | null;
  /** The records that point the hostname at us. */
  readonly dns: readonly DnsInstructionDto[];
  readonly lastCheckedAt: string | null;
  readonly issuedAt: string | null;
  /** Always set when `status` is `failed` — a failure with no reason is not actionable. */
  readonly failureReason: string | null;
}
