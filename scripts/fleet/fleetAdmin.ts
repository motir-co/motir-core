/**
 * `fleet-admin` — a platform admin's fleet ACCOUNT commands (Story MOTIR-8953 ·
 * MOTIR-8967), run inside a motir-core machine so they use that deployment's
 * secrets:
 *
 *   fly ssh console -a motir-core -C "node fleet/fleet-admin.mjs add-shard \
 *     --provider <provider> --fleet-kind <kind> --name <name> --region <region> \
 *     --github-org <org> (--create-org --admin-login <login> | --existing-org) \
 *     --operator <email> [provider options]"
 *
 *   fly ssh console -a motir-core -C "node fleet/fleet-admin.mjs refresh-limits \
 *     --name <account> --operator <email>"
 *
 * and the account controls beside it (MOTIR-8972): `set-ceiling --name <account>
 * (--ceiling <n> | --clear)`, `disable --name <account> --reason <text>` and
 * `enable --name <account>`, each with `--operator <email>`.
 *
 * `--provider aws` (MOTIR-9278) adds an AWS Organizations member account named
 * `--name`, in `--region` (default `us-east-1`); `--account-email <email>` is
 * required only when that account must be created.
 *
 * `add-shard` walks `fleetShardProvisioningService.addShard`'s steps, printing one
 * line per step (`done` · `already` · `pending: <what a person must do>`) and a
 * **Pending manual steps** list. Re-running the same command resumes.
 *
 * Exit codes: 0 when nothing is pending, 2 when the row is written but steps are
 * pending, 1 on a refusal or an error.
 *
 * ⚠️ IT IS BUNDLED, NOT RUN FROM SOURCE — `pnpm build:fleet-admin` esbuilds this
 * file into `.fleet-admin/fleet-admin.mjs`, which the Dockerfile stages at
 * `/app/fleet/`, for the reason `scripts/worker.ts`'s header gives: the runtime
 * image is a Next standalone output and carries no `scripts/` or `lib/`.
 *
 * ⚠️ NOTHING HERE PRINTS A SECRET: it prints step outcomes and the provider's
 * worded manual steps, and an error's one-line message.
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import { findShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import {
  fleetShardControlsService,
  type FleetShardControlResult,
} from '@/lib/services/fleetShardControlsService';
import {
  fleetShardProvisioningService,
  type ShardProvisioningResult,
} from '@/lib/services/fleetShardProvisioningService';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_PENDING = 2;

const USAGE = [
  'usage:',
  '  fleet-admin add-shard --provider <provider> --fleet-kind <kind> --name <name> --region <region>',
  '    --github-org <org> (--create-org --admin-login <login> [--billing-email <email>] | --existing-org)',
  '    --operator <email> [provider options]',
  '    --provider aws: --region defaults to us-east-1; --account-email <email> is the new',
  "      member account's root email, required only when no AWS account has the name",
  '  fleet-admin refresh-limits --name <account> --operator <email>',
  '  fleet-admin set-ceiling --name <account> (--ceiling <n> | --clear) --operator <email>',
  '  fleet-admin disable --name <account> --reason <text> --operator <email>',
  '  fleet-admin enable --name <account> --operator <email>',
].join('\n');

/** Where the command writes — stdout and stderr in production, a buffer in tests. */
export interface FleetAdminIo {
  out(line: string): void;
  err(line: string): void;
}

const SHARED_OPTIONS = {
  provider: { type: 'string' },
  'fleet-kind': { type: 'string' },
  name: { type: 'string' },
  region: { type: 'string' },
  'github-org': { type: 'string' },
  'create-org': { type: 'boolean' },
  'existing-org': { type: 'boolean' },
  'admin-login': { type: 'string', multiple: true },
  'billing-email': { type: 'string' },
  'profile-name': { type: 'string' },
  operator: { type: 'string' },
} as const;

function printResult(result: ShardProvisioningResult, io: FleetAdminIo): number {
  for (const step of result.steps) {
    const outcome = step.outcome === 'pending' ? `pending: ${step.detail}` : step.outcome;
    io.out(
      `${step.step.padEnd(20)} ${outcome}${step.outcome === 'pending' ? '' : ` — ${step.detail}`}`,
    );
  }
  io.out(`account ${result.shard.name} (${result.shard.fleetKind}) is ${result.shard.state}`);
  if (result.pendingManualSteps.length === 0) return EXIT_OK;
  io.out('');
  io.out('Pending manual steps:');
  result.pendingManualSteps.forEach((step, i) => io.out(`  ${i + 1}. ${step}`));
  return EXIT_PENDING;
}

