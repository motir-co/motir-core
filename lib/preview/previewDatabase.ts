import {
  OrchestratorNotConfiguredError,
  type DatabaseBranchCreated,
  type DatabaseBranchHandle,
  type DatabaseHandle,
  type DatabasePort,
  type DatabaseProvider,
  type DatabaseUsage,
} from '@motir/orchestrator';
import { getDatabasePort } from '@/lib/orchestrator/database';
import { PreviewHostingNotConfiguredError } from './errors';

// A PREVIEW'S DATABASE (MOTIR-5769 §6), through the provider-neutral database
// port — never a provider client of its own, so nothing here names Neon:
//
//   · each repository has ONE preview database, the application `<rid>-pv`
//     (on Neon, the project `mh-<rid>-pv`), data-free, separate from production
//     (`<rid>`) so a preview's credentials can never open a production row;
//   · each pull request's preview is its BRANCH `pr-<n>` of that database.
//
// The port is resolved at CALL time (`getDatabasePort`), so a deployment with no
// database provider configured boots; each call is then refused with
// `PreviewHostingNotConfiguredError`, naming what is unset.

/** The application the repository's preview database belongs to. */
export function previewDatabaseApplicationRef(repositoryId: string): string {
  return `${repositoryId}-pv`;
}

/** The branch a pull request's preview runs on. */
export function previewBranchName(pullRequestNumber: number): string {
  return `pr-${pullRequestNumber}`;
}

function port(provider: DatabaseProvider): DatabasePort {
  try {
    return getDatabasePort(provider);
  } catch (error) {
    if (error instanceof OrchestratorNotConfiguredError) {
      throw new PreviewHostingNotConfiguredError(error.message);
    }
    throw error;
  }
}

/** The repository's preview database, created data-free on first use and found
 *  thereafter (the port's create is idempotent). */
export async function ensurePreviewDatabase(
  repositoryId: string,
  provider: DatabaseProvider = 'neon',
): Promise<DatabaseHandle> {
  const { handle } = await port(provider).createDatabase({
    applicationRef: previewDatabaseApplicationRef(repositoryId),
  });
  return handle;
}

/** The pull request's branch, with the connection pairs the preview runs with.
 *  Idempotent: a redelivered webhook returns the same branch. */
export async function createPreviewBranch(
  database: DatabaseHandle,
  pullRequestNumber: number,
): Promise<DatabaseBranchCreated> {
  return port(database.provider).createBranch(database, {
    name: previewBranchName(pullRequestNumber),
  });
}

/** Delete a pull request's branch, returning its usage; a branch already gone is
 *  deleted with zero usage. */
export async function deletePreviewBranch(branch: DatabaseBranchHandle): Promise<DatabaseUsage> {
  return port(branch.database.provider).deleteBranch(branch);
}

/** Delete the repository's whole preview database (takeover, disconnect),
 *  returning its usage; already gone is zero usage. */
export async function deletePreviewDatabase(database: DatabaseHandle): Promise<DatabaseUsage> {
  return port(database.provider).deleteDatabase(database);
}
