import 'server-only';

import {
  createEcsServicesReader,
  FARGATE_ON_DEMAND_VCPU_QUOTA,
  type EcsContainerRead,
  type EcsDeploymentRead,
  type EcsServiceRead,
  type EcsServicesReader,
  type EcsTaskSizeRead,
} from '@/lib/awsServices/ecsServicesReader';
import {
  createEcrImageTagsReader,
  parseEcrImageAddress,
  type EcrImageAddress,
  type EcrImageTagsReader,
} from '@/lib/awsServices/ecrImagesReader';
import { HEADROOM_ALERT_FRACTION } from '@/lib/ciFleet/shardTargets';
import {
  repoCommitHistoryClient,
  type CommitComparison,
  type DefaultBranchHead,
  type RepoRef,
} from '@/lib/github/repoCommitHistory';
import type {
  PlatformServiceCommitDTO,
  PlatformServiceRowDTO,
  PlatformServiceVersionDTO,
  PlatformServiceVersionJudgementDTO,
  PlatformServicesClusterDTO,
  PlatformServicesDTO,
  PlatformServicesQuotaDTO,
  PlatformServicesShareDTO,
} from '@/lib/dto/platformServices';
import { requirePlatformStaff } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { platformAwsReadRepository } from '@/lib/repositories/platformAwsReadRepository';
import { sourceRepoToken } from '@/lib/services/runnerImageFreshnessProbeService';

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
 * THE DEPLOYED COMMIT (MOTIR-11112, design MOTIR-11242). Each service's PRIMARY
 * deployment runs a task definition whose APPLICATION container names its image
 * (`applicationImageOf` — picked by what it is, never by its position, because a
 * sidecar may be listed first, MOTIR-11275); every
 * deploy tags that image in ECR with the full commit SHA, so the commit is the
 * image's 40-hex tag (a reference BY that tag is used directly). The image
 * repository maps to its source repository on GitHub (`IMAGE_SOURCE_REPOSITORIES`)
 * and the commit is compared with that repository's default-branch head. Every
 * part is read on its own and per row: an ECR or GitHub failure, an image with no
 * commit tag or an unmapped repository makes THAT row's version `unknown` with
 * the reason, never an error for the page. Reads are shared across the rows of
 * one request — one ECR read per image, one head per repository, one compare per
 * (repository, deployed commit) — so the three motir-core services cost one
 * compare.
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

/**
 * Image repository (ECR) → the GitHub repository its images are built from. A
 * repository not listed here is `source_not_mapped`, never a guess.
 */
export const IMAGE_SOURCE_REPOSITORIES: Readonly<Record<string, RepoRef>> = {
  'motir/motir-core': { owner: 'motir-co', name: 'motir-core' },
  'motir/motir-ai': { owner: 'motir-co', name: 'motir-ai' },
  'motir/motir-gateway': { owner: 'motir-co', name: 'motir-gateway' },
  'motir/edge': { owner: 'motir-co', name: 'motir-gateway' },
};

/** The normal merge → CI → deploy window: an undeployed commit younger than
 *  this is `fresh`, one this old or older is `stale`. */
export const STALE_AFTER_MS = 45 * 60_000;

/** A full commit SHA, as every deploy tags its image. */
const SHA_TAG = /^[0-9a-f]{40}$/;

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

/** The service's deployments — one standing in for the service when ECS lists
 *  none — and the PRIMARY one among them. */
function deploymentsOf(service: EcsServiceRead): {
  deployments: EcsDeploymentRead[];
  primary: EcsDeploymentRead;
} {
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
  return { deployments, primary };
}

/** Whether an image is a reference into ECR, in a repository this page maps to
 *  its source — i.e. an image Motir itself builds and deploys. */
function isMappedEcrImage(image: string | null): boolean {
  const address = image === null ? null : parseEcrImageAddress(image);
  return address !== null && Object.hasOwn(IMAGE_SOURCE_REPOSITORIES, address.repositoryName);
}

/** Whether a container is named after its service — `motir-core-web` runs `web`. */
function isNamedAfter(serviceName: string, container: EcsContainerRead): boolean {
  const name = container.name;
  return !!name && (serviceName === name || serviceName.endsWith(`-${name}`));
}

/**
 * The service's APPLICATION container's image (MOTIR-11275). A task definition
 * may run a sidecar beside the application — core-web runs the OpenTelemetry
 * collector from `public.ecr.aws` — and the order ECS lists them in depends on
 * which tool registered the revision, so the pick never reads position:
 *
 * 1. an essential container whose image is a reference into ECR in a repository
 *    `IMAGE_SOURCE_REPOSITORIES` maps — the one named after the service when
 *    more than one is;
 * 2. else the container named after the service;
 * 3. else, only when nothing matches, the first container.
 *
 * Null when the task definition has no container or the picked one names no image.
 */
export function applicationImageOf(
  serviceName: string,
  containers: readonly EcsContainerRead[],
): string | null {
  const built = containers.filter((c) => c.essential && isMappedEcrImage(c.image));
  const picked =
    built.find((c) => isNamedAfter(serviceName, c)) ??
    built[0] ??
    containers.find((c) => isNamedAfter(serviceName, c)) ??
    containers[0];
  return picked?.image ?? null;
}

