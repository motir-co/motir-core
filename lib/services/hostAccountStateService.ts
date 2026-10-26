import { randomUUID } from 'node:crypto';
import type { FleetShard } from '@/generated/prisma/client';
import { FleetShardNotFoundError, FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import {
  deriveAccountState,
  reached,
  stateFromTimes,
  type HostAccountState,
} from '@/lib/ciFleet/hostAccountState';
import { FLEET_WORKLOAD_KINDS, type FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { findShardProvisioningProviderForRow } from '@/lib/fleetShards/provisioningProviders';
import { toFleetShardDTO } from '@/lib/mappers/fleetShardMappers';
import { fleetGrowthPassLeaseRepository } from '@/lib/repositories/fleetGrowthPassLeaseRepository';
import { fleetQuotaRequestRepository } from '@/lib/repositories/fleetQuotaRequestRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE HOST ACCOUNT STATE PASS (Story MOTIR-9365 · MOTIR-9585) — every minute,
// for every AWS account a Host organisation owns, work out which state it has
// reached (`lib/ciFleet/hostAccountState.ts`) and store the time it FIRST entered
// each one on every row of the account.
//
// The facts are gathered, never copied: whether a raise is recorded and its
// largest granted value come from the quota-request records — which the quota
// tracker already keeps fresh, for every kind, with no read of this pass's own
// — and "network built" is the add-shard's own idempotent network step, run
// again through the account's member role while the account is not yet live.
// Nothing stores that fact, so running the step is how it is learned.
//
// ONE DECISION PER AWS ACCOUNT. The merged indexer + agent hoster account is
// two rows naming one AWS account with one quota; its facts are read across both
// rows and its times written to both in one transaction, so the two never
// disagree.
//
// TIMES ONLY MOVE FORWARD: each is written only where it is null, so a replay, a
// raced pass, a later raise or a reduced grant changes none of them.
//
// Once the network is built every row of the account is settled from
// `provisioning` to `active` — the attribution pass skips `provisioning`, so
// until then nothing would reap it. Settling routes nothing: an `org_owned` row
// sits in no shared selection set, and routing to it waits on `liveAt`.
//
// One account's failure is logged and counted; the rest still run. The summary
// carries counts and state names only — never a credential or an email.

const LOG = '[hostAccountState]';
const LEASE_ID = 'host-account-state';
/** Longer than any pass; a crashed run's lease expires after it. */
const LEASE_MS = 10 * 60_000;

export interface HostAccountStateDeps {
  now?: () => Date;
  /** Build (or confirm) the account's network; throws when it cannot. The
   *  default runs the registered add-shard provider's network step. */
  network?: (account: FleetShardDTO) => Promise<void>;
}

export interface HostAccountSettlement {
  awsAccountId: string;
  state: HostAccountState;
  /** Rows this pass moved from `provisioning` to `active`. */
  settled: number;
  /** The network step was run and failed — retried next pass. */
  networkFailed: boolean;
}

export interface HostAccountStateSummary {
  /** False when another run held the pass. */
  ran: boolean;
  /** AWS accounts per state after the pass. */
  states: Partial<Record<HostAccountState, number>>;
  /** Rows settled to `active` this pass. */
  settled: number;
  /** Accounts whose read, network step or write failed. */
  failures: number;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

/** The add-shard provider's own network step for an existing row. */
async function providerNetwork(account: FleetShardDTO): Promise<void> {
  const provider = findShardProvisioningProviderForRow(account.provider, account);
  if (!provider) {
    throw new FleetShardProvisioningRefusedError([
      `no registered add-shard provider reads ${account.provider} accounts`,
    ]);
  }
  await provider.network({
    name: account.name,
    fleetKind: account.fleetKind,
    region: account.aws?.region ?? '',
    options: {},
    credentialRef: account.credentialRef,
    shard: account,
  });
}

/** The row an account's network was built for: the one it was created for — the
 *  merged account's indexer row, which the reconcile creates first. */
function accountRow(rows: readonly FleetShard[]): FleetShard {
  return rows.find((row) => row.fleetKind === 'code_graph_index') ?? rows[0]!;
}

/** The earliest time any row of the account already holds for `column`. */
function earliest(
  rows: readonly FleetShard[],
  column: 'quotaRequestedAt' | 'grantedAt' | 'liveAt',
): Date | null {
  const times = rows.map((row) => row[column]).filter((at): at is Date => at !== null);
  if (times.length === 0) return null;
  return new Date(Math.min(...times.map((at) => at.getTime())));
}

async function withStateLease<T>(now: Date, fn: () => Promise<T>): Promise<T | null> {
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

export const hostAccountStateService = {
  /**
   * Decide one own AWS account's state and store its times on every row of it.
   *
   * @throws FleetShardNotFoundError when no `org_owned` row names the account.
   */
  async settleAccount(
    awsAccountId: string,
    deps: HostAccountStateDeps = {},
  ): Promise<HostAccountSettlement> {
    const now = (deps.now ?? (() => new Date()))();
    const network = deps.network ?? providerNetwork;
    const { rows, requests } = await withSystemContext(async (tx) => {
      const rows = (await fleetShardRepository.listByAwsAccountInTx(awsAccountId, tx)).filter(
        (row) => row.role === 'org_owned',
      );
      const requests = (
        await Promise.all(rows.map((row) => fleetQuotaRequestRepository.listByShard(row.id, tx)))
      ).flat();
      return { rows, requests };
    });
    if (rows.length === 0) throw new FleetShardNotFoundError(awsAccountId);

    const granted = requests
      .map((request) => request.grantedValue)
      .filter((value): value is number => value !== null);
    const grantedVcpu = granted.length > 0 ? Math.max(...granted) : null;

    // A live account's network was built when it went live; it is not run again.
    let networkBuilt = rows.some((row) => row.liveAt !== null);
    let networkFailed = false;
    if (!networkBuilt) {
      try {
        await network(toFleetShardDTO(accountRow(rows)));
        networkBuilt = true;
      } catch (err) {
        networkFailed = true;
        console.error(`${LOG} an own account's network step failed`, {
          awsAccountId,
          error: errorName(err),
        });
      }
    }

    const derived = deriveAccountState({
      hasRequest: requests.length > 0,
      grantedVcpu,
      networkBuilt,
    });
    // A time already held by either row is the account's; otherwise it is now.
    const at = (column: 'quotaRequestedAt' | 'grantedAt' | 'liveAt') =>
      earliest(rows, column) ?? now;
    const times = {
      ...(reached(derived, 'quota_requested') ? { quotaRequestedAt: at('quotaRequestedAt') } : {}),
      ...(reached(derived, 'granted') ? { grantedAt: at('grantedAt') } : {}),
      ...(reached(derived, 'live') ? { liveAt: at('liveAt') } : {}),
    };
    const { after, settled } = await withSystemContext(async (tx) => {
      await fleetShardRepository.fillAccountStateTimesInTx(awsAccountId, times, tx);
      const settled = networkBuilt
        ? await fleetShardRepository.settleOrgOwnedAccountInTx(awsAccountId, tx)
        : 0;
      const after = (await fleetShardRepository.listByAwsAccountInTx(awsAccountId, tx)).filter(
        (row) => row.role === 'org_owned',
      );
      return { after, settled };
    });
    // The stored times are the record: a state never goes back, even when a
    // fact read now is weaker than it was (a failed network step on a live one).
    return {
      awsAccountId,
      state: stateFromTimes(accountRow(after)),
      settled,
      networkFailed,
    };
  },

  /** One pass over every own AWS account. Never throws for one account. */
  async runStatePass(deps: HostAccountStateDeps = {}): Promise<HostAccountStateSummary> {
    const now = (deps.now ?? (() => new Date()))();
    const summary: HostAccountStateSummary = { ran: true, states: {}, settled: 0, failures: 0 };
    const ran = await withStateLease(now, async () => {
      const rows = await withSystemContext((tx) => fleetShardRepository.listOrgOwned({}, tx));
      const accounts = [
        ...new Set(rows.map((row) => row.awsAccountId).filter((id): id is string => !!id)),
      ];
      for (const awsAccountId of accounts) {
        try {
          const outcome = await hostAccountStateService.settleAccount(awsAccountId, {
            ...deps,
            now: () => now,
          });
          summary.states[outcome.state] = (summary.states[outcome.state] ?? 0) + 1;
          summary.settled += outcome.settled;
          if (outcome.networkFailed) summary.failures += 1;
        } catch (err) {
          summary.failures += 1;
          console.error(`${LOG} an own account's state pass failed`, {
            awsAccountId,
            error: errorName(err),
          });
        }
      }
    });
    if (ran === null) return { ...summary, ran: false };
    return summary;
  },

  /**
   * Is the organisation on the SHARED FLOOR for this kind — true while it has no
   * live own account of the kind, including when it has no row at all (a refused
   * create). Admission, the caps lookup, `fleet-admin` and the admin view read
   * this one answer.
   */
  async isOnSharedFloor(organizationId: string, fleetKind: FleetWorkloadKind): Promise<boolean> {
    return (await hostAccountStateService.sharedFloorKinds(organizationId)).includes(fleetKind);
  },

  /** Every kind the organisation is still on the shared floor for. */
  async sharedFloorKinds(organizationId: string): Promise<FleetWorkloadKind[]> {
    const rows = await withSystemContext((tx) =>
      fleetShardRepository.listOrgOwnedInTx(organizationId, tx),
    );
    const live = new Set(rows.filter((row) => row.liveAt !== null).map((row) => row.fleetKind));
    return FLEET_WORKLOAD_KINDS.filter((kind) => !live.has(kind));
  },
};
