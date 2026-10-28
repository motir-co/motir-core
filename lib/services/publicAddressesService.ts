import { isCloud } from '@/lib/billing/availability';
import type { PublicHostResolutionDto, PublicProjectAddressesDto } from '@/lib/dto/publicAddresses';
import { PublicAddressesUnavailableError } from '@/lib/publicAddresses/errors';
import { isTenantDomainConfigured, tenantBaseDomain } from '@/lib/publicAddresses/tenantDomain';
import { publicProjectPath, publicSiteOrigin } from '@/lib/publicProjects/urls';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';

// HOST RESOLUTION — Story MOTIR-3878 · Subtask MOTIR-4217.
//
// The one anonymous read `motir-marketing`'s router (MOTIR-4220) makes to turn a
// `Host` header into something to render. This is the PRODUCER end of a
// two-ended integration; the consumer lives in the other repository.
//
// ── Anonymous by construction, and that is a decision the RLS enforces ─────
//
// Every read here goes through the `db` singleton with no workspace bound,
// because the whole question is which tenant a hostname belongs to and binding
// one first would presume the answer. What keeps that safe is not care taken
// here — it is the migration's `public_address_public_read` arm, which admits a
// row only when what it POINTS AT is public. A private project's domain
// resolves to `null` in this file without this file knowing why.
//
// ── One refusal shape, for every reason ───────────────────────────────────
//
// An unknown host, a host whose certificate has not issued, the base domain
// itself, and `motir.co` all answer the SAME 404. That is deliberate: a bot
// walking hostnames must not be able to tell "no such tenant" from "a tenant
// exists but is not serving yet", and the difference is exactly what would make
// enumeration worth doing.

/** A resolution that found nothing to serve. The route answers 404. */
export class PublicHostNotFoundError extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor() {
    super('Not found.');
    this.name = 'PublicHostNotFoundError';
  }
}

/**
 * Normalise a `Host` header into a bare hostname, or `null` if it is not one.
 *
 * ⚠️ REFUSES rather than repairs. A value carrying a scheme, a path, spaces or
 * a `@` is not a hostname somebody typed slightly wrong — it is a value that
 * reached this function from somewhere it should not have, and salvaging it
 * into "something nearby" is the shape `returnTarget.ts`'s header argues
 * against at length. A PORT is the one thing stripped, because `Host` carries
 * one legitimately (`example.com:443`).
 */
export function normaliseHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const withoutPort = trimmed.replace(/:\d+$/, '');
  // A hostname is labels joined by dots. Anything else — a scheme, a slash, a
  // space, credentials, a bracketed IPv6 literal — is refused.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(withoutPort)) {
    return null;
  }
  return withoutPort;
}

