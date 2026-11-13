/**
 * `pnpm db:rewrite:stored-asset-urls --from-base=<tigris public base> [--apply]` —
 * step 5 of the AWS cutover window (Story MOTIR-9712 · MOTIR-10075).
 *
 * WHY. `User.image` and `Project.image` store an object KEY since MOTIR-2404, and
 * `storedAssetUrl` resolves a key against `MOTIR_S3_PUBLIC_BASE_URL` — so a key
 * follows the window's move from Tigris to S3. A row written between MOTIR-2389 and
 * MOTIR-2404 may still hold an ABSOLUTE URL on the Tigris public base, which
 * `storedAssetUrl` passes through unchanged: it would keep pointing at Tigris and
 * break at the decommission. This rewrites exactly those rows to their keys.
 *
 * DRY RUN BY DEFAULT — the inverse of `db:backfill:fix-reason`. With no flag it
 * counts, per column, the rows whose value starts with `<from-base>/`, prints each
 * with the key it would become, reports absolute values on any OTHER host as a
 * count it leaves alone (Google avatars are the expected case), and writes nothing.
 * `--apply` rewrites every counted row in ONE transaction, re-counts inside it, and
 * rolls everything back unless the re-count is 0. A dry-run count of 0 means there
 * is nothing to apply.
 *
 * ⚠️ `--from-base` IS REQUIRED and never read from `MOTIR_S3_PUBLIC_BASE_URL`: the
 * window runs this while that variable may already name S3, where a base read from
 * it would match nothing and report a false 0. A non-`https:` base is refused before
 * any query runs.
 *
 * Usage (in the AWS window: against the old core database, after the freeze and
 * before the dump — motir-infra `docs/core-cutover.md` step 5 says why; any core
 * database works):
 *
 *   DATABASE_URL='<core url>' pnpm db:rewrite:stored-asset-urls \
 *     --from-base=<the old public base>
 *   DATABASE_URL='<core url>' pnpm db:rewrite:stored-asset-urls \
 *     --from-base=<the old public base> --apply
 *
 * In the AWS window `<the old public base>` was Tigris's public base.
 *
 * Exit 0 on a completed run, 1 on a refusal (bad base, a row that does not reduce,
 * a row that changed since it was counted, a non-zero re-count) or any error.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { StoredAssetRewriteError } from '@/lib/blob/errors';
import { db } from '@/lib/db';
import {
  parseFromBase,
  storedAssetUrlRewriteService,
  type StoredAssetRewriteColumnReport,
  type StoredAssetRewriteReport,
} from '@/lib/services/storedAssetUrlRewriteService';

const TAG = '[rewrite-stored-asset-urls]';

export interface RewriteArgs {
  fromBase: string;
  apply: boolean;
}

/** Parse and validate the arguments — throws before any query on a bad base. */
export function parseArgs(argv: string[]): RewriteArgs {
  let fromBase: string | undefined;
  let apply = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg.startsWith('--from-base=')) fromBase = arg.slice('--from-base='.length);
    else throw new StoredAssetRewriteError('STORED_ASSET_BAD_BASE', `unknown argument: ${arg}`);
  }
  return { fromBase: parseFromBase(fromBase), apply };
}

function printColumn(
  label: 'User.image' | 'Project.image',
  column: StoredAssetRewriteColumnReport,
  apply: boolean,
): void {
  console.log(`${TAG} ${label}: ${column.before} row(s) on the base`);
  for (const row of column.rows) {
    console.log(
      `${TAG}   ${row.id}: ${row.from} → ${row.to ?? '(does not reduce to a key)'}` +
        (apply ? '' : ' (dry run)'),
    );
  }
  console.log(
    `${TAG} ${label}: ${column.foreignAbsolute} absolute value(s) on another host, left alone`,
  );
  if (apply) console.log(`${TAG} ${label}: after the rewrite ${column.after} row(s) on the base`);
}

export function printReport(report: StoredAssetRewriteReport): void {
  console.log(
    `${TAG} ${report.apply ? 'APPLY' : 'DRY RUN — nothing will be written'}; base ${report.fromBase}/`,
  );
  printColumn('User.image', report.users, report.apply);
  printColumn('Project.image', report.projects, report.apply);
  const total = report.users.before + report.projects.before;
  if (!report.apply) {
    console.log(
      total === 0
        ? `${TAG} done — 0 rows to rewrite; there is nothing to apply.`
        : `${TAG} done — ${total} row(s) would be rewritten. Re-run with --apply to write them.`,
    );
  } else {
    console.log(`${TAG} done — ${total} row(s) rewritten in one transaction; after-count 0.`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await storedAssetUrlRewriteService.rewriteAbsoluteAssetUrls(args);
  printReport(report);
}

// Run only as a script, so a test can import `parseArgs` / `printReport`.
if (process.argv[1]?.endsWith('rewrite-stored-asset-urls.ts')) {
  main()
    .catch((err) => {
      if (err instanceof StoredAssetRewriteError) {
        console.error(`${TAG} refused (${err.code}): ${err.message}`);
      } else {
        console.error(`${TAG} failed:`, err);
      }
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
