import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HostingDeployTarget } from '../../hosting/types';
import type { FakeHostedApp, FakeHostedRelease, FakeHostingFailure } from './hosting';

// THE FAKE HOSTING PORT'S SHARED STORE (Story MOTIR-5766 · MOTIR-10098) — the
// package's third file-backed fake, on the seam the container fake
// (`MOTIR_FAKE_CONTAINER_STATE_PATH`) and the persistent fake
// (`MOTIR_FAKE_PERSISTENT_STATE_PATH`) already use.
//
// WHY A FILE. A preview's E2E lane runs the hosting port in THREE processes: the
// job worker deploys and destroys (the lifecycle's effects are jobs), the app
// server reads (`previewGateService.readUpstream` lists the app's releases and
// describes the live one), and the spec arranges and inspects. A per-call `Map`
// answers `[]` in the server for a release the worker just made, so the store
// lives in one file every process loads before an operation and writes after a
// mutation. Opt-in: with the variable unset, nothing here touches the disk and
// the fake keeps its in-memory closure.
//
// THE FILE'S KEYS are the port key the composition root caches a fake under
// (`fakeHostingPortKey`, used by `lib/orchestrator/hosting.ts` too), so two fakes
// in one process — another target, a narrowed prefix — write disjoint slices.
//
// DURABLE vs TAKE-ONCE. Apps, releases, health, run transitions, the clock, the
// minted list and the account flag are the slice. An armed one-shot failure is
// read once and consumed, so it lives in a SIDECAR (`${path}.failures.json`):
// taking a failure must never reload the store mid-operation.
//
// Last write wins, with no lock — the bargain the other two fakes make: the lane
// runs one worker, the writers are milliseconds apart on disjoint apps, and every
// operation rewrites its slice from what it just loaded. A torn read keeps what
// this process has, and the next write replaces the file.

export const FAKE_HOSTING_STATE_PATH_ENV = 'MOTIR_FAKE_HOSTING_STATE_PATH';

/** Everything one fake hosting port knows — the unit the file stores per key. */
export interface FakeHostingSlice {
  apps: Record<string, FakeHostedApp>;
  /** Every push credential minted, in order. */
  mintedFor: string[];
  /** Push namespaces made, in order of creation. */
  namespaces: string[];
  /** Live (unrevoked) credentials per push namespace. */
  liveTokens: Record<string, number>;
  /** Every release's shape, kept past its destroy (usage units). */
  shapes: Record<string, FakeHostedRelease>;
  /** The fake's clock, in epoch milliseconds. */
  clock: number;
  /** The last release number handed out. */
  sequence: number;
  /** Whether the organisation's AWS tenant account is ready. */
  accountReady: boolean;
}

/** The key a fake's slice is stored under — the composition root's cache key. */
export function fakeHostingPortKey(target: HostingDeployTarget, appPrefix?: string): string {
  return `${target}:${appPrefix ?? ''}`;
}

/** The shared store's path, or null when the seam is off. */
export function fakeHostingStatePath(): string | null {
  const raw = process.env[FAKE_HOSTING_STATE_PATH_ENV];
  return raw !== undefined && raw !== '' ? raw : null;
}

