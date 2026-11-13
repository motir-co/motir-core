import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMIT,
  EXIT_CODE,
  exitCodeFor,
  hostOf,
  NEON_RESET_SENTENCE,
  parseArgs,
  PG_TOP_STATEMENTS_MARKER,
  PG_TOP_STATEMENTS_MARKER_COMMENT,
  PgTopStatementsUsageError,
  renderJson,
  renderText,
  resolveDirectUrl,
  stateMessage,
  TEXT_QUERY_MAX,
  type StatementRow,
  type TopStatementsReadout,
} from '../../scripts/pgTopStatements';
import {
  infoSql,
  insufficientPrivilegeSql,
  PG_TOP_STATEMENTS_SQL,
  RANKINGS,
  rankingSql,
} from '../../scripts/pgTopStatementsQuery';

// MOTIR-8552 — the pure half of `pnpm ops:pg-top-statements`: the arguments, the
// choice of connection string, the two renderers, and the read-only and
// own-statement-exclusion properties of the SQL it sends.

const ROOT = join(__dirname, '..', '..');
const SOURCES = [
  'scripts/pg-top-statements.ts',
  'scripts/pgTopStatements.ts',
  'scripts/pgTopStatementsQuery.ts',
].map((p) => ({ path: p, text: readFileSync(join(ROOT, p), 'utf8') }));

function row(over: Partial<StatementRow> = {}): StatementRow {
  return {
    query: 'SELECT id FROM work_item WHERE id = $1',
    calls: 1200,
    totalMs: 5400.5,
    meanMs: 4.5,
    maxMs: 310.25,
    rows: 1200,
    ...over,
  };
}

function readout(over: Partial<TopStatementsReadout> = {}): TopStatementsReadout {
  return {
    readAt: '2026-10-14T12:00:00.000Z',
    limit: 20,
    extensionSchema: 'public',
    answeredBy: {
      host: 'db-1.eu-central-1.example.test',
      database: 'neondb',
      serverVersion: '17.2',
      computeStartedAt: '2026-10-14T08:00:00.000Z',
      latestMigration: { name: '20261013_add_x', finishedAt: '2026-10-13T10:00:00.000Z' },
    },
    coverage: {
      statsReset: '2026-10-14T08:00:05.000Z',
      dealloc: 0,
      infoAvailable: true,
      insufficientPrivilegeRows: 0,
    },
    byTotalTime: [row()],
    byMeanTime: [row({ query: 'SELECT pg_sleep($1)', meanMs: 900 })],
    byCalls: [row({ query: 'SELECT set_config($1, $2, $3)', calls: 99000 })],
    ...over,
  };
}

describe('parseArgs', () => {
  it('defaults to the top 20 in text', () => {
    expect(parseArgs([])).toEqual({ limit: DEFAULT_LIMIT, json: false });
  });

  it('takes --limit=N and --json', () => {
    expect(parseArgs(['--limit=50', '--json'])).toEqual({ limit: 50, json: true });
    expect(parseArgs(['--limit=1']).limit).toBe(1);
    expect(parseArgs(['--limit=200']).limit).toBe(200);
  });

  it.each(['--limit=0', '--limit=201', '--limit=abc', '--limit=', '--limit=2.5', '--limit=-3'])(
    'refuses %s by naming --limit',
    (arg) => {
      expect(() => parseArgs([arg])).toThrow(PgTopStatementsUsageError);
      expect(() => parseArgs([arg])).toThrow(/--limit/);
    },
  );

  it('refuses an unknown flag by name', () => {
    expect(() => parseArgs(['--reset'])).toThrow(/unknown argument "--reset"/);
    expect(() => parseArgs(['--help'])).toThrow(PgTopStatementsUsageError);
  });
});

