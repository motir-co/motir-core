import type { HostingEnvironment } from '../../../../hosting/types';

// The deterministic, VALIDATED names of a repository's databases (MOTIR-10007).
// Every part is checked against a strict pattern BEFORE it is used, so a name
// can neither escape its quoting nor collide by truncation: a repository id that
// is not a lowercase cuid, or a pull request that is not a positive integer, is
// refused — never cleaned up into something else. Every SQL identifier stays
// within PostgreSQL's 63 characters and is double-quoted where it is used.

const REPOSITORY_ID = /^[a-z0-9]{1,40}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const MAX_PULL_REQUEST = 999_999_999;

/** The cluster's main database, production's (the template's `DatabaseName`). */
export const MAIN_DATABASE = 'app';
/** The environment variable a release reads its connection URL from. */
export const DATABASE_URL_VARIABLE = 'DATABASE_URL';

export class DatabaseNameInvalidError extends Error {
  readonly code = 'AWS_DATABASE_NAME_INVALID' as const;
  constructor(readonly part: string) {
    super(`"${part}" cannot name a hosted database.`);
    this.name = 'DatabaseNameInvalidError';
  }
}

export interface EnvironmentDatabaseNames {
  /** The login role that owns the environment's database. */
  readonly role: string;
  readonly database: string;
  /** The per-preview secret stack; null for production. */
  readonly previewStackName: string | null;
}

function checkedRepositoryId(repositoryId: string): string {
  if (!REPOSITORY_ID.test(repositoryId)) throw new DatabaseNameInvalidError(repositoryId);
  return repositoryId;
}

/** The application's database stack. */
export function databaseStackName(repositoryId: string): string {
  return `motir-database-${checkedRepositoryId(repositoryId)}`;
}

/** The role, database and (for a preview) secret stack of an environment. */
export function environmentDatabaseNames(
  repositoryId: string,
  environment: HostingEnvironment,
): EnvironmentDatabaseNames {
  const rid = checkedRepositoryId(repositoryId);
  if (environment.kind === 'production') {
    return { role: `app_${rid}`, database: MAIN_DATABASE, previewStackName: null };
  }
  const n = environment.pullRequest;
  if (!Number.isInteger(n) || n < 1 || n > MAX_PULL_REQUEST) {
    throw new DatabaseNameInvalidError(String(n));
  }
  return {
    role: `app_${rid}_pr${n}`,
    database: `app_pr${n}`,
    previewStackName: `motir-database-${rid}-pr${n}`,
  };
}

/** A checked identifier, double-quoted. */
export function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new DatabaseNameInvalidError(name);
  return `"${name}"`;
}
