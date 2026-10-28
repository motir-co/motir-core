// The HOSTING DEPLOY PORT (Story MOTIR-9791 · MOTIR-5773) — one provider-neutral
// way to run a hosted web application for one (repository, environment), where
// the environment is a preview of one pull request or production. The decision
// of record is MOTIR-5769 (page cmvrcywwc00jkhpr1zvvnike8, version 1).
//
// ⚠️ A THIRD PORT, NOT A WORKLOAD ON EITHER OF THE OTHER TWO. `ContainerOrchestrator`
// runs batch work under a hard-kill timeout; `PersistentContainerOrchestrator`
// keeps an agent's machine and volume. A hosted release is neither: it serves
// HTTP on a declared port, answers a health check, keeps the release it replaced
// for rollback, may sleep when idle and wake on a request, and lives until it is
// retired. What it shares with them is the port discipline of
// `docs/decisions/ci-runner-fleet.md` §4: no provider type crosses this file, a
// fake ships beside every adapter, and destroying a release RETURNS its usage.
//
// The port never knows which caller is asking (preview lifecycle, production
// deploy, the operator deploy check), and it is told nothing about ownership: a
// customer repository (D1) is refused by the callers before it gets here.

/** The targets a Motir repo can run on (MOTIR-5769 §2). Each registers one
 *  adapter on this port; none adds a second port. */
export type HostingDeployTarget = 'serverless' | 'fly' | 'aws';

/** Where a release runs: one pull request's preview, or production. */
export type HostingEnvironment = { kind: 'preview'; pullRequest: number } | { kind: 'production' };

/** The isolation unit `ensureApp` made: where releases run (`appRef`) and where
 *  CI pushes the image they run (`pushNamespace`). A preview's push namespace is
 *  shared by every pull request of the repository and never production's, so a
 *  pull request's credential cannot overwrite production (MOTIR-5769 §4). */
export interface HostingApp {
  readonly appRef: string;
  readonly pushNamespace: string;
}

/**
 * A credential that may push to ONE push namespace. A static secret (an
 * app-scoped deploy token) or a federated identity (a GitHub-OIDC role) — two
 * shapes so no adapter has to fake the other's.
 */
export type DeployCredential =
  | { kind: 'secret'; pushNamespace: string; value: string; expiresAt: Date }
  | { kind: 'federated'; pushNamespace: string; subject: string };

/** What a release runs. An image is pinned by `digest` when one is given. */
export type ReleaseArtifact =
  | { kind: 'image'; ref: string; digest?: string }
  | { kind: 'bundle'; ref: string };

/**
 * The part of a repository's hosting manifest (`motir.hosting.json`, parsed by
 * the app's `parseHostingManifest`) the port reads. Declared here as a subset
 * because this package cannot import the app; an app-side type test pins that a
 * `HostingManifest` satisfies it, so the two cannot drift silently.
 */
export interface ReleaseRuntime {
  readonly port: number;
  readonly healthCheck: { readonly path: string };
  readonly startCommand: string;
  readonly database: { readonly kind: 'none' | 'postgres' };
}

/** One environment variable of a release. `secret` values are never logged or
 *  returned by `describe`. */
export interface ReleaseEnvVar {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
}

/** A release's size, from the repository row (MOTIR-9808). Each adapter maps it
 *  to its own machine sizes; previews run at the target's fixed preview size. */
export type ReleaseSize = 'small' | 'medium' | 'large';

/** Whether a release keeps running with no traffic. `idleSeconds` is recorded;
 *  an adapter whose provider picks its own idle window does not apply it. */
export type ReleaseIdlePolicy = { mode: 'always_on' } | { mode: 'suspend'; idleSeconds: number };

export interface DeployReleaseInput {
  readonly appRef: string;
  readonly environment: HostingEnvironment;
  readonly artifact: ReleaseArtifact;
  readonly runtime: ReleaseRuntime;
  readonly env: readonly ReleaseEnvVar[];
  /** Production's size; ignored for a preview. Absent means `small`. */
  readonly size?: ReleaseSize;
  /** Absent means the adapter's configured region. */
  readonly region?: string;
  readonly idle: ReleaseIdlePolicy;
}

