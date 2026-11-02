import type { MonitorIssue } from '@/generated/prisma/client';
import { getMonitorProvider } from '@/lib/monitors';
import { MonitorIssueGoneError, MonitorProviderCallError } from '@/lib/monitors/errors';
import type { MonitorAssigneeSyncNote } from '@/lib/monitors/syncStates';
import type { NormalizedMonitorAssignee } from '@/lib/monitors/types';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';
import { monitorIssueRepository } from '@/lib/repositories/monitorIssueRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { commentsService } from '@/lib/services/commentsService';
import { monitorCredentialService } from '@/lib/services/monitorCredentialService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { AssigneeNotInWorkspaceError } from '@/lib/workItems/errors';
import {
  bindWorkspaceContext,
  withSystemContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';

// The monitor SYNC service (Story MOTIR-4931) — what Motir writes BACK to a
// monitor, and what it takes from one, once ingestion (MOTIR-4929) has linked a
// provider issue to a bug.
//
// RESOLVE BACK (Subtask MOTIR-5703) lives here: a bug reaching a done-category
// status resolves each linked issue at the provider, exactly once. It is called
// from two places and only two — the `monitor-issue-resolve` job off
// `work-item/transitioned` (the fast path), and the backstop sweep at the end of
// every poll (`monitorIngestionService.pollConnection`).
//
// ⚠️ COMMIT-THEN-EFFECT. Nothing here runs inside the transition's transaction:
// the job consumes an event emitted AFTER the status write committed, so a slow
// or broken provider can never roll back, or hang, a completion a person made.
// A provider refusal is RECORDED on the link and the connection, never thrown.
//
// ⚠️ EXACTLY ONCE IS THE LINK'S CLAIM, NOT THE EVENT'S DELIVERY. The event is
// at-least-once and the sweep runs as well, so the same completion can reach
// {@link resolveLink} several times. `monitorIssueRepository.claimResolve` is ONE
// conditional UPDATE, and only its winner calls the provider; a `resolved` or
// `gone` link is never claimed again.

/**
 * A `pending` claim older than this is a crashed attempt, and the sweep may take
 * it over. Well above the resolve call's own bound
 * (`MONITOR_RESOLVE_ISSUE_TIMEOUT_MS`, plus one credential refresh and retry), so
 * a live attempt is never mistaken for a dead one.
 */
export const MONITOR_RESOLVE_STALE_MS = 15 * 60 * 1000;

/**
 * The most links ONE poll's backstop sweep resolves. A bound, not a budget: the
 * first poll after the deploy may find a backlog of already-done bugs, and 25 a
 * half-hour clears a few hundred in a working day without making any one poll
 * slow. The rest wait for the next poll, oldest first.
 */
export const MONITOR_RESOLVE_SWEEP_MAX = 25;

/**
 * The most open links ONE poll re-reads for their ASSIGNEE (MOTIR-5705).
 *
 * The poll reads issues whose last-SEEN moved, and assigning an issue in the
 * provider does not move it — so without this an assignment on a quiet error
 * would never arrive. The provider documents no batch-by-id read, so each link
 * is one `getIssue`. At the tick's 30-minute cadence
 * (`MONITOR_ISSUE_RECONCILE_CRON`) this visits up to 20 × 48 = 960 open links a
 * day per connection, oldest-checked first — a full rotation of a connection
 * holding under a thousand open bugs, every day, for 20 bounded reads a poll.
 * It sits beside `MONITOR_POLL_MAX_PAGES` as the poll's other bound.
 */
export const MONITOR_ASSIGNEE_REFRESH_MAX = 20;

/** What one assignee decision did (MOTIR-5705). */
export type MonitorAssigneeOutcome =
  | 'assigned'
  | 'unchanged'
  | 'unassigned_ignored'
  | 'team_assignee'
  | 'no_matching_member'
  | 'not_assignable'
  | 'binder_unavailable';

/** The connection an assignee decision runs for — the columns it reads. */
export interface MonitorAssigneeConnection {
  id: string;
  projectId: string;
  workspaceId: string;
  boundByUserId: string | null;
}

/** The provider assignee's comparison KEY. A provider's ids are unique only
 *  within their kind, so a user and a team sharing an id are still two people. */
export function assigneeKey(assignee: NormalizedMonitorAssignee | null): string | null {
  return assignee ? `${assignee.kind}:${assignee.externalId}` : null;
}

/** Is this refusal the update path telling us the BINDER cannot write here? */
function isBinderRefusal(
  err: unknown,
): err is PermissionDeniedError | ProjectAccessDeniedError | ProjectNotFoundError {
  return (
    err instanceof PermissionDeniedError ||
    err instanceof ProjectAccessDeniedError ||
    err instanceof ProjectNotFoundError
  );
}

/** What one resolve attempt did — the job's and the sweep's ledger output. */
export type MonitorResolveOutcome = 'resolved' | 'gone' | 'failed' | 'switched_off' | 'not_claimed';

export interface MonitorResolveSummary {
  links: number;
  resolved: number;
  gone: number;
  failed: number;
  skipped: number;
}

const EMPTY: MonitorResolveSummary = { links: 0, resolved: 0, gone: 0, failed: 0, skipped: 0 };

/** The bug a link points at — what the comment and the failure record name. */
export interface LinkedBug {
  id: string;
  identifier: string;
  projectId: string;
  workspaceId: string;
}

/** The done-category keys of a project's OWN workflow — the rule
 *  `reconcileIssue` applies, so a team's custom terminal status (and
 *  `cancelled`) counts. */
async function doneKeysOf(projectId: string, workspaceId: string): Promise<Set<string>> {
  const statuses = await workflowsService.listStatusesByProject(projectId, workspaceId);
  return new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));
}

