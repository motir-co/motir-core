import type { AttributionKillReason } from '@/lib/ciFleet/attributionErrors';
import type { FleetUseDTO, FleetUseWaitingDTO } from '@/lib/dto/fleetUse';

/**
 * WHAT AN ORGANISATION RUNS ON THE FLEET, NOW — the Settings › Organization ›
 * Fleet page's one read, for the org's owner or admin only.
 *
 * Every part is the org's OWN and fails alone: `{ kind: 'read', … }`, or
 * `{ kind: 'not_read' }` when that part could not be read. A part that was not
 * read is never an empty list or a 0.
 *
 * It must NEVER carry an organisation id, AWS account id, shard id, credential
 * ref, machine id, volume id, region, provider app name or user id, and no row
 * carries a link to an agent's panel or terminal. Built field by field
 * (`lib/mappers/orgFleetMappers.ts`), never by spreading a row. Codes, never
 * sentences: the page owns every word.
 */

export type OrgFleetPart<T> = ({ kind: 'read' } & T) | { kind: 'not_read' };

/** The org Fleet use figures, as Billing & plans › Fleet use ships them. */
export interface OrgFleetTilesDTO {
  plan: FleetUseDTO['plan'];
  /** False when the counts could not be read: every `inUse` and `waiting` is null. */
  countsRead: boolean;
  figures: FleetUseDTO['figures'];
}

/** A hosted agent run holding a fleet slot. */
export interface OrgFleetHostedRunDTO {
  /** The dispatch run id — what the Cancel action addresses. */
  id: string;
  /** Null when the project could not be named (it was deleted). */
  projectName: string | null;
  /** The run's card — its scope target, else its first leg; null when it has neither. */
  card: { key: string; title: string | null } | null;
  /** The display name of who started it; null when unknown. */
  dispatcherName: string | null;
  startedAt: string;
  /** The run page, in this app. */
  runUrl: string;
}

/** A member's agent instance — metadata only. */
export interface OrgFleetAgentInstanceDTO {
  /** The agent instance id — what the Hibernate action addresses. */
  id: string;
  ownerName: string | null;
  profileId: string;
  projectName: string | null;
  /** The instance's lifecycle state, as stored (`running`, `hibernated`, …). */
  state: string;
  /** When it entered that state. */
  since: string;
  /** The reader's own agent — a boolean, never the owner's id: a Hibernate of it
   *  tells nobody (MOTIR-10368 skips the self-notification). */
  ownedByViewer: boolean;
}

export type OrgFleetCiJobState = 'in_flight' | 'waiting';
export type OrgFleetWaitingCause = keyof FleetUseWaitingDTO;

/** One CI job in flight or waiting for a container. */
export interface OrgFleetCiJobDTO {
  id: string;
  /** `owner/name`. */
  repository: string;
  workflowName: string | null;
  jobName: string | null;
  projectName: string | null;
  queuedAt: string;
  state: OrgFleetCiJobState;
  /** Fleet use's bucket for a waiting job; null for one in flight. */
  waitingCause: OrgFleetWaitingCause | null;
  /** The GitHub Actions run. */
  actionsUrl: string;
}

/** The closed codes of why Motir stopped a machine — the attribution
 *  reconciler's own (`foreign_org`: the org's own account ran another org's work). */
export type OrgFleetMotirStopReason = AttributionKillReason;

/** A machine of the org that Motir itself stopped. */
export interface OrgFleetMotirStopDTO {
  decidedAt: string;
  /** The kind of work it ran; null when it carried none. */
  workload: string | null;
  reason: OrgFleetMotirStopReason;
  completed: boolean;
}

/** What an owner or admin stopped, as recorded. */
export type OrgFleetStopActionDTO = 'stop_everything' | 'cancel_hosted_run' | 'hibernate_agent';

/** The org's newest owner or admin stop — the "Last stopped by" line. */
export interface OrgFleetLastStopDTO {
  /** The display name at the stop; null when it could not be read then. */
  actorName: string | null;
  action: OrgFleetStopActionDTO;
  /** ISO-8601. */
  at: string;
}

export interface OrgFleetDTO {
  tiles: OrgFleetPart<OrgFleetTilesDTO>;
  hostedRuns: OrgFleetPart<{ rows: OrgFleetHostedRunDTO[] }>;
  agentInstances: OrgFleetPart<{ rows: OrgFleetAgentInstanceDTO[] }>;
  ciJobs: OrgFleetPart<{
    inFlight: number;
    waiting: FleetUseWaitingDTO;
    rows: OrgFleetCiJobDTO[];
  }>;
  /** Not charged and not stopped here: a count only. */
  indexJobs: OrgFleetPart<{ running: number }>;
  /** The last seven days, newest first. */
  motirStops: OrgFleetPart<{ since: string; entries: OrgFleetMotirStopDTO[] }>;
  /** Null inside `read` when no owner or admin has stopped anything yet. */
  lastStop: OrgFleetPart<{ stop: OrgFleetLastStopDTO | null }>;
}
