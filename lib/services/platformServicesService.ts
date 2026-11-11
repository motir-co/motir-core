import 'server-only';

import {
  createEcsServicesReader,
  FARGATE_ON_DEMAND_VCPU_QUOTA,
  type EcsDeploymentRead,
  type EcsServiceRead,
  type EcsServicesReader,
  type EcsTaskSizeRead,
} from '@/lib/awsServices/ecsServicesReader';
import { HEADROOM_ALERT_FRACTION } from '@/lib/ciFleet/shardTargets';
import type {
  PlatformServiceRowDTO,
  PlatformServicesClusterDTO,
  PlatformServicesDTO,
  PlatformServicesQuotaDTO,
  PlatformServicesShareDTO,
} from '@/lib/dto/platformServices';
import { requirePlatformStaff } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { platformAwsReadRepository } from '@/lib/repositories/platformAwsReadRepository';

/**
 * THE SERVICES PAGE'S READ (MOTIR-10890, design MOTIR-10889) — every ECS service
 * Motir itself runs in core's own AWS account, in cluster `motir-core`, its tasks
 * and their size, against the account's Fargate On-Demand vCPU quota. Superadmin
 * only. One read per page load; nothing is cached and nothing polls.
 *
 * ⚠️ AN UNREAD FIGURE IS NEVER A NUMBER. The two AWS reads are settled
 * INDEPENDENTLY: an ECS failure renders "ECS did not answer" with no row and no
 * total, a Service Quotas failure renders the quota "Not read" with no share, and
 * neither takes the other down. Neither ever falls back to 0, nor to an earlier
 * figure — `platform_aws_read` stores only WHEN each was last read.
 *
 * ⚠️ A TASK DEFINITION WITH NO SIZE FAILS THE CLUSTER READ. A Fargate task
 * definition always carries task-level `cpu` and `memory`; one that does not
 * would make the total a guess, and a guessed total against the quota is the
 * figure this page exists not to show.
 *
 * The AWS calls run BEFORE the audited transaction (`withPlatformRead` holds the
 * audit chain lock until it commits, so a remote call inside it would hold every
 * other staff action at the door). The transaction then writes the
 * `services.read` row, marks what answered, and reads the marks of what did not.
 */

/** The cluster the page reads: the services stack's own (motir-infra sets it). */
export function servicesCluster(): string {
  return process.env.MOTIR_ECS_CLUSTER?.trim() || 'motir-core';
}

const CLUSTER_SUBJECT = (cluster: string) => `ecs:${cluster}`;
const QUOTA_SUBJECT = `servicequotas:${FARGATE_ON_DEMAND_VCPU_QUOTA.serviceCode}/${FARGATE_ON_DEMAND_VCPU_QUOTA.quotaCode}`;

/** Two decimals: every Fargate size is a quarter vCPU, so this only trims float noise. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The account in an ARN (`arn:aws:ecs:<region>:<account>:…`), or null. */
export function accountOfArn(arn: string): string | null {
  const account = arn.split(':')[4];
  return account && /^\d{12}$/.test(account) ? account : null;
}

function sizeOf(
  service: EcsServiceRead,
  arn: string,
): EcsTaskSizeRead & { cpuUnits: number; memoryMib: number } {
  const size = service.taskDefinitions[arn];
  if (!size || size.cpuUnits === null || size.memoryMib === null) {
    throw new Error(`task definition of ${service.name} has no task-level size`);
  }
  return { ...size, cpuUnits: size.cpuUnits, memoryMib: size.memoryMib };
}

/**
 * One service, judged. Rolling = more than one deployment, or the PRIMARY's
 * rollout in progress; failed = a deployment whose rollout FAILED; short =
 * running < desired while not rolling; scaled to 0 = desired 0 and running 0.
 */
