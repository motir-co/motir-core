import type { HostedApplicationExportKind } from '@/lib/hosting/vocabulary';

// One database export of a grace-window application, as an organisation admin
// sees it (Story MOTIR-9800 · MOTIR-12134). It carries NO storage key: the dump
// is reached only through the download route, which mints a short-lived signed
// link and records the download.
export interface HostedApplicationExportDto {
  id: string;
  applicationId: string;
  kind: HostedApplicationExportKind;
  /** Who asked for it; null for the final export the stop took. */
  requestedByUserId: string | null;
  /** The dump's size in bytes, as the store reported it (a string: it may pass
   *  `Number.MAX_SAFE_INTEGER` in principle, and JSON has no bigint). */
  sizeBytes: string;
  createdAt: string;
  /** When the dump is deleted and stops being downloadable. */
  expiresAt: string;
}
