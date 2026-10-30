// DTO types for a Motir repository's PRODUCTION home (Story MOTIR-9797 ·
// MOTIR-10026). `HostedApplicationDto` never carries the database URL, in any
// form: the ciphertext stays on the row.

import type {
  HostedReleaseCause,
  HostedReleaseState,
  HostingTarget,
} from '@/lib/hosting/vocabulary';

export interface HostedReleaseDto {
  id: string;
  applicationId: string;
  commitSha: string;
  ref: string | null;
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
  createdAt: string;
}
