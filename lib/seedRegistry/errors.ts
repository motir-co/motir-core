// Typed errors for the SEED REGISTRY (Story MOTIR-704 · MOTIR-708). Kept in their
// own file so a later route (MOTIR-710's operator action) can import them without
// the Prisma client (the `lib/<domain>/errors.ts` convention). The suggested HTTP
// mapping is on each class.

/**
 * A written entry carries a value outside its closed list — a use case, size or
 * hosting target that `lib/hosting/vocabulary.ts` does not export, a role outside
 * ADR §1.1, or a blank required field. Names the FIELD and the VALUE, and nothing
 * is written. → 422
 */
export class SeedRegistryInvalidFieldError extends Error {
  readonly code = 'SEED_REGISTRY_INVALID_FIELD' as const;
  constructor(
    readonly field: string,
    readonly value: string,
    reason: string,
  ) {
    super(`Seed registry entry "${field}" is invalid: "${value}" ${reason}`);
    this.name = 'SeedRegistryInvalidFieldError';
  }
}

/** No entry has this key (current or legacy). → 404 */
export class SeedRegistryEntryNotFoundError extends Error {
  readonly code = 'SEED_REGISTRY_ENTRY_NOT_FOUND' as const;
  constructor(readonly key: string) {
    super(`No seed registry entry has the key "${key}".`);
    this.name = 'SeedRegistryEntryNotFoundError';
  }
}

/** Another entry already holds this key, as its key or a legacy key. → 409 */
export class SeedRegistryKeyTakenError extends Error {
  readonly code = 'SEED_REGISTRY_KEY_TAKEN' as const;
  constructor(readonly key: string) {
    super(`The seed registry key "${key}" is already taken.`);
    this.name = 'SeedRegistryKeyTakenError';
  }
}

// ── Resolution at establish ─────────────────────────────────────────────────
//
// A row's `seedSource` that does not resolve to a seed fails THAT ROW (706 3.6,
// card MOTIR-708 §4): the establish step records `reason` on the row verbatim, so
// it is written for a person and names the entry. It never falls back to
// `initialised` — a repository created from a guessed default is a real artifact
// nobody chose.

/** Base of every resolution failure: `reason` is the renderable sentence. */
export abstract class SeedResolutionError extends Error {
  abstract readonly code: string;
  constructor(
    readonly seedKey: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = new.target.name;
  }
}

/** The row names a key no registry entry carries. */
export class SeedEntryUnknownError extends SeedResolutionError {
  readonly code = 'SEED_ENTRY_UNKNOWN' as const;
  constructor(seedKey: string) {
    super(
      seedKey,
      `This repository is set to start from "${seedKey}", which is not in Motir's starter registry, ` +
        'so nothing was created. Choose another starter for this row, then retry it.',
    );
  }
}

/** The row names an entry that has been retired. */
export class SeedEntryRetiredError extends SeedResolutionError {
  readonly code = 'SEED_ENTRY_RETIRED' as const;
  constructor(seedKey: string) {
    super(
      seedKey,
      `This repository is set to start from "${seedKey}", which has been retired from Motir's ` +
        'starter registry, so nothing was created. Choose another starter for this row, then retry it.',
    );
  }
}
