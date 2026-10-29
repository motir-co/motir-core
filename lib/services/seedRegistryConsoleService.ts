import 'server-only';

import type { Prisma, ProjectRepoRole } from '@/generated/prisma/client';
import type {
  SeedPromotionSourceDto,
  SeedRegistryConsoleFilter,
  SeedRegistryConsolePageDto,
  SeedRegistryConsoleRowDto,
  SeedRegistryEntryDto,
  SeedRegistryRetirementDto,
} from '@/lib/dto/seedRegistry';
import { toSeedRegistryEntryDto } from '@/lib/mappers/seedRegistryMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { seedRegistryEntryRepository } from '@/lib/repositories/seedRegistryEntryRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { isFixedDefaultSeedKey } from '@/lib/seedRegistry/defaults';
import { LEAVING_TAKEOVER_STATES } from '@/lib/services/seedRegistryPromotionService';

// THE STARTER LIBRARY's reads for the operator console (Story MOTIR-704 ·
// MOTIR-712; design MOTIR-705 §2–§3, `design/starter-library/`). Two reads, both
// operator and above (`requirePlatformStaff('operator')`, R97), both audited:
//
//   · `listLibrary` — one numbered page of entries, newest first, with what the
//     Provenance column spells out: who promoted an entry, from which repository,
//     and who retired it, when and why. The retirement's reason lives only in the
//     platform audit log (`seed_registry.retire`), so it is read from there.
//   · `listPromotionSources` — every repository Motir created, for the promote
//     form's picker. Promote itself re-checks the source it is given
//     (the promotion service's `promote`); this list only decides what is
//     offered and why a row is held.
//
// Both read across tenants (`project_repository`, `github_repo`), which is why
// they run inside `withPlatformRead` on the `platform_staff` SELECT arms MOTIR-710
// added, and never through a workspace context.

/** The library's page size (design §2.4). */
export const STARTER_LIBRARY_PAGE_SIZE = 25;

/** How many repositories the promote form's picker lists, newest first. */
export const PROMOTION_SOURCE_LIMIT = 200;

export const seedRegistryConsoleService = {
  /**
   * One page of the starter library. A page past the last one answers that last
   * page, so a filter that shrank the list never lands an operator on a blank
   * page with a pager pointing backwards.
   */
  async listLibrary(
    principal: PlatformPrincipal,
    filter: SeedRegistryConsoleFilter,
    page: number,
  ): Promise<SeedRegistryConsolePageDto> {
    await requirePlatformStaff('operator');
    const where = {
      role: filter.role as ProjectRepoRole | undefined,
      status: filter.status === 'all' ? undefined : filter.status,
      target: filter.target,
    };
    return withPlatformRead(
      principal,
      {
        action: 'seed_registry.library_read',
        targetKind: 'platform',
        metadata: {
          role: filter.role ?? null,
          status: filter.status,
          target: filter.target ?? null,
          page,
        },
      },
      async (tx) => {
        const total = await seedRegistryEntryRepository.countForConsoleInTx(where, tx);
        const lastPage = Math.max(1, Math.ceil(total / STARTER_LIBRARY_PAGE_SIZE));
        const current = Math.min(Math.max(1, Math.floor(page)), lastPage);
        const entries = (
          await seedRegistryEntryRepository.listForConsoleInTx(
            where,
            {
              skip: (current - 1) * STARTER_LIBRARY_PAGE_SIZE,
              take: STARTER_LIBRARY_PAGE_SIZE,
            },
            tx,
          )
        ).map(toSeedRegistryEntryDto);
        return {
          rows: await withProvenance(entries, tx),
          total,
          page: current,
          pageSize: STARTER_LIBRARY_PAGE_SIZE,
        };
      },
    );
  },

  /** The promote form's picker: every repository Motir created, held ones marked. */
  async listPromotionSources(principal: PlatformPrincipal): Promise<SeedPromotionSourceDto[]> {
    await requirePlatformStaff('operator');
    return withPlatformRead(
      principal,
      { action: 'seed_registry.promote_sources_read', targetKind: 'platform' },
      async (tx) => {
        const rows = await projectRepoRepository.listPromotionSourcesInTx(
          PROMOTION_SOURCE_LIMIT,
          tx,
        );
        return rows.map((row) => ({
          id: row.id,
          name: row.name,
          repoRef: row.githubRepo ? `${row.githubRepo.owner}/${row.githubRepo.name}` : null,
          role: row.role,
          state: row.state,
          projectName: row.project.name,
          unavailable:
            row.takeoverState !== null && LEAVING_TAKEOVER_STATES.includes(row.takeoverState)
              ? 'leaving'
              : row.state !== 'created'
                ? 'not_created'
                : null,
        }));
      },
    );
  },
};

/** The Provenance column's facts for one page of entries — three batched reads. */
async function withProvenance(
  entries: SeedRegistryEntryDto[],
  tx: Prisma.TransactionClient,
): Promise<SeedRegistryConsoleRowDto[]> {
  const promoterIds = unique(entries.map((entry) => entry.promotedBy));
  const sourceIds = unique(entries.map((entry) => entry.promotedFrom));
  const retiredKeys = entries.filter((e) => e.status === 'retired').map((e) => e.key);

  const promoters = promoterIds.length > 0 ? await userRepository.findByIds(promoterIds, tx) : [];
  const sources =
    sourceIds.length > 0
      ? await projectRepoRepository.findRepoRefsForPromotionInTx(sourceIds, tx)
      : [];
  const retirements =
    retiredKeys.length > 0
      ? await platformAuditLogRepository.listByTargetsAndAction(
          'platform',
          retiredKeys,
          'seed_registry.retire',
          tx,
        )
      : [];

  const emailById = new Map(promoters.map((user) => [user.id, user.email]));
  const repoById = new Map(
    sources.map((row) => [
      row.id,
      row.githubRepo ? `${row.githubRepo.owner}/${row.githubRepo.name}` : null,
    ]),
  );
  // Newest first from the read, so the first row per key is its latest retirement.
  const retirementByKey = new Map<string, SeedRegistryRetirementDto>();
  for (const row of retirements) {
    if (row.targetId === null || retirementByKey.has(row.targetId)) continue;
    retirementByKey.set(row.targetId, {
      byEmail: row.actor?.email ?? null,
      at: row.createdAt.toISOString(),
      reason: row.reason,
    });
  }

  return entries.map((entry) => ({
    entry,
    isDefault: isFixedDefaultSeedKey(entry.key),
    promotedByEmail: entry.promotedBy ? (emailById.get(entry.promotedBy) ?? null) : null,
    promotedFromRepo: entry.promotedFrom ? (repoById.get(entry.promotedFrom) ?? null) : null,
    retirement: entry.status === 'retired' ? (retirementByKey.get(entry.key) ?? null) : null,
  }));
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}
