import { withSystemContext } from '@/lib/workspaces/context';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { motirOwnedOrgLogins } from '@/lib/ciMetering/ownedOrgs';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';

// A MOTIR-HOSTED REPOSITORY LEAVES THE CONNECTED SET WITH ITS LAST PROJECT
// (bug MOTIR-12192).
//
// A repository Motir hosts lives in Motir's provisioning organisation and
// belongs to the project it was created for. `persistProvisionedRepo` stamps
// that project's organisation onto its `github_repo` mirror so the tenant can
// dispatch into it — and every read keyed on `github_repo.organization_id` used
// to take that stamp as ownership. So when the project removed the repository,
// `projectRepoSetService.removeRow` un-claimed the mirror the way it un-claims an
// organisation's own repository, and the mirror stayed: listed in Settings ›
// Organisation › Git, in the first-index pass's population, and in the inventory
// motir-ai's code-graph reconcile subtracts from — for good, because no
// organisation-level door removes a repository the organisation never had.
//
// ⚠️ RETIRED, NOT DELETED. `github_pull_request` cascades from `github_repo`, so
// deleting the mirror would take every work item's linked pull requests with it.
// The mirror keeps its row and is stamped `retired_at`; every connected-set read
// in `githubRepoRepository` leaves a retired row out, and motir-ai's reconcile
// removes its mapping and graph once the inventory stops listing it.
//
// ⚠️ ONLY A REPOSITORY MOTIR HOSTS, AND ONLY ONCE NOBODY HOLDS IT. An
// organisation's own repository stays connected when a project removes it — it
// can be linked to another project, and the organisation disconnects it on
// purpose. And a hosted repository still held by a `project_repository` row is
// still that project's (a takeover in flight, a second project that linked it
// before the picker stopped offering hosted ones). The hold test runs in the
// same statement as the stamp (`retireIfUnheld`), across every workspace.

/** One mirror the sweep retired, or would retire on a dry run. */
export interface RetiredMirror {
  id: string;
  repoRef: string;
  organizationId: string;
  workspaceId: string;
}

export interface HostedMirrorSweepReport {
  dryRun: boolean;
  /** Connected mirrors no project row holds, hosted or not. */
  scanned: number;
  /** The Motir-hosted ones among them — retired, or listed on a dry run. */
  retired: RetiredMirror[];
}

export const hostedMirrorRetirementService = {
  /**
   * The removal path's half — called once a project row is gone. Retires the
   * mirror when its owner is one Motir hosts under and no other row holds it;
   * otherwise (an organisation's own repository, a row that was never realized,
   * a repository still held elsewhere) it does nothing. Idempotent. Returns
   * whether the mirror was retired by this call.
   */
  async retireIfHostedAndUnheld(
    mirror: { id: string; owner: string } | null,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (!mirror) return false;
    if (!isMotirHostedOwner(mirror.owner, await motirOwnedOrgLogins())) return false;
    const count = await withSystemContext((tx) =>
      githubRepoRepository.retireIfUnheld(mirror.id, now, tx),
    );
    return count > 0;
  },

  /**
   * THE DATA MIGRATION — every hosted mirror already left behind (the removals
   * made before this fix, and a removal whose post-commit step did not land)
   * retired the same way. Safe to re-run: a retired mirror is no longer a
   * candidate, and an imported repository or a held hosted one never is.
   */
  async sweep(opts: { dryRun: boolean; now?: Date }): Promise<HostedMirrorSweepReport> {
    const now = opts.now ?? new Date();
    const hostOwners = await motirOwnedOrgLogins();
    const candidates = await withSystemContext((tx) =>
      githubRepoRepository.listConnectedUnheld(tx),
    );
    const hosted = candidates.filter((row) => isMotirHostedOwner(row.owner, hostOwners));

    const retired: RetiredMirror[] = [];
    for (const row of hosted) {
      const entry: RetiredMirror = {
        id: row.id,
        repoRef: `${row.owner}/${row.name}`,
        organizationId: row.organizationId,
        workspaceId: row.workspaceId,
      };
      if (opts.dryRun) {
        retired.push(entry);
        continue;
      }
      // Re-tested per row: a project may have linked it since the list was read.
      const count = await withSystemContext((tx) =>
        githubRepoRepository.retireIfUnheld(row.id, now, tx),
      );
      if (count > 0) retired.push(entry);
    }
    return { dryRun: opts.dryRun, scanned: candidates.length, retired };
  },
};
