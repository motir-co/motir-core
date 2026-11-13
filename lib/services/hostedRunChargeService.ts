import { withSystemContext } from '@/lib/workspaces/context';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import { debitAgentMachine } from '@/lib/ai/motirAiClient';
import { MotirAiConfigError, MotirAiError, MotirAiUnavailableError } from '@/lib/ai/errors';
import { isCloudBilling } from '@/lib/billing/availability';
import { machineCreditsFor } from '@/lib/hostedRuns/machineRate';

// A HOSTED RUN IS CHARGED FOR ITS MACHINE TIME (Story MOTIR-683 · Subtask
// MOTIR-6514; `docs/decisions/hosted-agent-machine-charge.md`).
//
// ⚠️ THE METER STAYS COGS; THIS IS A SEPARATE READER OF IT. The fleet meter
// (`ciFleetCostMeterService`) answers *what did this container cost Motir* and
// must never become billing; this service answers *what does the customer pay*,
// from the same settled SECONDS and nothing else. The meter's `costUsd` is read by
// neither this file nor the call it makes — Motir's cost never becomes a price,
// and a price never feeds back into the meter.
//
// ⚠️ ONE CHARGE PER RUN, keyed on the run (decision §7). `externalRef` is the
// `DispatchRun.id`, so motir-ai debits once however often this is called; the
// caller's memoized step is what keeps a replayed pass from calling at all.
//
// ⚠️ IT NEVER THROWS FOR A CROSS-BOUNDARY FAILURE. It runs after the meter write
// has committed and after the container is gone, so there is nothing left for a
// failure to roll back; a transport failure comes back as `retryable`, for the
// caller to retry the same run, and a refusal as `refused`.

export type HostedRunChargeResult =
  | {
      outcome: 'charged';
      credits: number;
      billableSeconds: number;
      /** motir-ai had already recorded this run's charge — a retry after a
       *  call that timed out having landed. */
      idempotent: boolean;
      balanceAfter: number;
      exhausted: boolean;
    }
  | {
      outcome: 'not_charged';
      reason: /** Not a billing build — a self-host charges nothing. */
        | 'disabled'
        /** The run is gone, or is not a hosted run. */
        | 'no_run'
        /** Another container of this run is still open; ITS settle charges the run. */
        | 'not_settled'
        /** The run billed no seconds (decision §3: zero seconds, zero credits). */
        | 'zero_seconds'
        /** No motir-ai is configured to charge. */
        | 'unconfigured';
    }
  /** motir-ai refused the charge (4xx) — retrying the same request cannot help. */
  | { outcome: 'refused'; detail: string }
  /** motir-ai could not be reached, or failed (5xx) — retry the same run. */
  | { outcome: 'retryable'; detail: string };

export const hostedRunChargeService = {
  /**
   * Charge ONE hosted run's organization for the run's settled machine time.
   * Call it AFTER the container's settle record has committed.
   */
  async chargeMachineTime(
    dispatchRunId: string,
    options: { now?: () => Date } = {},
  ): Promise<HostedRunChargeResult> {
    if (!isCloudBilling()) return { outcome: 'not_charged', reason: 'disabled' };

    const located = await withSystemContext(async (tx) => {
      const run = await dispatchRunRepository.findById(dispatchRunId, tx);
      // Hosted only. An `instance` run is charged as its agent's machine time, on
      // the agent's intervals — never per run (`agent-instance-run.md` §5).
      if (!run || run.origin !== 'hosted') return null;
      const organizationId = await workspaceRepository.findOrganizationId(run.workspaceId, tx);
      return organizationId
        ? { organizationId, workspaceId: run.workspaceId, projectId: run.projectId }
        : null;
    });
    if (!located) return { outcome: 'not_charged', reason: 'no_run' };
    const { organizationId } = located;

    const machine = await ciFleetCostMeterService.getMachineTimeForDispatchRun(dispatchRunId);
    if (!machine.settled) return { outcome: 'not_charged', reason: 'not_settled' };

    const billableSeconds = Math.ceil(machine.billableSeconds);
    const credits = machineCreditsFor(billableSeconds, (options.now ?? (() => new Date()))());
    if (credits <= 0) return { outcome: 'not_charged', reason: 'zero_seconds' };

    try {
      const debit = await debitAgentMachine({
        coreOrganizationId: organizationId,
        coreRunId: dispatchRunId,
        credits,
        billableSeconds,
        externalRef: dispatchRunId,
        reason: 'Motir agent machine time',
        // WHERE the run ran (MOTIR-7240): the run's own workspace and project, so the
        // platform usage rollup places its coding spend below the org. The client
        // sends the pair only when both are present; the charge never waits on it.
        coreWorkspaceId: located.workspaceId,
        coreProjectId: located.projectId,
      });
      return {
        outcome: 'charged',
        credits,
        billableSeconds,
        idempotent: debit.idempotent,
        balanceAfter: debit.balanceAfter,
        exhausted: debit.exhausted,
      };
    } catch (err) {
      if (err instanceof MotirAiConfigError) {
        return { outcome: 'not_charged', reason: 'unconfigured' };
      }
      const detail = err instanceof Error ? err.message : String(err);
      // Anything that is not a typed motir-ai answer is the transport's (a reset,
      // a DNS failure): the charge may or may not have landed, and the same
      // `externalRef` makes asking again safe.
      if (err instanceof MotirAiUnavailableError || !(err instanceof MotirAiError)) {
        console.warn('[hostedRunChargeService] the machine charge did not reach motir-ai', {
          dispatchRunId,
          detail,
        });
        return { outcome: 'retryable', detail };
      }
      console.error('[hostedRunChargeService] motir-ai refused a machine charge', {
        dispatchRunId,
        credits,
        detail,
      });
      return { outcome: 'refused', detail };
    }
  },
};
