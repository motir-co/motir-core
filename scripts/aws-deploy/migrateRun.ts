/**
 * Step 2 of the core deploy (MOTIR-9927): register the migrate task with the
 * digest's image, run it once in the deploy target, wait for it to stop and read
 * its container's exit code. Only exit 0 passes. On any failure the last lines
 * of its log are printed, so CI shows why without anyone opening CloudWatch.
 *
 * ⚠️ It prints exit codes, stop reasons and the migrate container's own log
 * lines, never the task definition: the database URL is built inside the
 * container (motir-infra's migrate command) and is never logged there.
 */
import type { TaskDefinition } from '@aws-sdk/client-ecs';
import type { DeployAws } from './ports';
import { cloneWithImage } from './taskDefinitions';

/** How often the script polls ECS while it waits. */
export const POLL_INTERVAL_MS = 15_000;
/** How many migrate log lines a failure prints. */
export const LOG_TAIL_LINES = 50;

/** The deploy-target parameter motir-infra's `CoreDeployStack` writes. */
export interface DeployTarget {
  cluster: string;
  subnets: string[];
  securityGroups: string[];
  migrateFamily: string;
  migrateContainer: string;
  region: string;
}

export interface DeployLog {
  (line: string): void;
}

export type MigrateResult =
  | { ok: true; taskArn: string; exitCode: 0 }
  | { ok: false; taskArn: string | null; exitCode: number | null; reason: string };

/** Register the migrate revision for `image` and return its ARN and definition. */
async function registerMigrate(aws: DeployAws, target: DeployTarget, image: string) {
  const latest = await aws.describeTaskDefinition(target.migrateFamily);
  const arn = await aws.registerTaskDefinition(
    cloneWithImage(latest, target.migrateContainer, image),
  );
  return { arn, definition: latest };
}

/** Wait for the task to stop; `null` when the deadline passes first. */
async function waitForStop(aws: DeployAws, cluster: string, taskArn: string, deadline: number) {
  for (;;) {
    const task = await aws.describeTask(cluster, taskArn);
    if (task?.lastStatus === 'STOPPED') return task;
    if (aws.now() >= deadline) return null;
    await aws.sleep(POLL_INTERVAL_MS);
  }
}

/** Print the last lines of the migrate container's log stream, if it has one. */
async function tailMigrateLog(
  aws: DeployAws,
  definition: TaskDefinition,
  container: string,
  taskArn: string,
  log: DeployLog,
): Promise<void> {
  const options = definition.containerDefinitions?.find((c) => c.name === container)
    ?.logConfiguration?.options;
  const group = options?.['awslogs-group'];
  const prefix = options?.['awslogs-stream-prefix'];
  if (!group || !prefix) {
    log('migrate: the task definition names no awslogs group, so there is no log to show');
    return;
  }
  const stream = `${prefix}/${container}/${taskArn.slice(taskArn.lastIndexOf('/') + 1)}`;
  try {
    const lines = await aws.tailLog(group, stream, LOG_TAIL_LINES);
    log(`migrate: last ${String(lines.length)} log lines of ${group} ${stream}:`);
    for (const line of lines) log(`  ${line}`);
  } catch (err) {
    log(`migrate: could not read ${group} ${stream}: ${err instanceof Error ? err.name : 'error'}`);
  }
}

/** Run the migrate task from `image` and report whether its container exited 0. */
export async function runMigrate(
  aws: DeployAws,
  target: DeployTarget,
  image: string,
  timeoutMs: number,
  log: DeployLog,
): Promise<MigrateResult> {
  const { arn, definition } = await registerMigrate(aws, target, image);
  log(`migrate: registered ${arn}`);
  const taskArn = await aws.runTask({
    cluster: target.cluster,
    taskDefinition: arn,
    launchType: 'FARGATE',
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: target.subnets,
        securityGroups: target.securityGroups,
        assignPublicIp: 'DISABLED',
      },
    },
  });
  log(`migrate: started ${taskArn}`);
  const result = await settle(aws, target, taskArn, aws.now() + timeoutMs);
  if (!result.ok) await tailMigrateLog(aws, definition, target.migrateContainer, taskArn, log);
  return result;
}

/** Wait for the task and turn how it stopped into a result. */
async function settle(
  aws: DeployAws,
  target: DeployTarget,
  taskArn: string,
  deadline: number,
): Promise<MigrateResult> {
  const task = await waitForStop(aws, target.cluster, taskArn, deadline);
  if (!task) {
    await aws.stopTask(target.cluster, taskArn, 'the core deploy timed out waiting for it');
    return { ok: false, taskArn, exitCode: null, reason: 'timed out; the task was stopped' };
  }
  const container = task.containers?.find((c) => c.name === target.migrateContainer);
  const exitCode = container?.exitCode;
  if (exitCode === 0) return { ok: true, taskArn, exitCode: 0 };
  if (exitCode === undefined) {
    const why = [task.stoppedReason, container?.reason].filter(Boolean).join('; ');
    return { ok: false, taskArn, exitCode: null, reason: `never ran: ${why || 'no reason given'}` };
  }
  return { ok: false, taskArn, exitCode, reason: `exited ${String(exitCode)}` };
}
