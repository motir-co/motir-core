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

// ── Curation: promote and retire (MOTIR-710; 706 v2 §3.6) ───────────────────
//
// Every refusal below is raised BEFORE anything is written, in Motir or on
// GitHub, except where a class says otherwise.

/** Why a promotion's source row was refused. */
export type SeedPromotionSourceRefusal =
  /** No `project_repository` row has that id. */
  | 'not_found'
  /** The row is not `created` (a `connected` row is the organisation's own
   *  repository; a `proposed`, `creating`, `failed` or `skipped` row has no
   *  repository Motir made). */
  | 'not_created'
  /** The row is the organisation's own repository (`seedSource = organization`, D1). */
  | 'organization_row'
  /** A take-over is under way or done: the repository is leaving or has left Motir. */
  | 'taken_over'
  /** The repository is no longer in a GitHub org Motir holds. */
  | 'not_motir_held';

/**
 * A promotion's source is not a repository Motir created and still holds
 * (706 v2 §3.6, MOTIR-1966's re-scope). `refusal` names the rule. → 404 for
 * `not_found`, else 422.
 */
export class SeedPromotionSourceRefusedError extends Error {
  readonly code = 'SEED_PROMOTION_SOURCE_REFUSED' as const;
  constructor(
    readonly refusal: SeedPromotionSourceRefusal,
    readonly sourceRowId: string,
    detail: string,
  ) {
    super(`This repository cannot be promoted to a starter: ${detail}`);
    this.name = 'SeedPromotionSourceRefusedError';
  }
}

/** The named ref is not a branch, tag or commit of the source repository. → 422 */
export class SeedPromotionRefNotFoundError extends Error {
  readonly code = 'SEED_PROMOTION_REF_NOT_FOUND' as const;
  constructor(
    readonly repository: string,
    readonly ref: string,
  ) {
    super(`"${ref}" is not a branch, tag or commit of ${repository}.`);
    this.name = 'SeedPromotionRefNotFoundError';
  }
}

/** Why the source's hosting manifest refused a promotion's hosting targets. */
export type SeedPromotionManifestRefusal = 'missing' | 'invalid' | 'target_not_declared';

/**
 * 706 v2 §3.2's subset rule: an entry may claim a hosting target only when the
 * manifest at the promoted ref declares it. Names the FILE, and the manifest
 * FIELD (`invalid`) or the TARGET (`target_not_declared`). → 422
 */
export class SeedPromotionManifestRefusedError extends Error {
  readonly code = 'SEED_PROMOTION_MANIFEST_REFUSED' as const;
  constructor(
    readonly refusal: SeedPromotionManifestRefusal,
    readonly file: string,
    readonly field: string | null,
    readonly target: string | null,
    detail: string,
  ) {
    super(`The starter's ${file} refuses this promotion: ${detail}`);
    this.name = 'SeedPromotionManifestRefusedError';
  }
}

/**
 * Motir's org already has a repository by the template copy's name that is not
 * this entry's copy, so promoting would overwrite something else. → 409
 */
export class SeedPromotionTemplateNameTakenError extends Error {
  readonly code = 'SEED_PROMOTION_TEMPLATE_NAME_TAKEN' as const;
  constructor(readonly repository: string) {
    super(
      `${repository} already exists and is not this starter's template copy. ` +
        'Choose another key, or remove that repository first.',
    );
    this.name = 'SeedPromotionTemplateNameTakenError';
  }
}

/**
 * The entry is a role's default (706 v2 §3.8): `initialised`, or the web
 * default. Changing a default amends the decision; it is not an operator
 * action. → 409
 */
export class SeedEntryIsDefaultError extends Error {
  readonly code = 'SEED_ENTRY_IS_DEFAULT' as const;
  constructor(
    readonly key: string,
    readonly role: string,
  ) {
    super(
      `"${key}" is the default starter for ${role === 'any' ? 'every role' : `a ${role} repository`}, ` +
        'so it cannot be retired.',
    );
    this.name = 'SeedEntryIsDefaultError';
  }
}
