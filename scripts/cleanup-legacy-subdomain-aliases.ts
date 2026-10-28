/**
 * `pnpm db:cleanup:legacy-subdomain-aliases` — hold and delete every legacy
 * `workspace_subdomain_alias` row (Story MOTIR-4528 · MOTIR-9520). The shape is
 * `pnpm db:backfill:resume-state`'s, deliberately; the logic is
 * `legacyAliasCleanupService`'s, and this file has none of its own.
 *
 * WHY. The retired never-released design left alias rows that hold their names
 * for ever with no date to state. Each is replaced by a 90-day hold on the
 * name's digest, then deleted, in one transaction per batch.
 *
 * IDEMPOTENT: a second run reports every count as 0. Run once per environment.
 *
 * Usage:
 *   pnpm db:cleanup:legacy-subdomain-aliases
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { legacyAliasCleanupService } from '@/lib/services/legacyAliasCleanupService';

const TAG = '[cleanup-legacy-subdomain-aliases]';

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error(`${TAG} takes no arguments`);
  const report = await legacyAliasCleanupService.cleanupLegacyAliases();
  console.log(
    `${TAG} removed ${report.aliasesRemoved} alias rows; holds created ${report.holdsCreated}, ` +
      `raised ${report.holdsRaised}, kept ${report.holdsKept}`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(`${TAG}`, err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
