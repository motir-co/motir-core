import type { Prisma } from '@/generated/prisma/client';
import { getMonitorProvider } from '@/lib/monitors';
import {
  MonitorGrantNotFoundError,
  MonitorProviderCallError,
  isPermanentRefreshRefusal,
} from '@/lib/monitors/errors';
import { MONITOR_REFRESH_TIMEOUT_MS } from '@/lib/monitors/provider';
import { readOrgSlug } from '@/lib/mappers/monitorMappers';
import { decryptToken, encryptToken } from '@/lib/monitors/tokenCrypto';
import { monitorInstallationRepository } from '@/lib/repositories/monitorInstallationRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  bindWorkspaceContext,
  withSystemContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';

// The monitor CREDENTIAL LIFECYCLE (Story MOTIR-4926 · Subtask MOTIR-5261) —
// the refresh that keeps a grant usable past eight hours, the on-demand health
// probe, and the stored `degraded` verdict.
//
// ⚠️ WHY THIS CARD EXISTS AT ALL. A Sentry public-integration token expires
// every eight hours, so a connection made by MOTIR-5260 and left alone stops
// working before the next working day. Shipping the connect flow without this
// would look complete in every test, demo perfectly, and be broken by morning —
// which is the failure shape the whole epic answers.
//
// ⚠️ ON DEMAND, NOT ON A SCHEDULE, AND THAT IS A BOUNDARY RATHER THAN AN
// OMISSION. Every schedule in this story belongs to MOTIR-4929, which owns the
// poll and everything it writes. So the probe runs when the room loads a
// connection and when a person presses re-check, and the STORED verdict is what
// the room reads in between. Nothing here defines a job, and
// `tests/integration/monitors/monitorCredential.test.ts` asserts that as a fact
// about the filesystem rather than leaving it to this comment.
//
// ⚠️ AND IT WRITES A VERDICT RATHER THAN RAISING AN ALARM. No email, no
// notification row. MOTIR-4918 measured an alert that WAS delivered and read and
// still created no obligation; the answer is that the state is visible where a
// person looks, not that one more message is sent.

/**
 * How long before a stated expiry a credential is treated as already expired.
 *
 * A token that expires in twenty seconds is useless to a call that takes ten:
 * the skew is what stops a refresh being skipped by a clock that is technically
 * right. Mirrors the same constant in the GitLab connection path.
 */
export const MONITOR_EXPIRY_SKEW_MS = 60_000;

/**
 * How long a refresh LEASE lasts, in ms — the provider call's own deadline plus
 * a margin for the two short transactions around it (MOTIR-8184).
 *
 * The lease is the single-flight guarantee now that no transaction is held
 * across the provider call: a caller that finds a live lease waits rather than
 * spending the same rotating refresh token. It must outlive the call it guards,
 * or a second caller could take over while the first is still waiting on the
 * provider — and it must EXPIRE, so a process that died mid-call leaves a lease
 * the next caller takes over rather than a grant nobody can refresh. Pinned as
 * arithmetic by `monitorCredential.test.ts`.
 */
export const MONITOR_REFRESH_LEASE_MS = MONITOR_REFRESH_TIMEOUT_MS + 15_000;

/** How often a caller that found a live lease re-reads the grant, in ms. */
export const MONITOR_REFRESH_LEASE_POLL_MS = 250;

/**
 * How many times the write that stores a rotated pair is attempted.
 *
 * By the time it runs the provider has already invalidated the old refresh
 * token, so this one statement failing is the whole incident MOTIR-8184 is
 * about. A transient database error (a dropped pooled connection, a Neon compute
 * waking) is worth two more tries; anything that survives three is surfaced.
 */
const STORE_ATTEMPTS = 3;

/** What a caller gets to make one provider call with. */
export interface MonitorAccessToken {
  installationRowId: string;
  /** The grant's own workspace, from its row — what every write about the grant
   *  binds (MOTIR-10219). */
  workspaceId: string;
  provider: string;
  orgSlug: string | null;
  token: string;
  expiresAt: Date;
}

