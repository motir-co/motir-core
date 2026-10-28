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
