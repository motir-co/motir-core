import type { HostedApplication, HostedRelease } from '@/generated/prisma/client';
import type { HostedApplicationDto, HostedReleaseDto } from '@/lib/dto/hostedApplications';

// Row → DTO for hosted applications and their releases (Story MOTIR-9797 ·
// MOTIR-10026). The one rule that matters: `databaseUrlCiphertext` is never
// copied, so no caller of a service can reach the database URL through a DTO.

export function toHostedReleaseDto(row: HostedRelease): HostedReleaseDto {
  return {
    id: row.id,
    applicationId: row.applicationId,
    commitSha: row.commitSha,
    ref: row.ref,
    cause: row.cause,
    state: row.state,
    artifactRef: row.artifactRef,
    providerReleaseId: row.providerReleaseId,
    failureReason: row.failureReason,
    usageSeconds: row.usageSeconds,
    createdAt: row.createdAt.toISOString(),
    liveAt: row.liveAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

/** An application row with its two release pointers loaded. */
export type HostedApplicationWithReleases = HostedApplication & {
  currentRelease: HostedRelease | null;
  previousRelease: HostedRelease | null;
};

export function toHostedApplicationDto(row: HostedApplicationWithReleases): HostedApplicationDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectRepositoryId: row.projectRepositoryId,
    target: row.target,
    slug: row.slug,
    productionAddress: row.productionAddress,
    currentRelease: row.currentRelease ? toHostedReleaseDto(row.currentRelease) : null,
    previousRelease: row.previousRelease ? toHostedReleaseDto(row.previousRelease) : null,
    hasDatabase: row.databaseUrlCiphertext !== null,
    createdAt: row.createdAt.toISOString(),
  };
}
