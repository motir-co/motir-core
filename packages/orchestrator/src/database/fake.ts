import { databaseEnvPairs } from './env';
import {
  DatabaseApplicationRefInvalidError,
  DatabaseNotFoundError,
  assertDatabaseBranchName,
} from './errors';
import type {
  DatabaseBranchHandle,
  DatabaseHandle,
  DatabasePort,
  DatabaseProvider,
  DatabaseUsage,
} from './types';
import {
  emptyFakeDatabaseSlice,
  fakeDatabaseStatePath,
  readFakeDatabaseSlice,
  saveFakeDatabaseSlice,
  type FakeDatabaseSlice,
  type StoredFakeDatabase,
} from './fakeStore';

// The FAKE database port (MOTIR-9971) — the second implementation shipped beside
// the Neon adapter, for the reason every port here has one: the production and
// preview stories test against it, and a port with one implementation has never
// been shown to be a port.
//
// In memory and deterministic. It holds one database per application, keyed by
// the application ref, with connection strings that look like connection
// strings so a suite can search for them where they must not be. Compute time
// accrues while a database (or a branch) exists; storage is a fixed figure per
// database and per branch. A database's branches go with it. Its controls
// arrange what a test needs: a clock, and a read of what exists.
//
// SHARED ACROSS PROCESSES on request (MOTIR-12142): with
// `MOTIR_FAKE_DATABASE_STATE_PATH` set, every operation loads the databases,
// branches, clock and sequence from that file first and writes them back after
// a mutation (`./fakeStore`), so the acceptance lane's worker, app server and
// spec agree. Unset, the closure below is the whole store, as it always was.

/** What the fake holds for one database — never its connection strings. */
export interface FakeDatabase {
  readonly handle: DatabaseHandle;
  readonly region: string | null;
  readonly createdAt: Date;
}

/** What the fake holds for one branch — never its connection strings. */
export interface FakeDatabaseBranch {
  readonly branch: DatabaseBranchHandle;
  readonly createdAt: Date;
}

export interface FakeDatabaseControls {
  /** The fake's clock. */
  now(): Date;
  setClock(at: Date): void;
  advanceSeconds(seconds: number): void;
  /** Every database the fake holds now. */
  databases(): FakeDatabase[];
  /** Every branch the fake holds now, across its databases. */
  branches(): FakeDatabaseBranch[];
}

export interface FakeDatabaseOptions {
  readonly provider?: DatabaseProvider;
  readonly start?: Date;
}

/** The storage each fake database reports: 32 MiB. */
export const FAKE_DATABASE_STORAGE_BYTES = 32 * 1024 * 1024;

interface StoredBranch extends FakeDatabaseBranch {
  readonly pooledUrl: string;
  readonly directUrl: string;
}

interface StoredDatabase extends FakeDatabase {
  readonly pooledUrl: string;
  readonly directUrl: string;
  /** Keyed by branch name. */
  readonly branches: Map<string, StoredBranch>;
}

