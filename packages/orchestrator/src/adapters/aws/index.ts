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
  ContainerCapacity,
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
  awsSpotRefusal,
  classifyAwsLaunchError,
  isAwsCapacityCode,
} from './capacityErrors';
import { AWS_SHARD_TAG_KEY } from './network';
import { buildContainerUserData, buildRunnerUserData, encodeUserData } from './userData';

export * from './userData';
export * from './capacityErrors';
export * from './credentials';
export * from './management';
export * from './stackSet';
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
//      'terminate'`, so a finished job reads as terminal instead of billing to
//      the one-hour timeout.
//   2. A TERMINATED INSTANCE LINGERS for about an hour in DescribeInstances. It
//      reads as `exists: false, state: 'destroyed'`, the port's "gone".
//   3. THE LAUNCH CARRIES A CREDENTIAL (the JIT config, in user-data). No log
//      line, error or return value holds the payload; an EC2 failure surfaces as
//      its error CODE only (`Ec2ApiError` never copies AWS's message).
//
// A CI RUNNER MAY LAUNCH AS SPOT (MOTIR-11716). A `ci_runner` spec asking
// `capacity: 'spot'` walks the adapter's ordered Spot instance types first — each
// with the zone walk, on the Spot market — and launches on-demand, exactly as
// without Spot, the moment no Spot is to be had. Every other launch sends the
// request it always sent. The type names live in this config, never on the port.
//
// ⚠️ SHARD-BLIND AND ENVIRONMENT-BLIND. The composition root reads the account's
// key and the AMI id and hands this a plain config.

/** The machine class the fleet's one size maps to — 2 vCPU / 8 GiB, x86. */
export const AWS_DEFAULT_INSTANCE_TYPE = 'm6i.large';

/**
 * The ON-DEMAND instance type an ARM64 CI runner boots (MOTIR-11782): Graviton3,
 * 2 vCPU / 8 GiB — the same size class `ci-minutes-allowance.md` §M fixes for the
 * x86 runner. Overridden by {@link AwsOrchestratorConfig.arm64InstanceType}. An
 * arm64 launch is never Spot: the Spot list is x86 only, so a Spot walk could
 * only ever send an arm64 image to an x86 type.
 */
export const AWS_DEFAULT_ARM64_INSTANCE_TYPE = 'm7g.large';

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

/**
 * EC2's `StateReason.Code` for a Spot instance it terminated to take the capacity
 * back (MOTIR-11728): "The instance was terminated because the number of Spot
 * requests with a maximum price equal to or higher than the Spot price exceeded
 * available capacity or because of an increase in the Spot price."
 * https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_StateReason.html
 */
const SPOT_TERMINATION_CODE = 'Server.SpotInstanceTermination';

/** `InstanceLifecycle` of a Spot instance (absent on an on-demand one).
 *  https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Instance.html */
const SPOT_LIFECYCLE = 'spot';

/**
 * Whether EC2 RECLAIMED this instance for Spot capacity (MOTIR-11728): it was a
 * Spot instance AND its state-reason code is the Spot termination code. Read
 * from the structured fields only, never from the free-text reason; our own
 * terminate (`Client.UserInitiatedShutdown`), a health check, or an on-demand
 * instance never qualify. Only a `shutting-down` or `terminated` instance can be.
 */
function reclaimedBySpot(instance: Ec2Instance): boolean {
  return (
    (instance.state === 'terminated' || instance.state === 'shutting-down') &&
    instance.instanceLifecycle === SPOT_LIFECYCLE &&
    instance.stateReasonCode === SPOT_TERMINATION_CODE
  );
}

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