/** The link's bug, read with the link's own workspace bound (`work_item` has no
 *  system arm, so an unbound read would see nothing and say nothing). */
async function readBug(link: MonitorIssue): Promise<LinkedBug | null> {
  /* v8 ignore next -- unreachable: both callers hand in links their listing
     joined to a work item (`listByWorkItem` by its id, `listResolvableForConnection`
     through the done-status join). Asserted by `monitorSyncArms.test.ts` ›
     "both listings only ever return links that point at a work item". */
  if (!link.workItemId) return null;
  const workItemId = link.workItemId;
  return withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, link.workspaceId);
    const bug = await workItemRepository.findById(workItemId, tx);
    return bug
      ? {
          id: bug.id,
          identifier: bug.identifier,
          projectId: bug.projectId,
          workspaceId: bug.workspaceId,
        }
      : null;
  });
}

/** The words the gone-comment says — the issue by its permalink, or its provider
 *  id when there is none. Carries nothing from the credential. */
export function monitorIssueGoneComment(link: {
  externalIssueId: string;
  permalink: string | null;
}): string {
  const issue = link.permalink
    ? `[the linked monitor issue](${link.permalink})`
    : `the linked monitor issue \`${link.externalIssueId}\``;
  return (
    `Nothing was resolved in the monitor: ${issue} no longer exists there. ` +
    'It was deleted at the provider, so there is nothing left to close.'
  );
}

/** A connection's SYNC failure, written with the connection's own workspace
 *  bound (MOTIR-10219): its policy no longer admits a system-only write. */
async function recordConnectionFailure(
  connection: { id: string; workspaceId: string },
  reason: string,
  workItemIdentifier: string | null,
): Promise<void> {
  await withWorkspaceServiceContext(connection.workspaceId, (tx) =>
    monitorConnectionRepository.recordSyncFailure(
      connection.id,
      { reason, workItemIdentifier, at: new Date() },
      tx,
    ),
  );
}

