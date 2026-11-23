import { randomUUID } from 'node:crypto';
import {
  FLEET_CONTAINER_SIZE,
  hostedAgentFleetConfig,
  isOrchestratorConfigured,
} from '@/lib/orchestrator';
import type { WorkloadPeriodContainerCost } from '@/lib/repositories/ciContainerPeriodCostRepository';
import {
  hostedAgentContainerService,
  type HostedAgentContainerOutcome,
  type HostedAgentSupervisionOptions,
} from '@/lib/services/hostedAgentContainerService';
import { buildFleetCostReadout } from './fleetCostReadoutQuery';

// THE HOSTED-AGENT METER REHEARSAL, CALLABLE (Story MOTIR-4336 · MOTIR-4713).
//
// Boots ONE stand-in container through the metering seam, supervises it to its
// end in this process, settles it, and prints the usage record it wrote and the
// org's `agent` line — so "does a container under `hosted_agent` leave a priced
// row on the right line?" is answerable against a real fleet before Epic 9 has an
// agent to put in one.
//
// ⚠️ THE STAND-IN IS THE HOSTED-AGENT IMAGE, BOOTED WITH NONE OF ITS VARIABLES.
// `hostedAgentFleetConfig` already resolves a digest-pinned, pullable reference
// for it, and its launcher validates every required input before doing anything
// and exits `20` (SETUP_FAILED) naming every missing one
// (`packages/cli/sandbox/hosted/entrypoint.ts`). So an empty env is the smallest
// spec that makes it start, stop within seconds, and touch no repository,
// credential or control plane — enough to leave a started, stopped, priced
// `agent` row and nothing else. (It was the INDEXER image until MOTIR-12037
// retired the index fleet and `indexFleetConfig` with it.)
//
// ⚠️ THE GATE IS THE READOUT'S. Off-cloud the meter records nothing, so this
// stops before provisioning anything rather than booting a container whose cost
// nobody would write down. Internal COGS only: nothing here is a charge.

/** The stand-in's hard kill. It is expected to exit in seconds; this bounds a
 *  stand-in that does not. */
export const REHEARSAL_TIMEOUT_SECONDS = 300;

export interface HostedAgentRehearsalArgs {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  repoFullName: string;
  /** Test seams only; the command passes none. */
  options?: HostedAgentSupervisionOptions;
}

export interface HostedAgentRehearsal {
  /** Null when nothing was booted — the meter is disabled or no fleet is configured. */
  outcome: HostedAgentContainerOutcome | null;
  /** The org's `agent` line after the run; null when absent or nothing was read. */
  agentLine: WorkloadPeriodContainerCost | null;
  text: string;
}

export async function rehearseHostedAgentMeter(
  args: HostedAgentRehearsalArgs,
): Promise<HostedAgentRehearsal> {
  const before = await buildFleetCostReadout({
    organizationId: args.organizationId,
    at: new Date(),
  });
  if (!before.input) {
    return {
      outcome: null,
      agentLine: null,
      text: [
        'HOSTED-AGENT METER REHEARSAL',
        '',
        '  meter: disabled — nothing was booted.',
        '',
      ].join('\n'),
    };
  }
  if (!isOrchestratorConfigured()) {
    return {
      outcome: null,
      agentLine: null,
      text: [
        'HOSTED-AGENT METER REHEARSAL',
        '',
        '  no container fleet is configured on this deployment — nothing was booted.',
        '',
      ].join('\n'),
    };
  }

  const standIn = hostedAgentFleetConfig();
  const dispatchId = `agent-meter-rehearsal-${randomUUID()}`;
  const outcome = await hostedAgentContainerService.run(
    {
      dispatchId,
      runId: dispatchId,
      // A stand-in serves no dispatch run, and the meter column is a foreign key,
      // so the rehearsal's row is honestly unnamed (MOTIR-6448).
      dispatchRunId: null,
      organizationId: args.organizationId,
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      repoFullName: args.repoFullName,
      image: standIn.image,
      env: {},
      region: standIn.region,
      size: FLEET_CONTAINER_SIZE,
      timeoutSeconds: REHEARSAL_TIMEOUT_SECONDS,
    },
    args.options,
  );

  const at = outcome.outcome === 'settled' ? outcome.usage.stoppedAt : new Date();
  const after = await buildFleetCostReadout({ organizationId: args.organizationId, at });
  const agentLine = after.input?.org?.lines.find((line) => line.workload === 'agent') ?? null;

  return { outcome, agentLine, text: render(outcome, agentLine) };
}

function render(
  outcome: HostedAgentContainerOutcome,
  agentLine: WorkloadPeriodContainerCost | null,
): string {
  const out = ['HOSTED-AGENT METER REHEARSAL', ''];
  if (outcome.outcome !== 'settled') {
    // Every non-settled outcome carries its `detail`, so the narrowing is the proof.
    out.push(`  outcome: ${outcome.outcome} — ${outcome.detail}`, '');
    return out.join('\n');
  }
  const { usage } = outcome;
  // A settled container is always priced: the seam refuses an unpriced machine
  // class at boot ("the unpriced refusal happens BEFORE any spend",
  // tests/ciFleet/hostedAgentMeterStoryGate.test.ts), so `UNPRICED` is only ever
  // printed for a row this command could not have produced.
  /* v8 ignore next */
  const rateFrom = usage.rateEffectiveFrom ? usage.rateEffectiveFrom.toISOString() : 'UNPRICED';
  out.push(
    '  usage record',
    `    container        ${usage.provider}/${usage.handleId} (${usage.region})`,
    `    workload         ${usage.workload}`,
    `    machine          ${usage.cpuKind} ${usage.cpus} vCPU / ${usage.memoryMb} MB`,
    `    started          ${usage.startedAt ? usage.startedAt.toISOString() : '—'}`,
    `    stopped          ${usage.stoppedAt.toISOString()}`,
    `    exit code        ${outcome.exitCode ?? 'not observed'}`,
    `    teardown reason  ${usage.teardownReason}`,
    `    billable seconds ${usage.billableSeconds}`,
    `    usd per second   ${usage.usdPerSecond}`,
    `    cost usd         ${usage.costUsd}`,
    `    rate from        ${rateFrom}`,
    '',
  );
  out.push(
    agentLine
      ? `  agent line: ${agentLine.containerCount} container(s), ${agentLine.containerSeconds} s, $${agentLine.costUsd}`
      : '  agent line: ABSENT for this period — no row was recorded.',
    '',
  );
  return out.join('\n');
}
