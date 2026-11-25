import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FAKE_DATABASE_STATE_PATH_ENV, readFakeDatabaseSlice } from '@motir/orchestrator';
import { FAKE_BLOB_STATE_PATH_ENV, readFakeBlobObject } from '@/lib/test-blob-mock';
import { E2E_OBJECT_STORE_ENV } from './e2e-object-store-env';

// THE SPEC'S HALF OF THE GRACE-WINDOW FAKES (Story MOTIR-9800 · MOTIR-12142).
// The job worker deletes a production database at the grace-window stop and
// exports it first; the webServer exports on demand and deletes on Stop now. A
// spec reads what they did through the same files the lane config points all
// three processes at: the database fake's store, the blob mock's store, and the
// fake `pg_dump`'s sidecar beside the database store. Imports nothing that opens
// a database.

function requiredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set — run under the acceptance lane, whose config defaults it`);
  }
  return value;
}

/** Whether the lane's fake database port still holds a database for the
 *  application `applicationRef` — the PROJECT REPOSITORY id, the reference
 *  `productionDatabaseService` creates and `productionTeardownService` deletes
 *  the database under (not the hosted application's own id). */
export function fakeDatabaseExists(applicationRef: string, provider = 'neon'): boolean {
  requiredPath(FAKE_DATABASE_STATE_PATH_ENV);
  const slice = readFakeDatabaseSlice(provider);
  if (slice === null || slice === 'torn') return false;
  return Object.prototype.hasOwnProperty.call(slice.databases, applicationRef);
}

/** The bytes of the export stored at `storageKey` in the private bucket, or
 *  null when nothing is there (never written, or deleted). */
export function readFakeExportDump(storageKey: string): Buffer | null {
  requiredPath(FAKE_BLOB_STATE_PATH_ENV);
  return readFakeBlobObject(`${E2E_OBJECT_STORE_ENV.MOTIR_S3_PRIVATE_BUCKET}/${storageKey}`);
}

/** The fake `pg_dump`'s own state file: its run counter and an armed failure. */
export function fakePgDumpSidecarPath(): string {
  return `${requiredPath(FAKE_DATABASE_STATE_PATH_ENV)}.pg-dump.json`;
}

/** Make the NEXT `pg_dump` run, in whichever process spawns it, fail as an
 *  unreachable server does. The failure is consumed by that one run. */
export function armFakePgDumpFailure(): void {
  const file = fakePgDumpSidecarPath();
  let runs = 0;
  try {
    runs = (JSON.parse(readFileSync(file, 'utf8')) as { runs?: number }).runs ?? 0;
  } catch {
    runs = 0;
  }
  mkdirSync(dirname(file), { recursive: true });
  const sibling = `${file}.${process.pid}.tmp`;
  writeFileSync(sibling, JSON.stringify({ runs, armed: true }));
  renameSync(sibling, file);
}
