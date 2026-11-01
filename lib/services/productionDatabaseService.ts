import { DATABASE_DIRECT_ENV, OrchestratorApiError } from '@motir/orchestrator';
import {
  ApplicationNotFoundError,
  ProductionDatabaseProvisioningError,
  ProductionDatabaseUnreadableError,
} from '@/lib/hosting/errors';
import {
  databaseKindForTarget,
  PRODUCTION_DATABASE_ENV_NAME,
} from '@/lib/hosting/productionDatabase';
import { environmentConfigCrypto } from '@/lib/environmentConfig/crypto';
import { getDatabasePort } from '@/lib/orchestrator/database';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { withSystemContext, type SystemTransactionOptions } from '@/lib/workspaces/context';

// A Motir repository's PRODUCTION DATABASE (Story MOTIR-9797 · MOTIR-10028): one
// long-lived serverless Postgres per hosted application, created on its first
// release through the database port and kept as the application row's encrypted
// `database_url_ciphertext`. The release service is the only caller: previews
// have no application row, so nothing here can reach a preview, and
// `tests/hosting/productionDatabaseBoundary.test.ts` holds the import list to it.
//
// ⚠️ THE CONNECTION STRING IS A CREDENTIAL. It is encrypted before it is written,
// decrypted only into the value `getProductionDatabaseEnv` returns, and never
// cached, logged, mapped into a DTO or put in an error: a port failure is
// re-thrown carrying only its status and code.

/**
 * The transaction holds the application row's lock ACROSS the provider's create,
 * so two concurrent first releases make one database; the create is one
 * unretried call plus a lookup, so a minute covers it with room to spare.
 */
const PRODUCTION_DATABASE_TX: SystemTransactionOptions = { timeout: 60_000 };

/** A code is passed on only when it looks like one, so a message cannot ride in
 *  its place. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function provisioningError(
  applicationId: string,
  error: unknown,
): ProductionDatabaseProvisioningError {
  const status = error instanceof OrchestratorApiError ? error.status : null;
  const code = (error as { code?: unknown } | null)?.code;
  return new ProductionDatabaseProvisioningError(
    applicationId,
    status,
    typeof code === 'string' && ERROR_CODE.test(code) ? code : 'UNKNOWN',
  );
}

export interface ProductionDatabaseEnsured {
  /** The provider's opaque database reference, stored on the application row. */
  databaseProjectId: string;
  /** Whether this call created it (false: it already existed). */
  created: boolean;
}

/** The pair a production release receives. */
export interface ProductionDatabaseEnv {
  readonly DATABASE_URL: string;
}

async function ensureProductionDatabase(applicationId: string): Promise<ProductionDatabaseEnsured> {
  return withSystemContext(async (tx) => {
    if (!(await hostedApplicationRepository.lockForUpdate(applicationId, tx))) {
      throw new ApplicationNotFoundError(applicationId);
    }
    const app = await hostedApplicationRepository.findDatabaseById(applicationId, tx);
    if (!app) throw new ApplicationNotFoundError(applicationId);
    if (app.databaseUrlCiphertext !== null && app.databaseProjectId !== null) {
      return { databaseProjectId: app.databaseProjectId, created: false };
    }
    databaseKindForTarget(app.target);

    let created;
    try {
      // The ADR names the production database `mh-<rid>` from the repository
      // row; the port derives its project name from the reference it is given.
      created = await getDatabasePort().createDatabase({ applicationRef: app.projectRepositoryId });
    } catch (error) {
      throw provisioningError(applicationId, error);
    }
    const pooled = created.env.find((pair) => pair.name === PRODUCTION_DATABASE_ENV_NAME);
    if (!pooled) {
      throw new ProductionDatabaseProvisioningError(applicationId, null, 'DATABASE_URL_MISSING');
    }
    await hostedApplicationRepository.setDatabase(
      applicationId,
      {
        databaseProjectId: created.handle.databaseRef,
        databaseUrlCiphertext: environmentConfigCrypto.encryptToken(pooled.value),
      },
      tx,
    );
    return { databaseProjectId: created.handle.databaseRef, created: true };
  }, PRODUCTION_DATABASE_TX);
}

async function getProductionDatabaseEnv(applicationId: string): Promise<ProductionDatabaseEnv> {
  const app = await withSystemContext((tx) =>
    hostedApplicationRepository.findDatabaseById(applicationId, tx),
  );
  if (!app) throw new ApplicationNotFoundError(applicationId);
  if (app.databaseUrlCiphertext === null) {
    throw new ProductionDatabaseUnreadableError(applicationId, 'absent');
  }
  let value: string;
  try {
    value = environmentConfigCrypto.decryptToken(app.databaseUrlCiphertext);
  } catch {
    throw new ProductionDatabaseUnreadableError(applicationId, 'undecryptable');
  }
  return { DATABASE_URL: value };
}

/** The pair a release's MIGRATION needs beside it: the direct (unpooled)
 *  string, re-read through the database port and never stored. */
export interface ProductionMigrationEnv {
  readonly DIRECT_URL: string;
}

async function getProductionMigrationEnv(applicationId: string): Promise<ProductionMigrationEnv> {
  const app = await withSystemContext((tx) =>
    hostedApplicationRepository.findDatabaseById(applicationId, tx),
  );
  if (!app) throw new ApplicationNotFoundError(applicationId);
  if (app.databaseProjectId === null) {
    throw new ProductionDatabaseUnreadableError(applicationId, 'absent');
  }
  const port = getDatabasePort();
  let pairs;
  try {
    pairs = await port.connectionEnv({
      provider: port.provider,
      applicationRef: app.projectRepositoryId,
      databaseRef: app.databaseProjectId,
    });
  } catch (error) {
    throw provisioningError(applicationId, error);
  }
  const direct = pairs.find((pair) => pair.name === DATABASE_DIRECT_ENV);
  if (!direct) throw new ProductionDatabaseUnreadableError(applicationId, 'absent');
  return { DIRECT_URL: direct.value };
}

export const productionDatabaseService = {
  ensureProductionDatabase,
  getProductionDatabaseEnv,
  getProductionMigrationEnv,
};
