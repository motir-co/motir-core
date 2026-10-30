import type { Prisma, PublicAddress, WorkspaceRole } from '@/generated/prisma/client';

import { isCloud } from '@/lib/billing/availability';
import type {
  PublicSubdomainDto,
  SubdomainChangePreviewDto,
  SubdomainReleaseDto,
} from '@/lib/dto/publicAddresses';
import {
  HostnameTakenError,
  NameQuarantinedError,
  NoSubdomainClaimedError,
  PublicAddressesUnavailableError,
  ReservedLabelError,
  SubdomainChangeLimitError,
  SubdomainForbiddenError,
  SubdomainNotFoundError,
  WorkspaceNotVisibleError,
} from '@/lib/publicAddresses/errors';
import {
  hostnameReservationHash,
  reservesItsHostname,
} from '@/lib/publicAddresses/hostnameReservation';
import {
  canChangeNow,
  holdOutcome,
  nextChangeAllowedAt,
  type HoldOutcome,
} from '@/lib/publicAddresses/nameHold';
import { refuseLabel } from '@/lib/publicAddresses/reservedNames';
import { tenantBaseDomain, tenantHostname } from '@/lib/publicAddresses/tenantDomain';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import { publicHostnameReservationRepository } from '@/lib/repositories/publicHostnameReservationRepository';
import { publicSubdomainChangeRepository } from '@/lib/repositories/publicSubdomainChangeRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { readReachRole } from '@/lib/workspaces/membershipGate';
import { isWorkspaceManager } from '@/lib/projects/roles';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// A WORKSPACE'S TENANT SUBDOMAIN — claim it, rename it, release it, read it.
// Story MOTIR-3878 · Subtask MOTIR-4215; rebuilt by Story MOTIR-4528 · Subtask
// MOTIR-9507 to `docs/decisions/public-tenant-addresses.md` §8 Amendment 3.
//
// This is the FREE tier's address and it works on every tier. Custom domains are
// MOTIR-4216's; nothing here touches a certificate, because the wildcard
// `*.<base>` already covers every label (ADR §6) — claiming one writes a row,
// and renaming or releasing one deletes a row. `customDomainService.remove` DOES
// call the provider, and it is the nearest neighbour to this file's `release`;
// copying it would ask Fly to withdraw a certificate for a hostname it never
// issued one for.
//
// ── THE RULES (§8 Amendment 3, the story's rules 1 to 4) ────────────────────
//
//   1. ONE NAME per workspace. No alias, no redirect: a rename deletes the live
//      row and creates the new one, and the alias kind is never written again.
//      Legacy alias rows still in the database are the one-off cleanup's
//      (MOTIR-9520); this file neither reads nor writes them.
//   2. A rename or release STOPS SERVING AT ONCE. The old row is deleted in the
//      same transaction, so the next read of the host contract finds nothing.
//   3. THE HOLD. A label held strictly under 24 hours returns to the pool at
//      once; one held longer is reserved for 90 days. `nameHold.ts` is the one
//      definition, and this file never restates a duration.
//   4. ONE CHANGE PER 30 DAYS, renames and releases alike, with no cap on the
//      number. A first claim is not a change: it neither reads nor writes the
//      ledger, so claim-after-release stays possible while the rename or
//      release after it still obeys the limit.
//
// ── THE WRITE ORDER, and why each step is where it is ──────────────────────
//
//   lock the workspace row → read the live row → read the ledger and refuse on
//   the limit → decide the hold → RESERVE (quarantine only) → DELETE the old row
//   → (rename) CREATE the new row, then check the reservation table → record the
//   change in the ledger.
//
//   * The LOCK comes first because the ledger read and the hold decision are
//     decisions about a state; taken before the lock they decide about a state
//     that may already be gone. Two admins renaming at once serialize on it, and
//     the second one meets the first one's ledger row and is refused.
//   * RESERVE BEFORE DELETE. The reservation is what keeps a released name out of
//     the pool while it is held. A transaction that committed the delete and lost
//     the reserve would hand the name straight back — and unrepairably, because
//     the row that knew the hostname is the row that was deleted and the table
//     stores a digest we cannot read back. Reserving first means a failing
//     reserve rolls the delete back with it and the workspace keeps its address.
//   * DELETE BEFORE CREATE, so the workspace never holds two live subdomains (a
//     state `findLiveSubdomainForWorkspace` resolves arbitrarily) — and, because
//     it is one transaction, never holds none either.
//   * The LEDGER WRITE is last, so a refused claim of the new label rolls the
//     whole change back and spends no change from the limit.
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
// The workspace row is the single row all of one workspace's changes contend on,
// so it is the anchor — and the `hostname` unique index is the SECOND line of
// defence for the cross-workspace race the row lock cannot see (two different
// workspaces claiming one label lock two different rows). Both are needed and
// neither is redundant.
//
// ── THE CLOCK ──────────────────────────────────────────────────────────────
//
// Every method takes an optional trailing `now`, so the 24-hour and 30-day
// boundaries are testable to the millisecond. It is the only clock the rules
// read: `nameHold.ts` takes every instant as an argument.

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
   * The workspace's subdomain, or `null` when it holds none.
   *
   * Readable by any workspace member — an address is not a secret from the team
   * that answers at it, and the pane needs it to render the read-only arm.
   */
  async getForWorkspace(
    workspaceId: string,
    actorUserId: string,
    now: Date = new Date(),
  ): Promise<PublicSubdomainDto | null> {
    assertAvailable();
    await assertMember(workspaceId, actorUserId);
    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      const live = await publicAddressRepository.findLiveSubdomainForWorkspace(workspaceId, tx);
      if (!live) return null;
      return toDto(live, await readLastChange(workspaceId, tx), now);
    });
  },

  /**
   * What a rename or release would do right now, without doing it — the confirm
   * dialog's dated preview (story rule 5).
   *
   * Computed with the same pure functions the writes apply, so for the same
   * `now` the dialog and the stored expiry cannot disagree. It takes no lock:
   * it is advice, never authority, and the write recomputes under the lock.
   */
  async previewChange(
    workspaceId: string,
    actorUserId: string,
    now: Date = new Date(),
  ): Promise<SubdomainChangePreviewDto> {
    assertAvailable();
    await assertAddressAdmin(workspaceId, actorUserId);
    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      const live = await publicAddressRepository.findLiveSubdomainForWorkspace(workspaceId, tx);
      // A GET of a resource that is not there: 404, the release path's answer.
      if (!live) throw new SubdomainNotFoundError();
      const lastChangedAt = await readLastChange(workspaceId, tx);
      const hold = holdOf(live, now);
      return {
        host: live.hostname,
        outcome: hold.kind,
        returnsAt: hold.kind === 'quarantine' ? hold.returnsAt.toISOString() : null,
        changeAllowed: canChangeNow(lastChangedAt, now),
        nextChangeAllowedAt: blockedUntil(lastChangedAt, now)?.toISOString() ?? null,
      };
    });
  },

  /**
   * Claim a label for a workspace that has none.
   *
   * ONE transaction: lock, re-read under the lock, validate, write. A claim is
   * not a change (rule 4), so the ledger is neither read nor written.
   */
  async claim(
    workspaceId: string,
    label: string,
    actorUserId: string,
    now: Date = new Date(),
  ): Promise<PublicSubdomainDto> {
    assertAvailable();
    await assertAddressAdmin(workspaceId, actorUserId);
    assertLabelClaimable(label);

    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      await lockWorkspaceOrRefuse(workspaceId, tx);
      const live = await publicAddressRepository.findLiveSubdomainForWorkspace(workspaceId, tx);
      if (live) {
        // Already claimed — a claim is not a rename, and quietly turning one
        // into the other would spend a change from the limit without saying so.
        throw new HostnameTakenError(live.hostname);
      }
      const hostname = tenantHostname(label);
      const created = await publicAddressRepository.createSubdomain({ workspaceId, hostname }, tx);
      await assertNotReserved(hostname, now, tx);
      return toDto(created, await readLastChange(workspaceId, tx), now);
    });
  },

  /**
   * Rename the workspace's subdomain. The old name stops being served in this
   * transaction and is held or freed by rule 3; nothing redirects to the new one.
   *
   * The order inside the transaction is the file header's WRITE ORDER.
   */
  async rename(
    workspaceId: string,
    newLabel: string,
    actorUserId: string,
    now: Date = new Date(),
  ): Promise<PublicSubdomainDto> {
    assertAvailable();
    await assertAddressAdmin(workspaceId, actorUserId);
    assertLabelClaimable(newLabel);

    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      await lockWorkspaceOrRefuse(workspaceId, tx);
      const live = await publicAddressRepository.findLiveSubdomainForWorkspace(workspaceId, tx);
      if (!live) throw new NoSubdomainClaimedError();

      const hostname = tenantHostname(newLabel);
      if (hostname === live.hostname) {
        // Renaming to the name you already hold would spend a change and hold
        // the name against yourself. Refused as taken, which is what it is.
        throw new HostnameTakenError(hostname);
      }

      await assertChangeAllowed(workspaceId, now, tx);
      await retireLiveSubdomain(workspaceId, live, now, tx);
      const created = await publicAddressRepository.createSubdomain({ workspaceId, hostname }, tx);
      await assertNotReserved(hostname, now, tx);
      await publicSubdomainChangeRepository.recordChangeInTx(workspaceId, now, tx);

      return toDto(created, now, now);
    });
  },

  /**
   * RELEASE the workspace's subdomain (§8 Amendments 2 and 3). It stops being
   * served in this transaction, its name is held or freed by rule 3, and the
   * release counts against the 30-day limit exactly as a rename does.
   *
   * Returns when the name returns to the pool — `null` when it already has — so
   * the caller can state the date.
   *
   * ⚠️ NO CERTIFICATE CALL, and the temptation is structural rather than
   * hypothetical: the nearest neighbour to this method is
   * `customDomainService.remove`, which withdraws a certificate post-commit. A
   * workspace subdomain is covered by the wildcard `*.<base>` (ADR §6) — claiming
   * one issues nothing, so releasing one withdraws nothing.
   */
  async release(
    workspaceId: string,
    actorUserId: string,
    now: Date = new Date(),
  ): Promise<SubdomainReleaseDto> {
    assertAvailable();
    await assertAddressAdmin(workspaceId, actorUserId);

    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      await lockWorkspaceOrRefuse(workspaceId, tx);
      const live = await publicAddressRepository.findLiveSubdomainForWorkspace(workspaceId, tx);
      // Nothing claimed. A DELETE names a resource, so this is a 404 and NOT the
      // rename path's 409 — `SubdomainNotFoundError` carries that reasoning.
      if (!live) throw new SubdomainNotFoundError();

      await assertChangeAllowed(workspaceId, now, tx);
      const hold = await retireLiveSubdomain(workspaceId, live, now, tx);
      await publicSubdomainChangeRepository.recordChangeInTx(workspaceId, now, tx);

      return { returnsAt: hold.kind === 'quarantine' ? hold.returnsAt.toISOString() : null };
    });
  },
};