/** Persist a `degraded` verdict carrying the PROVIDER'S OWN reason.
 *
 *  ⚠️ THE REASON IS PASSED THROUGH VERBATIM. A Motir-authored summary ("the
 *  connection failed") is a sentence nobody can act on; the provider's own words
 *  tell a person whether to re-authorise, restore a deleted integration, or wait.
 *  MOTIR-4918 is why this is load-bearing rather than cosmetic. */
async function writeDegraded(
  installationRowId: string,
  providerReason: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await monitorInstallationRepository.updateHealth(
    installationRowId,
    { health: 'degraded', healthReason: providerReason, healthCheckedAt: new Date() },
    tx,
  );
}

/**
 * What one refresh attempt produced. A DISCRIMINATED RESULT rather than a thrown
 * error: a refusal is a fact to record (`settle` commits the verdict), not an
 * exception to unwind through a transaction that would roll the verdict back —
 * the shape MOTIR-5261's first draft got wrong.
 */
type RefreshOutcome =
  | { kind: 'ok'; credential: MonitorAccessToken }
  | {
      kind: 'refused';
      installationRowId: string;
      workspaceId: string;
      provider: string;
      reason: string;
      error: unknown;
      durationMs: number;
      /** When an earlier refresh went out and got no answer, if one did. A
       *  refusal after that is most likely its consequence, not a revocation. */
      refreshUncertainSince: Date | null;
    };

/** What the short locked read decided. */
type LeaseDecision =
  | { kind: 'fresh'; credential: MonitorAccessToken }
  | { kind: 'wait' }
  | {
      kind: 'refresh';
      grant: {
        id: string;
        workspaceId: string;
        provider: string;
        installationId: string;
        refreshTokenEncrypted: string;
        refreshUncertainAt: Date | null;
      };
      orgSlug: string | null;
    };

/**
 * Every refresh currently between "lease taken" and "outcome committed" in THIS
 * process. A stopping process awaits them ({@link
 * monitorCredentialService.settleInFlightRefreshes}) before it disconnects from
 * the database, so a deploy's SIGTERM does not cut a refresh off between the
 * provider's answer and the write that stores it.
 */
const inFlightRefreshes = new Set<Promise<unknown>>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Short transaction #1: lock, re-read, and decide — taking the lease if this
 *  caller is the one that refreshes. Commits before any provider call. */
async function decide(installationRowId: string, force: boolean): Promise<LeaseDecision> {
  return withSystemContext(async (tx) => {
    await monitorInstallationRepository.lockById(installationRowId, tx);
    const grant = await monitorInstallationRepository.findCredentialById(installationRowId, tx);
    if (!grant) throw new MonitorGrantNotFoundError(installationRowId);
    // The lease below is written in THIS transaction, under the lock — so the
    // grant's own workspace is bound here rather than in a second one (MOTIR-10219).
    await bindWorkspaceContext(tx, grant.workspaceId);

    const orgSlug = readOrgSlug(grant.metadata);
    const now = Date.now();

    // Somebody else is mid-refresh, so wait for their pair — checked BEFORE the
    // expiry, exactly as the old row lock blocked every reader. Spending the same
    // refresh token now is the hazard the lease exists for; and a token that
    // merely LOOKS fresh while a refresh is in flight is usually the one a forced
    // refresh is replacing because the provider just refused it.
    if (grant.refreshLeaseUntil && grant.refreshLeaseUntil.getTime() > now) {
      return { kind: 'wait' };
    }

    // The common path, and the one a waiter lands on once the holder has stored
    // its pair: a stored token that is still good. No provider call at all —
    // which is the observable consequence the concurrency test asserts.
    if (!force && grant.tokenExpiresAt.getTime() - MONITOR_EXPIRY_SKEW_MS > now) {
      return {
        kind: 'fresh',
        credential: {
          installationRowId: grant.id,
          workspaceId: grant.workspaceId,
          provider: grant.provider,
          orgSlug,
          token: decryptToken(grant.accessTokenEncrypted),
          expiresAt: grant.tokenExpiresAt,
        },
      };
    }

    await monitorInstallationRepository.setRefreshLease(
      grant.id,
      new Date(now + MONITOR_REFRESH_LEASE_MS),
      tx,
    );
    return {
      kind: 'refresh',
      grant: {
        id: grant.id,
        workspaceId: grant.workspaceId,
        provider: grant.provider,
        installationId: grant.installationId,
        refreshTokenEncrypted: grant.refreshTokenEncrypted,
        refreshUncertainAt: grant.refreshUncertainAt,
      },
      orgSlug,
    };
  });
}