async function addShard(args: string[], io: FleetAdminIo): Promise<number> {
  // Two passes: the shared options name the provider, whose own options are then
  // accepted strictly.
  // The first pass knows no provider option, so it reads `--account-email x` as a
  // flag and `x` as a positional: positionals are allowed HERE, and the strict
  // second pass refuses any that are really stray.
  const first = parseArgs({
    args,
    options: SHARED_OPTIONS,
    strict: false,
    allowPositionals: true,
  });
  const providerName = typeof first.values.provider === 'string' ? first.values.provider : '';
  const provider = findShardProvisioningProvider(providerName);
  const providerOptions = Object.fromEntries(
    (provider?.options ?? []).map((option) => [option.name, { type: 'string' as const }]),
  );
  // An unregistered provider is left to the service's preflight, which names it
  // with every other problem rather than failing here on its first option.
  const { values } = provider
    ? parseArgs({
        args,
        options: { ...SHARED_OPTIONS, ...providerOptions },
        strict: true,
        allowPositionals: false,
      })
    : first;
  const read = (key: string): string => {
    const value = (values as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : '';
  };

  if (Boolean(values['create-org']) === Boolean(values['existing-org'])) {
    throw new FleetShardProvisioningRefusedError([
      'pass exactly one of --create-org or --existing-org',
    ]);
  }
  const options: Record<string, string> = {};
  for (const option of provider?.options ?? []) {
    const value = read(option.name);
    if (value) options[option.name] = value;
  }
  const result = await fleetShardProvisioningService.addShard({
    provider: providerName,
    fleetKind: read('fleet-kind'),
    name: read('name'),
    region: read('region'),
    githubOrg: read('github-org'),
    orgMode: values['create-org'] ? 'create' : 'existing',
    operatorEmail: read('operator'),
    providerOptions: options,
    adminLogins: [values['admin-login'] ?? []]
      .flat()
      .filter((login): login is string => typeof login === 'string'),
    ...(read('billing-email') ? { billingEmail: read('billing-email') } : {}),
    ...(read('profile-name') ? { profileName: read('profile-name') } : {}),
  });
  return printResult(result, io);
}

async function refreshLimits(args: string[], io: FleetAdminIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { name: { type: 'string' }, operator: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  const result = await fleetShardProvisioningService.refreshLimits(
    values.name ?? '',
    values.operator ?? '',
  );
  return printResult(result, io);
}

function printControl(result: FleetShardControlResult, io: FleetAdminIo): number {
  io.out(
    `account ${result.name} (${result.fleetKind}): ${String(result.from ?? 'none')} → ` +
      `${String(result.to ?? 'none')}`,
  );
  return EXIT_OK;
}

/** The account controls beside add-shard (MOTIR-8972). */
async function control(command: string, args: string[], io: FleetAdminIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      operator: { type: 'string' },
      ...(command === 'set-ceiling'
        ? { ceiling: { type: 'string' }, clear: { type: 'boolean' } }
        : {}),
      ...(command === 'disable' ? { reason: { type: 'string' } } : {}),
    },
    strict: true,
    allowPositionals: false,
  });
  const read = (key: string): string => {
    const value = (values as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : '';
  };
  const name = read('name');
  const operator = read('operator');
  if (command === 'set-ceiling') {
    const clear = Boolean((values as Record<string, unknown>)['clear']);
    const raw = read('ceiling');
    if (clear === Boolean(raw)) {
      throw new FleetShardProvisioningRefusedError(['pass exactly one of --ceiling or --clear']);
    }
    const ceiling = clear ? null : Number(raw);
    return printControl(await fleetShardControlsService.setCeiling(name, ceiling, operator), io);
  }
  if (command === 'disable') {
    return printControl(
      await fleetShardControlsService.disable(name, read('reason'), operator),
      io,
    );
  }
  return printControl(await fleetShardControlsService.enable(name, operator), io);
}

/** Run one `fleet-admin` command; answers its exit code. */
export async function runFleetAdmin(argv: string[], io: FleetAdminIo): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === 'add-shard') return await addShard(args, io);
    if (command === 'refresh-limits') return await refreshLimits(args, io);
    if (command === 'set-ceiling' || command === 'disable' || command === 'enable') {
      return await control(command, args, io);
    }
    io.err(USAGE);
    return EXIT_ERROR;
  } catch (err) {
    if (err instanceof FleetShardProvisioningRefusedError) {
      io.err('refused:');
      for (const problem of err.problems) io.err(`  - ${problem}`);
      return EXIT_ERROR;
    }
    io.err(`error: ${err instanceof Error ? err.message : 'unknown'}`);
    return EXIT_ERROR;
  }
}

const isEntry =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  const io: FleetAdminIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  void runFleetAdmin(process.argv.slice(2), io).then(async (code) => {
    const { db } = await import('@/lib/db');
    await db.$disconnect().catch(() => undefined);
    process.exit(code);
  });
}
