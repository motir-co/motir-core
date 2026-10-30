/**
 * Steps 2, 4 and 5 of the core deploy (MOTIR-9927): find the cluster's services
 * that run the core image, roll each onto a revision with only the image changed,
 * wait for every PRIMARY deployment to complete, and on a failure or a timeout
 * put every rolled service back on the revision it ran before.
 *
 * The services keep 100% minimum healthy and 200% maximum with the circuit
 * breaker on (motir-infra's `FargateService`), so the old tasks serve until the
 * new ones pass the load balancer's health check, and keep serving on a rollback.
 */
import type { TaskDefinition } from '@aws-sdk/client-ecs';
import type { DeployAws } from './ports';
import { POLL_INTERVAL_MS, type DeployLog } from './migrateRun';
import { breachContainers, cloneWithImage, containersIn } from './taskDefinitions';

/** A core service and the revision it ran before this deploy. */
export interface CoreService {
  name: string;
  previousTaskDefinition: string;
  containers: string[];
}

export type RolloutState = 'COMPLETED' | 'FAILED' | 'IN_PROGRESS' | 'TIMED_OUT';

export interface RolledService {
  name: string;
  taskDefinition: string;
  rolloutState: RolloutState;
}

/**
 * The cluster's services with a container in `repository`. The cluster is
 * shared with services that run other images, which this leaves alone.
 *
 * Throws when a core service runs a breach revision (MOTIR-10093): the roll
 * clones the revision each service runs, so it would make the breach the
 * service's next release, run in a loop instead of the real service.
 */
export async function findCoreServices(
  aws: DeployAws,
  cluster: string,
  repository: string,
): Promise<CoreService[]> {
  const arns = await aws.listServices(cluster);
  if (arns.length === 0) return [];
  const services = await aws.describeServices(cluster, arns);
  const found: CoreService[] = [];
  for (const service of services) {
    if (!service.serviceName || !service.taskDefinition) continue;
    const definition = await aws.describeTaskDefinition(service.taskDefinition);
    const containers = containersIn(definition, repository);
    if (containers.length === 0) continue;
    refuseBreachRevision(service.serviceName, definition);
    found.push({
      name: service.serviceName,
      previousTaskDefinition: service.taskDefinition,
      containers,
    });
  }
  return found;
}

/** Throws when `definition`, which `service` runs, sets the breach guard. */
function refuseBreachRevision(service: string, definition: TaskDefinition): void {
  const containers = breachContainers(definition);
  if (containers.length === 0) return;
  throw new Error(
    `the service ${service} runs ${String(definition.family)}:${String(definition.revision)}, ` +
      `whose ${containers.join(', ')} container sets MOTIR_BREACH_ENABLED: a breach run holds ` +
      'it. Nothing was migrated, registered or rolled; point the service back at its own ' +
      'revision once the breach ends, then deploy again',
  );
}

/** Register `service`'s next revision with `image` on its core containers. */
async function registerWithImage(aws: DeployAws, service: CoreService, image: string) {
  const definition = await aws.describeTaskDefinition(service.previousTaskDefinition);
  const [first, ...rest] = service.containers as [string, ...string[]];
  const input = cloneWithImage(definition, first, image);
  for (const name of rest) {
    const container = input.containerDefinitions?.find((c) => c.name === name);
    if (container) container.image = image;
  }
  return aws.registerTaskDefinition(input);
}

/** Each service's rollout, read from its PRIMARY deployment. */
async function rolloutStates(
  aws: DeployAws,
  cluster: string,
  rolled: RolledService[],
): Promise<RolledService[]> {
  const described = await aws.describeServices(
    cluster,
    rolled.map((r) => r.name),
  );
  return rolled.map((r) => {
    const service = described.find((s) => s.serviceName === r.name);
    const primary = service?.deployments?.find((d) => d.status === 'PRIMARY');
    // A circuit-breaker rollback makes a deployment of the OLD revision primary,
    // which then completes: that is this deploy failing, not succeeding.
    if (!primary || primary.taskDefinition !== r.taskDefinition) {
      return { ...r, rolloutState: 'FAILED' };
    }
    const state = primary.rolloutState;
    return {
      ...r,
      rolloutState: state === 'COMPLETED' || state === 'FAILED' ? state : 'IN_PROGRESS',
    };
  });
}

/** Wait until every service completes, any fails, or the deadline passes. */
async function waitForRollout(
  aws: DeployAws,
  cluster: string,
  rolled: RolledService[],
  deadline: number,
  log: DeployLog,
): Promise<RolledService[]> {
  for (;;) {
    const states = await rolloutStates(aws, cluster, rolled);
    log(`roll: ${states.map((s) => `${s.name} ${s.rolloutState}`).join(', ')}`);
    if (states.some((s) => s.rolloutState === 'FAILED')) return states;
    if (states.every((s) => s.rolloutState === 'COMPLETED')) return states;
    if (aws.now() >= deadline) {
      return states.map((s) =>
        s.rolloutState === 'COMPLETED' ? s : { ...s, rolloutState: 'TIMED_OUT' },
      );
    }
    await aws.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Roll every service onto `image` together and wait. Resolves to each service's
 * outcome; `ok` only when every one is COMPLETED.
 */
export async function rollServices(
  aws: DeployAws,
  cluster: string,
  services: CoreService[],
  image: string,
  timeoutMs: number,
  log: DeployLog,
): Promise<{ ok: boolean; services: RolledService[] }> {
  const rolled: RolledService[] = [];
  for (const service of services) {
    const taskDefinition = await registerWithImage(aws, service, image);
    rolled.push({ name: service.name, taskDefinition, rolloutState: 'IN_PROGRESS' });
  }
  for (const r of rolled) {
    await aws.updateService(cluster, r.name, r.taskDefinition);
    log(`roll: ${r.name} -> ${r.taskDefinition}`);
  }
  const states = await waitForRollout(aws, cluster, rolled, aws.now() + timeoutMs, log);
  return { ok: states.every((s) => s.rolloutState === 'COMPLETED'), services: states };
}

/**
 * Put every service back on the revision it ran before, skipping one already
 * there (the circuit breaker rolled it back itself).
 */
export async function rollBack(
  aws: DeployAws,
  cluster: string,
  services: CoreService[],
  log: DeployLog,
): Promise<void> {
  const described = await aws.describeServices(
    cluster,
    services.map((s) => s.name),
  );
  for (const service of services) {
    const current = described.find((s) => s.serviceName === service.name)?.taskDefinition;
    if (current === service.previousTaskDefinition) {
      log(`rollback: ${service.name} already runs ${service.previousTaskDefinition}`);
      continue;
    }
    await aws.updateService(cluster, service.name, service.previousTaskDefinition);
    log(`rollback: ${service.name} -> ${service.previousTaskDefinition}`);
  }
}