/** Short transaction #2: the rotated pair, ALONE, retried on a transient error. */
async function storeRotatedPair(
  grant: { id: string; workspaceId: string },
  tokens: { accessTokenEncrypted: string; refreshTokenEncrypted: string; tokenExpiresAt: Date },
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await withWorkspaceServiceContext(grant.workspaceId, (tx) =>
        monitorInstallationRepository.storeRefreshedTokens(grant.id, tokens, tx),
      );
      return;
    } catch (error) {
      if (attempt >= STORE_ATTEMPTS) throw error;
      await sleep(250 * attempt);
    }
  }
}

/**
 * Call the provider and commit what it answered — with NO transaction open
 * while it answers.
 *
 * ⚠️ WHY THE LOCK IS NO LONGER HELD ACROSS THIS CALL (MOTIR-8184). The provider
 * rotates the refresh token the moment it accepts the request. Everything that
 * could stop our write after that point — a transaction budget (MOTIR-5988), a
 * client-side abort, a machine stopping before `COMMIT` — leaves a refresh token
 * the provider has already invalidated, and the connection is dead until a
 * person re-authorises. Holding a row lock and a transaction across the call
 * made every one of those a rollback of the new pair. Now the pair is written
 * in its own transaction, first, the instant it arrives; the health write
 * follows in another; and single-flight is a lease column, not an open lock.
 */
async function refreshWithLease(
  grant: Extract<LeaseDecision, { kind: 'refresh' }>['grant'],
  orgSlug: string | null,
): Promise<RefreshOutcome> {
  const provider = getMonitorProvider(grant.provider);
  const startedAt = Date.now();

  let refreshed;
  try {
    refreshed = await provider.refreshCredential({
      installationId: grant.installationId,
      refreshToken: decryptToken(grant.refreshTokenEncrypted),
    });
  } catch (error) {
    // NO ANSWER (a timeout, a dropped connection — `status` null) is not a
    // refusal: the request may have reached the provider and rotated the token.
    // So the stored pair is left exactly as it is, and the moment is recorded.
    const noAnswer = error instanceof MonitorProviderCallError && error.status === null;
    const released = await withWorkspaceServiceContext(grant.workspaceId, (tx) =>
      monitorInstallationRepository.releaseRefreshLease(
        grant.id,
        { uncertainAt: noAnswer ? new Date() : null },
        tx,
      ),
    );
    // A refusal here is the customer having revoked the integration far more
    // often than it is an outage, and either way the connection is not usable.
    return {
      kind: 'refused',
      installationRowId: grant.id,
      workspaceId: grant.workspaceId,
      provider: grant.provider,
      reason:
        error instanceof MonitorProviderCallError ? error.providerReason : 'The refresh failed.',
      error,
      durationMs: Date.now() - startedAt,
      refreshUncertainSince: noAnswer ? released.refreshUncertainAt : grant.refreshUncertainAt,
    };
  }

  // FIRST, AND ALONE: the rotated pair. Nothing shares this transaction.
  await storeRotatedPair(grant, {
    accessTokenEncrypted: encryptToken(refreshed.accessToken),
    refreshTokenEncrypted: encryptToken(refreshed.refreshToken),
    tokenExpiresAt: refreshed.expiresAt,
  });

  // ⚠️ ONE LINE PER REFRESH, AND NO CREDENTIAL IN IT — the duration and the new
  // expiry are what let the next lost pair be traced from the platform's logs,
  // which MOTIR-8184's own incident could not be. `info`, not `warn`: a refresh
  // that worked is not a warning, and it happens about three times a day a grant.
  // eslint-disable-next-line no-console -- the refresh trace the card asks for
  console.info('[monitorCredentialService] refresh succeeded', {
    installationRowId: grant.id,
    provider: grant.provider,
    durationMs: Date.now() - startedAt,
    expiresAt: refreshed.expiresAt.toISOString(),
  });

  // A successful refresh is also evidence of HEALTH, so the terminal value of
  // the lifecycle is written here rather than left showing a stale failure — a
  // re-authorised connection that keeps reading `degraded` is the same silent
  // wrongness one polarity over. A failure here costs a stale badge, never the
  // pair, which is why it is a second transaction.
  await withWorkspaceServiceContext(grant.workspaceId, (tx) =>
    monitorInstallationRepository.updateHealth(
      grant.id,
      { health: 'connected', healthReason: null, healthCheckedAt: new Date() },
      tx,
    ),
  );

  return {
    kind: 'ok',
    credential: {
      installationRowId: grant.id,
      workspaceId: grant.workspaceId,
      provider: grant.provider,
      orgSlug,
      token: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
    },
  };
}

