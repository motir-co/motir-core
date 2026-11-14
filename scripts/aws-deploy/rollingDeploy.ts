/**
 * Steps 2, 4 and 5 of the core deploy (MOTIR-9927): find the cluster's services
 * that run the core image, roll each onto a revision with only the image changed,
 * wait for every PRIMARY deployment to complete, and on a failure or a timeout
 * put every rolled service back on the revision it ran before.
 *
 * A service another deployer moves while the roll waits (a motir-infra deploy's
 * CloudFormation update, MOTIR-10117) is SUPERSEDED: the deploy fails, and the
 * rollback leaves that service on the revision the other deployer put there.
 *
 * Each service's next revision is cloned from the newest revision motir-infra's
 * CloudFormation registered (`infraBaseline.ts`, MOTIR-11235), not from the one
 * the service runs: an infra update the deploy overlapped is then kept by
 * construction, and the image is the only field the deploy owns. Each service is
 * read again right before its register (it may have moved since
 * `findCoreServices` read it, before the migrate), then registered and updated
 * in turn; a revision another deployer registers in the family between the read
 * and the register makes the roll read again.
 *
 * The services keep 100% minimum healthy and 200% maximum with the circuit
 * breaker on (motir-infra's `FargateService`), so the old tasks serve until the
 * new ones pass the load balancer's health check, and keep serving on a rollback.
 */
import type { TaskDefinition } from '@aws-sdk/client-ecs';
import type { DeployAws } from './ports';
import { POLL_INTERVAL_MS, type DeployLog } from './migrateRun';
import { infraBaseline, revisionName } from './infraBaseline';
import { breachContainers, cloneWithImage, containersIn } from './taskDefinitions';

/** A core service and the revision it ran before this deploy. */
export interface CoreService {
  name: string;
  previousTaskDefinition: string;
  containers: string[];
}

export type RolloutState = 'COMPLETED' | 'FAILED' | 'IN_PROGRESS' | 'SUPERSEDED' | 'TIMED_OUT';

export interface RolledService {
  name: string;
  taskDefinition: string;
  /**
   * The revision the service ran right before this deploy updated it: its
   * `previousTaskDefinition`, or the one another deployer moved it to before
   * the roll (MOTIR-11235). A rollback returns to it.
   */
  base: string;
  /** The revision `taskDefinition` copies, with only the image changed (MOTIR-11235). */
  clonedFrom: string;
  rolloutState: RolloutState;
}

/**
 * What the roll did to one service: the revision it ran right before its update
 * (`base`), the one the new revision copies (`clonedFrom`) and the one it was
 * pointed at (`rolledTo`). A rollback puts the service back on `base`, never on
 * a revision older than it.
 */
export interface RollRecord {
  base: string;
  /** The revision `rolledTo` copies: the newest CloudFormation one, else `base`. */
  clonedFrom: string;
  rolledTo: string;
}

/** How many times one service is read again when its family moves under the register. */
export const REBASE_ATTEMPTS = 3;

/**
 * The cluster's services with a container in `repository`. The cluster is
 * shared with services that run other images, which this leaves alone.
 *
 * Throws when a core service runs a breach revision (MOTIR-10093): a breach run
 * holds that service, and the deploy changes nothing under it. `rollServices`
 * asks again right before each register, since the migrate runs in between.
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
    refuseBreachRevision(
      service.serviceName,
      definition,
      'Nothing was migrated, registered or rolled',
    );
    found.push({
      name: service.serviceName,
      previousTaskDefinition: service.taskDefinition,
      containers,
    });
  }
  return found;
}

/**
 * Throws when `definition`, which `service` runs, sets the breach guard. `done`
 * says what the deploy has changed by then: nothing before the migrate, the
 * migrate (and any service before this one) at the roll.
 */
