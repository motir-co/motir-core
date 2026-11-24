import type { ReleaseLastExit, ReleaseRuntimeHealth } from '../../../../hosting/types';
import type { TenantEcsService, TenantEcsTask } from './ecsClient';

// THE CONTAINER SHAPE'S RUNTIME HEALTH (MOTIR-12104), read from ECS: the
// service's primary deployment, its desired count, and its tasks — running and
// stopped — with the stop facts ECS keeps on a stopped task for about an hour.
//
// What ECS writes on a stopped task (Amazon ECS API reference, `Task` and
// `Container`, and "Amazon ECS stopped task error messages", read 2026-11-23):
// `stopCode` `EssentialContainerExited` when the app's own container exited,
// `ServiceSchedulerInitiated` when ECS stopped it (a rollout replacing it, a
// scale-in, a failed health check); the container's `exitCode`; and, at the
// memory limit, the container reason `OutOfMemoryError: Container killed due to
// memory usage` (exit code 137).

/** The log group the task's `awslogs` driver writes, with stream prefix `app`
 *  (`aws-tenant-stacks/container-release.yaml`). */
export function containerLogGroup(appRef: string): string {
  return `/motir/hosting/${appRef}`;
}

const OOM = /OutOfMemoryError/;

/** Was the task killed at its memory limit? */
export function taskOomKilled(task: TenantEcsTask): boolean {
  return OOM.test(task.container?.reason ?? '') || OOM.test(task.stoppedReason ?? '');
}

/** Did the app itself stop the task — its essential container exited, or the
 *  kernel killed it at the memory limit — rather than ECS? */
export function taskCrashed(task: TenantEcsTask): boolean {
  return task.stopCode === 'EssentialContainerExited' || taskOomKilled(task);
}

const newestStopped = (tasks: readonly TenantEcsTask[]) =>
  tasks
    .filter((t) => t.lastStatus === 'STOPPED' && t.stoppedAt !== null)
    .reduce<TenantEcsTask | null>(
      (a, t) => (a === null || t.stoppedAt! > a.stoppedAt! ? t : a),
      null,
    );

export interface ContainerHealthFacts {
  /** Null when the stack holds no service yet. */
  readonly service: TenantEcsService | null;
  readonly tasks: readonly TenantEcsTask[];
  /** When the release stack was created, for a release with no service yet. */
  readonly stackCreatedAt: Date | null;
  readonly now: Date;
}

/**
 * A container release's runtime state, in order:
 *
 * 1. `deploying` — no service yet, or its primary rollout `IN_PROGRESS` —
 *    since the rollout (or the stack) began;
 * 2. `suspended` — desired count 0 (suspend-when-idle scaled it in) — since its
 *    last task stopped, else since the deployment last changed;
 * 3. `running` — a task of the current revision is running, since the first
 *    of them started; with `lastExit` from the newest task the APP stopped
 *    (an essential-container exit or a memory kill) since the deployment began;
 * 4. otherwise the newest stopped task of the current revision decides:
 *    `oom_killed` at a memory kill, else `exited` with the essential
 *    container's exit code — since it stopped;
 * 5. `deploying` — nothing has run yet (a task still starting).
 *
 * A task the rollout replaced belongs to an older revision and never decides.
 */
export function containerRuntimeHealth(facts: ContainerHealthFacts): ReleaseRuntimeHealth {
  const { service, now } = facts;
  if (!service) return { state: 'deploying', since: facts.stackCreatedAt ?? now };
  const primary = service.deployments.find((d) => d.status === 'PRIMARY') ?? null;
  const began = primary?.createdAt ?? primary?.updatedAt ?? facts.stackCreatedAt ?? now;
  if (primary?.rolloutState === 'IN_PROGRESS') return { state: 'deploying', since: began };

  if (service.desiredCount === 0) {
    const last = newestStopped(facts.tasks);
    return { state: 'suspended', since: last?.stoppedAt ?? primary?.updatedAt ?? began };
  }

  const current = facts.tasks.filter((t) => t.taskDefinition === service.taskDefinition);
  const running = current.filter((t) => t.lastStatus === 'RUNNING');
  if (running.length > 0) {
    const since = running.map((t) => t.startedAt ?? began).reduce((a, at) => (at < a ? at : a));
    const crash = newestStopped(
      facts.tasks.filter((t) => taskCrashed(t) && t.stoppedAt !== null && t.stoppedAt >= began),
    );
    const lastExit: ReleaseLastExit | null = crash
      ? {
          exitCode: crash.container?.exitCode ?? null,
          oomKilled: taskOomKilled(crash),
          at: crash.stoppedAt!,
        }
      : null;
    return lastExit ? { state: 'running', since, lastExit } : { state: 'running', since };
  }

  const stopped = newestStopped(current);
  if (stopped) {
    if (taskOomKilled(stopped)) return { state: 'oom_killed', since: stopped.stoppedAt! };
    return {
      state: 'exited',
      exitCode: stopped.container?.exitCode ?? null,
      since: stopped.stoppedAt!,
    };
  }
  return { state: 'deploying', since: began };
}
