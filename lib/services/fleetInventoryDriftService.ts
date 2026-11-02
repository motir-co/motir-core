import inventoryManifest from '@/lib/ciFleet/fleetJobInventory.json';
import type { FleetInventoryRepo, FleetJobInventory } from '@/lib/ciFleet/fleetJobInventoryTypes';
import { judgeStructure, type StaleReason } from '@/lib/ciFleet/inventoryStaleness';
import type { WorkflowSourceFile } from '@/lib/ciFleet/workflowFingerprint';
import { isGithubAppConfigured } from '@/lib/github/appAuth';
import {
  getOrgInstallation,
  latestWorkflowCommit,
  OrgInstallationReadError,
  readWorkflowSources,
} from '@/lib/github/orgInstallation';
import { OrgTargetAuthError, type GithubOrgTarget } from '@/lib/github/orgTarget';
import type {
  FleetInventoryDriftVerdictDTO,
  FleetInventoryStaleRepoDTO,
  FleetInventoryUnreadableRepoDTO,
} from '@/lib/dto/fleetInventoryDrift';

// THE FLEET-INVENTORY DRIFT PROBE (MOTIR-10211) — a probe of
// `system.daily-health-check` that fails when a PRIVATE repository's workflows
// have moved past what `lib/ciFleet/fleetJobInventory.json` measured.
//
// ⚠️ WHY IT EXISTS. The inventory is a hand-kept snapshot, and the readiness
// verdict (the guard on the Motir-CI-on-fleet switch) calls an entry stale when
// the repository moves past it. Nothing re-read it on its own: motir-infra#7's
// `verify` job left image coverage at Not met from 2026-10-28 until somebody
// happened to open /admin/fleet-settings on 2026-11-02. MOTIR-8870 named a
// scheduled re-measure as the lasting fix and only its other half shipped. This
// is the scheduled half: it asks readiness's own question, by readiness's own rule
// (`entryStaleness` below, which readiness calls too), once a day, and fails
// where a person looks — the DLQ row and the Sentry email the job already has.
//
// ⚠️ IT ALERTS; IT NEVER WRITES A VERDICT. Whether the image can run a job is a
// judgement against the runner image's Dockerfile that this process cannot make,
// so the probe records nothing in the inventory: a job it cannot judge is never
// recorded as `runnable` because it records no job at all. The message names the
// repository, the two shas, what moved and the jobs a re-measure must add, and
// points at the re-measure path in `docs/research/fleet-job-inventory.md`.
//
// ⚠️ ONLY `stale` IS LOUD, on the terms every probe in that job keeps. A read
// GitHub refused is `indeterminate` — a statement about the read, not about the
// entry — and failing on it would teach an operator the row is noise. It is on
// the job_run row either way. `not_applicable` is a deployment with no
// provisioning App, which can read no private repository: every self-hosted build.
//
// NAMES NO ORG. The orgs come from the inventory's own `repoRef`s.

export type EntryStaleness =
  | {
      state: 'current';
      /** The newest workflow commit, or null when the default branch has none. */
      headSha: string | null;
      addedJobs: string[];
    }
  | {
      state: 'stale';
      headSha: string;
      reason: StaleReason;
      movedJobs: string[];
      addedJobs: string[];
    }
  /** The newest workflow commit could not be read. */
  | { state: 'unreadable'; phase: 'head'; headSha: null; error: unknown }
  /** The workflow files at the newest workflow commit could not be read. */
  | { state: 'unreadable'; phase: 'files'; headSha: string; error: unknown };

/**
 * Read a repository's newest workflow commit and judge the entry at it. A head
 * that is the recorded sha, or no newer than the measurement, is current without
 * reading a file. Never throws for a GitHub failure: it answers `unreadable`.
 */
export async function entryStaleness(
  target: GithubOrgTarget,
  owner: string,
  name: string,
  entry: FleetInventoryRepo,
): Promise<EntryStaleness> {
  let head: Awaited<ReturnType<typeof latestWorkflowCommit>>;
  try {
    head = await latestWorkflowCommit(target, owner, name);
  } catch (error) {
    return { state: 'unreadable', phase: 'head', headSha: null, error };
  }
  if (
    !head ||
    head.sha === entry.sha ||
    new Date(head.committedAt).getTime() <= new Date(entry.measuredAt).getTime()
  ) {
    return { state: 'current', headSha: head?.sha ?? null, addedJobs: [] };
  }
  let files: WorkflowSourceFile[];
  try {
    files = await readWorkflowSources(target, owner, name, head.sha);
  } catch (error) {
    return { state: 'unreadable', phase: 'files', headSha: head.sha, error };
  }
  const verdict = judgeStructure(entry, files);
  if (verdict.current) return { state: 'current', headSha: head.sha, addedJobs: verdict.addedJobs };
  return {
    state: 'stale',
    headSha: head.sha,
    reason: verdict.reason,
    movedJobs: verdict.movedJobs,
    addedJobs: verdict.addedJobs,
  };
}

