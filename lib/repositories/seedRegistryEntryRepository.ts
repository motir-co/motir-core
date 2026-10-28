import type {
  HostingSize,
  HostingTarget,
  HostingUseCase,
  Prisma,
  ProjectRepoRole,
  SeedRegistryEntry,
  SeedRegistryEntryStatus,
} from '@/generated/prisma/client';
import { db } from '@/lib/db';

/**
 * The SEED REGISTRY (Story MOTIR-704 · MOTIR-708; decision MOTIR-706 v2).
 *
 * The READS are unbound on purpose: the table's SELECT policy is unconditional
 * (Motir's catalogue, read by every workspace's establish, by the planner's
 * request path and by the console), the `platform_run_model` posture — so they
 * read the singleton, with no transaction to open. Every WRITE, and every read
 * a write depends on, takes `tx`: the write arm is `app.platform_staff`, so it
 * runs inside an audited platform transaction (MOTIR-710's operator action).
 */

/** The stored filter the list read applies — vocabulary already checked. */
export interface SeedRegistryEntryWhere {
  role?: ProjectRepoRole;
  stack?: string;
  status?: SeedRegistryEntryStatus;
  hostingTarget?: HostingTarget;
  useCase?: HostingUseCase;
}

/** The columns a writer sets; the vocabulary is checked by the service first. */
export interface SeedRegistryEntryData {
  key: string;
  legacyKeys: string[];
  role: ProjectRepoRole | null;
  stack: string | null;
  label: string;
  templateOwner: string | null;
  templateRepo: string | null;
  useCases: HostingUseCase[];
  sizes: HostingSize[];
  hostingTargets: HostingTarget[];
  status: SeedRegistryEntryStatus;
  promotedFrom: string | null;
  promotedBy: string | null;
  promotedAt: Date | null;
}

export const seedRegistryEntryRepository = {
  /**
   * The entry a row's `seedSource` names — by its current key or one of its
   * legacy keys (706 3.7: a row written before the rename still resolves). The
   * service keeps a key unique across both columns, so at most one entry matches.
   */
  async findByKeyOrLegacyKey(key: string): Promise<SeedRegistryEntry | null> {
    return db.seedRegistryEntry.findFirst({
      where: { OR: [{ key }, { legacyKeys: { has: key } }] },
      orderBy: { key: 'asc' },
    });
  },

  /**
   * One page of entries, ordered by key, starting AFTER `afterKey`. `take` is
   * the page size plus one, so the caller can tell whether a next page exists.
   * The target and use-case filters are array CONTAINS, never equality.
   */
  async list(
    where: SeedRegistryEntryWhere,
    page: { take: number; afterKey: string | null },
  ): Promise<SeedRegistryEntry[]> {
    return db.seedRegistryEntry.findMany({
      where: {
        ...(where.role !== undefined ? { role: where.role } : {}),
        ...(where.stack !== undefined ? { stack: where.stack } : {}),
        ...(where.status !== undefined ? { status: where.status } : {}),
        ...(where.hostingTarget !== undefined
          ? { hostingTargets: { has: where.hostingTarget } }
          : {}),
        ...(where.useCase !== undefined ? { useCases: { has: where.useCase } } : {}),
        ...(page.afterKey !== null ? { key: { gt: page.afterKey } } : {}),
      },
      orderBy: { key: 'asc' },
      take: page.take,
    });
  },

  /** Every ACTIVE entry — what the default map is computed over. */
  async listActive(): Promise<SeedRegistryEntry[]> {
    return db.seedRegistryEntry.findMany({
      where: { status: 'active' },
      orderBy: { key: 'asc' },
    });
  },

  /** Entries holding any of `keys` as their key or a legacy key — the uniqueness check. */
  async findHoldingAnyKey(
    keys: string[],
    tx: Prisma.TransactionClient,
  ): Promise<Pick<SeedRegistryEntry, 'id' | 'key'>[]> {
    return tx.seedRegistryEntry.findMany({
      where: { OR: [{ key: { in: keys } }, { legacyKeys: { hasSome: keys } }] },
      select: { id: true, key: true },
    });
  },

  async create(
    data: SeedRegistryEntryData,
    tx: Prisma.TransactionClient,
  ): Promise<SeedRegistryEntry> {
    return tx.seedRegistryEntry.create({ data });
  },

  /** The entry a write is about to change, read inside that write's transaction. */
  async findByKeyInTx(
    key: string,
    tx: Prisma.TransactionClient,
  ): Promise<SeedRegistryEntry | null> {
    return tx.seedRegistryEntry.findUnique({ where: { key } });
  },

  async update(
    id: string,
    data: Partial<Omit<SeedRegistryEntryData, 'key'>>,
    tx: Prisma.TransactionClient,
  ): Promise<SeedRegistryEntry> {
    return tx.seedRegistryEntry.update({ where: { id }, data });
  },
};