export function createFakeDatabasePort(
  options: FakeDatabaseOptions = {},
): DatabasePort & FakeDatabaseControls {
  const provider = options.provider ?? 'neon';
  const start = options.start ?? new Date('2026-01-01T00:00:00Z');
  let clock = start.getTime();
  let sequence = 0;
  const stored = new Map<string, StoredDatabase>();
  const now = () => new Date(clock);

  /** Replace the closure's state with the file's — a no-op with the seam off,
   *  and on a torn read, which keeps what this process has. No slice in the
   *  file means none was ever written, or another process reset it: empty. */
  function load(): void {
    if (!fakeDatabaseStatePath()) return;
    const slice = readFakeDatabaseSlice(provider);
    if (slice === 'torn') return;
    const from = slice ?? emptyFakeDatabaseSlice(start);
    clock = from.clock;
    sequence = from.sequence;
    stored.clear();
    for (const [applicationRef, database] of Object.entries(from.databases)) {
      stored.set(applicationRef, revive(database));
    }
  }

  /** Write the closure's state to the file after a mutation — a no-op with the seam off. */
  function save(): void {
    if (!fakeDatabaseStatePath()) return;
    const slice: FakeDatabaseSlice = { databases: {}, clock, sequence };
    for (const [applicationRef, database] of stored) {
      slice.databases[applicationRef] = serialize(database);
    }
    saveFakeDatabaseSlice(provider, slice);
  }

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
      branches: new Map(),
    };
  }

  function branchOf(database: StoredDatabase, name: string): StoredBranch {
    sequence += 1;
    const branchRef = `fake-br-${sequence}`;
    const password = `fake-password-${sequence}`;
    return {
      branch: { database: database.handle, branchRef, name },
      createdAt: now(),
      pooledUrl: `postgresql://app:${password}@${branchRef}-pooler.fake.invalid/app?sslmode=require`,
      directUrl: `postgresql://app:${password}@${branchRef}.fake.invalid/app?sslmode=require`,
    };
  }

  return {
    provider,
    now: () => {
      load();
      return now();
    },
    setClock(at) {
      load();
      clock = at.getTime();
      save();
    },
    advanceSeconds(seconds) {
      load();
      clock += seconds * 1000;
      save();
    },
    databases: () => {
      load();
      return [...stored.values()].map(({ handle, region, createdAt }) => ({
        handle,
        region,
        createdAt,
      }));
    },
    branches: () => {
      load();
      return [...stored.values()].flatMap((database) =>
        [...database.branches.values()].map(({ branch, createdAt }) => ({ branch, createdAt })),
      );
    },

    async createDatabase({ applicationRef, region }) {
      if (!applicationRef.trim()) throw new DatabaseApplicationRefInvalidError(applicationRef);
      load();
      let database = stored.get(applicationRef);
      if (!database) {
        database = create(applicationRef, region);
        stored.set(applicationRef, database);
        save();
      }
      return { handle: database.handle, env: databaseEnvPairs(database) };
    },

    async connectionEnv(handle) {
      load();
      const database = held(handle);
      if (!database) throw new DatabaseNotFoundError(handle.applicationRef);
      return databaseEnvPairs(database);
    },

    async usageSince(handle, since) {
      load();
      const database = held(handle);
      if (!database) throw new DatabaseNotFoundError(handle.applicationRef);
      return usageOver(handle.applicationRef, since, database.createdAt);
    },

    async deleteDatabase(handle) {
      load();
      const database = held(handle);
      if (!database) return usageOver(handle.applicationRef, now(), null);
      stored.delete(handle.applicationRef);
      save();
      return usageOver(handle.applicationRef, database.createdAt, database.createdAt);
    },

    async list() {
      load();
      return [...stored.values()].map(({ handle }) => ({ handle }));
    },

    async createBranch(handle, { name }) {
      assertDatabaseBranchName(name);
      load();
      const database = held(handle);
      if (!database) throw new DatabaseNotFoundError(handle.applicationRef);
      let branch = database.branches.get(name);
      if (!branch) {
        branch = branchOf(database, name);
        database.branches.set(name, branch);
        save();
      }
      return { branch: branch.branch, env: databaseEnvPairs(branch) };
    },

    async branchUsage({ database: handle, branchRef, name }) {
      load();
      const branch = held(handle)?.branches.get(name);
      if (!branch || branch.branch.branchRef !== branchRef) {
        return usageOver(handle.applicationRef, now(), null);
      }
      return usageOver(handle.applicationRef, branch.createdAt, branch.createdAt);
    },

    async deleteBranch({ database: handle, branchRef, name }) {
      load();
      const branch = held(handle)?.branches.get(name);
      if (!branch || branch.branch.branchRef !== branchRef) {
        return usageOver(handle.applicationRef, now(), null);
      }
      held(handle)!.branches.delete(name);
      save();
      return usageOver(handle.applicationRef, branch.createdAt, branch.createdAt);
    },
  };
}

/** A stored database as the file holds it: instants as ISO, branches by name. */
function serialize(database: StoredDatabase): StoredFakeDatabase {
  const branches: StoredFakeDatabase['branches'] = {};
  for (const [name, branch] of database.branches) {
    branches[name] = {
      branch: branch.branch,
      createdAt: branch.createdAt.toISOString(),
      pooledUrl: branch.pooledUrl,
      directUrl: branch.directUrl,
    };
  }
  return {
    handle: database.handle,
    region: database.region,
    createdAt: database.createdAt.toISOString(),
    pooledUrl: database.pooledUrl,
    directUrl: database.directUrl,
    branches,
  };
}

/** The file's database back as the closure holds it: Dates and a branch Map. */
function revive(database: StoredFakeDatabase): StoredDatabase {
  return {
    handle: database.handle,
    region: database.region,
    createdAt: new Date(database.createdAt),
    pooledUrl: database.pooledUrl,
    directUrl: database.directUrl,
    branches: new Map(
      Object.entries(database.branches).map(([name, branch]) => [
        name,
        {
          branch: branch.branch,
          createdAt: new Date(branch.createdAt),
          pooledUrl: branch.pooledUrl,
          directUrl: branch.directUrl,
        },
      ]),
    ),
  };
}