/** A slice holding nothing, its clock at `start`. */
export function emptyFakeHostingSlice(start = new Date('2026-01-01T00:00:00Z')): FakeHostingSlice {
  return {
    apps: {},
    mintedFor: [],
    namespaces: [],
    liveTokens: {},
    shapes: {},
    clock: start.getTime(),
    sequence: 0,
    accountReady: true,
  };
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    // A torn read — the caller keeps what it has.
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

/** JSON carries a run transition's instant as ISO; give it back its Date. */
function revive(slice: FakeHostingSlice): FakeHostingSlice {
  for (const app of Object.values(slice.apps)) {
    app.transitions = app.transitions.map((t) => ({ ...t, at: new Date(t.at) }));
  }
  return slice;
}

/** The names a store key may never be: each one reaches `Object.prototype`
 *  through the plain records the store parses its JSON into. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** `key`, refused when it would address the prototype rather than a slice. A
 *  port key is `<target>:<prefix>` and never one of these; the check exists so a
 *  caller passing anything else cannot write through the store's records. */
function safeKey(key: string): string {
  if (UNSAFE_KEYS.has(key)) throw new Error(`"${key}" is not a fake hosting store key`);
  return key;
}

/** What the file says about `key`: its slice, `null` when nothing is stored for
 *  it (no file, or no slice — another process reset it), or `'torn'` when the
 *  file cannot be read, so a port keeps what it has. `null` with the seam off. */
export function readFakeHostingSlice(key: string): FakeHostingSlice | null | 'torn' {
  const path = fakeHostingStatePath();
  if (!path || !existsSync(path)) return null;
  const store = readJson<Record<string, FakeHostingSlice>>(path);
  if (!store) return 'torn';
  const slice = store[safeKey(key)];
  return slice ? revive(slice) : null;
}

/** The stored slice for `key`, or null (seam off, no file, a torn file, no slice). */
export function loadFakeHostingSlice(key: string): FakeHostingSlice | null {
  const slice = readFakeHostingSlice(key);
  return slice === 'torn' ? null : slice;
}

/** Write `slice` under `key`, keeping every other key's. A no-op with the seam off. */
export function saveFakeHostingSlice(key: string, slice: FakeHostingSlice): void {
  const path = fakeHostingStatePath();
  if (!path) return;
  writeJson(path, {
    ...readJson<Record<string, FakeHostingSlice>>(path),
    [safeKey(key)]: slice,
  });
}

/** What the store holds for `key` — for a process that holds only the file. */
export function readFakeHostingSnapshot(key: string): FakeHostingSlice | null {
  return loadFakeHostingSlice(key);
}

/** Load, mutate and save `key`'s slice (an empty one when none is stored) —
 *  the one way to write into the store from outside a port. Returns the slice. */
export function updateFakeHostingSnapshot(
  key: string,
  mutate: (slice: FakeHostingSlice) => void,
): FakeHostingSlice {
  const slice = loadFakeHostingSlice(key) ?? emptyFakeHostingSlice();
  mutate(slice);
  saveFakeHostingSlice(key, slice);
  return slice;
}

type ArmedFailures = Record<string, Partial<Record<FakeHostingFailure, string>>>;

function failuresPath(): string | null {
  const path = fakeHostingStatePath();
  return path ? `${path}.failures.json` : null;
}

/** Forget `key`'s slice and its armed failures. Writes only files that exist. */
export function resetFakeHostingSnapshot(key: string): void {
  const path = fakeHostingStatePath();
  const sidecar = failuresPath();
  if (!path || !sidecar) return;
  const store = readJson<Record<string, FakeHostingSlice>>(path);
  if (store) {
    delete store[safeKey(key)];
    writeJson(path, store);
  }
  const armed = readJson<ArmedFailures>(sidecar);
  if (armed) {
    delete armed[safeKey(key)];
    writeJson(sidecar, armed);
  }
}

/** Arm one failure of `operation` for `key` in the sidecar. Never creates the store. */
export function armFakeHostingFailure(
  key: string,
  operation: FakeHostingFailure,
  detail: string,
): void {
  const sidecar = failuresPath();
  if (!sidecar) return;
  const at = safeKey(key);
  const armed = readJson<ArmedFailures>(sidecar) ?? {};
  writeJson(sidecar, { ...armed, [at]: { ...armed[at], [safeKey(operation)]: detail } });
}

/** Take (consume) the failure armed for `key`'s `operation`: its detail, or null. */
export function takeArmedFakeHostingFailure(
  key: string,
  operation: FakeHostingFailure,
): string | null {
  const sidecar = failuresPath();
  if (!sidecar) return null;
  const at = safeKey(key);
  const op = safeKey(operation) as FakeHostingFailure;
  const armed = readJson<ArmedFailures>(sidecar);
  const detail = armed?.[at]?.[op];
  if (!armed || detail === undefined) return null;
  delete armed[at]![op];
  writeJson(sidecar, armed);
  return detail;
}
