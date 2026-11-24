import type { HostedReleaseDto } from '@/lib/dto/hostedApplications';
import type { DeployEligibilityRefusal } from '@/lib/hosting/deployEligibility';
import type {
  GraceNoticeKind,
  HostedApplicationExportKind,
  HostedApplicationState,
  HostingTarget,
} from '@/lib/hosting/vocabulary';

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
   *  return to, while the app is live and not taken over (MOTIR-12138). The
   *  rollback service stays the authority. */
  canRollback: boolean;
  /** The takeover facts (MOTIR-12138); null while there is no application. */
  handover: ProductionHandoverDto | null;
}

/** One database export as the panel lists it (Story MOTIR-9800 · MOTIR-12138):
 *  no storage key — a dump is reached only through the download route. */
export interface ProductionExportDto {
  id: string;
  kind: HostedApplicationExportKind;
  /** The dump's size in bytes, as a string (JSON has no bigint). */
  sizeBytes: string;
  createdAt: string;
  /** When the dump is deleted and stops being downloadable. */
  expiresAt: string;
  /** Who asked for it; null for the final export the stop took. */
  requestedBy: { id: string; name: string } | null;
}

/** Where the application stands in a takeover, and what the viewer may do about
 *  it (Story MOTIR-9800 · MOTIR-12138). Read server-side so the island computes
 *  no role and no eligibility; the export and stop routes stay the authority. */
export interface ProductionHandoverDto {
  state: HostedApplicationState;
  target: HostingTarget;
  /** When a grace window ends; null outside one. */
  stopsAt: string | null;
  /** When the app was handed over (the stop, or the AWS account leaving). */
  handedOverAt: string | null;
  /** The app's own address that answers without Motir (AWS), once known. */
  upstreamAddress: string | null;
  /** The AWS account the app runs in after the handover. */
  handedOverAccountId: string | null;
  /** The organisation the export and stop routes are addressed by. */
  organizationId: string;
  /** Its name, for the handing-over and handed-over copy. */
  organizationName: string;
  /** The newest grace notice recorded, or null when none is. */
  latestGraceNotice: { kind: GraceNoticeKind; sentAt: string } | null;
  /** The viewer is an organisation admin: Download export, Stop now and the
   *  final export's download render only then. */
  canManageHandover: boolean;
  /** The repository's deploy refusal; `taken_over` hides every release control. */
  deployRefusal: DeployEligibilityRefusal | null;
  /** The exports not yet expired, newest first — the on-demand ones and the
   *  stop's final one — for anyone who can browse the project. */
  exports: ProductionExportDto[];
  /** When the stop's final export is or was deleted: `handedOverAt` plus its
   *  retention, for a stopped serverless or Fly app; null otherwise. */
  finalExportExpiresAt: string | null;
}
