import { randomUUID } from 'node:crypto';
import {
  OrchestratorApiError,
  OrchestratorCapacityError,
  OrchestratorNotConfiguredError,
} from '../../errors';
import { sparedByCaller } from '../../reap';
import { buildContainerUsage } from '../../usage';
import { FLEET_METADATA_INTENT_KEY, FLEET_METADATA_KEY, FLEET_METADATA_VALUES } from '../fly';
import type {
  ContainerHandle,
  ContainerOrchestrator,
  ContainerSpec,
  ContainerStatus,
  ContainerUsage,
  ReapSparePredicate,
  TeardownReason,
  UsageAttribution,
  UsageAttributionResolver,
} from '../../types';
import { Ec2ApiError, type Ec2Api, type Ec2Instance, type Ec2Tag } from './ec2Client';
import {
  awsApiError as apiError,
  awsCapacityReason,
  classifyAwsLaunchError,
} from './capacityErrors';
import { AWS_SHARD_TAG_KEY } from './network';
import { buildContainerUserData, buildRunnerUserData, encodeUserData } from './userData';
import { buildIndexUserData, consoleExitCode, consoleShowsPullFailure } from './indexUserData';

export * from './userData';
export * from './indexUserData';
export * from './capacityErrors';
export * from './credentials';
export * from './management';
export * from './inventory';

// The AWS adapter (Story MOTIR-9270 · MOTIR-9276) — `ContainerOrchestrator` on
// EC2, one VM per job, booted from the runner AMI into the shard's tagged network
// (`./network.ts`).
//
// Thin like the Fly adapter, and for the same reason: the usage arithmetic is
// `buildContainerUsage`'s, the age rule `sparedByCaller`'s, and what makes a
// machine one of OURS is the fleet tag the Fly adapter defines — imported, not
// copied. What is left is translation, plus the three things EC2 does not give
// for free:
//
//   1. AN INSTANCE DOES NOT STOP ON ITS OWN. The AMI powers the VM off when the
//      runner exits and every runner launch says `InstanceInitiatedShutdownBehavior:
//      'terminate'` (an index VM's says `stop`, below), so a finished job reads as terminal instead of billing to
//      the one-hour timeout.
//   2. A TERMINATED INSTANCE LINGERS for about an hour in DescribeInstances. It
//      reads as `exists: false, state: 'destroyed'`, the port's "gone".
//   3. THE LAUNCH CARRIES A CREDENTIAL (the JIT config, in user-data). No log
//      line, error or return value holds the payload; an EC2 failure surfaces as
//      its error CODE only (`Ec2ApiError` never copies AWS's message).
//
// ⚠️ SHARD-BLIND AND ENVIRONMENT-BLIND. The composition root reads the account's
// key and the AMI id and hands this a plain config.
//
// AN INDEX VM (MOTIR-9446) is the one launch that is not a runner: a
// `code_graph_index` spec boots the stock Docker-host AMI (`indexerAmiId`) with a
// script that pulls the indexer image by digest and runs it (`./indexUserData.ts`
// names the AMI and why). Same size, same network, same tags and the same
// launch/zone walk as a runner. Its signals are read from the VM's serial console
// once it has stopped: a failed pull, reported as `imagePullFailed`, and the
// indexer's exit code (MOTIR-9449), reported as `exitCode`. Unlike a runner it
// launches with `InstanceInitiatedShutdownBehavior: 'stop'`, so its power-off
// leaves it stopped and readable until `teardown` terminates it at settle.

/** The machine class the fleet's one size maps to — 2 vCPU / 8 GiB, x86. */
export const AWS_DEFAULT_INSTANCE_TYPE = 'm6i.large';

/** Where the AMI's Docker data disk is mapped. */
export const AWS_DOCKER_DEVICE_NAME = '/dev/sdb';

/** How many times one `provision` sends RunInstances (same ClientToken) on a
 *  transport error or a 5xx before it gives up. */
export const AWS_LAUNCH_ATTEMPTS = 3;

/** How long the tag-discovered subnets and group are trusted before re-reading. */
export const AWS_NETWORK_CACHE_MS = 5 * 60_000;

