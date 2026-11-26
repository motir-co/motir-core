import type { AwsManagementCredentials } from './credentials';
import type { AwsManagementApi } from './management';
import type { TenantClients, TenantIam } from './tenant/clients';

// THE AWS FACTORIES' TEST OVERRIDES (Story MOTIR-9800 · MOTIR-12141). An E2E
// lane cannot reach AWS, and the handover is composed in a shipped module
// (`lib/orchestrator/awsHosting.ts`) that builds its clients through
// `createAwsManagementApi`, `createTenantClients` and `createTenantMemberIam`.
// So the override sits IN those factories: whatever composition calls them gets
// the fake, and no composition can route around it.
//
// The hooks live on `globalThis` under `Symbol.for` keys, as `lib/blob/s3.ts`'s
// transport hook does: Next.js route bundles and the job worker each load their
// own copy of this package, and one install has to reach every copy. Unset,
// every factory builds the real AWS SDK clients, exactly as before.

const MANAGEMENT_KEY = Symbol.for('motir.orchestrator.aws.managementOverride');
const TENANT_KEY = Symbol.for('motir.orchestrator.aws.tenantClientsOverride');

/** What `createAwsManagementApi` answers while the override is installed. */
export type AwsManagementOverride = (credentials: AwsManagementCredentials) => AwsManagementApi;

/** One tenant account, as the factories are asked for it. */
export interface AwsTenantTarget {
  readonly accountId: string;
  readonly region: string;
}

/** What the tenant-client factories answer while the override is installed. */
export interface AwsTenantClientsOverride {
  /** `createTenantClients`: the account's clients on its deploy role. */
  clients(target: AwsTenantTarget): TenantClients;
  /** `createTenantMemberIam`: the account's IAM on its member access role. */
  memberIam(target: AwsTenantTarget): TenantIam;
}

type Hooks = {
  [MANAGEMENT_KEY]?: AwsManagementOverride | null;
  [TENANT_KEY]?: AwsTenantClientsOverride | null;
};

const hooks = globalThis as typeof globalThis & Hooks;

/** Install (or, with null, remove) the management-API override — tests only. */
export function setAwsManagementOverrideForTests(override: AwsManagementOverride | null): void {
  hooks[MANAGEMENT_KEY] = override;
}

/** Install (or, with null, remove) the tenant-clients override — tests only. */
export function setAwsTenantClientsOverrideForTests(
  override: AwsTenantClientsOverride | null,
): void {
  hooks[TENANT_KEY] = override;
}

/** The installed management-API override, or null. */
export function awsManagementOverride(): AwsManagementOverride | null {
  return hooks[MANAGEMENT_KEY] ?? null;
}

/** The installed tenant-clients override, or null. */
export function awsTenantClientsOverride(): AwsTenantClientsOverride | null {
  return hooks[TENANT_KEY] ?? null;
}
