import type { FleetMachineKill } from '@/generated/prisma/client';
import { isCloudBilling } from '@/lib/billing/availability';
import { CI_DEBIT_PERIOD_MINUTES } from '@/lib/ciMetering/allowance';
import { isCiMeteringEnabled } from '@/lib/ciMetering/config';
import { periodStartFor } from '@/lib/ciMetering/period';
import { FLEET_WORKLOAD_KINDS, type FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import {
  isFleetMismatch,
  type FleetKillDTO,
  type FleetKillsDTO,
  type FleetOrgDTO,
  type FleetOrgPlanDTO,
  type FleetOrgRowDTO,
  type FleetRunningOrgsDTO,
  type FleetVerdict,
  type FleetWindowDTO,
} from '@/lib/dto/platformFleetMonitor';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { ciLiveAccrualRepository } from '@/lib/repositories/ciLiveAccrualRepository';
import { ciPeriodChargeRepository } from '@/lib/repositories/ciPeriodChargeRepository';
import { ciRunnerProvisioningIntentRepository as intents } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { fleetMachineKillRepository } from '@/lib/repositories/fleetMachineKillRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { platformOrganizationRepository } from '@/lib/repositories/platformOrganizationRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { orgPlanFiguresService } from '@/lib/services/orgPlanFiguresService';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { withSystemContext } from '@/lib/workspaces/context';

// THE FLEET MONITOR (MOTIR-7316 · Story MOTIR-6905) — one staff-gated, audited
// read that answers, per organisation, WHAT IS IT RUNNING AND IS IT BEING CHARGED
// FOR IT, plus the reconciler's kill record. The monitor page, the tenant page's
// fleet card and the mismatch alert job (MOTIR-7318) all reach their answer
// through {@link classify}, so the three can never disagree.
//
// ⚠️ THREE METERS, THREE CLOCKS. The census is live; the accrual lands once per
// debit period; motir-ai confirms a debit whenever it answers. Every verdict is
// judged over a WINDOW of two debit periods, so one late tick is slack rather
// than an alarm, and over `CI_DEBIT_PERIOD_MINUTES` read from the meter — never
// retyped — so the rule moves with the period.
//
// ⚠️ ONLY CI IS JUDGED FOR DEBITING. CI is the one workload debited while it
// runs (`fleet-per-org-pool.md` §3): hosted runs are charged when they settle,
// index containers never (Motir does not charge for indexing), agent instances
// sit outside the pool. They are counted and shown; only the zero stop judges
// hosted runs and agent instances, because the stop must have ended them.
//
// ⚠️ CAPACITY FOLLOWS THE PLAN (MOTIR-9377; the fleet-capacity decision
// MOTIR-9357). Each workload is shown against its own plan figure, read through
// `orgPlanFiguresService.figuresFor` (MOTIR-9659) — `planCapsService.capsFor` and
// `fleetCeilingService.resolveCiBurstCap`, as the admissions read them, and the
// same function the org's own Fleet use section reads — so the monitor never
// names a number no gate applies.
//
// ⚠️ READS ONLY. It computes no charge and changes no meter; a wrong debit found
// here is a bug or a ledger adjustment (MOTIR-745), never a write from this file.

/** The verdict window — two debit periods: one period of slack for a late tick. */
export const FLEET_MONITOR_WINDOW_MS = 2 * CI_DEBIT_PERIOD_MINUTES * 60_000;
/** One debit period — how long the zero stop is given to fire. */
export const FLEET_MONITOR_PERIOD_MS = CI_DEBIT_PERIOD_MINUTES * 60_000;

export const FLEET_ORGS_PAGE_SIZE = 25;
export const FLEET_KILLS_PAGE_SIZE = 25;
/** The kill list's default reach when the caller names no `since`. */
export const FLEET_KILLS_DEFAULT_SINCE_MS = 7 * 24 * 60 * 60_000;

/** The slot-backed workloads the zero stop must have ended. */
const STOPPED_AT_ZERO_SLOT_WORKLOADS: readonly FleetWorkloadKind[] = [
  'hosted_agent',
  'agent_instance',
];

/** How many organisations' facts are gathered at once. */
const GATHER_CONCURRENCY = 8;

/**
 * Everything {@link classify} judges, for one organisation at one instant. Facts,
 * not a transaction: the page and the alert job gather them the same way and
 * judge them with the same pure function.
 */
export interface FleetFacts {
  /** CI metering is on (cloud + a provisioning org). Off, nothing is debited. */
  meteringEnabled: boolean;
  /** The meta org — measured and never charged (`ci-minutes-allowance.md` §6.5). */
  isMeta: boolean;
  /** CI intents in flight now. */
  ciInFlight: number;
  /** The earliest JOB START among those — what the live charge accrues from. */
  oldestCiJobStartedAt: Date | null;
  /** The earliest in-flight CI container by any clock it has (started, booted,
   *  queued) — what the zero stop should already have torn down. */
  oldestCiInFlightAt: Date | null;
  /** The earliest live hosted-agent or agent-instance slot. */
  oldestSlotClaimedAt: Date | null;
  /** CI intents that settled inside the window. */
  ciSettledInWindow: number;
  /** The start of the latest tick that accrued anything for the org. */
  latestAccrualTickStart: Date | null;
  /** This month's charge record, or null when there is none. */
  charge: {
    chargedCredits: number;
    debitedCredits: number;
    pendingDebitRef: string | null;
    pendingDebitSince: Date | null;
  } | null;
  /**
   * The balance as the zero stop reads it. `not_read` when nothing has run long
   * enough for the zero stop to matter — the read crosses into motir-ai, so it
   * is spent only where it can change the verdict.
   */
  balance: 'exhausted' | 'readable' | 'unknown' | 'not_read';
}

const MISMATCH_ORDER: readonly FleetVerdict[] = [
  'running_not_debited',
  'debited_nothing_running',
  'exhausted_still_running',
  'balance_unknown',
];

function before(at: Date | null, bound: Date): boolean {
  return at !== null && at.getTime() < bound.getTime();
}

function earliest(...dates: (Date | null)[]): Date | null {
  let min: Date | null = null;
  for (const date of dates) {
    if (date !== null && (min === null || date.getTime() < min.getTime())) min = date;
  }
  return min;
}

/**
 * THE VERDICT — pure, over {@link FleetFacts}. Every verdict that holds, in a
 * fixed order (mismatches first); `['ok']` when none does.
 *
 * - `running_not_debited`: a CI job started BEFORE `now − W` (exactly at the
 *   bound is inside the window, so not yet owed) AND either (a) no accrual tick
 *   started at or after `now − W` — the debit job is not reaching the org — or
 *   (b) an outstanding debit (`pendingDebitRef`, `charged > debited`) has been
 *   pending since at least `now − W` — motir-ai is not confirming.
 * - `debited_nothing_running`: an accrual tick in the window while no CI intent
 *   was in flight at any point of it (none now, none settled in it).
 * - `exhausted_still_running`: the balance reads exhausted and a CI container, a
 *   hosted run or an agent instance started before `now − 1 period` — the zero
 *   stop should already have fired.
 * - `balance_unknown`: the balance could not be read. Shown, never a mismatch.
 * - `not_charged`: metering is off or the org is meta — nothing above is judged.
 */
export function classify(facts: FleetFacts, now: Date): FleetVerdict[] {
  if (!facts.meteringEnabled || facts.isMeta) return ['not_charged'];

  const windowStart = new Date(now.getTime() - FLEET_MONITOR_WINDOW_MS);
  const periodStart = new Date(now.getTime() - FLEET_MONITOR_PERIOD_MS);
  const held = new Set<FleetVerdict>();

  if (before(facts.oldestCiJobStartedAt, windowStart)) {
    const accrualReaching =
      facts.latestAccrualTickStart !== null &&
      facts.latestAccrualTickStart.getTime() >= windowStart.getTime();
    const charge = facts.charge;
    const debitStuck =
      charge !== null &&
      charge.pendingDebitRef !== null &&
      charge.chargedCredits > charge.debitedCredits &&
      charge.pendingDebitSince !== null &&
      charge.pendingDebitSince.getTime() <= windowStart.getTime();
    if (!accrualReaching || debitStuck) held.add('running_not_debited');
  }

  if (
    facts.latestAccrualTickStart !== null &&
    facts.latestAccrualTickStart.getTime() >= windowStart.getTime() &&
    facts.ciInFlight === 0 &&
    facts.ciSettledInWindow === 0
  ) {
    held.add('debited_nothing_running');
  }

  if (
    facts.balance === 'exhausted' &&
    before(earliest(facts.oldestCiInFlightAt, facts.oldestSlotClaimedAt), periodStart)
  ) {
    held.add('exhausted_still_running');
  }

  if (facts.balance === 'unknown') held.add('balance_unknown');

  const verdicts = MISMATCH_ORDER.filter((verdict) => held.has(verdict));
  return verdicts.length > 0 ? verdicts : ['ok'];
}

/** What one organisation's gather produced: its facts plus the counts the row shows. */
export interface FleetOrgReading {
  organizationId: string;
  /** The org's name as its own row reads it; null when the row is gone. */
  name: string | null;
  /** `Organization.internalBilling` — carried for the row, never a verdict input:
   *  an internally billed org is debited like any other (MOTIR-4565). */
  internalBilling: boolean;
  facts: FleetFacts;
  verdicts: FleetVerdict[];
  byWorkload: Record<FleetWorkloadKind, number>;
  plan: FleetOrgPlanDTO;
  accruedMinutesInWindow: number;
  /** The balance figure the zero-stop read returned, when it was read and answered. */
  balanceCredits: number | null;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

/** The balance as the zero stop reads it — through the same entitlement read —
 *  plus the figure it answered, which the page prints beside an exhausted org. */
async function readBalance(
  organizationId: string,
  now: Date,
): Promise<{ balance: FleetFacts['balance']; credits: number | null }> {
  try {
    const state = await ciAllowanceService.getEntitlementState(organizationId, now);
    const credits = state.balance ?? null;
    if (state.state === 'ci_credits_exhausted') return { balance: 'exhausted', credits };
    if (state.applicable && state.balance === null) return { balance: 'unknown', credits: null };
    return { balance: 'readable', credits };
  } catch (err) {
    console.error('[platformFleetMonitorService] could not read the entitlement', {
      organizationId,
      detail: detailOf(err),
    });
    return { balance: 'unknown', credits: null };
  }
}

async function mapConcurrent<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += GATHER_CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(i, i + GATHER_CONCURRENCY).map(fn))));
  }
  return out;
}

