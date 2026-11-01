import { Prisma, type AppEnvironment } from '@/generated/prisma/client';
import type {
  EnvironmentChangeDto,
  EnvironmentEntryDto,
  SetEnvironmentEntryResultDto,
} from '@/lib/dto/environmentConfig';
import { environmentConfigCrypto } from '@/lib/environmentConfig/crypto';
import {
  CustomerRepositoryError,
  EnvironmentConfigForbiddenError,
  EnvironmentEntryNotFoundError,
  InvalidEnvironmentNameError,
  ReservedEnvironmentNameError,
} from '@/lib/environmentConfig/errors';
import {
  isEnvironmentVariableName,
  isReservedEnvironmentName,
} from '@/lib/environmentConfig/reservedNames';
import type { EnvironmentConfigActionName } from '@/lib/environmentConfig/vocabulary';
import { sendEvent } from '@/lib/jobs/sendEvent';
import {
  toEnvironmentChangeDto,
  toEnvironmentEntryDto,
} from '@/lib/mappers/environmentConfigMappers';
import { PRISMA_UNIQUE_VIOLATION } from '@/lib/prisma/uniqueViolation';
import { ProjectRepoNotFoundError } from '@/lib/projectRepos/errors';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { environmentConfigChangeRepository } from '@/lib/repositories/environmentConfigChangeRepository';
import { environmentConfigEntryRepository } from '@/lib/repositories/environmentConfigEntryRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// A Motir repository's environment configuration (Story MOTIR-9795 · MOTIR-9961):
// the ONLY code that authorises a change, refuses a customer repository, encrypts
// a secret on write and records the change. The repositories below it store what
// they are handed; the resolver (MOTIR-9962) is the only code that decrypts.
//
// Gates mirror `projectRepoSetService`: writes need `repository:manage` (the
// builtin admin role holds it), reads need browse. Every write takes the
// repository row's lock first, so two writers of one repository run one after
// the other — the second sees the first's row and reports `replaced` — and a
// lost unique-key race that slips past it is retried once as a replace. Each
// change writes one `environment_config_change` row in its own transaction and
// sends one `environment.config.changed` event after commit; neither carries a
// value, and a refused or rolled-back call writes and sends nothing.

const RECENT_CHANGES_LIMIT = 20;

interface RepositoryScope {
  projectRepositoryId: string;
  projectId: string;
}

/** Load the row and gate the caller: `project:browse` to read, `repository:manage` to
 *  write. A customer repository is refused for both, after the gate. */
async function gate(
  projectRepositoryId: string,
  ctx: ServiceContext,
  mode: 'browse' | 'manage',
): Promise<RepositoryScope> {
  const row = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    projectRepoRepository.findById(projectRepositoryId, ctx.workspaceId, tx),
  );
  if (!row) throw new ProjectRepoNotFoundError(projectRepositoryId);
  if (mode === 'manage') {
    await assertCanManage(row.projectId, projectRepositoryId, ctx);
  } else {
    await projectAccessService.assertPermission(row.projectId, ctx, 'project:browse');
  }
  if (isOrganizationSeedSource(row.seedSource)) {
    throw new CustomerRepositoryError(projectRepositoryId);
  }
  return { projectRepositoryId, projectId: row.projectId };
}

async function assertCanManage(
  projectId: string,
  projectRepositoryId: string,
  ctx: ServiceContext,
): Promise<void> {
  try {
    await projectAccessService.assertPermission(projectId, ctx, 'repository:manage');
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      throw new EnvironmentConfigForbiddenError(projectRepositoryId);
    }
    throw err;
  }
}

function inRepository<T>(
  scope: RepositoryScope,
  ctx: ServiceContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: scope.projectId },
    fn,
  );
}

function assertSettableName(name: string): void {
  if (!isEnvironmentVariableName(name)) throw new InvalidEnvironmentNameError(name);
  if (isReservedEnvironmentName(name)) throw new ReservedEnvironmentNameError(name);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === PRISMA_UNIQUE_VIOLATION
  );
}

async function recordChange(
  tx: Prisma.TransactionClient,
  scope: RepositoryScope,
  ctx: ServiceContext,
  change: {
    environment: AppEnvironment;
    name: string;
    action: EnvironmentConfigActionName;
    isSecret: boolean;
  },
): Promise<void> {
  await environmentConfigChangeRepository.create(tx, {
    workspaceId: ctx.workspaceId,
    projectRepositoryId: scope.projectRepositoryId,
    actorId: ctx.userId,
    ...change,
  });
}

async function announce(
  scope: RepositoryScope,
  ctx: ServiceContext,
  environment: AppEnvironment,
  name: string,
  action: EnvironmentConfigActionName,
): Promise<void> {
  await sendEvent('environment.config.changed', {
    workspaceId: ctx.workspaceId,
    projectRepositoryId: scope.projectRepositoryId,
    environment,
    name,
    action,
    actorId: ctx.userId,
  });
}

