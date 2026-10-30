import { randomBytes } from 'node:crypto';

import type { Prisma } from '@/generated/prisma/client';

import { isCloud } from '@/lib/billing/availability';
import type { DnsInstructionDto, PublicAddressDto } from '@/lib/dto/publicAddresses';
import {
  CertificateProviderRefusedError,
  CertificateProviderUnavailableError,
} from '@/lib/publicAddresses/certificateProvider';
import {
  AddressNotFoundError,
  InvalidHostnameError,
  NotACustomerDomainError,
  PublicAddressesUnavailableError,
} from '@/lib/publicAddresses/errors';
import { pointingRecordsFor } from '@/lib/publicAddresses/pointingRecords';
import {
  certificateProvider,
  dnsResolver,
  seedFakeTxt,
  usingFakePublicAddressProviders,
} from '@/lib/publicAddresses/providers';
import { isTenantDomainConfigured, tenantBaseDomain } from '@/lib/publicAddresses/tenantDomain';
import { publicSiteOrigin } from '@/lib/publicProjects/urls';
import { entitlementsService } from '@/lib/services/entitlementsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE CUSTOMER-DOMAIN LIFECYCLE — Story MOTIR-3878 · Subtask MOTIR-4216.
// add → verify → issue → remove. The state machine is the ADR's §5 (which
// records prove ownership).
//
// ── A customer domain is a WORKSPACE asset (ADR MOTIR-9521 §1) ─────────────
//
// It names at most one application, never a project, and there is no primary:
// the product's single link is the application's production address, else its
// earliest-issued domain. The pane still lives in a project's settings, so the
// routes still carry a project key and the gate is still that project's
// `project:manage_access` (`project:browse` to list) — the key authorises the
// actor, it no longer scopes the rows.
//
// ── ⚠️ EVERY SIDE EFFECT SITS OUTSIDE ITS TRANSACTION ─────────────────────
//
// `CLAUDE.md`'s side-effects-outside-tx rule, and here it is not a style point:
// a DNS lookup and a certificate request are seconds-long calls to systems we do
// not control. Holding a Postgres transaction open across one means holding a
// row lock across a third party's latency, and a slow platform becomes a
// database incident. So each operation is: read → (commit) → call out →
// (short write). The tests assert the ORDER, not merely the outcome.
//
// ── The ownership TXT is checked BEFORE any certificate is requested ──────
//
// ADR §5's order is strict, and it is a security property rather than a nicety:
// anyone can point a hostname at us, so pointing is not proof. The `TXT` is the
// only step that needs write access to the customer's zone, which is what
// ownership actually means. A certificate is never requested for a hostname
// whose owner has not proven that.

/** The label the ownership TXT lives at. */
const VERIFY_PREFIX = '_motir-verify';

export interface DomainScopedInput {
  /** The project KEY ("PROD") the pane was opened from — the permission gate. */
  key: string;
  addressId: string;
  actorUserId: string;
  ctx: { workspaceId: string };
}

export interface ProjectScopedInput {
  /** The project KEY ("PROD"), as the route receives it. */
  key: string;
  actorUserId: string;
  ctx: { workspaceId: string };
}

