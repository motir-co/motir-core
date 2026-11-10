import type { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// The code-graph LEDGER reads are index reads, not whole-table scans (bug MOTIR-10545).
//
// `get_project_state` and the migrate wizard's index status resolve a workspace's
// index state from four `job_run` reads in ONE interactive transaction
// (`resolveCodeState`, `lib/services/projectStateService.ts`). Each filters on
// `workspace_id`, `function_id` and `status`. No index led with `function_id`
// after `workspace_id`, and under FORCE RLS `status = …` (enum equality) is not
// LEAKPROOF, so the planner could not use the `(workspace_id, status, …)` index
// for it either. Production therefore ran a parallel sequential scan of the whole
// table — ~507k rows — four times inside one transaction, and one call held it
// past Prisma's 5 s default and rolled back.
//
// HOW IT MEASURES. It calls the REAL repository methods — no copied SQL to drift —
// as the runtime role (`motir_app`) with a workspace bound, exactly the binding
// `withWorkspaceContext` gives them, and reads THIS transaction's counters:
// `pg_stat_xact_user_tables` (a full scan shows as `seq_scan > 0`) and
// `pg_stat_get_xact_numscans` on the ledger index (which index served the read). Parallel workers are
// off for the transaction so every scan is counted in this backend; the
// seq-vs-index choice does not depend on parallelism.
//
// ⚠️ THE TABLE MUST BE LARGE AND ANALYZED. On a small table a sequential scan is
// the planner's correct choice, so the fixture is the production shape the bug was
// measured on: one workspace with more than 100k rows, almost all of them from
// OTHER jobs, a few dozen code-graph rows, and more rows in other tenants.

const LEDGER_INDEX = 'job_run_workspace_id_function_id_status_idx';
const WORKSPACE = 'ws-10545-large';
const OTHER_WORKSPACE = 'ws-10545-other';
const NOISE_ROWS = 119_000;
const OTHER_TENANT_ROWS = 60_000;

/** One `job_run` insert over `generate_series`, owner role. */
async function seedRows(sql: string): Promise<void> {
  await adminDb.$executeRawUnsafe(`
    INSERT INTO "job_run"
      ("id", "workspace_id", "function_id", "event_name", "event_id", "attempt",
       "status", "started_at", "lane", "output")
    ${sql}
  `);
}

beforeAll(async () => {
  await truncateJobRuns(adminDb);
  await truncateAuthTables(adminDb);
  await adminDb.$executeRawUnsafe(`
    INSERT INTO "organization" ("id", "name", "slug", "createdAt", "updatedAt")
    VALUES ('org-10545', 'Ledger', 'ledger-10545', now(), now())
  `);
  await adminDb.$executeRawUnsafe(`
    INSERT INTO "workspace" ("id", "name", "slug", "updatedAt", "organizationId")
    VALUES ('${WORKSPACE}', 'Large', 'large-10545', now(), 'org-10545'),
           ('${OTHER_WORKSPACE}', 'Other', 'other-10545', now(), 'org-10545')
  `);
  // The large workspace's history: every other job it runs, all terminal.
  await seedRows(`
    SELECT 'noise-' || g, '${WORKSPACE}',
           (ARRAY['email.send', 'work-item.embed', 'plan.generate', 'ci.feedback'])[1 + g % 4],
           'e', 'noise-' || g, 1, 'succeeded',
           now() - make_interval(secs => g), 'engine', NULL
      FROM generate_series(1, ${NOISE_ROWS}) AS g
  `);
  // Its code-graph ledger: refreshes (2 failed, 1 abandoned, 1 still running),
  // indexes over three repositories (one succeeded run indexed nothing), two
  // still running.
  await seedRows(`
    SELECT 'refresh-' || g, '${WORKSPACE}', 'system.code-graph-refresh', 'e', 'refresh-' || g, 1,
           (CASE WHEN g <= 2 THEN 'failed' WHEN g = 3 THEN 'abandoned' WHEN g = 4 THEN 'running' ELSE 'succeeded' END)::"job_run_status",
           now() - make_interval(mins => g), 'engine', NULL
      FROM generate_series(1, 40) AS g
  `);
  await seedRows(`
    SELECT 'index-' || g, '${WORKSPACE}', 'system.code-graph-index', 'e', 'index-' || g, 1,
           (CASE WHEN g = 1 THEN 'failed' WHEN g IN (2, 3) THEN 'running' ELSE 'succeeded' END)::"job_run_status",
           now() - make_interval(hours => g), 'engine',
           CASE WHEN g = 4 THEN '{"indexed": false, "reason": "no projects"}'::jsonb
                WHEN g > 4 THEN jsonb_build_object('repoRef', 'acme/repo-' || (g % 3)) END
      FROM generate_series(1, 12) AS g
  `);
  // Other tenants and system rows, including code-graph rows the large workspace
  // must not see.
  await seedRows(`
    SELECT 'other-' || g, CASE WHEN g % 3 = 0 THEN NULL ELSE '${OTHER_WORKSPACE}' END,
           (ARRAY['email.send', 'system.code-graph-index', 'system.code-graph-refresh', 'ci.feedback'])[1 + g % 4],
           'e', 'other-' || g, 1,
           (CASE WHEN g % 7 = 0 THEN 'failed' WHEN g % 11 = 0 THEN 'running' ELSE 'succeeded' END)::"job_run_status",
           now() - make_interval(secs => g), 'engine',
           jsonb_build_object('repoRef', 'other/repo-' || g)
      FROM generate_series(1, ${OTHER_TENANT_ROWS}) AS g
  `);
  await adminDb.$executeRawUnsafe('ANALYZE "job_run"');
}, 120_000);

afterAll(async () => {
  await truncateJobRuns(adminDb);
  await truncateAuthTables(adminDb);
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface ScanCounts {
  seqScans: number;
  ledgerIndexScans: number;
}

/**
 * Run `fn` as the runtime role with the large workspace bound — the binding
 * `withWorkspaceContext` gives the ledger reads — and return its result with this
 * transaction's scan counts on `job_run`.
 */
async function measuredInWorkspace<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ result: T; scans: ScanCounts }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${WORKSPACE}, true)`;
    await tx.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather = 0');
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    const result = await fn(tx);
    const rows = await tx.$queryRaw<ScanCounts[]>`
      SELECT coalesce(t."seq_scan", 0)::int AS "seqScans",
             coalesce(pg_stat_get_xact_numscans(to_regclass(${LEDGER_INDEX})), 0)::int
               AS "ledgerIndexScans"
        FROM pg_stat_xact_user_tables t
       WHERE t."relname" = 'job_run'
    `;
    return { result, scans: rows[0] ?? { seqScans: 0, ledgerIndexScans: 0 } };
  });
}

function expectLedgerIndexRead(scans: ScanCounts): void {
  expect(scans.seqScans).toBe(0);
  expect(scans.ledgerIndexScans).toBeGreaterThan(0);
}

describe('the code-graph ledger reads use the ledger index on a >100k-row workspace (MOTIR-10545)', () => {
  it('the index exists on (workspace_id, function_id, status)', async () => {
    const [index] = await adminDb.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_indexdef(i.indexrelid) AS def
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = ${LEDGER_INDEX}`;
    expect(index?.def).toBe(
      `CREATE INDEX ${LEDGER_INDEX} ON public.job_run USING btree (workspace_id, function_id, status)`,
    );
  });

  it('listSucceededCodeGraphIndexRepoRefs — every indexed repository, none of another tenant', async () => {
    const { result, scans } = await measuredInWorkspace((tx) =>
      jobRunRepository.listSucceededCodeGraphIndexRepoRefs(WORKSPACE, tx),
    );
    expect(result.sort()).toEqual(['acme/repo-0', 'acme/repo-1', 'acme/repo-2']);
    expectLedgerIndexRead(scans);
  });

  it('findRunningCodeGraphIndexForWorkspace — the newest running index run', async () => {
    const { result, scans } = await measuredInWorkspace((tx) =>
      jobRunRepository.findRunningCodeGraphIndexForWorkspace(WORKSPACE, tx),
    );
    expect(result?.id).toBe('index-2');
    expectLedgerIndexRead(scans);
  });

  it('listRunningCodeGraphRunIds — every running run of both functions (bug MOTIR-10821)', async () => {
    const { result, scans } = await measuredInWorkspace((tx) =>
      jobRunRepository.listRunningCodeGraphRunIds(WORKSPACE, tx),
    );
    expect(result.sort()).toEqual(['index-2', 'index-3', 'refresh-4']);
    expectLedgerIndexRead(scans);
  });

  it('listTerminalCodeGraphRunIds — failed and abandoned runs of both functions', async () => {
    const { result, scans } = await measuredInWorkspace((tx) =>
      jobRunRepository.listTerminalCodeGraphRunIds(WORKSPACE, tx),
    );
    expect(result.sort()).toEqual(['index-1', 'refresh-1', 'refresh-2', 'refresh-3']);
    expectLedgerIndexRead(scans);
  });
});