export function judgeService(service: EcsServiceRead): PlatformServiceRowDTO {
  const deployments: EcsDeploymentRead[] =
    service.deployments.length > 0
      ? service.deployments
      : [
          {
            status: 'PRIMARY',
            rolloutState: null,
            createdAt: null,
            runningCount: service.runningCount,
            desiredCount: service.desiredCount,
            taskDefinitionArn: service.taskDefinitionArn,
          },
        ];
  const primary = deployments.find((d) => d.status === 'PRIMARY') ?? deployments[0]!;
  const others = deployments.filter((d) => d !== primary);
  const failedDeployment = deployments.find((d) => d.rolloutState === 'FAILED') ?? null;

  const current = sizeOf(service, service.taskDefinitionArn);
  const sizes = deployments.map((d) => sizeOf(service, d.taskDefinitionArn));
  const revisionOf = (d: EcsDeploymentRead) => sizeOf(service, d.taskDefinitionArn).revision;

  const running = service.runningCount;
  const desired = service.desiredCount;
  const rolling =
    failedDeployment === null && (others.length > 0 || primary.rolloutState === 'IN_PROGRESS');

  const tasks: PlatformServiceRowDTO['tasks'] =
    desired === 0 && running === 0
      ? 'scaledToZero'
      : rolling
        ? 'rolling'
        : running < desired
          ? 'short'
          : 'full';

  let deployment: PlatformServiceRowDTO['deployment'];
  if (failedDeployment) {
    const stillOn = deployments.find((d) => d !== failedDeployment) ?? null;
    deployment = {
      state: 'failed',
      fromRevision: stillOn ? revisionOf(stillOn) : null,
      toRevision: revisionOf(failedDeployment),
      newRunning: failedDeployment.runningCount,
      newDesired: failedDeployment.desiredCount,
      oldRunning: running - failedDeployment.runningCount,
      startedAt: failedDeployment.createdAt?.toISOString() ?? null,
    };
  } else {
    const draining = others[0] ?? null;
    deployment = {
      state: rolling ? 'rolling' : running < desired ? 'notRolling' : 'steady',
      fromRevision: rolling && draining ? revisionOf(draining) : null,
      toRevision: revisionOf(primary),
      newRunning: primary.runningCount,
      newDesired: primary.desiredCount,
      oldRunning: others.reduce((n, d) => n + d.runningCount, 0),
      startedAt: primary.createdAt?.toISOString() ?? null,
    };
  }

  const vcpu = round2(
    deployments.reduce((n, d, i) => n + d.runningCount * (sizes[i]!.cpuUnits / 1024), 0),
  );
  const uniformSize = deployments.every(
    (d, i) => d.runningCount === 0 || sizes[i]!.cpuUnits === current.cpuUnits,
  );

  return {
    name: service.name,
    family: current.family,
    revision: current.revision,
    running,
    desired,
    notStarted: tasks === 'short' ? desired - running : 0,
    tasks,
    vcpuPerTask: current.cpuUnits / 1024,
    memoryMib: current.memoryMib,
    vcpu,
    uniformSize,
    deployment,
  };
}

/** The cluster, judged: rows by name, the total and the pill counts. */
export function judgeCluster(
  services: EcsServiceRead[],
): Extract<PlatformServicesClusterDTO, { status: 'ok' }> {
  const rows = services.map(judgeService).sort((a, b) => a.name.localeCompare(b.name));
  return {
    status: 'ok',
    services: rows,
    total: {
      services: rows.length,
      running: rows.reduce((n, r) => n + r.running, 0),
      desired: rows.reduce((n, r) => n + r.desired, 0),
      vcpu: round2(rows.reduce((n, r) => n + r.vcpu, 0)),
    },
    rolling: rows.filter((r) => r.deployment.state === 'rolling').length,
    failed: rows.filter((r) => r.deployment.state === 'failed').length,
    short: rows.filter((r) => r.tasks === 'short').length,
  };
}

/**
 * The total against the quota: under 70%, at or over 70%, at or past the quota.
 * The percent is FLOORED so the number never reads past the verdict beside it
 * (69.75% shows 69%, under; 99.6% shows 99%, over 70%, not 100%).
 */
