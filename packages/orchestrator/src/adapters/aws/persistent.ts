import { randomUUID } from 'node:crypto';
import {
  OrchestratorApiError,
  OrchestratorCapacityError,
  OrchestratorNotConfiguredError,
  type OrchestratorCapacityReason,
} from '../../errors';
import type {
  ContainerSize,
  PersistentAppInventory,
  PersistentContainerHandle,
  PersistentContainerOrchestrator,
  PersistentContainerSpec,
  PersistentContainerState,
  PersistentContainerStatus,
  PersistentExecResult,
  PersistentLivenessResult,
  PersistentMachineEvent,
  PersistentTerminalEndpoint,
} from '../../types';
import { FLEET_METADATA_KEY, FLEET_METADATA_VALUES } from '../fly';
import { INSTANCE_METADATA_KEY, instanceMachineName } from '../fly/persistent';
import { awsApiError, classifyAwsLaunchError } from './capacityErrors';
import { Ec2ApiError, type Ec2Api, type Ec2Instance, type Ec2Tag } from './ec2Client';
import { AWS_DEFAULT_INSTANCE_TYPE, AwsInstanceSizeError, transitionTimeOf } from './index';
import { AWS_SHARD_TAG_KEY } from './network';
import { buildInstanceUserData, encodeInstanceUserData } from './persistentUserData';

// The AWS adapter's PERSISTENT half (Story MOTIR-9361 · MOTIR-9469) — an agent
// instance as ONE EC2 instance and ONE EBS home disk, in one zone of one
// account, for the instance's life. This card is its lifecycle and its disk;
// the reach channel (exec, liveness, the terminal) and the upkeep (config,
// image move, the tag listing) are MOTIR-9470 / MOTIR-9479, and until they land
// those methods throw one named `not_implemented` error rather than answering.
//
// What EC2 gives differently from Fly, and how the port's guarantees still hold:
//
//   1. ONE CALL MAKES THE MACHINE AND ITS DISK. The home disk is the launch's
//      second block-device mapping with `DeleteOnTermination: false`, so it
//      exists only as part of an instance that exists: a refused RunInstances
//      leaves nothing, and "never an untracked volume" needs no clean-up call.
//   2. THE ZONE IS THE CALLER'S. The disk lives in one zone; the adapter launches
//      in `spec.availabilityZone` and never rotates — a stopped instance restarts
//      where its disk is (EC2 does that by itself), and an out-of-stock zone is
//      placement's to answer with another account.
//   3. A MACHINE THAT EXITS RESTS. `InstanceInitiatedShutdownBehavior: 'stop'`,
//      so an instance whose main process powers it off is `stopped`, like a Fly
//      machine, never terminated with its disk orphaned.
//   4. EC2 KEEPS NO EVENT LIST. The current run's start is `LaunchTime`, which
//      EC2 refreshes on every start ("The time that the instance was last
//      launched", DescribeInstances' `Instance.LaunchTime`,
//      https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Instance.html),
//      and its stop is the instant in `StateTransitionReason`
//      (`User initiated (2026-10-22 12:00:00 GMT)`). The events are synthesised
//      from those two, so the machine-minute charge reads the same interval it
//      reads on Fly.
//   5. DESTROY IS TERMINATE, WAIT, THEN DELETE. A volume cannot be deleted while
//      attached (`VolumeInUse`, DeleteVolume,
//      https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DeleteVolume.html),
//      and a terminating instance holds it until it reads `terminated`.
//
// ⚠️ SHARD-BLIND AND ENVIRONMENT-BLIND, like the ephemeral adapter: the
// composition root reads the account's key and the AMI id and hands this a plain
// config. The user-data can carry the terminal key: no log line or error holds it.

/** Where the home disk is mapped on the instance (a Nitro instance shows it as NVMe). */
export const AWS_HOME_DEVICE_NAME = '/dev/sdf';

/** The instance tag carrying the image the instance was launched with. */
export const AWS_IMAGE_TAG_KEY = 'motir_image';