export const customDomainService = {
  /** Every customer domain of the workspace, as the pane renders them. */
  async list(input: ProjectScopedInput): Promise<PublicAddressDto[]> {
    assertAvailable();
    return withWorkspaceContext(
      { userId: input.actorUserId, workspaceId: input.ctx.workspaceId },
      async (tx) => {
        const project = await resolveProject(input, tx);
        await projectAccessService.assertPermission(
          project.id,
          { userId: input.actorUserId, workspaceId: input.ctx.workspaceId },
          'project:browse',
          tx,
        );
        const rows = await publicAddressRepository.listCustomDomainsForWorkspaceInTx(
          input.ctx.workspaceId,
          tx,
        );
        return rows.map(toDto);
      },
    );
  },

  /**
   * Connect a customer domain. One transaction: the cap assert (which locks the
   * org row) and the create, so the count cannot be raced.
   */
  async add(input: ProjectScopedInput & { hostname: string }): Promise<PublicAddressDto> {
    assertAvailable();
    const hostname = normaliseCustomHostname(input.hostname);

    return withWorkspaceContext(
      { userId: input.actorUserId, workspaceId: input.ctx.workspaceId },
      async (tx) => {
        const project = await resolveProject(input, tx);
        await projectAccessService.assertPermission(
          project.id,
          { userId: input.actorUserId, workspaceId: input.ctx.workspaceId },
          'project:manage_access',
          tx,
        );
        // ⚠️ INSIDE this transaction, which is the cap's own contract: it locks
        // the org row and counts under the lock, and a lock released before the
        // write it guards is not a lock.
        const organizationId = await workspaceRepository.findOrganizationId(
          input.ctx.workspaceId,
          tx,
        );
        if (organizationId) {
          await entitlementsService.assertCanAddCustomDomain(organizationId, tx);
        }
        const row = await publicAddressRepository.createCustomDomain(
          {
            workspaceId: input.ctx.workspaceId,
            applicationId: null,
            hostname,
            verificationToken: mintToken(),
          },
          tx,
        );
        const dto = toDto(row);
        // ⚠️ THE FAKE RESOLVER IS SEEDED HERE, AND ONLY HERE (MOTIR-4225).
        // `providers.ts` says the lane "seeds it through `seedFakeTxt` as the
        // address is created, so the verify step reads back the token the
        // service just minted — which is what the real flow does, with the
        // customer in between". Nothing did: `seedFakeTxt` had NO caller
        // anywhere in the product, so the in-memory resolver always answered
        // `[]` and no browser lane could drive a domain past `unverified` — the
        // seam existed and was inert, which is the shape that keeps a lane
        // permanently green about a state it never reaches.
        //
        // It is guarded on the SAME predicate that binds the fakes, so a real
        // deployment never reaches this line: the production resolver reads
        // public DNS and there is nothing to seed.
        if (usingFakePublicAddressProviders() && dto.verification) {
          seedFakeTxt(dto.verification.name, [dto.verification.value]);
        }
        return dto;
      },
    );
  },

  /**
   * Prove ownership, then ask the platform for a certificate.
   *
   * THREE writes, each short and each AFTER the call it records — never around
   * it. The DNS lookup and the certificate request are the slow parts and they
   * happen with no transaction open.
   */
  async verify(input: DomainScopedInput): Promise<PublicAddressDto> {
    assertAvailable();
    const { address } = await this.loadForWrite(input);
    const name = `${VERIFY_PREFIX}.${address.hostname}`;

    // ── outside any transaction ──
    const records = await dnsResolver().resolveTxt(name);
    const proven =
      address.verificationToken !== null && records.includes(address.verificationToken);

    if (!proven) {
      // Stays `unverified`, with a reason the pane can render. NOT `failed`:
      // failed means we asked and were refused; this means the customer has not
      // finished, which is an ordinary state on the way in.
      const row = await this.patch(input, {
        status: 'unverified',
        failureReason: records.length
          ? `Found a ${VERIFY_PREFIX} record, but not the expected value.`
          : `No ${VERIFY_PREFIX} TXT record found at ${name}. DNS changes can take a few minutes.`,
        lastCheckedAt: new Date(),
      });
      return toDto(row);
    }

    try {
      const provider = await certificateProvider();
      const state = await provider.request(address.hostname);
      const row = await this.patch(input, {
        status: state.issued ? 'issued' : 'pending_certificate',
        failureReason: null,
        lastCheckedAt: state.checkedAt,
        ...(state.issued ? { issuedAt: new Date() } : {}),
      });
      return toDto(row);
    } catch (err) {
      if (err instanceof CertificateProviderUnavailableError) {
        // The platform is down. NOT the customer's problem and not a state
        // change — retrying is the answer, so the row stays where it was.
        throw err;
      }
      const reason =
        err instanceof CertificateProviderRefusedError
          ? err.reason
          : 'The certificate request failed.';
      const row = await this.patch(input, {
        status: 'failed',
        failureReason: reason,
        lastCheckedAt: new Date(),
      });
      return toDto(row);
    }
  },

  /**
   * Remove a domain: delete the row, THEN withdraw the certificate.
   *
   * ⚠️ THE PLATFORM CALL COMES AFTER THE COMMIT AND MAY FAIL WITHOUT FAILING THE
   * REQUEST. The row is the source of truth for what we serve; once it is gone
   * the address answers nothing, so a certificate left behind on the platform
   * protects nothing and grants nothing — it is for a hostname that no longer
   * points at us, and Fly stops renewing a certificate whose hostname stops
   * validating. Failing the customer's request over that would be reporting a
   * cleanup problem as a user error.
   */
  async remove(input: DomainScopedInput): Promise<void> {
    assertAvailable();
    const { address } = await this.loadForWrite(input);

    await withWorkspaceContext(
      { userId: input.actorUserId, workspaceId: input.ctx.workspaceId },
      (tx) => publicAddressRepository.remove(address.id, tx),
    );

    try {
      const provider = await certificateProvider();
      await provider.remove(address.hostname);
    } catch (err) {
      // Logged with the hostname so the leftover is findable, and swallowed.
      console.warn(
        `[public-addresses] removed ${address.hostname} from the store but the certificate withdrawal failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  },

  // ── internals, exposed on the object so tests can spy the ordering ──────

  /** Load the customer domain, asserting the manage permission. */
  async loadForWrite(input: DomainScopedInput) {
    return withWorkspaceContext(
      { userId: input.actorUserId, workspaceId: input.ctx.workspaceId },
      async (tx) => {
        const address = await publicAddressRepository.findByIdInTx(input.addressId, tx);
        const project = await resolveProject(input, tx);
        await projectAccessService.assertPermission(
          project.id,
          { userId: input.actorUserId, workspaceId: input.ctx.workspaceId },
          'project:manage_access',
          tx,
        );
        if (
          !address ||
          address.kind !== 'custom_domain' ||
          address.workspaceId !== input.ctx.workspaceId
        ) {
          throw new AddressNotFoundError();
        }
        return { address };
      },
    );
  },

  /** One short write, after the side effect it records. */
  async patch(
    input: DomainScopedInput,
    data: Parameters<typeof publicAddressRepository.updateStatus>[1],
  ) {
    return withWorkspaceContext(
      { userId: input.actorUserId, workspaceId: input.ctx.workspaceId },
      (tx) => publicAddressRepository.updateStatus(input.addressId, data, tx),
    );
  },
};

// ── helpers ────────────────────────────────────────────────────────────────

function assertAvailable(): void {
  if (!isCloud()) throw new PublicAddressesUnavailableError();
}

async function resolveProject(
  input: { key: string; ctx: { workspaceId: string } },
  tx: Prisma.TransactionClient,
) {
  const project = await projectRepository.findByIdentifier(input.ctx.workspaceId, input.key, tx);
  if (!project) throw new AddressNotFoundError();
  return project;
}

/** 32 bytes of randomness, base64url — long enough that guessing is not a path. */
function mintToken(): string {
  return `motir-verify-${randomBytes(24).toString('base64url')}`;
}

/**
 * Normalise and REFUSE — never repair.
 *
 * Refuses our own addresses explicitly, and with their own error: connecting
 * `acme.motir.site` would add a row for something the wildcard already serves,
 * and its certificate request would collide with the wildcard or sit pending
 * for ever. Telling the customer *you already have this address* is a different
 * sentence from *that name is taken*.
 */
export function normaliseCustomHostname(raw: string): string {
  const host = raw.trim().toLowerCase().replace(/\.+$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    throw new InvalidHostnameError(raw);
  }
  if (isTenantDomainConfigured()) {
    const base = tenantBaseDomain();
    if (host === base || host.endsWith(`.${base}`)) throw new NotACustomerDomainError(host);
  }
  const site = new URL(publicSiteOrigin()).hostname;
  if (host === site || host.endsWith(`.${site}`)) throw new NotACustomerDomainError(host);
  return host;
}

function toDto(row: {
  id: string;
  applicationId: string | null;
  kind: string;
  hostname: string;
  status: string;
  verificationToken: string | null;
  lastCheckedAt: Date | null;
  issuedAt: Date | null;
  failureReason: string | null;
}): PublicAddressDto {
  // ⚠️ TWO KINDS OF RECORD, AND THE POINTING ONE COMES FIRST (MOTIR-4278).
  //
  // The record that POINTS the hostname at us — a `CNAME` for a subdomain,
  // `A` + `AAAA` for an apex (ADR §5's table) — is configuration, so it is the
  // same for every customer and is derivable with no provider reading. It is
  // listed first because it is the record that makes the address WORK, and
  // because that is the order `design/projects/public-address.mock.html`
  // panel 4 draws.
  //
  // It is NOT dropped once the certificate issues, unlike the ownership record
  // below: it describes the live configuration rather than an outstanding task,
  // and a customer auditing their zone months later is the reader it is for.
  //
  // Only a CUSTOMER domain has one. A workspace subdomain is a name under our
  // own base, already served and already covered by the wildcard (ADR §6) — the
  // customer creates nothing for it.
  const dns: DnsInstructionDto[] =
    row.kind === 'custom_domain' ? pointingRecordsFor(row.hostname) : [];

  // The ownership record is shown while it still has to be created, and dropped
  // once the certificate is live — a record a customer no longer needs is
  // clutter that reads like an outstanding task.
  const verification =
    row.verificationToken && row.status !== 'issued'
      ? { name: `${VERIFY_PREFIX}.${row.hostname}`, value: row.verificationToken }
      : null;
  if (verification) dns.push({ type: 'TXT', ...verification });

  return {
    id: row.id,
    kind: row.kind as PublicAddressDto['kind'],
    hostname: row.hostname,
    status: row.status as PublicAddressDto['status'],
    applicationId: row.applicationId,
    verification,
    dns,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    failureReason: row.failureReason,
  };
}
