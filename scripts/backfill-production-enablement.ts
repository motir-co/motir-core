/**
 * `pnpm hosting:backfill:production` — switch production on for every Motir
 * repository that can have it (Story MOTIR-9797 · MOTIR-10027).
 *
 * WHY. Enablement runs when a repository is established. A repository
 * established before it shipped, or one whose enablement failed at creation, has
 * no production app, credential or workflow variables until this runs.
 *
 * ⚠️ IT NEVER RE-IMPLEMENTS THE RULE. Each repository is handed to
 * `productionEnablementService.enableProduction`, the function creation calls.
 * Customer repositories are never read into the walk.
 *
 * IDEMPOTENT: a second run reports every enabled repository `already_enabled`
 * (or `token_reminted` once its deploy token is older than 76 days).
 *
 * Usage:
 *   DATABASE_URL='<url>' MOTIR_HOSTING_FLY_API_TOKEN='<token>' pnpm hosting:backfill:production
 *
 * Prints one line per repository and a total; exits 1 when any repository failed.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { productionEnablementService } from '@/lib/services/productionEnablementService';

const TAG = '[backfill-production-enablement]';

async function main(): Promise<number> {
  const entries = await productionEnablementService.backfillProductionEnablement();
  const counts = new Map<string, number>();
  for (const { projectRepositoryId, result } of entries) {
    counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
    const detail =
      result.outcome === 'failed'
        ? ` at ${result.step}: ${result.detail}`
        : result.outcome === 'skipped'
          ? ` (${result.reason})`
          : ` ${result.appName}`;
    console.log(`${TAG} ${projectRepositoryId} ${result.outcome}${detail}`);
  }
  const summary = [...counts].map(([outcome, n]) => `${outcome} ${n}`).join(', ');
  console.log(`${TAG} ${entries.length} repositories — ${summary || 'none eligible'}`);
  return counts.has('failed') ? 1 : 0;
}

main()
  .then(async (code) => {
    await db.$disconnect();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error(`${TAG} failed:`, err instanceof Error ? err.message : err);
    await db.$disconnect();
    process.exit(1);
  });