describe('resolveDirectUrl', () => {
  const DIRECT = 'postgresql://u:secret@db-1.eu-central-1.example.test/neondb';
  const POOLER = 'postgresql://u:secret@db-1-pooler.eu-central-1.example.test/neondb';
  const LOCAL = 'postgresql://prodect:prodect@localhost:5433/prodect';

  it('prefers DATABASE_URL_UNPOOLED', () => {
    expect(resolveDirectUrl({ DATABASE_URL_UNPOOLED: DIRECT, DATABASE_URL: POOLER })).toEqual({
      url: DIRECT,
      source: 'DATABASE_URL_UNPOOLED',
    });
  });

  it('falls back to DATABASE_URL', () => {
    expect(resolveDirectUrl({ DATABASE_URL: LOCAL })).toEqual({
      url: LOCAL,
      source: 'DATABASE_URL',
    });
  });

  it('refuses a Neon pooler host, naming DATABASE_URL_UNPOOLED', () => {
    expect(() => resolveDirectUrl({ DATABASE_URL: POOLER })).toThrow(PgTopStatementsUsageError);
    expect(() => resolveDirectUrl({ DATABASE_URL: POOLER })).toThrow(/DATABASE_URL_UNPOOLED/);
    expect(() => resolveDirectUrl({ DATABASE_URL_UNPOOLED: POOLER })).toThrow(/pooler/);
  });

  it('refuses when neither variable is set, naming DATABASE_URL_UNPOOLED', () => {
    expect(() => resolveDirectUrl({})).toThrow(PgTopStatementsUsageError);
    expect(() => resolveDirectUrl({ DATABASE_URL_UNPOOLED: '  ' })).toThrow(
      /no connection string.*DATABASE_URL_UNPOOLED/,
    );
  });

  it('hostOf never carries the credentials', () => {
    expect(hostOf(DIRECT)).toBe('db-1.eu-central-1.example.test');
    expect(hostOf(LOCAL)).toBe('localhost:5433');
    expect(hostOf(DIRECT)).not.toContain('secret');
  });
});

describe('renderText', () => {
  it('prints the answered-by block, the coverage line and three ranked sections', () => {
    const out = renderText(readout());
    expect(out).toContain('host=db-1.eu-central-1.example.test');
    expect(out).toContain('database=neondb');
    expect(out).toContain('server_version=17.2');
    expect(out).toContain('compute started: 2026-10-14T08:00:00.000Z');
    expect(out).toContain('latest migration: 20261013_add_x (finished 2026-10-13T10:00:00.000Z)');
    expect(out).toContain('since stats_reset 2026-10-14T08:00:05.000Z');
    expect(out).toContain(NEON_RESET_SENTENCE);

    const total = out.indexOf('== by total time ==');
    const mean = out.indexOf('== by mean time ==');
    const calls = out.indexOf('== by calls ==');
    expect(total).toBeGreaterThan(-1);
    expect(mean).toBeGreaterThan(total);
    expect(calls).toBeGreaterThan(mean);

    expect(out).toContain(
      '1. calls=1200 total_ms=5400.50 mean_ms=4.50 max_ms=310.25 rows=1200\n   SELECT id FROM work_item WHERE id = $1',
    );
    expect(out.slice(calls)).toContain('SELECT set_config($1, $2, $3)');
  });

  it('collapses a query to one line and cuts it at 300 characters', () => {
    const long = `SELECT\n    a,\n\tb\nFROM t WHERE ${'x = $1 AND '.repeat(60)}y = $2`;
    const out = renderText(readout({ byTotalTime: [row({ query: long })] }));
    const line = out.split('\n').find((l) => l.startsWith('   SELECT a, b FROM t'))!;
    expect(line).toBeDefined();
    expect(line.trim()).toHaveLength(TEXT_QUERY_MAX);
    expect(line.trim().endsWith('…')).toBe(true);
  });

  it('states the compute-start fallback when pg_stat_statements_info is absent', () => {
    const out = renderText(
      readout({
        coverage: {
          statsReset: null,
          dealloc: null,
          infoAvailable: false,
          insufficientPrivilegeRows: 0,
        },
      }),
    );
    expect(out).toContain('since the compute started 2026-10-14T08:00:00.000Z');
    expect(out).toContain('pg_stat_statements_info is absent');
    expect(out).toContain(NEON_RESET_SENTENCE);
    expect(out).not.toContain('sample');
  });

  it('warns that the ranking is a sample when dealloc > 0', () => {
    const out = renderText(readout({ coverage: { ...readout().coverage, dealloc: 7 } }));
    expect(out).toMatch(/sample: the view evicted entries 7 time\(s\)/);
  });

  it('counts the <insufficient privilege> rows, and is silent when there are none', () => {
    expect(renderText(readout())).not.toContain('insufficient privilege');
    const out = renderText(
      readout({ coverage: { ...readout().coverage, insufficientPrivilegeRows: 4 } }),
    );
    expect(out).toContain('4 row(s) read <insufficient privilege>');
    expect(out).toContain('pg_read_all_stats');
  });

  it('says so when a ranking is empty, and names a missing migrations table', () => {
    const out = renderText(
      readout({
        byTotalTime: [],
        answeredBy: { ...readout().answeredBy, latestMigration: null },
      }),
    );
    expect(out).toContain('(no statements recorded)');
    expect(out).toContain('(no _prisma_migrations table)');
  });
});