function refuseBreachRevision(service: string, definition: TaskDefinition, done: string): void {
  const containers = breachContainers(definition);
  if (containers.length === 0) return;
  throw new Error(
    `the service ${service} runs ${revisionName(definition)}, ` +
      `whose ${containers.join(', ')} container sets MOTIR_BREACH_ENABLED: a breach run holds ` +
      `it. ${done}; point the service back at its own revision once the breach ends, then ` +
      'deploy again',
  );
}

/**
 * The input that registers `definition` again with `image` on every one of
 * `containers`, every other field copied.
 */
function withImage(definition: TaskDefinition, containers: string[], image: string) {
  const [first, ...rest] = containers as [string, ...string[]];
  const input = cloneWithImage(definition, first, image);
  for (const name of rest) {
    const container = input.containerDefinitions?.find((c) => c.name === name);
    if (container) container.image = image;
  }
  return input;
}

/** The revision `service` runs now, read again from the cluster. */
async function liveRevision(aws: DeployAws, cluster: string, name: string): Promise<string> {
  const [described] = await aws.describeServices(cluster, [name]);
  const live = described?.taskDefinition;
  if (!live) throw new Error(`cluster ${cluster} no longer has the service ${name}`);
  return live;
}

/** A revision ARN's number: the part after the last `:`. */
function revisionOf(arn: string): number {
  return Number(arn.slice(arn.lastIndexOf(':') + 1));
}

/**
 * The revision `service`'s next one is cloned from: the newest one
 * CloudFormation registered (`infraBaseline`), else — with the reason logged —
 * the one the service runs now.
 */
async function cloneSource(
  aws: DeployAws,
  service: CoreService,
  live: TaskDefinition,
  newest: TaskDefinition,
  log: DeployLog,
): Promise<TaskDefinition> {
  const baseline = await infraBaseline(aws, newest, log);
  if (baseline) return baseline;
  log(`roll: ${service.name} is cloned from the revision it runs, ${revisionName(live)}`);
  return live;
}

/** The log line for a service whose clone source is not the revision step 2 read. */
function sourceNote(service: CoreService, record: RollRecord): string | null {
  const parts: string[] = [];
  if (record.base !== service.previousTaskDefinition) {
    parts.push(
      `${service.name} moved from ${service.previousTaskDefinition} to ${record.base} ` +
        'after the deploy read it',
    );
  }
  if (record.clonedFrom !== record.base) {
    parts.push(`${service.name} runs ${record.base}`);
  }
  if (parts.length === 0) return null;
  return `roll: ${parts.join('; ')}; ${record.rolledTo} is cloned from ${record.clonedFrom}`;
}

/**
 * Register `service`'s next revision with `image` (MOTIR-11235), right before
 * its update. The service is read again here, not trusted from
 * `findCoreServices`, which ran before the migrate: a revision that sets the
 * breach guard stops the roll, and the revision it runs NOW is the one a
 * rollback returns to. The clone is taken from the newest revision
 * CloudFormation registered, so a motir-infra update the deploy overlapped is
 * kept, never overwritten.
 *
 * The family's newest revision is read first: when the revision registered here
 * is not the one right after it, another deployer registered in between and is
 * about to move the service, so the roll waits one poll and reads again rather
 * than racing it.
 */
