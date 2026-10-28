import type { Prisma, WorkspaceRole } from '@/generated/prisma/client';

import { isCloud } from '@/lib/billing/availability';
import type { PublicSubdomainDto, RetiredSubdomainDto } from '@/lib/dto/publicAddresses';
import {
  HostnameTakenError,
  NoSubdomainClaimedError,
  PublicAddressesUnavailableError,
  ReservedLabelError,
  SubdomainForbiddenError,
  SubdomainNotFoundError,
  SubdomainRenameCapReachedError,
  WorkspaceNotVisibleError,
} from '@/lib/publicAddresses/errors';
import {
  hostnameReservationHash,
  reservesItsHostname,
} from '@/lib/publicAddresses/hostnameReservation';
import { addDays, QUARANTINE_DAYS } from '@/lib/publicAddresses/nameHold';
import { MAX_SUBDOMAIN_RENAMES, refuseLabel } from '@/lib/publicAddresses/reservedNames';
import { tenantBaseDomain, tenantHostname } from '@/lib/publicAddresses/tenantDomain';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import { publicHostnameReservationRepository } from '@/lib/repositories/publicHostnameReservationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { readReachRole } from '@/lib/workspaces/membershipGate';
import { isWorkspaceManager } from '@/lib/projects/roles';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// A WORKSPACE'S TENANT SUBDOMAIN — claim it, rename it, read it back.
// Story MOTIR-3878 · Subtask MOTIR-4215. `docs/decisions/public-tenant-addresses.md`
// §3 (a subdomain names a WORKSPACE), §8 (never released, capped), §11 (cloud).
//
// This is the FREE tier's address and it works on every tier. Custom domains are
// MOTIR-4216's; nothing here touches a certificate, because the wildcard
// `*.<base>` already covers every label (ADR §6) — claiming one writes a row,
// and RELEASING one deletes a row. `customDomainService.remove` DOES call the
// provider, and it is the nearest neighbour to this file's `release`; copying it
// would ask Fly to withdraw a certificate for a hostname it never issued one for.
//
// ── RELEASE (ADR §8 AMENDMENT 2 · Story MOTIR-4451 · Subtask MOTIR-4454) ────
//
// §8's never-released rule is about who may take a name NEXT, not about who must
// keep SERVING it — `reservesItsHostname`'s own comment says so — so a workspace
// may give its subdomain back while the NAME stays out of the namespace for ever.
// The workspace delete (`deleteWorkspaceCascade`) already had this shape scoped to a whole
// workspace (list → filter `reservesItsHostname` → `reserveMany` → delete, one
// transaction); `release` is that path narrowed from *the workspace is going* to
// *the subdomain is going*, and it follows it deliberately rather than by
// coincidence.
//
// ── AUTHORISATION: a WORKSPACE resource, not a project one ─────────────────
//
// The address names the workspace, so the gate is the WORKSPACE ROLE — the
// Manager (Story MOTIR-6168; the legacy `owner` / `admin` both resolve to it,
// and so does the org Owner or an org Admin) — and NOT project `canManage`. A
// project admin who is an ordinary member of the workspace must not be able to
// rename an address every other project in that workspace answers under.
//
// The two refusals are deliberately different: a MEMBER gets 403 (they can see
// the workspace, so telling them the control is admin-only leaks nothing and is
// the answer they need), a NON-MEMBER gets 404 (the no-existence-leak posture
// the rest of the tenancy boundary takes).
//
// ── CONCURRENCY: lock the WORKSPACE row, then read ─────────────────────────
//
// Two admins claiming at once is the warm-pool TOCTOU `entitlementsService`'s
// header describes. The workspace row is the single row all of one workspace's
// claims contend on, so it is the anchor — and the `hostname` unique index is
// the SECOND line of defence for the cross-workspace race the row lock cannot
// see (two different workspaces claiming one label lock two different rows).
// Both are needed and neither is redundant.

/**
 * Whether a workspace ROLE may change the address — the predicate the settings
 * pane's read-only arm asks (MOTIR-4221, design panel 8).
 *
 * ⚠️ EXPORTED SO THE RULE HAS ONE HOME. The pane has to decide whether to render
 * controls at all, and the alternative was a second `['owner', 'admin']` in a
 * page component — a copy of a security-shaped rule that drifts silently, since
 * the copy going stale shows up as controls that appear and then refuse. This is
 * presentation only: {@link assertAddressAdmin} still enforces on every write.
 */
export function roleMayManageAddress(role: WorkspaceRole | null | undefined): boolean {
  return isWorkspaceManager(role);
}