/** The page size the reaper asks DescribeInstances for (EC2 takes 5–1000). */
export const AWS_REAP_PAGE_SIZE = 200;

/** The states an instance can bill in — what the reaper sweeps. */
const LIVE_STATES = ['pending', 'running', 'stopping', 'stopped'];

/** States in which the VM has run and stopped (or is stopping): the job is over. */
const TERMINAL_STATES = new Set(['shutting-down', 'stopping', 'stopped']);

/** DescribeInstances / TerminateInstances on an id EC2 does not know. A
 *  terminated instance ages out to `NotFound`; a non-EC2 id is `Malformed`. */
const GONE_CODES = new Set(['InvalidInstanceID.NotFound', 'InvalidInstanceID.Malformed']);

/** RunInstances codes that mean the cached subnet or group no longer exists. */
const STALE_NETWORK_CODES = new Set([
  'InvalidSubnetID.NotFound',
  'InvalidSubnet',
  'InvalidGroup.NotFound',
  'InvalidSecurityGroupID.NotFound',
]);

/** The machine-name prefix per workload, as the Fly adapter names its machines. */
const NAME_PREFIXES: Record<ContainerSpec['workload'], string> = {
  ci_runner: 'motir-runner',
  code_graph_index: 'motir-index',
  hosted_agent: 'motir-agent',
  agent_instance: 'motir-instance',
};

/** A spec whose size no instance type is mapped to — refused before any call. */
export class AwsInstanceSizeError extends Error {
  readonly code = 'AWS_INSTANCE_SIZE_UNSUPPORTED' as const;
  constructor(
    readonly cpus: number,
    readonly memoryMb: number,
  ) {
    super(`The aws orchestrator has no instance type for ${cpus} vCPU / ${memoryMb} MB.`);
    this.name = 'AwsInstanceSizeError';
  }
}

/**
 * The four tags every index VM carries (MOTIR-9450), on its instance, volumes and
 * network interface, so a person in the EC2 console and AWS cost tooling can tell
 * whose index a billed resource is. They are a FINDING aid, never attribution:
 * anyone holding the account's key could write them, so the attribution pass
 * matches a VM by its usage row and slot, and reaps a tagged VM with no record.
 */
export const AWS_INDEX_TAG_KEYS = {
  workload: 'motir:workload',
  org: 'motir:org',
  project: 'motir:project',
  repo: 'motir:repo',
} as const;

/** EC2's limit on a tag value. A longer value is cut to it, never dropped. */
export const AWS_TAG_VALUE_MAX = 256;

/** An index spec missing what its tags are made of — refused before any call,
 *  so no VM is launched untagged. */
export class AwsIndexAttributionError extends Error {
  readonly code = 'AWS_INDEX_ATTRIBUTION_MISSING' as const;
  constructor(readonly field: 'orgId' | 'projectId' | 'repoFullName') {
    super(`An index VM cannot launch untagged: the spec has no ${field}.`);
    this.name = 'AwsIndexAttributionError';
  }
}

/** The tag naming the hosted run an instance serves (MOTIR-9422) — what the
 *  reaper reads back to find the run and its paying org from AWS alone. */
export const AWS_DISPATCH_RUN_TAG_KEY = 'motir_dispatch_run_id';

const FLEET_VALUE_SET: ReadonlySet<string> = new Set(Object.values(FLEET_METADATA_VALUES));

export interface AwsOrchestratorConfig {
  readonly ec2: Ec2Api;
  /** The region the `ec2` client speaks to — every handle's region. */
  readonly region: string;
  /** The shard's `motir-shard` tag value — its name. Scopes discovery and reap. */
  readonly shardTag: string;
  /** The runner AMI (`MOTIR_AWS_RUNNER_AMI_ID`). */
  readonly amiId: string;
  /** The Docker-host AMI an index VM boots (`MOTIR_AWS_INDEXER_AMI_ID`). Unset
   *  refuses a `code_graph_index` spec before any EC2 call. */
  readonly indexerAmiId?: string;
  /** Overrides {@link AWS_DEFAULT_INSTANCE_TYPE}. */
  readonly instanceType?: string;
  /** Overrides {@link AWS_REAP_PAGE_SIZE}. */
  readonly reapPageSize?: number;
  /** A fresh idempotency token per provision — the test seam. */
  readonly clientToken?: () => string;
  /** The clock — the test seam. */
  readonly now?: () => Date;
}

