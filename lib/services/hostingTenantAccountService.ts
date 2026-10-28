import { randomUUID } from 'node:crypto';
import type { HostingTenantAccount } from '@prisma/client';
import { FleetShardAccountRefusedError } from '@/lib/ciFleet/errors';
import { TenantAccountRefusedError } from '@/lib/ciFleet/headroomErrors';
import {
  TENANT_ACCOUNT_REGION,
  type HostingTenantAccountState,
} from '@/lib/ciFleet/hostingTenantAccounts';
import { refusalBackoffMs } from '@/lib/ciFleet/poolGrowthPolicy';
import {
  alertFleetShardHeadroom,
  type FleetHeadroomAlert,
} from '@/lib/monitoring/fleetShardHeadroomAlert';
import { fleetGrowthPassLeaseRepository } from '@/lib/repositories/fleetGrowthPassLeaseRepository';
import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';
import { bootstrapTenantAccount } from '@/lib/services/hostingTenantAccountBootstrapService';
import { createOrFindTenantAccount } from '@/lib/services/hostingTenantAccountProvisioningService';
import { withSystemContext } from '@/lib/workspaces/context';

// AN ORGANISATION'S TENANT AWS ACCOUNT, ASKED FOR AND WALKED TO READY (Story
// MOTIR-9792 · MOTIR-9942).
//
// `ensureForOrganization` is what the AWS adapter calls before a deploy: it makes
// sure the organisation has a `hosting_tenant_account` row (one, ever) and
// answers where it stands, without calling AWS. Not ready is an answer, not an
// error — the caller waits.
//
// `runReconcile` is the per-minute pass that does the AWS work, holding its own
// lease. For each row not yet `ready` it walks the steps the stored state names:
//
//   requested / refused ─(clear of backoff)→ creating ─(create or find the
//   account)→ bootstrapping ─(deploy role, tag, quota raises)→ ready
//
// A state is written only AFTER the step before it succeeded, and both AWS steps
// look before they act, so a pass cut off anywhere is finished by the next: a
// replayed `creating` finds the account by its derived name, a replayed
// `bootstrapping` finds the role, tag and raises in place.
//
// AWS refusing `CreateAccount` is recorded on the row (count and time), alerted
// once per organisation, and not tried again until `refusalBackoffMs` of the
// consecutive refusals has passed — read from the row, so a restart changes
// nothing. Any other failure leaves the state as it was for the next minute.
// One organisation's failure never stops the rest. Nothing here touches the
// fleet's tables, and the summary and logs carry outcome and error names only.

const LOG = '[hostingTenantAccount]';
const LEASE_ID = 'hosting-tenant-account-reconcile';
/** Longer than any pass; a crashed run's lease expires after it. */
const LEASE_MS = 10 * 60_000;

/** Where an organisation's tenant account stands, for a caller about to deploy. */
export interface TenantAccountAnswer {
  state: HostingTenantAccountState;
  /** True only once the account is bootstrapped. */
  ready: boolean;
  /** The AWS account id, once it is known. */
  accountId: string | null;
}

/** What one organisation's turn of the reconcile did. */
export type TenantAccountOutcome =
  /** The row reached `ready` this pass. */
  | 'ready'
  /** The row was already `ready`. */
  | 'already_ready'
  /** Inside the backoff of an earlier refusal; nothing was called. */
  | 'backing_off'
  /** AWS refused `CreateAccount`; recorded and alerted. */
  | 'refused'
  /** The organisation has no row; nothing to do. */
  | 'not_requested'
  /** A step failed; the state stays for the next pass. */
  | 'failed';

export interface TenantOrgReconcile {
  organizationId: string;
  outcome: TenantAccountOutcome;
}

export interface TenantReconcileSummary {
  /** False when another run held the pass. */
  ran: boolean;
  organizations: TenantOrgReconcile[];
  /** Organisations whose turn failed. */
  failures: number;
}

