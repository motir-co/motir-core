import { randomUUID } from 'node:crypto';
import { FleetShardAccountRefusedError } from '@/lib/ciFleet/errors';
import { HostAccountRefusedError } from '@/lib/ciFleet/headroomErrors';
import {
  HOST_ACCOUNT_SLOTS,
  hostAccountPlan,
  type HostAccountSlot,
} from '@/lib/ciFleet/hostAccounts';
import { ownAccountPoolCredits } from '@/lib/billing/ownAccountPlans';
import { refusalBackoffMs } from '@/lib/ciFleet/poolGrowthPolicy';
import {
  alertFleetShardHeadroom,
  type FleetHeadroomAlert,
} from '@/lib/monitoring/fleetShardHeadroomAlert';
import { fleetGrowthPassLeaseRepository } from '@/lib/repositories/fleetGrowthPassLeaseRepository';
import { hostAccountAttemptRepository } from '@/lib/repositories/hostAccountAttemptRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import {
  fleetShardProvisioningService,
  type AddSpareShardDeps,
  type ShardProvisioningResult,
} from '@/lib/services/fleetShardProvisioningService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { planCapsService, type PlanCapsAnswer } from '@/lib/services/planCapsService';
import { withSystemContext } from '@/lib/workspaces/context';

// THE OWN-ACCOUNTS RECONCILE (Story MOTIR-9365 · MOTIR-9582; widened to the larger
// pools by MOTIR-9366 · MOTIR-9651) — every minute, for every organisation whose
// plan carries its own accounts (`host` or a larger pool on sale,
// `planCarriesOwnAccounts`), make sure its three AWS accounts exist
// (`lib/ciFleet/hostAccounts.ts`), each created by the unattended add-shard with
// its quota raise filed at creation, sized to the plan's pool. A change between
// Host and a rung keeps the same accounts (their names carry no plan); only the raise target moves, and the walk files the new
// one once no request of another value is open.
//
// A RECONCILE, NOT A PURCHASE EVENT: a replayed paid invoice selects the same org
// and finds everything already there, and an org that leaves Host is simply no
// longer selected — its rows are left as they are. The plan is the plan-caps
// read's (`planCapsService.capsFor` answering `capped` with the plan's key), so
// `plan_unknown` and `exempt` never create an account.
//
// Every step of the walk looks before it acts, so a pass interrupted anywhere —
// after `CreateAccount`, after the row, after the merged account's first row —
// is finished by the next one without a second account, row or raise.
//
// A slot AWS refuses is recorded against (organisation, slot), alerted, and not
// tried again until `refusalBackoffMs` of its consecutive refusals has passed —
// the growth pass's backoff, from stored rows so a restart changes nothing. A
// slot whose kind has no primary account yet is skipped silently and tried next
// pass. One org's or slot's failure is logged and counted; the rest still run.
// Nothing here routes a job, and nothing returns, stores or logs a credential
// or a member-account email: the summary carries outcome names only.

const LOG = '[hostAccountReconcile]';
const LEASE_ID = 'host-account-reconcile';
/** Longer than any pass; a crashed run's lease expires after it. */
const LEASE_MS = 10 * 60_000;

/** What one slot's turn did. */
export type HostSlotOutcome =
  /** This pass created or completed something (an account, a row, a raise). */
  | 'created'
  /** Everything was already there. */
  | 'already'
  /** The account and its row exist; the raise failed to file and is retried. */
  | 'raise_failed'
  /** The kind has no primary account to take the GitHub org from yet. */
  | 'no_primary'
  /** AWS refused `CreateAccount`; recorded and alerted. */
  | 'refused'
  /** Inside the backoff of an earlier refusal. */
  | 'backing_off'
  | 'failed';

export interface HostOrgReconcile {
  organizationId: string;
  /** False when the org's plan carries no own accounts (`planCarriesOwnAccounts`)
   *  — nothing was touched. */
  host: boolean;
  slots: Partial<Record<HostAccountSlot, HostSlotOutcome>>;
}

export interface HostReconcileSummary {
  /** False when another run held the pass. */
  ran: boolean;
  organizations: HostOrgReconcile[];
  /** Orgs whose reconcile threw outside any slot. */
  failures: number;
}