/** EC2's limit on a tag value. A longer value is cut to it, never dropped. */
export const AWS_TAG_VALUE_MAX = 256;

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
  /** The ARM64 runner AMI (`MOTIR_AWS_RUNNER_ARM64_AMI_ID`, MOTIR-11782). Unset
   *  refuses an arm64 `ci_runner` spec before any EC2 call — never a fallback to
   *  {@link amiId}, which is an x86 image. */
  readonly arm64AmiId?: string;
  /** Overrides {@link AWS_DEFAULT_ARM64_INSTANCE_TYPE}. */
  readonly arm64InstanceType?: string;
  /** Overrides {@link AWS_DEFAULT_INSTANCE_TYPE}. The ON-DEMAND type: every
   *  launch that is not Spot, and a Spot launch's fallback. */
  readonly instanceType?: string;
  /**
   * The ORDERED instance types a CI runner asking for Spot walks (MOTIR-11716),
   * first to last — or a read of them, called once per such launch so a changed
   * setting applies to the next launch without rebuilding the adapter. Unset, or
   * an empty list, means this account launches no Spot: such a spec goes
   * straight to on-demand.
   */
  readonly spotInstanceTypes?: readonly string[] | (() => Promise<readonly string[]>);
  /** Overrides {@link AWS_REAP_PAGE_SIZE}. */
  readonly reapPageSize?: number;
  /** A fresh idempotency token per provision — the test seam. */
  readonly clientToken?: () => string;
  /** The clock — the test seam. */
  readonly now?: () => Date;
  /** A network NAMED by configuration instead of found by the shard tag — the
   *  install fleet's subnets and group, which its infrastructure defines and
   *  passes as values (MOTIR-10794). Each subnet is its own rotation stop. */
  readonly network?: AwsExplicitNetwork;
}