export interface TenantReconcileDeps {
  now?: () => Date;
  alert?: (alert: FleetHeadroomAlert) => void;
  /** Create or find the AWS account; the default reaches AWS. */
  create?: (organizationId: string) => Promise<{ accountId: string }>;
  /** Bootstrap the account; the default reaches AWS. */
  bootstrap?: (organizationId: string) => Promise<unknown>;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

function answerOf(row: HostingTenantAccount): TenantAccountAnswer {
  const state = row.state as HostingTenantAccountState;
  return { state, ready: state === 'ready', accountId: row.awsAccountId };
}

/** Is the row clear of its refusal backoff at `now`? */
function clearOfBackoff(row: HostingTenantAccount, now: Date): boolean {
  if (row.refusedCount === 0 || !row.lastRefusedAt) return true;
  return now.getTime() - row.lastRefusedAt.getTime() >= refusalBackoffMs(row.refusedCount);
}

const setState = (organizationId: string, state: HostingTenantAccountState) =>
  withSystemContext((tx) => hostingTenantAccountRepository.setStateInTx(organizationId, state, tx));

/** Walk one row from its stored state as far as it goes this pass. Throws for a
 *  failure other than a refusal, leaving the state where it was. */
async function walk(
  row: HostingTenantAccount,
  now: Date,
  deps: Required<TenantReconcileDeps>,
): Promise<TenantAccountOutcome> {
  const { organizationId } = row;
  let state = row.state as HostingTenantAccountState;
  if (state === 'ready') return 'already_ready';

  if (state === 'requested' || state === 'refused') {
    if (!clearOfBackoff(row, now)) return 'backing_off';
    await setState(organizationId, 'creating');
    state = 'creating';
  }

  if (state === 'creating') {
    try {
      await deps.create(organizationId);
    } catch (err) {
      if (!(err instanceof FleetShardAccountRefusedError)) throw err;
      const refused = await withSystemContext(async (tx) => {
        const recorded = await hostingTenantAccountRepository.recordRefusalInTx(
          organizationId,
          now,
          tx,
        );
        await hostingTenantAccountRepository.setStateInTx(organizationId, 'refused', tx);
        return recorded;
      });
      deps.alert(
        new TenantAccountRefusedError(
          organizationId,
          err.accountName,
          err.reason,
          refused.refusedCount,
        ),
      );
      return 'refused';
    }
    await withSystemContext(async (tx) => {
      await hostingTenantAccountRepository.clearRefusalsInTx(organizationId, tx);
      await hostingTenantAccountRepository.setStateInTx(organizationId, 'bootstrapping', tx);
    });
    state = 'bootstrapping';
  }

  if (state === 'bootstrapping') {
    await deps.bootstrap(organizationId);
    await setState(organizationId, 'ready');
  }
  return 'ready';
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

function resolveDeps(deps: TenantReconcileDeps): Required<TenantReconcileDeps> {
  return {
    now: deps.now ?? (() => new Date()),
    alert: deps.alert ?? alertFleetShardHeadroom,
    create: deps.create ?? ((organizationId) => createOrFindTenantAccount(organizationId)),
    bootstrap: deps.bootstrap ?? ((organizationId) => bootstrapTenantAccount(organizationId)),
  };
}

export const hostingTenantAccountService = {
  /** Make sure the organisation has its tenant account row, and say where it
   *  stands. No AWS call; never a second row; not ready is an answer. */
  async ensureForOrganization(organizationId: string): Promise<TenantAccountAnswer> {
    const row = await withSystemContext((tx) =>
      hostingTenantAccountRepository.ensureRequestedInTx(organizationId, TENANT_ACCOUNT_REGION, tx),
    );
    return answerOf(row);
  },

  /** Walk one organisation's row as far as it goes. Never throws. */
  async reconcileOrganization(
    organizationId: string,
    deps: TenantReconcileDeps = {},
  ): Promise<TenantOrgReconcile> {
    const resolved = resolveDeps(deps);
    try {
      const row = await withSystemContext((tx) =>
        hostingTenantAccountRepository.findByOrganizationId(organizationId, tx),
      );
      if (!row) return { organizationId, outcome: 'not_requested' };
      return { organizationId, outcome: await walk(row, resolved.now(), resolved) };
    } catch (err) {
      console.error(`${LOG} an organisation's tenant account step failed`, {
        organizationId,
        error: errorName(err),
      });
      return { organizationId, outcome: 'failed' };
    }
  },

  /** One pass over every row not yet ready, holding the lease. */
  async runReconcile(deps: TenantReconcileDeps = {}): Promise<TenantReconcileSummary> {
    const now = (deps.now ?? (() => new Date()))();
    const summary: TenantReconcileSummary = { ran: true, organizations: [], failures: 0 };
    const ran = await withReconcileLease(now, async () => {
      const rows = await withSystemContext((tx) =>
        hostingTenantAccountRepository.listUnreadyInTx(tx),
      );
      for (const row of rows) {
        const outcome = await hostingTenantAccountService.reconcileOrganization(
          row.organizationId,
          { ...deps, now: () => now },
        );
        if (outcome.outcome === 'failed') summary.failures += 1;
        summary.organizations.push(outcome);
      }
    });
    if (ran === null) return { ...summary, ran: false };
    return summary;
  },
};