/** The tagged network one launch goes into. */
interface ShardNetwork {
  /** Sorted by zone name: the rotation's order. */
  readonly subnets: ReadonlyArray<{ readonly subnetId: string; readonly zone: string }>;
  readonly securityGroupId: string;
  readonly readAt: number;
}

function isGone(err: unknown): boolean {
  return err instanceof Ec2ApiError && GONE_CODES.has(err.code);
}

function tagOf(instance: Ec2Instance, key: string): string | undefined {
  return instance.tags.find((t) => t.key === key)?.value;
}

function isIndexInstance(instance: Ec2Instance): boolean {
  return tagOf(instance, FLEET_METADATA_KEY) === FLEET_METADATA_VALUES.code_graph_index;
}

/** The index VM's four tags, or a refusal naming the first field it lacks. */
function indexTags(spec: ContainerSpec): Ec2Tag[] {
  for (const field of ['orgId', 'projectId', 'repoFullName'] as const) {
    if (!spec[field]?.trim()) throw new AwsIndexAttributionError(field);
  }
  return [
    // The workload KIND, as the fleet names it (`motir_fleet` keeps the Fly spelling).
    { key: AWS_INDEX_TAG_KEYS.workload, value: spec.workload },
    { key: AWS_INDEX_TAG_KEYS.org, value: spec.orgId },
    { key: AWS_INDEX_TAG_KEYS.project, value: spec.projectId },
    { key: AWS_INDEX_TAG_KEYS.repo, value: spec.repoFullName },
  ];
}

/**
 * The instant in `StateTransitionReason`, when AWS gives one — its form is
 * `User initiated (2026-10-22 12:00:00 GMT)`.
 */
