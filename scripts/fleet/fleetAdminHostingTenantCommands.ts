/**
 * `fleet-admin`'s HOSTING TENANT command (Story MOTIR-9792 · MOTIR-9943) — the
 * platform admin's door onto an enterprise organisation's tenant AWS account:
 *
 *   hosting-tenant ensure <organization id>
 *   hosting-tenant converge-deploy-policy [--organization <id>]
 *
 * A printer over `hostingTenantAccountService.ensureForOrganization`: it makes
 * sure the organisation has its tenant account row and prints where it stands.
 * It never waits and never calls AWS — the per-minute reconcile job builds the
 * account, and running the command again shows the state move. Exits 0 when the
 * account is ready, 2 while it is being built.
 *
 * `converge-deploy-policy` (MOTIR-10005) brings the deploy role of one `ready`
 * account, or of every one, onto today's policy — a ready account never re-runs
 * its bootstrap, so this is how a policy change reaches it. It prints one
 * outcome per organisation and the counts, and exits 1 when any organisation
 * failed (2 when the one named is not ready yet).
 *
 * Every line printed passes through `scrubSecrets` last and carries organisation
 * ids, states, outcomes and account ids only.
 */
import { parseArgs } from 'node:util';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import { scrubSecrets } from '@/lib/fleetShards/scrubSecrets';
import {
  hostingTenantAccountService,
  type DeployPolicyConvergeSummary,
  type DeployPolicyConvergence,
  type TenantAccountAnswer,
} from '@/lib/services/hostingTenantAccountService';
import type { PoolCommandIo } from './fleetAdminPoolCommands';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
/** The account is still being built (`fleetAdmin.ts`'s `EXIT_PENDING`). */
const EXIT_PENDING = 2;

const USAGE =
  'hosting-tenant ensure <organization id> | hosting-tenant converge-deploy-policy [--organization <id>]';

export interface HostingTenantCommandDeps {
  /** The ensure call; the default is the service's. */
  ensure?: (organizationId: string) => Promise<TenantAccountAnswer>;
  /** One organisation's deploy-policy convergence; the default is the service's. */
  convergeOne?: (organizationId: string) => Promise<DeployPolicyConvergence>;
  /** Every ready organisation's; the default is the service's. */
  convergeAll?: () => Promise<DeployPolicyConvergeSummary>;
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

export function formatDeployPolicyConvergence(result: DeployPolicyConvergence): string {
  return `deploy policy ${result.organizationId}: ${result.outcome}`;
}

export function formatDeployPolicySummary(summary: DeployPolicyConvergeSummary): string {
  return (
    `deploy policy: ${summary.organizations.length} ready account(s), ` +
    `${summary.changed} changed, ${summary.unchanged} unchanged, ${summary.failures} failed`
  );
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function convergeDeployPolicy(
  rest: string[],
  io: PoolCommandIo,
  deps: HostingTenantCommandDeps,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { organization: { type: 'string' } },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 0 || values.organization === '') {
    throw new FleetShardProvisioningRefusedError([USAGE]);
  }
  const organizationId = values.organization;
  if (organizationId) {
    const convergeOne =
      deps.convergeOne ?? ((id: string) => hostingTenantAccountService.convergeDeployPolicy(id));
    const result = await convergeOne(organizationId);
    io.out(formatDeployPolicyConvergence(result));
    if (result.outcome === 'failed') return EXIT_ERROR;
    return result.outcome === 'not_ready' ? EXIT_PENDING : EXIT_OK;
  }
  const convergeAll =
    deps.convergeAll ?? (() => hostingTenantAccountService.convergeReadyAccounts());
  const summary = await convergeAll();
  for (const result of summary.organizations) io.out(formatDeployPolicyConvergence(result));
  io.out(formatDeployPolicySummary(summary));
  return summary.failures > 0 ? EXIT_ERROR : EXIT_OK;
}

export async function hostingTenant(
  args: string[],
  rawIo: PoolCommandIo,
  deps: HostingTenantCommandDeps = {},
): Promise<number> {
  const io = scrubbed(rawIo);
  const [subcommand, ...rest] = args;
  if (subcommand === 'converge-deploy-policy') return convergeDeployPolicy(rest, io, deps);
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
