/**
 * `fleet-admin check-quota` (Story MOTIR-9709 · MOTIR-9926) — a READ-ONLY proof
 * that this deployment's fleet code reaches a pool account through the assumed
 * management role:
 *
 *   node fleet/fleet-admin.mjs check-quota --account-id <12 digits> [--region us-east-1]
 *
 * It builds the management API exactly as the fleet services do
 * (`fleetManagementApi`, so on Fargate the task role is the first credential and
 * `AWS_ORG_ADMIN_ROLE_ARN` the role it assumes), assumes the member role in that
 * account and reads its granted vCPU quota. It prints one line and writes
 * nothing.
 *
 * ⚠️ NO DATABASE. The account is named on the command line rather than looked up
 * in `fleet_shard`, because the database it runs against may be empty (the AWS
 * core database is, until the cutover). Nothing here imports a repository.
 *
 * ⚠️ A failure prints AWS's error code or the error's class (`awsReasonOf`),
 * never a free-text message, which could quote what a call was given.
 */
import { parseArgs } from 'node:util';
import { OrchestratorNotConfiguredError, type AwsManagementApi } from '@motir/orchestrator';
import { awsReasonOf, fleetManagementApi } from '@/lib/services/fleetShardQuotaService';

/** The service quota code for running On-Demand standard vCPUs. */
export const VCPU_QUOTA_CODE = 'L-1216C47A';
const DEFAULT_REGION = 'us-east-1';
const ACCOUNT_ID = /^\d{12}$/;

const EXIT_OK = 0;
const EXIT_ERROR = 1;

export const CHECK_QUOTA_USAGE =
  'usage: fleet-admin check-quota --account-id <12-digit AWS account id> [--region <region>]';

/** Where the command writes, as `fleetAdmin.ts`'s `FleetAdminIo`. */
export interface CheckQuotaIo {
  out(line: string): void;
  err(line: string): void;
}

/** The one seam: the management API. Production passes none. */
export interface FleetAdminCheckDeps {
  management?: () => AwsManagementApi;
}

function parse(args: string[]): { accountId: string; region: string } | null {
  try {
    const { values } = parseArgs({
      args,
      options: { 'account-id': { type: 'string' }, region: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    });
    const accountId = values['account-id'];
    if (!accountId || !ACCOUNT_ID.test(accountId)) return null;
    return { accountId, region: values.region || DEFAULT_REGION };
  } catch {
    return null;
  }
}

/** Read one account's granted vCPU quota through the assumed management role. */
export async function checkQuota(
  args: string[],
  io: CheckQuotaIo,
  deps: FleetAdminCheckDeps = {},
): Promise<number> {
  const parsed = parse(args);
  if (!parsed) {
    io.err(CHECK_QUOTA_USAGE);
    return EXIT_ERROR;
  }
  const { accountId, region } = parsed;
  try {
    const management = (deps.management ?? fleetManagementApi)();
    const session = await management.assumeMemberRole(accountId);
    const granted = await management.readVcpuQuota(session, region);
    io.out(`account ${accountId} ${region} ${VCPU_QUOTA_CODE} granted ${String(granted)}`);
    return EXIT_OK;
  } catch (err) {
    // A missing configuration's message names every unset variable, not a value.
    if (err instanceof OrchestratorNotConfiguredError) io.err(err.message);
    else io.err(`error: ${awsReasonOf(err)}`);
    return EXIT_ERROR;
  }
}