/** How many times one provision sends RunInstances (same ClientToken) on a
 *  transport error or a 5xx before it gives up. */
export const AWS_PERSISTENT_LAUNCH_ATTEMPTS = 3;

/** How many reads `destroyPersistent` waits for a terminating instance. */
export const AWS_TERMINATE_WAIT_ATTEMPTS = 30;

/** How many DeleteVolume tries a volume still detaching gets. */
export const AWS_VOLUME_DELETE_ATTEMPTS = 10;

/** The pause between those reads and tries. */
export const AWS_PERSISTENT_POLL_MS = 2_000;

/** The volume capacity codes — the EC2 error-codes reference
 *  (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/errors-overview.html).
 *  The instance codes are `capacityErrors.ts`'s. */
const VOLUME_CAPACITY_REASON: ReadonlyMap<string, OrchestratorCapacityReason> = new Map([
  ['VolumeLimitExceeded', 'quota_exceeded'],
  ['InsufficientVolumeCapacity', 'out_of_stock'],
]);

const GONE_INSTANCE_CODES = new Set(['InvalidInstanceID.NotFound', 'InvalidInstanceID.Malformed']);
const GONE_VOLUME_CODES = new Set(['InvalidVolume.NotFound', 'InvalidVolumeID.Malformed']);

/** A spec this adapter cannot launch — refused before any EC2 call. */
export class AwsPersistentSpecError extends Error {
  readonly code = 'AWS_PERSISTENT_SPEC_REFUSED' as const;
  constructor(readonly reason: 'missing_zone') {
    super('An AWS agent instance needs the availability zone its disk will live in.');
    this.name = 'AwsPersistentSpecError';
  }
}

