import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createObjectStore, type ObjectStore } from '../helpers/hostedApplicationExportFixtures';

// AN EXPORT RESTORES (Story MOTIR-9800 · MOTIR-12134). A real database is dumped
// through `createExport` — the real `pg_dump`, streamed into the in-memory store
// that keeps the bytes — and the stored bytes are restored with the real
// `pg_restore` into an EMPTY database, whose tables and rows must equal the
// source's. This is the promise the export makes to the customer: what they
// download is their database.
//
// ⚠️ IT FAILS, AND NEVER SKIPS, WITHOUT `pg_dump` AND `pg_restore`. A skipped
// restore test is a green check over an export nobody has restored. CI installs
// the PGDG client in the lane that runs it.

const store: { current: ObjectStore } = { current: createObjectStore() };
vi.mock('@/lib/blob/uploader', () => ({
  putPrivateStream: (...a: Parameters<ObjectStore['putPrivateStream']>) =>
    store.current.putPrivateStream(...a),
  deleteAttachmentBlob: (key: string) => store.current.deleteAttachmentBlob(key),
  signedDownloadUrl: (...a: Parameters<ObjectStore['signedDownloadUrl']>) =>
    store.current.signedDownloadUrl(...a),
}));
const { getProductionMigrationEnv } = vi.hoisted(() => ({ getProductionMigrationEnv: vi.fn() }));
vi.mock('@/lib/services/productionDatabaseService', () => ({
  productionDatabaseService: { getProductionMigrationEnv },
}));

const { db } = await import('@/lib/db');
const { hostedApplicationExportService } =
  await import('@/lib/services/hostedApplicationExportService');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const fixtures = await import('../helpers/hostedApplicationExportFixtures');

let source: { name: string; url: string };
let target: { name: string; url: string };
let scratch: string;

// CREATE / DROP DATABASE each force a checkpoint; on a loaded CI cluster the
// two drops below have run past the default 30 s hook timeout (core#4413), so
// both hooks get a wider budget.
const SCRATCH_HOOK_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  await truncateAuthTables();
  source = await fixtures.createScratchDatabase('export_restore_src');
  target = await fixtures.createScratchDatabase('export_restore_dst');
  await fixtures.seedTenantDatabase(source.url);
  scratch = mkdtempSync(join(tmpdir(), 'motir-export-'));
}, SCRATCH_HOOK_TIMEOUT_MS);

afterAll(async () => {
  rmSync(scratch, { recursive: true, force: true });
  await fixtures.dropScratchDatabase(source.name);
  await fixtures.dropScratchDatabase(target.name);
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
}, SCRATCH_HOOK_TIMEOUT_MS);

describe('a grace-window export', () => {
  it('has pg_dump and pg_restore to run with — a missing client fails here, it does not skip', () => {
    for (const bin of ['pg_dump', 'pg_restore']) {
      const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
      expect(probe.error, `${bin} is not installed`).toBeUndefined();
      expect(probe.stdout).toMatch(/PostgreSQL\)? \d+/);
    }
  });

  it('restores with pg_restore into an empty database, tables and rows equal to the source', async () => {
    getProductionMigrationEnv.mockResolvedValue({ DIRECT_URL: source.url });
    const world = await fixtures.seedExportWorld();

    const exportId = await hostedApplicationExportService.createExport(
      world.applicationId,
      { kind: 'final' },
      { kind: 'system' },
    );

    const row = await adminDb.hostedApplicationExport.findUniqueOrThrow({
      where: { id: exportId },
    });
    const stored = store.current.objects.get(row.storageKey);
    expect(stored).toBeDefined();
    expect(row.sizeBytes).toBe(BigInt(stored!.bytes.length));

    const file = join(scratch, 'export.dump');
    writeFileSync(file, stored!.bytes);
    execFileSync(
      'pg_restore',
      ['--no-owner', '--no-acl', '--exit-on-error', `--dbname=${target.url}`, file],
      {
        stdio: 'pipe',
      },
    );

    expect(await fixtures.snapshotTenantDatabase(target.url)).toEqual(
      await fixtures.snapshotTenantDatabase(source.url),
    );
    // The sequences came across too: the next order follows the last one.
    const next = await fixtures.onDatabase(target.url, (c) =>
      c.query(`SELECT nextval(pg_get_serial_sequence('"order"', 'id'))::text AS id`),
    );
    expect(next.rows[0]).toEqual({ id: '4' });
  });
});
