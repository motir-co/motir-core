import {
  FLEET_CONTAINER_SIZE,
  buildContainerUsage,
  type ContainerUsage,
  type TeardownReason,
} from '@motir/orchestrator';
import type { AgentInstanceIntervalEndReason } from '@/generated/prisma/client';
import { debitAgentMachine } from '@/lib/ai/motirAiClient';
import { MotirAiConfigError, MotirAiError, MotirAiUnavailableError } from '@/lib/ai/errors';
import { isCloudBilling } from '@/lib/billing/availability';
import { machineCreditsFor } from '@/lib/hostedRuns/machineRate';
import { recordContainerUsage, selectedOrchestratorProvider } from '@/lib/orchestrator';
import { agentInstanceIntervalRepository } from '@/lib/repositories/agentInstanceIntervalRepository';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// AN AGENT INSTANCE'S RUNNING INTERVAL IS CHARGED (Story MOTIR-6860 · MOTIR-6873;
// `docs/decisions/agent-instances.md` §5, `hosted-agent-machine-charge.md`).
//
// ⚠️ ONE DEBIT PER INTERVAL, keyed on the interval. The ledger's idempotency key
// is `agent-instance-interval:<id>` (the interval's stored `chargeReference`),
// so motir-ai debits once however often this runs, and the interval row's
// `chargeOutcome` leaves `pending` exactly once — `recordCharge` only writes onto
// a closed interval still `pending`.
//
// ⚠️ SETTLE, THEN METER, THEN CHARGE — the hosted run's order
// (`hostedRunChargeService`): the interval's seconds are durable (it is closed)
// before anything reads them; the COGS meter row is written from those seconds
// (§5: "the meter stays COGS"); the charge is a separate reader of the same
// seconds and never of the meter's cost.
//
// ⚠️ IT NEVER THROWS FOR A CROSS-BOUNDARY FAILURE. A transport failure leaves
// the interval `pending` with the attempt counted, and the sweep's backstop pass
// asks again with the same key; a refusal (4xx) is recorded as `refused`.

export type AgentInstanceChargeResult =
  | { outcome: 'charged'; credits: number; billableSeconds: number; idempotent: boolean }
  | {
      outcome: 'not_charged';
      reason: 'disabled' | 'zero_seconds' | 'unconfigured';
    }
  | { outcome: 'refused'; detail: string }
  | { outcome: 'retryable'; detail: string }
  /** The interval is not closed-and-pending — open, already charged, or gone. */
  | { outcome: 'noop' };

/** An interval's end → the teardown reason its meter row records. */
function teardownReasonFor(endReason: AgentInstanceIntervalEndReason | null): TeardownReason {
  return endReason === 'lost' ? 'reaped' : 'job_completed';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : String(err);
}

export const agentInstanceChargeService = {
  /**
   * Charge ONE closed interval. Idempotent: an interval that is open, already
   * decided, or does not exist answers `noop` and writes nothing.
   */
  async chargeInterval(intervalId: string): Promise<AgentInstanceChargeResult> {
    const found = await withSystemContext(async (tx) => {
      const interval = await agentInstanceIntervalRepository.findById(intervalId, tx);
      if (!interval) return null;
      const instance = await agentInstanceRepository.findById(interval.agentInstanceId, tx);
      if (!instance) return null;
      // The account it lives in names the meter's provider (MOTIR-9472).
      const shard = instance.fleetShardId
        ? await fleetShardRepository.findById(instance.fleetShardId, tx)
        : null;
      return { interval, instance, shardProvider: shard?.provider ?? null };
    });
    if (!found) return { outcome: 'noop' };
    const { interval, instance, shardProvider } = found;
    if (!interval.endedAt || interval.chargeOutcome !== 'pending') return { outcome: 'noop' };

    const billableSeconds = interval.billableSeconds ?? 0;
    const record = (data: Parameters<typeof agentInstanceIntervalRepository.recordCharge>[1]) =>
      withWorkspaceServiceContext(instance.workspaceId, (tx) =>
        agentInstanceIntervalRepository.recordCharge(interval.id, data, tx),
      );

    if (billableSeconds <= 0) {
      await record({ outcome: 'not_charged', credits: 0, detail: 'zero seconds' });
      return { outcome: 'not_charged', reason: 'zero_seconds' };
    }
    if (!isCloudBilling()) {
      await record({ outcome: 'not_charged', credits: 0, detail: 'not a billing build' });
      return { outcome: 'not_charged', reason: 'disabled' };
    }

    // The COGS meter — Motir's own cost of the interval, keyed by the interval so
    // a replay is a duplicate rather than a second row. Best-effort: a meter that
    // fails must not stop the customer's charge, and it logs its own failure.
    // An instance on an AWS hoster account is metered as `aws`, not as the
    // process-wide provider; price and minutes are the same either way.
    const selected = selectedOrchestratorProvider();
    const provider = shardProvider && selected !== 'fake' ? shardProvider : selected;
    const built = buildContainerUsage({
      handle: {
        provider,
        id: `${instance.machineId ?? instance.id}:${interval.id}`,
        region: instance.region,
        createdAt: interval.startedAt,
      },
      attribution: {
        orgId: instance.organizationId,
        workspaceId: instance.workspaceId,
        projectId: instance.projectId,
        repoFullName: '',
        workload: 'agent_instance',
        workflowJobId: null,
        size: FLEET_CONTAINER_SIZE,
        observedStartedAt: interval.startedAt,
      },
      lifecycle: {
        createdAt: interval.startedAt,
        startedAt: interval.startedAt,
        stoppedAt: interval.endedAt,
        // A `rolled` interval's machine is still up — the running charge closed
        // the interval, not the machine (AMENDMENT 2).
        terminalState:
          interval.endReason === 'lost'
            ? 'destroyed'
            : interval.endReason === 'rolled'
              ? 'running'
              : 'stopped',
      },
      reason: teardownReasonFor(interval.endReason),
    });
    const usage: ContainerUsage = { ...built, repoFullName: null };
    try {
      await recordContainerUsage(usage);
    } catch (err) {
      console.error('[agentInstanceCharge] the interval could not be metered', {
        intervalId: interval.id,
        detail: describe(err),
      });
    }

    const credits = machineCreditsFor(billableSeconds, interval.endedAt);
    try {
      const debit = await debitAgentMachine({
        coreOrganizationId: instance.organizationId,
        instanceIntervalId: interval.id,
        credits,
        billableSeconds,
        externalRef: interval.chargeReference,
        reason: 'agent instance machine time',
      });
      await record({ outcome: 'charged', credits, chargedAt: new Date(), detail: null });
      return { outcome: 'charged', credits, billableSeconds, idempotent: debit.idempotent };
    } catch (err) {
      if (err instanceof MotirAiConfigError) {
        await record({ outcome: 'not_charged', credits: 0, detail: 'motir-ai is not configured' });
        return { outcome: 'not_charged', reason: 'unconfigured' };
      }
      const detail = describe(err);
      if (err instanceof MotirAiUnavailableError || !(err instanceof MotirAiError)) {
        // Still `pending`, with the attempt counted — the sweep asks again.
        await record({ outcome: 'pending', detail });
        return { outcome: 'retryable', detail };
      }
      await record({ outcome: 'refused', credits, detail });
      return { outcome: 'refused', detail };
    }
  },
};
