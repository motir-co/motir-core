import type {
  AppEnvironment,
  EnvironmentConfigAction,
  EnvironmentConfigChange,
  Prisma,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// The append-only change record of a Motir repository's environment configuration
// (Story MOTIR-9795 · MOTIR-9960). The table has no value column, and this
// repository has no update or delete method: a change, once recorded, stands.
// Row-level secured on `workspace_id`.

export interface CreateEnvironmentConfigChangeInput {
  workspaceId: string;
  projectRepositoryId: string;
  environment: AppEnvironment;
  name: string;
  action: EnvironmentConfigAction;
  isSecret: boolean;
  actorId: string | null;
}

export const environmentConfigChangeRepository = {
  async create(
    tx: Prisma.TransactionClient,
    input: CreateEnvironmentConfigChangeInput,
  ): Promise<EnvironmentConfigChange> {
    return tx.environmentConfigChange.create({ data: input });
  },

  /** The newest changes to one repository's environment, newest first. */
  async listRecent(
    projectRepositoryId: string,
    environment: AppEnvironment,
    limit: number,
    tx?: Prisma.TransactionClient,
  ): Promise<EnvironmentConfigChange[]> {
    const client = tx ?? dbRead;
    return client.environmentConfigChange.findMany({
      where: { projectRepositoryId, environment },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  },
};
