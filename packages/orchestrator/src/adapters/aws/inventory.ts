import type { FleetInventory, InventoryMachine, InventoryVolume } from '../../types';
import { awsApiError } from './capacityErrors';
import {
  Ec2ApiError,
  type Ec2Api,
  type Ec2Instance,
  type Ec2Tag,
  type Ec2Volume,
} from './ec2Client';
import { toAwsPersistentState } from './persistent';

// THE AWS HOSTER INVENTORY (Story MOTIR-9361 · MOTIR-9476) — every machine and
// disk in ONE agent-hoster account, for the attribution reconciler.
//
// ⚠️ EVERY INSTANCE, NOT EVERY TAGGED ONE. A hoster account holds nothing but
// agent-instance machines, and the machine nobody tagged — one started by hand,
// or a launch that failed before its tags landed — is exactly the one the
// reconciler exists to find. So the listing has no tag filter.
//
// ⚠️ A FAILED LISTING THROWS, and every listing is paged to its end: a first page
// is not an inventory, and "EC2 did not answer" read as "nothing is running"
// would let a leak hide behind an outage.
//
// It needs only the account's EC2 key: no AMI, no hoster CA. A destroy is a
// TerminateInstances (the home disk, `DeleteOnTermination: false`, stays for the
// volume pass) and a disk is deleted only while it is unattached.

export interface AwsFleetInventoryConfig {
  readonly ec2: Ec2Api;
  /** The region the `ec2` client speaks to — every listed machine's region. */
  readonly region: string;
  /** The account's `motir-shard` tag value — the ONE app the account answers. */
  readonly shardTag: string;
}

/** Page size for the listings (DescribeInstances takes 5–1000, DescribeVolumes 5–500). */
export const AWS_INVENTORY_PAGE_SIZE = 200;

const GONE_INSTANCE_CODES = new Set(['InvalidInstanceID.NotFound', 'InvalidInstanceID.Malformed']);
const GONE_VOLUME_CODES = new Set(['InvalidVolume.NotFound', 'InvalidVolumeID.Malformed']);

function codeOf(err: unknown): string | null {
  return err instanceof Ec2ApiError ? err.code : null;
}

function tagRecord(tags: readonly Ec2Tag[]): Record<string, string> {
  return Object.fromEntries(tags.map((t) => [t.key, t.value]));
}

export function createAwsFleetInventory(config: AwsFleetInventoryConfig): FleetInventory {
  const { ec2, region, shardTag } = config;

  /** DescribeInstances paged to the end; terminated instances are left out by the
   *  `instance-state-name` filter
   *  (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInstances.html). */
  async function allInstances(): Promise<Ec2Instance[]> {
    const out: Ec2Instance[] = [];
    let nextToken: string | undefined;
    do {
      const page = await ec2.describeInstances({
        filters: [
          {
            name: 'instance-state-name',
            values: ['pending', 'running', 'stopping', 'stopped', 'shutting-down'],
          },
        ],
        maxResults: AWS_INVENTORY_PAGE_SIZE,
        ...(nextToken ? { nextToken } : {}),
      });
      out.push(...page.instances);
      nextToken = page.nextToken ?? undefined;
    } while (nextToken);
    return out;
  }

  /** DescribeVolumes paged to the end, every state; `CreateTime` and the
   *  attachment come with each (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeVolumes.html). */
  async function allVolumes(): Promise<Ec2Volume[]> {
    const out: Ec2Volume[] = [];
    let nextToken: string | undefined;
    do {
      const page = await ec2.describeVolumes({
        maxResults: AWS_INVENTORY_PAGE_SIZE,
        ...(nextToken ? { nextToken } : {}),
      });
      out.push(...page.volumes);
      nextToken = page.nextToken ?? undefined;
    } while (nextToken);
    return out;
  }

  return {
    provider: 'aws',

    async listApps(): Promise<string[]> {
      return [shardTag];
    },

    async listMachines(app: string): Promise<InventoryMachine[]> {
      if (app !== shardTag) return [];
      let instances: Ec2Instance[];
      try {
        instances = await allInstances();
      } catch (err) {
        throw awsApiError(err);
      }
      return instances.map((i) => {
        const tags = tagRecord(i.tags);
        return {
          app,
          machineId: i.instanceId,
          name: tags['Name'] ?? '',
          region,
          state: toAwsPersistentState(i.state),
          createdAt: i.launchTime,
          metadata: tags,
        };
      });
    },

    /** TerminateInstances; one EC2 no longer knows is already gone. */
    async destroyMachine(_app: string, machineId: string): Promise<void> {
      try {
        await ec2.terminateInstances([machineId]);
      } catch (err) {
        if (GONE_INSTANCE_CODES.has(codeOf(err) ?? '')) return;
        throw awsApiError(err);
      }
    },

    /** StopInstances — the disk stays. A machine already gone, or already
     *  stopping, is where a stop puts it. */
    async stopMachine(_app: string, machineId: string): Promise<void> {
      try {
        await ec2.stopInstances([machineId]);
      } catch (err) {
        const code = codeOf(err) ?? '';
        if (GONE_INSTANCE_CODES.has(code) || code === 'IncorrectInstanceState') return;
        throw awsApiError(err);
      }
    },

    async listVolumes(app: string): Promise<InventoryVolume[]> {
      if (app !== shardTag) return [];
      let volumes: Ec2Volume[];
      try {
        volumes = await allVolumes();
      } catch (err) {
        throw awsApiError(err);
      }
      return volumes.map((v) => ({
        volumeId: v.volumeId,
        state: v.state,
        attachedMachineId: v.attachedInstanceId,
        createdAt: v.createTime,
        tags: tagRecord(v.tags),
      }));
    },

    /** DeleteVolume; one EC2 no longer knows is already gone. An attached disk
     *  is EC2's `VolumeInUse`, thrown — never detached here. */
    async destroyVolume(_app: string, volumeId: string): Promise<void> {
      try {
        await ec2.deleteVolume(volumeId);
      } catch (err) {
        if (GONE_VOLUME_CODES.has(codeOf(err) ?? '')) return;
        throw awsApiError(err);
      }
    },
  };
}
