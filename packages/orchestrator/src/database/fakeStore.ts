import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseBranchHandle, DatabaseHandle } from './types';

// THE FAKE DATABASE PORT'S SHARED STORE (Story MOTIR-9800 · MOTIR-12142) — the
// package's fourth file-backed fake, on the seam the hosting fake
// (`MOTIR_FAKE_HOSTING_STATE_PATH`), the container fake and the persistent fake
// already use.
//
// WHY A FILE. The acceptance lane runs the database port in THREE processes: the
// job worker creates a database with a production release and deletes it at the
// grace-window stop (`hosting.application-grace.stop`), the app server deletes it
// on Stop now and reads it for an on-demand export, and the spec asks whether it
// still exists. A per-process `Map` answers "not found" in the server for a
// database the worker made, so the store lives in one file every process loads
// before an operation and writes after a mutation. Opt-in: with the variable
// unset, nothing here touches the disk and the fake keeps its in-memory closure.
//
// THE FILE'S KEYS are the provider (`neon`, …): the composition root caches one
// fake per provider, so two fakes in one process write disjoint slices.
//
// THE SEQUENCE IS PART OF THE SLICE. A handle is held only when its
// `databaseRef` matches the stored one, so two processes each minting
// `fake-db-1` for different applications would see each other's handles as not
// held. Loading the sequence with the databases keeps every ref distinct.
//
// Last write wins, with no lock — the bargain the other fakes make: the lane
// runs one worker, and the writers touch disjoint applications. A torn read
// keeps what this process has. Unlike the hosting store, a write goes to a
// sibling file renamed over the store (`lib/test-fake-aws.ts`'s
// `replaceFixtureFileSync` pattern), so a reader in another process never sees
// half a file — `pg_dump`'s fake reads this file directly.

export const FAKE_DATABASE_STATE_PATH_ENV = 'MOTIR_FAKE_DATABASE_STATE_PATH';

/** One branch as the file stores it: instants as ISO strings. */
export interface StoredFakeBranch {
  branch: DatabaseBranchHandle;
  createdAt: string;
  pooledUrl: string;
  directUrl: string;
}

/** One database as the file stores it, with its branches by name. */
export interface StoredFakeDatabase {
  handle: DatabaseHandle;
  region: string | null;
  createdAt: string;
  pooledUrl: string;
  directUrl: string;
  branches: Record<string, StoredFakeBranch>;
}

/** Everything one fake database port knows — the unit the file stores per provider. */
export interface FakeDatabaseSlice {
  /** Keyed by application ref. */
  databases: Record<string, StoredFakeDatabase>;
  /** The fake's clock, in epoch milliseconds. */
  clock: number;
  /** The last database or branch number handed out. */
  sequence: number;
}

/** The shared store's path, or null when the seam is off. */
export function fakeDatabaseStatePath(): string | null {
  const raw = process.env[FAKE_DATABASE_STATE_PATH_ENV];
  return raw !== undefined && raw !== '' ? raw : null;
}

/** A slice holding nothing, its clock at `start`. */
export function emptyFakeDatabaseSlice(
  start = new Date('2026-01-01T00:00:00Z'),
): FakeDatabaseSlice {
  return { databases: {}, clock: start.getTime(), sequence: 0 };
}

/** The names a store key may never be: each reaches `Object.prototype` through
 *  the plain records the store parses its JSON into. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function safeKey(key: string): string {
  if (UNSAFE_KEYS.has(key)) throw new Error(`"${key}" is not a fake database store key`);
  return key;
}

function readStore(path: string): Record<string, FakeDatabaseSlice> | 'torn' | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, FakeDatabaseSlice>;
  } catch {
    return 'torn';
  }
}

/** Write `value` whole: a sibling file, renamed over the store. */
function replaceJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const sibling = `${path}.${process.pid}.tmp`;
  writeFileSync(sibling, JSON.stringify(value), 'utf8');
  renameSync(sibling, path);
}

/** What the file says about `provider`: its slice, `null` when nothing is
 *  stored for it (no file, or no slice), or `'torn'` when the file cannot be
 *  read, so a port keeps what it has. `null` with the seam off. */
export function readFakeDatabaseSlice(provider: string): FakeDatabaseSlice | null | 'torn' {
  const key = safeKey(provider);
  const path = fakeDatabaseStatePath();
  if (!path) return null;
  const store = readStore(path);
  if (store === null || store === 'torn') return store;
  return store[key] ?? null;
}

/** Write `slice` under `provider`, keeping every other provider's. A no-op with
 *  the seam off; a torn store is replaced by this provider's slice alone. */
export function saveFakeDatabaseSlice(provider: string, slice: FakeDatabaseSlice): void {
  const key = safeKey(provider);
  const path = fakeDatabaseStatePath();
  if (!path) return;
  const store = readStore(path);
  replaceJson(path, {
    ...(store && store !== 'torn' ? store : {}),
    [key]: slice,
  });
}