export interface AwsPersistentOrchestratorConfig {
  readonly ec2: Ec2Api;
  /** The region the `ec2` client speaks to — every handle's region. */
  readonly region: string;
  /** The account's `motir-shard` tag value — its name, and every handle's app. */
  readonly shardTag: string;
  /** The hoster AMI (`MOTIR_AWS_HOSTER_AMI_ID`). */
  readonly amiId: string;
  /** The instance type for a size; null refuses the size. Default: the fleet's
   *  one size (2 vCPU / 8 GiB) as {@link AWS_DEFAULT_INSTANCE_TYPE}. */
  readonly instanceTypeFor?: (size: ContainerSize) => string | null;
  /** A fresh idempotency token per provision — the test seam. */
  readonly clientToken?: () => string;
  /** The clock — the test seam. */
  readonly now?: () => Date;
  /** The pause between polls — the test seam. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function defaultInstanceType(size: ContainerSize): string | null {
  return size.cpus === 2 && size.memoryMb === 8192 ? AWS_DEFAULT_INSTANCE_TYPE : null;
}

function codeOf(err: unknown): string | null {
  return err instanceof Ec2ApiError ? err.code : null;
}

/** EC2's instance state in the INSTANCE vocabulary. */
export function toAwsPersistentState(state: string): PersistentContainerState {
  switch (state) {
    case 'pending':
      return 'starting';
    case 'running':
      return 'running';
    case 'stopping':
    case 'shutting-down':
      return 'stopping';
    case 'stopped':
      return 'stopped';
    case 'terminated':
      return 'gone';
    default:
      // An unknown state is still in motion — the sweep asks again.
      return 'starting';
  }
}

/** A launch or start refusal: the instance capacity table, then the volume one. */
function classifyCapacity(err: unknown, zone: string | null): OrchestratorApiError {
  const volumeReason = err instanceof Ec2ApiError ? VOLUME_CAPACITY_REASON.get(err.code) : null;
  if (volumeReason && err instanceof Ec2ApiError) {
    return new OrchestratorCapacityError('aws', err.httpStatus, volumeReason, zone, err.code);
  }
  return classifyAwsLaunchError(err, zone);
}

function notImplemented(): never {
  throw new OrchestratorApiError('aws', 501, 'not_implemented');
}

function tagOf(instance: Ec2Instance, key: string): string | undefined {
  return instance.tags.find((t) => t.key === key)?.value;
}

/** An AWS persistent adapter for ONE account (one region). */
export function createAwsPersistentOrchestrator(
  config: AwsPersistentOrchestratorConfig,
): PersistentContainerOrchestrator {
  const { ec2, region, shardTag, amiId } = config;
  const instanceTypeFor = config.instanceTypeFor ?? defaultInstanceType;
  const clientToken = config.clientToken ?? (() => randomUUID());
  const now = config.now ?? (() => new Date());
  const sleep =
    config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  function tagsFor(spec: PersistentContainerSpec): Ec2Tag[] {
    return [
      { key: AWS_SHARD_TAG_KEY, value: shardTag },
      { key: FLEET_METADATA_KEY, value: FLEET_METADATA_VALUES.agent_instance },
      { key: INSTANCE_METADATA_KEY, value: spec.instanceId },
      { key: 'motir_org_id', value: spec.orgId },
      { key: 'motir_project_id', value: spec.projectId },
      { key: 'Name', value: instanceMachineName(spec.instanceId) },
      { key: AWS_IMAGE_TAG_KEY, value: spec.image },
    ];
  }

  /** The account's subnet in `zone` and its security group, found by tag. */
  async function networkIn(zone: string): Promise<{ subnetId: string; securityGroupId: string }> {
    const byTag = { name: `tag:${AWS_SHARD_TAG_KEY}`, values: [shardTag] };
    let subnets, groups;
    try {
      subnets = await ec2.describeSubnets([byTag, { name: 'availability-zone', values: [zone] }]);
      groups = await ec2.describeSecurityGroups([byTag]);
    } catch (err) {
      throw awsApiError(err);
    }
    const where = `${AWS_SHARD_TAG_KEY}=${shardTag} in ${zone} (${region})`;
    if (subnets.length === 0) {
      throw new OrchestratorNotConfiguredError(`no subnet is tagged ${where}`);
    }
    if (groups.length !== 1) {
      throw new OrchestratorNotConfiguredError(
        `${groups.length === 0 ? 'no' : 'more than one'} security group is tagged ${shardTag} in ${region}`,
      );
    }
    return { subnetId: subnets[0]!.subnetId, securityGroupId: groups[0]!.groupId };
  }

  /** The instance, or null when EC2 no longer knows it. Other failures throw. */
  async function readInstance(id: string): Promise<Ec2Instance | null> {
    try {
      const { instances } = await ec2.describeInstances({ instanceIds: [id] });
      return instances[0] ?? null;
    } catch (err) {
      if (GONE_INSTANCE_CODES.has(codeOf(err) ?? '')) return null;
      throw awsApiError(err);
    }
  }

  function homeVolumeOf(instance: Ec2Instance | null): string | null {
    return instance?.volumes?.find((v) => v.deviceName === AWS_HOME_DEVICE_NAME)?.volumeId ?? null;
  }

  /** Terminate; an id EC2 no longer knows is already gone. */
  async function terminate(id: string): Promise<void> {
    try {
      await ec2.terminateInstances([id]);
    } catch (err) {
      if (GONE_INSTANCE_CODES.has(codeOf(err) ?? '')) return;
      throw awsApiError(err);
    }
  }

  /** Wait until EC2 reports the instance terminated (or forgotten). */
  async function awaitTerminated(id: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const instance = await readInstance(id);
      if (!instance || instance.state === 'terminated') return;
      if (attempt >= AWS_TERMINATE_WAIT_ATTEMPTS) {
        // The disk is never touched while its machine may still hold it.
        throw new OrchestratorApiError('aws', null, 'InstanceNotTerminated');
      }
      await sleep(AWS_PERSISTENT_POLL_MS);
    }
  }