describe('renderJson', () => {
  it('emits one parseable object with the full query text and both blocks', () => {
    const long = `SELECT\n  ${'c, '.repeat(200)}d FROM t`;
    const fixture = readout({ byTotalTime: [row({ query: long })] });
    const parsed = JSON.parse(renderJson(fixture)) as TopStatementsReadout & {
      coverageText: string[];
    };
    expect(parsed.byTotalTime[0]!.query).toBe(long);
    expect(parsed.answeredBy).toEqual(fixture.answeredBy);
    expect(parsed.coverage).toEqual(fixture.coverage);
    expect(parsed.byMeanTime).toEqual(fixture.byMeanTime);
    expect(parsed.byCalls).toEqual(fixture.byCalls);
    expect(parsed.coverageText[0]).toContain(NEON_RESET_SENTENCE);
  });
});

describe('the named states', () => {
  it('maps each state to its exit code', () => {
    expect(exitCodeFor({ state: 'ok', ...readout() })).toBe(0);
    expect(exitCodeFor({ state: 'extension_not_installed' })).toBe(2);
    expect(exitCodeFor({ state: 'extension_not_loaded', detail: 'x' })).toBe(3);
    expect(EXIT_CODE.usage).toBe(1);
  });

  it('prints one line per non-ok state saying what to do', () => {
    const notInstalled = stateMessage({ state: 'extension_not_installed' }, 'h');
    expect(notInstalled).not.toContain('\n');
    expect(notInstalled).toMatch(/not installed.*enable it/);
    const notLoaded = stateMessage({ state: 'extension_not_loaded', detail: 'boom' }, 'h');
    expect(notLoaded).not.toContain('\n');
    expect(notLoaded).toMatch(/not loaded.*shared_preload_libraries.*boom/);
  });
});

describe('the SQL it sends', () => {
  const schema = 'public';
  const sent = [
    ...Object.values(PG_TOP_STATEMENTS_SQL),
    ...RANKINGS.map((c) => rankingSql(schema, c)),
    insufficientPrivilegeSql(schema),
    infoSql(schema),
  ];

  it('carries the marker comment on every statement', () => {
    expect(PG_TOP_STATEMENTS_MARKER_COMMENT).toBe(`/* ${PG_TOP_STATEMENTS_MARKER} */`);
    for (const sql of sent) expect(sql.startsWith(PG_TOP_STATEMENTS_MARKER_COMMENT)).toBe(true);
  });

  it('excludes its own statements from every ranking, ordered DESC and limited', () => {
    for (const column of RANKINGS) {
      const sql = rankingSql(schema, column);
      expect(sql).toContain('WHERE strpos(query, $2) = 0');
      expect(sql).toContain(`ORDER BY ${column} DESC LIMIT $1`);
      expect(sql).toContain(
        'query, calls, total_exec_time, mean_exec_time, max_exec_time, rows FROM "public".pg_stat_statements',
      );
    }
    expect(RANKINGS).toEqual(['total_exec_time', 'mean_exec_time', 'calls']);
  });

  it('schema-qualifies the view from the catalog, quoting the identifier', () => {
    expect(PG_TOP_STATEMENTS_SQL.extensionSchema).toMatch(/pg_extension e JOIN pg_namespace n/);
    expect(rankingSql('ext"s', 'calls')).toContain('FROM "ext""s".pg_stat_statements');
  });

  it('opens a read-only transaction with a local statement timeout', () => {
    expect(PG_TOP_STATEMENTS_SQL.begin).toContain('BEGIN READ ONLY');
    expect(PG_TOP_STATEMENTS_SQL.timeout).toContain('SET LOCAL statement_timeout');
  });
});

describe('the sources', () => {
  it('never import @/lib/db or @prisma/client', () => {
    for (const { path, text } of SOURCES) {
      expect(text, path).not.toMatch(/from\s+['"]@\/lib\/db['"]/);
      expect(text, path).not.toMatch(/['"]@prisma\/client['"]/);
      expect(text, path).not.toMatch(/['"]@\/generated\/prisma/);
    }
  });

  it('contain no write, no extension creation and no statistics reset', () => {
    for (const { path, text } of SOURCES) {
      expect(text, path).not.toMatch(/CREATE EXTENSION/i);
      expect(text, path).not.toMatch(/pg_stat_statements_reset/i);
      expect(text, path).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    }
  });
});