// ── Internals ──────────────────────────────────────────────────────────────

/** The hold `live` takes if it stops being the workspace's name at `now` (rule 3). */
function holdOf(live: PublicAddress, now: Date): HoldOutcome {
  // The live row's `createdAt` is when the workspace took THIS label: a rename
  // creates a new row, so the clock restarts with every name.
  return holdOutcome({ claimedAt: live.createdAt, releasedAt: now });
}

/** The workspace's last rename or release, or `null` if it has never changed its name. */
async function readLastChange(
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<Date | null> {
  return (
    (await publicSubdomainChangeRepository.findByWorkspaceInTx(workspaceId, tx))?.lastChangedAt ??
    null
  );
}

/** When the 30-day limit next allows a change, or `null` when it allows one at `now`. */
function blockedUntil(lastChangedAt: Date | null, now: Date): Date | null {
  if (!lastChangedAt || canChangeNow(lastChangedAt, now)) return null;
  return nextChangeAllowedAt(lastChangedAt);
}

/**
 * Refuse a rename or release inside the 30-day limit (rule 4). Called UNDER the
 * workspace lock, so the ledger it reads is the one the change will write.
 */
async function assertChangeAllowed(
  workspaceId: string,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const until = blockedUntil(await readLastChange(workspaceId, tx), now);
  if (until) throw new SubdomainChangeLimitError(until);
}

/**
 * Stop serving the live subdomain: hold its name if rule 3 says so, then delete
 * its row. RESERVE BEFORE DELETE — the file header's write order says why.
 */
async function retireLiveSubdomain(
  workspaceId: string,
  live: PublicAddress,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<HoldOutcome> {
  const hold = holdOf(live, now);
  // `reservesItsHostname` stays the one place that decides which kinds are ever
  // held; it is true for a workspace subdomain, and asking keeps it that way.
  if (hold.kind === 'quarantine' && reservesItsHostname(live.kind)) {
    await publicHostnameReservationRepository.reserveMany(
      [
        {
          hostnameHash: hostnameReservationHash(live.hostname),
          retiredFromWorkspaceId: workspaceId,
          expiresAt: hold.returnsAt,
        },
      ],
      now,
      tx,
    );
  }
  await publicAddressRepository.remove(live.id, tx);
  return hold;
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

/**
 * Refuse a label the ADR §8 grammar or reserved set rejects. `refuseLabel` is
 * the ONLY label check, so a grammar rule added there (MOTIR-9797's `--` and
 * length rules) applies here the day it lands.
 */
function assertLabelClaimable(label: string): void {
  const refusal = refuseLabel(label);
  if (refusal) throw new ReservedLabelError(label, refusal);
}

/**
 * Refuse a hostname that is held by an unexpired reservation — a name another
 * workspace (or this one) renamed or released within the hold, or a deleted
 * workspace retired (Bug MOTIR-4366, §8 Amendment 3).
 *
 * The `public_address.hostname` unique index holds a name for as long as its row
 * exists; this is what holds it once the row is gone. A lapsed reservation holds
 * nothing, whether or not the sweep has deleted it yet.
 *
 * ⚠️ CALLED AFTER THE INSERT, NOT BEFORE IT, AND THE ORDER IS THE RACE
 * ARGUMENT. Checked BEFORE, this would be a count-then-write with a real window:
 * a rename, release or workspace delete committing between the check and the
 * insert frees a name we have already decided is free. Checked AFTER, the window
 * closes by construction. Our insert holds the `hostname` slot, so no other row
 * carried that hostname at insert time; any change that could reserve it must
 * therefore have removed its own row BEFORE our insert, hence committed before
 * it, hence is visible to this read under READ COMMITTED. Throwing rolls the
 * whole transaction back, so the refusal costs the caller nothing.
 *
 * `NameQuarantinedError`, not `HostnameTakenError`: a reservation ends on a
 * known date, and story rule 5 owes the claimer that date. The reserving
 * workspace stays unnamed — only the date is read.
 */
async function assertNotReserved(
  hostname: string,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const returnsAt = await publicHostnameReservationRepository.findActiveExpiryInTx(
    hostnameReservationHash(hostname),
    now,
    tx,
  );
  if (returnsAt) throw new NameQuarantinedError(hostname, returnsAt);
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

/** Map the live subdomain row and the ledger's last change to the DTO. */
function toDto(live: PublicAddress, lastChangedAt: Date | null, now: Date): PublicSubdomainDto {
  return {
    label: labelOf(live.hostname),
    hostname: live.hostname,
    url: `https://${live.hostname}`,
    claimedAt: live.createdAt.toISOString(),
    nextChangeAllowedAt: blockedUntil(lastChangedAt, now)?.toISOString() ?? null,
  };
}
