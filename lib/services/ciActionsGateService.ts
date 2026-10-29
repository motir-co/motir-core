import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { actionsPermissionsClient } from '@/lib/github/actionsPermissions';
import { isCiMeteringEnabled, provisioningOrgLogin } from '@/lib/ciMetering/config';
import { motirOwnedOrgLogins } from '@/lib/ciMetering/ownedOrgs';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import type { CiEntitlementStateDTO } from '@/lib/dto/ciAllowance';

// THE CI-ACTIONS GATE (Story MOTIR-1775 · MOTIR-1907) — the REPOSITORY-side half
// of the CI-charging contract in `docs/decisions/ci-minutes-allowance.md`.
//
// MOTIR-1901 refuses the next DISPATCH; MOTIR-1922 will decline the fleet RUNNER
// BOOT. Neither can stop GitHub billing Motir for a run nobody dispatched, and
// neither is VISIBLE:
//
//   * LEGIBILITY — a queued job with no runner does not fail. It sits pending for
//     up to 24h and is then silently dropped, which is indistinguishable from
//     Motir being broken. Disabling Actions makes the refusal immediate and
//     legible, and is what the billing panel (MOTIR-1902/1903) can explain.
//   * THE GITHUB-HOSTED FALLBACK — MOTIR-1915 has every project workflow select
//     its runner via `vars.MOTIR_RUNNER` with an `ubuntu-latest` fallback, so the
//     repo stays portable after MOTIR-711's handoff. A missing or CLEARED
//     variable therefore routes the job to a GitHub-hosted runner billed to
//     Motir — a path no runner-side gate ever sees, because no fleet runner is
//     requested. This is the only thing that stops it. (MOTIR-1908 measured that
//     a $0 org budget does NOT: included minutes discount to `netAmount: 0`, so
//     ~2,000 private-repo minutes a month never accrue against it.)
//
// ⚠️ THE SHAPE IS "PERSIST INTENT, THEN CONVERGE", and it is forced by the
// problem: N repositories means N GitHub calls with NO transaction over them.
// Half can fail. So the transaction records only what Motir INTENDS, and the
// host calls happen AFTER it commits (§8.6 — a GitHub outage must never roll back
// the metering write or fail the request). A row whose call failed keeps its
// intent ahead of its applied stamp and is picked up by the next sweep. Nothing
// is lost, and nothing is retried forever in-line.

/** What one pass did. Returned for logging + tests; never thrown. */
export type CiActionsSyncOutcome =
  /** Off-cloud, no provisioning org, or the META org — nothing read, nothing called. */
  | { outcome: 'bypassed'; reason: 'disabled' | 'no_provisioning_org' | 'meta' }
  /** The entitlement read failed. Actions were left ENABLED — see the fail-open note. */
  | { outcome: 'failed_open'; detail: string }
  /** A pass ran. `intentChanged` counts rows whose desired state moved; `applied`
   *  and `failed` count host calls this pass actually made. */
  | {
      outcome: 'synced';
      disabled: boolean;
      workspaces: number;
      intentChanged: number;
      applied: number;
      failed: number;
    };