export const publicSubdomainService = {
  /**
   * The workspace's subdomain, or `null` when it has never claimed one.
   *
   * Readable by any workspace member — an address is not a secret from the team
   * that answers at it, and the pane needs it to render the read-only arm.
   */
  async getForWorkspace(
    workspaceId: string,
    actorUserId: string,
  ): Promise<PublicSubdomainDto | null> {
    assertAvailable();
    await assertMember(workspaceId, actorUserId);
    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      const addresses = await publicAddressRepository.listForWorkspaceInTx(workspaceId, tx);
      return toDto(addresses, await reservedCount(workspaceId, tx));
    });
  },

  /**
   * Claim a label for a workspace that has none.
   *
   * ONE transaction: lock, re-read under the lock, validate, write. The re-read
   * is the point of the lock — a claim decided from a read taken before it is a
   * decision about a state that may already be gone.
   */
  async claim(
    workspaceId: string,
    label: string,
    actorUserId: string,
  ): Promise<PublicSubdomainDto> {
    assertAvailable();
    await assertAddressAdmin(workspaceId, actorUserId);
    assertLabelClaimable(label);

    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      await lockWorkspaceOrRefuse(workspaceId, tx);
      const live = await publicAddressRepository.findLiveSubdomainForWorkspace(workspaceId, tx);
      if (live) {
        // Already claimed — a claim is not a rename, and quietly turning one
        // into the other would spend a rename from the cap without saying so.
        throw new HostnameTakenError(live.hostname);
      }
      const hostname = tenantHostname(label);
      await publicAddressRepository.createSubdomain({ workspaceId, hostname }, tx);
      await assertNotReserved(hostname, tx);
      const addresses = await publicAddressRepository.listForWorkspaceInTx(workspaceId, tx);
      return toDto(addresses, await reservedCount(workspaceId, tx))!;
    });
  },

  /**
   * Rename the workspace's subdomain, retaining the old label FOR EVER.
   *
   * The retirement and the new claim are ONE transaction, so there is no instant
   * at which the workspace has two live subdomains or none.
   */
  async rename(
    workspaceId: string,
    newLabel: string,
    actorUserId: string,
  ): Promise<PublicSubdomainDto> {
    assertAvailable();
    await assertAddressAdmin(workspaceId, actorUserId);
    assertLabelClaimable(newLabel);

    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      await lockWorkspaceOrRefuse(workspaceId, tx);
      const live = await publicAddressRepository.findLiveSubdomainForWorkspace(workspaceId, tx);
      if (!live) throw new NoSubdomainClaimedError();

      const reserved = await reservedCount(workspaceId, tx);
      const used =
        (await publicAddressRepository.countAliasesForWorkspace(workspaceId, tx)) + reserved;
      if (used >= MAX_SUBDOMAIN_RENAMES) {
        throw new SubdomainRenameCapReachedError(used, MAX_SUBDOMAIN_RENAMES);
      }

      const hostname = tenantHostname(newLabel);
      if (hostname === live.hostname) {
        // Renaming to the name you already hold would burn a rename from the cap
        // and write an alias row pointing at itself. Refused as taken, which is
        // what it is.
        throw new HostnameTakenError(hostname);
      }

      // ORDER MATTERS: retire first, then claim. The reverse would hold two
      // `workspace_subdomain` rows for an instant — a state
      // `findLiveSubdomainForWorkspace` resolves arbitrarily.
      await publicAddressRepository.retireSubdomainToAlias(live.id, tx);
      await publicAddressRepository.createSubdomain({ workspaceId, hostname }, tx);
      await assertNotReserved(hostname, tx);

      const addresses = await publicAddressRepository.listForWorkspaceInTx(workspaceId, tx);
      return toDto(addresses, reserved)!;
    });
  },

  /**
   * RELEASE the workspace's subdomain — the live label AND every retained alias
   * (ADR §8 Amendment 2, MOTIR-4454).
   *
   * ONE transaction, and the ORDER inside it is the whole safety argument:
   * **reserve, then delete.** The reservation is the only reason a release is
   * permitted at all — it is what keeps §8's protection while the address goes —
   * so a release that committed the delete and lost the reserve would hand the
   * label back to the global namespace, which is the exact outcome §8 exists to
   * prevent. And it would be unrepairable: the row that knew the hostname is the
   * row that was deleted, and the table deliberately stores a digest we cannot
   * read back. Reserving first means a failing reserve rolls the delete back with
   * it and the workspace keeps its address.
   *
   * The rows are chosen by `reservesItsHostname`, never by a hand-written kind
   * list. That predicate is where the custom-domain exclusion lives, and it
   * carries its own reason: a customer's domain is theirs whatever happens to
   * their Motir account, so reserving it would be a hostage rather than a
   * protection. A workspace with custom domains keeps every one of them, and a
   * promoted one stays the project's canonical.
   *
   * ⚠️ NO CERTIFICATE CALL, and the temptation is structural rather than
   * hypothetical: the nearest neighbour to this method is
   * `customDomainService.remove`, which withdraws a certificate post-commit. A
   * workspace subdomain is covered by the wildcard `*.<base>` (ADR §6) — claiming
   * one issues nothing, so releasing one withdraws nothing, and asking Fly about
   * a hostname it never certificated is a call that can only fail.
   *
   * ⚠️ NO `setPrimary(null)` SWEEP either. `project.primary_address_id` is
   * `ON DELETE SET NULL` (`schema.prisma`'s own comment on the relation), so a
   * project whose primary this was falls back to §7's default — `motir.co/p/<id>`
   * — on its own. A hand-run sweep here would be a second copy of a constraint
   * the database already holds, and the test asserts the fallback instead.
   */
  async release(workspaceId: string, actorUserId: string): Promise<void> {
    assertAvailable();
    await assertAddressAdmin(workspaceId, actorUserId);

    await withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      await lockWorkspaceOrRefuse(workspaceId, tx);
      const rows = (await publicAddressRepository.listForWorkspaceInTx(workspaceId, tx)).filter(
        (address) => reservesItsHostname(address.kind),
      );
      // Nothing claimed. A DELETE names a resource, so this is a 404 and NOT the
      // rename path's 409 — `SubdomainNotFoundError` carries that reasoning.
      if (rows.length === 0) throw new SubdomainNotFoundError();

      const now = new Date();
      await publicHostnameReservationRepository.reserveMany(
        rows.map((address) => ({
          hostnameHash: hostnameReservationHash(address.hostname),
          retiredFromWorkspaceId: workspaceId,
          expiresAt: addDays(now, QUARANTINE_DAYS),
        })),
        now,
        tx,
      );
      await publicAddressRepository.removeMany(
        rows.map((address) => address.id),
        tx,
      );
    });
  },
};

