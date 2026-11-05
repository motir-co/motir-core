/**
 * AN ORGANISATION OWNER OR ADMIN'S STOPS of the org's own fleet work
 * (`docs/decisions/agent-instances.md` §8 AMENDMENT 8) — what the Fleet page's
 * confirmations show, and what each stop did.
 *
 * Counts, times, display names and the ids the page itself addresses — never an
 * organisation id, AWS account id, shard id, credential ref, machine id or
 * provider app name. Built field by field in `orgFleetStopService`.
 */

/** What Stop everything WOULD stop now. A count that could not be read is null,
 *  never 0, so the page can refuse to confirm. */
export interface OrgFleetStopPreviewDTO {
  /** Live GitHub Actions runs on the org's Motir-hosted repositories. */
  ciRuns: number | null;
  /** CI containers in flight. */
  ciContainers: number | null;
  /** Hosted-agent runs holding a container. */
  hostedRuns: number | null;
  /** Agent instances running now. */
  runningAgents: number | null;
  /** Index containers — for information: they are never stopped. */
  indexContainers: number | null;
}

/** What one Stop everything achieved. A partial stop is a result, never a throw. */
export interface OrgFleetStopResultDTO {
  runsCancelled: number;
  ciContainersStopped: number;
  /** Hosted runs this stop closed (one already closed is not counted). */
  hostedRunsEnded: number;
  agentsHibernated: number;
  failures: {
    /** Repositories whose runs could not be cancelled, and containers not torn down. */
    ci: number;
    /** Hosted runs that could not be ended, or whose key could not be revoked. */
    hosted: number;
    /** Agents whose stop did not confirm. */
    agents: number;
  };
  /** The acting owner or admin's display name; null when it could not be read. */
  stoppedByName: string | null;
  /** ISO-8601. */
  stoppedAt: string;
}

/** What Cancel did to one hosted run. `closed: false`: it had already closed. */
export interface OrgFleetCancelRunOutcomeDTO {
  dispatchRunId: string;
  closed: boolean;
  /** ISO-8601. */
  at: string;
}

/**
 * What Hibernate did to one agent. `already_resting`: it was hibernating or
 * hibernated already; `in_motion`: it is starting, waking, updating or being
 * deleted, and its own settle decides where it lands. Neither is an error.
 */
export type OrgFleetHibernateOutcomeDTO =
  | {
      kind: 'hibernated';
      instanceId: string;
      /** Whose agent it is — the owner the notification tells. */
      ownerUserId: string;
      actorUserId: string;
      /** ISO-8601. */
      at: string;
    }
  | { kind: 'already_resting'; instanceId: string }
  | { kind: 'in_motion'; instanceId: string };
