import { OrchestratorNotConfiguredError } from '../../errors';
import type { FleetInventory, InventoryMachine, PersistentContainerState } from '../../types';
import { awsApiError } from './capacityErrors';
import { Ec2ApiError, type Ec2Api, type Ec2Instance } from './ec2Client';

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

export interface AwsFleetInventoryConfig {
  /** The account's EC2 client — the same one its orchestrator launches through. */
  readonly ec2: Ec2Api;
  /** The region the account's fleet runs in, e.g. `us-east-1`. */
  readonly region: string;
  /** The account's name — the one app the inventory lists. */
  readonly accountName: string;
  /** DescribeInstances page size (EC2 takes 5–1000) — the test seam. */
  readonly pageSize?: number;
}

/** EC2 takes 5–1000 per DescribeInstances page. */
const PAGE_SIZE = 1000;

/** An id EC2 no longer knows (terminated long ago) or never knew. */
const GONE_CODES = new Set(['InvalidInstanceID.NotFound', 'InvalidInstanceID.Malformed']);

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
  const metadata: Record<string, string> = {};
  for (const tag of instance.tags) metadata[tag.key] = tag.value;
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

    async stopMachine() {
      throw new OrchestratorNotConfiguredError(
        'AWS hosts no persistent fleet machine yet, so there is nothing to stop on an AWS account',
      );
    },
  };
}
