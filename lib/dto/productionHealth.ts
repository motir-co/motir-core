import type { ReleaseLogStream } from '@motir/orchestrator';
import type { HostedReleaseState } from '@/generated/prisma/client';
import type {
  HostedApplicationEventKind,
  HostedHealthCondition,
  HostedHealthState,
} from '@/lib/hosting/healthState';

// A Motir repository's PRODUCTION HEALTH as the panel reads it (Story MOTIR-9799
// · MOTIR-12106): the application's one health state, when it began, the probe
// condition beside it, and its crash events, newest first. Never carries an
// environment value or a provider message; an event's log lines are masked.

export interface ProductionHealthLogLineDto {
  /** ISO 8601. */
  at: string;
  stream: ReleaseLogStream;
  message: string;
}

export interface ProductionHealthEventDto {
  id: string;
  /** ISO 8601. */
  occurredAt: string;
  kind: HostedApplicationEventKind;
  /** `exit code <n>`, `out of memory`, `HTTP <status>` or `timed out`. */
  reason: string;
  /** Up to 50, newest first, masked; empty when the logs could not be read. */
  lastLogLines: ProductionHealthLogLineDto[];
  /** The release it happened on — what a Roll back from it leaves; null when
   *  that release is gone. */
  releaseId: string | null;
  /** That release's commit and its state now (a `rolled_back` one reads
   *  "Rolled back since"); null when it is gone. */
  release: { commitSha: string; state: HostedReleaseState } | null;
}

export interface ProductionHealthDto {
  /** Null before the application's first release has been probed. */
  state: HostedHealthState | null;
  /** ISO 8601; null with no state. */
  since: string | null;
  condition: HostedHealthCondition | null;
  /** The path the health probe asks, from the running release's manifest;
   *  null before it has been read. */
  healthCheckPath: string | null;
  events: ProductionHealthEventDto[];
}
