import { isCloud } from '@/lib/billing/availability';
import type { PublicHostResolutionDto, PublicProjectAddressesDto } from '@/lib/dto/publicAddresses';
import { resolveApplicationTarget } from '@/lib/publicAddresses/applicationTarget';
import { PublicAddressesUnavailableError } from '@/lib/publicAddresses/errors';
import { isTenantDomainConfigured, tenantBaseDomain } from '@/lib/publicAddresses/tenantDomain';
import { publicProjectPath, publicSiteOrigin } from '@/lib/publicProjects/urls';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { withSystemContext } from '@/lib/workspaces/context';

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
// workspace subdomain only when its workspace has a public project, and a
// customer domain only once its certificate is issued (MOTIR-9523). Anything
// else resolves to `null` in this file without this file knowing why.
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
  async resolveHost(
    rawHost: string,
    options: { credentialed: boolean } = { credentialed: false },
  ): Promise<PublicHostResolutionDto> {
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
    if (address.status !== 'issued') throw new PublicHostNotFoundError();

    // A customer domain is a workspace asset naming at most one APPLICATION, and
    // never a project (ADR MOTIR-9521 §1, §3). The reads are a NARROW system
    // read: the contract is anonymous, the row already proved the workspace,
    // and the workspace's name must answer whatever its projects' visibility.
    const { workspace, application } = await withSystemContext(async (tx) => ({
      workspace: await workspaceRepository.findByIdInTx(address.workspaceId, tx),
      application: address.applicationId
        ? await hostedApplicationRepository.findForHostContract(address.applicationId, tx)
        : null,
    }));
    if (!workspace) throw new PublicHostNotFoundError();
    const noApplication = { kind: 'no_application', workspace: { name: workspace.name } } as const;

    // Unbound, someone else's (never, by the FK and the add check — but the
    // contract does not take that on trust), or no production release yet.
    if (
      !application ||
      application.workspaceId !== address.workspaceId ||
      !application.currentReleaseId
    ) {
      return noApplication;
    }

    const answer = {
      kind: 'application',
      workspace: { name: workspace.name },
      application: { id: application.id, slug: application.slug },
    } as const;
    if (!options.credentialed) return answer;

    // ⚠️ THE UPSTREAM GOES ONLY TO THE EDGE. Asking the target for it is also
    // only done for the edge: a Fly upstream wakes on any request.
    const upstream = await resolveApplicationTarget(application);
    // A release Motir records but the target no longer serves has nowhere to go.
    if (!upstream) return noApplication;
    return { ...answer, upstream };
  },

  /**
   * The canonical HOST for each of several projects — the crawl index's
   * per-row need (MOTIR-4217). A project absent from the map takes the
   * caller's default.
   *
   * ⚠️ ALWAYS EMPTY NOW, and that is the rule rather than a stub. A customer
   * domain serves an application, never a project (ADR MOTIR-9521 §1), and a
   * workspace subdomain serves no project path (MOTIR-9790) — so no address
   * Motir holds is ever a project's canonical host. It keeps its signature so
   * the index's caller does not change shape with the rule.
   */
  async primaryHostsForProjects(
    _projects: ReadonlyArray<{ id: string; workspaceId: string; identifier: string }>,
  ): Promise<Map<string, string>> {
    return new Map();
  },

  /**
   * A project's canonical address and every alternate (ADR §7).
   *
   * Every project's canonical is `motir.co/p/<identifier>`, and it has no
   * alternates: a customer domain serves an application, never a project (ADR
   * MOTIR-9521 §1, which retires the *primary* customer domain), and the bare
   * workspace host belongs to the workspace's default application (MOTIR-9790),
   * so `acme.motir.site/ACME` is a 404 — a canonical or a sitemap entry naming
   * it would send readers and crawlers to a page that does not exist.
   */
  async addressesForProject(
    _projectId: string,
    _workspaceId: string,
    identifier: string,
  ): Promise<PublicProjectAddressesDto> {
    return { primary: `${publicSiteOrigin()}${publicProjectPath(identifier)}`, alternates: [] };
  },
};
