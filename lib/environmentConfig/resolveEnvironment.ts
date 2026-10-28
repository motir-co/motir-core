// The one read the deploying code calls (Story MOTIR-9795): a Motir repository's
// configuration for one environment, in the deploy port's `{ name, value, secret }`
// shape. Secrets are decrypted in memory and exist only in the returned array —
// nothing is written or logged. A system-internal call with no session and no
// permission check: the workspace id comes from the deploying caller's own
// trusted record, never from request input.
import type { ReleaseEnvVar } from '@motir/orchestrator';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';
import { environmentConfigEntryRepository } from '@/lib/repositories/environmentConfigEntryRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { ENVIRONMENT_CONFIG_KEY_ENV, environmentConfigCrypto } from './crypto';
import {
  CustomerRepositoryEnvironmentError,
  EnvironmentRepositoryNotFoundError,
  EnvironmentSecretUndecryptableError,
} from './errors';
import { emptyEnvironmentFlagSource, type EnvironmentFlagSource } from './flagSource';
import type { EnvironmentName } from './vocabulary';

export interface ResolveEnvironmentOptions {
  /** The repository's workspace, from a trusted record — binds row-level security. */
  readonly workspaceId: string;
  /** Non-secret flag values merged in; defaults to none (MOTIR-7136). */
  readonly flagSource?: EnvironmentFlagSource;
}

export async function resolveEnvironment(
  repositoryId: string,
  environment: EnvironmentName,
  { workspaceId, flagSource = emptyEnvironmentFlagSource }: ResolveEnvironmentOptions,
): Promise<ReleaseEnvVar[]> {
  const entries = await withWorkspaceServiceContext(workspaceId, async (tx) => {
    // The repository first, and the refusal before any entry is read.
    const repo = await projectRepoRepository.findById(repositoryId, workspaceId, tx);
    if (!repo) throw new EnvironmentRepositoryNotFoundError(repositoryId);
    if (isOrganizationSeedSource(repo.seedSource)) {
      throw new CustomerRepositoryEnvironmentError(repositoryId);
    }
    return environmentConfigEntryRepository.listByRepositoryAndEnvironment(
      repositoryId,
      environment,
      tx,
    );
  });

  const resolved = new Map<string, ReleaseEnvVar>();
  for (const entry of entries) {
    resolved.set(entry.name, {
      name: entry.name,
      value: entry.isSecret ? decrypt(entry.name, entry.value) : entry.value,
      secret: entry.isSecret,
    });
  }
  // A stored entry wins over a flag of the same name.
  for (const flag of await flagSource.listFlagValues(repositoryId, environment)) {
    if (!resolved.has(flag.name)) {
      resolved.set(flag.name, { name: flag.name, value: flag.value, secret: false });
    }
  }
  return [...resolved.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function decrypt(entryName: string, ciphertext: string): string {
  try {
    return environmentConfigCrypto.decryptToken(ciphertext);
  } catch (err) {
    // A missing or malformed key is the crypto's own error naming the key, and is
    // not swallowed; any other failure is reported by the entry's name only.
    if (err instanceof Error && err.message.startsWith(ENVIRONMENT_CONFIG_KEY_ENV)) throw err;
    throw new EnvironmentSecretUndecryptableError(entryName);
  }
}