export const monitorSyncService = {
  /**
   * Resolve every issue linked to ONE bug — the `work-item/transitioned` job's
   * entry point.
   *
   * CHEAPEST EXIT FIRST: the links are read before anything else, because almost
   * every transition in the product is on a work item no monitor filed. Then the
   * transition's `toStatusKey` must be in the project's done category.
   */
  async resolveLinkedIssues(
    workItemId: string,
    toStatusKey: string,
  ): Promise<MonitorResolveSummary> {
    const links = await withSystemContext((tx) =>
      monitorIssueRepository.listByWorkItem(workItemId, tx),
    );
    if (links.length === 0) return EMPTY;

    const bug = await readBug(links[0]!);
    if (!bug) return EMPTY;
    const doneKeys = await doneKeysOf(bug.projectId, bug.workspaceId);
    if (!doneKeys.has(toStatusKey)) return { ...EMPTY, links: links.length };

    const summary: MonitorResolveSummary = { ...EMPTY, links: links.length };
    for (const link of links) {
      tally(summary, await monitorSyncService.resolveLink(link, bug));
    }
    return summary;
  },

  /**
   * Resolve ONE link, if this caller wins its claim. The per-link path the job
   * and the sweep share.
   *
   * | the connection / claim / provider says      | recorded                                  |
   * |---------------------------------------------|-------------------------------------------|
   * | `resolveOnDone` off                         | nothing — `resolve_state` stays as it was |
   * | claim lost (held, resolved or gone)         | nothing                                   |
   * | provider accepted                           | `resolved` + time; connection failure cleared |
   * | provider no longer has it (`MonitorIssueGoneError`) | `gone`, and ONE comment on the bug as the binder |
   * | provider refused (`MonitorProviderCallError`) | `failed` + reason; connection failure + bug key |
   *
   * Anything else THROWS, leaving the claim `pending` — the job's retry and
   * dead-letter apply, and the sweep re-claims it once it is stale.
   */
  async resolveLink(link: MonitorIssue, bug: LinkedBug): Promise<MonitorResolveOutcome> {
    const connection = await withSystemContext((tx) =>
      monitorConnectionRepository.findById(link.connectionId, tx),
    );
    if (!connection || !connection.resolveOnDone) return 'switched_off';

    // Every write below binds the LINK's own workspace (MOTIR-10219) — the row
    // read above, never the caller's input. The policy refuses a system-only write.
    const now = new Date();
    const won = await withWorkspaceServiceContext(link.workspaceId, (tx) =>
      monitorIssueRepository.claimResolve(
        link.id,
        now,
        new Date(now.getTime() - MONITOR_RESOLVE_STALE_MS),
        tx,
      ),
    );
    if (!won) return 'not_claimed';

    try {
      await monitorCredentialService.withFreshCredential(connection.installationId, (credential) =>
        getMonitorProvider(credential.provider).resolveIssue({
          accessToken: credential.token,
          externalIssueId: link.externalIssueId,
        }),
      );
    } catch (err) {
      if (err instanceof MonitorIssueGoneError) {
        await withWorkspaceServiceContext(link.workspaceId, (tx) =>
          monitorIssueRepository.recordGone(link.id, tx),
        );
        await sayGoneOnTheCard(link, bug, connection);
        return 'gone';
      }
      if (err instanceof MonitorProviderCallError) {
        await withWorkspaceServiceContext(link.workspaceId, (tx) =>
          monitorIssueRepository.recordResolveFailed(link.id, err.providerReason, tx),
        );
        await recordConnectionFailure(connection, err.providerReason, bug.identifier);
        return 'failed';
      }
      throw err;
    }

    await withWorkspaceServiceContext(link.workspaceId, async (tx) => {
      await monitorIssueRepository.recordResolved(link.id, new Date(), tx);
      await monitorConnectionRepository.clearSyncFailure(connection.id, tx);
    });
    return 'resolved';
  },

  /**
   * Carry ONE provider-side assignment onto the link's bug (Story MOTIR-4931 ·
   * Subtask MOTIR-5705), matched to a Motir member BY EMAIL.
   *
   * ⚠️ ONLY A CHANGE ON THE PROVIDER SIDE IS APPLIED. The provider's current
   * assignee is compared with the one Motir last applied or deliberately
   * declined (`synced_assignee_external_id`), inside ONE transaction holding the
   * link `FOR UPDATE` — so a person who re-assigns the bug in Motir is never
   * overwritten every half hour, and two concurrent decisions about one new
   * assignee produce ONE write: the loser reads the already-synced key under
   * the lock and returns.
   *
   * | provider says                                  | action     | recorded                          |
   * |------------------------------------------------|------------|-----------------------------------|
   * | same as last synced                            | nothing    | —                                 |
   * | a user whose email is a workspace member        | assign, as the binder | the key, note `null`   |
   * | a user with no matching member                 | no write   | the key, `no_matching_member`     |
   * | a team                                         | no write   | the key, `team_assignee`          |
   * | unassigned after a previous assignee            | no write   | `null`, note `null`               |
   *
   * A bug in a done-category status, or a deleted one, is never assigned (and
   * nothing is recorded, so a reopened bug still takes the assignment). A binder
   * who is missing or refused records a NAMED failure on the connection and
   * assigns nothing; no other identity is substituted. The assignment goes
   * through `workItemsService.updateWorkItem` as the binder, so every guard,
   * event and notification of an ordinary assignment runs unchanged.
   */
  async applyAssignee(
    connection: MonitorAssigneeConnection,
    externalIssueId: string,
    assignee: NormalizedMonitorAssignee | null,
    doneKeys: ReadonlySet<string>,
  ): Promise<MonitorAssigneeOutcome> {
    const key = assigneeKey(assignee);
    return withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, connection.workspaceId);
      const lockedId = await monitorIssueRepository.lockByExternalId(
        connection.id,
        externalIssueId,
        tx,
      );
      const link = lockedId ? await monitorIssueRepository.findById(lockedId, tx) : null;
      if (!link || link.syncedAssigneeExternalId === key) return 'unchanged';

      const record = (note: MonitorAssigneeSyncNote | null) =>
        monitorIssueRepository.recordAssigneeSync(
          link.id,
          { externalAssigneeId: key, note, checkedAt: new Date() },
          tx,
        );

      // A monitor UNASSIGNING does not take ownership away from a person here.
      if (assignee === null) {
        await record(null);
        return 'unassigned_ignored';
      }
      const bug = link.workItemId ? await workItemRepository.findById(link.workItemId, tx) : null;
      if (!bug || doneKeys.has(bug.status)) return 'not_assignable';

      if (assignee.kind === 'team') {
        await record('team_assignee');
        return 'team_assignee';
      }
      const user = assignee.email ? await userRepository.findByEmail(assignee.email) : null;
      if (!user) {
        await record('no_matching_member');
        return 'no_matching_member';
      }

      const binderId = connection.boundByUserId;
      if (!binderId) {
        await recordSyncFailureIn(
          tx,
          connection.id,
          `An assignment for ${bug.identifier} arrived from the monitor, and this connection has no binder to make it as. Bind the monitored project again.`,
          bug.identifier,
        );
        return 'binder_unavailable';
      }
      if (bug.assigneeId === user.id) {
        await record(null);
        return 'unchanged';
      }
      // The LOCK IS HELD ACROSS THE UPDATE — the `reconcileIssue` shape:
      // `updateWorkItem` owns its own transaction on disjoint rows, and a second
      // decision about this link waits here, then reads the key recorded below.
      try {
        await workItemsService.updateWorkItem(
          bug.id,
          { assigneeId: user.id },
          { userId: binderId, workspaceId: connection.workspaceId },
        );
      } catch (err) {
        if (err instanceof AssigneeNotInWorkspaceError) {
          await record('no_matching_member');
          return 'no_matching_member';
        }
        if (isBinderRefusal(err)) {
          await recordSyncFailureIn(
            tx,
            connection.id,
            `The person who bound this connection could not assign ${bug.identifier}: ${err.message}`,
            bug.identifier,
          );
          return 'binder_unavailable';
        }
        throw err;
      }
      await record(null);
      return 'assigned';
    });
  },

  /**
   * The BOUNDED ASSIGNEE REFRESH (MOTIR-5705): re-read up to
   * {@link MONITOR_ASSIGNEE_REFRESH_MAX} of the connection's open links,
   * oldest-checked first, through `getIssue`, and apply what comes back. An issue
   * the provider no longer has is stamped and left — saying so on the card is
   * the resolve side's job. ONE link's refusal does not stop the rest, and
   * nothing here changes the poll's recorded ingestion outcome.
   */
  async refreshAssignees(
    connection: MonitorAssigneeConnection & { installationId: string },
    doneKeys: ReadonlySet<string>,
  ): Promise<{ checked: number; failed: number }> {
    const links = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, connection.workspaceId);
      return monitorIssueRepository.listForAssigneeRefresh(
        connection.id,
        [...doneKeys],
        MONITOR_ASSIGNEE_REFRESH_MAX,
        tx,
      );
    });
    let failed = 0;
    for (const link of links) {
      try {
        const current = await monitorCredentialService.withFreshCredential(
          connection.installationId,
          (credential) =>
            getMonitorProvider(credential.provider).getIssue({
              accessToken: credential.token,
              orgSlug: credential.orgSlug ?? '',
              externalIssueId: link.externalIssueId,
            }),
        );
        if (current) {
          await monitorSyncService.applyAssignee(
            connection,
            link.externalIssueId,
            current.assignee,
            doneKeys,
          );
        }
      } catch (err) {
        if (!(err instanceof MonitorProviderCallError)) throw err;
        failed += 1;
      }
      await withWorkspaceServiceContext(link.workspaceId, (tx) =>
        monitorIssueRepository.markAssigneeChecked(link.id, new Date(), tx),
      );
    }
    return { checked: links.length, failed };
  },

  /**
   * The BACKSTOP: resolve every claimable link on one connection whose bug is
   * done, capped at {@link MONITOR_RESOLVE_SWEEP_MAX}. Called at the end of every
   * poll when the connection resolves on done.
   *
   * It catches what the event cannot: a `failed` link (retried here), a stale
   * `pending` one (a crashed attempt), and a done bug whose transition emitted no
   * event — several status writers do not announce themselves, so the event is
   * the fast path and this is the guarantee. The first sweep after the deploy
   * resolves every link whose bug was ALREADY done, which is intended.
   */
  async sweepConnection(connectionId: string): Promise<MonitorResolveSummary> {
    const connection = await withSystemContext((tx) =>
      monitorConnectionRepository.findById(connectionId, tx),
    );
    if (!connection || !connection.resolveOnDone) return EMPTY;

    const doneKeys = await doneKeysOf(connection.projectId, connection.workspaceId);
    // The listing JOINS `work_item` (the bug must be done), which has no system
    // arm — so the connection's own workspace is bound, or the join sees nothing
    // and says nothing.
    const links = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, connection.workspaceId);
      return monitorIssueRepository.listResolvableForConnection(
        connectionId,
        [...doneKeys],
        new Date(Date.now() - MONITOR_RESOLVE_STALE_MS),
        MONITOR_RESOLVE_SWEEP_MAX,
        tx,
      );
    });
    const summary: MonitorResolveSummary = { ...EMPTY, links: links.length };
    for (const link of links) {
      const bug = await readBug(link);
      // The bug was deleted between the listing and this read — a real race, and
      // nothing to resolve for it.
      if (!bug) {
        summary.skipped += 1;
        continue;
      }
      tally(summary, await monitorSyncService.resolveLink(link, bug));
    }
    return summary;
  },
};