/** The image the service's PRIMARY deployment runs — its application
 *  container's — or null when its task definition names none. */
export function primaryImageOf(service: EcsServiceRead): string | null {
  const primary = service.taskDefinitions[deploymentsOf(service).primary.taskDefinitionArn];
  return primary ? applicationImageOf(service.name, primary.containers) : null;
}

/** What one deployment's image resolved to: its commit, and that commit judged. */
export interface DeploymentVersionRead {
  commit: PlatformServiceCommitDTO | null;
  judgement: PlatformServiceVersionJudgementDTO;
}

/** A service whose version was never read — the judges' default, so a cluster
 *  judged without a version read says so rather than inventing one. */
const NOT_READ: DeploymentVersionRead = {
  commit: null,
  judgement: { state: 'unknown', reason: 'ecr_not_read' },
};

/** A rolling service's version is its PRIMARY deployment's, said to be rolling. */
function effectiveJudgement(
  version: PlatformServiceVersionDTO,
): PlatformServiceVersionJudgementDTO {
  return version.state === 'rolling' ? version.primary : version;
}

/**
 * One service, judged. Rolling = more than one deployment, or the PRIMARY's
 * rollout in progress; failed = a deployment whose rollout FAILED; short =
 * running < desired while not rolling; scaled to 0 = desired 0 and running 0.
 * The version is the PRIMARY deployment's (`read`), wrapped in `rolling` while
 * the deployment rolls.
 */
export function judgeService(
  service: EcsServiceRead,
  read: DeploymentVersionRead = NOT_READ,
): PlatformServiceRowDTO {
  const { deployments, primary } = deploymentsOf(service);
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
    commit: read.commit,
    version:
      deployment.state === 'rolling'
        ? { state: 'rolling', primary: read.judgement }
        : read.judgement,
  };
}

/** The cluster, judged: rows by name, the total and the pill counts. `versions`
 *  holds each service's version read, by service name. */
