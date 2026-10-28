import { databaseEnvPairs } from './env';
import { DatabaseApplicationRefInvalidError, DatabaseNotFoundError } from './errors';
import type { DatabaseHandle, DatabasePort, DatabaseProvider, DatabaseUsage } from './types';

// The FAKE database port (MOTIR-9971) — the second implementation shipped beside
// the Neon adapter, for the reason every port here has one: the production and
// preview stories test against it, and a port with one implementation has never
// been shown to be a port.
//
// In memory and deterministic. It holds one database per application, keyed by
// the application ref, with connection strings that look like connection
// strings so a suite can search for them where they must not be. Compute time
// accrues while a database exists; storage is a fixed figure per database. Its
// controls arrange what a test needs: a clock, and a read of what exists.

/** What the fake holds for one database — never its connection strings. */
export interface FakeDatabase {
  readonly handle: DatabaseHandle;
  readonly region: string | null;
  readonly createdAt: Date;
}

export interface FakeDatabaseControls {
  /** The fake's clock. */
  now(): Date;
  setClock(at: Date): void;
  advanceSeconds(seconds: number): void;
  /** Every database the fake holds now. */
  databases(): FakeDatabase[];
}

export interface FakeDatabaseOptions {
  readonly provider?: DatabaseProvider;
  readonly start?: Date;
}

/** The storage each fake database reports: 32 MiB. */
export const FAKE_DATABASE_STORAGE_BYTES = 32 * 1024 * 1024;

interface StoredDatabase extends FakeDatabase {
  readonly pooledUrl: string;
  readonly directUrl: string;
}

export function createFakeDatabasePort(
  options: FakeDatabaseOptions = {},
): DatabasePort & FakeDatabaseControls {
  const provider = options.provider ?? 'neon';
  let clock = (options.start ?? new Date('2026-01-01T00:00:00Z')).getTime();
  let sequence = 0;
  const stored = new Map<string, StoredDatabase>();
  const now = () => new Date(clock);

  function held(handle: DatabaseHandle): StoredDatabase | undefined {
    const database = stored.get(handle.applicationRef);
    return database?.handle.databaseRef === handle.databaseRef ? database : undefined;
  }

  function usageOver(applicationRef: string, since: Date, livedFrom: Date | null): DatabaseUsage {
    const until = now();
    const from = livedFrom ? Math.max(since.getTime(), livedFrom.getTime()) : until.getTime();
    return {
      provider,
      applicationRef,
      since,
      until,
      computeSeconds: Math.max(0, Math.floor((until.getTime() - from) / 1000)),
      storageBytes: livedFrom ? FAKE_DATABASE_STORAGE_BYTES : 0,
    };
  }

  function create(applicationRef: string, region: string | undefined): StoredDatabase {
    sequence += 1;
    const databaseRef = `fake-db-${sequence}`;
    const password = `fake-password-${sequence}`;
    return {
      handle: { provider, applicationRef, databaseRef },
      region: region ?? null,
      createdAt: now(),
      pooledUrl: `postgresql://app:${password}@${databaseRef}-pooler.fake.invalid/app?sslmode=require`,
      directUrl: `postgresql://app:${password}@${databaseRef}.fake.invalid/app?sslmode=require`,
    };
  }

  return {
    provider,
    now,
    setClock(at) {
      clock = at.getTime();
    },
    advanceSeconds(seconds) {
      clock += seconds * 1000;
    },
    databases: () =>
      [...stored.values()].map(({ handle, region, createdAt }) => ({ handle, region, createdAt })),

    async createDatabase({ applicationRef, region }) {
      if (!applicationRef.trim()) throw new DatabaseApplicationRefInvalidError(applicationRef);
      let database = stored.get(applicationRef);
      if (!database) {
        database = create(applicationRef, region);
        stored.set(applicationRef, database);
      }
      return { handle: database.handle, env: databaseEnvPairs(database) };
    },

    async connectionEnv(handle) {
      const database = held(handle);
      if (!database) throw new DatabaseNotFoundError(handle.applicationRef);
      return databaseEnvPairs(database);
    },

    async usageSince(handle, since) {
      const database = held(handle);
      if (!database) throw new DatabaseNotFoundError(handle.applicationRef);
      return usageOver(handle.applicationRef, since, database.createdAt);
    },

    async deleteDatabase(handle) {
      const database = held(handle);
      if (!database) return usageOver(handle.applicationRef, now(), null);
      stored.delete(handle.applicationRef);
      return usageOver(handle.applicationRef, database.createdAt, database.createdAt);
    },

    async list() {
      return [...stored.values()].map(({ handle }) => ({ handle }));
    },
  };
}
