import {
  MOTIR_ARM64_RUNNER_LABEL,
  MOTIR_RUNNER_ARM64_VARIABLE,
  MOTIR_RUNNER_LABEL,
  MOTIR_RUNNER_VARIABLE,
} from '@/lib/ciFleet/config';
import { readArm64RunnerAmiId } from '@/lib/orchestrator';
import { isRepoProvisioningConfigured } from '@/lib/github/repoProvisioning';
import {
  actionsVariableClient,
  type EnsureOrgVariableOutcome,
} from '@/lib/github/actionsVariables';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';

// THE WRITER FOR `vars.MOTIR_RUNNER` (Story MOTIR-1916 · MOTIR-2015) — the half of
// the runner-selection seam that had a reader and nothing else.
//
// MOTIR-1925 shipped `runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}` across
// the starter's 5 job sites, and `repoProvisioning.ts` seeds the same expression
// into an initialised repo's CI stub. Nothing ever SET the variable, so it was
// always empty, `runs-on` always resolved to `ubuntu-latest`, no queued job's
// requested labels ever contained the fleet label, and `isMotirFleetJob()` refused
// every job that will ever exist. The fleet was unreachable — and, worse, silently
// so: every job ran green on GitHub-hosted, which is what a working system also
// looks like.
//
// ⚠️ THE VALUE IS `MOTIR_RUNNER_LABEL`, IMPORTED — NEVER A SECOND LITERAL. This is
// the third place the fleet's label has to agree (the runner's own
// `--no-default-labels` registration, the `isMotirFleetJob` gate, and now this
// write), and `lib/ciFleet/config.ts` already carries the story of what a second
// literal cost: MOTIR-1920 and MOTIR-1923 each declared `'motir-runner'`, the
// merge produced the drift the shared export exists to prevent, and MOTIR-1964 was
// the red `main` that followed. A literal here would be worse than that one,
// because it would be the value GitHub actually serves to workflows: edit it alone
// and every job requests a label the gate no longer recognises, so the fleet stops
// booting while every workflow still reports green. `tests/ciFleet/
// fleetRunnerVariable.test.ts` fails if the literal reappears at this write site.
//
// ⚠️ ORG-LEVEL, AND THAT IS WHAT MAKES THE HANDOVER FREE (ADR §N.1). See the
// boundary module for the full argument; the consequence for THIS service is that
// it has exactly one method and no per-repository bookkeeping. There is no unset
// to remember on MOTIR-711's transfer path, because a repository that leaves
// Motir's org stops resolving Motir's org variables by construction.
//
// ⚠️ IT IS A SIDE EFFECT, AND IT NEVER FAILS AN ESTABLISHMENT — the same contract
// `projectRunnerGroupService.syncQuietly` holds, for the same reason (ADR §4.2): a
// created repository cannot be rolled back, so nothing about the fleet may turn a
// settled row into a failed one. A repository established while this call is
// failing simply runs on GitHub-hosted runners — which is exactly what the
// `|| 'ubuntu-latest'` fallback is for — until the next establishment re-runs the
// ensure.

/** What the establish path did to `MOTIR_RUNNER_ARM64` (Story MOTIR-11779 ·
 *  MOTIR-11786). Independent of the x86 outcome: an arm64 refusal never changes
 *  it, and never fails an establishment. */
export type FleetRunnerArm64VariableOutcome =
  /** The org variable now holds the arm64 fleet label. */
  | { outcome: 'ensured'; result: EnsureOrgVariableOutcome }
  /** No arm64 runner AMI is pinned on this deployment, so nothing was written:
   *  arm64 jobs keep their GitHub fallback. */
  | { outcome: 'not_ready' }
  /** GitHub refused or was unreachable. */
  | { outcome: 'ensure_failed'; detail: string };

export type FleetRunnerVariableOutcome =
  /** This deployment never provisions repositories (self-hosted, or the Studio App
   *  / provisioning org is unwired), so there is no fleet and no variable to
   *  write. A first-class state, not a misconfiguration — the same branch
   *  `projectRunnerGroupService` opens with. */
  | { outcome: 'not_configured' }
  /** The org variable now holds the fleet label. */
  | {
      outcome: 'ensured';
      result: EnsureOrgVariableOutcome;
      arm64: FleetRunnerArm64VariableOutcome;
    }
  /** GitHub refused or was unreachable. Repositories still establish; their CI
   *  runs GitHub-hosted until a later pass succeeds. */
  | { outcome: 'ensure_failed'; detail: string; arm64: FleetRunnerArm64VariableOutcome };

