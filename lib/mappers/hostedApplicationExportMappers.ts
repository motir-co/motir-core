import type { HostedApplicationExport } from '@/generated/prisma/client';
import type { HostedApplicationExportDto } from '@/lib/dto/hostedApplicationExport';
import type { HostedApplicationExportKind } from '@/lib/hosting/vocabulary';

// Row → DTO for a database export (Story MOTIR-9800 · MOTIR-12134). The one rule
// that matters: `storageKey` is never copied, so no caller can reach the dump
// except through the download route, which records every download.

export function toHostedApplicationExportDto(
  row: HostedApplicationExport,
): HostedApplicationExportDto {
  return {
    id: row.id,
    applicationId: row.applicationId,
    // The column's CHECK constraint admits only the two kinds.
    kind: row.kind as HostedApplicationExportKind,
    requestedByUserId: row.requestedByUserId,
    sizeBytes: row.sizeBytes.toString(),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