/** A live (or once-live) release. `providerRef` is opaque above the adapter. */
export interface ReleaseHandle {
  readonly target: HostingDeployTarget;
  readonly appRef: string;
  readonly environment: HostingEnvironment;
  readonly releaseId: string;
  readonly providerRef: string;
}

export type ReleaseState = 'deploying' | 'healthy' | 'unhealthy' | 'stopped' | 'destroyed';

/** What a forwarder must send to reach the upstream (MOTIR-5769 §4): the derived
 *  `X-Motir-Origin-Secret`, a SigV4 signature, or nothing yet. */
export type OriginCredentialKind = 'origin_secret' | 'aws_sigv4' | 'none';

export interface ReleaseDescription {
  readonly state: ReleaseState;
  /** The release live in this environment now — after a rollback, NOT the
   *  handle's own release. Null once destroyed. */
  readonly releaseId: string | null;
  /** The release a rollback would restore, or null when there is none. */
  readonly previousReleaseId: string | null;
  /** Where a forwarder sends requests, or null once destroyed. */
  readonly upstreamAddress: string | null;
  readonly originCredential: OriginCredentialKind;
}

/** Running time of one environment's release over a window. Stopped and
 *  suspended time is not running time. */
export interface ReleaseUsage {
  readonly target: HostingDeployTarget;
  readonly appRef: string;
  readonly releaseId: string;
  readonly since: Date;
  readonly until: Date;
  readonly runningSeconds: number;
  /** Requests served in the window, where the target meters them (serverless,
   *  MOTIR-9972); a target that does not leaves it out. */
  readonly invocations?: number;
}

export type ReleaseDestroyReason =
  | 'pull_request_closed'
  | 'retired'
  | 'reaped'
  | 'takeover'
  | 'operator';

export interface ReleaseSummary {
  readonly handle: ReleaseHandle;
  readonly state: ReleaseState;
}

export interface HostingDeployPort {
  readonly target: HostingDeployTarget;
  /** Create (or find) the isolation unit for one (repository, environment).
   *  Idempotent: an existing unit is success. */
  ensureApp(input: { repositoryId: string; environment: HostingEnvironment }): Promise<HostingApp>;
  /** A credential that may push to that one namespace and no other. */
  mintDeployCredential(input: { pushNamespace: string }): Promise<DeployCredential>;
  /** Run a release. Deploying the same (app, environment) again REPLACES the live
   *  release in place and keeps the one it replaced as the rollback target —
   *  never two live releases for one environment. */
  deploy(input: DeployReleaseInput): Promise<ReleaseHandle>;
  describe(handle: ReleaseHandle): Promise<ReleaseDescription>;
  /** Make the kept previous release live again; the release it replaces becomes
   *  the new previous one. Throws `NoPreviousReleaseError` when there is none. */
  rollback(input: { appRef: string; environment: HostingEnvironment }): Promise<ReleaseHandle>;
  /** Running seconds of the environment's release from `since` until now — for a
   *  release that lives for months and is rarely destroyed. */
  usageSince(handle: ReleaseHandle, since: Date): Promise<ReleaseUsage>;
  /** Destroy the environment's release. NON-OPTIONAL usage: there is no destroy
   *  that does not produce it. The usage covers the environment's whole life
   *  (`since` is its first start); a caller that already settled windows through
   *  `usageSince` charges only the part after them. An already-gone release is
   *  destroyed, with zero running seconds. */
  destroy(handle: ReleaseHandle, reason: ReleaseDestroyReason): Promise<ReleaseUsage>;
  /** Remove the whole isolation unit (a reaper's or a closed preview's step).
   *  Returns the usage of every release still live in it, so removing an app
   *  never loses running time; an already-gone app returns none. */
  destroyApp(input: { appRef: string }): Promise<ReleaseUsage[]>;
  /** The app's releases; an app that does not exist has none. */
  listReleases(input: { appRef: string }): Promise<ReleaseSummary[]>;
}