/**
 * Decide, and refresh if needed — single-flight across callers and processes.
 *
 * `force` skips the expiry check, for the one case where a stored token looks
 * fresh and has been refused anyway. A forced caller that had to WAIT for
 * somebody else's refresh does not refresh again: the pair it was refused with
 * has just been replaced, and spending the new refresh token as well is how two
 * page loads used to break a connection.
 */
async function refresh(
  installationRowId: string,
  { force }: { force: boolean },
): Promise<RefreshOutcome> {
  let waited = false;
  for (;;) {
    const decision = await decide(installationRowId, force && !waited);
    if (decision.kind === 'fresh') return { kind: 'ok', credential: decision.credential };
    if (decision.kind === 'wait') {
      waited = true;
      await sleep(MONITOR_REFRESH_LEASE_POLL_MS);
      continue;
    }
    const run = refreshWithLease(decision.grant, decision.orgSlug);
    inFlightRefreshes.add(run);
    try {
      return await run;
    } finally {
      inFlightRefreshes.delete(run);
    }
  }
}

/** Hand back the credential, or COMMIT the verdict and then throw.
 *
 *  ⚠️ A PERMANENT refusal (MOTIR-8170) is recorded differently from a transient
 *  one. The provider has said the refresh token will never work again, so the
 *  grant is marked `refreshRevokedAt`, the poll stops visiting it, and the warn
 *  line is written ONCE — when the mark is first set — rather than on every
 *  attempt. Before this, a grant whose token Sentry no longer had was refreshed,
 *  refused and logged on every five-minute tick until somebody noticed.
 *  A timeout or a 5xx stays transient: `degraded`, logged, and tried again. */
