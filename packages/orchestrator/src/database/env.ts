import type { ReleaseEnvVar } from '../hosting/types';

// The NAMES a database's connection strings are delivered under (MOTIR-9971) —
// the Prisma datasource convention the starters read: `DATABASE_URL` for the
// pooled string the application queries through, `DIRECT_URL` for the direct
// one migrations need. Every adapter builds its pairs through
// `databaseEnvPairs`, so the names live in one place.

export const DATABASE_POOLED_ENV = 'DATABASE_URL';
export const DATABASE_DIRECT_ENV = 'DIRECT_URL';

export interface DatabaseConnectionStrings {
  readonly pooledUrl: string;
  readonly directUrl: string;
}

/** Exactly two secret pairs: the pooled string, then the direct one. */
export function databaseEnvPairs({
  pooledUrl,
  directUrl,
}: DatabaseConnectionStrings): readonly ReleaseEnvVar[] {
  return [
    { name: DATABASE_POOLED_ENV, value: pooledUrl, secret: true },
    { name: DATABASE_DIRECT_ENV, value: directUrl, secret: true },
  ];
}
