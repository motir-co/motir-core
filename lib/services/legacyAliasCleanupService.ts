import type { PublicAddress } from '@/generated/prisma/client';
import { hostnameReservationHash } from '@/lib/publicAddresses/hostnameReservation';
import { QUARANTINE_DAYS, addDays } from '@/lib/publicAddresses/nameHold';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import { publicHostnameReservationRepository } from '@/lib/repositories/publicHostnameReservationRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE LEGACY ALIAS CLEANUP — Story MOTIR-4528 · Subtask MOTIR-9520.
//
// The pre-Amendment-3 design turned a renamed-away-from subdomain into a
// `public_address` row of kind `workspace_subdomain_alias`, and that row held the
// name for ever through the unique index on `hostname`. The rebuilt rules know
// nothing about aliases (§8 Amendment 3 rule 1: one name, no aliases) and the
// host contract 404s one, so a leftover row is dead weight blocking its name with
// no expiry and no date anyone could state. This removes them, once per
// environment, through `scripts/cleanup-legacy-subdomain-aliases.ts`.
//
// ⚠️ ONE RULE: a retired name is HELD BEFORE its row goes, in the same
// transaction. An alias's own hold clock is not recoverable, so it is always a
// quarantine of `QUARANTINE_DAYS` from `now` — the conservative reading the
// workspace delete applies to a leftover alias: a name someone may have linked is
// never freed early. A digest already held past `now` keeps its hold untouched
// (never shortened); a LAPSED row for it is raised, not skipped, or the name
// would be free. The reservation stays a digest (Amendment 1).
//
// System-scoped: alias rows belong to every workspace, so each batch runs under
// `withSystemContext` (the `system` arms of both tables). Idempotent: a second
// run finds no alias and changes nothing.

export interface LegacyAliasCleanupReport {
  aliasesRemoved: number;
  holdsCreated: number;
  holdsRaised: number;
  holdsKept: number;
}

interface HoldPlan {
  writes: Array<{ hostnameHash: string; retiredFromWorkspaceId: string; expiresAt: Date }>;
  created: number;
  raised: number;
  kept: number;
}

/** Sort one batch's aliases into holds to write and holds already in force. Pure. */
function planHolds(
  aliases: readonly PublicAddress[],
  expiries: ReadonlyMap<string, Date>,
  now: Date,
): HoldPlan {
  const plan: HoldPlan = { writes: [], created: 0, raised: 0, kept: 0 };
  const expiresAt = addDays(now, QUARANTINE_DAYS);
  for (const alias of aliases) {
    const hostnameHash = hostnameReservationHash(alias.hostname);
    const current = expiries.get(hostnameHash);
    if (current && current > now) {
      plan.kept += 1;
      continue;
    }
    if (current) plan.raised += 1;
    else plan.created += 1;
    plan.writes.push({ hostnameHash, retiredFromWorkspaceId: alias.workspaceId, expiresAt });
  }
  return plan;
}

export const legacyAliasCleanupService = {
  /**
   * Hold and delete every legacy alias row, `batchSize` at a time, one
   * transaction per batch. `now` is an argument so a test can pin the expiry.
   */
  async cleanupLegacyAliases(
    now: Date = new Date(),
    batchSize = 200,
  ): Promise<LegacyAliasCleanupReport> {
    const report: LegacyAliasCleanupReport = {
      aliasesRemoved: 0,
      holdsCreated: 0,
      holdsRaised: 0,
      holdsKept: 0,
    };
    for (;;) {
      // Counted only once the batch COMMITS, so a rolled-back batch adds nothing.
      const batch = await withSystemContext(async (tx) => {
        const aliases = await publicAddressRepository.listAliasesInTx(batchSize, tx);
        if (aliases.length === 0) return null;
        const expiries = await publicHostnameReservationRepository.findExpiriesInTx(
          aliases.map((a) => hostnameReservationHash(a.hostname)),
          tx,
        );
        const plan = planHolds(aliases, expiries, now);
        // Hold FIRST: a failing hold rolls the delete back with it, so a name is
        // never briefly free.
        await publicHostnameReservationRepository.holdUntilInTx(plan.writes, now, tx);
        const removed = await publicAddressRepository.removeMany(
          aliases.map((a) => a.id),
          tx,
        );
        return { plan, removed };
      });
      if (!batch) return report;
      report.aliasesRemoved += batch.removed;
      report.holdsCreated += batch.plan.created;
      report.holdsRaised += batch.plan.raised;
      report.holdsKept += batch.plan.kept;
      if (batch.removed < batchSize) return report;
    }
  },
};