export const ciActionsGateService = {
  /**
   * Bring one organization's Motir-owned repositories in line with its
   * entitlement state, then push that intent to GitHub.
   *
   * `opts.state` INJECTS the entitlement rather than reading it. Two callers want
   * that: the metering path, which has just computed the state and must not pay
   * for a second cross-boundary balance read; and the meta-org test, which cannot
   * reach this guard any other way (see the meta note below).
   */
  async syncForOrganization(
    organizationId: string,
    opts?: { at?: Date; state?: CiEntitlementStateDTO },
  ): Promise<CiActionsSyncOutcome> {
    const at = opts?.at ?? new Date();

    // §8.5 — off-cloud there is no meter, no pool and no refusal, so there is
    // nothing to enforce and Motir hosts nobody's repositories.
    if (!isCiMeteringEnabled()) return { outcome: 'bypassed', reason: 'disabled' };

    // Nothing is Motir-owned when no provisioning org is configured, so the whole
    // path is correctly inert (the same first-class UNSET state the meter's gate
    // documents) — and it is also exactly what must happen once a repo has been
    // transferred away.
    if (!provisioningOrgLogin()) return { outcome: 'bypassed', reason: 'no_provisioning_org' };
    // Every org Motir owns — the provisioning org and each fleet account's
    // (MOTIR-8974), where a tenant's hosted repositories may live.
    const owners = await motirOwnedOrgLogins();

    // ⚠️ THE META GUARD IS READ INDEPENDENTLY OF THE STATE, ON PURPOSE.
    //
    // `getEntitlementState` already returns `bypassed` for a meta org and NEVER
    // `ci_credits_exhausted` (§4.4 — moooon B.V. pays its own GitHub bill), so
    // routing the meta case through the state would make THIS guard unreachable
    // and its test vacuous: the pass would return early on `state !== exhausted`
    // having never consulted `isMeta` at all, and would go green while asserting
    // nothing. Disabling Actions on Motir's own repositories would cost Motir the
    // ability to ship the fix, so the guard that prevents it must be a real
    // assertion, not a consequence of another layer. Reading `isMeta` here — and
    // BEFORE any state branch — is what makes it one.
    const isMeta = await withOrgServiceWriteContext(organizationId, async (tx) => {
      const organization = await organizationRepository.findByIdInTx(organizationId, tx);
      // A missing org row defaults to non-meta — the safe direction, matching
      // `resolveTenantOrg` and the meter.
      return organization?.isMeta ?? false;
    });
    if (isMeta) return { outcome: 'bypassed', reason: 'meta' };

    let state: CiEntitlementStateDTO;
    try {
      state = opts?.state ?? (await ciAllowanceService.getEntitlementState(organizationId, at));
    } catch (err) {
      // FAIL OPEN, matching `ciAllowanceService`'s documented posture: a gate that
      // fails closed on its own dependency's outage takes the agent loop down with
      // it, and Motir's own outage must never look like the user being out of
      // credits. Leave Actions as they are and log.
      const detail = err instanceof Error ? err.message : 'unknown';
      console.error(
        `[ciActionsGateService] entitlement read failed for org ${organizationId}; leaving Actions ENABLED:`,
        detail,
      );
      return { outcome: 'failed_open', detail };
    }

    // ONLY the exhausted state disables. Crossing the pool is §6.1's normal,
    // visible `drawing_on_credits` event and must keep working; `bypassed` and
    // `within_allowance` likewise.
    const disabled = state.state === 'ci_credits_exhausted';

    const workspaceIds = await this.listOwnedWorkspaceIds(organizationId, owners);

    // ── The transaction: intent only ────────────────────────────────────────
    let intentChanged = 0;
    for (const workspaceId of workspaceIds) {
      intentChanged += await withWorkspaceServiceContext(workspaceId, async (tx) => {
        const rows = await projectRepoRepository.listMotirCreatedByWorkspace(workspaceId, tx);
        const ids = rows
          .filter((row) => isMotirHostedOwner(row.githubRepo?.owner, owners))
          .map((row) => row.id);
        return projectRepoRepository.setCiActionsIntent(ids, disabled, at, tx);
      });
    }

    // ── After the commit: the host calls ────────────────────────────────────
    const { applied, failed } = await assertPending(workspaceIds, owners);
    return {
      outcome: 'synced',
      disabled,
      workspaces: workspaceIds.length,
      intentChanged,
      applied,
      failed,
    };
  },

  /**
   * Re-assert every unconverged row across every Motir-hosted workspace — the
   * idempotent completion pass.
   *
   * This is what makes a partially-failed fan-out self-healing: the intent is
   * already durable, so a run where half the GitHub calls failed leaves those
   * rows pending and the next sweep finishes them. It is also the RESUME path's
   * deadline-beater — a top-up flips the intent back to enabled, and this must
   * re-enable the repository before the first queued job would otherwise be
   * dropped at 24h.
   */
  async sweep(): Promise<{ applied: number; failed: number }> {
    if (!isCiMeteringEnabled()) return { applied: 0, failed: 0 };
    if (!provisioningOrgLogin()) return { applied: 0, failed: 0 };
    const owners = await motirOwnedOrgLogins();
    return assertPending(await workspaceIdsOwnedBy(owners), owners);
  },

  /**
   * The organizations this gate is currently holding DISABLED — the resume pass's
   * input (`ciActionsGateSweep`).
   *
   * Deliberately driven off STORED INTENT rather than off the entitlement: it
   * answers "who did Motir disable?", which is a local read, instead of "who is
   * exhausted?", which would cost a cross-boundary balance read per organization
   * per tick for a set that is empty almost always. The hourly job then
   * re-derives the real state for just these few.
   *
   * This is also what breaks the resume DEADLOCK: a disabled org cannot meter a
   * run (its Actions are off), so it can never re-trigger the metering path that
   * would notice it is solvent again. Something has to ask on its behalf, and it
   * has to be able to find it without the org doing anything.
   */
  async listDisabledOrganizationIds(): Promise<string[]> {
    if (!isCiMeteringEnabled()) return [];
    if (!provisioningOrgLogin()) return [];

    const candidates = await workspaceIdsOwnedBy(await motirOwnedOrgLogins());

    const organizationIds = new Set<string>();
    for (const workspaceId of candidates) {
      const organizationId = await withWorkspaceServiceContext(workspaceId, async (tx) => {
        const disabled = await projectRepoRepository.countCiActionsDisabledByWorkspace(
          workspaceId,
          tx,
        );
        if (disabled === 0) return null;
        const workspace = await workspaceRepository.findByIdInTx(workspaceId, tx);
        return workspace?.organizationId ?? null;
      });
      if (organizationId) organizationIds.add(organizationId);
    }
    return [...organizationIds];
  },

  /**
   * The workspaces of `organizationId` that hold at least one Motir-hosted repo.
   *
   * The traversal is mirror → workspace → org, one workspace at a time, and that
   * direction is NOT a preference: `workspace`'s RLS admits a row only via
   * `id = app.workspace_id` or the caller's own memberships and has no
   * `app.system_admin` escape, so "list an org's workspaces" is simply not a read
   * a background path can make (see `githubRepoRepository.listWorkspaceIdsByOwner`).
   * Binding each candidate workspace's own GUC and reading ITS row back is the
   * reachable direction — the same one `ciMinutesMeterService` §5.2 takes — and a
   * pleasant consequence is that RLS itself, not this code, is what stops a
   * workspace in another org from being touched.
   */
  async listOwnedWorkspaceIds(
    organizationId: string,
    owners: readonly string[],
  ): Promise<string[]> {
    const candidates = await workspaceIdsOwnedBy(owners);

    const owned: string[] = [];
    for (const workspaceId of candidates) {
      const matches = await withWorkspaceServiceContext(workspaceId, async (tx) => {
        const workspace = await workspaceRepository.findByIdInTx(workspaceId, tx);
        return workspace?.organizationId === organizationId;
      });
      if (matches) owned.push(workspaceId);
    }
    return owned;
  },
};

