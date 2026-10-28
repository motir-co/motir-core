import { awsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import type {
  FleetShardDTO,
  FleetShardLimitsDTO,
  FleetShardProviderDTO,
} from '@/lib/dto/fleetShard';

// THE PROVIDER SEAM OF ADD-SHARD (Story MOTIR-8953 · MOTIR-8967). `fleet-admin
// add-shard --provider <name>` runs a SHARED walk — preflight, the GitHub org and
// App installation, the account row, the audit — and hands the four steps that
// differ per cloud to the provider registered under `<name>`: its account, its
// network, its quota read and its runtime credential. A provider also names the
// extra CLI options it takes and validates them with `--region`.
//
// The first production provider is AWS (MOTIR-9278,
// `awsProvisioningProvider.ts`); the tests register fakes beside it.
//
// ⚠️ A PROVIDER NEVER MINTS OR RETURNS A SECRET. Its runtime-credential step
// CONFIRMS that the account's runtime credential works (for AWS, by assuming the
// account's runner role, MOTIR-9847); when it cannot yet, the provider words the
// pending step.

/** One extra CLI option a provider takes, as `--<name> <value>`. */
export interface ProviderOption {
  name: string;
  description: string;
  required: boolean;
}

/** What every provider step is handed. */
export interface ProviderStepContext {
  /** The account's name (`--name`). */
  name: string;
  fleetKind: string;
  region: string;
  /** The provider's own options, by name. Empty on `refresh-limits`. */
  options: Readonly<Record<string, string>>;
  /** `FLEET_SHARD_<NAME_UPPER_SNAKE>` — the env prefix the account's runtime key lives under. */
  credentialRef: string;
  /** What the account step returned for this run — in memory only, never stored. */
  account?: unknown;
  /** The existing row, on a resume or a refresh. */
  shard?: FleetShardDTO | null;
}

/** The row fields a provider owns: which `FleetShardProvider` the row is, and
 *  the location columns that provider records. */
export interface ProviderLocation {
  provider: FleetShardProviderDTO;
  flyOrg?: string | null;
  flyApp?: string | null;
  flyRegion?: string | null;
  awsAccountId?: string | null;
  awsRegion?: string | null;
}

export interface ProviderAccountResult {
  created: boolean;
  detail: string;
  /** Credentials for the steps after it, kept in memory for the run. */
  account: unknown;
}

export interface ProviderNetworkResult {
  /** What this run created — empty means everything was already there. */
  created: string[];
  /** What the network is (its ids), for the step's audit line; the row models no
   *  network column, so this is where a run records them. */
  detail?: string;
}

export interface ProviderQuotaResult {
  vcpuQuota: number;
  /** Any further limit the provider read (e.g. a machine limit), recorded with
   *  source `provider_read`. */
  limits?: Partial<FleetShardLimitsDTO>;
}

export interface ProviderCredentialResult {
  /** The account's runtime credential works. The step only confirms it: what the
   *  credential is made of is built by the network step (MOTIR-9847). */
  confirmed: boolean;
}

export interface ShardProvisioningProvider {
  /** The `--provider` value. */
  name: string;
  options: readonly ProviderOption[];
  /** Every env var this provider will read, so preflight reports them all at once. */
  requiredEnv(ctx: ProviderStepContext): string[];
  /** Problems with `--region` and the provider's options; empty when valid. */
  validate(ctx: ProviderStepContext): string[];
  location(ctx: ProviderStepContext): ProviderLocation;
  /** True when an existing row is this provider's account at this location. */
  matchesRow(shard: FleetShardDTO, ctx: ProviderStepContext): boolean;
  account(ctx: ProviderStepContext): Promise<ProviderAccountResult>;
  network(ctx: ProviderStepContext): Promise<ProviderNetworkResult>;
  readQuota(ctx: ProviderStepContext): Promise<ProviderQuotaResult>;
  runtimeCredential(ctx: ProviderStepContext): Promise<ProviderCredentialResult>;
  /** The pending step when the credential is not confirmed, worded by the provider. */
  manualCredentialStep(ctx: ProviderStepContext): string;
}

/** The registered providers. AWS (MOTIR-9278) is the first production entry. */
const PROVIDERS = new Map<string, ShardProvisioningProvider>([
  [awsShardProvisioningProvider.name, awsShardProvisioningProvider],
]);

export function findShardProvisioningProvider(name: string): ShardProvisioningProvider | null {
  return PROVIDERS.get(name) ?? null;
}

/** The registered provider whose rows are `provider`, when exactly one is. */
export function findShardProvisioningProviderForRow(
  provider: FleetShardProviderDTO,
  shard: FleetShardDTO,
): ShardProvisioningProvider | null {
  const matches = [...PROVIDERS.values()].filter(
    (candidate) =>
      candidate.location({
        name: shard.name,
        fleetKind: shard.fleetKind,
        region: shard.fly?.region ?? shard.aws?.region ?? '',
        options: {},
        credentialRef: shard.credentialRef,
        shard,
      }).provider === provider,
  );
  return matches.length === 1 ? matches[0]! : null;
}

export function shardProvisioningProviderNames(): string[] {
  return [...PROVIDERS.keys()].sort();
}

/** Register a provider; answers the call that removes it again, restoring the
 *  provider it replaced (a test's stand-in for `aws` gives the real one back). */
export function registerShardProvisioningProvider(provider: ShardProvisioningProvider): () => void {
  const replaced = PROVIDERS.get(provider.name);
  PROVIDERS.set(provider.name, provider);
  return () => {
    if (PROVIDERS.get(provider.name) !== provider) return;
    if (replaced) PROVIDERS.set(provider.name, replaced);
    else PROVIDERS.delete(provider.name);
  };
}
