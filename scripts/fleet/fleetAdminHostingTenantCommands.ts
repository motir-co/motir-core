/**
 * `fleet-admin`'s HOSTING TENANT command (Story MOTIR-9792 · MOTIR-9943) — the
 * platform admin's door onto an enterprise organisation's tenant AWS account:
 *
 *   hosting-tenant ensure <organization id>
 *
 * A printer over `hostingTenantAccountService.ensureForOrganization`: it makes
 * sure the organisation has its tenant account row and prints where it stands.
 * It never waits and never calls AWS — the per-minute reconcile job builds the
 * account, and running the command again shows the state move. Exits 0 when the
 * account is ready, 2 while it is being built. Every line printed passes through
 * `scrubSecrets` last and carries the organisation id, the state and the account
 * id only.
 */
import { parseArgs } from 'node:util';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import { scrubSecrets } from '@/lib/fleetShards/scrubSecrets';
import {
  hostingTenantAccountService,
  type TenantAccountAnswer,
} from '@/lib/services/hostingTenantAccountService';
import type { PoolCommandIo } from './fleetAdminPoolCommands';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
/** The account is still being built (`fleetAdmin.ts`'s `EXIT_PENDING`). */
const EXIT_PENDING = 2;

const USAGE = 'hosting-tenant ensure <organization id>';

export interface HostingTenantCommandDeps {
  /** The ensure call; the default is the service's. */
  ensure?: (organizationId: string) => Promise<TenantAccountAnswer>;
}

function scrubbed(io: PoolCommandIo): PoolCommandIo {
  return { out: (line) => io.out(scrubSecrets(line)), err: (line) => io.err(scrubSecrets(line)) };
}

// ── Formatting (pure) ────────────────────────────────────────────────────────

export function formatTenantAccountAnswer(
  organizationId: string,
  answer: TenantAccountAnswer,
): string {
  const account = answer.accountId ? `  account ${answer.accountId}` : '';
  return `tenant account ${organizationId}: ${answer.state}${account}`;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function hostingTenant(
  args: string[],
  rawIo: PoolCommandIo,
  deps: HostingTenantCommandDeps = {},
): Promise<number> {
  const io = scrubbed(rawIo);
  const [subcommand, ...rest] = args;
  if (subcommand !== 'ensure') throw new FleetShardProvisioningRefusedError([USAGE]);
  const { positionals } = parseArgs({
    args: rest,
    options: {},
    strict: true,
    allowPositionals: true,
  });
  const [organizationId] = positionals;
  if (positionals.length !== 1 || !organizationId) {
    throw new FleetShardProvisioningRefusedError([USAGE]);
  }

  const ensure =
    deps.ensure ?? ((id: string) => hostingTenantAccountService.ensureForOrganization(id));
  let answer: TenantAccountAnswer;
  try {
    answer = await ensure(organizationId);
  } catch (err) {
    // An unknown organisation is refused by the row's foreign key; the database's
    // own message is never printed, only the error's type.
    io.err(`error: ${err instanceof Error ? err.name : 'UnknownError'}`);
    return EXIT_ERROR;
  }
  io.out(formatTenantAccountAnswer(organizationId, answer));
  return answer.ready ? EXIT_OK : EXIT_PENDING;
}