export interface HostReconcileDeps {
  now?: () => Date;
  alert?: (alert: FleetHeadroomAlert) => void;
  /** The plan read; the default is the caps lookup's. */
  capsFor?: (organizationId: string) => Promise<PlanCapsAnswer>;
  /** The add-shard's AWS seam and env. */
  provisioning?: AddSpareShardDeps;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

/** The plan key when this plan answer names a plan that carries its own accounts
 *  (Host or a larger pool on sale), else null. */
function ownAccountsPlanKey(answer: PlanCapsAnswer): string | null {
  if (answer.kind !== 'capped') return null;
  return ownAccountPoolCredits(answer.planKey) === null ? null : answer.planKey;
}

async function hasPrimary(fleetKind: string): Promise<boolean> {
  const primaries = await fleetShardService.listShards({ fleetKind, role: 'primary' });
  return primaries.some((shard) => shard.state !== 'disabled');
}

/** Is (org, slot) clear of its refusal backoff at `now`? */
async function clearOfBackoff(
  organizationId: string,
  slot: HostAccountSlot,
  now: Date,
): Promise<boolean> {
  const attempt = await withSystemContext((tx) =>
    hostAccountAttemptRepository.findInTx(organizationId, slot, tx),
  );
  if (!attempt || attempt.refusedCount === 0 || !attempt.lastRefusedAt) return true;
  return now.getTime() - attempt.lastRefusedAt.getTime() >= refusalBackoffMs(attempt.refusedCount);
}

function outcomeOf(result: ShardProvisioningResult): HostSlotOutcome {
  if (result.steps.some((s) => s.step === 'quota_raise' && s.outcome === 'failed')) {
    return 'raise_failed';
  }
  return result.steps.some((s) => s.step !== 'preflight' && s.outcome === 'done')
    ? 'created'
    : 'already';
}

async function reconcileSlot(
  organizationId: string,
  planKey: string,
  slot: HostAccountSlot,
  now: Date,
  deps: Required<Pick<HostReconcileDeps, 'alert'>> & HostReconcileDeps,
): Promise<HostSlotOutcome> {
  const plan = hostAccountPlan(organizationId, slot, ownAccountPoolCredits(planKey)!);
  if (!(await hasPrimary(plan.account.fleetKind))) return 'no_primary';
  if (!(await clearOfBackoff(organizationId, slot, now))) return 'backing_off';

  let result: ShardProvisioningResult;
  try {
    result = await fleetShardProvisioningService.addOrgOwnedShard(
      { organizationId, slot, planKey },
      deps.provisioning,
    );
  } catch (err) {
    if (!(err instanceof FleetShardAccountRefusedError)) throw err;
    const attempt = await withSystemContext((tx) =>
      hostAccountAttemptRepository.recordRefusalInTx(organizationId, slot, now, tx),
    );
    deps.alert(
      new HostAccountRefusedError(
        organizationId,
        slot,
        err.accountName,
        err.reason,
        attempt.refusedCount,
      ),
    );
    return 'refused';
  }
  await withSystemContext((tx) =>
    hostAccountAttemptRepository.clearRefusalsInTx(organizationId, slot, tx),
  );
  return outcomeOf(result);
}

/** Run `fn` holding the reconcile's lease, or answer null when another run holds it. */
async function withReconcileLease<T>(now: Date, fn: () => Promise<T>): Promise<T | null> {
  const holder = randomUUID();
  const taken = await withSystemContext((tx) =>
    fleetGrowthPassLeaseRepository.tryAcquireInTx(
      LEASE_ID,
      holder,
      now,
      new Date(now.getTime() + LEASE_MS),
      tx,
    ),
  );
  if (!taken) return null;
  try {
    return await fn();
  } finally {
    await withSystemContext((tx) =>
      fleetGrowthPassLeaseRepository.releaseInTx(LEASE_ID, holder, tx),
    );
  }
}

export const hostAccountReconcileService = {
  /** Make sure one organisation's own accounts exist — when its plan carries
   *  them (`host` or a larger pool on sale). Never throws for one slot. */
  async reconcileOrganization(
    organizationId: string,
    deps: HostReconcileDeps = {},
  ): Promise<HostOrgReconcile> {
    const now = (deps.now ?? (() => new Date()))();
    const alert = deps.alert ?? alertFleetShardHeadroom;
    const capsFor = deps.capsFor ?? planCapsService.capsFor;
    const outcome: HostOrgReconcile = { organizationId, host: false, slots: {} };
    const planKey = ownAccountsPlanKey(await capsFor(organizationId));
    if (planKey === null) return outcome;
    outcome.host = true;

    for (const slot of HOST_ACCOUNT_SLOTS) {
      try {
        outcome.slots[slot] = await reconcileSlot(organizationId, planKey, slot, now, {
          ...deps,
          alert,
        });
      } catch (err) {
        outcome.slots[slot] = 'failed';
        console.error(`${LOG} a Host account slot failed`, {
          organizationId,
          slot,
          error: errorName(err),
        });
      }
    }
    return outcome;
  },

  /** One pass over every organisation that can be on Host. Never throws for one org. */
  async runReconcile(deps: HostReconcileDeps = {}): Promise<HostReconcileSummary> {
    const now = (deps.now ?? (() => new Date()))();
    const summary: HostReconcileSummary = { ran: true, organizations: [], failures: 0 };
    const ran = await withReconcileLease(now, async () => {
      const candidates = await withSystemContext((tx) =>
        organizationRepository.listHostCandidateIdsInTx(tx),
      );
      for (const organizationId of candidates) {
        try {
          const outcome = await hostAccountReconcileService.reconcileOrganization(organizationId, {
            ...deps,
            now: () => now,
          });
          if (outcome.host) summary.organizations.push(outcome);
        } catch (err) {
          summary.failures += 1;
          console.error(`${LOG} an organisation's reconcile failed`, {
            organizationId,
            error: errorName(err),
          });
        }
      }
    });
    if (ran === null) return { ...summary, ran: false };
    return summary;
  },
};
