/**
 * `pnpm ops:fleet-cost` — what did each fleet workload cost this period, and how
 * much of it was Motir's own? (Story MOTIR-4335 · MOTIR-4540)
 *
 * WHY IT EXISTS. `ciFleetCostMeterService` measures every container the shared
 * fleet boots, keyed by workload (`ci` / `index` / `agent`) and rolled up per
 * period, and `code-graph-index-fleet.md` §9 Decision 8 sets the bar that Motir's
 * own compute be "metered as COGS attributed to Motir, queryable as its own line".
 * The measurement was built and the last step was not: a grep for callers of
 * `getOrgPeriodCostByWorkload` / `getMetaPeriodCostSplit` outside `lib/services/`
 * and `tests/` returned NOTHING. Four public reads whose comments say they exist to
 * answer "what did indexing cost us?", and no path in the product reached any of
 * them. A number nobody can obtain and a number nobody recorded are the same number
 * from where a person is standing. This command is that path, and it is the whole
 * of what "queryable as its own line" means.
 *
 * ⚠️ IT IS NOT BILLING AND IT IS NOT A CHARGE. These are Motir's INTERNAL COGS.
 * Indexing is attributed and accounted for internally; no customer is charged for
 * it, no ledger is debited here, no balance is read, and nothing this prints
 * reaches a user-facing surface.
 *
 * WHAT IT ADDS: one caller. The arithmetic, the tenancy scoping and the money
 * handling are all already in the service and its repository, and this adds none of
 * them — no new read, no aggregation, and no total line (a total is an addition the
 * rollup does not hold).
 *
 * Usage:
 *   pnpm ops:fleet-cost                              # platform-wide meta/tenant split, current period
 *   pnpm ops:fleet-cost --org=<organizationId>       # + that org's per-workload lines
 *   pnpm ops:fleet-cost --period=2026-08             # any past period
 *
 * `--period` takes `YYYY-MM` (UTC calendar month) and is resolved through the
 * meter's OWN `periodStartFor`, so the readout and the rollup can never disagree
 * about where a period starts. `--org` takes the organization's internal id.
 *
 * Needs `DATABASE_URL` for the target database. The rollup is RLS-gated, and the
 * service reads it under `withSystemContext` — which is what makes a cross-tenant
 * read return rows rather than silently returning none:
 *
 *   DATABASE_URL='<core direct url>' MOTIR_CLOUD=true pnpm ops:fleet-cost --period=2026-08
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { parsePeriodArg } from './fleetCostReadout';
import { buildFleetCostReadout } from './fleetCostReadoutQuery';

const TAG = '[fleet-cost]';

interface Args {
  organizationId?: string;
  /** An instant INSIDE the period to read — the service keys it itself. */
  at: Date;
}

function parseArgs(argv: string[]): Args {
  let organizationId: string | undefined;
  let at = new Date();

  for (const arg of argv) {
    if (arg.startsWith('--org=')) organizationId = arg.slice('--org='.length);
    else if (arg.startsWith('--period=')) at = parsePeriodArg(arg.slice('--period='.length));
    else throw new Error(`${TAG} unknown argument: ${arg}`);
  }

  return { organizationId, at };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // The read and the render live in `fleetCostReadoutQuery.ts` so the story's
  // rehearsal can call the SAME readout this prints (MOTIR-4545).
  const { text } = await buildFleetCostReadout(args);
  console.log(text);
}

main()
  .catch((err: unknown) => {
    console.error(`${TAG} failed:`, err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
