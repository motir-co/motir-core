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
