/**
 * WHERE IS THIS PROCESS RUNNING? — the one place motir-core asks that question
 * (MOTIR-1167), answered since MOTIR-10952 from AWS Fargate's own injection.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ WHY THIS FILE EXISTS AT ALL, AND WHY IT IS ONE FILE
 * ---------------------------------------------------------------------------
 * `tests/ciFleet/orchestratorPortBoundary.test.ts` enforces
 * `docs/decisions/ci-runner-fleet.md` §4 rule 1 — *no `fly` types, imports or
 * ids above the adapter directory* — by scanning the SOURCE of all of `lib/`,
 * `app/` and `components/`, because half the ways a provider leaks (a hardcoded
 * API host, an env var, a status string) are not imports and a module-graph
 * check would miss them.
 *
 * The operator console's health glance needs the app's own hosting identity:
 * which deployment answered, where, and a link out to the platform's console.
 * So the knowledge has to live SOMEWHERE, and the choice is between one named
 * file and raw `process.env` reads scattered through a service. This is that
 * file. It is still registered as the guard's `ALLOWED` entry for the three
 * host-tag accessors at the bottom (`hostInstanceId`, `hostRegion`,
 * `hostProcessGroup`), which read Fly's variables for the terminal relay and
 * Sentry's instance tags. Those are not this card's to move: giving them an AWS
 * source is a separate gap, and `deploymentIdentity()` itself reads no `FLY_*`
 * variable any more.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ IT IS NOT PART OF THE FLEET'S PORT, AND SAYING SO MATTERS
 * ---------------------------------------------------------------------------
 * The guard's SUBJECT is the CI-runner orchestrator PORT — that a second
 * container provider is "a new file under `adapters/` plus one branch in the
 * selector". This file is not part of that port: it boots no container, tears
 * none down, meters nothing, and imports nothing from `lib/orchestrator/`. It
 * asks where the WEB PROCESS is, which the fleet has no opinion about. When a
 * further deployment target lands, the fix is one more branch HERE, which is a
 * small change precisely because this is the only place.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ WHAT IT DELIBERATELY DOES NOT ANSWER: HOW MANY TASKS
 * ---------------------------------------------------------------------------
 * Counting this deployment's siblings needs a credential and an API call, which
 * is the deployment-status port's job (`deploymentStatus.ts`, its ECS adapter
 * under `adapters/ecs/`). This file makes no call — not even to the task
 * metadata endpoint, which would answer richer questions but would put a network
 * seam inside an accessor that has never had one. Everything below is read from
 * what the PLATFORM injects into the running process, which is a reading taken
 * from inside, and from the one variable the infrastructure sets beside it:
 *
 * - `AWS_EXECUTION_ENV` = `AWS_ECS_FARGATE` — AWS's own injection, which says
 *   this process is a Fargate task;
 * - `AWS_REGION` — set by ECS on a Fargate task's containers;
 * - `MOTIR_ECS_CLUSTER` — the ECS cluster core's services run in, put on the web
 *   container by the infrastructure (MOTIR-10890).
 */

/** The value AWS injects into `AWS_EXECUTION_ENV` on a Fargate task. */
const FARGATE_EXECUTION_ENV = 'AWS_ECS_FARGATE';

/** Which host is serving this process, in provider-neutral terms. */
export interface DeploymentIdentity {
  /**
   * The platform, or `null` when this build is not running on a managed host —
   * a local `next start`, a self-hosted container, a CI runner. `null` is an
   * ordinary answer and not a failure: motir-core is GPL-3.0 and anyone may run
   * it somewhere this file has never heard of.
   */
  provider: 'fargate' | null;
  /**
   * The deployment's name on that platform: on Fargate, the ECS cluster core's
   * services run in — the grouping that holds web, worker and relay.
   */
  app: string | null;
  /** The region this particular instance is in. */
  region: string | null;
  /**
   * This instance's own id — the task ANSWERING, not the fleet's size. Null on
   * Fargate, which puts no per-task id in the container's environment.
   */
  instanceId: string | null;
  /**
   * Where an operator goes to see the deployment itself, or `null` when there is
   * no such place. Constructed from what the process reads rather than
   * configured, so it cannot drift from the deployment actually running.
   */
  dashboardUrl: string | null;
}

/** Not deployed anywhere this build can name. */
const UNMANAGED: DeploymentIdentity = {
  provider: null,
  app: null,
  region: null,
  instanceId: null,
  dashboardUrl: null,
};

/**
 * Resolve the running deployment's identity.
 *
 * Keyed on `AWS_EXECUTION_ENV`, because that is AWS's own statement that this
 * process is a Fargate task. Cluster and region are reported when present and
 * left null when not, rather than defaulted to a placeholder that would read as
 * a measurement.
 */
export function deploymentIdentity(): DeploymentIdentity {
  if (nonEmpty(process.env['AWS_EXECUTION_ENV']) !== FARGATE_EXECUTION_ENV) return UNMANAGED;

  const region = nonEmpty(process.env['AWS_REGION']) ?? null;
  return {
    provider: 'fargate',
    app: nonEmpty(process.env['MOTIR_ECS_CLUSTER']) ?? null,
    region,
    instanceId: null,
    dashboardUrl: region ? ecsClustersConsoleUrl(region) : null,
  };
}

/**
 * The ECS console's clusters page for a region.
 *
 * A list, not a deep link to the cluster or a service: an operator opening the
 * card mid-incident needs to land somewhere that exists, and the clusters page
 * for the region always resolves (the same judgement `platformHealthService`
 * records for the database console). The region is in the HOST, as AWS's own
 * regional console URLs carry it.
 */
function ecsClustersConsoleUrl(region: string): string {
  const r = encodeURIComponent(region);
  return `https://${r}.console.aws.amazon.com/ecs/v2/clusters?region=${r}`;
}

/**
 * THIS PROCESS'S OWN INSTANCE ID ON ITS HOST, or `undefined` when the host injects
 * none. Unlike `deploymentIdentity()` it does not require the app name: the
 * terminal relay (MOTIR-6959, `lib/agentTerminal/relay/machineId.ts`) keys its
 * connection rows on it and falls back to hostname + pid itself, so the provider's
 * variable is named here, inside this file's registered exception, and nowhere
 * else in `lib/`.
 */
export function hostInstanceId(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return nonEmpty(env['FLY_MACHINE_ID']);
}

/**
 * THIS PROCESS'S REGION and PROCESS GROUP on its host, or `undefined` when the
 * host injects none. Read for the `instance.*` tags every Sentry event carries
 * (MOTIR-8549, `lib/monitoring/config.ts`), which must not name the provider's
 * variables themselves.
 */
export function hostRegion(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return nonEmpty(env['FLY_REGION']);
}

export function hostProcessGroup(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return nonEmpty(env['FLY_PROCESS_GROUP']);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