export function judgeShare(vcpu: number, quota: number): PlatformServicesShareDTO {
  const ratio = quota > 0 ? vcpu / quota : vcpu > 0 ? Infinity : 1;
  const verdict = ratio >= 1 ? 'atQuota' : ratio >= HEADROOM_ALERT_FRACTION ? 'over70' : 'under';
  return {
    percent: quota > 0 ? Math.floor(ratio * 100) : 100,
    verdict,
    headroom:
      verdict === 'under'
        ? round2(quota * HEADROOM_ALERT_FRACTION - vcpu)
        : verdict === 'over70'
          ? round2(quota - vcpu)
          : 0,
    over: round2(Math.max(0, vcpu - quota)),
  };
}

export interface PlatformServicesReadOptions {
  now?: Date;
  reader?: EcsServicesReader;
}

export const platformServicesService = {
  async read(options: PlatformServicesReadOptions = {}): Promise<PlatformServicesDTO> {
    const principal = await requirePlatformStaff('superadmin');
    const now = options.now ?? new Date();
    const reader = options.reader ?? createEcsServicesReader();
    const cluster = servicesCluster();

    const [clusterRead, quotaRead] = await Promise.allSettled([
      reader.listServices(cluster).then(judgeAndKeep),
      reader.readFargateVcpuQuota(),
    ]);
    if (clusterRead.status === 'rejected') logFailure('cluster', cluster, clusterRead.reason);
    if (quotaRead.status === 'rejected') logFailure('quota', cluster, quotaRead.reason);

    const clusterSubject = CLUSTER_SUBJECT(cluster);
    const marks = await withPlatformRead(
      principal,
      {
        action: 'services.read',
        targetKind: 'platform',
        targetId: cluster,
        metadata: {
          cluster,
          clusterRead: clusterRead.status === 'fulfilled',
          quotaRead: quotaRead.status === 'fulfilled',
        },
      },
      async (tx) => {
        if (clusterRead.status === 'fulfilled') {
          await platformAwsReadRepository.markRead(
            { subject: clusterSubject, accountId: clusterRead.value.account, readAt: now },
            tx,
          );
        }
        if (quotaRead.status === 'fulfilled') {
          await platformAwsReadRepository.markRead({ subject: QUOTA_SUBJECT, readAt: now }, tx);
        }
        return platformAwsReadRepository.findMany([clusterSubject, QUOTA_SUBJECT], tx);
      },
    );
    const mark = (subject: string) => marks.find((m) => m.subject === subject) ?? null;

    const read: PlatformServicesClusterDTO =
      clusterRead.status === 'fulfilled'
        ? clusterRead.value.judged
        : { status: 'failed', lastReadAt: mark(clusterSubject)?.readAt.toISOString() ?? null };
    const quota: PlatformServicesQuotaDTO =
      quotaRead.status === 'fulfilled'
        ? { status: 'ok', vcpu: quotaRead.value, readAt: now.toISOString() }
        : { status: 'notRead', lastReadAt: mark(QUOTA_SUBJECT)?.readAt.toISOString() ?? null };

    return {
      cluster,
      account: mark(clusterSubject)?.accountId ?? null,
      readAt: now.toISOString(),
      read,
      quota,
      share:
        read.status === 'ok' && quota.status === 'ok'
          ? judgeShare(read.total.vcpu, quota.vcpu)
          : null,
    };
  },
};

/** Judge the read where it lands, so a task definition with no size fails it. */
function judgeAndKeep(services: EcsServiceRead[]) {
  const account = services.map((s) => accountOfArn(s.arn)).find((a) => a !== null) ?? null;
  return { judged: judgeCluster(services), account };
}

/** The failure, by its error NAME only — an AWS message can carry ARNs and request ids. */
function logFailure(what: 'cluster' | 'quota', cluster: string, reason: unknown): void {
  console.error(`[admin] services ${what} read failed`, {
    cluster,
    error: reason instanceof Error ? reason.name : 'unknown',
  });
}
