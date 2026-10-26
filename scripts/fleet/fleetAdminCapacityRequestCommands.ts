/**
 * `fleet-admin`'s CAPACITY REQUEST commands (Story MOTIR-9365 · MOTIR-9583),
 * beside the pool commands — how the platform admin works a Host organisation's
 * ask for more capacity on its own accounts:
 *
 *   capacity-requests --operator <email>
 *   capacity-request-link <request> <quota request> --operator <email>
 *   capacity-request-close <request> <note> --operator <email>
 *
 * The raise itself is filed with `request-quota` first; `capacity-request-link`
 * then ties the ask to it. A printer over `fleetCapacityRequestService`, which
 * writes one platform audit entry per command. Every line printed passes
 * through `scrubSecrets` last; a line carries ids, accounts, kinds, figures and
 * statuses only — never the reason text or a credential.
 */
import { parseArgs } from 'node:util';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import type { FleetCapacityRequestDTO } from '@/lib/dto/fleetCapacityRequest';
import { scrubSecrets } from '@/lib/fleetShards/scrubSecrets';
import { platformPrincipalForStaffEmail, type PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { fleetCapacityRequestService } from '@/lib/services/fleetCapacityRequestService';
import type { PoolCommandIo } from './fleetAdminPoolCommands';

const EXIT_OK = 0;

function scrubbed(io: PoolCommandIo): PoolCommandIo {
  return { out: (line) => io.out(scrubSecrets(line)), err: (line) => io.err(scrubSecrets(line)) };
}

async function resolveSuperadmin(email: string | undefined): Promise<PlatformPrincipal> {
  try {
    return await platformPrincipalForStaffEmail(email ?? '', 'superadmin');
  } catch (err) {
    if (err instanceof NotPlatformStaffError) {
      throw new FleetShardProvisioningRefusedError([
        `--operator ${email || '(none)'} is not a superadmin on the platform staff`,
      ]);
    }
    throw err;
  }
}

function parse(args: string[], positionals: number, usage: string) {
  const { values, positionals: given } = parseArgs({
    args,
    options: { operator: { type: 'string' } },
    strict: true,
    allowPositionals: positionals > 0,
  });
  if (given.length < positionals) throw new FleetShardProvisioningRefusedError([usage]);
  return { operator: values.operator, positionals: given };
}

// ── Formatting (pure) ────────────────────────────────────────────────────────

export function formatCapacityRequest(r: FleetCapacityRequestDTO): string {
  const outcome = r.outcome
    ? `  quota request ${r.outcome.quotaRequestId} ${r.outcome.status}` +
      `  granted ${r.outcome.grantedValue ?? '-'}`
    : '';
  return (
    `${r.id}  org ${r.organizationId}  account ${r.awsAccountId}  ${r.fleetKind}` +
    `  ${r.quotaCode} ${r.desiredVcpu} vCPU  ${r.status}  ${r.createdAt}${outcome}`
  );
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export async function capacityRequests(args: string[], rawIo: PoolCommandIo): Promise<number> {
  const io = scrubbed(rawIo);
  const { operator } = parse(args, 0, 'capacity-requests --operator <email>');
  const requests = await fleetCapacityRequestService.listActive(await resolveSuperadmin(operator));
  if (requests.length === 0) io.out('no open or filed capacity requests');
  for (const request of requests) io.out(formatCapacityRequest(request));
  return EXIT_OK;
}

export async function capacityRequestLink(args: string[], rawIo: PoolCommandIo): Promise<number> {
  const io = scrubbed(rawIo);
  const { operator, positionals } = parse(
    args,
    2,
    'capacity-request-link <request> <quota request> --operator <email>',
  );
  const linked = await fleetCapacityRequestService.linkQuotaRequest(
    { requestId: positionals[0]!, quotaRequestId: positionals[1]! },
    await resolveSuperadmin(operator),
  );
  io.out(formatCapacityRequest(linked));
  return EXIT_OK;
}

export async function capacityRequestClose(args: string[], rawIo: PoolCommandIo): Promise<number> {
  const io = scrubbed(rawIo);
  const { operator, positionals } = parse(
    args,
    2,
    'capacity-request-close <request> <note> --operator <email>',
  );
  const closed = await fleetCapacityRequestService.close(
    { requestId: positionals[0]!, note: positionals.slice(1).join(' ') },
    await resolveSuperadmin(operator),
  );
  io.out(formatCapacityRequest(closed));
  return EXIT_OK;
}
