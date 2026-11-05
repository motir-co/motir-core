// A PLATFORM ADMIN'S STOP of one organisation's containers (Story MOTIR-6905 ·
// MOTIR-7317) — what the tenant page's confirmation shows, and what the stop did.

/** What a stop WOULD do now. */
export interface FleetStopPreviewDTO {
  /** Live GitHub Actions runs on the org's Motir-hosted repositories; null when
   *  GitHub could not be read — the confirmation says it does not know. */
  ciRuns: number | null;
  /** CI containers in flight. */
  ciContainers: number;
  /** Hosted-agent runs holding a container. */
  hostedRuns: number;
  /** Agent instances running now. */
  agentInstances: number;
  /** Index containers — counted, and NOT stopped: indexing is never charged. */
  indexContainers: number;
}

/** What one stop achieved. A partial stop is a result, never a throw. */
export interface FleetStopResultDTO {
  runsCancelled: number;
  ciContainersStopped: number;
  /** Hosted runs this stop closed (one already closed is not counted). */
  hostedRunsEnded: number;
  agentInstancesHibernated: number;
  failures: {
    /** Repositories whose runs could not be cancelled, and containers that could
     *  not be torn down. */
    ci: number;
    /** Hosted runs that could not be ended, or whose key could not be revoked. */
    hosted: number;
    /** Agent instances whose stop did not confirm. */
    instances: number;
  };
}

/**
 * The newest `fleet.stop` audit row for an organisation — the tenant page's
 * Fleet card shows it back in its foot (MOTIR-7320 · design S4 k), so an
 * operator who just stopped an org sees the record without leaving the card.
 */
export interface FleetLastStopDTO {
  /** ISO-8601. */
  at: string;
  /** The actor's email; null when the user row could not be read. */
  actorEmail: string | null;
  reason: string | null;
  /** The counts the stop wrote into the row's metadata; 0 where absent. */
  runsCancelled: number;
  ciContainersStopped: number;
  hostedRunsEnded: number;
  agentInstancesHibernated: number;
}

/**
 * The newest stop an ORGANISATION owner or admin made of the org's own fleet
 * work — read from the stored `org_admin_stop` end and teardown reasons, never
 * from `fleet.stop` rows, so the tenant page's Fleet card shows it apart from a
 * platform stop. One Stop everything ends many rows within seconds: the counts
 * are the rows of each kind inside the 10-minute window ending at `at`. The
 * admin's name is in neither record, so it carries no actor.
 */
export interface FleetLastOrgAdminStopDTO {
  /** ISO-8601 — the newest of the two stored times. */
  at: string;
  ciContainersStopped: number;
  agentInstancesHibernated: number;
}