  /** Delete a volume; one EC2 no longer knows is already gone. A volume still
   *  detaching from a terminated instance is retried, bounded. */
  async function deleteVolume(id: string, retryInUse: boolean): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await ec2.deleteVolume(id);
        return;
      } catch (err) {
        const code = codeOf(err) ?? '';
        if (GONE_VOLUME_CODES.has(code)) return;
        if (!retryInUse || code !== 'VolumeInUse' || attempt >= AWS_VOLUME_DELETE_ATTEMPTS) {
          throw awsApiError(err);
        }
      }
      await sleep(AWS_PERSISTENT_POLL_MS);
    }
  }

  /**
   * ONE RunInstances, retried with the SAME token on a transport error or 5xx:
   * EC2 answers a repeated ClientToken with the instance it already made
   * (https://docs.aws.amazon.com/AWSEC2/latest/devguide/ec2-api-idempotency.html),
   * so an ambiguous timeout cannot make two. A capacity refusal is never resent.
   */
  async function launch(
    spec: PersistentContainerSpec,
    zone: string,
    instanceType: string,
    userData: string,
  ): Promise<Ec2Instance> {
    const { subnetId, securityGroupId } = await networkIn(zone);
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
          // The ephemeral adapter's lockdown: IMDSv2 only, one hop, so no
          // container reaches the metadata service (and the user-data in it). No
          // IamInstanceProfile and no KeyName are ever sent.
          metadataOptions: {
            httpTokens: 'required',
            httpPutResponseHopLimit: 1,
            httpEndpoint: 'enabled',
          },
          instanceInitiatedShutdownBehavior: 'stop',
          blockDeviceMappings: [
            {
              deviceName: AWS_HOME_DEVICE_NAME,
              volumeSizeGb: spec.volumeSizeGb,
              volumeType: 'gp3',
              deleteOnTermination: false,
            },
          ],
          tags: tagsFor(spec),
        });
      } catch (err) {
        const capacity = classifyCapacity(err, zone);
        const retryable =
          err instanceof Ec2ApiError &&
          err.retryable &&
          !(capacity instanceof OrchestratorCapacityError);
        if (!retryable || attempt >= AWS_PERSISTENT_LAUNCH_ATTEMPTS) throw capacity;
      }
    }
  }

  function gone(handle: PersistentContainerHandle): PersistentContainerStatus {
    return {
      machineId: handle.machineId,
      state: 'gone',
      providerState: '',
      startedAt: null,
      stoppedAt: null,
      events: [],
    };
  }

  return {
    provider: 'aws',

    /** One account is one app: every handle names the account. */
    appNameFor(): string {
      return shardTag;
    },

    defaultRegion(): string {
      return region;
    },

    async provisionPersistent(spec: PersistentContainerSpec): Promise<PersistentContainerHandle> {
      // Every refusal below happens before any EC2 call.
      const zone = spec.availabilityZone;
      if (!zone) throw new AwsPersistentSpecError('missing_zone');
      if (spec.region && spec.region !== region) {
        throw new OrchestratorNotConfiguredError(
          `this aws account boots in ${region}, not ${spec.region}`,
        );
      }
      const instanceType = instanceTypeFor(spec.size);
      if (!instanceType) throw new AwsInstanceSizeError(spec.size.cpus, spec.size.memoryMb);
      const userData = encodeInstanceUserData(buildInstanceUserData(spec));

      const launched = await launch(spec, zone, instanceType, userData);
      // RunInstances answers the mapping it made; when it did not, describe it.
      const volumeId =
        homeVolumeOf(launched) ?? homeVolumeOf(await readInstance(launched.instanceId));
      if (!volumeId) {
        // Not a handle Motir could ever destroy the disk of: give the machine
        // back now, and leave the disk to the reconciler's tag listing.
        await terminate(launched.instanceId);
        throw new OrchestratorApiError('aws', null, 'MissingField.HomeVolume');
      }
      return {
        provider: 'aws',
        app: shardTag,
        machineId: launched.instanceId,
        volumeId,
        region,
        createdAt: launched.launchTime ?? now(),
      };
    },

    /** StopInstances — the disk stays. A stopped or stopping machine, and one EC2
     *  no longer knows, are already where a stop puts them. */
    async stop(handle: PersistentContainerHandle): Promise<void> {
      try {
        await ec2.stopInstances([handle.machineId]);
      } catch (err) {
        if (GONE_INSTANCE_CODES.has(codeOf(err) ?? '')) return;
        if (codeOf(err) === 'IncorrectInstanceState') {
          const instance = await readInstance(handle.machineId);
          const state = instance ? toAwsPersistentState(instance.state) : 'gone';
          if (state === 'stopped' || state === 'stopping' || state === 'gone') return;
        }
        throw awsApiError(err);
      }
    },

    /** StartInstances — the same instance, in its own zone, with its disk. A
     *  running or pending machine is already started; a capacity refusal is typed. */
    async start(handle: PersistentContainerHandle): Promise<void> {
      try {
        await ec2.startInstances([handle.machineId]);
      } catch (err) {
        if (codeOf(err) === 'IncorrectInstanceState') {
          const instance = await readInstance(handle.machineId);
          const state = instance ? toAwsPersistentState(instance.state) : 'gone';
          if (state === 'running' || state === 'starting') return;
        }
        throw classifyCapacity(err, null);
      }
    },

    async describePersistent(
      handle: PersistentContainerHandle,
    ): Promise<PersistentContainerStatus> {
      const instance = await readInstance(handle.machineId);
      if (!instance || instance.state === 'terminated') return gone(handle);
      const state = toAwsPersistentState(instance.state);
      const startedAt = instance.state === 'pending' ? null : instance.launchTime;
      const stoppedAt =
        instance.state === 'stopped' ? transitionTimeOf(instance.stateTransitionReason) : null;
      const events: PersistentMachineEvent[] = [
        ...(startedAt ? [{ type: 'start', status: 'started', at: startedAt }] : []),
        ...(stoppedAt ? [{ type: 'stop', status: 'stopped', at: stoppedAt }] : []),
      ].sort((a, b) => a.at.getTime() - b.at.getTime());
      return {
        machineId: handle.machineId,
        state,
        providerState: instance.state,
        startedAt,
        stoppedAt,
        events,
        image: tagOf(instance, AWS_IMAGE_TAG_KEY) ?? null,
      };
    },

    /** Terminate, wait for `terminated`, THEN delete the disk. Idempotent: a gone
     *  machine still has its disk taken; a gone disk is done. */
    async destroyPersistent(handle: PersistentContainerHandle): Promise<void> {
      await terminate(handle.machineId);
      await awaitTerminated(handle.machineId);
      await deleteVolume(handle.volumeId, true);
    },

    /** Terminate one machine by id — the reconciler's orphan clean-up. Its disk
     *  (DeleteOnTermination false) stays for `destroyVolume`. */
    async destroyMachine(_app: string, machineId: string): Promise<void> {
      await terminate(machineId);
    },

    /** Delete one disk by id — the reconciler's orphan clean-up. A disk still
     *  in use is refused, never force-detached from a machine that may own it. */
    async destroyVolume(_app: string, volumeId: string): Promise<void> {
      await deleteVolume(volumeId, false);
    },

    // ── MOTIR-9470 (reach) and MOTIR-9479 (upkeep) ─────────────────────────────
    listPersistent(): Promise<PersistentAppInventory> {
      return Promise.resolve().then(notImplemented);
    },
    exec(): Promise<PersistentExecResult> {
      return Promise.resolve().then(notImplemented);
    },
    ensureMachineConfig(): Promise<'updated' | 'current'> {
      return Promise.resolve().then(notImplemented);
    },
    terminalEndpoint(): PersistentTerminalEndpoint {
      return notImplemented();
    },
    moveImage(): Promise<void> {
      return Promise.resolve().then(notImplemented);
    },
    checkLiveness(): Promise<PersistentLivenessResult> {
      return Promise.resolve().then(notImplemented);
    },
  };
}