async function registerFromLive(
  aws: DeployAws,
  cluster: string,
  service: CoreService,
  image: string,
  log: DeployLog,
): Promise<RollRecord> {
  for (let attempt = 1; ; attempt++) {
    const base = await liveRevision(aws, cluster, service.name);
    const live = await aws.describeTaskDefinition(base);
    refuseBreachRevision(service.name, live, `It was not rolled, nor any service after it`);
    const family = String(live.family);
    const newest = await aws.describeTaskDefinition(family);
    const source = await cloneSource(aws, service, live, newest, log);
    const rolledTo = await aws.registerTaskDefinition(withImage(source, service.containers, image));
    if (revisionOf(rolledTo) === Number(newest.revision) + 1) {
      const record = { base, clonedFrom: String(source.taskDefinitionArn), rolledTo };
      const note = sourceNote(service, record);
      if (note) log(note);
      return record;
    }
    if (attempt >= REBASE_ATTEMPTS) {
      throw new Error(
        `another deployer kept registering ${family} revisions while this deploy registered ` +
          `${service.name}'s (${String(REBASE_ATTEMPTS)} attempts, last ${rolledTo}); ` +
          'nothing more was rolled. Deploy again once the other deploy has finished',
      );
    }
    log(
      `roll: another deployer registered a ${family} revision after ${revisionName(newest)}, ` +
        `beside this deploy's ${rolledTo}; reading ${service.name} again`,
    );
    await aws.sleep(POLL_INTERVAL_MS);
  }
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
    if (!primary || primary.taskDefinition === r.base) {
      return { ...r, rolloutState: 'FAILED' };
    }
    // Any other revision was put there by someone else after this deploy's update.
    if (primary.taskDefinition !== r.taskDefinition) {
      return { ...r, rolloutState: 'SUPERSEDED' };
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
    if (states.some((s) => s.rolloutState === 'FAILED' || s.rolloutState === 'SUPERSEDED')) {
      return states;
    }
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
 * Roll every service onto `image` and wait for them together. Each service is
 * read, registered and updated in turn (MOTIR-11235), so the revision cloned is
 * the one it runs at its update. Resolves to each service's outcome; `ok` only
 * when every one is COMPLETED. Each update is recorded in `updated` (service
 * name → the revision it cloned and the one it was pointed at) as it is issued,
 * so a caller can roll back exactly what this deploy changed even when it throws.
 */
export async function rollServices(
  aws: DeployAws,
  cluster: string,
  services: CoreService[],
  image: string,
  timeoutMs: number,
  log: DeployLog,
  updated: Map<string, RollRecord> = new Map(),
): Promise<{ ok: boolean; services: RolledService[] }> {
  const rolled: RolledService[] = [];
  for (const service of services) {
    const record = await registerFromLive(aws, cluster, service, image, log);
    await aws.updateService(cluster, service.name, record.rolledTo);
    updated.set(service.name, record);
    rolled.push({
      name: service.name,
      taskDefinition: record.rolledTo,
      base: record.base,
      clonedFrom: record.clonedFrom,
      rolloutState: 'IN_PROGRESS',
    });
    log(`roll: ${service.name} -> ${record.rolledTo}`);
  }
  const deadline = aws.now() + timeoutMs;
  const states = await waitForRollout(aws, cluster, rolled, deadline, log);
  return { ok: states.every((s) => s.rolloutState === 'COMPLETED'), services: states };
}

/**
 * Put every service this deploy moved back on the revision it cloned — the one
 * it ran before, or the one another deployer moved it to before the roll
 * (MOTIR-11235). Only a service still on the revision `updated` names is moved: one already back (the
 * circuit breaker rolled it back itself) is skipped, and one on any other
 * revision was moved by another deployer after this deploy (SUPERSEDED,
 * MOTIR-10117) and is left there, since forcing the old revision back would
 * undo that deployer's change.
 */
export async function rollBack(
  aws: DeployAws,
  cluster: string,
  services: CoreService[],
  updated: ReadonlyMap<string, RollRecord>,
  log: DeployLog,
): Promise<void> {
  const described = await aws.describeServices(
    cluster,
    services.map((s) => s.name),
  );
  for (const service of services) {
    const current = described.find((s) => s.serviceName === service.name)?.taskDefinition;
    const record = updated.get(service.name);
    const base = record?.base ?? service.previousTaskDefinition;
    if (current === base) {
      log(`rollback: ${service.name} already runs ${base}`);
      continue;
    }
    const rolledTo = record?.rolledTo;
    if (!rolledTo || current !== rolledTo) {
      log(
        `rollback: ${service.name} left on ${String(current)}, which another deployer put ` +
          `there after this deploy${rolledTo ? ` rolled it to ${rolledTo}` : ''}`,
      );
      continue;
    }
    await aws.updateService(cluster, service.name, base);
    log(`rollback: ${service.name} -> ${base}`);
  }
}