/**
 * Push every pending row in these workspaces to GitHub, marking each one applied
 * as it lands.
 *
 * Per-row isolation is the contract: one repository's failure must not abandon
 * the rest of the fan-out, so each call is caught individually and the row simply
 * stays pending. Marking happens per row too — a crash mid-fan-out loses no
 * progress, because every row that DID land is already stamped.
 */
async function assertPending(
  workspaceIds: string[],
  owners: readonly string[],
): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;

  for (const workspaceId of workspaceIds) {
    const pending = await withWorkspaceServiceContext(workspaceId, async (tx) => {
      const ids = (
        await projectRepoRepository.listCiActionsPendingByWorkspace(workspaceId, tx)
      ).map((row) => row.id);
      if (ids.length === 0) return [];
      const rows = await projectRepoRepository.listMotirCreatedByWorkspace(workspaceId, tx);
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.flatMap((id) => {
        const row = byId.get(id);
        // Re-check the owner at call time rather than trusting the enumeration:
        // a repo transferred out of Motir's org (MOTIR-711) is the user's, and
        // its Actions settings are no longer Motir's to touch.
        if (!row?.githubRepo || !isMotirHostedOwner(row.githubRepo.owner, owners)) return [];
        return [
          {
            id: row.id,
            // Motir's cuid for the installation — resolved to GitHub's id below.
            installationRowId: row.githubRepo.installationId,
            owner: row.githubRepo.owner,
            repo: row.githubRepo.name,
            disabled: row.ciActionsDisabled,
          },
        ];
      });
    });

    // GitHub's NUMERIC installation ids (MOTIR-10062). The mirror's
    // `installationId` is the foreign key to `GithubInstallation.id`, a cuid GitHub
    // never issued — a token minted for it is a 404, so no pause or resume would
    // ever land. Read under `withSystemContext`: the provisioning installation
    // Motir-created repositories live in is shared and has no `workspace_id`.
    const hostInstallationIds =
      pending.length === 0
        ? new Map<string, string>()
        : await withSystemContext((tx) =>
            githubInstallationRepository.findHostInstallationIdsByIds(
              pending.map((row) => row.installationRowId),
              tx,
            ),
          );

    for (const row of pending) {
      try {
        const installationId = hostInstallationIds.get(row.installationRowId);
        if (!installationId) {
          throw new Error(
            'the GitHub installation this repository lives in is no longer on record',
          );
        }
        await actionsPermissionsClient.setActionsEnabled({
          installationId,
          owner: row.owner,
          repo: row.repo,
          enabled: !row.disabled,
        });
      } catch (err) {
        failed += 1;
        console.error(
          `[ciActionsGateService] could not ${row.disabled ? 'disable' : 'enable'} Actions on ` +
            `${row.owner}/${row.repo}; intent stays pending for the next sweep:`,
          err instanceof Error ? err.message : 'unknown',
        );
        continue;
      }
      // Stamp only what actually landed, and only after it landed. Under the
      // WORKSPACE GUC — `project_repository`'s policy is FOR ALL and predicates
      // purely on `app.workspace_id`, so a bare `db.$transaction` would write
      // nothing in production (the app connects as the non-BYPASSRLS
      // `motir_app` role) and every row would silently re-pend forever.
      await withWorkspaceServiceContext(workspaceId, (tx) =>
        projectRepoRepository.markCiActionsApplied(row.id, tx),
      );
      applied += 1;
    }
  }

  return { applied, failed };
}

/** Every workspace holding a mirror under one of these owners, de-duplicated. */
async function workspaceIdsOwnedBy(owners: readonly string[]): Promise<string[]> {
  return withSystemContext(async (tx) => {
    const ids = new Set<string>();
    for (const owner of owners) {
      for (const row of await githubRepoRepository.listWorkspaceIdsByOwner(owner, tx)) {
        ids.add(row.workspaceId);
      }
    }
    return [...ids];
  });
}