async function settle(outcome: RefreshOutcome): Promise<MonitorAccessToken> {
  if (outcome.kind === 'ok') return outcome.credential;

  // ⚠️ THE LOG LINES CARRY THE REASON AND NO CREDENTIAL. The error path is where
  // a token usually escapes — the happy path has nobody printing anything — so
  // the fields are named explicitly rather than spread from the row. They carry
  // the same duration the success line does (MOTIR-8184).
  const fields = {
    installationRowId: outcome.installationRowId,
    provider: outcome.provider,
    providerReason: outcome.reason,
    durationMs: outcome.durationMs,
    // Non-null means an earlier refresh got no answer: a refusal now is most
    // likely that lost rotation, not the customer revoking the integration.
    refreshUncertainSince: outcome.refreshUncertainSince?.toISOString() ?? null,
  };

  if (isPermanentRefreshRefusal(outcome.error)) {
    const firstRecorded = await withWorkspaceServiceContext(outcome.workspaceId, async (tx) => {
      const marked = await monitorInstallationRepository.markRefreshRevoked(
        outcome.installationRowId,
        { healthReason: outcome.reason, at: new Date() },
        tx,
      );
      // Already marked: refresh the verdict's reason and time, and say nothing.
      if (marked === 0) await writeDegraded(outcome.installationRowId, outcome.reason, tx);
      return marked > 0;
    });
    if (firstRecorded) {
      console.warn(
        '[monitorCredentialService] refresh permanently refused; connection must be reconnected, polling stopped',
        fields,
      );
    }
    throw outcome.error;
  }

  await withWorkspaceServiceContext(outcome.workspaceId, (tx) =>
    writeDegraded(outcome.installationRowId, outcome.reason, tx),
  );
  console.warn('[monitorCredentialService] refresh refused; connection marked degraded', fields);
  throw outcome.error;
}

