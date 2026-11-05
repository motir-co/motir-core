import type {
  CiRunnerProvisioningIntent,
  FleetMachineKill,
  OrgFleetLastStop,
} from '@/generated/prisma/client';
import type { AttributionKillReason } from '@/lib/ciFleet/attributionErrors';
import type { FleetUseDTO } from '@/lib/dto/fleetUse';
import type {
  OrgFleetAgentInstanceDTO,
  OrgFleetCiJobDTO,
  OrgFleetHostedRunDTO,
  OrgFleetLastStopDTO,
  OrgFleetMotirStopDTO,
  OrgFleetTilesDTO,
  OrgFleetWaitingCause,
} from '@/lib/dto/orgFleet';
import { CI_RUNNER_INTENT_PENDING } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';

// THE ORG FLEET READ → its tenant DTO. Field by field, never a spread: a column
// added to an intent, an instance or a kill row (a machine id, a shard, a
// region, an app name, a provider's failure text) never reaches a tenant by
// default.

const KILL_REASONS: ReadonlySet<AttributionKillReason> = new Set<AttributionKillReason>([
  'no_record',
  'record_ended',
  'org_stopped',
  'foreign_org',
]);

export function isMotirStopReason(reason: string): reason is AttributionKillReason {
  return KILL_REASONS.has(reason as AttributionKillReason);
}

/** The figures as Fleet use ships them — only the parts the tiles draw. */
export function toOrgFleetTilesDTO(fleetUse: FleetUseDTO): OrgFleetTilesDTO {
  return {
    plan: fleetUse.plan,
    countsRead: fleetUse.countsRead,
    figures: {
      agentRunsInParallel: fleetUse.figures.agentRunsInParallel,
      agentsInOrg: fleetUse.figures.agentsInOrg,
      agentsPerPerson: fleetUse.figures.agentsPerPerson,
      ciJobsInFlight: fleetUse.figures.ciJobsInFlight,
    },
  };
}

/** The run page's address for a run. */
export function runUrlOf(dispatchRunId: string): string {
  return `/runs?run=${encodeURIComponent(dispatchRunId)}`;
}

/** The GitHub Actions run's address. */
export function actionsUrlOf(
  intent: Pick<CiRunnerProvisioningIntent, 'repoOwner' | 'repoName' | 'runId'>,
): string {
  const owner = encodeURIComponent(intent.repoOwner);
  const name = encodeURIComponent(intent.repoName);
  return `https://github.com/${owner}/${name}/actions/runs/${encodeURIComponent(intent.runId)}`;
}

export function toOrgFleetHostedRunDTO(input: {
  id: string;
  startedAt: Date;
  projectName: string | null;
  card: { key: string; title: string | null } | null;
  dispatcherName: string | null;
}): OrgFleetHostedRunDTO {
  return {
    id: input.id,
    projectName: input.projectName,
    card: input.card ? { key: input.card.key, title: input.card.title } : null,
    dispatcherName: input.dispatcherName,
    startedAt: input.startedAt.toISOString(),
    runUrl: runUrlOf(input.id),
  };
}

export function toOrgFleetAgentInstanceDTO(
  instance: { id: string; profileId: string; state: string; stateChangedAt: Date },
  names: { ownerName: string | null; projectName: string | null },
  ownedByViewer: boolean,
): OrgFleetAgentInstanceDTO {
  return {
    id: instance.id,
    ownerName: names.ownerName,
    profileId: instance.profileId,
    projectName: names.projectName,
    state: instance.state,
    since: instance.stateChangedAt.toISOString(),
    ownedByViewer,
  };
}

export function toOrgFleetCiJobDTO(
  intent: CiRunnerProvisioningIntent,
  projectName: string | null,
  waitingCauseOf: (reason: string | null) => OrgFleetWaitingCause,
): OrgFleetCiJobDTO {
  const waiting = intent.status === CI_RUNNER_INTENT_PENDING;
  return {
    id: intent.id,
    repository: `${intent.repoOwner}/${intent.repoName}`,
    workflowName: intent.workflowName,
    jobName: intent.jobName,
    projectName,
    queuedAt: intent.queuedAt.toISOString(),
    state: waiting ? 'waiting' : 'in_flight',
    waitingCause: waiting ? waitingCauseOf(intent.waitingReason) : null,
    actionsUrl: actionsUrlOf(intent),
  };
}

/** A kill row, or null for a reason this read does not know (never guessed). */
export function toOrgFleetMotirStopDTO(kill: FleetMachineKill): OrgFleetMotirStopDTO | null {
  if (!isMotirStopReason(kill.reason)) return null;
  return {
    decidedAt: kill.decidedAt.toISOString(),
    workload: kill.workload,
    reason: kill.reason,
    completed: kill.completedAt !== null,
  };
}

/** The last-stop row → its line. The actor's user id never leaves. */
export function toOrgFleetLastStopDTO(row: OrgFleetLastStop): OrgFleetLastStopDTO {
  return {
    actorName: row.actorName,
    action: row.action,
    at: row.stoppedAt.toISOString(),
  };
}
