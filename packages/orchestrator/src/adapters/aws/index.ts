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
import { buildRunnerUserData, encodeUserData } from './userData';

export * from './userData';
export * from './capacityErrors';
export * from './credentials';
export * from './management';

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
//      runner exits and every launch says `InstanceInitiatedShutdownBehavior:
//      'terminate'`, so a finished job reads as terminal instead of billing to
//      the one-hour timeout.
//   2. A TERMINATED INSTANCE LINGERS for about an hour in DescribeInstances. It
//      reads as `exists: false, state: 'destroyed'`, the port's "gone".
//   3. THE LAUNCH CARRIES A CREDENTIAL (the JIT config, in user-data). No log
//      line, error or return value holds the payload; an EC2 failure surfaces as
//      its error CODE only (`Ec2ApiError` never copies AWS's message).
//
// ⚠️ SHARD-BLIND AND ENVIRONMENT-BLIND. The composition root reads the account's
// key and the AMI id and hands this a plain config.

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

const FLEET_VALUE_SET: ReadonlySet<string> = new Set(Object.values(FLEET_METADATA_VALUES));

export interface AwsOrchestratorConfig {
  readonly ec2: Ec2Api;
  /** The region the `ec2` client speaks to — every handle's region. */
  readonly region: string;
  /** The shard's `motir-shard` tag value — its name. Scopes discovery and reap. */
  readonly shardTag: string;
  /** The runner AMI (`MOTIR_AWS_RUNNER_AMI_ID`). */
  readonly amiId: string;
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

/** Every tag a launch writes, on the instance and its volumes in the SAME call. */
function tagsFor(spec: ContainerSpec, shardTag: string): Ec2Tag[] {
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
  ];
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
    userData: string,
    { subnetId, zone }: { subnetId: string; zone: string },
    securityGroupId: string,
  ): Promise<Ec2Instance> {
    const token = clientToken();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await ec2.runInstances({
          clientToken: token,
          imageId: amiId,
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
          instanceInitiatedShutdownBehavior: 'terminate',
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
          tags: tagsFor(spec, shardTag),
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
      const userData = encodeUserData(buildRunnerUserData(spec.env));

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
          return toHandle(await launchInSubnet(spec, userData, subnet, securityGroupId));
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
      if (!instance || instance.state === 'terminated') return gone(handle);
      const terminal = TERMINAL_STATES.has(instance.state);
      return {
        handleId: handle.id,
        exists: true,
        state: instance.state,
        terminal,
        createdAt: instance.launchTime ?? handle.createdAt,
        startedAt: startedAtOf(instance),
        stoppedAt: terminal ? transitionTimeOf(instance.stateTransitionReason) : null,
        // EC2 reports no exit status; the port documents null as an answer.
        exitCode: null,
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
