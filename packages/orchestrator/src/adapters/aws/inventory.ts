import type {
  FleetInventory,
  InventoryMachine,
  InventoryVolume,
  PersistentContainerState,
} from '../../types';
import { awsApiError } from './capacityErrors';
import { Ec2ApiError, type Ec2Api, type Ec2Instance, type Ec2Volume } from './ec2Client';

// THE AWS FLEET INVENTORY (Story MOTIR-9359 · MOTIR-9426,
// `docs/decisions/fleet-per-org-pool.md` §5) — every instance in one AWS fleet
// account's region, the AWS twin of `../fly/inventory.ts`.
//
// ⚠️ THE WHOLE REGION, NO TAG FILTER. §5 exists for the machine nobody recorded,
// and a VM started by hand carries no `motir-shard` tag, so a listing scoped to
// the tag would be blind to exactly the leak it is there to find. An account is
// one app, named for the account; its tags ride `metadata` for the alert and are
// never attribution — the reconciler matches on Motir's own records.
//
// ⚠️ A FAILED LISTING THROWS, as the port requires. It is never an empty array:
// "EC2 did not answer" read as "nothing is running" would hide a leak behind an
// outage. Errors carry the AWS error CODE only (`Ec2ApiError` never copies the
// SDK's message, which can echo user-data).
//
// An agent-hoster account's machines persist (Story MOTIR-9361 · MOTIR-9476), so
// the inventory also stops a machine and lists and deletes its disks: a stop
// keeps the disk, and a disk is deleted only while it is unattached.

export interface AwsFleetInventoryConfig {
  /** The account's EC2 client — the same one its orchestrator launches through. */
  readonly ec2: Ec2Api;
  /** The region the account's fleet runs in, e.g. `us-east-1`. */
  readonly region: string;
  /** The account's name — the one app the inventory lists. */
  readonly accountName: string;
  /** DescribeInstances / DescribeVolumes page size (EC2 takes 5–1000 and
   *  5–500) — the test seam. */
  readonly pageSize?: number;
}

/** EC2 takes 5–1000 per DescribeInstances page. */
const PAGE_SIZE = 1000;

/** EC2 takes 5–500 per DescribeVolumes page. */
const VOLUME_PAGE_SIZE = 500;

/** An id EC2 no longer knows (terminated long ago) or never knew. */
const GONE_CODES = new Set(['InvalidInstanceID.NotFound', 'InvalidInstanceID.Malformed']);

/** A disk EC2 no longer knows, or never knew. */
const GONE_VOLUME_CODES = new Set(['InvalidVolume.NotFound', 'InvalidVolumeID.Malformed']);

function tagRecord(tags: readonly { key: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(tags.map((t) => [t.key, t.value]));
}

/** EC2's instance state names in the port's vocabulary. */
const STATE: Readonly<Record<string, PersistentContainerState>> = {
  pending: 'starting',
  running: 'running',
  stopping: 'stopping',
  stopped: 'stopped',
  'shutting-down': 'gone',
  terminated: 'gone',
};

function toMachine(app: string, region: string, instance: Ec2Instance): InventoryMachine {
  const metadata = tagRecord(instance.tags);
  return {
    app,
    machineId: instance.instanceId,
    name: metadata['Name'] ?? '',
    region,
    // An unknown EC2 state is judged as a live machine, never skipped as gone.
    state: STATE[instance.state] ?? 'failed',
    createdAt: instance.launchTime,
    metadata,
  };
}

/** A `FleetInventory` over one AWS fleet account. */
export function createAwsFleetInventory(config: AwsFleetInventoryConfig): FleetInventory {
  const { ec2, region, accountName } = config;
  const pageSize = config.pageSize ?? PAGE_SIZE;
  return {
    provider: 'aws',

    async listApps() {
      return [accountName];
    },

    async listMachines(app) {
      if (app !== accountName) return [];
      const machines: InventoryMachine[] = [];
      let nextToken: string | undefined;
      do {
        let page: Awaited<ReturnType<Ec2Api['describeInstances']>>;
        try {
          page = await ec2.describeInstances({
            maxResults: pageSize,
            ...(nextToken ? { nextToken } : {}),
          });
        } catch (err) {
          throw awsApiError(err);
        }
        for (const instance of page.instances) machines.push(toMachine(app, region, instance));
        nextToken = page.nextToken ?? undefined;
      } while (nextToken);
      return machines;
    },

    async destroyMachine(_app, machineId) {
      try {
        await ec2.terminateInstances([machineId]);
      } catch (err) {
        if (err instanceof Ec2ApiError && GONE_CODES.has(err.code)) return;
        throw awsApiError(err);
      }
    },

    /** StopInstances — the disk stays. A machine already gone, or already
     *  stopping, is where a stop puts it. */
    async stopMachine(_app, machineId) {
      try {
        await ec2.stopInstances([machineId]);
      } catch (err) {
        const code = err instanceof Ec2ApiError ? err.code : '';
        if (GONE_CODES.has(code) || code === 'IncorrectInstanceState') return;
        throw awsApiError(err);
      }
    },

    async listVolumes(app) {
      if (app !== accountName) return [];
      const volumes: InventoryVolume[] = [];
      let nextToken: string | undefined;
      do {
        let page: Awaited<ReturnType<Ec2Api['describeVolumes']>>;
        try {
          page = await ec2.describeVolumes({
            maxResults: Math.min(pageSize, VOLUME_PAGE_SIZE),
            ...(nextToken ? { nextToken } : {}),
          });
        } catch (err) {
          throw awsApiError(err);
        }
        for (const v of page.volumes as Ec2Volume[]) {
          volumes.push({
            volumeId: v.volumeId,
            state: v.state,
            attachedMachineId: v.attachedInstanceId,
            createdAt: v.createTime,
            tags: tagRecord(v.tags),
          });
        }
        nextToken = page.nextToken ?? undefined;
      } while (nextToken);
      return volumes;
    },

    /** DeleteVolume; one EC2 no longer knows is already gone. An attached disk
     *  is EC2's `VolumeInUse`, thrown — never detached here. */
    async destroyVolume(_app, volumeId) {
      try {
        await ec2.deleteVolume(volumeId);
      } catch (err) {
        if (err instanceof Ec2ApiError && GONE_VOLUME_CODES.has(err.code)) return;
        throw awsApiError(err);
      }
    },
  };
}
