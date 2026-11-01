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
// deploy, the operator deploy check). A customer repository (D1) is never
// deployed: an adapter that can be asked to run one — the AWS adapter, which
// reads the repository's seed source — refuses it by name with
// `CustomerRepositoryRefusedError` (`./errors`), rather than trusting every
// caller to have filtered it out first.

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

/** Which of a repository's two push namespaces: its previews' (shared by every
 *  pull request) or its production's. */
export type PushNamespaceKind = 'preview' | 'production';

/** A push namespace `ensurePushNamespace` made, and the image repository a
 *  `docker push` into it names (`registry.fly.io/mh-<rid>-pv`, an ECR URI) —
 *  the value enablement writes for the repository's CI (MOTIR-5769 §11). */
export interface PushNamespace {
  readonly pushNamespace: string;
  readonly imageRepository: string;
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
  /**
   * What the release needs beyond answering HTTP (MOTIR-9974). Optional so a
   * target that runs anything (Fly) and older callers compile unchanged; the
   * serverless target REFUSES a release without it, because it cannot run one
   * it could not check. A parsed manifest always carries it.
   */
  readonly requires?: { readonly websockets: boolean; readonly backgroundWork: boolean };
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

/** Which AWS shape a release takes (MOTIR-5769 §4): a Lambda function for a
 *  small app, an ECS Fargate service for a long-running one. An INPUT, never a
 *  guess — the caller reads it from the repository's recorded hosting decision,
 *  and the AWS adapter refuses a release without one (`requireReleaseShape`). */
export type ReleaseShape = 'function' | 'container';

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
  /** The AWS shape. Required by the `aws` target; every other target ignores it. */
  readonly shape?: ReleaseShape;
}

/** A live (or once-live) release. `providerRef` is opaque above the adapter. */
export interface ReleaseHandle {
  readonly target: HostingDeployTarget;
  readonly appRef: string;
  readonly environment: HostingEnvironment;
  readonly releaseId: string;
  readonly providerRef: string;
}

/** `waiting_for_account`: the release is held until its organisation's AWS
 *  tenant account is ready; deploying the same input again once it is completes
 *  it, as the same release. */
export type ReleaseState =
  | 'waiting_for_account'
  | 'deploying'
  | 'healthy'
  | 'unhealthy'
  | 'stopped'
  | 'destroyed';

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

/** Compute a release consumed, in its provider's billing units: Lambda
 *  GB-seconds, or Fargate vCPU-seconds and GB-seconds (MOTIR-5769 §4). */
export type ReleaseComputeUsage =
  | { readonly unit: 'lambda'; readonly gbSeconds: number }
  | { readonly unit: 'fargate'; readonly vcpuSeconds: number; readonly gbSeconds: number };

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
  /** The same window in compute units. Set by the AWS shapes; absent on the
   *  targets that bill by running time alone. */
  readonly compute?: ReleaseComputeUsage;
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

/** A one-off run of a release image (MOTIR-10030): a production release's
 *  migration step, run against its database BEFORE the release takes traffic. */
export interface RunReleaseCommandInput {
  readonly appRef: string;
  readonly artifact: ReleaseArtifact;
  /** The command, split on whitespace into argv — no shell, as `startCommand`. */
  readonly command: string;
  readonly env: readonly ReleaseEnvVar[];
  /** How long the command may run before it is stopped and reported timed out. */
  readonly timeoutSeconds: number;
}

/** How a release command ended: its exit status ONLY — never its output, which
 *  can echo the environment it ran with. `exitCode` is null when it timed out. */
export interface ReleaseCommandResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export interface HostingDeployPort {
  readonly target: HostingDeployTarget;
  /** Create (or find) the isolation unit for one (repository, environment).
   *  Idempotent: an existing unit is success. */
  ensureApp(input: { repositoryId: string; environment: HostingEnvironment }): Promise<HostingApp>;
  /** Create (or find) ONE push namespace of a repository and nothing else — no
   *  release unit. What switching a repository's previews on needs before any
   *  pull request exists (MOTIR-5775). Idempotent. */
  ensurePushNamespace(input: {
    repositoryId: string;
    kind: PushNamespaceKind;
  }): Promise<PushNamespace>;
  /** A credential that may push to that one namespace and no other. */
  mintDeployCredential(input: { pushNamespace: string }): Promise<DeployCredential>;
  /** Revoke every static credential that may push to the namespace, so a
   *  repository leaving Motir keeps no way to push (MOTIR-5775). A federated
   *  credential is not revocable here — its trust binds the repository's
   *  immutable ids, which stop matching once it leaves — so a federated target
   *  revokes nothing. Idempotent: a second call, or a namespace that does not
   *  exist, revokes nothing. */
  revokeDeployCredentials(input: { pushNamespace: string }): Promise<{ revoked: number }>;
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
  /** Run one command of a release image to completion in the app, then remove
   *  what ran it. It never serves traffic and never touches the live release.
   *  A target that cannot throws `ReleaseCommandUnsupportedError`. */
  runReleaseCommand(input: RunReleaseCommandInput): Promise<ReleaseCommandResult>;
}
