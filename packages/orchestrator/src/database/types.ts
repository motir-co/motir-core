// The DATABASE PORT (Story MOTIR-9793 · MOTIR-9971) — one provider-neutral way to
// give a hosted application its own database: create it, hand back its
// connection strings, report its usage, delete it. The decision of record is
// MOTIR-5769 (page cmvrcywwc00jkhpr1zvvnike8, version 1), which pairs the
// serverless and Fly targets with the same database kind (serverless Postgres).
//
// ⚠️ A PORT OF ITS OWN, NOT AN OPERATION ON THE DEPLOY PORT. The Fly target and
// previews need the same database as the serverless target, and a deploy port
// that also owned databases would mix two lifecycles: a release is replaced on
// every merge, a database lives as long as the application. What it shares with
// the deploy port is the discipline of `docs/decisions/ci-runner-fleet.md` §4:
// no provider type crosses this file, a fake ships beside every adapter, and
// deleting a database RETURNS its usage.
//
// ⚠️ A CONNECTION STRING IS A CREDENTIAL. The port returns it in exactly one
// shape — a `ReleaseEnvVar` with `secret: true`, from `createDatabase` and
// `connectionEnv` — the shape the deploy port already delivers to a provider's
// environment. Every other value here (a handle, a summary, a usage record) is
// typed without a field a URL could ride in, and no error message carries one.
import type { ReleaseEnvVar } from '../hosting/types';

/** The providers a database can live on. Neon is the record's serverless
 *  Postgres; another provider joins by adding its name and one adapter. */
export type DatabaseProvider = 'neon';

/** One application's database. `databaseRef` is opaque above the adapter, and
 *  no field holds a connection string. */
export interface DatabaseHandle {
  readonly provider: DatabaseProvider;
  /** The application the database belongs to — an app reference as the deploy
   *  port's `ensureApp` returns it. */
  readonly applicationRef: string;
  readonly databaseRef: string;
}

export interface CreateDatabaseInput {
  readonly applicationRef: string;
  /** Absent means the adapter's configured region. */
  readonly region?: string;
}

/** A created (or found) database and its connection pairs — the ONE place a
 *  connection string leaves the port. */
export interface DatabaseCreated {
  readonly handle: DatabaseHandle;
  readonly env: readonly ReleaseEnvVar[];
}

/** Compute time and storage of one database over a window. */
export interface DatabaseUsage {
  readonly provider: DatabaseProvider;
  readonly applicationRef: string;
  readonly since: Date;
  readonly until: Date;
  readonly computeSeconds: number;
  readonly storageBytes: number;
}

export interface DatabaseSummary {
  readonly handle: DatabaseHandle;
}

/** One BRANCH of an application's database (MOTIR-5772) — what a pull-request
 *  preview runs on: MOTIR-5769 §6 gives each preview branch `pr-<n>` of its
 *  repository's data-free preview database. `branchRef` is opaque above the
 *  adapter, and, like the database handle, no field holds a connection string. */
export interface DatabaseBranchHandle {
  readonly database: DatabaseHandle;
  readonly branchRef: string;
  /** The name it was created under — unique within its database. */
  readonly name: string;
}

export interface CreateBranchInput {
  /** A DNS-label-shaped name, unique within the database (`pr-12`). */
  readonly name: string;
}

/** A created (or found) branch and its connection pairs — the branch's own
 *  credentials, never its database's. */
export interface DatabaseBranchCreated {
  readonly branch: DatabaseBranchHandle;
  readonly env: readonly ReleaseEnvVar[];
}

export interface DatabasePort {
  readonly provider: DatabaseProvider;
  /** Create the application's database. Idempotent on `applicationRef`: an
   *  existing database is returned, with its pairs, never a second one — so a
   *  retried production-deploy step does not make two. */
  createDatabase(input: CreateDatabaseInput): Promise<DatabaseCreated>;
  /** Re-read the pairs of an existing database. Throws `DatabaseNotFoundError`
   *  when the handle names none. */
  connectionEnv(handle: DatabaseHandle): Promise<readonly ReleaseEnvVar[]>;
  /** Compute and storage from `since` until now — for a database that lives as
   *  long as its application and is rarely deleted. */
  usageSince(handle: DatabaseHandle, since: Date): Promise<DatabaseUsage>;
  /** Delete the database. NON-OPTIONAL usage: there is no delete that does not
   *  produce it. The usage covers the database's whole life; an already-gone
   *  database is deleted with zero usage. */
  deleteDatabase(handle: DatabaseHandle): Promise<DatabaseUsage>;
  /** The databases this port holds. */
  list(): Promise<DatabaseSummary[]>;
  /** Create a branch of the database from its root, with its own connection
   *  pairs. Idempotent on `name`: an existing branch is returned, never a
   *  second one, so a redelivered webhook makes one preview database. Throws
   *  `DatabaseNotFoundError` when the handle names no database, and
   *  `DatabaseBranchNameInvalidError` before any provider call. */
  createBranch(database: DatabaseHandle, input: CreateBranchInput): Promise<DatabaseBranchCreated>;
  /** Delete the branch, returning its usage over its life. An already-gone
   *  branch — or a database already gone with it — is deleted with zero usage,
   *  so teardown is idempotent. */
  deleteBranch(branch: DatabaseBranchHandle): Promise<DatabaseUsage>;
}