interface SetEntryInput {
  name: string;
  value: string;
  isSecret: boolean;
}

/** One write transaction of `set`: lock the repository, read the name, upsert
 *  it and record the change. */
function writeEntry(
  scope: RepositoryScope,
  environment: AppEnvironment,
  input: SetEntryInput,
  stored: string,
  ctx: ServiceContext,
) {
  return inRepository(scope, ctx, async (tx) => {
    await projectRepoRepository.lockById(scope.projectRepositoryId, tx);
    const key = { projectRepositoryId: scope.projectRepositoryId, environment, name: input.name };
    const existing = await environmentConfigEntryRepository.findByName(key, tx);
    const row = await environmentConfigEntryRepository.upsert(tx, {
      ...key,
      workspaceId: ctx.workspaceId,
      isSecret: input.isSecret,
      value: stored,
    });
    const action = existing ? 'replaced' : 'added';
    await recordChange(tx, scope, ctx, {
      environment,
      name: input.name,
      action,
      isSecret: input.isSecret,
    });
    return { row, action } as const;
  });
}

export const environmentConfigService = {
  /** The repository's entries in one environment. Open to anyone who can browse
   *  the project; a secret shows only its name and that it is set. */
  async list(
    projectRepositoryId: string,
    environment: AppEnvironment,
    ctx: ServiceContext,
  ): Promise<EnvironmentEntryDto[]> {
    const scope = await gate(projectRepositoryId, ctx, 'browse');
    const rows = await inRepository(scope, ctx, (tx) =>
      environmentConfigEntryRepository.listByRepositoryAndEnvironment(
        projectRepositoryId,
        environment,
        tx,
      ),
    );
    return rows.map(toEnvironmentEntryDto);
  },

  /** Add or replace one entry. A secret is encrypted before it is stored, and the
   *  answer never carries a secret's value or ciphertext. */
  async set(
    projectRepositoryId: string,
    environment: AppEnvironment,
    input: SetEntryInput,
    ctx: ServiceContext,
  ): Promise<SetEnvironmentEntryResultDto> {
    const scope = await gate(projectRepositoryId, ctx, 'manage');
    assertSettableName(input.name);
    const stored = input.isSecret ? environmentConfigCrypto.encryptToken(input.value) : input.value;
    let written;
    try {
      written = await writeEntry(scope, environment, input, stored, ctx);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      written = await writeEntry(scope, environment, input, stored, ctx);
    }
    await announce(scope, ctx, environment, input.name, written.action);
    return {
      outcome: written.action === 'added' ? 'created' : 'replaced',
      entry: toEnvironmentEntryDto(written.row),
    };
  },

  /** Delete one entry; a name that is not set is `EnvironmentEntryNotFoundError`. */
  async delete(
    projectRepositoryId: string,
    environment: AppEnvironment,
    name: string,
    ctx: ServiceContext,
  ): Promise<void> {
    const scope = await gate(projectRepositoryId, ctx, 'manage');
    await inRepository(scope, ctx, async (tx) => {
      await projectRepoRepository.lockById(projectRepositoryId, tx);
      const key = { projectRepositoryId, environment, name };
      const existing = await environmentConfigEntryRepository.findByName(key, tx);
      if (!existing) throw new EnvironmentEntryNotFoundError(name, environment);
      await environmentConfigEntryRepository.deleteByName(tx, key);
      await recordChange(tx, scope, ctx, {
        environment,
        name,
        action: 'deleted',
        isSecret: existing.isSecret,
      });
    });
    await announce(scope, ctx, environment, name, 'deleted');
  },

  /** The latest changes to the repository's environment, newest first, with no
   *  value. Browse-gated like `list`. */
  async listChanges(
    projectRepositoryId: string,
    environment: AppEnvironment,
    ctx: ServiceContext,
  ): Promise<EnvironmentChangeDto[]> {
    const scope = await gate(projectRepositoryId, ctx, 'browse');
    return inRepository(scope, ctx, async (tx) => {
      const rows = await environmentConfigChangeRepository.listRecent(
        projectRepositoryId,
        environment,
        RECENT_CHANGES_LIMIT,
        tx,
      );
      // The actor is stored by id and named when read, so a change outlives the
      // account that made it: an actor that no longer resolves keeps its row and
      // loses only the name.
      const actorIds = [...new Set(rows.flatMap((r) => (r.actorId ? [r.actorId] : [])))];
      const users = await userRepository.findByIds(actorIds, tx);
      const names = new Map(users.map((u) => [u.id, u.name]));
      return rows.map((row) => toEnvironmentChangeDto(row, names));
    });
  },
};
