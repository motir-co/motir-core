// The verdict of the hosted-agent image LAG probe (MOTIR-10882), a probe of
// `system.daily-health-check`: does the `MOTIR_HOSTED_AGENT_IMAGE` this
// deployment boots follow the newest image the hosted-agent lane published on
// `main`? The arms are written out flat so the memoized step's pinned shape
// reads as plain objects.

/** The newest `main` build of the hosted-agent image, as the registry answers it. */
export interface HostedAgentMainBuildDTO {
  /** The `:main` reference that was read. */
  reference: string;
  /** The digest `:main` resolves to — what a pin of it would name. */
  digest: string;
  /** When that image was built (its config's `created`), ISO 8601; null only on
   *  a `current` verdict whose config records no build time. */
  createdAt: string | null;
}

/** How far a newer `main` build is ahead of the pin. */
export interface HostedAgentImageLagDTO {
  /** How long the newest `main` build has existed, in hours (one decimal). */
  unpinnedHours: number;
  /** How much newer it is than the pinned build, in hours; null when the pinned
   *  image's build time could not be read. */
  behindHours: number | null;
  /** The pinned image's build time, ISO 8601, or null when it could not be read. */
  pinnedCreatedAt: string | null;
}

export type HostedAgentImageLagVerdictDTO =
  /** The fake orchestrator, or no `MOTIR_HOSTED_AGENT_IMAGE`: nothing is pinned. */
  | { verdict: 'not_applicable'; checkedAt: string; detail: string }
  /** The pin IS the newest `main` build. */
  | { verdict: 'current'; checkedAt: string; pinned: string; main: HostedAgentMainBuildDTO }
  /** A newer `main` build exists, but within both allowances — its pin pull
   *  request is expected to be open. Recorded, never loud. */
  | {
      verdict: 'pending';
      checkedAt: string;
      pinned: string;
      main: HostedAgentMainBuildDTO;
      lag: HostedAgentImageLagDTO;
    }
  /** The newest `main` build has gone unpinned for more than a day, or the pin is
   *  more than a week behind it. Loud. */
  | {
      verdict: 'lagging';
      checkedAt: string;
      pinned: string;
      main: HostedAgentMainBuildDTO;
      lag: HostedAgentImageLagDTO;
    }
  /** The pin or the registry could not be read. Recorded; a streak is the alarm. */
  | {
      verdict: 'indeterminate';
      checkedAt: string;
      /** `pin` — the configured value is not a usable digest pin; `registry` —
       *  `:main` could not be read, or named no digest or build time. */
      phase: 'pin' | 'registry';
      reference: string;
      detail: string;
    };