export const publicAddressesService = {
  /**
   * Resolve a `Host` header to what should be rendered at it.
   *
   * Throws {@link PublicHostNotFoundError} for everything that is not a live
   * tenant address — see the one-refusal-shape note above.
   */
  async resolveHost(rawHost: string): Promise<PublicHostResolutionDto> {
    if (!isCloud()) throw new PublicAddressesUnavailableError();

    const host = normaliseHost(rawHost);
    if (!host) throw new PublicHostNotFoundError();

    // The BASE domain itself is not a tenant address. It has no row, so it would
    // 404 anyway — but saying so here means the answer does not depend on the
    // absence of a row somebody could one day create.
    if (isTenantDomainConfigured() && host === tenantBaseDomain()) {
      throw new PublicHostNotFoundError();
    }

    const address = await publicAddressRepository.findByHostname(host);
    if (!address) throw new PublicHostNotFoundError();

    if (address.kind === 'workspace_subdomain') {
      const workspace = await projectRepository.findWorkspaceNameForPublic(address.workspaceId);
      if (!workspace) throw new PublicHostNotFoundError();
      // The address decision (MOTIR-9790) gives the bare workspace host to the
      // workspace's default application. No application record exists yet, so
      // the only honest answer for a live host is that it has none to serve —
      // the `application` outcome arrives with the record.
      return { kind: 'no_application', workspace: { name: workspace } };
    }

    // ⚠️ A RETIRED NAME NEVER ANSWERS (ADR §8 Amendment 3 rule 2). A rename or
    // release deletes the row, so a retired hostname has none — but a
    // `workspace_subdomain_alias` row left over from the retired never-released
    // design is dormant data, and it must 404 like any other unknown host rather
    // than redirect or fall through into the custom-domain branch below. So this
    // admits only the one kind that branch is written for.
    if (address.kind !== 'custom_domain') throw new PublicHostNotFoundError();

    // A custom domain serves only once its certificate is ISSUED. Every other
    // status — unverified, verifying, pending, failed, expired, revoked — is a
    // domain that does not answer, and they share the 404 so a customer's
    // half-configured domain does not advertise itself.
    if (address.status !== 'issued' || !address.projectId) throw new PublicHostNotFoundError();

    const project = await projectRepository.findPublicByIdInternal(address.projectId);
    if (!project) throw new PublicHostNotFoundError();

    return {
      kind: 'project',
      project: { identifier: project.identifier, name: project.name },
      primary: project.primaryAddressId === address.id,
    };
  },

  /**
   * The canonical HOST for each of several projects, in TWO queries — the crawl
   * index's per-row need (MOTIR-4217).
   *
   * Same rule as {@link addressesForProject}, reduced to the host and batched:
   * a promoted custom domain wins, else the workspace subdomain, else the
   * default public site. Returns a map keyed by project id; a project absent
   * from it takes the caller's default.
   */
  async primaryHostsForProjects(
    projects: ReadonlyArray<{ id: string; workspaceId: string; identifier: string }>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (projects.length === 0 || !isCloud() || !isTenantDomainConfigured()) return out;

    const workspaceIds = [...new Set(projects.map((p) => p.workspaceId))];
    const addresses = await publicAddressRepository.listForWorkspaces(workspaceIds);
    if (addresses.length === 0) return out;

    const primaryIds = await projectRepository.listPrimaryAddressIds(projects.map((p) => p.id));

    // Index once rather than scanning the address list per project — the
    // difference between O(projects x addresses) and O(projects + addresses),
    // which matters exactly at the page size this exists to serve.
    const subdomainByWorkspace = new Map<string, string>();
    const customById = new Map<string, string>();
    for (const a of addresses) {
      if (a.kind === 'workspace_subdomain') subdomainByWorkspace.set(a.workspaceId, a.hostname);
      else if (a.kind === 'custom_domain' && a.status === 'issued')
        customById.set(a.id, a.hostname);
    }

    for (const p of projects) {
      const promotedId = primaryIds.get(p.id);
      const promoted = promotedId ? customById.get(promotedId) : undefined;
      const host = promoted ?? subdomainByWorkspace.get(p.workspaceId);
      if (host) out.set(p.id, host);
    }
    return out;
  },

  /**
   * A project's canonical address and every alternate (ADR §7).
   *
   * THE DEFAULT RULE, and the order is the decision:
   *   1. an explicitly-chosen primary custom domain, if one is set;
   *   2. otherwise the workspace subdomain path, if the workspace claimed one;
   *   3. otherwise `motir.co/p/<identifier>`, which every project always has.
   *
   * Step 3 is why this never returns an empty primary: a project with no
   * addresses at all still has one, and it is the address it has always had.
   */
  async addressesForProject(
    projectId: string,
    workspaceId: string,
    identifier: string,
  ): Promise<PublicProjectAddressesDto> {
    const fallback = `${publicSiteOrigin()}${publicProjectPath(identifier)}`;
    if (!isCloud() || !isTenantDomainConfigured()) {
      return { primary: fallback, alternates: [] };
    }

    const [addresses, project] = await Promise.all([
      publicAddressRepository.listForWorkspace(workspaceId),
      projectRepository.findPublicByIdInternal(projectId),
    ]);

    const urls: string[] = [];
    /** An explicitly-promoted custom domain — rule 1. */
    let promoted: string | null = null;
    /** The workspace subdomain's path for this project — rule 2. */
    let subdomainUrl: string | null = null;

    for (const a of addresses) {
      // A customer domain belongs to ONE project; a subdomain belongs to the
      // workspace and serves every public project under it at a path.
      if (a.kind === 'custom_domain') {
        if (a.projectId !== projectId || a.status !== 'issued') continue;
        const url = `https://${a.hostname}`;
        urls.push(url);
        if (project?.primaryAddressId === a.id) promoted = url;
      } else if (a.kind === 'workspace_subdomain') {
        // ⚠️ `/<identifier>`, NOT `/p/<identifier>` — and the difference is the
        // whole point of the address. A workspace subdomain serves the project
        // at the FIRST path segment (`acme.motir.site/PROD`); `/p/` is the
        // shape `motir.co` uses because that host also carries a landing, an
        // /explore and a /docs that a bare key would collide with.
        //
        // Corrected against the renderer, which is the authority on what a
        // path means: `motir-marketing`'s router (MOTIR-4220) rewrites
        // `/<identifier>` on a subdomain onto its `/p/[identifier]` tree. It
        // also serves `/p/<identifier>` there — it has to, because it sees its
        // own rewrite — so the old value was not BROKEN. It was a canonical
        // pointing at the duplicate rather than at the address, which is
        // exactly the failure `<link rel="canonical">` exists to prevent.
        subdomainUrl = `https://${a.hostname}/${encodeURIComponent(identifier)}`;
        urls.push(subdomainUrl);
      }
      // An ALIAS is deliberately not listed. It is a redirect, not an address
      // the project is reachable AT — listing it would put a permanent redirect
      // into a sitemap.
    }

    const primary = promoted ?? subdomainUrl ?? fallback;
    const alternates = [fallback, ...urls].filter((u) => u !== primary);
    return { primary, alternates };
  },
};