async function recordSyncFailureIn(
  tx: Parameters<typeof monitorConnectionRepository.recordSyncFailure>[2],
  connectionId: string,
  reason: string,
  workItemIdentifier: string | null,
): Promise<void> {
  await monitorConnectionRepository.recordSyncFailure(
    connectionId,
    { reason, workItemIdentifier, at: new Date() },
    tx,
  );
}

function tally(summary: MonitorResolveSummary, outcome: MonitorResolveOutcome): void {
  if (outcome === 'resolved') summary.resolved += 1;
  else if (outcome === 'gone') summary.gone += 1;
  else if (outcome === 'failed') summary.failed += 1;
  else summary.skipped += 1;
}

/**
 * "The issue is gone" is said ONCE, on the bug, as the connection's BINDER — the
 * identity ingestion files as (MOTIR-4929). A missing binder, or a comment the
 * create path refuses, leaves the link `gone` and records a NAMED failure on the
 * connection instead. It never substitutes another identity.
 */
async function sayGoneOnTheCard(
  link: MonitorIssue,
  bug: LinkedBug,
  connection: { id: string; workspaceId: string; boundByUserId: string | null },
): Promise<void> {
  const binderId = connection.boundByUserId;
  if (!binderId) {
    await recordConnectionFailure(
      connection,
      `The monitor issue for ${bug.identifier} no longer exists, and this connection has no binder to say so on the bug. Bind the monitored project again.`,
      bug.identifier,
    );
    return;
  }
  try {
    await commentsService.addComment(
      bug.id,
      { bodyMd: monitorIssueGoneComment(link) },
      { userId: binderId, workspaceId: bug.workspaceId },
    );
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    await recordConnectionFailure(
      connection,
      `The monitor issue for ${bug.identifier} no longer exists, and saying so on the bug failed: ${why}`,
      bug.identifier,
    );
  }
}