export function transitionTimeOf(reason: string | null): Date | null {
  const match = /\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT\)/.exec(reason ?? '');
  if (!match) return null;
  const at = new Date(`${match[1]}T${match[2]}.000Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

function startedAtOf(instance: Ec2Instance): Date | null {
  return instance.state === 'pending' ? null : instance.launchTime;
}

function nameFor(spec: ContainerSpec): string {
  const prefix = NAME_PREFIXES[spec.workload];
  return spec.workflowJobId !== null
    ? `${prefix}-${spec.workflowJobId}`
    : `${prefix}-${spec.projectId}`;
}

/** Every tag a launch writes, on the instance and its volumes (and an index VM's
 *  network interface) in the SAME call. Each value is cut to EC2's limit. */
function tagsFor(
  spec: ContainerSpec,
  shardTag: string,
  extraTags: readonly Ec2Tag[] = [],
): Ec2Tag[] {
  return [
    { key: AWS_SHARD_TAG_KEY, value: shardTag },
    { key: FLEET_METADATA_KEY, value: FLEET_METADATA_VALUES[spec.workload] },
    // Omitted, not blank, for a workload with no job — as the Fly adapter does.
    ...(spec.workflowJobId !== null
      ? [{ key: FLEET_METADATA_INTENT_KEY, value: String(spec.workflowJobId) }]
      : []),
    { key: 'motir_org_id', value: spec.orgId },
    { key: 'motir_project_id', value: spec.projectId },
    { key: 'Name', value: nameFor(spec) },
    ...extraTags,
  ].map((tag) => ({ key: tag.key, value: tag.value.slice(0, AWS_TAG_VALUE_MAX) }));
}

/** A hosted run's tags (MOTIR-9422): the run it serves, and a name naming it. */
function hostedAgentTagsFor(spec: ContainerSpec, shardTag: string, runId: string): Ec2Tag[] {
  return [
    { key: AWS_SHARD_TAG_KEY, value: shardTag },
    { key: FLEET_METADATA_KEY, value: FLEET_METADATA_VALUES.hosted_agent },
    { key: 'motir_org_id', value: spec.orgId },
    { key: 'motir_project_id', value: spec.projectId },
    { key: AWS_DISPATCH_RUN_TAG_KEY, value: runId },
    { key: 'Name', value: `${NAME_PREFIXES.hosted_agent}-${runId}` },
  ];
}

/** What one launch sends: the base64 user-data and the tags, and — for a
 *  workload that does not boot the runner AMI — its own image and power-off. */
interface LaunchPayload {
  readonly userData: string;
  readonly tags: Ec2Tag[];
  /** The AMI; omitted means the runner AMI (`amiId`). */
  readonly imageId?: string;
  /** Omitted means `terminate`. */
  readonly shutdownBehavior?: 'terminate' | 'stop';
  /** Tag the network interface too (an index VM's attribution tags). */
  readonly tagNetworkInterface?: boolean;
}

/**
 * THE LAUNCH PAYLOAD PER WORKLOAD — total over the union, so a new workload is a
 * compile error here. Every refusal throws before any EC2 call. The agent hoster
 * boots on AWS in its own story; until then it is refused.
 */
const LAUNCH_PAYLOADS: Record<
  ContainerSpec['workload'],
  (
    spec: ContainerSpec,
    shardTag: string,
    config: Pick<AwsOrchestratorConfig, 'indexerAmiId'>,
  ) => LaunchPayload
> = {
  ci_runner: (spec, shardTag) => ({
    userData: encodeUserData(buildRunnerUserData(spec.env)),
    tags: tagsFor(spec, shardTag),
  }),
  hosted_agent: (spec, shardTag) => {
    const userData = buildContainerUserData({ image: spec.image, env: spec.env });
    // The builder has refused a spec with no run id, so this is set.
    const runId = spec.env['MOTIR_DISPATCH_RUN_ID']!;
    return {
      userData: encodeUserData(userData),
      tags: hostedAgentTagsFor(spec, shardTag, runId),
    };
  },
  // An index VM (MOTIR-9446) boots the stock Docker-host AMI and runs the pinned
  // indexer image; it is held stopped until teardown, so describe can read the
  // exit code first (MOTIR-9449), and carries its four attribution tags on its
  // instance, volumes and network interface (MOTIR-9450).
  code_graph_index: (spec, shardTag, { indexerAmiId }) => {
    const extraTags = indexTags(spec);
    if (!indexerAmiId) {
      throw new OrchestratorNotConfiguredError(
        'this aws account has no indexer AMI (set MOTIR_AWS_INDEXER_AMI_ID)',
      );
    }
    return {
      userData: encodeUserData(buildIndexUserData(spec)),
      tags: tagsFor(spec, shardTag, extraTags),
      imageId: indexerAmiId,
      shutdownBehavior: 'stop',
      tagNetworkInterface: true,
    };
  },
  agent_instance: () => notOnAws('agent_instance'),
};

function notOnAws(workload: ContainerSpec['workload']): never {
  throw new OrchestratorNotConfiguredError(
    `the aws orchestrator does not boot the ${workload} workload yet`,
  );
}

/** An AWS adapter for ONE shard (one account, one region). */
export function createAwsOrchestrator(config: AwsOrchestratorConfig): ContainerOrchestrator {
  const { ec2, region, shardTag, amiId } = config;
  const instanceType = config.instanceType ?? AWS_DEFAULT_INSTANCE_TYPE;
  const pageSize = config.reapPageSize ?? AWS_REAP_PAGE_SIZE;
  const clientToken = config.clientToken ?? (() => randomUUID());
  const now = config.now ?? (() => new Date());

  let network: ShardNetwork | null = null;
  let rotation = 0;

  /** The shard's subnets (sorted by zone) and its group, found by tag. */
  async function shardNetwork(): Promise<ShardNetwork> {
    if (network && now().getTime() - network.readAt < AWS_NETWORK_CACHE_MS) return network;
    const byTag = [{ name: `tag:${AWS_SHARD_TAG_KEY}`, values: [shardTag] }];
    let subnets, groups;
    try {
      subnets = await ec2.describeSubnets(byTag);
      groups = await ec2.describeSecurityGroups(byTag);
    } catch (err) {
      throw apiError(err);
    }
    const where = `${AWS_SHARD_TAG_KEY}=${shardTag} in ${region}`;
    if (subnets.length === 0) {
      throw new OrchestratorNotConfiguredError(`no subnet is tagged ${where}`);
    }
    if (groups.length !== 1) {
      throw new OrchestratorNotConfiguredError(
        `${groups.length === 0 ? 'no' : 'more than one'} security group is tagged ${where}`,
      );
    }
    network = {
      subnets: [...subnets]
        .sort((a, b) => a.availabilityZone.localeCompare(b.availabilityZone))
        .map((s) => ({ subnetId: s.subnetId, zone: s.availabilityZone })),
      securityGroupId: groups[0]!.groupId,
      readAt: now().getTime(),
    };
    return network;
  }

  /**
   * ONE RunInstances into ONE subnet, retried with the SAME token on a transport
   * error or 5xx: EC2 answers a repeated ClientToken with the instance it already
   * made, so an ambiguous timeout cannot make two. A capacity refusal is never
   * resent here — it is the zone walk's (`provision`) — even when EC2 marks it
   * retryable (InsufficientInstanceCapacity is a 500, RequestLimitExceeded a 503).
   * A refusal throws classified, naming the zone.
   */
  async function launchInSubnet(
    spec: ContainerSpec,
    { userData, tags, imageId, shutdownBehavior, tagNetworkInterface }: LaunchPayload,
    { subnetId, zone }: { subnetId: string; zone: string },
    securityGroupId: string,
  ): Promise<Ec2Instance> {
    const token = clientToken();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await ec2.runInstances({
          clientToken: token,
          imageId: imageId ?? amiId,
          instanceType,
          subnetId,
          securityGroupIds: [securityGroupId],
          userData,
          // IMDSv2 only, one hop: a container on the VM cannot reach the
          // metadata service, which holds the user-data and so the JIT config.
          // No IamInstanceProfile and no KeyName are ever sent.
          metadataOptions: {
            httpTokens: 'required',
            httpPutResponseHopLimit: 1,
            httpEndpoint: 'enabled',
          },
          instanceInitiatedShutdownBehavior: shutdownBehavior ?? 'terminate',
          blockDeviceMappings:
            spec.dockerVolumeGb && spec.dockerVolumeGb > 0
              ? [
                  {
                    deviceName: AWS_DOCKER_DEVICE_NAME,
                    volumeSizeGb: spec.dockerVolumeGb,
                    volumeType: 'gp3',
                    deleteOnTermination: true,
                  },
                ]
              : [],
          tags,
          ...(tagNetworkInterface ? { tagNetworkInterface: true } : {}),
        });
      } catch (err) {
        const retryable = err instanceof Ec2ApiError && err.retryable && !awsCapacityReason(err);
        if (!retryable || attempt >= AWS_LAUNCH_ATTEMPTS) {
          if (err instanceof Ec2ApiError && STALE_NETWORK_CODES.has(err.code)) network = null;
          throw classifyAwsLaunchError(err, zone);
        }
      }
    }
  }

  function toHandle(instance: Ec2Instance): ContainerHandle {
    return {
      provider: 'aws',
      id: instance.instanceId,
      region,
      // A handle with no instant cannot be reaped by age; now is the honest floor.
      createdAt: instance.launchTime ?? now(),
    };
  }

  /** The instance, or null when EC2 no longer knows it. Other failures throw. */
  async function readInstance(id: string): Promise<Ec2Instance | null> {
    try {
      const { instances } = await ec2.describeInstances({ instanceIds: [id] });
      return instances[0] ?? null;
    } catch (err) {
      if (isGone(err)) return null;
      throw apiError(err);
    }
  }

  /** Terminate; an id EC2 no longer knows is already gone. */
  async function terminate(id: string): Promise<void> {
    try {
      await ec2.terminateInstances([id]);
    } catch (err) {
      if (isGone(err)) return;
      throw apiError(err);
    }
  }

  /** The §5 row, once the instance is terminated. AWS's instants win; the
   *  caller's observation and now are the fallbacks. */
  function usageFor(
    handle: ContainerHandle,
    instance: Ec2Instance | null,
    reason: TeardownReason,
    context: UsageAttribution,
  ): ContainerUsage {
    return buildContainerUsage({
      handle,
      attribution: context,
      reason,
      lifecycle: {
        createdAt: instance?.launchTime ?? handle.createdAt,
        startedAt: (instance ? startedAtOf(instance) : null) ?? context.observedStartedAt,
        stoppedAt: transitionTimeOf(instance?.stateTransitionReason ?? null) ?? now(),
        terminalState: 'destroyed',
      },
    });
  }

  /**
   * What a stopped index VM reported on its console — the one channel a VM with
   * no inbound rule and no credentials has: whether its pull failed, and the
   * indexer's exit code. A pull failure carries no exit code. A console that
   * cannot be read is "not known" for both, never a pull failure: the run then
   * ends as a stop whose code was not observed.
   */
  async function indexOutcome(
    instance: Ec2Instance,
  ): Promise<{ imagePullFailed?: true; exitCode: number | null }> {
    let output: string | null;
    try {
      output = await ec2.getConsoleOutput(instance.instanceId);
    } catch (err) {
      console.warn('[awsOrchestrator] could not read an index VM console', {
        instanceId: instance.instanceId,
        detail: err instanceof Ec2ApiError ? err.code : 'unknown',
      });
      return { exitCode: null };
    }
    if (consoleShowsPullFailure(output)) return { imagePullFailed: true, exitCode: null };
    return { exitCode: consoleExitCode(output) };
  }

  function gone(handle: ContainerHandle): ContainerStatus {
    return {
      handleId: handle.id,
      exists: false,
      state: 'destroyed',
      terminal: true,
      createdAt: handle.createdAt,
      startedAt: null,
      stoppedAt: null,
      exitCode: null,
    };
  }

  return {
    provider: 'aws',

    /** Launch one instance and return its handle at once — not waiting for it to
     *  start, as the Fly adapter does and for the same reason: every created
     *  instance is tracked from its first moment. */
    async provision(spec: ContainerSpec): Promise<ContainerHandle> {
      // Every refusal below happens before any EC2 call.
      if (spec.region && spec.region !== region) {
        throw new OrchestratorNotConfiguredError(
          `this aws account boots in ${region}, not ${spec.region}`,
        );
      }
      if (spec.size.cpus !== 2 || spec.size.memoryMb !== 8192) {
        throw new AwsInstanceSizeError(spec.size.cpus, spec.size.memoryMb);
      }
      const payload = LAUNCH_PAYLOADS[spec.workload](spec, shardTag, config);

      // THE ZONE WALK (MOTIR-9277): from this call's rotation index around the
      // list once, one RunInstances per zone, each with its own token (a refused
      // call created nothing). Only `out_of_stock` is zone-local and moves on;
      // quota and throttling are account-wide, so they — and any other refusal —
      // stop the walk at once. No zone is remembered as out of stock between
      // calls: capacity recovers in minutes, and a stale blacklist would hide it.
      const { subnets, securityGroupId } = await shardNetwork();
      const start = rotation;
      rotation += 1;
      const tried = new Set<string>();
      let outOfStock: OrchestratorCapacityError | null = null;
      for (let i = 0; i < subnets.length; i += 1) {
        const subnet = subnets[(start + i) % subnets.length]!;
        if (tried.has(subnet.zone)) continue;
        tried.add(subnet.zone);
        try {
          return toHandle(await launchInSubnet(spec, payload, subnet, securityGroupId));
        } catch (err) {
          if (!(err instanceof OrchestratorCapacityError) || err.reason !== 'out_of_stock')
            throw err;
          outOfStock = err;
        }
      }
      throw outOfStock!;
    },

    async describe(handle: ContainerHandle): Promise<ContainerStatus> {
      const instance = await readInstance(handle.id);
      if (!instance) return gone(handle);
      const index = isIndexInstance(instance);
      // An index VM that is still `stopping` has not finished: its console is read
      // once it reads `stopped`, so the code is never judged missing too early.
      const terminal =
        TERMINAL_STATES.has(instance.state) && !(index && instance.state === 'stopping');
      const stopped = instance.state === 'terminated' || terminal;
      // Only a stopped index VM is asked: one console read per stop, not per poll.
      const outcome = stopped && index ? await indexOutcome(instance) : { exitCode: null };
      if (instance.state === 'terminated') return { ...gone(handle), ...outcome };
      return {
        ...outcome,
        handleId: handle.id,
        exists: true,
        state: instance.state,
        terminal,
        createdAt: instance.launchTime ?? handle.createdAt,
        startedAt: startedAtOf(instance),
        stoppedAt: terminal ? transitionTimeOf(instance.stateTransitionReason) : null,
      };
    },

    /** Read (for the instants), terminate, then build the row. IDEMPOTENT: an id
     *  EC2 has forgotten, or an instance already terminated, still gets a row. A
     *  terminate refused for any other reason throws, and the instance lives. */
    async teardown(
      handle: ContainerHandle,
      reason: TeardownReason,
      context: UsageAttribution,
    ): Promise<ContainerUsage> {
      let instance: Ec2Instance | null = null;
      try {
        instance = await readInstance(handle.id);
      } catch (err) {
        console.warn('[awsOrchestrator] could not read an instance before teardown', {
          instanceId: handle.id,
          detail: err instanceof OrchestratorApiError ? err.message : 'unknown',
        });
      }
      await terminate(handle.id);
      return usageFor(handle, instance, reason, context);
    },

    /** The crash backstop: terminate every live instance of THIS shard carrying a
     *  fleet tag and launched before `olderThan`. Reads AWS, never memory; the
     *  shard tag keeps one shard's reaper off another's machines. */
    async reap(
      olderThan: Date,
      resolve: UsageAttributionResolver,
      spare?: ReapSparePredicate,
    ): Promise<ContainerUsage[]> {
      const filters = [
        { name: `tag:${AWS_SHARD_TAG_KEY}`, values: [shardTag] },
        { name: `tag:${FLEET_METADATA_KEY}`, values: [...FLEET_VALUE_SET] },
        // https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInstances.html
        { name: 'instance-state-name', values: LIVE_STATES },
      ];
      const found: Ec2Instance[] = [];
      let nextToken: string | undefined;
      do {
        let page;
        try {
          page = await ec2.describeInstances({ filters, maxResults: pageSize, nextToken });
        } catch (err) {
          throw apiError(err);
        }
        found.push(...page.instances);
        nextToken = page.nextToken ?? undefined;
      } while (nextToken);

      const usages: ContainerUsage[] = [];
      for (const instance of found) {
        // The filters already scope the listing; checked again so a provider that
        // ignored one could still not make this reap another shard's machine.
        if (tagOf(instance, AWS_SHARD_TAG_KEY) !== shardTag) continue;
        if (!FLEET_VALUE_SET.has(tagOf(instance, FLEET_METADATA_KEY) ?? '')) continue;
        if (!LIVE_STATES.includes(instance.state)) continue;
        if (!instance.launchTime) {
          console.warn('[awsOrchestrator] fleet instance has no launch time — not reaped', {
            instanceId: instance.instanceId,
          });
          continue;
        }
        if (instance.launchTime.getTime() >= olderThan.getTime()) continue;

        const handle = toHandle(instance);
        if (await sparedByCaller(spare, handle)) continue;
        const attribution = await resolve(handle);
        try {
          await terminate(handle.id);
        } catch (err) {
          // One refusal must not end the sweep.
          console.error('[awsOrchestrator] could not reap a fleet instance', {
            instanceId: handle.id,
            detail: err instanceof OrchestratorApiError ? err.message : 'unknown',
          });
          continue;
        }
        if (!attribution) {
          console.warn('[awsOrchestrator] reaped a fleet instance with no attributable intent', {
            instanceId: handle.id,
            launchTime: instance.launchTime.toISOString(),
          });
          continue;
        }
        usages.push(usageFor(handle, instance, 'reaped', attribution));
      }
      return usages;
    },
  };
}
