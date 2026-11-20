/**
 * `fleet-admin`'s HOSTING SERVERLESS command (MOTIR-11921) — the platform
 * admin's door onto the two IAM roles of Motir's serverless hosting account:
 *
 *   hosting-serverless converge-roles --trust <principal ARN> [--trust …] [--dry-run]
 *
 * It brings `motir-hosting-serverless-deploy` and `mh-shared-exec` onto their
 * definitions in `@motir/orchestrator` (`serverlessRoleDefinitions`): each
 * role's trust policy and inline policy is written only when it differs, and
 * read back. `--trust` names every principal that may assume the deploy role —
 * Motir's management role and the operator who runs the deploy check — and is
 * required, because the converge REPLACES the trust it finds. `--dry-run` reads
 * and prints what would change, writing nothing; run it first.
 *
 * It prints one line per role — whether its trust and its policy changed, and
 * the statements that differed (`+Sid` only in the definition, `-Sid` only
 * live, `~Sid` different) — then the counts. Every line passes through
 * `scrubSecrets` and carries role names, statement ids and the account id only.
 */
import { parseArgs } from 'node:util';
import type { ServerlessRoleConvergence } from '@motir/orchestrator';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import { scrubSecrets } from '@/lib/fleetShards/scrubSecrets';
import {
  serverlessHostingRolesService,
  type ServerlessHostingRolesInput,
  type ServerlessHostingRolesResult,
} from '@/lib/services/serverlessHostingRolesService';
import type { PoolCommandIo } from './fleetAdminPoolCommands';

const EXIT_OK = 0;

const USAGE =
  'hosting-serverless converge-roles --trust <principal ARN> [--trust <principal ARN> ...] [--dry-run]';

export interface HostingServerlessCommandDeps {
  /** The converge; the default is the service's. */
  converge?: (input: ServerlessHostingRolesInput) => Promise<ServerlessHostingRolesResult>;
}

// ── Formatting (pure) ────────────────────────────────────────────────────────

function part(outcome: ServerlessRoleConvergence['trust'], diff: readonly string[]): string {
  return diff.length > 0 ? `${outcome} (${diff.join(' ')})` : outcome;
}

export function formatServerlessRoleConvergence(result: ServerlessRoleConvergence): string {
  return (
    `role ${result.roleName}: trust ${part(result.trust, result.trustDiff)}, ` +
    `policy ${part(result.policy, result.policyDiff)}`
  );
}

export function formatServerlessRolesSummary(
  result: ServerlessHostingRolesResult,
  dryRun: boolean,
): string {
  const drifted = result.roles.filter((r) => r.trust !== 'unchanged' || r.policy !== 'unchanged');
  const verb = dryRun ? 'would change' : 'changed';
  return (
    `serverless roles in ${result.accountId}: ${result.roles.length} role(s), ` +
    `${drifted.length} ${verb}, ${result.roles.length - drifted.length} unchanged` +
    (dryRun ? ' (dry run, nothing written)' : '')
  );
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function hostingServerless(
  args: string[],
  rawIo: PoolCommandIo,
  deps: HostingServerlessCommandDeps = {},
): Promise<number> {
  const io = { out: (line: string) => rawIo.out(scrubSecrets(line)) };
  const [subcommand, ...rest] = args;
  if (subcommand !== 'converge-roles') throw new FleetShardProvisioningRefusedError([USAGE]);
  const { values, positionals } = parseArgs({
    args: rest,
    options: { trust: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' } },
    strict: true,
    allowPositionals: true,
  });
  const trustPrincipals = (values.trust ?? []).map((arn) => arn.trim()).filter(Boolean);
  if (positionals.length > 0 || trustPrincipals.length === 0) {
    throw new FleetShardProvisioningRefusedError([USAGE]);
  }
  const dryRun = values['dry-run'] ?? false;
  const converge = deps.converge ?? ((input) => serverlessHostingRolesService.converge(input));
  const result = await converge({ trustPrincipals, dryRun });
  for (const role of result.roles) io.out(formatServerlessRoleConvergence(role));
  io.out(formatServerlessRolesSummary(result, dryRun));
  return EXIT_OK;
}
