// Typed errors of the HOSTING DEPLOY PORT (MOTIR-5773). Provider-neutral, like
// the port: an adapter's API failures stay `OrchestratorApiError`, and a target
// with no adapter is `OrchestratorNotConfiguredError` (`../errors`).

/** `rollback` asked for an environment that has no kept previous release — a
 *  first deploy, or one already destroyed. */
export class NoPreviousReleaseError extends Error {
  readonly code = 'HOSTING_NO_PREVIOUS_RELEASE' as const;
  constructor(readonly appRef: string) {
    super(`${appRef} has no previous release to roll back to.`);
    this.name = 'NoPreviousReleaseError';
  }
}

/** The (prefix, repository, environment) would not make a DNS-label app name:
 *  at most 63 characters of `[a-z0-9-]`, starting with a letter or digit
 *  (MOTIR-5769 §4). Refused rather than mangled, so a name never collides. */
export class HostingAppNameInvalidError extends Error {
  readonly code = 'HOSTING_APP_NAME_INVALID' as const;
  constructor(readonly appName: string) {
    super(`"${appName}" is not a valid hosted app name (a DNS label of at most 63 [a-z0-9-]).`);
    this.name = 'HostingAppNameInvalidError';
  }
}

/** A release handle or app ref names a release this adapter does not hold. */
export class ReleaseNotFoundError extends Error {
  readonly code = 'HOSTING_RELEASE_NOT_FOUND' as const;
  constructor(readonly appRef: string) {
    super(`${appRef} has no release.`);
    this.name = 'ReleaseNotFoundError';
  }
}

/** The target cannot run this kind of artifact (Fly runs images, not bundles). */
export class ReleaseArtifactUnsupportedError extends Error {
  readonly code = 'HOSTING_ARTIFACT_UNSUPPORTED' as const;
  constructor(
    readonly target: string,
    readonly artifactKind: string,
  ) {
    super(`The ${target} target cannot run a ${artifactKind} artifact.`);
    this.name = 'ReleaseArtifactUnsupportedError';
  }
}

/** The release's runtime asks for something the target reserves — on Fly, the
 *  guard container's port. Refused by the field's name before any API call. */
export class ReleaseRuntimeRefusedError extends Error {
  readonly code = 'HOSTING_RUNTIME_REFUSED' as const;
  constructor(
    readonly target: string,
    readonly field: string,
    readonly reason: string,
  ) {
    super(`The ${target} target refuses the release's ${field}: ${reason}.`);
    this.name = 'ReleaseRuntimeRefusedError';
  }
}

/** A release for a target that needs a shape (AWS: `function` or `container`)
 *  arrived without one. Refused by name before anything is created — the shape
 *  is the repository's recorded hosting decision, never inferred. */
export class ReleaseShapeRequiredError extends Error {
  readonly code = 'HOSTING_SHAPE_REQUIRED' as const;
  constructor(readonly target: string) {
    super(
      `The ${target} target needs a release shape ("function" or "container"); none was given.`,
    );
    this.name = 'ReleaseShapeRequiredError';
  }
}

/** The repository is a customer repository (its seed source is the
 *  organisation's own, D1). No hosting adapter deploys one. */
export class CustomerRepositoryRefusedError extends Error {
  readonly code = 'HOSTING_CUSTOMER_REPOSITORY_REFUSED' as const;
  constructor(readonly repositoryId: string) {
    super(`Repository ${repositoryId} is a customer repository; Motir does not host it.`);
    this.name = 'CustomerRepositoryRefusedError';
  }
}

/** The idle policy cannot be honoured by this target's shape — on AWS, a
 *  container is `always_on` only (MOTIR-5769 §4). Refused before any provider
 *  call. */
export class IdlePolicyUnsupportedError extends Error {
  readonly code = 'HOSTING_IDLE_POLICY_UNSUPPORTED' as const;
  constructor(
    readonly target: string,
    readonly shape: string,
    readonly mode: string,
  ) {
    super(`The ${target} ${shape} shape cannot run with the "${mode}" idle policy.`);
    this.name = 'IdlePolicyUnsupportedError';
  }
}