export const monitorCredentialService = {
  /**
   * A USABLE access token for one grant — refreshing, single-flight, when the
   * stored one is expired or nearly so.
   *
   * ⚠️ ONE REFRESH AT A TIME PER GRANT, and this is not the usual benign race.
   * The provider ROTATES the refresh token on every refresh, so a second
   * concurrent refresh spending the same stored refresh token either fails or
   * invalidates the pair the first one just persisted — a connection broken by
   * nothing but two page loads arriving together. So a concurrent caller finds
   * the refresh LEASE, waits for it, re-reads, finds a credential that is now
   * fresh, and performs NO second refresh. (Until MOTIR-8184 this was a row lock
   * held across the HTTP call; see {@link refreshWithLease} for why it is not.)
   *
   * That last clause is the observable part, which is what makes it testable at
   * all: "it is single-flight" is unobservable, "exactly one provider call is
   * made and the loser proceeds with the winner's token" is not.
   *
   * SYSTEM context, like the GitLab token mint: a refresh is a trusted operation
   * that a webhook, a poll or a page load may all reach, and the workspace is
   * discovered FROM the row rather than supplied by the caller.
   */
  async getAccessToken(installationRowId: string): Promise<MonitorAccessToken> {
    const outcome = await refresh(installationRowId, { force: false });
    return settle(outcome);
  },

  /**
   * Run `fn` with a usable token, refreshing ONCE and retrying ONCE on a 401.
   *
   * ⚠️ ONCE, AND THE COUNT IS THE POINT. A credential believed fresh can still
   * be refused — the customer revoked it inside the window, or the provider
   * rotated it out of band — and the right answer is one refresh and one retry.
   * A loop is the failure this bounds: each attempt spends a refresh token, and a
   * provider that keeps answering 401 would be handed the whole chain. The second
   * 401 surfaces as a typed error and writes `degraded`.
   */
  async withFreshCredential<T>(
    installationRowId: string,
    fn: (credential: MonitorAccessToken) => Promise<T>,
  ): Promise<T> {
    const first = await monitorCredentialService.getAccessToken(installationRowId);
    try {
      return await fn(first);
    } catch (err) {
      if (!(err instanceof MonitorProviderCallError) || err.status !== 401) throw err;

      // Force the refresh the expiry check would have skipped: the stored token
      // LOOKS fresh and is not, which is the only case this arm exists for.
      const refreshed = await monitorCredentialService.forceRefresh(installationRowId);
      try {
        return await fn(refreshed);
      } catch (retryErr) {
        if (retryErr instanceof MonitorProviderCallError) {
          await withWorkspaceServiceContext(refreshed.workspaceId, (tx) =>
            writeDegraded(installationRowId, retryErr.providerReason, tx),
          );
        }
        throw retryErr;
      }
    }
  },

  /**
   * Refresh REGARDLESS of the stored expiry, under the same lease.
   *
   * Separate from {@link getAccessToken} rather than a flag on it, because the
   * two answer different questions — "give me something usable" and "the thing
   * you gave me was refused" — and a boolean parameter would let the second
   * case be reached by accident from the first.
   */
  async forceRefresh(installationRowId: string): Promise<MonitorAccessToken> {
    const outcome = await refresh(installationRowId, { force: true });
    return settle(outcome);
  },

  /**
   * Wait for every refresh this process has in flight to COMMIT its outcome, or
   * for `timeoutMs`, whichever comes first. Called by a stopping process before
   * it disconnects from the database (`scripts/worker.ts`'s drain, MOTIR-8184).
   *
   * ⚠️ A STOP IS WHERE A ROTATED PAIR USED TO DIE. The provider has rotated the
   * token the moment it answers; a process that exits before the pair is stored
   * leaves the grant holding a refresh token that no longer exists. Resolves
   * whether the refreshes succeeded or not — a refusal is still an outcome the
   * row has recorded — and never throws.
   */
  async settleInFlightRefreshes(timeoutMs: number): Promise<{ pending: number }> {
    if (inFlightRefreshes.size === 0) return { pending: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([Promise.allSettled([...inFlightRefreshes]), deadline]);
    clearTimeout(timer);
    return { pending: inFlightRefreshes.size };
  },

  /**
   * PROBE the connection now, and persist what the provider says.
   *
   * The method the settings room calls on load and on re-check — and the only
   * door into the probe, which is what keeps the no-schedule boundary honest:
   * there is nothing for a job to call.
   *
   * It asserts `integration:manage`, because a probe spends a provider call and
   * writes a row.
   */
  async probeHealth(
    projectId: string,
    installationRowId: string,
    ctx: ServiceContext,
  ): Promise<{ health: string; healthReason: string | null; healthCheckedAt: Date }> {
    await projectAccessService.assertPermission(projectId, ctx, 'integration:manage');

    // The refresh comes FIRST: probing with an expired token would report
    // `degraded` on a connection that is merely stale, which is the false
    // negative that would teach people to ignore the badge.
    let credential: MonitorAccessToken;
    try {
      credential = await monitorCredentialService.getAccessToken(installationRowId);
    } catch (err) {
      if (err instanceof MonitorProviderCallError) {
        // `getAccessToken` has already written the verdict under its own lock;
        // read it back rather than writing a second, so the stored value and the
        // returned one cannot disagree.
        const row = await withSystemContext((tx) =>
          monitorInstallationRepository.findCredentialById(installationRowId, tx),
        );
        /* v8 ignore next 5 -- the fallbacks are unreachable: the refused refresh
           writes all three fields before it throws. Asserted by
           `monitorStorySeams.test.ts` › "a refused refresh has written all three
           health fields before probeHealth reads them back". */
        return {
          health: row?.health ?? 'degraded',
          healthReason: row?.healthReason ?? err.providerReason,
          healthCheckedAt: row?.healthCheckedAt ?? new Date(),
        };
      }
      throw err;
    }

    const provider = getMonitorProvider(credential.provider);
    // `describeHealth` returns a VERDICT and does not throw (the seam's own
    // contract), so there is no catch here: an unhealthy answer is a value.
    const verdict = await provider.describeHealth({
      accessToken: credential.token,
      orgSlug: credential.orgSlug ?? '',
    });

    await withWorkspaceServiceContext(credential.workspaceId, (tx) =>
      monitorInstallationRepository.updateHealth(
        installationRowId,
        {
          health: verdict.status,
          healthReason: verdict.reason,
          healthCheckedAt: verdict.checkedAt,
        },
        tx,
      ),
    );

    return {
      health: verdict.status,
      healthReason: verdict.reason,
      healthCheckedAt: verdict.checkedAt,
    };
  },
};
