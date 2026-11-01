import type { HostedReleaseDto } from '@/lib/dto/hostedApplications';
import type { HostingTarget } from '@/lib/hosting/vocabulary';

// The PRODUCTION PANEL's read model (Story MOTIR-9797 · MOTIR-10036): what the
// panel at Repository › Production renders, assembled server-side so the client
// computes no role and no eligibility. Never carries an environment value, a
// connection string or a provider message.

/** The application the panel describes. */
export interface ProductionApplicationSummaryDto {
  id: string;
  target: HostingTarget;
  /** The production host without scheme, or null before the workspace claimed
   *  a motir.site label. */
  productionAddress: string | null;
}

export interface ProductionPanelDto {
  /** Null for a Motir repository that has never released — the empty state. */
  application: ProductionApplicationSummaryDto | null;
  currentRelease: HostedReleaseDto | null;
  previousRelease: HostedReleaseDto | null;
  /** One page of the release history, newest first. */
  releases: HostedReleaseDto[];
  /** The opaque token for the next page, or null on the last one. */
  nextCursor: string | null;
  /** The viewer holds the project's administration permission. */
  isAdministrator: boolean;
  /** The viewer may roll back now: an administrator, with a previous release to
   *  return to. The rollback service stays the authority. */
  canRollback: boolean;
}
