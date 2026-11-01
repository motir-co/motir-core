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

/** The console library's filter (MOTIR-712): `target: 'none'` is an EMPTY
 *  `hostingTargets`, every other target is array CONTAINS. */
export interface SeedRegistryConsoleWhere {
  role?: ProjectRepoRole;
  status?: SeedRegistryEntryStatus;
  target?: HostingTarget | 'none';
}

function consoleWhere(where: SeedRegistryConsoleWhere): Prisma.SeedRegistryEntryWhereInput {
  return {
    ...(where.role !== undefined ? { role: where.role } : {}),
    ...(where.status !== undefined ? { status: where.status } : {}),
    ...(where.target === 'none'
      ? { hostingTargets: { isEmpty: true } }
      : where.target !== undefined
        ? { hostingTargets: { has: where.target } }
        : {}),
  };
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
  promotedRef: string | null;
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

  /**
   * One page of the ACTIVE entries a row of `role` may seed from (MOTIR-709's
   * hard filter): the role's own entries whose `hostingTargets` contains
   * `target` (`{ contains }`), is empty (`'none'`), or either (`'any'`, a `web`
   * row with no target yet) — plus every any-role entry with no targets
   * (`initialised`), which fits every row.
   */
  async listCompatible(
    where: { role: ProjectRepoRole; target: { contains: HostingTarget } | 'none' | 'any' },
    page: { take: number; afterKey: string | null },
  ): Promise<SeedRegistryEntry[]> {
    return db.seedRegistryEntry.findMany({
      where: {
        status: 'active',
        OR: [
          {
            OR: [{ role: where.role }, { role: null }],
            ...(where.target === 'none'
              ? { hostingTargets: { isEmpty: true } }
              : where.target === 'any'
                ? {}
                : { hostingTargets: { has: where.target.contains } }),
          },
          { role: null, hostingTargets: { isEmpty: true } },
        ],
        ...(page.afterKey !== null ? { key: { gt: page.afterKey } } : {}),
      },
      orderBy: { key: 'asc' },
      take: page.take,
    });
  },

  /**
   * One numbered page of the operator console's library (MOTIR-712), newest
   * first. `target: 'none'` keeps the entries with no hosting target. Read inside
   * the console's audited platform read, so it takes that read's `tx`.
   */
  async listForConsoleInTx(
    where: SeedRegistryConsoleWhere,
    page: { skip: number; take: number },
    tx: Prisma.TransactionClient,
  ): Promise<SeedRegistryEntry[]> {
    return tx.seedRegistryEntry.findMany({
      where: consoleWhere(where),
      orderBy: [{ createdAt: 'desc' }, { key: 'asc' }],
      skip: page.skip,
      take: page.take,
    });
  },

  /** How many entries the console's filter keeps — the pager's total. */
  async countForConsoleInTx(
    where: SeedRegistryConsoleWhere,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.seedRegistryEntry.count({ where: consoleWhere(where) });
  },

  /** The entry promoted from this source row at this commit, if any — read
   *  before a promotion copies anything, so a re-promotion skips the copy. */
  async findByPromotion(
    promotedFrom: string,
    promotedRef: string,
  ): Promise<SeedRegistryEntry | null> {
    return db.seedRegistryEntry.findUnique({
      where: { promotedFrom_promotedRef: { promotedFrom, promotedRef } },
    });
  },

  /** Every entry, retired ones included — the room's one registry read
   *  (MOTIR-712): a created row still names the starter it came from. */
  async listAll(): Promise<SeedRegistryEntry[]> {
    return db.seedRegistryEntry.findMany({ orderBy: { key: 'asc' } });
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

  /** The entry promoted from this source row at this commit, inside the promote's
   *  transaction — what makes a re-promotion an update (MOTIR-710). */
  async findByPromotionInTx(
    promotedFrom: string,
    promotedRef: string,
    tx: Prisma.TransactionClient,
  ): Promise<SeedRegistryEntry | null> {
    return tx.seedRegistryEntry.findUnique({
      where: { promotedFrom_promotedRef: { promotedFrom, promotedRef } },
    });
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
