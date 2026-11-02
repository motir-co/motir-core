/**
 * `DATABASE_URL` for `fleet-admin` in a Fargate task of the core image (MOTIR-10264).
 *
 * On Fly the machine's environment holds `DATABASE_URL`. A Fargate task does not:
 * ECS injects the five login parts of core's application role
 * (`MOTIR_DB_USERNAME` … `MOTIR_DB_NAME`, from the database secret), and each
 * service composes the URL inside its own node process — motir-infra
 * `lib/constructs/core-migrate-task.ts` `withDatabaseUrl` — so a second process
 * started in the same task, such as an ECS Exec session, sees only the parts.
 *
 * This is that composition, written the same way so the two cannot disagree:
 * the user, password and database name percent-encoded (a generated password may
 * hold `@`, `/`, `:` or `%`), the host and port as given, `sslmode=verify-full`
 * as the services ask for (`SERVICE_DATABASE_SSLMODE`: node-postgres checks the
 * RDS certificate and its host name against `NODE_EXTRA_CA_CERTS`, which the task
 * sets), and the parts removed from the environment once the URL is composed.
 *
 * ⚠️ IT MUST RUN BEFORE `@/lib/db` IS EVALUATED, which reads `DATABASE_URL` at
 * module load. That is why it is its own module, imported by the bundle's entry
 * (`fleetAdminMain.ts`) ahead of a dynamic import of everything else.
 *
 * ⚠️ NOTHING HERE PRINTS. The composed URL and the password are handed back as
 * `secrets`, for the entry to redact from every line the command writes.
 */

/** The variables a core task is given its database login parts in (motir-infra `DATABASE_PART_ENV`). */
export const DATABASE_PART_ENV = {
  username: 'MOTIR_DB_USERNAME',
  password: 'MOTIR_DB_PASSWORD',
  host: 'MOTIR_DB_HOST',
  port: 'MOTIR_DB_PORT',
  dbname: 'MOTIR_DB_NAME',
} as const;

/** The TLS mode the services' URLs ask for (motir-infra `SERVICE_DATABASE_SSLMODE`). */
export const FARGATE_DATABASE_SSLMODE = 'verify-full';

/**
 * Where the URL came from:
 * - `environment` — `DATABASE_URL` was already set (a Fly machine, a developer's
 *   shell); nothing was touched.
 * - `parts` — it was composed from the login parts, which are now removed.
 * - `none` — neither is present; the database client will refuse on first import.
 */
export type DatabaseUrlSource =
  | { source: 'environment' }
  | { source: 'none' }
  | { source: 'parts'; secrets: readonly string[] };

/** The environment the URL is read from and written to — `process.env` in the bundle. */
export type DatabaseEnv = Record<string, string | undefined>;

/** Some login parts are set but not all of them; names the missing variables only. */
export class DatabasePartsIncompleteError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`);
    this.name = 'DatabasePartsIncompleteError';
  }
}

/**
 * Sets `env.DATABASE_URL` from the login parts when it is not already set, and
 * says where the URL came from. Throws `DatabasePartsIncompleteError` when only
 * some of the parts are set, as `withDatabaseUrl` refuses a missing part.
 */
export function composeDatabaseUrl(env: DatabaseEnv): DatabaseUrlSource {
  if (env['DATABASE_URL']) return { source: 'environment' };
  const names = Object.values(DATABASE_PART_ENV);
  const missing = names.filter((name) => !env[name]);
  if (missing.length === names.length) return { source: 'none' };
  if (missing.length > 0) throw new DatabasePartsIncompleteError(missing);

  // Every part is set: the check above refused otherwise.
  const part = (key: keyof typeof DATABASE_PART_ENV): string => String(env[DATABASE_PART_ENV[key]]);
  const enc = encodeURIComponent;
  const password = part('password');
  const url =
    `postgresql://${enc(part('username'))}:${enc(password)}` +
    `@${part('host')}:${part('port')}/${enc(part('dbname'))}` +
    `?sslmode=${FARGATE_DATABASE_SSLMODE}`;
  env['DATABASE_URL'] = url;
  for (const name of names) delete env[name];
  return { source: 'parts', secrets: [url, password, enc(password)] };
}