export function judgeCluster(
  services: EcsServiceRead[],
  versions: ReadonlyMap<string, DeploymentVersionRead> = new Map(),
): Extract<PlatformServicesClusterDTO, { status: 'ok' }> {
  const rows = services
    .map((service) => judgeService(service, versions.get(service.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const judged = rows.map((r) => effectiveJudgement(r.version));
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
    staleOrDiverged: judged.filter(
      (v) => v.state === 'diverged' || (v.state === 'behind' && v.severity === 'stale'),
    ).length,
    versionsNotRead: judged.length > 0 && judged.every((v) => v.state === 'unknown'),
  };
}

// ── The deployed commit (MOTIR-11112) ────────────────────────────────────────

/** Where the version read reads from — handed in by tests, else ECR over the
 *  default chain and GitHub with the Fleet status page's token. */
export interface ServiceVersionSources {
  ecr: EcrImageTagsReader;
  github: {
    defaultBranchHead(repo: RepoRef, token: string | null): Promise<DefaultBranchHead>;
    compare(
      repo: RepoRef,
      base: string,
      head: string,
      token: string | null,
    ): Promise<CommitComparison>;
  };
  token(owner: string): Promise<string | null>;
}

function defaultVersionSources(): ServiceVersionSources {
  return {
    ecr: createEcrImageTagsReader(),
    github: repoCommitHistoryClient,
    token: (owner) => sourceRepoToken(owner),
  };
}

/** A read that failed, so the row is `unknown` for `reason`. */
class VersionReadError extends Error {
  constructor(
    readonly reason: 'ecr_not_read' | 'github_not_read',
    readonly underlying: unknown,
  ) {
    super(reason);
    this.name = 'VersionReadError';
  }
}

/** One promise per key, so rows that share a read share its one call. */
function memo<T>(make: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const made = new Map<string, Promise<T>>();
  return (key) => {
    let promise = made.get(key);
    if (!promise) {
      promise = make(key);
      made.set(key, promise);
    }
    return promise;
  };
}

const repoKey = (repo: RepoRef) => `${repo.owner}/${repo.name}`;

/** The deployed commit judged against the default-branch head. */
export function judgeComparison(
  repo: RepoRef,
  deployed: string,
  head: DefaultBranchHead,
  comparison: CommitComparison,
  now: Date,
): PlatformServiceVersionJudgementDTO {
  if (comparison.relation === 'identical') return { state: 'latest' };
  if (comparison.relation !== 'ahead') return { state: 'diverged' };
  if (comparison.oldestAheadAt === null) {
    throw new Error('GitHub named no oldest undeployed commit');
  }
  const age = now.getTime() - new Date(comparison.oldestAheadAt).getTime();
  return {
    state: 'behind',
    count: comparison.aheadBy,
    oldestUndeployedAt: comparison.oldestAheadAt,
    severity: age >= STALE_AFTER_MS ? 'stale' : 'fresh',
    compareUrl: `https://github.com/${repoKey(repo)}/compare/${deployed}...${encodeURIComponent(head.branch)}`,
  };
}

/**
 * The version reader of ONE request: `versionOf(image)` resolves an image to its
 * commit and judges it. It never throws — every failure is the row's `unknown`
 * reason — and it shares each ECR read, head read and compare across the rows.
 */
export function createVersionReader(
  sources: ServiceVersionSources,
  now: Date,
): (image: string | null) => Promise<DeploymentVersionRead> {
  const token = memo((owner) => sources.token(owner));
  const tags = memo(async (image) => {
    try {
      return await sources.ecr.tagsOf(parseEcrImageAddress(image)!);
    } catch (err) {
      throw new VersionReadError('ecr_not_read', err);
    }
  });
  const github = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (err) {
      throw new VersionReadError('github_not_read', err);
    }
  };
  const heads = memo((key) => {
    const repo = repoOf(key);
    return github(async () => sources.github.defaultBranchHead(repo, await token(repo.owner)));
  });
  const compares = memo((key) => {
    const [repoPart, deployed, head] = key.split('@') as [string, string, string];
    const repo = repoOf(repoPart);
    return github(async () =>
      sources.github.compare(repo, deployed, head, await token(repo.owner)),
    );
  });

  async function commitOf(address: EcrImageAddress, image: string): Promise<string | null> {
    if (address.tag && SHA_TAG.test(address.tag)) return address.tag;
    return (await tags(image)).find((tag) => SHA_TAG.test(tag)) ?? null;
  }

  async function judge(repo: RepoRef, sha: string): Promise<PlatformServiceVersionJudgementDTO> {
    const head = await heads(repoKey(repo));
    if (head.sha === sha) return { state: 'latest' };
    const comparison = await compares(`${repoKey(repo)}@${sha}@${head.sha}`);
    return github(async () => judgeComparison(repo, sha, head, comparison, now));
  }

  return async (image) => {
    const address = image === null ? null : parseEcrImageAddress(image);
    if (image === null || address === null) {
      return {
        commit: null,
        judgement: {
          state: 'unknown',
          reason: image === null ? 'no_sha_tag' : 'source_not_mapped',
        },
      };
    }
    let commit: PlatformServiceCommitDTO | null = null;
    try {
      const sha = await commitOf(address, image);
      if (sha === null) return { commit, judgement: { state: 'unknown', reason: 'no_sha_tag' } };
      const source = IMAGE_SOURCE_REPOSITORIES[address.repositoryName] ?? null;
      if (source === null) {
        commit = { sha, repository: null, url: null };
        return { commit, judgement: { state: 'unknown', reason: 'source_not_mapped' } };
      }
      commit = {
        sha,
        repository: source.name,
        url: `https://github.com/${repoKey(source)}/commit/${sha}`,
      };
      return { commit, judgement: await judge(source, sha) };
    } catch (err) {
      if (!(err instanceof VersionReadError)) throw err;
      logVersionFailure(address.repositoryName, err);
      return { commit, judgement: { state: 'unknown', reason: err.reason } };
    }
  };
}

function repoOf(key: string): RepoRef {
  const [owner, name] = key.split('/') as [string, string];
  return { owner, name };
}

/** Every service's version, by name — each service's PRIMARY deployment image. */
async function readVersions(
  services: EcsServiceRead[],
  sources: ServiceVersionSources,
  now: Date,
): Promise<Map<string, DeploymentVersionRead>> {
  const versionOf = createVersionReader(sources, now);
  const reads = await Promise.all(services.map((s) => versionOf(primaryImageOf(s))));
  return new Map(services.map((s, i) => [s.name, reads[i]!]));
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
  /** Where the deployed commits are read from (MOTIR-11112). */
  versionSources?: ServiceVersionSources;
}

export const platformServicesService = {
  async read(options: PlatformServicesReadOptions = {}): Promise<PlatformServicesDTO> {
    const principal = await requirePlatformStaff('superadmin');
    const now = options.now ?? new Date();
    const reader = options.reader ?? createEcsServicesReader();
    const cluster = servicesCluster();
    const versionSources = options.versionSources ?? defaultVersionSources();

    const [clusterRead, quotaRead] = await Promise.allSettled([
      reader
        .listServices(cluster)
        .then(async (services) =>
          judgeAndKeep(services, await readVersions(services, versionSources, now)),
        ),
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
function judgeAndKeep(services: EcsServiceRead[], versions: Map<string, DeploymentVersionRead>) {
  const account = services.map((s) => accountOfArn(s.arn)).find((a) => a !== null) ?? null;
  return { judged: judgeCluster(services, versions), account };
}

/** A version read that failed, by its error NAME only, like `logFailure`. */
function logVersionFailure(repository: string, failure: VersionReadError): void {
  console.error('[admin] services version read failed', {
    repository,
    reason: failure.reason,
    error: failure.underlying instanceof Error ? failure.underlying.name : 'unknown',
  });
}

/** The failure, by its error NAME only — an AWS message can carry ARNs and request ids. */
function logFailure(what: 'cluster' | 'quota', cluster: string, reason: unknown): void {
  console.error(`[admin] services ${what} read failed`, {
    cluster,
    error: reason instanceof Error ? reason.name : 'unknown',
  });
}
