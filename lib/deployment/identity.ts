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
 * file. It is still registered as the guard's `ALLOWED` entry, now naming the
 * Fargate variables the whole file reads — `deploymentIdentity()` and the three
 * host-tag accessors at the bottom (`hostInstanceId`, `hostRegion`,
 * `hostProcessGroup`) that feed the terminal relay and Sentry's instance tags.
 * Since MOTIR-10962 none of them reads a `FLY_*` variable.
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
 *   container by the infrastructure (MOTIR-10890);
 * - `ECS_CONTAINER_METADATA_URI_V4` — injected by Fargate (platform 1.4.0 and
 *   later) into every container. Its last path segment is the container's
 *   Docker id, which on Fargate is the TASK id (32 hex digits) followed by `-`
 *   and a 10-digit number — the same id that ends the task's ARN. The task id
 *   is read from that string, without calling the endpoint;
 * - `MONITORING_CLOUDWATCH_SERVICE` — the process's own name (`web`, `worker`,
 *   `relay`), which the infrastructure sets on each core task definition for the
 *   CloudWatch publishers' `Service` dimension (motir-infra
 *   `monitoring-environment.ts`, MOTIR-10273). The Sentry tag reuses it, so a
 *   metric and an error from the same process name it the same way.
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
   * This instance's own id — the task ANSWERING, not the fleet's size. Null
   * here: the Hosting card reads no per-task id (`hostInstanceId()` below is
   * the accessor that does, for the relay and Sentry's tags).
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
 * Is this process a Fargate task? The one gate the three host-tag accessors
 * share, read from the environment they are handed so a test can say it.
 */
function onFargate(env: Readonly<Record<string, string | undefined>>): boolean {
  return nonEmpty(env['AWS_EXECUTION_ENV']) === FARGATE_EXECUTION_ENV;
}

/**
 * A Fargate container's metadata URI ends in its Docker id: the task id (32 lower
 * hex digits), a dash and a 10-digit number. Anything else — another launch type's
 * URI, a value somebody typed — yields no id rather than a wrong one.
 */
const FARGATE_METADATA_URI_TASK_ID = /\/v4\/([0-9a-f]{32})-\d+\/?$/;

/**
 * THIS PROCESS'S OWN INSTANCE ID ON ITS HOST — on Fargate the task id — or
 * `undefined` when there is none to read. The terminal relay (MOTIR-6959,
 * `lib/agentTerminal/relay/machineId.ts`) keys its connection rows on it and falls
 * back to hostname + pid itself, and Sentry tags `instance.machine` with it
 * (`lib/monitoring/config.ts`), so the host's variables are named here, inside
 * this file's registered exception, and nowhere else in `lib/`.
 */
export function hostInstanceId(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (!onFargate(env)) return undefined;
  const uri = nonEmpty(env['ECS_CONTAINER_METADATA_URI_V4']);
  return uri?.match(FARGATE_METADATA_URI_TASK_ID)?.[1];
}

/**
 * THIS PROCESS'S REGION on its host, or `undefined` off Fargate or when the task
 * carries none. Read for the `instance.region` tag every Sentry event carries
 * (MOTIR-8549, `lib/monitoring/config.ts`), which must not name the host's
 * variables itself.
 */
export function hostRegion(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return onFargate(env) ? nonEmpty(env['AWS_REGION']) : undefined;
}

/**
 * THIS PROCESS'S NAME among core's services — `web`, `worker` or `relay` — or
 * `undefined` off Fargate or when the task definition sets none. Read for the
 * `instance.process_group` tag.
 */
export function hostProcessGroup(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return onFargate(env) ? nonEmpty(env['MONITORING_CLOUDWATCH_SERVICE']) : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