function statusOf(err: unknown): number | null {
  if (err instanceof OrgInstallationReadError || err instanceof OrgTargetAuthError) {
    return err.status;
  }
  return null;
}

const ownerOf = (repoRef: string) => repoRef.slice(0, repoRef.indexOf('/'));
const nameOf = (repoRef: string) => repoRef.slice(repoRef.indexOf('/') + 1);

/** The provisioning App's target on `org`, or why it cannot be had. */
async function orgTargetFor(
  org: string,
): Promise<{ target: GithubOrgTarget } | { status: number | null }> {
  try {
    const installation = await getOrgInstallation(org, 'provisioning');
    if (!installation) return { status: 404 };
    if (installation.suspendedAt) return { status: 403 };
    return { target: { org, installationId: installation.id, role: 'provisioning' } };
  } catch (err) {
    return { status: statusOf(err) };
  }
}

/** Fold the per-entry answers into the verdict. Pure; exported for its unit test. */
export function judgeDrift(
  checkedAt: string,
  checked: string[],
  stale: FleetInventoryStaleRepoDTO[],
  unreadable: FleetInventoryUnreadableRepoDTO[],
): FleetInventoryDriftVerdictDTO {
  if (stale.length > 0) return { verdict: 'stale', checkedAt, checked, stale, unreadable };
  if (unreadable.length > 0) return { verdict: 'indeterminate', checkedAt, checked, unreadable };
  return { verdict: 'current', checkedAt, checked };
}

export const fleetInventoryDriftService = {
  /**
   * Judge every PRIVATE entry of the inventory against its repository's newest
   * workflow commit. Never throws on a stale entry or a refused read — the caller
   * decides which arms are loud. `inventory` and `now` are injectable for tests.
   */
  async check(
    options: { inventory?: FleetJobInventory; now?: Date } = {},
  ): Promise<FleetInventoryDriftVerdictDTO> {
    const inventory = options.inventory ?? (inventoryManifest as FleetJobInventory);
    const checkedAt = (options.now ?? new Date()).toISOString();
    // Only private repositories request the fleet (the runner group access-lists
    // private repositories only), so only their entries are read by readiness.
    const entries = Object.entries(inventory.repos)
      .filter(([, entry]) => entry.visibility === 'private')
      .sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) {
      return { verdict: 'not_applicable', checkedAt, reason: 'no_private_entries' };
    }
    if (!isGithubAppConfigured('provisioning')) {
      return { verdict: 'not_applicable', checkedAt, reason: 'app_not_configured' };
    }

    const targets = new Map<string, Awaited<ReturnType<typeof orgTargetFor>>>();
    const checked: string[] = [];
    const stale: FleetInventoryStaleRepoDTO[] = [];
    const unreadable: FleetInventoryUnreadableRepoDTO[] = [];
    for (const [repository, entry] of entries) {
      const org = ownerOf(repository);
      const orgKey = org.toLowerCase();
      if (!targets.has(orgKey)) targets.set(orgKey, await orgTargetFor(org));
      const resolved = targets.get(orgKey)!;
      if (!('target' in resolved)) {
        unreadable.push({ repository, phase: 'installation', status: resolved.status });
        continue;
      }
      const answer = await entryStaleness(resolved.target, org, nameOf(repository), entry);
      if (answer.state === 'unreadable') {
        unreadable.push({ repository, phase: answer.phase, status: statusOf(answer.error) });
        continue;
      }
      checked.push(repository);
      if (answer.state === 'stale') {
        stale.push({
          repository,
          measuredSha: entry.sha,
          headSha: answer.headSha,
          reason: answer.reason,
          movedJobs: answer.movedJobs,
          addedJobs: answer.addedJobs,
        });
      }
    }
    return judgeDrift(checkedAt, checked, stale, unreadable);
  },
};
