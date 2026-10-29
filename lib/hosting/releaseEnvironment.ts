import type { ReleaseEnvVar } from '@motir/orchestrator';
import { PRODUCTION_DATABASE_ENV_NAME } from '@/lib/hosting/productionDatabase';

// The environment a PRODUCTION release runs with (Story MOTIR-9797 · MOTIR-10030):
// the repository's resolved production entries, and the production database's
// pooled string as the reserved `DATABASE_URL`. No I/O — the release service
// resolves both sides and hands the merge to the port, in memory only.

/** The resolved entries with `DATABASE_URL` taken from the production database:
 *  a resolved entry of that reserved name is always dropped, and the database's
 *  value (a secret) added when the application has one. */
export function mergeProductionEnvironment(
  resolved: readonly ReleaseEnvVar[],
  database: { readonly DATABASE_URL: string } | null,
): ReleaseEnvVar[] {
  const merged = resolved.filter((v) => v.name !== PRODUCTION_DATABASE_ENV_NAME);
  if (database) {
    merged.push({ name: PRODUCTION_DATABASE_ENV_NAME, value: database.DATABASE_URL, secret: true });
  }
  return merged;
}
