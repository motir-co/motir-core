import 'server-only';

import { DescribeServicesCommand, ECSClient } from '@aws-sdk/client-ecs';
import {
  DEPLOYMENT_STATUS_TIMEOUT_MS,
  type DeploymentGroupStatus,
  type DeploymentStatus,
  type DeploymentStatusProvider,
} from '../../deploymentStatus';

// THE ONLY MODULE IN `motir-core` THAT ASKS ECS HOW MANY OF CORE'S OWN TASKS RUN
// (MOTIR-10952). The deployment-status port's ECS adapter, which replaced the Fly
// adapter that counted machines from the Machines API.
//
// ⚠️ IT SENDS ONE ACTION, AND IT IS A READ. `DescribeServicesCommand` and nothing
// else — no list call, no task or task-definition read and no write. That is the
// action motir-infra's `ServicesReadDescribe` statement already grants the web
// task role on this install's own core cluster (MOTIR-10890), so this card asks
// the infrastructure for no new permission. The console's stance is read and
// link, never remediate.
//
// ⚠️ IT DESCRIBES NAMED SERVICES; IT NEVER LISTS THE CLUSTER. The cluster
// `MOTIR_ECS_CLUSTER` names is shared: motir-ai, the gateway, run-edge and the
// code graph run in it beside core's web, worker and optional relay, and the
// Services page (`lib/awsServices/ecsServicesReader.ts`) lists all of them on
// purpose. The Hosting card is about core's own deployment, so it describes
// exactly the services `MOTIR_DEPLOYMENT_ECS_SERVICES` names — which the
// infrastructure derives from the helper that names the services — and a relay
// the install does not run is never asked about.
//
// ⚠️ NO CREDENTIALS AND NO REGION ARE PASSED. The client resolves both through
// the SDK's default chain, which on ECS is the web task's role (served by the
// container credentials endpoint) and the `AWS_REGION` ECS sets — the same
// stance as `ecsServicesReader.ts`. Off AWS the chain finds nothing and the read
// throws, which the card renders as its `readFailed` arm, never as a zero.

/** The ECS cluster core's services run in — the variable MOTIR-10890 put on the web container. */
export const ECS_CLUSTER_ENV = 'MOTIR_ECS_CLUSTER';

/** Core's own services in that cluster, comma-separated (MOTIR-10948). */
export const ECS_SERVICES_ENV = 'MOTIR_DEPLOYMENT_ECS_SERVICES';

/** DescribeServices takes at most ten services per call. */
const DESCRIBE_BATCH = 10;

/** The fields of one ECS deployment this adapter reads. */
export interface EcsDeploymentRow {
  readonly status?: string;
  readonly rolloutState?: string;
  readonly taskDefinition?: string;
  readonly createdAt?: Date;
}

/** The fields of one described ECS service this adapter reads. */
export interface EcsServiceRow {
  readonly serviceName?: string;
  /** `ACTIVE`, or `DRAINING` / `INACTIVE` for a deleted service ECS still describes. */
  readonly status?: string;
  readonly runningCount?: number;
  readonly pendingCount?: number;
  readonly desiredCount?: number;
  readonly deployments?: readonly EcsDeploymentRow[];
}

/** One `failures` entry of the answer. */
export interface EcsFailureRow {
  readonly arn?: string;
  readonly reason?: string;
}

/** What one describe call answered. */
export interface EcsDescribeAnswer {
  readonly services?: readonly EcsServiceRow[];
  readonly failures?: readonly EcsFailureRow[];
}

/** The seam: describe at most ten named services in one cluster. */
export type DescribeServices = (input: {
  cluster: string;
  services: string[];
  abortSignal: AbortSignal;
}) => Promise<EcsDescribeAnswer>;

interface EcsDeploymentConfig {
  readonly cluster: string;
  readonly services: readonly string[];
}

/**
 * The config, read at CALL time so a deployment without it boots and simply
 * cannot read. There is NO default cluster (unlike `servicesCluster()`): a card
 * naming a cluster nobody configured would report a reading nobody took.
 */