function windowDto(now: Date): FleetWindowDTO {
  return {
    windowMinutes: FLEET_MONITOR_WINDOW_MS / 60_000,
    periodMinutes: FLEET_MONITOR_PERIOD_MS / 60_000,
    judgedAt: now.toISOString(),
  };
}

function runningTotal(reading: FleetOrgReading): number {
  return FLEET_WORKLOAD_KINDS.reduce((sum, kind) => sum + reading.byWorkload[kind], 0);
}

function hasMismatch(reading: FleetOrgReading): boolean {
  return reading.verdicts.some(isFleetMismatch);
}

function toRow(
  reading: FleetOrgReading,
  org: { name: string; isMeta: boolean } | undefined,
): FleetOrgRowDTO {
  const charge = reading.facts.charge;
  return {
    organizationId: reading.organizationId,
    name: org?.name ?? reading.name,
    isMeta: org?.isMeta ?? reading.facts.isMeta,
    internalBilling: reading.internalBilling,
    byWorkload: reading.byWorkload,
    plan: reading.plan,
    accruedMinutesInWindow: reading.accruedMinutesInWindow,
    confirmedCreditsThisMonth: charge?.debitedCredits ?? 0,
    pendingCredits: charge ? Math.max(0, charge.chargedCredits - charge.debitedCredits) : 0,
    pendingSince:
      charge && charge.chargedCredits > charge.debitedCredits && charge.pendingDebitSince
        ? charge.pendingDebitSince.toISOString()
        : null,
    latestAccrualTickAt: reading.facts.latestAccrualTickStart?.toISOString() ?? null,
    balanceCredits: reading.balanceCredits,
    verdicts: reading.verdicts,
  };
}

