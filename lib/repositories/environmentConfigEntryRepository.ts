import type { AppEnvironment, EnvironmentConfigEntry, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// A Motir repository's environment entries (Story MOTIR-9795 · MOTIR-9960): one
// row per (repository, environment, name). A leaf: it stores whatever value it
// is handed — a secret arrives ALREADY encrypted by the service — and does no
// encryption, no authorisation and no event. Row-level secured on `workspace_id`,
// so the caller holds a workspace-bound transaction.

export interface EnvironmentConfigEntryKey {
  projectRepositoryId: string;
  environment: AppEnvironment;
  name: string;
}

export interface UpsertEnvironmentConfigEntryInput extends EnvironmentConfigEntryKey {
  workspaceId: string;
  isSecret: boolean;
  /** The plain value, or the `v1.` ciphertext when `isSecret`. */
  value: string;
}

export const environmentConfigEntryRepository = {
  /** Every entry of one repository's environment, by name. */
  async listByRepositoryAndEnvironment(
    projectRepositoryId: string,
    environment: AppEnvironment,
    tx?: Prisma.TransactionClient,
  ): Promise<EnvironmentConfigEntry[]> {
    const client = tx ?? dbRead;
    return client.environmentConfigEntry.findMany({
      where: { projectRepositoryId, environment },
      orderBy: { name: 'asc' },
    });
  },

  async findByName(
    key: EnvironmentConfigEntryKey,
    tx?: Prisma.TransactionClient,
  ): Promise<EnvironmentConfigEntry | null> {
    const client = tx ?? dbRead;
    return client.environmentConfigEntry.findUnique({
      where: { projectRepositoryId_environment_name: key },
    });
  },

  /** Create the entry, or replace its value and secret flag when the name is
   *  already set in that environment. */
  async upsert(
    tx: Prisma.TransactionClient,
    input: UpsertEnvironmentConfigEntryInput,
  ): Promise<EnvironmentConfigEntry> {
    const { workspaceId, isSecret, value, ...key } = input;
    return tx.environmentConfigEntry.upsert({
      where: { projectRepositoryId_environment_name: key },
      create: { workspaceId, ...key, isSecret, value },
      update: { isSecret, value },
    });
  },

  /** Delete the entry; answers how many rows went (0 when the name was unset). */
  async deleteByName(
    tx: Prisma.TransactionClient,
    key: EnvironmentConfigEntryKey,
  ): Promise<number> {
    const { count } = await tx.environmentConfigEntry.deleteMany({ where: key });
    return count;
  },
};