export function ecsDeploymentConfig(): EcsDeploymentConfig | null {
  const cluster = process.env[ECS_CLUSTER_ENV]?.trim();
  const services = (process.env[ECS_SERVICES_ENV] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (!cluster || services.length === 0) return null;
  return { cluster, services: [...new Set(services)] };
}

/** `family:revision` from a task-definition ARN, or the value itself when it is not one. */
function releaseOf(taskDefinition: string | undefined): string | null {
  if (!taskDefinition) return null;
  const slash = taskDefinition.lastIndexOf('/');
  return slash === -1 ? taskDefinition : taskDefinition.slice(slash + 1);
}

/** The PRIMARY deployment, or the newest when none is marked primary. */
function primaryOf(deployments: readonly EcsDeploymentRow[]): EcsDeploymentRow | undefined {
  const primary = deployments.find((d) => d.status === 'PRIMARY');
  if (primary) return primary;
  return [...deployments].sort(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
  )[0];
}

/** One service's reading in the port's neutral shape. */
function groupOf(name: string, row: EcsServiceRow): DeploymentGroupStatus {
  const deployments = row.deployments ?? [];
  const primary = primaryOf(deployments);
  const rollout = primary?.rolloutState;
  const started = row.runningCount ?? 0;
  return {
    name,
    started,
    total: started + (row.pendingCount ?? 0),
    expected: row.desiredCount ?? 0,
    release: releaseOf(primary?.taskDefinition),
    rolling: deployments.length > 1 || rollout === 'IN_PROGRESS' || rollout === 'FAILED',
  };
}

/**
 * Fold the described services into the port's shape: exactly one group per
 * REQUESTED service, in the requested order.
 *
 * ⚠️ A REQUESTED SERVICE THE ANSWER LEFT OUT THROWS — and so does one named in
 * `failures`. Counted as zero, it would read as a healthy service with nothing
 * to run, and the port's contract is that an implementation throws rather than
 * reporting an empty fleet. A service that genuinely reports zero desired and
 * zero running is still returned: that is a reading, and the operator's answer.
 *
 * ⚠️ SO DOES ONE WHOSE OWN STATUS IS NOT `ACTIVE`. A deleted service stays in
 * DescribeServices' `services` (not `failures`) as `DRAINING`, then `INACTIVE`,
 * with its desired count set to zero, until ECS purges it. Folded, it would read
 * as a steady 0/0 — the same silent zero as a missing service, with a status
 * field attached. Only an `ACTIVE` service is a reading.
 */
export function foldServices(
  rows: readonly EcsServiceRow[],
  requested: readonly string[],
  failures: readonly EcsFailureRow[] = [],
): DeploymentStatus {
  const failed = failures.map((f) => `${f.arn ?? '(unnamed)'} (${f.reason ?? 'no reason'})`);
  if (failed.length > 0) {
    throw new Error(`deployment status: ECS could not describe ${failed.join(', ')}`);
  }
  const byName = new Map<string, EcsServiceRow>();
  for (const row of rows) {
    if (row.serviceName) byName.set(row.serviceName, row);
  }
  const groups = requested.map((name) => {
    const row = byName.get(name);
    if (!row) throw new Error(`deployment status: ECS returned no service named ${name}`);
    if (row.status !== 'ACTIVE') {
      throw new Error(
        `deployment status: ECS service ${name} is ${row.status ?? 'of unknown status'}`,
      );
    }
    return groupOf(name, row);
  });
  return { groups };
}

/** The adapter over an injected describe — what its own test drives. */
export function createEcsDeploymentStatusProvider(
  describeServices: DescribeServices,
): DeploymentStatusProvider {
  return {
    configured: () => ecsDeploymentConfig() !== null,
    async read() {
      const config = ecsDeploymentConfig();
      if (!config) {
        throw new Error(`deployment status: ${ECS_CLUSTER_ENV} or ${ECS_SERVICES_ENV} unset`);
      }
      const abortSignal = AbortSignal.timeout(DEPLOYMENT_STATUS_TIMEOUT_MS);
      const rows: EcsServiceRow[] = [];
      const failures: EcsFailureRow[] = [];
      for (let i = 0; i < config.services.length; i += DESCRIBE_BATCH) {
        const answer = await describeServices({
          cluster: config.cluster,
          services: config.services.slice(i, i + DESCRIBE_BATCH),
          abortSignal,
        });
        rows.push(...(answer.services ?? []));
        failures.push(...(answer.failures ?? []));
      }
      return foldServices(rows, config.services, failures);
    },
  };
}

let client: ECSClient | null = null;

/** The real describe: one `DescribeServicesCommand`, bounded by the caller's abort signal. */
const describeOverSdk: DescribeServices = async ({ cluster, services, abortSignal }) => {
  client ??= new ECSClient({});
  return client.send(new DescribeServicesCommand({ cluster, services }), { abortSignal });
};

/** The ECS binding of the deployment-status port. */
export const ecsDeploymentStatusProvider: DeploymentStatusProvider =
  createEcsDeploymentStatusProvider(describeOverSdk);
