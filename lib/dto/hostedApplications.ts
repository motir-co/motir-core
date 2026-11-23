// DTO types for a Motir repository's PRODUCTION home (Story MOTIR-9797 ·
// MOTIR-10026). `HostedApplicationDto` never carries the database URL, in any
// form: the ciphertext stays on the row.

import type {
  HostedApplicationState,
  HostedReleaseCause,
  HostedReleaseState,
  HostingTarget,
} from '@/lib/hosting/vocabulary';

export interface HostedReleaseDto {
  id: string;
  applicationId: string;
  commitSha: string;
  ref: string | null;
  /** The commit's subject line, null when the build did not report it
   *  (MOTIR-10103). */
  commitSubject: string | null;
  /** The pull request a merge release came from, when its commit names one. */
  pullRequestNumber: number | null;
  /** Who asked for a release of a ref; null for any other release. */
  requestedBy: { id: string; name: string } | null;
  cause: HostedReleaseCause;
  state: HostedReleaseState;
  artifactRef: string | null;
  providerReleaseId: string | null;
  failureReason: string | null;
  usageSeconds: number | null;
  /** Who restored the release by a rollback, and when — null for a release
   *  never restored (MOTIR-10035). */
  restoredBy: { id: string; name: string } | null;
  restoredAt: string | null;
  createdAt: string;
  liveAt: string | null;
  endedAt: string | null;
}

export interface HostedApplicationDto {
  id: string;
  workspaceId: string;
  projectId: string;
  projectRepositoryId: string;
  target: HostingTarget;
  slug: string;
  /** The production host without scheme, or null while the workspace has no
   *  claimed motir.site label. */
  productionAddress: string | null;
  currentRelease: HostedReleaseDto | null;
  previousRelease: HostedReleaseDto | null;
  /** Whether a production database has been provisioned. */
  hasDatabase: boolean;
  /** Where the app stands in a takeover (MOTIR-9800): `live`, `handing_over`,
   *  in `grace` until `stopsAt`, or `handed_over` to the organisation's own
   *  account. */
  state: HostedApplicationState;
  /** When a grace period ends and the app is stopped; null outside grace. */
  stopsAt: string | null;
  /** When the app was handed over; null until it is. */
  handedOverAt: string | null;
  /** The app's own address that answers without Motir, once the handover
   *  opened it; null before. */
  upstreamAddress: string | null;
  /** The AWS account the app was handed over in; null until it is. */
  handedOverAccountId: string | null;
  createdAt: string;
}
