import {
  AWS_DEFAULT_INSTANCE_TYPE,
  OrchestratorNotConfiguredError,
  type FleetWorkloadKind,
} from '@motir/orchestrator';
import { isCloud } from '@/lib/billing/availability';

// THE INSTALL FLEET (Story MOTIR-10792 · MOTIR-10794) — the VMs the install's
// OWN organisation runs on, in core's own AWS account, with no pool account, no
// `fleet_shard` row and no shared or org cap. The install's own organisation is
// the meta org on Motir cloud and, with cloud off, the install's one org (any
// org). Four kinds may run there — the CI runner (MOTIR-11232), the index, the
// agent host and the agent run — and only those `MOTIR_INSTALL_FLEET_KINDS`
// lists. A 1-account self-host has no pool account at all, so its own CI has to
// run here; Motir's own production uses the same shape.
//
// motir-infra (MOTIR-10793) defines the subnets, the security group and the VM
// instance profile and passes them to core's tasks under the names below. Core
// launches with its own task-role credentials: nothing is assumed.
//
// ⚠️ NO ROW, SO A PSEUDO-ACCOUNT ID. Every boot path resolves "where does this
// container live" through one account id (`fleetShardOrchestratorService.forShard`),
// and a session memo carries it across steps. The install fleet's is
// {@link INSTALL_FLEET_SHARD_ID}: it lives in memory and in memos only, and is
// never written to a `fleet_shard_id` column — every row of an install-fleet
// container carries null there, as the card requires. A CI runner's intent says
// it is on the install fleet with its own `install_fleet` flag
// ({@link ciRunnerIntentShardId}).

export const INSTALL_FLEET_KINDS_ENV = 'MOTIR_INSTALL_FLEET_KINDS';
export const INSTALL_FLEET_SUBNET_IDS_ENV = 'MOTIR_INSTALL_FLEET_SUBNET_IDS';
export const INSTALL_FLEET_SECURITY_GROUP_ID_ENV = 'MOTIR_INSTALL_FLEET_SECURITY_GROUP_ID';
export const INSTALL_FLEET_INSTANCE_PROFILE_ARN_ENV = 'MOTIR_INSTALL_FLEET_INSTANCE_PROFILE_ARN';
export const INSTALL_FLEET_REGION_ENV = 'MOTIR_INSTALL_FLEET_REGION';

/** The install fleet's pseudo-account id — never a `fleet_shard` row's (a cuid). */
export const INSTALL_FLEET_SHARD_ID = 'install-fleet';

/** The `motir-shard` tag every install-fleet VM AND its volumes carry, and the
 *  `app` of its agent instances' handles: what the reconciler and the routing
 *  find it by. motir-infra's grants (MOTIR-10793) are conditioned on exactly
 *  this value — a launch without it is refused. */
export const INSTALL_FLEET_TAG = 'motir-install-fleet';

/** The kinds the install fleet can run at all. */
const ELIGIBLE: ReadonlySet<FleetWorkloadKind> = new Set<FleetWorkloadKind>([
  'ci_runner',
  'code_graph_index',
  'agent_instance',
  'hosted_agent',
]);

/** The kinds the install fleet can run at all, in the Fleet status page's order
 *  (Monitoring's): CI runner, agent runner, indexer, agent hoster. */
export const INSTALL_FLEET_ELIGIBLE_KINDS: readonly FleetWorkloadKind[] = [
  'ci_runner',
  'hosted_agent',
  'code_graph_index',
  'agent_instance',
];

/**
 * vCPU per EC2 instance type the install fleet boots (MOTIR-10887). A type not
 * listed has no known size, and the Fleet status page shows its vCPU as Not
 * available rather than guessing one.
 */
export const EC2_INSTANCE_TYPE_VCPU: Readonly<Record<string, number>> = {
  'm6i.large': 2,
};

/**
 * The instance type an install-fleet VM of this kind boots. Every kind boots the
 * AWS adapters' default: `installFleetOrchestrator` names no type for a CI
 * runner, an index or an agent run, and the persistent adapter maps the agent host's one size
 * (`FLEET_CONTAINER_SIZE`) to the same type.
 */
export function installFleetInstanceType(_kind: FleetWorkloadKind): string {
  return AWS_DEFAULT_INSTANCE_TYPE;
}

/** vCPU of one VM of an EC2 instance type, or null when the type's size is not known here. */
export function ec2InstanceTypeVcpu(type: string): number | null {
  return EC2_INSTANCE_TYPE_VCPU[type] ?? null;
}

/** vCPU of one install-fleet VM of this kind, or null when its type's size is unknown. */
export function installFleetMachineVcpu(kind: FleetWorkloadKind): number | null {
  return ec2InstanceTypeVcpu(installFleetInstanceType(kind));
}