// ── Internals ──────────────────────────────────────────────────────────────

/**
 * How many hostnames this workspace has RETIRED into the reservation table — the
 * SECOND term of the ADR §8 rename cap, as Amendment 2 restates it.
 *
 * The ADR line this implements, quoted (`docs/decisions/public-tenant-addresses.md`
 * §8 Amendment 2, *The rename cap: releasing does NOT reset it*):
 *
 * > `renamesLeft = MAX_SUBDOMAIN_RENAMES − (aliases held + hostnames this
 * > workspace has reserved)`
 *
 * So the cap counts names BURNT out of a shared namespace, not alias ROWS. Those were the
 * same number for as long as the only way to stop holding an alias was to delete
 * the whole workspace. A release deletes the rows while the workspace survives,
 * so a cap reading only them is handed back in full on every release, and
 * `claim → rename ×5 → release`, repeated, burns names without bound — giving
 * back at the exit exactly what the cap holds at the door.
 *
 * ⚠️ IT CHARGES THE RELEASED LIVE LABEL TOO, and that is Amendment 2's stated
 * choice rather than an off-by-one: the live label is permanently burnt as surely
 * as an alias is, so a workspace that claims once and releases once has spent one
 * of its five. Not charging it would need a column on the reservation table
 * marking which kind a row came from, existing only to make the cap kinder.
 *
 * For a workspace that has never released this is `0`, so every derived number
 * is byte-for-byte what it was before Amendment 2.
 */
async function reservedCount(workspaceId: string, tx: Prisma.TransactionClient): Promise<number> {
  return publicHostnameReservationRepository.countForWorkspaceInTx(workspaceId, tx);
}

/** Public addresses are a cloud capability — ABSENT off-cloud, not hidden. */
function assertAvailable(): void {
  if (!isCloud()) throw new PublicAddressesUnavailableError();
}

async function assertMember(workspaceId: string, actorUserId: string): Promise<WorkspaceRole> {
  // The org Owner or an org Admin reads as `manager` in every workspace of the org.
  const role = await readReachRole(actorUserId, workspaceId);
  if (!role) throw new WorkspaceNotVisibleError();
  return role;
}

async function assertAddressAdmin(workspaceId: string, actorUserId: string): Promise<void> {
  const role = await assertMember(workspaceId, actorUserId);
  if (!roleMayManageAddress(role)) throw new SubdomainForbiddenError();
}

