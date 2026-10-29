// Typed errors for HOSTING a Motir repository (Story MOTIR-9791). The decision of
// record is MOTIR-5769 (page cmvrcywwc00jkhpr1zvvnike8, version 1). Kept free of
// Prisma so the operator deploy check and the deploy port can import them without
// a database. The suggested HTTP mapping is on each class.

/** One failing manifest field: its dotted path (`null` for the document itself)
 *  and a one-line reason. */
export interface HostingManifestIssue {
  field: string | null;
  reason: string;
}

/** The repository has no hosting manifest at that ref. The caller passes `null`
 *  when the file is absent; the parser never looks for one itself. → 422 */
export class HostingManifestMissingError extends Error {
  readonly code = 'HOSTING_MANIFEST_MISSING' as const;
  constructor(readonly fileName: string) {
    super(`No hosting manifest: the repository has no ${fileName} at its root.`);
    this.name = 'HostingManifestMissingError';
  }
}

/**
 * The hosting manifest is not valid JSON, or a field is missing or invalid.
 * `field` names the FIRST failing field in the record's field order (`null` when
 * the text does not parse at all); `issues` lists every failing field, so one run
 * shows them all. → 422
 */
export class HostingManifestInvalidError extends Error {
  readonly code = 'HOSTING_MANIFEST_INVALID' as const;
  readonly field: string | null;
  readonly reason: string;
  constructor(readonly issues: readonly HostingManifestIssue[]) {
    const first = issues[0] ?? { field: null, reason: 'invalid' };
    super(
      `Invalid hosting manifest: ${first.field ?? 'the document'} — ${first.reason}` +
        (issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''),
    );
    this.name = 'HostingManifestInvalidError';
    this.field = first.field;
    this.reason = first.reason;
  }
}

// ── The application record and its releases (Story MOTIR-9797 · MOTIR-10026) ──

/** A customer repository (seed source `organization`) is never hosted by Motir
 *  (Decision MOTIR-5769, D1). → 409 */
export class CustomerRepositoryNotDeployableError extends Error {
  readonly code = 'CUSTOMER_REPOSITORY_NOT_DEPLOYABLE' as const;
  constructor(readonly projectRepositoryId: string) {
    super(`Repository ${projectRepositoryId} is a customer repository; Motir does not host it.`);
    this.name = 'CustomerRepositoryNotDeployableError';
  }
}

/** The repository row names no repository that exists yet. → 409 */
export class RepositoryNotEstablishedError extends Error {
  readonly code = 'REPOSITORY_NOT_ESTABLISHED' as const;
  constructor(
    readonly projectRepositoryId: string,
    readonly state: string,
  ) {
    super(`Repository ${projectRepositoryId} is not established (state ${state}).`);
    this.name = 'RepositoryNotEstablishedError';
  }
}

/** The repository has no hosting target, so there is nowhere to run it. → 409 */
export class HostingTargetMissingError extends Error {
  readonly code = 'HOSTING_TARGET_MISSING' as const;
  constructor(readonly projectRepositoryId: string) {
    super(`Repository ${projectRepositoryId} has no hosting target.`);
    this.name = 'HostingTargetMissingError';
  }
}

/** A release move outside the edge table, or one whose release already moved
 *  (`actual` is then its current state, or null when it no longer exists). → 409 */
export class IllegalReleaseTransitionError extends Error {
  readonly code = 'ILLEGAL_RELEASE_TRANSITION' as const;
  constructor(
    readonly releaseId: string,
    readonly from: string,
    readonly to: string,
    readonly actual: string | null,
  ) {
    super(
      `Release ${releaseId} cannot move ${from} → ${to}` +
        (actual === from ? '.' : ` (it is ${actual ?? 'gone'}).`),
    );
    this.name = 'IllegalReleaseTransitionError';
  }
}

/** The release belongs to another application. → 409 */
export class ReleaseNotOfApplicationError extends Error {
  readonly code = 'RELEASE_NOT_OF_APPLICATION' as const;
  constructor(
    readonly releaseId: string,
    readonly applicationId: string,
  ) {
    super(`Release ${releaseId} is not a release of application ${applicationId}.`);
    this.name = 'ReleaseNotOfApplicationError';
  }
}

/** No hosted application (or repository row) by that id. → 404 */
export class ApplicationNotFoundError extends Error {
  readonly code = 'APPLICATION_NOT_FOUND' as const;
  constructor(readonly id: string) {
    super(`No hosted application for ${id}.`);
    this.name = 'ApplicationNotFoundError';
  }
}

/** The step of production enablement that failed (MOTIR-10027). */
export type ProductionEnablementStep =
  | 'repository'
  | 'manifest'
  | 'application'
  | 'app'
  | 'credential'
  | 'environment'
  | 'secret'
  | 'variables'
  | 'record';

/**
 * Production enablement stopped at `step`. Every step is idempotent, so running
 * enablement again repairs it; the target variable is written last, so a failure
 * never leaves the workflow able to run. `detail` never carries a credential.
 * → 502
 */
export class ProductionEnablementFailedError extends Error {
  readonly code = 'PRODUCTION_ENABLEMENT_FAILED' as const;
  constructor(
    readonly projectRepositoryId: string,
    readonly step: ProductionEnablementStep,
    readonly detail: string,
  ) {
    super(`Production enablement of ${projectRepositoryId} failed at ${step}: ${detail}`);
    this.name = 'ProductionEnablementFailedError';
  }
}
