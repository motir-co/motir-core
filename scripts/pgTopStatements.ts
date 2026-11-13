// THE `pg_stat_statements` READOUT — the pure half (MOTIR-8552).
//
// Argument parsing, the choice of connection string and both renderers. Nothing
// here opens a socket or reads a file, so every branch is unit-tested from a
// fixture readout (`tests/scripts/pg-top-statements.test.ts`). The read lives in
// `pgTopStatementsQuery.ts`, the CLI in `pg-top-statements.ts`.
//
// ⚠️ THE NUMBERS COVER A WINDOW, NOT ALL TIME. `pg_stat_statements` keeps its
// counters in shared memory, so every restart of the server discards them — on
// Amazon RDS (production since the MOTIR-9699 cutover) a reboot, a failover or a
// maintenance restart; on Neon (preview databases) a compute restart, scale to
// zero included. So every readout says which window it covers — `stats_reset`
// from `pg_stat_statements_info` (PostgreSQL ≥ 14), else the compute's start —
// names what resets it on the engine that answered (`resetSentenceFor`), and says
// when the view evicted entries (`dealloc > 0`), which makes the ranking a sample
// rather than a census.

/** The marker every statement this command sends carries, and every ranking
 *  excludes — so the readout never ranks its own reads. */
export const PG_TOP_STATEMENTS_MARKER = 'motir:pg-top-statements';
export const PG_TOP_STATEMENTS_MARKER_COMMENT = `/* ${PG_TOP_STATEMENTS_MARKER} */`;

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;
/** Text mode prints a query on one line, cut here; `--json` carries it whole. */
export const TEXT_QUERY_MAX = 300;

export const RDS_RESET_SENTENCE =
  'Amazon RDS resets these statistics when the instance restarts (a reboot, a failover or a maintenance restart), so the figures cover only this window.';
export const NEON_RESET_SENTENCE =
  'Neon resets these statistics when a compute restarts, so the figures cover only this window.';
export const POSTGRES_RESET_SENTENCE =
  'PostgreSQL resets these statistics when the server restarts, so the figures cover only this window.';

/** A `host[:port]` label's hostname, lower-cased — `hostOf` puts the port on. */
function bareHost(host: string): string {
  return host.replace(/:\d+$/, '').toLowerCase();
}

/** An Amazon RDS endpoint — an instance, an Aurora cluster or an RDS Proxy. */
function isRdsHost(hostname: string): boolean {
  return bareHost(hostname).endsWith('.rds.amazonaws.com');
}

/** A Neon endpoint, pooled or direct. */
function isNeonHost(hostname: string): boolean {
  return bareHost(hostname).endsWith('.neon.tech');
}

/**
 * The connection pooler a hostname names, or null for a direct endpoint.
 *
 * - **An RDS Proxy** endpoint reads `<proxy>.proxy-<id>.<region>.rds.amazonaws.com`
 *   (a custom proxy endpoint `<endpoint>.endpoint.proxy-<id>.…`), where an instance
 *   or a cluster reads `<name>.<id>.<region>.rds.amazonaws.com` — so the
 *   `proxy-` label is the tell.
 * - **A Neon pooler** carries `-pooler` on its endpoint label
 *   (`ep-…-pooler.<region>.aws.neon.tech`). Neon still serves the preview databases.
 */
export function poolerOf(hostname: string): 'rds_proxy' | 'neon_pooler' | null {
  const host = bareHost(hostname);
  if (isRdsHost(host) && host.split('.').some((label) => label.startsWith('proxy-'))) {
    return 'rds_proxy';
  }
  if (host.includes('-pooler.')) return 'neon_pooler';
  return null;
}

/** What resets the counters, for the engine whose host answered the read. */
export function resetSentenceFor(host: string): string {
  if (isRdsHost(host)) return RDS_RESET_SENTENCE;
  if (isNeonHost(host)) return NEON_RESET_SENTENCE;
  return POSTGRES_RESET_SENTENCE;
}

