// Typed errors for a Motir repository's environment configuration (Story
// MOTIR-9795). Kept free of Prisma so the resolver and the deploy check can import
// them without a database. The suggested HTTP mapping is on each class.

/** The name is one the platform sets itself (`isReservedEnvironmentName`):
 *  `PORT`, `DATABASE_URL` or any `MOTIR_*`. → 422 */
export class ReservedEnvironmentNameError extends Error {
  readonly code = 'ENVIRONMENT_NAME_RESERVED' as const;
  constructor(readonly reservedName: string) {
    super(
      `${reservedName} is reserved: PORT, DATABASE_URL and MOTIR_* names are set by the platform.`,
    );
    this.name = 'ReservedEnvironmentNameError';
  }
}
/** Motir holds no configuration for a customer repository — one whose seed
 *  source is the organisation's own (D1 of MOTIR-5769). → 422 */
export class CustomerRepositoryError extends Error {
  readonly code = 'ENVIRONMENT_CONFIG_CUSTOMER_REPOSITORY' as const;
  constructor(readonly projectRepositoryId: string) {
    super(
      `Repository ${projectRepositoryId} is a customer repository: Motir holds no environment configuration for it.`,
    );
    this.name = 'CustomerRepositoryError';
  }
}

/** The caller may browse the project but may not manage its repositories
 *  (`repository:manage`), so may not change their environment configuration. → 403 */
export class EnvironmentConfigForbiddenError extends Error {
  readonly code = 'ENVIRONMENT_CONFIG_FORBIDDEN' as const;
  constructor(readonly projectRepositoryId: string) {
    super(
      `Only a project administrator may change the environment configuration of repository ${projectRepositoryId}.`,
    );
    this.name = 'EnvironmentConfigForbiddenError';
  }
}

/** No entry of that name is set in that environment. → 404 */
export class EnvironmentEntryNotFoundError extends Error {
  readonly code = 'ENVIRONMENT_ENTRY_NOT_FOUND' as const;
  constructor(
    readonly entryName: string,
    readonly environment: string,
  ) {
    super(`${entryName} is not set in ${environment}.`);
    this.name = 'EnvironmentEntryNotFoundError';
  }
}

/** The name is not an environment-variable name: it must match
 *  `^[A-Za-z_][A-Za-z0-9_]*$`. → 422 */
export class InvalidEnvironmentNameError extends Error {
  readonly code = 'ENVIRONMENT_NAME_INVALID' as const;
  constructor(readonly entryName: string) {
    super(
      `"${entryName}" is not an environment variable name: use letters, digits and underscores, not starting with a digit.`,
    );
    this.name = 'InvalidEnvironmentNameError';
  }
}
