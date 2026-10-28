// Typed errors of the DATABASE PORT (MOTIR-9971). Provider-neutral, like the
// port: an adapter's API failures stay `OrchestratorApiError`, and a provider
// with no adapter is `OrchestratorNotConfiguredError` (`../errors`). Neither
// error here carries anything but the application ref — never a connection
// string, which is a credential.

/** A handle names a database this port does not hold. */
export class DatabaseNotFoundError extends Error {
  readonly code = 'DATABASE_NOT_FOUND' as const;
  constructor(readonly applicationRef: string) {
    super(`${applicationRef} has no database.`);
    this.name = 'DatabaseNotFoundError';
  }
}

/** The application ref is empty or blank — there is no application to give a
 *  database to. Refused before any provider call. */
export class DatabaseApplicationRefInvalidError extends Error {
  readonly code = 'DATABASE_APPLICATION_REF_INVALID' as const;
  constructor(readonly applicationRef: string) {
    super(`"${applicationRef}" is not an application reference.`);
    this.name = 'DatabaseApplicationRefInvalidError';
  }
}
