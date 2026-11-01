import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE FLEET NEVER READS A TENANT ACCOUNT (Story MOTIR-9792 · MOTIR-9944) — the
// source half of the story gate's isolation proof; the behaviour half is
// `tests/services/hostingTenantAccountIntegration.test.ts`.
//
// An enterprise tenant's AWS account has its own record and no `fleet_shard`
// row, so nothing that places, measures, grows, caps or lists the fleet can see
// it. This guard keeps it that way: none of those modules may import the tenant
// account's repository or service, or query its table.

const ROOT = process.cwd();

/** Admission, headroom, pool growth, plan caps and the pool view. */
const FLEET_PATHS = [
  'lib/ciFleet',
  'lib/repositories/fleetShardRepository.ts',
  'lib/services/fleetShardAdmissionService.ts',
  'lib/services/fleetShardHeadroomService.ts',
  'lib/services/fleetPoolGrowthService.ts',
  'lib/services/fleetPoolGrowthPassService.ts',
  'lib/services/fleetQuotaRaiseService.ts',
  'lib/services/planCapsService.ts',
  'lib/services/fleetPoolStatusService.ts',
  'lib/services/platformFleetPoolsService.ts',
  'scripts/fleet/fleetAdminPoolCommands.ts',
];

/** The tenant account's own pure plan module lives under `lib/ciFleet` and is
 *  not a fleet path. */
const OWN_MODULES = new Set(['lib/ciFleet/hostingTenantAccounts.ts']);

const TENANT_REACH: Array<[string, RegExp]> = [
  ['imports the tenant account repository', /from '[^']*hostingTenantAccountRepository'/],
  [
    'imports the tenant account service',
    /from '[^']*hostingTenantAccount(Service|[A-Z]\w*Service)'/,
  ],
  ['queries the tenant account table', /\.hostingTenantAccount\.|"hosting_tenant_account"/],
];

function filesUnder(path: string): string[] {
  const full = join(ROOT, path);
  if (statSync(full).isFile()) return [path];
  return readdirSync(full).flatMap((entry) => filesUnder(join(path, entry)));
}

function tenantReachIn(file: string, source: string): string[] {
  return TENANT_REACH.filter(([, pattern]) => pattern.test(source)).map(
    ([what]) => `${file} ${what}`,
  );
}

describe('the fleet code paths never reach the tenant account', () => {
  const files = FLEET_PATHS.flatMap(filesUnder)
    .map((f) => relative(ROOT, join(ROOT, f)))
    .filter((f) => /\.tsx?$/.test(f) && !OWN_MODULES.has(f));

  it('scans the fleet modules — a guard over nothing passes vacuously', () => {
    expect(files.length).toBeGreaterThan(FLEET_PATHS.length);
  });

  it('no admission, headroom, growth, caps or pool-view module imports or queries it', () => {
    const reaches = files.flatMap((f) => tenantReachIn(f, readFileSync(join(ROOT, f), 'utf8')));
    expect(reaches).toEqual([]);
  });

  it('bites: each reach is named with its file', () => {
    expect(
      tenantReachIn(
        'lib/ciFleet/x.ts',
        [
          "import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';",
          "import { hostingTenantAccountService } from '@/lib/services/hostingTenantAccountService';",
          'await tx.hostingTenantAccount.findMany();',
        ].join('\n'),
      ),
    ).toEqual([
      'lib/ciFleet/x.ts imports the tenant account repository',
      'lib/ciFleet/x.ts imports the tenant account service',
      'lib/ciFleet/x.ts queries the tenant account table',
    ]);
    expect(tenantReachIn('lib/ciFleet/y.ts', 'SELECT 1 FROM "hosting_tenant_account"')).toEqual([
      'lib/ciFleet/y.ts queries the tenant account table',
    ]);
  });
});