function toKillDto(kill: FleetMachineKill, names: Map<string, string>): FleetKillDTO {
  return {
    id: kill.id,
    app: kill.app,
    machineId: kill.machineId,
    machineName: kill.machineName,
    reason: kill.reason,
    action: kill.action,
    workload: kill.workload,
    organizationId: kill.organizationId,
    organizationName: kill.organizationId ? (names.get(kill.organizationId) ?? null) : null,
    ageSeconds: kill.ageSeconds,
    decidedAt: kill.decidedAt.toISOString(),
    completedAt: kill.completedAt?.toISOString() ?? null,
    failureDetail: kill.failureDetail,
  };
}

function pageOf(requested: number | undefined, total: number, pageSize: number) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const asked = requested !== undefined && Number.isFinite(requested) ? Math.trunc(requested) : 1;
  return { page: Math.min(Math.max(1, asked), pageCount), pageCount };
}

export const platformFleetMonitorService = {
  /**
   * The organisations the monitor looks at: every org holding a live CI intent
   * or a live slot (agent instances hold `agent_instance` slots), PLUS every org
   * the live charge accrued for inside the window — an org debited while nothing
   * of it runs is exactly the `debited_nothing_running` leak, and it holds no
   * container to be found by.
   */
  async listOrganizationsToJudge(now: Date): Promise<string[]> {
    const windowStart = new Date(now.getTime() - FLEET_MONITOR_WINDOW_MS);
    const [ci, slots, accrued] = await withSystemContext(async (tx) => [
      await intents.listOrganizationsInFlight(tx),
      await fleetInFlightSlotRepository.listOrganizationsInFlight(now, tx),
      await ciLiveAccrualRepository.listOrganizationsSince(windowStart, tx),
    ]);
    return [...new Set([...ci, ...slots, ...accrued])].sort();
  },

  /**
   * Gather ONE organisation's facts and judge them. Not staff-gated — the alert
   * job calls it with no principal; every staff path gates before calling it.
   *
   * The fleet tables are read under the system context, as the census is; the
   * charge row and `isMeta` under the org GUC (the org policies have no system
   * escape), and the plan outside both, as the admissions read it.
   */
  async judgeOrganization(organizationId: string, now: Date): Promise<FleetOrgReading> {
    const windowStart = new Date(now.getTime() - FLEET_MONITOR_WINDOW_MS);
    const periodStart = new Date(now.getTime() - FLEET_MONITOR_PERIOD_MS);

    const fleet = await withSystemContext(async (tx) => {
      const inFlight = await intents.listInFlightForOrganization(organizationId, tx);
      return {
        inFlight,
        oldestSlotClaimedAt: await fleetInFlightSlotRepository.oldestLiveClaimForOrganization(
          organizationId,
          STOPPED_AT_ZERO_SLOT_WORKLOADS,
          now,
          tx,
        ),
        ciSettledInWindow: await intents.countSettledForOrganizationSince(
          organizationId,
          windowStart,
          tx,
        ),
        latestAccrualTickStart: await ciLiveAccrualRepository.latestTickForOrganization(
          organizationId,
          tx,
        ),
        accruedSeconds: await ciLiveAccrualRepository.sumForOrganizationSince(
          organizationId,
          windowStart,
          tx,
        ),
        census: await fleetCeilingService.orgCensus(organizationId, now, tx),
      };
    });
    const org = await withOrgServiceWriteContext(organizationId, async (tx) => {
      const row = await organizationRepository.findByIdInTx(organizationId, tx);
      return {
        name: row?.name ?? null,
        // A missing row judges as charged — the safe direction, as the meters do.
        isMeta: row?.isMeta ?? false,
        internalBilling: row?.internalBilling ?? false,
        charge: await ciPeriodChargeRepository.findForPeriod(
          organizationId,
          periodStartFor(now),
          tx,
        ),
      };
    });
    const plan = await orgPlanFiguresService.figuresFor(organizationId);

    const oldestCiJobStartedAt = earliest(...fleet.inFlight.map((intent) => intent.startedAt));
    const oldestCiInFlightAt = earliest(
      ...fleet.inFlight.map((intent) => intent.startedAt ?? intent.bootedAt ?? intent.queuedAt),
    );
    const meteringEnabled = isCiMeteringEnabled();
    // The balance crosses into motir-ai: read it only where the zero stop could
    // have owed something — a container older than one period.
    const balanceRead =
      meteringEnabled &&
      !org.isMeta &&
      before(earliest(oldestCiInFlightAt, fleet.oldestSlotClaimedAt), periodStart)
        ? await readBalance(organizationId, now)
        : { balance: 'not_read' as const, credits: null };
    const balance = balanceRead.balance;

    const facts: FleetFacts = {
      meteringEnabled,
      isMeta: org.isMeta,
      ciInFlight: fleet.inFlight.length,
      oldestCiJobStartedAt,
      oldestCiInFlightAt,
      oldestSlotClaimedAt: fleet.oldestSlotClaimedAt,
      ciSettledInWindow: fleet.ciSettledInWindow,
      latestAccrualTickStart: fleet.latestAccrualTickStart,
      charge: org.charge
        ? {
            chargedCredits: org.charge.chargedCredits,
            debitedCredits: org.charge.debitedCredits,
            pendingDebitRef: org.charge.pendingDebitRef,
            pendingDebitSince: org.charge.pendingDebitSince,
          }
        : null,
      balance,
    };

    return {
      organizationId,
      name: org.name,
      internalBilling: org.internalBilling,
      facts,
      verdicts: classify(facts, now),
      byWorkload: fleet.census.byWorkload,
      plan,
      accruedMinutesInWindow: Math.floor(fleet.accruedSeconds / 60),
      balanceCredits: balanceRead.credits,
    };
  },

  /**
   * The monitor's list: every org running anything (or debited in the window),
   * MISMATCHED FIRST, then by how much it runs, 25 to a page with a total.
   * Every org is judged before the page is cut, so a mismatch on page three is
   * never hidden behind a quiet page one.
   */
  async listRunningOrgs(
    principal: PlatformPrincipal,
    input: { page?: number } = {},
    now: Date = new Date(),
  ): Promise<FleetRunningOrgsDTO> {
    await requirePlatformStaff('support');
    if (!isCloudBilling()) {
      await platformAuditService.record(principal, {
        action: 'estate.read',
        targetKind: 'platform',
      });
      return { meter: 'disabled' };
    }

    const orgIds = await this.listOrganizationsToJudge(now);
    const readings = await mapConcurrent(orgIds, (id) => this.judgeOrganization(id, now));
    readings.sort(
      (a, b) =>
        Number(hasMismatch(b)) - Number(hasMismatch(a)) ||
        runningTotal(b) - runningTotal(a) ||
        a.organizationId.localeCompare(b.organizationId),
    );

    const total = readings.length;
    const { page, pageCount } = pageOf(input.page, total, FLEET_ORGS_PAGE_SIZE);
    const slice = readings.slice((page - 1) * FLEET_ORGS_PAGE_SIZE, page * FLEET_ORGS_PAGE_SIZE);

    // The names cross tenants: the platform read writes the audit row in the
    // same transaction it reads them in.
    const orgs = await withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'platform' },
      (tx) =>
        platformOrganizationRepository.findOrganizationsByIds(
          slice.map((reading) => reading.organizationId),
          tx,
        ),
    );
    const byId = new Map(orgs.map((org) => [org.id, org]));

    return {
      meter: 'enabled',
      window: windowDto(now),
      rows: slice.map((reading) => toRow(reading, byId.get(reading.organizationId))),
      total,
      mismatched: readings.filter(hasMismatch).length,
      ciRunners: readings.reduce((sum, reading) => sum + reading.byWorkload.ci_runner, 0),
      hostedAgents: readings.reduce((sum, reading) => sum + reading.byWorkload.hosted_agent, 0),
      agentInstances: readings.reduce((sum, reading) => sum + reading.byWorkload.agent_instance, 0),
      page,
      pageSize: FLEET_ORGS_PAGE_SIZE,
      pageCount,
    };
  },

  /** One organisation's row — the tenant page's fleet card. Read whether or not
   *  it is running anything: "nothing running" is an answer the card shows. */
  async orgFleet(
    principal: PlatformPrincipal,
    organizationId: string,
    now: Date = new Date(),
  ): Promise<FleetOrgDTO> {
    await requirePlatformStaff('support');
    const entry = {
      action: 'estate.read' as const,
      targetKind: 'organization' as const,
      targetId: organizationId,
      organizationId,
    };
    if (!isCloudBilling()) {
      await platformAuditService.record(principal, entry);
      return { meter: 'disabled' };
    }

    const reading = await this.judgeOrganization(organizationId, now);
    const org = await withPlatformRead(principal, entry, (tx) =>
      platformOrganizationRepository.findOrganizationById(organizationId, tx),
    );
    return {
      meter: 'enabled',
      window: windowDto(now),
      row: toRow(reading, org ?? undefined),
    };
  },

  /** The reconciler's kill record, newest first, paged with a total. */
  async listKills(
    principal: PlatformPrincipal,
    input: { since?: Date; page?: number } = {},
    now: Date = new Date(),
  ): Promise<FleetKillsDTO> {
    await requirePlatformStaff('support');
    if (!isCloudBilling()) {
      await platformAuditService.record(principal, {
        action: 'estate.read',
        targetKind: 'platform',
      });
      return { meter: 'disabled' };
    }

    const since = input.since ?? new Date(now.getTime() - FLEET_KILLS_DEFAULT_SINCE_MS);
    const [total, failed] = await withSystemContext(async (tx) => [
      await fleetMachineKillRepository.countSince(since, tx),
      await fleetMachineKillRepository.countFailedSince(since, tx),
    ]);
    const { page, pageCount } = pageOf(input.page, total, FLEET_KILLS_PAGE_SIZE);
    const kills = await withSystemContext((tx) =>
      fleetMachineKillRepository.listSince(
        since,
        { offset: (page - 1) * FLEET_KILLS_PAGE_SIZE, limit: FLEET_KILLS_PAGE_SIZE },
        tx,
      ),
    );
    const orgIds = [
      ...new Set(kills.flatMap((kill) => (kill.organizationId ? [kill.organizationId] : []))),
    ];
    const orgs = await withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'platform' },
      (tx) => platformOrganizationRepository.findOrganizationsByIds(orgIds, tx),
    );
    const names = new Map(orgs.map((org) => [org.id, org.name]));

    return {
      meter: 'enabled',
      since: since.toISOString(),
      rows: kills.map((kill) => toKillDto(kill, names)),
      total,
      failed,
      page,
      pageSize: FLEET_KILLS_PAGE_SIZE,
      pageCount,
    };
  },
};