export interface PgTopStatementsArgs {
  limit: number;
  json: boolean;
}

/** A refusal the CLI prints as-is and exits 1 on. */
export class PgTopStatementsUsageError extends Error {
  override readonly name = 'PgTopStatementsUsageError';
}

export function parseArgs(argv: readonly string[]): PgTopStatementsArgs {
  let limit = DEFAULT_LIMIT;
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--limit=')) {
      const raw = arg.slice('--limit='.length);
      const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
        throw new PgTopStatementsUsageError(
          `--limit must be a whole number from 1 to ${MAX_LIMIT}, got "${raw}"`,
        );
      }
      limit = n;
    } else {
      throw new PgTopStatementsUsageError(
        `unknown argument "${arg}" (accepted: --limit=N, --json)`,
      );
    }
  }
  return { limit, json };
}

export interface DirectUrl {
  url: string;
  /** Which variable it came from. */
  source: 'DATABASE_URL_UNPOOLED' | 'DATABASE_URL';
}

/**
 * The direct (unpooled) connection string — `DATABASE_URL_UNPOOLED`, else
 * `DATABASE_URL` for a database with no pooler in front (production's RDS
 * instance, a local Postgres; `prisma.config.ts`'s rule). A POOLER host — an RDS
 * Proxy or a Neon `-pooler` endpoint (`poolerOf`) — is refused: the read is a
 * session of its own, and through a pooler it would take a slot from the pool
 * whose traffic the readout is measuring.
 */
export function resolveDirectUrl(env: Readonly<Record<string, string | undefined>>): DirectUrl {
  const unpooled = env['DATABASE_URL_UNPOOLED']?.trim();
  const pooled = env['DATABASE_URL']?.trim();
  const picked: DirectUrl | null = unpooled
    ? { url: unpooled, source: 'DATABASE_URL_UNPOOLED' }
    : pooled
      ? { url: pooled, source: 'DATABASE_URL' }
      : null;
  if (!picked) {
    throw new PgTopStatementsUsageError(
      'no connection string: set DATABASE_URL_UNPOOLED to the direct (non-pooler) URL',
    );
  }
  let hostname: string;
  try {
    hostname = new URL(picked.url).hostname;
  } catch {
    throw new PgTopStatementsUsageError(`${picked.source} is not a parseable URL`);
  }
  const pooler = poolerOf(hostname);
  if (pooler) {
    const what = pooler === 'rds_proxy' ? 'an RDS Proxy endpoint' : 'a Neon pooler host';
    throw new PgTopStatementsUsageError(
      `${picked.source} names ${what} (${hostname}); set DATABASE_URL_UNPOOLED to the database's direct endpoint`,
    );
  }
  return picked;
}

/** `host[:port]` of a connection string — never its credentials. */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return '(unparseable)';
  }
}

// ── The readout ──────────────────────────────────────────────────────────────

export interface StatementRow {
  /** As `pg_stat_statements` stored it — constants already `$n`. */
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  maxMs: number;
  rows: number;
}

export interface AnsweredBy {
  host: string;
  database: string;
  serverVersion: string;
  /** `pg_postmaster_start_time()`, ISO. */
  computeStartedAt: string | null;
  /** The newest applied row of `_prisma_migrations`; null when the table is absent. */
  latestMigration: { name: string; finishedAt: string | null } | null;
}

export interface Coverage {
  /** `pg_stat_statements_info.stats_reset`, ISO; null when the view is absent. */
  statsReset: string | null;
  /** `pg_stat_statements_info.dealloc`; null when the view is absent. */
  dealloc: number | null;
  infoAvailable: boolean;
  /** Rows whose text reads `<insufficient privilege>` — the role lacks `pg_read_all_stats`. */
  insufficientPrivilegeRows: number;
}

export interface TopStatementsReadout {
  readAt: string;
  limit: number;
  extensionSchema: string;
  answeredBy: AnsweredBy;
  coverage: Coverage;
  byTotalTime: StatementRow[];
  byMeanTime: StatementRow[];
  byCalls: StatementRow[];
}