/** Subnets and a security group given as ids (MOTIR-10794). */
export interface AwsExplicitNetwork {
  readonly subnetIds: readonly string[];
  readonly securityGroupId: string;
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

/** Every tag a launch writes, on the instance and its volumes in the SAME call.
 *  Each value is cut to EC2's limit. */
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

/** The market and type ONE attempt launches on. No `market` = on-demand. */
interface LaunchMarket {
  readonly instanceType: string;
  readonly market?: 'spot';
}

/** What one launch sends: the base64 user-data and the tags, and — for an
 *  arm64 runner — its own image and type. */
interface LaunchPayload {
  readonly userData: string;
  readonly tags: Ec2Tag[];
  /** The AMI; omitted means the runner AMI (`amiId`). */
  readonly imageId?: string;
  /**
   * The on-demand instance type; omitted means the adapter's x86 type. Set only
   * TOGETHER with {@link imageId} by an architecture branch (MOTIR-11782), so no
   * path can pair an arm64 image with an x86 type or the reverse.
   */
  readonly instanceType?: string;
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
    config: Pick<AwsOrchestratorConfig, 'arm64AmiId' | 'arm64InstanceType'>,
  ) => LaunchPayload
> = {
  ci_runner: (spec, shardTag, { arm64AmiId, arm64InstanceType }) => {
    const base = {
      userData: encodeUserData(buildRunnerUserData(spec.env)),
      tags: tagsFor(spec, shardTag),
    };
    if (spec.architecture !== 'arm64') return base;
    // ONE branch picks the arm64 image and the arm64 type together (MOTIR-11782).
    if (!arm64AmiId) {
      throw new OrchestratorNotConfiguredError(
        'this aws account has no arm64 runner AMI (set MOTIR_AWS_RUNNER_ARM64_AMI_ID)',
      );
    }
    return {
      ...base,
      imageId: arm64AmiId,
      instanceType: arm64InstanceType ?? AWS_DEFAULT_ARM64_INSTANCE_TYPE,
    };
  },
  hosted_agent: (spec, shardTag) => {
    const userData = buildContainerUserData({ image: spec.image, env: spec.env });
    // The builder has refused a spec with no run id, so this is set.
    const runId = spec.env['MOTIR_DISPATCH_RUN_ID']!;
    return {
      userData: encodeUserData(userData),
      tags: hostedAgentTagsFor(spec, shardTag, runId),
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
    if (config.network) {
      // Named, not found: no EC2 read, and each subnet is one stop of the walk.
      return {
        subnets: config.network.subnetIds.map((subnetId) => ({ subnetId, zone: subnetId })),
        securityGroupId: config.network.securityGroupId,
        readAt: now().getTime(),
      };
    }
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
   * A refusal throws AS EC2 ANSWERED IT: the on-demand walk classifies it, the
   * Spot walk reads its code.
   */
  async function launchInSubnet(
    spec: ContainerSpec,
    { userData, tags, imageId }: LaunchPayload,
    { subnetId }: { subnetId: string; zone: string },
    securityGroupId: string,
    launch: LaunchMarket,
  ): Promise<Ec2Instance> {
    const token = clientToken();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await ec2.runInstances({
          clientToken: token,
          imageId: imageId ?? amiId,
          instanceType: launch.instanceType,
          subnetId,
          securityGroupIds: [securityGroupId],
          userData,
          // IMDSv2 only, one hop: a container on the VM cannot reach the
          // metadata service, which holds the user-data and so the JIT config.
          // No KeyName and no instance profile is ever sent.
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
          tags,
          // Only a Spot attempt names a market; on-demand sends none, as ever.
          ...(launch.market ? { market: launch.market } : {}),
        });
      } catch (err) {
        const retryable =
          err instanceof Ec2ApiError && err.retryable && !isAwsCapacityCode(err.code);
        if (!retryable || attempt >= AWS_LAUNCH_ATTEMPTS) {
          if (err instanceof Ec2ApiError && STALE_NETWORK_CODES.has(err.code)) network = null;
          throw err;
        }
      }
    }
  }

  /**
   * THE ZONE WALK (MOTIR-9277): from `start` around the list once, one
   * RunInstances per zone, each with its own token (a refused call created
   * nothing). Only `out_of_stock` is zone-local and moves on; quota and
   * throttling are account-wide, so they — and any other refusal — stop the walk
   * at once, classified. No zone is remembered as out of stock between calls:
   * capacity recovers in minutes, and a stale blacklist would hide it.
   */
  async function zoneWalk(
    spec: ContainerSpec,
    payload: LaunchPayload,
    { subnets, securityGroupId }: ShardNetwork,
    start: number,
    launch: LaunchMarket,
  ): Promise<Ec2Instance> {
    const tried = new Set<string>();
    let outOfStock: OrchestratorCapacityError | null = null;
    for (let i = 0; i < subnets.length; i += 1) {
      const subnet = subnets[(start + i) % subnets.length]!;
      if (tried.has(subnet.zone)) continue;
      tried.add(subnet.zone);
      try {
        return await launchInSubnet(spec, payload, subnet, securityGroupId, launch);
      } catch (raw) {
        const err = classifyAwsLaunchError(raw, subnet.zone);
        if (!(err instanceof OrchestratorCapacityError) || err.reason !== 'out_of_stock') throw err;
        outOfStock = err;
      }
    }
    throw outOfStock!;
  }

  /** The ordered Spot types for this launch; a read that fails is no Spot. */
  async function spotTypes(): Promise<readonly string[]> {
    const source = config.spotInstanceTypes;
    if (!source) return [];
    if (typeof source !== 'function') return source;
    try {
      return await source();
    } catch {
      console.warn('[awsOrchestrator] the Spot instance types could not be read — on-demand', {
        shardTag,
      });
      return [];
    }
  }

  /**
   * THE SPOT TYPE WALK (MOTIR-11716): each type in order, each with the zone walk
   * on the Spot market and its own token per attempt. A zone with no spare
   * capacity moves to the next zone, a type refused in every zone to the next
   * type. The instance, or null when no Spot is to be had — every type refused,
   * the account's Spot limit, or a refusal that is no capacity code — and the
   * caller then launches on-demand at once: no wait, and nothing remembered
   * between calls. A throttled attempt throws `throttled`: the rate limit is the
   * account's, and an on-demand call would only add to it.
   */
  async function spotWalk(
    spec: ContainerSpec,
    payload: LaunchPayload,
    { subnets, securityGroupId }: ShardNetwork,
    start: number,
  ): Promise<Ec2Instance | null> {
    const types = await spotTypes();
    for (const type of types) {
      const tried = new Set<string>();
      for (let i = 0; i < subnets.length; i += 1) {
        const subnet = subnets[(start + i) % subnets.length]!;
        if (tried.has(subnet.zone)) continue;
        tried.add(subnet.zone);
        try {
          return await launchInSubnet(spec, payload, subnet, securityGroupId, {
            instanceType: type,
            market: 'spot',
          });
        } catch (err) {
          // The CODE only — never AWS's message, which can echo user-data.
          const code = err instanceof Ec2ApiError ? err.code : 'UnknownError';
          const move = awsSpotRefusal(code);
          if (move === 'next_zone') continue;
          if (move === 'throttled') throw classifyAwsLaunchError(err, subnet.zone);
          console.warn('[awsOrchestrator] Spot refused — launching on-demand', {
            shardTag,
            instanceType: type,
            zone: subnet.zone,
            code,
          });
          return null;
        }
      }
    }
    if (types.length > 0) {
      console.warn('[awsOrchestrator] no Spot capacity of any type — launching on-demand', {
        shardTag,
        instanceTypes: types,
      });
    }
    return null;
  }

  function toHandle(instance: Ec2Instance, capacity?: ContainerCapacity): ContainerHandle {
    return {
      provider: 'aws',
      id: instance.instanceId,
      region,
      // A handle with no instant cannot be reaped by age; now is the honest floor.
      createdAt: instance.launchTime ?? now(),
      ...(capacity ? { capacity } : {}),
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
      // Only a CI runner has an arm64 image; every other workload refuses one
      // rather than boot it on x86 (MOTIR-11782).
      if (spec.architecture === 'arm64' && spec.workload !== 'ci_runner') {
        throw new OrchestratorNotConfiguredError(
          `the aws orchestrator boots no arm64 ${spec.workload}`,
        );
      }
      const payload = LAUNCH_PAYLOADS[spec.workload](spec, shardTag, config);

      // From this call's rotation index around the zones, for every walk below.
      const shard = await shardNetwork();
      const start = rotation;
      rotation += 1;
      const onDemand: LaunchMarket = { instanceType: payload.instanceType ?? instanceType };
      // Only an x86 CI runner is ever Spot: every other workload, an arm64 runner
      // (the Spot list is x86 only — MOTIR-11782) and a runner not asking for it
      // send exactly the request they sent before Spot existed.
      if (
        spec.workload !== 'ci_runner' ||
        spec.capacity !== 'spot' ||
        spec.architecture === 'arm64'
      ) {
        return toHandle(await zoneWalk(spec, payload, shard, start, onDemand));
      }
      const spot = await spotWalk(spec, payload, shard, start);
      if (spot) return toHandle(spot, 'spot');
      // No Spot to be had: ONE on-demand launch, today's walk, at once.
      return toHandle(await zoneWalk(spec, payload, shard, start, onDemand), 'on_demand');
    },

    async describe(handle: ContainerHandle): Promise<ContainerStatus> {
      const instance = await readInstance(handle.id);
      if (!instance) return gone(handle);
      const terminal = TERMINAL_STATES.has(instance.state);
      // EC2 keeps a terminated instance describable for a while after it ends,
      // and supervision polls far more often than that — so WHY it ended is read
      // here, while it still can be (MOTIR-11728).
      const reclaim = reclaimedBySpot(instance) ? { reclaimed: true } : {};
      if (instance.state === 'terminated') return { ...gone(handle), ...reclaim };
      return {
        exitCode: null,
        ...reclaim,
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