/** A constant message + a structured context object, never a template literal
 *  carrying a value — `console.*`'s first argument is a FORMAT string, and the
 *  sibling fleet services hold the same posture. */
function logEnsureFailure(variable: string, org: string | null, detail: string): void {
  console.error(
    '[fleetRunnerVariableService] could not ensure the fleet runner variable — ' +
      'repositories still establish and their CI runs GitHub-hosted',
    { variable, org, detail },
  );
}

const detailOf = (err: unknown): string => (err instanceof Error ? err.message : 'unknown');

/** `MOTIR_RUNNER_ARM64` = the arm64 fleet label, when the arm64 pool is ready. */
async function ensureArm64(target?: GithubOrgTarget): Promise<FleetRunnerArm64VariableOutcome> {
  if (readArm64RunnerAmiId() === null) return { outcome: 'not_ready' };
  try {
    const result = await actionsVariableClient.ensureOrgVariable(
      MOTIR_RUNNER_ARM64_VARIABLE,
      MOTIR_ARM64_RUNNER_LABEL,
      target,
    );
    return { outcome: 'ensured', result };
  } catch (err) {
    const detail = detailOf(err);
    logEnsureFailure(MOTIR_RUNNER_ARM64_VARIABLE, target?.org ?? null, detail);
    return { outcome: 'ensure_failed', detail };
  }
}

export const fleetRunnerVariableService = {
  /**
   * Make Motir's provisioning org carry `MOTIR_RUNNER = <the fleet label>`, so
   * every repository Motir hosts selects the fleet. With a `target` (MOTIR-8966)
   * the variable is ensured in the tenant's assigned GitHub org instead.
   *
   * ORG-WIDE, SO IT IS NOT PER-REPOSITORY WORK. It is nonetheless called from the
   * establish flow rather than from a one-time bootstrap, and that is deliberate:
   * establishment is the moment a repository that READS the variable comes into
   * existence, so it is the only event that can guarantee the variable precedes
   * its first reader. The cost of re-running it is one conditional GET (the
   * ensure's read short-circuits when the value is already right), and the benefit
   * is self-healing — a variable deleted or edited by hand comes back on the next
   * establishment instead of at the next incident.
   *
   * THE ARM64 VARIABLE (MOTIR-11786) is ensured beside it, on the same readiness
   * condition the console's flip uses — an arm64 runner AMI pinned
   * (`readArm64RunnerAmiId()`). The two writes are independent: each is tried,
   * and neither's failure changes the other's outcome.
   */
  async ensureForFleet(target?: GithubOrgTarget): Promise<FleetRunnerVariableOutcome> {
    if (!isRepoProvisioningConfigured()) return { outcome: 'not_configured' };
    let x86:
      | { outcome: 'ensured'; result: EnsureOrgVariableOutcome }
      | { outcome: 'ensure_failed'; detail: string };
    try {
      const result = await actionsVariableClient.ensureOrgVariable(
        MOTIR_RUNNER_VARIABLE,
        MOTIR_RUNNER_LABEL,
        target,
      );
      x86 = { outcome: 'ensured', result };
    } catch (err) {
      const detail = detailOf(err);
      logEnsureFailure(MOTIR_RUNNER_VARIABLE, target?.org ?? null, detail);
      x86 = { outcome: 'ensure_failed', detail };
    }
    return { ...x86, arm64: await ensureArm64(target) };
  },

  /**
   * {@link ensureForFleet} as a SIDE EFFECT — the form the establish path uses.
   *
   * `ensureForFleet` already converts every GitHub refusal into an outcome, so this
   * wrapper exists for the failures it does NOT model: an unexpected throw out of
   * the auth path or the client. Failing an establishment over a variable would
   * report a settled row as failed and destroy the one artifact that cannot be
   * recreated, so the contract is enforced here rather than re-remembered at each
   * call site — the same shape as `projectRunnerGroupService.syncQuietly`.
   */
  async ensureQuietly(target?: GithubOrgTarget): Promise<void> {
    try {
      await this.ensureForFleet(target);
    } catch (err) {
      console.error('[fleetRunnerVariableService] could not ensure the fleet runner variable', {
        err,
      });
    }
  },
};
