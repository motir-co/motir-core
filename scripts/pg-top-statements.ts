/**
 * `pnpm ops:pg-top-statements` — which statements does this database spend its
 * time on? (MOTIR-8552, Story MOTIR-8537)
 *
 * Reads `pg_stat_statements` and prints three rankings — by total execution time,
 * by mean execution time and by call count — each row with the normalized SQL
 * (constants already `$n`), calls, total / mean / max ms and rows. Above them it
 * says WHAT answered (host, database, server version, compute start, the latest
 * applied migration) and WHAT the numbers cover.
 *
 * Usage:
 *   DATABASE_URL_UNPOOLED='<core direct url>' pnpm ops:pg-top-statements
 *   pnpm ops:pg-top-statements --limit=50
 *   pnpm ops:pg-top-statements --json          # one object, full query text
 *
 * Needs `DATABASE_URL_UNPOOLED` — the direct, non-pooler endpoint — and falls back
 * to `DATABASE_URL` for a database with no pooler in front (production's Amazon
 * RDS instance, a local Postgres). A pooler host — an RDS Proxy endpoint or a Neon
 * `-pooler` endpoint — is refused.
 *
 * ⚠️ The server resets these statistics when it restarts (on Amazon RDS a reboot,
 * a failover or a maintenance restart), so a readout covers the window since
 * `stats_reset` (or the compute start), never all time, and says what resets it
 * on the engine that answered.
 *
 * Read-only: it enables nothing and clears nothing. Exit codes:
 *   0  ok
 *   1  bad arguments, no URL, or a refused pooler URL
 *   2  the extension is not installed in this database
 *   3  the extension is installed but its library is not preloaded
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL_UNPOOLED from .env
import {
  EXIT_CODE,
  exitCodeFor,
  hostOf,
  parseArgs,
  PgTopStatementsUsageError,
  renderJson,
  renderText,
  resolveDirectUrl,
  stateMessage,
} from './pgTopStatements';
import { readTopStatements } from './pgTopStatementsQuery';

const TAG = '[pg-top-statements]';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { url } = resolveDirectUrl(process.env);
  const result = await readTopStatements(url, args.limit);
  process.exitCode = exitCodeFor(result);
  if (result.state !== 'ok') {
    console.error(`${TAG} ${stateMessage(result, hostOf(url))}`);
    return;
  }
  console.log(args.json ? renderJson(result) : renderText(result));
}

main().catch((err: unknown) => {
  if (err instanceof PgTopStatementsUsageError) {
    console.error(`${TAG} ${err.message}`);
    process.exitCode = EXIT_CODE.usage;
    return;
  }
  console.error(`${TAG} failed:`, err);
  process.exitCode = EXIT_CODE.usage;
});