/** Is this the install fleet's pseudo-account id? */
export function isInstallFleetShardId(id: string | null | undefined): boolean {
  return id === INSTALL_FLEET_SHARD_ID;
}

/**
 * The account id a CI runner's container is reached through (MOTIR-11232): the
 * install fleet's pseudo-account id when its intent is on the install fleet,
 * else the account the intent recorded (null = the process-wide fleet). The one
 * read every CI path — supervision, settle, stop, reap, the vanished sweep —
 * resolves an intent's orchestrator by, so none of them can mistake an
 * install-fleet runner (no account row) for one on the process-wide fleet.
 */
export function ciRunnerIntentShardId(intent: {
  fleetShardId: string | null;
  installFleet: boolean;
}): string | null {
  return intent.installFleet ? INSTALL_FLEET_SHARD_ID : intent.fleetShardId;
}

/**
 * What a `fleet_shard_id` column records for the account a container booted on:
 * the account's id, or null for the install fleet and the process-wide fleet —
 * the never-written contract above (MOTIR-10858). The pseudo-account id has no
 * `fleet_shard` row, so writing it would break the column's foreign key.
 */
export function fleetShardIdForColumn(id: string | null | undefined): string | null {
  if (id === null || id === undefined || isInstallFleetShardId(id)) return null;
  return id;
}

/**
 * Was this container placed on the install fleet? Its row records no account
 * (`fleet_shard_id` is null) and its handle's app is the install fleet's tag
 * (MOTIR-10794). A null account with any other app is the process-wide lane.
 */
export function isOnInstallFleet(placement: {
  fleetShardId: string | null;
  flyApp?: string | null;
}): boolean {
  return placement.fleetShardId === null && placement.flyApp === INSTALL_FLEET_TAG;
}

/** The kinds `MOTIR_INSTALL_FLEET_KINDS` lists that the install fleet can run.
 *  Unset or empty: none, and every placement is as before. Read per call. */
export function installFleetKinds(): ReadonlySet<FleetWorkloadKind> {
  const raw = process.env[INSTALL_FLEET_KINDS_ENV] ?? '';
  const kinds = raw
    .split(',')
    .map((kind) => kind.trim())
    .filter((kind): kind is FleetWorkloadKind => ELIGIBLE.has(kind as FleetWorkloadKind));
  return new Set(kinds);
}

/** Does the install fleet take this kind on this deployment? */
export function installFleetTakesKind(kind: FleetWorkloadKind): boolean {
  return installFleetKinds().has(kind);
}

/** Is this org the install's own — the meta org on cloud, any org with cloud off? */
export function isInstallOrganization(org: { isMeta: boolean } | null): boolean {
  if (!isCloud()) return true;
  return org?.isMeta === true;
}

/** Is any install-fleet kind configured? The reconciler walks the fleet only then. */
export function isInstallFleetEnabled(): boolean {
  return installFleetKinds().size > 0;
}

/** Where the install fleet's VMs go. */
export interface InstallFleetConfig {
  readonly region: string;
  readonly subnetIds: readonly string[];
  readonly securityGroupId: string;
  readonly instanceProfileArn: string;
}

/**
 * The install fleet's network, profile and region — or the typed not-configured
 * error naming EVERY missing variable at once, as `indexFleetConfig` does: a
 * listed kind with no network is a misconfiguration to say loudly at the boot,
 * never a quiet fall back to a pool the admission did not count it against.
 */
export function installFleetConfig(): InstallFleetConfig {
  const read = (name: string) => process.env[name]?.trim() ?? '';
  const subnetIds = read(INSTALL_FLEET_SUBNET_IDS_ENV)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const values = {
    region: read(INSTALL_FLEET_REGION_ENV),
    securityGroupId: read(INSTALL_FLEET_SECURITY_GROUP_ID_ENV),
    instanceProfileArn: read(INSTALL_FLEET_INSTANCE_PROFILE_ARN_ENV),
  };
  const missing = [
    ...(subnetIds.length === 0 ? [INSTALL_FLEET_SUBNET_IDS_ENV] : []),
    ...(values.securityGroupId ? [] : [INSTALL_FLEET_SECURITY_GROUP_ID_ENV]),
    ...(values.instanceProfileArn ? [] : [INSTALL_FLEET_INSTANCE_PROFILE_ARN_ENV]),
    ...(values.region ? [] : [INSTALL_FLEET_REGION_ENV]),
  ];
  if (missing.length > 0) {
    throw new OrchestratorNotConfiguredError(`set ${missing.join(', ')}`);
  }
  return { ...values, subnetIds };
}
