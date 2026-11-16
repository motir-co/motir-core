import 'server-only';

import { z } from 'zod';
import type { CiFleetBlindSpotOrgDTO, CiFleetBlindSpotsDTO } from '@/lib/dto/ciFleetBlindSpots';
import { isCiFleetConfigured } from '@/lib/orchestrator';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { ciFleetBlindSpotsRepository } from '@/lib/repositories/ciFleetBlindSpotsRepository';
import type { ReconcileOutcome } from '@/lib/services/ciRunnerReconcileService';
import { withSystemContext } from '@/lib/workspaces/context';

/**
 * THE CI FLEET'S BLIND SPOTS (MOTIR-11439; design MOTIR-11467,
 * `platform-admin/design-notes.md` § AMENDMENT 2026-11-16).
 *
 * The provision sweep's reconcile (`ciRunnerReconcileService`, MOTIR-11437)
 * finds, per GitHub organisation, the repos with queued fleet jobs but no
 * `workflow_job` deliveries and the linked repos the fleet's credential cannot
 * read. This service KEEPS the latest outcome and READS it for the console.
 *
 * WHY A RECORD OF ITS OWN, not the sweep's `job_run` output. The page needs the
 * latest outcome and the time of its tick on every load; the ledger keeps one row
 * per tick (288 a day) with no index on the function and no ordering the read
 * could use, writes `output` only when the WHOLE run succeeds (a failed boot fan-out
 * would hide a reconcile that ran), and is subject to retention. So the sweep
 * writes ONE row here inside its reconcile step, and the page reads that row.
 *
 * ⚠️ NO GITHUB ON A PAGE LOAD. `read` touches only the stored row and
 * `isCiFleetConfigured()`, which reads configuration and never the network.
 *
 * ⚠️ NOTHING READS AS SEEN WITHOUT A READ. A failed read is `unavailable`, an
 * unconfigured fleet `notConfigured`, no stored tick `notComputed`, a thrown
 * reconcile `reconcileFailed` — none of them carries an org list.
 */

/** The stored shape: only what the page draws (the design's *Data* section). */
const storedOutcomeSchema = z.object({
  orgs: z.array(
    z.object({
      org: z.string(),
      undeliveredRepos: z.array(z.string()),
      unreadableRepos: z.array(z.string()),
      error: z.string().nullable(),
    }),
  ),
  error: z.string().nullable(),
});

type StoredOutcome = z.infer<typeof storedOutcomeSchema>;

/** The reconcile outcome, narrowed to the fields the page draws. Exported for its tests. */
export function toStoredOutcome(outcome: ReconcileOutcome): StoredOutcome {
  return {
    orgs: outcome.orgs.map((o) => ({
      org: o.org,
      undeliveredRepos: [...(o.undeliveredRepos ?? [])],
      unreadableRepos: [...(o.unreadableRepos ?? [])],
      error: o.error ?? null,
    })),
    error: outcome.error ?? null,
  };
}

/** Not read → with blind spots → seen, then by login (the design's Org list order). */
function orgRank(org: CiFleetBlindSpotOrgDTO): number {
  if (org.error !== null) return 0;
  return org.undeliveredRepos.length + org.unreadableRepos.length > 0 ? 1 : 2;
}

/** The orgs in the order the card lists them. Exported for its tests. */
export function orderOrgs(orgs: CiFleetBlindSpotOrgDTO[]): CiFleetBlindSpotOrgDTO[] {
  return [...orgs].sort((a, b) => orgRank(a) - orgRank(b) || a.org.localeCompare(b.org, 'en'));
}

export const ciFleetBlindSpotsService = {
  /**
   * Keep `outcome` as the latest, computed at `computedAt`. Called by the
   * provision sweep inside its reconcile step, so a replayed step (whose memo
   * already holds the outcome) never writes again. A stored outcome newer than
   * `computedAt` is left as it is.
   */
  async record(outcome: ReconcileOutcome, computedAt: Date): Promise<void> {
    await withSystemContext((tx) =>
      ciFleetBlindSpotsRepository.replaceIfNewer(
        { outcome: toStoredOutcome(outcome), computedAt },
        tx,
      ),
    );
  },

  /**
   * The Fleet status page's read: the latest stored outcome and its time, or the
   * state that stands in for it. One `fleet.status.read` audit row per call.
   * Superadmin only.
   *
   * @throws NotPlatformStaffError below `superadmin` — before anything is read.
   */
  async read(principal: PlatformPrincipal): Promise<CiFleetBlindSpotsDTO> {
    await requirePlatformStaff('superadmin');
    try {
      const [configured, row] = await Promise.all([
        isCiFleetConfigured(),
        withPlatformRead(
          principal,
          { action: 'fleet.status.read', targetKind: 'platform', targetId: 'ci_fleet_blind_spots' },
          (tx) => ciFleetBlindSpotsRepository.findLatest(tx),
        ),
      ]);
      if (!configured) return { status: 'notConfigured' };
      if (row === null) return { status: 'notComputed' };

      const stored = storedOutcomeSchema.parse(row.outcome);
      const computedAt = row.computedAt.toISOString();
      if (stored.error !== null)
        return { status: 'reconcileFailed', error: stored.error, computedAt };
      return { status: 'ok', orgs: orderOrgs(stored.orgs), computedAt };
    } catch (err) {
      // By its NAME only: a Prisma or parse message can carry row data.
      console.error('[admin] fleet status CI fleet blind spots read failed', {
        error: err instanceof Error ? err.name : 'unknown',
      });
      return { status: 'unavailable' };
    }
  },
};