/** Refuse a label the ADR §8 grammar or reserved set rejects. */
function assertLabelClaimable(label: string): void {
  const refusal = refuseLabel(label);
  if (refusal) throw new ReservedLabelError(label, refusal);
}

/**
 * Refuse a hostname a DELETED workspace retired — the second half of ADR §8's
 * never-released rule (Bug MOTIR-4366).
 *
 * The first half is the `public_address.hostname` unique index, which holds a
 * name for as long as its row exists. This is the half that holds it once the
 * row is gone: the workspace delete (`deleteWorkspaceCascade`) writes a digest into
 * `public_hostname_reservation` before the cascade takes the addresses, and this
 * is what reads it back.
 *
 * ⚠️ CALLED AFTER THE INSERT, NOT BEFORE IT, AND THE ORDER IS THE RACE
 * ARGUMENT. Checked BEFORE, this would be a count-then-write — the exact shape
 * the model's own comment says the global unique exists to avoid — with a real
 * window: a workspace delete committing between the check and the insert frees
 * a name we have already decided is free. Checked AFTER, the window closes by
 * construction. Our insert holds the `hostname` slot, so no other row carried
 * that hostname at insert time; any deletion that could reserve it must
 * therefore have removed its own row BEFORE our insert, hence committed before
 * it, hence is visible to this read under READ COMMITTED. Throwing rolls the
 * whole transaction back, so the refusal costs the caller nothing.
 *
 * `HostnameTakenError`, not a fourth error: `errors.ts` is explicit that the
 * situations behind a taken hostname are deliberately NOT distinguished, and
 * "held by a workspace that no longer exists" is the one a claimer has least
 * business being told about.
 */
async function assertNotReserved(hostname: string, tx: Prisma.TransactionClient): Promise<void> {
  const reserved = await publicHostnameReservationRepository.isReservedInTx(
    hostnameReservationHash(hostname),
    new Date(),
    tx,
  );
  if (reserved) throw new HostnameTakenError(hostname);
}

/**
 * Take the workspace row lock, and REFUSE when it matched nothing.
 *
 * A `SELECT … FOR UPDATE` over zero rows locks nothing and reports success, so
 * ignoring the result gives a guard that silently does not serialize — the
 * failure `entitlementsService`'s `lockOrgRowOrRefuse` was written against. A
 * workspace that vanished mid-request is a 404, which is what the caller sees.
 */
async function lockWorkspaceOrRefuse(
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (!(await workspaceRepository.lockByIdForUpdate(workspaceId, tx))) {
    throw new WorkspaceNotVisibleError();
  }
}

/** The label half of `<label>.<base>`. */
function labelOf(hostname: string): string {
  const base = tenantBaseDomain();
  return hostname.endsWith(`.${base}`) ? hostname.slice(0, -(base.length + 1)) : hostname;
}

/**
 * Map the workspace's address rows to the DTO.
 *
 * `null` when there is no LIVE subdomain — which includes the case of a
 * workspace holding only aliases. That cannot happen through this service (a
 * rename always claims), and the mapping still handles it rather than asserting
 * it away, because an unreachable branch that returns `null` is cheaper than one
 * that throws in production if the assumption ever stops holding.
 */
function toDto(
  addresses: Array<{ hostname: string; kind: string; createdAt: Date; updatedAt: Date }>,
  reservedHostnames: number,
): PublicSubdomainDto | null {
  const live = addresses.find((a) => a.kind === 'workspace_subdomain');
  if (!live) return null;
  const aliases: RetiredSubdomainDto[] = addresses
    .filter((a) => a.kind === 'workspace_subdomain_alias')
    // `updatedAt`, not `createdAt`: an alias was CREATED when the workspace
    // first claimed that label and RETIRED when the rename moved off it, and
    // those are different dates — often months apart. `retireSubdomainToAlias`
    // is the write that stamps `updatedAt`, so it is the retirement's clock.
    .map((a) => ({ hostname: a.hostname, retiredAt: a.updatedAt.toISOString() }));
  return {
    label: labelOf(live.hostname),
    hostname: live.hostname,
    url: `https://${live.hostname}`,
    claimedAt: live.createdAt.toISOString(),
    aliases,
    // ⚠️ ALIASES *PLUS* RESERVATIONS — the ADR §8 cap counts names BURNT, not
    // alias ROWS (Amendment 2). `reservedHostnames` is `0` for every workspace
    // that has never released, so this is the old number wherever the old number
    // was defined. See {@link reservedCount} for why the difference matters.
    renamesLeft: Math.max(0, MAX_SUBDOMAIN_RENAMES - aliases.length - reservedHostnames),
  };
}