export type TopStatementsResult =
  | ({ state: 'ok' } & TopStatementsReadout)
  | { state: 'extension_not_installed' }
  | { state: 'extension_not_loaded'; detail: string };

export const EXIT_CODE = {
  ok: 0,
  usage: 1,
  extension_not_installed: 2,
  extension_not_loaded: 3,
} as const;

export function exitCodeFor(result: TopStatementsResult): number {
  return EXIT_CODE[result.state];
}

/** The one line a non-ok state prints. */
export function stateMessage(
  result: Exclude<TopStatementsResult, { state: 'ok' }>,
  host: string,
): string {
  if (result.state === 'extension_not_installed') {
    return `pg_stat_statements is not installed in this database (${host}) — enable it with the manual step on MOTIR-8537, over the direct connection, then run this again.`;
  }
  return `pg_stat_statements is installed but its library is not loaded on this compute (${host}): the server does not preload it (shared_preload_libraries). ${result.detail}`;
}

function oneLine(query: string): string {
  const collapsed = query.replace(/\s+/g, ' ').trim();
  return collapsed.length > TEXT_QUERY_MAX
    ? `${collapsed.slice(0, TEXT_QUERY_MAX - 1)}…`
    : collapsed;
}

function ms(n: number): string {
  return n.toFixed(2);
}

/** What the numbers cover, in words. */
export function coverageLines(readout: TopStatementsReadout): string[] {
  const { coverage, answeredBy } = readout;
  const since = coverage.statsReset
    ? `since stats_reset ${coverage.statsReset}`
    : `since the compute started ${answeredBy.computeStartedAt ?? '(unknown)'} (pg_stat_statements_info is absent, so the compute start stands in for the last reset)`;
  const lines = [`coverage: ${since} to ${readout.readAt}. ${resetSentenceFor(answeredBy.host)}`];
  if (coverage.dealloc !== null && coverage.dealloc > 0) {
    lines.push(
      `⚠️ sample: the view evicted entries ${coverage.dealloc} time(s) (dealloc), so these rankings are a sample, not every statement.`,
    );
  }
  if (coverage.insufficientPrivilegeRows > 0) {
    lines.push(
      `⚠️ ${coverage.insufficientPrivilegeRows} row(s) read <insufficient privilege>: this role cannot see other roles' statement text (grant pg_read_all_stats).`,
    );
  }
  return lines;
}

function section(title: string, rows: readonly StatementRow[]): string[] {
  const out = [``, `== ${title} ==`];
  if (rows.length === 0) {
    out.push('(no statements recorded)');
    return out;
  }
  rows.forEach((r, i) => {
    out.push(
      `${i + 1}. calls=${r.calls} total_ms=${ms(r.totalMs)} mean_ms=${ms(r.meanMs)} max_ms=${ms(r.maxMs)} rows=${r.rows}`,
      `   ${oneLine(r.query)}`,
    );
  });
  return out;
}

export function renderText(readout: TopStatementsReadout): string {
  const a = readout.answeredBy;
  const migration = a.latestMigration
    ? `${a.latestMigration.name} (finished ${a.latestMigration.finishedAt ?? 'never'})`
    : '(no _prisma_migrations table)';
  return [
    `pg_stat_statements top ${readout.limit} — read ${readout.readAt}`,
    `answered by: host=${a.host} database=${a.database} server_version=${a.serverVersion}`,
    `compute started: ${a.computeStartedAt ?? '(unknown)'}`,
    `latest migration: ${migration}`,
    ...coverageLines(readout),
    ...section('by total time', readout.byTotalTime),
    ...section('by mean time', readout.byMeanTime),
    ...section('by calls', readout.byCalls),
  ].join('\n');
}

/** One parseable object — the full query text, for a report to attach unedited. */
export function renderJson(readout: TopStatementsReadout): string {
  return JSON.stringify({ ...readout, coverageText: coverageLines(readout) }, null, 2);
}
