/**
 * THE DEPLOYMENT-STATUS PORT (MOTIR-7332, MOTIR-10952): is each of this
 * deployment's services running as many tasks as it should, and is each one
 * steady on its release?
 *
 * `identity.ts` answers where THIS PROCESS is, from what the platform injects
 * into it. This port answers a question no process can answer about itself: how
 * many of its siblings are up. That takes a call to the platform's API with a
 * credential, which `identity.ts` deliberately refuses to make (its header says
 * so, and the boundary guard enforces it). So the call lives behind this port,
 * in an adapter directory, and `lib/` above it sees only the neutral shape below.
 *
 * ⚠️ THE RELEASE IS PER GROUP, NOT FLEET-WIDE (MOTIR-10952). The port once
 * carried the distinct releases the whole deployment ran and called more than
 * one "mixed". That held for one app whose process groups pulled one image. A
 * fleet of separately deployed services has one release EACH, and those
 * releases cannot be compared across services (two task-definition families
 * never share a revision), so a fleet-wide list would read a healthy install as
 * mixed for ever. Each group therefore carries its own `release` and says
 * whether its own rollout is still in play (`rolling`).
 *
 * No provider type, service ARN or state string crosses this file. A second
 * hosting provider is one more adapter plus one branch in `providers.ts`.
 */

/** How long the read may take before the card says it could not answer. */
export const DEPLOYMENT_STATUS_TIMEOUT_MS = 3000;

/** One group the platform runs — on ECS, one service: how many of its tasks run, against how many should. */
export interface DeploymentGroupStatus {
  /** The group's name on the platform, e.g. the ECS service's name. */
  readonly name: string;
  /** Tasks (or machines) in the group that are running now. */
  readonly started: number;
  /** Tasks in the group that count toward it: running plus those still starting. */
  readonly total: number;
  /**
   * How many SHOULD be running: the platform's own desired count, which is the
   * operator's decision as the platform records it — never a second table here.
   */
  readonly expected: number;
  /** The release THIS group runs, or `null` when the platform names none. */
  readonly release: string | null;
  /**
   * Is this group mid-deploy — more than one deployment in play, or a rollout
   * that has not completed (in progress or failed)?
   */
  readonly rolling: boolean;
}

/** What the platform reports about the whole deployment. */
export interface DeploymentStatus {
  /** One entry per group the deployment runs, in the order the adapter was asked for them. */
  readonly groups: readonly DeploymentGroupStatus[];
}

/** The port. An implementation THROWS when it cannot read; it never reports an empty fleet instead. */
export interface DeploymentStatusProvider {
  /** Is the credential this provider reads with present? Never throws. */
  configured(): boolean;
  /** Read the deployment's status now. Throws on any failure. */
  read(): Promise<DeploymentStatus>;
}
